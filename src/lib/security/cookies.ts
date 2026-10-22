import { env } from "@/lib/env";

export const SESSION_COOKIE_NAME = "ss_session";
export const CSRF_COOKIE_NAME = "ss_csrf";

export const SESSION_MAX_AGE_SECONDS = 86400; // 24 hours
export const INACTIVITY_TIMEOUT_SECONDS = 7200; // 2 hours

/**
 * Build a Set-Cookie string for the session secret
 */
export function buildSessionCookie(token: string, maxAge: number = SESSION_MAX_AGE_SECONDS): string {
  const isProd = env.NODE_ENV === "production";
  const directives = [
    `${SESSION_COOKIE_NAME}=${token}`,
    "HttpOnly",
    "Path=/",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
  ];

  if (isProd) {
    directives.push("Secure");
  }

  return directives.join("; ");
}

/**
 * Build a Set-Cookie string for the anti-CSRF token (readable by JavaScript)
 */
export function buildCsrfCookie(csrfToken: string, maxAge: number = SESSION_MAX_AGE_SECONDS): string {
  const isProd = env.NODE_ENV === "production";
  const directives = [
    `${CSRF_COOKIE_NAME}=${csrfToken}`,
    "Path=/",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
  ];

  if (isProd) {
    directives.push("Secure");
  }

  return directives.join("; ");
}

/**
 * Build Set-Cookie headers that immediately expire and clear auth cookies
 */
export function buildClearAuthCookies(): string[] {
  const isProd = env.NODE_ENV === "production";
  const secureFlag = isProd ? "; Secure" : "";
  return [
    `${SESSION_COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT${secureFlag}`,
    `${CSRF_COOKIE_NAME}=; Path=/; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT${secureFlag}`,
  ];
}

/**
 * Parse a specific cookie from a Request's Cookie header
 */
export function getCookieFromRequest(request: Request, name: string): string | null {
  // Check NextRequest cookies map if present
  if ("cookies" in request && (request as unknown as { cookies?: { get?: (k: string) => { value?: string } | string } }).cookies) {
    const nextCookie = (request as unknown as { cookies: { get: (k: string) => { value?: string } | string } }).cookies.get(name);
    if (nextCookie) {
      return typeof nextCookie === "string" ? nextCookie : nextCookie.value || null;
    }
  }

  const cookieHeader = request.headers.get("cookie");
  if (!cookieHeader) return null;

  const cookies = cookieHeader.split(";");
  for (const cookie of cookies) {
    const [rawKey, ...valParts] = cookie.trim().split("=");
    if (rawKey === name) {
      return decodeURIComponent(valParts.join("="));
    }
  }

  return null;
}
