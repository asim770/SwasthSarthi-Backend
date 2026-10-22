import { NextRequest, NextResponse } from "next/server";
import {
  requireAuthenticatedUser,
  getNotifications,
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
    const page = parseInt(request.nextUrl.searchParams.get("page") || "1", 10);
    const limit = parseInt(request.nextUrl.searchParams.get("limit") || "20", 10);
    const unreadOnly = request.nextUrl.searchParams.get("unreadOnly") === "true";

    const result = await getNotifications(principal, { page, limit, unreadOnly });
    return apiSuccess(result, request, { status: 200 });
  } catch (err) {
    return handleDalError(err, request);
  }
}
