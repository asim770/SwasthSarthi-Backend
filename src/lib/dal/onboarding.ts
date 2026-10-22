import mongoose from "mongoose";
import { Facility, IFacility, FacilityType, FacilityStatus } from "@/lib/db/models/Facility";
import { User, IUser, VerificationStatus } from "@/lib/db/models/User";
import { AuthenticatedPrincipal } from "./types";
import {
  ForbiddenError,
  NotFoundError,
  ValidationError,
  ConflictError,
} from "./errors";
import { requireAllowedRole } from "./policies";
import { assertSafeIdentifier } from "./sanitizer";
import { logAuditEvent } from "./audit";
import { connectToDatabase } from "@/lib/db/connect";

export interface RegisterInstitutionInput {
  name: string;
  type: FacilityType;
  facilityId: string;
  address?: string;
  city?: string;
  state?: string;
  contactPhone?: string;
  contactEmail?: string;
  demoHfrId?: string;
}

export interface ReviewDecisionInput {
  decision: "APPROVED" | "REJECTED" | "SUSPENDED";
  reason: string;
}

export interface RegisterPractitionerInput {
  name: string;
  role: "doctor" | "laboratory" | "pharmacy";
  phone: string;
  email?: string;
  facility: string;
  specialization?: string;
  hprId?: string;
  hfrId?: string;
}

/**
 * Mock Registry Verification Service (Demonstration only)
 * Explicitly marks simulated verification from real HPR/HFR registry checks.
 */
export function mockRegistryVerificationCheck(
  identifier: string,
  type: "HFR" | "HPR"
): {
  verified: boolean;
  registrySource: string;
  complianceNotes: string[];
  disclaimer: string;
} {
  const isSyntheticFormat =
    type === "HFR"
      ? identifier.startsWith("IN") || identifier.startsWith("FAC")
      : identifier.startsWith("HPR") || identifier.includes("@hpr");

  return {
    verified: Boolean(identifier && identifier.length >= 4),
    registrySource: type === "HFR" ? "MOCK_NATIONAL_HEALTH_FACILITY_REGISTRY" : "MOCK_HEALTHCARE_PROFESSIONALS_REGISTRY",
    complianceNotes: [
      `Format schema validation: ${isSyntheticFormat ? "SYNTHETIC_CONFORMANT" : "STANDARD_COMPLIANT"}`,
      "State Medical Council accreditation simulated: VALID",
      "ABDM Sandboxed HFR/HPR Identifier active: YES",
    ],
    disclaimer:
      "SIMULATED_DEMO_REGISTRY: This verification was produced by the SwasthSaarthi mock sandbox and does not represent an actual call to the live National Health Authority (NHA) production registries.",
  };
}

/**
 * Register a synthetic healthcare institution
 */
export async function registerInstitution(
  principal: AuthenticatedPrincipal,
  input: RegisterInstitutionInput
): Promise<IFacility> {
  // Admins or facility representatives can register; status defaults to PENDING
  await connectToDatabase();

  if (!input.name || !input.facilityId || !input.type) {
    throw new ValidationError("Facility name, type, and identifier are required.");
  }

  const existing = await Facility.findOne({
    facilityId: input.facilityId.toUpperCase().trim(),
  });
  if (existing) {
    throw new ConflictError(`Facility with ID '${input.facilityId}' already exists.`);
  }

  const registeredByObjId = new mongoose.Types.ObjectId(principal.id);

  const facility = await Facility.create({
    facilityId: input.facilityId.toUpperCase().trim(),
    name: input.name.trim(),
    type: input.type,
    status: "PENDING",
    address: input.address?.trim(),
    city: input.city?.trim(),
    state: input.state?.trim(),
    contactPhone: input.contactPhone?.trim(),
    contactEmail: input.contactEmail?.trim(),
    demoHfrId: input.demoHfrId || `IN07${Date.now().toString().slice(-6)}`,
    registeredBy: registeredByObjId,
    registeredByName: principal.name,
    changeHistory: [
      {
        fromStatus: "PENDING",
        toStatus: "PENDING",
        changedBy: registeredByObjId,
        changedByName: principal.name,
        changedAt: new Date(),
        reason: "Initial synthetic facility registration submitted for admin review.",
      },
    ],
  });

  await logAuditEvent({
    action: "INSTITUTION_REGISTERED",
    principal,
    targetResourceType: "Facility",
    targetResourceId: facility.facilityId,
    outcome: "ALLOWED",
    metadata: {
      name: facility.name,
      type: facility.type,
      facilityId: facility.facilityId,
    },
  });

  return facility;
}

/**
 * List institutions within administrative scope
 */
export async function listInstitutions(
  principal: AuthenticatedPrincipal,
  statusFilter?: string
): Promise<IFacility[]> {
  requireAllowedRole(principal, ["admin"], "Only administrators may list institutional registries.");
  await connectToDatabase();

  const query: Record<string, unknown> = {};
  if (statusFilter && statusFilter !== "ALL") {
    query.status = statusFilter;
  }

  return Facility.find(query).sort({ createdAt: -1 });
}

/**
 * Review institution verification decision (Approve, Reject, Suspend)
 * Self-approval strictly forbidden
 */
export async function reviewInstitution(
  principal: AuthenticatedPrincipal,
  facilityId: string,
  input: ReviewDecisionInput
): Promise<IFacility> {
  requireAllowedRole(principal, ["admin"], "Only administrators may approve, reject, or suspend institutions.");
  assertSafeIdentifier(facilityId, "facilityId");
  await connectToDatabase();

  const facility = await Facility.findOne({ facilityId: facilityId.toUpperCase().trim() });
  if (!facility) {
    throw new NotFoundError(`Facility with identifier '${facilityId}' not found.`);
  }

  // Prevent self-approval if an administrator registered the institution
  if (facility.registeredBy.toString() === principal.id) {
    await logAuditEvent({
      action: "INSTITUTION_SELF_APPROVAL_BLOCKED",
      principal,
      targetResourceType: "Facility",
      targetResourceId: facilityId,
      outcome: "DENIED",
      denialReason: "User attempted to review/approve an institution they registered.",
    });
    throw new ForbiddenError("Self-approval forbidden. An institution cannot be approved by its registrant.");
  }

  const previousStatus = facility.status;
  const newStatus = input.decision;

  // Validate state transitions
  if (previousStatus === newStatus) {
    throw new ValidationError(`Facility is already in state '${newStatus}'.`);
  }

  facility.status = newStatus;
  facility.verifiedBy = new mongoose.Types.ObjectId(principal.id);
  facility.verifiedByName = principal.name;
  facility.verifiedAt = new Date();
  facility.statusReason = input.reason.trim();

  facility.changeHistory.push({
    fromStatus: previousStatus,
    toStatus: newStatus,
    changedBy: new mongoose.Types.ObjectId(principal.id),
    changedByName: principal.name,
    changedAt: new Date(),
    reason: input.reason.trim(),
  });

  await facility.save();

  await logAuditEvent({
    action: `INSTITUTION_${newStatus}`,
    principal,
    targetResourceType: "Facility",
    targetResourceId: facilityId,
    outcome: "ALLOWED",
    metadata: {
      fromStatus: previousStatus,
      toStatus: newStatus,
      reason: input.reason,
    },
  });

  return facility;
}

/**
 * List practitioner verification requests
 */
export async function listPractitionerVerifications(
  principal: AuthenticatedPrincipal,
  statusFilter?: string
): Promise<Partial<IUser>[]> {
  requireAllowedRole(principal, ["admin"], "Only administrators may inspect practitioner verification queues.");
  await connectToDatabase();

  const query: Record<string, unknown> = {
    role: { $in: ["doctor", "laboratory", "pharmacy"] },
  };
  if (statusFilter && statusFilter !== "ALL") {
    query.verificationStatus = statusFilter;
  }

  return User.find(query)
    .select("_id name abhaId abhaAddress role facility specialization verificationStatus hprId hfrId createdAt updatedAt")
    .sort({ createdAt: -1 });
}

/**
 * Review practitioner verification (Approve, Reject, Suspend)
 * Self-approval strictly forbidden
 */
export async function reviewPractitioner(
  principal: AuthenticatedPrincipal,
  targetUserId: string,
  input: ReviewDecisionInput
): Promise<Partial<IUser>> {
  if (principal.id === targetUserId) {
    await logAuditEvent({
      action: "PRACTITIONER_SELF_APPROVAL_BLOCKED",
      principal,
      targetResourceType: "User",
      targetResourceId: targetUserId,
      outcome: "DENIED",
      denialReason: "User attempted to verify their own professional credentials.",
    });
    throw new ForbiddenError("Self-approval forbidden. You cannot verify your own professional account.");
  }

  requireAllowedRole(principal, ["admin"], "Only administrators may verify practitioners.");

  const user = await User.findById(targetUserId);
  if (!user || user.role === "patient" || user.role === "admin") {
    throw new NotFoundError(`Practitioner account '${targetUserId}' not found.`);
  }

  const previousStatus = user.verificationStatus || "PENDING";
  const newStatus = input.decision;

  if (previousStatus === newStatus) {
    throw new ValidationError(`Practitioner is already in status '${newStatus}'.`);
  }

  user.verificationStatus = newStatus;
  user.verifiedBy = new mongoose.Types.ObjectId(principal.id);
  user.verifiedByName = principal.name;
  user.verifiedAt = new Date();
  user.statusReason = input.reason.trim();

  // If practitioner is suspended or rejected, set isActive to false
  if (newStatus === "SUSPENDED" || newStatus === "REJECTED") {
    user.isActive = false;
  } else if (newStatus === "APPROVED") {
    user.isActive = true;
  }

  user.verificationHistory.push({
    fromStatus: previousStatus,
    toStatus: newStatus,
    changedBy: new mongoose.Types.ObjectId(principal.id),
    changedByName: principal.name,
    changedAt: new Date(),
    reason: input.reason.trim(),
  });

  await user.save();

  await logAuditEvent({
    action: `PRACTITIONER_${newStatus}`,
    principal,
    targetResourceType: "User",
    targetResourceId: targetUserId,
    outcome: "ALLOWED",
    metadata: {
      practitionerRole: user.role,
      fromStatus: previousStatus,
      toStatus: newStatus,
      reason: input.reason,
    },
  });

  return {
    _id: user._id,
    name: user.name,
    role: user.role,
    facility: user.facility,
    verificationStatus: user.verificationStatus,
    isActive: user.isActive,
  };
}

/**
 * Validate that an institution is currently approved and active before protected operations
 */
export async function assertFacilityApproved(facilityNameOrId: string): Promise<void> {
  await connectToDatabase();

  const facility = await Facility.findOne({
    $or: [
      { name: facilityNameOrId },
      { facilityId: facilityNameOrId.toUpperCase() },
      { demoHfrId: facilityNameOrId },
    ],
  });

  // If facility document exists in DB, strictly enforce that its status is APPROVED
  if (facility && facility.status !== "APPROVED") {
    throw new ForbiddenError(
      `Facility '${facility.name}' is currently ${facility.status}. Restricted clinical workflows are prohibited.`
    );
  }
}
