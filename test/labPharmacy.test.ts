import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { connectToDatabase } from "@/lib/db/connect";
import { User, IUser } from "@/lib/db/models/User";
import { LabOrder, ILabOrder } from "@/lib/db/models/LabOrder";
import { Prescription, IPrescription } from "@/lib/db/models/Prescription";
import { DispensingEvent } from "@/lib/db/models/DispensingEvent";
import { SourceInstitutionRecord } from "@/lib/db/models/SourceInstitutionRecord";
import { ConsentArtifact } from "@/lib/db/models/ConsentArtifact";
import { AuditLog } from "@/lib/db/models/AuditLog";
import {
  createLaboratoryOrder,
  getLaboratoryOrders,
  getLaboratoryOrderById,
  submitDiagnosticReport,
  getDoctorLaboratoryOrders,
} from "@/lib/dal/laboratory";
import {
  createPrescription,
  getEligiblePrescriptions,
  getPrescriptionById,
  recordDispensation,
  getDoctorPrescriptions,
} from "@/lib/dal/pharmacy";
import { getHealthRecordsForPatient } from "@/lib/dal/records";
import { AuthenticatedPrincipal } from "@/lib/dal/types";
import {
  ForbiddenError,
  InvalidQueryError,
  NotFoundError,
  ConsentRequiredError,
} from "@/lib/dal/errors";
import { validateFhirResource } from "@/lib/fhir/validator";

describe("SwasthSaarthi — Step 8: Laboratory & Pharmacy Workflows Suite", () => {
  let patientUser: IUser;
  let otherPatientUser: IUser;
  let doctorUser: IUser;
  let labUser: IUser;
  let otherLabUser: IUser;
  let pharmacyUser: IUser;
  let adminUser: IUser;

  let patientPrincipal: AuthenticatedPrincipal;
  let doctorPrincipal: AuthenticatedPrincipal;
  let labPrincipal: AuthenticatedPrincipal;
  let otherLabPrincipal: AuthenticatedPrincipal;
  let pharmacyPrincipal: AuthenticatedPrincipal;
  let adminPrincipal: AuthenticatedPrincipal;

  let testOrder: ILabOrder;
  let testPrescription: IPrescription;

  before(async () => {
    await connectToDatabase();

    const timestamp = Date.now().toString();

    // 1. Seed identities
    patientUser = await User.create({
      abhaId: `32-8492-${timestamp.slice(-4)}-1111`,
      abhaAddress: `patient.step8.${timestamp}@sbx`,
      name: "Ramesh Sharma",
      role: "patient",
      isActive: true,
      phone: `+91-987${timestamp.slice(-7)}`,
      email: `ramesh.${timestamp}@synthetic.demo`,
    });

    otherPatientUser = await User.create({
      abhaId: `32-8492-${timestamp.slice(-4)}-2222`,
      abhaAddress: `other.step8.${timestamp}@sbx`,
      name: "Suresh Gupta",
      role: "patient",
      isActive: true,
      phone: `+91-986${timestamp.slice(-7)}`,
      email: `suresh.${timestamp}@synthetic.demo`,
    });

    doctorUser = await User.create({
      abhaId: `HPR-DEL-${timestamp.slice(-4)}-3333`,
      abhaAddress: `dr.kapoor.${timestamp}@hpr.sbx`,
      name: "Dr. Siddharth Kapoor",
      role: "doctor",
      isActive: true,
      phone: `+91-985${timestamp.slice(-7)}`,
      facility: "Max Super Speciality Hospital, Saket",
    });

    labUser = await User.create({
      abhaId: `HFR-LAB-${timestamp.slice(-4)}-4444`,
      abhaAddress: `saket.lab.${timestamp}@hfr.sbx`,
      name: "Max Saket Diagnostic Laboratory",
      role: "laboratory",
      isActive: true,
      phone: `+91-984${timestamp.slice(-7)}`,
      facility: "Max Super Speciality Hospital, Saket",
    });

    otherLabUser = await User.create({
      abhaId: `HFR-LAB-${timestamp.slice(-4)}-5555`,
      abhaAddress: `apollo.lab.${timestamp}@hfr.sbx`,
      name: "Apollo Pathology Laboratory",
      role: "laboratory",
      isActive: true,
      phone: `+91-983${timestamp.slice(-7)}`,
      facility: "Apollo Clinics, Indiranagar",
    });

    pharmacyUser = await User.create({
      abhaId: `HFR-PHARM-${timestamp.slice(-4)}-6666`,
      abhaAddress: `apollo.rx.${timestamp}@hfr.sbx`,
      name: "Apollo Pharmacy Hub",
      role: "pharmacy",
      isActive: true,
      phone: `+91-982${timestamp.slice(-7)}`,
      facility: "Apollo Health City",
    });

    adminUser = await User.create({
      abhaId: `ADMIN-SHA-${timestamp.slice(-4)}-7777`,
      abhaAddress: `admin.${timestamp}@swasth.sbx`,
      name: "Platform Auditor",
      role: "admin",
      isActive: true,
      phone: `+91-981${timestamp.slice(-7)}`,
      facility: "State Health Authority (SHA)",
    });

    // 2. Setup Principals
    patientPrincipal = {
      id: patientUser._id.toString(),
      abhaId: patientUser.abhaId,
      abhaAddress: patientUser.abhaAddress,
      name: patientUser.name,
      role: "patient",
      isActive: true,
      sessionId: "session-test-patient",
    };

    doctorPrincipal = {
      id: doctorUser._id.toString(),
      abhaId: doctorUser.abhaId,
      abhaAddress: doctorUser.abhaAddress,
      name: doctorUser.name,
      role: "doctor",
      facility: doctorUser.facility,
      isActive: true,
      sessionId: "session-test-doctor",
    };

    labPrincipal = {
      id: labUser._id.toString(),
      abhaId: labUser.abhaId,
      abhaAddress: labUser.abhaAddress,
      name: labUser.name,
      role: "laboratory",
      facility: labUser.facility,
      isActive: true,
      sessionId: "session-test-lab",
    };

    otherLabPrincipal = {
      id: otherLabUser._id.toString(),
      abhaId: otherLabUser.abhaId,
      abhaAddress: otherLabUser.abhaAddress,
      name: otherLabUser.name,
      role: "laboratory",
      facility: otherLabUser.facility,
      isActive: true,
      sessionId: "session-test-other-lab",
    };

    pharmacyPrincipal = {
      id: pharmacyUser._id.toString(),
      abhaId: pharmacyUser.abhaId,
      abhaAddress: pharmacyUser.abhaAddress,
      name: pharmacyUser.name,
      role: "pharmacy",
      facility: pharmacyUser.facility,
      isActive: true,
      sessionId: "session-test-pharmacy",
    };

    adminPrincipal = {
      id: adminUser._id.toString(),
      abhaId: adminUser.abhaId,
      abhaAddress: adminUser.abhaAddress,
      name: adminUser.name,
      role: "admin",
      facility: adminUser.facility,
      isActive: true,
      sessionId: "session-test-admin",
    };

    // 3. Grant active consent from patient to doctor for lab orders and prescriptions
    await ConsentArtifact.create({
      consentId: `CONSENT-STEP8-${timestamp}`,
      patientId: patientUser._id,
      requesterDoctorId: doctorUser._id,
      requesterFacility: doctorUser.facility,
      purpose: "Care Management & Diagnostics",
      hiTypes: ["DiagnosticReport", "Observation", "MedicationRequest", "Encounter"],
      dateRangeFrom: new Date("2026-01-01"),
      dateRangeTo: new Date("2026-12-31"),
      expiresAt: new Date(Date.now() + 30 * 86400000),
      status: "GRANTED",
      version: 1,
    });
  });

  // ==========================================
  // LABORATORY WORKFLOW TESTS (1 - 7)
  // ==========================================

  // 1. Authorized laboratory can view its assigned order
  it("1. Authorized laboratory can view its assigned order", async () => {
    // Doctor creates order assigned to Max Super Speciality Hospital
    testOrder = await createLaboratoryOrder(doctorPrincipal, {
      patientId: patientUser._id.toString(),
      targetFacility: "Max Super Speciality Hospital, Saket",
      testName: "Glycated Hemoglobin (HbA1c)",
      testCode: "LOINC-4548-4",
      priority: "ROUTINE",
      instructions: "Standard venipuncture in EDTA tube.",
    });

    assert.ok(testOrder);
    assert.strictEqual(testOrder.status, "ORDERED");
    assert.strictEqual(testOrder.targetFacility, "Max Super Speciality Hospital, Saket");

    // Laboratory from Max Super Speciality Hospital queries orders
    const orders = await getLaboratoryOrders(labPrincipal);
    assert.ok(orders.some((o) => o.orderId === testOrder.orderId));

    // Lab queries single order by ID
    const single = await getLaboratoryOrderById(labPrincipal, testOrder.orderId);
    assert.strictEqual(single.orderId, testOrder.orderId);
    assert.strictEqual(single.testName, "Glycated Hemoglobin (HbA1c)");
  });

  // 2. Laboratory cannot view another facility's order
  it("2. Laboratory cannot view another facility's order", async () => {
    // otherLabPrincipal is from Apollo Clinics, Indiranagar
    // testOrder is assigned to Max Super Speciality Hospital, Saket
    await assert.rejects(
      async () => {
        await getLaboratoryOrderById(otherLabPrincipal, testOrder.orderId);
      },
      (err: unknown) => {
        assert.ok(err instanceof ForbiddenError);
        assert.match((err as Error).message, /Cross-facility access denied|Facility mismatch/i);
        return true;
      }
    );

    // Also verify other lab's list does not contain testOrder
    const otherLabOrders = await getLaboratoryOrders(otherLabPrincipal);
    assert.strictEqual(
      otherLabOrders.some((o) => o.orderId === testOrder.orderId),
      false
    );
  });

  // 3. Laboratory cannot submit a report against an unrelated order
  it("3. Laboratory cannot submit a report against an unrelated order", async () => {
    await assert.rejects(
      async () => {
        await submitDiagnosticReport(otherLabPrincipal, testOrder.orderId, {
          title: "HbA1c Report",
          summary: "Normal blood sugar",
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof ForbiddenError);
        assert.match((err as Error).message, /Cross-facility access denied|Facility mismatch/i);
        return true;
      }
    );
  });

  // 4. Invalid FHIR references are rejected
  it("4. Invalid FHIR references are rejected", async () => {
    const invalidBasedOnFhir = {
      resourceType: "DiagnosticReport",
      id: "DR-INVALID-REF-01",
      status: "final",
      code: { text: "HbA1c Panel" },
      subject: { reference: `Patient/${patientUser._id.toString()}` },
      basedOn: [{ reference: "ServiceRequest/SOME-COMPLETELY-DIFFERENT-ORDER" }],
    };

    await assert.rejects(
      async () => {
        await submitDiagnosticReport(labPrincipal, testOrder.orderId, {
          title: "HbA1c Diagnostic Report",
          summary: "Glycated Hemoglobin 5.6%",
          diagnosticReportFhir: invalidBasedOnFhir,
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof InvalidQueryError);
        assert.match((err as Error).message, /basedOn reference does not match/i);
        return true;
      }
    );
  });

  // 5. Mismatched patient references are rejected
  it("5. Mismatched patient references are rejected", async () => {
    const mismatchedPatientFhir = {
      resourceType: "DiagnosticReport",
      id: "DR-MISMATCH-PATIENT",
      status: "final",
      code: { text: "HbA1c Panel" },
      subject: { reference: `Patient/${otherPatientUser._id.toString()}` }, // Patient 2 instead of Patient 1!
      basedOn: [{ reference: `ServiceRequest/${testOrder.orderId}` }],
    };

    await assert.rejects(
      async () => {
        await submitDiagnosticReport(labPrincipal, testOrder.orderId, {
          title: "HbA1c Diagnostic Report",
          summary: "Glycated Hemoglobin 5.6%",
          diagnosticReportFhir: mismatchedPatientFhir,
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof InvalidQueryError);
        assert.match(
          (err as Error).message,
          /Resource patient reference does not match|subject reference must match/i
        );
        return true;
      }
    );
  });

  // 6. A report cannot be submitted in an invalid state
  it("6. A report cannot be submitted in an invalid state", async () => {
    // First, submit a valid report to transition order to COMPLETED
    const submitResult = await submitDiagnosticReport(labPrincipal, testOrder.orderId, {
      title: "HbA1c Diagnostic Report",
      summary: "Glycated Hemoglobin 5.6% within reference range.",
      observations: [
        {
          code: "4548-4",
          name: "Hemoglobin A1c",
          value: 5.6,
          unit: "%",
          referenceRange: "4.0 - 5.6%",
          interpretation: "Normal",
        },
      ],
    });

    assert.ok(submitResult.reportRecordId);
    assert.strictEqual(submitResult.order.status, "COMPLETED");

    // Second attempt to submit against COMPLETED order must be rejected!
    await assert.rejects(
      async () => {
        await submitDiagnosticReport(labPrincipal, testOrder.orderId, {
          title: "Duplicate Report Submission",
          summary: "Attempting to overwrite completed report",
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof InvalidQueryError);
        assert.match((err as Error).message, /already been completed/i);
        return true;
      }
    );
  });

  // 7. Submitted reports retain correct source-institution metadata
  it("7. Submitted reports retain correct source-institution metadata", async () => {
    const sourceRecord = await SourceInstitutionRecord.findOne({
      careContextId: testOrder.orderId,
      resourceType: "DiagnosticReport",
    });

    assert.ok(sourceRecord);
    assert.strictEqual(sourceRecord.institutionName, "Max Super Speciality Hospital, Saket");
    assert.strictEqual(sourceRecord.institutionId, "HIP-MAX-001");
    assert.strictEqual(sourceRecord.institutionType, "laboratory");
    assert.strictEqual(sourceRecord.patientName, patientUser.name);
    assert.strictEqual(sourceRecord.isMockData, true);

    // Verify observation source record was also created
    const obsRecord = await SourceInstitutionRecord.findOne({
      careContextId: testOrder.orderId,
      resourceType: "Observation",
    });
    assert.ok(obsRecord);
    assert.strictEqual(obsRecord.institutionId, "HIP-MAX-001");
  });

  // ==========================================
  // PHARMACY WORKFLOW TESTS (8 - 15)
  // ==========================================

  // 8. Pharmacy can retrieve an eligible prescription
  it("8. Pharmacy can retrieve an eligible prescription", async () => {
    // Doctor creates a prescription for Patient
    testPrescription = await createPrescription(doctorPrincipal, {
      patientId: patientUser._id.toString(),
      medications: [
        {
          code: "RX-ATOR-20",
          name: "Atorvastatin Calcium",
          dosage: "20mg",
          frequency: "Once daily at night",
          durationDays: 30,
          quantity: 30,
        },
      ],
      maxRefills: 1,
      validityDays: 30,
    });

    assert.ok(testPrescription);
    assert.strictEqual(testPrescription.status, "ACTIVE");
    assert.strictEqual(testPrescription.remainingQuantity, 30);

    // Pharmacy retrieves eligible prescriptions
    const activePrescriptions = await getEligiblePrescriptions(pharmacyPrincipal);
    assert.ok(activePrescriptions.some((p) => p.prescriptionId === testPrescription.prescriptionId));

    // Pharmacy views prescription details
    const single = await getPrescriptionById(pharmacyPrincipal, testPrescription.prescriptionId);
    assert.strictEqual(single.prescriptionId, testPrescription.prescriptionId);
    assert.strictEqual(single.medications[0].name, "Atorvastatin Calcium");
  });

  // 9. Pharmacy cannot access a patient's general medical history
  it("9. Pharmacy cannot access a patient's general medical history", async () => {
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
  });

  // 10. Invalid or expired prescriptions are rejected
  it("10. Invalid or expired prescriptions are rejected", async () => {
    // Create an expired prescription
    const expiredRx = await Prescription.create({
      prescriptionId: `RX-EXPIRED-${Date.now()}`,
      patientId: patientUser._id,
      patientName: patientUser.name,
      doctorId: doctorUser._id,
      doctorName: doctorUser.name,
      facility: "Apollo Clinics, Indiranagar",
      medications: [
        {
          name: "Expired Antibiotic",
          dosage: "500mg",
          frequency: "Twice daily",
          durationDays: 7,
          quantity: 14,
          remainingQuantity: 14,
        },
      ],
      status: "ACTIVE",
      totalQuantity: 14,
      dispensedQuantity: 0,
      remainingQuantity: 14,
      remainingRefills: 0,
      prescribedAt: new Date(Date.now() - 40 * 86400000),
      expiresAt: new Date(Date.now() - 10 * 86400000), // Expired 10 days ago!
    });

    await assert.rejects(
      async () => {
        await recordDispensation(pharmacyPrincipal, expiredRx.prescriptionId, {
          quantityToDispense: 14,
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof InvalidQueryError);
        assert.match((err as Error).message, /expired and cannot be dispensed/i);
        return true;
      }
    );
  });

  // 11. Excessive dispensing quantities are rejected
  it("11. Excessive dispensing quantities are rejected", async () => {
    // testPrescription has 30 units remaining
    await assert.rejects(
      async () => {
        await recordDispensation(pharmacyPrincipal, testPrescription.prescriptionId, {
          quantityToDispense: 100, // Excessive: 100 > 30!
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof InvalidQueryError);
        assert.match((err as Error).message, /exceeds remaining authorized quantity/i);
        return true;
      }
    );
  });

  // 12. Duplicate requests are idempotent
  it("12. Duplicate requests are idempotent", async () => {
    const idempotencyKey = `IDEMP-TEST-${Date.now()}`;

    // First dispensation: dispense 10 units
    const firstResult = await recordDispensation(pharmacyPrincipal, testPrescription.prescriptionId, {
      quantityToDispense: 10,
      idempotencyKey,
      notes: "First partial dispense",
    });

    assert.strictEqual(firstResult.duplicate, undefined);
    assert.strictEqual(firstResult.prescription.remainingQuantity, 20);
    assert.strictEqual(firstResult.prescription.status, "PARTIALLY_DISPENSED");

    // Second dispensation with identical idempotencyKey: must return safely without re-decrementing
    const secondResult = await recordDispensation(pharmacyPrincipal, testPrescription.prescriptionId, {
      quantityToDispense: 10,
      idempotencyKey,
      notes: "Duplicate retry",
    });

    assert.strictEqual(secondResult.duplicate, true);
    assert.strictEqual(secondResult.prescription.remainingQuantity, 20); // Still 20, NOT 10!
  });

  // 13. Concurrent dispensing cannot exceed permitted fulfilment
  it("13. Concurrent dispensing cannot exceed permitted fulfilment", async () => {
    // Current testPrescription has 20 units remaining
    // Fire two concurrent dispensing requests each attempting to take 15 units (total 30 > 20!)
    const p1 = recordDispensation(pharmacyPrincipal, testPrescription.prescriptionId, {
      quantityToDispense: 15,
      idempotencyKey: `IDEMP-CONC-1-${Date.now()}`,
    });

    const p2 = recordDispensation(pharmacyPrincipal, testPrescription.prescriptionId, {
      quantityToDispense: 15,
      idempotencyKey: `IDEMP-CONC-2-${Date.now()}`,
    });

    const results = await Promise.allSettled([p1, p2]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    // Exactly one must succeed and one must be rejected to prevent over-dispensing!
    assert.strictEqual(fulfilled.length, 1);
    assert.strictEqual(rejected.length, 1);

    const checkRx = await Prescription.findOne({ prescriptionId: testPrescription.prescriptionId });
    assert.strictEqual(checkRx?.remainingQuantity, 5); // 20 - 15 = 5
  });

  // 14. Unauthorized facility access is denied
  it("14. Unauthorized facility access is denied", async () => {
    const unaffiliatedPharmacist: AuthenticatedPrincipal = {
      id: new mongoose.Types.ObjectId().toString(),
      abhaId: "99-9999-9999-9999",
      abhaAddress: "rogue@hfr.sbx",
      role: "pharmacy",
      name: "Rogue Pharmacist",
      facility: "", // Missing facility affiliation!
      isActive: true,
      sessionId: "session-rogue",
    };

    await assert.rejects(
      async () => {
        await recordDispensation(unaffiliatedPharmacist, testPrescription.prescriptionId, {
          quantityToDispense: 5,
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof ForbiddenError);
        assert.match((err as Error).message, /not affiliated with a registered pharmacy/i);
        return true;
      }
    );
  });

  // 15. Administrators cannot retrieve clinical prescription contents
  it("15. Administrators cannot retrieve clinical prescription contents", async () => {
    await assert.rejects(
      async () => {
        await getEligiblePrescriptions(adminPrincipal);
      },
      (err: unknown) => {
        assert.ok(err instanceof ForbiddenError);
        assert.match((err as Error).message, /Administrators are strictly forbidden/i);
        return true;
      }
    );

    await assert.rejects(
      async () => {
        await getPrescriptionById(adminPrincipal, testPrescription.prescriptionId);
      },
      (err: unknown) => {
        assert.ok(err instanceof ForbiddenError);
        assert.match((err as Error).message, /Administrators are strictly forbidden/i);
        return true;
      }
    );
  });

  // ==========================================
  // INTEGRATION TESTS (16 - 19)
  // ==========================================

  // 16. Doctor-created orders appear only in the assigned laboratory workflow
  it("16. Doctor-created orders appear only in the assigned laboratory workflow", async () => {
    const doctorOrder = await createLaboratoryOrder(doctorPrincipal, {
      patientId: patientUser._id.toString(),
      targetFacility: "Apollo Clinics, Indiranagar",
      testName: "Serum Electrolytes Panel",
      testCode: "LOINC-24362-6",
      priority: "STAT",
    });

    assert.ok(doctorOrder);

    // Doctor can view it in their created orders list
    const docOrders = await getDoctorLaboratoryOrders(doctorPrincipal);
    assert.ok(docOrders.some((o) => o.orderId === doctorOrder.orderId));

    // Apollo lab CAN see it
    const apolloLabOrders = await getLaboratoryOrders(otherLabPrincipal);
    assert.ok(apolloLabOrders.some((o) => o.orderId === doctorOrder.orderId));

    // Max lab CANNOT see it
    const maxLabOrders = await getLaboratoryOrders(labPrincipal);
    assert.strictEqual(
      maxLabOrders.some((o) => o.orderId === doctorOrder.orderId),
      false
    );
  });

  // 17. Valid lab reports enter the existing authorized record-exchange workflow
  it("17. Valid lab reports enter the existing authorized record-exchange workflow", async () => {
    // Query SourceInstitutionRecord at Max Super Speciality Hospital for DiagnosticReport
    const labReportsInHip = await SourceInstitutionRecord.find({
      institutionId: "HIP-MAX-001",
      resourceType: "DiagnosticReport",
      patientAbhaAddress: patientUser.abhaAddress,
    });

    assert.ok(labReportsInHip.length > 0);
    const reportRecord = labReportsInHip[0];

    // Verify it is a valid FHIR R4 DiagnosticReport
    const fhirValidation = validateFhirResource(reportRecord.fhirResource, {
      expectedPatientId: patientUser._id.toString(),
      expectedResourceType: "DiagnosticReport",
    });

    assert.strictEqual(fhirValidation.isValid, true);
    assert.strictEqual(reportRecord.status, "final");
  });

  // 18. Dispensing produces a valid FHIR MedicationDispense where applicable
  it("18. Dispensing produces a valid FHIR MedicationDispense where applicable", async () => {
    const dispEvent = await DispensingEvent.findOne({
      prescriptionId: testPrescription.prescriptionId,
    });

    assert.ok(dispEvent);
    assert.ok(dispEvent.fhirResource);
    assert.strictEqual(dispEvent.fhirResource.resourceType, "MedicationDispense");

    const validation = validateFhirResource(dispEvent.fhirResource, {
      expectedPatientId: patientUser._id.toString(),
      expectedResourceType: "MedicationDispense",
    });

    assert.strictEqual(validation.isValid, true);
  });

  // 19. Audit events are created without leaking secrets
  it("19. Audit events are created without leaking secrets", async () => {
    const auditLogs = await AuditLog.find({
      action: {
        $in: [
          "CREATE_LAB_ORDER",
          "SUBMIT_LAB_REPORT",
          "CREATE_PRESCRIPTION",
          "DISPENSE_MEDICATION",
          "DUPLICATE_DISPENSE_BLOCKED",
          "DISPENSE_REJECTED",
        ],
      },
    });

    assert.ok(auditLogs.length > 0);

    for (const log of auditLogs) {
      assert.ok(log.action);
      assert.ok(log.principalRole);
      assert.ok(log.outcome);

      // Verify no sensitive credentials or raw clinical blobs in metadata
      const metaString = JSON.stringify(log.metadata || {});
      assert.strictEqual(metaString.includes("otp"), false);
      assert.strictEqual(metaString.includes("password"), false);
      assert.strictEqual(metaString.includes("token"), false);
      assert.strictEqual(metaString.includes("session"), false);
    }
  });
});
