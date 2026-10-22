import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  requireAuthenticatedUser,
  recordDispensation,
  handleDalError,
} from "@/lib/dal";
import { apiSuccess } from "@/lib/api/response";
import { handleCorsPreflight } from "@/lib/api/cors";

const dispenseSchema = z.object({
  quantityToDispense: z.number().int().positive().optional(),
  idempotencyKey: z.string().max(100).optional(),
  batchNumber: z.string().max(50).optional(),
  notes: z.string().max(300).optional(),
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
    let body = {};
    try {
      body = await request.json();
    } catch {
      // Body is optional
    }
    const validatedInput = dispenseSchema.parse(body);

    const result = await recordDispensation(principal, id, validatedInput);
    return apiSuccess(result, request, { status: 200 });
  } catch (err) {
    return handleDalError(err, request);
  }
}
