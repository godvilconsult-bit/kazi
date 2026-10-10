import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decodeFunctionData, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { feeDistributorAbi, taskOnchainId } from "@kazi/shared";
import { ADMIN_KEY, createHarness, login, newAccount, type Harness } from "./harness";

/** Phase 6: $KAZI pages — token metrics without a chain, points, airdrop proofs, fee-split calldata. */

const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const LAUNCH = {
  network: "local",
  tge: 1_800_000_000,
  total: "1000000000000000000000000000",
  teamVesting: addr(0x101),
  ecosystemVesting: addr(0x102),
  airdrop: addr(0x103),
  treasury: addr(0x104),
  liquidity: addr(0x105),
  community: addr(0x106),
};
const FEE_DISTRIBUTOR = addr(0x107);

let h: Harness;
beforeAll(async () => {
  h = await createHarness({
    tokenLaunch: LAUNCH,
    airdropId: "early-1",
    contracts: {
      agentRegistry: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
      stakingVault: "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512",
      feeDistributor: FEE_DISTRIBUTOR,
    },
  });
});
afterAll(async () => {
  await h.close();
});

describe("token", () => {
  it("reports 'not deployed' instead of failing when there is no chain", async () => {
    expect((await h.app.inject({ method: "GET", url: "/token/metrics" })).json()).toEqual({ deployed: false, launched: false });
    expect((await h.app.inject({ method: "GET", url: "/token/staking" })).json()).toEqual({ deployed: false });
  });

  it("publishes the airdrop contract in /config once the token has launched", async () => {
    const config = (await h.app.inject({ method: "GET", url: "/config" })).json<{ contracts: Record<string, string> }>();
    expect(config.contracts["airdrop"]).toBe(LAUNCH.airdrop);
  });
});

describe("points", () => {
  it("shows your own history with flags, and a public leaderboard without full wallets", async () => {
    const me = await login(h);
    const other = await login(h);
    const nobody = await login(h);
    const id = randomUUID();
    await h.prisma.task.create({
      data: { id, onchainId: taskOnchainId(id), clientId: me.user.id, title: "Swahili menu", description: "Translate", deadline: new Date(Date.now() + 86_400_000), status: "COMPLETED" },
    });
    await h.prisma.pointsEntry.createMany({
      data: [
        { userId: me.user.id, taskId: id, role: "CLIENT", feeUnits: "2400000", points: 240 },
        { userId: me.user.id, taskId: randomUUID(), role: "PROVIDER", feeUnits: "1200000", points: 12, flag: "repeat-pair" },
        { userId: other.user.id, taskId: randomUUID(), role: "CLIENT", feeUnits: "5000000", points: 500 },
        { userId: nobody.user.id, taskId: randomUUID(), role: "CLIENT", feeUnits: "100", points: 0, flag: "below-minimum" },
      ],
    });

    expect((await h.app.inject({ method: "GET", url: "/points/me" })).statusCode).toBe(401);
    const mine = (await h.app.inject({ method: "GET", url: "/points/me", headers: { cookie: me.cookie } })).json<{
      total: number;
      entries: { taskId: string; title: string | null; role: string; points: number; flag: string | null }[];
    }>();
    expect(mine.total).toBe(252);
    expect(mine.entries).toHaveLength(2);
    expect(mine.entries.find((e) => e.role === "CLIENT")).toMatchObject({ taskId: id, title: "Swahili menu", points: 240, flag: null });
    expect(mine.entries.find((e) => e.role === "PROVIDER")).toMatchObject({ title: null, points: 12, flag: "repeat-pair" });

    const board = (await h.app.inject({ method: "GET", url: "/points/leaderboard" })).json<{ leaders: { rank: number; wallet: string; points: number }[] }>();
    expect(board.leaders.map((l) => l.points)).toEqual([500, 252]);
    expect(board.leaders[0]).toMatchObject({ rank: 1, wallet: `${other.account.address.slice(0, 6)}…${other.account.address.slice(-4)}` });
    expect(JSON.stringify(board).toLowerCase()).not.toContain(other.account.address.toLowerCase());
  });
});

describe("airdrop", () => {
  it("serves the stored allocation and proof for a wallet, and 404s for everyone else", async () => {
    const holder = newAccount().address;
    const proof = [`0x${"ab".repeat(32)}`, `0x${"cd".repeat(32)}`];
    await h.prisma.airdropAllocation.createMany({
      data: [
        { airdropId: "early-1", wallet: holder.toLowerCase(), amount: "1500000000000000000000", proof },
        { airdropId: "older-0", wallet: newAccount().address.toLowerCase(), amount: "1", proof: [] },
      ],
    });
    const res = await h.app.inject({ method: "GET", url: `/airdrop/${holder}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ airdropId: "early-1", contract: LAUNCH.airdrop, amount: "1500000000000000000000", proof });

    expect((await h.app.inject({ method: "GET", url: `/airdrop/${newAccount().address}` })).statusCode).toBe(404);
    const otherDrop = await h.prisma.airdropAllocation.findFirstOrThrow({ where: { airdropId: "older-0" } });
    expect((await h.app.inject({ method: "GET", url: `/airdrop/${otherDrop.wallet}` })).statusCode).toBe(404);
    expect((await h.app.inject({ method: "GET", url: "/airdrop/not-a-wallet" })).statusCode).toBe(400);
  });
});

describe("fee split", () => {
  it("returns setSplit calldata for the admin Safe, admin-only, and only for splits that add up", async () => {
    const user = await login(h);
    const split = { treasuryBps: 5_000, stakerBps: 3_000, buybackBps: 2_000 };
    expect((await h.app.inject({ method: "POST", url: "/admin/fee-split", headers: { cookie: user.cookie }, payload: split })).statusCode).toBe(403);

    const admin = await login(h, privateKeyToAccount(ADMIN_KEY));
    const res = await h.app.inject({ method: "POST", url: "/admin/fee-split", headers: { cookie: admin.cookie }, payload: split });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ tx: { to: string; data: `0x${string}`; value: string }; signer: string }>();
    expect(body).toMatchObject({ signer: "adminSafe", tx: { to: FEE_DISTRIBUTOR, value: "0" } });
    expect(decodeFunctionData({ abi: feeDistributorAbi, data: body.tx.data })).toMatchObject({ functionName: "setSplit", args: [5_000, 3_000, 2_000] });

    const bad = await h.app.inject({ method: "POST", url: "/admin/fee-split", headers: { cookie: admin.cookie }, payload: { ...split, buybackBps: 1_000 } });
    expect(bad.statusCode).toBe(400);
  });
});
