import { decodeEventLog, type Abi, type Address, type Log, type PublicClient } from "viem";
import type { Logger } from "pino";
import type { PrismaClient } from "@kazi/db";
import type { Deployment } from "@kazi/config/deployments";
import { agentRegistryAbi, feeDistributorAbi, stakingVaultAbi, taskEscrowAbi } from "@kazi/shared";
import { applyChainEvent, type ContractKind } from "./handlers";

export interface IndexerOptions {
  chainId: number;
  /** Blocks needed before an event counts (1 = act on inclusion; Arc has instant finality). */
  confirmations: number;
  batchSize: bigint;
  /** On process start, re-scan this many blocks below the cursor (defensive reorg handling). */
  reorgDepth: bigint;
}

const CONTRACTS: readonly { key: keyof Deployment; kind: ContractKind; abi: Abi }[] = [
  { key: "taskEscrow", kind: "TaskEscrow", abi: taskEscrowAbi },
  { key: "agentRegistry", kind: "AgentRegistry", abi: agentRegistryAbi },
  { key: "stakingVault", kind: "StakingVault", abi: stakingVaultAbi },
  { key: "feeDistributor", kind: "FeeDistributor", abi: feeDistributorAbi },
];

/** Polls eth_getLogs → ChainEvent (unique per chain/tx/logIndex) → state processors. Idempotent. */
export class ChainIndexer {
  private readonly byAddress = new Map<string, { kind: ContractKind; abi: Abi }>();
  private readonly cursorId: string;
  private rescanned = false;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly client: PublicClient,
    private readonly deployment: Deployment,
    private readonly opts: IndexerOptions,
    private readonly log: Logger,
  ) {
    for (const c of CONTRACTS) {
      this.byAddress.set(String(deployment[c.key]).toLowerCase(), { kind: c.kind, abi: c.abi });
    }
    this.cursorId = `${opts.chainId}:${deployment.taskEscrow.toLowerCase()}`;
  }

  /** Index one batch of confirmed blocks. Returns the scanned range (or null if up to date). */
  async pollOnce(): Promise<{ from: bigint; to: bigint; stored: number } | null> {
    // cacheTime 0: viem caches the block number (~4 s) by default, which would stall a fast chain.
    const latest = await this.client.getBlockNumber({ cacheTime: 0 });
    const confirmedTip = latest - BigInt(this.opts.confirmations - 1);
    const cursor = await this.prisma.indexerCursor.findUnique({ where: { id: this.cursorId } });
    const start = BigInt(this.deployment.deployedAtBlock);
    let from = cursor ? cursor.lastBlock + 1n : start;
    if (!this.rescanned && cursor) {
      from = maxBig(start, from - this.opts.reorgDepth);
      this.rescanned = true;
    }
    if (from > confirmedTip) return null;
    const to = minBig(confirmedTip, from + this.opts.batchSize - 1n);

    const logs = await this.client.getLogs({
      address: [...this.byAddress.keys()] as Address[],
      fromBlock: from,
      toBlock: to,
    });

    const rows = logs.flatMap((l) => this.decode(l));
    await this.prisma.$transaction([
      this.prisma.chainEvent.createMany({ data: rows, skipDuplicates: true }),
      this.prisma.indexerCursor.upsert({
        where: { id: this.cursorId },
        update: { lastBlock: to },
        create: { id: this.cursorId, lastBlock: to },
      }),
    ]);
    if (rows.length > 0) this.log.info({ from, to, events: rows.length }, "indexed chain events");
    return { from, to, stored: rows.length };
  }

  /** Apply unprocessed events in chain order. Each handler is idempotent; failures stay unprocessed. */
  async processPending(limit = 500): Promise<number> {
    const pending = await this.prisma.chainEvent.findMany({
      where: { processed: false, chainId: this.opts.chainId },
      orderBy: [{ blockNumber: "asc" }, { logIndex: "asc" }],
      take: limit,
    });
    let done = 0;
    for (const event of pending) {
      const contract = this.byAddress.get(event.contract);
      if (!contract) continue;
      try {
        await applyChainEvent(this.prisma, contract.kind, event, {
          client: this.client,
          deployment: this.deployment,
          log: this.log,
        });
        await this.prisma.chainEvent.update({ where: { id: event.id }, data: { processed: true } });
        done++;
      } catch (err) {
        // Stop here so later events for the same task aren't applied out of order; the job retries.
        this.log.error(
          { err, chainEventId: event.id, name: event.name, txHash: event.txHash },
          "chain event processing failed",
        );
        throw err;
      }
    }
    return done;
  }

  private decode(l: Log) {
    const contract = this.byAddress.get(l.address.toLowerCase());
    if (!contract || l.transactionHash === null || l.logIndex === null || l.blockNumber === null)
      return [];
    try {
      const decoded = decodeEventLog({ abi: contract.abi, data: l.data, topics: l.topics });
      const name = decoded.eventName as string | undefined;
      if (name === undefined) return [];
      return [
        {
          chainId: this.opts.chainId,
          contract: l.address.toLowerCase(),
          name,
          txHash: l.transactionHash,
          logIndex: l.logIndex,
          blockNumber: l.blockNumber,
          args: toJson(decoded.args),
        },
      ];
    } catch {
      this.log.warn({ txHash: l.transactionHash, logIndex: l.logIndex }, "undecodable log skipped");
      return [];
    }
  }
}

/** bigint → decimal string, recursively (JSON-safe; money stays exact). */
export function toJson(value: unknown): never {
  const walk = (v: unknown): unknown => {
    if (typeof v === "bigint") return v.toString();
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object")
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(value) as never;
}

const maxBig = (a: bigint, b: bigint) => (a > b ? a : b);
const minBig = (a: bigint, b: bigint) => (a < b ? a : b);
