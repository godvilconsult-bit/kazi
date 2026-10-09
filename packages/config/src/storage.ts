/**
 * Node-only entry point (`@kazi/config/storage`). Private object storage behind short-lived signed
 * URLs (docs/09 §1: signed URLs, private bucket). Used by the API (client uploads/downloads) and
 * the worker (attachment reading for the router, signed URLs for agents, copying agent outputs).
 */

export class StorageError extends Error {
  override readonly name = "StorageError";
}

export interface ObjectStorage {
  /** URL the client PUTs the file body to. */
  createUploadUrl(key: string): Promise<{ url: string; expiresInSeconds: number }>;
  /** URL to GET the file, valid for `expiresInSeconds`. */
  createDownloadUrl(key: string, expiresInSeconds: number): Promise<string>;
  /** Object metadata, or null if it doesn't exist. */
  stat(key: string): Promise<{ size: number; contentType: string | null } | null>;
  /** Server-side upload (e.g. copying an agent's output file into Kazi's bucket). */
  upload(key: string, body: Uint8Array, contentType: string): Promise<void>;
  /** Server-side download, refusing objects larger than `maxBytes`. */
  download(key: string, maxBytes: number): Promise<Uint8Array>;
}

const SUPABASE_UPLOAD_URL_TTL_SECONDS = 2 * 60 * 60; // fixed by Supabase for signed upload URLs

/** Supabase Storage signed-URL API (verified live against the kazi-files bucket). */
export class SupabaseStorage implements ObjectStorage {
  private readonly headers: Record<string, string>;

  constructor(
    private readonly baseUrl: string,
    serviceRoleKey: string,
    private readonly bucket: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.headers = { Authorization: `Bearer ${serviceRoleKey}`, apikey: serviceRoleKey };
  }

  async createUploadUrl(key: string) {
    const res = await this.call(`/object/upload/sign/${this.bucket}/${encodeKey(key)}`, {
      method: "POST",
      body: "{}",
    });
    const body = (await res.json()) as { url?: string };
    if (!body.url) throw new StorageError("upload URL missing from response");
    return {
      url: `${this.baseUrl}/storage/v1${body.url}`,
      expiresInSeconds: SUPABASE_UPLOAD_URL_TTL_SECONDS,
    };
  }

  async createDownloadUrl(key: string, expiresInSeconds: number) {
    const res = await this.call(`/object/sign/${this.bucket}/${encodeKey(key)}`, {
      method: "POST",
      body: JSON.stringify({ expiresIn: expiresInSeconds }),
    });
    const body = (await res.json()) as { signedURL?: string };
    if (!body.signedURL) throw new StorageError("download URL missing from response");
    return `${this.baseUrl}/storage/v1${body.signedURL}`;
  }

  async stat(key: string) {
    const res = await this.fetchImpl(
      `${this.baseUrl}/storage/v1/object/info/${this.bucket}/${encodeKey(key)}`,
      { headers: this.headers },
    );
    if (res.status === 400 || res.status === 404) {
      const body = (await res.json().catch(() => ({}))) as { statusCode?: string };
      if (res.status === 404 || body.statusCode === "404") return null;
      throw new StorageError(`stat failed (${res.status})`);
    }
    if (!res.ok) throw new StorageError(`stat failed (${res.status})`);
    const body = (await res.json()) as { size?: number; content_type?: string | null };
    if (typeof body.size !== "number") throw new StorageError("size missing from object info");
    return { size: body.size, contentType: body.content_type ?? null };
  }

  async upload(key: string, body: Uint8Array, contentType: string) {
    const res = await this.fetchImpl(
      `${this.baseUrl}/storage/v1/object/${this.bucket}/${encodeKey(key)}`,
      {
        method: "POST",
        headers: { ...this.headers, "content-type": contentType, "x-upsert": "true" },
        body,
      },
    );
    if (!res.ok) throw new StorageError(`upload failed (${res.status})`);
  }

  async download(key: string, maxBytes: number) {
    const info = await this.stat(key);
    if (!info) throw new StorageError("object not found");
    if (info.size > maxBytes) throw new StorageError(`object is ${info.size} bytes (max ${maxBytes})`);
    const res = await this.fetchImpl(
      `${this.baseUrl}/storage/v1/object/authenticated/${this.bucket}/${encodeKey(key)}`,
      { headers: this.headers },
    );
    if (!res.ok) throw new StorageError(`download failed (${res.status})`);
    return new Uint8Array(await res.arrayBuffer());
  }

  private async call(path: string, init: RequestInit): Promise<Response> {
    const res = await this.fetchImpl(`${this.baseUrl}/storage/v1${path}`, {
      ...init,
      headers: { ...this.headers, "content-type": "application/json" },
    });
    if (!res.ok) throw new StorageError(`request failed (${res.status})`);
    return res;
  }
}

/** In-memory storage for tests. `put` simulates the client's upload. */
export class MemoryStorage implements ObjectStorage {
  readonly objects = new Map<string, { size: number; contentType: string; body?: Uint8Array }>();

  async createUploadUrl(key: string) {
    return { url: `memory://upload/${key}`, expiresInSeconds: 7200 };
  }

  async createDownloadUrl(key: string, expiresInSeconds: number) {
    return `memory://download/${key}?ttl=${expiresInSeconds}`;
  }

  async stat(key: string) {
    const o = this.objects.get(key);
    return o ? { size: o.size, contentType: o.contentType } : null;
  }

  async upload(key: string, body: Uint8Array, contentType: string) {
    this.objects.set(key, { size: body.byteLength, contentType, body });
  }

  async download(key: string, maxBytes: number) {
    const o = this.objects.get(key);
    if (!o?.body) throw new StorageError("object not found");
    if (o.size > maxBytes) throw new StorageError(`object is ${o.size} bytes (max ${maxBytes})`);
    return o.body;
  }

  put(key: string, size: number, contentType: string, body?: Uint8Array): void {
    this.objects.set(key, { size, contentType, ...(body ? { body } : {}) });
  }
}

function encodeKey(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}
