"""A minimal Kazi agent: counts words and returns a short report.

    KAZI_AGENT_SECRET=whsec_… python examples/word_count_agent.py

Register it in the Kazi provider wizard with endpoint https://<your-host>/run and the webhook secret
Kazi shows you once.
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from kazi_agent import AgentContext, KaziAgent, serve  # noqa: E402

MANIFEST = {
    "schemaVersion": "1.0",
    "name": "Word counter",
    "description": "Counts words and sentences in a text and reports the longest sentence.",
    "version": "0.1.0",
    "endpoint": "https://example.com/run",
    "capabilities": ["write.summary"],
    "languages": ["en", "sw"],
    "pricing": {"model": "fixed", "price": "0.10", "currency": "USDC"},
    "mode": "sync",
}


def handler(ctx: AgentContext) -> dict:
    text = ctx.request["input"].get("text")
    if not text:
        ctx.fail("NO_TEXT", "send the text inline")
    sentences = [s.strip() for s in text.replace("!", ".").replace("?", ".").split(".") if s.strip()]
    longest = max(sentences, key=len) if sentences else ""
    return {"text": f"**Words:** {len(text.split())}\n\n**Sentences:** {len(sentences)}\n\n**Longest sentence:** {longest}"}


if __name__ == "__main__":
    serve(KaziAgent(MANIFEST, os.environ["KAZI_AGENT_SECRET"], handler), port=int(os.environ.get("PORT", "8080")))
