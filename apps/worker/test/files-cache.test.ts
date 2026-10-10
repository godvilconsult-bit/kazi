import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pino } from "pino";
import { MemoryStorage } from "@kazi/config/storage";
import { createPrismaClient, type PrismaClient } from "@kazi/db";
import {
  FileImportError,
  attachmentSummaries,
  importAgentFiles,
  isPrivateAddress,
  resolveFileRefs,
  safeFetch,
} from "../src/files/files";
import { MockLlm } from "../src/llm";
import { MemoryPlanCache, planCacheKey } from "../src/router/cache";

/** Phase 3 completion: attachments, agent output files, SSRF guard, plan cache. */

const log = pino({ level: "silent" });
let prisma: PrismaClient;
let ownerId: string;

const TABLES = [
  "HostedRun",
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
];

beforeAll(async () => {
  prisma = createPrismaClient(process.env["DATABASE_URL"]!);
  await prisma.$executeRawUnsafe(
    `TRUNCATE ${TABLES.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`,
  );
  const u = await prisma.user.create({
    data: {
      wallet: `0x${createHash("sha256").update(String(Date.now())).digest("hex").slice(0, 40)}`,
    },
  });
  ownerId = u.id;
});
afterAll(async () => {
  await prisma.$disconnect();
});

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const bytes = (s: string) => new TextEncoder().encode(s);

describe("SSRF guard", () => {
  it("flags private, loopback, link-local and reserved addresses", () => {
    for (const ip of [
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.1",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "::1",
      "fd00::1",
      "fe80::1",
      "::ffff:10.0.0.1",
    ]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ["8.8.8.8", "41.59.1.1", "2606:4700::1111"])
      expect(isPrivateAddress(ip), ip).toBe(false);
  });

  it("refuses http, private hosts and oversized bodies", async () => {
    await expect(safeFetch("http://example.com/a.pdf", 10)).rejects.toThrow(/https/);
    await expect(safeFetch("https://127.0.0.1/a.pdf", 10)).rejects.toThrow(/not public/);
    await expect(safeFetch("https://169.254.169.254/latest/meta-data", 10)).rejects.toThrow(
      /not public/,
    );
    const big = async () => new Response(new Uint8Array(100));
    await expect(
      safeFetch("http://agent.test/x", 10, { fetch: big as typeof fetch, allowInsecure: true }),
    ).rejects.toThrow(/too large/);
  });
});

describe("agent output files", () => {
  it("copies returned files into Kazi's bucket after checking the hash; kazi:// refs resolve to signed URLs", async () => {
    const storage = new MemoryStorage();
    const body = bytes("# Report\n\nAll figures checked.");
    const fakeFetch = async () => new Response(body);
    const refs = await importAgentFiles(
      { prisma, storage, fetch: fakeFetch as typeof fetch, allowInsecure: true },
      { taskId: `t-${Date.now()}`, clientId: ownerId, subtaskId: "s1", attempt: 1 },
      [{ url: "http://agent.test/report.md", sha256: sha(body), mime: "text/markdown" }],
    );
    expect(refs).toHaveLength(1);
    expect(refs[0]!.url).toMatch(/^kazi:\/\/files\//);
    const id = refs[0]!.url.split("/").pop()!;
    const row = await prisma.fileObject.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({
      ownerId,
      source: "agent",
      sha256: sha(body),
      status: "UPLOADED",
      size: body.byteLength,
    });
    expect(storage.objects.get(row.key)?.body).toEqual(body);

    const signed = await resolveFileRefs({ prisma, storage }, refs, 60);
    expect(signed[0]!.url).toMatch(/^memory:\/\/download\//);
    expect(signed[0]!.sha256).toBe(sha(body));
  });

  it("passes through the client's own kazi:// files but rejects another user's file id", async () => {
    const other = await prisma.user.create({
      data: { wallet: `0x${Date.now().toString(16).padStart(40, "e")}` },
    });
    const mine = await prisma.fileObject.create({
      data: {
        ownerId,
        key: `mine-${Date.now()}`,
        filename: "a.txt",
        mime: "text/plain",
        size: 1,
        status: "UPLOADED",
      },
    });
    const theirs = await prisma.fileObject.create({
      data: {
        ownerId: other.id,
        key: `theirs-${Date.now()}`,
        filename: "b.txt",
        mime: "text/plain",
        size: 1,
        status: "UPLOADED",
      },
    });
    const deps = { prisma, storage: new MemoryStorage() };
    const ctx = { taskId: "t3", clientId: ownerId, subtaskId: "s3", attempt: 1 };
    const ok = await importAgentFiles(deps, ctx, [
      { url: `kazi://files/${mine.id}`, sha256: "a".repeat(64), mime: "text/plain" },
    ]);
    expect(ok).toHaveLength(1);
    await expect(
      importAgentFiles(deps, ctx, [
        { url: `kazi://files/${theirs.id}`, sha256: "a".repeat(64), mime: "text/plain" },
      ]),
    ).rejects.toThrow(/unknown file reference/);
  });

  it("rejects a file whose content doesn't match the declared hash", async () => {
    const fakeFetch = async () => new Response(bytes("tampered"));
    await expect(
      importAgentFiles(
        {
          prisma,
          storage: new MemoryStorage(),
          fetch: fakeFetch as typeof fetch,
          allowInsecure: true,
        },
        { taskId: "t1", clientId: ownerId, subtaskId: "s2", attempt: 1 },
        [{ url: "http://agent.test/x", sha256: "a".repeat(64), mime: "text/plain" }],
      ),
    ).rejects.toThrow(FileImportError);
  });
});

describe("attachment summaries for the router", () => {
  it("inlines short text, summarizes long text once and reuses the stored summary", async () => {
    const storage = new MemoryStorage();
    const short = bytes("Executive summary: 340 installations, 12 technicians.");
    const long = bytes("Section. ".repeat(2_000));
    storage.put("a/short.txt", short.byteLength, "text/plain", short);
    storage.put("a/long.txt", long.byteLength, "text/plain", long);
    const mk = (key: string, filename: string, size: number) =>
      prisma.fileObject.create({
        data: {
          ownerId,
          key: `${key}-${Date.now()}`,
          filename,
          mime: "text/plain",
          size,
          status: "UPLOADED",
        },
      });
    const f1 = await mk("a/short.txt", "short.txt", short.byteLength);
    const f2 = await mk("a/long.txt", "long.txt", long.byteLength);
    storage.put(f1.key, short.byteLength, "text/plain", short);
    storage.put(f2.key, long.byteLength, "text/plain", long);
    const task = await prisma.task.create({
      data: {
        id: `t-${Date.now()}`,
        onchainId: `0x${"1".repeat(63)}${Date.now() % 10}`,
        clientId: ownerId,
        title: "T",
        description: "D",
        deadline: new Date(Date.now() + 86_400_000),
      },
    });

    const llm = new MockLlm().on("summarize", () => "A long document of repeated sections.");
    const deps = { prisma, storage, llm, fastModel: "mock", log };
    const out = await attachmentSummaries(deps, ownerId, [f1.id, f2.id], task.id);
    const byName = Object.fromEntries(out.map((a) => [a.filename, a.summary]));
    expect(byName["short.txt"]).toContain("340 installations");
    expect(byName["long.txt"]).toBe("A long document of repeated sections.");
    expect(llm.calls).toHaveLength(1);

    await attachmentSummaries(deps, ownerId, [f1.id, f2.id], task.id);
    expect(llm.calls).toHaveLength(1); // stored summaries reused
    expect(
      Number((await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).llmCostUsd),
    ).toBeGreaterThan(0);
  });
});

describe("plan cache", () => {
  const base = {
    title: "Translate",
    description: "Translate my summary",
    attachments: [],
    budget: "5.00 USDC",
    deadline: new Date("2026-10-12T10:00:00Z"),
    capabilities: ["translate.en-sw", "write.blog_post"],
  };
  it("keys on everything that shapes the plan, ignoring capability order and time of day", async () => {
    const k = planCacheKey(base);
    expect(planCacheKey({ ...base, capabilities: [...base.capabilities].reverse() })).toBe(k);
    expect(planCacheKey({ ...base, deadline: new Date("2026-10-12T22:00:00Z") })).toBe(k);
    expect(planCacheKey({ ...base, description: "Translate my summary!" })).not.toBe(k);
    expect(planCacheKey({ ...base, budget: "6.00 USDC" })).not.toBe(k);
    const cache = new MemoryPlanCache();
    const plan = { feasible: false, infeasibleReason: "x", clarifyingQuestions: [], subtasks: [] };
    await cache.set(k, plan);
    expect(await cache.get(k)).toEqual(plan);
  });
});

describe("onchain setup of Kazi's own providers", () => {
  it(
    "registers, bonds and activates the service-fee provider once (idempotent)",
    { timeout: 300_000 },
    async () => {
      const { startLocalChain, KEYS } = await import("./anvil");
      const { registerKaziProviders } = await import("../src/setup/providers");
      const { foundry } = await import("viem/chains");
      const { SERVICE_FEE_PROVIDER, agentRegistryAbi } = await import("@kazi/shared");
      const chain = await startLocalChain();
      try {
        const slug = SERVICE_FEE_PROVIDER.slug;
        await prisma.provider.deleteMany({ where: { slug } });
        await prisma.provider.create({
          data: {
            ownerId,
            kind: "AGENT",
            name: SERVICE_FEE_PROVIDER.name,
            slug,
            description: SERVICE_FEE_PROVIDER.description,
            pricing: { ...SERVICE_FEE_PROVIDER.pricing },
            payoutAddress: "0x000000000000000000000000000000000000dEaD".toLowerCase(),
            isHouse: true,
          },
        });
        const opts = {
          prisma,
          publicClient: chain.publicClient,
          chain: foundry,
          rpcUrl: chain.rpcUrl,
          deployment: chain.deployment,
          setupKey: KEYS.admin,
          log,
        };
        const first = await registerKaziProviders(opts);
        const service = first.find((r) => r.slug === slug)!;
        expect(service.status).toBe("registered");
        const status = await chain.publicClient.readContract({
          address: chain.deployment.agentRegistry,
          abi: agentRegistryAbi,
          functionName: "statusOf",
          args: [service.onchainId],
        });
        expect(status).toBe(2); // ProviderStatus.ACTIVE (NONE, PENDING, ACTIVE, …)
        const row = await prisma.provider.findUniqueOrThrow({ where: { slug } });
        expect(row.onchainId).toBe(service.onchainId);
        expect(row.status).toBe("ACTIVE");
        const again = await registerKaziProviders(opts);
        expect(again.find((r) => r.slug === slug)?.status).toBe("already");
      } finally {
        chain.stop();
      }
    },
  );
});
