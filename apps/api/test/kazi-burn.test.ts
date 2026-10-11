import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getAddress, type Address } from "viem";
import { createHarness, type Harness } from "./harness";

/**
 * KAZI bought back and burned through its Argus launch (docs/08-TOKENOMICS.md §8): /token/kazi-burn
 * reads the burn address's KAZI, the splitter's buyback budget and spend, and the hook's tax.
 * Decimals come from the tokens. Chain reads come from a stub client.
 */

const addr = (n: number) => getAddress(`0x${n.toString(16).padStart(40, "0")}`) as Address;
const KAZI = addr(0x301);
const HOOK = addr(0x302);
const SPLITTER = addr(0x303);
const USDC = addr(0x304);
const DEAD = getAddress("0x000000000000000000000000000000000000dEaD");
const E18 = 10n ** 18n;
const SUPPLY = 1_000_000_000n * E18;
const BURNED = 2_500_000n * E18; // 0.25% of supply

const reads: Record<string, unknown> = {
  [`${KAZI}:balanceOf`]: BURNED,
  [`${KAZI}:totalSupply`]: SUPPLY,
  [`${KAZI}:decimals`]: 18,
  [`${SPLITTER}:quoteAsset`]: USDC,
  [`${SPLITTER}:budgetBurn`]: 44_673n,
  [`${SPLITTER}:burnDrawn`]: 30_000n,
  [`${SPLITTER}:totalReceived`]: 638_198n,
  [`${SPLITTER}:creatorBps`]: 7_000n,
  [`${SPLITTER}:burnBps`]: 1_000n,
  [`${HOOK}:buyTaxBps`]: 150n,
  [`${HOOK}:sellTaxBps`]: 150n,
  [`${USDC}:decimals`]: 6,
};
const publicClient = {
  readContract: async ({
    address,
    functionName,
    args,
  }: {
    address: Address;
    functionName: string;
    args?: readonly unknown[];
  }) => {
    if (functionName === "balanceOf") expect(args?.[0]).toBe(DEAD);
    const key = `${getAddress(address)}:${functionName}`;
    if (!(key in reads)) throw new Error(`unexpected read ${key}`);
    return reads[key];
  },
};

let h: Harness;
let bare: Harness;
beforeAll(async () => {
  h = await createHarness({
    publicClient: publicClient as never,
    argusLaunch: {
      network: "local",
      chainId: 31337,
      token: KAZI,
      portal: addr(0x305),
      hook: HOOK,
      splitter: SPLITTER,
      burnExecutor: addr(0x306),
      burnAddress: DEAD,
      launchBlock: 1,
    },
  });
});
afterAll(async () => {
  await h.close();
  await bare?.close();
});

describe("KAZI buyback and burn", () => {
  it("reports burned KAZI, USDC spent and waiting, and the tax share that funds it", async () => {
    const b = (await h.app.inject({ method: "GET", url: "/token/kazi-burn" })).json();
    expect(b).toEqual({
      available: true,
      token: KAZI,
      burnAddress: DEAD,
      kaziDecimals: 18,
      totalSupply: SUPPLY.toString(),
      burned: BURNED.toString(),
      burnedBps: 25,
      quoteAsset: USDC,
      quoteDecimals: 6,
      buybackSpent: "30000",
      buybackPending: "14673",
      taxCollected: "638198",
      burnShareBps: 700, // 10% of the creator's 70%
      buyTaxBps: 150,
      sellTaxBps: 150,
    });
  });

  it("says unavailable on a network without an Argus launch", async () => {
    bare = await createHarness({ publicClient: publicClient as never });
    const b = (await bare.app.inject({ method: "GET", url: "/token/kazi-burn" })).json();
    expect(b).toEqual({ available: false });
  });
});
