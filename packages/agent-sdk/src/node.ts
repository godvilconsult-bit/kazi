import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { KaziAgent } from "./agent";

/** Plain `node:http` adapter. For Fastify/Express, pass the raw body string to `agent.handle`. */
export function toNodeHandler(agent: KaziAgent, opts: { maxBodyBytes?: number } = {}) {
  const limit = opts.maxBodyBytes ?? agent.manifest.limits?.maxInputBytes ?? 5_000_000;
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    let rawBody: string;
    try {
      rawBody = await readBody(req, limit);
    } catch {
      return send(res, 413, {
        status: "failed",
        error: { code: "PAYLOAD_TOO_LARGE", message: `max ${limit} bytes` },
      });
    }
    const headers: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(req.headers))
      headers[k.toLowerCase()] = Array.isArray(v) ? v[0] : v;
    const out = await agent.handle({
      method: req.method ?? "GET",
      path: new URL(req.url ?? "/", "http://agent").pathname,
      headers,
      rawBody,
    });
    send(res, out.status, out.body);
  };
}

/** Start an HTTP server for the agent. */
export function serveAgent(agent: KaziAgent, port: number, host = "0.0.0.0"): Promise<Server> {
  const server = createServer((req, res) => void toNodeHandler(agent)(req, res));
  return new Promise((resolve) => server.listen(port, host, () => resolve(server)));
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
