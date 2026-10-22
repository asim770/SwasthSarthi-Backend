import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  requireAuthenticatedUser,
  getEligiblePrescriptions,
  getDoctorPrescriptions,
  getPatientPrescriptions,
  createPrescription,
  ForbiddenError,
  handleDalError,
} from "@/lib/dal";
import { apiSuccess } from "@/lib/api/response";
import { handleCorsPreflight } from "@/lib/api/cors";

const medicationItemSchema = z.object({
  code: z.string().optional(),
  name: z.string().min(1, "Medication name is required"),
  dosage: z.string().min(1, "Dosage is required"),
  frequency: z.string().min(1, "Frequency is required"),
  durationDays: z.number().int().positive("Duration must be positive"),
  route: z.string().optional(),
  quantity: z.number().int().positive().optional(),
  instructions: z.string().max(300).optional(),
});

const createPrescriptionSchema = z.object({
  patientId: z.string().min(1, "Patient ID is required"),
  medications: z.array(medicationItemSchema).min(1, "At least one medication is required"),
  maxRefills: z.number().int().min(0).max(5).optional(),
  validityDays: z.number().int().min(1).max(365).optional(),
  instructions: z.string().max(500).optional(),
});

export async function OPTIONS(request: NextRequest): Promise<NextResponse> {
  return handleCorsPreflight(request);
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const principal = await requireAuthenticatedUser(request);
    const { searchParams } = new URL(request.url);
    const status = searchParams.get("status") || undefined;

    let prescriptions;
    if (principal.role === "pharmacy") {
      prescriptions = await getEligiblePrescriptions(principal, { status });
    } else if (principal.role === "doctor") {
      prescriptions = await getDoctorPrescriptions(principal, { status });
    } else if (principal.role === "patient") {
      prescriptions = await getPatientPrescriptions(principal, { status });
    } else {
      throw new ForbiddenError("You are not authorized to view prescriptions.");
    }

    return apiSuccess(prescriptions, request, { status: 200 });
  } catch (err) {
    return handleDalError(err, request);
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const principal = await requireAuthenticatedUser(request);
    const body = await request.json();
    const validatedInput = createPrescriptionSchema.parse(body);

    const prescription = await createPrescription(principal, validatedInput);
    return apiSuccess(prescription, request, { status: 201 });
  } catch (err) {
    return handleDalError(err, request);
  }
}
