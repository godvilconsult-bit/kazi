import { GetPublicKeyCommand, KMSClient, SignCommand } from "@aws-sdk/client-kms";
import type { KmsKey } from "./kms";

/**
 * AWS KMS backend for platform signers (SIGNER_BACKEND=aws-kms). Keys: KeySpec ECC_SECG_P256K1,
 * KeyUsage SIGN_VERIFY. Credentials and region come from the standard AWS chain (instance role,
 * AWS_REGION, …); the IAM policy only needs kms:GetPublicKey and kms:Sign on these keys.
 */
export function awsKmsKey(keyId: string, client: KMSClient = new KMSClient({})): KmsKey {
  return {
    async getPublicKey() {
      const res = await client.send(new GetPublicKeyCommand({ KeyId: keyId }));
      if (res.KeySpec !== "ECC_SECG_P256K1" || !res.PublicKey) {
        throw new Error(`KMS key ${keyId} is not a secp256k1 signing key (KeySpec ${res.KeySpec ?? "unknown"})`);
      }
      return res.PublicKey;
    },
    async signDigest(digest) {
      const res = await client.send(
        new SignCommand({ KeyId: keyId, Message: digest, MessageType: "DIGEST", SigningAlgorithm: "ECDSA_SHA_256" }),
      );
      if (!res.Signature) throw new Error(`KMS key ${keyId} returned no signature`);
      return res.Signature;
    },
  };
}
