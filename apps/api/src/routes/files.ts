import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { presignUploadSchema } from "@kazi/shared";
import type { AppServices } from "../app";
import { requireAuth } from "../auth/guards";
import { invalidState, notFound, parse } from "../http/errors";
import { serializeFile } from "./serializers";

const DOWNLOAD_URL_TTL_SECONDS = 15 * 60; // docs/09 §1: signed URLs (15 min)
const idParams = z.object({ id: z.string().min(1).max(64) });

/** Keep keys boring: no path tricks, no odd unicode, bounded length. */
function safeFilename(name: string): string {
  const cleaned = name
    .normalize("NFKD")
    .replace(/[^\w.-]+/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 120);
  return cleaned || "file";
}

export function fileRoutes(s: AppServices) {
  async function loadOwnFile(req: FastifyRequest) {
    const auth = requireAuth(req);
    const { id } = parse(idParams, req.params);
    const file = await s.prisma.fileObject.findUnique({ where: { id } });
    if (!file || (file.ownerId !== auth.userId && !auth.roles.includes("ADMIN")))
      throw notFound("File");
    return file;
  }

  return async function routes(app: FastifyInstance) {
    /** Step 1: reserve a file and get a signed URL to PUT the bytes to (max 50 MB). */
    app.post(
      "/files/presign",
      { preHandler: s.limiter.guard("files-presign", 30, 60) },
      async (req, reply) => {
        const auth = requireAuth(req);
        const body = parse(presignUploadSchema, req.body);
        const key = `${auth.userId}/${randomUUID()}/${safeFilename(body.filename)}`;
        const upload = await s.storage.createUploadUrl(key);
        const file = await s.prisma.fileObject.create({
          data: {
            ownerId: auth.userId,
            key,
            filename: body.filename,
            mime: body.mime,
            size: body.size,
            sha256: body.sha256 ?? null,
          },
        });
        return reply.status(201).send({
          file: serializeFile(file),
          upload: {
            url: upload.url,
            method: "PUT",
            headers: { "content-type": body.mime },
            expiresAt: new Date(Date.now() + upload.expiresInSeconds * 1000).toISOString(),
          },
        });
      },
    );

    /** Step 2: confirm the upload; the server checks the object exists with the declared size. */
    app.post("/files/:id/complete", async (req) => {
      const file = await loadOwnFile(req);
      if (file.status === "UPLOADED") return { file: serializeFile(file) };
      const stat = await s.storage.stat(file.key);
      if (!stat) throw invalidState("File has not been uploaded yet");
      if (stat.size !== file.size)
        throw invalidState(`Uploaded size ${stat.size} does not match declared size ${file.size}`);
      const updated = await s.prisma.fileObject.update({
        where: { id: file.id },
        data: { status: "UPLOADED" },
      });
      return { file: serializeFile(updated) };
    });

    app.get("/files/:id/download-url", async (req) => {
      const file = await loadOwnFile(req);
      if (file.status !== "UPLOADED") throw invalidState("File is not uploaded");
      const url = await s.storage.createDownloadUrl(file.key, DOWNLOAD_URL_TTL_SECONDS);
      return {
        url,
        expiresAt: new Date(Date.now() + DOWNLOAD_URL_TTL_SECONDS * 1000).toISOString(),
      };
    });
  };
}
