/**
 * Explicit transition tables (docs/02-ARCHITECTURE.md §5). Every DB status change goes through
 * `transition()`, which throws on illegal moves. Onchain events are the source of truth for
 * money, so chain-driven events (FUND, RELEASE, REFUND, ...) are allowed from every state the
 * chain can legitimately reach — the indexer must never be blocked by a stale DB state.
 */

export const TASK_STATUSES = [
  "DRAFT",
  "QUOTED",
  "FUNDED",
  "IN_PROGRESS",
  "DELIVERED",
  "COMPLETED",
  "DISPUTED",
  "RESOLVED",
  "CANCELLED",
  "EXPIRED",
  "REFUNDED",
  "PARTIALLY_REFUNDED",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const SUBTASK_STATUSES = [
  "PENDING",
  "DISPATCHED",
  "SUBMITTED",
  "EVALUATING",
  "ACCEPTED",
  "REJECTED",
  "FAILED",
  "RELEASED",
  "REFUNDED",
] as const;
export type SubtaskStatus = (typeof SUBTASK_STATUSES)[number];

export type TaskEvent =
  | "QUOTE" // router produced a (new) quote
  | "CANCEL" // client cancels before funding
  | "EXPIRE_QUOTE" // quote validity elapsed without funding
  | "FUND" // indexer saw TaskFunded
  | "START" // first subtask dispatched
  | "DELIVER" // all subtasks accepted
  | "REQUEST_REVISION" // client asks for a revision during review
  | "COMPLETE" // client approved / review window elapsed and all milestones released
  | "DISPUTE" // indexer saw DisputeOpened
  | "RESOLVE" // arbiter settled every milestone
  | "REFUND" // every milestone refunded (failure, refundExpired, ...)
  | "PARTIAL_REFUND"; // closed with some milestones refunded and some released

export type SubtaskEvent =
  | "DISPATCH"
  | "SUBMIT"
  | "EVALUATE"
  | "ACCEPT"
  | "REJECT"
  | "TIMEOUT"
  | "AGENT_ERROR" // the provider reported failure (sync response or callback)
  | "RETRY"
  | "FAIL"
  | "ABANDON" // a dependency failed for good, so this step can never start
  | "REVISE" // the client asked for a revision of an accepted step during review
  | "RELEASE" // indexer saw MilestoneReleased (or dispute release)
  | "REFUND"; // indexer saw MilestoneRefunded

const ACTIVE_TASK: readonly TaskStatus[] = ["FUNDED", "IN_PROGRESS", "DELIVERED", "DISPUTED"];

/** event → { from: to } */
const TASK_TABLE: Readonly<Record<TaskEvent, Partial<Record<TaskStatus, TaskStatus>>>> = {
  QUOTE: { DRAFT: "QUOTED", QUOTED: "QUOTED", EXPIRED: "QUOTED" },
  CANCEL: { DRAFT: "CANCELLED", QUOTED: "CANCELLED" },
  EXPIRE_QUOTE: { QUOTED: "EXPIRED" },
  // EXPIRED → FUNDED: a funding tx mined right at quote expiry must still be honoured (chain wins).
  FUND: { QUOTED: "FUNDED", EXPIRED: "FUNDED", CANCELLED: "FUNDED" },
  START: { FUNDED: "IN_PROGRESS" },
  DELIVER: { IN_PROGRESS: "DELIVERED" },
  REQUEST_REVISION: { DELIVERED: "IN_PROGRESS" },
  COMPLETE: { DELIVERED: "COMPLETED", IN_PROGRESS: "COMPLETED", FUNDED: "COMPLETED" },
  DISPUTE: { FUNDED: "DISPUTED", IN_PROGRESS: "DISPUTED", DELIVERED: "DISPUTED" },
  RESOLVE: { DISPUTED: "RESOLVED" },
  REFUND: Object.fromEntries(ACTIVE_TASK.map((s) => [s, "REFUNDED"])),
  PARTIAL_REFUND: Object.fromEntries(ACTIVE_TASK.map((s) => [s, "PARTIALLY_REFUNDED"])),
};

const OPEN_SUBTASK: readonly SubtaskStatus[] = [
  "PENDING",
  "DISPATCHED",
  "SUBMITTED",
  "EVALUATING",
  "ACCEPTED",
  "REJECTED",
  "FAILED",
];

const SUBTASK_TABLE: Readonly<Record<SubtaskEvent, Partial<Record<SubtaskStatus, SubtaskStatus>>>> =
  {
    DISPATCH: { PENDING: "DISPATCHED" },
    SUBMIT: { DISPATCHED: "SUBMITTED" },
    EVALUATE: { SUBMITTED: "EVALUATING" },
    ACCEPT: { EVALUATING: "ACCEPTED" },
    REJECT: { EVALUATING: "REJECTED" },
    TIMEOUT: { DISPATCHED: "REJECTED" },
    AGENT_ERROR: { DISPATCHED: "REJECTED" },
    RETRY: { REJECTED: "DISPATCHED" },
    FAIL: { REJECTED: "FAILED", DISPATCHED: "FAILED" },
    ABANDON: { PENDING: "FAILED" },
    REVISE: { ACCEPTED: "REJECTED" },
    // Chain-driven: the client or arbiter may settle a milestone at any point.
    RELEASE: Object.fromEntries(OPEN_SUBTASK.map((s) => [s, "RELEASED"])),
    REFUND: Object.fromEntries(OPEN_SUBTASK.map((s) => [s, "REFUNDED"])),
  };

export class IllegalTransitionError extends Error {
  override readonly name = "IllegalTransitionError";
  constructor(
    readonly entity: "task" | "subtask",
    readonly from: string,
    readonly event: string,
  ) {
    super(`Illegal ${entity} transition: ${event} from ${from}`);
  }
}

export function transition(entity: "task", from: TaskStatus, event: TaskEvent): TaskStatus;
export function transition(
  entity: "subtask",
  from: SubtaskStatus,
  event: SubtaskEvent,
): SubtaskStatus;
export function transition(
  entity: "task" | "subtask",
  from: TaskStatus | SubtaskStatus,
  event: TaskEvent | SubtaskEvent,
): TaskStatus | SubtaskStatus {
  const table = (entity === "task" ? TASK_TABLE : SUBTASK_TABLE) as Record<
    string,
    Record<string, string>
  >;
  const to = table[event]?.[from];
  if (to === undefined) throw new IllegalTransitionError(entity, from, event);
  return to as TaskStatus | SubtaskStatus;
}

export function canTransition(entity: "task", from: TaskStatus, event: TaskEvent): boolean;
export function canTransition(entity: "subtask", from: SubtaskStatus, event: SubtaskEvent): boolean;
export function canTransition(
  entity: "task" | "subtask",
  from: TaskStatus | SubtaskStatus,
  event: TaskEvent | SubtaskEvent,
): boolean {
  const table = (entity === "task" ? TASK_TABLE : SUBTASK_TABLE) as Record<
    string,
    Record<string, string>
  >;
  return table[event]?.[from] !== undefined;
}

/** Exposed for tests and docs generation. */
export const TRANSITION_TABLES = { task: TASK_TABLE, subtask: SUBTASK_TABLE } as const;
