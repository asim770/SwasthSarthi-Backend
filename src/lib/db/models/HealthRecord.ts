import mongoose, { Schema, Document, Model } from "mongoose";

export type HealthResourceType =
  | "DiagnosticReport"
  | "Encounter"
  | "Immunization"
  | "Observation"
  | "MedicationRequest";

export interface IHealthRecord extends Document {
  recordId: string;
  patientId: mongoose.Types.ObjectId;
  title: string;
  resourceType: HealthResourceType;
  date: Date;
  providerFacility: string;
  doctorName: string;
  doctorId?: mongoose.Types.ObjectId;
  status: string;
  summary: string;
  careContextId: string;
  fhirBundleId: string;
  clinicalData?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

const HealthRecordSchema = new Schema<IHealthRecord>(
  {
    recordId: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      index: true,
    },
    patientId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    title: {
      type: String,
      required: true,
      trim: true,
    },
    resourceType: {
      type: String,
      required: true,
      enum: [
        "DiagnosticReport",
        "Encounter",
        "Immunization",
        "Observation",
        "MedicationRequest",
      ],
      index: true,
    },
    date: {
      type: Date,
      required: true,
      index: true,
    },
    providerFacility: {
      type: String,
      required: true,
      trim: true,
    },
    doctorName: {
      type: String,
      required: true,
      trim: true,
    },
    doctorId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      index: true,
    },
    status: {
      type: String,
      required: true,
      default: "final",
    },
    summary: {
      type: String,
      required: true,
    },
    careContextId: {
      type: String,
      required: true,
      trim: true,
    },
    fhirBundleId: {
      type: String,
      required: true,
      trim: true,
    },
    clinicalData: {
      type: Schema.Types.Mixed,
      default: {},
    },
  },
  {
    timestamps: true,
  }
);

HealthRecordSchema.index({ patientId: 1, resourceType: 1, date: 1 });

export const HealthRecord: Model<IHealthRecord> =
  mongoose.models.HealthRecord ||
  mongoose.model<IHealthRecord>("HealthRecord", HealthRecordSchema);
