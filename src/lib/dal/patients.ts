import mongoose from "mongoose";
import { User, IUser } from "@/lib/db/models/User";
import { AuthenticatedPrincipal } from "./types";
import {
  ForbiddenError,
  NotFoundError,
  InvalidQueryError,
} from "./errors";
import { assertSafeQueryInput, assertSafeIdentifier } from "./sanitizer";
import { logAuditEvent } from "./audit";
import { connectToDatabase } from "@/lib/db/connect";

export interface UpdatePatientProfileInput {
  phone?: string;
  email?: string;
  gender?: "Male" | "Female" | "Other";
  dateOfBirth?: string;
}

/**
 * Retrieve patient demographic profile enforcing ownership and authorized discovery
 */
export async function getPatientProfile(
  principal: AuthenticatedPrincipal,
  targetPatientId: string
): Promise<Partial<IUser>> {
  assertSafeIdentifier(targetPatientId, "targetPatientId");
  await connectToDatabase();

  if (!mongoose.isValidObjectId(targetPatientId)) {
    throw new InvalidQueryError("Invalid patient identifier format.");
  }

  // 1. Patient role: strict ownership assertion
  if (principal.role === "patient") {
    if (principal.id !== targetPatientId) {
      await logAuditEvent({
        action: "READ_PATIENT_PROFILE_DENIED",
        principal,
        targetResourceType: "Patient",
        targetResourceId: targetPatientId,
        outcome: "DENIED",
        denialReason: "IDOR Attempt: Patient tried to access another patient's profile",
      });
      throw new ForbiddenError("Access denied. You are only permitted to access your own patient profile.");
    }
  }

  // 2. Admin role: administrative metadata only
  const patient = await User.findById(targetPatientId);
  if (!patient || patient.role !== "patient") {
    throw new NotFoundError("Patient record not found.");
  }

  await logAuditEvent({
    action: "READ_PATIENT_PROFILE",
    principal,
    targetResourceType: "Patient",
    targetResourceId: targetPatientId,
    targetPatientId: patient._id,
    outcome: "ALLOWED",
  });

  // Minimum necessary representation based on role
  if (principal.role === "admin") {
    return {
      _id: patient._id,
      abhaId: patient.abhaId,
      abhaAddress: patient.abhaAddress,
      name: patient.name,
      role: patient.role,
      isActive: patient.isActive,
      createdAt: patient.createdAt,
    };
  }

  if (principal.role === "laboratory" || principal.role === "pharmacy") {
    // Minimum necessary for specimen/dispensation intake
    return {
      _id: patient._id,
      abhaId: patient.abhaId,
      abhaAddress: patient.abhaAddress,
      name: patient.name,
      gender: patient.gender,
      dateOfBirth: patient.dateOfBirth,
    };
  }

  // Patient self or treating Doctor
  return {
    _id: patient._id,
    abhaId: patient.abhaId,
    abhaAddress: patient.abhaAddress,
    name: patient.name,
    role: patient.role,
    isActive: patient.isActive,
    phone: patient.phone,
    email: patient.email,
    gender: patient.gender,
    dateOfBirth: patient.dateOfBirth,
    createdAt: patient.createdAt,
    updatedAt: patient.updatedAt,
  };
}

/**
 * List discoverable patients for authorized healthcare providers (Doctor)
 */
export async function listDiscoverablePatients(
  principal: AuthenticatedPrincipal
): Promise<Partial<IUser>[]> {
  await connectToDatabase();

  if (principal.role !== "doctor") {
    throw new ForbiddenError("Only registered healthcare practitioners may search patient registries.");
  }

  const patients = await User.find({ role: "patient", isActive: true })
    .select("_id name abhaId abhaAddress gender dateOfBirth phone")
    .limit(20);

  return patients.map((p) => ({
    id: p._id.toString(),
    _id: p._id,
    name: p.name,
    abhaId: p.abhaId,
    abhaAddress: p.abhaAddress,
    gender: p.gender,
    dateOfBirth: p.dateOfBirth,
    phone: p.phone,
  })) as unknown as Partial<IUser>[];
}

/**
 * Update patient profile with protection against mass assignment
 */
export async function updatePatientProfile(
  principal: AuthenticatedPrincipal,
  targetPatientId: string,
  input: UpdatePatientProfileInput
): Promise<Partial<IUser>> {
  assertSafeIdentifier(targetPatientId, "targetPatientId");
  assertSafeQueryInput(input);
  await connectToDatabase();

  // Strict ownership: only the patient themselves can update their profile
  if (principal.role !== "patient" || principal.id !== targetPatientId) {
    await logAuditEvent({
      action: "UPDATE_PATIENT_PROFILE_DENIED",
      principal,
      targetResourceType: "Patient",
      targetResourceId: targetPatientId,
      outcome: "DENIED",
      denialReason: "User is not authorized to edit this patient profile",
    });
    throw new ForbiddenError("You may only update your own profile.");
  }

  // Construct validated update object explicitly (mass assignment prevention)
  const allowedUpdates: Record<string, unknown> = {};
  if (input.phone !== undefined) allowedUpdates.phone = input.phone.trim();
  if (input.email !== undefined) allowedUpdates.email = input.email.trim().toLowerCase();
  if (input.gender !== undefined) allowedUpdates.gender = input.gender;
  if (input.dateOfBirth !== undefined) allowedUpdates.dateOfBirth = input.dateOfBirth;

  const updatedPatient = await User.findByIdAndUpdate(
    targetPatientId,
    { $set: allowedUpdates },
    { returnDocument: "after" }
  ).select("_id abhaId abhaAddress name role isActive phone email gender dateOfBirth");

  if (!updatedPatient) {
    throw new NotFoundError("Patient not found.");
  }

  await logAuditEvent({
    action: "UPDATE_PATIENT_PROFILE",
    principal,
    targetResourceType: "Patient",
    targetResourceId: targetPatientId,
    targetPatientId: updatedPatient._id,
    outcome: "ALLOWED",
  });

  return updatedPatient;
}
