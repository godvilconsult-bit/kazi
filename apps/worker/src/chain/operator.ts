import type { Logger } from "pino";
import {
  createWalletClient,
  http,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { taskEscrowAbi } from "@kazi/shared";

/**
 * The OPERATOR key's onchain writes (release / refund / reassign). Transactions are sent one at
 * a time and each waits for its receipt, so the nonce never races (one operator per process).
 */

export const MILESTONE_STATUSES = ["NONE", "FUNDED", "RELEASED", "REFUNDED"] as const;
export type OnchainMilestoneStatus = (typeof MILESTONE_STATUSES)[number];

export interface OnchainMilestone {
  providerId: bigint;
  amount: bigint;
  status: OnchainMilestoneStatus;
}

export interface EscrowOperator {
  readonly address: Address;
  milestone(taskId: Hex, index: number): Promise<OnchainMilestone>;
  release(taskId: Hex, index: number): Promise<Hex>;
  refund(taskId: Hex, index: number): Promise<Hex>;
  reassign(taskId: Hex, index: number, providerId: bigint): Promise<Hex>;
}

export function createEscrowOperator(opts: {
  publicClient: PublicClient;
  rpcUrl: string;
  chain: Chain;
  escrow: Address;
  privateKey: Hex;
  /** Arc drops transactions whose maxFeePerGas is below this floor (docs/00-ARC-FACTS.md §3). */
  minMaxFeePerGasWei: bigint;
  log: Logger;
}): EscrowOperator {
  const account = privateKeyToAccount(opts.privateKey);
  const wallet = createWalletClient({ account, chain: opts.chain, transport: http(opts.rpcUrl) });
  let queue: Promise<unknown> = Promise.resolve();

  /** Simulate (surfaces reverts with decoded errors), send, wait for the receipt. Serialized. */
  function write(
    functionName: "releaseMilestone" | "refundMilestone" | "reassign",
    args: readonly [Hex, bigint] | readonly [Hex, bigint, bigint],
  ): Promise<Hex> {
    const run = async () => {
      const fees = await opts.publicClient.estimateFeesPerGas();
      const maxFeePerGas =
        fees.maxFeePerGas > opts.minMaxFeePerGasWei ? fees.maxFeePerGas : opts.minMaxFeePerGasWei;
      const maxPriorityFeePerGas =
        fees.maxPriorityFeePerGas < maxFeePerGas ? fees.maxPriorityFeePerGas : maxFeePerGas;
      const { request } = await opts.publicClient.simulateContract({
        account,
        address: opts.escrow,
        abi: taskEscrowAbi,
        functionName,
        args: args as never,
        maxFeePerGas,
        maxPriorityFeePerGas,
      });
      const hash = await wallet.writeContract(request);
      const receipt = await opts.publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error(`${functionName} reverted in ${hash}`);
      opts.log.info(
        { functionName, taskId: args[0], index: Number(args[1]), hash },
        "operator tx mined",
      );
      return hash;
    };
    const next = queue.then(run, run);
    queue = next.catch(() => undefined);
    return next;
  }

  return {
    address: account.address,
    async milestone(taskId, index) {
      const m = await opts.publicClient.readContract({
        address: opts.escrow,
        abi: taskEscrowAbi,
        functionName: "getMilestone",
        args: [taskId, BigInt(index)],
      });
      return {
        providerId: m.providerId,
        amount: m.amount,
        status: MILESTONE_STATUSES[m.status] ?? "NONE",
      };
    },
    release: (taskId, index) => write("releaseMilestone", [taskId, BigInt(index)]),
    refund: (taskId, index) => write("refundMilestone", [taskId, BigInt(index)]),
    reassign: (taskId, index, providerId) => write("reassign", [taskId, BigInt(index), providerId]),
  };
}
