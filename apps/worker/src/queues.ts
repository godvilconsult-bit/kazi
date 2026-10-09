import { Queue, type ConnectionOptions, type DefaultJobOptions } from "bullmq";
import { QUEUE_NAMES, type QueueName } from "@kazi/shared";

/** Queues from docs/02-ARCHITECTURE.md §4; names and payloads live in @kazi/shared (jobs.ts). */
export { QUEUE_NAMES, type QueueName };

/** All jobs: max 5 attempts, exponential backoff; failed jobs are kept (dead-letter, visible in admin). */
export const DEFAULT_JOB_OPTIONS: DefaultJobOptions = {
  attempts: 5,
  backoff: { type: "exponential", delay: 2_000 },
  removeOnComplete: { count: 1_000 },
  removeOnFail: false,
};

export function createQueues(
  connection: ConnectionOptions,
  prefix: string,
): Record<QueueName, Queue> {
  return Object.fromEntries(
    QUEUE_NAMES.map((name) => [
      name,
      new Queue(name, { connection, prefix, defaultJobOptions: DEFAULT_JOB_OPTIONS }),
    ]),
  ) as Record<QueueName, Queue>;
}
