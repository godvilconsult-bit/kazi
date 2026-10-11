/**
 * Read-only views of the Argus contracts behind KAZI (docs/08-TOKENOMICS.md §8). Third-party
 * contracts: these signatures were read from the deployed bytecode on Arc mainnet (2026-10-11),
 * not from abis.ts (which forge generates from Kazi's own contracts).
 */

const view = (name: string) =>
  ({
    type: "function",
    name,
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  }) as const;

/** Per-launch revenue splitter: tax in (quote asset), then creator funds / burn / dividends / liquidity. */
export const argusSplitterAbi = [
  view("totalReceived"),
  view("treasuryBps"),
  view("creatorBps"),
  view("burnBps"),
  view("dividendBps"),
  view("liquidityBps"),
  /** Quote-asset amount allocated to buyback-and-burn so far. */
  view("budgetBurn"),
  /** Quote-asset amount the burn executor has spent buying KAZI. */
  view("burnDrawn"),
  {
    type: "function",
    name: "quoteAsset",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
] as const;

/** Per-launch Uniswap v4 hook: the buy and sell tax, fixed at launch. */
export const argusHookAbi = [view("buyTaxBps"), view("sellTaxBps")] as const;

/** Basis points of every trade's tax that fund buyback-and-burn (burnBps applies to the creator side). */
export function argusBurnShareBps(creatorBps: bigint, burnBps: bigint): number {
  return Number((creatorBps * burnBps) / 10_000n);
}
