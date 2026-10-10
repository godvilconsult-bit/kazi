import type { Address } from "viem";
import type { StoredQuote } from "@kazi/shared";

/**
 * How a client pays for a quoted task (docs/12-PUBLIC-API.md). Today: the client's own wallet funds
 * the TaskEscrow (non-custodial). x402 (HTTP 402 pay-per-request via Circle Gateway nanopayments) is
 * an adapter slot: Arc support is unverified for production (docs/00-ARC-FACTS.md §5) and x402
 * pays a resource server rather than an escrow, so it needs a settlement design before enabling.
 */

export type PaymentMethod = "escrow-wallet" | "x402";

export type PaymentInstructions =
  | {
      method: "escrow-wallet";
      chainId: number;
      usdc: Address;
      escrow: Address;
      /** Base units of USDC to approve (exactly this amount) and fund. */
      total: string;
      expiresAt: string;
      steps: { to: Address; function: string; args: unknown[] }[];
    }
  | { method: "x402"; status: "unavailable"; reason: string };

export interface PaymentAdapter {
  readonly method: PaymentMethod;
  readonly enabled: boolean;
  instructions(input: {
    quote: Extract<StoredQuote, { outcome: "QUOTED" }>;
    chainId: number;
    usdc: Address;
    escrow: Address;
  }): PaymentInstructions;
}

export const escrowWalletAdapter: PaymentAdapter = {
  method: "escrow-wallet",
  enabled: true,
  instructions({ quote, chainId, usdc, escrow }) {
    return {
      method: "escrow-wallet",
      chainId,
      usdc,
      escrow,
      total: quote.total,
      expiresAt: quote.expiresAt,
      steps: [
        {
          to: usdc,
          function: "approve(address spender, uint256 amount)",
          args: [escrow, quote.total],
        },
        {
          to: escrow,
          function:
            "createAndFund((bytes32 taskId, uint256[] providerIds, uint128[] amounts, uint64 deadline, uint16 feeBps, uint64 expiry) quote, bytes quoteSig)",
          args: [quote.onchain, quote.signature],
        },
      ],
    };
  },
};

export const x402Adapter: PaymentAdapter = {
  method: "x402",
  enabled: false,
  instructions() {
    return {
      method: "x402",
      status: "unavailable",
      reason:
        "x402 payments are not enabled yet: Arc nanopayments are unverified for production. Fund the escrow from your wallet (method=escrow-wallet).",
    };
  },
};

export const PAYMENT_ADAPTERS: Readonly<Record<PaymentMethod, PaymentAdapter>> = {
  "escrow-wallet": escrowWalletAdapter,
  x402: x402Adapter,
};
