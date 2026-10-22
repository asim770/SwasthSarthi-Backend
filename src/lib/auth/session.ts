import mongoose from "mongoose";
import { Session, ISession } from "@/lib/db/models/Session";
import { User, IUser, UserRole } from "@/lib/db/models/User";
import { connectToDatabase } from "@/lib/db/connect";
import {
  generateSecureToken,
  hashToken,
  generateCsrfToken,
} from "@/lib/security/crypto";
import {
  buildSessionCookie,
  buildCsrfCookie,
  buildClearAuthCookies,
  getCookieFromRequest,
  SESSION_COOKIE_NAME,
  SESSION_MAX_AGE_SECONDS,
  INACTIVITY_TIMEOUT_SECONDS,
} from "@/lib/security/cookies";
import { validateCsrf } from "@/lib/security/csrf";

export interface SessionContext {
  user: IUser;
  session: ISession;
}

export interface ValidationFailure {
  user: null;
  session: null;
  error: string;
}

export type SessionValidationResult = SessionContext | ValidationFailure;

/**
 * Create a new server-side session, persist its token hash, and construct secure cookies
 */
export async function createSession(
  userOrId: mongoose.Types.ObjectId | { _id: mongoose.Types.ObjectId; role: UserRole },
  roleArg?: UserRole,
  request?: Request
): Promise<{
  session: ISession;
  sessionId: string;
  rawSessionToken: string;
  csrfToken: string;
  cookieHeaders: string[];
}> {
  await connectToDatabase();

  let userId: mongoose.Types.ObjectId;
  let role: UserRole;

  if (userOrId && typeof userOrId === "object" && "_id" in userOrId && "role" in userOrId) {
    userId = userOrId._id;
    role = userOrId.role as UserRole;
  } else {
    userId = userOrId as mongoose.Types.ObjectId;
    role = roleArg as UserRole;
  }

  const rawSessionToken = generateSecureToken(32);
  const tokenHash = hashToken(rawSessionToken);
  const sessionId = generateSecureToken(16);
  const csrfSecret = generateSecureToken(16);
  const csrfToken = generateCsrfToken(csrfSecret);

  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_MAX_AGE_SECONDS * 1000);

  const ipAddress =
    request?.headers?.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request?.headers?.get("x-real-ip") ||
    undefined;
  const userAgent = request?.headers?.get("user-agent") || undefined;

  const session = await Session.create({
    sessionId,
    tokenHash,
    userId,
    role,
    csrfSecret,
    ipAddress,
    userAgent,
    lastActivityAt: now,
    expiresAt,
    isRevoked: false,
  });

  const cookieHeaders = [
    buildSessionCookie(rawSessionToken, SESSION_MAX_AGE_SECONDS),
    buildCsrfCookie(csrfToken, SESSION_MAX_AGE_SECONDS),
  ];

  return {
    session,
    sessionId: session.sessionId,
    rawSessionToken,
    csrfToken,
    cookieHeaders,
  };
}

/**
 * Validate session from request cookies with inactivity sliding window and active user checks
 */
export async function validateSession(request: Request): Promise<SessionValidationResult> {
  const rawSessionToken =
    getCookieFromRequest(request, SESSION_COOKIE_NAME) ||
    getCookieFromRequest(request, "ss_session_id");
  if (!rawSessionToken) {
    return { user: null, session: null, error: "MISSING_SESSION_COOKIE" };
  }

  await connectToDatabase();

  const tokenHash = hashToken(rawSessionToken);
  const session = await Session.findOne({
    $or: [{ tokenHash }, { sessionId: rawSessionToken }],
    isRevoked: false,
  });

  if (!session) {
    return { user: null, session: null, error: "INVALID_OR_REVOKED_SESSION" };
  }

  const now = new Date();

  // Hard maximum session expiration
  if (session.expiresAt <= now) {
    session.isRevoked = true;
    session.revokedAt = now;
    await session.save();
    return { user: null, session: null, error: "SESSION_EXPIRED" };
  }

  // Sliding inactivity timeout
  const inactiveDurationMs = now.getTime() - session.lastActivityAt.getTime();
  if (inactiveDurationMs > INACTIVITY_TIMEOUT_SECONDS * 1000) {
    session.isRevoked = true;
    session.revokedAt = now;
    await session.save();
    return { user: null, session: null, error: "SESSION_INACTIVITY_TIMEOUT" };
  }

  // Verify active user principal
  const user = await User.findById(session.userId);
  if (!user) {
    return { user: null, session: null, error: "USER_NOT_FOUND" };
  }

  if (!user.isActive) {
    return { user: null, session: null, error: "USER_INACTIVE" };
  }

  // Update last activity sliding window (debounced if within 60s)
  if (inactiveDurationMs > 60000) {
    session.lastActivityAt = now;
    await session.save();
  }

  return { user, session };
}

/**
 * Revoke the current session and return headers clearing auth cookies
 */
export async function invalidateSession(request: Request): Promise<{
  revoked: boolean;
  clearCookieHeaders: string[];
}> {
  const rawSessionToken = getCookieFromRequest(request, SESSION_COOKIE_NAME);
  const clearCookieHeaders = buildClearAuthCookies();

  if (!rawSessionToken) {
    return { revoked: false, clearCookieHeaders };
  }

  await connectToDatabase();
  const tokenHash = hashToken(rawSessionToken);

  const result = await Session.updateOne(
    { tokenHash, isRevoked: false },
    { isRevoked: true, revokedAt: new Date() }
  );

  return {
    revoked: result.modifiedCount > 0,
    clearCookieHeaders,
  };
}

/**
 * Reusable server-side authentication guard enforcing active session and CSRF checks
 */
export async function requireAuth(
  request: Request
): Promise<
  | { success: true; user: IUser; session: ISession }
  | { success: false; status: number; code: string; message: string }
> {
  const result = await validateSession(request);

  if (!result.user || !result.session) {
    const errorMap: Record<string, { status: number; code: string; message: string }> = {
      MISSING_SESSION_COOKIE: {
        status: 401,
        code: "UNAUTHENTICATED",
        message: "Authentication session required.",
      },
      INVALID_OR_REVOKED_SESSION: {
        status: 401,
        code: "SESSION_INVALID",
        message: "Session is invalid or has been revoked.",
      },
      SESSION_EXPIRED: {
        status: 401,
        code: "SESSION_EXPIRED",
        message: "Session has expired. Please sign in again.",
      },
      SESSION_INACTIVITY_TIMEOUT: {
        status: 401,
        code: "SESSION_INACTIVE",
        message: "Session timed out due to inactivity.",
      },
      USER_INACTIVE: {
        status: 403,
        code: "ACCOUNT_SUSPENDED",
        message: "User account is inactive or disabled.",
      },
    };

    const err = errorMap[result.error] || {
      status: 401,
      code: "AUTHENTICATION_FAILED",
      message: "Authentication failed.",
    };

    return { success: false, ...err };
  }

  // Enforce CSRF check for state-changing HTTP methods
  const isStateChanging = ["POST", "PUT", "PATCH", "DELETE"].includes(
    request.method.toUpperCase()
  );

  if (isStateChanging) {
    const isCsrfValid = validateCsrf(request, result.session.csrfSecret);
    if (!isCsrfValid) {
      return {
        success: false,
        status: 403,
        code: "CSRF_VERIFICATION_FAILED",
        message: "Invalid or missing anti-CSRF token in x-csrf-token header.",
      };
    }
  }

  return {
    success: true,
    user: result.user,
    session: result.session,
  };
}
