export { holderKey } from "@kazi/shared";

/**
 * StakingVault helpers for the /stake page (docs/08-TOKENOMICS.md §2). Pure, so the page's
 * position maths is unit-tested against the contract's rules (packages/contracts/src/StakingVault.sol).
 */

/** StakingVault.getAccount (the fields the page uses). */
export interface VaultAccount {
  active: bigint;
  pending: bigint;
  unbonding: bigint;
  pendingSince: bigint | number;
  unbondReadyAt: bigint | number;
}

export interface StakePosition {
  /** Earning stake. */
  active: bigint;
  /** Warming up: bonded but not earning yet. */
  warming: bigint;
  /** When the warm-up ends (unix seconds); null without warming stake. */
  warmUntil: number | null;
  /** Warm-up is over, but the vault only activates it on the account's next interaction (or a poke). */
  needsActivation: boolean;
  /** In cooldown: not earning, withdrawable at `unbondReadyAt`. */
  unbonding: bigint;
  unbondReadyAt: number | null;
  canWithdraw: boolean;
  /** What requestUnstake accepts: warming first, then active. */
  unstakeable: bigint;
}

export function stakePosition(a: VaultAccount, nowSec: number, warmupSec: number): StakePosition {
  const warmUntil = a.pending > 0n ? Number(a.pendingSince) + warmupSec : null;
  const unbondReadyAt = a.unbonding > 0n ? Number(a.unbondReadyAt) : null;
  return {
    active: a.active,
    warming: a.pending,
    warmUntil,
    needsActivation: warmUntil !== null && nowSec >= warmUntil,
    unbonding: a.unbonding,
    unbondReadyAt,
    canWithdraw: unbondReadyAt !== null && nowSec >= unbondReadyAt,
    unstakeable: a.active + a.pending,
  };
}

/** Approvals are exact, never unlimited: approve only when the allowance doesn't cover this stake. */
export function needsApproval(allowance: bigint, amount: bigint): boolean {
  return allowance < amount;
}

export type AmountError = "invalid" | "zero" | "tooMuch";

/** Validates a parsed amount against what the wallet or position holds. */
export function amountError(amount: bigint | null, max: bigint): AmountError | null {
  if (amount === null) return "invalid";
  if (amount <= 0n) return "zero";
  if (amount > max) return "tooMuch";
  return null;
}

/** Basis points as a percentage label: 3000 → "30", 1250 → "12.5". */
export function sharePct(bps: number): string {
  const pct = bps / 100;
  return String(Number(pct.toFixed(2)));
}
