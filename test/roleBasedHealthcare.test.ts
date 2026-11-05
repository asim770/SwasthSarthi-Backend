import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { NextRequest } from "next/server";
import { connectToDatabase } from "../src/lib/db/connect";
import { User } from "../src/lib/db/models/User";
import { HealthRecord } from "../src/lib/db/models/HealthRecord";
import { Prescription } from "../src/lib/db/models/Prescription";
import { DispensingEvent } from "../src/lib/db/models/DispensingEvent";
import { ConsentArtifact } from "../src/lib/db/models/ConsentArtifact";
import { createSession } from "../src/lib/auth/session";

import { POST as signupHandler } from "../src/app/api/v1/auth/signup/route";
import { POST as loginHandler } from "../src/app/api/v1/auth/login/route";
import { POST as reviewPractitionerHandler } from "../src/app/api/v1/admin/practitioners/[id]/review/route";
import { GET as patientByPidHandler } from "../src/app/api/v1/patients/by-patient-id/[patientId]/route";
import { POST as consentsHandler, GET as getConsentsHandler } from "../src/app/api/v1/consents/route";
import { PATCH as consentDecisionHandler } from "../src/app/api/v1/consents/[id]/route";
import { POST as consultationHandler } from "../src/app/api/v1/records/consultations/route";
import { POST as directLabReportHandler } from "../src/app/api/v1/laboratory/reports/route";
import { POST as dispenseHandler } from "../src/app/api/v1/pharmacy/dispenses/route";
import { GET as patientInfoHandler } from "../src/app/api/v1/patients/[id]/info/route";

async function createAuthenticatedSession(user: any): Promise<string> {
  const res = await createSession(user._id, user.role);
  return `ss_session=${res.rawSessionToken}`;
}

describe("SwasthSaarthi — Role-Based Healthcare System & Unified Medical Records Suite", () => {
  let adminUser: any;
  let adminCookie: string;

  let patientUser: any;
  let patientCookie: string;
  let patientIdGenerated: string;

  let doctorUser: any;
  let doctorCookie: string;

  let labUser: any;
  let labCookie: string;

  let pharmacyUser: any;
  let pharmacyCookie: string;

  let createdConsentId: string;
  let createdPrescriptionId: string;

  before(async () => {
    await connectToDatabase();

    // Clean up test users from previous runs
    await User.deleteMany({
      email: {
        $in: [
          "pooja.hegde.unified@example.com",
          "dr.vikram.seth@example.com",
          "drlal.metropolis@example.com",
          "apollo.carepharm@example.com",
          "private.patient@synthetic.demo",
        ],
      },
    });

    // 1. Ensure or find admin user
    adminUser = await User.findOne({ role: "admin" });
    if (!adminUser) {
      adminUser = await User.create({
        name: "Super Administrator",
        email: "super.admin.unified@synthetic.demo",
        role: "admin",
        isActive: true,
        accountStatus: "active",
        phone: "+91-9876543200",
        abhaId: "91-9999-9999-9999",
        abhaAddress: "superadmin.unified@sbx",
        verificationStatus: "APPROVED",
      });
    }
    adminCookie = await createAuthenticatedSession(adminUser);
  });

  test("1. Patient signs up and receives permanent unique Patient ID (SS-PAT-XXXXXX)", async () => {
    const req = new NextRequest("http://localhost:3000/api/v1/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        role: "patient",
        name: "Pooja Hegde",
        email: "pooja.hegde.unified@example.com",
        password: "StrongPassword123!",
        confirmPassword: "StrongPassword123!",
        phone: "+91-9876543211",
        gender: "Female",
        dateOfBirth: "1994-05-15",
      }),
    });
    const res = await signupHandler(req);
    const body = await res.json();

    assert.equal(res.status, 201);
    assert.ok(body.data.patientId);
    assert.match(body.data.patientId, /^SS-PAT-\d{6}$/);
    patientIdGenerated = body.data.patientId;

    // Activate patient for subsequent tests
    patientUser = await User.findOne({ patientId: patientIdGenerated });
    patientUser.accountStatus = "active";
    patientUser.isEmailVerified = true;
    patientUser.verificationStatus = "APPROVED";
    await patientUser.save();

    patientCookie = await createAuthenticatedSession(patientUser);
    assert.ok(patientCookie);
  });

  test("2. Doctor registers and account status is PENDING administrator verification", async () => {
    const req = new NextRequest("http://localhost:3000/api/v1/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        role: "doctor",
        name: "Dr. Vikram Seth",
        email: "dr.vikram.seth@example.com",
        password: "DoctorPassword123!",
        confirmPassword: "DoctorPassword123!",
        phone: "+91-9876543212",
        medicalQualification: "MBBS, MD (Cardiology)",
        specialization: "Cardiology",
        registrationNumber: "MCI-CARD-94821",
        hospitalOrClinicName: "City Heart Institute",
        address: "74 Medical Enclave, New Delhi",
      }),
    });
    const res = await signupHandler(req);
    const body = await res.json();

    assert.equal(res.status, 201);
    assert.equal(body.data.pendingApproval, true);
    assert.equal(body.data.user.role, "doctor");
    assert.equal(body.data.user.verificationStatus, "PENDING");
    assert.equal(body.data.user.patientId, undefined); // Doctors do not receive patient IDs

    doctorUser = await User.findById(body.data.user.id);
    assert.ok(doctorUser);
    assert.equal(doctorUser.verificationStatus, "PENDING");

    doctorCookie = await createAuthenticatedSession(doctorUser);
  });

  test("3. Unapproved doctor is blocked from operational clinical workflows (receives 403 Forbidden)", async () => {
    // Attempting to submit a consultation while in PENDING status
    const req = new NextRequest("http://localhost:3000/api/v1/records/consultations", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: doctorCookie,
      },
      body: JSON.stringify({
        patientId: patientIdGenerated,
        symptoms: "Chest tightness and palpitations",
        diagnosis: "Suspected Angina",
        treatmentPlan: "Rest and ECG recommended",
      }),
    });
    const res = await consultationHandler(req);
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.match(body.error.message, /Account verification pending/);
  });

  test("4. Administrator reviews and approves Doctor, Laboratory, and Pharmacy accounts", async () => {
    // Register Lab
    const labReq = new NextRequest("http://localhost:3000/api/v1/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        role: "laboratory",
        name: "Dr. Lal Metropolis Lab",
        email: "drlal.metropolis@example.com",
        password: "LabPassword123!",
        confirmPassword: "LabPassword123!",
        phone: "+91-9876543213",
        organizationName: "Metropolis Diagnostics Hub",
        registrationNumber: "NABL-LAB-84920",
        authorizedRepresentative: "Rajesh Kumar (Chief Biochemist)",
        address: "12 Diagnostic Row, Gurugram",
      }),
    });
    const labRes = await signupHandler(labReq);
    const labBody = await labRes.json();
    labUser = await User.findById(labBody.data.user.id);

    // Register Pharmacy
    const pharmReq = new NextRequest("http://localhost:3000/api/v1/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        role: "pharmacy",
        name: "Apollo Care Pharmacy",
        email: "apollo.carepharm@example.com",
        password: "PharmPassword123!",
        confirmPassword: "PharmPassword123!",
        phone: "+91-9876543214",
        organizationName: "Apollo Care Pharmacy",
        registrationNumber: "DL-20B-10829",
        authorizedRepresentative: "Anita Roy (Lead Pharmacist)",
        address: "Gate 2 Apollo Hospital, New Delhi",
      }),
    });
    const pharmRes = await signupHandler(pharmReq);
    const pharmBody = await pharmRes.json();
    pharmacyUser = await User.findById(pharmBody.data.user.id);

    // Administrator approves Doctor
    const approveDocReq = new NextRequest(
      `http://localhost:3000/api/v1/admin/practitioners/${doctorUser._id}/review`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: adminCookie },
        body: JSON.stringify({ decision: "APPROVED", reason: "Credentials and license verified" }),
      }
    );
    const docApproveRes = await reviewPractitionerHandler(approveDocReq, {
      params: Promise.resolve({ id: doctorUser._id.toString() }),
    });
    assert.equal(docApproveRes.status, 200);

    // Refresh doctor user & session
    doctorUser = await User.findById(doctorUser._id);
    assert.equal(doctorUser.verificationStatus, "APPROVED");
    doctorCookie = await createAuthenticatedSession(doctorUser);

    // Administrator approves Lab
    const approveLabReq = new NextRequest(
      `http://localhost:3000/api/v1/admin/practitioners/${labUser._id}/review`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: adminCookie },
        body: JSON.stringify({ decision: "APPROVED", reason: "NABL certification verified" }),
      }
    );
    const labApproveRes = await reviewPractitionerHandler(approveLabReq, {
      params: Promise.resolve({ id: labUser._id.toString() }),
    });
    assert.equal(labApproveRes.status, 200);
    labUser = await User.findById(labUser._id);
    labCookie = await createAuthenticatedSession(labUser);

    // Administrator approves Pharmacy
    const approvePharmReq = new NextRequest(
      `http://localhost:3000/api/v1/admin/practitioners/${pharmacyUser._id}/review`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: adminCookie },
        body: JSON.stringify({ decision: "APPROVED", reason: "Drug License verified" }),
      }
    );
    const pharmApproveRes = await reviewPractitionerHandler(approvePharmReq, {
      params: Promise.resolve({ id: pharmacyUser._id.toString() }),
    });
    assert.equal(pharmApproveRes.status, 200);
    pharmacyUser = await User.findById(pharmacyUser._id);
    pharmacyCookie = await createAuthenticatedSession(pharmacyUser);
  });

  test("5. Doctor searches patient using Patient ID and receives minimum non-sensitive info", async () => {
    const req = new NextRequest(
      `http://localhost:3000/api/v1/patients/by-patient-id/${patientIdGenerated}`,
      {
        method: "GET",
        headers: { Cookie: doctorCookie },
      }
    );
    const res = await patientByPidHandler(req, {
      params: Promise.resolve({ patientId: patientIdGenerated }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();

    assert.equal(body.data.patientId, patientIdGenerated);
    assert.equal(body.data.name, "Pooja Hegde");
  });

  test("6. Doctor requests access (consent) and patient approves request", async () => {
    // Doctor creates consent request
    const reqConsent = new NextRequest("http://localhost:3000/api/v1/consents", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: doctorCookie },
      body: JSON.stringify({
        patientId: patientUser._id.toString(),
        purpose: "Comprehensive Cardiology Evaluation",
        hiTypes: ["DiagnosticReport", "Encounter", "MedicationRequest", "MedicationDispense"],
        dateRangeFrom: new Date(Date.now() - 365 * 86400000).toISOString(),
        dateRangeTo: new Date().toISOString(),
        expireDurationDays: 14,
      }),
    });
    const consentRes = await consentsHandler(reqConsent);
    assert.equal(consentRes.status, 201);
    const consentBody = await consentRes.json();
    createdConsentId = consentBody.data.consentId;
    assert.ok(createdConsentId);

    // Patient approves consent
    const approveReq = new NextRequest(
      `http://localhost:3000/api/v1/consents/${createdConsentId}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Cookie: patientCookie },
        body: JSON.stringify({
          decision: "APPROVED",
          note: "Approved for Dr. Vikram Seth cardiology review",
        }),
      }
    );
    const approveRes = await consentDecisionHandler(approveReq, {
      params: Promise.resolve({ id: createdConsentId }),
    });
    assert.equal(approveRes.status, 200);
    const approveBody = await approveRes.json();
    assert.ok(["APPROVED", "GRANTED"].includes(approveBody.data.status));
  });

  test("7. Doctor submits consultation report with diagnosis, prescription, and lab order", async () => {
    const req = new NextRequest("http://localhost:3000/api/v1/records/consultations", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: doctorCookie },
      body: JSON.stringify({
        patientId: patientIdGenerated,
        symptoms: "Exertional dyspnea and episodic dizziness",
        clinicalFindings: "BP 138/88 mmHg, regular rhythm, no murmurs",
        diagnosis: "Stage 1 Essential Hypertension",
        treatmentPlan: "Lifestyle modification, low sodium diet, and Telmisartan therapy",
        prescribedMedicines: [
          {
            name: "Telmisartan",
            dosage: "40mg",
            frequency: "Once daily morning",
            durationDays: 30,
            quantity: 30,
            instructions: "Take after breakfast with water",
          },
        ],
        recommendedTests: [
          {
            testName: "Lipid Profile Comprehensive",
            priority: "ROUTINE",
            instructions: "12-hour fasting required",
          },
        ],
        followUpDate: "2026-12-05",
        clinicalNotes: "Patient to monitor home BP twice weekly.",
      }),
    });

    const res = await consultationHandler(req);
    assert.equal(res.status, 201);
    const body = await res.json();

    assert.ok(body.data.consultationRecord);
    assert.equal(body.data.consultationRecord.resourceType, "Encounter");
    assert.ok(body.data.prescriptionId);
    createdPrescriptionId = body.data.prescriptionId;
    assert.ok(body.data.labOrderIds && body.data.labOrderIds.length > 0);
  });

  test("8. Laboratory uploads diagnostic test report linked to Patient ID", async () => {
    const req = new NextRequest("http://localhost:3000/api/v1/laboratory/reports", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: labCookie },
      body: JSON.stringify({
        patientId: patientIdGenerated,
        testName: "Lipid Profile Comprehensive",
        testCategory: "Biochemistry",
        testDate: new Date().toISOString(),
        observations: [
          {
            code: "2093-3",
            name: "Total Cholesterol",
            value: 195,
            unit: "mg/dL",
            referenceRange: "125 - 200 mg/dL",
            interpretation: "Normal",
          },
          {
            code: "2085-9",
            name: "HDL Cholesterol",
            value: 52,
            unit: "mg/dL",
            referenceRange: "> 40 mg/dL",
            interpretation: "Normal",
          },
          {
            code: "13457-7",
            name: "LDL Cholesterol",
            value: 118,
            unit: "mg/dL",
            referenceRange: "< 100 mg/dL",
            interpretation: "Borderline High",
          },
        ],
        technicianName: "Rajesh Kumar (Senior Biochemist)",
        laboratoryName: "Metropolis Diagnostics Hub",
        notes: "Specimen lipemic index normal. Tested on calibrated auto-analyzer.",
      }),
    });

    const res = await directLabReportHandler(req);
    assert.equal(res.status, 201);
    const body = await res.json();

    assert.ok(body.data.reportRecordId);
    assert.ok(body.data.healthRecord);
    assert.equal(body.data.healthRecord.resourceType, "DiagnosticReport");
  });

  test("9. Pharmacy searches active prescription by Patient ID and submits medicine dispensing record", async () => {
    assert.ok(createdPrescriptionId);

    const req = new NextRequest("http://localhost:3000/api/v1/pharmacy/dispenses", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: pharmacyCookie },
      body: JSON.stringify({
        prescriptionId: createdPrescriptionId,
        quantityToDispense: 30,
        batchNumber: "BATCH-TELM-2026",
        notes: "Dispensed 30 tablets of Telmisartan 40mg. Advised on dosage compliance.",
      }),
    });

    const res = await dispenseHandler(req);
    assert.equal(res.status, 201);
    const body = await res.json();

    assert.equal(body.data.prescription.status, "DISPENSED");
    assert.equal(body.data.dispensingEvent.quantityDispensed, 30);
  });

  test("10. Patient Dashboard fetches unified records — all doctor reports, lab results, prescriptions, and dispensations are present", async () => {
    const req = new NextRequest(
      `http://localhost:3000/api/v1/patients/${patientIdGenerated}/info`,
      {
        method: "GET",
        headers: { Cookie: patientCookie },
      }
    );
    const res = await patientInfoHandler(req, {
      params: Promise.resolve({ id: patientIdGenerated }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();

    assert.equal(body.data.patient.patientId, patientIdGenerated);
    assert.ok(body.data.clinicalRecords.length >= 3); // Encounter, MedicationRequest, DiagnosticReport, etc.

    const recordTypes = body.data.clinicalRecords.map((r: any) => r.resourceType);
    assert.ok(recordTypes.includes("Encounter")); // Doctor Consultation
    assert.ok(recordTypes.includes("DiagnosticReport")); // Lab Report
    assert.ok(recordTypes.includes("MedicationRequest")); // Doctor Prescription

    assert.ok(body.data.prescriptions.length >= 1);
    assert.ok(body.data.dispensingEvents.length >= 1);
    assert.equal(body.data.dispensingEvents[0].batchNumber, "BATCH-TELM-2026");
  });

  test("11. Security: Patient cannot access another patient's medical records (IDOR protection)", async () => {
    const anotherPatient = await User.create({
      patientId: "SS-PAT-999999",
      name: "Private Patient",
      email: "private.patient@synthetic.demo",
      role: "patient",
      isActive: true,
      phone: "+91-9999999999",
      abhaId: "91-0000-0000-0001",
      abhaAddress: "private@sbx",
      verificationStatus: "APPROVED",
    });

    const req = new NextRequest(
      `http://localhost:3000/api/v1/patients/${anotherPatient.patientId}/info`,
      {
        method: "GET",
        headers: { Cookie: patientCookie }, // Pooja Hegde trying to access Private Patient's record
      }
    );
    const res = await patientInfoHandler(req, {
      params: Promise.resolve({ id: anotherPatient.patientId as string }),
    });
    assert.equal(res.status, 403);
  });

  test("12. Security: Administrator cannot access clinical contents (administrative segregation)", async () => {
    const req = new NextRequest(
      `http://localhost:3000/api/v1/patients/${patientIdGenerated}/info`,
      {
        method: "GET",
        headers: { Cookie: adminCookie }, // Admin requesting clinical info
      }
    );
    const res = await patientInfoHandler(req, {
      params: Promise.resolve({ id: patientIdGenerated }),
    });
    const body = await res.json();
    assert.equal(res.status, 200);
    // Administrator only receives profile metadata, not clinical records or prescriptions
    assert.equal(body.data.clinicalRecords.length, 0);
    assert.equal(body.data.prescriptions.length, 0);
  });
});
