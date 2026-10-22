import { getCookieFromRequest, CSRF_COOKIE_NAME } from "./cookies";
import { verifyCsrfToken } from "./crypto";

/**
 * Validate CSRF token for state-changing HTTP requests
 * Uses double-submit cookie verification combined with session CSRF secret verification
 */
export function validateCsrf(request: Request, sessionCsrfSecret?: string): boolean {
  const method = request.method.toUpperCase();

  // Safe HTTP methods do not require CSRF verification
  if (["GET", "HEAD", "OPTIONS"].includes(method)) {
    return true;
  }

  const headerToken = request.headers.get("x-csrf-token");
  if (!headerToken) {
    return false;
  }

  // If a session CSRF secret is provided, verify against the cryptographic HMAC
  if (sessionCsrfSecret) {
    return verifyCsrfToken(headerToken, sessionCsrfSecret);
  }

  // Fallback to double-submit cookie matching if session secret is unavailable
  const cookieToken = getCookieFromRequest(request, CSRF_COOKIE_NAME);
  if (!cookieToken) {
    return false;
  }

  return headerToken === cookieToken;
}
