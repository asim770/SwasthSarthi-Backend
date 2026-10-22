import { AuthenticatedPrincipal } from "./types";
import { UserRole } from "@/lib/db/models/User";
import {
  UnauthenticatedError,
  ForbiddenError,
  AuthorizationError,
} from "./errors";
import { validateSession } from "@/lib/auth/session";

/**
 * Resolve and verify the trusted authenticated principal from server-side session
 * Rejects unauthenticated requests and inactive accounts
 */
export async function requireAuthenticatedUser(
  request: Request
): Promise<AuthenticatedPrincipal> {
  const result = await validateSession(request);

  if (!result.user || !result.session) {
    if (result.error === "USER_INACTIVE") {
      throw new ForbiddenError("Account is inactive or suspended.");
    }
    throw new UnauthenticatedError(
      result.error === "SESSION_EXPIRED"
        ? "Session has expired. Please sign in again."
        : result.error === "SESSION_INACTIVITY_TIMEOUT"
        ? "Session timed out due to inactivity."
        : "Authentication session required."
    );
  }

  if (!result.user.isActive) {
    throw new ForbiddenError("Account is inactive or suspended.");
  }

  return {
    id: result.user._id.toString(),
    abhaId: result.user.abhaId,
    abhaAddress: result.user.abhaAddress,
    name: result.user.name,
    role: result.user.role,
    isActive: result.user.isActive,
    facility: result.user.facility,
    specialization: result.user.specialization,
    sessionId: result.session.sessionId,
  };
}

/**
 * Enforce that the principal possesses one of the allowed roles
 */
export function requireAllowedRole(
  principal: AuthenticatedPrincipal,
  allowedRoles: UserRole[],
  customMessage?: string
): void {
  if (!allowedRoles.includes(principal.role)) {
    throw new ForbiddenError(
      customMessage ||
        `Role '${principal.role}' is not authorized to perform this operation. Allowed: [${allowedRoles.join(
          ", "
        )}]`
    );
  }
}

/**
 * Check active user status
 */
export function checkActiveUserStatus(principal: AuthenticatedPrincipal): void {
  if (!principal.isActive) {
    throw new ForbiddenError("User account is disabled or inactive.");
  }
}

/**
 * Enforce strict patient ownership: target patient ID must match principal's user ID
 */
export function assertPatientOwnership(
  principal: AuthenticatedPrincipal,
  targetPatientId: string,
  resourceName = "patient record"
): void {
  if (principal.role !== "patient") {
    throw new ForbiddenError(
      `Only patients can assert ownership over their data. Current role: ${principal.role}`
    );
  }

  if (principal.id !== targetPatientId) {
    throw new ForbiddenError(
      `Access denied. You can only access your own ${resourceName}.`
    );
  }
}

/**
 * Verify practitioner or staff membership within a facility
 */
export function assertFacilityMembership(
  principal: AuthenticatedPrincipal,
  targetFacility: string
): void {
  if (!principal.facility) {
    throw new ForbiddenError("User has no associated facility registration.");
  }

  // Exact or normalized facility name match
  const userFac = principal.facility.trim().toLowerCase();
  const reqFac = targetFacility.trim().toLowerCase();

  if (userFac !== reqFac) {
    throw new ForbiddenError(
      `Cross-facility access denied. Your facility '${principal.facility}' does not match '${targetFacility}'.`
    );
  }
}

/**
 * Strictly deny administrative users from accessing clinical content, FHIR resources, or medical data
 * An administrator must NEVER read clinical records under any circumstances.
 */
export function assertDenyAdminClinicalAccess(
  principal: AuthenticatedPrincipal,
  context = "clinical health records"
): void {
  if (principal.role === "admin") {
    throw new ForbiddenError(
      `Security Violation: Administrators are strictly forbidden from viewing or accessing ${context}. Administrative privileges do not grant clinical data access.`
    );
  }
}

/**
 * Verify laboratory access scope
 */
export function assertLabOrderScope(
  principal: AuthenticatedPrincipal,
  orderTargetFacility: string
): void {
  requireAllowedRole(principal, ["laboratory"], "Only laboratories may access test orders.");
  assertFacilityMembership(principal, orderTargetFacility);
}

/**
 * Verify pharmacy dispensation scope
 */
export function assertPharmacyScope(
  principal: AuthenticatedPrincipal,
  prescriptionFacility?: string
): void {
  requireAllowedRole(principal, ["pharmacy"], "Only pharmacies may dispense prescriptions.");
  if (prescriptionFacility && principal.facility) {
    // If prescription is constrained to a facility
    const userFac = principal.facility.trim().toLowerCase();
    const rxFac = prescriptionFacility.trim().toLowerCase();
    if (userFac !== rxFac && !userFac.includes("hub") && !rxFac.includes("hub")) {
      throw new ForbiddenError(
        `Cross-facility prescription dispensation denied. Prescribed for '${prescriptionFacility}'.`
      );
    }
  }
}
