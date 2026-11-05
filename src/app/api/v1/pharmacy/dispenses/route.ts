import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  requireAuthenticatedUser,
  getDispensingHistory,
  recordDispensation,
  handleDalError,
} from "@/lib/dal";
import { apiSuccess, apiError } from "@/lib/api/response";
import { handleCorsPreflight } from "@/lib/api/cors";

const directDispenseSchema = z.object({
  prescriptionId: z.string().min(1, "prescriptionId is required"),
  quantityToDispense: z.number().int().positive().optional(),
  idempotencyKey: z.string().max(100).optional(),
  batchNumber: z.string().max(50).optional(),
  notes: z.string().max(300).optional(),
});

export async function OPTIONS(request: NextRequest): Promise<NextResponse> {
  return handleCorsPreflight(request);
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const principal = await requireAuthenticatedUser(request);
    const history = await getDispensingHistory(principal);
    return apiSuccess(history, request, { status: 200 });
  } catch (err) {
    return handleDalError(err, request);
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const principal = await requireAuthenticatedUser(request);
    const body = await request.json().catch(() => ({}));
    const parse = directDispenseSchema.safeParse(body);

    if (!parse.success) {
      return apiError(parse.error, request, { status: 400 });
    }

    const { prescriptionId, ...dispenseInput } = parse.data;
    const result = await recordDispensation(principal, prescriptionId, dispenseInput);
    return apiSuccess(result, request, { status: 201 });
  } catch (err) {
    return handleDalError(err, request);
  }
}

