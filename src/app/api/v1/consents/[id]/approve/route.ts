import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  requireAuthenticatedUser,
  approveConsent,
  handleDalError,
} from "@/lib/dal";
import { apiSuccess } from "@/lib/api/response";
import { handleCorsPreflight } from "@/lib/api/cors";

const approveConsentSchema = z.object({
  approvedHiTypes: z.array(z.string()).optional(),
  note: z.string().max(250).optional(),
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
      // Empty body is allowed, defaults to all requested categories
      body = {};
    }
    const validatedInput = approveConsentSchema.parse(body);

    const approvedConsent = await approveConsent(principal, id, validatedInput);
    return apiSuccess(approvedConsent, request, { status: 200 });
  } catch (err) {
    return handleDalError(err, request);
  }
}
