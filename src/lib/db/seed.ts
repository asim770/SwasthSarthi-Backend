import { connectToDatabase } from "./connect";
import { User } from "./models/User";
import { HealthRecord } from "./models/HealthRecord";
import { ConsentArtifact } from "./models/ConsentArtifact";
import { LabOrder } from "./models/LabOrder";
import { Prescription } from "./models/Prescription";

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
            name: "Atorvastatin Calcium",
            dosage: "10mg",
            frequency: "Once daily at bedtime",
            durationDays: 30,
            instructions: "Take with or without food.",
          },
          {
            name: "Metoprolol Succinate ER",
            dosage: "25mg",
            frequency: "Once daily morning",
            durationDays: 30,
            instructions: "Do not crush or chew tablet.",
          },
        ],
        status: "ACTIVE",
        remainingRefills: 2,
        prescribedAt: new Date("2026-10-02"),
        expiresAt: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000), // 60 days
        dispensedEvents: [],
      });
    }
  }
}
