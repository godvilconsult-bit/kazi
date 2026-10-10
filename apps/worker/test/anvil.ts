import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  createPublicClient,
  createWalletClient,
  http,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import {
  agentRegistryAbi,
  feeDistributorAbi,
  kaziTokenAbi,
  mockUsdcAbi,
  stakingVaultAbi,
  taskEscrowAbi,
} from "@kazi/shared";
import type { Deployment } from "@kazi/config/deployments";

/** Well-known anvil dev keys (public test mnemonic — never real funds). */
export const KEYS = {
  admin: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  quoter: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  operator: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  client: "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  providerOwner: "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
} as const satisfies Record<string, Hex>;

const ARTIFACTS = resolve(import.meta.dirname, "../../../packages/contracts/out");

export function artifact(name: string): Hex {
  const path = join(ARTIFACTS, `${name}.sol`, `${name}.json`);
  if (!existsSync(path)) throw new Error(`Missing ${path}. Run \`pnpm -F contracts build\` first.`);
  return (JSON.parse(readFileSync(path, "utf8")) as { bytecode: { object: Hex } }).bytecode.object;
}

function anvilBin(): string {
  const local = join(
    homedir(),
    ".foundry",
    "bin",
    process.platform === "win32" ? "anvil.exe" : "anvil",
  );
  return process.env["ANVIL_BIN"] ?? (existsSync(local) ? local : "anvil");
}

export interface LocalChain {
  rpcUrl: string;
  publicClient: PublicClient;
  wallet: (key: Hex) => ReturnType<typeof createWalletClient>;
  deployment: Deployment;
  minAgentStake: bigint;
  stop: () => void;
}

export async function startLocalChain(): Promise<LocalChain> {
  const port = 20_000 + Math.floor(Math.random() * 20_000);
  const rpcUrl = `http://127.0.0.1:${port}`;
  const proc: ChildProcess = spawn(anvilBin(), ["--port", String(port), "--silent"], {
    stdio: "ignore",
  });
  const publicClient = createPublicClient({
    chain: foundry,
    transport: http(rpcUrl),
  }) as PublicClient;
  for (let i = 0; ; i++) {
    try {
      await publicClient.getChainId();
      break;
    } catch {
      if (i > 100) throw new Error("anvil did not start");
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  const wallet = (key: Hex) =>
    createWalletClient({
      account: privateKeyToAccount(key),
      chain: foundry,
      transport: http(rpcUrl),
    });
  const admin = wallet(KEYS.admin);
  const adminAddr = admin.account!.address;

  async function deploy(name: string, abi: Abi, args: readonly unknown[]): Promise<Address> {
    const hash = await admin.deployContract({
      abi,
      bytecode: artifact(name),
      args,
      account: admin.account!,
      chain: foundry,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (!receipt.contractAddress) throw new Error(`deploy ${name} failed`);
    return receipt.contractAddress;
  }
  async function send(
    key: Hex,
    address: Address,
    abi: Abi,
    functionName: string,
    args: readonly unknown[],
  ) {
    const w = wallet(key);
    const hash = await w.writeContract({
      address,
      abi,
      functionName,
      args,
      account: w.account!,
      chain: foundry,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`${functionName} reverted`);
    return receipt;
  }

  const minAgentStake = 10_000n * 10n ** 18n;
  const usdc = await deploy("MockUSDC", mockUsdcAbi, [6]);
  const kazi = await deploy("KaziToken", kaziTokenAbi, [
    "Kazi",
    "KAZI",
    adminAddr,
    1_000_000_000n * 10n ** 18n,
  ]);
  const registry = await deploy("AgentRegistry", agentRegistryAbi, [
    adminAddr,
    minAgentStake,
    2_000n * 10n ** 18n,
  ]);
  const treasury = privateKeyToAccount(KEYS.operator).address; // any address works as a sink here
  const distributor = await deploy("FeeDistributor", feeDistributorAbi, [
    adminAddr,
    usdc,
    kazi,
    treasury,
    treasury,
    5_000,
    3_000,
    2_000,
  ]);
  const vault = await deploy("StakingVault", stakingVaultAbi, [
    adminAddr,
    kazi,
    usdc,
    registry,
    distributor,
  ]);
  const escrow = await deploy("TaskEscrow", taskEscrowAbi, [
    adminAddr,
    usdc,
    registry,
    distributor,
    1_200,
    7n * 24n * 3600n,
  ]);

  const role = (abi: Abi, address: Address, fn: string) =>
    publicClient.readContract({ address, abi, functionName: fn }) as Promise<Hex>;
  await send(KEYS.admin, registry, agentRegistryAbi, "setStakingVault", [vault]);
  await send(KEYS.admin, distributor, feeDistributorAbi, "setStakingVault", [vault]);
  await send(KEYS.admin, vault, stakingVaultAbi, "grantRole", [
    await role(stakingVaultAbi, vault, "REWARD_NOTIFIER_ROLE"),
    distributor,
  ]);
  await send(KEYS.admin, registry, agentRegistryAbi, "grantRole", [
    await role(agentRegistryAbi, registry, "REGISTRAR_ROLE"),
    adminAddr,
  ]);
  await send(KEYS.admin, escrow, taskEscrowAbi, "grantRole", [
    await role(taskEscrowAbi, escrow, "QUOTER_ROLE"),
    privateKeyToAccount(KEYS.quoter).address,
  ]);
  await send(KEYS.admin, escrow, taskEscrowAbi, "grantRole", [
    await role(taskEscrowAbi, escrow, "OPERATOR_ROLE"),
    privateKeyToAccount(KEYS.operator).address,
  ]);

  return {
    rpcUrl,
    publicClient,
    wallet,
    minAgentStake,
    deployment: {
      network: "local",
      chainId: foundry.id,
      deployedAtBlock: 0,
      usdc,
      kaziToken: kazi,
      agentRegistry: registry,
      feeDistributor: distributor,
      stakingVault: vault,
      taskEscrow: escrow,
      adminSafe: adminAddr,
    },
    stop: () => proc.kill(),
  };
}

export async function sendTx(
  chain: LocalChain,
  key: Hex,
  address: Address,
  abi: Abi,
  functionName: string,
  args: readonly unknown[],
) {
  const w = chain.wallet(key);
  const hash = await w.writeContract({
    address,
    abi,
    functionName,
    args,
    account: w.account!,
    chain: foundry,
  });
  const receipt = await chain.publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${functionName} reverted`);
  return receipt;
}
