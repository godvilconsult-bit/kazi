import { createServer, type Server } from "node:http";
import { toNodeHandler, type KaziAgent } from "@kazi/agent-sdk";

/** One HTTP service hosting every house agent under /<slug>/... (endpoint = /<slug>/run). */
export function createHouseServer(agents: ReadonlyMap<string, KaziAgent>): Server {
  const handlers = new Map([...agents].map(([slug, agent]) => [slug, toNodeHandler(agent)]));
  return createServer((req, res) => {
    const slug = new URL(req.url ?? "/", "http://house").pathname.split("/")[1] ?? "";
    const handle = handlers.get(slug);
    if (handle) return void handle(req, res);
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      return void res.end(JSON.stringify({ ok: true, agents: [...handlers.keys()] }));
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(
      JSON.stringify({ status: "failed", error: { code: "NOT_FOUND", message: "unknown agent" } }),
    );
  });
}
