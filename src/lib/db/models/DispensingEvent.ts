import mongoose, { Schema, Document, Model } from "mongoose";

export interface IDispensingEventDocument extends Document {
  dispenseId: string;
  idempotencyKey: string;
  prescriptionId: string;
  patientId: mongoose.Types.ObjectId;
  patientName: string;
  patientAbha: string;
  pharmacistId: mongoose.Types.ObjectId;
  pharmacistName: string;
  pharmacyFacility: string;
  medicationName: string;
  medicationCode?: string;
  quantityDispensed: number;
  remainingQuantityAfter: number;
  batchNumber?: string;
  notes?: string;
  status: "completed" | "in-progress" | "cancelled";
  fhirResource?: Record<string, unknown>;
  dispensedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const DispensingEventSchema = new Schema<IDispensingEventDocument>(
  {
    dispenseId: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      index: true,
    },
    idempotencyKey: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      index: true,
    },
    prescriptionId: {
      type: String,
      required: true,
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
    patientAbha: {
      type: String,
      required: true,
    },
    pharmacistId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    pharmacistName: {
      type: String,
      required: true,
    },
    pharmacyFacility: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    medicationName: {
      type: String,
      required: true,
    },
    medicationCode: {
      type: String,
    },
    quantityDispensed: {
      type: Number,
      required: true,
      min: 1,
    },
    remainingQuantityAfter: {
      type: Number,
      required: true,
      min: 0,
    },
    batchNumber: {
      type: String,
      trim: true,
    },
    notes: {
      type: String,
    },
    status: {
      type: String,
      required: true,
      enum: ["completed", "in-progress", "cancelled"],
      default: "completed",
      index: true,
    },
    fhirResource: {
      type: Schema.Types.Mixed,
    },
    dispensedAt: {
      type: Date,
      required: true,
      default: Date.now,
      index: true,
    },
  },
  {
    timestamps: true,
  }
);

DispensingEventSchema.index({ prescriptionId: 1, dispensedAt: -1 });
DispensingEventSchema.index({ pharmacyFacility: 1, dispensedAt: -1 });

export const DispensingEvent: Model<IDispensingEventDocument> =
  mongoose.models.DispensingEvent ||
  mongoose.model<IDispensingEventDocument>("DispensingEvent", DispensingEventSchema);
