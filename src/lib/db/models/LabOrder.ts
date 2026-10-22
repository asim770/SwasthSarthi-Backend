import mongoose, { Schema, Document, Model } from "mongoose";

export type LabOrderStatus = "ORDERED" | "IN_PROGRESS" | "COMPLETED" | "CANCELLED";
export type LabOrderPriority = "ROUTINE" | "URGENT" | "STAT";

export interface ILabOrder extends Document {
  orderId: string;
  patientId: mongoose.Types.ObjectId;
  patientName: string;
  patientAbha: string;
  doctorId: mongoose.Types.ObjectId;
  doctorName: string;
  targetFacility: string;
  assignedLabId?: mongoose.Types.ObjectId;
  testName: string;
  testCode: string;
  instructions?: string;
  status: LabOrderStatus;
  priority: LabOrderPriority;
  orderedAt: Date;
  completedAt?: Date;
  reportRecordId?: string;
  fhirResource?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

const LabOrderSchema = new Schema<ILabOrder>(
  {
    orderId: {
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
    patientAbha: {
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
    targetFacility: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    assignedLabId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      index: true,
    },
    testName: {
      type: String,
      required: true,
    },
    testCode: {
      type: String,
      required: true,
    },
    instructions: {
      type: String,
    },
    status: {
      type: String,
      required: true,
      enum: ["ORDERED", "IN_PROGRESS", "COMPLETED", "CANCELLED"],
      default: "ORDERED",
      index: true,
    },
    priority: {
      type: String,
      required: true,
      enum: ["ROUTINE", "URGENT", "STAT"],
      default: "ROUTINE",
    },
    orderedAt: {
      type: Date,
      required: true,
      default: Date.now,
    },
    completedAt: {
      type: Date,
    },
    reportRecordId: {
      type: String,
    },
    fhirResource: {
      type: Schema.Types.Mixed,
    },
  },
  {
    timestamps: true,
  }
);

LabOrderSchema.index({ targetFacility: 1, status: 1 });
LabOrderSchema.index({ assignedLabId: 1, status: 1 });

export const LabOrder: Model<ILabOrder> =
  mongoose.models.LabOrder || mongoose.model<ILabOrder>("LabOrder", LabOrderSchema);
