import mongoose from "mongoose";
import { Notification, INotification, NotificationCategory } from "@/lib/db/models/Notification";
import { AuthenticatedPrincipal } from "./types";
import { ForbiddenError, NotFoundError, ValidationError } from "./errors";
import { assertSafeIdentifier } from "./sanitizer";
import { logAuditEvent } from "./audit";
import { connectToDatabase } from "@/lib/db/connect";

export interface CreateNotificationParams {
  recipientId: string | mongoose.Types.ObjectId;
  recipientAbha: string;
  recipientRole?: string;
  category: NotificationCategory;
  title: string;
  message: string;
  relatedResourceId?: string;
  relatedResourceType?: string;
  idempotencyKey?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Create or enqueue a notification with strict clinical redaction and idempotency
 */
export async function createNotification(
  params: CreateNotificationParams
): Promise<{ notification: INotification; duplicate: boolean }> {
  await connectToDatabase();

  const key =
    params.idempotencyKey ||
    `NOTIF-KEY-${params.recipientAbha}-${params.category}-${params.relatedResourceId || Date.now()}`;

  // 1. Idempotency check: prevent duplicate queue or event processing
  const existing = await Notification.findOne({ idempotencyKey: key });
  if (existing) {
    return { notification: existing, duplicate: true };
  }

  // 2. Strict privacy check: ensure title/message contain no clinical values, passwords, or OTPs
  const lowerMsg = (params.title + " " + params.message).toLowerCase();
  const prohibitedSensitiveTerms = ["password", "otp", "secret", "bearer", "token"];
  for (const term of prohibitedSensitiveTerms) {
    if (lowerMsg.includes(term)) {
      throw new ValidationError(`Notification content contains restricted sensitive term: ${term}`);
    }
  }

  const recipientObjId =
    typeof params.recipientId === "string"
      ? new mongoose.Types.ObjectId(params.recipientId)
      : params.recipientId;

  const notification = await Notification.create({
    recipientId: recipientObjId,
    recipientAbha: params.recipientAbha.toLowerCase(),
    recipientRole: params.recipientRole,
    category: params.category,
    title: params.title.trim(),
    message: params.message.trim(),
    relatedResourceId: params.relatedResourceId,
    relatedResourceType: params.relatedResourceType,
    deliveryStatus: "DELIVERED",
    idempotencyKey: key,
    metadata: params.metadata || {},
  });

  return { notification, duplicate: false };
}

/**
 * Retrieve notifications for the authenticated user only
 */
export async function getNotifications(
  principal: AuthenticatedPrincipal,
  params: { page?: number; limit?: number; unreadOnly?: boolean } = {}
): Promise<{
  notifications: INotification[];
  total: number;
  unreadCount: number;
  page: number;
  limit: number;
}> {
  await connectToDatabase();

  const recipientObjId = new mongoose.Types.ObjectId(principal.id);
  const filter: Record<string, unknown> = {
    $or: [{ recipientId: recipientObjId }, { recipientAbha: principal.abhaAddress.toLowerCase() }],
  };

  if (params.unreadOnly) {
    filter.isRead = false;
  }

  const page = Math.max(1, params.page || 1);
  const limit = Math.min(50, Math.max(1, params.limit || 20));
  const skip = (page - 1) * limit;

  const [notifications, total, unreadCount] = await Promise.all([
    Notification.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
    Notification.countDocuments(filter),
    Notification.countDocuments({
      $or: [{ recipientId: recipientObjId }, { recipientAbha: principal.abhaAddress.toLowerCase() }],
      isRead: false,
    }),
  ]);

  return {
    notifications,
    total,
    unreadCount,
    page,
    limit,
  };
}

/**
 * Retrieve unread notification count
 */
export async function getUnreadNotificationCount(
  principal: AuthenticatedPrincipal
): Promise<number> {
  await connectToDatabase();
  const recipientObjId = new mongoose.Types.ObjectId(principal.id);

  return Notification.countDocuments({
    $or: [{ recipientId: recipientObjId }, { recipientAbha: principal.abhaAddress.toLowerCase() }],
    isRead: false,
  });
}

/**
 * Mark a single notification as read with strict ownership verification
 */
export async function markNotificationAsRead(
  principal: AuthenticatedPrincipal,
  notificationId: string
): Promise<INotification> {
  assertSafeIdentifier(notificationId, "notificationId");
  await connectToDatabase();

  const notification = await Notification.findOne({
    $or: [
      { notificationId },
      ...(mongoose.isValidObjectId(notificationId) ? [{ _id: new mongoose.Types.ObjectId(notificationId) }] : []),
    ],
  });

  if (!notification) {
    throw new NotFoundError(`Notification '${notificationId}' not found.`);
  }

  // Ownership verification: user can only mark their own notification as read
  if (
    notification.recipientId.toString() !== principal.id &&
    notification.recipientAbha.toLowerCase() !== principal.abhaAddress.toLowerCase()
  ) {
    await logAuditEvent({
      action: "NOTIFICATION_ACCESS_DENIED",
      principal,
      targetResourceType: "Notification",
      targetResourceId: notificationId,
      outcome: "DENIED",
      denialReason: "User attempted to mark another user's notification as read.",
    });
    throw new ForbiddenError("Access denied. You may only manage your own notifications.");
  }

  notification.isRead = true;
  notification.readAt = new Date();
  await notification.save();

  return notification;
}

/**
 * Mark all notifications for the authenticated user as read
 */
export async function markAllNotificationsAsRead(
  principal: AuthenticatedPrincipal
): Promise<{ markedCount: number }> {
  await connectToDatabase();
  const recipientObjId = new mongoose.Types.ObjectId(principal.id);

  const res = await Notification.updateMany(
    {
      $or: [{ recipientId: recipientObjId }, { recipientAbha: principal.abhaAddress.toLowerCase() }],
      isRead: false,
    },
    {
      $set: {
        isRead: true,
        readAt: new Date(),
      },
    }
  );

  return { markedCount: res.modifiedCount };
}
