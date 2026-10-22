import { Queue, Worker, Job } from "bullmq";
import { getBullMQConnectionOptions, getRedisStatus } from "./redis";
import { createNotification, CreateNotificationParams } from "@/lib/dal/notifications";
import { INotification } from "@/lib/db/models/Notification";
import { env } from "@/lib/env";

export const NOTIFICATION_QUEUE_NAME = "swasth-saarthi-notifications-queue";

let notificationQueue: Queue | null = null;
let notificationWorker: Worker | null = null;

export function getNotificationQueue(): Queue | null {
  if (notificationQueue) return notificationQueue;

  try {
    const connection = getBullMQConnectionOptions();
    notificationQueue = new Queue(NOTIFICATION_QUEUE_NAME, {
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

    notificationQueue.on("error", (err) => {
      if (env.NODE_ENV === "development") {
        console.warn(`[BullMQ Notification Queue Notice]: ${err.message}`);
      }
    });

    return notificationQueue;
  } catch (err) {
    console.warn("Failed to initialize BullMQ Notification Queue:", err);
    return null;
  }
}

/**
 * Dispatch notification through background BullMQ worker or immediate resilient fallback
 */
export async function dispatchNotification(
  params: CreateNotificationParams
): Promise<{ enqueued: boolean; notification: INotification; duplicate: boolean }> {
  try {
    const redisCheck = await getRedisStatus();
    if (redisCheck.status === "connected") {
      const queue = getNotificationQueue();
      if (queue) {
        const jobId = params.idempotencyKey || `job-${Date.now()}`;
        await queue.add("send-notification", params, { jobId });
      }
    }
  } catch (err) {
    // Fall back to direct database execution
  }

  // Direct persistence guarantees that notifications are always recorded and verified
  const result = await createNotification(params);
  return {
    enqueued: true,
    notification: result.notification,
    duplicate: result.duplicate,
  };
}

/**
 * Initialize background worker if Redis is active
 */
export function initNotificationWorker(): Worker | null {
  if (notificationWorker) return notificationWorker;

  try {
    const connection = getBullMQConnectionOptions();
    notificationWorker = new Worker(
      NOTIFICATION_QUEUE_NAME,
      async (job: Job<CreateNotificationParams>) => {
        return await createNotification(job.data);
      },
      {
        connection,
        concurrency: 5,
      }
    );

    return notificationWorker;
  } catch (err) {
    return null;
  }
}
