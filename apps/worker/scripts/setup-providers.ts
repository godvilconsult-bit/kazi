/**
 * Register + bond + activate Kazi's own providers (service fee, house agents) on the configured
 * network and store their onchain ids. Run after `pnpm db:seed`:
 *   SETUP_PRIVATE_KEY=0x… pnpm -F @kazi/worker setup-providers
 * The key needs REGISTRAR_ROLE on AgentRegistry and enough $KAZI for one minimum bond per provider.
 * It is read from the environment and never logged.
 */
import { pino } from "pino";
import { createPublicClient, defineChain, http, type Hex } from "viem";
import { z } from "zod";
import {
  chainEnvSchema,
  dbEnvSchema,
  getChainConfig,
  loadEnv,
  runtimeEnvSchema,
} from "@kazi/config";
import { loadDeployment } from "@kazi/config/deployments";
import { createPrismaClient } from "@kazi/db";
import { registerKaziProviders } from "../src/setup/providers";

const env = loadEnv(
  runtimeEnvSchema
    .extend(dbEnvSchema.shape)
    .extend(chainEnvSchema.shape)
    .extend({ SETUP_PRIVATE_KEY: z.string().regex(/^0x[0-9a-fA-F]{64}$/) }),
);
const log = pino({ level: "info" });
const deployment = loadDeployment(env.KAZI_NETWORK, process.env["DEPLOYMENTS_DIR"] || undefined);
const chain = getChainConfig(env.KAZI_NETWORK, {
  rpcUrl: env.ARC_RPC_URL,
  usdcAddress: env.USDC_ADDRESS ?? deployment.usdc,
  expectedChainId: env.ARC_CHAIN_ID,
  confirmations: env.CONFIRMATIONS,
});
const viemChain = defineChain({
  id: chain.chainId,
  name: chain.name,
  nativeCurrency: chain.nativeCurrency,
  rpcUrls: { default: { http: [chain.rpcUrl] } },
});
const prisma = createPrismaClient(env.DATABASE_URL);
try {
  const results = await registerKaziProviders({
    prisma,
    publicClient: createPublicClient({ chain: viemChain, transport: http(chain.rpcUrl) }),
    chain: viemChain,
    rpcUrl: chain.rpcUrl,
    deployment,
    setupKey: env.SETUP_PRIVATE_KEY as Hex,
    minMaxFeePerGasWei: chain.minMaxFeePerGasWei,
    log,
  });
  for (const r of results) console.log(`${r.slug}: onchain id ${r.onchainId} (${r.status})`);
} finally {
  await prisma.$disconnect();
}
