import { NextRequest, NextResponse } from "next/server";
import {
  requireAuthenticatedUser,
  deleteNotification,
  handleDalError,
} from "@/lib/dal";
import { apiSuccess } from "@/lib/api/response";
import { handleCorsPreflight } from "@/lib/api/cors";

export async function OPTIONS(request: NextRequest): Promise<NextResponse> {
  return handleCorsPreflight(request);
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  try {
    const { id } = await params;
    const principal = await requireAuthenticatedUser(request);
    const result = await deleteNotification(principal, id);
    return apiSuccess(result, request, { status: 200 });
  } catch (err) {
    return handleDalError(err, request);
  }
}
