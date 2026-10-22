import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  requireAuthenticatedUser,
  initiateScopedHealthTransfer,
  handleDalError,
} from "@/lib/dal";
import { apiSuccess } from "@/lib/api/response";
import { handleCorsPreflight } from "@/lib/api/cors";

const initiateTransferSchema = z.object({
  consentId: z.string().min(1, "consentId is required"),
  patientId: z.string().min(1, "patientId is required"),
  hipId: z.string().min(1, "hipId is required"),
  transactionId: z.string().optional(),
  requestedHiTypes: z.array(z.string()).optional(),
  dateRangeFrom: z.string().optional(),
  dateRangeTo: z.string().optional(),
});

export async function OPTIONS(request: NextRequest): Promise<NextResponse> {
  return handleCorsPreflight(request);
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const principal = await requireAuthenticatedUser(request);
    const body = await request.json();
    const validatedInput = initiateTransferSchema.parse(body);

    const report = await initiateScopedHealthTransfer(principal, validatedInput);
    return apiSuccess(report, request, { status: 202 });
  } catch (err) {
    return handleDalError(err, request);
  }
}
