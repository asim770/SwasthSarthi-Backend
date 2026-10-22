import { NextRequest, NextResponse } from "next/server";
import {
  requireAuthenticatedUser,
  markNotificationAsRead,
  handleDalError,
} from "@/lib/dal";
import { apiSuccess } from "@/lib/api/response";
import { handleCorsPreflight } from "@/lib/api/cors";

export async function OPTIONS(request: NextRequest): Promise<NextResponse> {
  return handleCorsPreflight(request);
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  try {
    const { id } = await params;
    const principal = await requireAuthenticatedUser(request);
    const notification = await markNotificationAsRead(principal, id);
    return apiSuccess(notification, request, { status: 200 });
  } catch (err) {
    return handleDalError(err, request);
  }
}
