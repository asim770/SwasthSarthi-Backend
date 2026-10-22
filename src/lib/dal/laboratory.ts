import mongoose from "mongoose";
import { LabOrder, ILabOrder } from "@/lib/db/models/LabOrder";
import { HealthRecord } from "@/lib/db/models/HealthRecord";
import { SourceInstitutionRecord } from "@/lib/db/models/SourceInstitutionRecord";
import { User } from "@/lib/db/models/User";
import { ConsentArtifact } from "@/lib/db/models/ConsentArtifact";
import { AuthenticatedPrincipal } from "./types";
import {
  ForbiddenError,
  NotFoundError,
  InvalidQueryError,
  ConsentRequiredError,
} from "./errors";
import {
  requireAllowedRole,
  assertFacilityMembership,
  assertDenyAdminClinicalAccess,
} from "./policies";
import { assertSafeQueryInput, assertSafeIdentifier } from "./sanitizer";
import { logAuditEvent } from "./audit";
import { assertFacilityApproved } from "./onboarding";
import { createNotification } from "./notifications";
import { connectToDatabase } from "@/lib/db/connect";
import { validateFhirResource } from "@/lib/fhir/validator";

export interface CreateLabOrderInput {
  patientId: string;
  targetFacility: string;
  testName: string;
  testCode: string;
  priority?: "ROUTINE" | "URGENT" | "STAT";
  instructions?: string;
}

export interface DiagnosticObservationInput {
  code: string;
  name: string;
  value: number | string;
  unit?: string;
  referenceRange?: string;
  interpretation?: string;
}

export interface SubmitDiagnosticReportInput {
  title: string;
  summary: string;
  observations?: DiagnosticObservationInput[];
  testResults?: Record<string, unknown>;
  diagnosticReportFhir?: Record<string, unknown>;
}

export interface LabOrderFilter {
  status?: string;
}

/**
 * Doctor creates a synthetic laboratory test order (ServiceRequest)
 */
export async function createLaboratoryOrder(
  principal: AuthenticatedPrincipal,
  input: CreateLabOrderInput
): Promise<ILabOrder> {
  requireAllowedRole(principal, ["doctor"], "Only licensed medical practitioners may order laboratory tests.");
  assertSafeQueryInput(input);
  assertSafeIdentifier(input.patientId, "patientId");
  await connectToDatabase();

  if (!mongoose.isValidObjectId(input.patientId)) {
    throw new InvalidQueryError("Invalid patient identifier format.");
  }

  const patient = await User.findById(input.patientId);
  if (!patient || !patient.isActive || patient.role !== "patient") {
    throw new NotFoundError("Target patient does not exist or account is inactive.");
  }

  // Doctor must have active consent or authorized clinical access for this patient
  const activeConsent = await ConsentArtifact.findOne({
    patientId: patient._id,
    requesterDoctorId: principal.id,
    status: "GRANTED",
    expiresAt: { $gt: new Date() },
  });

  if (!activeConsent) {
    await logAuditEvent({
      action: "CREATE_LAB_ORDER_DENIED",
      principal,
      targetResourceType: "LabOrder",
      targetPatientId: patient._id.toString(),
      outcome: "DENIED",
      denialReason: "No active patient electronic consent found for requesting doctor",
    });
    throw new ConsentRequiredError(
      "Active patient electronic consent is required before ordering clinical tests."
    );
  }

  const orderId = `LAB-ORD-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
  const priority = input.priority || "ROUTINE";

  // Construct canonical FHIR R4 ServiceRequest
  const serviceRequestFhir = {
    resourceType: "ServiceRequest",
    id: orderId,
    status: "active",
    intent: "order",
    priority: priority.toLowerCase(),
    code: {
      coding: [
        {
          system: "http://loinc.org",
          code: input.testCode.trim(),
          display: input.testName.trim(),
        },
      ],
      text: input.testName.trim(),
    },
    subject: {
      reference: `Patient/${patient._id.toString()}`,
      display: patient.name,
    },
    requester: {
      reference: `Practitioner/${principal.id}`,
      display: principal.name,
    },
    performer: [
      {
        display: input.targetFacility.trim(),
      },
    ],
    authoredOn: new Date().toISOString(),
    note: input.instructions
      ? [{ text: input.instructions.trim() }]
      : undefined,
  };

  // Validate FHIR R4 ServiceRequest structure
  const validation = validateFhirResource(serviceRequestFhir, {
    expectedPatientId: patient._id.toString(),
    expectedResourceType: "ServiceRequest",
  });

  if (!validation.isValid) {
    const errorMsg = validation.issues.map((i) => i.message).join("; ");
    throw new InvalidQueryError(`ServiceRequest FHIR validation failed: ${errorMsg}`);
  }

  const order = await LabOrder.create({
    orderId,
    patientId: patient._id,
    patientName: patient.name,
    patientAbha: patient.abhaAddress || patient.abhaId,
    doctorId: new mongoose.Types.ObjectId(principal.id),
    doctorName: principal.name,
    targetFacility: input.targetFacility.trim(),
    testName: input.testName.trim(),
    testCode: input.testCode.trim(),
    priority,
    instructions: input.instructions?.trim(),
    status: "ORDERED",
    orderedAt: new Date(),
    fhirResource: serviceRequestFhir,
  });

  await logAuditEvent({
    action: "CREATE_LAB_ORDER",
    principal,
    targetResourceType: "LabOrder",
    targetResourceId: orderId,
    targetPatientId: patient._id.toString(),
    outcome: "ALLOWED",
    metadata: {
      orderId,
      testName: input.testName,
      targetFacility: input.targetFacility,
      priority,
    },
  });

  return order;
}

/**
 * Retrieve laboratory test orders assigned to the authenticated laboratory facility
 */
export async function getLaboratoryOrders(
  principal: AuthenticatedPrincipal,
  filter?: LabOrderFilter
): Promise<ILabOrder[]> {
  assertDenyAdminClinicalAccess(principal, "laboratory orders");
  requireAllowedRole(principal, ["laboratory"], "Only laboratory technicians may query test orders.");
  assertSafeQueryInput(filter);
  await connectToDatabase();

  if (!principal.facility) {
    throw new ForbiddenError("Laboratory user is not affiliated with a registered facility.");
  }

  const query: Record<string, unknown> = {
    targetFacility: principal.facility,
  };

  if (filter?.status && filter.status !== "ALL") {
    query.status = filter.status;
  }

  // Facility-scoped order filtering
  const orders = await LabOrder.find(query).sort({ orderedAt: -1 });

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
 * Retrieve laboratory orders created by the authenticated doctor
 */
export async function getDoctorLaboratoryOrders(
  principal: AuthenticatedPrincipal,
  filter?: LabOrderFilter
): Promise<ILabOrder[]> {
  requireAllowedRole(principal, ["doctor"], "Only doctors may query their created orders.");
  assertSafeQueryInput(filter);
  await connectToDatabase();

  const query: Record<string, unknown> = {
    doctorId: new mongoose.Types.ObjectId(principal.id),
  };

  if (filter?.status && filter.status !== "ALL") {
    query.status = filter.status;
  }

  return LabOrder.find(query).sort({ orderedAt: -1 });
}

/**
 * Retrieve laboratory orders for the authenticated patient
 */
export async function getPatientLaboratoryOrders(
  principal: AuthenticatedPrincipal,
  filter?: LabOrderFilter
): Promise<ILabOrder[]> {
  requireAllowedRole(principal, ["patient"], "Only patients may query their laboratory orders.");
  assertSafeQueryInput(filter);
  await connectToDatabase();

  const query: Record<string, unknown> = {
    patientId: new mongoose.Types.ObjectId(principal.id),
  };

  if (filter?.status && filter.status !== "ALL") {
    query.status = filter.status;
  }

  return LabOrder.find(query).sort({ orderedAt: -1 });
}

/**
 * Retrieve single laboratory test order by ID with role and facility boundary check
 */
export async function getLaboratoryOrderById(
  principal: AuthenticatedPrincipal,
  orderId: string
): Promise<ILabOrder> {
  assertDenyAdminClinicalAccess(principal, "laboratory orders");
  assertSafeIdentifier(orderId, "orderId");
  await connectToDatabase();

  const order = await LabOrder.findOne({ orderId });
  if (!order) {
    throw new NotFoundError(`Lab order '${orderId}' not found.`);
  }

  // Enforce boundary per role
  if (principal.role === "laboratory") {
    assertFacilityMembership(principal, order.targetFacility);
  } else if (principal.role === "doctor") {
    if (order.doctorId.toString() !== principal.id) {
      throw new ForbiddenError("You are not authorized to access orders created by another practitioner.");
    }
  } else if (principal.role === "patient") {
    if (order.patientId.toString() !== principal.id) {
      throw new ForbiddenError("You are not authorized to view another patient's laboratory orders.");
    }
  } else {
    throw new ForbiddenError(`Role '${principal.role}' cannot view clinical laboratory orders.`);
  }

  await logAuditEvent({
    action: "READ_LAB_ORDER",
    principal,
    targetResourceType: "LabOrder",
    targetResourceId: orderId,
    targetPatientId: order.patientId,
    outcome: "ALLOWED",
  });

  return order;
}

/**
 * Submit diagnostic report for an authorized test order and persist to simulated source laboratory
 */
export async function submitDiagnosticReport(
  principal: AuthenticatedPrincipal,
  orderId: string,
  input: SubmitDiagnosticReportInput
): Promise<{ order: ILabOrder; reportRecordId: string; fhirDiagnosticReport: Record<string, unknown> }> {
  requireAllowedRole(principal, ["laboratory"], "Only laboratory technicians may submit diagnostic reports.");
  assertSafeIdentifier(orderId, "orderId");
  assertSafeQueryInput(input);
  await connectToDatabase();

  const order = await LabOrder.findOne({ orderId });
  if (!order) {
    throw new NotFoundError(`Lab order '${orderId}' not found.`);
  }

  // Enforce facility boundary: lab can only submit for orders assigned to their facility
  assertFacilityMembership(principal, order.targetFacility);
  await assertFacilityApproved(order.targetFacility);

  if (order.status === "COMPLETED") {
    throw new InvalidQueryError("Diagnostic report has already been completed for this order.");
  }

  if (order.status === "CANCELLED") {
    throw new InvalidQueryError("Cannot submit report for a cancelled order.");
  }

  // Validate optional custom FHIR payload if supplied
  if (input.diagnosticReportFhir) {
    const fhir = input.diagnosticReportFhir;
    const validation = validateFhirResource(fhir, {
      expectedPatientId: order.patientId.toString(),
      expectedResourceType: "DiagnosticReport",
    });

    if (!validation.isValid) {
      await logAuditEvent({
        action: "LAB_REPORT_VALIDATION_FAILED",
        principal,
        targetResourceType: "DiagnosticReport",
        targetResourceId: orderId,
        outcome: "DENIED",
        denialReason: "FHIR DiagnosticReport payload failed validation schema",
      });
      const errorMsg = validation.issues.map((i) => i.message).join("; ");
      throw new InvalidQueryError(`Invalid FHIR DiagnosticReport: ${errorMsg}`);
    }

    // Reference validation: verify subject reference links to order's patient
    const subject = fhir.subject as { reference?: string } | undefined;
    if (subject?.reference && subject.reference !== `Patient/${order.patientId.toString()}`) {
      throw new InvalidQueryError("DiagnosticReport subject reference must match order patient.");
    }

    // Verify basedOn reference if provided
    const basedOn = fhir.basedOn as Array<{ reference?: string }> | undefined;
    if (basedOn && basedOn.length > 0) {
      const matchingRef = basedOn.some((b) => b.reference === `ServiceRequest/${order.orderId}`);
      if (!matchingRef) {
        throw new InvalidQueryError("DiagnosticReport basedOn reference does not match order ID.");
      }
    }
  }

  // Generate canonical record ID
  const reportRecordId = `REC-LAB-${Date.now().toString(36).toUpperCase()}`;
  const careContextId = order.orderId;
  const now = new Date();

  // Resolve simulated source institution ID
  const facility = principal.facility || order.targetFacility;
  let institutionId = "HIP-LAL-003";
  if (facility.toLowerCase().includes("max")) {
    institutionId = "HIP-MAX-001";
  } else if (facility.toLowerCase().includes("apollo")) {
    institutionId = "HIP-APOLLO-002";
  } else if (facility.toLowerCase().includes("fortis")) {
    institutionId = "HIP-FORTIS-004";
  }

  // Create individual FHIR Observations if structured observations provided
  const observationResults: Array<{ reference: string; display: string }> = [];

  if (input.observations && input.observations.length > 0) {
    for (let i = 0; i < input.observations.length; i++) {
      const obs = input.observations[i];
      const obsId = `OBS-${order.orderId}-${i + 1}`;
      const fhirObservation = {
        resourceType: "Observation",
        id: obsId,
        status: "final",
        code: {
          coding: [{ system: "http://loinc.org", code: obs.code, display: obs.name }],
          text: obs.name,
        },
        subject: {
          reference: `Patient/${order.patientId.toString()}`,
          display: order.patientName,
        },
        effectiveDateTime: now.toISOString(),
        valueQuantity: typeof obs.value === "number" ? {
          value: obs.value,
          unit: obs.unit || "unit",
        } : undefined,
        valueString: typeof obs.value === "string" ? obs.value : undefined,
        interpretation: obs.interpretation
          ? [{ text: obs.interpretation }]
          : undefined,
        referenceRange: obs.referenceRange
          ? [{ text: obs.referenceRange }]
          : undefined,
      };

      // Store Observation at simulated source laboratory
      await SourceInstitutionRecord.create({
        recordId: `SRC-OBS-${Date.now().toString(36).toUpperCase()}-${i}`,
        institutionId,
        institutionName: facility,
        institutionType: "laboratory",
        patientAbhaId: order.patientAbha,
        patientAbhaAddress: order.patientAbha,
        patientName: order.patientName,
        careContextId,
        careContextDescription: `${order.testName} - Component Observation`,
        resourceType: "Observation",
        recordDate: now,
        status: "final",
        fhirResource: fhirObservation,
        isMockData: true,
      });

      observationResults.push({
        reference: `Observation/${obsId}`,
        display: obs.name,
      });
    }
  }

  // Build canonical FHIR R4 DiagnosticReport
  const canonicalDiagnosticReport = input.diagnosticReportFhir || {
    resourceType: "DiagnosticReport",
    id: reportRecordId,
    status: "final",
    code: {
      coding: [
        {
          system: "http://loinc.org",
          code: order.testCode,
          display: order.testName,
        },
      ],
      text: input.title.trim(),
    },
    subject: {
      reference: `Patient/${order.patientId.toString()}`,
      display: order.patientName,
    },
    basedOn: [
      {
        reference: `ServiceRequest/${order.orderId}`,
        display: order.testName,
      },
    ],
    performer: [
      {
        reference: `Organization/${institutionId}`,
        display: facility,
      },
    ],
    effectiveDateTime: now.toISOString(),
    issued: now.toISOString(),
    result: observationResults,
    conclusion: input.summary.trim(),
  };

  // 1. Store DiagnosticReport at simulated source laboratory for ABDM exchange
  await SourceInstitutionRecord.create({
    recordId: `SRC-DR-${Date.now().toString(36).toUpperCase()}`,
    institutionId,
    institutionName: facility,
    institutionType: "laboratory",
    patientAbhaId: order.patientAbha,
    patientAbhaAddress: order.patientAbha,
    patientName: order.patientName,
    careContextId,
    careContextDescription: order.testName,
    resourceType: "DiagnosticReport",
    recordDate: now,
    status: "final",
    fhirResource: canonicalDiagnosticReport,
    isMockData: true,
  });

  // 2. Also register local health record
  await HealthRecord.create({
    recordId: reportRecordId,
    patientId: order.patientId,
    title: input.title.trim(),
    resourceType: "DiagnosticReport",
    date: now,
    providerFacility: facility,
    doctorName: `Verified by ${principal.name} (Lab Specialist)`,
    doctorId: order.doctorId,
    status: "final",
    summary: input.summary.trim(),
    careContextId,
    fhirBundleId: `urn:uuid:${crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2)}`,
    clinicalData: input.testResults || { observations: input.observations },
  });

  // 3. Mark LabOrder as completed
  order.status = "COMPLETED";
  order.completedAt = now;
  order.reportRecordId = reportRecordId;
  await order.save();

  await logAuditEvent({
    action: "SUBMIT_LAB_REPORT",
    principal,
    targetResourceType: "LabOrder",
    targetResourceId: orderId,
    targetPatientId: order.patientId,
    outcome: "ALLOWED",
    metadata: {
      reportRecordId,
      institutionId,
      facility,
      observationsCount: observationResults.length,
    },
  });

  // Notify patient that a diagnostic report is ready (safe clinical summary without lab values)
  await createNotification({
    recipientId: order.patientId,
    recipientAbha: order.patientAbha,
    recipientRole: "patient",
    category: "LAB_REPORT",
    title: "Diagnostic Report Available",
    message: `A new laboratory diagnostic report for '${order.testName}' has been finalized by ${facility}.`,
    relatedResourceId: reportRecordId,
    relatedResourceType: "DiagnosticReport",
    idempotencyKey: `notif-lab-${order.orderId}`,
  }).catch(() => {});

  return {
    order,
    reportRecordId,
    fhirDiagnosticReport: canonicalDiagnosticReport,
  };
}

/**
 * Retrieve previously submitted reports within the laboratory's authorized facility scope
 */
export async function getLaboratorySubmittedReports(
  principal: AuthenticatedPrincipal
): Promise<Array<Record<string, unknown>>> {
  requireAllowedRole(principal, ["laboratory"], "Only laboratory technicians may query facility reports.");
  await connectToDatabase();

  if (!principal.facility) {
    throw new ForbiddenError("Laboratory technician is not affiliated with a registered healthcare facility.");
  }

  const reports = await SourceInstitutionRecord.find({
    institutionName: principal.facility,
    resourceType: "DiagnosticReport",
  }).sort({ recordDate: -1 });

  return reports.map((r) => ({
    recordId: r.recordId,
    careContextId: r.careContextId,
    testName: r.careContextDescription,
    patientName: r.patientName,
    patientAbhaAddress: r.patientAbhaAddress,
    recordDate: r.recordDate,
    status: r.status,
    fhirResource: r.fhirResource,
  }));
}
