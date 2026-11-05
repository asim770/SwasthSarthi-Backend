import { NextRequest } from "next/server";
import { z } from "zod";
import { apiSuccess, apiError } from "@/lib/api/response";
import { handleCorsPreflight } from "@/lib/api/cors";
import { connectToDatabase } from "@/lib/db/connect";
import { User } from "@/lib/db/models/User";
import { AuthChallenge } from "@/lib/db/models/AuthChallenge";
import { Session } from "@/lib/db/models/Session";
import { hashPassword } from "@/lib/security/crypto";
import { logAuditEvent } from "@/lib/dal/audit";
import { OtpChallengeService } from "@/lib/auth/otp/otpChallengeService";

export const dynamic = "force-dynamic";

const resetPasswordSchema = z.object({
  challengeId: z.string().min(1, "Challenge reference is required"),
  otp: z.string().length(6, "Verification code must be exactly 6 digits"),
  newPassword: z
    .string()
    .min(8, "Password must be at least 8 characters long")
    .max(128, "Password exceeds maximum length")
    .regex(
      /^(?=.*[A-Za-z])(?=.*\d).*$/,
      "Password must contain at least one letter and at least one number"
    ),
});

export async function OPTIONS(request: NextRequest) {
  return handleCorsPreflight(request);
}

/**
 * POST /api/v1/auth/reset-password
 * Verifies email OTP and sets the new password, revoking existing sessions.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => null);
    const parseResult = resetPasswordSchema.safeParse(body);

    if (!parseResult.success) {
      return apiError(parseResult.error, request, {
        status: 400,
        code: "VALIDATION_ERROR",
      });
    }

    const { challengeId, otp, newPassword } = parseResult.data;
    const clientIp = request.headers.get("x-forwarded-for")?.split(",")[0].trim();
    const userAgent = request.headers.get("user-agent") || undefined;

    await connectToDatabase();

    const otpService = new OtpChallengeService();
    const challengeDoc = await AuthChallenge.findOne({ challengeId });

    if (!challengeDoc) {
      if (process.env.NODE_ENV !== "production" && otp === "123456") {
        // Dev mock pass-through
      } else {
        return apiError(new Error("Password reset challenge has expired or does not exist."), request, {
          status: 400,
          code: "INVALID_CHALLENGE",
          fallbackMessage: "Password reset code has expired. Please request a new one.",
        });
      }
    } else {
      await otpService.verifyChallenge({
        challengeId,
        otp,
        clientIp,
        userAgent,
      });
    }

    const targetEmail = challengeDoc?.destination?.toLowerCase().trim();
    const user = await User.findOne({
      $or: [{ email: targetEmail }, { _id: challengeDoc?.userId }],
    });

    if (!user) {
      return apiError(new Error("Patient account associated with this challenge was not found."), request, {
        status: 404,
        code: "USER_NOT_FOUND",
      });
    }

    // Hash new password securely and persist reliably with Mongoose select:false
    const newHash = await hashPassword(newPassword);
    await User.updateOne(
      { _id: user._id },
      {
        $set: {
          passwordHash: newHash,
        },
        $addToSet: {
          authProviders: "password",
        },
      }
    );

    // Revoke all existing sessions for security
    await Session.deleteMany({ userId: user._id });

    // Audit log
    try {
      await logAuditEvent({
        action: "AUTH_PASSWORD_RESET_SUCCESS",
        principal: {
          id: user._id.toString(),
          role: user.role,
        },
        targetResourceType: "User",
        targetPatientId: user._id,
        outcome: "ALLOWED",
        metadata: {
          patientId: user.patientId,
          challengeId,
        },
      });
    } catch {
      // Non-blocking audit error
    }

    return apiSuccess(
      {
        success: true,
        message: "Your password has been successfully reset. Please sign in with your new password.",
      },
      request,
      { status: 200 }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Password reset failed.";
    return apiError(error, request, {
      status: 400,
      code: "RESET_PASSWORD_FAILED",
      fallbackMessage: message,
    });
  }
}
