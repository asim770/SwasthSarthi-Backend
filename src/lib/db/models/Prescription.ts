import mongoose, { Schema, Document, Model } from "mongoose";

export type PrescriptionStatus =
  | "ACTIVE"
  | "PARTIALLY_DISPENSED"
  | "DISPENSED"
  | "EXPIRED"
  | "CANCELLED";

export interface IMedicationItem {
  code?: string;
  name: string;
  dosage: string;
  frequency: string;
  durationDays: number;
  route?: string;
  quantity: number;
  remainingQuantity: number;
  instructions?: string;
}

export interface IDispensationEvent {
  dispenseId?: string;
  idempotencyKey?: string;
  dispensedAt: Date;
  pharmacyFacility: string;
  pharmacistId: mongoose.Types.ObjectId;
  pharmacistName?: string;
  quantityDispensed: number;
  remainingQuantityAfter?: number;
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
  totalQuantity: number;
  dispensedQuantity: number;
  remainingQuantity: number;
  maxRefills: number;
  remainingRefills: number;
  prescribedAt: Date;
  expiresAt: Date;
  dispensedEvents: IDispensationEvent[];
  fhirResource?: Record<string, unknown>;
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
        code: { type: String, trim: true },
        name: { type: String, required: true },
        dosage: { type: String, required: true },
        frequency: { type: String, required: true },
        durationDays: { type: Number, required: true },
        route: { type: String, default: "oral" },
        quantity: { type: Number, required: true, default: 30, min: 1 },
        remainingQuantity: { type: Number, required: true, default: 30, min: 0 },
        instructions: { type: String },
      },
    ],
    status: {
      type: String,
      required: true,
      enum: ["ACTIVE", "PARTIALLY_DISPENSED", "DISPENSED", "EXPIRED", "CANCELLED"],
      default: "ACTIVE",
      index: true,
    },
    totalQuantity: {
      type: Number,
      required: true,
      default: 30,
      min: 0,
    },
    dispensedQuantity: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
    },
    remainingQuantity: {
      type: Number,
      required: true,
      default: 30,
      min: 0,
    },
    maxRefills: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
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
        dispenseId: { type: String },
        idempotencyKey: { type: String },
        dispensedAt: { type: Date, required: true, default: Date.now },
        pharmacyFacility: { type: String, required: true },
        pharmacistId: { type: Schema.Types.ObjectId, ref: "User", required: true },
        pharmacistName: { type: String },
        quantityDispensed: { type: Number, required: true, default: 0 },
        remainingQuantityAfter: { type: Number },
        notes: { type: String },
      },
    ],
    fhirResource: {
      type: Schema.Types.Mixed,
    },
  },
  {
    timestamps: true,
  }
);

PrescriptionSchema.index({ status: 1, expiresAt: 1 });
PrescriptionSchema.index({ patientId: 1, status: 1 });
PrescriptionSchema.index({ prescriptionId: 1, remainingQuantity: 1 });

export const Prescription: Model<IPrescription> =
  mongoose.models.Prescription ||
  mongoose.model<IPrescription>("Prescription", PrescriptionSchema);
