import { describe, expect, it } from "vitest";
import {
  CHAIN_PRESETS,
  ChainConfigError,
  EnvValidationError,
  authEnvSchema,
  explorerLink,
  getChainConfig,
  loadChainConfig,
  loadEnv,
} from "./index";

const MOCK_USDC = "0x5FbDB2315678afecb367f032d93F642f64180aa3";

describe("chain presets", () => {
  it("match docs/00-ARC-FACTS.md", () => {
    expect(CHAIN_PRESETS.mainnet.chainId).toBe(5042);
    expect(CHAIN_PRESETS.testnet.chainId).toBe(5042002);
    expect(CHAIN_PRESETS.mainnet.usdcAddress).toBe("0x3600000000000000000000000000000000000000");
    expect(CHAIN_PRESETS.testnet.minMaxFeePerGasWei).toBe(20_000_000_000n);
  });
});

describe("getChainConfig", () => {
  it("uses preset RPC and USDC on testnet", () => {
    const cfg = getChainConfig("testnet");
    expect(cfg.rpcUrl).toBe("https://rpc.testnet.arc.io");
    expect(cfg.usdcAddress).toBe(CHAIN_PRESETS.testnet.usdcAddress);
    expect(cfg.confirmations).toBe(2);
  });

  it("applies RPC override", () => {
    const cfg = getChainConfig("mainnet", { rpcUrl: "https://example.org/rpc" });
    expect(cfg.rpcUrl).toBe("https://example.org/rpc");
  });

  it("requires USDC_ADDRESS on local", () => {
    expect(() => getChainConfig("local")).toThrow(ChainConfigError);
    expect(getChainConfig("local", { usdcAddress: MOCK_USDC }).usdcAddress).toBe(MOCK_USDC);
  });

  it("rejects a chain id that does not match the network", () => {
    expect(() => getChainConfig("mainnet", { expectedChainId: 5042002 })).toThrow(/does not match/);
  });
});

describe("loadChainConfig", () => {
  it("resolves from env and treats empty strings as unset", () => {
    const cfg = loadChainConfig({
      KAZI_NETWORK: "testnet",
      ARC_CHAIN_ID: "5042002",
      ARC_RPC_URL: "",
      USDC_ADDRESS: "",
      CONFIRMATIONS: "",
    });
    expect(cfg.chainId).toBe(5042002);
    expect(cfg.rpcUrl).toBe("https://rpc.testnet.arc.io");
    expect(cfg.confirmations).toBe(2);
  });

  it("fails fast on an unknown network", () => {
    expect(() => loadChainConfig({ KAZI_NETWORK: "devnet" })).toThrow(EnvValidationError);
  });

  it("rejects a malformed USDC address", () => {
    expect(() => loadChainConfig({ KAZI_NETWORK: "local", USDC_ADDRESS: "0x123" })).toThrow(
      /USDC_ADDRESS/,
    );
  });
});

describe("loadEnv", () => {
  it("lists every invalid variable without echoing values", () => {
    try {
      loadEnv(authEnvSchema, { JWT_SECRET: "short", ENCRYPTION_KEY: "bm9wZQ==" });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(EnvValidationError);
      const message = (err as EnvValidationError).message;
      expect(message).toMatch(/JWT_SECRET/);
      expect(message).toMatch(/ENCRYPTION_KEY/);
      expect(message).not.toMatch(/short/);
    }
  });

  it("parses admin wallet lists", () => {
    const env = loadEnv(authEnvSchema, {
      JWT_SECRET: "x".repeat(32),
      ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
      ADMIN_WALLETS: `${MOCK_USDC}, ${MOCK_USDC}`,
    });
    expect(env.ADMIN_WALLETS).toHaveLength(2);
  });
});

describe("explorerLink", () => {
  it("builds links when an explorer exists", () => {
    expect(explorerLink(CHAIN_PRESETS.mainnet, "tx", "0xabc")).toBe(
      "https://explorer.arc.io/tx/0xabc",
    );
    expect(explorerLink(CHAIN_PRESETS.local, "tx", "0xabc")).toBeUndefined();
  });
});
