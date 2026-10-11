import type { Redis } from "ioredis";
import type { Logger } from "pino";
import type { Chain, Hex, PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { z } from "zod";
import type { Deployment } from "@kazi/config/deployments";
import type { PrismaClient } from "@kazi/db";
import { ownProviderSlugs, registerKaziProviders, type SetupResult } from "./providers";

/**
 * Registers Kazi's own providers (service fee + house agents) onchain from inside the worker, so a
 * deploy needs no manual step (docs/runbooks/deploy.md §4–5). It uses the setup (registrar) key,
 * held as a Railway secret during the guarded launch. It runs at start and then every `everyMs`
 * until every one of them is active, then stops.
 *
 * Never registers twice: it waits until the indexer has reached the chain head, then hands
 * registerKaziProviders the registrations this key already made (ChainEvent), and a Redis lock keeps
 * two worker replicas from racing.
 */

export interface OwnProviderDeps {
  prisma: PrismaClient;
  redis: Redis;
  keyPrefix: string;
  publicClient: PublicClient;
  chain: Chain;
  rpcUrl: string;
  deployment: Deployment;
  setupKey: Hex;
  /** ChainIndexer cursor id: `${chainId}:${taskEscrow lowercase}`. */
  indexerCursorId: string;
  minMaxFeePerGasWei?: bigint;
  log: Logger;
}

export type OwnProviderRun =
  | { state: "locked" }
  | { state: "indexer-behind"; indexed: bigint | null; head: bigint }
  | { state: "not-seeded" }
  | { state: "partial"; results: SetupResult[] }
  | { state: "done"; results: SetupResult[] };

/** The indexer may trail the head by its confirmations and one batch. */
const INDEXER_SLACK_BLOCKS = 50n;
const LOCK_MS = 15 * 60_000;

const registeredArgs = z.object({
  providerId: z.union([z.string(), z.number(), z.bigint()]),
  owner: z.string(),
  metadataURI: z.string(),
});

export async function registerOwnProvidersOnce(deps: OwnProviderDeps): Promise<OwnProviderRun> {
  const lockKey = `${deps.keyPrefix}:lock:own-providers`;
  if ((await deps.redis.set(lockKey, "1", "PX", LOCK_MS, "NX")) !== "OK")
    return { state: "locked" };
  try {
    const head = await deps.publicClient.getBlockNumber({ cacheTime: 0 });
    const cursor = await deps.prisma.indexerCursor.findUnique({
      where: { id: deps.indexerCursorId },
    });
    if (!cursor || cursor.lastBlock + INDEXER_SLACK_BLOCKS < head)
      return { state: "indexer-behind", indexed: cursor?.lastBlock ?? null, head };

    const slugs = ownProviderSlugs();
    const seeded = await deps.prisma.provider.count({ where: { slug: { in: slugs } } });
    if (seeded === 0) return { state: "not-seeded" };

    // Registrations this key already made (e.g. by a run that stopped before its DB write).
    const setup = privateKeyToAccount(deps.setupKey).address.toLowerCase();
    const rows = await deps.prisma.chainEvent.findMany({
      where: { contract: deps.deployment.agentRegistry.toLowerCase(), name: "ProviderRegistered" },
      select: { args: true },
    });
    const knownRegistrations = new Map<string, bigint>();
    for (const row of rows) {
      const a = registeredArgs.safeParse(row.args);
      if (a.success && a.data.owner.toLowerCase() === setup)
        knownRegistrations.set(a.data.metadataURI, BigInt(a.data.providerId));
    }

    const results = await registerKaziProviders({
      prisma: deps.prisma,
      publicClient: deps.publicClient,
      chain: deps.chain,
      rpcUrl: deps.rpcUrl,
      deployment: deps.deployment,
      setupKey: deps.setupKey,
      ...(deps.minMaxFeePerGasWei !== undefined
        ? { minMaxFeePerGasWei: deps.minMaxFeePerGasWei }
        : {}),
      knownRegistrations,
      log: deps.log,
    });
    return results.length === slugs.length
      ? { state: "done", results }
      : { state: "partial", results };
  } finally {
    await deps.redis.del(lockKey);
  }
}

/** Runs registerOwnProvidersOnce now and every `everyMs` until it reports done. */
export function startOwnProviderRegistration(
  deps: OwnProviderDeps,
  everyMs = 5 * 60_000,
): { stop: () => void } {
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  const round = async () => {
    try {
      const run = await registerOwnProvidersOnce(deps);
      if (run.state === "done") {
        const fresh = run.results.filter((r) => r.status !== "already");
        deps.log.info(
          { registered: fresh.map((r) => r.slug) },
          fresh.length ? "Kazi's providers registered onchain" : "Kazi's providers already active",
        );
        return;
      }
      deps.log.info({ state: run.state }, "Kazi's providers not all active yet; retrying later");
    } catch (err) {
      deps.log.error({ err }, "registering Kazi's providers failed; retrying later");
    }
    if (!stopped) timer = setTimeout(() => void round(), everyMs);
  };
  void round();
  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
