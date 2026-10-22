import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  requireAuthenticatedUser,
  getConsentsForPrincipal,
  createConsentRequest,
  handleDalError,
} from "@/lib/dal";
import { apiSuccess } from "@/lib/api/response";
import { handleCorsPreflight } from "@/lib/api/cors";

const createConsentSchema = z.object({
  patientId: z.string().min(1, "patientId is required"),
  purpose: z.string().min(5).max(250),
  hiTypes: z.array(z.string()).min(1, "At least one hiType is required"),
  dateRangeFrom: z.string().transform((v) => new Date(v)),
  dateRangeTo: z.string().transform((v) => new Date(v)),
  expiresAt: z.string().transform((v) => new Date(v)),
});

export async function OPTIONS(request: NextRequest): Promise<NextResponse> {
  return handleCorsPreflight(request);
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const principal = await requireAuthenticatedUser(request);
    const consents = await getConsentsForPrincipal(principal);
    return apiSuccess(consents, request, { status: 200 });
  } catch (err) {
    return handleDalError(err, request);
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const principal = await requireAuthenticatedUser(request);
    const body = await request.json();
    const validatedInput = createConsentSchema.parse(body);

    const consent = await createConsentRequest(principal, validatedInput);
    return apiSuccess(consent, request, { status: 201 });
  } catch (err) {
    return handleDalError(err, request);
  }
}
