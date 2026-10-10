import type { Hex, LocalAccount } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createKmsAccount } from "./kms";

/**
 * Platform signers (OPERATOR, QUOTER). Production uses a KMS (keys never in memory or env);
 * plaintext keys are for local development and testnet only, and never allowed on mainnet.
 */
export interface SignerEnv {
  NODE_ENV: "development" | "test" | "production";
  KAZI_NETWORK: "local" | "testnet" | "mainnet";
  SIGNER_BACKEND: "env" | "aws-kms";
  ALLOW_PLAINTEXT_KEYS: boolean;
  OPERATOR_PRIVATE_KEY?: string | undefined;
  QUOTER_PRIVATE_KEY?: string | undefined;
  OPERATOR_KMS_KEY_ID?: string | undefined;
  QUOTER_KMS_KEY_ID?: string | undefined;
}

export async function loadSigners(
  env: SignerEnv,
): Promise<{ operator: LocalAccount; quoter: LocalAccount }> {
  if (env.SIGNER_BACKEND === "aws-kms") {
    if (!env.OPERATOR_KMS_KEY_ID || !env.QUOTER_KMS_KEY_ID)
      throw new Error("SIGNER_BACKEND=aws-kms needs OPERATOR_KMS_KEY_ID and QUOTER_KMS_KEY_ID");
    const { awsKmsKey } = await import("./aws-kms");
    const [operator, quoter] = await Promise.all([
      createKmsAccount(awsKmsKey(env.OPERATOR_KMS_KEY_ID)),
      createKmsAccount(awsKmsKey(env.QUOTER_KMS_KEY_ID)),
    ]);
    return { operator, quoter };
  }
  plaintextAllowed(env);
  if (!env.OPERATOR_PRIVATE_KEY || !env.QUOTER_PRIVATE_KEY)
    throw new Error(
      "OPERATOR_PRIVATE_KEY and QUOTER_PRIVATE_KEY are required with SIGNER_BACKEND=env",
    );
  return {
    operator: privateKeyToAccount(env.OPERATOR_PRIVATE_KEY as Hex),
    quoter: privateKeyToAccount(env.QUOTER_PRIVATE_KEY as Hex),
  };
}

/** Plaintext keys: never on mainnet; in production only with an explicit ALLOW_PLAINTEXT_KEYS (testnet). */
export function plaintextAllowed(
  env: Pick<SignerEnv, "NODE_ENV" | "KAZI_NETWORK" | "ALLOW_PLAINTEXT_KEYS">,
): void {
  if (env.KAZI_NETWORK === "mainnet")
    throw new Error("Mainnet signers must use a KMS: set SIGNER_BACKEND=aws-kms");
  if (env.NODE_ENV === "production" && !env.ALLOW_PLAINTEXT_KEYS) {
    throw new Error(
      "Plaintext signer keys are refused in production: set SIGNER_BACKEND=aws-kms, or ALLOW_PLAINTEXT_KEYS=true on testnet",
    );
  }
}
