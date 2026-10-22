import mongoose, { Schema, Document, Model } from "mongoose";

export interface ITransferredRecordCache extends Document {
  transferId: string;
  bundleId: string;
  patientId: mongoose.Types.ObjectId;
  patientAbhaAddress: string;
  doctorId: mongoose.Types.ObjectId;
  consentId: string;
  hipId: string;
  hipName: string;
  fhirBundle: Record<string, unknown>;
  resourceCount: number;
  cachedAt: Date;
  expiresAt: Date;
  isMockData: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const TransferredRecordCacheSchema = new Schema<ITransferredRecordCache>(
  {
    transferId: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    bundleId: {
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
    patientAbhaAddress: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      index: true,
    },
    doctorId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    consentId: {
      type: String,
      required: true,
      trim: true,
      index: true,
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
    fhirBundle: {
      type: Schema.Types.Mixed,
      required: true,
    },
    resourceCount: {
      type: Number,
      required: true,
      default: 0,
    },
    cachedAt: {
      type: Date,
      required: true,
      default: Date.now,
    },
    expiresAt: {
      type: Date,
      required: true,
      // TTL index: MongoDB automatically removes records when current date exceeds expiresAt
      index: { expireAfterSeconds: 0 },
    },
    isMockData: {
      type: Boolean,
      required: true,
      default: true,
    },
  },
  {
    timestamps: true,
  }
);

TransferredRecordCacheSchema.index({ patientId: 1, doctorId: 1 });
TransferredRecordCacheSchema.index({ consentId: 1, expiresAt: 1 });

export const TransferredRecordCache: Model<ITransferredRecordCache> =
  mongoose.models.TransferredRecordCache ||
  mongoose.model<ITransferredRecordCache>(
    "TransferredRecordCache",
    TransferredRecordCacheSchema
  );
