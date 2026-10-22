import { NextRequest } from "next/server";
import { apiSuccess, apiError } from "@/lib/api/response";
import { handleCorsPreflight } from "@/lib/api/cors";
import { connectToDatabase, getDatabaseStatus } from "@/lib/db/connect";
import { getRedisStatus } from "@/lib/queue/redis";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";

export async function OPTIONS(request: NextRequest) {
  return handleCorsPreflight(request);
}

export async function GET(request: NextRequest) {
  try {
    // Attempt database check
    let dbStatus = getDatabaseStatus();
    if (dbStatus.status === "disconnected") {
      try {
        await connectToDatabase();
        dbStatus = getDatabaseStatus();
      } catch {
        // Handled gracefully in health reporting
      }
    }

    // Check Redis connectivity
    const redisStatus = await getRedisStatus();

    const isHealthy =
      dbStatus.status === "connected" && redisStatus.status === "connected";

    const payload = {
      status: isHealthy ? "healthy" : "degraded",
      service: "SwasthSaarthi API Gateway",
      version: "1.0.0",
      environment: env.NODE_ENV,
      timestamp: new Date().toISOString(),
      uptimeSeconds: Math.floor(process.uptime()),
      services: {
        api: {
          status: "up",
        },
        database: {
          type: "mongodb",
          status: dbStatus.status,
          databaseName: dbStatus.databaseName,
        },
        redis: {
          status: redisStatus.status,
          latencyMs: redisStatus.latencyMs,
        },
      },
    };

    return apiSuccess(payload, request, {
      status: isHealthy ? 200 : 200, // Return 200 so monitoring clients receive the health breakdown payload
    });
  } catch (error) {
    return apiError(error, request, {
      status: 503,
      code: "HEALTH_CHECK_FAILED",
      fallbackMessage: "Health check encountered a critical error",
    });
  }
}
