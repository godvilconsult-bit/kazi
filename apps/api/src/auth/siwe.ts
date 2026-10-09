import type { Redis } from "ioredis";
import { recoverMessageAddress, type PublicClient } from "viem";
import { generateSiweNonce, parseSiweMessage } from "viem/siwe";
import { normalizeWallet } from "@kazi/shared";
import { unauthorized } from "../http/errors";

/** Sign-In with Ethereum (EIP-4361) using viem's built-in SIWE support — no extra dependency. */

const NONCE_TTL_SECONDS = 10 * 60;
const MAX_MESSAGE_AGE_MS = 10 * 60 * 1000;
const CLOCK_SKEW_MS = 60 * 1000;

export interface SiweConfig {
  /** Host (and port) the web app is served from, e.g. "kazi.app" or "localhost:3000". */
  domain: string;
  chainId: number;
  /** For smart-contract wallets (ERC-1271/6492). EOAs are verified locally without RPC. */
  publicClient?: PublicClient | undefined;
}

export class SiweService {
  constructor(
    private readonly redis: Redis,
    private readonly prefix: string,
    private readonly config: SiweConfig,
  ) {}

  async issueNonce(): Promise<string> {
    const nonce = generateSiweNonce();
    await this.redis.set(this.nonceKey(nonce), "1", "EX", NONCE_TTL_SECONDS);
    return nonce;
  }

  /** Verifies the message + signature and consumes the nonce (single use). Returns the wallet. */
  async verify(
    message: string,
    signature: `0x${string}`,
    now: Date = new Date(),
  ): Promise<`0x${string}`> {
    const fields = parseSiweMessage(message);
    const { address, domain, chainId, nonce, issuedAt, expirationTime, notBefore, version } =
      fields;

    if (!address || !nonce || !issuedAt || !domain || chainId === undefined) {
      throw unauthorized("Malformed sign-in message");
    }
    if (version !== "1") throw unauthorized("Unsupported sign-in message version");
    if (domain !== this.config.domain)
      throw unauthorized("Sign-in message is for a different site");
    if (chainId !== this.config.chainId)
      throw unauthorized("Sign-in message is for a different chain");

    const t = now.getTime();
    if (issuedAt.getTime() > t + CLOCK_SKEW_MS || t - issuedAt.getTime() > MAX_MESSAGE_AGE_MS) {
      throw unauthorized("Sign-in message is too old");
    }
    if (expirationTime && expirationTime.getTime() <= t)
      throw unauthorized("Sign-in message expired");
    if (notBefore && notBefore.getTime() > t + CLOCK_SKEW_MS)
      throw unauthorized("Sign-in message not valid yet");

    // Single use: GETDEL is atomic, so a replayed message can never pass twice.
    const consumed = await this.redis.getdel(this.nonceKey(nonce));
    if (consumed === null) throw unauthorized("Unknown or already used nonce");

    if (!(await this.signatureMatches(address, message, signature))) {
      throw unauthorized("Invalid signature");
    }
    return normalizeWallet(address);
  }

  private async signatureMatches(
    address: `0x${string}`,
    message: string,
    signature: `0x${string}`,
  ) {
    try {
      const recovered = await recoverMessageAddress({ message, signature });
      if (recovered.toLowerCase() === address.toLowerCase()) return true;
    } catch {
      // not a plain ECDSA signature — may be a smart-contract wallet
    }
    if (!this.config.publicClient) return false;
    try {
      return await this.config.publicClient.verifyMessage({ address, message, signature });
    } catch {
      return false;
    }
  }

  private nonceKey(nonce: string): string {
    return `${this.prefix}:siwe:nonce:${nonce}`;
  }
}
