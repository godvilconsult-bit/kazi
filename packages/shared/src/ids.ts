import { keccak256, stringToHex, type Hex } from "viem";

/** Onchain task id = keccak256(utf8(dbTaskId)) — docs/04-BACKEND-API.md §2 (Task.onchainId). */
export function taskOnchainId(taskId: string): Hex {
  return keccak256(stringToHex(taskId));
}

/** Lowercase canonical form used for every wallet stored in the DB. */
export function normalizeWallet(address: string): `0x${string}` {
  return address.toLowerCase() as `0x${string}`;
}
