import { Queue, Worker, Job } from "bullmq";
import { getBullMQConnectionOptions, getRedisStatus } from "./redis";
import { mockAbdmAdapter } from "@/lib/abdm/mockAdapter";
import { AuthenticatedPrincipal } from "@/lib/dal/types";
import { env } from "@/lib/env";

export const ABDM_TRANSFER_QUEUE_NAME = "abdm-data-transfer-queue";

export interface TransferJobData {
  transferId: string;
  requesterPrincipal: AuthenticatedPrincipal;
}

let transferQueue: Queue | null = null;
let transferWorker: Worker | null = null;

export function getTransferQueue(): Queue | null {
  if (transferQueue) return transferQueue;

  try {
    const connection = getBullMQConnectionOptions();
    transferQueue = new Queue(ABDM_TRANSFER_QUEUE_NAME, {
      connection,
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: "exponential",
          delay: 1500,
        },
        removeOnComplete: 100,
        removeOnFail: 200,
      },
    });

    transferQueue.on("error", (err) => {
      if (env.NODE_ENV === "development") {
        console.warn(`[BullMQ Transfer Queue Notice]: ${err.message}`);
      }
    });

    return transferQueue;
  } catch (err) {
    console.warn("Failed to initialize BullMQ Transfer Queue:", err);
    return null;
  }
}

/**
 * Enqueue or execute transfer job with resilient fallback when Redis is unavailable
 */
export async function dispatchHealthDataTransfer(
  transferId: string,
  principal: AuthenticatedPrincipal
): Promise<{ enqueued: boolean; executedDirectly: boolean }> {
  try {
    const redisCheck = await getRedisStatus();
    if (redisCheck.status === "connected") {
      const queue = getTransferQueue();
      if (queue) {
        await queue.add(
          "EXECUTE_ABDM_TRANSFER",
          {
            transferId,
            requesterPrincipal: principal,
          },
          {
            jobId: `transfer-${transferId}`,
          }
        );
        return { enqueued: true, executedDirectly: false };
      }
    }
  } catch {
    // Redis unavailable, fallback to direct execution
  }

  // Resilient in-process async execution for test / development environments without active Redis
  await mockAbdmAdapter.executeTransfer(transferId, principal);
  return { enqueued: false, executedDirectly: true };
}

/**
 * Initialize background worker for ABDM transfers
 */
export function initTransferWorker(): Worker | null {
  if (transferWorker) return transferWorker;

  try {
    const connection = getBullMQConnectionOptions();
    transferWorker = new Worker(
      ABDM_TRANSFER_QUEUE_NAME,
      async (job: Job) => {
        if (job.name === "EXECUTE_ABDM_TRANSFER") {
          const { transferId, requesterPrincipal } = job.data as TransferJobData;
          return await mockAbdmAdapter.executeTransfer(transferId, requesterPrincipal);
        }
        return { unhandled: true };
      },
      { connection }
    );

    transferWorker.on("error", (err) => {
      if (env.NODE_ENV === "development") {
        console.warn(`[BullMQ Transfer Worker Notice]: ${err.message}`);
      }
    });

    return transferWorker;
  } catch (err) {
    console.warn("Failed to initialize BullMQ Transfer Worker:", err);
    return null;
  }
}
