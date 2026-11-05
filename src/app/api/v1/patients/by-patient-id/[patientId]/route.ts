import { NextRequest, NextResponse } from "next/server";
import {
  requireAuthenticatedUser,
  getPatientProfile,
  handleDalError,
} from "@/lib/dal";
import { apiSuccess } from "@/lib/api/response";
import { handleCorsPreflight } from "@/lib/api/cors";

export async function OPTIONS(request: NextRequest): Promise<NextResponse> {
  return handleCorsPreflight(request);
}

/**
 * GET /api/v1/patients/by-patient-id/[patientId]
 * Retrieve full patient demographic profile using unique Patient ID
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ patientId: string }> }
): Promise<NextResponse> {
  try {
    const { patientId } = await params;
    const principal = await requireAuthenticatedUser(request);
    const profile = await getPatientProfile(principal, patientId);
    return apiSuccess(profile, request, { status: 200 });
  } catch (err) {
    return handleDalError(err, request);
  }
}
