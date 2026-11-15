import { NextRequest, NextResponse } from "next/server";
import mongoose from "mongoose";
import { requireAuthenticatedUser, handleDalError } from "@/lib/dal";
import { ForbiddenError } from "@/lib/dal/errors";
import { apiSuccess } from "@/lib/api/response";
import { handleCorsPreflight } from "@/lib/api/cors";
import { connectToDatabase } from "@/lib/db/connect";
import { User, IUser } from "@/lib/db/models/User";
import { HealthRecord, IHealthRecord } from "@/lib/db/models/HealthRecord";
import { Prescription } from "@/lib/db/models/Prescription";
import { LabOrder } from "@/lib/db/models/LabOrder";

export interface TreatedPatientItem {
  patient: {
    _id: string;
    id: string;
    patientId: string;
    name: string;
    gender?: string;
    dateOfBirth?: string;
    abhaAddress?: string;
    abhaId?: string;
    phone?: string;
    email?: string;
  };
  lastConsultationDate: string;
  latestDiagnosis: string;
  latestTreatmentPlan: string;
  latestSymptoms?: string;
  latestClinicalFindings?: string;
  prescribedMedicines?: Array<{
    name: string;
    dosage: string;
    frequency: string;
    durationDays?: number;
    instructions?: string;
  }>;
  recommendedTests?: Array<{
    testName: string;
    testCode?: string;
    priority?: string;
    instructions?: string;
  }>;
  followUpDate?: string;
  clinicalNotes?: string;
  totalConsultations: number;
  totalPrescriptions: number;
  totalLabOrders: number;
}

export async function OPTIONS(request: NextRequest): Promise<NextResponse> {
  return handleCorsPreflight(request);
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const principal = await requireAuthenticatedUser(request);
    if (principal.role !== "doctor") {
      throw new ForbiddenError("Only licensed medical practitioners may access consulted patient registries.");
    }

    await connectToDatabase();
    const doctorObjId = new mongoose.Types.ObjectId(principal.id);

    // 1. Find all health records authored by or assigned to this doctor
    const doctorRecords = await HealthRecord.find({
      $or: [
        { doctorId: doctorObjId },
        { doctorName: { $regex: principal.name.replace(/^Dr\.\s*/i, ""), $options: "i" } },
      ],
    }).sort({ date: -1 });

    // Collect patient IDs who received consultation/treatment from this doctor
    const patientIds = new Set<string>();
    doctorRecords.forEach((r) => {
      if (r.patientId) patientIds.add(r.patientId.toString());
    });

    // Also check Prescriptions authored by this doctor
    const doctorPrescriptions = await Prescription.find({
      $or: [
        { doctorId: doctorObjId },
        { doctorName: { $regex: principal.name.replace(/^Dr\.\s*/i, ""), $options: "i" } },
      ],
    });
    doctorPrescriptions.forEach((p) => {
      if (p.patientId) patientIds.add(p.patientId.toString());
    });

    const treatedList: TreatedPatientItem[] = [];

    for (const pId of Array.from(patientIds)) {
      const patient = await User.findById(pId);
      if (!patient) continue;

      // Find encounters/records for this patient from this doctor or overall
      const patientRecords = await HealthRecord.find({
        patientId: patient._id,
      }).sort({ date: -1 });

      const doctorSpecificRecords = patientRecords.filter(
        (r) =>
          (r.doctorId && r.doctorId.toString() === principal.id) ||
          (r.doctorName && r.doctorName.toLowerCase().includes(principal.name.toLowerCase().replace(/^dr\.\s*/, "")))
      );

      // Prefer doctor's own consultation, fallback to latest encounter
      const primaryRecord =
        doctorSpecificRecords.find((r) => r.resourceType === "Encounter") ||
        doctorSpecificRecords[0] ||
        patientRecords.find((r) => r.resourceType === "Encounter") ||
        patientRecords[0];

      const clinicalData = (primaryRecord?.clinicalData as Record<string, unknown>) || {};

      const pPrescriptions = await Prescription.countDocuments({ patientId: patient._id });
      const pLabOrders = await LabOrder.countDocuments({ patientId: patient._id });

      treatedList.push({
        patient: {
          _id: patient._id.toString(),
          id: patient._id.toString(),
          patientId: patient.patientId || `PID-${patient._id.toString().slice(-8).toUpperCase()}`,
          name: patient.name,
          gender: patient.gender,
          dateOfBirth: patient.dateOfBirth,
          abhaAddress: patient.abhaAddress,
          abhaId: patient.abhaId,
          phone: patient.phone,
          email: patient.email,
        },
        lastConsultationDate: primaryRecord?.date
          ? primaryRecord.date.toISOString().split("T")[0]
          : new Date().toISOString().split("T")[0],
        latestDiagnosis:
          (clinicalData.diagnosis as string) ||
          primaryRecord?.title?.replace(/^Consultation:\s*/i, "") ||
          "Routine Clinical Evaluation",
        latestTreatmentPlan:
          (clinicalData.treatmentPlan as string) ||
          primaryRecord?.summary ||
          "Follow clinical protocol, continue prescribed pharmacotherapy, and scheduled follow-up.",
        latestSymptoms: (clinicalData.symptoms as string) || undefined,
        latestClinicalFindings: (clinicalData.clinicalFindings as string) || undefined,
        prescribedMedicines: Array.isArray(clinicalData.prescribedMedicines)
          ? (clinicalData.prescribedMedicines as TreatedPatientItem["prescribedMedicines"])
          : undefined,
        recommendedTests: Array.isArray(clinicalData.recommendedTests)
          ? (clinicalData.recommendedTests as TreatedPatientItem["recommendedTests"])
          : undefined,
        followUpDate: (clinicalData.followUpDate as string) || undefined,
        clinicalNotes: (clinicalData.clinicalNotes as string) || undefined,
        totalConsultations: patientRecords.filter((r) => r.resourceType === "Encounter").length || 1,
        totalPrescriptions: pPrescriptions,
        totalLabOrders: pLabOrders,
      });
    }

    // Sort by last consultation date descending
    treatedList.sort((a, b) => (a.lastConsultationDate < b.lastConsultationDate ? 1 : -1));

    return apiSuccess(treatedList, request, { status: 200 });
  } catch (err) {
    return handleDalError(err, request);
  }
}
