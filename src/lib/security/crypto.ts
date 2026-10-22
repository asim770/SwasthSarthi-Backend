import crypto from "crypto";

// Internal pepper for challenge OTP hashing
const OTP_PEPPER = process.env.OTP_PEPPER || "swasth_saarthi_demo_otp_pepper_2026";
const CSRF_PEPPER = process.env.CSRF_PEPPER || "swasth_saarthi_demo_csrf_pepper_2026";

/**
 * Generate a cryptographically random 6-digit OTP
 */
export function generateRandomOtp(): string {
  return crypto.randomInt(100000, 1000000).toString();
}

/**
 * Hash an OTP with a challenge-specific salt and system pepper using SHA-256
 */
export function hashOtp(otp: string, challengeId: string): string {
  return crypto
    .createHash("sha256")
    .update(`${otp}:${challengeId}:${OTP_PEPPER}`)
    .digest("hex");
}

/**
 * Generate high-entropy cryptographically random session token (32 bytes = 256 bits)
 */
export function generateSecureToken(bytes: number = 32): string {
  return crypto.randomBytes(bytes).toString("hex");
}

/**
 * Hash a session secret using SHA-256 before persisting to MongoDB
 */
export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/**
 * Generate an anti-CSRF token derived from a session's CSRF secret
 */
export function generateCsrfToken(csrfSecret: string): string {
  return crypto
    .createHmac("sha256", `${csrfSecret}:${CSRF_PEPPER}`)
    .update("ss_csrf_validation")
    .digest("hex");
}

/**
 * Verify a CSRF token against the session's CSRF secret using constant-time comparison
 */
export function verifyCsrfToken(providedToken: string, csrfSecret: string): boolean {
  if (!providedToken || !csrfSecret) return false;
  const expectedToken = generateCsrfToken(csrfSecret);
  if (providedToken.length !== expectedToken.length) return false;
  return crypto.timingSafeEqual(
    Buffer.from(providedToken, "utf8"),
    Buffer.from(expectedToken, "utf8")
  );
}
