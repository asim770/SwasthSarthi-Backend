import mongoose from "mongoose";
import { AuditLog, AuditOutcome } from "@/lib/db/models/AuditLog";
import { AuthenticatedPrincipal } from "./types";
import { connectToDatabase } from "@/lib/db/connect";

export interface LogAuditParams {
  action: string;
  principal?: Partial<AuthenticatedPrincipal> | null;
  targetResourceType: string;
  targetResourceId?: string;
  targetPatientId?: string | mongoose.Types.ObjectId;
  outcome: AuditOutcome;
  denialReason?: string;
  ipAddress?: string;
  userAgent?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Record a security-relevant event to the audit trail
 * Explicitly sanitizes metadata to never log raw FHIR content, credentials, or secrets
 */
export async function logAuditEvent(params: LogAuditParams): Promise<void> {
  try {
    await connectToDatabase();

    // Sanitize metadata to exclude any accidental PHI or credential leaks
    const cleanMetadata: Record<string, unknown> = {};
    if (params.metadata) {
      for (const [key, value] of Object.entries(params.metadata)) {
        if (
          [
            "password",
            "otp",
            "token",
            "secret",
            "clinicalData",
            "fhirBundle",
            "rawContent",
            "aadhaar",
          ].some((sensitive) => key.toLowerCase().includes(sensitive))
        ) {
          cleanMetadata[key] = "[REDACTED]";
        } else if (typeof value === "object" && value !== null) {
          // Avoid deep serializing complex objects in audit
          cleanMetadata[key] = Array.isArray(value)
            ? `[Array(${value.length})]`
            : "[Object]";
        } else {
          cleanMetadata[key] = value;
        }
      }
    }

    let patientObjId: mongoose.Types.ObjectId | undefined;
    if (params.targetPatientId) {
      if (typeof params.targetPatientId === "string" && mongoose.isValidObjectId(params.targetPatientId)) {
        patientObjId = new mongoose.Types.ObjectId(params.targetPatientId);
      } else if (params.targetPatientId instanceof mongoose.Types.ObjectId) {
        patientObjId = params.targetPatientId;
      }
    }

    let principalObjId: mongoose.Types.ObjectId | undefined;
    if (params.principal?.id && mongoose.isValidObjectId(params.principal.id)) {
      principalObjId = new mongoose.Types.ObjectId(params.principal.id);
    }

    await AuditLog.create({
      action: params.action,
      principalId: principalObjId,
      principalRole: params.principal?.role || "anonymous",
      principalName: params.principal?.name,
      targetResourceType: params.targetResourceType,
      targetResourceId: params.targetResourceId,
      targetPatientId: patientObjId,
      outcome: params.outcome,
      denialReason: params.denialReason,
      ipAddress: params.ipAddress,
      userAgent: params.userAgent,
      metadata: cleanMetadata,
      timestamp: new Date(),
    });
  } catch (err) {
    // Non-blocking catch to prevent logging failure from masking the underlying application flow,
    // but logged to console for security telemetry
    console.error("⚠️ AuditLog write failure:", err);
  }
}
