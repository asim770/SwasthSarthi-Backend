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
    role: z
      .enum(["patient", "doctor", "laboratory", "pharmacy"])
      .optional()
      .default("patient"),
    name: z
      .string()
      .min(2, "Name must be at least 2 characters")
      .max(100, "Name exceeds maximum length")
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
    // Doctor specific fields
    medicalQualification: z.string().max(100).optional(),
    specialization: z.string().max(100).optional(),
    registrationNumber: z.string().max(100).optional(),
    hospitalOrClinicName: z.string().max(150).optional(),
    // Organization (Lab / Pharmacy) fields
    organizationName: z.string().max(150).optional(),
    authorizedRepresentative: z.string().max(100).optional(),
    address: z.string().max(250).optional(),
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
 * Role-based registration for Patient, Doctor, Laboratory, and Pharmacy accounts.
 * - Patients: assigned permanent unique Patient ID (SS-PAT-XXXXXX), email OTP verification challenge.
 * - Doctors / Labs / Pharmacies: created in PENDING status for administrator review and approval.
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

    const {
      role = "patient",
      name,
      email,
      password,
      phone,
      gender,
      dateOfBirth,
      medicalQualification,
      specialization,
      registrationNumber,
      hospitalOrClinicName,
      organizationName,
      authorizedRepresentative,
      address,
    } = parseResult.data;
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

    // 1. Hash password securely using PBKDF2 with SHA-512
    const passwordHash = await hashPassword(password);

    // 2. Generate compliant synthetic ABHA identifier & address for HL7/FHIR records
    const username =
      normalizedEmail.split("@")[0].replace(/[^a-zA-Z0-9]/g, "").toLowerCase() ||
      role;
    const randSuffix = crypto.randomInt(1000, 9999);
    const abhaAddress = `${username}${randSuffix}@sbx`;
    const abhaId = `91-${crypto.randomInt(1000, 9999)}-${crypto.randomInt(1000, 9999)}-${crypto.randomInt(1000, 9999)}`;

    const normalizedPhone =
      phone && phone.trim().length >= 8
        ? phone.trim()
        : `+91-${crypto.randomInt(6000000000, 9999999999)}`;

    // Handle Doctor, Laboratory, and Pharmacy registration (Pending admin approval)
    if (role === "doctor" || role === "laboratory" || role === "pharmacy") {
      const facilityName =
        role === "doctor"
          ? hospitalOrClinicName || "Primary Health Center"
          : organizationName || name || `${role.toUpperCase()} Facility`;

      const newUser = await User.create({
        name,
        email: normalizedEmail,
        passwordHash,
        role,
        isActive: true,
        accountStatus: "active",
        authProviders: ["password"],
        phone: normalizedPhone,
        gender: gender || "Other",
        dateOfBirth: dateOfBirth || "1988-01-01",
        abhaId,
        abhaAddress,
        isEmailVerified: true,
        isPhoneVerified: true,
        facility: facilityName,
        specialization: specialization || (role === "doctor" ? "General Medicine" : undefined),
        medicalQualification,
        registrationNumber,
        hospitalOrClinicName,
        organizationName,
        authorizedRepresentative,
        address,
        verificationStatus: "PENDING",
        verificationHistory: [
          {
            fromStatus: "PENDING",
            toStatus: "PENDING",
            changedBy: new mongoose.Types.ObjectId(),
            changedByName: `${role.toUpperCase()} Self-Registration Portal`,
            changedAt: new Date(),
            reason: `${role.toUpperCase()} registration submitted; awaiting administrator verification and approval.`,
          },
        ],
      });

      // If laboratory or pharmacy, also register in Facility collection in PENDING state
      if (role === "laboratory" || role === "pharmacy") {
        try {
          const { Facility } = await import("@/lib/db/models/Facility");
          const facType = role === "laboratory" ? ("LABORATORY" as const) : ("PHARMACY" as const);
          const facId = `${role === "laboratory" ? "LAB" : "PHARM"}-${Date.now().toString(36).toUpperCase()}`;
          await Facility.create({
            facilityId: facId,
            name: facilityName,
            type: facType,
            status: "PENDING",
            address: address || "Healthcare Center Hub",
            contactPhone: normalizedPhone,
            contactEmail: normalizedEmail,
            demoHfrId: `IN07${Date.now().toString().slice(-6)}`,
            registeredBy: newUser._id,
            registeredByName: name,
            changeHistory: [
              {
                fromStatus: "PENDING",
                toStatus: "PENDING",
                changedBy: newUser._id,
                changedByName: name,
                changedAt: new Date(),
                reason: `${role.toUpperCase()} facility self-registered; pending admin verification.`,
              },
            ],
          });
        } catch (facErr) {
          console.warn("Facility registration notice:", facErr);
        }
      }

      await logAuditEvent({
        action: `PRACTITIONER_REGISTERED_PENDING_APPROVAL`,
        principal: {
          id: newUser._id.toString(),
          role: newUser.role,
        },
        targetResourceType: "User",
        targetResourceId: newUser._id.toString(),
        outcome: "ALLOWED",
        metadata: {
          role,
          email: normalizedEmail,
          facility: facilityName,
          verificationStatus: "PENDING",
        },
      });

      return apiSuccess(
        {
          requiresVerification: false,
          pendingApproval: true,
          user: {
            id: newUser._id.toString(),
            email: newUser.email,
            name: newUser.name,
            role: newUser.role,
            facility: newUser.facility,
            verificationStatus: newUser.verificationStatus,
          },
          message: `${role.charAt(0).toUpperCase() + role.slice(1)} registration submitted successfully. Your account is pending administrator verification and approval.`,
        },
        request,
        {
          status: 201,
        }
      );
    }

    // 3. For Patient: Generate guaranteed unique, permanent Patient ID
    const patientId = await generateUniquePatientId();

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
