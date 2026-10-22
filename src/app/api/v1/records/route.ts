import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  requireAuthenticatedUser,
  getHealthRecordsForPatient,
  createHealthRecord,
  handleDalError,
} from "@/lib/dal";
import { apiSuccess, apiError } from "@/lib/api/response";
import { handleCorsPreflight } from "@/lib/api/cors";

const createRecordSchema = z.object({
  patientId: z.string().min(1, "patientId is required"),
  title: z.string().min(3).max(120),
  resourceType: z.enum([
    "DiagnosticReport",
    "Encounter",
    "Immunization",
    "Observation",
    "MedicationRequest",
  ]),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}/, "Format: YYYY-MM-DD"),
  providerFacility: z.string().optional(),
  summary: z.string().min(5).max(1000),
  clinicalData: z.record(z.string(), z.unknown()).optional(),
});

export async function OPTIONS(request: NextRequest): Promise<NextResponse> {
  return handleCorsPreflight(request);
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const principal = await requireAuthenticatedUser(request);
    const searchParams = request.nextUrl.searchParams;

    const patientId = searchParams.get("patientId") || (principal.role === "patient" ? principal.id : "");
    if (!patientId) {
      return apiError(
        new Error("Query parameter 'patientId' is required."),
        request,
        { status: 400, code: "MISSING_PARAMETER", fallbackMessage: "Query parameter 'patientId' is required." }
      );
    }

    const filter = {
      resourceType: searchParams.get("resourceType") || undefined,
      fromDate: searchParams.get("fromDate") || undefined,
      toDate: searchParams.get("toDate") || undefined,
    };

    const records = await getHealthRecordsForPatient(principal, patientId, filter);
    return apiSuccess(records, request, { status: 200 });
  } catch (err) {
    return handleDalError(err, request);
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const principal = await requireAuthenticatedUser(request);
    const body = await request.json();
    const validatedInput = createRecordSchema.parse(body);

    const record = await createHealthRecord(principal, validatedInput);
    return apiSuccess(record, request, { status: 201 });
  } catch (err) {
    return handleDalError(err, request);
  }
}
