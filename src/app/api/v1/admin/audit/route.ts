import { NextRequest, NextResponse } from "next/server";
import { requireAuthenticatedUser, getAuditMetadata, handleDalError } from "@/lib/dal";
import { apiSuccess } from "@/lib/api/response";
import { handleCorsPreflight } from "@/lib/api/cors";

export async function OPTIONS(request: NextRequest): Promise<NextResponse> {
  return handleCorsPreflight(request);
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const principal = await requireAuthenticatedUser(request);
    const limit = parseInt(request.nextUrl.searchParams.get("limit") || "50", 10);
    const logs = await getAuditMetadata(principal, limit);
    return apiSuccess(logs, request, { status: 200 });
  } catch (err) {
    return handleDalError(err, request);
  }
}
