import Redis, { RedisOptions } from "ioredis";
import type { ConnectionOptions } from "bullmq";
import { env } from "@/lib/env";

export function getRedisOptions(): RedisOptions {
  return {
    host: env.REDIS_HOST,
    port: env.REDIS_PORT,
    password: env.REDIS_PASSWORD || undefined,
    maxRetriesPerRequest: null, // Required by BullMQ
    enableReadyCheck: false,
    retryStrategy(times) {
      // In development, stop retrying after 3 attempts if Redis is not running
      if (times > 3) {
        return null;
      }
      return Math.min(times * 100, 1000);
    },
    connectTimeout: 2000,
    lazyConnect: true,
  };
}

export function getBullMQConnectionOptions(): ConnectionOptions {
  return {
    host: env.REDIS_HOST,
    port: env.REDIS_PORT,
    password: env.REDIS_PASSWORD || undefined,
    maxRetriesPerRequest: null,
  };
}

let redisClient: Redis | null = null;

export function getRedisClient(): Redis {
  if (!redisClient) {
    redisClient = new Redis(getRedisOptions());

    redisClient.on("connect", () => {
      console.log("✅ Redis connected successfully");
    });

    redisClient.on("error", (err) => {
      // Log connection warnings concisely
      if (env.NODE_ENV === "development") {
        console.warn(`[Redis Notice] Connection to ${env.REDIS_HOST}:${env.REDIS_PORT} unavailable: ${err.message}`);
      }
    });
  }

  return redisClient;
}

export type RedisConnectionStatus = "connected" | "connecting" | "reconnecting" | "disconnected";

export async function getRedisStatus(): Promise<{
  status: RedisConnectionStatus;
  latencyMs?: number;
}> {
  const client = getRedisClient();

  if (client.status === "ready") {
    try {
      const start = Date.now();
      await client.ping();
      return {
        status: "connected",
        latencyMs: Date.now() - start,
      };
    } catch {
      return { status: "disconnected" };
    }
  }

  // If not already connected/ready, attempt a fast, non-blocking probe (max 300ms)
  try {
    const probe = new Redis({
      host: env.REDIS_HOST,
      port: env.REDIS_PORT,
      password: env.REDIS_PASSWORD || undefined,
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
      connectTimeout: 300,
      lazyConnect: false,
      retryStrategy: () => null, // Never retry in probe
    });

    // Suppress unhandled error events on the probe
    probe.on("error", () => {});

    const start = Date.now();
    await Promise.race([
      probe.ping(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("Redis probe timeout")), 300)),
    ]);
    const latencyMs = Date.now() - start;

    probe.disconnect();
    return {
      status: "connected",
      latencyMs,
    };
  } catch {
    return {
      status: "disconnected",
    };
  }
}
