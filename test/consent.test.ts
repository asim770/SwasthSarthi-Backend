import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { connectToDatabase } from "@/lib/db/connect";
import { User, IUser } from "@/lib/db/models/User";
import { HealthRecord } from "@/lib/db/models/HealthRecord";
import { ConsentArtifact } from "@/lib/db/models/ConsentArtifact";
import { AuditLog } from "@/lib/db/models/AuditLog";
import { seedDemoIdentities } from "@/lib/db/seed";
import { createSession } from "@/lib/auth/session";
import {
  createConsentRequest,
  approveConsent,
  denyConsent,
  revokeConsent,
  getConsentsForPrincipal,
  getConsentById,
  getConsentHistory,
  evaluateConsent,
  getHealthRecordsForPatient,
  sweepExpiredConsents,
  ForbiddenError,
  ConsentRequiredError,
  InvalidStateTransitionError,
} from "@/lib/dal";
import { AuthenticatedPrincipal } from "@/lib/dal/types";
import { verifyConsentForQueuedTransfer } from "@/lib/queue/consentWorker";

// Import Route Handlers for API integration tests
import { POST as approveRoute } from "@/app/api/v1/consents/[id]/approve/route";
import { GET as getConsentRoute } from "@/app/api/v1/consents/[id]/route";
import { NextRequest } from "next/server";

describe("SwasthSaarthi — Step 6: Consent Management System Suite", () => {
  let patientUser: IUser;
  let otherPatientUser: IUser;
  let doctorUser: IUser;
  let otherDoctorUser: IUser;
  let adminUser: IUser;

  let patientPrincipal: AuthenticatedPrincipal;
  let otherPatientPrincipal: AuthenticatedPrincipal;
  let doctorPrincipal: AuthenticatedPrincipal;
  let adminPrincipal: AuthenticatedPrincipal;

  let patientSessionCookie: string;
  let otherPatientSessionCookie: string;

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
      sessionId: `sess-pt-6-${Date.now()}`,
    };

    otherPatientPrincipal = {
      id: otherPatientUser._id.toString(),
      abhaId: otherPatientUser.abhaId,
      abhaAddress: otherPatientUser.abhaAddress,
      name: otherPatientUser.name,
      role: "patient",
      isActive: true,
      sessionId: `sess-opt-6-${Date.now()}`,
    };

    doctorPrincipal = {
      id: doctorUser._id.toString(),
      abhaId: doctorUser.abhaId,
      abhaAddress: doctorUser.abhaAddress,
      name: doctorUser.name,
      role: "doctor",
      facility: doctorUser.facility,
      isActive: true,
      sessionId: `sess-doc-6-${Date.now()}`,
    };

    adminPrincipal = {
      id: adminUser._id.toString(),
      abhaId: adminUser.abhaId,
      abhaAddress: adminUser.abhaAddress,
      name: adminUser.name,
      role: "admin",
      isActive: true,
      sessionId: `sess-adm-6-${Date.now()}`,
    };

    // Create server sessions
    const pSession = await createSession(patientUser);
    patientSessionCookie = `ss_session_id=${pSession.sessionId}`;

    const opSession = await createSession(otherPatientUser);
    otherPatientSessionCookie = `ss_session_id=${opSession.sessionId}`;
  });

  // 1. Authorized doctor creates a pending request
  it("1. Authorized doctor creates a pending request", async () => {
    const consent = await createConsentRequest(doctorPrincipal, {
      patientId: patientUser._id.toString(),
      purpose: "Comprehensive Cardiology Evaluation",
      hiTypes: ["DiagnosticReport", "Observation", "Encounter"],
      dateRangeFrom: new Date("2026-06-01"),
      dateRangeTo: new Date("2026-12-31"),
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    });

    assert.ok(consent.consentId.startsWith("CONSENT-"));
    assert.equal(consent.status, "PENDING");
    assert.equal(consent.version, 1);
    assert.equal(consent.hiTypes.length, 3);
    assert.equal(consent.decisionHistory.length, 1);
    assert.equal(consent.decisionHistory[0].action, "REQUESTED");
    assert.equal(consent.decisionHistory[0].actorRole, "doctor");
  });

  // 2. Unauthorized doctor cannot request access to an unrelated patient
  it("2. Unauthorized doctor cannot request access to an invalid or inactive patient", async () => {
    const inactiveUser = (await User.findOne({ abhaAddress: "inactive.user@sbx" }))!;

    await assert.rejects(
      async () => {
        await createConsentRequest(doctorPrincipal, {
          patientId: inactiveUser._id.toString(),
          purpose: "Consultation attempt",
          hiTypes: ["DiagnosticReport"],
          dateRangeFrom: new Date("2026-01-01"),
          dateRangeTo: new Date("2026-12-31"),
          expiresAt: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000),
        });
      },
      (err: Error) => {
        return err.message.includes("inactive") || err.message.includes("not exist");
      }
    );

    // Non-doctor cannot request consent
    await assert.rejects(
      async () => {
        await createConsentRequest(patientPrincipal, {
          patientId: otherPatientUser._id.toString(),
          purpose: "Invalid attempt",
          hiTypes: ["DiagnosticReport"],
          dateRangeFrom: new Date("2026-01-01"),
          dateRangeTo: new Date("2026-12-31"),
          expiresAt: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000),
        });
      },
      (err: Error) => {
        return err instanceof ForbiddenError;
      }
    );
  });

  // 3. Patient can list their own requests
  it("3. Patient can list their own requests", async () => {
    const list = await getConsentsForPrincipal(patientPrincipal);
    assert.ok(Array.isArray(list));
    assert.ok(list.length > 0);
    // Every listed consent must belong to patient
    list.forEach((c) => {
      const p = c.patientId as unknown;
      const pid = p && typeof p === "object" && "_id" in p
        ? String((p as { _id: unknown })._id)
        : String(p);
      assert.equal(pid, patientUser._id.toString());
    });
  });

  // 4. Patient cannot view or decide another patient's request (IDOR prevention)
  it("4. Patient cannot view or decide another patient's request", async () => {
    // Create consent for Patient 1
    const consent = await createConsentRequest(doctorPrincipal, {
      patientId: patientUser._id.toString(),
      purpose: "Private Clinical Audit",
      hiTypes: ["DiagnosticReport"],
      dateRangeFrom: new Date("2026-01-01"),
      dateRangeTo: new Date("2026-12-31"),
      expiresAt: new Date(Date.now() + 15 * 24 * 60 * 60 * 1000),
    });

    // Patient 2 attempts to read Patient 1's consent
    await assert.rejects(
      async () => {
        await getConsentById(otherPatientPrincipal, consent.consentId);
      },
      (err: Error) => err instanceof ForbiddenError
    );

    // Patient 2 attempts to approve Patient 1's consent
    await assert.rejects(
      async () => {
        await approveConsent(otherPatientPrincipal, consent.consentId);
      },
      (err: Error) => err instanceof ForbiddenError
    );

    // Patient 2 attempts to deny Patient 1's consent
    await assert.rejects(
      async () => {
        await denyConsent(otherPatientPrincipal, consent.consentId);
      },
      (err: Error) => err instanceof ForbiddenError
    );
  });

  // 5. Pending consent does not permit record access
  it("5. Pending consent does not permit record access", async () => {
    const consent = await createConsentRequest(doctorPrincipal, {
      patientId: patientUser._id.toString(),
      purpose: "Pre-Approval Check",
      hiTypes: ["DiagnosticReport"],
      dateRangeFrom: new Date("2026-01-01"),
      dateRangeTo: new Date("2026-12-31"),
      expiresAt: new Date(Date.now() + 20 * 24 * 60 * 60 * 1000),
    });

    assert.equal(consent.status, "PENDING");

    // Evaluation for a specific doctor without other active consent
    const evaluation = await evaluateConsent(
      patientUser._id.toString(),
      otherDoctorUser._id.toString(),
      "DiagnosticReport",
      new Date("2026-10-18")
    );
    assert.equal(evaluation.hasConsent, false);
  });

  // 6. Approval activates only the approved scope
  it("6. Approval activates only the approved scope", async () => {
    const consent = await createConsentRequest(doctorPrincipal, {
      patientId: patientUser._id.toString(),
      purpose: "Multi-Category Request",
      hiTypes: ["DiagnosticReport", "Observation"],
      dateRangeFrom: new Date("2026-01-01"),
      dateRangeTo: new Date("2026-12-31"),
      expiresAt: new Date(Date.now() + 25 * 24 * 60 * 60 * 1000),
    });

    // Patient approves ONLY DiagnosticReport (omitting Observation)
    const approved = await approveConsent(patientPrincipal, consent.consentId, {
      approvedHiTypes: ["DiagnosticReport"],
      note: "Only diagnostic lab reports are approved for this review.",
    });

    assert.equal(approved.status, "APPROVED");
    assert.deepEqual(approved.approvedHiTypes, ["DiagnosticReport"]);
    assert.equal(approved.version, 2);

    // Doctor can access DiagnosticReport
    const evalAllowed = await evaluateConsent(
      patientUser._id.toString(),
      doctorUser._id.toString(),
      "DiagnosticReport",
      new Date("2026-10-18")
    );
    assert.equal(evalAllowed.hasConsent, true);

    // Doctor CANNOT access Observation under this specific scope
    const evalDenied = await evaluateConsent(
      patientUser._id.toString(),
      doctorUser._id.toString(),
      "MedicationRequest",
      new Date("2026-10-18")
    );
    assert.equal(evalDenied.hasConsent, false);
  });

  // 7. Denied consent never permits record access
  it("7. Denied consent never permits record access", async () => {
    const consent = await createConsentRequest(doctorPrincipal, {
      patientId: otherPatientUser._id.toString(),
      purpose: "Consultation Request",
      hiTypes: ["DiagnosticReport"],
      dateRangeFrom: new Date("2026-01-01"),
      dateRangeTo: new Date("2026-12-31"),
      expiresAt: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000),
    });

    // Patient denies request
    const denied = await denyConsent(otherPatientPrincipal, consent.consentId, "Patient declined consultation.");
    assert.equal(denied.status, "DENIED");

    const evaluation = await evaluateConsent(
      otherPatientUser._id.toString(),
      doctorUser._id.toString(),
      "DiagnosticReport"
    );
    assert.equal(evaluation.hasConsent, false);
  });

  // 8. Revocation blocks subsequent access immediately
  it("8. Revocation blocks subsequent access immediately", async () => {
    const consent = await createConsentRequest(doctorPrincipal, {
      patientId: otherPatientUser._id.toString(),
      purpose: "Temporary Access for Revocation Test",
      hiTypes: ["Encounter"],
      dateRangeFrom: new Date("2026-01-01"),
      dateRangeTo: new Date("2026-12-31"),
      expiresAt: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000),
    });

    // Approve
    await approveConsent(otherPatientPrincipal, consent.consentId);

    // Verify accessible
    const evalBefore = await evaluateConsent(
      otherPatientUser._id.toString(),
      doctorUser._id.toString(),
      "Encounter"
    );
    assert.equal(evalBefore.hasConsent, true);

    // Revoke
    const revoked = await revokeConsent(otherPatientPrincipal, consent.consentId, "Treatment completed.");
    assert.equal(revoked.status, "REVOKED");

    // Verify immediately blocked
    const evalAfter = await evaluateConsent(
      otherPatientUser._id.toString(),
      doctorUser._id.toString(),
      "Encounter"
    );
    assert.equal(evalAfter.hasConsent, false);
  });

  // 9. Expired consent blocks access even before a background job runs
  it("9. Expired consent blocks access even before a background job runs", async () => {
    // Manually insert an approved consent that has an expiry in the past
    const expiredConsentId = `CONSENT-TEST-EXPIRED-${Date.now()}`;
    await ConsentArtifact.create({
      consentId: expiredConsentId,
      patientId: otherPatientUser._id,
      requesterDoctorId: otherDoctorUser._id,
      requesterFacility: otherDoctorUser.facility,
      purpose: "Past Evaluation",
      hiTypes: ["DiagnosticReport"],
      approvedHiTypes: ["DiagnosticReport"],
      dateRangeFrom: new Date("2025-01-01"),
      dateRangeTo: new Date("2025-12-31"),
      expiresAt: new Date(Date.now() - 5000), // 5 seconds in past
      status: "APPROVED",
      version: 1,
    });

    // Synchronous DAL evaluation must reject without waiting for any worker
    const evaluation = await evaluateConsent(
      otherPatientUser._id.toString(),
      otherDoctorUser._id.toString(),
      "DiagnosticReport"
    );
    assert.equal(evaluation.hasConsent, false);
  });

  // 10. Out-of-range dates are denied
  it("10. Out-of-range dates are denied", async () => {
    const consent = await createConsentRequest(doctorPrincipal, {
      patientId: otherPatientUser._id.toString(),
      purpose: "Date Bound Test",
      hiTypes: ["Observation"],
      dateRangeFrom: new Date("2026-06-01"),
      dateRangeTo: new Date("2026-08-31"),
      expiresAt: new Date(Date.now() + 15 * 24 * 60 * 60 * 1000),
    });

    await approveConsent(otherPatientPrincipal, consent.consentId);

    // Record from May 2026 (before dateRangeFrom)
    const evalEarly = await evaluateConsent(
      otherPatientUser._id.toString(),
      doctorUser._id.toString(),
      "Observation",
      new Date("2026-05-15")
    );
    assert.equal(evalEarly.hasConsent, false);

    // Record from Sept 2026 (after dateRangeTo)
    const evalLate = await evaluateConsent(
      otherPatientUser._id.toString(),
      doctorUser._id.toString(),
      "Observation",
      new Date("2026-09-10")
    );
    assert.equal(evalLate.hasConsent, false);

    // Record from July 2026 (within range)
    const evalValid = await evaluateConsent(
      otherPatientUser._id.toString(),
      doctorUser._id.toString(),
      "Observation",
      new Date("2026-07-15")
    );
    assert.equal(evalValid.hasConsent, true);
  });

  // 11. Unapproved resource categories are denied
  it("11. Unapproved resource categories are denied", async () => {
    const consent = await createConsentRequest(doctorPrincipal, {
      patientId: otherPatientUser._id.toString(),
      purpose: "Category Scope Test",
      hiTypes: ["Immunization"],
      dateRangeFrom: new Date("2026-01-01"),
      dateRangeTo: new Date("2026-12-31"),
      expiresAt: new Date(Date.now() + 15 * 24 * 60 * 60 * 1000),
    });

    await approveConsent(otherPatientPrincipal, consent.consentId);

    const evalDenied = await evaluateConsent(
      otherPatientUser._id.toString(),
      doctorUser._id.toString(),
      "DiagnosticReport"
    );
    assert.equal(evalDenied.hasConsent, false);
  });

  // 12. A doctor cannot expand scope after approval
  it("12. A doctor cannot expand scope after approval", async () => {
    const consent = await createConsentRequest(doctorPrincipal, {
      patientId: patientUser._id.toString(),
      purpose: "Scope Expansion Prevention",
      hiTypes: ["DiagnosticReport"],
      dateRangeFrom: new Date("2026-01-01"),
      dateRangeTo: new Date("2026-12-31"),
      expiresAt: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000),
    });

    // Doctor attempting to approve or expand scope is forbidden
    await assert.rejects(
      async () => {
        await approveConsent(doctorPrincipal, consent.consentId, {
          approvedHiTypes: ["DiagnosticReport", "Observation"],
        });
      },
      (err: Error) => err instanceof ForbiddenError
    );

    // Even if patient tries to approve unrequested categories, it is rejected
    await assert.rejects(
      async () => {
        await approveConsent(patientPrincipal, consent.consentId, {
          approvedHiTypes: ["DiagnosticReport", "Immunization"], // Immunization was not requested!
        });
      },
      (err: Error) => err instanceof ForbiddenError
    );
  });

  // 13. Duplicate or concurrent decisions cannot produce invalid states
  it("13. Duplicate or concurrent decisions cannot produce invalid states", async () => {
    const consent = await createConsentRequest(doctorPrincipal, {
      patientId: patientUser._id.toString(),
      purpose: "Concurrency State Transition Test",
      hiTypes: ["DiagnosticReport"],
      dateRangeFrom: new Date("2026-01-01"),
      dateRangeTo: new Date("2026-12-31"),
      expiresAt: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000),
    });

    // First approval succeeds
    await approveConsent(patientPrincipal, consent.consentId);

    // Second approval attempt on already approved consent must throw InvalidStateTransitionError
    await assert.rejects(
      async () => {
        await approveConsent(patientPrincipal, consent.consentId);
      },
      (err: Error) => err instanceof InvalidStateTransitionError
    );

    // Denying an already approved consent must throw InvalidStateTransitionError
    await assert.rejects(
      async () => {
        await denyConsent(patientPrincipal, consent.consentId);
      },
      (err: Error) => err instanceof InvalidStateTransitionError
    );
  });

  // 14. Administrators cannot approve consent or access clinical records
  it("14. Administrators cannot approve consent or access clinical records", async () => {
    const consent = await createConsentRequest(doctorPrincipal, {
      patientId: patientUser._id.toString(),
      purpose: "Admin Denial Test",
      hiTypes: ["DiagnosticReport"],
      dateRangeFrom: new Date("2026-01-01"),
      dateRangeTo: new Date("2026-12-31"),
      expiresAt: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000),
    });

    // Administrator attempting to approve consent
    await assert.rejects(
      async () => {
        await approveConsent(adminPrincipal, consent.consentId);
      },
      (err: Error) => err instanceof ForbiddenError
    );

    // Administrator attempting to read health records
    await assert.rejects(
      async () => {
        await getHealthRecordsForPatient(adminPrincipal, patientUser._id.toString());
      },
      (err: Error) => err instanceof ForbiddenError && err.message.includes("Administrative users are strictly forbidden")
    );
  });

  // 15. Queue workers reject revoked or expired consent
  it("15. Queue workers reject revoked or expired consent during data transfer", async () => {
    const consent = await createConsentRequest(doctorPrincipal, {
      patientId: otherPatientUser._id.toString(),
      purpose: "Queue Worker Verification",
      hiTypes: ["DiagnosticReport"],
      dateRangeFrom: new Date("2026-01-01"),
      dateRangeTo: new Date("2026-12-31"),
      expiresAt: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000),
    });

    await approveConsent(otherPatientPrincipal, consent.consentId);

    // 1. Initial check in worker: ALLOWED
    const initialWorkerCheck = await verifyConsentForQueuedTransfer({
      transferId: "TRANS-001",
      consentId: consent.consentId,
      patientId: otherPatientUser._id.toString(),
      doctorId: doctorUser._id.toString(),
      resourceType: "DiagnosticReport",
      recordDate: "2026-10-18",
    });
    assert.equal(initialWorkerCheck.allowed, true);

    // 2. Patient revokes consent while job was in flight
    await revokeConsent(otherPatientPrincipal, consent.consentId);

    // 3. Worker recheck: MUST BE REJECTED
    const postRevocationWorkerCheck = await verifyConsentForQueuedTransfer({
      transferId: "TRANS-002",
      consentId: consent.consentId,
      patientId: otherPatientUser._id.toString(),
      doctorId: doctorUser._id.toString(),
      resourceType: "DiagnosticReport",
      recordDate: "2026-10-18",
    });
    assert.equal(postRevocationWorkerCheck.allowed, false);
    assert.ok(postRevocationWorkerCheck.reason);
  });

  // 16. Failed API requests do not disclose another patient's information
  it("16. Failed API requests do not disclose another patient's information", async () => {
    const consent = await createConsentRequest(doctorPrincipal, {
      patientId: patientUser._id.toString(),
      purpose: "Confidentiality Check",
      hiTypes: ["DiagnosticReport"],
      dateRangeFrom: new Date("2026-01-01"),
      dateRangeTo: new Date("2026-12-31"),
      expiresAt: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000),
    });

    // Patient 2 requests Patient 1's consent details via Route Handler
    const request = new NextRequest(`http://localhost:3001/api/v1/consents/${consent.consentId}`, {
      headers: {
        cookie: otherPatientSessionCookie,
      },
    });

    const response = await getConsentRoute(request, {
      params: Promise.resolve({ id: consent.consentId }),
    });

    assert.equal(response.status, 403);
    const json = await response.json();
    assert.equal(json.success, false);
    // Ensure no patient name, abha, or clinical details leaked in error
    const str = JSON.stringify(json);
    assert.equal(str.includes("Rahul Verma"), false);
    assert.equal(str.includes("rahul.verma@sbx"), false);
  });

  // 17. All decisions create the appropriate history and audit events
  it("17. All decisions create the appropriate history and audit events", async () => {
    const consent = await createConsentRequest(doctorPrincipal, {
      patientId: patientUser._id.toString(),
      purpose: "Full Audit History Test",
      hiTypes: ["DiagnosticReport", "Observation"],
      dateRangeFrom: new Date("2026-01-01"),
      dateRangeTo: new Date("2026-12-31"),
      expiresAt: new Date(Date.now() + 20 * 24 * 60 * 60 * 1000),
    });

    await approveConsent(patientPrincipal, consent.consentId, {
      note: "Audit test approval",
    });

    await revokeConsent(patientPrincipal, consent.consentId, "Audit test revocation");

    // Fetch history
    const history = await getConsentHistory(patientPrincipal, consent.consentId);
    assert.equal(history.length, 3);
    assert.equal(history[0].action, "REQUESTED");
    assert.equal(history[1].action, "APPROVED");
    assert.equal(history[2].action, "REVOKED");

    // Check AuditLog table has corresponding events
    const auditEvents = await AuditLog.find({
      targetResourceId: consent.consentId,
    });
    const actions = auditEvents.map((a) => a.action);
    assert.ok(actions.includes("CONSENT_REQUEST_CREATED"));
    assert.ok(actions.includes("CONSENT_APPROVED"));
    assert.ok(actions.includes("CONSENT_REVOKED"));
  });

  // Background Sweep Verification
  it("Background sweep marks expired consents as EXPIRED", async () => {
    // Create an expired consent artifact
    const pastConsentId = `CONSENT-SWEEP-${Date.now()}`;
    await ConsentArtifact.create({
      consentId: pastConsentId,
      patientId: otherPatientUser._id,
      requesterDoctorId: doctorUser._id,
      requesterFacility: doctorUser.facility,
      purpose: "Sweep Test",
      hiTypes: ["DiagnosticReport"],
      dateRangeFrom: new Date("2025-01-01"),
      dateRangeTo: new Date("2025-12-31"),
      expiresAt: new Date(Date.now() - 10000),
      status: "APPROVED",
      version: 1,
    });

    const result = await sweepExpiredConsents();
    assert.ok(result.expiredCount >= 1);

    const sweptConsent = await ConsentArtifact.findOne({ consentId: pastConsentId });
    assert.equal(sweptConsent?.status, "EXPIRED");
  });
});
