import type { AgentOutput } from "./protocol";
import type { Acceptance } from "./router";

/**
 * Deterministic checks (docs/06-ROUTER.md §5, layer 1): cheap, run before the LLM judge.
 * Shared so `kazi-agent dev` can run the same checks against a developer's local agent.
 * Agent output is untrusted (CLAUDE.md rule 7); nothing here executes or follows it.
 */

export interface CheckFailure {
  code: "EMPTY" | "FORMAT" | "MISSING_TERMS" | "LENGTH" | "INJECTION";
  message: string;
}

export interface CheckInput {
  output: AgentOutput;
  acceptance: Acceptance;
  /** Expected size in words when the capability is priced per 1000 words (e.g. translations). */
  expectedWords?: number | undefined;
}

/**
 * Phrases aimed at Kazi's reviewer rather than the client. Kept narrow on purpose: a match rejects
 * the attempt (the agent may retry) and flags it for human review; it never slashes by itself.
 */
const INJECTION_PATTERNS: readonly RegExp[] = [
  /\b(ignore|disregard|forget)\b[^.\n]{0,40}\b(previous|prior|above|earlier|preceding)\b[^.\n]{0,30}\b(instructions?|prompts?)\b/i,
  /\b(you are|act as|you're)\s+(now\s+)?(an?\s+|the\s+)?(evaluator|judge|grader|reviewer)\b/i,
  /\b(note|message|instructions?)\s+(to|for)\s+(the\s+)?(evaluator|judge|grader|ai|model|llm|assistant)s?\b/i,
  /\b(evaluator|judge|grader|reviewer)s?\b[^.\n]{0,40}\b(must|should|shall)\b[^.\n]{0,20}\b(pass|accept|approve)\b[^.\n]{0,20}\b(this|the|my)\s+(output|submission|answer|work|response)\b/i,
  /\b(give|assign|award)\b[^.\n]{0,30}\b(this|the|my)\s+(output|answer|submission|work)\b[^.\n]{0,30}(100|10\/10|perfect|full marks|maximum)/i,
  /<\/?\s*(system|instructions?|admin|developer)\s*>/i,
];
/** Zero-width / bidi-control characters used to hide text from humans. */
const HIDDEN_CHARS = /[\u200b-\u200f\u2060-\u2064\u202a-\u202e\ufeff]/g;
const HIDDEN_MARKUP = /<!--[\s\S]*?-->|display\s*:\s*none|font-size\s*:\s*0(px)?\b/i;

export function runChecks(input: CheckInput): CheckFailure[] {
  const failures: CheckFailure[] = [];
  const text = input.output.text ?? "";
  const files = input.output.files ?? [];

  if (text.trim().length === 0 && files.length === 0) {
    return [{ code: "EMPTY", message: "The output is empty." }];
  }

  switch (input.acceptance.format) {
    case "file":
      if (files.length === 0)
        failures.push({ code: "FORMAT", message: "A file was required but none was returned." });
      break;
    case "json":
      try {
        JSON.parse(text);
      } catch {
        failures.push({ code: "FORMAT", message: "The output must be valid JSON." });
      }
      break;
    default:
      if (text.trim().length === 0)
        failures.push({ code: "FORMAT", message: "A text answer was required." });
  }

  const missing = (input.acceptance.mustInclude ?? []).filter(
    (term) => !text.toLowerCase().includes(term.toLowerCase()),
  );
  if (missing.length > 0) {
    failures.push({
      code: "MISSING_TERMS",
      message: `Missing required content: ${missing.map((m) => `"${m}"`).join(", ")}.`,
    });
  }

  if (input.expectedWords && input.expectedWords >= 50 && text.length > 0) {
    const words = countWords(text);
    const ratio = words / input.expectedWords;
    if (ratio < 0.7 || ratio > 1.3) {
      failures.push({
        code: "LENGTH",
        message: `Expected about ${Math.round(input.expectedWords)} words but got ${words} (outside ±30%).`,
      });
    }
  }

  const injection = detectInjection(text);
  if (injection) failures.push({ code: "INJECTION", message: injection });
  return failures;
}

export function detectInjection(text: string): string | null {
  const hidden = text.match(HIDDEN_CHARS)?.length ?? 0;
  if (hidden > 3) return `The output contains ${hidden} invisible characters.`;
  if (HIDDEN_MARKUP.test(text)) return "The output contains hidden markup.";
  const normalized = text.replace(HIDDEN_CHARS, "");
  for (const p of INJECTION_PATTERNS) {
    if (p.test(normalized)) return "The output contains instructions addressed to Kazi's reviewer.";
  }
  return null;
}

export function countWords(text: string): number {
  return text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}
