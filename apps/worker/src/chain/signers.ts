import type { Hex, LocalAccount } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { parseUnits } from "@kazi/shared";
import { createKmsAccount } from "./kms";

/**
 * Platform signers (OPERATOR, QUOTER). A KMS keeps the keys out of memory and env entirely.
 * Plaintext keys (from env, e.g. Railway secret variables) are for local development and testnet,
 * and on mainnet only during the guarded launch: explicitly allowed and with small escrow caps
 * (docs/runbooks/deploy.md §4). Raising the caps past PLAINTEXT_MAINNET_ESCROW_CAP_USDC needs a KMS.
 */
export const PLAINTEXT_MAINNET_ESCROW_CAP_USDC = "10000";

export interface SignerEnv {
  NODE_ENV: "development" | "test" | "production";
  KAZI_NETWORK: "local" | "testnet" | "mainnet";
  SIGNER_BACKEND: "env" | "aws-kms";
  ALLOW_PLAINTEXT_KEYS: boolean;
  OPERATOR_PRIVATE_KEY?: string | undefined;
  QUOTER_PRIVATE_KEY?: string | undefined;
  OPERATOR_KMS_KEY_ID?: string | undefined;
  QUOTER_KMS_KEY_ID?: string | undefined;
  /** Guarded-launch caps (env.ts guardEnvSchema): plaintext keys on mainnet need both. */
  MAX_TASK_USDC?: string | undefined;
  MAX_OPEN_ESCROW_USDC?: string | undefined;
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

/**
 * Plaintext keys: in production only with an explicit ALLOW_PLAINTEXT_KEYS; on mainnet, additionally
 * only while the guarded-launch caps are set and open escrow is capped at
 * PLAINTEXT_MAINNET_ESCROW_CAP_USDC or less.
 */
export function plaintextAllowed(
  env: Pick<
    SignerEnv,
    "NODE_ENV" | "KAZI_NETWORK" | "ALLOW_PLAINTEXT_KEYS" | "MAX_TASK_USDC" | "MAX_OPEN_ESCROW_USDC"
  >,
): void {
  if (env.KAZI_NETWORK === "mainnet") {
    if (!env.ALLOW_PLAINTEXT_KEYS)
      throw new Error(
        "Mainnet signers need a KMS (SIGNER_BACKEND=aws-kms), or ALLOW_PLAINTEXT_KEYS=true during the guarded launch",
      );
    if (!env.MAX_TASK_USDC || !env.MAX_OPEN_ESCROW_USDC)
      throw new Error(
        "Plaintext signer keys on mainnet need the guarded-launch caps MAX_TASK_USDC and MAX_OPEN_ESCROW_USDC",
      );
    // Compared as fixed-point integers (CLAUDE.md rule 1); 18 places covers any USDC decimals.
    if (
      parseUnits(env.MAX_OPEN_ESCROW_USDC, 18) > parseUnits(PLAINTEXT_MAINNET_ESCROW_CAP_USDC, 18)
    )
      throw new Error(
        `Plaintext signer keys on mainnet are allowed only while MAX_OPEN_ESCROW_USDC ≤ ${PLAINTEXT_MAINNET_ESCROW_CAP_USDC}: move the signers to a KMS first`,
      );
    return;
  }
  if (env.NODE_ENV === "production" && !env.ALLOW_PLAINTEXT_KEYS) {
    throw new Error(
      "Plaintext signer keys are refused in production: set SIGNER_BACKEND=aws-kms, or ALLOW_PLAINTEXT_KEYS=true on testnet",
    );
  }
}
