import { Queue, Worker, type Processor, type QueueOptions, type WorkerOptions } from "bullmq";
import { getBullMQConnectionOptions } from "@/lib/queue/redis";

// Common prefix for SwasthSaarthi background queues
const QUEUE_PREFIX = "swasth_saarthi";

const activeQueues = new Map<string, Queue>();
const activeWorkers = new Map<string, Worker>();

/**
 * Get or initialize a BullMQ Queue
 */
export function getOrCreateQueue<DataType = unknown, ResultType = unknown>(
  name: string,
  options?: Partial<QueueOptions>
): Queue<DataType, ResultType> {
  if (activeQueues.has(name)) {
    return activeQueues.get(name) as Queue<DataType, ResultType>;
  }

  const queue = new Queue<DataType, ResultType>(name, {
    connection: getBullMQConnectionOptions(),
    prefix: QUEUE_PREFIX,
    defaultJobOptions: {
      attempts: 3,
      backoff: {
        type: "exponential",
        delay: 2000,
      },
      removeOnComplete: {
        age: 3600, // keep completed jobs for 1 hour
        count: 500,
      },
      removeOnFail: {
        age: 86400, // keep failed jobs for 24 hours
      },
    },
    ...options,
  });

  activeQueues.set(name, queue);
  return queue;
}

/**
 * Create a BullMQ worker for background job execution
 */
export function createWorker<DataType = unknown, ResultType = unknown>(
  name: string,
  processor: Processor<DataType, ResultType>,
  options?: Partial<WorkerOptions>
): Worker<DataType, ResultType> {
  if (activeWorkers.has(name)) {
    return activeWorkers.get(name) as Worker<DataType, ResultType>;
  }

  const worker = new Worker<DataType, ResultType>(name, processor, {
    connection: getBullMQConnectionOptions(),
    prefix: QUEUE_PREFIX,
    concurrency: 5,
    ...options,
  });

  worker.on("completed", (job) => {
    console.log(`[BullMQ] Job ${job.id} on ${name} completed`);
  });

  worker.on("failed", (job, err) => {
    console.error(`[BullMQ] Job ${job?.id} on ${name} failed:`, err.message);
  });

  activeWorkers.set(name, worker);
  return worker;
}

/**
 * Gracefully close all queues and workers
 */
export async function closeQueueConnections(): Promise<void> {
  const closeWorkers = Array.from(activeWorkers.values()).map((w) => w.close());
  const closeQueues = Array.from(activeQueues.values()).map((q) => q.close());
  await Promise.all([...closeWorkers, ...closeQueues]);
  activeWorkers.clear();
  activeQueues.clear();
}
