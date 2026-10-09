/**
 * Browser client for the Kazi API. Auth is an httpOnly cookie set by the API (SIWE), so every call
 * sends credentials; an expired access token is refreshed once, transparently.
 */

export const API_URL = (process.env["NEXT_PUBLIC_API_URL"] ?? "http://localhost:4000").replace(/\/$/, "");

export class ApiError extends Error {
  override readonly name = "ApiError";
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

let refreshing: Promise<boolean> | null = null;

/** One refresh at a time; concurrent 401s wait for the same rotation. */
function refreshSession(): Promise<boolean> {
  refreshing ??= fetch(`${API_URL}/auth/refresh`, { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: "{}" })
    .then((r) => r.ok)
    .catch(() => false)
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
}

export interface ApiInit {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
  signal?: AbortSignal;
}

export async function api<T>(path: string, init: ApiInit = {}, retry = true): Promise<T> {
  const method = init.method ?? "GET";
  // Fastify rejects an empty body with a JSON content type, so mutating calls always send JSON.
  const body = method === "GET" ? undefined : JSON.stringify(init.body ?? {});
  const res = await fetch(`${API_URL}${path}`, {
    method,
    credentials: "include",
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body,
    signal: init.signal,
  });
  if (res.status === 401 && retry && !path.startsWith("/auth/")) {
    if (await refreshSession()) return api<T>(path, init, false);
  }
  if (!res.ok) {
    const err = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
    throw new ApiError(res.status, err?.error?.code ?? `HTTP_${res.status}`, err?.error?.message ?? res.statusText);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const apiUrl = (path: string) => `${API_URL}${path}`;

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) {
    // viem/wagmi errors carry a short message first; the rest is technical detail.
    const short = (err as { shortMessage?: string }).shortMessage;
    return short ?? err.message.split("\n")[0] ?? err.message;
  }
  return String(err);
}
