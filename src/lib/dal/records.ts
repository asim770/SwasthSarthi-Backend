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
import {
  assertDenyAdminClinicalAccess,
  assertPractitionerApproved,
  requireAllowedRole,
} from "./policies";
import { assertSafeQueryInput, assertSafeIdentifier } from "./sanitizer";
import { evaluateConsent } from "./consents";
import { logAuditEvent } from "./audit";
import { createNotification } from "./notifications";
import { connectToDatabase } from "@/lib/db/connect";
import { resolvePatientUser } from "./patients";

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

  const patient = await resolvePatientUser(patientId);
  const patientObjectId = patient._id as mongoose.Types.ObjectId;
  const targetPatientId = patientObjectId.toString();

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
    const isOwner =
      principal.id === targetPatientId ||
      (principal.patientId && principal.patientId === patient.patientId);

    if (!isOwner) {
      await logAuditEvent({
        action: "READ_CLINICAL_RECORDS_DENIED",
        principal,
        targetResourceType: "HealthRecord",
        targetPatientId,
        outcome: "DENIED",
        denialReason: "IDOR Attempt: Patient tried to access another patient's medical records",
      });
      throw new ForbiddenError("Access denied. You may only view your own personal health records.");
    }

    const query: Record<string, unknown> = {
      patientId: patientObjectId,
    };
    if (filter?.resourceType) {
      query.resourceType = filter.resourceType;
    }

    const records = await HealthRecord.find(query).sort({ date: -1 });

    await logAuditEvent({
      action: "READ_CLINICAL_RECORDS",
      principal,
      targetResourceType: "HealthRecord",
      targetPatientId,
      outcome: "ALLOWED",
      metadata: { recordsCount: records.length },
    });

    return records;
  }

  // 3. Doctor Role: Require active, granted electronic consent
  if (principal.role === "doctor") {
    const now = new Date();
    const activeConsents = await ConsentArtifact.find({
      patientId: patientObjectId,
      requesterDoctorId: new mongoose.Types.ObjectId(principal.id),
      status: { $in: ["APPROVED", "GRANTED"] },
      expiresAt: { $gt: now },
    });

    if (!activeConsents || activeConsents.length === 0) {
      await logAuditEvent({
        action: "READ_CLINICAL_RECORDS_DENIED",
        principal,
        targetResourceType: "HealthRecord",
        targetPatientId,
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
        targetPatientId,
        outcome: "DENIED",
        denialReason: `Requested resourceType '${filter.resourceType}' is not within active consent hiTypes`,
      });
      throw new ConsentRequiredError(
        `Requested clinical category '${filter.resourceType}' is outside consented categories.`
      );
    }

    // Build consent-constrained query
    const query: Record<string, unknown> = {
      patientId: patientObjectId,
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
      targetPatientId,
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

  const patient = await resolvePatientUser(input.patientId);
  const patientObjectId = patient._id as mongoose.Types.ObjectId;
  const targetPatientId = patientObjectId.toString();

  // If patient: can only create for self
  if (principal.role === "patient") {
    const isOwner =
      principal.id === targetPatientId ||
      (principal.patientId && principal.patientId === patient.patientId);
    if (!isOwner) {
      throw new ForbiddenError("Patients may only upload records to their own profile.");
    }
  }

  // If doctor: must have active consent to append records or create encounter
  if (principal.role === "doctor") {
    const evaluation = await evaluateConsent(
      targetPatientId,
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
    patientId: patientObjectId,
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

export interface PrescribedMedicineInput {
  name: string;
  dosage: string;
  frequency: string;
  durationDays: number;
  quantity?: number;
  instructions?: string;
}

export interface RecommendedLabTestInput {
  testName: string;
  testCode?: string;
  priority?: "ROUTINE" | "URGENT" | "STAT";
  instructions?: string;
}

export interface CreateDoctorConsultationInput {
  patientId: string;
  consultationDate?: string | Date;
  symptoms: string;
  clinicalFindings?: string;
  diagnosis: string;
  treatmentPlan: string;
  prescribedMedicines?: PrescribedMedicineInput[];
  recommendedTests?: RecommendedLabTestInput[];
  followUpDate?: string;
  clinicalNotes?: string;
  supportingDocuments?: string[];
}

/**
 * Doctor submits a comprehensive consultation record
 */
export async function createDoctorConsultation(
  principal: AuthenticatedPrincipal,
  input: CreateDoctorConsultationInput
): Promise<{
  consultationRecord: IHealthRecord;
  prescriptionId?: string;
  labOrderIds?: string[];
}> {
  requireAllowedRole(principal, ["doctor"], "Only licensed medical practitioners may submit consultation records.");
  assertPractitionerApproved(principal, "submitting clinical consultation reports");
  assertSafeQueryInput(input);
  await connectToDatabase();

  const patient = await resolvePatientUser(input.patientId);
  const patientObjectId = patient._id as mongoose.Types.ObjectId;

  // Verify active electronic consent
  const now = new Date();
  const activeConsent = await ConsentArtifact.findOne({
    patientId: patientObjectId,
    requesterDoctorId: new mongoose.Types.ObjectId(principal.id),
    status: { $in: ["APPROVED", "GRANTED"] },
    expiresAt: { $gt: now },
  });

  if (!activeConsent) {
    await logAuditEvent({
      action: "SUBMIT_CONSULTATION_DENIED",
      principal,
      targetResourceType: "HealthRecord",
      targetPatientId: patientObjectId.toString(),
      outcome: "DENIED",
      denialReason: "No active granted electronic consent found for doctor",
    });
    throw new ConsentRequiredError(
      "Active patient electronic consent is required before submitting clinical consultations."
    );
  }

  const consultationDate = input.consultationDate ? new Date(input.consultationDate) : now;
  const recordId = `REC-ENC-${Date.now().toString(36).toUpperCase()}-${Math.floor(100 + Math.random() * 900)}`;
  const careContextId = `OPD-${Date.now().toString(36).toUpperCase()}`;

  // 1. Create Encounter HealthRecord
  const consultationRecord = await HealthRecord.create({
    recordId,
    patientId: patientObjectId,
    title: `Consultation: ${input.diagnosis.trim()}`,
    resourceType: "Encounter",
    date: consultationDate,
    providerFacility: principal.facility || "SwasthSaarthi Care Network",
    doctorName: `Dr. ${principal.name}`,
    doctorId: new mongoose.Types.ObjectId(principal.id),
    status: "final",
    summary:
      input.treatmentPlan?.trim() ||
      input.clinicalNotes?.trim() ||
      `Clinical evaluation for ${input.diagnosis.trim()}`,
    careContextId,
    fhirBundleId: `urn:uuid:${crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2)}`,
    clinicalData: {
      symptoms: input.symptoms,
      clinicalFindings: input.clinicalFindings,
      diagnosis: input.diagnosis,
      treatmentPlan: input.treatmentPlan,
      prescribedMedicines: input.prescribedMedicines || [],
      recommendedTests: input.recommendedTests || [],
      followUpDate: input.followUpDate,
      clinicalNotes: input.clinicalNotes,
      supportingDocuments: input.supportingDocuments || [],
      doctorSpecialization: principal.specialization,
      doctorFacility: principal.facility,
    },
  });

  // 2. Automatically create Prescription if medicines prescribed
  let prescriptionId: string | undefined;
  if (input.prescribedMedicines && input.prescribedMedicines.length > 0) {
    try {
      const { Prescription } = await import("@/lib/db/models/Prescription");
      prescriptionId = `RX-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
      const expiresAt = new Date(now.getTime() + 30 * 86400000);

      const medications = input.prescribedMedicines.map((m) => {
        const qty = m.quantity && m.quantity > 0 ? m.quantity : m.durationDays * 2 || 30;
        return {
          name: m.name,
          dosage: m.dosage,
          frequency: m.frequency,
          durationDays: m.durationDays,
          route: "oral",
          quantity: qty,
          remainingQuantity: qty,
          instructions: m.instructions,
        };
      });

      const totalQuantity = medications.reduce((sum, m) => sum + m.quantity, 0);

      await Prescription.create({
        prescriptionId,
        patientId: patientObjectId,
        patientName: patient.name,
        doctorId: new mongoose.Types.ObjectId(principal.id),
        doctorName: principal.name,
        facility: principal.facility || "Care Clinic",
        medications,
        status: "ACTIVE",
        totalQuantity,
        dispensedQuantity: 0,
        remainingQuantity: totalQuantity,
        maxRefills: 0,
        remainingRefills: 0,
        prescribedAt: now,
        expiresAt,
        dispensedEvents: [],
      });

      // Also create MedicationRequest HealthRecord
      await HealthRecord.create({
        recordId: `REC-RX-${prescriptionId}`,
        patientId: patientObjectId,
        title: `Prescription: ${medications.map((m) => m.name).join(", ")}`,
        resourceType: "MedicationRequest",
        date: consultationDate,
        providerFacility: principal.facility || "Care Clinic",
        doctorName: `Dr. ${principal.name}`,
        doctorId: new mongoose.Types.ObjectId(principal.id),
        status: "final",
        summary: `Prescription issued: ${medications.map((m) => `${m.name} (${m.dosage})`).join("; ")}`,
        careContextId,
        fhirBundleId: `urn:uuid:${crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2)}`,
        clinicalData: {
          prescriptionId,
          medications,
          instructions: input.treatmentPlan,
        },
      });
    } catch (rxErr) {
      console.warn("Prescription auto-creation notice:", rxErr);
    }
  }

  // 3. Automatically create Lab Orders if tests recommended
  const labOrderIds: string[] = [];
  if (input.recommendedTests && input.recommendedTests.length > 0) {
    try {
      const { LabOrder } = await import("@/lib/db/models/LabOrder");
      for (const t of input.recommendedTests) {
        const orderId = `LAB-ORD-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
        await LabOrder.create({
          orderId,
          patientId: patientObjectId,
          patientName: patient.name,
          patientAbha: patient.abhaAddress || "patient@sbx",
          doctorId: new mongoose.Types.ObjectId(principal.id),
          doctorName: principal.name,
          targetFacility: "All Diagnostic Laboratories",
          testName: t.testName,
          testCode: t.testCode || "LAB-DIAG",
          instructions: t.instructions || input.treatmentPlan,
          status: "ORDERED",
          priority: t.priority || "ROUTINE",
          orderedAt: now,
        });
        labOrderIds.push(orderId);
      }
    } catch (labErr) {
      console.warn("Lab order auto-creation notice:", labErr);
    }
  }

  // 4. Audit logging
  await logAuditEvent({
    action: "DOCTOR_ADD_CONSULTATION",
    principal,
    targetResourceType: "HealthRecord",
    targetResourceId: recordId,
    targetPatientId: patientObjectId,
    outcome: "ALLOWED",
    metadata: {
      diagnosis: input.diagnosis,
      facility: principal.facility,
      prescriptionsCount: input.prescribedMedicines?.length || 0,
      labOrdersCount: labOrderIds.length,
    },
  });

  // 5. Patient notification
  await createNotification({
    recipientId: patientObjectId,
    recipientAbha: patient.abhaAddress || patient.email || "patient@sbx",
    recipientRole: "patient",
    category: "CONSULTATION",
    title: "New Doctor Consultation Report",
    message: `Dr. ${principal.name} has added a new consultation report (${input.diagnosis}) to your health record.`,
    relatedResourceId: recordId,
    relatedResourceType: "Encounter",
  });

  return {
    consultationRecord,
    prescriptionId,
    labOrderIds,
  };
}

export interface CreateHealthAssessmentInput {
  patientId: string;
  assessmentTitle: string;
  currentAssessment: string;
  observations?: string;
  changesSincePrevious?: string;
  treatmentProgress?: string;
  followUpRecommendations?: string;
  nextReviewDate?: string;
}

/**
 * Doctor adds a health assessment / health status update
 */
export async function createHealthAssessment(
  principal: AuthenticatedPrincipal,
  input: CreateHealthAssessmentInput
): Promise<IHealthRecord> {
  requireAllowedRole(principal, ["doctor"], "Only licensed medical practitioners may submit health assessments.");
  assertPractitionerApproved(principal, "updating patient health status");
  assertSafeQueryInput(input);
  await connectToDatabase();

  const patient = await resolvePatientUser(input.patientId);
  const patientObjectId = patient._id as mongoose.Types.ObjectId;

  const now = new Date();
  const activeConsent = await ConsentArtifact.findOne({
    patientId: patientObjectId,
    requesterDoctorId: new mongoose.Types.ObjectId(principal.id),
    status: { $in: ["APPROVED", "GRANTED"] },
    expiresAt: { $gt: now },
  });

  if (!activeConsent) {
    throw new ConsentRequiredError(
      "Active patient electronic consent is required before updating health assessments."
    );
  }

  const recordId = `REC-OBS-${Date.now().toString(36).toUpperCase()}-${Math.floor(100 + Math.random() * 900)}`;

  const record = await HealthRecord.create({
    recordId,
    patientId: patientObjectId,
    title: `Doctor Assessment: ${input.assessmentTitle.trim()}`,
    resourceType: "Observation",
    date: now,
    providerFacility: principal.facility || "Care Clinic",
    doctorName: `Dr. ${principal.name}`,
    doctorId: new mongoose.Types.ObjectId(principal.id),
    status: "final",
    summary: input.currentAssessment.trim(),
    careContextId: `ASSESS-${Date.now().toString(36).toUpperCase()}`,
    fhirBundleId: `urn:uuid:${crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2)}`,
    clinicalData: {
      assessmentTitle: input.assessmentTitle,
      currentAssessment: input.currentAssessment,
      observations: input.observations,
      changesSincePrevious: input.changesSincePrevious,
      treatmentProgress: input.treatmentProgress,
      followUpRecommendations: input.followUpRecommendations,
      nextReviewDate: input.nextReviewDate,
      reviewedByDoctor: principal.name,
      doctorSpecialization: principal.specialization,
      doctorFacility: principal.facility,
    },
  });

  await logAuditEvent({
    action: "DOCTOR_UPDATE_HEALTH_ASSESSMENT",
    principal,
    targetResourceType: "HealthRecord",
    targetResourceId: recordId,
    targetPatientId: patientObjectId,
    outcome: "ALLOWED",
    metadata: {
      assessmentTitle: input.assessmentTitle,
      doctor: principal.name,
    },
  });

  await createNotification({
    recipientId: patientObjectId,
    recipientAbha: patient.abhaAddress || patient.email || "patient@sbx",
    recipientRole: "patient",
    category: "CONSULTATION",
    title: "Health Assessment Updated",
    message: `Dr. ${principal.name} updated your clinical health assessment: ${input.assessmentTitle}.`,
    relatedResourceId: recordId,
    relatedResourceType: "Observation",
  });

  return record;
}

