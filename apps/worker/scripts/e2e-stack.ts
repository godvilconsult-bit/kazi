/**
 * Isolated local stack for the browser end-to-end test (apps/web/e2e, docs/07-FRONTEND.md §6):
 * a fresh anvil chain with all contracts, the `kazi_test_e2e` database, its own Redis prefix and
 * ports, the scripted mock LLM (KAZI_LLM_MOCK=e2e), house agents, API, worker and web app.
 * Started by Playwright's webServer; stops everything on SIGINT/SIGTERM.
 *
 *   pnpm -F @kazi/worker e2e:stack      (then http://localhost:3100)
 *
 * Uses only anvil's public dev keys. Never point it at a real network.
 */
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseEnv } from "node:util";
import { randomBytes } from "node:crypto";
import { pino } from "pino";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { SecretBox, deriveHouseAgentSecret } from "@kazi/config/secrets";
import { createPrismaClient } from "@kazi/db";
import { CAPABILITY_DEFINITIONS, HOUSE_AGENT_LISTINGS, SERVICE_FEE_PROVIDER, kaziTokenAbi, mockUsdcAbi } from "@kazi/shared";
import { planAirdrop } from "../src/points/airdrop";
import { registerKaziProviders } from "../src/setup/providers";
import { KEYS, sendTx, startLocalChain } from "../test/anvil";

const PORTS = { api: 4001, web: 3100, house: 4101 } as const;
/** LOAD_TEST=1: the same stack for scripts/load-test.ts — no web app; the load driver sets X-Forwarded-For per simulated client. */
const LOAD = process.env["LOAD_TEST"] === "1";
const AIRDROP_ID = "e2e-1";
const KAZI = 10n ** 18n;
const root = resolve(import.meta.dirname, "../../..");
const log = pino({ level: "info" });
const children: ChildProcess[] = [];

function forgeBin(): string {
  const local = join(homedir(), ".foundry", "bin", process.platform === "win32" ? "forge.exe" : "forge");
  return process.env["FORGE_BIN"] ?? (existsSync(local) ? local : "forge");
}

function stopAll(code = 0): never {
  for (const c of children) {
    if (c.pid === undefined || c.exitCode !== null) continue;
    if (process.platform === "win32") {
      try {
        execFileSync("taskkill", ["/pid", String(c.pid), "/T", "/F"], { stdio: "ignore" });
      } catch {
        // already gone
      }
    } else c.kill("SIGTERM");
  }
  process.exit(code);
}

// ── Environment ──────────────────────────────────────────────────────────────
const dotenv = parseEnv(readFileSync(resolve(root, ".env"), "utf8")) as Record<string, string>;
const dbUrl = new URL(dotenv["DATABASE_URL"] ?? "");
dbUrl.pathname = "/kazi_test_e2e";
const tmp = resolve(root, "..", ".tmp");
const deploymentsDir = resolve(tmp, "e2e-deployments");
mkdirSync(deploymentsDir, { recursive: true });

const chain = await startLocalChain();
process.on("SIGINT", () => {
  chain.stop();
  stopAll();
});
process.on("SIGTERM", () => {
  chain.stop();
  stopAll();
});
writeFileSync(resolve(deploymentsDir, "local.json"), JSON.stringify(chain.deployment, null, 2));

const admin = privateKeyToAccount(KEYS.admin).address; // holds $KAZI and the registrar role
const client = privateKeyToAccount(KEYS.client).address; // the browser's mock wallet
const treasury = "0x976EA74026E726554dB657fA54763abd0C3a0aa9"; // anvil #6 (address only)
const houseSecret = dotenv["HOUSE_AGENTS_SECRET"] ?? "e2e-house-agents-master-secret-0123456789";
const encryptionKey = dotenv["ENCRYPTION_KEY"] ?? "";

const common: Record<string, string> = {
  ...dotenv,
  NODE_ENV: "development",
  TMP: tmp,
  TEMP: tmp,
  KAZI_NETWORK: "local",
  ARC_CHAIN_ID: String(foundry.id),
  ARC_RPC_URL: chain.rpcUrl,
  PUBLIC_RPC_URL: chain.rpcUrl,
  USDC_ADDRESS: chain.deployment.usdc,
  CONFIRMATIONS: "1",
  DATABASE_URL: dbUrl.toString(),
  REDIS_KEY_PREFIX: `kazi-e2e-${randomBytes(3).toString("hex")}`,
  APP_URL: `http://localhost:${PORTS.web}`,
  API_URL: `http://localhost:${PORTS.api}`,
  API_PORT: String(PORTS.api),
  DEPLOYMENTS_DIR: deploymentsDir,
  KAZI_LLM_MOCK: "e2e",
  ANTHROPIC_API_KEY: "sk-ant-e2e-mock-not-a-real-key",
  OPERATOR_PRIVATE_KEY: KEYS.operator,
  QUOTER_PRIVATE_KEY: KEYS.quoter,
  ADMIN_WALLETS: admin,
  TREASURY_ADDRESS: treasury,
  HOUSE_AGENTS_SECRET: houseSecret,
  HOUSE_AGENTS_PORT: String(PORTS.house),
  HOUSE_AGENTS_BASE_URL: `http://127.0.0.1:${PORTS.house}`,
  EXECUTOR_TICK_MS: "1000",
  INDEXER_POLL_MS: "500",
  AIRDROP_ID,
  ...(LOAD ? { TRUST_PROXY: "true", QUOTE_DAILY_LIMIT: "1000", LOG_LEVEL: "warn" } : {}),
};

// ── Database: clean slate + the providers this flow needs ────────────────────
const prisma = createPrismaClient(common["DATABASE_URL"] ?? "");
const tables = await prisma.$queryRaw<{ tablename: string }[]>`select tablename from pg_tables where schemaname = 'public' and tablename <> '_prisma_migrations'`;
await prisma.$executeRawUnsafe(`TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(", ")} RESTART IDENTITY CASCADE`);
for (const c of CAPABILITY_DEFINITIONS) {
  await prisma.capability.create({ data: { slug: c.slug, description: c.description } });
}
const owner = await prisma.user.create({ data: { wallet: admin.toLowerCase(), roles: ["CLIENT", "PROVIDER_OWNER", "ADMIN"] } });
const box = new SecretBox(encryptionKey);
// Only the provider the scripted plan uses (fewer onchain registrations, faster start).
for (const a of HOUSE_AGENT_LISTINGS.filter((l) => l.slug === "house-business-plan-writer")) {
  await prisma.provider.create({
    data: {
      slug: a.slug,
      ownerId: owner.id,
      kind: "AGENT",
      name: a.name,
      description: a.description,
      capabilities: [...a.capabilities],
      languages: [...a.languages],
      endpointUrl: `http://127.0.0.1:${PORTS.house}/${a.slug}/run`,
      pricing: { ...a.pricing },
      payoutAddress: admin.toLowerCase(),
      status: "PENDING",
      isHouse: true,
      webhookSecretEnc: box.encrypt(deriveHouseAgentSecret(houseSecret, a.slug)),
    },
  });
}
await prisma.provider.create({
  data: {
    slug: SERVICE_FEE_PROVIDER.slug,
    ownerId: owner.id,
    kind: "AGENT",
    name: SERVICE_FEE_PROVIDER.name,
    description: SERVICE_FEE_PROVIDER.description,
    capabilities: [],
    languages: [],
    pricing: { ...SERVICE_FEE_PROVIDER.pricing },
    payoutAddress: treasury.toLowerCase(),
    status: "PENDING",
    isHouse: true,
  },
});
await registerKaziProviders({
  prisma,
  publicClient: chain.publicClient,
  chain: foundry,
  rpcUrl: chain.rpcUrl,
  deployment: chain.deployment,
  setupKey: KEYS.admin,
  log,
});
// ── $KAZI launch (Phase 6): the real DeployTokenLaunch script, an airdrop for the mock wallet ──
const airdropPlan = planAirdrop({
  holders: [],
  total: 4_000n * KAZI,
  fixed: [
    { wallet: client, amount: 1_000n * KAZI },
    { wallet: "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65", amount: 3_000n * KAZI }, // anvil #4
  ],
});
// forge may only write under packages/config/deployments (foundry.toml fs_permissions).
const launchOut = resolve(root, "packages/config/deployments/e2e/local-token-launch.json");
mkdirSync(dirname(launchOut), { recursive: true });
execFileSync(forgeBin(), ["script", "script/DeployTokenLaunch.s.sol", "--rpc-url", chain.rpcUrl, "--broadcast", "--private-key", KEYS.admin], {
  cwd: resolve(root, "packages/contracts"),
  stdio: ["ignore", "ignore", "inherit"],
  env: {
    ...process.env,
    KAZI_NETWORK: "local",
    KAZI_TOKEN: chain.deployment.kaziToken,
    ADMIN_SAFE: admin,
    TEAM_BENEFICIARY: "0x23618e81E3f5cdF7f54C3d65f7FBc0aBf5B21E8f", // anvil #8
    ECOSYSTEM_BENEFICIARY: "0xa0Ee7A142d267C1f36714E4a8F75612F20a79720", // anvil #9
    TREASURY_ADDRESS: treasury,
    LIQUIDITY_ADDRESS: admin, // admin keeps liquidity + community: it funds the staking test below
    COMMUNITY_ADDRESS: admin,
    AIRDROP_MERKLE_ROOT: airdropPlan.root,
    TOKEN_LAUNCH_OUT: launchOut,
  },
});
copyFileSync(launchOut, resolve(deploymentsDir, "local-token-launch.json"));
await prisma.airdropAllocation.createMany({
  data: airdropPlan.allocations.map((a) => ({ airdropId: AIRDROP_ID, wallet: a.wallet.toLowerCase(), amount: a.amount.toString(), proof: a.proof })),
});
await sendTx(chain, KEYS.admin, chain.deployment.kaziToken, kaziTokenAbi, "transfer", [client, 10_000n * KAZI]);
await prisma.$disconnect();

// The test client gets 1,000 test USDC.
const usdcDecimals = Number(await chain.publicClient.readContract({ address: chain.deployment.usdc, abi: mockUsdcAbi, functionName: "decimals" }));
const minted = await chain.wallet(KEYS.admin).writeContract({
  address: chain.deployment.usdc,
  abi: mockUsdcAbi,
  functionName: "mint",
  args: [client, 1_000n * 10n ** BigInt(usdcDecimals)],
  account: privateKeyToAccount(KEYS.admin),
  chain: foundry,
});
await chain.publicClient.waitForTransactionReceipt({ hash: minted });

// ── Processes ────────────────────────────────────────────────────────────────
function start(name: string, args: string[], extra: Record<string, string> = {}) {
  const child = spawn("pnpm", args, { cwd: root, env: { ...process.env, ...common, ...extra }, stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32" });
  const tag = (line: string) => line.trim() && process.stdout.write(`[${name}] ${line}\n`);
  child.stdout?.on("data", (d: Buffer) => d.toString().split("\n").forEach(tag));
  child.stderr?.on("data", (d: Buffer) => d.toString().split("\n").forEach(tag));
  child.on("exit", (code) => log.warn({ name, code }, "process exited"));
  children.push(child);
}

async function waitFor(url: string, label: string, timeoutMs = 300_000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
      if (res.status < 500) return;
    } catch {
      // not up yet
    }
    if (Date.now() > until) throw new Error(`${label} did not start (${url})`);
    await new Promise((r) => setTimeout(r, 1_000));
  }
}

start("house", ["--filter", "@kazi/house-agents", "start"]);
start("api", ["--filter", "@kazi/api", "start"]);
start("worker", ["--filter", "@kazi/worker", "start"]);
if (!LOAD) start("web", ["--filter", "@kazi/web", "exec", "next", "dev", "--port", String(PORTS.web)], {
  NEXT_PUBLIC_API_URL: `http://localhost:${PORTS.api}`,
  NEXT_PUBLIC_E2E_WALLET: client,
  NEXT_DIST_DIR: ".next-e2e",
  // Geo hooks: the spec sends cf-ipcountry: US to see the restricted staking page.
  GEO_RESTRICTED_COUNTRIES: "US",
  GEO_COUNTRY_HEADER: "cf-ipcountry",
});
try {
  await waitFor(`http://127.0.0.1:${PORTS.house}/health`, "house agents");
  await waitFor(`http://localhost:${PORTS.api}/health`, "api");
  if (!LOAD) await waitFor(`http://localhost:${PORTS.web}/`, "web", 600_000);
} catch (err) {
  log.error({ err }, "e2e stack failed to start");
  chain.stop();
  stopAll(1);
}
// The load driver reads where everything runs from here.
writeFileSync(
  resolve(deploymentsDir, "stack.json"),
  JSON.stringify({ api: `http://localhost:${PORTS.api}`, web: `http://localhost:${PORTS.web}`, rpcUrl: chain.rpcUrl, usdc: chain.deployment.usdc, escrow: chain.deployment.taskEscrow }, null, 2),
);
log.info({ web: `http://localhost:${PORTS.web}`, client, rpc: chain.rpcUrl }, "e2e stack ready");
