import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  requireAuthenticatedUser,
  listInstitutions,
  registerInstitution,
  handleDalError,
} from "@/lib/dal";
import { apiSuccess, apiError } from "@/lib/api/response";
import { handleCorsPreflight } from "@/lib/api/cors";

export async function OPTIONS(request: NextRequest): Promise<NextResponse> {
  return handleCorsPreflight(request);
}

const RegisterInstitutionSchema = z.object({
  name: z.string().min(2, "Institution name must be at least 2 characters."),
  type: z.enum(["HOSPITAL", "LABORATORY", "PHARMACY", "CLINIC"]),
  facilityId: z.string().min(3, "Facility ID must be at least 3 characters."),
  address: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  contactPhone: z.string().optional(),
  contactEmail: z.string().email().optional(),
  demoHfrId: z.string().optional(),
});

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const principal = await requireAuthenticatedUser(request);
    const status = request.nextUrl.searchParams.get("status") || undefined;
    const institutions = await listInstitutions(principal, status);
    return apiSuccess(institutions, request, { status: 200 });
  } catch (err) {
    return handleDalError(err, request);
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const principal = await requireAuthenticatedUser(request);
    const body = await request.json().catch(() => ({}));
    const parse = RegisterInstitutionSchema.safeParse(body);

    if (!parse.success) {
      return apiError(parse.error, request);
    }

    const facility = await registerInstitution(principal, parse.data);
    return apiSuccess(facility, request, { status: 201 });
  } catch (err) {
    return handleDalError(err, request);
  }
}
