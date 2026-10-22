import mongoose, { Schema, Document, Model } from "mongoose";

export type ConsentStatus =
  | "PENDING"
  | "APPROVED"
  | "DENIED"
  | "REVOKED"
  | "EXPIRED"
  | "REQUESTED"
  | "GRANTED";

export interface IConsentDecisionHistory {
  action: "REQUESTED" | "PENDING" | "APPROVED" | "DENIED" | "REVOKED" | "EXPIRED";
  actorId: mongoose.Types.ObjectId;
  actorRole: string;
  actorName: string;
  timestamp: Date;
  note?: string;
  approvedHiTypes?: string[];
}

export interface IConsentArtifact extends Document {
  consentId: string;
  patientId: mongoose.Types.ObjectId;
  requesterDoctorId: mongoose.Types.ObjectId;
  requesterFacility: string;
  purpose: string;
  hiTypes: string[]; // e.g. ["DiagnosticReport", "Encounter", "Immunization", "Observation", "MedicationRequest", "MedicationDispense", "DocumentReference"]
  approvedHiTypes: string[];
  dateRangeFrom: Date;
  dateRangeTo: Date;
  expiresAt: Date;
  status: ConsentStatus;
  version: number;
  decisionHistory: IConsentDecisionHistory[];
  grantedAt?: Date;
  revokedAt?: Date;
  deniedAt?: Date;
  expiredAt?: Date;
  signature?: string;
  createdAt: Date;
  updatedAt: Date;
}

const DecisionHistorySchema = new Schema<IConsentDecisionHistory>(
  {
    action: {
      type: String,
      required: true,
      enum: ["REQUESTED", "PENDING", "APPROVED", "DENIED", "REVOKED", "EXPIRED"],
    },
    actorId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    actorRole: {
      type: String,
      required: true,
    },
    actorName: {
      type: String,
      required: true,
    },
    timestamp: {
      type: Date,
      default: Date.now,
      required: true,
    },
    note: {
      type: String,
      trim: true,
    },
    approvedHiTypes: {
      type: [String],
      default: [],
    },
  },
  { _id: false }
);

const ConsentArtifactSchema = new Schema<IConsentArtifact>(
  {
    consentId: {
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
    purpose: {
      type: String,
      required: true,
      trim: true,
    },
    hiTypes: {
      type: [String],
      required: true,
      default: [],
    },
    approvedHiTypes: {
      type: [String],
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
    expiresAt: {
      type: Date,
      required: true,
      index: true,
    },
    status: {
      type: String,
      required: true,
      enum: ["PENDING", "APPROVED", "DENIED", "REVOKED", "EXPIRED", "REQUESTED", "GRANTED"],
      default: "PENDING",
      index: true,
    },
    version: {
      type: Number,
      default: 1,
      required: true,
    },
    decisionHistory: {
      type: [DecisionHistorySchema],
      default: [],
    },
    grantedAt: {
      type: Date,
    },
    revokedAt: {
      type: Date,
    },
    deniedAt: {
      type: Date,
    },
    expiredAt: {
      type: Date,
    },
    signature: {
      type: String,
    },
  },
  {
    timestamps: true,
  }
);

// Compound index for active consent lookups: active consent by patient, doctor, status
ConsentArtifactSchema.index({
  patientId: 1,
  requesterDoctorId: 1,
  status: 1,
  expiresAt: 1,
});

export const ConsentArtifact: Model<IConsentArtifact> =
  mongoose.models.ConsentArtifact ||
  mongoose.model<IConsentArtifact>("ConsentArtifact", ConsentArtifactSchema);

