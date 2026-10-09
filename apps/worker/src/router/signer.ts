import { createPublicClient, http, type Address, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Deployment } from "@kazi/config/deployments";
import {
  QUOTE_EIP712_TYPES,
  agentRegistryAbi,
  mockUsdcAbi,
  quoteDomain,
  taskEscrowAbi,
} from "@kazi/shared";

/** EIP-712 quote signing (docs/04-BACKEND-API.md §6). The key never leaves this module or the logs. */

export interface OnchainQuoteArgs {
  taskId: Hex;
  providerIds: readonly bigint[];
  amounts: readonly bigint[];
  deadline: bigint;
  feeBps: number;
  expiry: bigint;
}

export interface QuoteSigner {
  readonly address: Address;
  sign(quote: OnchainQuoteArgs, client: Address): Promise<Hex>;
}

export function createQuoteSigner(privateKey: Hex, chainId: number, escrow: Address): QuoteSigner {
  const account = privateKeyToAccount(privateKey);
  const domain = quoteDomain(chainId, escrow);
  return {
    address: account.address,
    sign: (quote, client) =>
      account.signTypedData({
        domain,
        types: QUOTE_EIP712_TYPES,
        primaryType: "Quote",
        message: {
          taskId: quote.taskId,
          client,
          providerIds: [...quote.providerIds],
          amounts: [...quote.amounts],
          deadline: quote.deadline,
          feeBps: quote.feeBps,
          expiry: quote.expiry,
        },
      }),
  };
}

/** The few onchain values the router needs; read fresh per quote (fees and stakes change). */
export interface RouterChain {
  chainId: number;
  escrow: Address;
  /** USDC decimals (CLAUDE.md rule 1: read from the token, never hardcoded). */
  usdcDecimals(): Promise<number>;
  /** The escrow's published fee; quotes may not exceed it. */
  publishedFeeBps(): Promise<number>;
  minAgentStake(): Promise<bigint>;
}

export function createRouterChain(
  client: PublicClient,
  chainId: number,
  d: Deployment,
): RouterChain {
  let decimals: number | undefined;
  return {
    chainId,
    escrow: d.taskEscrow,
    async usdcDecimals() {
      decimals ??= Number(
        await client.readContract({ address: d.usdc, abi: mockUsdcAbi, functionName: "decimals" }),
      );
      return decimals;
    },
    async publishedFeeBps() {
      return Number(
        await client.readContract({
          address: d.taskEscrow,
          abi: taskEscrowAbi,
          functionName: "feeBps",
        }),
      );
    },
    async minAgentStake() {
      return client.readContract({
        address: d.agentRegistry,
        abi: agentRegistryAbi,
        functionName: "minStake",
        args: [0],
      });
    },
  };
}

export function createRouterChainFromRpc(
  rpcUrl: string,
  chainId: number,
  d: Deployment,
): RouterChain {
  return createRouterChain(createPublicClient({ transport: http(rpcUrl) }), chainId, d);
}
