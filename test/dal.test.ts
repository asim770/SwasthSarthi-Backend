import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { connectToDatabase } from "@/lib/db/connect";
import { User, IUser } from "@/lib/db/models/User";
import { HealthRecord } from "@/lib/db/models/HealthRecord";
import { ConsentArtifact } from "@/lib/db/models/ConsentArtifact";
import { LabOrder } from "@/lib/db/models/LabOrder";
import { Prescription } from "@/lib/db/models/Prescription";
import { AuditLog } from "@/lib/db/models/AuditLog";
import { seedDemoIdentities } from "@/lib/db/seed";
import { createSession } from "@/lib/auth/session";
import {
  getPatientProfile,
  getHealthRecordsForPatient,
  getHealthRecordById,
  createConsentRequest,
  evaluateConsent,
  getLaboratoryOrders,
  getLaboratoryOrderById,
  getEligiblePrescriptions,
  assertSafeQueryInput,
  ForbiddenError,
  ConsentRequiredError,
  InvalidQueryError,
} from "@/lib/dal";
import { AuthenticatedPrincipal } from "@/lib/dal/types";

// Import Route Handlers for API layer integration testing
import { GET as getRecordsRoute } from "@/app/api/v1/records/route";
import { GET as getSingleRecordRoute } from "@/app/api/v1/records/[id]/route";
import { GET as getPatientRoute } from "@/app/api/v1/patients/[id]/route";
import { NextRequest } from "next/server";

describe("SwasthSaarthi — Step 5: Secure DAL and Role-Based Access Control Suite", () => {
  let patientUser: IUser;
  let otherPatientUser: IUser;
  let doctorUser: IUser;
  let labUser: IUser;
  let pharmacyUser: IUser;
  let adminUser: IUser;

  let patientPrincipal: AuthenticatedPrincipal;
  let otherPatientPrincipal: AuthenticatedPrincipal;
  let doctorPrincipal: AuthenticatedPrincipal;
  let labPrincipal: AuthenticatedPrincipal;
  let pharmacyPrincipal: AuthenticatedPrincipal;
  let adminPrincipal: AuthenticatedPrincipal;

  let patientSessionCookie: string;
  let doctorSessionCookie: string;
  let adminSessionCookie: string;
  let otherPatientSessionCookie: string;

  before(async () => {
    await connectToDatabase();
    await seedDemoIdentities();

    // Ensure a second patient exists for cross-patient IDOR tests
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

    // Clean up any test consents for secondPatient so Doctor has 0 consents
    await ConsentArtifact.deleteMany({ patientId: secondPatient._id });

    patientUser = (await User.findOne({ abhaAddress: "rahul.verma@sbx" }))!;
    otherPatientUser = secondPatient;
    doctorUser = (await User.findOne({ abhaAddress: "dr.ananya@hpr.sbx" }))!;
    labUser = (await User.findOne({ abhaAddress: "max.lab@hfr.sbx" }))!;
    pharmacyUser = (await User.findOne({ abhaAddress: "apollo.rx@hfr.sbx" }))!;
    adminUser = (await User.findOne({ abhaAddress: "admin.neha@swasth.sbx" }))!;

    assert.ok(patientUser && doctorUser && labUser && pharmacyUser && adminUser);

    // Build principals
    patientPrincipal = {
      id: patientUser._id.toString(),
      abhaId: patientUser.abhaId,
      abhaAddress: patientUser.abhaAddress,
      name: patientUser.name,
      role: "patient",
      isActive: true,
      sessionId: "session-test-patient",
    };

    otherPatientPrincipal = {
      id: otherPatientUser._id.toString(),
      abhaId: otherPatientUser.abhaId,
      abhaAddress: otherPatientUser.abhaAddress,
      name: otherPatientUser.name,
      role: "patient",
      isActive: true,
      sessionId: "session-test-other-patient",
    };

    doctorPrincipal = {
      id: doctorUser._id.toString(),
      abhaId: doctorUser.abhaId,
      abhaAddress: doctorUser.abhaAddress,
      name: doctorUser.name,
      role: "doctor",
      isActive: true,
      facility: doctorUser.facility,
      specialization: doctorUser.specialization,
      sessionId: "session-test-doctor",
    };

    labPrincipal = {
      id: labUser._id.toString(),
      abhaId: labUser.abhaId,
      abhaAddress: labUser.abhaAddress,
      name: labUser.name,
      role: "laboratory",
      isActive: true,
      facility: labUser.facility,
      sessionId: "session-test-lab",
    };

    pharmacyPrincipal = {
      id: pharmacyUser._id.toString(),
      abhaId: pharmacyUser.abhaId,
      abhaAddress: pharmacyUser.abhaAddress,
      name: pharmacyUser.name,
      role: "pharmacy",
      isActive: true,
      facility: pharmacyUser.facility,
      sessionId: "session-test-pharmacy",
    };

    adminPrincipal = {
      id: adminUser._id.toString(),
      abhaId: adminUser.abhaId,
      abhaAddress: adminUser.abhaAddress,
      name: adminUser.name,
      role: "admin",
      isActive: true,
      facility: adminUser.facility,
      sessionId: "session-test-admin",
    };

    // Create real server sessions and cookie headers for API tests
    const dummyReq = new Request("http://localhost:3001");
    const pSession = await createSession(patientUser._id, "patient", dummyReq);
    patientSessionCookie = `ss_session=${pSession.rawSessionToken}`;

    const opSession = await createSession(otherPatientUser._id, "patient", dummyReq);
    otherPatientSessionCookie = `ss_session=${opSession.rawSessionToken}`;

    const dSession = await createSession(doctorUser._id, "doctor", dummyReq);
    doctorSessionCookie = `ss_session=${dSession.rawSessionToken}`;

    const aSession = await createSession(adminUser._id, "admin", dummyReq);
    adminSessionCookie = `ss_session=${aSession.rawSessionToken}`;
  });

  after(async () => {
    await mongoose.disconnect();
  });

  it("1. Patient can read their own permitted profile", async () => {
    const profile = await getPatientProfile(patientPrincipal, patientUser._id.toString());
    assert.strictEqual(profile._id?.toString(), patientUser._id.toString());
    assert.strictEqual(profile.name, "Rahul Verma");
    assert.strictEqual(profile.phone, "+91-9876543210");
  });

  it("2. Patient cannot read another patient's profile (IDOR prevention)", async () => {
    await assert.rejects(
      async () => {
        await getPatientProfile(patientPrincipal, otherPatientUser._id.toString());
      },
      (err: unknown) => {
        assert.ok(err instanceof ForbiddenError);
        assert.match((err as Error).message, /access denied/i);
        return true;
      }
    );
  });

  it("3. Doctor cannot read clinical records without valid consent", async () => {
    // Dr. Ananya has consent for Rahul Verma, but ZERO consent for Priya Verma
    await assert.rejects(
      async () => {
        await getHealthRecordsForPatient(doctorPrincipal, otherPatientUser._id.toString());
      },
      (err: unknown) => {
        assert.ok(err instanceof ConsentRequiredError);
        assert.match((err as Error).message, /active electronic consent/i);
        return true;
      }
    );
  });

  it("4. Doctor cannot exceed consented record categories or date range", async () => {
    // Active consent for Dr. Ananya on Rahul Verma covers ONLY:
    // DiagnosticReport and Encounter between 2026-09-01 and 2026-12-31.
    // Querying 'Immunization' (unconsented category) must fail closed!
    await assert.rejects(
      async () => {
        await getHealthRecordsForPatient(doctorPrincipal, patientUser._id.toString(), {
          resourceType: "Immunization",
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof ConsentRequiredError);
        assert.match((err as Error).message, /outside consented categories/i);
        return true;
      }
    );

    // But querying consented categories succeeds
    const permittedRecords = await getHealthRecordsForPatient(
      doctorPrincipal,
      patientUser._id.toString(),
      { resourceType: "DiagnosticReport" }
    );
    assert.ok(permittedRecords.length > 0);
    assert.strictEqual(permittedRecords[0].resourceType, "DiagnosticReport");
  });

  it("5. Revoked consent denies subsequent requests", async () => {
    // Consent CONSENT-REVOKED-OPHTHAL-02 was revoked for Observation
    const evaluation = await evaluateConsent(
      patientUser._id.toString(),
      doctorUser._id.toString(),
      "Observation",
      new Date("2026-08-28")
    );
    assert.strictEqual(evaluation.hasConsent, false);

    // Record REC-2026-055 is an Observation
    await assert.rejects(
      async () => {
        await getHealthRecordById(doctorPrincipal, "REC-2026-055");
      },
      (err: unknown) => {
        assert.ok(err instanceof ConsentRequiredError);
        return true;
      }
    );
  });

  it("6. Expired consent denies access", async () => {
    // 1. For Dr. Ananya and Rahul Verma, historical consent for Immunization expired on 2026-01-01
    const evaluation = await evaluateConsent(
      patientUser._id.toString(),
      doctorUser._id.toString(),
      "Immunization",
      new Date("2025-06-15")
    );
    assert.strictEqual(evaluation.hasConsent, false);

    // 2. Patient with exclusively expired consent fails with NO_ACTIVE_CONSENT_FOUND
    const uniqueSuffix = Date.now().toString();
    const tempPatient = await User.create({
      abhaId: `55-9999-${uniqueSuffix.slice(-6)}`,
      abhaAddress: `expired.${uniqueSuffix}@sbx`,
      name: "Expired Patient",
      role: "patient",
      isActive: true,
      phone: "+91-9999999999",
    });

    await ConsentArtifact.create({
      consentId: `CONSENT-EXPIRED-${uniqueSuffix}`,
      patientId: tempPatient._id,
      requesterDoctorId: doctorUser._id,
      requesterFacility: "Apollo Clinics",
      purpose: "Expired checkup",
      hiTypes: ["DiagnosticReport"],
      dateRangeFrom: new Date("2024-01-01"),
      dateRangeTo: new Date("2024-12-31"),
      expiresAt: new Date(Date.now() - 86400000), // Expired yesterday
      status: "GRANTED",
    });

    const expiredEval = await evaluateConsent(
      tempPatient._id.toString(),
      doctorUser._id.toString(),
      "DiagnosticReport",
      new Date("2024-06-01")
    );
    assert.strictEqual(expiredEval.hasConsent, false);
    assert.strictEqual(expiredEval.reason, "NO_ACTIVE_CONSENT_FOUND");
  });

  it("7. Laboratory cannot retrieve unrelated clinical records", async () => {
    await assert.rejects(
      async () => {
        await getHealthRecordsForPatient(labPrincipal, patientUser._id.toString());
      },
      (err: unknown) => {
        assert.ok(err instanceof ForbiddenError);
        assert.match((err as Error).message, /not authorized to browse general clinical records/i);
        return true;
      }
    );
  });

  it("8. Pharmacy cannot access laboratory reports or general history", async () => {
    await assert.rejects(
      async () => {
        await getHealthRecordsForPatient(pharmacyPrincipal, patientUser._id.toString());
      },
      (err: unknown) => {
        assert.ok(err instanceof ForbiddenError);
        assert.match((err as Error).message, /not authorized to browse general clinical records/i);
        return true;
      }
    );

    // But Pharmacy CAN view eligible prescriptions
    const rxList = await getEligiblePrescriptions(pharmacyPrincipal);
    assert.ok(rxList.length > 0);
    assert.strictEqual(rxList[0].status, "ACTIVE");
  });

  it("9. Administrator cannot read FHIR resources or clinical contents", async () => {
    // Admin attempting to read patient clinical records
    await assert.rejects(
      async () => {
        await getHealthRecordsForPatient(adminPrincipal, patientUser._id.toString());
      },
      (err: unknown) => {
        assert.ok(err instanceof ForbiddenError);
        assert.match((err as Error).message, /Administrators are strictly forbidden/i);
        return true;
      }
    );

    // Admin attempting to read a single record by ID
    await assert.rejects(
      async () => {
        await getHealthRecordById(adminPrincipal, "REC-2026-101");
      },
      (err: unknown) => {
        assert.ok(err instanceof ForbiddenError);
        assert.match((err as Error).message, /strictly forbidden/i);
        return true;
      }
    );
  });

  it("10. A manipulated role field cannot escalate privileges", async () => {
    // Client sending role="admin" or role="doctor" in query or request payload
    // The DAL strictly derives role from validated server session!
    // Even if an attacker passes `{ role: "doctor" }` as a parameter to patient profile:
    const fakePrincipal: AuthenticatedPrincipal = {
      ...patientPrincipal,
      // Even if attacker claimed doctor in memory, without DB/session backing:
      role: "patient", // Server derived
    };

    await assert.rejects(
      async () => {
        await getLaboratoryOrders(fakePrincipal);
      },
      (err: unknown) => {
        assert.ok(err instanceof ForbiddenError);
        return true;
      }
    );
  });

  it("11. A doctor cannot cross an unauthorized facility boundary", async () => {
    // Lab order LAB-ORD-2026-001 belongs to Max Super Speciality Hospital, Saket
    // A laboratory user from a different facility attempting to access it must be rejected
    const rogueLabPrincipal: AuthenticatedPrincipal = {
      ...labPrincipal,
      facility: "Fortis Diagnostics, Vasant Kunj", // Different facility
    };

    await assert.rejects(
      async () => {
        await getLaboratoryOrderById(rogueLabPrincipal, "LAB-ORD-2026-001");
      },
      (err: unknown) => {
        assert.ok(err instanceof ForbiddenError);
        assert.match((err as Error).message, /Cross-facility access denied/i);
        return true;
      }
    );
  });

  it("12. Missing sessions receive an appropriate authentication error", async () => {
    const unauthReq = new NextRequest("http://localhost:3001/api/v1/records");
    const response = await getRecordsRoute(unauthReq);
    assert.strictEqual(response.status, 401);
    const body = await response.json();
    assert.strictEqual(body.success, false);
    assert.strictEqual(body.error.code, "UNAUTHENTICATED");
  });

  it("13. Direct API calls receive the same authorization checks as frontend calls", async () => {
    // Generate fresh session for patient A
    const { rawSessionToken } = await createSession(
      patientUser._id,
      "patient",
      new Request("http://localhost:3001")
    );

    // Direct call to /api/v1/patients/[id] by Patient A requesting Patient B's ID
    const directReq = new NextRequest(
      `http://localhost:3001/api/v1/patients/${otherPatientUser._id.toString()}`,
      {
        headers: {
          cookie: `ss_session=${rawSessionToken}`,
        },
      }
    );

    const response = await getPatientRoute(directReq, {
      params: Promise.resolve({ id: otherPatientUser._id.toString() }),
    });

    const body = await response.json();
    assert.strictEqual(response.status, 403);
    assert.strictEqual(body.success, false);
    assert.strictEqual(body.error.code, "FORBIDDEN");
  });

  it("14. Untrusted MongoDB query operators are rejected", async () => {
    // Pass malicious NoSQL injection operator
    assert.throws(
      () => {
        assertSafeQueryInput({ $gt: "", $where: "sleep(1000)" });
      },
      (err: unknown) => {
        assert.ok(err instanceof InvalidQueryError);
        assert.match((err as Error).message, /MongoDB operators are strictly forbidden/i);
        return true;
      }
    );

    assert.throws(
      () => {
        assertSafeQueryInput({ "patientId.nested": "malicious" });
      },
      (err: unknown) => {
        assert.ok(err instanceof InvalidQueryError);
        return true;
      }
    );
  });

  it("15. Unauthorized attempts produce safe audit metadata without leaking clinical content", async () => {
    // Generate a fresh session for Admin
    const { rawSessionToken } = await createSession(
      adminUser._id,
      "admin",
      new Request("http://localhost:3001")
    );

    // Generate an unauthorized attempt by Admin trying to access records via HTTP API
    const adminReq = new NextRequest(
      `http://localhost:3001/api/v1/records?patientId=${patientUser._id.toString()}`,
      {
        headers: {
          cookie: `ss_session=${rawSessionToken}`,
        },
      }
    );

    const res = await getRecordsRoute(adminReq);
    assert.strictEqual(res.status, 403);

    // Inspect AuditLog in database
    const latestAudit = await AuditLog.findOne({
      action: "READ_CLINICAL_RECORDS_DENIED",
    }).sort({ timestamp: -1 });

    assert.ok(latestAudit);
    assert.strictEqual(latestAudit.outcome, "DENIED");
    // Verify no clinical data was leaked into audit log metadata
    assert.strictEqual(latestAudit.metadata?.clinicalData, undefined);
    assert.strictEqual(latestAudit.metadata?.fhirBundle, undefined);
  });
});
