import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  requireAuthenticatedUser,
  createDoctorConsultation,
  handleDalError,
} from "@/lib/dal";
import { apiSuccess, apiError } from "@/lib/api/response";
import { handleCorsPreflight } from "@/lib/api/cors";

const consultationSchema = z.object({
  patientId: z.string().min(1, "Patient ID is required"),
  consultationDate: z.string().optional(),
  symptoms: z.string().min(2, "Symptoms are required"),
  clinicalFindings: z.string().optional(),
  diagnosis: z.string().min(2, "Diagnosis is required"),
  treatmentPlan: z.string().min(2, "Treatment plan is required"),
  prescribedMedicines: z
    .array(
      z.object({
        name: z.string().min(1, "Medicine name is required"),
        dosage: z.string().min(1, "Dosage is required"),
        frequency: z.string().min(1, "Frequency is required"),
        durationDays: z.number().min(1, "Duration in days is required"),
        quantity: z.number().optional(),
        instructions: z.string().optional(),
      })
    )
    .optional(),
  recommendedTests: z
    .array(
      z.object({
        testName: z.string().min(1, "Test name is required"),
        testCode: z.string().optional(),
        priority: z.enum(["ROUTINE", "URGENT", "STAT"]).optional(),
        instructions: z.string().optional(),
      })
    )
    .optional(),
  followUpDate: z.string().optional(),
  clinicalNotes: z.string().optional(),
  supportingDocuments: z.array(z.string()).optional(),
});

export async function OPTIONS(request: NextRequest): Promise<NextResponse> {
  return handleCorsPreflight(request);
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const principal = await requireAuthenticatedUser(request);
    const body = await request.json().catch(() => ({}));
    const parse = consultationSchema.safeParse(body);

    if (!parse.success) {
      return apiError(parse.error, request, { status: 400 });
    }

    const result = await createDoctorConsultation(principal, parse.data);
    return apiSuccess(result, request, { status: 201 });
  } catch (err) {
    return handleDalError(err, request);
  }
}
