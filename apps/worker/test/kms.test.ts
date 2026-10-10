import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  bytesToHex,
  createWalletClient,
  hexToBytes,
  http,
  numberToHex,
  parseEther,
  recoverTransactionAddress,
  verifyMessage,
  verifyTypedData,
  type Hex,
  type TransactionSerialized,
} from "viem";
import { privateKeyToAccount, sign } from "viem/accounts";
import { foundry } from "viem/chains";
import { createKmsAccount, parseDerSignature, uncompressedPublicKey, type KmsKey } from "../src/chain/kms";
import { loadSigners, plaintextAllowed } from "../src/chain/signers";
import { KEYS, startLocalChain, type LocalChain } from "./anvil";

/** Phase 7: KMS-backed signer (docs/09 §3) — checked against a local key standing in for the KMS. */

const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const SPKI_PREFIX = "3056301006072a8648ce3d020106052b8104000a034200"; // id-ecPublicKey, secp256k1, BIT STRING

function derInteger(v: bigint): string {
  let hex = v.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  if (parseInt(hex.slice(0, 2), 16) >= 0x80) hex = `00${hex}`; // keep it positive
  return `02${(hex.length / 2).toString(16).padStart(2, "0")}${hex}`;
}

function derSignature(r: bigint, s: bigint): Uint8Array {
  const body = derInteger(r) + derInteger(s);
  return hexToBytes(`0x30${(body.length / 2).toString(16).padStart(2, "0")}${body}`);
}

/** What AWS KMS returns for a secp256k1 key, produced with a local key. `highS` mimics KMS returning the other half of the curve. */
function fakeKms(privateKey: Hex, highS = false): KmsKey {
  const account = privateKeyToAccount(privateKey);
  return {
    getPublicKey: async () => hexToBytes(`0x${SPKI_PREFIX}${account.publicKey.slice(2)}`),
    signDigest: async (digest) => {
      const sig = await sign({ hash: bytesToHex(digest), privateKey });
      const r = BigInt(sig.r);
      const s = BigInt(sig.s);
      return derSignature(r, highS ? N - s : s);
    },
  };
}

describe("KMS account", () => {
  const key = KEYS.operator;
  const local = privateKeyToAccount(key);

  it("derives the address from the KMS public key", async () => {
    const account = await createKmsAccount(fakeKms(key));
    expect(account.address).toBe(local.address);
    expect(uncompressedPublicKey(await fakeKms(key).getPublicKey())).toBe(local.publicKey);
  });

  it("signs messages and typed data that verify, normalising high-s signatures", async () => {
    for (const highS of [false, true]) {
      const account = await createKmsAccount(fakeKms(key, highS));
      const signature = await account.signMessage({ message: "Sign in to Kazi" });
      expect(signature).toBe(await local.signMessage({ message: "Sign in to Kazi" })); // RFC 6979: identical
      expect(await verifyMessage({ address: local.address, message: "Sign in to Kazi", signature })).toBe(true);

      const typed = {
        domain: { name: "Kazi", version: "1", chainId: 31337, verifyingContract: "0x0000000000000000000000000000000000000001" },
        types: { Quote: [{ name: "taskId", type: "bytes32" }, { name: "expiry", type: "uint64" }] },
        primaryType: "Quote",
        message: { taskId: numberToHex(1n, { size: 32 }), expiry: 1_800_000_000n },
      } as const;
      const typedSig = await account.signTypedData(typed);
      expect(await verifyTypedData({ address: local.address, ...typed, signature: typedSig })).toBe(true);
    }
  });

  it("signs transactions exactly like the local key", async () => {
    const account = await createKmsAccount(fakeKms(key, true));
    const tx = { chainId: 31337, nonce: 3, to: local.address, value: parseEther("1"), gas: 21_000n, maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1n, type: "eip1559" } as const;
    const serialized = await account.signTransaction(tx);
    expect(serialized).toBe(await local.signTransaction(tx));
    expect(await recoverTransactionAddress({ serializedTransaction: serialized as TransactionSerialized })).toBe(local.address);
  });

  it("rejects malformed KMS responses", () => {
    expect(() => parseDerSignature(new Uint8Array([0x31, 0x00]))).toThrow(/malformed/);
    expect(() => parseDerSignature(derSignature(0n, 1n))).toThrow(/range/);
    expect(() => uncompressedPublicKey(new Uint8Array(10))).toThrow(/uncompressed/);
  });
});

describe("signer policy", () => {
  const base = { NODE_ENV: "development", KAZI_NETWORK: "local", SIGNER_BACKEND: "env", ALLOW_PLAINTEXT_KEYS: false } as const;

  it("uses dev keys locally, refuses them in production unless allowed, and never on mainnet", async () => {
    const accounts = await loadSigners({ ...base, OPERATOR_PRIVATE_KEY: KEYS.operator, QUOTER_PRIVATE_KEY: KEYS.quoter });
    expect(accounts.operator.address).toBe(privateKeyToAccount(KEYS.operator).address);
    expect(() => plaintextAllowed({ NODE_ENV: "production", KAZI_NETWORK: "testnet", ALLOW_PLAINTEXT_KEYS: false })).toThrow(/refused in production/);
    expect(() => plaintextAllowed({ NODE_ENV: "production", KAZI_NETWORK: "testnet", ALLOW_PLAINTEXT_KEYS: true })).not.toThrow();
    expect(() => plaintextAllowed({ NODE_ENV: "production", KAZI_NETWORK: "mainnet", ALLOW_PLAINTEXT_KEYS: true })).toThrow(/KMS/);
    await expect(loadSigners({ ...base, SIGNER_BACKEND: "aws-kms" })).rejects.toThrow(/OPERATOR_KMS_KEY_ID/);
  });
});

describe("KMS account onchain", () => {
  let chain: LocalChain;
  beforeAll(async () => {
    chain = await startLocalChain();
  });
  afterAll(() => chain?.stop());

  it("sends a transaction anvil accepts", async () => {
    const account = await createKmsAccount(fakeKms(KEYS.operator));
    const wallet = createWalletClient({ account, chain: foundry, transport: http(chain.rpcUrl) });
    const to = privateKeyToAccount(KEYS.client).address;
    const before = await chain.publicClient.getBalance({ address: to });
    const hash = await wallet.sendTransaction({ to, value: 12_345n });
    const receipt = await chain.publicClient.waitForTransactionReceipt({ hash });
    expect(receipt.status).toBe("success");
    expect(receipt.from.toLowerCase()).toBe(account.address.toLowerCase());
    expect(await chain.publicClient.getBalance({ address: to })).toBe(before + 12_345n);
  });
});
