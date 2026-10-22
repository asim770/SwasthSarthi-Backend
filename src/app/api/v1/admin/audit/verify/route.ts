import { NextRequest, NextResponse } from "next/server";
import {
  requireAuthenticatedUser,
  requireAllowedRole,
  verifyAuditChainIntegrity,
  handleDalError,
} from "@/lib/dal";
import { apiSuccess } from "@/lib/api/response";
import { handleCorsPreflight } from "@/lib/api/cors";

export async function OPTIONS(request: NextRequest): Promise<NextResponse> {
  return handleCorsPreflight(request);
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const principal = await requireAuthenticatedUser(request);
    requireAllowedRole(principal, ["admin"], "Only administrators may verify audit chain integrity.");

    const fromSeq = parseInt(request.nextUrl.searchParams.get("fromSeq") || "1", 10);
    const toSeqParam = request.nextUrl.searchParams.get("toSeq");
    const toSeq = toSeqParam ? parseInt(toSeqParam, 10) : undefined;

    const result = await verifyAuditChainIntegrity(fromSeq, toSeq);
    return apiSuccess(result, request, { status: 200 });
  } catch (err) {
    return handleDalError(err, request);
  }
}
