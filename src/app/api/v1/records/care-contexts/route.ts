import { NextRequest, NextResponse } from "next/server";
import {
  requireAuthenticatedUser,
  getDiscoverableCareContexts,
  handleDalError,
} from "@/lib/dal";
import { apiSuccess, apiError } from "@/lib/api/response";
import { handleCorsPreflight } from "@/lib/api/cors";

export async function OPTIONS(request: NextRequest): Promise<NextResponse> {
  return handleCorsPreflight(request);
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const principal = await requireAuthenticatedUser(request);
    const searchParams = request.nextUrl.searchParams;

    const patientId =
      searchParams.get("patientId") ||
      (principal.role === "patient" ? principal.id : "");

    if (!patientId) {
      return apiError(
        new Error("Query parameter 'patientId' is required."),
        request,
        {
          status: 400,
          code: "MISSING_PARAMETER",
          fallbackMessage: "Query parameter 'patientId' is required.",
        }
      );
    }

    const careContexts = await getDiscoverableCareContexts(principal, patientId);
    return apiSuccess(careContexts, request, { status: 200 });
  } catch (err) {
    return handleDalError(err, request);
  }
}
