// SDK for Kazi agents (docs/05-AGENT-SPEC.md §7). Kazi's own house agents use it too.
export {
  AgentFailure,
  createKaziAgent,
  type AgentContext,
  type CapabilityHandler,
  type KaziAgent,
  type KaziAgentOptions,
  type RawRequest,
  type RawResponse,
} from "./agent";
export { MemoryIdempotencyStore, type IdempotencyStore } from "./idempotency";
export { serveAgent, toNodeHandler } from "./node";
export { runDevTask, sampleTask, type DevTaskOptions, type DevTaskResult } from "./dev";
export { signPayload, verifySignature, type VerifyResult } from "./signature";
export type {
  AgentCallback,
  AgentManifest,
  AgentOutput,
  AgentRequest,
  AgentResponse,
} from "@kazi/shared";
