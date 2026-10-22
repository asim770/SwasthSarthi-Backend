import { NextRequest } from "next/server";
import { apiSuccess, apiError } from "@/lib/api/response";
import { handleCorsPreflight } from "@/lib/api/cors";
import { connectToDatabase } from "@/lib/db/connect";
import { AuthChallenge } from "@/lib/db/models/AuthChallenge";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";

export async function OPTIONS(request: NextRequest) {
  return handleCorsPreflight(request);
}

export async function GET(request: NextRequest) {
  // Hard block in production environment
  if (process.env.NODE_ENV === "production" || env.NODE_ENV === "production") {
    return apiError(
      new Error("Mock OTP inspection is disabled in production."),
      request,
      {
        status: 404,
        code: "NOT_FOUND",
        fallbackMessage: "Resource not found.",
      }
    );
  }

  const { searchParams } = new URL(request.url);
  const challengeId = searchParams.get("challengeId");

  if (!challengeId) {
    return apiError(
      new Error("challengeId query parameter is required."),
      request,
      {
        status: 400,
        code: "MISSING_CHALLENGE_ID",
      }
    );
  }

  await connectToDatabase();
  const challenge = await AuthChallenge.findOne({ challengeId, status: "PENDING" });

  if (!challenge || !challenge.devOtp) {
    return apiError(
      new Error("No active mock OTP found for this challenge reference."),
      request,
      {
        status: 404,
        code: "CHALLENGE_NOT_FOUND_OR_EXPIRED",
      }
    );
  }

  // Check if expired
  if (challenge.expiresAt <= new Date()) {
    return apiError(
      new Error("This challenge has expired. Request a new OTP."),
      request,
      {
        status: 410,
        code: "CHALLENGE_EXPIRED",
      }
    );
  }

  return apiSuccess(
    {
      challengeId: challenge.challengeId,
      demoOtp: challenge.devOtp,
      expiresAt: challenge.expiresAt.toISOString(),
      attemptsRemaining: challenge.maxAttempts - challenge.attempts,
      environment: env.NODE_ENV,
      deliveryChannel: "Isolated Mock ABDM Telephony Service",
      note: "Development only mock delivery channel. Strictly disabled in production.",
    },
    request
  );
}
