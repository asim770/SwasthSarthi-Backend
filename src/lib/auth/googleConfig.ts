import { env } from "@/lib/env";

/**
 * Active Google OAuth 2.0 Web Client ID verified in Google Cloud Console.
 * Used as fallback if an older/revoked placeholder ID is present in env.
 */
export const ACTIVE_GOOGLE_CLIENT_ID =
  "666611753013-91i8o6iasa6b80041k2kl07ocjoa9lk3.apps.googleusercontent.com";

const DEPRECATED_GOOGLE_CLIENT_ID_FRAGMENT = "cp94eclg8ts7i1ddlqq9eijlnqbc9qgl";

/**
 * Resolve the active Google OAuth Client ID.
 */
export function getActiveGoogleClientId(): string {
  const configured = (env.GOOGLE_CLIENT_ID || "").trim();
  if (!configured || configured.includes(DEPRECATED_GOOGLE_CLIENT_ID_FRAGMENT)) {
    return ACTIVE_GOOGLE_CLIENT_ID;
  }
  return configured;
}

/**
 * Resolve the configured Google OAuth Client Secret from environment variables.
 */
export function getGoogleClientSecret(): string {
  return (env.GOOGLE_CLIENT_SECRET || "").trim();
}
