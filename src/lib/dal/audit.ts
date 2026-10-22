import mongoose from "mongoose";
import crypto from "crypto";
import { AuditLog, AuditOutcome, IAuditLog } from "@/lib/db/models/AuditLog";
import { AuditChainHead, GENESIS_HASH } from "@/lib/db/models/AuditChainHead";
import { AuthenticatedPrincipal } from "./types";
import { ForbiddenError } from "./errors";
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
  correlationId?: string;
  metadata?: Record<string, unknown>;
}

export interface CanonicalAuditData {
  sequenceNumber: number;
  previousEventHash: string;
  action: string;
  principalId?: string;
  principalRole?: string;
  targetResourceType: string;
  targetResourceId?: string;
  targetPatientId?: string;
  outcome: string;
  timestamp: string;
  schemaVersion: number;
}

/**
 * Deterministically serialize audit event to canonical JSON
 */
export function canonicalizeAuditEvent(data: CanonicalAuditData): string {
  return JSON.stringify({
    action: data.action,
    outcome: data.outcome,
    previousEventHash: data.previousEventHash,
    principalId: data.principalId || "",
    principalRole: data.principalRole || "",
    schemaVersion: data.schemaVersion || 1,
    sequenceNumber: data.sequenceNumber,
    targetPatientId: data.targetPatientId || "",
    targetResourceId: data.targetResourceId || "",
    targetResourceType: data.targetResourceType,
    timestamp: data.timestamp,
  });
}

/**
 * Compute SHA-256 cryptographic hash of canonical audit event string
 */
export function computeEventHash(canonicalString: string): string {
  return crypto.createHash("sha256").update(canonicalString).digest("hex");
}

/**
 * Record a security-relevant event to the append-only, hash-chained audit trail
 * Explicitly sanitizes metadata to never log raw FHIR content, credentials, or secrets
 */
export async function logAuditEvent(params: LogAuditParams): Promise<IAuditLog | void> {
  try {
    await connectToDatabase();

    // Sanitize metadata to exclude any accidental PHI, passwords, OTPs, or credential leaks
    const cleanMetadata: Record<string, unknown> = {};
    if (params.metadata) {
      for (const [key, value] of Object.entries(params.metadata)) {
        if (
          [
            "password",
            "otp",
            "token",
            "secret",
            "clinicaldata",
            "fhirbundle",
            "rawcontent",
            "aadhaar",
          ].some((sensitive) => key.toLowerCase().includes(sensitive))
        ) {
          cleanMetadata[key] = "[REDACTED]";
        } else if (typeof value === "object" && value !== null) {
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

    // Advance hash chain with optimistic concurrency control and retries
    const maxRetries = 10;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      let head = await AuditChainHead.findOne({ chainId: "MAIN" });
      if (!head) {
        head = await AuditChainHead.create({
          chainId: "MAIN",
          currentSequence: 0,
          lastEventHash: GENESIS_HASH,
        });
      }

      const nextSequence = head.currentSequence + 1;
      const prevHash = head.lastEventHash;
      const eventTimestamp = new Date();

      const canonicalString = canonicalizeAuditEvent({
        sequenceNumber: nextSequence,
        previousEventHash: prevHash,
        action: params.action,
        principalId: principalObjId?.toString(),
        principalRole: params.principal?.role || "anonymous",
        targetResourceType: params.targetResourceType,
        targetResourceId: params.targetResourceId,
        targetPatientId: patientObjId?.toString(),
        outcome: params.outcome,
        timestamp: eventTimestamp.toISOString(),
        schemaVersion: 1,
      });

      const currentHash = computeEventHash(canonicalString);

      // Atomic conditional CAS update: only advances if sequence and prevHash match current state
      const updatedHead = await AuditChainHead.findOneAndUpdate(
        {
          chainId: "MAIN",
          currentSequence: head.currentSequence,
          lastEventHash: prevHash,
        },
        {
          $set: {
            currentSequence: nextSequence,
            lastEventHash: currentHash,
          },
        },
        { returnDocument: "after" }
      );

      if (updatedHead) {
        // Linear chain head acquired successfully! Insert immutable event document
        const createdLog = await AuditLog.create({
          eventId: `EVT-${nextSequence}-${Date.now()}`,
          sequenceNumber: nextSequence,
          previousEventHash: prevHash,
          currentEventHash: currentHash,
          schemaVersion: 1,
          correlationId: params.correlationId,
          action: params.action,
          principalId: principalObjId,
          principalRole: params.principal?.role || "anonymous",
          principalName: params.principal?.name,
          facility: params.principal?.facility,
          targetResourceType: params.targetResourceType,
          targetResourceId: params.targetResourceId,
          targetPatientId: patientObjId,
          outcome: params.outcome,
          denialReason: params.denialReason,
          ipAddress: params.ipAddress,
          userAgent: params.userAgent,
          metadata: cleanMetadata,
          timestamp: eventTimestamp,
        });

        return createdLog;
      }

      // Race detected: back off and retry next sequence slot
      await new Promise((resolve) => setTimeout(resolve, 5 + attempt * 15));
    }

    // Fallback: in case of extreme contention, persist event with next best sequence
    const fallbackSeq = (await AuditLog.countDocuments({})) + 1;
    return await AuditLog.create({
      eventId: `EVT-${fallbackSeq}-${Date.now()}`,
      sequenceNumber: fallbackSeq,
      previousEventHash: GENESIS_HASH,
      currentEventHash: computeEventHash(`${params.action}-${fallbackSeq}-${Date.now()}`),
      schemaVersion: 1,
      action: params.action,
      principalId: principalObjId,
      principalRole: params.principal?.role || "anonymous",
      principalName: params.principal?.name,
      facility: params.principal?.facility,
      targetResourceType: params.targetResourceType,
      targetResourceId: params.targetResourceId,
      targetPatientId: patientObjId,
      outcome: params.outcome,
      denialReason: params.denialReason,
      metadata: cleanMetadata,
      timestamp: new Date(),
    });
  } catch (err) {
    console.error("⚠️ AuditLog write failure:", err);
  }
}

/**
 * Verify integrity of the hash-chained audit log sequence
 * Detects: altered content, reordered events, missing records, or broken links
 */
export async function verifyAuditChainIntegrity(
  fromSeq = 1,
  toSeq?: number
): Promise<{
  valid: boolean;
  totalVerified: number;
  fromSequence: number;
  toSequence: number;
  brokenAtSequence?: number;
  details?: string;
}> {
  await connectToDatabase();

  const query: Record<string, unknown> = {
    sequenceNumber: { $gte: fromSeq },
  };
  if (toSeq !== undefined) {
    (query.sequenceNumber as Record<string, unknown>).$lte = toSeq;
  }

  const logs = await AuditLog.find(query).sort({ sequenceNumber: 1 });

  if (logs.length === 0) {
    return {
      valid: true,
      totalVerified: 0,
      fromSequence: fromSeq,
      toSequence: toSeq || fromSeq,
      details: "No audit events found in requested sequence range.",
    };
  }

  let expectedSeq = fromSeq;
  let expectedPrevHash: string | null = null;

  for (let i = 0; i < logs.length; i++) {
    const event = logs[i];

    // 1. Contiguity check
    if (event.sequenceNumber !== expectedSeq) {
      return {
        valid: false,
        totalVerified: i,
        fromSequence: fromSeq,
        toSequence: logs[logs.length - 1].sequenceNumber || expectedSeq,
        brokenAtSequence: event.sequenceNumber,
        details: `Sequence discontinuity: expected sequence ${expectedSeq}, but encountered ${event.sequenceNumber}.`,
      };
    }

    // 2. Genesis or previous hash link check
    if (i === 0) {
      if (fromSeq === 1 && event.previousEventHash !== GENESIS_HASH) {
        return {
          valid: false,
          totalVerified: 0,
          fromSequence: fromSeq,
          toSequence: logs[logs.length - 1].sequenceNumber || expectedSeq,
          brokenAtSequence: event.sequenceNumber,
          details: `Genesis record invalid: previousEventHash must be ${GENESIS_HASH}, got ${event.previousEventHash}`,
        };
      }
    } else if (expectedPrevHash && event.previousEventHash !== expectedPrevHash) {
      return {
        valid: false,
        totalVerified: i,
        fromSequence: fromSeq,
        toSequence: logs[logs.length - 1].sequenceNumber || expectedSeq,
        brokenAtSequence: event.sequenceNumber,
        details: `Chain linkage mismatch at sequence ${event.sequenceNumber}: expected previous hash ${expectedPrevHash}, but found ${event.previousEventHash}.`,
      };
    }

    // 3. Cryptographic hash re-computation check (detects content tampering)
    const canonicalString = canonicalizeAuditEvent({
      sequenceNumber: event.sequenceNumber!,
      previousEventHash: event.previousEventHash || "",
      action: event.action,
      principalId: event.principalId?.toString(),
      principalRole: event.principalRole,
      targetResourceType: event.targetResourceType,
      targetResourceId: event.targetResourceId,
      targetPatientId: event.targetPatientId?.toString(),
      outcome: event.outcome,
      timestamp: event.timestamp.toISOString(),
      schemaVersion: event.schemaVersion || 1,
    });

    const expectedHash = computeEventHash(canonicalString);
    if (event.currentEventHash !== expectedHash) {
      return {
        valid: false,
        totalVerified: i,
        fromSequence: fromSeq,
        toSequence: logs[logs.length - 1].sequenceNumber || expectedSeq,
        brokenAtSequence: event.sequenceNumber,
        details: `Payload integrity altered at sequence ${event.sequenceNumber}: recomputed hash ${expectedHash} does not match recorded ${event.currentEventHash}.`,
      };
    }

    expectedPrevHash = event.currentEventHash;
    expectedSeq++;
  }

  return {
    valid: true,
    totalVerified: logs.length,
    fromSequence: fromSeq,
    toSequence: logs[logs.length - 1].sequenceNumber || expectedSeq - 1,
    details: `Chain integrity verified across ${logs.length} contiguous audit events.`,
  };
}

/**
 * Patient scoped access history: returns non-sensitive metadata for patient's own records
 */
export async function getPatientAccessHistory(
  principal: AuthenticatedPrincipal,
  limit = 50
): Promise<Array<Record<string, unknown>>> {
  if (principal.role !== "patient") {
    throw new ForbiddenError("Only patients may query their access history ledger.");
  }

  await connectToDatabase();

  const logs = await AuditLog.find({
    targetPatientId: new mongoose.Types.ObjectId(principal.id),
    outcome: "ALLOWED",
  })
    .sort({ timestamp: -1 })
    .limit(Math.min(limit, 100));

  return logs.map((l) => ({
    eventId: l.eventId,
    sequenceNumber: l.sequenceNumber,
    timestamp: l.timestamp,
    action: l.action,
    accessorRole: l.principalRole,
    accessorName: l.principalName || "Authorized Healthcare Practitioner",
    facility: l.facility || "Verified Facility Network",
    resourceType: l.targetResourceType,
    outcome: l.outcome,
  }));
}
