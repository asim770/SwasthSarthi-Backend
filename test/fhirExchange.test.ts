import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { connectToDatabase } from "@/lib/db/connect";
import { User, IUser } from "@/lib/db/models/User";
import { HealthRecord } from "@/lib/db/models/HealthRecord";
import { ConsentArtifact } from "@/lib/db/models/ConsentArtifact";
import { SourceInstitutionRecord } from "@/lib/db/models/SourceInstitutionRecord";
import { HealthDataTransfer } from "@/lib/db/models/HealthDataTransfer";
import { TransferredRecordCache } from "@/lib/db/models/TransferredRecordCache";
import { AuditLog } from "@/lib/db/models/AuditLog";
import { seedDemoIdentities } from "@/lib/db/seed";
import {
  getAuthorizedTimeline,
  getAuthorizedFhirBundle,
  initiateScopedHealthTransfer,
  getDiscoverableCareContexts,
  ForbiddenError,
  ConsentRequiredError,
  NotFoundError,
  InvalidQueryError,
} from "@/lib/dal";
import { AuthenticatedPrincipal } from "@/lib/dal/types";
import { mockAbdmAdapter } from "@/lib/abdm/mockAdapter";
import { validateFhirResource, validateFhirBundle } from "@/lib/fhir/validator";
import { summarizeFhirResource, sanitizeClinicalString } from "@/lib/fhir/summarizer";
import { FhirBundle, BaseFhirResource } from "@/lib/fhir/types";

// Import Route Handlers for API testing
import { GET as getTimelineRoute } from "@/app/api/v1/records/timeline/route";
import { POST as initiateTransferRoute } from "@/app/api/v1/records/transfer/route";
import { GET as getTransferStatusRoute } from "@/app/api/v1/records/transfer/[id]/route";
import { GET as getFhirBundleRoute } from "@/app/api/v1/records/fhir/[id]/route";
import { NextRequest } from "next/server";

describe("SwasthSaarthi — Step 7: FHIR Records, Mock ABDM Exchange & Patient Timeline Suite", () => {
  let patientUser: IUser;
  let otherPatientUser: IUser;
  let doctorUser: IUser;
  let otherDoctorUser: IUser;
  let adminUser: IUser;

  let patientPrincipal: AuthenticatedPrincipal;
  let otherPatientPrincipal: AuthenticatedPrincipal;
  let doctorPrincipal: AuthenticatedPrincipal;
  let otherDoctorPrincipal: AuthenticatedPrincipal;
  let adminPrincipal: AuthenticatedPrincipal;

  before(async () => {
    await connectToDatabase();
    await seedDemoIdentities();

    // Ensure secondary patient exists for IDOR tests
    let secondPatient = await User.findOne({ abhaAddress: "priya.verma@sbx" });
    if (!secondPatient) {
      secondPatient = await User.create({
        abhaId: "44-1234-5678-9900",
        abhaAddress: "priya.verma@sbx",
        name: "Priya Verma",
        role: "patient",
        isActive: true,
        phone: "+91-9876543220",
        email: "priya.verma@synthetic.demo",
        gender: "Female",
        dateOfBirth: "1994-08-20",
      });
    }

    // Clean up secondPatient consents to ensure fresh state
    await ConsentArtifact.deleteMany({ patientId: secondPatient._id });

    // Ensure secondary doctor exists
    let secondDoctor = await User.findOne({ abhaAddress: "dr.vikram@hpr.sbx" });
    if (!secondDoctor) {
      secondDoctor = await User.create({
        abhaId: "HPR-BLR-2026-8811",
        abhaAddress: "dr.vikram@hpr.sbx",
        name: "Dr. Vikram Malhotra",
        role: "doctor",
        isActive: true,
        phone: "+91-9876543230",
        email: "dr.vikram@synthetic.demo",
        facility: "Fortis Hospital, Cunningham Road",
        specialization: "Neurology",
      });
    }

    patientUser = (await User.findOne({ abhaAddress: "rahul.verma@sbx" }))!;
    otherPatientUser = secondPatient;
    doctorUser = (await User.findOne({ abhaAddress: "dr.ananya@hpr.sbx" }))!;
    otherDoctorUser = secondDoctor;
    adminUser = (await User.findOne({ abhaAddress: "admin.neha@swasth.sbx" }))!;

    patientPrincipal = {
      id: patientUser._id.toString(),
      abhaId: patientUser.abhaId,
      abhaAddress: patientUser.abhaAddress,
      name: patientUser.name,
      role: "patient",
      isActive: true,
      sessionId: `sess-pt-7-${Date.now()}`,
    };

    otherPatientPrincipal = {
      id: otherPatientUser._id.toString(),
      abhaId: otherPatientUser.abhaId,
      abhaAddress: otherPatientUser.abhaAddress,
      name: otherPatientUser.name,
      role: "patient",
      isActive: true,
      sessionId: `sess-opt-7-${Date.now()}`,
    };

    doctorPrincipal = {
      id: doctorUser._id.toString(),
      abhaId: doctorUser.abhaId,
      abhaAddress: doctorUser.abhaAddress,
      name: doctorUser.name,
      role: "doctor",
      facility: doctorUser.facility,
      isActive: true,
      sessionId: `sess-doc-7-${Date.now()}`,
    };

    otherDoctorPrincipal = {
      id: otherDoctorUser._id.toString(),
      abhaId: otherDoctorUser.abhaId,
      abhaAddress: otherDoctorUser.abhaAddress,
      name: otherDoctorUser.name,
      role: "doctor",
      facility: otherDoctorUser.facility,
      isActive: true,
      sessionId: `sess-odoc-7-${Date.now()}`,
    };

    adminPrincipal = {
      id: adminUser._id.toString(),
      abhaId: adminUser.abhaId,
      abhaAddress: adminUser.abhaAddress,
      name: adminUser.name,
      role: "admin",
      isActive: true,
      sessionId: `sess-adm-7-${Date.now()}`,
    };
  });

  // 1. Valid synthetic FHIR R4 resource acceptance
  it("1. Valid synthetic FHIR R4 resource acceptance", () => {
    const validDiagnosticReport = {
      resourceType: "DiagnosticReport",
      id: "DR-TEST-001",
      status: "final",
      code: {
        coding: [{ system: "http://loinc.org", code: "24331-1", display: "Lipid Panel" }],
        text: "Lipid Panel",
      },
      subject: { reference: `Patient/${patientUser._id.toString()}` },
      effectiveDateTime: "2026-10-18T10:00:00Z",
    };

    const result = validateFhirResource(validDiagnosticReport, {
      expectedPatientId: patientUser._id.toString(),
      expectedResourceType: "DiagnosticReport",
    });

    assert.equal(result.isValid, true);
    assert.equal(result.resourceType, "DiagnosticReport");
    assert.equal(result.resourceId, "DR-TEST-001");
    assert.equal(result.issues.filter((i) => i.severity === "error").length, 0);
  });

  // 2. Invalid resource types and malformed Bundles
  it("2. Invalid resource types and malformed Bundles", () => {
    // Unsupported resource type
    const unsupported = {
      resourceType: "UnknownCustomEntity",
      id: "ENT-001",
    };
    const res1 = validateFhirResource(unsupported);
    assert.equal(res1.isValid, false);
    assert.ok(res1.issues.some((i) => i.code === "UNSUPPORTED_RESOURCE_TYPE"));

    // Missing id
    const missingId = {
      resourceType: "Observation",
      status: "final",
      code: { text: "Blood pressure" },
    };
    const res2 = validateFhirResource(missingId);
    assert.equal(res2.isValid, false);
    assert.ok(res2.issues.some((i) => i.code === "MISSING_RESOURCE_ID"));

    // Malformed Bundle with invalid entry
    const malformedBundle = {
      resourceType: "Bundle" as const,
      id: "bundle-err-1",
      type: "searchset" as const,
      entry: [
        {
          fullUrl: "urn:uuid:invalid",
          resource: null as unknown as BaseFhirResource,
        },
      ],
    };
    const res3 = validateFhirBundle(malformedBundle);
    assert.equal(res3.isValid, false);
    assert.ok(res3.issues.some((i) => i.code === "MALFORMED_BUNDLE_ENTRY"));
  });

  // 3. Broken or mismatched patient references
  it("3. Broken or mismatched patient references", () => {
    const mismatchedResource = {
      resourceType: "Observation",
      id: "OBS-MISMATCH-001",
      status: "final",
      code: { text: "Pulse Rate" },
      subject: { reference: "Patient/someone-else-id" },
      effectiveDateTime: "2026-10-18T10:00:00Z",
    };

    const res = validateFhirResource(mismatchedResource, {
      expectedPatientId: patientUser._id.toString(),
    });

    assert.equal(res.isValid, false);
    assert.ok(res.issues.some((i) => i.code === "PATIENT_REFERENCE_MISMATCH"));
  });

  // 4. Unauthorized patient access (cross-patient access blocked)
  it("4. Unauthorized patient access (cross-patient access blocked)", async () => {
    // Patient 2 attempts to query Patient 1's timeline
    await assert.rejects(
      async () => {
        await getAuthorizedTimeline(otherPatientPrincipal, patientUser._id.toString());
      },
      (err: Error) => {
        assert.ok(err instanceof ForbiddenError);
        assert.match(err.message, /Access denied/i);
        return true;
      }
    );
  });

  // 5. Doctor access without consent
  it("5. Doctor access without consent", async () => {
    // Dr. Vikram has ZERO consent on Rahul Verma
    await assert.rejects(
      async () => {
        await getAuthorizedTimeline(otherDoctorPrincipal, patientUser._id.toString());
      },
      (err: Error) => {
        assert.ok(err instanceof ConsentRequiredError);
        assert.match(err.message, /Active electronic consent/i);
        return true;
      }
    );
  });

  // 6. Consent limited to selected resource categories
  it("6. Consent limited to selected resource categories", async () => {
    // Seed active consent for Dr. Vikram covering ONLY Observation
    const obsOnlyConsent = await ConsentArtifact.create({
      consentId: `CONSENT-OBS-ONLY-${Date.now()}`,
      patientId: patientUser._id,
      requesterDoctorId: otherDoctorUser._id,
      requesterFacility: otherDoctorUser.facility,
      purpose: "Vital Signs Review Only",
      hiTypes: ["Observation"],
      approvedHiTypes: ["Observation"],
      dateRangeFrom: new Date("2026-01-01"),
      dateRangeTo: new Date("2026-12-31"),
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      status: "GRANTED",
      grantedAt: new Date(),
    });

    const items = await getAuthorizedTimeline(otherDoctorPrincipal, patientUser._id.toString());
    assert.ok(items.length > 0);
    // Every record returned MUST have resourceType Observation
    items.forEach((item) => {
      assert.equal(item.resourceType, "Observation");
    });

    // Cleanup
    await ConsentArtifact.deleteOne({ _id: obsOnlyConsent._id });
  });

  // 7. Consent date-range enforcement
  it("7. Consent date-range enforcement", async () => {
    // Seed consent restricted strictly to September 2026
    const septConsent = await ConsentArtifact.create({
      consentId: `CONSENT-SEPT-2026-${Date.now()}`,
      patientId: patientUser._id,
      requesterDoctorId: otherDoctorUser._id,
      requesterFacility: otherDoctorUser.facility,
      purpose: "September Review Only",
      hiTypes: ["DiagnosticReport", "Encounter", "Immunization", "Observation"],
      approvedHiTypes: ["DiagnosticReport", "Encounter", "Immunization", "Observation"],
      dateRangeFrom: new Date("2026-09-01"),
      dateRangeTo: new Date("2026-09-30"),
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      status: "GRANTED",
      grantedAt: new Date(),
    });

    const items = await getAuthorizedTimeline(otherDoctorPrincipal, patientUser._id.toString());
    assert.ok(items.length > 0);
    // Every item date must fall within September 2026
    items.forEach((item) => {
      assert.ok(item.date >= "2026-09-01" && item.date <= "2026-09-30");
    });

    // Cleanup
    await ConsentArtifact.deleteOne({ _id: septConsent._id });
  });

  // 8. Expired and revoked consent during queued transfer
  it("8. Expired and revoked consent during queued transfer", async () => {
    // Create a consent artifact that is already expired
    const expiredConsent = await ConsentArtifact.create({
      consentId: `CONSENT-XFER-EXP-${Date.now()}`,
      patientId: patientUser._id,
      requesterDoctorId: doctorUser._id,
      requesterFacility: doctorUser.facility,
      purpose: "Expired Transfer Test",
      hiTypes: ["DiagnosticReport"],
      dateRangeFrom: new Date("2026-01-01"),
      dateRangeTo: new Date("2026-12-31"),
      expiresAt: new Date(Date.now() - 5000), // in past
      status: "GRANTED",
    });

    // Create a transfer job record
    const transfer = await HealthDataTransfer.create({
      transferId: `XFER-EXP-${Date.now()}`,
      transactionId: `TXN-EXP-${Date.now()}`,
      consentId: expiredConsent.consentId,
      patientId: patientUser._id,
      patientAbhaAddress: patientUser.abhaAddress,
      requesterDoctorId: doctorUser._id,
      requesterFacility: doctorUser.facility,
      hipId: "HIP-MAX-001",
      hipName: "Max Super Speciality Hospital, Saket",
      requestedHiTypes: ["DiagnosticReport"],
      dateRangeFrom: new Date("2026-01-01"),
      dateRangeTo: new Date("2026-12-31"),
      status: "REQUESTED",
      retryCount: 0,
      maxRetries: 3,
      lastAttemptAt: new Date(),
      expiresAt: new Date(Date.now() + 86400000),
      isMockInteraction: true,
    });

    // Executing the transfer must fail closed and mark status as FAILED
    await assert.rejects(
      async () => {
        await mockAbdmAdapter.executeTransfer(transfer.transferId, doctorPrincipal);
      },
      (err: Error) => {
        assert.ok(err instanceof ConsentRequiredError);
        return true;
      }
    );

    const updated = await HealthDataTransfer.findOne({ transferId: transfer.transferId });
    assert.equal(updated?.status, "FAILED");
    assert.ok(updated?.failureReason?.includes("expired"));

    // Cleanup
    await ConsentArtifact.deleteOne({ _id: expiredConsent._id });
    await HealthDataTransfer.deleteOne({ _id: transfer._id });
  });

  // 9. Duplicate transfer requests and worker retries
  it("9. Duplicate transfer requests and worker retries", async () => {
    const txnKey = `TXN-IDEMPOTENT-${Date.now()}`;

    // Initiate first transfer
    const firstReport = await initiateScopedHealthTransfer(doctorPrincipal, {
      consentId: "CONSENT-ACTIVE-CARDIOLOGY-01",
      patientId: patientUser._id.toString(),
      hipId: "HIP-MAX-001",
      transactionId: txnKey,
    });

    assert.ok(firstReport.transferId);
    assert.equal(firstReport.transactionId, txnKey);

    // Duplicate request with identical transactionId must return the existing transfer
    const secondReport = await initiateScopedHealthTransfer(doctorPrincipal, {
      consentId: "CONSENT-ACTIVE-CARDIOLOGY-01",
      patientId: patientUser._id.toString(),
      hipId: "HIP-MAX-001",
      transactionId: txnKey,
    });

    assert.equal(secondReport.transferId, firstReport.transferId);
    assert.equal(secondReport.transactionId, firstReport.transactionId);

    // Verify status tracking
    const statusReport = await mockAbdmAdapter.getTransferStatus(firstReport.transferId, doctorPrincipal);
    assert.equal(statusReport.transferId, firstReport.transferId);
  });

  // 10. Unauthorized retrieval of cached resources
  it("10. Unauthorized retrieval of cached resources", async () => {
    const testBundleId = `urn:uuid:test-cache-${Date.now()}`;

    // Create a mock cached transferred record belonging to patientUser & doctorUser
    await TransferredRecordCache.create({
      transferId: `XFER-CACHE-TEST-${Date.now()}`,
      bundleId: testBundleId,
      patientId: patientUser._id,
      patientAbhaAddress: patientUser.abhaAddress,
      doctorId: doctorUser._id,
      consentId: "CONSENT-ACTIVE-CARDIOLOGY-01",
      hipId: "HIP-MAX-001",
      hipName: "Max Super Speciality Hospital",
      fhirBundle: {
        resourceType: "Bundle",
        id: testBundleId,
        type: "searchset",
        entry: [],
      },
      resourceCount: 0,
      cachedAt: new Date(),
      expiresAt: new Date(Date.now() + 86400000),
      isMockData: true,
    });

    // Patient 2 attempts to retrieve Patient 1's cached bundle
    await assert.rejects(
      async () => {
        await getAuthorizedFhirBundle(otherPatientPrincipal, testBundleId);
      },
      (err: Error) => {
        assert.ok(err instanceof ForbiddenError);
        assert.match(err.message, /Access denied/i);
        return true;
      }
    );

    // Cleanup
    await TransferredRecordCache.deleteOne({ bundleId: testBundleId });
  });

  // 11. Source institution isolation
  it("11. Source institution isolation", async () => {
    // When requesting transfer from HIP-MAX-001, records originating from HIP-APOLLO-002 must NOT be included!
    const transferReport = await initiateScopedHealthTransfer(doctorPrincipal, {
      consentId: "CONSENT-ACTIVE-CARDIOLOGY-01",
      patientId: patientUser._id.toString(),
      hipId: "HIP-MAX-001",
      transactionId: `TXN-ISOLATION-${Date.now()}`,
    });

    assert.equal(transferReport.hipId, "HIP-MAX-001");

    // Fetch the resulting cached bundle
    assert.ok(transferReport.bundleId);
    const bundle = await getAuthorizedFhirBundle(doctorPrincipal, transferReport.bundleId);
    assert.equal(bundle.resourceType, "Bundle");

    // Every entry in this bundle must originate from Max Hospital
    if (bundle.entry && bundle.entry.length > 0) {
      bundle.entry.forEach((entry) => {
        assert.ok(entry.fullUrl?.includes("HIP-MAX-001"));
      });
    }
  });

  // 12. Unsupported resource handling
  it("12. Unsupported resource handling", () => {
    const rawUnknown = {
      resourceType: "BiologicallyDerivedProduct",
      id: "BDP-001",
      status: "available",
    };

    const res = validateFhirResource(rawUnknown);
    assert.equal(res.isValid, false);
    assert.ok(res.issues.some((i) => i.code === "UNSUPPORTED_RESOURCE_TYPE"));
  });

  // 13. Safe rendering of untrusted clinical text (XSS protection)
  it("13. Safe rendering of untrusted clinical text", () => {
    const maliciousPayload = "<script>alert('XSS')</script><img src=x onerror=alert(1)>";
    const sanitized = sanitizeClinicalString(maliciousPayload);

    assert.equal(sanitized.includes("<script>"), false);
    assert.equal(sanitized.includes("<img"), false);
    assert.ok(sanitized.includes("&lt;script&gt;"));
    assert.ok(sanitized.includes("&lt;img"));

    // Also verify summarizer cleans observation values and text
    const maliciousObservation = {
      resourceType: "Observation",
      id: "OBS-XSS",
      status: "final",
      code: { text: "<b onmouseover=evil()>Dangerous Heading</b>" },
      valueString: "<iframe src='javascript:alert(1)'></iframe>",
      effectiveDateTime: "2026-10-18T10:00:00Z",
    };

    const summary = summarizeFhirResource(maliciousObservation);
    assert.equal(summary.title.includes("<b"), false);
    assert.ok(summary.title.includes("&lt;b"));
    assert.equal(summary.summary.includes("<iframe"), false);
    assert.ok(summary.summary.includes("&lt;iframe"));
  });

  // 14. Patient timeline filtering and empty states
  it("14. Patient timeline filtering and empty states", async () => {
    // 1. Patient requests timeline filtered by DiagnosticReport
    const labItems = await getAuthorizedTimeline(patientPrincipal, patientUser._id.toString(), {
      resourceType: "DiagnosticReport",
    });
    assert.ok(labItems.length > 0);
    labItems.forEach((item) => assert.equal(item.resourceType, "DiagnosticReport"));

    // 2. Filter with non-matching resourceType returns empty list cleanly without errors
    const emptyItems = await getAuthorizedTimeline(patientPrincipal, patientUser._id.toString(), {
      resourceType: "DocumentReference",
      fromDate: "2029-01-01", // Future date
    });
    assert.ok(Array.isArray(emptyItems));
    assert.equal(emptyItems.length, 0);

    // 3. Search filter
    const searchItems = await getAuthorizedTimeline(patientPrincipal, patientUser._id.toString(), {
      search: "Lipid",
    });
    assert.ok(searchItems.length > 0);
    assert.ok(searchItems.some((i) => i.title.toLowerCase().includes("lipid") || i.summary.toLowerCase().includes("lipid")));
  });

  // 15. Audit events for successful and denied transfer attempts
  it("15. Audit events for successful and denied transfer attempts", async () => {
    // Verify AuditLog table recorded transfer events
    const auditEvents = await AuditLog.find({
      action: { $in: ["ABDM_HEALTH_DATA_TRANSFER_REQUESTED", "ABDM_HEALTH_DATA_TRANSFER_COMPLETED", "ABDM_HEALTH_DATA_TRANSFER_DENIED"] },
    });

    assert.ok(auditEvents.length > 0);

    // Ensure audit metadata never logs raw clinical data or personal OTPs
    for (const event of auditEvents) {
      assert.strictEqual(event.metadata?.fhirBundle, undefined);
      assert.strictEqual(event.metadata?.clinicalData, undefined);
      assert.strictEqual(event.metadata?.otp, undefined);
    }
  });
});
