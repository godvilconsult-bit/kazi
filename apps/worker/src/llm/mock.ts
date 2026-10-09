import {
  LlmError,
  type LlmClient,
  type LlmPurpose,
  type LlmUsage,
  type StructuredRequest,
  type TextRequest,
} from "./client";

/**
 * Deterministic LLM for tests (docs/10-BUILD-PLAN Phase 3). Register a responder per purpose;
 * structured responses are validated with the request's schema exactly like the real client.
 */

type Req = Omit<StructuredRequest<unknown>, "schema">;
type Responder = (req: Req) => unknown;

export const MOCK_USAGE: LlmUsage = {
  model: "mock",
  inputTokens: 1_000,
  outputTokens: 200,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0.001,
};

export class MockLlm implements LlmClient {
  readonly calls: Req[] = [];
  private readonly responders = new Map<LlmPurpose, Responder>();

  on(purpose: LlmPurpose, responder: Responder): this {
    this.responders.set(purpose, responder);
    return this;
  }

  async structured<T>(req: StructuredRequest<T>): Promise<{ data: T; usage: LlmUsage }> {
    const raw = this.respond(req);
    const parsed = req.schema.safeParse(raw);
    if (!parsed.success)
      throw new LlmError("mock output failed validation", "INVALID_OUTPUT", MOCK_USAGE);
    return { data: parsed.data, usage: MOCK_USAGE };
  }

  async text(req: TextRequest): Promise<{ text: string; usage: LlmUsage }> {
    const raw = this.respond(req);
    if (typeof raw !== "string")
      throw new LlmError("mock text responder must return a string", "INVALID_OUTPUT");
    return { text: raw, usage: MOCK_USAGE };
  }

  private respond(req: Req): unknown {
    const { purpose, model, system, user, effort, maxTokens, taskId, subtaskId } = req;
    this.calls.push({ purpose, model, system, user, effort, maxTokens, taskId, subtaskId });
    const responder = this.responders.get(purpose);
    if (!responder) throw new LlmError(`no mock responder for ${purpose}`, "API");
    const out = responder(req);
    if (out instanceof LlmError) throw out;
    return out;
  }
}
