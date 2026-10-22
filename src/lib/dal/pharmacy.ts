import mongoose from "mongoose";
import { Prescription, IPrescription } from "@/lib/db/models/Prescription";
import { DispensingEvent, IDispensingEventDocument } from "@/lib/db/models/DispensingEvent";
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
  assertDenyAdminClinicalAccess,
} from "./policies";
import { assertSafeIdentifier, assertSafeQueryInput } from "./sanitizer";
import { logAuditEvent } from "./audit";
import { assertFacilityApproved } from "./onboarding";
import { connectToDatabase } from "@/lib/db/connect";
import { validateFhirResource } from "@/lib/fhir/validator";

export interface PrescriptionMedicationItemInput {
  code?: string;
  name: string;
  dosage: string;
  frequency: string;
  durationDays: number;
  route?: string;
  quantity?: number;
  instructions?: string;
}

export interface CreatePrescriptionInput {
  patientId: string;
  medications: PrescriptionMedicationItemInput[];
  maxRefills?: number;
  validityDays?: number;
  instructions?: string;
}

export interface RecordDispensationInput {
  quantityToDispense?: number;
  idempotencyKey?: string;
  batchNumber?: string;
  notes?: string;
}

/**
 * Doctor creates a synthetic prescription (MedicationRequest)
 */
export async function createPrescription(
  principal: AuthenticatedPrincipal,
  input: CreatePrescriptionInput
): Promise<IPrescription> {
  requireAllowedRole(principal, ["doctor"], "Only licensed medical practitioners may create prescriptions.");
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
      action: "CREATE_PRESCRIPTION_DENIED",
      principal,
      targetResourceType: "Prescription",
      targetPatientId: patient._id.toString(),
      outcome: "DENIED",
      denialReason: "No active patient electronic consent found for prescribing doctor",
    });
    throw new ConsentRequiredError(
      "Active patient electronic consent is required before issuing prescriptions."
    );
  }

  if (!input.medications || input.medications.length === 0) {
    throw new InvalidQueryError("A prescription must contain at least one medication item.");
  }

  const prescriptionId = `RX-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
  const now = new Date();
  const validityDays = input.validityDays && input.validityDays > 0 ? input.validityDays : 30;
  const expiresAt = new Date(now.getTime() + validityDays * 86400000);
  const maxRefills = input.maxRefills && input.maxRefills >= 0 ? input.maxRefills : 0;

  // Process medication items and compute total quantities
  let totalQuantity = 0;
  const medicationItems = input.medications.map((m) => {
    const qty = m.quantity && m.quantity > 0 ? m.quantity : 30;
    totalQuantity += qty;
    return {
      code: m.code?.trim(),
      name: m.name.trim(),
      dosage: m.dosage.trim(),
      frequency: m.frequency.trim(),
      durationDays: m.durationDays > 0 ? m.durationDays : 30,
      route: m.route?.trim() || "oral",
      quantity: qty,
      remainingQuantity: qty,
      instructions: m.instructions?.trim(),
    };
  });

  // Construct canonical FHIR R4 MedicationRequest
  const medicationRequestFhir = {
    resourceType: "MedicationRequest",
    id: prescriptionId,
    status: "active",
    intent: "order",
    subject: {
      reference: `Patient/${patient._id.toString()}`,
      display: patient.name,
    },
    requester: {
      reference: `Practitioner/${principal.id}`,
      display: principal.name,
    },
    authoredOn: now.toISOString(),
    dosageInstruction: medicationItems.map((m) => ({
      text: `${m.name} ${m.dosage} - ${m.frequency} (${m.route})`,
      route: {
        coding: [{ system: "http://snomed.info/sct", display: m.route }],
        text: m.route,
      },
    })),
    dispenseRequest: {
      numberOfRepeatsAllowed: maxRefills,
      quantity: {
        value: totalQuantity,
        unit: "units",
      },
      validityPeriod: {
        start: now.toISOString(),
        end: expiresAt.toISOString(),
      },
    },
    note: input.instructions ? [{ text: input.instructions.trim() }] : undefined,
  };

  // Validate FHIR R4 MedicationRequest structure
  const validation = validateFhirResource(medicationRequestFhir, {
    expectedPatientId: patient._id.toString(),
    expectedResourceType: "MedicationRequest",
  });

  if (!validation.isValid) {
    const errorMsg = validation.issues.map((i) => i.message).join("; ");
    throw new InvalidQueryError(`MedicationRequest FHIR validation failed: ${errorMsg}`);
  }

  const prescription = await Prescription.create({
    prescriptionId,
    patientId: patient._id,
    patientName: patient.name,
    doctorId: new mongoose.Types.ObjectId(principal.id),
    doctorName: principal.name,
    facility: principal.facility || "Apollo Clinics, Indiranagar",
    medications: medicationItems,
    status: "ACTIVE",
    totalQuantity,
    dispensedQuantity: 0,
    remainingQuantity: totalQuantity,
    maxRefills,
    remainingRefills: maxRefills,
    prescribedAt: now,
    expiresAt,
    dispensedEvents: [],
    fhirResource: medicationRequestFhir,
  });

  await logAuditEvent({
    action: "CREATE_PRESCRIPTION",
    principal,
    targetResourceType: "Prescription",
    targetResourceId: prescriptionId,
    targetPatientId: patient._id.toString(),
    outcome: "ALLOWED",
    metadata: {
      prescriptionId,
      totalQuantity,
      medicationsCount: medicationItems.length,
      expiresAt: expiresAt.toISOString(),
    },
  });

  return prescription;
}

/**
 * Retrieve active, eligible prescriptions for pharmacy dispensing
 */
export async function getEligiblePrescriptions(
  principal: AuthenticatedPrincipal,
  filter?: { status?: string }
): Promise<IPrescription[]> {
  assertDenyAdminClinicalAccess(principal, "prescriptions");
  requireAllowedRole(principal, ["pharmacy"], "Only pharmacists may query dispensing prescriptions.");
  assertSafeQueryInput(filter);
  await connectToDatabase();

  const now = new Date();
  const query: Record<string, unknown> = {
    expiresAt: { $gt: now },
  };

  if (filter?.status && filter.status !== "ALL") {
    query.status = filter.status;
  } else if (!filter?.status) {
    query.status = "ACTIVE";
  } else {
    query.status = { $in: ["ACTIVE", "PARTIALLY_DISPENSED"] };
  }

  const prescriptions = await Prescription.find(query).sort({ prescribedAt: -1 });

  await logAuditEvent({
    action: "READ_PHARMACY_PRESCRIPTIONS",
    principal,
    targetResourceType: "Prescription",
    outcome: "ALLOWED",
    metadata: { count: prescriptions.length, role: principal.role },
  });

  return prescriptions;
}

/**
 * Retrieve prescriptions authored by the authenticated doctor
 */
export async function getDoctorPrescriptions(
  principal: AuthenticatedPrincipal,
  filter?: { status?: string }
): Promise<IPrescription[]> {
  requireAllowedRole(principal, ["doctor"], "Only doctors may query their prescribed medications.");
  assertSafeQueryInput(filter);
  await connectToDatabase();

  const query: Record<string, unknown> = {
    doctorId: new mongoose.Types.ObjectId(principal.id),
  };

  if (filter?.status && filter.status !== "ALL") {
    query.status = filter.status;
  }

  return Prescription.find(query).sort({ prescribedAt: -1 });
}

/**
 * Retrieve prescriptions for the authenticated patient
 */
export async function getPatientPrescriptions(
  principal: AuthenticatedPrincipal,
  filter?: { status?: string }
): Promise<IPrescription[]> {
  requireAllowedRole(principal, ["patient"], "Only patients may query their prescriptions.");
  assertSafeQueryInput(filter);
  await connectToDatabase();

  const query: Record<string, unknown> = {
    patientId: new mongoose.Types.ObjectId(principal.id),
  };

  if (filter?.status && filter.status !== "ALL") {
    query.status = filter.status;
  }

  return Prescription.find(query).sort({ prescribedAt: -1 });
}

/**
 * Retrieve single prescription by ID with strict RBAC boundaries
 */
export async function getPrescriptionById(
  principal: AuthenticatedPrincipal,
  prescriptionId: string
): Promise<IPrescription> {
  assertDenyAdminClinicalAccess(principal, "prescriptions");
  assertSafeIdentifier(prescriptionId, "prescriptionId");
  await connectToDatabase();

  const prescription = await Prescription.findOne({ prescriptionId });
  if (!prescription) {
    throw new NotFoundError(`Prescription '${prescriptionId}' not found.`);
  }

  const isPatientOwner =
    principal.role === "patient" && prescription.patientId.toString() === principal.id;
  const isPharmacy = principal.role === "pharmacy";
  const isDoctorAuthor =
    principal.role === "doctor" && prescription.doctorId.toString() === principal.id;

  if (!isPatientOwner && !isPharmacy && !isDoctorAuthor) {
    await logAuditEvent({
      action: "READ_PRESCRIPTION_DENIED",
      principal,
      targetResourceType: "Prescription",
      targetResourceId: prescriptionId,
      outcome: "DENIED",
      denialReason: "User role or identity not authorized to read this prescription",
    });
    throw new ForbiddenError("You are not authorized to view this prescription.");
  }

  await logAuditEvent({
    action: "READ_PRESCRIPTION",
    principal,
    targetResourceType: "Prescription",
    targetResourceId: prescriptionId,
    targetPatientId: prescription.patientId,
    outcome: "ALLOWED",
  });

  return prescription;
}

/**
 * Atomically record medication dispensation for an active prescription with idempotency & concurrency safety
 */
export async function recordDispensation(
  principal: AuthenticatedPrincipal,
  prescriptionId: string,
  input?: RecordDispensationInput
): Promise<{
  prescription: IPrescription;
  dispensingEvent: IDispensingEventDocument | null;
  duplicate?: boolean;
}> {
  requireAllowedRole(principal, ["pharmacy"], "Only licensed pharmacists may record medication dispensations.");
  assertSafeIdentifier(prescriptionId, "prescriptionId");
  assertSafeQueryInput(input);
  await connectToDatabase();

  if (!principal.facility) {
    throw new ForbiddenError("Pharmacist is not affiliated with a registered pharmacy facility.");
  }
  await assertFacilityApproved(principal.facility);

  // 1. Idempotency Check: if idempotencyKey supplied, ensure duplicate requests return previous state
  const idempotencyKey = input?.idempotencyKey?.trim() || `IDEMP-DISP-${prescriptionId}-${Date.now()}`;
  const existingEvent = await DispensingEvent.findOne({ idempotencyKey });
  if (existingEvent) {
    const existingPrescription = await Prescription.findOne({ prescriptionId });
    await logAuditEvent({
      action: "DUPLICATE_DISPENSE_BLOCKED",
      principal,
      targetResourceType: "Prescription",
      targetResourceId: prescriptionId,
      outcome: "ALLOWED",
      metadata: { idempotencyKey, note: "Idempotent duplicate request safely returned existing dispensation" },
    });
    return {
      prescription: existingPrescription!,
      dispensingEvent: existingEvent,
      duplicate: true,
    };
  }

  // 2. Fetch Prescription and verify eligibility
  const prescription = await Prescription.findOne({ prescriptionId });
  if (!prescription) {
    throw new NotFoundError(`Prescription '${prescriptionId}' not found.`);
  }

  const now = new Date();

  // Check expiry
  if (prescription.expiresAt <= now) {
    prescription.status = "EXPIRED";
    await prescription.save();
    await logAuditEvent({
      action: "DISPENSE_REJECTED",
      principal,
      targetResourceType: "Prescription",
      targetResourceId: prescriptionId,
      targetPatientId: prescription.patientId,
      outcome: "DENIED",
      denialReason: "Prescription has expired",
    });
    throw new InvalidQueryError("Prescription has expired and cannot be dispensed.");
  }

  // Check status
  if (prescription.status === "DISPENSED" || prescription.status === "CANCELLED") {
    await logAuditEvent({
      action: "DISPENSE_REJECTED",
      principal,
      targetResourceType: "Prescription",
      targetResourceId: prescriptionId,
      targetPatientId: prescription.patientId,
      outcome: "DENIED",
      denialReason: `Prescription status is ${prescription.status}`,
    });
    throw new InvalidQueryError(
      `Prescription is not active (status: ${prescription.status}) and cannot be dispensed.`
    );
  }

  // 3. Determine quantity to dispense (supports partial or full dispensing)
  const availableQuantity = prescription.remainingQuantity ?? prescription.totalQuantity ?? 30;
  const quantityToDispense =
    input?.quantityToDispense && input.quantityToDispense > 0
      ? input.quantityToDispense
      : availableQuantity;

  if (quantityToDispense > availableQuantity) {
    await logAuditEvent({
      action: "DISPENSE_REJECTED",
      principal,
      targetResourceType: "Prescription",
      targetResourceId: prescriptionId,
      targetPatientId: prescription.patientId,
      outcome: "DENIED",
      denialReason: `Requested quantity ${quantityToDispense} exceeds available ${availableQuantity}`,
    });
    throw new InvalidQueryError(
      `Dispensing quantity (${quantityToDispense}) exceeds remaining authorized quantity (${availableQuantity}).`
    );
  }

  // 4. Concurrency-Safe Atomic Decrement
  // Uses MongoDB conditional query precondition to guarantee atomic decrement
  const updatedPrescription = await Prescription.findOneAndUpdate(
    {
      prescriptionId,
      status: { $in: ["ACTIVE", "PARTIALLY_DISPENSED"] },
      remainingQuantity: { $gte: quantityToDispense },
      expiresAt: { $gt: now },
    },
    {
      $inc: {
        dispensedQuantity: quantityToDispense,
        remainingQuantity: -quantityToDispense,
      },
    },
    { returnDocument: "after" }
  );

  if (!updatedPrescription) {
    await logAuditEvent({
      action: "DISPENSE_REJECTED",
      principal,
      targetResourceType: "Prescription",
      targetResourceId: prescriptionId,
      outcome: "DENIED",
      denialReason: "Concurrent dispensation depleted authorized quantity",
    });
    throw new InvalidQueryError(
      "Dispensing conflict: Prescription is no longer available or was fulfilled by a concurrent request."
    );
  }

  // 5. Compute new prescription lifecycle state
  if (updatedPrescription.remainingQuantity === 0) {
    if (updatedPrescription.remainingRefills > 0) {
      updatedPrescription.remainingRefills -= 1;
      updatedPrescription.remainingQuantity = updatedPrescription.totalQuantity;
      updatedPrescription.status = "ACTIVE";
    } else {
      updatedPrescription.status = "DISPENSED";
    }
  } else {
    updatedPrescription.status = "PARTIALLY_DISPENSED";
  }

  const dispenseId = `DISP-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
  const batchNumber = input?.batchNumber?.trim() || `BATCH-RX-${Date.now().toString(36).slice(-4).toUpperCase()}`;

  // 6. Construct FHIR R4 MedicationDispense resource
  const fhirMedicationDispense = {
    resourceType: "MedicationDispense",
    id: dispenseId,
    status: "completed",
    medicationCodeableConcept: {
      text: updatedPrescription.medications[0]?.name || "Prescription Item",
    },
    subject: {
      reference: `Patient/${updatedPrescription.patientId.toString()}`,
      display: updatedPrescription.patientName,
    },
    authorizingPrescription: [
      {
        reference: `MedicationRequest/${updatedPrescription.prescriptionId}`,
      },
    ],
    quantity: {
      value: quantityToDispense,
      unit: "units",
    },
    whenHandedOver: now.toISOString(),
    performer: [
      {
        actor: {
          reference: `Organization/${principal.facility}`,
          display: principal.facility,
        },
      },
    ],
    note: input?.notes ? [{ text: input.notes.trim() }] : undefined,
  };

  // Add dispensation record to embedded prescription events
  updatedPrescription.dispensedEvents.push({
    dispenseId,
    idempotencyKey,
    dispensedAt: now,
    pharmacyFacility: principal.facility,
    pharmacistId: new mongoose.Types.ObjectId(principal.id),
    pharmacistName: principal.name,
    quantityDispensed: quantityToDispense,
    remainingQuantityAfter: updatedPrescription.remainingQuantity,
    notes: input?.notes?.trim(),
  });

  await updatedPrescription.save();

  // 7. Persist discrete DispensingEvent for tracking & concurrency idempotency
  const dispensingEvent = await DispensingEvent.create({
    dispenseId,
    idempotencyKey,
    prescriptionId,
    patientId: updatedPrescription.patientId,
    patientName: updatedPrescription.patientName,
    patientAbha: "rahul.verma@sbx",
    pharmacistId: new mongoose.Types.ObjectId(principal.id),
    pharmacistName: principal.name,
    pharmacyFacility: principal.facility,
    medicationName: updatedPrescription.medications[0]?.name || "Dispensed Medication",
    medicationCode: updatedPrescription.medications[0]?.code,
    quantityDispensed: quantityToDispense,
    remainingQuantityAfter: updatedPrescription.remainingQuantity,
    batchNumber,
    notes: input?.notes?.trim(),
    status: "completed",
    fhirResource: fhirMedicationDispense,
    dispensedAt: now,
  });

  // 8. Persist MedicationDispense into SourceInstitutionRecord for ABDM exchange
  await SourceInstitutionRecord.create({
    recordId: `SRC-DISP-${dispenseId}`,
    institutionId: "HIP-APOLLO-002",
    institutionName: principal.facility,
    institutionType: "clinic",
    patientAbhaId: "32-8492-1920-4491",
    patientAbhaAddress: "rahul.verma@sbx",
    patientName: updatedPrescription.patientName,
    careContextId: `CARE-CTX-RX-${prescriptionId}`,
    careContextDescription: `Dispensing Event: ${updatedPrescription.medications[0]?.name || "Medication"}`,
    resourceType: "MedicationDispense",
    recordDate: now,
    status: "completed",
    fhirResource: fhirMedicationDispense,
    isMockData: true,
  });

  await logAuditEvent({
    action: "DISPENSE_MEDICATION",
    principal,
    targetResourceType: "Prescription",
    targetResourceId: prescriptionId,
    targetPatientId: updatedPrescription.patientId,
    outcome: "ALLOWED",
    metadata: {
      dispenseId,
      idempotencyKey,
      quantityDispensed: quantityToDispense,
      remainingQuantity: updatedPrescription.remainingQuantity,
      status: updatedPrescription.status,
      facility: principal.facility,
    },
  });

  return {
    prescription: updatedPrescription,
    dispensingEvent,
  };
}

/**
 * Retrieve dispensing history for facility or patient
 */
export async function getDispensingHistory(
  principal: AuthenticatedPrincipal
): Promise<IDispensingEventDocument[]> {
  assertDenyAdminClinicalAccess(principal, "dispensing records");
  await connectToDatabase();

  const query: Record<string, unknown> = {};

  if (principal.role === "pharmacy") {
    if (!principal.facility) {
      throw new ForbiddenError("Pharmacist is not affiliated with a facility.");
    }
    query.pharmacyFacility = principal.facility;
  } else if (principal.role === "patient") {
    query.patientId = new mongoose.Types.ObjectId(principal.id);
  } else if (principal.role === "doctor") {
    // Doctors view dispensations for their prescriptions
    const doctorPrescriptions = await Prescription.find({
      doctorId: new mongoose.Types.ObjectId(principal.id),
    }).select("prescriptionId");
    const rxIds = doctorPrescriptions.map((p) => p.prescriptionId);
    query.prescriptionId = { $in: rxIds };
  } else {
    throw new ForbiddenError(`Role '${principal.role}' is not authorized to query dispensing history.`);
  }

  return DispensingEvent.find(query).sort({ dispensedAt: -1 });
}
