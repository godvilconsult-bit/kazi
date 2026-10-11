/**
 * Generates the platform signer keys for Arc mainnet when they are held as Railway secrets instead of
 * a KMS (guarded launch, docs/runbooks/deploy.md §4): OPERATOR (pays out milestones) and QUOTER
 * (signs quotes). Appends OPERATOR_PRIVATE_KEY/OPERATOR_ADDRESS and QUOTER_PRIVATE_KEY/QUOTER_ADDRESS
 * to the git-ignored .env.mainnet (or ENV_FILE=...). Prints addresses only, never keys. Idempotent:
 * existing keys are kept, and an address set without its key (e.g. a KMS address) is never replaced.
 *
 *   pnpm -F @kazi/contracts signers:generate
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";

const ENV_FILE = process.env["ENV_FILE"] ?? resolve(import.meta.dirname, "../../../.env.mainnet");
if (!existsSync(ENV_FILE)) throw new Error(`env file not found: ${ENV_FILE}`);

const env: Record<string, string> = {};
for (const line of readFileSync(ENV_FILE, "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m?.[1]) env[m[1]] = (m[2] ?? "").split(" #")[0]?.trim() ?? "";
}

const lines: string[] = [];
for (const role of ["OPERATOR", "QUOTER"] as const) {
  const keyName = `${role}_PRIVATE_KEY`;
  const addrName = `${role}_ADDRESS`;
  const existing = env[keyName];
  if (existing) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(existing)) throw new Error(`${keyName} is malformed`);
    const address = privateKeyToAccount(existing as Hex).address;
    if (env[addrName] && env[addrName].toLowerCase() !== address.toLowerCase())
      throw new Error(`${addrName} doesn't match ${keyName}`);
    console.log(`${role.toLowerCase()}: ${address} (kept)`);
    continue;
  }
  if (env[addrName])
    throw new Error(`${addrName} is set without ${keyName} (a KMS signer?); not replacing it`);
  const key = generatePrivateKey();
  const address = privateKeyToAccount(key).address;
  lines.push(`${keyName}=${key}`, `${addrName}=${address}`);
  console.log(`${role.toLowerCase()}: ${address} (new)`);
}
if (lines.length) {
  appendFileSync(
    ENV_FILE,
    `\n# Platform signers held as Railway secrets (guarded launch), generated ${new Date().toISOString()}.\n${lines.join("\n")}\n`,
  );
  console.log(
    `keys stored in ${ENV_FILE} (git-ignored); fund the operator with a few USDC for gas`,
  );
}
