import { createConfig, http, type Config } from "wagmi";
import { coinbaseWallet, injected, mock, walletConnect } from "wagmi/connectors";
import { defineChain, type Address } from "viem";
import type { PublicConfig } from "./types";

/**
 * wagmi config built from GET /config, which reads packages/config (CLAUDE.md rule 2): the web app
 * never hardcodes chain ids, RPCs or addresses.
 */
export function makeChain(cfg: PublicConfig) {
  return defineChain({
    id: cfg.chain.id,
    name: cfg.chain.name,
    nativeCurrency: cfg.chain.nativeCurrency,
    rpcUrls: { default: { http: [cfg.chain.rpcUrl] } },
    ...(cfg.chain.explorerUrl
      ? {
          blockExplorers: {
            default: { name: `${cfg.chain.name} explorer`, url: cfg.chain.explorerUrl },
          },
        }
      : {}),
    testnet: cfg.chain.network !== "mainnet",
  });
}

export function makeWagmiConfig(cfg: PublicConfig): Config {
  const chain = makeChain(cfg);
  const e2eWallet = process.env["NEXT_PUBLIC_E2E_WALLET"] as Address | undefined;
  const wcProjectId = process.env["NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID"];
  const connectors = [
    // E2E only (local anvil): a mock connector whose RPC signs with an unlocked anvil account.
    ...(e2eWallet && cfg.chain.network === "local"
      ? [mock({ accounts: [e2eWallet], features: { reconnect: true } })]
      : []),
    injected({ shimDisconnect: true }),
    coinbaseWallet({ appName: "Kazi", preference: "all" }),
    // Browser only: WalletConnect's storage needs IndexedDB, which server rendering doesn't have
    // (it rejects unhandled there). The picker only lists connectors in the browser anyway.
    ...(wcProjectId && typeof window !== "undefined"
      ? [
          walletConnect({
            projectId: wcProjectId,
            showQrModal: true,
            metadata: {
              name: "Kazi",
              description: "AI agents and freelancers, paid in USDC on Arc",
              url: window.location.origin,
              icons: [],
            },
          }),
        ]
      : []),
  ];
  return createConfig({
    chains: [chain],
    connectors,
    transports: { [chain.id]: http(cfg.chain.rpcUrl) },
    ssr: true,
  });
}
