import mongoose, { Schema, Document, Model } from "mongoose";

export interface ISourceInstitutionRecord extends Document {
  recordId: string;
  institutionId: string;
  institutionName: string;
  institutionType: "hospital" | "clinic" | "laboratory" | "speciality";
  patientAbhaId: string;
  patientAbhaAddress: string;
  patientName: string;
  careContextId: string;
  careContextDescription: string;
  resourceType: string;
  recordDate: Date;
  fhirResource: Record<string, unknown>;
  status: string;
  isMockData: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const SourceInstitutionRecordSchema = new Schema<ISourceInstitutionRecord>(
  {
    recordId: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      index: true,
    },
    institutionId: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    institutionName: {
      type: String,
      required: true,
      trim: true,
    },
    institutionType: {
      type: String,
      required: true,
      enum: ["hospital", "clinic", "laboratory", "speciality"],
      default: "hospital",
    },
    patientAbhaId: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    patientAbhaAddress: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      index: true,
    },
    patientName: {
      type: String,
      required: true,
      trim: true,
    },
    careContextId: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    careContextDescription: {
      type: String,
      required: true,
      trim: true,
    },
    resourceType: {
      type: String,
      required: true,
      index: true,
    },
    recordDate: {
      type: Date,
      required: true,
      index: true,
    },
    fhirResource: {
      type: Schema.Types.Mixed,
      required: true,
    },
    status: {
      type: String,
      required: true,
      default: "final",
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

// Indexes for isolation and fast query during authorized exchange
SourceInstitutionRecordSchema.index({ institutionId: 1, patientAbhaAddress: 1 });
SourceInstitutionRecordSchema.index({ patientAbhaAddress: 1, resourceType: 1, recordDate: 1 });

export const SourceInstitutionRecord: Model<ISourceInstitutionRecord> =
  mongoose.models.SourceInstitutionRecord ||
  mongoose.model<ISourceInstitutionRecord>(
    "SourceInstitutionRecord",
    SourceInstitutionRecordSchema
  );
