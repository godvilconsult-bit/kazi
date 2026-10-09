import { Redis } from "ioredis";
import { createPublicClient, http } from "viem";
import { getChainConfig } from "@kazi/config";
import { DeploymentNotFoundError, loadDeployment } from "@kazi/config/deployments";
import { createPrismaClient } from "@kazi/db";
import { buildApp } from "./app";
import { bullmqJobQueue } from "./jobs";
import { loadApiEnv } from "./env";
import { SupabaseStorage } from "@kazi/config/storage";

const env = loadApiEnv(); // fails fast with a list of every missing/invalid variable

/** Deployed addresses, if this network has been deployed (local: `pnpm -F contracts deploy:local`). */
function loadDeployed() {
  try {
    return loadDeployment(env.KAZI_NETWORK);
  } catch (err) {
    if (err instanceof DeploymentNotFoundError) return undefined;
    throw err;
  }
}
const deployment = loadDeployed();

const chain = getChainConfig(env.KAZI_NETWORK, {
  rpcUrl: env.ARC_RPC_URL,
  usdcAddress: env.USDC_ADDRESS ?? deployment?.usdc,
  expectedChainId: env.ARC_CHAIN_ID,
  confirmations: env.CONFIRMATIONS,
});

const prisma = createPrismaClient(env.DATABASE_URL);
const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 3 });
// BullMQ needs its own connection with maxRetriesPerRequest disabled.
const jobs = bullmqJobQueue(
  new Redis(env.REDIS_URL, { maxRetriesPerRequest: null }),
  env.REDIS_KEY_PREFIX,
);
const app = await buildApp({
  env,
  chain,
  prisma,
  redis,
  jobs,
  escrowAddress: deployment?.taskEscrow,
  contracts: deployment
    ? {
        agentRegistry: deployment.agentRegistry,
        stakingVault: deployment.stakingVault,
        kaziToken: deployment.kaziToken,
        feeDistributor: deployment.feeDistributor,
      }
    : undefined,
  storage: new SupabaseStorage(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, env.STORAGE_BUCKET),
  publicClient: createPublicClient({ transport: http(chain.rpcUrl) }),
  logger:
    env.NODE_ENV === "development"
      ? {
          transport: { target: "pino-pretty" },
          redact: ["req.headers.cookie", "req.headers.authorization"],
        }
      : { redact: ["req.headers.cookie", "req.headers.authorization"] },
});

const shutdown = async () => {
  await app.close();
  await jobs.close();
  await prisma.$disconnect();
  redis.disconnect();
};
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

await app.listen({ host: env.API_HOST, port: env.API_PORT });
