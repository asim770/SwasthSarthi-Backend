import mongoose, { Schema, Document, Model } from "mongoose";

export type VerificationStatus = "PENDING" | "APPROVED" | "REJECTED" | "SUSPENDED";

export interface IVerificationHistory {
  fromStatus: VerificationStatus;
  toStatus: VerificationStatus;
  changedBy: mongoose.Types.ObjectId;
  changedByName: string;
  changedAt: Date;
  reason?: string;
}

export interface IUser extends Document {
  abhaId: string;
  abhaAddress: string;
  name: string;
  role: UserRole;
  isActive: boolean;
  phone: string;
  email?: string;
  gender?: string;
  dateOfBirth?: string;
  facility?: string;
  specialization?: string;
  verificationStatus: VerificationStatus;
  hprId?: string;
  hfrId?: string;
  verifiedAt?: Date;
  verifiedBy?: mongoose.Types.ObjectId;
  verifiedByName?: string;
  statusReason?: string;
  verificationHistory: IVerificationHistory[];
  createdAt: Date;
  updatedAt: Date;
}

const VerificationHistorySchema = new Schema<IVerificationHistory>(
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

const UserSchema = new Schema<IUser>(
  {
    abhaId: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      index: true,
    },
    abhaAddress: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    role: {
      type: String,
      required: true,
      enum: ["patient", "doctor", "laboratory", "pharmacy", "admin"],
      index: true,
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
    phone: {
      type: String,
      required: true,
      trim: true,
    },
    email: {
      type: String,
      trim: true,
      lowercase: true,
    },
    gender: {
      type: String,
      enum: ["Male", "Female", "Other"],
    },
    dateOfBirth: {
      type: String,
    },
    facility: {
      type: String,
      trim: true,
    },
    specialization: {
      type: String,
      trim: true,
    },
    verificationStatus: {
      type: String,
      enum: ["PENDING", "APPROVED", "REJECTED", "SUSPENDED"],
      default: "APPROVED",
      index: true,
    },
    hprId: {
      type: String,
      trim: true,
      index: true,
    },
    hfrId: {
      type: String,
      trim: true,
      index: true,
    },
    verifiedAt: {
      type: Date,
    },
    verifiedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
    },
    verifiedByName: {
      type: String,
    },
    statusReason: {
      type: String,
    },
    verificationHistory: {
      type: [VerificationHistorySchema],
      default: [],
    },
  },
  {
    timestamps: true,
  }
);

// Prevent re-compilation of model in hot-reload
export const User: Model<IUser> =
  mongoose.models.User || mongoose.model<IUser>("User", UserSchema);
