import { NextRequest, NextResponse } from "next/server";
import { requireAuthenticatedUser, getHealthRecordById, handleDalError } from "@/lib/dal";
import { apiSuccess } from "@/lib/api/response";
import { handleCorsPreflight } from "@/lib/api/cors";

export async function OPTIONS(request: NextRequest): Promise<NextResponse> {
  return handleCorsPreflight(request);
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  try {
    const { id } = await params;
    const principal = await requireAuthenticatedUser(request);
    const record = await getHealthRecordById(principal, id);
    return apiSuccess(record, request, { status: 200 });
  } catch (err) {
    return handleDalError(err, request);
  }
}
