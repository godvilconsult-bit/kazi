import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getAddress, type Address } from "viem";
import { createHarness, type Harness } from "./harness";

/**
 * KAZI (Argus) ⇄ KAZI Credits gate (docs/08-TOKENOMICS.md §8): /config hands the web app the gate and
 * the Argus token; /token/metrics reports what is locked, keeps the gate's unissued reserve out of
 * circulation, and says whether every Credit is backed. Chain reads come from a stub client.
 */

const addr = (n: number) => getAddress(`0x${n.toString(16).padStart(40, "0")}`) as Address;
const CREDITS = addr(0x201);
const VAULT = addr(0x202);
const GATE = addr(0x203);
const ARGUS = addr(0x204);
const E18 = 10n ** 18n;
const SUPPLY = 1_000_000_000n * E18;
const LOCKED = 5_000n * E18;

const reads: Record<string, unknown> = {
  [`${CREDITS}:decimals`]: 18,
  [`${CREDITS}:totalSupply`]: SUPPLY,
  [`${VAULT}:totalTracked`]: 3_000n * E18,
  [`${VAULT}:totalActive`]: 1_000n * E18,
  [`${VAULT}:totalRewardsNotified`]: 0n,
  [`${VAULT}:totalRewardsClaimed`]: 0n,
  [`${GATE}:totalLocked`]: LOCKED,
  [`${GATE}:reserve`]: SUPPLY - LOCKED,
  [`${GATE}:fullyBacked`]: true,
  [`${GATE}:paused`]: false,
};
const publicClient = {
  readContract: async ({ address, functionName }: { address: Address; functionName: string }) => {
    if (functionName === "decimals" && address !== CREDITS) return 6; // USDC
    const key = `${getAddress(address)}:${functionName}`;
    if (!(key in reads)) throw new Error(`unexpected read ${key}`);
    return reads[key];
  },
};

let h: Harness;
beforeAll(async () => {
  h = await createHarness({
    publicClient: publicClient as never,
    contracts: {
      stakingVault: VAULT,
      kaziToken: CREDITS,
      creditsGate: GATE,
      argusKazi: ARGUS,
    },
    creditsGate: {
      network: "local",
      chainId: 31337,
      deployedAtBlock: 1,
      gate: GATE,
      kazi: ARGUS,
      credits: CREDITS,
    },
  });
});
afterAll(async () => {
  await h.close();
});

describe("KAZI ⇄ KAZI Credits gate", () => {
  it("gives the web app the gate and the Argus KAZI in /config", async () => {
    const config = (await h.app.inject({ method: "GET", url: "/config" })).json<{
      kaziDecimals: number;
      contracts: Record<string, string>;
    }>();
    expect(config.kaziDecimals).toBe(18);
    expect(config.contracts["creditsGate"]).toBe(GATE);
    expect(config.contracts["argusKazi"]).toBe(ARGUS);
  });

  it("reports locked KAZI and backing, and keeps the unissued reserve out of circulation", async () => {
    const m = (await h.app.inject({ method: "GET", url: "/token/metrics" })).json<{
      deployed: boolean;
      circulating: string;
      totalSupply: string;
      creditsGate: Record<string, unknown>;
      contracts: Record<string, string | null>;
    }>();
    expect(m.deployed).toBe(true);
    expect(m.totalSupply).toBe(SUPPLY.toString());
    // Only the Credits that came out of the gate circulate.
    expect(m.circulating).toBe(LOCKED.toString());
    expect(m.creditsGate).toEqual({
      address: GATE,
      kazi: ARGUS,
      totalLocked: LOCKED.toString(),
      reserve: (SUPPLY - LOCKED).toString(),
      fullyBacked: true,
      paused: false,
    });
    expect(m.contracts["creditsGate"]).toBe(GATE);
    expect(m.contracts["argusKazi"]).toBe(ARGUS);
  });
});
