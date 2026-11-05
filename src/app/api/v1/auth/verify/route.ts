import { NextRequest } from "next/server";
import { z } from "zod";
import { apiSuccess, apiError } from "@/lib/api/response";
import { handleCorsPreflight } from "@/lib/api/cors";
import { otpChallengeService } from "@/lib/auth/otp";
import { createSession } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

const verifySchema = z.object({
  challengeId: z.string().min(10, "Invalid challenge ID format").trim(),
  otp: z
    .string()
    .length(6, "OTP must be exactly 6 digits")
    .regex(/^\d+$/, "OTP must contain only numbers"),
});

export async function OPTIONS(request: NextRequest) {
  return handleCorsPreflight(request);
}

export async function POST(request: NextRequest) {
  try {
    const clientIp =
      request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      request.headers.get("x-real-ip") ||
      "127.0.0.1";

    const userAgent = request.headers.get("user-agent") || undefined;

    const body = await request.json().catch(() => null);
    const parseResult = verifySchema.safeParse(body);

    if (!parseResult.success) {
      return apiError(parseResult.error, request, {
        status: 400,
        code: "VALIDATION_ERROR",
      });
    }

    const { challengeId, otp } = parseResult.data;

    // Verify OTP challenge with atomic attempt counting and constant-time check
    const { user, challenge, contactVerified } =
      await otpChallengeService.verifyChallenge({
        challengeId,
        otp,
        clientIp,
        userAgent,
      });

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
          email: user.email,
          facility: user.facility,
          specialization: user.specialization,
          isActive: user.isActive,
          isPhoneVerified: user.isPhoneVerified,
          isEmailVerified: user.isEmailVerified,
        },
        csrfToken,
        contactVerified,
        channel: challenge.channel,
        demoMode: true,
        abdmSimulated: true,
        message: "Authentication successful. Server session initialized.",
      },
      request,
      {
        status: 200,
        cookies: cookieHeaders,
      }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "An error occurred during verification.";

    if (message.includes("consumed") || message.includes("replay")) {
      return apiError(error, request, {
        status: 409,
        code: "CHALLENGE_ALREADY_CONSUMED",
        fallbackMessage: "This challenge has already been used.",
      });
    }

    if (
      message.includes("Maximum verification attempts") ||
      message.includes("locked") ||
      message.includes("exhausted")
    ) {
      return apiError(error, request, {
        status: 403,
        code: "CHALLENGE_EXHAUSTED",
        fallbackMessage: "Maximum attempts exceeded. Please request a new OTP.",
      });
    }

    if (message.includes("Incorrect OTP")) {
      return apiError(error, request, {
        status: 401,
        code: "INVALID_OTP",
        fallbackMessage: message,
      });
    }

    if (message.includes("expired")) {
      return apiError(error, request, {
        status: 410,
        code: "CHALLENGE_EXPIRED",
        fallbackMessage: "Challenge expired.",
      });
    }

    if (message.includes("does not exist")) {
      return apiError(error, request, {
        status: 404,
        code: "CHALLENGE_NOT_FOUND",
        fallbackMessage: "Invalid challenge reference.",
      });
    }

    if (message.includes("Too many") || message.includes("Rate limit")) {
      return apiError(error, request, {
        status: 429,
        code: "RATE_LIMIT_EXCEEDED",
        fallbackMessage: "Rate limit exceeded for challenge verification.",
      });
    }

    if (message.includes("concurrently")) {
      return apiError(error, request, {
        status: 409,
        code: "CHALLENGE_CONCURRENT_CONFLICT",
        fallbackMessage: "Conflict during challenge verification.",
      });
    }

    return apiError(error, request, {
      status: 500,
      code: "VERIFICATION_FAILED",
      fallbackMessage: message,
    });
  }
}
