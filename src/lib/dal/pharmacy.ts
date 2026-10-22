import mongoose from "mongoose";
import { Prescription, IPrescription } from "@/lib/db/models/Prescription";
import { AuthenticatedPrincipal } from "./types";
import {
  ForbiddenError,
  NotFoundError,
  InvalidQueryError,
} from "./errors";
import { requireAllowedRole } from "./policies";
import { assertSafeIdentifier } from "./sanitizer";
import { logAuditEvent } from "./audit";
import { connectToDatabase } from "@/lib/db/connect";

export interface RecordDispensationInput {
  notes?: string;
}

/**
 * Retrieve active, eligible prescriptions for pharmacy dispensing
 */
export async function getEligiblePrescriptions(
  principal: AuthenticatedPrincipal
): Promise<IPrescription[]> {
  requireAllowedRole(principal, ["pharmacy"], "Only pharmacists may query dispensing prescriptions.");
  await connectToDatabase();

  const now = new Date();
  const prescriptions = await Prescription.find({
    status: "ACTIVE",
    expiresAt: { $gt: now },
  }).sort({ prescribedAt: -1 });

  await logAuditEvent({
    action: "READ_PHARMACY_PRESCRIPTIONS",
    principal,
    targetResourceType: "Prescription",
    outcome: "ALLOWED",
    metadata: { count: prescriptions.length },
  });

  return prescriptions;
}

/**
 * Retrieve single prescription by ID
 */
export async function getPrescriptionById(
  principal: AuthenticatedPrincipal,
  prescriptionId: string
): Promise<IPrescription> {
  assertSafeIdentifier(prescriptionId, "prescriptionId");
  await connectToDatabase();

  const prescription = await Prescription.findOne({ prescriptionId });
  if (!prescription) {
    throw new NotFoundError(`Prescription '${prescriptionId}' not found.`);
  }

  // Authorization check: Patient owner or Pharmacy role
  const isPatientOwner =
    principal.role === "patient" && prescription.patientId.toString() === principal.id;
  const isPharmacy = principal.role === "pharmacy";
  const isDoctor =
    principal.role === "doctor" && prescription.doctorId.toString() === principal.id;

  if (!isPatientOwner && !isPharmacy && !isDoctor) {
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

  return prescription;
}

/**
 * Record medication dispensation for an active prescription
 */
export async function recordDispensation(
  principal: AuthenticatedPrincipal,
  prescriptionId: string,
  input?: RecordDispensationInput
): Promise<IPrescription> {
  requireAllowedRole(principal, ["pharmacy"], "Only pharmacists may record medication dispensations.");
  assertSafeIdentifier(prescriptionId, "prescriptionId");
  await connectToDatabase();

  const prescription = await Prescription.findOne({ prescriptionId });
  if (!prescription) {
    throw new NotFoundError(`Prescription '${prescriptionId}' not found.`);
  }

  if (prescription.status !== "ACTIVE") {
    throw new InvalidQueryError(
      `Prescription is not active (status: ${prescription.status}) and cannot be dispensed.`
    );
  }

  const now = new Date();
  if (prescription.expiresAt <= now) {
    prescription.status = "EXPIRED";
    await prescription.save();
    throw new InvalidQueryError("Prescription has expired and cannot be dispensed.");
  }

  // Record dispensation event
  prescription.dispensedEvents.push({
    dispensedAt: now,
    pharmacyFacility: principal.facility || "Apollo Pharmacy Dispensation Hub",
    pharmacistId: new mongoose.Types.ObjectId(principal.id),
    notes: input?.notes?.trim(),
  });

  if (prescription.remainingRefills > 0) {
    prescription.remainingRefills -= 1;
  } else {
    prescription.status = "DISPENSED";
  }

  await prescription.save();

  await logAuditEvent({
    action: "DISPENSE_MEDICATION",
    principal,
    targetResourceType: "Prescription",
    targetResourceId: prescriptionId,
    targetPatientId: prescription.patientId,
    outcome: "ALLOWED",
    metadata: { remainingRefills: prescription.remainingRefills, status: prescription.status },
  });

  return prescription;
}
