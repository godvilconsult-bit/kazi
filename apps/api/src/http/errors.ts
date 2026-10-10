import type { FastifyError, FastifyInstance } from "fastify";
import { ZodError, type ZodType } from "zod";
import type { ErrorCode } from "@kazi/shared";
import { StorageError } from "@kazi/config/storage";

/** Typed API error → `{ error: { code, message, details? } }` (CLAUDE.md code style). */
export class AppError extends Error {
  override readonly name = "AppError";
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly statusCode: number,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new AppError("VALIDATION_ERROR", message, 400, details);
export const unauthorized = (message = "Authentication required") =>
  new AppError("UNAUTHORIZED", message, 401);
export const forbidden = (message = "Not allowed") => new AppError("FORBIDDEN", message, 403);
export const notFound = (what = "Resource") => new AppError("NOT_FOUND", `${what} not found`, 404);
export const conflict = (message: string) => new AppError("CONFLICT", message, 409);
export const invalidState = (message: string) => new AppError("INVALID_STATE", message, 409);
export const unavailable = (message: string) => new AppError("UNAVAILABLE", message, 503);
/** ROUTER_DISABLED (docs/runbooks/incident-response.md): funded work continues, new quotes wait. */
export const quotesPaused = () =>
  unavailable(
    "New quotes are paused for maintenance. Tasks already funded keep going — please try again later.",
  );

/** Validate untrusted input; throws a 400 with the Zod issues. */
export function parse<T extends ZodType>(schema: T, data: unknown): T["_output"] {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw badRequest(
      "Invalid request",
      result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    );
  }
  return result.data;
}

export function registerErrorHandling(
  app: FastifyInstance,
  report?: (err: unknown, context: Record<string, unknown>) => void,
): void {
  app.setNotFoundHandler((_req, reply) => {
    void reply.status(404).send({ error: { code: "NOT_FOUND", message: "Route not found" } });
  });

  app.setErrorHandler((err: FastifyError | AppError | ZodError, req, reply) => {
    if (err instanceof AppError) {
      return reply
        .status(err.statusCode)
        .send({ error: { code: err.code, message: err.message, details: err.details } });
    }
    if (err instanceof StorageError) {
      req.log.warn({ err }, "storage error");
      return reply
        .status(502)
        .send({ error: { code: "STORAGE_ERROR", message: `Storage error: ${err.message}` } });
    }
    if (err instanceof ZodError) {
      return reply
        .status(400)
        .send({ error: { code: "VALIDATION_ERROR", message: "Invalid request" } });
    }
    const status = (err as FastifyError).statusCode;
    if (status !== undefined && status >= 400 && status < 500) {
      // Fastify-level client errors (bad JSON, wrong content-type, body too large, ...)
      return reply
        .status(status)
        .send({ error: { code: "VALIDATION_ERROR", message: err.message } });
    }
    req.log.error({ err }, "unhandled error");
    report?.(err, {
      method: req.method,
      route: req.routeOptions.url ?? "unmatched",
      reqId: req.id,
    });
    return reply
      .status(500)
      .send({ error: { code: "INTERNAL", message: "Internal server error" } });
  });
}
