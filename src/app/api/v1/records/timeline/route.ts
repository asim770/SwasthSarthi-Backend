import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  requireAuthenticatedUser,
  getAuthorizedTimeline,
  handleDalError,
} from "@/lib/dal";
import { apiSuccess, apiError } from "@/lib/api/response";
import { handleCorsPreflight } from "@/lib/api/cors";

const timelineQuerySchema = z.object({
  patientId: z.string().min(1, "patientId is required"),
  resourceType: z.string().optional(),
  fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}/, "Format: YYYY-MM-DD").optional(),
  toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}/, "Format: YYYY-MM-DD").optional(),
  search: z.string().max(100).optional(),
  sourceInstitution: z.string().max(100).optional(),
});

export async function OPTIONS(request: NextRequest): Promise<NextResponse> {
  return handleCorsPreflight(request);
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const principal = await requireAuthenticatedUser(request);
    const searchParams = request.nextUrl.searchParams;

    const patientId =
      searchParams.get("patientId") ||
      (principal.role === "patient" ? principal.id : "");

    if (!patientId) {
      return apiError(
        new Error("Query parameter 'patientId' is required."),
        request,
        {
          status: 400,
          code: "MISSING_PARAMETER",
          fallbackMessage: "Query parameter 'patientId' is required.",
        }
      );
    }

    const validatedQuery = timelineQuerySchema.parse({
      patientId,
      resourceType: searchParams.get("resourceType") || undefined,
      fromDate: searchParams.get("fromDate") || undefined,
      toDate: searchParams.get("toDate") || undefined,
      search: searchParams.get("search") || undefined,
      sourceInstitution: searchParams.get("sourceInstitution") || undefined,
    });

    const items = await getAuthorizedTimeline(principal, validatedQuery.patientId, {
      resourceType: validatedQuery.resourceType,
      fromDate: validatedQuery.fromDate,
      toDate: validatedQuery.toDate,
      search: validatedQuery.search,
      sourceInstitution: validatedQuery.sourceInstitution,
    });

    return apiSuccess(items, request, { status: 200 });
  } catch (err) {
    return handleDalError(err, request);
  }
}
