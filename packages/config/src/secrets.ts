import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";

/**
 * Node-only entry point (`@kazi/config/secrets`).
 * AES-256-GCM for secrets at rest (agent webhook secrets). Key = ENCRYPTION_KEY (32 bytes base64).
 * Format: base64url(iv[12] | tag[16] | ciphertext), prefixed with a version tag.
 */
const VERSION = "v1";

export class SecretBox {
  private readonly key: Buffer;

  constructor(base64Key: string) {
    this.key = Buffer.from(base64Key, "base64");
    if (this.key.length !== 32) throw new Error("ENCRYPTION_KEY must be 32 bytes");
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return `${VERSION}.${Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64url")}`;
  }

  decrypt(sealed: string): string {
    const [version, body] = sealed.split(".");
    if (version !== VERSION || !body) throw new Error("Unsupported secret format");
    const raw = Buffer.from(body, "base64url");
    const decipher = createDecipheriv("aes-256-gcm", this.key, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
  }
}

/** New webhook secret shown to the developer exactly once. */
export function generateWebhookSecret(): string {
  return `whsec_${randomBytes(32).toString("base64url")}`;
}

/**
 * House agents' webhook secrets are derived from one master secret (HOUSE_AGENTS_SECRET), so the
 * seed and the house-agents service agree without sharing a database.
 */
export function deriveHouseAgentSecret(masterSecret: string, slug: string): string {
  if (masterSecret.length < 32)
    throw new Error("HOUSE_AGENTS_SECRET must be at least 32 characters");
  return `whsec_${createHmac("sha256", masterSecret).update(`kazi-house-agent:${slug}`).digest("base64url")}`;
}
