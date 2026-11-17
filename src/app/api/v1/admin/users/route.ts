import { NextRequest, NextResponse } from "next/server";
import { requireAuthenticatedUser, listUsersForAdmin, handleDalError } from "@/lib/dal";
import { apiSuccess } from "@/lib/api/response";
import { handleCorsPreflight } from "@/lib/api/cors";

export async function OPTIONS(request: NextRequest): Promise<NextResponse> {
  return handleCorsPreflight(request);
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const principal = await requireAuthenticatedUser(request);
    const searchParams = request.nextUrl.searchParams;
    const page = parseInt(searchParams.get("page") || "1", 10);
    const limit = parseInt(searchParams.get("limit") || "10", 10);
    const role = searchParams.get("role") || undefined;
    const status = searchParams.get("status") || undefined;
    const search = searchParams.get("search") || undefined;

    const result = await listUsersForAdmin(principal, {
      page,
      limit,
      role,
      status,
      search,
    });
    return apiSuccess(result, request, { status: 200 });
  } catch (err) {
    return handleDalError(err, request);
  }
}
