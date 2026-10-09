import { Queue, type ConnectionOptions } from "bullmq";
import { QUEUE_NAMES, type QueueName } from "@kazi/shared";

const COUNT_STATES = ["waiting", "active", "delayed", "failed", "completed"] as const;
export type QueueCounts = Record<QueueName, Record<(typeof COUNT_STATES)[number], number>>;

/** The API only produces jobs (docs/04-BACKEND-API.md); the worker consumes them. */
export interface JobQueue {
  /** Idempotent: a job with the same id that still exists is not added again. */
  enqueue(
    queue: QueueName,
    name: string,
    data: Record<string, unknown>,
    jobId: string,
  ): Promise<void>;
  /** Job counts per queue for the admin dashboard. */
  counts(): Promise<QueueCounts>;
  close(): Promise<void>;
}

export function bullmqJobQueue(connection: ConnectionOptions, prefix: string): JobQueue {
  const queues = new Map<QueueName, Queue>();
  const get = (name: QueueName) => {
    let q = queues.get(name);
    if (!q) {
      q = new Queue(name, {
        connection,
        prefix,
        defaultJobOptions: {
          attempts: 5,
          backoff: { type: "exponential", delay: 2_000 },
          removeOnComplete: { count: 1_000 },
          removeOnFail: false,
        },
      });
      queues.set(name, q);
    }
    return q;
  };
  return {
    async enqueue(queue, name, data, jobId) {
      await get(queue).add(name, data, { jobId });
    },
    async counts() {
      const entries = await Promise.all(
        QUEUE_NAMES.map(async (q) => {
          const c = await get(q).getJobCounts(...COUNT_STATES);
          return [q, Object.fromEntries(COUNT_STATES.map((st) => [st, c[st] ?? 0]))] as const;
        }),
      );
      return Object.fromEntries(entries) as QueueCounts;
    },
    async close() {
      await Promise.all([...queues.values()].map((q) => q.close()));
    },
  };
}

/** For tests: records jobs instead of sending them. */
export class MemoryJobQueue implements JobQueue {
  readonly jobs: {
    queue: QueueName;
    name: string;
    data: Record<string, unknown>;
    jobId: string;
  }[] = [];
  async counts(): Promise<QueueCounts> {
    return Object.fromEntries(
      QUEUE_NAMES.map((q) => [
        q,
        { waiting: this.jobs.filter((j) => j.queue === q).length, active: 0, delayed: 0, failed: 0, completed: 0 },
      ]),
    ) as QueueCounts;
  }
  async enqueue(
    queue: QueueName,
    name: string,
    data: Record<string, unknown>,
    jobId: string,
  ): Promise<void> {
    if (!this.jobs.some((j) => j.jobId === jobId)) this.jobs.push({ queue, name, data, jobId });
  }
  async close(): Promise<void> {}
}
