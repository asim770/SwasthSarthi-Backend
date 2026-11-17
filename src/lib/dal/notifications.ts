import mongoose from "mongoose";
import { Notification, INotification, NotificationCategory } from "@/lib/db/models/Notification";
import { AuthenticatedPrincipal } from "./types";
import { ForbiddenError, NotFoundError, ValidationError } from "./errors";
import { assertSafeIdentifier } from "./sanitizer";
import { logAuditEvent } from "./audit";
import { connectToDatabase } from "@/lib/db/connect";

export interface CreateNotificationParams {
  recipientId: string | mongoose.Types.ObjectId;
  recipientAbha?: string;
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

  const recipientObjId =
    typeof params.recipientId === "string"
      ? new mongoose.Types.ObjectId(params.recipientId)
      : params.recipientId;

  const abhaNormalized = (params.recipientAbha || "").toLowerCase();

  const key =
    params.idempotencyKey ||
    `NOTIF-KEY-${recipientObjId}-${params.category}-${params.relatedResourceId || Date.now()}`;

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

  const notification = await Notification.create({
    recipientId: recipientObjId,
    recipientAbha: abhaNormalized,
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
 * Helper to build recipient matching filter without throwing on undefined ABHA or non-ObjectId
 */
function buildRecipientFilter(principal: AuthenticatedPrincipal): Record<string, unknown> {
  const orConditions: Record<string, unknown>[] = [];
  if (mongoose.isValidObjectId(principal.id)) {
    orConditions.push({ recipientId: new mongoose.Types.ObjectId(principal.id) });
  } else if (principal.id) {
    orConditions.push({ recipientId: principal.id });
  }
  if (principal.abhaAddress && principal.abhaAddress.trim()) {
    orConditions.push({ recipientAbha: principal.abhaAddress.toLowerCase().trim() });
  }
  if (principal.patientId && principal.patientId.trim()) {
    orConditions.push({ recipientAbha: principal.patientId.toLowerCase().trim() });
  }
  if (orConditions.length === 0) {
    return { _id: new mongoose.Types.ObjectId() };
  }
  return { $or: orConditions };
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

  const baseFilter = buildRecipientFilter(principal);

  const queryFilter: Record<string, unknown> = { ...baseFilter };
  if (params.unreadOnly) {
    queryFilter.isRead = false;
  }

  const page = Math.max(1, params.page || 1);
  const limit = Math.min(50, Math.max(1, params.limit || 20));
  const skip = (page - 1) * limit;

  const [notifications, total, unreadCount] = await Promise.all([
    Notification.find(queryFilter).sort({ createdAt: -1 }).skip(skip).limit(limit),
    Notification.countDocuments(queryFilter),
    Notification.countDocuments({
      ...baseFilter,
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
  const baseFilter = buildRecipientFilter(principal);

  return Notification.countDocuments({
    ...baseFilter,
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
  const principalAbha = (principal.abhaAddress || principal.patientId || principal.abhaId || "").toLowerCase();
  const notifAbha = (notification.recipientAbha || "").toLowerCase();
  const matchesId = notification.recipientId?.toString() === principal.id;
  const matchesAbha = Boolean(principalAbha && notifAbha && principalAbha === notifAbha);

  if (!matchesId && !matchesAbha) {
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
  const baseFilter = buildRecipientFilter(principal);

  const res = await Notification.updateMany(
    {
      ...baseFilter,
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

/**
 * Delete or dismiss a single notification with strict ownership verification
 */
export async function deleteNotification(
  principal: AuthenticatedPrincipal,
  notificationId: string
): Promise<{ success: boolean }> {
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

  const principalAbha = (principal.abhaAddress || principal.patientId || principal.abhaId || "").toLowerCase();
  const notifAbha = (notification.recipientAbha || "").toLowerCase();
  const matchesId = notification.recipientId?.toString() === principal.id;
  const matchesAbha = Boolean(principalAbha && notifAbha && principalAbha === notifAbha);

  if (!matchesId && !matchesAbha) {
    await logAuditEvent({
      action: "NOTIFICATION_DELETE_DENIED",
      principal,
      targetResourceType: "Notification",
      targetResourceId: notificationId,
      outcome: "DENIED",
      denialReason: "User attempted to delete another user's notification.",
    });
    throw new ForbiddenError("Access denied. You may only manage your own notifications.");
  }

  await notification.deleteOne();

  await logAuditEvent({
    action: "NOTIFICATION_DELETED",
    principal,
    targetResourceType: "Notification",
    targetResourceId: notificationId,
    outcome: "ALLOWED",
  });

  return { success: true };
}

export { sendHealthcareEventNotification } from "@/lib/services/notificationService";
