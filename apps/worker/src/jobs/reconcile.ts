import type { Redis } from "ioredis";
import type { Logger } from "pino";
import { erc20Abi, type PublicClient } from "viem";
import type { PrismaClient } from "@kazi/db";
import type { Deployment } from "@kazi/config/deployments";

export interface ReconciliationResult {
  checkedAt: string;
  block: string;
  onchainBalance: string;
  expectedBalance: string;
  difference: string;
  ok: boolean;
}

export const reconciliationKey = (prefix: string) => `${prefix}:reconciliation:last`;

/**
 * Escrow reconciliation (docs/02 §8): USDC.balanceOf(escrow) at the indexer cursor block must
 * equal Σ funded − Σ released/refunded according to the indexed events. A mismatch means missed
 * events, a direct transfer to the escrow, or a bug — alert on it.
 */
export async function reconcileEscrow(
  prisma: PrismaClient,
  client: PublicClient,
  deployment: Deployment,
  chainId: number,
  redis: Redis,
  redisPrefix: string,
  log: Logger,
): Promise<ReconciliationResult | null> {
  const cursor = await prisma.indexerCursor.findUnique({
    where: { id: `${chainId}:${deployment.taskEscrow.toLowerCase()}` },
  });
  if (!cursor) return null;

  const escrow = deployment.taskEscrow.toLowerCase();
  const events = await prisma.chainEvent.findMany({
    where: {
      chainId,
      contract: escrow,
      blockNumber: { lte: cursor.lastBlock },
      name: { in: ["TaskFunded", "MilestoneReleased", "MilestoneRefunded", "DisputeResolved"] },
    },
    select: { name: true, args: true },
  });

  let expected = 0n;
  for (const e of events) {
    const a = e.args as Record<string, string>;
    switch (e.name) {
      case "TaskFunded":
        expected += BigInt(a["totalAmount"] ?? "0");
        break;
      case "MilestoneReleased":
        expected -= BigInt(a["providerAmount"] ?? "0") + BigInt(a["fee"] ?? "0");
        break;
      case "MilestoneRefunded":
        expected -= BigInt(a["amount"] ?? "0");
        break;
      case "DisputeResolved":
        expected -=
          BigInt(a["clientAmount"] ?? "0") +
          BigInt(a["providerAmount"] ?? "0") +
          BigInt(a["fee"] ?? "0");
        break;
    }
  }

  const onchain = await client.readContract({
    address: deployment.usdc,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [deployment.taskEscrow],
    blockNumber: cursor.lastBlock,
  });

  const result: ReconciliationResult = {
    checkedAt: new Date().toISOString(),
    block: cursor.lastBlock.toString(),
    onchainBalance: onchain.toString(),
    expectedBalance: expected.toString(),
    difference: (onchain - expected).toString(),
    ok: onchain === expected,
  };
  await redis.set(reconciliationKey(redisPrefix), JSON.stringify(result));
  if (result.ok) log.info(result, "escrow reconciliation ok");
  else log.error(result, "ESCROW RECONCILIATION MISMATCH");
  return result;
}
