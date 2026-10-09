/** Minimal cookie handling (no extra dependency). Names/values we set are URL-safe tokens. */

export interface CookieOptions {
  maxAgeSeconds: number;
  path: string;
  secure: boolean;
  domain?: string | undefined;
}

export function serializeCookie(name: string, value: string, opts: CookieOptions): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    `Max-Age=${opts.maxAgeSeconds}`,
    `Path=${opts.path}`,
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (opts.secure) parts.push("Secure");
  if (opts.domain) parts.push(`Domain=${opts.domain}`);
  return parts.join("; ");
}

export function clearCookie(name: string, opts: Omit<CookieOptions, "maxAgeSeconds">): string {
  return serializeCookie(name, "", { ...opts, maxAgeSeconds: 0 });
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    const raw = part.slice(eq + 1).trim();
    try {
      out[name] = decodeURIComponent(raw);
    } catch {
      // ignore malformed cookie values
    }
  }
  return out;
}
