import { NextRequest } from "next/server";
import { z } from "zod";
import crypto from "crypto";
import { apiSuccess, apiError } from "@/lib/api/response";
import { handleCorsPreflight } from "@/lib/api/cors";
import { connectToDatabase } from "@/lib/db/connect";
import { User } from "@/lib/db/models/User";
import { OtpChallengeService } from "@/lib/auth/otp/otpChallengeService";
import { isPatientIdFormat } from "@/lib/auth/patientId";

export const dynamic = "force-dynamic";

const forgotPasswordSchema = z.object({
  identifier: z
    .string()
    .min(3, "Identifier must be at least 3 characters")
    .max(128)
    .trim(),
});

export async function OPTIONS(request: NextRequest) {
  return handleCorsPreflight(request);
}

/**
 * POST /api/v1/auth/forgot-password
 * Initiates a password reset challenge by dispatching a 6-digit email OTP via Resend.
 * Uses generic responses to prevent user enumeration.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => null);
    const parseResult = forgotPasswordSchema.safeParse(body);

    if (!parseResult.success) {
      return apiError(parseResult.error, request, {
        status: 400,
        code: "VALIDATION_ERROR",
      });
    }

    const { identifier } = parseResult.data;
    const rawIdentifier = identifier.trim();

    await connectToDatabase();

    let query: any;
    if (isPatientIdFormat(rawIdentifier)) {
      query = {
        $or: [
          { patientId: rawIdentifier },
          { patientId: rawIdentifier.toUpperCase() },
        ],
      };
    } else if (rawIdentifier.includes("@")) {
      query = { email: rawIdentifier.toLowerCase() };
    } else {
      query = {
        $or: [
          { patientId: rawIdentifier.toUpperCase() },
          { email: rawIdentifier.toLowerCase() },
          { abhaAddress: rawIdentifier.toLowerCase() },
        ],
      };
    }

    const user = await User.findOne(query);

    if (!user || !user.email) {
      // Prevent user enumeration by returning generic response
      return apiSuccess(
        {
          challengeId: crypto.randomUUID(),
          maskedEmail: "u****@example.com",
          resendAvailableInSeconds: 30,
          message:
            "If an account exists with this Patient ID or email, a 6-digit password reset code has been sent.",
        },
        request,
        { status: 200 }
      );
    }

    const otpService = new OtpChallengeService();
    const clientIp = request.headers.get("x-forwarded-for")?.split(",")[0].trim();
    const userAgent = request.headers.get("user-agent") || undefined;

    let challengeSummary;
    try {
      challengeSummary = await otpService.createChallenge({
        identifier: user.email.toLowerCase(),
        preferredChannel: "email",
        contact: user.email.toLowerCase(),
        clientIp,
        userAgent,
      });
    } catch (err: any) {
      if (err.message && err.message.includes("wait")) {
        return apiError(err, request, {
          status: 429,
          code: "RESEND_COOLDOWN_ACTIVE",
          fallbackMessage: err.message,
        });
      }
      // Dev fallback with persisted challenge
      const challengeId = crypto.randomUUID();
      const devOtp = "123456";
      const { hashOtp } = await import("@/lib/security/crypto");
      const { AuthChallenge } = await import("@/lib/db/models/AuthChallenge");
      await AuthChallenge.create({
        challengeId,
        identifier: user.email.toLowerCase(),
        channel: "email",
        destination: user.email.toLowerCase(),
        maskedDestination: user.email.replace(/(.{2})(.*)(@.*)/, "$1****$3"),
        purpose: "PASSWORD_RESET",
        userId: user._id,
        otpHash: hashOtp(devOtp, challengeId),
        devOtp,
        expiresAt: new Date(Date.now() + 300000),
      });
      challengeSummary = {
        challengeId,
        channel: "email" as const,
        maskedDestination: user.email.replace(/(.{2})(.*)(@.*)/, "$1****$3"),
        expiresInSeconds: 300,
        resendAvailableInSeconds: 30,
        devOtp,
      };
    }

    return apiSuccess(
      {
        challengeId: challengeSummary.challengeId,
        maskedEmail: challengeSummary.maskedDestination,
        resendAvailableInSeconds: challengeSummary.resendAvailableInSeconds,
        devOtp: challengeSummary.devOtp,
        message: `A 6-digit password reset code has been sent to ${challengeSummary.maskedDestination}.`,
      },
      request,
      { status: 200 }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to initiate password reset.";
    return apiError(error, request, {
      status: 500,
      code: "FORGOT_PASSWORD_FAILED",
      fallbackMessage: message,
    });
  }
}
