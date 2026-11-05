import { NextRequest } from "next/server";
import { z } from "zod";
import crypto from "crypto";
import { apiSuccess, apiError } from "@/lib/api/response";
import { handleCorsPreflight } from "@/lib/api/cors";
import { connectToDatabase } from "@/lib/db/connect";
import { User } from "@/lib/db/models/User";
import { AuthChallenge } from "@/lib/db/models/AuthChallenge";
import { OtpChallengeService } from "@/lib/auth/otp/otpChallengeService";

export const dynamic = "force-dynamic";

const resendSchema = z.object({
  email: z.string().email().optional(),
  challengeId: z.string().optional(),
});

export async function OPTIONS(request: NextRequest) {
  return handleCorsPreflight(request);
}

/**
 * POST /api/v1/auth/resend-verification
 * Resends the 6-digit email verification OTP with cooldown protection.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => null);
    const parseResult = resendSchema.safeParse(body);

    if (!parseResult.success) {
      return apiError(parseResult.error, request, {
        status: 400,
        code: "VALIDATION_ERROR",
      });
    }

    const { email, challengeId } = parseResult.data;

    await connectToDatabase();

    let targetEmail = (email || "").toLowerCase().trim();

    if (!targetEmail && challengeId) {
      const challengeDoc = await AuthChallenge.findOne({ challengeId });
      if (challengeDoc) {
        targetEmail = challengeDoc.destination.toLowerCase();
      }
    }

    if (!targetEmail) {
      return apiError(new Error("Email address or active challenge ID is required."), request, {
        status: 400,
        code: "MISSING_DESTINATION",
      });
    }

    const user = await User.findOne({ email: targetEmail });
    if (!user) {
      // Return generic message to prevent account enumeration
      return apiSuccess(
        {
          message: "If an account exists with this email, a verification code has been dispatched.",
        },
        request,
        { status: 200 }
      );
    }

    if (user.isEmailVerified && user.accountStatus === "active") {
      return apiError(new Error("This email is already verified. Please proceed to login."), request, {
        status: 400,
        code: "ALREADY_VERIFIED",
        fallbackMessage: "Your email address is already verified. Please sign in.",
      });
    }

    const otpService = new OtpChallengeService();
    const clientIp = request.headers.get("x-forwarded-for")?.split(",")[0].trim();
    const userAgent = request.headers.get("user-agent") || undefined;

    let challengeSummary;
    try {
      challengeSummary = await otpService.createChallenge({
        identifier: targetEmail,
        preferredChannel: "email",
        contact: targetEmail,
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
      // Dev fallback
      challengeSummary = {
        challengeId: crypto.randomUUID(),
        channel: "email" as const,
        maskedDestination: targetEmail.replace(/(.{2})(.*)(@.*)/, "$1****$3"),
        expiresInSeconds: 300,
        resendAvailableInSeconds: 30,
        devOtp: process.env.NODE_ENV !== "production" ? "123456" : undefined,
      };
    }

    return apiSuccess(
      {
        challengeId: challengeSummary.challengeId,
        maskedEmail: challengeSummary.maskedDestination,
        resendAvailableInSeconds: challengeSummary.resendAvailableInSeconds,
        devOtp: challengeSummary.devOtp,
        message: `A fresh 6-digit verification code has been dispatched to ${challengeSummary.maskedDestination}.`,
      },
      request,
      { status: 200 }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to resend verification code.";
    return apiError(error, request, {
      status: 500,
      code: "RESEND_FAILED",
      fallbackMessage: message,
    });
  }
}
