import mongoose, { Schema, Document, Model } from "mongoose";

export type HealthDataTransferStatus = "REQUESTED" | "PROCESSING" | "TRANSFERRED" | "FAILED";

export interface IHealthDataTransfer extends Document {
  transferId: string;
  transactionId: string;
  consentId: string;
  patientId: mongoose.Types.ObjectId;
  patientAbhaAddress: string;
  requesterDoctorId: mongoose.Types.ObjectId;
  requesterFacility: string;
  hipId: string;
  hipName: string;
  requestedHiTypes: string[];
  dateRangeFrom: Date;
  dateRangeTo: Date;
  status: HealthDataTransferStatus;
  retryCount: number;
  maxRetries: number;
  lastAttemptAt: Date;
  completedAt?: Date;
  failureReason?: string;
  bundleId?: string;
  recordCount: number;
  expiresAt: Date;
  isMockInteraction: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const HealthDataTransferSchema = new Schema<IHealthDataTransfer>(
  {
    transferId: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      index: true,
    },
    transactionId: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      index: true,
    },
    consentId: {
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
    patientAbhaAddress: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      index: true,
    },
    requesterDoctorId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    requesterFacility: {
      type: String,
      required: true,
      trim: true,
    },
    hipId: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    hipName: {
      type: String,
      required: true,
      trim: true,
    },
    requestedHiTypes: {
      type: [String],
      required: true,
      default: [],
    },
    dateRangeFrom: {
      type: Date,
      required: true,
    },
    dateRangeTo: {
      type: Date,
      required: true,
    },
    status: {
      type: String,
      required: true,
      enum: ["REQUESTED", "PROCESSING", "TRANSFERRED", "FAILED"],
      default: "REQUESTED",
      index: true,
    },
    retryCount: {
      type: Number,
      required: true,
      default: 0,
    },
    maxRetries: {
      type: Number,
      required: true,
      default: 3,
    },
    lastAttemptAt: {
      type: Date,
      required: true,
      default: Date.now,
    },
    completedAt: {
      type: Date,
    },
    failureReason: {
      type: String,
    },
    bundleId: {
      type: String,
      trim: true,
    },
    recordCount: {
      type: Number,
      required: true,
      default: 0,
    },
    expiresAt: {
      type: Date,
      required: true,
      index: true,
    },
    isMockInteraction: {
      type: Boolean,
      required: true,
      default: true,
    },
  },
  {
    timestamps: true,
  }
);

HealthDataTransferSchema.index({ patientId: 1, consentId: 1 });
HealthDataTransferSchema.index({ requesterDoctorId: 1, createdAt: -1 });

export const HealthDataTransfer: Model<IHealthDataTransfer> =
  mongoose.models.HealthDataTransfer ||
  mongoose.model<IHealthDataTransfer>(
    "HealthDataTransfer",
    HealthDataTransferSchema
  );
