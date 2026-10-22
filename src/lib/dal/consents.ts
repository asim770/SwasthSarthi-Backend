import mongoose from "mongoose";
import { ConsentArtifact, IConsentArtifact, ConsentStatus } from "@/lib/db/models/ConsentArtifact";
import { User } from "@/lib/db/models/User";
import { AuthenticatedPrincipal, ConsentEvaluationResult } from "./types";
import {
  ForbiddenError,
  NotFoundError,
  InvalidQueryError,
} from "./errors";
import { requireAllowedRole, assertPatientOwnership } from "./policies";
import { assertSafeQueryInput, assertSafeIdentifier } from "./sanitizer";
import { logAuditEvent } from "./audit";
import { connectToDatabase } from "@/lib/db/connect";

export interface CreateConsentRequestInput {
  patientId: string;
  purpose: string;
  hiTypes: string[];
  dateRangeFrom: Date;
  dateRangeTo: Date;
  expiresAt: Date;
}

/**
 * Evaluate if an active, unexpired, granted electronic consent exists covering
 * the requested patient, doctor, resource category, and record date.
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

  // Find granted consents that have not passed their expiry date
  const consents = await ConsentArtifact.find({
    patientId: new mongoose.Types.ObjectId(patientId),
    requesterDoctorId: new mongoose.Types.ObjectId(doctorId),
    status: "GRANTED",
    expiresAt: { $gt: now },
  });

  if (!consents || consents.length === 0) {
    return { hasConsent: false, reason: "NO_ACTIVE_CONSENT_FOUND" };
  }

  for (const consent of consents) {
    // 1. Check if resource category is permitted
    const coversType = consent.hiTypes.includes(resourceType);
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

    // Matching consent found
    return {
      hasConsent: true,
      consentId: consent.consentId,
      allowedHiTypes: consent.hiTypes,
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
 * Get consent artefacts for the authenticated principal
 */
export async function getConsentsForPrincipal(
  principal: AuthenticatedPrincipal
): Promise<IConsentArtifact[]> {
  await connectToDatabase();

  if (principal.role === "patient") {
    return ConsentArtifact.find({
      patientId: new mongoose.Types.ObjectId(principal.id),
    })
      .populate("requesterDoctorId", "name abhaId specialization facility")
      .sort({ createdAt: -1 });
  }

  if (principal.role === "doctor") {
    return ConsentArtifact.find({
      requesterDoctorId: new mongoose.Types.ObjectId(principal.id),
    })
      .populate("patientId", "name abhaId abhaAddress gender dateOfBirth")
      .sort({ createdAt: -1 });
  }

  if (principal.role === "admin") {
    // Admin only receives anonymized operational metadata; no patient clinical data
    return ConsentArtifact.find({})
      .select("consentId requesterFacility purpose status hiTypes expiresAt createdAt")
      .sort({ createdAt: -1 })
      .limit(50);
  }

  throw new ForbiddenError(
    `Role '${principal.role}' is not authorized to browse electronic consent artefacts.`
  );
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

  const consent = await ConsentArtifact.findOne({ consentId });
  if (!consent) {
    throw new NotFoundError(`Consent artefact '${consentId}' not found.`);
  }

  // Authorization check: only the patient owner or requesting doctor may read it
  const isPatientOwner = consent.patientId.toString() === principal.id;
  const isRequesterDoctor = consent.requesterDoctorId.toString() === principal.id;

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

  const patient = await User.findById(input.patientId);
  if (!patient || patient.role !== "patient" || !patient.isActive) {
    throw new NotFoundError("Target patient does not exist or account is inactive.");
  }

  const consentId = `CONSENT-${Date.now().toString(36).toUpperCase()}-${Math.random()
    .toString(36)
    .substring(2, 6)
    .toUpperCase()}`;

  const consent = await ConsentArtifact.create({
    consentId,
    patientId: patient._id,
    requesterDoctorId: new mongoose.Types.ObjectId(principal.id),
    requesterFacility: principal.facility,
    purpose: input.purpose.trim(),
    hiTypes: input.hiTypes,
    dateRangeFrom: new Date(input.dateRangeFrom),
    dateRangeTo: new Date(input.dateRangeTo),
    expiresAt: new Date(input.expiresAt),
    status: "REQUESTED",
  });

  await logAuditEvent({
    action: "CREATE_CONSENT_REQUEST",
    principal,
    targetResourceType: "ConsentArtifact",
    targetResourceId: consent.consentId,
    targetPatientId: patient._id,
    outcome: "ALLOWED",
    metadata: {
      purpose: input.purpose,
      hiTypesCount: input.hiTypes.length,
    },
  });

  return consent;
}

/**
 * Update consent decision (Patient grants/denies; Patient or Doctor revokes)
 */
export async function updateConsentStatus(
  principal: AuthenticatedPrincipal,
  consentId: string,
  newStatus: "GRANTED" | "DENIED" | "REVOKED"
): Promise<IConsentArtifact> {
  assertSafeIdentifier(consentId, "consentId");
  await connectToDatabase();

  const consent = await ConsentArtifact.findOne({ consentId });
  if (!consent) {
    throw new NotFoundError(`Consent '${consentId}' not found.`);
  }

  const isPatientOwner = consent.patientId.toString() === principal.id;
  const isRequesterDoctor = consent.requesterDoctorId.toString() === principal.id;

  if (newStatus === "GRANTED" || newStatus === "DENIED") {
    // Only the patient can approve or deny consent
    if (!isPatientOwner) {
      await logAuditEvent({
        action: `CONSENT_${newStatus}_DENIED`,
        principal,
        targetResourceType: "ConsentArtifact",
        targetResourceId: consentId,
        outcome: "DENIED",
        denialReason: "Only the patient owner can approve or deny consent",
      });
      throw new ForbiddenError("Only the patient owner can approve or deny consent requests.");
    }

    consent.status = newStatus;
    if (newStatus === "GRANTED") {
      consent.grantedAt = new Date();
    } else {
      consent.deniedAt = new Date();
    }
  } else if (newStatus === "REVOKED") {
    // Both patient and requesting doctor can revoke/withdraw consent
    if (!isPatientOwner && !isRequesterDoctor) {
      await logAuditEvent({
        action: "CONSENT_REVOKE_DENIED",
        principal,
        targetResourceType: "ConsentArtifact",
        targetResourceId: consentId,
        outcome: "DENIED",
        denialReason: "Only the patient owner or requesting doctor can revoke consent",
      });
      throw new ForbiddenError("You are not authorized to revoke this consent.");
    }

    consent.status = "REVOKED";
    consent.revokedAt = new Date();
  }

  await consent.save();

  await logAuditEvent({
    action: `CONSENT_${newStatus}`,
    principal,
    targetResourceType: "ConsentArtifact",
    targetResourceId: consentId,
    targetPatientId: consent.patientId,
    outcome: "ALLOWED",
    metadata: { status: newStatus },
  });

  return consent;
}
