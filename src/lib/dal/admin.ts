import { User, IUser } from "@/lib/db/models/User";
import { AuditLog, IAuditLog } from "@/lib/db/models/AuditLog";
import { Session } from "@/lib/db/models/Session";
import { ConsentArtifact } from "@/lib/db/models/ConsentArtifact";
import { AuthenticatedPrincipal } from "./types";
import {
  NotFoundError,
  ForbiddenError,
} from "./errors";
import { requireAllowedRole } from "./policies";
import { assertSafeIdentifier } from "./sanitizer";
import { logAuditEvent } from "./audit";
import { connectToDatabase } from "@/lib/db/connect";

export interface ListUsersAdminOptions {
  page?: number;
  limit?: number;
  role?: string;
  status?: string;
  verificationStatus?: string;
  search?: string;
}

export interface AdminUsersResult {
  users: Partial<IUser>[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

/**
 * List registered user accounts for administrative management
 * Returns strictly administrative metadata without any clinical details
 * Supports server-side pagination, debounced search, role filtering, and status filtering
 */
export async function listUsersForAdmin(
  principal: AuthenticatedPrincipal,
  options?: ListUsersAdminOptions
): Promise<AdminUsersResult> {
  requireAllowedRole(principal, ["admin"], "Only administrators may view user directories.");
  await connectToDatabase();

  const query: Record<string, unknown> = {};

  if (options?.role && options.role.toUpperCase() !== "ALL") {
    const roleLower = options.role.toLowerCase();
    const validRoles = ["patient", "doctor", "laboratory", "pharmacy", "admin"];
    if (validRoles.includes(roleLower)) {
      query.role = roleLower;
    }
  }

  if (options?.status && options.status.toUpperCase() !== "ALL") {
    const statusUpper = options.status.toUpperCase();
    if (statusUpper === "ACTIVE") {
      query.isActive = true;
    } else if (statusUpper === "SUSPENDED") {
      query.isActive = false;
    }
  }

  if (options?.verificationStatus && options.verificationStatus.toUpperCase() !== "ALL") {
    query.verificationStatus = options.verificationStatus.toUpperCase();
  }

  if (options?.search && options.search.trim()) {
    const escaped = options.search.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    query.$or = [
      { name: { $regex: escaped, $options: "i" } },
      { email: { $regex: escaped, $options: "i" } },
      { patientId: { $regex: escaped, $options: "i" } },
      { abhaAddress: { $regex: escaped, $options: "i" } },
      { phone: { $regex: escaped, $options: "i" } },
      { facility: { $regex: escaped, $options: "i" } },
      { specialization: { $regex: escaped, $options: "i" } },
    ];
  }

  const page = Math.max(1, options?.page || 1);
  const limit = Math.min(50, Math.max(1, options?.limit || 10));
  const skip = (page - 1) * limit;

  const [users, total] = await Promise.all([
    User.find(query)
      .select(
        "_id patientId abhaId abhaAddress name email phone role isActive verificationStatus facility specialization createdAt updatedAt"
      )
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit),
    User.countDocuments(query),
  ]);

  const totalPages = Math.ceil(total / limit) || 1;

  await logAuditEvent({
    action: "ADMIN_LIST_USERS",
    principal,
    targetResourceType: "User",
    outcome: "ALLOWED",
    metadata: {
      count: users.length,
      total,
      page,
      limit,
      roleFilter: options?.role || "ALL",
      statusFilter: options?.status || "ALL",
      hasSearch: Boolean(options?.search),
    },
  });

  return {
    users,
    total,
    page,
    limit,
    totalPages,
  };
}

/**
 * Update user account status (active/suspended)
 * Prevents self-suspension by administrator
 */
export async function updateUserStatus(
  principal: AuthenticatedPrincipal,
  targetUserId: string,
  isActive: boolean
): Promise<Partial<IUser>> {
  requireAllowedRole(principal, ["admin"], "Only administrators may modify user account status.");
  assertSafeIdentifier(targetUserId, "targetUserId");

  if (principal.id === targetUserId) {
    await logAuditEvent({
      action: "ADMIN_SELF_STATUS_CHANGE_BLOCKED",
      principal,
      targetResourceType: "User",
      targetResourceId: targetUserId,
      outcome: "DENIED",
      denialReason: "Administrator attempted to modify their own active account status.",
    });
    throw new ForbiddenError("Administrators cannot modify their own active account status.");
  }

  await connectToDatabase();

  const user = await User.findById(targetUserId);
  if (!user) {
    throw new NotFoundError(`User '${targetUserId}' not found.`);
  }

  user.isActive = isActive;
  await user.save();

  // If user was deactivated, revoke all active sessions for that user
  if (!isActive) {
    await Session.updateMany(
      { userId: user._id, isRevoked: false },
      { isRevoked: true, revokedAt: new Date() }
    );
  }

  await logAuditEvent({
    action: "ADMIN_UPDATE_USER_STATUS",
    principal,
    targetResourceType: "User",
    targetResourceId: targetUserId,
    outcome: "ALLOWED",
    metadata: { isActive },
  });

  return {
    _id: user._id,
    patientId: user.patientId,
    abhaId: user.abhaId,
    name: user.name,
    email: user.email,
    role: user.role,
    isActive: user.isActive,
    verificationStatus: user.verificationStatus,
  };
}

/**
 * View security audit metadata (Strictly anonymized/redacted of PHI)
 */
export async function getAuditMetadata(
  principal: AuthenticatedPrincipal,
  limit = 50
): Promise<IAuditLog[]> {
  requireAllowedRole(principal, ["admin"], "Only administrators may inspect security audit logs.");
  await connectToDatabase();

  const logs = await AuditLog.find({})
    .sort({ timestamp: -1 })
    .limit(Math.min(limit, 100));

  await logAuditEvent({
    action: "ADMIN_VIEW_AUDIT_LOGS",
    principal,
    targetResourceType: "AuditLog",
    outcome: "ALLOWED",
    metadata: { logsCount: logs.length },
  });

  return logs;
}

/**
 * Retrieve high-level operational statistics for administrator dashboard
 */
export async function getOperationalHealth(
  principal: AuthenticatedPrincipal
): Promise<{
  totalUsers: number;
  activeSessions: number;
  totalConsents: number;
  grantedConsents: number;
}> {
  requireAllowedRole(principal, ["admin"], "Only administrators may view operational health statistics.");
  await connectToDatabase();

  const [totalUsers, activeSessions, totalConsents, grantedConsents] =
    await Promise.all([
      User.countDocuments({}),
      Session.countDocuments({ isRevoked: false, expiresAt: { $gt: new Date() } }),
      ConsentArtifact.countDocuments({}),
      ConsentArtifact.countDocuments({ status: "GRANTED" }),
    ]);

  return {
    totalUsers,
    activeSessions,
    totalConsents,
    grantedConsents,
  };
}
