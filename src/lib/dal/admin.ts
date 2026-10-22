import { User, IUser } from "@/lib/db/models/User";
import { AuditLog, IAuditLog } from "@/lib/db/models/AuditLog";
import { Session } from "@/lib/db/models/Session";
import { ConsentArtifact } from "@/lib/db/models/ConsentArtifact";
import { AuthenticatedPrincipal } from "./types";
import {
  NotFoundError,
} from "./errors";
import { requireAllowedRole } from "./policies";
import { assertSafeIdentifier } from "./sanitizer";
import { logAuditEvent } from "./audit";
import { connectToDatabase } from "@/lib/db/connect";

/**
 * List registered user accounts for administrative management
 * Returns strictly administrative metadata without any clinical details
 */
export async function listUsersForAdmin(
  principal: AuthenticatedPrincipal
): Promise<Partial<IUser>[]> {
  requireAllowedRole(principal, ["admin"], "Only administrators may view user directories.");
  await connectToDatabase();

  const users = await User.find({})
    .select("_id abhaId abhaAddress name role isActive phone facility specialization createdAt updatedAt")
    .sort({ createdAt: -1 });

  await logAuditEvent({
    action: "ADMIN_LIST_USERS",
    principal,
    targetResourceType: "User",
    outcome: "ALLOWED",
    metadata: { count: users.length },
  });

  return users;
}

/**
 * Update user account status (active/suspended)
 */
export async function updateUserStatus(
  principal: AuthenticatedPrincipal,
  targetUserId: string,
  isActive: boolean
): Promise<Partial<IUser>> {
  requireAllowedRole(principal, ["admin"], "Only administrators may modify user account status.");
  assertSafeIdentifier(targetUserId, "targetUserId");
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
    abhaId: user.abhaId,
    name: user.name,
    role: user.role,
    isActive: user.isActive,
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
