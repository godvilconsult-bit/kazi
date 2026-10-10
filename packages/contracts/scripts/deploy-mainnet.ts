/**
 * Deploys Kazi to Arc MAINNET for the guarded launch (docs/runbooks/deploy.md §2). Reads the
 * git-ignored D:/KAZI/kazi/.env.mainnet (or ENV_FILE=...). Never prints private keys.
 *
 *   pnpm -F @kazi/contracts deploy:mainnet -- --i-accept-unaudited-contracts
 *
 * Required in the env file:
 *   DEPLOYER_PRIVATE_KEY   fresh key that only pays gas (it renounces every admin role)
 *   SETUP_ADDRESS          hot key that registers + activates Kazi's house agents (REGISTRAR only)
 *   ADMIN_SAFE_OWNERS      comma-separated owner addresses of the admin Safe (hardware wallets)
 *   ADMIN_SAFE_THRESHOLD   signatures required (≥ 2 unless --allow-single-signer)
 *   PAUSER_ADDRESS         guardian wallet that can pause the escrow (not unpause)
 *   OPERATOR_ADDRESS       KMS-held operator (pnpm -F @kazi/worker kms-address -- <key id>)
 *   QUOTER_ADDRESS         KMS-held quoter
 * Optional: ADMIN_SAFE (reuse an existing Safe), TREASURY_ADDRESS (default: the Safe),
 *           FEE_BPS (default 1200), ARC_RPC_URL.
 *
 * Guarded-launch choices (docs/HANDOVER.md §5): no provider bonds and no staker fee share until the
 * token launch (min stakes 0, split 80% treasury / 20% buyback reserve), the whole $KAZI supply
 * minted to the Safe and not distributed. The deployer sends no funds anywhere: the operator's gas
 * is funded by you.
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
  stringToHex,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { CHAIN_PRESETS, getChainConfig } from "@kazi/config";
import { agentRegistryAbi, feeDistributorAbi, stakingVaultAbi, taskEscrowAbi } from "@kazi/shared";

// Safe v1.4.1 canonical deployments (verified present on Arc mainnet 2026-10-10).
const SAFE_PROXY_FACTORY: Address = "0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67";
const SAFE_L2_SINGLETON: Address = "0x29fcB43b46531BcA003ddC8FCB67FFE91900C762";
const SAFE_FALLBACK_HANDLER: Address = "0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99";
const ZERO: Address = "0x0000000000000000000000000000000000000000";

const ENV_FILE = process.env["ENV_FILE"] ?? resolve(import.meta.dirname, "../../../.env.mainnet");
const CONTRACTS_DIR = resolve(import.meta.dirname, "..");
const DEPLOYMENT_FILE = resolve(CONTRACTS_DIR, "../config/deployments/mainnet.json");

if (!process.argv.includes("--i-accept-unaudited-contracts")) {
  throw new Error(
    "Mainnet holds real USDC and these contracts are not audited yet. Re-run with " +
      "--i-accept-unaudited-contracts once you accept that risk (guarded launch, docs/HANDOVER.md).",
  );
}

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
  const v = env[name] ?? "";
  if (!/^0x[0-9a-fA-F]{64}$/.test(v))
    throw new Error(`${name} is missing or not a 32-byte hex key`);
  return v as Hex;
}

function addr(env: Record<string, string>, name: string): Address {
  const v = env[name];
  if (!v) throw new Error(`${name} is missing in ${ENV_FILE}`);
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
const preset = CHAIN_PRESETS.mainnet;
const chainCfg = getChainConfig("mainnet", { rpcUrl: env["ARC_RPC_URL"] || undefined });
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
    `RPC is chain ${actualChainId}, expected Arc mainnet ${preset.chainId}; refusing to deploy`,
  );
}

// ── Inputs ───────────────────────────────────────────────────────────────────
const deployer = privateKeyToAccount(key(env, "DEPLOYER_PRIVATE_KEY"));
const setup = addr(env, "SETUP_ADDRESS");
const pauser = addr(env, "PAUSER_ADDRESS");
const operator = addr(env, "OPERATOR_ADDRESS");
const quoter = addr(env, "QUOTER_ADDRESS");
const owners = (env["ADMIN_SAFE_OWNERS"] ?? "")
  .split(",")
  .map((a) => a.trim())
  .filter(Boolean)
  .map((a) => getAddress(a));
const threshold = BigInt(env["ADMIN_SAFE_THRESHOLD"] ?? "0");
if (owners.length === 0) throw new Error("ADMIN_SAFE_OWNERS is missing");
if (new Set(owners).size !== owners.length) throw new Error("ADMIN_SAFE_OWNERS has duplicates");
if (threshold < 1n || threshold > BigInt(owners.length))
  throw new Error("ADMIN_SAFE_THRESHOLD must be between 1 and the number of owners");
if (threshold < 2n && !process.argv.includes("--allow-single-signer")) {
  throw new Error(
    "A 1-signature admin Safe means one stolen key controls the platform. Use ≥ 2 signers, or pass --allow-single-signer.",
  );
}
const hot = [deployer.address, setup, operator, quoter];
for (const o of [...owners, pauser]) {
  if (hot.some((h) => h.toLowerCase() === o.toLowerCase())) {
    throw new Error(
      `${o} is both a Safe owner/guardian and a backend hot key; use separate wallets`,
    );
  }
}
if (new Set([deployer.address, setup, operator, quoter].map((a) => a.toLowerCase())).size !== 4) {
  throw new Error("deployer, setup, operator and quoter must be four different addresses");
}

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
if (balance === 0n) throw new Error("the deployer has no USDC for gas on Arc mainnet");
if (existsSync(DEPLOYMENT_FILE))
  throw new Error(`${DEPLOYMENT_FILE} exists — Kazi is already deployed on mainnet`);

// ── 1. Admin Safe ────────────────────────────────────────────────────────────
const safeReadAbi = parseAbi([
  "function getOwners() view returns (address[])",
  "function getThreshold() view returns (uint256)",
]);
let adminSafe = env["ADMIN_SAFE"] ? getAddress(env["ADMIN_SAFE"]) : null;
if (!adminSafe) {
  const initializer = encodeFunctionData({
    abi: parseAbi([
      "function setup(address[] _owners, uint256 _threshold, address to, bytes data, address fallbackHandler, address paymentToken, uint256 payment, address paymentReceiver)",
    ]),
    functionName: "setup",
    args: [owners, threshold, ZERO, "0x", SAFE_FALLBACK_HANDLER, ZERO, 0n, ZERO],
  });
  const saltNonce = BigInt(
    keccak256(stringToHex(`kazi-mainnet-admin-${owners.join(",").toLowerCase()}-${threshold}`)),
  );
  const { request, result } = await pub.simulateContract({
    account: deployer,
    address: SAFE_PROXY_FACTORY,
    abi: parseAbi([
      "function createProxyWithNonce(address _singleton, bytes initializer, uint256 saltNonce) returns (address proxy)",
    ]),
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
    `\n# Admin Safe v1.4.1 (${threshold}-of-${owners.length}), created ${new Date().toISOString()}\nADMIN_SAFE=${adminSafe}\n`,
  );
  console.log(`admin Safe created: ${adminSafe} (tx ${hash})`);
}
const [safeOwners, safeThreshold] = await Promise.all([
  pub.readContract({ address: adminSafe, abi: safeReadAbi, functionName: "getOwners" }),
  pub.readContract({ address: adminSafe, abi: safeReadAbi, functionName: "getThreshold" }),
]);
const sameOwners =
  safeOwners.length === owners.length && safeOwners.every((o) => owners.includes(getAddress(o)));
if (!sameOwners || safeThreshold !== threshold) {
  throw new Error(
    `Safe ${adminSafe} is ${safeThreshold}-of-[${safeOwners.join(", ")}], expected ${threshold}-of-[${owners.join(", ")}]`,
  );
}
const treasury = env["TREASURY_ADDRESS"] ? getAddress(env["TREASURY_ADDRESS"]) : adminSafe;

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
      KAZI_NETWORK: "mainnet",
      ADMIN_SAFE: adminSafe,
      OPERATOR_ADDRESS: operator,
      QUOTER_ADDRESS: quoter,
      REGISTRAR_ADDRESS: setup,
      EXTRA_REGISTRAR_ADDRESS: owners[0],
      SLASHER_ADDRESS: adminSafe,
      PAUSER_ADDRESS: pauser,
      TREASURY_ADDRESS: treasury,
      BUYBACK_RESERVE_ADDRESS: adminSafe,
      TOKEN_DISTRIBUTOR_ADDRESS: adminSafe,
      USDC_ADDRESS: chainCfg.usdcAddress,
      FEE_BPS: env["FEE_BPS"] || "1200",
      MIN_AGENT_STAKE: "0",
      MIN_HUMAN_STAKE: "0",
      TREASURY_BPS: "8000",
      STAKER_BPS: "0",
      BUYBACK_BPS: "2000",
    },
  },
);
const d = JSON.parse(readFileSync(DEPLOYMENT_FILE, "utf8")) as Record<string, string | number>;

// ── 3. Verify roles and settings onchain ─────────────────────────────────────
const escrow = getAddress(String(d["taskEscrow"]));
const registry = getAddress(String(d["agentRegistry"]));
const vault = getAddress(String(d["stakingVault"]));
const distributor = getAddress(String(d["feeDistributor"]));
const ADMIN_ROLE = `0x${"00".repeat(32)}` as Hex;
const role = (
  address: Address,
  abi: typeof taskEscrowAbi | typeof agentRegistryAbi | typeof stakingVaultAbi,
  name: string,
) =>
  pub.readContract({
    address,
    abi: abi as typeof taskEscrowAbi,
    functionName: name as "ARBITER_ROLE",
  }) as Promise<Hex>;
const has = (address: Address, r: Hex, who: Address) =>
  pub.readContract({ address, abi: taskEscrowAbi, functionName: "hasRole", args: [r, who] });
const [arbiter, operatorRole, quoterRole, pauserRole, registrarRole, slasherRole] =
  await Promise.all([
    role(escrow, taskEscrowAbi, "ARBITER_ROLE"),
    role(escrow, taskEscrowAbi, "OPERATOR_ROLE"),
    role(escrow, taskEscrowAbi, "QUOTER_ROLE"),
    role(escrow, taskEscrowAbi, "PAUSER_ROLE"),
    role(registry, agentRegistryAbi, "REGISTRAR_ROLE"),
    role(vault, stakingVaultAbi, "SLASHER_ROLE"),
  ]);
const checks: [string, Promise<boolean>][] = [
  ["escrow admin = Safe", has(escrow, ADMIN_ROLE, adminSafe)],
  ["registry admin = Safe", has(registry, ADMIN_ROLE, adminSafe)],
  ["vault admin = Safe", has(vault, ADMIN_ROLE, adminSafe)],
  ["fee distributor admin = Safe", has(distributor, ADMIN_ROLE, adminSafe)],
  ["escrow arbiter = Safe", has(escrow, arbiter, adminSafe)],
  ["escrow operator = KMS operator", has(escrow, operatorRole, operator)],
  ["escrow quoter = KMS quoter", has(escrow, quoterRole, quoter)],
  ["escrow pauser = guardian", has(escrow, pauserRole, pauser)],
  ["registrar = setup key", has(registry, registrarRole, setup)],
  ["registrar = first Safe owner", has(registry, registrarRole, owners[0] as Address)],
  ["slasher = Safe", has(vault, slasherRole, adminSafe)],
  [
    "deployer holds no admin role (escrow)",
    has(escrow, ADMIN_ROLE, deployer.address).then((v) => !v),
  ],
  [
    "deployer holds no admin role (registry)",
    has(registry, ADMIN_ROLE, deployer.address).then((v) => !v),
  ],
  [
    "deployer holds no admin role (vault)",
    has(vault, ADMIN_ROLE, deployer.address).then((v) => !v),
  ],
  [
    "deployer holds no admin role (distributor)",
    has(distributor, ADMIN_ROLE, deployer.address).then((v) => !v),
  ],
  [
    "staker share off until token launch",
    pub
      .readContract({ address: distributor, abi: feeDistributorAbi, functionName: "stakerBps" })
      .then((v) => Number(v) === 0),
  ],
];
let ok = true;
for (const [name, p] of checks) {
  const v = await p;
  ok &&= v;
  console.log(`${v ? "✓" : "✗"} ${name}`);
}
console.log(`\ndeployment: ${DEPLOYMENT_FILE}`);
for (const [k, v] of Object.entries(d)) console.log(`  ${k}: ${v}`);
if (!ok) throw new Error("role check failed — do NOT use this deployment; pause it from the Safe");
console.log(
  `\nNext: fund the operator ${operator} with a few USDC for gas (you send it), then follow docs/runbooks/deploy.md §3.`,
);
