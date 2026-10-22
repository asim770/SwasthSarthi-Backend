import mongoose, { Schema, Document, Model } from "mongoose";

export type NotificationCategory =
  | "CONSENT"
  | "RECORD_ACCESS"
  | "LAB_REPORT"
  | "PRESCRIPTION"
  | "ONBOARDING"
  | "SECURITY";

export type NotificationDeliveryStatus = "PENDING" | "DELIVERED" | "FAILED";

export interface INotification extends Document {
  notificationId: string;
  recipientId: mongoose.Types.ObjectId;
  recipientAbha: string;
  recipientRole?: string;
  category: NotificationCategory;
  title: string;
  message: string;
  relatedResourceId?: string;
  relatedResourceType?: string;
  isRead: boolean;
  readAt?: Date;
  deliveryStatus: NotificationDeliveryStatus;
  idempotencyKey: string;
  retryCount: number;
  metadata?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

const NotificationSchema = new Schema<INotification>(
  {
    notificationId: {
      type: String,
      required: true,
      unique: true,
      index: true,
      default: () => `NOTIF-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
    },
    recipientId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    recipientAbha: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    recipientRole: {
      type: String,
      index: true,
    },
    category: {
      type: String,
      required: true,
      enum: ["CONSENT", "RECORD_ACCESS", "LAB_REPORT", "PRESCRIPTION", "ONBOARDING", "SECURITY"],
      index: true,
    },
    title: {
      type: String,
      required: true,
      trim: true,
    },
    message: {
      type: String,
      required: true,
      trim: true,
    },
    relatedResourceId: {
      type: String,
      trim: true,
      index: true,
    },
    relatedResourceType: {
      type: String,
      trim: true,
      index: true,
    },
    isRead: {
      type: Boolean,
      default: false,
      index: true,
    },
    readAt: {
      type: Date,
    },
    deliveryStatus: {
      type: String,
      enum: ["PENDING", "DELIVERED", "FAILED"],
      default: "DELIVERED",
      index: true,
    },
    idempotencyKey: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    retryCount: {
      type: Number,
      default: 0,
    },
    metadata: {
      type: Schema.Types.Mixed,
      default: {},
    },
  },
  {
    timestamps: true,
  }
);

NotificationSchema.index({ recipientId: 1, isRead: 1, createdAt: -1 });
NotificationSchema.index({ recipientAbha: 1, createdAt: -1 });

export const Notification: Model<INotification> =
  mongoose.models.Notification ||
  mongoose.model<INotification>("Notification", NotificationSchema);
