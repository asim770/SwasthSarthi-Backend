import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  requireAuthenticatedUser,
  denyConsent,
  handleDalError,
} from "@/lib/dal";
import { apiSuccess } from "@/lib/api/response";
import { handleCorsPreflight } from "@/lib/api/cors";

const denyConsentSchema = z.object({
  reason: z.string().max(250).optional(),
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
      body = {};
    }
    const validatedInput = denyConsentSchema.parse(body);

    const deniedConsent = await denyConsent(principal, id, validatedInput.reason);
    return apiSuccess(deniedConsent, request, { status: 200 });
  } catch (err) {
    return handleDalError(err, request);
  }
}
