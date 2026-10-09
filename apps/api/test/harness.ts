import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { Redis } from "ioredis";
import { privateKeyToAccount, generatePrivateKey, type PrivateKeyAccount } from "viem/accounts";
import { createSiweMessage } from "viem/siwe";
import { getChainConfig } from "@kazi/config";
import { createPrismaClient, type PrismaClient } from "@kazi/db";
import { buildApp } from "../src/app";
import { loadApiEnv, type ApiEnv } from "../src/env";
import { MemoryJobQueue } from "../src/jobs";
import { MemoryStorage } from "@kazi/config/storage";

export const ADMIN_KEY =
  "0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6" as const; // anvil #9

export interface Harness {
  app: FastifyInstance;
  prisma: PrismaClient;
  redis: Redis;
  storage: MemoryStorage;
  jobs: MemoryJobQueue;
  env: ApiEnv;
  close: () => Promise<void>;
}

const TABLES = [
  "Submission",
  "Subtask",
  "Dispute",
  "TaskEvent",
  "Task",
  "FreelancerProfile",
  "Provider",
  "RefreshToken",
  "FileObject",
  "User",
  "Capability",
  "ChainEvent",
  "IndexerCursor",
  "IdempotencyKey",
  "Offer",
  "Notification",
];

export async function createHarness(): Promise<Harness> {
  const env = loadApiEnv();
  const prisma = createPrismaClient(env.DATABASE_URL);
  await prisma.$executeRawUnsafe(
    `TRUNCATE ${TABLES.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`,
  );
  await prisma.capability.createMany({
    data: [
      { slug: "translate.en-sw", description: "Translation en → sw" },
      { slug: "write.business_plan", description: "Business plan" },
      { slug: "human.review", description: "Human review" },
    ],
  });
  const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 3 });
  const storage = new MemoryStorage();
  const jobs = new MemoryJobQueue();
  const app = await buildApp({
    env,
    chain: getChainConfig("local", { usdcAddress: env.USDC_ADDRESS }),
    prisma,
    redis,
    storage,
    jobs,
    escrowAddress: "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0",
    contracts: {
      agentRegistry: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
      stakingVault: "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512",
    },
  });
  await app.ready();

  return {
    app,
    prisma,
    redis,
    storage,
    jobs,
    env,
    close: async () => {
      await app.close();
      let cursor = "0";
      do {
        const [next, keys] = await redis.scan(
          cursor,
          "MATCH",
          `${env.REDIS_KEY_PREFIX}:*`,
          "COUNT",
          500,
        );
        cursor = next;
        if (keys.length > 0) await redis.del(...keys);
      } while (cursor !== "0");
      redis.disconnect();
      await prisma.$disconnect();
    },
  };
}

export function newAccount(): PrivateKeyAccount {
  return privateKeyToAccount(generatePrivateKey());
}

export async function siweMessage(
  h: Harness,
  account: PrivateKeyAccount,
  overrides: { domain?: string; chainId?: number; issuedAt?: Date } = {},
) {
  const res = await h.app.inject({ method: "GET", url: "/auth/nonce" });
  const { nonce } = res.json<{ nonce: string }>();
  return createSiweMessage({
    address: account.address,
    chainId: overrides.chainId ?? 31337,
    domain: overrides.domain ?? "localhost:3000",
    nonce,
    uri: "http://localhost:3000",
    version: "1",
    issuedAt: overrides.issuedAt ?? new Date(),
    statement: "Sign in to Kazi",
  });
}

/** Full SIWE login; returns the Cookie header for subsequent requests. */
export async function login(h: Harness, account: PrivateKeyAccount = newAccount()) {
  const message = await siweMessage(h, account);
  const signature = await account.signMessage({ message });
  const res = await h.app.inject({
    method: "POST",
    url: "/auth/verify",
    payload: { message, signature },
  });
  if (res.statusCode !== 200) throw new Error(`login failed: ${res.body}`);
  return {
    account,
    cookie: cookieHeader(res),
    refresh: cookieValue(res, "kazi_refresh"),
    user: res.json<{ user: { id: string } }>().user,
  };
}

export function cookieHeader(res: LightMyRequestResponse): string {
  return res.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}

export function cookieValue(res: LightMyRequestResponse, name: string): string {
  const c = res.cookies.find((x) => x.name === name);
  if (!c) throw new Error(`cookie ${name} not set`);
  return c.value;
}

export function inDays(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}
