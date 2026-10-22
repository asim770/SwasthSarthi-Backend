import mongoose, { Schema, Document, Model } from "mongoose";

export type FacilityType = "HOSPITAL" | "LABORATORY" | "PHARMACY" | "CLINIC";
export type FacilityStatus = "PENDING" | "APPROVED" | "REJECTED" | "SUSPENDED";

export interface IFacilityStatusHistory {
  fromStatus: FacilityStatus;
  toStatus: FacilityStatus;
  changedBy: mongoose.Types.ObjectId;
  changedByName: string;
  changedAt: Date;
  reason?: string;
}

export interface IFacility extends Document {
  facilityId: string; // Unique facility code or demo HFR ID (e.g. IN0710000001)
  name: string;
  type: FacilityType;
  status: FacilityStatus;
  address?: string;
  city?: string;
  state?: string;
  contactPhone?: string;
  contactEmail?: string;
  demoHfrId?: string;
  registeredBy: mongoose.Types.ObjectId;
  registeredByName: string;
  verifiedBy?: mongoose.Types.ObjectId;
  verifiedByName?: string;
  verifiedAt?: Date;
  statusReason?: string;
  changeHistory: IFacilityStatusHistory[];
  createdAt: Date;
  updatedAt: Date;
}

const FacilityStatusHistorySchema = new Schema<IFacilityStatusHistory>(
  {
    fromStatus: {
      type: String,
      enum: ["PENDING", "APPROVED", "REJECTED", "SUSPENDED"],
      required: true,
    },
    toStatus: {
      type: String,
      enum: ["PENDING", "APPROVED", "REJECTED", "SUSPENDED"],
      required: true,
    },
    changedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    changedByName: {
      type: String,
      required: true,
    },
    changedAt: {
      type: Date,
      default: Date.now,
    },
    reason: {
      type: String,
    },
  },
  { _id: false }
);

const FacilitySchema = new Schema<IFacility>(
  {
    facilityId: {
      type: String,
      required: true,
      unique: true,
      uppercase: true,
      trim: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    type: {
      type: String,
      required: true,
      enum: ["HOSPITAL", "LABORATORY", "PHARMACY", "CLINIC"],
      index: true,
    },
    status: {
      type: String,
      required: true,
      enum: ["PENDING", "APPROVED", "REJECTED", "SUSPENDED"],
      default: "PENDING",
      index: true,
    },
    address: {
      type: String,
      trim: true,
    },
    city: {
      type: String,
      trim: true,
    },
    state: {
      type: String,
      trim: true,
    },
    contactPhone: {
      type: String,
      trim: true,
    },
    contactEmail: {
      type: String,
      trim: true,
      lowercase: true,
    },
    demoHfrId: {
      type: String,
      trim: true,
      index: true,
    },
    registeredBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    registeredByName: {
      type: String,
      required: true,
    },
    verifiedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
    },
    verifiedByName: {
      type: String,
    },
    verifiedAt: {
      type: Date,
    },
    statusReason: {
      type: String,
    },
    changeHistory: {
      type: [FacilityStatusHistorySchema],
      default: [],
    },
  },
  {
    timestamps: true,
  }
);

FacilitySchema.index({ status: 1, type: 1 });
FacilitySchema.index({ name: 1, status: 1 });

export const Facility: Model<IFacility> =
  mongoose.models.Facility || mongoose.model<IFacility>("Facility", FacilitySchema);
