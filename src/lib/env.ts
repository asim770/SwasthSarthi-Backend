import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  PORT: z.coerce.number().default(3000),
  MONGODB_URI: z
    .string()
    .min(1, "MONGODB_URI is required")
    .default("mongodb://127.0.0.1:27017/swasth_saarthi"),
  REDIS_HOST: z.string().default("127.0.0.1"),
  REDIS_PORT: z.coerce.number().default(6379),
  REDIS_PASSWORD: z.string().optional(),
  CORS_ALLOWED_ORIGINS: z
    .string()
    .default("http://localhost:5173,http://localhost:3000,http://127.0.0.1:5173"),
  OTP_PEPPER: z
    .string()
    .default("swasth_saarthi_demo_otp_pepper_2026"),
  CSRF_PEPPER: z
    .string()
    .default("swasth_saarthi_demo_csrf_pepper_2026"),
  SESSION_MAX_AGE_SECONDS: z.coerce.number().default(86400),
  SESSION_INACTIVITY_TIMEOUT_SECONDS: z.coerce.number().default(7200),
  // OTP Delivery Configuration
  OTP_DELIVERY_MODE: z.enum(["mock", "real", "hybrid"]).default("mock"),
  OTP_CHANNELS_ENABLED: z.string().default("mock,sms,email"),
  RESEND_API_KEY: z.string().optional(),
  RESEND_FROM_EMAIL: z.string().default("onboarding@resend.dev"),
  MSG91_AUTH_KEY: z.string().optional(),
  MSG91_OTP_TEMPLATE_ID: z.string().optional(),
  OTP_TTL_SECONDS: z.coerce.number().default(300),
  OTP_MAX_ATTEMPTS: z.coerce.number().default(3),
  OTP_RESEND_COOLDOWN_SECONDS: z.coerce.number().default(30),
  OTP_MAX_SENDS_PER_WINDOW: z.coerce.number().default(3),
  OTP_MAX_VERIFY_ATTEMPTS_PER_WINDOW: z.coerce.number().default(5),
  // Google OAuth Configuration
  GOOGLE_CLIENT_ID: z.string().optional().default("666611753013-cp94eclg8ts7i1ddlqq9eijlnqbc9qgl.apps.googleusercontent.com"),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_REDIRECT_URI: z.string().optional().default("http://localhost:3000/api/auth/callback/google"),
  JWT_SECRET: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

function parseEnv(): Env {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    const formattedErrors = result.error.format();
    console.error("❌ Invalid environment variables:", JSON.stringify(formattedErrors, null, 2));
    // In production we throw to prevent running with bad config
    if (process.env.NODE_ENV === "production") {
      throw new Error("Invalid environment configuration. Check logs for details.");
    }
  }

  // Fallback to parsed data or schema defaults
  return result.success ? result.data : envSchema.parse({});
}

export const env = parseEnv();
