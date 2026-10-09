import { z } from "zod";

/**
 * Money helpers. All amounts are bigint base units (CLAUDE.md rule 1); decimals always come
 * from the token contract at startup — never hardcoded here.
 */

/** Base-unit amount carried as a decimal string in JSON/DB (e.g. "1500000"). */
export const baseUnitsSchema = z
  .string()
  .regex(/^(0|[1-9]\d*)$/, "must be a non-negative integer string (base units)")
  .max(78);

/** Human decimal amount as typed in manifests/UI (e.g. "0.80"). */
export const decimalAmountSchema = z
  .string()
  .regex(/^(0|[1-9]\d*)(\.\d+)?$/, "must be a non-negative decimal string like 12.50");

export class MoneyError extends Error {
  override readonly name = "MoneyError";
}

/** "12.5" + 6 decimals → 12_500_000n. Rejects more fractional digits than the token supports. */
export function parseUnits(value: string, decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new MoneyError(`invalid decimals: ${decimals}`);
  }
  const parsed = decimalAmountSchema.safeParse(value);
  if (!parsed.success) throw new MoneyError(`invalid amount: ${value}`);
  const [whole = "0", fraction = ""] = value.split(".");
  if (fraction.length > decimals) {
    throw new MoneyError(`amount ${value} has more than ${decimals} decimal places`);
  }
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0");
}

/** 12_500_000n + 6 decimals → "12.5" (exact, trailing zeros trimmed). */
export function formatUnits(value: bigint, decimals: number): string {
  if (value < 0n) throw new MoneyError("negative amounts are not supported");
  const base = 10n ** BigInt(decimals);
  const whole = value / base;
  const fraction = (value % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return fraction.length > 0 ? `${whole}.${fraction}` : whole.toString();
}

/** Fixed 2-dp display (rounds DOWN — never show more money than exists). */
export function formatUsdcDisplay(value: bigint, decimals: number): string {
  if (decimals < 2) return `${formatUnits(value, decimals)}`;
  const cents = value / 10n ** BigInt(decimals - 2);
  return `${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")}`;
}
