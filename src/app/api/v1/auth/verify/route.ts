import { NextRequest } from "next/server";
import { z } from "zod";
import { apiSuccess, apiError } from "@/lib/api/response";
import { handleCorsPreflight } from "@/lib/api/cors";
import { connectToDatabase } from "@/lib/db/connect";
import { User } from "@/lib/db/models/User";
import { AuthChallenge } from "@/lib/db/models/AuthChallenge";
import { hashOtp } from "@/lib/security/crypto";
import { checkRateLimit } from "@/lib/security/rateLimiter";
import { createSession } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

const verifySchema = z.object({
  challengeId: z.string().min(10, "Invalid challenge ID format").trim(),
  otp: z.string().length(6, "OTP must be exactly 6 digits").regex(/^\d+$/, "OTP must contain only numbers"),
});

export async function OPTIONS(request: NextRequest) {
  return handleCorsPreflight(request);
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => null);
    const parseResult = verifySchema.safeParse(body);

    if (!parseResult.success) {
      return apiError(parseResult.error, request, {
        status: 400,
        code: "VALIDATION_ERROR",
      });
    }

    const { challengeId, otp } = parseResult.data;

    // Rate-limit OTP attempts per challenge: max 5 requests per 5 minutes
    const limitResult = checkRateLimit(`verify_challenge:${challengeId}`, 5, 300000);
    if (!limitResult.allowed) {
      return apiError(
        new Error(`Too many verification attempts for this challenge. Try again in ${limitResult.resetInSeconds}s.`),
        request,
        {
          status: 429,
          code: "RATE_LIMIT_EXCEEDED",
          fallbackMessage: "Rate limit exceeded for challenge verification.",
        }
      );
    }

    await connectToDatabase();

    const now = new Date();

    // Check challenge existence and status before atomic increment
    const existing = await AuthChallenge.findOne({ challengeId });
    if (!existing) {
      return apiError(
        new Error("Challenge reference does not exist or has expired."),
        request,
        {
          status: 404,
          code: "CHALLENGE_NOT_FOUND",
          fallbackMessage: "Invalid challenge reference.",
        }
      );
    }

    if (existing.status === "CONSUMED") {
      return apiError(
        new Error("This OTP challenge has already been consumed. Replay is forbidden."),
        request,
        {
          status: 409,
          code: "CHALLENGE_ALREADY_CONSUMED",
          fallbackMessage: "This challenge has already been used.",
        }
      );
    }

    if (existing.status === "EXHAUSTED" || existing.attempts >= existing.maxAttempts) {
      return apiError(
        new Error("Maximum verification attempts exceeded. Challenge is locked."),
        request,
        {
          status: 403,
          code: "CHALLENGE_EXHAUSTED",
          fallbackMessage: "Too many failed attempts. Please request a new OTP.",
        }
      );
    }

    if (existing.expiresAt <= now || existing.status === "EXPIRED") {
      existing.status = "EXPIRED";
      await existing.save();
      return apiError(
        new Error("The OTP challenge has expired. Please request a new one."),
        request,
        {
          status: 410,
          code: "CHALLENGE_EXPIRED",
          fallbackMessage: "Challenge expired.",
        }
      );
    }

    // Atomic increment of attempt counter
    const challenge = await AuthChallenge.findOneAndUpdate(
      {
        challengeId,
        status: "PENDING",
        attempts: { $lt: existing.maxAttempts },
        expiresAt: { $gt: now },
      },
      {
        $inc: { attempts: 1 },
      },
      { returnDocument: "after" }
    );

    if (!challenge) {
      return apiError(
        new Error("Challenge is no longer valid or is being processed concurrently."),
        request,
        {
          status: 409,
          code: "CHALLENGE_CONCURRENT_CONFLICT",
          fallbackMessage: "Conflict during challenge verification.",
        }
      );
    }

    // Compare cryptographic OTP hash
    const computedHash = hashOtp(otp, challengeId);
    if (computedHash !== challenge.otpHash) {
      const attemptsLeft = challenge.maxAttempts - challenge.attempts;

      if (challenge.attempts >= challenge.maxAttempts) {
        challenge.status = "EXHAUSTED";
        await challenge.save();
        return apiError(
          new Error("Incorrect OTP. All verification attempts exhausted."),
          request,
          {
            status: 403,
            code: "CHALLENGE_EXHAUSTED",
            fallbackMessage: "Maximum attempts exceeded.",
          }
        );
      }

      return apiError(
        new Error(`Incorrect OTP. ${attemptsLeft} attempt(s) remaining.`),
        request,
        {
          status: 401,
          code: "INVALID_OTP",
          fallbackMessage: `Incorrect verification code. ${attemptsLeft} attempts remaining.`,
        }
      );
    }

    // Atomically mark challenge as CONSUMED to prevent race condition replays
    const consumedResult = await AuthChallenge.findOneAndUpdate(
      { challengeId, status: "PENDING" },
      { status: "CONSUMED", consumedAt: new Date() }
    );

    if (!consumedResult) {
      return apiError(
        new Error("Challenge could not be consumed. Possible replay attempt."),
        request,
        {
          status: 409,
          code: "CHALLENGE_REPLAY_REJECTED",
          fallbackMessage: "Challenge replay prevented.",
        }
      );
    }

    // Resolve user principal
    const user = await User.findById(challenge.userId);
    if (!user) {
      return apiError(new Error("Associated user not found."), request, {
        status: 404,
        code: "USER_NOT_FOUND",
      });
    }

    if (!user.isActive) {
      return apiError(
        new Error("User account is inactive. Please contact system administrator."),
        request,
        {
          status: 403,
          code: "ACCOUNT_INACTIVE",
        }
      );
    }

    // Create server-managed session in MongoDB and construct secure cookies
    const { csrfToken, cookieHeaders } = await createSession(
      user._id,
      user.role,
      request
    );

    return apiSuccess(
      {
        user: {
          id: user._id.toString(),
          abhaId: user.abhaId,
          abhaAddress: user.abhaAddress,
          name: user.name,
          role: user.role,
          phone: user.phone,
          facility: user.facility,
          specialization: user.specialization,
          isActive: user.isActive,
        },
        csrfToken,
        message: "Authentication successful. Server session initialized.",
      },
      request,
      {
        status: 200,
        cookies: cookieHeaders,
      }
    );
  } catch (error) {
    return apiError(error, request, {
      status: 500,
      code: "VERIFICATION_FAILED",
      fallbackMessage: "An error occurred during OTP verification.",
    });
  }
}
