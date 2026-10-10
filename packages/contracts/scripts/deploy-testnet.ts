/**
 * Deploys Kazi to Arc TESTNET from a git-ignored env file (default D:/KAZI/kazi/.env.testnet, or
 * ENV_FILE=...). Never prints private keys and refuses to run against any other chain.
 *
 *   pnpm -F @kazi/contracts deploy:testnet
 *
 * Env file: DEPLOYER_PRIVATE_KEY, OPERATOR_PRIVATE_KEY, QUOTER_PRIVATE_KEY, TREASURY_ADDRESS,
 *           ADMIN_WALLET, optional ADMIN_SAFE (reused if set).
 * 1. Creates (or reuses) the admin Safe v1.4.1 owned by ADMIN_WALLET (threshold 1 on testnet).
 * 2. Runs script/Deploy.s.sol: operator + quoter hot keys; registrar = deployer (so
 *    `setup-providers` can activate house agents) + ADMIN_WALLET (admin page); slasher =
 *    ADMIN_WALLET; token distributor = deployer (test $KAZI for house-agent and tester bonds);
 *    treasury = TREASURY_ADDRESS; buyback reserve = TREASURY_ADDRESS.
 * 3. Sends the escrow operator gas, then checks every role onchain.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeFunctionData,
  formatUnits,
  getAddress,
  http,
  keccak256,
  parseAbi,
  parseUnits,
  stringToHex,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { CHAIN_PRESETS, getChainConfig } from "@kazi/config";
import { agentRegistryAbi, stakingVaultAbi, taskEscrowAbi } from "@kazi/shared";

// Safe v1.4.1 canonical deployments (verified present on Arc testnet).
const SAFE_PROXY_FACTORY: Address = "0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67";
const SAFE_L2_SINGLETON: Address = "0x29fcB43b46531BcA003ddC8FCB67FFE91900C762";
const SAFE_FALLBACK_HANDLER: Address = "0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99";
const ZERO: Address = "0x0000000000000000000000000000000000000000";
/** Gas sent to the escrow operator (releases/refunds), in native USDC. */
const OPERATOR_GAS = "2";

const ENV_FILE = process.env["ENV_FILE"] ?? resolve(import.meta.dirname, "../../../.env.testnet");
const CONTRACTS_DIR = resolve(import.meta.dirname, "..");
const DEPLOYMENT_FILE = resolve(CONTRACTS_DIR, "../config/deployments/testnet.json");

function readEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) throw new Error(`env file not found: ${path}`);
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (!m?.[1]) continue;
    out[m[1]] =
      (m[2] ?? "")
        .split(" #")[0]
        ?.trim()
        .replace(/^["']|["']$/g, "") ?? "";
  }
  return out;
}

function key(env: Record<string, string>, name: string): Hex {
  let v = env[name] ?? "";
  if (v && !v.startsWith("0x")) v = `0x${v}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(v))
    throw new Error(`${name} is missing or not a 32-byte hex key`);
  return v as Hex;
}

function addr(env: Record<string, string>, name: string): Address {
  const v = env[name];
  if (!v) throw new Error(`${name} is missing`);
  return getAddress(v);
}

function forgeBin(): string {
  const local = join(
    homedir(),
    ".foundry",
    "bin",
    process.platform === "win32" ? "forge.exe" : "forge",
  );
  return process.env["FORGE"] ?? (existsSync(local) ? local : "forge");
}

const env = readEnvFile(ENV_FILE);
const chainCfg = getChainConfig("testnet", { rpcUrl: env["ARC_RPC_URL"] || undefined });
const preset = CHAIN_PRESETS.testnet;
const chain = defineChain({
  id: preset.chainId,
  name: preset.name,
  nativeCurrency: preset.nativeCurrency,
  rpcUrls: { default: { http: [chainCfg.rpcUrl] } },
});
const pub = createPublicClient({ chain, transport: http(chainCfg.rpcUrl, { timeout: 30_000 }) });
const actualChainId = await pub.getChainId();
if (actualChainId !== preset.chainId) {
  throw new Error(
    `RPC is chain ${actualChainId}, expected Arc testnet ${preset.chainId}; refusing to deploy`,
  );
}

const deployer = privateKeyToAccount(key(env, "DEPLOYER_PRIVATE_KEY"));
const operator = privateKeyToAccount(key(env, "OPERATOR_PRIVATE_KEY")).address;
const quoter = privateKeyToAccount(key(env, "QUOTER_PRIVATE_KEY")).address;
const treasury = addr(env, "TREASURY_ADDRESS");
const adminWallet = addr(env, "ADMIN_WALLET");
const wallet = createWalletClient({
  account: deployer,
  chain,
  transport: http(chainCfg.rpcUrl, { timeout: 30_000 }),
});

async function fees() {
  const est = await pub.estimateFeesPerGas();
  const floor = preset.minMaxFeePerGasWei;
  const maxFeePerGas = est.maxFeePerGas > floor ? est.maxFeePerGas : floor;
  return {
    maxFeePerGas,
    maxPriorityFeePerGas:
      est.maxPriorityFeePerGas < maxFeePerGas ? est.maxPriorityFeePerGas : maxFeePerGas,
  };
}

const balance = await pub.getBalance({ address: deployer.address });
console.log(
  `deployer ${deployer.address}: ${formatUnits(balance, preset.nativeCurrency.decimals)} USDC (gas)`,
);
if (balance === 0n) throw new Error("the deployer has no testnet USDC for gas");

if (existsSync(DEPLOYMENT_FILE) && !process.argv.includes("--redeploy")) {
  throw new Error(`${DEPLOYMENT_FILE} exists; pass --redeploy to deploy a fresh set of contracts`);
}

// ── 1. Admin Safe ────────────────────────────────────────────────────────────
let adminSafe = env["ADMIN_SAFE"] ? getAddress(env["ADMIN_SAFE"]) : null;
if (adminSafe) {
  const code = await pub.getCode({ address: adminSafe });
  if (!code || code === "0x") throw new Error(`ADMIN_SAFE ${adminSafe} has no code on Arc testnet`);
  console.log(`admin Safe (reused): ${adminSafe}`);
} else {
  const safeAbi = parseAbi([
    "function setup(address[] _owners, uint256 _threshold, address to, bytes data, address fallbackHandler, address paymentToken, uint256 payment, address paymentReceiver)",
  ]);
  const factoryAbi = parseAbi([
    "function createProxyWithNonce(address _singleton, bytes initializer, uint256 saltNonce) returns (address proxy)",
  ]);
  const initializer = encodeFunctionData({
    abi: safeAbi,
    functionName: "setup",
    args: [[adminWallet], 1n, ZERO, "0x", SAFE_FALLBACK_HANDLER, ZERO, 0n, ZERO],
  });
  const saltNonce = BigInt(
    keccak256(stringToHex(`kazi-testnet-admin-${adminWallet.toLowerCase()}`)),
  );
  const { request, result } = await pub.simulateContract({
    account: deployer,
    address: SAFE_PROXY_FACTORY,
    abi: factoryAbi,
    functionName: "createProxyWithNonce",
    args: [SAFE_L2_SINGLETON, initializer, saltNonce],
    ...(await fees()),
  });
  const hash = await wallet.writeContract(request);
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`Safe creation reverted (${hash})`);
  adminSafe = getAddress(result);
  appendFileSync(
    ENV_FILE,
    `\n# Admin Safe v1.4.1 (owner ${adminWallet}, threshold 1), created ${new Date().toISOString()}\nADMIN_SAFE=${adminSafe}\n`,
  );
  console.log(`admin Safe created: ${adminSafe} (tx ${hash})`);
}
const owners = await pub.readContract({
  address: adminSafe,
  abi: parseAbi([
    "function getOwners() view returns (address[])",
    "function getThreshold() view returns (uint256)",
  ]),
  functionName: "getOwners",
});
const owner = owners.length === 1 ? owners[0] : undefined;
if (!owner || getAddress(owner) !== adminWallet) {
  throw new Error(
    `Safe ${adminSafe} owners are ${owners.join(", ")}, expected only ${adminWallet}`,
  );
}

// ── 2. Contracts ─────────────────────────────────────────────────────────────
console.log("deploying contracts with forge (this takes a minute)…");
execFileSync(
  forgeBin(),
  [
    "script",
    "script/Deploy.s.sol",
    "--rpc-url",
    chainCfg.rpcUrl,
    "--broadcast",
    "--slow",
    "--private-key",
    key(env, "DEPLOYER_PRIVATE_KEY"),
  ],
  {
    cwd: CONTRACTS_DIR,
    stdio: ["ignore", "inherit", "inherit"],
    env: {
      ...process.env,
      KAZI_NETWORK: "testnet",
      ADMIN_SAFE: adminSafe,
      OPERATOR_ADDRESS: operator,
      QUOTER_ADDRESS: quoter,
      REGISTRAR_ADDRESS: deployer.address,
      EXTRA_REGISTRAR_ADDRESS: adminWallet,
      SLASHER_ADDRESS: adminWallet,
      TREASURY_ADDRESS: treasury,
      BUYBACK_RESERVE_ADDRESS: treasury,
      TOKEN_DISTRIBUTOR_ADDRESS: deployer.address,
      USDC_ADDRESS: chainCfg.usdcAddress,
    },
  },
);
const d = JSON.parse(readFileSync(DEPLOYMENT_FILE, "utf8")) as Record<string, string | number>;

// ── 3. Operator gas ──────────────────────────────────────────────────────────
const opBalance = await pub.getBalance({ address: operator });
const gas = parseUnits(OPERATOR_GAS, preset.nativeCurrency.decimals);
if (opBalance < gas / 2n) {
  const hash = await wallet.sendTransaction({ to: operator, value: gas, ...(await fees()) });
  await pub.waitForTransactionReceipt({ hash });
  console.log(`sent ${OPERATOR_GAS} USDC gas to the operator ${operator} (tx ${hash})`);
}

// ── 4. Verify roles onchain ──────────────────────────────────────────────────
const escrow = getAddress(String(d["taskEscrow"]));
const registry = getAddress(String(d["agentRegistry"]));
const vault = getAddress(String(d["stakingVault"]));
const ADMIN_ROLE = "0x0000000000000000000000000000000000000000000000000000000000000000" as const;
const [arbiterRole, operatorRole, quoterRole, registrarRole, slasherRole] = await Promise.all([
  pub.readContract({ address: escrow, abi: taskEscrowAbi, functionName: "ARBITER_ROLE" }),
  pub.readContract({ address: escrow, abi: taskEscrowAbi, functionName: "OPERATOR_ROLE" }),
  pub.readContract({ address: escrow, abi: taskEscrowAbi, functionName: "QUOTER_ROLE" }),
  pub.readContract({ address: registry, abi: agentRegistryAbi, functionName: "REGISTRAR_ROLE" }),
  pub.readContract({ address: vault, abi: stakingVaultAbi, functionName: "SLASHER_ROLE" }),
]);
const has = (
  address: Address,
  abi: typeof taskEscrowAbi | typeof agentRegistryAbi | typeof stakingVaultAbi,
  r: Hex,
  who: Address,
) =>
  pub.readContract({
    address,
    abi: abi as typeof taskEscrowAbi,
    functionName: "hasRole",
    args: [r, who],
  });
const checks: [string, Promise<boolean>][] = [
  ["escrow admin = Safe", has(escrow, taskEscrowAbi, ADMIN_ROLE, adminSafe)],
  ["registry admin = Safe", has(registry, agentRegistryAbi, ADMIN_ROLE, adminSafe)],
  ["vault admin = Safe", has(vault, stakingVaultAbi, ADMIN_ROLE, adminSafe)],
  ["escrow arbiter = Safe", has(escrow, taskEscrowAbi, arbiterRole, adminSafe)],
  ["escrow operator", has(escrow, taskEscrowAbi, operatorRole, operator)],
  ["escrow quoter", has(escrow, taskEscrowAbi, quoterRole, quoter)],
  [
    "deployer renounced escrow admin",
    has(escrow, taskEscrowAbi, ADMIN_ROLE, deployer.address).then((v) => !v),
  ],
  [
    "deployer renounced registry admin",
    has(registry, agentRegistryAbi, ADMIN_ROLE, deployer.address).then((v) => !v),
  ],
  [
    "registrar = deployer (house-agent setup)",
    has(registry, agentRegistryAbi, registrarRole, deployer.address),
  ],
  ["registrar = admin wallet", has(registry, agentRegistryAbi, registrarRole, adminWallet)],
  ["slasher = admin wallet", has(vault, stakingVaultAbi, slasherRole, adminWallet)],
];
let ok = true;
for (const [name, p] of checks) {
  const v = await p;
  ok &&= v;
  console.log(`${v ? "✓" : "✗"} ${name}`);
}
console.log(`\ndeployment: ${DEPLOYMENT_FILE}`);
for (const [k, v] of Object.entries(d)) console.log(`  ${k}: ${v}`);
if (!ok) throw new Error("role check failed — do not use this deployment");
