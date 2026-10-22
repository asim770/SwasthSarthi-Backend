import { NextRequest, NextResponse } from "next/server";
import {
  requireAuthenticatedUser,
  listPractitionerVerifications,
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
    const status = request.nextUrl.searchParams.get("status") || undefined;
    const practitioners = await listPractitionerVerifications(principal, status);
    return apiSuccess(practitioners, request, { status: 200 });
  } catch (err) {
    return handleDalError(err, request);
  }
}
