import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, inDays, login, type Harness } from "./harness";

/** Kazi-hosted agents and task speed (docs/11-HOSTED-AGENTS.md). */

let h: Harness;
let dev: Awaited<ReturnType<typeof login>>;

beforeAll(async () => {
  h = await createHarness();
  dev = await login(h);
});
afterAll(async () => {
  await h.close();
});

const hostedConfig = {
  instructions:
    "You translate business documents from English to Swahili, keeping all figures exactly.",
  model: "claude-sonnet-5-5",
  effort: "medium",
};
const hostedAgent = (over: Record<string, unknown> = {}) => ({
  kind: "AGENT",
  name: "Hosted Translator",
  description: "Translates business documents EN to SW.",
  capabilities: ["translate.en-sw"],
  languages: ["en", "sw"],
  pricing: { model: "per_unit", unit: "1000_words", price: "0.80", currency: "USDC" },
  payoutAddress: dev.account.address,
  hosting: "KAZI",
  hostedConfig,
  ...over,
});
const create = (body: unknown) =>
  h.app.inject({
    method: "POST",
    url: "/providers",
    headers: { cookie: dev.cookie },
    payload: body as object,
  });

describe("hosted agents", () => {
  it("registers a Kazi-hosted agent without endpoint or webhook secret, with defaults filled in", async () => {
    const res = await create(hostedAgent());
    expect(res.statusCode).toBe(201);
    const body = res.json<{ provider: Record<string, unknown>; webhookSecret: string | null }>();
    expect(body.webhookSecret).toBeNull();
    expect(body.provider).toMatchObject({
      hosting: "KAZI",
      endpointUrl: null,
      hostedConfig: {
        model: "claude-sonnet-5-5",
        effort: "medium",
        webSearch: null,
        maxOutputTokens: 32_000,
        samples: [],
      },
      aiCostUsd: null,
    });
  });

  it("validates hosted settings", async () => {
    expect((await create(hostedAgent({ hostedConfig: undefined }))).statusCode).toBe(400);
    expect(
      (
        await create(
          hostedAgent({
            hostedConfig: { ...hostedConfig, model: "claude-haiku-5-5", webSearch: { maxUses: 3 } },
          }),
        )
      ).statusCode,
    ).toBe(400); // web search needs Opus or Sonnet
    expect(
      (await create(hostedAgent({ hostedConfig: { ...hostedConfig, model: "gpt-5" } }))).statusCode,
    ).toBe(400);
    expect(
      (await create(hostedAgent({ hosting: "SELF", hostedConfig: undefined }))).statusCode,
    ).toBe(400); // needs endpoint
  });

  it("never exposes a hosted agent's instructions in the public directory", async () => {
    const created = (await create(hostedAgent())).json<{ provider: { id: string; slug: string } }>()
      .provider;
    await h.prisma.provider.update({ where: { id: created.id }, data: { status: "ACTIVE" } });
    const pub = await h.app.inject({ method: "GET", url: `/providers/${created.slug}` });
    expect(pub.statusCode).toBe(200);
    expect(pub.body).not.toContain("keeping all figures exactly");
    expect(pub.json<{ provider: { hosting: string } }>().provider.hosting).toBe("KAZI");
  });

  it("starts one advice run at a time, and editing settings clears the measured cost", async () => {
    const p = (await create(hostedAgent())).json<{ provider: { id: string } }>().provider;
    const advise = () =>
      h.app.inject({
        method: "POST",
        url: `/providers/${p.id}/advise`,
        headers: { cookie: dev.cookie },
      });
    const first = await advise();
    expect(first.statusCode).toBe(202);
    expect(first.json()).toMatchObject({ status: "RUNNING" });
    expect((await advise()).json()).toMatchObject({ status: "RUNNING" });
    expect(
      h.jobs.jobs.filter((j) => j.name === "advise" && j.data["providerId"] === p.id),
    ).toHaveLength(1);

    await h.prisma.provider.update({
      where: { id: p.id },
      data: {
        aiCost: {
          economyNano: "1",
          expressNano: "2",
          samples: 1,
          updatedAt: new Date().toISOString(),
        },
      },
    });
    const edited = await h.app.inject({
      method: "PATCH",
      url: `/providers/${p.id}`,
      headers: { cookie: dev.cookie },
      payload: { hostedConfig: { ...hostedConfig, model: "claude-opus-5-5" } },
    });
    expect(edited.statusCode).toBe(200);
    expect(edited.json<{ provider: Record<string, unknown> }>().provider).toMatchObject({
      aiCostUsd: null,
      hostedAdvice: null,
      hostedConfig: { model: "claude-opus-5-5" },
    });
  });
});

describe("task speed", () => {
  it("defaults to Economy, and a quote request can switch it", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/tasks",
      headers: { cookie: dev.cookie },
      payload: {
        title: "Translate",
        description: "Translate my summary into Swahili.",
        deadline: inDays(5),
      },
    });
    const task = res.json<{ task: { id: string; speed: string } }>().task;
    expect(task.speed).toBe("ECONOMY");
    const q = await h.app.inject({
      method: "POST",
      url: `/tasks/${task.id}/quote`,
      headers: { cookie: dev.cookie },
      payload: { speed: "EXPRESS" },
    });
    expect(q.statusCode).toBe(202);
    expect((await h.prisma.task.findUniqueOrThrow({ where: { id: task.id } })).speed).toBe(
      "EXPRESS",
    );
    const bad = await h.app.inject({
      method: "POST",
      url: `/tasks/${task.id}/quote`,
      headers: { cookie: dev.cookie },
      payload: { speed: "TURBO" },
    });
    expect(bad.statusCode).toBe(400);
  });
});
