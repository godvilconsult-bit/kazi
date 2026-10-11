import type { Logger } from "pino";
import {
  createWalletClient,
  http,
  keccak256,
  parseEventLogs,
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
 * house agents (§7) — bonds the minimum $KAZI for each and activates them, and stores the onchain
 * id in the DB. The setup key must hold REGISTRAR_ROLE and enough $KAZI for every bond.
 *
 * Safe to re-run, and to resume after a crash: the onchain id is stored as soon as the register
 * transaction is mined, a provider's onchain status (not the DB's) decides whether it still needs
 * its bond and activation, and `knownRegistrations` (registrations this key already made, e.g.
 * from the indexer) is consulted before registering, so a provider is never registered twice.
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
  /** Onchain registrations this setup key already made, by metadata URI → provider id. */
  knownRegistrations?: ReadonlyMap<string, bigint>;
}

export interface SetupResult {
  slug: string;
  onchainId: bigint;
  /** registered: new onchain; activated: was registered, now bonded + active; already: was active. */
  status: "registered" | "activated" | "already";
}

/** AgentRegistry ProviderStatus: NONE, PENDING, ACTIVE, SUSPENDED, DELISTED. */
const PENDING = 1;
const ACTIVE = 2;

export const ownProviderSlugs = (): string[] => [
  SERVICE_FEE_PROVIDER_SLUG,
  ...HOUSE_AGENT_LISTINGS.map((l) => l.slug),
];
export const providerMetadataUri = (slug: string) => `kazi://providers/${slug}`;

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

  async function send(
    address: Address,
    abi: readonly unknown[],
    functionName: string,
    args: readonly unknown[],
  ) {
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
      maxPriorityFeePerGas:
        fees.maxPriorityFeePerGas < maxFeePerGas ? fees.maxPriorityFeePerGas : maxFeePerGas,
    });
    const hash = await wallet.writeContract(request as never);
    const receipt = await opts.publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`${functionName} reverted (${hash})`);
    return receipt;
  }

  const stakedOf = (id: bigint) =>
    opts.publicClient.readContract({
      address: d.stakingVault,
      abi: stakingVaultAbi,
      functionName: "stakedOf",
      args: [id],
    });

  const results: SetupResult[] = [];
  for (const slug of ownProviderSlugs()) {
    const p = await opts.prisma.provider.findUnique({ where: { slug } });
    if (!p) {
      opts.log.warn({ slug }, "provider missing from the DB; run `pnpm db:seed` first");
      continue;
    }
    let id = p.onchainId ?? opts.knownRegistrations?.get(providerMetadataUri(slug)) ?? null;
    let registered = false;
    if (id === null) {
      const receipt = await send(d.agentRegistry, agentRegistryAbi, "register", [
        0, // ProviderKind.AGENT
        p.payoutAddress as Address,
        providerMetadataUri(slug),
        keccak256(stringToHex(slug)),
      ]);
      // The id comes from the event, not a prediction: anyone can register concurrently.
      const [event] = parseEventLogs({
        abi: agentRegistryAbi,
        eventName: "ProviderRegistered",
        logs: receipt.logs,
      });
      if (!event) throw new Error(`register ${slug}: no ProviderRegistered event`);
      id = event.args.providerId;
      registered = true;
    }
    if (p.onchainId === null) {
      // Stored right away: a crash before activation resumes from here instead of registering again.
      await opts.prisma.provider.update({ where: { id: p.id }, data: { onchainId: id } });
    }
    const status = Number(
      await opts.publicClient.readContract({
        address: d.agentRegistry,
        abi: agentRegistryAbi,
        functionName: "statusOf",
        args: [id],
      }),
    );
    if (status === PENDING) {
      // Networks without bonds yet (minimum 0, e.g. the mainnet guarded launch) skip the bond.
      const staked = await stakedOf(id);
      if (minStake > staked) {
        await send(d.kaziToken, kaziTokenAbi, "approve", [d.stakingVault, minStake - staked]);
        await send(d.stakingVault, stakingVaultAbi, "bond", [id, minStake - staked]);
      }
      await send(d.agentRegistry, agentRegistryAbi, "activate", [id]);
    } else if (status !== ACTIVE) {
      opts.log.warn(
        { slug, onchainId: id.toString(), status },
        "provider is suspended or delisted onchain; left as is",
      );
      continue;
    }
    await opts.prisma.provider.update({
      where: { id: p.id },
      data: { status: "ACTIVE", stakeAmount: (await stakedOf(id)).toString() },
    });
    const outcome = registered ? "registered" : status === PENDING ? "activated" : "already";
    if (outcome !== "already")
      opts.log.info({ slug, onchainId: id.toString(), outcome }, "Kazi provider active onchain");
    results.push({ slug, onchainId: id, status: outcome });
  }
  return results;
}
