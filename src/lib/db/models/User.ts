import mongoose, { Schema, Document, Model } from "mongoose";

export type UserRole = "patient" | "doctor" | "laboratory" | "pharmacy" | "admin";

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
  patientId?: string;
  passwordHash?: string;
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
  isPhoneVerified?: boolean;
  isEmailVerified?: boolean;
  phoneVerifiedAt?: Date;
  emailVerifiedAt?: Date;
  googleSubject?: string;
  authProviders?: string[];
  accountStatus?: "active" | "pending_verification" | "suspended";
  lastLoginAt?: Date;
  medicalQualification?: string;
  registrationNumber?: string;
  hospitalOrClinicName?: string;
  organizationName?: string;
  authorizedRepresentative?: string;
  address?: string;
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
    patientId: {
      type: String,
      unique: true,
      sparse: true,
      trim: true,
      index: true,
    },
    passwordHash: {
      type: String,
      select: false,
    },
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
      sparse: true,
      unique: true,
      index: true,
    },
    isPhoneVerified: {
      type: Boolean,
      default: false,
    },
    isEmailVerified: {
      type: Boolean,
      default: false,
    },
    phoneVerifiedAt: {
      type: Date,
    },
    emailVerifiedAt: {
      type: Date,
    },
    googleSubject: {
      type: String,
      unique: true,
      sparse: true,
      index: true,
    },
    authProviders: {
      type: [String],
      default: ["password"],
    },
    accountStatus: {
      type: String,
      enum: ["active", "pending_verification", "suspended"],
      default: "active",
      index: true,
    },
    lastLoginAt: {
      type: Date,
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
    medicalQualification: {
      type: String,
      trim: true,
    },
    registrationNumber: {
      type: String,
      trim: true,
    },
    hospitalOrClinicName: {
      type: String,
      trim: true,
    },
    organizationName: {
      type: String,
      trim: true,
    },
    authorizedRepresentative: {
      type: String,
      trim: true,
    },
    address: {
      type: String,
      trim: true,
    },
  },
  {
    timestamps: true,
  }
);

// Prevent re-compilation of model in hot-reload
export const User: Model<IUser> =
  mongoose.models.User || mongoose.model<IUser>("User", UserSchema);
