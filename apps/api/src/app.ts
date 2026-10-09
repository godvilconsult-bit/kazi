import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import type { Redis } from "ioredis";
import type { Address, PublicClient } from "viem";
import { mockUsdcAbi } from "@kazi/shared";
import type { PrismaClient } from "@kazi/db";
import type { ChainConfig } from "@kazi/config";
import type { ApiEnv } from "./env";
import { registerErrorHandling } from "./http/errors";
import { parseCookies } from "./http/cookies";
import { RateLimiter } from "./security/rate-limit";
import { SecretBox } from "@kazi/config/secrets";
import { SiweService } from "./auth/siwe";
import { TokenService, type AuthContext } from "./auth/tokens";
import type { ObjectStorage } from "@kazi/config/storage";
import type { JobQueue } from "./jobs";
import { authRoutes, ACCESS_COOKIE } from "./routes/auth";
import { taskRoutes } from "./routes/tasks";
import { providerRoutes } from "./routes/providers";
import { fileRoutes } from "./routes/files";
import { adminRoutes } from "./routes/admin";
import { agentRoutes } from "./routes/agent";
import { publicRoutes } from "./routes/public";
import { freelancerRoutes } from "./routes/freelancer";
import { notificationRoutes } from "./routes/notifications";

declare module "fastify" {
  interface FastifyRequest {
    auth: AuthContext | null;
  }
}

export interface AppDeps {
  env: ApiEnv;
  chain: ChainConfig;
  prisma: PrismaClient;
  redis: Redis;
  storage: ObjectStorage;
  jobs: JobQueue;
  /** TaskEscrow address, when the network is deployed (needed for fund-params). */
  escrowAddress?: Address | undefined;
  /** Other deployed contracts, for the web app (registry, staking, token, fee distributor). */
  contracts?: Record<string, Address> | undefined;
  publicClient?: PublicClient | undefined;
  logger?: FastifyServerOptions["logger"];
}

export interface AppServices extends AppDeps {
  tokens: TokenService;
  siwe: SiweService;
  limiter: RateLimiter;
  secrets: SecretBox;
  adminWallets: ReadonlySet<string>;
  cookieSecure: boolean;
  /** USDC decimals read from the token once (CLAUDE.md rule 1); 6 only without an RPC (tests). */
  usdcDecimals: () => Promise<number>;
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: deps.logger ?? false,
    bodyLimit: 1024 * 1024, // JSON bodies only; files go straight to storage via signed URLs
    trustProxy: true,
  });

  const appUrl = new URL(deps.env.APP_URL);
  let decimals: Promise<number> | undefined;
  const usdcDecimals = () => {
    const client = deps.publicClient;
    if (!client) return Promise.resolve(6);
    decimals ??= client
      .readContract({ address: deps.chain.usdcAddress, abi: mockUsdcAbi, functionName: "decimals" })
      .then(Number)
      .catch((err: unknown) => {
        decimals = undefined; // retry on the next call
        throw err;
      });
    return decimals;
  };
  const services: AppServices = {
    ...deps,
    tokens: new TokenService(deps.env.JWT_SECRET, deps.prisma),
    siwe: new SiweService(deps.redis, deps.env.REDIS_KEY_PREFIX, {
      domain: appUrl.host,
      chainId: deps.chain.chainId,
      publicClient: deps.publicClient,
    }),
    limiter: new RateLimiter(deps.redis, deps.env.REDIS_KEY_PREFIX),
    secrets: new SecretBox(deps.env.ENCRYPTION_KEY),
    adminWallets: new Set(deps.env.ADMIN_WALLETS.map((w) => w.toLowerCase())),
    cookieSecure: appUrl.protocol === "https:" || deps.env.NODE_ENV === "production",
    usdcDecimals,
  };

  registerErrorHandling(app);

  // CORS: only the Kazi web app origin, with credentials (cookies). No wildcard.
  app.addHook("onRequest", async (req, reply) => {
    const origin = req.headers.origin;
    if (origin === appUrl.origin) {
      void reply
        .header("access-control-allow-origin", origin)
        .header("access-control-allow-credentials", "true")
        .header("vary", "Origin");
      if (req.method === "OPTIONS") {
        return reply
          .header("access-control-allow-methods", "GET,POST,PATCH,DELETE,OPTIONS")
          .header("access-control-allow-headers", "content-type,authorization")
          .header("access-control-max-age", "600")
          .status(204)
          .send();
      }
    }
  });

  // Auth context from the access cookie (browser) or a Bearer token (non-browser clients).
  app.decorateRequest("auth", null);
  app.addHook("onRequest", async (req) => {
    const bearer = req.headers.authorization?.startsWith("Bearer ")
      ? req.headers.authorization.slice(7)
      : undefined;
    const token = bearer ?? parseCookies(req.headers.cookie)[ACCESS_COOKIE];
    req.auth = token ? await services.tokens.verifyAccess(token) : null;
  });

  app.get("/health", async () => ({ status: "ok" }));

  await app.register(authRoutes(services));
  await app.register(taskRoutes(services));
  await app.register(providerRoutes(services));
  await app.register(fileRoutes(services));
  await app.register(adminRoutes(services));
  await app.register(agentRoutes(services));
  await app.register(publicRoutes(services));
  await app.register(freelancerRoutes(services));
  await app.register(notificationRoutes(services));

  return app;
}
