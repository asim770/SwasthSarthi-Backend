import mongoose, { Schema, Document, Model } from "mongoose";
import { UserRole } from "./User";

export type AuditOutcome = "ALLOWED" | "DENIED" | "FAILED";

export interface IAuditLog extends Document {
  action: string;
  principalId?: mongoose.Types.ObjectId;
  principalRole?: UserRole | "anonymous";
  principalName?: string;
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

export const AuditLog: Model<IAuditLog> =
  mongoose.models.AuditLog || mongoose.model<IAuditLog>("AuditLog", AuditLogSchema);
