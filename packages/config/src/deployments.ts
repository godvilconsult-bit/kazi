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
