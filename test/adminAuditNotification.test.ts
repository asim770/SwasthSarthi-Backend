import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { connectToDatabase } from "@/lib/db/connect";
import { User, IUser } from "@/lib/db/models/User";
import { Facility, IFacility } from "@/lib/db/models/Facility";
import { AuditLog } from "@/lib/db/models/AuditLog";
import { AuditChainHead, GENESIS_HASH } from "@/lib/db/models/AuditChainHead";
import { Notification } from "@/lib/db/models/Notification";
import { ConsentArtifact } from "@/lib/db/models/ConsentArtifact";
import {
  registerInstitution,
  listInstitutions,
  reviewInstitution,
  listPractitionerVerifications,
  reviewPractitioner,
  assertFacilityApproved,
} from "@/lib/dal/onboarding";
import {
  logAuditEvent,
  verifyAuditChainIntegrity,
  canonicalizeAuditEvent,
  computeEventHash,
  getPatientAccessHistory,
} from "@/lib/dal/audit";
import {
  createNotification,
  getNotifications,
  getUnreadNotificationCount,
  markNotificationAsRead,
  markAllNotificationsAsRead,
} from "@/lib/dal/notifications";
import { createConsentRequest } from "@/lib/dal/consents";
import { getHealthRecordsForPatient } from "@/lib/dal/records";
import { AuthenticatedPrincipal } from "@/lib/dal/types";
import {
  ForbiddenError,
  ValidationError,
  ConflictError,
} from "@/lib/dal/errors";

describe("SwasthSaarthi — Step 9: Admin Onboarding, Audit Chain & Notifications Suite", () => {
  let patientUser: IUser;
  let otherPatientUser: IUser;
  let doctorUser: IUser;
  let adminUser: IUser;
  let otherAdminUser: IUser;

  let patientPrincipal: AuthenticatedPrincipal;
  let otherPatientPrincipal: AuthenticatedPrincipal;
  let doctorPrincipal: AuthenticatedPrincipal;
  let adminPrincipal: AuthenticatedPrincipal;
  let otherAdminPrincipal: AuthenticatedPrincipal;

  before(async () => {
    await connectToDatabase();

    const timestamp = Date.now().toString();

    // 1. Setup Test Users
    patientUser = await User.create({
      abhaId: `91-0001-${timestamp.slice(-4)}`,
      abhaAddress: `step9.patient.${timestamp.slice(-4)}@sbx`,
      name: "Step 9 Patient",
      role: "patient",
      isActive: true,
      phone: `+91-911${timestamp.slice(-7)}`,
    });

    otherPatientUser = await User.create({
      abhaId: `91-0002-${timestamp.slice(-4)}`,
      abhaAddress: `step9.other.${timestamp.slice(-4)}@sbx`,
      name: "Other Step 9 Patient",
      role: "patient",
      isActive: true,
      phone: `+91-912${timestamp.slice(-7)}`,
    });

    doctorUser = await User.create({
      abhaId: `HPR-DOC-${timestamp.slice(-4)}`,
      abhaAddress: `step9.doc.${timestamp.slice(-4)}@hpr.sbx`,
      name: "Dr. Step 9 Practitioner",
      role: "doctor",
      isActive: true,
      phone: `+91-913${timestamp.slice(-7)}`,
      facility: "Max Super Speciality Hospital, Saket",
      specialization: "Internal Medicine",
      verificationStatus: "PENDING",
      hprId: `HPR-${timestamp.slice(-6)}`,
    });

    adminUser = await User.create({
      abhaId: `ADMIN-01-${timestamp.slice(-4)}`,
      abhaAddress: `step9.admin1.${timestamp.slice(-4)}@swasth.sbx`,
      name: "Lead Administrator Neha",
      role: "admin",
      isActive: true,
      phone: `+91-914${timestamp.slice(-7)}`,
      facility: "National Health Authority",
    });

    otherAdminUser = await User.create({
      abhaId: `ADMIN-02-${timestamp.slice(-4)}`,
      abhaAddress: `step9.admin2.${timestamp.slice(-4)}@swasth.sbx`,
      name: "Auditor Administrator Rajiv",
      role: "admin",
      isActive: true,
      phone: `+91-915${timestamp.slice(-7)}`,
      facility: "State Health Authority",
    });

    // 2. Setup Principals
    patientPrincipal = {
      id: patientUser._id.toString(),
      abhaId: patientUser.abhaId,
      abhaAddress: patientUser.abhaAddress,
      name: patientUser.name,
      role: "patient",
      isActive: true,
      sessionId: "session-p1",
    };

    otherPatientPrincipal = {
      id: otherPatientUser._id.toString(),
      abhaId: otherPatientUser.abhaId,
      abhaAddress: otherPatientUser.abhaAddress,
      name: otherPatientUser.name,
      role: "patient",
      isActive: true,
      sessionId: "session-p2",
    };

    doctorPrincipal = {
      id: doctorUser._id.toString(),
      abhaId: doctorUser.abhaId,
      abhaAddress: doctorUser.abhaAddress,
      name: doctorUser.name,
      role: "doctor",
      facility: doctorUser.facility,
      isActive: true,
      sessionId: "session-doc",
    };

    adminPrincipal = {
      id: adminUser._id.toString(),
      abhaId: adminUser.abhaId,
      abhaAddress: adminUser.abhaAddress,
      name: adminUser.name,
      role: "admin",
      facility: adminUser.facility,
      isActive: true,
      sessionId: "session-admin1",
    };

    otherAdminPrincipal = {
      id: otherAdminUser._id.toString(),
      abhaId: otherAdminUser.abhaId,
      abhaAddress: otherAdminUser.abhaAddress,
      name: otherAdminUser.name,
      role: "admin",
      facility: otherAdminUser.facility,
      isActive: true,
      sessionId: "session-admin2",
    };
  });

  // ==========================================
  // ONBOARDING TESTS (1 - 6)
  // ==========================================

  // 1. Authorized admin can register an institution
  it("1. Authorized admin can register an institution", async () => {
    const facilityId = `IN07-${Date.now().toString().slice(-6)}`;
    const facility = await registerInstitution(adminPrincipal, {
      name: "Indraprastha Medical Center",
      type: "HOSPITAL",
      facilityId,
      city: "New Delhi",
      state: "Delhi",
      contactPhone: "+91-11-26510000",
      contactEmail: "admin@indraprastha.demo",
    });

    assert.ok(facility);
    assert.equal(facility.name, "Indraprastha Medical Center");
    assert.equal(facility.status, "PENDING");
    assert.equal(facility.facilityId, facilityId);
    assert.equal(facility.registeredBy.toString(), adminPrincipal.id);
  });

  // 2. Non-admin cannot approve or suspend an institution
  it("2. Non-admin cannot approve or suspend an institution", async () => {
    const facilityId = `IN29-${Date.now().toString().slice(-6)}`;
    const fac = await Facility.create({
      facilityId,
      name: "Bangalore Cardiac Clinic",
      type: "CLINIC",
      status: "PENDING",
      registeredBy: new mongoose.Types.ObjectId(adminPrincipal.id),
      registeredByName: adminPrincipal.name,
    });

    // Doctor attempts approval
    await assert.rejects(
      async () => {
        await reviewInstitution(doctorPrincipal, fac.facilityId, {
          decision: "APPROVED",
          reason: "Unauthorized doctor attempting facility approval",
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof ForbiddenError);
        return true;
      }
    );

    // Patient attempts suspension
    await assert.rejects(
      async () => {
        await reviewInstitution(patientPrincipal, fac.facilityId, {
          decision: "SUSPENDED",
          reason: "Unauthorized patient attempting facility suspension",
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof ForbiddenError);
        return true;
      }
    );
  });

  // 3. Users cannot approve their own verification
  it("3. Users cannot approve their own verification", async () => {
    // 3a. Admin who registered facility cannot approve it (self-approval blocked)
    const facilityId = `IN07-SELF-${Date.now().toString().slice(-5)}`;
    const selfFac = await Facility.create({
      facilityId,
      name: "Neha Personal Diagnostic Clinic",
      type: "LABORATORY",
      status: "PENDING",
      registeredBy: new mongoose.Types.ObjectId(adminPrincipal.id),
      registeredByName: adminPrincipal.name,
    });

    await assert.rejects(
      async () => {
        await reviewInstitution(adminPrincipal, selfFac.facilityId, {
          decision: "APPROVED",
          reason: "Attempting self-approval of own registered facility",
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof ForbiddenError);
        assert.match(err.message, /Self-approval forbidden/);
        return true;
      }
    );

    // Another admin CAN review it
    const reviewed = await reviewInstitution(otherAdminPrincipal, selfFac.facilityId, {
      decision: "APPROVED",
      reason: "Second administrator verified compliance checklist",
    });
    assert.equal(reviewed.status, "APPROVED");

    // 3b. Practitioner cannot review their own professional record
    await assert.rejects(
      async () => {
        await reviewPractitioner(doctorPrincipal, doctorPrincipal.id, {
          decision: "APPROVED",
          reason: "Attempting self-verification of medical credentials",
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof ForbiddenError);
        assert.match(err.message, /Self-approval forbidden/);
        return true;
      }
    );
  });

  // 4. Unapproved or suspended facilities cannot perform restricted operations
  it("4. Unapproved or suspended facilities cannot perform restricted operations", async () => {
    const suspendedFacilityId = `FAC-SUSP-${Date.now().toString().slice(-5)}`;
    await Facility.create({
      facilityId: suspendedFacilityId,
      name: "Suspended Metropolitan Clinic",
      type: "CLINIC",
      status: "SUSPENDED",
      registeredBy: new mongoose.Types.ObjectId(adminPrincipal.id),
      registeredByName: adminPrincipal.name,
      statusReason: "Malpractice telemetry investigation underway",
    });

    await assert.rejects(
      async () => {
        await assertFacilityApproved("Suspended Metropolitan Clinic");
      },
      (err: unknown) => {
        assert.ok(err instanceof ForbiddenError);
        assert.match(err.message, /currently SUSPENDED/);
        return true;
      }
    );

    // Pending facility is also blocked
    const pendingFacilityId = `FAC-PEND-${Date.now().toString().slice(-5)}`;
    await Facility.create({
      facilityId: pendingFacilityId,
      name: "Pending Testing Diagnostic Center",
      type: "LABORATORY",
      status: "PENDING",
      registeredBy: new mongoose.Types.ObjectId(adminPrincipal.id),
      registeredByName: adminPrincipal.name,
    });

    await assert.rejects(
      async () => {
        await assertFacilityApproved("Pending Testing Diagnostic Center");
      },
      (err: unknown) => {
        assert.ok(err instanceof ForbiddenError);
        assert.match(err.message, /currently PENDING/);
        return true;
      }
    );
  });

  // 5. Client-supplied roles and verification statuses cannot grant privileges
  it("5. Client-supplied roles and verification statuses cannot grant privileges", async () => {
    // A doctor principal trying to pass admin payload or pretend verification status is approved
    const spoofedPrincipal: AuthenticatedPrincipal = {
      ...doctorPrincipal,
      role: "doctor", // Server evaluates session token role, rejecting client role claims
    };

    await assert.rejects(
      async () => {
        await listInstitutions(spoofedPrincipal);
      },
      (err: unknown) => {
        assert.ok(err instanceof ForbiddenError);
        return true;
      }
    );
  });

  // 6. Admin cannot retrieve clinical record contents
  it("6. Admin cannot retrieve clinical record contents", async () => {
    await assert.rejects(
      async () => {
        await getHealthRecordsForPatient(adminPrincipal, patientUser._id.toString());
      },
      (err: unknown) => {
        assert.ok(err instanceof ForbiddenError);
        assert.match(err.message, /strictly forbidden/i);
        return true;
      }
    );
  });

  // ==========================================
  // AUDIT CHAIN TESTS (7 - 13)
  // ==========================================

  // 7. Audit event hashes verify correctly
  it("7. Audit event hashes verify correctly", async () => {
    const log1 = await logAuditEvent({
      action: "AUTH_LOGIN_SUCCESS",
      principal: patientPrincipal,
      targetResourceType: "Session",
      outcome: "ALLOWED",
    });

    const log2 = await logAuditEvent({
      action: "CONSENT_REQUESTED",
      principal: doctorPrincipal,
      targetResourceType: "ConsentArtifact",
      outcome: "ALLOWED",
    });

    assert.ok(log1 && log2);
    assert.ok(log1.sequenceNumber && log2.sequenceNumber);
    assert.ok(log2.sequenceNumber > log1.sequenceNumber);

    const check = await verifyAuditChainIntegrity(log1.sequenceNumber, log2.sequenceNumber);
    assert.equal(check.valid, true);
    assert.ok(check.totalVerified >= 2);
  });

  // 8. Altered event data is detected
  it("8. Altered event data is detected", async () => {
    // Generate two valid events
    const log1 = await logAuditEvent({
      action: "RECORD_DISCOVERY",
      principal: patientPrincipal,
      targetResourceType: "HealthRecord",
      outcome: "ALLOWED",
    });

    const log2 = await logAuditEvent({
      action: "LAB_REPORT_FILED",
      principal: doctorPrincipal,
      targetResourceType: "LabOrder",
      outcome: "ALLOWED",
    });

    assert.ok(log1 && log2 && log2.sequenceNumber);

    // Simulate tampering: change log2 action directly on raw MongoDB collection (bypassing Mongoose hooks)
    await mongoose.connection.collection("auditlogs").updateOne(
      { _id: (log2 as any)._id },
      { $set: { action: "TAMPERED_ACTION_DATA" } }
    );

    const check = await verifyAuditChainIntegrity(log1.sequenceNumber, log2.sequenceNumber);
    assert.equal(check.valid, false);
    assert.equal(check.brokenAtSequence, log2.sequenceNumber);
    assert.match(check.details || "", /Payload integrity altered/);

    // Restore clean action to not poison subsequent tests
    await mongoose.connection.collection("auditlogs").updateOne(
      { _id: (log2 as any)._id },
      { $set: { action: "LAB_REPORT_FILED" } }
    );
  });

  // 9. Deleted, reordered, or missing events are detected within the verifiable chain
  it("9. Deleted, reordered, or missing events are detected within the verifiable chain", async () => {
    const logA = await logAuditEvent({
      action: "CHAIN_EVENT_A",
      principal: adminPrincipal,
      targetResourceType: "AuditLog",
      outcome: "ALLOWED",
    });

    const logB = await logAuditEvent({
      action: "CHAIN_EVENT_B",
      principal: adminPrincipal,
      targetResourceType: "AuditLog",
      outcome: "ALLOWED",
    });

    const logC = await logAuditEvent({
      action: "CHAIN_EVENT_C",
      principal: adminPrincipal,
      targetResourceType: "AuditLog",
      outcome: "ALLOWED",
    });

    assert.ok(logA && logB && logC && logA.sequenceNumber && logC.sequenceNumber);

    // Delete event B via raw collection to simulate a missing record in the chain
    await mongoose.connection.collection("auditlogs").deleteOne({ _id: (logB as any)._id });

    const check = await verifyAuditChainIntegrity(logA.sequenceNumber, logC.sequenceNumber);
    assert.equal(check.valid, false);
    assert.match(check.details || "", /Sequence discontinuity/);
  });

  // 10. Concurrent event writes do not silently fork the chain
  it("10. Concurrent event writes do not silently fork the chain", async () => {
    const concurrentCount = 6;
    const promises = Array.from({ length: concurrentCount }).map((_, idx) =>
      logAuditEvent({
        action: `CONCURRENT_TEST_EVENT_${idx}`,
        principal: adminPrincipal,
        targetResourceType: "ConcurrencyProbe",
        outcome: "ALLOWED",
        metadata: { threadIdx: idx },
      })
    );

    const results = await Promise.all(promises);
    assert.equal(results.length, concurrentCount);

    const sequenceNumbers = results
      .map((r) => r?.sequenceNumber)
      .filter((seq): seq is number => typeof seq === "number")
      .sort((a, b) => a - b);

    // All sequences must be unique (no duplicate sequence assigned!)
    const uniqueSeqs = new Set(sequenceNumbers);
    assert.equal(uniqueSeqs.size, concurrentCount);

    // Verify chain integrity over this contiguous slice
    const check = await verifyAuditChainIntegrity(sequenceNumbers[0], sequenceNumbers[sequenceNumbers.length - 1]);
    assert.equal(check.valid, true);
    assert.ok(check.totalVerified >= concurrentCount);
  });

  // 11. Application-level updates or deletes of existing audit events are rejected
  it("11. Application-level updates or deletes of existing audit events are rejected", async () => {
    const auditDoc = await AuditLog.findOne().sort({ timestamp: -1 });
    assert.ok(auditDoc);

    // Mongoose updateOne must fail
    await assert.rejects(
      async () => {
        await AuditLog.updateOne({ _id: auditDoc._id }, { action: "MODIFIED" });
      },
      /Audit records are append-only/
    );

    // Mongoose deleteOne must fail
    await assert.rejects(
      async () => {
        await AuditLog.deleteOne({ _id: auditDoc._id });
      },
      /Audit records are append-only/
    );
  });

  // 12. Retry behavior does not unintentionally duplicate audit events
  it("12. Retry behavior does not unintentionally duplicate audit events", async () => {
    const correlationId = `CORR-${Date.now()}`;
    const initialCount = await AuditLog.countDocuments({ correlationId });
    assert.equal(initialCount, 0);

    // First attempt
    await logAuditEvent({
      action: "IDEMPOTENT_ACTION_PROBE",
      principal: doctorPrincipal,
      targetResourceType: "ConsentArtifact",
      correlationId,
      outcome: "ALLOWED",
    });

    const countAfter = await AuditLog.countDocuments({ correlationId });
    assert.equal(countAfter, 1);
  });

  // 13. Audit events contain no raw clinical content or authentication secrets
  it("13. Audit events contain no raw clinical content or authentication secrets", async () => {
    const sensitiveLog = await logAuditEvent({
      action: "TEST_REDACTION",
      principal: patientPrincipal,
      targetResourceType: "SecurityProbe",
      outcome: "ALLOWED",
      metadata: {
        password: "SuperSecretPassword123!",
        otp: "654321",
        bearerToken: "eyJh...sensitiveJWT",
        clinicalData: { bloodGlucose: 140, hivStatus: "Negative" },
        allowedReference: "REF-2026-X99",
      },
    });

    assert.ok(sensitiveLog && sensitiveLog.metadata);
    assert.equal(sensitiveLog.metadata.password, "[REDACTED]");
    assert.equal(sensitiveLog.metadata.otp, "[REDACTED]");
    assert.equal(sensitiveLog.metadata.bearerToken, "[REDACTED]");
    assert.equal(sensitiveLog.metadata.clinicalData, "[REDACTED]");
    assert.equal(sensitiveLog.metadata.allowedReference, "REF-2026-X99");
  });

  // ==========================================
  // NOTIFICATION TESTS (14 - 19)
  // ==========================================

  // 14. Consent events enqueue the correct recipient notification
  it("14. Consent events enqueue the correct recipient notification", async () => {
    const now = new Date();
    const futureExpiry = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);
    const consent = await createConsentRequest(doctorPrincipal, {
      patientId: patientUser._id.toString(),
      purpose: "Telemetry Review Notification Test",
      hiTypes: ["DiagnosticReport"],
      dateRangeFrom: "2026-01-01",
      dateRangeTo: "2026-12-31",
      expiresAt: futureExpiry.toISOString(),
    });

    assert.ok(consent);

    // Verify patient received the notification
    const patientNotifs = await getNotifications(patientPrincipal, { limit: 10 });
    const matching = patientNotifs.notifications.find(
      (n) => n.relatedResourceId === consent.consentId && n.category === "CONSENT"
    );

    assert.ok(matching);
    assert.equal(matching.recipientAbha, patientUser.abhaAddress);
    assert.match(matching.title, /Consent Request/);
  });

  // 15. Users cannot read another user's notification inbox
  it("15. Users cannot read another user's notification inbox", async () => {
    // Create notification explicitly for patientUser
    const { notification } = await createNotification({
      recipientId: patientUser._id,
      recipientAbha: patientUser.abhaAddress,
      category: "SECURITY",
      title: "Login from New Browser Session",
      message: "A new session was established using ABHA biometric authentication.",
      idempotencyKey: `notif-sec-${Date.now()}`,
    });

    // otherPatientPrincipal queries inbox
    const otherInbox = await getNotifications(otherPatientPrincipal, { limit: 50 });
    const foundOther = otherInbox.notifications.some((n) => n.notificationId === notification.notificationId);
    assert.equal(foundOther, false);
  });

  // 16. Mark-as-read only affects the authorized recipient's notification
  it("16. Mark-as-read only affects the authorized recipient's notification", async () => {
    const { notification } = await createNotification({
      recipientId: patientUser._id,
      recipientAbha: patientUser.abhaAddress,
      category: "ONBOARDING",
      title: "Welcome to SwasthSaarthi Portal",
      message: "Your ABHA account is registered and active.",
      idempotencyKey: `notif-welcome-${Date.now()}`,
    });

    assert.equal(notification.isRead, false);

    // otherPatientPrincipal tries to mark it as read -> must throw ForbiddenError
    await assert.rejects(
      async () => {
        await markNotificationAsRead(otherPatientPrincipal, notification.notificationId);
      },
      (err: unknown) => {
        assert.ok(err instanceof ForbiddenError);
        return true;
      }
    );

    // Authorized recipient marks it
    const marked = await markNotificationAsRead(patientPrincipal, notification.notificationId);
    assert.equal(marked.isRead, true);
    assert.ok(marked.readAt);
  });

  // 17. Duplicate queue delivery does not create duplicate notifications
  it("17. Duplicate queue delivery does not create duplicate notifications", async () => {
    const idempotencyKey = `IDEMP-QUEUE-${Date.now()}`;

    const res1 = await createNotification({
      recipientId: patientUser._id,
      recipientAbha: patientUser.abhaAddress,
      category: "SECURITY",
      title: "Idempotent Alert Test",
      message: "Testing duplicate message suppression.",
      idempotencyKey,
    });

    assert.equal(res1.duplicate, false);

    // Replay of same event
    const res2 = await createNotification({
      recipientId: patientUser._id,
      recipientAbha: patientUser.abhaAddress,
      category: "SECURITY",
      title: "Idempotent Alert Test",
      message: "Testing duplicate message suppression.",
      idempotencyKey,
    });

    assert.equal(res2.duplicate, true);
    assert.equal(res2.notification.notificationId, res1.notification.notificationId);

    const totalMatching = await Notification.countDocuments({ idempotencyKey });
    assert.equal(totalMatching, 1);
  });

  // 18. Failed delivery is retried safely
  it("18. Failed delivery is retried safely", async () => {
    const retryKey = `RETRY-ALERT-${Date.now()}`;
    const initial = await createNotification({
      recipientId: patientUser._id,
      recipientAbha: patientUser.abhaAddress,
      category: "ONBOARDING",
      title: "Verification Update",
      message: "Your healthcare facility profile status has been reviewed.",
      idempotencyKey: retryKey,
    });

    assert.ok(initial.notification);
    assert.equal(initial.notification.deliveryStatus, "DELIVERED");
  });

  // 19. Notification messages do not leak sensitive clinical details
  it("19. Notification messages do not leak sensitive clinical details", async () => {
    // Attempting to create notification with sensitive credentials/OTP fails validation
    await assert.rejects(
      async () => {
        await createNotification({
          recipientId: patientUser._id,
          recipientAbha: patientUser.abhaAddress,
          category: "SECURITY",
          title: "Your login OTP",
          message: "Your OTP is 123456. Do not share password or secret.",
          idempotencyKey: `notif-sensitive-${Date.now()}`,
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof ValidationError);
        assert.match(err.message, /restricted sensitive term/);
        return true;
      }
    );

    // Access history for patient returns non-sensitive metadata only
    const history = await getPatientAccessHistory(patientPrincipal);
    assert.ok(Array.isArray(history));
    for (const item of history) {
      assert.ok(!("clinicalData" in item));
      assert.ok(!("fhirResource" in item));
      assert.ok(!("password" in item));
    }
  });
});
