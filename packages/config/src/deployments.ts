import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { addressSchema } from "./env";
import type { KaziNetwork } from "./chains";

/**
 * Contract addresses written by packages/contracts/script/Deploy.s.sol.
 * Node-only entry point (`@kazi/config/deployments`) because it reads the filesystem.
 */
export const deploymentSchema = z.object({
  network: z.string(),
  chainId: z.number().int().positive(),
  deployedAtBlock: z.number().int().nonnegative(),
  usdc: addressSchema,
  kaziToken: addressSchema,
  agentRegistry: addressSchema,
  feeDistributor: addressSchema,
  stakingVault: addressSchema,
  taskEscrow: addressSchema,
  adminSafe: addressSchema,
});
export type Deployment = z.infer<typeof deploymentSchema>;

export const DEFAULT_DEPLOYMENTS_DIR = resolve(import.meta.dirname, "../deployments");

export class DeploymentNotFoundError extends Error {
  override readonly name = "DeploymentNotFoundError";
}

/** Token launch allocations written by script/DeployTokenLaunch.s.sol (Phase 6). */
export const tokenLaunchSchema = z.object({
  network: z.string(),
  tge: z.number().int().nonnegative(),
  total: z.union([z.string(), z.number()]).transform(String),
  teamVesting: addressSchema,
  ecosystemVesting: addressSchema,
  airdrop: addressSchema,
  treasury: addressSchema,
  liquidity: addressSchema,
  community: addressSchema,
});
export type TokenLaunch = z.infer<typeof tokenLaunchSchema>;

/** The token launch for a network, or null when the token hasn't launched there yet. */
export function loadTokenLaunch(
  network: KaziNetwork,
  dir: string = DEFAULT_DEPLOYMENTS_DIR,
): TokenLaunch | null {
  const path = resolve(dir, `${network}-token-launch.json`);
  if (!existsSync(path)) return null;
  return tokenLaunchSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

/**
 * KAZI ⇄ KAZI Credits gate written by script/DeployCreditsGate.s.sol (docs/08-TOKENOMICS.md §8):
 * `kazi` is the token traded on Argus, `credits` is Kazi's own token (= deployment.kaziToken).
 */
export const creditsGateSchema = z.object({
  network: z.string(),
  chainId: z.number().int().positive(),
  deployedAtBlock: z.number().int().nonnegative(),
  gate: addressSchema,
  kazi: addressSchema,
  credits: addressSchema,
});
export type CreditsGate = z.infer<typeof creditsGateSchema>;

/** The credits gate for a network, or null when it isn't deployed there. */
export function loadCreditsGate(
  network: KaziNetwork,
  dir: string = DEFAULT_DEPLOYMENTS_DIR,
): CreditsGate | null {
  const path = resolve(dir, `${network}-credits-gate.json`);
  if (!existsSync(path)) return null;
  return creditsGateSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

export function loadDeployment(
  network: KaziNetwork,
  dir: string = DEFAULT_DEPLOYMENTS_DIR,
): Deployment {
  const path = resolve(dir, `${network}.json`);
  if (!existsSync(path)) {
    throw new DeploymentNotFoundError(
      `No deployment for ${network} at ${path}. Run the deploy script (packages/contracts) first.`,
    );
  }
  return deploymentSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}
