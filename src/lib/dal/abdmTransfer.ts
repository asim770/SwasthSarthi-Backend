import mongoose from "mongoose";
import { connectToDatabase } from "@/lib/db/connect";
import { HealthRecord, IHealthRecord } from "@/lib/db/models/HealthRecord";
import { TransferredRecordCache, ITransferredRecordCache } from "@/lib/db/models/TransferredRecordCache";
import { HealthDataTransfer } from "@/lib/db/models/HealthDataTransfer";
import { ConsentArtifact } from "@/lib/db/models/ConsentArtifact";
import { User } from "@/lib/db/models/User";
import { AuthenticatedPrincipal } from "./types";
import {
  ForbiddenError,
  NotFoundError,
  ConsentRequiredError,
  InvalidQueryError,
} from "./errors";
import { assertDenyAdminClinicalAccess, requireAllowedRole } from "./policies";
import { assertSafeQueryInput, assertSafeIdentifier } from "./sanitizer";
import { logAuditEvent } from "./audit";
import { mockAbdmAdapter } from "@/lib/abdm/mockAdapter";
import { dispatchHealthDataTransfer } from "@/lib/queue/transferWorker";
import { summarizeFhirResource, extractResourceDate } from "@/lib/fhir/summarizer";
import { FhirBundle, FhirBundleEntry, BaseFhirResource } from "@/lib/fhir/types";
import { DiscoveredCareContext, HealthDataTransferStatusReport } from "@/lib/abdm/types";

export interface TimelineQueryFilter {
  resourceType?: string;
  fromDate?: string;
  toDate?: string;
  search?: string;
  sourceInstitution?: string;
}

export interface TimelineItem {
  id: string;
  recordId: string;
  title: string;
  resourceType: string;
  category: string;
  date: string;
  status: string;
  summary: string;
  providerFacility: string;
  doctorName: string;
  sourceInstitution: string;
  careContextId: string;
  bundleId: string;
  isMockData: boolean;
  origin: "vault" | "abdm_transfer";
  rawResourceId?: string;
  details?: Record<string, unknown>;
}

/**
 * Retrieve longitudinal health record timeline with full consent, RBAC, and ABAC enforcement
 */
export async function getAuthorizedTimeline(
  principal: AuthenticatedPrincipal,
  patientId: string,
  filter?: TimelineQueryFilter
): Promise<TimelineItem[]> {
  assertDenyAdminClinicalAccess(principal, "patient health timeline");
  assertSafeIdentifier(patientId, "patientId");
  assertSafeQueryInput(filter);
  await connectToDatabase();

  if (!mongoose.isValidObjectId(patientId)) {
    throw new InvalidQueryError("Invalid patient identifier format.");
  }

  // Strictly block Laboratory and Pharmacy from browsing general timeline
  if (principal.role === "laboratory" || principal.role === "pharmacy") {
    await logAuditEvent({
      action: "READ_CLINICAL_RECORDS_DENIED",
      principal,
      targetResourceType: "HealthRecord",
      targetPatientId: patientId,
      outcome: "DENIED",
      denialReason: `Role '${principal.role}' attempted to browse general longitudinal timeline`,
    });
    throw new ForbiddenError(
      `Role '${principal.role}' is not authorized to browse general patient health timeline.`
    );
  }

  const patientObjectId = new mongoose.Types.ObjectId(patientId);
  const patientUser = await User.findById(patientObjectId);
  if (!patientUser) {
    throw new NotFoundError("Patient account not found.");
  }

  const now = new Date();
  const timelineItems: TimelineItem[] = [];

  // 1. Patient Role: View personal vault records and authorized transferred records
  if (principal.role === "patient") {
    if (principal.id !== patientId) {
      await logAuditEvent({
        action: "READ_PATIENT_TIMELINE_DENIED",
        principal,
        targetResourceType: "HealthRecord",
        targetPatientId: patientId,
        outcome: "DENIED",
        denialReason: "IDOR Attempt: Patient tried to access another patient's timeline",
      });
      throw new ForbiddenError("Access denied. You may only view your own personal health timeline.");
    }

    // A. Local Vault Records
    const vaultRecords = await HealthRecord.find({ patientId: patientObjectId }).sort({ date: -1 });
    for (const rec of vaultRecords) {
      timelineItems.push({
        id: rec.recordId,
        recordId: rec.recordId,
        title: rec.title,
        resourceType: rec.resourceType,
        category: rec.resourceType,
        date: rec.date.toISOString().split("T")[0],
        status: rec.status,
        summary: rec.summary,
        providerFacility: rec.providerFacility,
        doctorName: rec.doctorName,
        sourceInstitution: rec.providerFacility,
        careContextId: rec.careContextId,
        bundleId: rec.fhirBundleId,
        isMockData: true,
        origin: "vault",
        details: (rec.clinicalData as Record<string, unknown>) || {},
      });
    }

    // B. Transferred and cached records across HIPs
    const cachedTransfers = await TransferredRecordCache.find({
      patientId: patientObjectId,
      expiresAt: { $gt: now },
    });

    for (const cache of cachedTransfers) {
      const bundle = cache.fhirBundle as FhirBundle;
      if (bundle && Array.isArray(bundle.entry)) {
        for (const entry of bundle.entry) {
          if (!entry.resource) continue;
          const summary = summarizeFhirResource(entry.resource as Record<string, unknown>);
          timelineItems.push({
            id: `XFER-${entry.resource.id || Math.random().toString(36).slice(2)}`,
            recordId: (entry.resource.id as string) || "RESOURCE",
            title: summary.title,
            resourceType: entry.resource.resourceType as string,
            category: summary.category,
            date: summary.date,
            status: summary.status,
            summary: summary.summary,
            providerFacility: cache.hipName,
            doctorName: summary.performer || "Institutional Clinician",
            sourceInstitution: cache.hipName,
            careContextId: `ABDM-${cache.hipId}`,
            bundleId: cache.bundleId,
            isMockData: true,
            origin: "abdm_transfer",
            rawResourceId: entry.resource.id as string,
            details: summary.details,
          });
        }
      }
    }
  }

  // 2. Doctor Role: Require active, valid electronic consent
  if (principal.role === "doctor") {
    const activeConsents = await ConsentArtifact.find({
      patientId: patientObjectId,
      requesterDoctorId: new mongoose.Types.ObjectId(principal.id),
      status: { $in: ["APPROVED", "GRANTED"] },
      expiresAt: { $gt: now },
    });

    if (!activeConsents || activeConsents.length === 0) {
      await logAuditEvent({
        action: "READ_PATIENT_TIMELINE_DENIED",
        principal,
        targetResourceType: "HealthRecord",
        targetPatientId: patientId,
        outcome: "DENIED",
        denialReason: "No active, valid electronic consent found for this patient and doctor",
      });
      throw new ConsentRequiredError(
        "Access denied. Active electronic consent from the patient is required to view health records."
      );
    }

    // Determine consent boundaries
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

    // A. Local Vault Records within consent scope
    const vaultQuery: Record<string, unknown> = {
      patientId: patientObjectId,
      resourceType: { $in: Array.from(allowedHiTypes) },
    };
    const dateQuery: Record<string, unknown> = {};
    if (earliestDate) dateQuery.$gte = earliestDate;
    if (latestDate) dateQuery.$lte = latestDate;
    if (Object.keys(dateQuery).length > 0) vaultQuery.date = dateQuery;

    const vaultRecords = await HealthRecord.find(vaultQuery).sort({ date: -1 });
    for (const rec of vaultRecords) {
      timelineItems.push({
        id: rec.recordId,
        recordId: rec.recordId,
        title: rec.title,
        resourceType: rec.resourceType,
        category: rec.resourceType,
        date: rec.date.toISOString().split("T")[0],
        status: rec.status,
        summary: rec.summary,
        providerFacility: rec.providerFacility,
        doctorName: rec.doctorName,
        sourceInstitution: rec.providerFacility,
        careContextId: rec.careContextId,
        bundleId: rec.fhirBundleId,
        isMockData: true,
        origin: "vault",
        details: (rec.clinicalData as Record<string, unknown>) || {},
      });
    }

    // B. Transferred and cached records transferred by this doctor and within consent scope
    const cachedTransfers = await TransferredRecordCache.find({
      patientId: patientObjectId,
      doctorId: new mongoose.Types.ObjectId(principal.id),
      expiresAt: { $gt: now },
    });

    for (const cache of cachedTransfers) {
      const bundle = cache.fhirBundle as FhirBundle;
      if (bundle && Array.isArray(bundle.entry)) {
        for (const entry of bundle.entry) {
          if (!entry.resource) continue;
          const res = entry.resource as Record<string, unknown>;
          const resType = res.resourceType as string;

          // Scope check: must be in allowedHiTypes
          if (!allowedHiTypes.has(resType)) continue;

          // Date check
          const resDate = extractResourceDate(res);
          if (earliestDate && resDate < earliestDate) continue;
          if (latestDate && resDate > latestDate) continue;

          const summary = summarizeFhirResource(res);
          timelineItems.push({
            id: `XFER-${res.id || Math.random().toString(36).slice(2)}`,
            recordId: (res.id as string) || "RESOURCE",
            title: summary.title,
            resourceType: resType,
            category: summary.category,
            date: summary.date,
            status: summary.status,
            summary: summary.summary,
            providerFacility: cache.hipName,
            doctorName: summary.performer || "Institutional Clinician",
            sourceInstitution: cache.hipName,
            careContextId: `ABDM-${cache.hipId}`,
            bundleId: cache.bundleId,
            isMockData: true,
            origin: "abdm_transfer",
            rawResourceId: res.id as string,
            details: summary.details,
          });
        }
      }
    }
  }

  // Apply filters
  let filtered = timelineItems;

  if (filter?.resourceType && filter.resourceType !== "ALL") {
    filtered = filtered.filter((item) => item.resourceType === filter.resourceType);
  }

  if (filter?.fromDate) {
    filtered = filtered.filter((item) => item.date >= filter.fromDate!);
  }

  if (filter?.toDate) {
    filtered = filtered.filter((item) => item.date <= filter.toDate!);
  }

  if (filter?.sourceInstitution) {
    const srcLower = filter.sourceInstitution.toLowerCase();
    filtered = filtered.filter((item) =>
      item.sourceInstitution.toLowerCase().includes(srcLower)
    );
  }

  if (filter?.search) {
    const q = filter.search.toLowerCase();
    filtered = filtered.filter(
      (item) =>
        item.title.toLowerCase().includes(q) ||
        item.summary.toLowerCase().includes(q) ||
        item.doctorName.toLowerCase().includes(q) ||
        item.providerFacility.toLowerCase().includes(q)
    );
  }

  // Deduplicate and sort descending by date
  filtered.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

  await logAuditEvent({
    action: "READ_PATIENT_TIMELINE",
    principal,
    targetResourceType: "HealthRecord",
    targetPatientId: patientId,
    outcome: "ALLOWED",
    metadata: {
      count: filtered.length,
      filteredBy: filter?.resourceType || "ALL",
    },
  });

  return filtered;
}

/**
 * Retrieve authorized FHIR Bundle by ID
 */
export async function getAuthorizedFhirBundle(
  principal: AuthenticatedPrincipal,
  bundleId: string
): Promise<FhirBundle> {
  assertDenyAdminClinicalAccess(principal, "FHIR Bundle details");
  assertSafeIdentifier(bundleId, "bundleId");
  await connectToDatabase();

  // 1. Search in TransferredRecordCache
  const cached = await TransferredRecordCache.findOne({ bundleId });
  if (cached) {
    // Check patient ownership
    if (principal.role === "patient" && cached.patientId.toString() !== principal.id) {
      throw new ForbiddenError("Access denied. You may only view your own FHIR records.");
    }
    // Check doctor consent
    if (principal.role === "doctor") {
      const activeConsent = await ConsentArtifact.findOne({
        consentId: cached.consentId,
        status: { $in: ["APPROVED", "GRANTED"] },
        expiresAt: { $gt: new Date() },
      });
      if (!activeConsent) {
        throw new ConsentRequiredError("Active consent required to access this FHIR bundle.");
      }
    }

    await logAuditEvent({
      action: "READ_FHIR_BUNDLE",
      principal,
      targetResourceType: "FhirBundle",
      targetResourceId: bundleId,
      targetPatientId: cached.patientId,
      outcome: "ALLOWED",
    });

    return cached.fhirBundle as FhirBundle;
  }

  // 2. Search in HealthRecord vault for matching fhirBundleId
  const vaultRecord = await HealthRecord.findOne({ fhirBundleId: bundleId });
  if (vaultRecord) {
    if (principal.role === "patient" && vaultRecord.patientId.toString() !== principal.id) {
      throw new ForbiddenError("Access denied. You may only view your own FHIR records.");
    }
    if (principal.role === "doctor") {
      const consent = await ConsentArtifact.findOne({
        patientId: vaultRecord.patientId,
        requesterDoctorId: new mongoose.Types.ObjectId(principal.id),
        status: { $in: ["APPROVED", "GRANTED"] },
        expiresAt: { $gt: new Date() },
      });
      if (!consent) {
        throw new ConsentRequiredError("Active consent required to access this FHIR bundle.");
      }
    }

    // Construct valid FHIR R4 Bundle for vault record
    const bundle: FhirBundle = {
      resourceType: "Bundle",
      id: vaultRecord.fhirBundleId,
      type: "document",
      timestamp: vaultRecord.date.toISOString(),
      entry: [
        {
          fullUrl: `https://swasth.saarthi.vault/records/${vaultRecord.recordId}`,
          resource: {
            resourceType: vaultRecord.resourceType as unknown as FhirBundleEntry["resource"]["resourceType"],
            id: vaultRecord.recordId,
            status: vaultRecord.status,
            date: vaultRecord.date.toISOString(),
            subject: {
              reference: `Patient/${vaultRecord.patientId.toString()}`,
            },
            code: {
              text: vaultRecord.title,
            },
            clinicalData: vaultRecord.clinicalData,
          } as unknown as BaseFhirResource,
        },
      ],
    };

    await logAuditEvent({
      action: "READ_FHIR_BUNDLE",
      principal,
      targetResourceType: "FhirBundle",
      targetResourceId: bundleId,
      targetPatientId: vaultRecord.patientId,
      outcome: "ALLOWED",
    });

    return bundle;
  }

  throw new NotFoundError(`FHIR Bundle '${bundleId}' not found.`);
}

/**
 * Initiate scoped health data transfer from participating mock institution
 */
export async function initiateScopedHealthTransfer(
  principal: AuthenticatedPrincipal,
  input: {
    consentId: string;
    patientId: string;
    hipId: string;
    transactionId?: string;
    requestedHiTypes?: string[];
    dateRangeFrom?: string;
    dateRangeTo?: string;
  }
): Promise<HealthDataTransferStatusReport> {
  requireAllowedRole(principal, ["doctor"], "Only licensed medical practitioners can initiate ABDM record transfers.");
  assertDenyAdminClinicalAccess(principal, "health data transfer");
  assertSafeQueryInput(input);
  await connectToDatabase();

  const patient = await User.findById(input.patientId);
  if (!patient || !patient.isActive) {
    throw new NotFoundError("Target patient account not found or inactive.");
  }

  // Initiate transfer record via mock adapter
  const report = await mockAbdmAdapter.initiateHealthDataTransfer(
    {
      consentId: input.consentId,
      patientId: input.patientId,
      patientAbhaAddress: patient.abhaAddress,
      requesterDoctorId: principal.id,
      requesterFacility: principal.facility || "Apollo Clinics, Indiranagar",
      hipId: input.hipId,
      transactionId: input.transactionId,
      requestedHiTypes: input.requestedHiTypes,
      dateRangeFrom: input.dateRangeFrom,
      dateRangeTo: input.dateRangeTo,
    },
    principal
  );

  // Dispatch background job (or resilient in-process execution)
  await dispatchHealthDataTransfer(report.transferId, principal);

  // Return latest status report
  return await mockAbdmAdapter.getTransferStatus(report.transferId, principal);
}

/**
 * Discover care contexts at participating mock institutions
 */
export async function getDiscoverableCareContexts(
  principal: AuthenticatedPrincipal,
  patientId: string
): Promise<DiscoveredCareContext[]> {
  assertDenyAdminClinicalAccess(principal, "care contexts");
  assertSafeIdentifier(patientId, "patientId");
  await connectToDatabase();

  const patient = await User.findById(patientId);
  if (!patient) {
    throw new NotFoundError("Patient account not found.");
  }

  // Authorization check
  if (principal.role === "patient" && principal.id !== patientId) {
    throw new ForbiddenError("Patients may only discover their own care contexts.");
  }

  if (principal.role === "doctor") {
    // Doctor needs active consent or linked patient care relationship
    const consent = await ConsentArtifact.findOne({
      patientId: patient._id,
      requesterDoctorId: new mongoose.Types.ObjectId(principal.id),
      status: { $in: ["APPROVED", "GRANTED", "PENDING"] },
    });
    if (!consent) {
      throw new ConsentRequiredError(
        "Patient consent request is required to discover linked ABDM care contexts."
      );
    }
  }

  return await mockAbdmAdapter.discoverPatientCareContexts(patient.abhaAddress);
}
