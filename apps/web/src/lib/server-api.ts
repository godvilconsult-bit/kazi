import type { PublicConfig } from "./types";

/** Server-side reads of public API data (landing, directory, profiles). No user credentials. */

const SERVER_API_URL = (
  process.env["API_URL_INTERNAL"] ??
  process.env["NEXT_PUBLIC_API_URL"] ??
  "http://localhost:4000"
).replace(/\/$/, "");

export async function serverGet<T>(path: string, revalidate = 30): Promise<T | null> {
  try {
    const res = await fetch(`${SERVER_API_URL}${path}`, { next: { revalidate } });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null; // API unreachable: pages render an offline state instead of crashing
  }
}

export function getPublicConfig(): Promise<PublicConfig | null> {
  return serverGet<PublicConfig>("/config", 30);
}
