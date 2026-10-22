import mongoose, { Schema, Document, Model } from "mongoose";

export type PrescriptionStatus = "ACTIVE" | "DISPENSED" | "EXPIRED" | "CANCELLED";

export interface IMedicationItem {
  name: string;
  dosage: string;
  frequency: string;
  durationDays: number;
  instructions?: string;
}

export interface IDispensationEvent {
  dispensedAt: Date;
  pharmacyFacility: string;
  pharmacistId: mongoose.Types.ObjectId;
  notes?: string;
}

export interface IPrescription extends Document {
  prescriptionId: string;
  patientId: mongoose.Types.ObjectId;
  patientName: string;
  doctorId: mongoose.Types.ObjectId;
  doctorName: string;
  facility: string;
  medications: IMedicationItem[];
  status: PrescriptionStatus;
  remainingRefills: number;
  prescribedAt: Date;
  expiresAt: Date;
  dispensedEvents: IDispensationEvent[];
  createdAt: Date;
  updatedAt: Date;
}

const PrescriptionSchema = new Schema<IPrescription>(
  {
    prescriptionId: {
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
    patientName: {
      type: String,
      required: true,
    },
    doctorId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    doctorName: {
      type: String,
      required: true,
    },
    facility: {
      type: String,
      required: true,
      trim: true,
    },
    medications: [
      {
        name: { type: String, required: true },
        dosage: { type: String, required: true },
        frequency: { type: String, required: true },
        durationDays: { type: Number, required: true },
        instructions: { type: String },
      },
    ],
    status: {
      type: String,
      required: true,
      enum: ["ACTIVE", "DISPENSED", "EXPIRED", "CANCELLED"],
      default: "ACTIVE",
      index: true,
    },
    remainingRefills: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
    },
    prescribedAt: {
      type: Date,
      required: true,
      default: Date.now,
    },
    expiresAt: {
      type: Date,
      required: true,
      index: true,
    },
    dispensedEvents: [
      {
        dispensedAt: { type: Date, required: true, default: Date.now },
        pharmacyFacility: { type: String, required: true },
        pharmacistId: { type: Schema.Types.ObjectId, ref: "User", required: true },
        notes: { type: String },
      },
    ],
  },
  {
    timestamps: true,
  }
);

PrescriptionSchema.index({ status: 1, expiresAt: 1 });
PrescriptionSchema.index({ patientId: 1, status: 1 });

export const Prescription: Model<IPrescription> =
  mongoose.models.Prescription ||
  mongoose.model<IPrescription>("Prescription", PrescriptionSchema);
