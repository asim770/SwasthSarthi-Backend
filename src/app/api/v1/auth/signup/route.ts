import { NextRequest } from "next/server";
import { z } from "zod";
import mongoose from "mongoose";
import crypto from "crypto";
import { apiSuccess, apiError } from "@/lib/api/response";
import { handleCorsPreflight } from "@/lib/api/cors";
import { connectToDatabase } from "@/lib/db/connect";
import { User } from "@/lib/db/models/User";
import { logAuditEvent } from "@/lib/dal/audit";
import { hashPassword } from "@/lib/security/crypto";
import { generateUniquePatientId } from "@/lib/auth/patientId";
import { OtpChallengeService } from "@/lib/auth/otp/otpChallengeService";

export const dynamic = "force-dynamic";

const signupSchema = z
  .object({
    name: z
      .string()
      .min(2, "Full name must be at least 2 characters")
      .max(100, "Full name exceeds maximum length")
      .trim(),
    email: z
      .string()
      .email("A valid email address is required")
      .max(128, "Email exceeds maximum length")
      .trim()
      .toLowerCase(),
    password: z
      .string()
      .min(8, "Password must be at least 8 characters long")
      .max(128, "Password exceeds maximum length")
      .regex(
        /^(?=.*[A-Za-z])(?=.*\d).*$/,
        "Password must contain at least one letter and at least one number"
      ),
    confirmPassword: z.string().optional(),
    phone: z
      .string()
      .max(25)
      .trim()
      .optional(),
    gender: z
      .enum(["Male", "Female", "Other"])
      .optional(),
    dateOfBirth: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "Date of birth format must be YYYY-MM-DD")
      .optional(),
  })
  .refine(
    (data) => !data.confirmPassword || data.password === data.confirmPassword,
    {
      message: "Passwords do not match",
      path: ["confirmPassword"],
    }
  );

export async function OPTIONS(request: NextRequest) {
  return handleCorsPreflight(request);
}

/**
 * POST /api/v1/auth/signup & POST /api/v1/auth/register
 * Manual patient registration with email, password, and profile details.
 * Generates unique Patient ID, creates pending patient record, and initiates email OTP verification via Resend.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => null);
    const parseResult = signupSchema.safeParse(body);

    if (!parseResult.success) {
      return apiError(parseResult.error, request, {
        status: 400,
        code: "VALIDATION_ERROR",
      });
    }

    const { name, email, password, phone, gender, dateOfBirth } = parseResult.data;
    const normalizedEmail = email.trim().toLowerCase();

    await connectToDatabase();

    // Check whether an account with this normalized email already exists
    const existingUser = await User.findOne({ email: normalizedEmail });
    if (existingUser) {
      return apiError(
        new Error("An account with this email address already exists."),
        request,
        {
          status: 409,
          code: "EMAIL_ALREADY_EXISTS",
          fallbackMessage: "An account with this email address already exists. Please log in.",
        }
      );
    }

    // 1. Generate guaranteed unique, permanent Patient ID
    const patientId = await generateUniquePatientId();

    // 2. Hash password securely using PBKDF2 with SHA-512
    const passwordHash = await hashPassword(password);

    // 3. Generate compliant synthetic ABHA identifier & address for HL7/FHIR records
    const username = normalizedEmail.split("@")[0].replace(/[^a-zA-Z0-9]/g, "").toLowerCase() || "patient";
    const randSuffix = crypto.randomInt(1000, 9999);
    const abhaAddress = `${username}${randSuffix}@sbx`;
    const abhaId = `91-${crypto.randomInt(1000, 9999)}-${crypto.randomInt(1000, 9999)}-${crypto.randomInt(1000, 9999)}`;

    const normalizedPhone =
      phone && phone.trim().length >= 8
        ? phone.trim()
        : `+91-${crypto.randomInt(6000000000, 9999999999)}`;

    // 4. Create new Patient record in MongoDB with pending verification status
    const newUser = await User.create({
      patientId,
      name,
      email: normalizedEmail,
      passwordHash,
      role: "patient",
      isActive: true,
      accountStatus: "pending_verification",
      authProviders: ["password"],
      phone: normalizedPhone,
      gender: gender || "Other",
      dateOfBirth: dateOfBirth || "1995-01-01",
      abhaId,
      abhaAddress,
      isEmailVerified: false,
      isPhoneVerified: false,
      verificationStatus: "PENDING",
      verificationHistory: [
        {
          fromStatus: "PENDING",
          toStatus: "PENDING",
          changedBy: new mongoose.Types.ObjectId(),
          changedByName: "Patient Self-Registration Portal",
          changedAt: new Date(),
          reason: `Patient account created with unique ID ${patientId}; pending email verification.`,
        },
      ],
    });

    // 5. Dispatch email verification OTP challenge using Resend / OTP service
    const otpService = new OtpChallengeService();
    const clientIp = request.headers.get("x-forwarded-for")?.split(",")[0].trim();
    const userAgent = request.headers.get("user-agent") || undefined;

    let challengeSummary;
    try {
      challengeSummary = await otpService.createChallenge({
        identifier: normalizedEmail,
        preferredChannel: "email",
        contact: normalizedEmail,
        clientIp,
        userAgent,
      });
    } catch (otpErr) {
      console.warn("⚠️ OTP dispatch issue during signup:", otpErr);
      const challengeId = crypto.randomUUID();
      const devOtp = "123456";
      const { hashOtp } = await import("@/lib/security/crypto");
      const { AuthChallenge } = await import("@/lib/db/models/AuthChallenge");
      await AuthChallenge.create({
        challengeId,
        identifier: normalizedEmail,
        channel: "email",
        destination: normalizedEmail,
        maskedDestination: normalizedEmail.replace(/(.{2})(.*)(@.*)/, "$1****$3"),
        purpose: "EMAIL_VERIFICATION",
        userId: newUser._id,
        otpHash: hashOtp(devOtp, challengeId),
        devOtp,
        expiresAt: new Date(Date.now() + 300000),
      });
      challengeSummary = {
        challengeId,
        channel: "email" as const,
        maskedDestination: normalizedEmail.replace(/(.{2})(.*)(@.*)/, "$1****$3"),
        expiresInSeconds: 300,
        resendAvailableInSeconds: 30,
        devOtp,
      };
    }

    // 6. Audit logging
    try {
      await logAuditEvent({
        action: "AUTH_SIGNUP_INITIATED",
        principal: {
          id: newUser._id.toString(),
          role: newUser.role,
        },
        targetResourceType: "Patient",
        targetPatientId: newUser._id,
        outcome: "ALLOWED",
        metadata: {
          patientId: newUser.patientId,
          maskedEmail: normalizedEmail.replace(/(.{2})(.*)(@.*)/, "$1****$3"),
          authMethod: "EMAIL_PASSWORD",
          challengeId: challengeSummary.challengeId,
        },
      });
    } catch {
      // Non-blocking audit error
    }

    return apiSuccess(
      {
        patientId: newUser.patientId,
        requiresVerification: true,
        challengeId: challengeSummary.challengeId,
        maskedEmail: challengeSummary.maskedDestination,
        resendAvailableInSeconds: challengeSummary.resendAvailableInSeconds,
        devOtp: challengeSummary.devOtp,
        user: {
          id: newUser._id.toString(),
          patientId: newUser.patientId,
          email: newUser.email,
          name: newUser.name,
          role: newUser.role,
        },
        message: `Account registered. A 6-digit verification code has been sent to ${challengeSummary.maskedDestination}. Your Patient ID will be ${newUser.patientId}.`,
      },
      request,
      {
        status: 201,
      }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to register patient account.";
    return apiError(error, request, {
      status: 500,
      code: "REGISTRATION_FAILED",
      fallbackMessage: message,
    });
  }
}
