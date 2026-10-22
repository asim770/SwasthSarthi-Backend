import mongoose, { Schema, Document, Model } from "mongoose";

export type ConsentStatus = "REQUESTED" | "GRANTED" | "DENIED" | "REVOKED" | "EXPIRED";

export interface IConsentArtifact extends Document {
  consentId: string;
  patientId: mongoose.Types.ObjectId;
  requesterDoctorId: mongoose.Types.ObjectId;
  requesterFacility: string;
  purpose: string;
  hiTypes: string[]; // e.g. ["DiagnosticReport", "Encounter", "Immunization", "Observation", "MedicationRequest"]
  dateRangeFrom: Date;
  dateRangeTo: Date;
  expiresAt: Date;
  status: ConsentStatus;
  grantedAt?: Date;
  revokedAt?: Date;
  deniedAt?: Date;
  signature?: string;
  createdAt: Date;
  updatedAt: Date;
}

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
      enum: ["REQUESTED", "GRANTED", "DENIED", "REVOKED", "EXPIRED"],
      default: "REQUESTED",
      index: true,
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
    signature: {
      type: String,
    },
  },
  {
    timestamps: true,
  }
);

// Compound index for efficient consent lookups: active consent by patient, doctor, status
ConsentArtifactSchema.index({
  patientId: 1,
  requesterDoctorId: 1,
  status: 1,
  expiresAt: 1,
});

export const ConsentArtifact: Model<IConsentArtifact> =
  mongoose.models.ConsentArtifact ||
  mongoose.model<IConsentArtifact>("ConsentArtifact", ConsentArtifactSchema);
