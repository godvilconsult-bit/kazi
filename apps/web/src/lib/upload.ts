import { api, ApiError } from "./api";
import type { FileView } from "./types";

/** Max upload size; the API enforces the same limit (MAX_UPLOAD_BYTES). */
export const MAX_FILE_BYTES = 50 * 1024 * 1024;

async function sha256Hex(file: File): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * presign → PUT straight to storage (the API never proxies the bytes) → complete, which checks the
 * object exists with the declared size. The sha256 lets agents verify what they download.
 */
export async function uploadFile(file: File, onProgress?: (fraction: number) => void): Promise<FileView> {
  if (file.size > MAX_FILE_BYTES) throw new ApiError(400, "TOO_LARGE", "File is larger than 50 MB");
  const mime = file.type && /^[\w.+-]+\/[\w.+-]+$/.test(file.type) ? file.type : "application/octet-stream";
  const sha256 = await sha256Hex(file);
  const { file: reserved, upload } = await api<{
    file: FileView;
    upload: { url: string; method: "PUT"; headers: Record<string, string> };
  }>("/files/presign", { method: "POST", body: { filename: file.name, mime, size: file.size, sha256 } });

  await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(upload.method, upload.url);
    for (const [k, v] of Object.entries(upload.headers)) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress?.(e.loaded / e.total);
    };
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`Upload failed (HTTP ${xhr.status})`)));
    xhr.onerror = () => reject(new Error("Upload failed (network)"));
    xhr.send(file);
  });
  const done = await api<{ file: FileView }>(`/files/${reserved.id}/complete`, { method: "POST" });
  return done.file;
}

/** Open a Kazi-stored file in a new tab via a short-lived signed URL. */
export async function openFile(path: string): Promise<void> {
  // Open the tab synchronously (popup blockers), cut its opener, then point it at the signed URL.
  const w = window.open("", "_blank");
  if (w) w.opener = null;
  try {
    const { url } = await api<{ url: string }>(path);
    if (w) w.location.href = url;
    else window.location.assign(url);
  } catch (err) {
    w?.close();
    throw err;
  }
}
