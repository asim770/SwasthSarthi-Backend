import mongoose from "mongoose";
import {
  ConsentArtifact,
  IConsentArtifact,
  IConsentDecisionHistory,
} from "@/lib/db/models/ConsentArtifact";
import { User } from "@/lib/db/models/User";
import { AuthenticatedPrincipal, ConsentEvaluationResult } from "./types";
import {
  ForbiddenError,
  NotFoundError,
  InvalidQueryError,
  InvalidStateTransitionError,
} from "./errors";
import { requireAllowedRole } from "./policies";
import { assertSafeQueryInput, assertSafeIdentifier } from "./sanitizer";
import { logAuditEvent } from "./audit";
import { connectToDatabase } from "@/lib/db/connect";

export const VALID_HI_TYPES = [
  "DiagnosticReport",
  "Observation",
  "MedicationRequest",
  "MedicationDispense",
  "Encounter",
  "Immunization",
  "DocumentReference",
] as const;

export type ValidHiType = (typeof VALID_HI_TYPES)[number];

export const MAX_CONSENT_DURATION_DAYS = 180;

export interface CreateConsentRequestInput {
  patientId: string;
  purpose: string;
  hiTypes: string[];
  dateRangeFrom: Date | string;
  dateRangeTo: Date | string;
  expiresAt: Date | string;
}

export interface ApproveConsentInput {
  approvedHiTypes?: string[];
  note?: string;
}

/**
 * Evaluate if an active, unexpired, granted electronic consent exists covering
 * the requested patient, doctor, resource category, and record date.
 * Fail closed if any condition is not met.
 */
export async function evaluateConsent(
  patientId: string,
  doctorId: string,
  resourceType: string,
  recordDate?: Date
): Promise<ConsentEvaluationResult> {
  await connectToDatabase();

  if (!mongoose.isValidObjectId(patientId) || !mongoose.isValidObjectId(doctorId)) {
    return { hasConsent: false, reason: "INVALID_PARTICIPANT_IDENTIFIER" };
  }

  const now = new Date();

  // Find approved/granted consents that have NOT passed their expiry date
  const consents = await ConsentArtifact.find({
    patientId: new mongoose.Types.ObjectId(patientId),
    requesterDoctorId: new mongoose.Types.ObjectId(doctorId),
    status: { $in: ["APPROVED", "GRANTED"] },
    expiresAt: { $gt: now }, // Synchronous fail-closed expiry check
  });

  if (!consents || consents.length === 0) {
    return { hasConsent: false, reason: "NO_ACTIVE_CONSENT_FOUND" };
  }

  for (const consent of consents) {
    // Determine effective approved categories: approvedHiTypes if present, else hiTypes
    const effectiveTypes =
      consent.approvedHiTypes && consent.approvedHiTypes.length > 0
        ? consent.approvedHiTypes
        : consent.hiTypes;

    // 1. Check if resource category is permitted
    const coversType = effectiveTypes.includes(resourceType);
    if (!coversType) {
      continue;
    }

    // 2. Check if clinical record date falls within consented date range
    if (recordDate) {
      if (consent.dateRangeFrom && recordDate < consent.dateRangeFrom) {
        continue;
      }
      if (consent.dateRangeTo && recordDate > consent.dateRangeTo) {
        continue;
      }
    }

    // Matching valid consent found
    return {
      hasConsent: true,
      consentId: consent.consentId,
      allowedHiTypes: effectiveTypes,
      dateRangeFrom: consent.dateRangeFrom,
      dateRangeTo: consent.dateRangeTo,
    };
  }

  return {
    hasConsent: false,
    reason: "RECORD_EXCEEDS_CONSENT_CATEGORIES_OR_DATE_RANGE",
  };
}

/**
 * Get consent artefacts for the authenticated principal with optional status filtering
 */
export async function getConsentsForPrincipal(
  principal: AuthenticatedPrincipal,
  filterStatus?: string
): Promise<IConsentArtifact[]> {
  await connectToDatabase();

  const query: Record<string, unknown> = {};

  if (principal.role === "patient") {
    query.patientId = new mongoose.Types.ObjectId(principal.id);
  } else if (principal.role === "doctor") {
    query.requesterDoctorId = new mongoose.Types.ObjectId(principal.id);
  } else if (principal.role === "admin") {
    // Admin only receives operational metadata; no patient clinical data
    return ConsentArtifact.find({})
      .select("consentId requesterFacility purpose status hiTypes approvedHiTypes expiresAt createdAt version")
      .sort({ createdAt: -1 })
      .limit(50);
  } else {
    throw new ForbiddenError(
      `Role '${principal.role}' is not authorized to browse electronic consent artefacts.`
    );
  }

  // Apply status filter if provided
  if (filterStatus && filterStatus !== "ALL") {
    const upper = filterStatus.toUpperCase();
    if (upper === "PENDING") {
      query.status = { $in: ["PENDING", "REQUESTED"] };
    } else if (upper === "APPROVED") {
      query.status = { $in: ["APPROVED", "GRANTED"] };
      query.expiresAt = { $gt: new Date() };
    } else if (upper === "EXPIRED") {
      query.$or = [
        { status: "EXPIRED" },
        { status: { $in: ["APPROVED", "GRANTED"] }, expiresAt: { $lte: new Date() } },
      ];
    } else {
      query.status = upper;
    }
  }

  const populateField =
    principal.role === "patient"
      ? { path: "requesterDoctorId", select: "name abhaId specialization facility" }
      : { path: "patientId", select: "name abhaId abhaAddress gender dateOfBirth" };

  return ConsentArtifact.find(query)
    .populate(populateField)
    .sort({ createdAt: -1 });
}

/**
 * Get single consent artefact by ID
 */
export async function getConsentById(
  principal: AuthenticatedPrincipal,
  consentId: string
): Promise<IConsentArtifact> {
  await connectToDatabase();
  assertSafeIdentifier(consentId, "consentId");

  const consent = await ConsentArtifact.findOne({ consentId })
    .populate("requesterDoctorId", "name abhaId specialization facility")
    .populate("patientId", "name abhaId abhaAddress gender dateOfBirth");

  if (!consent) {
    throw new NotFoundError(`Consent artefact '${consentId}' not found.`);
  }

  // Authorization check: only the patient owner or requesting doctor may read it (or admin for metadata)
  const isPatientOwner = consent.patientId._id
    ? consent.patientId._id.toString() === principal.id
    : consent.patientId.toString() === principal.id;

  const isRequesterDoctor = consent.requesterDoctorId._id
    ? consent.requesterDoctorId._id.toString() === principal.id
    : consent.requesterDoctorId.toString() === principal.id;

  if (principal.role !== "admin" && !isPatientOwner && !isRequesterDoctor) {
    await logAuditEvent({
      action: "READ_CONSENT_DENIED",
      principal,
      targetResourceType: "ConsentArtifact",
      targetResourceId: consentId,
      outcome: "DENIED",
      denialReason: "User is neither the patient owner nor the requesting doctor",
    });
    throw new ForbiddenError("You are not authorized to view this consent artefact.");
  }

  await logAuditEvent({
    action: "CONSENT_VIEWED",
    principal,
    targetResourceType: "ConsentArtifact",
    targetResourceId: consentId,
    targetPatientId: consent.patientId._id || consent.patientId,
    outcome: "ALLOWED",
  });

  return consent;
}

/**
 * Create a new consent request (Doctor only)
 */
export async function createConsentRequest(
  principal: AuthenticatedPrincipal,
  input: CreateConsentRequestInput
): Promise<IConsentArtifact> {
  requireAllowedRole(principal, ["doctor"], "Only registered doctors may request electronic consent.");
  assertSafeQueryInput(input);
  await connectToDatabase();

  if (!principal.facility) {
    throw new ForbiddenError("Doctor must be affiliated with a verified healthcare facility to request consent.");
  }

  if (!mongoose.isValidObjectId(input.patientId)) {
    throw new InvalidQueryError("Invalid patient identifier format.");
  }

  // 1. Validate target patient exists, is active, and has patient role
  const patient = await User.findById(input.patientId);
  if (!patient || patient.role !== "patient" || !patient.isActive) {
    throw new NotFoundError("Target patient does not exist or account is inactive.");
  }

  // 2. Validate resource categories
  if (!input.hiTypes || input.hiTypes.length === 0) {
    throw new InvalidQueryError("At least one resource category (hiType) must be specified.");
  }

  for (const type of input.hiTypes) {
    if (!VALID_HI_TYPES.includes(type as ValidHiType)) {
      throw new InvalidQueryError(`Unsupported resource category '${type}'.`);
    }
  }

  // 3. Validate date ranges
  const dateFrom = new Date(input.dateRangeFrom);
  const dateTo = new Date(input.dateRangeTo);
  if (isNaN(dateFrom.getTime()) || isNaN(dateTo.getTime())) {
    throw new InvalidQueryError("Invalid date range bounds.");
  }
  if (dateFrom > dateTo) {
    throw new InvalidQueryError("dateRangeFrom cannot be after dateRangeTo.");
  }

  // 4. Validate expiry
  const now = new Date();
  const expiresAt = new Date(input.expiresAt);
  if (isNaN(expiresAt.getTime())) {
    throw new InvalidQueryError("Invalid consent expiry date.");
  }
  if (expiresAt <= now) {
    throw new InvalidQueryError("Consent expiry date must be in the future.");
  }

  const maxExpiry = new Date(now.getTime() + MAX_CONSENT_DURATION_DAYS * 24 * 60 * 60 * 1000);
  if (expiresAt > maxExpiry) {
    throw new InvalidQueryError(
      `Consent expiry cannot exceed ${MAX_CONSENT_DURATION_DAYS} days (policy limit).`
    );
  }

  const consentId = `CONSENT-${Date.now().toString(36).toUpperCase()}-${Math.random()
    .toString(36)
    .substring(2, 6)
    .toUpperCase()}`;

  const initialHistory: IConsentDecisionHistory = {
    action: "REQUESTED",
    actorId: new mongoose.Types.ObjectId(principal.id),
    actorRole: principal.role,
    actorName: principal.name,
    timestamp: now,
    note: `Consent requested for purpose: ${input.purpose.trim()}`,
  };

  const consent = await ConsentArtifact.create({
    consentId,
    patientId: patient._id,
    requesterDoctorId: new mongoose.Types.ObjectId(principal.id),
    requesterFacility: principal.facility,
    purpose: input.purpose.trim(),
    hiTypes: input.hiTypes,
    approvedHiTypes: [],
    dateRangeFrom: dateFrom,
    dateRangeTo: dateTo,
    expiresAt,
    status: "PENDING",
    version: 1,
    decisionHistory: [initialHistory],
  });

  await logAuditEvent({
    action: "CONSENT_REQUEST_CREATED",
    principal,
    targetResourceType: "ConsentArtifact",
    targetResourceId: consent.consentId,
    targetPatientId: patient._id,
    outcome: "ALLOWED",
    metadata: {
      purpose: input.purpose,
      hiTypesCount: input.hiTypes.length,
      hiTypes: input.hiTypes,
      expiresAt: expiresAt.toISOString(),
    },
  });

  return consent;
}

/**
 * Approve a pending consent request (Patient only)
 * Creates a versioned snapshot with approved categories (subset of requested; cannot widen)
 */
export async function approveConsent(
  principal: AuthenticatedPrincipal,
  consentId: string,
  input?: ApproveConsentInput
): Promise<IConsentArtifact> {
  assertSafeIdentifier(consentId, "consentId");
  await connectToDatabase();

  // Deny administrators and non-patients from approving consent
  if (principal.role !== "patient") {
    await logAuditEvent({
      action: "UNAUTHORIZED_CONSENT_DECISION",
      principal,
      targetResourceType: "ConsentArtifact",
      targetResourceId: consentId,
      outcome: "DENIED",
      denialReason: `Role '${principal.role}' attempted to approve patient consent`,
    });
    throw new ForbiddenError("Only the patient owner can approve consent requests.");
  }

  const consent = await ConsentArtifact.findOne({ consentId });
  if (!consent) {
    throw new NotFoundError(`Consent '${consentId}' not found.`);
  }

  // IDOR check: Only the patient owner can approve
  if (consent.patientId.toString() !== principal.id) {
    await logAuditEvent({
      action: "UNAUTHORIZED_CONSENT_DECISION",
      principal,
      targetResourceType: "ConsentArtifact",
      targetResourceId: consentId,
      outcome: "DENIED",
      denialReason: "IDOR: Patient attempted to approve consent belonging to another patient",
    });
    throw new ForbiddenError("You are not authorized to approve consent for another patient.");
  }

  // Check state: Must be PENDING or REQUESTED
  if (consent.status !== "PENDING" && consent.status !== "REQUESTED") {
    throw new InvalidStateTransitionError(
      `Cannot approve consent: current status is '${consent.status}'.`
    );
  }

  // Determine approved categories
  let approvedTypes: string[] = consent.hiTypes;
  if (input?.approvedHiTypes && input.approvedHiTypes.length > 0) {
    // Scope widening prevention: All approved categories must be within requested hiTypes!
    for (const type of input.approvedHiTypes) {
      if (!consent.hiTypes.includes(type)) {
        throw new ForbiddenError(
          `Cannot approve category '${type}': not in original requested scope.`
        );
      }
    }
    approvedTypes = input.approvedHiTypes;
  }

  const now = new Date();
  const nextVersion = (consent.version || 1) + 1;

  // Atomic conditional update (CAS) to prevent concurrent state transitions
  const updatedConsent = await ConsentArtifact.findOneAndUpdate(
    {
      consentId,
      patientId: new mongoose.Types.ObjectId(principal.id),
      status: { $in: ["PENDING", "REQUESTED"] },
    },
    {
      $set: {
        status: "APPROVED",
        approvedHiTypes: approvedTypes,
        grantedAt: now,
        version: nextVersion,
        signature: `SIG-ABHA-${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 8)}`,
      },
      $push: {
        decisionHistory: {
          action: "APPROVED",
          actorId: new mongoose.Types.ObjectId(principal.id),
          actorRole: principal.role,
          actorName: principal.name,
          timestamp: now,
          note: input?.note || "Consent approved by patient.",
          approvedHiTypes: approvedTypes,
        },
      },
    },
    { new: true }
  );

  if (!updatedConsent) {
    throw new InvalidStateTransitionError(
      "Consent approval failed: concurrent state transition occurred or status is no longer pending."
    );
  }

  await logAuditEvent({
    action: "CONSENT_APPROVED",
    principal,
    targetResourceType: "ConsentArtifact",
    targetResourceId: consentId,
    targetPatientId: consent.patientId,
    outcome: "ALLOWED",
    metadata: {
      version: nextVersion,
      approvedHiTypes: approvedTypes,
    },
  });

  return updatedConsent;
}

/**
 * Deny a pending consent request (Patient only)
 */
export async function denyConsent(
  principal: AuthenticatedPrincipal,
  consentId: string,
  reason?: string
): Promise<IConsentArtifact> {
  assertSafeIdentifier(consentId, "consentId");
  await connectToDatabase();

  if (principal.role !== "patient") {
    await logAuditEvent({
      action: "UNAUTHORIZED_CONSENT_DECISION",
      principal,
      targetResourceType: "ConsentArtifact",
      targetResourceId: consentId,
      outcome: "DENIED",
      denialReason: `Role '${principal.role}' attempted to deny patient consent`,
    });
    throw new ForbiddenError("Only the patient owner can deny consent requests.");
  }

  const consent = await ConsentArtifact.findOne({ consentId });
  if (!consent) {
    throw new NotFoundError(`Consent '${consentId}' not found.`);
  }

  if (consent.patientId.toString() !== principal.id) {
    await logAuditEvent({
      action: "UNAUTHORIZED_CONSENT_DECISION",
      principal,
      targetResourceType: "ConsentArtifact",
      targetResourceId: consentId,
      outcome: "DENIED",
      denialReason: "IDOR: Patient attempted to deny consent belonging to another patient",
    });
    throw new ForbiddenError("You are not authorized to deny consent for another patient.");
  }

  if (consent.status !== "PENDING" && consent.status !== "REQUESTED") {
    throw new InvalidStateTransitionError(
      `Cannot deny consent: current status is '${consent.status}'.`
    );
  }

  const now = new Date();

  // Atomic conditional update
  const updatedConsent = await ConsentArtifact.findOneAndUpdate(
    {
      consentId,
      patientId: new mongoose.Types.ObjectId(principal.id),
      status: { $in: ["PENDING", "REQUESTED"] },
    },
    {
      $set: {
        status: "DENIED",
        deniedAt: now,
      },
      $push: {
        decisionHistory: {
          action: "DENIED",
          actorId: new mongoose.Types.ObjectId(principal.id),
          actorRole: principal.role,
          actorName: principal.name,
          timestamp: now,
          note: reason || "Consent denied by patient.",
        },
      },
    },
    { new: true }
  );

  if (!updatedConsent) {
    throw new InvalidStateTransitionError(
      "Consent denial failed: concurrent state transition occurred or status is no longer pending."
    );
  }

  await logAuditEvent({
    action: "CONSENT_DENIED",
    principal,
    targetResourceType: "ConsentArtifact",
    targetResourceId: consentId,
    targetPatientId: consent.patientId,
    outcome: "ALLOWED",
    metadata: { reason },
  });

  return updatedConsent;
}

/**
 * Revoke an active consent (Patient only)
 * Revocation immediately and permanently blocks subsequent access.
 */
export async function revokeConsent(
  principal: AuthenticatedPrincipal,
  consentId: string,
  reason?: string
): Promise<IConsentArtifact> {
  assertSafeIdentifier(consentId, "consentId");
  await connectToDatabase();

  if (principal.role !== "patient") {
    await logAuditEvent({
      action: "UNAUTHORIZED_CONSENT_DECISION",
      principal,
      targetResourceType: "ConsentArtifact",
      targetResourceId: consentId,
      outcome: "DENIED",
      denialReason: `Role '${principal.role}' attempted to revoke patient consent`,
    });
    throw new ForbiddenError("Only the patient owner can revoke consent.");
  }

  const consent = await ConsentArtifact.findOne({ consentId });
  if (!consent) {
    throw new NotFoundError(`Consent '${consentId}' not found.`);
  }

  if (consent.patientId.toString() !== principal.id) {
    await logAuditEvent({
      action: "UNAUTHORIZED_CONSENT_DECISION",
      principal,
      targetResourceType: "ConsentArtifact",
      targetResourceId: consentId,
      outcome: "DENIED",
      denialReason: "IDOR: Patient attempted to revoke consent belonging to another patient",
    });
    throw new ForbiddenError("You are not authorized to revoke consent for another patient.");
  }

  if (consent.status !== "APPROVED" && consent.status !== "GRANTED") {
    throw new InvalidStateTransitionError(
      `Cannot revoke consent: current status is '${consent.status}'. Only active approved consents can be revoked.`
    );
  }

  const now = new Date();

  // Atomic conditional update
  const updatedConsent = await ConsentArtifact.findOneAndUpdate(
    {
      consentId,
      patientId: new mongoose.Types.ObjectId(principal.id),
      status: { $in: ["APPROVED", "GRANTED"] },
    },
    {
      $set: {
        status: "REVOKED",
        revokedAt: now,
      },
      $push: {
        decisionHistory: {
          action: "REVOKED",
          actorId: new mongoose.Types.ObjectId(principal.id),
          actorRole: principal.role,
          actorName: principal.name,
          timestamp: now,
          note: reason || "Consent revoked by patient.",
        },
      },
    },
    { new: true }
  );

  if (!updatedConsent) {
    throw new InvalidStateTransitionError(
      "Consent revocation failed: concurrent state transition occurred or status is not active."
    );
  }

  await logAuditEvent({
    action: "CONSENT_REVOKED",
    principal,
    targetResourceType: "ConsentArtifact",
    targetResourceId: consentId,
    targetPatientId: consent.patientId,
    outcome: "ALLOWED",
    metadata: { reason },
  });

  return updatedConsent;
}

/**
 * Retrieve consent decision history
 */
export async function getConsentHistory(
  principal: AuthenticatedPrincipal,
  consentId: string
): Promise<IConsentDecisionHistory[]> {
  const consent = await getConsentById(principal, consentId);
  return consent.decisionHistory || [];
}

/**
 * Background sweep: Mark eligible expired consents as EXPIRED
 */
export async function sweepExpiredConsents(): Promise<{ expiredCount: number }> {
  await connectToDatabase();
  const now = new Date();

  const expiredConsents = await ConsentArtifact.find({
    status: { $in: ["APPROVED", "GRANTED", "PENDING", "REQUESTED"] },
    expiresAt: { $lte: now },
  });

  let count = 0;
  for (const consent of expiredConsents) {
    const updated = await ConsentArtifact.findOneAndUpdate(
      {
        _id: consent._id,
        status: { $in: ["APPROVED", "GRANTED", "PENDING", "REQUESTED"] },
      },
      {
        $set: {
          status: "EXPIRED",
          expiredAt: now,
        },
        $push: {
          decisionHistory: {
            action: "EXPIRED",
            actorId: consent.patientId,
            actorRole: "system",
            actorName: "System Expiry Worker",
            timestamp: now,
            note: "Consent validity period expired.",
          },
        },
      }
    );

    if (updated) {
      count++;
      await logAuditEvent({
        action: "CONSENT_EXPIRED",
        principal: {
          id: consent.patientId.toString(),
          role: "patient",
          name: "System Worker",
        },
        targetResourceType: "ConsentArtifact",
        targetResourceId: consent.consentId,
        targetPatientId: consent.patientId,
        outcome: "ALLOWED",
      });
    }
  }

  return { expiredCount: count };
}

/**
 * Backward-compatible helper for Step 5 PATCH /api/v1/consents/[id]
 */
export async function updateConsentStatus(
  principal: AuthenticatedPrincipal,
  consentId: string,
  newStatus: "GRANTED" | "APPROVED" | "DENIED" | "REVOKED"
): Promise<IConsentArtifact> {
  if (newStatus === "GRANTED" || newStatus === "APPROVED") {
    return approveConsent(principal, consentId);
  } else if (newStatus === "DENIED") {
    return denyConsent(principal, consentId);
  } else if (newStatus === "REVOKED") {
    return revokeConsent(principal, consentId);
  }
  throw new InvalidQueryError(`Unsupported status transition '${newStatus}'.`);
}
