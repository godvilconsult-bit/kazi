import type { AgentResponse } from "@kazi/shared";

/**
 * Same `X-Kazi-Idempotency-Key` = same job: run it once (05-AGENT-SPEC §3). Plug in Redis or a
 * DB for multi-instance agents; the in-memory default only protects a single process.
 */
export interface IdempotencyStore {
  /** Atomically claim a key. Returns false if it was already claimed (job running or done). */
  claim(key: string, ttlSec: number): Promise<boolean>;
  /** Record the final response for a claimed key (replayed for duplicate sync requests). */
  complete(key: string, response: AgentResponse, ttlSec: number): Promise<void>;
  get(key: string): Promise<AgentResponse | "PENDING" | undefined>;
}

export class MemoryIdempotencyStore implements IdempotencyStore {
  private readonly entries = new Map<
    string,
    { value: AgentResponse | "PENDING"; expires: number }
  >();

  async claim(key: string, ttlSec: number): Promise<boolean> {
    this.sweep();
    if (this.entries.has(key)) return false;
    this.entries.set(key, { value: "PENDING", expires: Date.now() + ttlSec * 1000 });
    return true;
  }

  async complete(key: string, response: AgentResponse, ttlSec: number): Promise<void> {
    this.entries.set(key, { value: response, expires: Date.now() + ttlSec * 1000 });
  }

  async get(key: string): Promise<AgentResponse | "PENDING" | undefined> {
    this.sweep();
    return this.entries.get(key)?.value;
  }

  private sweep(): void {
    const now = Date.now();
    for (const [k, e] of this.entries) if (e.expires <= now) this.entries.delete(k);
  }
}
