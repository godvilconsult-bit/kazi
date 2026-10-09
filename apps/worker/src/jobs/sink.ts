import type { Queue } from "bullmq";
import type { QueueName } from "@kazi/shared";

/** Where workers enqueue follow-up jobs. BullMQ in production; an in-memory list in tests. */
export interface JobSink {
  /** Idempotent: a job with the same id that still exists is not added again. */
  add(queue: QueueName, name: string, data: Record<string, unknown>, jobId: string): Promise<void>;
}

export function bullmqSink(queues: Record<QueueName, Queue>): JobSink {
  return {
    async add(queue, name, data, jobId) {
      await queues[queue].add(name, data, { jobId });
    },
  };
}

export class MemorySink implements JobSink {
  readonly jobs: {
    queue: QueueName;
    name: string;
    data: Record<string, unknown>;
    jobId: string;
  }[] = [];

  async add(
    queue: QueueName,
    name: string,
    data: Record<string, unknown>,
    jobId: string,
  ): Promise<void> {
    if (!this.jobs.some((j) => j.jobId === jobId)) this.jobs.push({ queue, name, data, jobId });
  }

  /** Remove and return all queued jobs (tests drive the workers by hand). */
  drain(): typeof this.jobs {
    return this.jobs.splice(0, this.jobs.length);
  }
}
