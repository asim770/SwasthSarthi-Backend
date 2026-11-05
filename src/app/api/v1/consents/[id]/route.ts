import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  requireAuthenticatedUser,
  getConsentById,
  updateConsentStatus,
  handleDalError,
} from "@/lib/dal";
import { apiSuccess } from "@/lib/api/response";
import { handleCorsPreflight } from "@/lib/api/cors";

const updateConsentSchema = z
  .object({
    status: z.string().optional(),
    decision: z.string().optional(),
    note: z.string().optional(),
  })
  .transform((data) => {
    let raw = (data.status || data.decision || "").toUpperCase();
    if (raw === "APPROVED") raw = "GRANTED";
    if (raw === "REJECTED") raw = "DENIED";
    if (!["GRANTED", "DENIED", "REVOKED"].includes(raw)) {
      raw = "GRANTED";
    }
    return { status: raw as "GRANTED" | "DENIED" | "REVOKED" };
  });

export async function OPTIONS(request: NextRequest): Promise<NextResponse> {
  return handleCorsPreflight(request);
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  try {
    const { id } = await params;
    const principal = await requireAuthenticatedUser(request);
    const consent = await getConsentById(principal, id);
    return apiSuccess(consent, request, { status: 200 });
  } catch (err) {
    return handleDalError(err, request);
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  try {
    const { id } = await params;
    const principal = await requireAuthenticatedUser(request);
    const body = await request.json();
    const { status } = updateConsentSchema.parse(body);

    const updated = await updateConsentStatus(principal, id, status);
    return apiSuccess(updated, request, { status: 200 });
  } catch (err) {
    return handleDalError(err, request);
  }
}
