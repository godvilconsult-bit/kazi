"""HMAC request signatures (docs/05-AGENT-SPEC.md §3).

``X-Kazi-Signature: t=<unix>,v1=<hex hmac_sha256(secret, t + "." + raw_body)>``

Kazi signs every request to an agent with the agent's webhook secret, and agents sign their
callbacks to Kazi the same way. Always sign and verify the exact raw bytes, never re-serialized JSON.
"""

from __future__ import annotations

import hashlib
import hmac
import re
import time
from dataclasses import dataclass
from typing import Optional

SIGNATURE_HEADER = "x-kazi-signature"
SUBTASK_ID_HEADER = "x-kazi-subtask-id"
IDEMPOTENCY_HEADER = "x-kazi-idempotency-key"
#: Signatures whose timestamp is further than this from now are rejected (seconds).
SIGNATURE_TOLERANCE_SECONDS = 300

_HEX64 = re.compile(r"^[0-9a-f]{64}$")


def _hmac(secret: str, data: str) -> str:
    return hmac.new(secret.encode("utf-8"), data.encode("utf-8"), hashlib.sha256).hexdigest()


def sign_payload(raw_body: str, secret: str, now_sec: Optional[int] = None) -> str:
    """The ``X-Kazi-Signature`` header value for ``raw_body``."""
    t = int(time.time()) if now_sec is None else now_sec
    return f"t={t},v1={_hmac(secret, f'{t}.{raw_body}')}"


@dataclass(frozen=True)
class VerifyResult:
    ok: bool
    #: MISSING, MALFORMED, STALE or MISMATCH when not ok.
    reason: Optional[str] = None


def verify_signature(
    raw_body: str,
    header: Optional[str],
    secret: str,
    now_sec: Optional[int] = None,
    tolerance_sec: int = SIGNATURE_TOLERANCE_SECONDS,
) -> VerifyResult:
    """Check a request from Kazi (constant-time comparison, replay window)."""
    if not header:
        return VerifyResult(False, "MISSING")
    parts = {}
    for kv in header.split(","):
        key, _, value = kv.partition("=")
        parts[key.strip()] = value.strip()
    t, v1 = parts.get("t", ""), parts.get("v1", "")
    if not t.isdigit() or not _HEX64.match(v1):
        return VerifyResult(False, "MALFORMED")
    now = int(time.time()) if now_sec is None else now_sec
    if abs(now - int(t)) > tolerance_sec:
        return VerifyResult(False, "STALE")
    expected = _hmac(secret, f"{t}.{raw_body}")
    return VerifyResult(True) if hmac.compare_digest(expected, v1) else VerifyResult(False, "MISMATCH")
