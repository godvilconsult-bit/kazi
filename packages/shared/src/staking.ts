import { encodeAbiParameters, keccak256, pad, type Address, type Hex } from "viem";

/** StakingVault account keys (packages/contracts/src/StakingVault.sol) and staking perks. */

/** docs/08-TOKENOMICS.md §2.4: clients with at least this much earning stake (KAZI, decimal)… */
export const STAKER_DISCOUNT_MIN_KAZI = "5000";
/** …pay this many basis points less take rate (12% → 10%). */
export const STAKER_DISCOUNT_BPS = 200;

/** holderKey(holder) = bytes32(uint256(uint160(holder))). */
export function holderKey(holder: Address): Hex {
  return pad(holder.toLowerCase() as Hex, { size: 32 });
}

/** providerKey(providerId) = keccak256(abi.encode("kazi.provider", providerId)). */
export function providerKey(providerId: bigint): Hex {
  return keccak256(
    encodeAbiParameters([{ type: "string" }, { type: "uint256" }], ["kazi.provider", providerId]),
  );
}
