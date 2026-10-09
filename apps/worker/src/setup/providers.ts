import type { Logger } from "pino";
import {
  createWalletClient,
  http,
  keccak256,
  stringToHex,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Deployment } from "@kazi/config/deployments";
import type { PrismaClient } from "@kazi/db";
import {
  HOUSE_AGENT_LISTINGS,
  SERVICE_FEE_PROVIDER_SLUG,
  agentRegistryAbi,
  kaziTokenAbi,
  stakingVaultAbi,
} from "@kazi/shared";

/**
 * Registers Kazi's own providers onchain — the service-fee provider (docs/06-ROUTER.md §3) and the
 * house agents (§7) — bonds the minimum $KAZI for each and activates them, then stores the
 * onchain id in the DB. Idempotent: providers that already have an onchain id are skipped.
 * The setup key must hold REGISTRAR_ROLE and enough $KAZI for every bond.
 */

export interface SetupOptions {
  prisma: PrismaClient;
  publicClient: PublicClient;
  chain: Chain;
  rpcUrl: string;
  deployment: Deployment;
  setupKey: Hex;
  log: Logger;
  /** Arc drops transactions whose maxFeePerGas is below this floor. */
  minMaxFeePerGasWei?: bigint;
}

export interface SetupResult {
  slug: string;
  onchainId: bigint;
  status: "registered" | "already";
}

export async function registerKaziProviders(opts: SetupOptions): Promise<SetupResult[]> {
  const account = privateKeyToAccount(opts.setupKey);
  const wallet = createWalletClient({ account, chain: opts.chain, transport: http(opts.rpcUrl) });
  const d = opts.deployment;
  const minStake = await opts.publicClient.readContract({
    address: d.agentRegistry,
    abi: agentRegistryAbi,
    functionName: "minStake",
    args: [0],
  });

  async function send(address: Address, abi: readonly unknown[], functionName: string, args: readonly unknown[]) {
    const fees = await opts.publicClient.estimateFeesPerGas();
    const floor = opts.minMaxFeePerGasWei ?? 0n;
    const maxFeePerGas = fees.maxFeePerGas > floor ? fees.maxFeePerGas : floor;
    const { request } = await opts.publicClient.simulateContract({
      account,
      address,
      abi: abi as never,
      functionName: functionName as never,
      args: args as never,
      maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas < maxFeePerGas ? fees.maxPriorityFeePerGas : maxFeePerGas,
    });
    const hash = await wallet.writeContract(request as never);
    const receipt = await opts.publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`${functionName} reverted (${hash})`);
    return receipt;
  }

  const slugs = [SERVICE_FEE_PROVIDER_SLUG, ...HOUSE_AGENT_LISTINGS.map((l) => l.slug)];
  const results: SetupResult[] = [];
  for (const slug of slugs) {
    const p = await opts.prisma.provider.findUnique({ where: { slug } });
    if (!p) {
      opts.log.warn({ slug }, "provider missing from the DB; run `pnpm db:seed` first");
      continue;
    }
    if (p.onchainId !== null) {
      results.push({ slug, onchainId: p.onchainId, status: "already" });
      continue;
    }
    const id = await opts.publicClient.readContract({
      address: d.agentRegistry,
      abi: agentRegistryAbi,
      functionName: "nextProviderId",
    });
    await send(d.agentRegistry, agentRegistryAbi, "register", [
      0, // ProviderKind.AGENT
      p.payoutAddress as Address,
      `kazi://providers/${slug}`,
      keccak256(stringToHex(slug)),
    ]);
    await send(d.kaziToken, kaziTokenAbi, "approve", [d.stakingVault, minStake]);
    await send(d.stakingVault, stakingVaultAbi, "bond", [id, minStake]);
    await send(d.agentRegistry, agentRegistryAbi, "activate", [id]);
    await opts.prisma.provider.update({
      where: { id: p.id },
      data: { onchainId: id, status: "ACTIVE", stakeAmount: minStake.toString() },
    });
    opts.log.info({ slug, onchainId: id.toString() }, "provider registered, bonded and activated");
    results.push({ slug, onchainId: id, status: "registered" });
  }
  return results;
}
