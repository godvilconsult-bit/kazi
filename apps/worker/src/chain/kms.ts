import {
  bytesToBigInt,
  hashMessage,
  hashTypedData,
  hexToBytes,
  keccak256,
  numberToHex,
  parseSignature,
  recoverAddress,
  serializeSignature,
  serializeTransaction,
  toHex,
  type Hex,
  type LocalAccount,
  type SerializeTransactionFn,
  type TransactionSerializable,
} from "viem";
import { publicKeyToAddress, toAccount } from "viem/accounts";

/**
 * A viem account whose private key never leaves a KMS (docs/09-SECURITY-COMPLIANCE.md §3). The KMS
 * only signs 32-byte digests; this adapter hashes (EIP-191 / EIP-712 / transaction), normalises the
 * signature to low-s (EIP-2) and finds the recovery bit by recovering against the key's address.
 */

/** The two operations a KMS-held secp256k1 key needs (AWS implementation: aws-kms.ts). */
export interface KmsKey {
  /** DER-encoded SubjectPublicKeyInfo of a secp256k1 public key. */
  getPublicKey(): Promise<Uint8Array>;
  /** DER-encoded ECDSA signature of `digest` (32 bytes, signed as-is, not hashed again). */
  signDigest(digest: Uint8Array): Promise<Uint8Array>;
}

/** secp256k1 group order. */
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

export async function createKmsAccount(key: KmsKey): Promise<LocalAccount> {
  const publicKey = uncompressedPublicKey(await key.getPublicKey());
  const address = publicKeyToAddress(publicKey);

  const signHash = async (hash: Hex): Promise<Hex> => {
    const { r, s: rawS } = parseDerSignature(await key.signDigest(hexToBytes(hash)));
    const s = rawS > N / 2n ? N - rawS : rawS;
    for (const yParity of [0, 1] as const) {
      const signature = serializeSignature({
        r: numberToHex(r, { size: 32 }),
        s: numberToHex(s, { size: 32 }),
        yParity,
      });
      if ((await recoverAddress({ hash, signature })) === address) return signature;
    }
    throw new Error("KMS signature does not recover to the key's address");
  };

  return toAccount({
    address,
    async sign({ hash }) {
      return signHash(hash);
    },
    async signMessage({ message }) {
      return signHash(hashMessage(message));
    },
    async signTypedData(typedData) {
      return signHash(hashTypedData(typedData));
    },
    async signTransaction(transaction, options) {
      const serializer = (options?.serializer ??
        serializeTransaction) as SerializeTransactionFn<TransactionSerializable>;
      const unsigned = await serializer(transaction as TransactionSerializable);
      const signature = parseSignature(await signHash(keccak256(unsigned)));
      return serializer(transaction as TransactionSerializable, signature);
    },
  });
}

/** The 65-byte uncompressed point (0x04 ‖ X ‖ Y) at the end of a secp256k1 SPKI. */
export function uncompressedPublicKey(spki: Uint8Array): Hex {
  const point = spki.slice(-65);
  if (spki.length < 65 || point[0] !== 0x04)
    throw new Error("KMS public key is not an uncompressed secp256k1 point");
  return toHex(point);
}

/** DER `SEQUENCE { INTEGER r, INTEGER s }` → r, s. */
export function parseDerSignature(der: Uint8Array): { r: bigint; s: bigint } {
  let i = 0;
  const byte = () => {
    const b = der[i++];
    if (b === undefined) throw new Error("truncated DER signature");
    return b;
  };
  const expect = (tag: number) => {
    if (byte() !== tag) throw new Error("malformed DER signature");
  };
  const length = () => {
    const first = byte();
    if (first < 0x80) return first;
    let len = 0;
    for (let k = 0; k < (first & 0x7f); k++) len = (len << 8) | byte();
    return len;
  };
  const integer = () => {
    expect(0x02);
    const len = length();
    if (len === 0 || i + len > der.length) throw new Error("malformed DER integer");
    const value = bytesToBigInt(der.slice(i, i + len));
    i += len;
    return value;
  };
  expect(0x30);
  length();
  const r = integer();
  const s = integer();
  if (r <= 0n || r >= N || s <= 0n || s >= N) throw new Error("DER signature out of range");
  return { r, s };
}
