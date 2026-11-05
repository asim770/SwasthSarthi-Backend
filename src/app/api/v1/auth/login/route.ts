import { NextRequest } from "next/server";
import { z } from "zod";
import { apiSuccess, apiError } from "@/lib/api/response";
import { handleCorsPreflight } from "@/lib/api/cors";
import { connectToDatabase } from "@/lib/db/connect";
import { User } from "@/lib/db/models/User";
import { createSession } from "@/lib/auth/session";
import { logAuditEvent } from "@/lib/dal/audit";
import { verifyPassword } from "@/lib/security/crypto";
import { isPatientIdFormat } from "@/lib/auth/patientId";
import { checkRateLimit } from "@/lib/security/rateLimiter";

export const dynamic = "force-dynamic";

const loginSchema = z.object({
  identifier: z
    .string()
    .min(3, "Patient ID or email must be at least 3 characters")
    .max(128, "Identifier exceeds maximum length")
    .trim(),
  password: z
    .string()
    .min(1, "Password is required"),
  rememberMe: z.boolean().optional(),
});

export async function OPTIONS(request: NextRequest) {
  return handleCorsPreflight(request);
}

/**
 * POST /api/v1/auth/login
 * Authenticate using either unique Patient ID or registered email + password.
 * Applies rate limiting, pending verification check, and generic error messaging.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => null);
    const parseResult = loginSchema.safeParse(body);

    if (!parseResult.success) {
      return apiError(parseResult.error, request, {
        status: 400,
        code: "VALIDATION_ERROR",
      });
    }

    const { identifier, password } = parseResult.data;
    const rawIdentifier = identifier.trim();
    const clientIp = request.headers.get("x-forwarded-for")?.split(",")[0].trim() || "unknown";

    // 1. Rate limiting: max 5 failed attempts per 15-minute window per IP
    const rateCheck = checkRateLimit(`login_ip:${clientIp}`, 10, 900000);
    if (!rateCheck.allowed) {
      return apiError(
        new Error(`Too many login attempts. Please wait ${rateCheck.resetInSeconds} seconds.`),
        request,
        {
          status: 429,
          code: "RATE_LIMIT_EXCEEDED",
          fallbackMessage: "Too many login attempts. Please try again later.",
        }
      );
    }

    await connectToDatabase();

    // 2. Determine whether identifier is a Patient ID or email address
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
      // General identifier lookup: patientId, email, abhaAddress, or abhaId
      query = {
        $or: [
          { patientId: rawIdentifier.toUpperCase() },
          { email: rawIdentifier.toLowerCase() },
          { abhaAddress: rawIdentifier.toLowerCase() },
          { abhaId: rawIdentifier },
        ],
      };
    }

    const user = await User.findOne(query).select("+passwordHash");

    // Generic error to prevent account enumeration
    const genericAuthError = new Error("Invalid Patient ID, email, or password.");

    if (!user) {
      return apiError(genericAuthError, request, {
        status: 401,
        code: "INVALID_CREDENTIALS",
        fallbackMessage: "Invalid Patient ID, email, or password.",
      });
    }

    // 3. Confirm account is active and eligible to log in
    if (user.accountStatus === "pending_verification") {
      return apiError(
        new Error("Your email address has not been verified yet. Please verify your email to log in."),
        request,
        {
          status: 403,
          code: "EMAIL_VERIFICATION_REQUIRED",
          fallbackMessage: "Email verification required. Please verify your email before logging in.",
        }
      );
    }

    if (user.accountStatus === "suspended" || user.isActive === false) {
      return apiError(
        new Error("This account is inactive or suspended. Please contact hospital support."),
        request,
        {
          status: 403,
          code: "ACCOUNT_INACTIVE",
          fallbackMessage: "This account has been deactivated or suspended.",
        }
      );
    }

    // 4. Verify password configuration
    if (!user.passwordHash) {
      return apiError(
        new Error(
          "No password has been set for this account. If you registered via Google, please sign in with Google or use Forgot Password."
        ),
        request,
        {
          status: 400,
          code: "PASSWORD_NOT_SET",
          fallbackMessage:
            "No password has been configured for this account. Please sign in with Google or use Forgot Password to establish one.",
        }
      );
    }

    // 5. Verify password hash
    const isValid = await verifyPassword(password, user.passwordHash);

    if (!isValid) {
      try {
        await logAuditEvent({
          action: "AUTH_LOGIN_FAILED",
          principal: {
            id: user._id.toString(),
            role: user.role,
          },
          targetResourceType: "Session",
          outcome: "DENIED",
          denialReason: "INVALID_PASSWORD",
          ipAddress: clientIp,
          metadata: {
            identifierType: isPatientIdFormat(rawIdentifier) ? "PATIENT_ID" : "EMAIL",
            maskedIdentifier: rawIdentifier.includes("@")
              ? rawIdentifier.replace(/(.{2})(.*)(@.*)/, "$1****$3")
              : rawIdentifier,
          },
        });
      } catch {
        // Non-blocking audit error
      }

      return apiError(genericAuthError, request, {
        status: 401,
        code: "INVALID_CREDENTIALS",
        fallbackMessage: "Invalid Patient ID, email, or password.",
      });
    }

    // 6. Update lastLoginAt & ensure patientId exists
    user.lastLoginAt = new Date();
    await user.save();

    // 7. Establish secure server-managed session
    const { csrfToken, cookieHeaders } = await createSession(
      user._id,
      user.role,
      request
    );

    // 8. Audit login success
    try {
      await logAuditEvent({
        action: "AUTH_LOGIN_SUCCESS",
        principal: {
          id: user._id.toString(),
          role: user.role,
        },
        targetResourceType: "Session",
        outcome: "ALLOWED",
        ipAddress: clientIp,
        metadata: {
          authMethod: "PASSWORD",
          patientId: user.patientId,
          role: user.role,
        },
      });
    } catch {
      // Non-blocking audit error
    }

    return apiSuccess(
      {
        user: {
          id: user._id.toString(),
          patientId: user.patientId,
          abhaId: user.abhaId,
          abhaAddress: user.abhaAddress,
          name: user.name,
          role: user.role,
          phone: user.phone,
          email: user.email,
          authProviders: user.authProviders || ["password"],
          accountStatus: user.accountStatus || "active",
          verificationStatus: user.verificationStatus || "APPROVED",
          facility: user.facility,
          specialization: user.specialization,
          gender: user.gender,
          dateOfBirth: user.dateOfBirth,
          isActive: user.isActive,
          isPhoneVerified: user.isPhoneVerified,
          isEmailVerified: user.isEmailVerified,
        },
        patientId: user.patientId,
        csrfToken,
        message: `Welcome back, ${user.name}!`,
      },
      request,
      {
        status: 200,
        cookies: cookieHeaders,
      }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Authentication error.";
    return apiError(error, request, {
      status: 500,
      code: "LOGIN_FAILED",
      fallbackMessage: message,
    });
  }
}
