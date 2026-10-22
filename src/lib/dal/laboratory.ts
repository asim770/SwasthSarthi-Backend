import { LabOrder, ILabOrder } from "@/lib/db/models/LabOrder";
import { HealthRecord } from "@/lib/db/models/HealthRecord";
import { AuthenticatedPrincipal } from "./types";
import {
  ForbiddenError,
  NotFoundError,
  InvalidQueryError,
} from "./errors";
import { requireAllowedRole, assertFacilityMembership } from "./policies";
import { assertSafeQueryInput, assertSafeIdentifier } from "./sanitizer";
import { logAuditEvent } from "./audit";
import { connectToDatabase } from "@/lib/db/connect";

export interface SubmitDiagnosticReportInput {
  title: string;
  summary: string;
  testResults?: Record<string, unknown>;
}

/**
 * Retrieve laboratory test orders assigned to the authenticated laboratory facility
 */
export async function getLaboratoryOrders(
  principal: AuthenticatedPrincipal
): Promise<ILabOrder[]> {
  requireAllowedRole(principal, ["laboratory"], "Only laboratory technicians may query test orders.");
  await connectToDatabase();

  if (!principal.facility) {
    throw new ForbiddenError("Laboratory user is not affiliated with a registered facility.");
  }

  // Facility-scoped order filtering
  const orders = await LabOrder.find({
    targetFacility: principal.facility,
  }).sort({ orderedAt: -1 });

  await logAuditEvent({
    action: "READ_LAB_ORDERS",
    principal,
    targetResourceType: "LabOrder",
    outcome: "ALLOWED",
    metadata: { ordersCount: orders.length, facility: principal.facility },
  });

  return orders;
}

/**
 * Retrieve single laboratory test order by ID with facility boundary check
 */
export async function getLaboratoryOrderById(
  principal: AuthenticatedPrincipal,
  orderId: string
): Promise<ILabOrder> {
  requireAllowedRole(principal, ["laboratory"], "Only laboratory technicians may query test orders.");
  assertSafeIdentifier(orderId, "orderId");
  await connectToDatabase();

  const order = await LabOrder.findOne({ orderId });
  if (!order) {
    throw new NotFoundError(`Lab order '${orderId}' not found.`);
  }

  // Enforce facility boundary: lab can only see orders assigned to their facility
  assertFacilityMembership(principal, order.targetFacility);

  return order;
}

/**
 * Submit diagnostic report for an authorized test order
 */
export async function submitDiagnosticReport(
  principal: AuthenticatedPrincipal,
  orderId: string,
  input: SubmitDiagnosticReportInput
): Promise<{ order: ILabOrder; reportRecordId: string }> {
  requireAllowedRole(principal, ["laboratory"], "Only laboratory technicians may submit diagnostic reports.");
  assertSafeIdentifier(orderId, "orderId");
  assertSafeQueryInput(input);
  await connectToDatabase();

  const order = await LabOrder.findOne({ orderId });
  if (!order) {
    throw new NotFoundError(`Lab order '${orderId}' not found.`);
  }

  // Enforce facility boundary
  assertFacilityMembership(principal, order.targetFacility);

  if (order.status === "COMPLETED") {
    throw new InvalidQueryError("Diagnostic report has already been completed for this order.");
  }

  if (order.status === "CANCELLED") {
    throw new InvalidQueryError("Cannot submit report for a cancelled order.");
  }

  // Generate record ID
  const reportRecordId = `REC-LAB-${Date.now().toString(36).toUpperCase()}`;

  // 1. Create DiagnosticReport health record linked to the patient and ordering doctor
  await HealthRecord.create({
    recordId: reportRecordId,
    patientId: order.patientId,
    title: input.title.trim(),
    resourceType: "DiagnosticReport",
    date: new Date(),
    providerFacility: principal.facility || order.targetFacility,
    doctorName: `Verified by ${principal.name} (Lab Tech)`,
    doctorId: order.doctorId,
    status: "final",
    summary: input.summary.trim(),
    careContextId: `ABDM-LAB-${order.orderId}`,
    fhirBundleId: `urn:uuid:${crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2)}`,
    clinicalData: input.testResults || {},
  });

  // 2. Update order status to COMPLETED
  order.status = "COMPLETED";
  order.completedAt = new Date();
  order.reportRecordId = reportRecordId;
  await order.save();

  await logAuditEvent({
    action: "SUBMIT_LAB_REPORT",
    principal,
    targetResourceType: "LabOrder",
    targetResourceId: orderId,
    targetPatientId: order.patientId,
    outcome: "ALLOWED",
    metadata: { reportRecordId },
  });

  return { order, reportRecordId };
}
