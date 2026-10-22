import mongoose, { Schema, Document, Model } from "mongoose";

export type UserRole = "patient" | "doctor" | "laboratory" | "pharmacy" | "admin";

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
  createdAt: Date;
  updatedAt: Date;
}

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
  },
  {
    timestamps: true,
  }
);

// Prevent re-compilation of model in hot-reload
export const User: Model<IUser> =
  mongoose.models.User || mongoose.model<IUser>("User", UserSchema);
