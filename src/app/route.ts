import { NextRequest } from "next/server";
import { apiSuccess } from "@/lib/api/response";
import { handleCorsPreflight } from "@/lib/api/cors";

export const dynamic = "force-dynamic";

export async function OPTIONS(request: NextRequest) {
  return handleCorsPreflight(request);
}

export async function GET(request: NextRequest) {
  return apiSuccess(
    {
      name: "SwasthSaarthi Healthcare API Gateway",
      description: "FHIR R4 & ABDM-compliant health record portal backend",
      version: "1.0.0",
      status: "operational",
      endpoints: {
        health: "/api/v1/health",
      },
    },
    request
  );
}
