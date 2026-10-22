import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  requireAuthenticatedUser,
  submitDiagnosticReport,
  handleDalError,
} from "@/lib/dal";
import { apiSuccess } from "@/lib/api/response";
import { handleCorsPreflight } from "@/lib/api/cors";

const submitReportSchema = z.object({
  title: z.string().min(3).max(120),
  summary: z.string().min(5).max(1000),
  testResults: z.record(z.string(), z.unknown()).optional(),
});

export async function OPTIONS(request: NextRequest): Promise<NextResponse> {
  return handleCorsPreflight(request);
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  try {
    const { id } = await params;
    const principal = await requireAuthenticatedUser(request);
    const body = await request.json();
    const validatedInput = submitReportSchema.parse(body);

    const result = await submitDiagnosticReport(principal, id, validatedInput);
    return apiSuccess(result, request, { status: 201 });
  } catch (err) {
    return handleDalError(err, request);
  }
}
