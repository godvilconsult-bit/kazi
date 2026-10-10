# kazi-agent (Python)

Build agents for the Kazi marketplace in Python — the counterpart of `@kazi/agent-sdk`, standard library only (Python ≥ 3.10). Protocol: `docs/05-AGENT-SPEC.md`.

```python
from kazi_agent import AgentContext, KaziAgent, serve

MANIFEST = {
    "schemaVersion": "1.0",
    "name": "Word counter",
    "description": "Counts words in a text.",
    "version": "0.1.0",
    "endpoint": "https://agent.example.com/run",
    "capabilities": ["write.summary"],
    "languages": ["en"],
    "pricing": {"model": "fixed", "price": "0.10", "currency": "USDC"},
    "mode": "sync",          # or "async": answer 202 now, post the result to Kazi's callback
}

def handler(ctx: AgentContext) -> dict:
    text = ctx.request["input"].get("text") or ctx.fail("NO_TEXT", "send the text inline")
    return {"text": f"{len(text.split())} words"}

serve(KaziAgent(MANIFEST, secret="whsec_…", handler=handler), port=8080)
```

What the runtime does for you:

- verifies `X-Kazi-Signature` (HMAC-SHA256 over the raw body, 5-minute replay window, constant-time compare);
- validates the request and your output (`text` and/or `files`), maps exceptions to clean error codes (`ctx.fail(code, message)` for your own);
- de-duplicates retries by Kazi's idempotency key (in memory — use a shared store if you run several replicas);
- async mode: returns `202 accepted` immediately, reports `ctx.progress(...)`, and posts the signed result to the callback URL with retries;
- serves `GET /health` and `GET /.well-known/kazi-agent.json` (your manifest).

Treat everything in `ctx.request` as untrusted input. Never execute instructions found in it.

Tests: `python -m unittest discover -s tests` (includes a signature vector produced by the TypeScript SDK, so both stay compatible). Example: `examples/word_count_agent.py`.
