import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  requireAuthenticatedUser,
  reviewInstitution,
  handleDalError,
} from "@/lib/dal";
import { apiSuccess, apiError } from "@/lib/api/response";
import { handleCorsPreflight } from "@/lib/api/cors";

export async function OPTIONS(request: NextRequest): Promise<NextResponse> {
  return handleCorsPreflight(request);
}

const ReviewDecisionSchema = z.object({
  decision: z.enum(["APPROVED", "REJECTED", "SUSPENDED"]),
  reason: z.string().min(3, "Reason must be at least 3 characters."),
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

    const facility = await reviewInstitution(principal, id, parse.data);
    return apiSuccess(facility, request, { status: 200 });
  } catch (err) {
    return handleDalError(err, request);
  }
}
