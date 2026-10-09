import type { FastifyReply, FastifyRequest } from "fastify";
import type { Redis } from "ioredis";
import { AppError } from "../http/errors";

/** Fixed-window rate limiter in Redis (per wallet when signed in, else per IP). */
export class RateLimiter {
  constructor(
    private readonly redis: Redis,
    private readonly prefix: string,
  ) {}

  async hit(bucket: string, subject: string, limit: number, windowSeconds: number) {
    const window = Math.floor(Date.now() / 1000 / windowSeconds);
    const key = `${this.prefix}:rl:${bucket}:${subject}:${window}`;
    const results = await this.redis.multi().incr(key).expire(key, windowSeconds, "NX").exec();
    const count = Number(results?.[0]?.[1] ?? 0);
    return {
      allowed: count <= limit,
      remaining: Math.max(0, limit - count),
      retryAfter: windowSeconds,
    };
  }

  /** Fastify preHandler: `{ preHandler: limiter.guard("auth", 20, 60) }`. */
  guard(bucket: string, limit: number, windowSeconds: number) {
    return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
      const subject = req.auth?.wallet ?? `ip:${req.ip}`;
      const { allowed, remaining, retryAfter } = await this.hit(
        bucket,
        subject,
        limit,
        windowSeconds,
      );
      void reply.header("x-ratelimit-limit", limit).header("x-ratelimit-remaining", remaining);
      if (!allowed) {
        void reply.header("retry-after", retryAfter);
        throw new AppError("RATE_LIMITED", "Too many requests, slow down", 429);
      }
    };
  }
}
