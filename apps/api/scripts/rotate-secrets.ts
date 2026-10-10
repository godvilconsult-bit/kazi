/**
 * Secret rotation (docs/runbooks/key-compromise.md). Never prints a secret.
 *
 *   NEW_ENCRYPTION_KEY=… pnpm -F @kazi/api rotate-secrets          re-encrypt every stored webhook secret
 *   NEW_HOUSE_AGENTS_SECRET=… pnpm -F @kazi/api rotate-secrets     re-derive Kazi's house agents' secrets
 *
 * Both can be given at once. Reads the current ENCRYPTION_KEY and DATABASE_URL from the environment;
 * writes everything in one transaction. Afterwards set the new values in every service and restart.
 */
import { z } from "zod";
import { authEnvSchema, dbEnvSchema, loadEnv } from "@kazi/config";
import { SecretBox, deriveHouseAgentSecret } from "@kazi/config/secrets";
import { createPrismaClient } from "@kazi/db";

const env = loadEnv(
  dbEnvSchema.extend({ ENCRYPTION_KEY: authEnvSchema.shape.ENCRYPTION_KEY }).extend({
    NEW_ENCRYPTION_KEY: z.preprocess((v) => (v === "" ? undefined : v), z.string().optional()),
    NEW_HOUSE_AGENTS_SECRET: z.preprocess(
      (v) => (v === "" ? undefined : v),
      z.string().min(32).optional(),
    ),
  }),
);
if (!env.NEW_ENCRYPTION_KEY && !env.NEW_HOUSE_AGENTS_SECRET) {
  throw new Error("Set NEW_ENCRYPTION_KEY and/or NEW_HOUSE_AGENTS_SECRET");
}

const current = new SecretBox(env.ENCRYPTION_KEY);
const next = env.NEW_ENCRYPTION_KEY ? new SecretBox(env.NEW_ENCRYPTION_KEY) : current;
const prisma = createPrismaClient(env.DATABASE_URL);
try {
  const providers = await prisma.provider.findMany({
    where: { webhookSecretEnc: { not: null } },
    select: { id: true, slug: true, isHouse: true, webhookSecretEnc: true },
  });
  const updates = providers.flatMap((p) => {
    if (!p.webhookSecretEnc) return [];
    const rederive = p.isHouse && env.NEW_HOUSE_AGENTS_SECRET;
    if (!rederive && !env.NEW_ENCRYPTION_KEY) return [];
    const plain = rederive
      ? deriveHouseAgentSecret(env.NEW_HOUSE_AGENTS_SECRET ?? "", p.slug)
      : current.decrypt(p.webhookSecretEnc);
    return [
      prisma.provider.update({
        where: { id: p.id },
        data: { webhookSecretEnc: next.encrypt(plain) },
      }),
    ];
  });
  await prisma.$transaction(updates);
  console.log(`Rotated ${updates.length} of ${providers.length} stored webhook secrets.`);
  if (env.NEW_ENCRYPTION_KEY)
    console.log("Now set ENCRYPTION_KEY to the new key in the API and worker, then restart them.");
  if (env.NEW_HOUSE_AGENTS_SECRET)
    console.log("Now set HOUSE_AGENTS_SECRET in the house agents and worker, then restart them.");
} finally {
  await prisma.$disconnect();
}
