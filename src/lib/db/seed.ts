import { connectToDatabase } from "./connect";
import { User } from "./models/User";
import { HealthRecord } from "./models/HealthRecord";
import { ConsentArtifact } from "./models/ConsentArtifact";
import { LabOrder } from "./models/LabOrder";
import { Prescription } from "./models/Prescription";
import { SourceInstitutionRecord } from "./models/SourceInstitutionRecord";
import { Facility } from "./models/Facility";
import { logAuditEvent } from "@/lib/dal/audit";

export const DEMO_IDENTITIES = [
  {
    abhaId: "32-8492-1920-4491",
    abhaAddress: "rahul.verma@sbx",
    name: "Rahul Verma",
    role: "patient" as const,
    isActive: true,
    phone: "+91-9876543210",
    email: "rahul.verma@synthetic.demo",
    gender: "Male",
    dateOfBirth: "1992-05-14",
  },
  {
    abhaId: "HPR-DEL-2026-9912",
    abhaAddress: "dr.ananya@hpr.sbx",
    name: "Dr. Ananya Sharma",
    role: "doctor" as const,
    isActive: true,
    phone: "+91-9876543211",
    email: "dr.ananya@synthetic.demo",
    facility: "Apollo Clinics, Indiranagar",
    specialization: "Cardiology",
  },
  {
    abhaId: "HFR-DEL-LAB-001",
    abhaAddress: "max.lab@hfr.sbx",
    name: "Max Diagnostic Laboratory",
    role: "laboratory" as const,
    isActive: true,
    phone: "+91-9876543212",
    email: "max.lab@synthetic.demo",
    facility: "Max Super Speciality Hospital, Saket",
  },
  {
    abhaId: "HFR-BLR-PHARM-042",
    abhaAddress: "apollo.rx@hfr.sbx",
    name: "Apollo Pharmacy Dispensation Hub",
    role: "pharmacy" as const,
    isActive: true,
    phone: "+91-9876543213",
    email: "apollo.rx@synthetic.demo",
    facility: "Apollo Health City",
  },
  {
    abhaId: "ADMIN-SHA-2026-001",
    abhaAddress: "admin.neha@swasth.sbx",
    name: "Neha Kapoor",
    role: "admin" as const,
    isActive: true,
    phone: "+91-9876543214",
    email: "admin.neha@synthetic.demo",
    facility: "State Health Authority (SHA)",
  },
  {
    abhaId: "99-9999-9999-9999",
    abhaAddress: "inactive.user@sbx",
    name: "Inactive Test Account",
    role: "patient" as const,
    isActive: false,
    phone: "+91-9876543299",
    email: "inactive@synthetic.demo",
  },
];

/**
 * Seed synthetic identities and clinical/workflow fixtures if not already present
 */
export async function seedDemoIdentities(): Promise<void> {
  await connectToDatabase();

  for (const identity of DEMO_IDENTITIES) {
    const existing = await User.findOne({
      $or: [
        { abhaId: identity.abhaId },
        { abhaAddress: identity.abhaAddress.toLowerCase() },
      ],
    });

    if (!existing) {
      await User.create(identity);
    }
  }

  const patient = await User.findOne({ abhaAddress: "rahul.verma@sbx" });
  const doctor = await User.findOne({ abhaAddress: "dr.ananya@hpr.sbx" });
  const labUser = await User.findOne({ abhaAddress: "max.lab@hfr.sbx" });

  if (patient && doctor) {
    // 1. Seed clinical health records for Rahul Verma
    const sampleRecords = [
      {
        recordId: "REC-2026-101",
        patientId: patient._id,
        title: "Comprehensive Metabolic & Lipid Panel",
        resourceType: "DiagnosticReport" as const,
        date: new Date("2026-10-18"),
        providerFacility: "Max Super Speciality Hospital, Saket",
        doctorName: "Dr. Arvind Saxena (Endocrinology)",
        status: "final",
        summary:
          "Fasting blood glucose 92 mg/dL. HbA1c 5.4%. Total cholesterol 178 mg/dL. Kidney and liver enzyme profiles within reference ranges.",
        careContextId: "MAX-DEL-ENC-2026-8812",
        fhirBundleId: "urn:uuid:7b3a98e2-c451-4091-bf92-12e840d708e1",
      },
      {
        recordId: "REC-2026-092",
        patientId: patient._id,
        title: "Cardiology Follow-up & 12-Lead ECG",
        resourceType: "Encounter" as const,
        date: new Date("2026-10-02"),
        providerFacility: "Apollo Clinics, Indiranagar",
        doctorName: "Dr. Ananya Sharma (Cardiology)",
        doctorId: doctor._id,
        status: "completed",
        summary:
          "Resting arterial BP 118/76 mmHg, pulse 72 bpm. 12-lead ECG confirms normal sinus rhythm without ischemic ST-T abnormalities.",
        careContextId: "APOLLO-BLR-OP-2026-4412",
        fhirBundleId: "urn:uuid:fa490b65-27a9-4670-bb5c-91544a055ff2",
      },
      {
        recordId: "REC-2026-074",
        patientId: patient._id,
        title: "Seasonal Quadrivalent Influenza Vaccine",
        resourceType: "Immunization" as const,
        date: new Date("2026-09-14"),
        providerFacility: "Fortis Hospital, Bannerghatta",
        doctorName: "Dr. Rajesh Iyer (Internal Medicine)",
        status: "completed",
        summary:
          "0.5mL intramuscular dose administered in left deltoid. Lot #FL2026-99A. Zero immediate adverse reactions observed.",
        careContextId: "FORTIS-BLR-IMM-2026-1092",
        fhirBundleId: "urn:uuid:31c6a6f1-a110-449e-b9a3-5c8e03bc0214",
      },
      {
        recordId: "REC-2026-055",
        patientId: patient._id,
        title: "Slit-Lamp & Non-Mydriatic Fundus Exam",
        resourceType: "Observation" as const,
        date: new Date("2026-08-28"),
        providerFacility: "Narayana Nethralaya",
        doctorName: "Dr. Meenakshi Sundaram (Ophthalmology)",
        status: "final",
        summary:
          "Intraocular pressure 14 mmHg OU. Clear media. Cup-to-disc ratio 0.3 without microaneurysms or diabetic retinopathy.",
        careContextId: "NN-BLR-OPH-2026-3391",
        fhirBundleId: "urn:uuid:99a8b7c6-1122-3344-5566-778899aabbcc",
      },
    ];

    for (const rec of sampleRecords) {
      const exists = await HealthRecord.findOne({ recordId: rec.recordId });
      if (!exists) {
        await HealthRecord.create(rec);
      }
    }

    // 2. Seed active electronic consent for Dr. Ananya Sharma from Rahul Verma
    // Covers DiagnosticReport and Encounter between 2026-09-01 and 2026-12-31
    const activeConsentExists = await ConsentArtifact.findOne({
      consentId: "CONSENT-ACTIVE-CARDIOLOGY-01",
    });
    if (!activeConsentExists) {
      await ConsentArtifact.create({
        consentId: "CONSENT-ACTIVE-CARDIOLOGY-01",
        patientId: patient._id,
        requesterDoctorId: doctor._id,
        requesterFacility: "Apollo Clinics, Indiranagar",
        purpose: "Cardiology Evaluation and Longitudinal Management",
        hiTypes: ["DiagnosticReport", "Encounter"],
        dateRangeFrom: new Date("2026-09-01"),
        dateRangeTo: new Date("2026-12-31"),
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days in future
        status: "GRANTED",
        grantedAt: new Date("2026-10-01"),
      });
    }

    // 3. Seed revoked consent for Observation
    const revokedConsentExists = await ConsentArtifact.findOne({
      consentId: "CONSENT-REVOKED-OPHTHAL-02",
    });
    if (!revokedConsentExists) {
      await ConsentArtifact.create({
        consentId: "CONSENT-REVOKED-OPHTHAL-02",
        patientId: patient._id,
        requesterDoctorId: doctor._id,
        requesterFacility: "Apollo Clinics, Indiranagar",
        purpose: "Ophthalmology Consultation",
        hiTypes: ["Observation"],
        dateRangeFrom: new Date("2026-01-01"),
        dateRangeTo: new Date("2026-12-31"),
        expiresAt: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000),
        status: "REVOKED",
        grantedAt: new Date("2026-08-01"),
        revokedAt: new Date("2026-09-01"),
      });
    }

    // 4. Seed expired consent
    const expiredConsentExists = await ConsentArtifact.findOne({
      consentId: "CONSENT-EXPIRED-PAST-03",
    });
    if (!expiredConsentExists) {
      await ConsentArtifact.create({
        consentId: "CONSENT-EXPIRED-PAST-03",
        patientId: patient._id,
        requesterDoctorId: doctor._id,
        requesterFacility: "Apollo Clinics, Indiranagar",
        purpose: "Historical General Health Checkup",
        hiTypes: ["Immunization"],
        dateRangeFrom: new Date("2025-01-01"),
        dateRangeTo: new Date("2025-12-31"),
        expiresAt: new Date("2026-01-01"), // In past
        status: "GRANTED",
        grantedAt: new Date("2025-01-05"),
      });
    }

    // 5. Seed pending consent request for Cardiology Review
    const pendingConsentExists = await ConsentArtifact.findOne({
      consentId: "CONSENT-PENDING-CARDIOLOGY-04",
    });
    if (!pendingConsentExists) {
      await ConsentArtifact.create({
        consentId: "CONSENT-PENDING-CARDIOLOGY-04",
        patientId: patient._id,
        requesterDoctorId: doctor._id,
        requesterFacility: "Apollo Clinics, Indiranagar",
        purpose: "Post-Operative Remote Cardiac Monitoring",
        hiTypes: ["DiagnosticReport", "Observation", "Encounter"],
        approvedHiTypes: [],
        dateRangeFrom: new Date("2026-08-01"),
        dateRangeTo: new Date("2026-12-31"),
        expiresAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000), // 14 days
        status: "PENDING",
        version: 1,
        decisionHistory: [
          {
            action: "REQUESTED",
            actorId: doctor._id,
            actorRole: "doctor",
            actorName: doctor.name,
            timestamp: new Date(),
            note: "Requested comprehensive cardiac records for telemetry review.",
          },
        ],
      });
    }

    // 6. Seed denied consent request for Dermatology
    const deniedConsentExists = await ConsentArtifact.findOne({
      consentId: "CONSENT-DENIED-DERM-05",
    });
    if (!deniedConsentExists) {
      await ConsentArtifact.create({
        consentId: "CONSENT-DENIED-DERM-05",
        patientId: patient._id,
        requesterDoctorId: doctor._id,
        requesterFacility: "Apollo Clinics, Indiranagar",
        purpose: "Dermatological Allergy Evaluation",
        hiTypes: ["Observation", "Immunization"],
        approvedHiTypes: [],
        dateRangeFrom: new Date("2026-01-01"),
        dateRangeTo: new Date("2026-06-30"),
        expiresAt: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000),
        status: "DENIED",
        version: 1,
        deniedAt: new Date("2026-10-15"),
        decisionHistory: [
          {
            action: "REQUESTED",
            actorId: doctor._id,
            actorRole: "doctor",
            actorName: doctor.name,
            timestamp: new Date("2026-10-14"),
            note: "Requested records for allergy consultation.",
          },
          {
            action: "DENIED",
            actorId: patient._id,
            actorRole: "patient",
            actorName: patient.name,
            timestamp: new Date("2026-10-15"),
            note: "Patient opted not to share allergy immunization history.",
          },
        ],
      });
    }

    // 5. Seed Lab Order for Max Diagnostic Laboratory
    const labOrderExists = await LabOrder.findOne({ orderId: "LAB-ORD-2026-001" });
    if (!labOrderExists) {
      await LabOrder.create({
        orderId: "LAB-ORD-2026-001",
        patientId: patient._id,
        patientName: patient.name,
        patientAbha: patient.abhaAddress,
        doctorId: doctor._id,
        doctorName: doctor.name,
        targetFacility: "Max Super Speciality Hospital, Saket",
        assignedLabId: labUser?._id,
        testName: "Lipid Profile & Serum Electrolytes Panel",
        testCode: "LOINC-24331-1",
        instructions: "12-hour fasting required prior to blood draw.",
        status: "ORDERED",
        priority: "ROUTINE",
        orderedAt: new Date(),
      });
    }

    // 6. Seed Prescription for Apollo Pharmacy
    const prescriptionExists = await Prescription.findOne({
      prescriptionId: "RX-2026-0042",
    });
    if (!prescriptionExists) {
      await Prescription.create({
        prescriptionId: "RX-2026-0042",
        patientId: patient._id,
        patientName: patient.name,
        doctorId: doctor._id,
        doctorName: doctor.name,
        facility: "Apollo Clinics, Indiranagar",
        medications: [
          {
            code: "RX-ATOR-10",
            name: "Atorvastatin Calcium",
            dosage: "10mg",
            frequency: "Once daily at bedtime",
            durationDays: 30,
            route: "oral",
            quantity: 30,
            remainingQuantity: 30,
            instructions: "Take with or without food.",
          },
          {
            code: "RX-METOP-25",
            name: "Metoprolol Succinate ER",
            dosage: "25mg",
            frequency: "Once daily morning",
            durationDays: 30,
            route: "oral",
            quantity: 30,
            remainingQuantity: 30,
            instructions: "Do not crush or chew tablet.",
          },
        ],
        status: "ACTIVE",
        totalQuantity: 60,
        dispensedQuantity: 0,
        remainingQuantity: 60,
        maxRefills: 2,
        remainingRefills: 2,
        prescribedAt: new Date("2026-10-02"),
        expiresAt: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000), // 60 days
        dispensedEvents: [],
      });
    }

    // 7. Seed Simulated Originating Healthcare Institutions (HIPs) Records
    const sourceRecords = [
      // Max Super Speciality Hospital, Saket (HIP-MAX-001)
      {
        recordId: "SRC-MAX-001",
        institutionId: "HIP-MAX-001",
        institutionName: "Max Super Speciality Hospital, Saket",
        institutionType: "hospital" as const,
        patientAbhaId: patient.abhaId,
        patientAbhaAddress: patient.abhaAddress,
        patientName: patient.name,
        careContextId: "MAX-DEL-ENC-2026-8812",
        careContextDescription: "Comprehensive Inpatient Cardiology & Metabolic Panel",
        resourceType: "DiagnosticReport",
        recordDate: new Date("2026-10-18T08:30:00Z"),
        status: "final",
        isMockData: true,
        fhirResource: {
          resourceType: "DiagnosticReport",
          id: "DR-MAX-2026-101",
          status: "final",
          code: {
            coding: [{ system: "http://loinc.org", code: "24331-1", display: "Lipid Panel with Direct LDL" }],
            text: "Comprehensive Lipid Profile & Liver Function Panel",
          },
          subject: { reference: `Patient/${patient._id.toString()}`, display: patient.name },
          effectiveDateTime: "2026-10-18T08:30:00Z",
          issued: "2026-10-18T14:00:00Z",
          performer: [{ display: "Max Super Speciality Hospital Diagnostic Division", reference: "Organization/HIP-MAX-001" }],
          conclusion: "Total cholesterol 178 mg/dL. Fasting glucose 92 mg/dL. HbA1c 5.4%. Normal renal and hepatic function.",
        },
      },
      {
        recordId: "SRC-MAX-002",
        institutionId: "HIP-MAX-001",
        institutionName: "Max Super Speciality Hospital, Saket",
        institutionType: "hospital" as const,
        patientAbhaId: patient.abhaId,
        patientAbhaAddress: patient.abhaAddress,
        patientName: patient.name,
        careContextId: "MAX-DEL-ENC-2026-8812",
        careContextDescription: "Cardiology Inpatient Stay & Telemetry Monitoring",
        resourceType: "Encounter",
        recordDate: new Date("2026-09-22T10:00:00Z"),
        status: "finished",
        isMockData: true,
        fhirResource: {
          resourceType: "Encounter",
          id: "ENC-MAX-2026-042",
          status: "finished",
          class: { system: "http://terminology.hl7.org/CodeSystem/v3-ActCode", code: "IMP", display: "Inpatient Encounter" },
          subject: { reference: `Patient/${patient._id.toString()}`, display: patient.name },
          period: { start: "2026-09-22T10:00:00Z", end: "2026-09-25T16:00:00Z" },
          reasonCode: [{ text: "Inpatient Cardiac Telemetry Monitoring & Stress Testing" }],
          serviceProvider: { reference: "Organization/HIP-MAX-001", display: "Max Super Speciality Hospital, Saket" },
        },
      },
      {
        recordId: "SRC-MAX-003",
        institutionId: "HIP-MAX-001",
        institutionName: "Max Super Speciality Hospital, Saket",
        institutionType: "hospital" as const,
        patientAbhaId: patient.abhaId,
        patientAbhaAddress: patient.abhaAddress,
        patientName: patient.name,
        careContextId: "MAX-DEL-ENC-2026-8812",
        careContextDescription: "Inpatient Discharge Documentation",
        resourceType: "DocumentReference",
        recordDate: new Date("2026-09-25T16:30:00Z"),
        status: "current",
        isMockData: true,
        fhirResource: {
          resourceType: "DocumentReference",
          id: "DOC-MAX-2026-881",
          status: "current",
          subject: { reference: `Patient/${patient._id.toString()}`, display: patient.name },
          date: "2026-09-25T16:30:00Z",
          description: "Cardiology Inpatient Discharge Summary & Follow-up Protocol",
          content: [{ attachment: { contentType: "application/pdf", title: "Discharge_Summary_Rahul_Verma.pdf" } }],
        },
      },

      // Apollo Clinics, Indiranagar (HIP-APOLLO-002)
      {
        recordId: "SRC-APO-001",
        institutionId: "HIP-APOLLO-002",
        institutionName: "Apollo Clinics, Indiranagar",
        institutionType: "clinic" as const,
        patientAbhaId: patient.abhaId,
        patientAbhaAddress: patient.abhaAddress,
        patientName: patient.name,
        careContextId: "APOLLO-BLR-OP-2026-4412",
        careContextDescription: "Outpatient Cardiology Follow-up & Review",
        resourceType: "Encounter",
        recordDate: new Date("2026-10-02T11:00:00Z"),
        status: "finished",
        isMockData: true,
        fhirResource: {
          resourceType: "Encounter",
          id: "ENC-APO-2026-092",
          status: "finished",
          class: { system: "http://terminology.hl7.org/CodeSystem/v3-ActCode", code: "AMB", display: "Ambulatory Clinic Visit" },
          subject: { reference: `Patient/${patient._id.toString()}`, display: patient.name },
          period: { start: "2026-10-02T11:00:00Z", end: "2026-10-02T11:45:00Z" },
          reasonCode: [{ text: "Post-discharge Outpatient Cardiology Review & 12-lead ECG" }],
          serviceProvider: { reference: "Organization/HIP-APOLLO-002", display: "Apollo Clinics, Indiranagar" },
        },
      },
      {
        recordId: "SRC-APO-002",
        institutionId: "HIP-APOLLO-002",
        institutionName: "Apollo Clinics, Indiranagar",
        institutionType: "clinic" as const,
        patientAbhaId: patient.abhaId,
        patientAbhaAddress: patient.abhaAddress,
        patientName: patient.name,
        careContextId: "APOLLO-BLR-OP-2026-4412",
        careContextDescription: "Cardiology Vital Signs Evaluation",
        resourceType: "Observation",
        recordDate: new Date("2026-10-02T11:15:00Z"),
        status: "final",
        isMockData: true,
        fhirResource: {
          resourceType: "Observation",
          id: "OBS-APO-2026-114",
          status: "final",
          code: {
            coding: [{ system: "http://loinc.org", code: "85354-9", display: "Blood Pressure Panel" }],
            text: "Resting Arterial Blood Pressure",
          },
          subject: { reference: `Patient/${patient._id.toString()}`, display: patient.name },
          effectiveDateTime: "2026-10-02T11:15:00Z",
          valueString: "118/76 mmHg (Sitting, right arm, pulse 72 bpm regular)",
        },
      },
      {
        recordId: "SRC-APO-003",
        institutionId: "HIP-APOLLO-002",
        institutionName: "Apollo Clinics, Indiranagar",
        institutionType: "clinic" as const,
        patientAbhaId: patient.abhaId,
        patientAbhaAddress: patient.abhaAddress,
        patientName: patient.name,
        careContextId: "APOLLO-BLR-OP-2026-4412",
        careContextDescription: "Cardiovascular Pharmacotherapy Protocol",
        resourceType: "MedicationRequest",
        recordDate: new Date("2026-10-02T11:40:00Z"),
        status: "active",
        isMockData: true,
        fhirResource: {
          resourceType: "MedicationRequest",
          id: "MED-APO-2026-042",
          status: "active",
          intent: "order",
          medicationCodeableConcept: { text: "Atorvastatin Calcium 20mg Tablet" },
          subject: { reference: `Patient/${patient._id.toString()}`, display: patient.name },
          authoredOn: "2026-10-02T11:40:00Z",
          dosageInstruction: [{ text: "1 tablet orally every night at bedtime for 30 days" }],
        },
      },

      // Dr. Lal PathLabs Central Reference Lab (HIP-LAL-003)
      {
        recordId: "SRC-LAL-001",
        institutionId: "HIP-LAL-003",
        institutionName: "Dr. Lal PathLabs Central Reference Lab",
        institutionType: "laboratory" as const,
        patientAbhaId: patient.abhaId,
        patientAbhaAddress: patient.abhaAddress,
        patientName: patient.name,
        careContextId: "LAL-DEL-BIO-2026-9901",
        careContextDescription: "Biochemistry & Glycemic Index Evaluation",
        resourceType: "DiagnosticReport",
        recordDate: new Date("2026-09-10T07:45:00Z"),
        status: "final",
        isMockData: true,
        fhirResource: {
          resourceType: "DiagnosticReport",
          id: "DR-LAL-2026-302",
          status: "final",
          code: {
            coding: [{ system: "http://loinc.org", code: "4548-4", display: "HbA1c / Glycated Hemoglobin" }],
            text: "Glycated Hemoglobin HbA1c & Fasting Plasma Glucose",
          },
          subject: { reference: `Patient/${patient._id.toString()}`, display: patient.name },
          effectiveDateTime: "2026-09-10T07:45:00Z",
          issued: "2026-09-10T12:00:00Z",
          performer: [{ display: "Dr. Lal PathLabs Central Reference Lab, Rohini", reference: "Organization/HIP-LAL-003" }],
          conclusion: "HbA1c is 5.4% (Estimated Average Glucose 108 mg/dL). Fasting glucose 88 mg/dL. Demonstrates excellent metabolic and glycemic control.",
        },
      },
      {
        recordId: "SRC-LAL-002",
        institutionId: "HIP-LAL-003",
        institutionName: "Dr. Lal PathLabs Central Reference Lab",
        institutionType: "laboratory" as const,
        patientAbhaId: patient.abhaId,
        patientAbhaAddress: patient.abhaAddress,
        patientName: patient.name,
        careContextId: "LAL-DEL-BIO-2026-9901",
        careContextDescription: "Biochemistry Referral Order",
        resourceType: "ServiceRequest",
        recordDate: new Date("2026-09-10T12:15:00Z"),
        status: "active",
        isMockData: true,
        fhirResource: {
          resourceType: "ServiceRequest",
          id: "SR-LAL-2026-501",
          status: "active",
          intent: "order",
          priority: "routine",
          code: { text: "Routine Follow-up Glycemic & Lipid Profiling in 90 Days" },
          subject: { reference: `Patient/${patient._id.toString()}`, display: patient.name },
          authoredOn: "2026-09-10T12:15:00Z",
        },
      },

      // Fortis Hospital, Bannerghatta Road (HIP-FORTIS-004)
      {
        recordId: "SRC-FOR-001",
        institutionId: "HIP-FORTIS-004",
        institutionName: "Fortis Hospital, Bannerghatta Road",
        institutionType: "speciality" as const,
        patientAbhaId: patient.abhaId,
        patientAbhaAddress: patient.abhaAddress,
        patientName: patient.name,
        careContextId: "FORTIS-BLR-IMM-2026-1092",
        careContextDescription: "Preventive Immunization & Travel Health",
        resourceType: "Immunization",
        recordDate: new Date("2026-09-14T15:20:00Z"),
        status: "completed",
        isMockData: true,
        fhirResource: {
          resourceType: "Immunization",
          id: "IMM-FOR-2026-771",
          status: "completed",
          vaccineCode: {
            coding: [{ system: "http://hl7.org/fhir/sid/cvx", code: "197", display: "Influenza, seasonal, quadrivalent" }],
            text: "Influenza, seasonal quadrivalent 0.5 mL",
          },
          patient: { reference: `Patient/${patient._id.toString()}`, display: patient.name },
          occurrenceDateTime: "2026-09-14T15:20:00Z",
          lotNumber: "FL2026-99A",
          primarySource: true,
        },
      },
      {
        recordId: "SRC-FOR-002",
        institutionId: "HIP-FORTIS-004",
        institutionName: "Fortis Hospital, Bannerghatta Road",
        institutionType: "speciality" as const,
        patientAbhaId: patient.abhaId,
        patientAbhaAddress: patient.abhaAddress,
        patientName: patient.name,
        careContextId: "FORTIS-BLR-IMM-2026-1092",
        careContextDescription: "Hospital Pharmacy Medication Dispensation",
        resourceType: "MedicationDispense",
        recordDate: new Date("2026-09-15T10:00:00Z"),
        status: "completed",
        isMockData: true,
        fhirResource: {
          resourceType: "MedicationDispense",
          id: "DISP-FOR-2026-904",
          status: "completed",
          medicationCodeableConcept: { text: "Ramipril 2.5mg Capsule (30 Capsules)" },
          subject: { reference: `Patient/${patient._id.toString()}`, display: patient.name },
          whenHandedOver: "2026-09-15T10:00:00Z",
          quantity: { value: 30, unit: "capsules" },
        },
      },
    ];

    for (const src of sourceRecords) {
      const exists = await SourceInstitutionRecord.findOne({ recordId: src.recordId });
      if (!exists) {
        await SourceInstitutionRecord.create(src);
      }
    }

    // 8. Seed initial verified facilities for Step 9 Onboarding
    const adminUser = await User.findOne({ role: "admin" });
    if (adminUser) {
      const demoFacilities = [
        {
          facilityId: "IN0710000001",
          name: "Max Super Speciality Hospital, Saket",
          type: "HOSPITAL" as const,
          status: "APPROVED" as const,
          city: "New Delhi",
          state: "Delhi",
          contactPhone: "+91-11-26515050",
          contactEmail: "admin@maxhealth.demo",
          demoHfrId: "IN0710000001",
          registeredBy: adminUser._id,
          registeredByName: adminUser.name,
          verifiedBy: adminUser._id,
          verifiedByName: adminUser.name,
          verifiedAt: new Date(),
        },
        {
          facilityId: "IN2910000002",
          name: "Apollo Clinics, Indiranagar",
          type: "CLINIC" as const,
          status: "APPROVED" as const,
          city: "Bengaluru",
          state: "Karnataka",
          contactPhone: "+91-80-25219900",
          contactEmail: "blr.indiranagar@apollo.demo",
          demoHfrId: "IN2910000002",
          registeredBy: adminUser._id,
          registeredByName: adminUser.name,
          verifiedBy: adminUser._id,
          verifiedByName: adminUser.name,
          verifiedAt: new Date(),
        },
        {
          facilityId: "IN3610000003",
          name: "Apollo Health City",
          type: "PHARMACY" as const,
          status: "APPROVED" as const,
          city: "Hyderabad",
          state: "Telangana",
          contactPhone: "+91-40-23607777",
          contactEmail: "pharmacy@apollohealth.demo",
          demoHfrId: "IN3610000003",
          registeredBy: adminUser._id,
          registeredByName: adminUser.name,
          verifiedBy: adminUser._id,
          verifiedByName: adminUser.name,
          verifiedAt: new Date(),
        },
        {
          facilityId: "IN0710000004",
          name: "Dr. Lal PathLabs, Delhi Central",
          type: "LABORATORY" as const,
          status: "APPROVED" as const,
          city: "New Delhi",
          state: "Delhi",
          contactPhone: "+91-11-39885050",
          contactEmail: "central.lab@drlal.demo",
          demoHfrId: "IN0710000004",
          registeredBy: adminUser._id,
          registeredByName: adminUser.name,
          verifiedBy: adminUser._id,
          verifiedByName: adminUser.name,
          verifiedAt: new Date(),
        },
        {
          facilityId: "IN0710000099",
          name: "Sunrise Community Diagnostic Centre",
          type: "LABORATORY" as const,
          status: "PENDING" as const,
          city: "New Delhi",
          state: "Delhi",
          contactPhone: "+91-11-45009911",
          contactEmail: "onboarding@sunriselab.demo",
          demoHfrId: "IN0710000099",
          registeredBy: adminUser._id,
          registeredByName: adminUser.name,
        },
      ];

      for (const fac of demoFacilities) {
        const facExists = await Facility.findOne({ facilityId: fac.facilityId });
        if (!facExists) {
          await Facility.create(fac);
        }
      }
    }
  }
}

// Enable direct execution via tsx src/lib/db/seed.ts
if (typeof process !== "undefined" && process.argv[1] && process.argv[1].includes("seed.ts")) {
  seedDemoIdentities()
    .then(() => {
      console.log("✅ Synthetic demo identities and healthcare fixtures seeded successfully.");
      process.exit(0);
    })
    .catch((err) => {
      console.error("❌ Failed to seed database:", err);
      process.exit(1);
    });
}

