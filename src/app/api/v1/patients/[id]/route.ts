import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  requireAuthenticatedUser,
  getPatientProfile,
  updatePatientProfile,
  handleDalError,
} from "@/lib/dal";
import { apiSuccess } from "@/lib/api/response";
import { handleCorsPreflight } from "@/lib/api/cors";

const updatePatientSchema = z.object({
  phone: z.string().min(5).max(20).optional(),
  email: z.string().email().optional(),
  gender: z.enum(["Male", "Female", "Other"]).optional(),
  dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Format: YYYY-MM-DD").optional(),
});

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
    const profile = await getPatientProfile(principal, id);
    return apiSuccess(profile, request, { status: 200 });
  } catch (err) {
    return handleDalError(err, request);
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  try {
    const { id } = await params;
    const principal = await requireAuthenticatedUser(request);
    const body = await request.json();
    const validatedInput = updatePatientSchema.parse(body);

    const updated = await updatePatientProfile(principal, id, validatedInput);
    return apiSuccess(updated, request, { status: 200 });
  } catch (err) {
    return handleDalError(err, request);
  }
}
