import { describe, expect, it } from "vitest";
import { pad } from "viem";
import { holderKey, providerKey } from "@kazi/shared";
import { durationLabel } from "../src/lib/format";
import { geoFor, geoFromHeaders, parseCountryList } from "../src/lib/geo";
import { amountError, needsApproval, sharePct, stakePosition } from "../src/lib/staking";

/** Phase 6 helpers: staking position maths (mirrors StakingVault), geo hooks, labels. */

const KAZI = 10n ** 18n;

describe("staking position", () => {
  const base = { active: 0n, pending: 0n, unbonding: 0n, pendingSince: 0n, unbondReadyAt: 0n };

  it("treats warm-up stake as not earning until it is activated", () => {
    const pos = stakePosition({ ...base, active: 100n * KAZI, pending: 50n * KAZI, pendingSince: 1_000n }, 1_000 + 3_600, 86_400);
    expect(pos).toMatchObject({ active: 100n * KAZI, warming: 50n * KAZI, warmUntil: 87_400, needsActivation: false, unstakeable: 150n * KAZI });
    const matured = stakePosition({ ...base, pending: 50n * KAZI, pendingSince: 1_000n }, 87_400, 86_400);
    expect(matured.needsActivation).toBe(true);
  });

  it("allows a withdrawal only once the cooldown has passed", () => {
    const cooling = stakePosition({ ...base, unbonding: 10n * KAZI, unbondReadyAt: 2_000n }, 1_999, 86_400);
    expect(cooling).toMatchObject({ unbonding: 10n * KAZI, unbondReadyAt: 2_000, canWithdraw: false, warmUntil: null, unstakeable: 0n });
    expect(stakePosition({ ...base, unbonding: 10n * KAZI, unbondReadyAt: 2_000n }, 2_000, 86_400).canWithdraw).toBe(true);
    expect(stakePosition(base, 99_999, 86_400)).toMatchObject({ unbondReadyAt: null, canWithdraw: false, needsActivation: false });
  });

  it("approves exactly what a stake needs and validates amounts", () => {
    expect(needsApproval(0n, 1n)).toBe(true);
    expect(needsApproval(5n * KAZI, 5n * KAZI)).toBe(false);
    expect(amountError(null, 10n)).toBe("invalid");
    expect(amountError(0n, 10n)).toBe("zero");
    expect(amountError(11n, 10n)).toBe("tooMuch");
    expect(amountError(10n, 10n)).toBeNull();
  });

  it("derives vault keys the way StakingVault does", () => {
    const holder = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
    expect(holderKey(holder)).toBe(pad("0x70997970c51812dc3a010c7d01b50e0d17dc79c8", { size: 32 }));
    expect(providerKey(1n)).toMatch(/^0x[0-9a-f]{64}$/);
    expect(providerKey(1n)).not.toBe(providerKey(2n));
  });

  it("labels shares and durations without hardcoding them", () => {
    expect(sharePct(3_000)).toBe("30");
    expect(sharePct(1_250)).toBe("12.5");
    expect(sharePct(0)).toBe("0");
    expect(durationLabel(7 * 86_400, "en")).toBe("7 days");
    expect(durationLabel(86_400, "en")).toBe("1 day");
    expect(durationLabel(7_200, "en")).toBe("2 hours");
  });
});

describe("geo restriction", () => {
  it("reads a configurable country list", () => {
    expect(parseCountryList(" us, cu ,IR,,bogus")).toEqual(["US", "CU", "IR"]);
    expect(parseCountryList(undefined)).toEqual([]);
  });

  it("restricts listed countries only; unknown or missing countries are not restricted", () => {
    const list = ["US", "T1"];
    expect(geoFor("us", list)).toEqual({ country: "US", restricted: true });
    expect(geoFor("KE", list)).toEqual({ country: "KE", restricted: false });
    expect(geoFor("T1", list)).toEqual({ country: "T1", restricted: true }); // Cloudflare's Tor code
    expect(geoFor("XX", list)).toEqual({ country: null, restricted: false });
    expect(geoFor(null, list)).toEqual({ country: null, restricted: false });
    expect(geoFor("United States", list)).toEqual({ country: null, restricted: false });
  });

  it("trusts only the configured header", () => {
    const headers = new Map([
      ["cf-ipcountry", "US"],
      ["x-vercel-ip-country", "TZ"],
    ]);
    const h = { get: (name: string) => headers.get(name) ?? null };
    expect(geoFromHeaders(h, { GEO_RESTRICTED_COUNTRIES: "US" })).toEqual({ country: "US", restricted: true });
    expect(geoFromHeaders(h, { GEO_RESTRICTED_COUNTRIES: "US", GEO_COUNTRY_HEADER: "X-Vercel-IP-Country" })).toEqual({ country: "TZ", restricted: false });
    expect(geoFromHeaders(h, {})).toEqual({ country: "US", restricted: false });
  });
});
