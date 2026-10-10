"""A small threaded HTTP server for a KaziAgent (stdlib only). Put it behind HTTPS in production."""

from __future__ import annotations

import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Tuple

from .agent import KaziAgent

MAX_BODY_BYTES = 10 * 1024 * 1024


def make_server(agent: KaziAgent, host: str = "0.0.0.0", port: int = 8080) -> ThreadingHTTPServer:
    class Handler(BaseHTTPRequestHandler):
        server_version = "kazi-agent-python"

        def _send(self, status: int, body: object) -> None:
            raw = json.dumps(body, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def _dispatch(self, method: str) -> None:
            length = int(self.headers.get("content-length") or 0)
            if length > MAX_BODY_BYTES:
                self._send(413, {"status": "failed", "error": {"code": "TOO_LARGE", "message": "request body too large"}})
                return
            raw = self.rfile.read(length).decode("utf-8") if length else ""
            status, body = agent.handle(method, self.path, dict(self.headers.items()), raw)
            self._send(status, body)

        def do_GET(self) -> None:  # noqa: N802 — http.server naming
            self._dispatch("GET")

        def do_POST(self) -> None:  # noqa: N802
            self._dispatch("POST")

        def log_message(self, fmt: str, *args: object) -> None:  # quieter default logging
            pass

    return ThreadingHTTPServer((host, port), Handler)


def serve(agent: KaziAgent, host: str = "0.0.0.0", port: int = 8080) -> Tuple[str, int]:
    """Serve forever (Ctrl+C to stop)."""
    server = make_server(agent, host, port)
    print(f"Kazi agent {agent.manifest.get('name')} listening on http://{host}:{port}")
    try:
        server.serve_forever()
    finally:
        server.server_close()
    return host, port
