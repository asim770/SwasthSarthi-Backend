import mongoose, { Schema, Document, Model } from "mongoose";

export const GENESIS_HASH = "0000000000000000000000000000000000000000000000000000000000000000";

export interface IAuditChainHead extends Document {
  chainId: string;
  currentSequence: number;
  lastEventHash: string;
  updatedAt: Date;
}

const AuditChainHeadSchema = new Schema<IAuditChainHead>(
  {
    chainId: {
      type: String,
      required: true,
      unique: true,
      default: "MAIN",
      index: true,
    },
    currentSequence: {
      type: Number,
      required: true,
      default: 0,
    },
    lastEventHash: {
      type: String,
      required: true,
      default: GENESIS_HASH,
    },
  },
  {
    timestamps: true,
  }
);

export const AuditChainHead: Model<IAuditChainHead> =
  mongoose.models.AuditChainHead ||
  mongoose.model<IAuditChainHead>("AuditChainHead", AuditChainHeadSchema);
