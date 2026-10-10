"""Tests for the Python agent SDK. Run: python -m unittest discover -s tests (from this folder)."""

import json
import os
import sys
import threading
import time
import unittest
import urllib.request

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from kazi_agent import KaziAgent, make_server, sign_payload, verify_signature  # noqa: E402

SECRET = "whsec_test_secret_0123456789abcdef"
MANIFEST = {
    "schemaVersion": "1.0",
    "name": "Echo",
    "description": "Echoes the text back in upper case.",
    "version": "0.1.0",
    "endpoint": "https://example.com/run",
    "capabilities": ["write.summary"],
    "languages": ["en"],
    "pricing": {"model": "fixed", "price": "0.10", "currency": "USDC"},
    "mode": "sync",
}


def request(**overrides):
    body = {
        "subtaskId": "st_1",
        "attempt": 1,
        "capability": "write.summary",
        "instructions": "Summarize.",
        "input": {"text": "habari dunia"},
        "acceptance": {"rubric": ["Short"], "format": "markdown"},
        "deadline": "2030-01-01T00:00:00Z",
        "callbackUrl": "https://api.kazi.app/agent/callback",
        "budget": "0.10",
    }
    body.update(overrides)
    return json.dumps(body)


def signed(raw, secret=SECRET, **extra):
    return {"X-Kazi-Signature": sign_payload(raw, secret), **extra}


class SignatureTest(unittest.TestCase):
    def test_matches_the_typescript_sdk(self):
        # Produced by @kazi/agent-sdk signPayload(body, secret, 1_800_000_000).
        body = '{"subtaskId":"st_golden","attempt":1,"text":"Habari — ✓"}'
        header = "t=1800000000,v1=839cbf50816106655a59487088eba47235e52a2bf93cf9016716fadeed145482"
        self.assertEqual(sign_payload(body, "whsec_golden_secret_0123456789", 1_800_000_000), header)
        self.assertTrue(verify_signature(body, header, "whsec_golden_secret_0123456789", now_sec=1_800_000_000).ok)

    def test_rejects_bad_signatures(self):
        raw = '{"a":1}'
        header = sign_payload(raw, SECRET, 1_000)
        self.assertEqual(verify_signature('{"a":2}', header, SECRET, now_sec=1_000).reason, "MISMATCH")
        self.assertEqual(verify_signature(raw, header, "other", now_sec=1_000).reason, "MISMATCH")
        self.assertEqual(verify_signature(raw, header, SECRET, now_sec=1_301).reason, "STALE")
        self.assertEqual(verify_signature(raw, "t=abc,v1=zz", SECRET).reason, "MALFORMED")
        self.assertEqual(verify_signature(raw, None, SECRET).reason, "MISSING")


class SyncAgentTest(unittest.TestCase):
    def setUp(self):
        self.calls = 0

        def handler(ctx):
            self.calls += 1
            return {"text": ctx.request["input"]["text"].upper()}

        self.agent = KaziAgent(MANIFEST, SECRET, handler)

    def test_completes_a_signed_request(self):
        raw = request()
        status, body = self.agent.handle("POST", "/run", signed(raw), raw)
        self.assertEqual(status, 200)
        self.assertEqual(body, {"status": "completed", "output": {"text": "HABARI DUNIA"}})

    def test_rejects_unsigned_unknown_and_invalid_requests(self):
        raw = request()
        self.assertEqual(self.agent.handle("POST", "/run", {}, raw)[0], 401)
        self.assertEqual(self.agent.handle("POST", "/run", signed(raw, "wrong"), raw)[0], 401)
        bad = request(capability="translate.en-sw")
        self.assertEqual(self.agent.handle("POST", "/run", signed(bad), bad)[0], 422)
        invalid = request(input={})
        status, body = self.agent.handle("POST", "/run", signed(invalid), invalid)
        self.assertEqual((status, body["error"]["code"]), (400, "INVALID_REQUEST"))
        self.assertEqual(self.agent.handle("GET", "/health", {}, "")[0], 200)
        self.assertEqual(self.agent.handle("GET", "/.well-known/kazi-agent.json", {}, "")[1]["name"], "Echo")

    def test_answers_a_retry_from_the_store(self):
        raw = request()
        first = self.agent.handle("POST", "/run", signed(raw), raw)
        again = self.agent.handle("POST", "/run", signed(raw), raw)
        self.assertEqual(first, again)
        self.assertEqual(self.calls, 1)

    def test_reports_handler_failures_cleanly(self):
        def fails(ctx):
            ctx.fail("NO_TEXT", "send text")

        agent = KaziAgent(MANIFEST, SECRET, fails)
        raw = request()
        self.assertEqual(agent.handle("POST", "/run", signed(raw), raw)[1]["error"], {"code": "NO_TEXT", "message": "send text"})

        errors = []
        broken = KaziAgent(MANIFEST, SECRET, lambda ctx: 1 / 0, on_error=lambda err, req: errors.append(err))
        raw2 = request(subtaskId="st_2")
        self.assertEqual(broken.handle("POST", "/run", signed(raw2), raw2)[1]["error"]["code"], "INTERNAL")
        self.assertEqual(len(errors), 1)

        empty = KaziAgent(MANIFEST, SECRET, lambda ctx: {})
        raw3 = request(subtaskId="st_3")
        self.assertEqual(empty.handle("POST", "/run", signed(raw3), raw3)[1]["error"]["code"], "OUTPUT_INVALID")


class AsyncAgentTest(unittest.TestCase):
    def test_accepts_then_posts_signed_progress_and_result(self):
        posted = []

        def post(url, body, headers):
            posted.append((url, body.decode("utf-8"), headers))
            return 200

        def handler(ctx):
            ctx.progress(0.5, "half way")
            return {"text": "done"}

        agent = KaziAgent({**MANIFEST, "mode": "async"}, SECRET, handler, post=post)
        raw = request()
        self.assertEqual(agent.handle("POST", "/run", signed(raw), raw), (202, {"status": "accepted"}))
        agent.idle()
        self.assertEqual([json.loads(b)["status"] for _, b, _ in posted], ["progress", "completed"])
        for url, body, headers in posted:
            self.assertEqual(url, "https://api.kazi.app/agent/callback")
            self.assertEqual(headers["x-kazi-subtask-id"], "st_1")
            self.assertTrue(verify_signature(body, headers["x-kazi-signature"], SECRET).ok)


class ServerTest(unittest.TestCase):
    def test_round_trip_over_http(self):
        agent = KaziAgent(MANIFEST, SECRET, lambda ctx: {"text": "ok"})
        server = make_server(agent, "127.0.0.1", 0)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            port = server.server_address[1]
            raw = request()
            req = urllib.request.Request(f"http://127.0.0.1:{port}/run", data=raw.encode("utf-8"), headers={"content-type": "application/json", **signed(raw)}, method="POST")
            with urllib.request.urlopen(req, timeout=10) as res:
                self.assertEqual(json.loads(res.read()), {"status": "completed", "output": {"text": "ok"}})
        finally:
            server.shutdown()
            server.server_close()


if __name__ == "__main__":
    unittest.main()
