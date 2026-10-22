import mongoose, { Schema, Document, Model } from "mongoose";
import { UserRole } from "./User";

export type AuditOutcome = "ALLOWED" | "DENIED" | "FAILED";

export interface IAuditLog extends Document {
  eventId: string;
  sequenceNumber?: number;
  previousEventHash?: string;
  currentEventHash?: string;
  schemaVersion: number;
  correlationId?: string;
  action: string;
  principalId?: mongoose.Types.ObjectId;
  principalRole?: UserRole | "anonymous";
  principalName?: string;
  facility?: string;
  targetResourceType: string;
  targetResourceId?: string;
  targetPatientId?: mongoose.Types.ObjectId;
  outcome: AuditOutcome;
  denialReason?: string;
  ipAddress?: string;
  userAgent?: string;
  metadata?: Record<string, unknown>;
  timestamp: Date;
}

const AuditLogSchema = new Schema<IAuditLog>(
  {
    eventId: {
      type: String,
      required: true,
      index: true,
      default: () => `EVT-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
    },
    sequenceNumber: {
      type: Number,
      index: true,
    },
    previousEventHash: {
      type: String,
      index: true,
    },
    currentEventHash: {
      type: String,
      index: true,
    },
    schemaVersion: {
      type: Number,
      default: 1,
    },
    correlationId: {
      type: String,
      index: true,
    },
    action: {
      type: String,
      required: true,
      index: true,
    },
    principalId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      index: true,
    },
    principalRole: {
      type: String,
      index: true,
    },
    principalName: {
      type: String,
    },
    facility: {
      type: String,
      index: true,
    },
    targetResourceType: {
      type: String,
      required: true,
      index: true,
    },
    targetResourceId: {
      type: String,
      index: true,
    },
    targetPatientId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      index: true,
    },
    outcome: {
      type: String,
      required: true,
      enum: ["ALLOWED", "DENIED", "FAILED"],
      index: true,
    },
    denialReason: {
      type: String,
    },
    ipAddress: {
      type: String,
    },
    userAgent: {
      type: String,
    },
    metadata: {
      type: Schema.Types.Mixed,
      default: {},
    },
    timestamp: {
      type: Date,
      required: true,
      default: Date.now,
      index: true,
    },
  },
  {
    timestamps: false,
  }
);

AuditLogSchema.index({ timestamp: -1 });
AuditLogSchema.index({ principalId: 1, timestamp: -1 });
AuditLogSchema.index({ targetPatientId: 1, timestamp: -1 });

// Strictly prevent application-level mutations and deletions to enforce append-only security
const rejectAuditMutation = function () {
  throw new Error("Audit records are append-only and cannot be mutated or deleted.");
};

AuditLogSchema.pre("updateOne", rejectAuditMutation);
AuditLogSchema.pre("updateMany", rejectAuditMutation);
AuditLogSchema.pre("findOneAndUpdate", rejectAuditMutation);
AuditLogSchema.pre("replaceOne", rejectAuditMutation);
AuditLogSchema.pre("deleteOne", rejectAuditMutation);
AuditLogSchema.pre("deleteMany", rejectAuditMutation);
AuditLogSchema.pre("findOneAndDelete", rejectAuditMutation);

export const AuditLog: Model<IAuditLog> =
  mongoose.models.AuditLog || mongoose.model<IAuditLog>("AuditLog", AuditLogSchema);
