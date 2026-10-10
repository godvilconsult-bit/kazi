import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pino } from "pino";
import { createPrismaClient, type PrismaClient } from "@kazi/db";
import { taskOnchainId, type Plan } from "@kazi/shared";
import { offersTick } from "../src/executor/offers";
import { closeLastPerTx } from "../src/indexer/indexer";
import { withRequiredReviews } from "../src/router/decompose";

/** Phase 5: required human review for tax drafts; freelancer due-soon reminders. */

const log = pino({ level: "silent" });
let prisma: PrismaClient;
let ownerId: string;

beforeAll(async () => {
  prisma = createPrismaClient(process.env["DATABASE_URL"]!);
  ownerId = (await prisma.user.create({ data: { wallet: `0x${randomBytes(20).toString("hex")}` } }))
    .id;
});
afterAll(async () => {
  await prisma.$disconnect();
});

const step = (
  index: number,
  capability: string,
  dependsOn: number[] = [],
): Plan["subtasks"][number] => ({
  index,
  title: `Step ${index}`,
  capability,
  instructions: "Do the work.",
  dependsOn,
  estimatedUnits: 1,
  acceptance: { rubric: ["Done"], format: "markdown" },
  needsHuman: false,
});

describe("required reviews", () => {
  it("adds a licensed human review after every Tanzanian tax draft", () => {
    const plan: Plan = {
      feasible: true,
      clarifyingQuestions: [],
      subtasks: [step(0, "finance.bookkeeping_draft"), step(1, "tax.tz_tra_draft", [0])],
    };
    const out = withRequiredReviews(plan);
    expect(out.subtasks).toHaveLength(3);
    expect(out.subtasks[2]).toMatchObject({
      index: 2,
      capability: "human.review",
      dependsOn: [1],
      needsHuman: true,
    });
  });

  it("keeps a plan that already has the review, and leaves other plans alone", () => {
    const reviewed: Plan = {
      feasible: true,
      clarifyingQuestions: [],
      subtasks: [step(0, "tax.tz_tra_draft"), step(1, "human.review", [0])],
    };
    expect(withRequiredReviews(reviewed)).toBe(reviewed);
    const plain: Plan = {
      feasible: true,
      clarifyingQuestions: [],
      subtasks: [step(0, "write.business_plan")],
    };
    expect(withRequiredReviews(plain)).toBe(plain);
  });
});

describe("freelancer reminders", () => {
  it("reminds the freelancer once per attempt when the step is due soon", async () => {
    const freelancer = await prisma.user.create({
      data: { wallet: `0x${randomBytes(20).toString("hex")}` },
    });
    const provider = await prisma.provider.create({
      data: {
        ownerId: freelancer.id,
        kind: "HUMAN",
        name: "Reviewer",
        slug: `h-${randomUUID()}`,
        description: "Licensed reviewer",
        capabilities: ["human.review"],
        pricing: { model: "fixed", price: "5.00", currency: "USDC" },
        payoutAddress: "0x000000000000000000000000000000000000dead",
        status: "ACTIVE",
      },
    });
    const id = randomUUID();
    const task = await prisma.task.create({
      data: {
        id,
        onchainId: taskOnchainId(id),
        clientId: ownerId,
        title: "Tax",
        description: "VAT",
        deadline: new Date(Date.now() + 86_400_000),
        status: "IN_PROGRESS",
      },
    });
    const st = await prisma.subtask.create({
      data: {
        taskId: task.id,
        index: 0,
        title: "Review the VAT draft",
        instructions: "Review",
        capability: "human.review",
        dependsOn: [],
        acceptance: {},
        providerId: provider.id,
        amount: "5000000",
        status: "DISPATCHED",
        attempts: 1,
        timeoutAt: new Date(Date.now() + 3_600_000), // 1 h left
      },
    });
    await prisma.offer.create({
      data: {
        subtaskId: st.id,
        attempt: 1,
        providerId: provider.id,
        status: "ACCEPTED",
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });

    await offersTick({ prisma, log });
    await offersTick({ prisma, log });
    const reminders = await prisma.notification.findMany({
      where: { userId: freelancer.id, type: "DUE_SOON" },
    });
    expect(reminders).toHaveLength(1);
    expect(reminders[0]!.link).toBe(`/freelancer/subtasks/${st.id}`);
  });
});

describe("indexer ordering", () => {
  it("applies TaskClosed after the other events of its transaction", () => {
    const ev = (txHash: string, name: string) => ({ txHash, name });
    const batch = [
      ev("0x1", "MilestoneReleased"),
      ev("0x2", "TaskClosed"),
      ev("0x2", "MilestoneReleased"),
      ev("0x3", "TaskFunded"),
    ];
    expect(closeLastPerTx(batch, false).map((e) => `${e.txHash}:${e.name}`)).toEqual([
      "0x1:MilestoneReleased",
      "0x2:MilestoneReleased",
      "0x2:TaskClosed",
      "0x3:TaskFunded",
    ]);
    // A full batch never splits its last transaction: it waits for the next batch.
    expect(closeLastPerTx(batch, true).map((e) => e.txHash)).toEqual(["0x1", "0x2", "0x2"]);
    expect(closeLastPerTx([ev("0x9", "TaskClosed")], true)).toHaveLength(1);
  });
});
