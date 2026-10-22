import { NextRequest } from "next/server";
import { z } from "zod";
import crypto from "crypto";
import { apiSuccess, apiError } from "@/lib/api/response";
import { handleCorsPreflight } from "@/lib/api/cors";
import { connectToDatabase } from "@/lib/db/connect";
import { User } from "@/lib/db/models/User";
import { AuthChallenge } from "@/lib/db/models/AuthChallenge";
import { seedDemoIdentities } from "@/lib/db/seed";
import { generateRandomOtp, hashOtp } from "@/lib/security/crypto";
import { checkRateLimit } from "@/lib/security/rateLimiter";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";

const challengeSchema = z.object({
  identifier: z
    .string()
    .min(3, "Identifier must be at least 3 characters")
    .max(64, "Identifier exceeds maximum length")
    .trim(),
});

function maskIdentifier(id: string): string {
  if (id.includes("@")) {
    const [name, domain] = id.split("@");
    const visibleChars = Math.min(2, name.length);
    const masked = name.slice(0, visibleChars) + "*".repeat(Math.max(1, name.length - visibleChars));
    return `${masked}@${domain}`;
  }
  // ABHA number format: 14 characters or general string
  if (id.length >= 8) {
    return `${id.slice(0, 3)}-****-****-${id.slice(-4)}`;
  }
  return `${id.slice(0, 1)}***${id.slice(-1)}`;
}

export async function OPTIONS(request: NextRequest) {
  return handleCorsPreflight(request);
}

export async function POST(request: NextRequest) {
  try {
    const clientIp =
      request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      request.headers.get("x-real-ip") ||
      "127.0.0.1";

    // Rate limit per IP: Max 5 challenges per 5 minutes
    const ipLimit = checkRateLimit(`challenge_ip:${clientIp}`, 5, 300000);
    if (!ipLimit.allowed) {
      return apiError(
        new Error(`Too many login challenge requests. Try again in ${ipLimit.resetInSeconds}s.`),
        request,
        {
          status: 429,
          code: "RATE_LIMIT_EXCEEDED",
          fallbackMessage: "Rate limit exceeded. Please wait before retrying.",
        }
      );
    }

    const body = await request.json().catch(() => null);
    const parseResult = challengeSchema.safeParse(body);
    if (!parseResult.success) {
      return apiError(parseResult.error, request, {
        status: 400,
        code: "VALIDATION_ERROR",
      });
    }

    const { identifier } = parseResult.data;
    const normalizedIdentifier = identifier.toLowerCase();

    // Rate limit per identifier: Max 3 challenges per 5 minutes
    const idLimit = checkRateLimit(`challenge_id:${normalizedIdentifier}`, 3, 300000);
    if (!idLimit.allowed) {
      return apiError(
        new Error(`Too many OTP requests for this account. Try again in ${idLimit.resetInSeconds}s.`),
        request,
        {
          status: 429,
          code: "RATE_LIMIT_EXCEEDED",
          fallbackMessage: "Too many attempts for this identity.",
        }
      );
    }

    await connectToDatabase();
    await seedDemoIdentities();

    // Look up synthetic user by ABHA ID or ABHA Address
    const user = await User.findOne({
      $or: [
        { abhaId: identifier },
        { abhaAddress: normalizedIdentifier },
      ],
    });

    if (!user) {
      // Generic error message to prevent identity enumeration
      return apiError(
        new Error("Demo identity not found. Please choose an available demo persona."),
        request,
        {
          status: 404,
          code: "IDENTITY_NOT_FOUND",
          fallbackMessage: "Unable to find matching demo identity in synthetic registry.",
        }
      );
    }

    if (!user.isActive) {
      return apiError(
        new Error("This synthetic identity account has been deactivated."),
        request,
        {
          status: 403,
          code: "ACCOUNT_INACTIVE",
          fallbackMessage: "Account is inactive or suspended.",
        }
      );
    }

    // Generate cryptographic OTP and challenge reference
    const otp = generateRandomOtp();
    const challengeId = crypto.randomUUID();
    const otpHash = hashOtp(otp, challengeId);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 5 * 60 * 1000); // 5 minutes validity

    // In non-production (development/test), preserve devOtp for isolated testing endpoint
    const isDev = env.NODE_ENV !== "production";

    await AuthChallenge.create({
      challengeId,
      identifier: normalizedIdentifier,
      userId: user._id,
      otpHash,
      devOtp: isDev ? otp : undefined,
      attempts: 0,
      maxAttempts: 3,
      status: "PENDING",
      expiresAt,
      ipAddress: clientIp,
    });

    return apiSuccess(
      {
        challengeId,
        maskedIdentifier: maskIdentifier(user.abhaAddress),
        role: user.role,
        name: user.name,
        expiresAt: expiresAt.toISOString(),
        resendAvailableInSeconds: 30,
        demoMode: true,
        note: "College demonstration mode using synthetic identities. Not connected to real ABDM network.",
      },
      request,
      { status: 201 }
    );
  } catch (error) {
    return apiError(error, request, {
      status: 500,
      code: "CHALLENGE_GENERATION_FAILED",
      fallbackMessage: "Failed to generate mock ABHA login challenge.",
    });
  }
}
