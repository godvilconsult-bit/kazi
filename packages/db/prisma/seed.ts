// Seed: capability registry, an admin user, the house agent providers and Kazi's service-fee
// provider (docs/06-ROUTER.md §3, §7). Idempotent (upserts) — safe to run twice. `pnpm db:seed`.
import { deriveHouseAgentSecret, SecretBox } from "@kazi/config/secrets";
import {
  CAPABILITY_DEFINITIONS,
  HOUSE_AGENT_LISTINGS,
  SERVICE_FEE_PROVIDER,
  normalizeWallet,
} from "@kazi/shared";
import { createPrismaClient } from "../src/index";

// Anvil account #1 — a well-known LOCAL test address, used only when ADMIN_WALLETS is unset outside production.
const DEV_ADMIN_FALLBACK = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

async function main(): Promise<void> {
  const databaseUrl = process.env["DATABASE_URL"];
  if (!databaseUrl) throw new Error("DATABASE_URL is not set");
  const isProd = process.env["NODE_ENV"] === "production";

  const adminWallets = (process.env["ADMIN_WALLETS"] ?? "")
    .split(",")
    .map((w) => w.trim())
    .filter(Boolean);
  if (adminWallets.length === 0 && isProd)
    throw new Error("ADMIN_WALLETS is required to seed production");
  const adminWallet = normalizeWallet(adminWallets[0] ?? DEV_ADMIN_FALLBACK);
  const houseBaseUrl = process.env["HOUSE_AGENTS_BASE_URL"] ?? "http://localhost:4100";
  const treasury = process.env["TREASURY_ADDRESS"];
  if (!treasury && isProd) throw new Error("TREASURY_ADDRESS is required to seed production");
  // House agents' webhook secrets: derived from HOUSE_AGENTS_SECRET, stored encrypted.
  const master = process.env["HOUSE_AGENTS_SECRET"];
  const encryptionKey = process.env["ENCRYPTION_KEY"];
  const box = master && encryptionKey ? new SecretBox(encryptionKey) : undefined;

  const prisma = createPrismaClient(databaseUrl);
  try {
    for (const c of CAPABILITY_DEFINITIONS) {
      await prisma.capability.upsert({
        where: { slug: c.slug },
        update: { description: c.description },
        create: { slug: c.slug, description: c.description },
      });
    }

    const admin = await prisma.user.upsert({
      where: { wallet: adminWallet },
      update: { roles: { set: ["CLIENT", "PROVIDER_OWNER", "ADMIN"] } },
      create: {
        wallet: adminWallet,
        displayName: "Kazi Admin",
        roles: ["CLIENT", "PROVIDER_OWNER", "ADMIN"],
      },
    });

    // Admin rights follow ADMIN_WALLETS: strip a stale ADMIN flag from anyone no longer listed
    // (e.g. the dev fallback account once a real admin wallet is configured).
    const allowedAdmins = new Set(adminWallets.map(normalizeWallet));
    allowedAdmins.add(adminWallet);
    const staleAdmins = await prisma.user.findMany({
      where: { roles: { has: "ADMIN" }, wallet: { notIn: [...allowedAdmins] } },
    });
    for (const u of staleAdmins) {
      await prisma.user.update({
        where: { id: u.id },
        data: { roles: { set: u.roles.filter((r) => r !== "ADMIN") } },
      });
    }

    // House agents always belong to the current admin wallet (a re-seed after setting ADMIN_WALLETS
    // moves them off any earlier test address). They pay out to HOUSE_AGENTS_PAYOUT_ADDRESS when
    // set — on mainnet, the treasury Safe — else to the admin wallet.
    const housePayout = normalizeWallet(process.env["HOUSE_AGENTS_PAYOUT_ADDRESS"] || adminWallet);
    for (const agent of HOUSE_AGENT_LISTINGS) {
      const webhookSecretEnc =
        box && master ? box.encrypt(deriveHouseAgentSecret(master, agent.slug)) : undefined;
      await prisma.provider.upsert({
        where: { slug: agent.slug },
        update: {
          name: agent.name,
          description: agent.description,
          capabilities: [...agent.capabilities],
          languages: [...agent.languages],
          endpointUrl: `${houseBaseUrl}/${agent.slug}/run`,
          pricing: { ...agent.pricing },
          ownerId: admin.id,
          payoutAddress: housePayout,
          ...(webhookSecretEnc ? { webhookSecretEnc } : {}),
        },
        create: {
          slug: agent.slug,
          ownerId: admin.id,
          kind: "AGENT",
          name: agent.name,
          description: agent.description,
          capabilities: [...agent.capabilities],
          languages: [...agent.languages],
          endpointUrl: `${houseBaseUrl}/${agent.slug}/run`,
          pricing: { ...agent.pricing },
          payoutAddress: housePayout,
          status: "ACTIVE",
          isHouse: true,
          ...(webhookSecretEnc ? { webhookSecretEnc } : {}),
        },
      });
    }

    // The router's service-fee milestone goes to this provider; its payout is the treasury.
    // It must also be registered + bonded onchain (onchainId) before quotes can include the fee.
    const servicePayout = normalizeWallet(treasury ?? adminWallet);
    await prisma.provider.upsert({
      where: { slug: SERVICE_FEE_PROVIDER.slug },
      update: {
        name: SERVICE_FEE_PROVIDER.name,
        description: SERVICE_FEE_PROVIDER.description,
        ownerId: admin.id,
        payoutAddress: servicePayout,
      },
      create: {
        slug: SERVICE_FEE_PROVIDER.slug,
        ownerId: admin.id,
        kind: "AGENT",
        name: SERVICE_FEE_PROVIDER.name,
        description: SERVICE_FEE_PROVIDER.description,
        capabilities: [],
        languages: [],
        pricing: { ...SERVICE_FEE_PROVIDER.pricing },
        payoutAddress: servicePayout,
        status: "ACTIVE",
        isHouse: true,
      },
    });

    console.log(
      `Seeded ${CAPABILITY_DEFINITIONS.length} capabilities, admin ${adminWallet}${
        adminWallets.length === 0 ? " (dev fallback — set ADMIN_WALLETS)" : ""
      }, ${HOUSE_AGENT_LISTINGS.length} house agents${box ? " with webhook secrets" : " (no HOUSE_AGENTS_SECRET: webhook secrets not set)"}, service-fee provider paying ${servicePayout}${
        treasury ? "" : " (admin fallback — set TREASURY_ADDRESS)"
      }; removed stale ADMIN from ${staleAdmins.length} user(s).`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

await main();
