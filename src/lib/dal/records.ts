import mongoose from "mongoose";
import { HealthRecord, IHealthRecord, HealthResourceType } from "@/lib/db/models/HealthRecord";
import { ConsentArtifact } from "@/lib/db/models/ConsentArtifact";
import { AuthenticatedPrincipal } from "./types";
import {
  ForbiddenError,
  NotFoundError,
  ConsentRequiredError,
  InvalidQueryError,
} from "./errors";
import { assertDenyAdminClinicalAccess } from "./policies";
import { assertSafeQueryInput, assertSafeIdentifier } from "./sanitizer";
import { evaluateConsent } from "./consents";
import { logAuditEvent } from "./audit";
import { connectToDatabase } from "@/lib/db/connect";

export interface RecordQueryFilter {
  resourceType?: string;
  fromDate?: string;
  toDate?: string;
}

export interface CreateHealthRecordInput {
  patientId: string;
  title: string;
  resourceType: HealthResourceType;
  date: Date | string;
  providerFacility?: string;
  summary: string;
  clinicalData?: Record<string, unknown>;
}

/**
 * Query patient clinical records with strict RBAC, ABAC, and consent boundary enforcement
 */
export async function getHealthRecordsForPatient(
  principal: AuthenticatedPrincipal,
  patientId: string,
  filter?: RecordQueryFilter
): Promise<IHealthRecord[]> {
  assertDenyAdminClinicalAccess(principal, "health records");
  assertSafeIdentifier(patientId, "patientId");
  assertSafeQueryInput(filter);
  await connectToDatabase();

  if (!mongoose.isValidObjectId(patientId)) {
    throw new InvalidQueryError("Invalid patient identifier format.");
  }

  // 1. Strictly block Laboratory and Pharmacy from general longitudinal record browsing
  if (principal.role === "laboratory" || principal.role === "pharmacy") {
    await logAuditEvent({
      action: "READ_CLINICAL_RECORDS_DENIED",
      principal,
      targetResourceType: "HealthRecord",
      targetPatientId: patientId,
      outcome: "DENIED",
      denialReason: `Role '${principal.role}' attempted to browse general longitudinal health records`,
    });
    throw new ForbiddenError(
      `Role '${principal.role}' is not authorized to browse general clinical records. Access is restricted to authorized orders or prescriptions.`
    );
  }

  // 2. Patient Role: Strict ownership check
  if (principal.role === "patient") {
    if (principal.id !== patientId) {
      await logAuditEvent({
        action: "READ_CLINICAL_RECORDS_DENIED",
        principal,
        targetResourceType: "HealthRecord",
        targetPatientId: patientId,
        outcome: "DENIED",
        denialReason: "IDOR Attempt: Patient tried to access another patient's medical records",
      });
      throw new ForbiddenError("Access denied. You may only view your own personal health records.");
    }

    const query: Record<string, unknown> = {
      patientId: new mongoose.Types.ObjectId(patientId),
    };
    if (filter?.resourceType) {
      query.resourceType = filter.resourceType;
    }

    const records = await HealthRecord.find(query).sort({ date: -1 });

    await logAuditEvent({
      action: "READ_CLINICAL_RECORDS",
      principal,
      targetResourceType: "HealthRecord",
      targetPatientId: patientId,
      outcome: "ALLOWED",
      metadata: { recordsCount: records.length },
    });

    return records;
  }

  // 3. Doctor Role: Require active, granted electronic consent
  if (principal.role === "doctor") {
    const now = new Date();
    const activeConsents = await ConsentArtifact.find({
      patientId: new mongoose.Types.ObjectId(patientId),
      requesterDoctorId: new mongoose.Types.ObjectId(principal.id),
      status: { $in: ["APPROVED", "GRANTED"] },
      expiresAt: { $gt: now },
    });

    if (!activeConsents || activeConsents.length === 0) {
      await logAuditEvent({
        action: "READ_CLINICAL_RECORDS_DENIED",
        principal,
        targetResourceType: "HealthRecord",
        targetPatientId: patientId,
        outcome: "DENIED",
        denialReason: "No active, valid electronic consent found for this patient and doctor",
      });
      throw new ConsentRequiredError(
        "Access denied. Active electronic consent from the patient is required to view clinical health records."
      );
    }

    // Collect all permitted resource categories and date boundaries
    const allowedHiTypes = new Set<string>();
    let earliestDate: Date | null = null;
    let latestDate: Date | null = null;

    for (const consent of activeConsents) {
      const types =
        consent.approvedHiTypes && consent.approvedHiTypes.length > 0
          ? consent.approvedHiTypes
          : consent.hiTypes;
      types.forEach((t) => allowedHiTypes.add(t));
      if (!earliestDate || consent.dateRangeFrom < earliestDate) {
        earliestDate = consent.dateRangeFrom;
      }
      if (!latestDate || consent.dateRangeTo > latestDate) {
        latestDate = consent.dateRangeTo;
      }
    }

    // If caller filtered by an explicit resource type, ensure it is consented
    if (filter?.resourceType && !allowedHiTypes.has(filter.resourceType)) {
      await logAuditEvent({
        action: "READ_CLINICAL_RECORDS_DENIED",
        principal,
        targetResourceType: "HealthRecord",
        targetPatientId: patientId,
        outcome: "DENIED",
        denialReason: `Requested resourceType '${filter.resourceType}' is not within active consent hiTypes`,
      });
      throw new ConsentRequiredError(
        `Requested clinical category '${filter.resourceType}' is outside consented categories.`
      );
    }

    // Build consent-constrained query
    const query: Record<string, unknown> = {
      patientId: new mongoose.Types.ObjectId(patientId),
      resourceType: filter?.resourceType
        ? filter.resourceType
        : { $in: Array.from(allowedHiTypes) },
    };

    const dateQuery: Record<string, unknown> = {};
    if (earliestDate) dateQuery.$gte = earliestDate;
    if (latestDate) dateQuery.$lte = latestDate;
    if (Object.keys(dateQuery).length > 0) {
      query.date = dateQuery;
    }

    const records = await HealthRecord.find(query).sort({ date: -1 });

    await logAuditEvent({
      action: "READ_CLINICAL_RECORDS",
      principal,
      targetResourceType: "HealthRecord",
      targetPatientId: patientId,
      outcome: "ALLOWED",
      metadata: {
        recordsCount: records.length,
        consentedCategories: Array.from(allowedHiTypes),
      },
    });

    return records;
  }

  throw new ForbiddenError("Unauthorized to access clinical health records.");
}

/**
 * Retrieve a single health record with strict consent verification
 */
export async function getHealthRecordById(
  principal: AuthenticatedPrincipal,
  recordId: string
): Promise<IHealthRecord> {
  assertDenyAdminClinicalAccess(principal, "health record details");
  assertSafeIdentifier(recordId, "recordId");
  await connectToDatabase();

  const record = await HealthRecord.findOne({ recordId });
  if (!record) {
    throw new NotFoundError(`Health record '${recordId}' not found.`);
  }

  // 1. Patient: Check ownership
  if (principal.role === "patient") {
    if (record.patientId.toString() !== principal.id) {
      await logAuditEvent({
        action: "READ_RECORD_BY_ID_DENIED",
        principal,
        targetResourceType: "HealthRecord",
        targetResourceId: recordId,
        outcome: "DENIED",
        denialReason: "IDOR Attempt: Patient tried to fetch another user's record ID",
      });
      throw new ForbiddenError("Access denied. You may only view your own records.");
    }

    return record;
  }

  // 2. Doctor: Verify active consent for this specific record category and date
  if (principal.role === "doctor") {
    const evaluation = await evaluateConsent(
      record.patientId.toString(),
      principal.id,
      record.resourceType,
      record.date
    );

    if (!evaluation.hasConsent) {
      await logAuditEvent({
        action: "READ_RECORD_BY_ID_DENIED",
        principal,
        targetResourceType: "HealthRecord",
        targetResourceId: recordId,
        targetPatientId: record.patientId,
        outcome: "DENIED",
        denialReason: `Consent verification failed: ${evaluation.reason}`,
      });
      throw new ConsentRequiredError(
        "Access denied. You do not possess active electronic consent covering this specific clinical record."
      );
    }

    await logAuditEvent({
      action: "READ_RECORD_BY_ID",
      principal,
      targetResourceType: "HealthRecord",
      targetResourceId: recordId,
      targetPatientId: record.patientId,
      outcome: "ALLOWED",
    });

    return record;
  }

  throw new ForbiddenError("Unauthorized to view this clinical health record.");
}

/**
 * Create a new health record (Patient upload or authorized Doctor encounter entry)
 */
export async function createHealthRecord(
  principal: AuthenticatedPrincipal,
  input: CreateHealthRecordInput
): Promise<IHealthRecord> {
  assertDenyAdminClinicalAccess(principal, "health record creation");
  assertSafeQueryInput(input);
  await connectToDatabase();

  if (!mongoose.isValidObjectId(input.patientId)) {
    throw new InvalidQueryError("Invalid patient identifier format.");
  }

  // If patient: can only create for self
  if (principal.role === "patient" && principal.id !== input.patientId) {
    throw new ForbiddenError("Patients may only upload records to their own profile.");
  }

  // If doctor: must have active consent to append records or create encounter
  if (principal.role === "doctor") {
    const evaluation = await evaluateConsent(
      input.patientId,
      principal.id,
      input.resourceType
    );
    if (!evaluation.hasConsent) {
      throw new ConsentRequiredError(
        "Active consent required to create clinical records for this patient."
      );
    }
  }

  const recordId = `REC-${new Date().getFullYear()}-${Math.floor(100 + Math.random() * 900)}`;

  const record = await HealthRecord.create({
    recordId,
    patientId: new mongoose.Types.ObjectId(input.patientId),
    title: input.title.trim(),
    resourceType: input.resourceType,
    date: new Date(input.date),
    providerFacility: input.providerFacility || principal.facility || "SwasthSaarthi Personal Health Vault",
    doctorName: principal.role === "doctor" ? principal.name : "Self-Reported / Patient Upload",
    doctorId: principal.role === "doctor" ? new mongoose.Types.ObjectId(principal.id) : undefined,
    status: "final",
    summary: input.summary.trim(),
    careContextId: `ABDM-DOC-${Date.now().toString().slice(-6)}`,
    fhirBundleId: `urn:uuid:${crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2)}`,
    clinicalData: input.clinicalData || {},
  });

  await logAuditEvent({
    action: "CREATE_HEALTH_RECORD",
    principal,
    targetResourceType: "HealthRecord",
    targetResourceId: record.recordId,
    targetPatientId: record.patientId,
    outcome: "ALLOWED",
    metadata: { resourceType: input.resourceType },
  });

  return record;
}
