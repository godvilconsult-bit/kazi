import { describe, expect, it } from "vitest";
import {
  CAPABILITIES,
  IllegalTransitionError,
  MoneyError,
  SUBTASK_STATUSES,
  TASK_STATUSES,
  canTransition,
  capabilityInputSchema,
  capabilitySlugSchema,
  createProviderSchema,
  createTaskSchema,
  formatUnits,
  formatUsdcDisplay,
  parseUnits,
  presignUploadSchema,
  taskOnchainId,
  transition,
  type SubtaskStatus,
  type TaskStatus,
} from "./index";

describe("money", () => {
  it("parses decimal strings into base units without floats", () => {
    expect(parseUnits("12.5", 6)).toBe(12_500_000n);
    expect(parseUnits("0.000001", 6)).toBe(1n);
    expect(parseUnits("1", 18)).toBe(10n ** 18n);
    expect(parseUnits("0", 6)).toBe(0n);
    // 0.1 + 0.2 style float errors are impossible
    expect(parseUnits("0.1", 18) + parseUnits("0.2", 18)).toBe(parseUnits("0.3", 18));
  });

  it("rejects malformed and over-precise amounts", () => {
    expect(() => parseUnits("1.2345678", 6)).toThrow(MoneyError);
    expect(() => parseUnits("-1", 6)).toThrow(MoneyError);
    expect(() => parseUnits("1e6", 6)).toThrow(MoneyError);
    expect(() => parseUnits("01", 6)).toThrow(MoneyError);
    expect(() => parseUnits("1", 37)).toThrow(MoneyError);
  });

  it("formats exactly and displays 2 dp rounding down", () => {
    expect(formatUnits(12_500_000n, 6)).toBe("12.5");
    expect(formatUnits(1n, 6)).toBe("0.000001");
    expect(formatUnits(7n * 10n ** 18n, 18)).toBe("7");
    expect(formatUsdcDisplay(1_999_999n, 6)).toBe("1.99");
    expect(formatUsdcDisplay(5n * 10n ** 18n, 18)).toBe("5.00");
    expect(() => formatUnits(-1n, 6)).toThrow(MoneyError);
  });

  it("round-trips", () => {
    for (const v of ["0", "1", "0.5", "123.456789", "1000000"]) {
      expect(formatUnits(parseUnits(v, 6), 6)).toBe(v);
    }
  });
});

describe("task state machine", () => {
  it("walks the happy path", () => {
    let s: TaskStatus = "DRAFT";
    for (const e of ["QUOTE", "FUND", "START", "DELIVER", "COMPLETE"] as const)
      s = transition("task", s, e);
    expect(s).toBe("COMPLETED");
  });

  it("throws on illegal transitions", () => {
    expect(() => transition("task", "DRAFT", "FUND")).toThrow(IllegalTransitionError);
    expect(() => transition("task", "COMPLETED", "DISPUTE")).toThrow(/Illegal task transition/);
    expect(() => transition("task", "FUNDED", "CANCEL")).toThrow(IllegalTransitionError);
  });

  it("lets the chain win: funding is honoured after quote expiry or cancel", () => {
    expect(transition("task", "EXPIRED", "FUND")).toBe("FUNDED");
    expect(transition("task", "CANCELLED", "FUND")).toBe("FUNDED");
  });

  it("refunds are possible from every active state", () => {
    for (const s of ["FUNDED", "IN_PROGRESS", "DELIVERED", "DISPUTED"] as const) {
      expect(transition("task", s, "REFUND")).toBe("REFUNDED");
    }
  });

  it("terminal states accept nothing", () => {
    for (const s of ["COMPLETED", "RESOLVED", "REFUNDED", "PARTIALLY_REFUNDED"] as const) {
      for (const e of ["QUOTE", "FUND", "START", "DISPUTE", "REFUND", "CANCEL"] as const) {
        expect(canTransition("task", s, e)).toBe(false);
      }
    }
    expect(TASK_STATUSES).toHaveLength(12);
  });
});

describe("subtask state machine", () => {
  it("retries after reject and timeout, then fails", () => {
    let s: SubtaskStatus = "PENDING";
    for (const e of [
      "DISPATCH",
      "SUBMIT",
      "EVALUATE",
      "REJECT",
      "RETRY",
      "TIMEOUT",
      "FAIL",
    ] as const) {
      s = transition("subtask", s, e);
    }
    expect(s).toBe("FAILED");
    expect(transition("subtask", s, "REFUND")).toBe("REFUNDED");
  });

  it("chain-driven settlement works from every open state, never twice", () => {
    const open = SUBTASK_STATUSES.filter((s) => s !== "RELEASED" && s !== "REFUNDED");
    for (const s of open) {
      expect(transition("subtask", s, "RELEASE")).toBe("RELEASED");
      expect(transition("subtask", s, "REFUND")).toBe("REFUNDED");
    }
    expect(() => transition("subtask", "RELEASED", "RELEASE")).toThrow(IllegalTransitionError);
    expect(() => transition("subtask", "REFUNDED", "RELEASE")).toThrow(IllegalTransitionError);
  });
});

describe("capabilities", () => {
  it("contains the v1 taxonomy and validates slugs", () => {
    expect(CAPABILITIES).toContain("translate.en-sw");
    expect(CAPABILITIES).toContain("human.review");
    expect(new Set(CAPABILITIES).size).toBe(CAPABILITIES.length);
    for (const slug of CAPABILITIES)
      expect(capabilitySlugSchema.safeParse(slug).success).toBe(true);
    expect(capabilitySlugSchema.safeParse("Bad Slug").success).toBe(false);
  });

  it("requires text or files as input", () => {
    expect(capabilityInputSchema.safeParse({}).success).toBe(false);
    expect(capabilityInputSchema.safeParse({ text: "hello" }).success).toBe(true);
  });
});

describe("api schemas", () => {
  it("validates task creation", () => {
    const ok = createTaskSchema.safeParse({
      title: "Translate my plan",
      description: "Translate the attached business plan into Swahili.",
      deadline: "2026-10-20T12:00:00Z",
      budgetMax: "25000000",
    });
    expect(ok.success).toBe(true);
    expect(
      createTaskSchema.safeParse({ title: "x", description: "short", deadline: "soon" }).success,
    ).toBe(false);
    expect(
      createTaskSchema.safeParse({
        title: "Valid title",
        description: "Valid description here",
        deadline: "2026-10-20T12:00:00Z",
        budgetMax: "12.50", // floats are not base units
      }).success,
    ).toBe(false);
  });

  it("requires an https endpoint for agents only", () => {
    const base = {
      name: "Swahili Translator",
      description: "Translates business documents.",
      capabilities: ["translate.en-sw"],
      languages: ["en", "sw"],
      pricing: { model: "per_unit", unit: "1000_words", price: "0.80", currency: "USDC" },
      payoutAddress: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    };
    expect(createProviderSchema.safeParse({ ...base, kind: "AGENT" }).success).toBe(false);
    expect(
      createProviderSchema.safeParse({ ...base, kind: "AGENT", endpointUrl: "http://x.io" })
        .success,
    ).toBe(false);
    expect(
      createProviderSchema.safeParse({ ...base, kind: "AGENT", endpointUrl: "https://x.io/run" })
        .success,
    ).toBe(true);
    expect(createProviderSchema.safeParse({ ...base, kind: "HUMAN" }).success).toBe(true);
  });

  it("caps uploads at 50 MB and rejects path tricks", () => {
    expect(
      presignUploadSchema.safeParse({ filename: "a.pdf", mime: "application/pdf", size: 1 })
        .success,
    ).toBe(true);
    expect(
      presignUploadSchema.safeParse({ filename: "../a.pdf", mime: "application/pdf", size: 1 })
        .success,
    ).toBe(false);
    expect(
      presignUploadSchema.safeParse({
        filename: "a.pdf",
        mime: "application/pdf",
        size: 50 * 1024 * 1024 + 1,
      }).success,
    ).toBe(false);
  });
});

describe("ids", () => {
  it("derives a deterministic bytes32 onchain id", () => {
    const id = taskOnchainId("ckabc123");
    expect(id).toMatch(/^0x[0-9a-f]{64}$/);
    expect(taskOnchainId("ckabc123")).toBe(id);
    expect(taskOnchainId("ckabc124")).not.toBe(id);
  });
});
