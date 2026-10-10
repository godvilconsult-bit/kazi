/**
 * State for multi-transaction flows (fund = approve + createAndFund). Pure, so the stepper's
 * error/retry behaviour is unit-tested (docs/07-FRONTEND.md §6).
 */

export type StepStatus = "idle" | "wallet" | "pending" | "done" | "error" | "skipped";

export interface TxStep {
  key: string;
  status: StepStatus;
  hash?: `0x${string}` | undefined;
  error?: string | undefined;
}

export type StepAction =
  | { type: "wallet"; key: string }
  | { type: "sent"; key: string; hash: `0x${string}` }
  | { type: "done"; key: string }
  | { type: "skip"; key: string }
  | { type: "error"; key: string; error?: string | undefined }
  | { type: "reset" };

export function initSteps(keys: readonly string[]): TxStep[] {
  return keys.map((key) => ({ key, status: "idle" }));
}

export function stepsReducer(steps: TxStep[], action: StepAction): TxStep[] {
  if (action.type === "reset") return steps.map((s) => (s.status === "done" || s.status === "skipped" ? s : { key: s.key, status: "idle" }));
  return steps.map((s) => {
    if (s.key !== action.key) return s;
    switch (action.type) {
      case "wallet":
        return { key: s.key, status: "wallet" };
      case "sent":
        return { ...s, status: "pending", hash: action.hash, error: undefined };
      case "done":
        return { ...s, status: "done", error: undefined };
      case "skip":
        return { key: s.key, status: "skipped" };
      case "error":
        return { ...s, status: "error", error: action.error };
    }
  });
}

/** The step to run next: the first that isn't finished. Null when all are done. */
export function nextStep(steps: readonly TxStep[]): TxStep | null {
  return steps.find((s) => s.status !== "done" && s.status !== "skipped") ?? null;
}

export function isBusy(steps: readonly TxStep[]): boolean {
  return steps.some((s) => s.status === "wallet" || s.status === "pending");
}

/** Wallet rejections are the user's choice, not failures worth alarming about. */
export function isUserRejection(err: unknown): boolean {
  const text = `${(err as { name?: string })?.name ?? ""} ${(err as { message?: string })?.message ?? ""}`;
  return /UserRejected|User rejected|denied transaction|rejected the request/i.test(text);
}
