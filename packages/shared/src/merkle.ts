import { concat, encodeAbiParameters, keccak256, type Address, type Hex } from "viem";

/**
 * Merkle tree for KaziAirdrop, compatible with OpenZeppelin's StandardMerkleTree / MerkleProof:
 * leaf = keccak256(bytes.concat(keccak256(abi.encode(account, amount)))) and parents hash the
 * sorted pair, so proofs need no left/right flags.
 */

export function airdropLeaf(account: Address, amount: bigint): Hex {
  return keccak256(concat([keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [account, amount]))]));
}

function hashPair(a: Hex, b: Hex): Hex {
  return BigInt(a) < BigInt(b) ? keccak256(concat([a, b])) : keccak256(concat([b, a]));
}

export interface MerkleTree {
  root: Hex;
  proof(index: number): Hex[];
}

/** Builds the tree over leaves in the given order. An odd node at the end of a level moves up. */
export function buildMerkleTree(leaves: readonly Hex[]): MerkleTree {
  if (leaves.length === 0) throw new Error("no leaves");
  const levels: Hex[][] = [[...leaves]];
  while ((levels.at(-1) ?? []).length > 1) {
    const level = levels.at(-1) ?? [];
    const next: Hex[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i];
      const right = level[i + 1];
      if (left === undefined) break;
      next.push(right === undefined ? left : hashPair(left, right));
    }
    levels.push(next);
  }
  const root = levels.at(-1)?.[0];
  if (!root) throw new Error("empty tree");
  return {
    root,
    proof(index: number): Hex[] {
      const proof: Hex[] = [];
      let i = index;
      for (let l = 0; l < levels.length - 1; l++) {
        const level = levels[l] ?? [];
        const sibling = level[i % 2 === 0 ? i + 1 : i - 1];
        if (sibling !== undefined) proof.push(sibling);
        i = Math.floor(i / 2);
      }
      return proof;
    },
  };
}

export function verifyMerkleProof(proof: readonly Hex[], root: Hex, leaf: Hex): boolean {
  return proof.reduce<Hex>((acc, p) => hashPair(acc, p), leaf).toLowerCase() === root.toLowerCase();
}
