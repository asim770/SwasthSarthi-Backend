import { NextRequest } from "next/server";
import { z } from "zod";
import { apiSuccess, apiError } from "@/lib/api/response";
import { handleCorsPreflight } from "@/lib/api/cors";
import { otpChallengeService, OtpChannel } from "@/lib/auth/otp";

export const dynamic = "force-dynamic";

const challengeSchema = z.object({
  identifier: z
    .string()
    .min(3, "Identifier must be at least 3 characters")
    .max(64, "Identifier exceeds maximum length")
    .trim(),
  channel: z.enum(["sms", "email", "mock"]).optional(),
  contact: z.string().max(128).trim().optional(),
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
    const parseResult = challengeSchema.safeParse(body);
    if (!parseResult.success) {
      return apiError(parseResult.error, request, {
        status: 400,
        code: "VALIDATION_ERROR",
      });
    }

    const { identifier, channel, contact } = parseResult.data;

    const challengeSummary = await otpChallengeService.createChallenge({
      identifier,
      channel: channel as OtpChannel | undefined,
      contact,
      clientIp,
      userAgent,
    });

    return apiSuccess(challengeSummary, request, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to generate OTP challenge.";

    if (message.includes("Too many") || message.includes("Rate limit")) {
      return apiError(error, request, {
        status: 429,
        code: "RATE_LIMIT_EXCEEDED",
        fallbackMessage: message,
      });
    }

    if (message.includes("wait") && message.includes("seconds")) {
      return apiError(error, request, {
        status: 429,
        code: "RESEND_COOLDOWN_ACTIVE",
        fallbackMessage: message,
      });
    }

    if (message.includes("Demo identity not found")) {
      return apiError(error, request, {
        status: 404,
        code: "IDENTITY_NOT_FOUND",
        fallbackMessage: "Unable to find matching demo identity in synthetic registry.",
      });
    }

    if (message.includes("deactivated") || message.includes("disabled")) {
      return apiError(error, request, {
        status: 403,
        code: "ACCOUNT_INACTIVE",
        fallbackMessage: "Account is inactive or suspended.",
      });
    }

    if (message.includes("disabled in real delivery mode")) {
      return apiError(error, request, {
        status: 400,
        code: "MOCK_DELIVERY_FORBIDDEN",
        fallbackMessage: message,
      });
    }

    if (
      message.includes("not configured") ||
      message.includes("dispatch failed") ||
      message.includes("delivery failed") ||
      message.includes("delivery failure")
    ) {
      return apiError(error, request, {
        status: 502,
        code: "PROVIDER_DELIVERY_ERROR",
        fallbackMessage: "OTP delivery provider error. Please verify server configuration.",
      });
    }

    return apiError(error, request, {
      status: 500,
      code: "CHALLENGE_GENERATION_FAILED",
      fallbackMessage: message,
    });
  }
}
