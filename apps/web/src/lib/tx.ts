"use client";

import { useCallback } from "react";
import { useConfig } from "wagmi";
import {
  getAccount,
  getPublicClient,
  sendTransaction,
  switchChain,
  waitForTransactionReceipt,
  writeContract,
} from "wagmi/actions";
import type { Abi, ContractFunctionArgs, ContractFunctionName, Hex } from "viem";
import { useKaziConfig } from "@/components/config";
import type { Address } from "./types";

/**
 * Wallet writes with Arc's fee floor applied (docs/00-ARC-FACTS.md §3: transactions priced below
 * 20 gwei are dropped) and an explicit chain check, waiting for the receipt.
 */
export function useTx() {
  const config = useConfig();
  const cfg = useKaziConfig();

  const prepare = useCallback(async () => {
    if (getAccount(config).chainId !== cfg.chain.id) {
      await switchChain(config, { chainId: cfg.chain.id });
    }
    const floor = BigInt(cfg.chain.minMaxFeePerGasWei);
    if (floor === 0n) return {};
    const client = getPublicClient(config, { chainId: cfg.chain.id });
    if (!client) return {};
    const est = await client.estimateFeesPerGas().catch(() => null);
    if (!est?.maxFeePerGas) return { maxFeePerGas: floor };
    return {
      maxFeePerGas: est.maxFeePerGas < floor ? floor : est.maxFeePerGas,
      maxPriorityFeePerGas: est.maxPriorityFeePerGas,
    };
  }, [config, cfg]);

  const wait = useCallback(
    async (hash: Hex) => {
      const receipt = await waitForTransactionReceipt(config, { hash, chainId: cfg.chain.id });
      if (receipt.status !== "success") throw new Error("The transaction reverted onchain.");
      return receipt;
    },
    [config, cfg],
  );

  const write = useCallback(
    async <
      const abi extends Abi,
      fn extends ContractFunctionName<abi, "nonpayable" | "payable">,
      args extends ContractFunctionArgs<abi, "nonpayable" | "payable", fn>,
    >(
      req: { address: Address; abi: abi; functionName: fn; args: args },
      onHash?: (hash: Hex) => void,
    ) => {
      const fees = await prepare();
      // wagmi's generics don't narrow through a wrapper; the request is fully typed by the caller.
      const hash = await writeContract(config, {
        address: req.address,
        abi: req.abi,
        functionName: req.functionName,
        args: req.args,
        ...fees,
        chainId: cfg.chain.id,
      } as never);
      onHash?.(hash);
      await wait(hash);
      return hash;
    },
    [config, cfg, prepare, wait],
  );

  /** Raw calldata from the API (admin actions). */
  const send = useCallback(
    async (tx: { to: Address; data: Hex }, onHash?: (hash: Hex) => void) => {
      const fees = await prepare();
      const hash = await sendTransaction(config, { to: tx.to, data: tx.data, value: 0n, ...fees, chainId: cfg.chain.id });
      onHash?.(hash);
      await wait(hash);
      return hash;
    },
    [config, cfg, prepare, wait],
  );

  return { write, send };
}
