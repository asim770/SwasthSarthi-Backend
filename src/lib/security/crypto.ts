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
 * Verify an OTP against the stored challenge hash using constant-time comparison
 */
export function verifyOtpHash(otp: string, challengeId: string, storedHash: string): boolean {
  if (!otp || !challengeId || !storedHash) return false;
  const computedHash = hashOtp(otp, challengeId);
  if (computedHash.length !== storedHash.length) return false;
  return crypto.timingSafeEqual(
    Buffer.from(computedHash, "utf8"),
    Buffer.from(storedHash, "utf8")
  );
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

/**
 * Hash a user password using PBKDF2 with SHA-512 and 100,000 iterations
 */
export function hashPassword(password: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16).toString("hex");
    crypto.pbkdf2(password, salt, 100000, 64, "sha512", (err, derivedKey) => {
      if (err) return reject(err);
      resolve(`${salt}:${derivedKey.toString("hex")}`);
    });
  });
}

/**
 * Verify a user password against stored PBKDF2 hash using constant-time comparison
 */
export function verifyPassword(password: string, storedHash?: string): Promise<boolean> {
  return new Promise((resolve) => {
    if (!password || !storedHash || !storedHash.includes(":")) {
      return resolve(false);
    }
    const [salt, key] = storedHash.split(":");
    crypto.pbkdf2(password, salt, 100000, 64, "sha512", (err, derivedKey) => {
      if (err) return resolve(false);
      const keyBuffer = Buffer.from(key, "hex");
      if (derivedKey.length !== keyBuffer.length) return resolve(false);
      resolve(crypto.timingSafeEqual(derivedKey, keyBuffer));
    });
  });
}

