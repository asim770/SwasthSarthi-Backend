import mongoose from "mongoose";
import { connectToDatabase } from "@/lib/db/connect";
import {
  ParticipatingInstitution,
  PARTICIPATING_INSTITUTIONS,
  DiscoveredCareContext,
  HealthDataTransferInitParams,
  HealthDataTransferStatusReport,
} from "./types";
import { IAbdmAdapter } from "./adapter";
import { SourceInstitutionRecord } from "@/lib/db/models/SourceInstitutionRecord";
import {
  HealthDataTransfer,
  IHealthDataTransfer,
} from "@/lib/db/models/HealthDataTransfer";
import { TransferredRecordCache } from "@/lib/db/models/TransferredRecordCache";
import { ConsentArtifact } from "@/lib/db/models/ConsentArtifact";
import { User } from "@/lib/db/models/User";
import { AuthenticatedPrincipal } from "@/lib/dal/types";
import {
  ForbiddenError,
  NotFoundError,
  ConsentRequiredError,
  InvalidQueryError,
} from "@/lib/dal/errors";
import { logAuditEvent } from "@/lib/dal/audit";
import { validateFhirBundle } from "@/lib/fhir/validator";
import { FhirBundle, FhirBundleEntry, BaseFhirResource } from "@/lib/fhir/types";

const DEMO_TRANSFER_CACHE_HOURS = 24;

export class MockAbdmAdapter implements IAbdmAdapter {
  /**
   * Return simulated participating ABDM healthcare institutions (HIPs)
   */
  async getParticipatingInstitutions(): Promise<ParticipatingInstitution[]> {
    return PARTICIPATING_INSTITUTIONS;
  }

  /**
   * Discover care contexts linked to a patient ABHA address across participating HIPs
   */
  async discoverPatientCareContexts(
    patientAbhaAddress: string
  ): Promise<DiscoveredCareContext[]> {
    await connectToDatabase();

    const normalizedAddress = patientAbhaAddress.trim().toLowerCase();
    const records = await SourceInstitutionRecord.find({
      patientAbhaAddress: normalizedAddress,
    });

    if (!records || records.length === 0) {
      return [];
    }

    const careContextMap = new Map<string, DiscoveredCareContext>();

    for (const rec of records) {
      const key = `${rec.institutionId}::${rec.careContextId}`;
      const recDate = rec.recordDate.toISOString().split("T")[0];

      if (!careContextMap.has(key)) {
        careContextMap.set(key, {
          careContextId: rec.careContextId,
          patientAbhaAddress: rec.patientAbhaAddress,
          institutionId: rec.institutionId,
          institutionName: rec.institutionName,
          institutionType: rec.institutionType,
          description: rec.careContextDescription,
          resourceCount: 1,
          availableHiTypes: [rec.resourceType],
          earliestDate: recDate,
          latestDate: recDate,
          isMockData: true,
        });
      } else {
        const item = careContextMap.get(key)!;
        item.resourceCount += 1;
        if (!item.availableHiTypes.includes(rec.resourceType)) {
          item.availableHiTypes.push(rec.resourceType);
        }
        if (recDate < item.earliestDate) item.earliestDate = recDate;
        if (recDate > item.latestDate) item.latestDate = recDate;
      }
    }

    return Array.from(careContextMap.values());
  }

  /**
   * Initiate a health information transfer request with idempotency protection
   */
  async initiateHealthDataTransfer(
    params: HealthDataTransferInitParams,
    principal: AuthenticatedPrincipal
  ): Promise<HealthDataTransferStatusReport> {
    await connectToDatabase();

    if (!params.consentId || !params.patientId || !params.hipId) {
      throw new InvalidQueryError("consentId, patientId, and hipId are required.");
    }

    // Check participating institution
    const institution = PARTICIPATING_INSTITUTIONS.find((i) => i.id === params.hipId);
    if (!institution) {
      throw new NotFoundError(
        `Participating institution '${params.hipId}' is not registered with mock ABDM network.`
      );
    }

    // Idempotency check: if transactionId provided and already exists, return existing transfer
    const transactionId =
      params.transactionId ||
      `TXN-${params.consentId}-${params.hipId}-${new Date().toISOString().slice(0, 10)}`;

    const existingTransfer = await HealthDataTransfer.findOne({ transactionId });
    if (existingTransfer) {
      return this.formatTransferReport(existingTransfer);
    }

    // Initial pre-check on consent
    const consent = await ConsentArtifact.findOne({
      consentId: params.consentId,
    });

    if (!consent) {
      throw new ConsentRequiredError(`Consent artifact '${params.consentId}' not found.`);
    }

    if (!["APPROVED", "GRANTED"].includes(consent.status)) {
      throw new ConsentRequiredError(
        `Cannot initiate data transfer: consent status is '${consent.status}'.`
      );
    }

    const now = new Date();
    if (consent.expiresAt <= now) {
      throw new ConsentRequiredError("Cannot initiate data transfer: consent has expired.");
    }

    const transferId = `XFER-2026-${Math.floor(100000 + Math.random() * 900000)}`;
    const expiresAt = new Date(now.getTime() + DEMO_TRANSFER_CACHE_HOURS * 3600 * 1000);

    const hiTypes =
      params.requestedHiTypes && params.requestedHiTypes.length > 0
        ? params.requestedHiTypes
        : consent.approvedHiTypes && consent.approvedHiTypes.length > 0
        ? consent.approvedHiTypes
        : consent.hiTypes;

    const fromDate = params.dateRangeFrom ? new Date(params.dateRangeFrom) : consent.dateRangeFrom;
    const toDate = params.dateRangeTo ? new Date(params.dateRangeTo) : consent.dateRangeTo;

    const transfer = await HealthDataTransfer.create({
      transferId,
      transactionId,
      consentId: consent.consentId,
      patientId: new mongoose.Types.ObjectId(params.patientId),
      patientAbhaAddress: params.patientAbhaAddress.toLowerCase(),
      requesterDoctorId: new mongoose.Types.ObjectId(params.requesterDoctorId),
      requesterFacility: params.requesterFacility || principal.facility || "Apollo Clinics",
      hipId: institution.id,
      hipName: institution.name,
      requestedHiTypes: hiTypes,
      dateRangeFrom: fromDate,
      dateRangeTo: toDate,
      status: "REQUESTED",
      retryCount: 0,
      maxRetries: 3,
      lastAttemptAt: now,
      recordCount: 0,
      expiresAt,
      isMockInteraction: true,
    });

    await logAuditEvent({
      action: "ABDM_HEALTH_DATA_TRANSFER_REQUESTED",
      principal,
      targetResourceType: "HealthDataTransfer",
      targetResourceId: transfer.transferId,
      targetPatientId: transfer.patientId,
      outcome: "ALLOWED",
      metadata: {
        hipId: transfer.hipId,
        consentId: transfer.consentId,
        requestedHiTypes: transfer.requestedHiTypes,
        transactionId: transfer.transactionId,
      },
    });

    return this.formatTransferReport(transfer);
  }

  /**
   * Execute the mock data transfer workflow, enforcing consent re-evaluation,
   * HIP isolation, FHIR bundle assembly, and safe caching.
   */
  async executeTransfer(
    transferId: string,
    principal?: AuthenticatedPrincipal
  ): Promise<{
    transfer: HealthDataTransferStatusReport;
    bundle?: FhirBundle;
  }> {
    await connectToDatabase();

    const transfer = await HealthDataTransfer.findOne({ transferId });
    if (!transfer) {
      throw new NotFoundError(`Transfer job '${transferId}' not found.`);
    }

    // 1. Re-evaluate consent state at time of transfer execution
    const consent = await ConsentArtifact.findOne({
      consentId: transfer.consentId,
    });

    const now = new Date();
    const isConsentValid =
      consent &&
      ["APPROVED", "GRANTED"].includes(consent.status) &&
      consent.expiresAt > now;

    if (!isConsentValid) {
      transfer.status = "FAILED";
      transfer.failureReason = !consent
        ? "Consent artifact no longer exists."
        : consent.expiresAt <= now
        ? "Consent expired during queued transfer."
        : `Consent is in revoked/invalid status '${consent.status}'.`;
      transfer.lastAttemptAt = now;
      await transfer.save();

      await logAuditEvent({
        action: "ABDM_HEALTH_DATA_TRANSFER_DENIED",
        principal: principal || {
          id: transfer.requesterDoctorId.toString(),
          role: "doctor",
          name: "Doctor via Transfer Worker",
          facility: transfer.requesterFacility,
        },
        targetResourceType: "HealthDataTransfer",
        targetResourceId: transfer.transferId,
        targetPatientId: transfer.patientId,
        outcome: "DENIED",
        denialReason: transfer.failureReason,
        metadata: {
          consentId: transfer.consentId,
          hipId: transfer.hipId,
        },
      });

      throw new ConsentRequiredError(`Data transfer aborted: ${transfer.failureReason}`);
    }

    // 2. Query source records strictly isolated to the specified originating institution
    const effectiveHiTypes =
      consent.approvedHiTypes && consent.approvedHiTypes.length > 0
        ? consent.approvedHiTypes
        : consent.hiTypes;

    // Filter query: strictly hipId, patient, and consented hiTypes + date range
    const sourceQuery: Record<string, unknown> = {
      institutionId: transfer.hipId,
      patientAbhaAddress: transfer.patientAbhaAddress.toLowerCase(),
      resourceType: { $in: effectiveHiTypes },
      recordDate: {
        $gte: transfer.dateRangeFrom,
        $lte: transfer.dateRangeTo,
      },
    };

    const sourceRecords = await SourceInstitutionRecord.find(sourceQuery).sort({
      recordDate: -1,
    });

    // 3. Assemble FHIR R4 Bundle (searchset)
    const bundleId = `urn:uuid:${crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2)}`;
    const entries: FhirBundleEntry[] = sourceRecords.map((sr) => ({
      fullUrl: `https://mock.abdm.gateway/hip/${transfer.hipId}/${sr.resourceType}/${sr.recordId}`,
      resource: sr.fhirResource as unknown as BaseFhirResource,
      search: {
        mode: "match",
      },
    }));

    const bundle: FhirBundle = {
      resourceType: "Bundle",
      id: bundleId,
      type: "searchset",
      timestamp: now.toISOString(),
      total: entries.length,
      entry: entries,
    };

    // 4. Validate constructed Bundle against FHIR R4 structural rules
    const validation = validateFhirBundle(bundle, {
      expectedPatientId: transfer.patientId.toString(),
    });

    if (!validation.isValid) {
      console.warn(
        `[FHIR Validation Warning] Bundle ${bundleId} has issues:`,
        validation.issues.map((i) => i.message).join("; ")
      );
    }

    // 5. Re-check consent immediately before committing cached records
    const recheckConsent = await ConsentArtifact.findOne({
      consentId: transfer.consentId,
      status: { $in: ["APPROVED", "GRANTED"] },
      expiresAt: { $gt: new Date() },
    });

    if (!recheckConsent) {
      transfer.status = "FAILED";
      transfer.failureReason = "Consent revoked or expired right before data commit.";
      await transfer.save();
      throw new ConsentRequiredError("Consent invalid immediately before commit.");
    }

    // 6. Cache transferred records with explicit retention expiry
    const cacheExpiresAt = new Date(now.getTime() + DEMO_TRANSFER_CACHE_HOURS * 3600 * 1000);

    // Remove any older cache for this transfer to ensure clean state
    await TransferredRecordCache.deleteMany({ transferId: transfer.transferId });

    await TransferredRecordCache.create({
      transferId: transfer.transferId,
      bundleId,
      patientId: transfer.patientId,
      patientAbhaAddress: transfer.patientAbhaAddress,
      doctorId: transfer.requesterDoctorId,
      consentId: transfer.consentId,
      hipId: transfer.hipId,
      hipName: transfer.hipName,
      fhirBundle: bundle,
      resourceCount: entries.length,
      cachedAt: now,
      expiresAt: cacheExpiresAt,
      isMockData: true,
    });

    // 7. Update transfer status to TRANSFERRED
    transfer.status = "TRANSFERRED";
    transfer.bundleId = bundleId;
    transfer.recordCount = entries.length;
    transfer.completedAt = now;
    transfer.lastAttemptAt = now;
    transfer.failureReason = undefined;
    await transfer.save();

    // 8. Log audit event
    await logAuditEvent({
      action: "ABDM_HEALTH_DATA_TRANSFER_COMPLETED",
      principal: principal || {
        id: transfer.requesterDoctorId.toString(),
        role: "doctor",
        name: "Doctor via Transfer Worker",
        facility: transfer.requesterFacility,
      },
      targetResourceType: "HealthDataTransfer",
      targetResourceId: transfer.transferId,
      targetPatientId: transfer.patientId,
      outcome: "ALLOWED",
      metadata: {
        hipId: transfer.hipId,
        consentId: transfer.consentId,
        recordCount: entries.length,
        bundleId,
      },
    });

    return {
      transfer: this.formatTransferReport(transfer),
      bundle,
    };
  }

  /**
   * Get transfer status report
   */
  async getTransferStatus(
    transferId: string,
    principal: AuthenticatedPrincipal
  ): Promise<HealthDataTransferStatusReport> {
    await connectToDatabase();

    const transfer = await HealthDataTransfer.findOne({ transferId });
    if (!transfer) {
      throw new NotFoundError(`Transfer '${transferId}' not found.`);
    }

    // RBAC: caller must be patient owner or requesting doctor
    if (
      principal.role === "patient" &&
      transfer.patientId.toString() !== principal.id
    ) {
      throw new ForbiddenError("Access denied. You may only view your own transfer jobs.");
    }
    if (
      principal.role === "doctor" &&
      transfer.requesterDoctorId.toString() !== principal.id
    ) {
      throw new ForbiddenError(
        "Access denied. You may only view transfer jobs initiated by your account."
      );
    }

    return this.formatTransferReport(transfer);
  }

  private formatTransferReport(
    transfer: IHealthDataTransfer
  ): HealthDataTransferStatusReport {
    return {
      transferId: transfer.transferId,
      transactionId: transfer.transactionId,
      consentId: transfer.consentId,
      status: transfer.status,
      hipId: transfer.hipId,
      hipName: transfer.hipName,
      requestedHiTypes: transfer.requestedHiTypes,
      recordCount: transfer.recordCount,
      bundleId: transfer.bundleId,
      retryCount: transfer.retryCount,
      lastAttemptAt: transfer.lastAttemptAt.toISOString(),
      completedAt: transfer.completedAt ? transfer.completedAt.toISOString() : undefined,
      failureReason: transfer.failureReason,
      expiresAt: transfer.expiresAt.toISOString(),
      isMockInteraction: true,
    };
  }
}

export const mockAbdmAdapter = new MockAbdmAdapter();
