import mongoose, { Schema, Document, Model } from "mongoose";

export type ChallengeStatus = "PENDING" | "CONSUMED" | "EXPIRED" | "EXHAUSTED";

export interface IAuthChallenge extends Document {
  challengeId: string;
  identifier: string;
  userId?: mongoose.Types.ObjectId;
  otpHash: string;
  devOtp?: string;
  attempts: number;
  maxAttempts: number;
  status: ChallengeStatus;
  expiresAt: Date;
  consumedAt?: Date;
  ipAddress?: string;
  createdAt: Date;
}

const AuthChallengeSchema = new Schema<IAuthChallenge>(
  {
    challengeId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    identifier: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
    },
    otpHash: {
      type: String,
      required: true,
    },
    devOtp: {
      type: String,
    },
    attempts: {
      type: Number,
      default: 0,
    },
    maxAttempts: {
      type: Number,
      default: 3,
    },
    status: {
      type: String,
      enum: ["PENDING", "CONSUMED", "EXPIRED", "EXHAUSTED"],
      default: "PENDING",
      index: true,
    },
    expiresAt: {
      type: Date,
      required: true,
      index: true,
    },
    consumedAt: {
      type: Date,
    },
    ipAddress: {
      type: String,
    },
    createdAt: {
      type: Date,
      default: Date.now,
      expires: 600, // MongoDB TTL index: 10 minutes
    },
  },
  {
    timestamps: false,
  }
);

export const AuthChallenge: Model<IAuthChallenge> =
  mongoose.models.AuthChallenge ||
  mongoose.model<IAuthChallenge>("AuthChallenge", AuthChallengeSchema);
