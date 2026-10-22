import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  PORT: z.coerce.number().default(3001),
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
