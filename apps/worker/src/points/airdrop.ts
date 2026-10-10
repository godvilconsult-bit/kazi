import { getAddress, type Address, type Hex } from "viem";
import { airdropLeaf, buildMerkleTree } from "@kazi/shared";

/**
 * Airdrop plan (docs/08-TOKENOMICS.md §1, §5): turns points into $KAZI allocations and the Merkle
 * tree KaziAirdrop verifies. Pure and deterministic — the same inputs always give the same root.
 *
 * - Fixed allocations (e.g. a published arcdex community list) come out of the total first.
 * - The rest is split pro rata to points among wallets with at least `minPoints`.
 * - No wallet's points share may exceed `maxPerWallet`; capped wallets get the cap and the excess is
 *   re-split among the others (water-filling). If everyone is capped, the remainder stays unallocated.
 * - Rounding dust and anything unallocated stays in the contract and is swept to the treasury
 *   after the claim deadline.
 */

export interface PointsHolder {
  wallet: Address;
  points: bigint;
}

export interface FixedAllocation {
  wallet: Address;
  amount: bigint;
}

export interface PlannedAllocation {
  wallet: Address;
  amount: bigint;
  points: bigint;
  proof: Hex[];
}

export interface AirdropPlan {
  root: Hex;
  total: bigint;
  allocated: bigint;
  unallocated: bigint;
  allocations: PlannedAllocation[];
}

export interface PlanOptions {
  holders: readonly PointsHolder[];
  /** $KAZI base units available to this airdrop (the KaziAirdrop contract's balance). */
  total: bigint;
  minPoints?: bigint;
  /** Largest points-based allocation per wallet, in base units; null for no cap. */
  maxPerWallet?: bigint | null;
  fixed?: readonly FixedAllocation[];
  exclude?: readonly Address[];
}

export function planAirdrop(opts: PlanOptions): AirdropPlan {
  if (opts.total <= 0n) throw new Error("total must be positive");
  const excluded = new Set((opts.exclude ?? []).map((w) => w.toLowerCase()));
  const amounts = new Map<string, bigint>();
  const pointsOf = new Map<string, bigint>();
  const add = (map: Map<string, bigint>, wallet: string, v: bigint) =>
    map.set(wallet, (map.get(wallet) ?? 0n) + v);

  let fixedTotal = 0n;
  for (const f of opts.fixed ?? []) {
    if (f.amount <= 0n) throw new Error(`fixed allocation for ${f.wallet} must be positive`);
    const w = f.wallet.toLowerCase();
    if (excluded.has(w)) continue;
    add(amounts, w, f.amount);
    fixedTotal += f.amount;
  }
  if (fixedTotal > opts.total) throw new Error("fixed allocations exceed the airdrop total");

  for (const h of opts.holders) {
    const w = h.wallet.toLowerCase();
    if (!excluded.has(w) && h.points > 0n) add(pointsOf, w, h.points);
  }
  const minPoints = opts.minPoints ?? 1n;
  let pool = [...pointsOf.entries()]
    .filter(([, p]) => p >= minPoints)
    .sort(([a], [b]) => (a < b ? -1 : 1));

  const cap = opts.maxPerWallet ?? null;
  let budget = opts.total - fixedTotal;
  while (pool.length > 0 && budget > 0n) {
    const totalPoints = pool.reduce((a, [, p]) => a + p, 0n);
    const share = (p: bigint) => (budget * p) / totalPoints;
    const capped = cap === null ? [] : pool.filter(([, p]) => share(p) > cap);
    if (capped.length === 0) {
      let given = 0n;
      for (const [w, p] of pool) {
        const amount = share(p);
        add(amounts, w, amount);
        given += amount;
      }
      budget -= given;
      break;
    }
    for (const [w] of capped) {
      add(amounts, w, cap as bigint);
      budget -= cap as bigint;
    }
    const cappedSet = new Set(capped.map(([w]) => w));
    pool = pool.filter(([w]) => !cappedSet.has(w));
  }

  const rows = [...amounts.entries()]
    .filter(([, a]) => a > 0n)
    .sort(([a], [b]) => (a < b ? -1 : 1));
  if (rows.length === 0) throw new Error("nobody qualifies for this airdrop");
  const tree = buildMerkleTree(rows.map(([w, a]) => airdropLeaf(getAddress(w), a)));
  const allocations = rows.map(([w, amount], i) => ({
    wallet: getAddress(w),
    amount,
    points: pointsOf.get(w) ?? 0n,
    proof: tree.proof(i),
  }));
  const allocated = allocations.reduce((a, r) => a + r.amount, 0n);
  return {
    root: tree.root,
    total: opts.total,
    allocated,
    unallocated: opts.total - allocated,
    allocations,
  };
}
