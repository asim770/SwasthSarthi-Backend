import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  requireAuthenticatedUser,
  updateUserStatus,
  handleDalError,
} from "@/lib/dal";
import { apiSuccess } from "@/lib/api/response";
import { handleCorsPreflight } from "@/lib/api/cors";

const updateUserStatusSchema = z.object({
  isActive: z.boolean(),
});

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
    const body = await request.json();
    const { isActive } = updateUserStatusSchema.parse(body);

    const updated = await updateUserStatus(principal, id, isActive);
    return apiSuccess(updated, request, { status: 200 });
  } catch (err) {
    return handleDalError(err, request);
  }
}
