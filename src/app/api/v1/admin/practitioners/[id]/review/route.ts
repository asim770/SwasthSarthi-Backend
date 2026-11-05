import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  requireAuthenticatedUser,
  reviewPractitioner,
  handleDalError,
} from "@/lib/dal";
import { apiSuccess, apiError } from "@/lib/api/response";
import { handleCorsPreflight } from "@/lib/api/cors";

export async function OPTIONS(request: NextRequest): Promise<NextResponse> {
  return handleCorsPreflight(request);
}

const ReviewDecisionSchema = z.object({
  decision: z.preprocess((val) => {
    if (val === "APPROVE") return "APPROVED";
    if (val === "REJECT") return "REJECTED";
    if (val === "SUSPEND") return "SUSPENDED";
    return val;
  }, z.enum(["APPROVED", "REJECTED", "SUSPENDED"])),
  reason: z
    .string()
    .optional()
    .default("Reviewed and processed by administrator."),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  try {
    const { id } = await params;
    const principal = await requireAuthenticatedUser(request);
    const body = await request.json().catch(() => ({}));
    const parse = ReviewDecisionSchema.safeParse(body);

    if (!parse.success) {
      return apiError(parse.error, request);
    }

    const practitioner = await reviewPractitioner(principal, id, parse.data);
    return apiSuccess(practitioner, request, { status: 200 });
  } catch (err) {
    return handleDalError(err, request);
  }
}
