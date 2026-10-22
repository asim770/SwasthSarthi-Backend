import { NextRequest, NextResponse } from "next/server";
import {
  requireAuthenticatedUser,
  requireAllowedRole,
  sweepExpiredConsents,
  handleDalError,
} from "@/lib/dal";
import { apiSuccess } from "@/lib/api/response";
import { handleCorsPreflight } from "@/lib/api/cors";

export async function OPTIONS(request: NextRequest): Promise<NextResponse> {
  return handleCorsPreflight(request);
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const principal = await requireAuthenticatedUser(request);
    requireAllowedRole(principal, ["admin"], "Only administrators can trigger consent maintenance sweeps.");

    const result = await sweepExpiredConsents();
    return apiSuccess(result, request, { status: 200 });
  } catch (err) {
    return handleDalError(err, request);
  }
}
