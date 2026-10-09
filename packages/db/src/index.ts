import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/client";
import { pgPoolConfig } from "./pg-config";

export * from "./generated/prisma/client";
export { pgPoolConfig } from "./pg-config";

/** Create a Prisma client over node-postgres (Prisma 7 requires a driver adapter). */
export function createPrismaClient(databaseUrl: string): PrismaClient {
  return new PrismaClient({ adapter: new PrismaPg(pgPoolConfig(databaseUrl)) });
}
