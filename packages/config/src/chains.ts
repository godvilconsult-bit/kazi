/**
 * Chain presets — the ONLY place chain values live (CLAUDE.md rule 2).
 * Every value is sourced from docs/00-ARC-FACTS.md; update both together.
 *
 * Token decimals are intentionally absent: read `decimals()` from the token
 * contract at startup (CLAUDE.md rule 1). `nativeCurrency.decimals` is chain
 * metadata required by wallets (Arc native USDC = 18), not a money input.
 */

export const NETWORKS = ["local", "testnet", "mainnet"] as const;
export type KaziNetwork = (typeof NETWORKS)[number];

export type Address = `0x${string}`;

export interface ChainPreset {
  readonly network: KaziNetwork;
  readonly chainId: number;
  readonly name: string;
  readonly rpcUrls: readonly string[];
  readonly wsUrl: string | undefined;
  readonly explorerUrl: string | undefined;
  readonly nativeCurrency: {
    readonly name: string;
    readonly symbol: string;
    readonly decimals: number;
  };
  /** USDC ERC-20 interface. Undefined for local: MockUSDC address comes from env/deployments. */
  readonly usdcAddress: Address | undefined;
  /** Arc drops txs with maxFeePerGas below this floor (docs/00-ARC-FACTS.md §3). In wei. */
  readonly minMaxFeePerGasWei: bigint;
  readonly faucetUrl: string | undefined;
}

const ARC_USDC: Address = "0x3600000000000000000000000000000000000000";
const TWENTY_GWEI = 20_000_000_000n;

export const CHAIN_PRESETS: Readonly<Record<KaziNetwork, ChainPreset>> = {
  local: {
    network: "local",
    chainId: 31337,
    name: "Anvil",
    rpcUrls: ["http://127.0.0.1:8545"],
    wsUrl: "ws://127.0.0.1:8545",
    explorerUrl: undefined,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    usdcAddress: undefined,
    minMaxFeePerGasWei: 0n,
    faucetUrl: undefined,
  },
  testnet: {
    network: "testnet",
    chainId: 5042002,
    name: "Arc Testnet",
    rpcUrls: [
      "https://rpc.testnet.arc.io",
      "https://rpc.blockdaemon.testnet.arc.io",
      "https://rpc.drpc.testnet.arc.io",
      "https://rpc.quicknode.testnet.arc.io",
    ],
    wsUrl: "wss://rpc.testnet.arc.io",
    explorerUrl: "https://explorer.testnet.arc.io",
    nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
    usdcAddress: ARC_USDC,
    minMaxFeePerGasWei: TWENTY_GWEI,
    faucetUrl: "https://faucet.circle.com",
  },
  mainnet: {
    network: "mainnet",
    chainId: 5042,
    name: "Arc",
    rpcUrls: [
      "https://rpc.mainnet.arc.io",
      "https://rpc.blockdaemon.mainnet.arc.io",
      "https://rpc.drpc.mainnet.arc.io",
      "https://rpc.quicknode.mainnet.arc.io",
    ],
    wsUrl: "wss://rpc.quicknode.mainnet.arc.io",
    explorerUrl: "https://explorer.arc.io",
    nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
    usdcAddress: ARC_USDC,
    minMaxFeePerGasWei: TWENTY_GWEI,
    faucetUrl: undefined,
  },
};

export interface ChainConfig extends ChainPreset {
  /** RPC actually used: env override first, then preset defaults. */
  readonly rpcUrl: string;
  readonly usdcAddress: Address;
  readonly confirmations: number;
}

export interface ChainOverrides {
  rpcUrl?: string | undefined;
  usdcAddress?: Address | undefined;
  expectedChainId?: number | undefined;
  confirmations?: number | undefined;
}

export class ChainConfigError extends Error {
  override readonly name = "ChainConfigError";
}

export function getChainConfig(network: KaziNetwork, overrides: ChainOverrides = {}): ChainConfig {
  const preset = CHAIN_PRESETS[network];

  if (overrides.expectedChainId !== undefined && overrides.expectedChainId !== preset.chainId) {
    throw new ChainConfigError(
      `ARC_CHAIN_ID=${overrides.expectedChainId} does not match KAZI_NETWORK=${network} (expected ${preset.chainId})`,
    );
  }

  const usdcAddress = overrides.usdcAddress ?? preset.usdcAddress;
  if (usdcAddress === undefined) {
    throw new ChainConfigError(`USDC_ADDRESS is required for KAZI_NETWORK=${network}`);
  }

  const rpcUrl = overrides.rpcUrl ?? preset.rpcUrls[0];
  if (rpcUrl === undefined) {
    throw new ChainConfigError(`No RPC URL configured for KAZI_NETWORK=${network}`);
  }

  return {
    ...preset,
    rpcUrl,
    usdcAddress,
    confirmations: overrides.confirmations ?? 2,
  };
}

/** Explorer link for a tx or address; undefined on networks without an explorer (local). */
export function explorerLink(
  chain: Pick<ChainPreset, "explorerUrl">,
  kind: "tx" | "address",
  value: string,
): string | undefined {
  return chain.explorerUrl === undefined ? undefined : `${chain.explorerUrl}/${kind}/${value}`;
}
