import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  requireAuthenticatedUser,
  createHealthAssessment,
  handleDalError,
} from "@/lib/dal";
import { apiSuccess, apiError } from "@/lib/api/response";
import { handleCorsPreflight } from "@/lib/api/cors";

const assessmentSchema = z.object({
  patientId: z.string().min(1, "Patient ID is required"),
  assessmentTitle: z.string().min(2, "Assessment title is required"),
  currentAssessment: z.string().min(5, "Assessment description is required"),
  observations: z.string().optional(),
  changesSincePrevious: z.string().optional(),
  treatmentProgress: z.string().optional(),
  followUpRecommendations: z.string().optional(),
  nextReviewDate: z.string().optional(),
});

export async function OPTIONS(request: NextRequest): Promise<NextResponse> {
  return handleCorsPreflight(request);
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const principal = await requireAuthenticatedUser(request);
    const body = await request.json().catch(() => ({}));
    const parse = assessmentSchema.safeParse(body);

    if (!parse.success) {
      return apiError(parse.error, request, { status: 400 });
    }

    const record = await createHealthAssessment(principal, parse.data);
    return apiSuccess(record, request, { status: 201 });
  } catch (err) {
    return handleDalError(err, request);
  }
}
