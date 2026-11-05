import { NextRequest, NextResponse } from "next/server";
import mongoose from "mongoose";
import {
  requireAuthenticatedUser,
  resolvePatientUser,
  getPatientProfile,
  getHealthRecordsForPatient,
  handleDalError,
} from "@/lib/dal";
import { apiSuccess } from "@/lib/api/response";
import { handleCorsPreflight } from "@/lib/api/cors";
import { ConsentArtifact } from "@/lib/db/models/ConsentArtifact";
import { Prescription } from "@/lib/db/models/Prescription";
import { LabOrder } from "@/lib/db/models/LabOrder";
import { connectToDatabase } from "@/lib/db/connect";

export async function OPTIONS(request: NextRequest): Promise<NextResponse> {
  return handleCorsPreflight(request);
}

/**
 * GET /api/v1/patients/[id]/info
 * Comprehensive endpoint: Fetch all patient info, clinical records, consents, and orders by patient ID
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  try {
    const { id } = await params;
    const principal = await requireAuthenticatedUser(request);
    await connectToDatabase();

    // 1. Resolve patient document and verify access
    const patientUser = await resolvePatientUser(id);
    const profile = await getPatientProfile(principal, id);

    const patientObjectId = patientUser._id as mongoose.Types.ObjectId;

    let clinicalRecords: unknown[] = [];
    let consents: unknown[] = [];
    let prescriptions: unknown[] = [];
    let labOrders: unknown[] = [];
    let dispensingEvents: unknown[] = [];

    if (principal.role === "patient" || principal.role === "doctor") {
      try {
        clinicalRecords = await getHealthRecordsForPatient(principal, id);
      } catch {
        clinicalRecords = [];
      }

      // Fetch active consents for this patient
      const consentQuery =
        principal.role === "doctor"
          ? {
              patientId: patientObjectId,
              requesterDoctorId: new mongoose.Types.ObjectId(principal.id),
            }
          : { patientId: patientObjectId };

      consents = await ConsentArtifact.find(consentQuery)
        .sort({ createdAt: -1 })
        .limit(20)
        .lean();

      // Fetch prescriptions linked to this patient
      prescriptions = await Prescription.find({ patientId: patientObjectId })
        .sort({ date: -1 })
        .limit(20)
        .lean();

      // Fetch lab orders linked to this patient
      labOrders = await LabOrder.find({ patientId: patientObjectId })
        .sort({ orderDate: -1 })
        .limit(20)
        .lean();

      // Fetch pharmacy dispensing events linked to this patient
      const { DispensingEvent } = await import("@/lib/db/models/DispensingEvent");
      dispensingEvents = await DispensingEvent.find({ patientId: patientObjectId })
        .sort({ dispensedAt: -1 })
        .limit(20)
        .lean();
    }

    return apiSuccess(
      {
        patient: profile,
        recordsSummary: {
          totalClinicalRecords: clinicalRecords.length,
          totalConsents: consents.length,
          totalPrescriptions: prescriptions.length,
          totalLabOrders: labOrders.length,
          totalDispensingEvents: dispensingEvents.length,
        },
        clinicalRecords,
        consents,
        prescriptions,
        labOrders,
        dispensingEvents,
      },
      request,
      { status: 200 }
    );
  } catch (err) {
    return handleDalError(err, request);
  }
}
