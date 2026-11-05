import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  requireAuthenticatedUser,
  getLaboratorySubmittedReports,
  uploadDirectLaboratoryReport,
  handleDalError,
} from "@/lib/dal";
import { apiSuccess, apiError } from "@/lib/api/response";
import { handleCorsPreflight } from "@/lib/api/cors";

const directReportSchema = z.object({
  patientId: z.string().min(1, "Patient ID is required"),
  testName: z.string().min(2, "Test name is required"),
  testCategory: z.string().optional(),
  testDate: z.string().optional(),
  observations: z
    .array(
      z.object({
        code: z.string().min(1),
        name: z.string().min(1),
        value: z.union([z.number(), z.string()]),
        unit: z.string().optional(),
        referenceRange: z.string().optional(),
        interpretation: z.string().optional(),
      })
    )
    .optional(),
  testResults: z.record(z.string(), z.unknown()).optional(),
  technicianName: z.string().optional(),
  laboratoryName: z.string().optional(),
  pdfAttachment: z.string().optional(),
  notes: z.string().optional(),
  summary: z.string().optional(),
  orderId: z.string().optional(),
});

export async function OPTIONS(request: NextRequest): Promise<NextResponse> {
  return handleCorsPreflight(request);
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const principal = await requireAuthenticatedUser(request);
    const reports = await getLaboratorySubmittedReports(principal);
    return apiSuccess(reports, request, { status: 200 });
  } catch (err) {
    return handleDalError(err, request);
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const principal = await requireAuthenticatedUser(request);
    const body = await request.json().catch(() => ({}));
    const parse = directReportSchema.safeParse(body);

    if (!parse.success) {
      return apiError(parse.error, request, { status: 400 });
    }

    const result = await uploadDirectLaboratoryReport(principal, parse.data);
    return apiSuccess(result, request, { status: 201 });
  } catch (err) {
    return handleDalError(err, request);
  }
}

