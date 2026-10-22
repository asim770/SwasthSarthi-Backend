import { Queue, Worker, Job } from "bullmq";
import { getBullMQConnectionOptions } from "./redis";
import { sweepExpiredConsents, evaluateConsent } from "@/lib/dal/consents";
import { logAuditEvent } from "@/lib/dal/audit";
import { env } from "@/lib/env";

export const CONSENT_QUEUE_NAME = "consent-maintenance-queue";

export interface QueuedDataTransferPayload {
  transferId: string;
  consentId: string;
  patientId: string;
  doctorId: string;
  doctorFacility?: string;
  resourceType: string;
  recordDate?: string;
}

let consentQueue: Queue | null = null;
let consentWorker: Worker | null = null;

/**
 * Get or initialize BullMQ Consent Queue safely
 */
export function getConsentQueue(): Queue | null {
  if (consentQueue) return consentQueue;

  try {
    const connection = getBullMQConnectionOptions();
    consentQueue = new Queue(CONSENT_QUEUE_NAME, {
      connection,
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: "exponential",
          delay: 1000,
        },
        removeOnComplete: 100,
        removeOnFail: 200,
      },
    });

    consentQueue.on("error", (err) => {
      if (env.NODE_ENV === "development") {
        console.warn(`[BullMQ Queue Warning]: ${err.message}`);
      }
    });

    return consentQueue;
  } catch (err) {
    console.warn("Failed to initialize BullMQ Consent Queue:", err);
    return null;
  }
}

/**
 * Worker-level consent verification for queued health data transfer.
 * If consent is revoked, expired, or invalid while in the queue,
 * the worker MUST recheck authorization and deny the release of records.
 */
export async function verifyConsentForQueuedTransfer(
  payload: QueuedDataTransferPayload
): Promise<{ allowed: boolean; reason?: string }> {
  const dateObj = payload.recordDate ? new Date(payload.recordDate) : undefined;

  const evaluation = await evaluateConsent(
    payload.patientId,
    payload.doctorId,
    payload.resourceType,
    dateObj
  );

  if (!evaluation.hasConsent) {
    await logAuditEvent({
      action: "QUEUED_TRANSFER_CONSENT_DENIED",
      principal: {
        id: payload.doctorId,
        role: "doctor",
        name: "Doctor via Queue Worker",
        facility: payload.doctorFacility,
      },
      targetResourceType: "HealthRecord",
      targetResourceId: payload.transferId,
      targetPatientId: payload.patientId,
      outcome: "DENIED",
      denialReason: `Worker recheck failed: ${evaluation.reason}`,
      metadata: {
        consentId: payload.consentId,
        resourceType: payload.resourceType,
      },
    });

    return { allowed: false, reason: evaluation.reason };
  }

  return { allowed: true };
}

/**
 * Initialize background worker for periodic expiry maintenance and queued transfers
 */
export function initConsentWorker(): Worker | null {
  if (consentWorker) return consentWorker;

  try {
    const connection = getBullMQConnectionOptions();
    consentWorker = new Worker(
      CONSENT_QUEUE_NAME,
      async (job: Job) => {
        if (job.name === "SWEEP_EXPIRED_CONSENTS") {
          const result = await sweepExpiredConsents();
          return { sweepResult: result };
        }

        if (job.name === "HEALTH_DATA_TRANSFER") {
          const payload = job.data as QueuedDataTransferPayload;
          const verification = await verifyConsentForQueuedTransfer(payload);
          if (!verification.allowed) {
            throw new Error(`Data transfer aborted: consent invalid (${verification.reason})`);
          }
          return { status: "TRANSFERRED", transferId: payload.transferId };
        }

        return { unhandled: true };
      },
      { connection }
    );

    consentWorker.on("error", (err) => {
      if (env.NODE_ENV === "development") {
        console.warn(`[BullMQ Worker Warning]: ${err.message}`);
      }
    });

    return consentWorker;
  } catch (err) {
    console.warn("Failed to initialize BullMQ Consent Worker:", err);
    return null;
  }
}
