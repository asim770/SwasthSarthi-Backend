import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  requireAuthenticatedUser,
  getLaboratoryOrders,
  getDoctorLaboratoryOrders,
  getPatientLaboratoryOrders,
  createLaboratoryOrder,
  ForbiddenError,
  handleDalError,
} from "@/lib/dal";
import { apiSuccess } from "@/lib/api/response";
import { handleCorsPreflight } from "@/lib/api/cors";

const createOrderSchema = z.object({
  patientId: z.string().min(1, "Patient ID is required"),
  targetFacility: z.string().min(2, "Target facility is required"),
  testName: z.string().min(2, "Test name is required"),
  testCode: z.string().min(2, "Test code is required"),
  priority: z.enum(["ROUTINE", "URGENT", "STAT"]).optional(),
  instructions: z.string().max(500).optional(),
});

export async function OPTIONS(request: NextRequest): Promise<NextResponse> {
  return handleCorsPreflight(request);
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const principal = await requireAuthenticatedUser(request);
    const { searchParams } = new URL(request.url);
    const status = searchParams.get("status") || undefined;

    let orders;
    if (principal.role === "laboratory") {
      orders = await getLaboratoryOrders(principal, { status });
    } else if (principal.role === "doctor") {
      orders = await getDoctorLaboratoryOrders(principal, { status });
    } else if (principal.role === "patient") {
      orders = await getPatientLaboratoryOrders(principal, { status });
    } else {
      throw new ForbiddenError("You are not authorized to query laboratory orders.");
    }

    return apiSuccess(orders, request, { status: 200 });
  } catch (err) {
    return handleDalError(err, request);
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const principal = await requireAuthenticatedUser(request);
    const body = await request.json();
    const validatedInput = createOrderSchema.parse(body);

    const order = await createLaboratoryOrder(principal, validatedInput);
    return apiSuccess(order, request, { status: 201 });
  } catch (err) {
    return handleDalError(err, request);
  }
}
