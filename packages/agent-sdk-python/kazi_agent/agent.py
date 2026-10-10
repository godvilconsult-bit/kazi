"""Kazi agent runtime (docs/05-AGENT-SPEC.md), the Python counterpart of ``@kazi/agent-sdk``.

Your handler receives the task and returns ``{"text": ...}`` and/or ``{"files": [...]}``. The runtime
verifies Kazi's signature, validates the request, de-duplicates retries, and — for async agents —
answers ``202`` at once and posts the result to Kazi's callback URL, signed with your secret.
"""

from __future__ import annotations

import json
import re
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Callable, Dict, List, Mapping, Optional, Tuple

from .signature import IDEMPOTENCY_HEADER, SIGNATURE_HEADER, SUBTASK_ID_HEADER, sign_payload, verify_signature

Json = Dict[str, Any]
#: Same rule as capabilitySlugSchema in packages/shared/src/capabilities.ts.
_CAPABILITY = re.compile(r"^[a-z]+\.[a-z0-9_]+(-[a-z0-9_]+)?$")
_DECIMAL = re.compile(r"^\d+(\.\d+)?$")


class AgentFailure(Exception):
    """Raise (or call ``ctx.fail``) to report a clean failure with your own error code."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass
class AgentContext:
    request: Json
    _progress: Callable[[float, Optional[str]], None]

    def progress(self, fraction: float, message: Optional[str] = None) -> None:
        """Report progress (async agents only; ignored in sync mode)."""
        self._progress(min(1.0, max(0.0, fraction)), message)

    def fail(self, code: str, message: str) -> None:
        raise AgentFailure(code, message)

    @property
    def deadline(self) -> datetime:
        return datetime.fromisoformat(self.request["deadline"].replace("Z", "+00:00"))


Handler = Callable[[AgentContext], Json]


def _failed(code: str, message: str) -> Json:
    return {"status": "failed", "error": {"code": code, "message": message[:2000]}}


def validate_request(body: Any) -> Optional[str]:
    """None when ``body`` is a valid Kazi agent request, else a short reason."""
    if not isinstance(body, dict):
        return "body must be a JSON object"
    for key, kind in (("subtaskId", str), ("capability", str), ("instructions", str), ("deadline", str), ("callbackUrl", str), ("budget", str)):
        if not isinstance(body.get(key), kind) or not body[key]:
            return f"{key} is required"
    if not isinstance(body.get("attempt"), int) or body["attempt"] < 1:
        return "attempt must be a positive integer"
    if len(body["capability"]) > 64 or not _CAPABILITY.match(body["capability"]):
        return "capability is malformed"
    if not _DECIMAL.match(body["budget"]):
        return "budget must be a decimal string"
    inp = body.get("input")
    if not isinstance(inp, dict) or (inp.get("text") is None and not inp.get("files")):
        return "input needs text or files"
    if not isinstance(body.get("acceptance"), dict):
        return "acceptance is required"
    return None


def validate_output(output: Any) -> Optional[str]:
    if not isinstance(output, dict):
        return "the handler must return a dict"
    text, files = output.get("text"), output.get("files")
    if text is None and not files:
        return "output needs text or files"
    if text is not None and not isinstance(text, str):
        return "text must be a string"
    if files is not None and (not isinstance(files, list) or len(files) > 50):
        return "files must be a list of at most 50 file references"
    return None


@dataclass
class IdempotencyStore:
    """In-memory store keyed by Kazi's idempotency key (use a shared store when running several replicas)."""

    ttl_sec: int = 24 * 3600
    _items: Dict[str, Tuple[float, Any]] = field(default_factory=dict)
    _lock: threading.Lock = field(default_factory=threading.Lock)

    def claim(self, key: str) -> bool:
        with self._lock:
            now = time.time()
            self._items = {k: v for k, v in self._items.items() if v[0] > now}
            if key in self._items:
                return False
            self._items[key] = (now + self.ttl_sec, "PENDING")
            return True

    def get(self, key: str) -> Any:
        with self._lock:
            item = self._items.get(key)
            return item[1] if item else None

    def complete(self, key: str, response: Json) -> None:
        with self._lock:
            self._items[key] = (time.time() + self.ttl_sec, response)


class KaziAgent:
    """One agent: its manifest (``mode`` "sync" or "async"), webhook secret and handler."""

    def __init__(
        self,
        manifest: Json,
        secret: str,
        handler: Handler,
        store: Optional[IdempotencyStore] = None,
        on_error: Optional[Callable[[BaseException, Optional[Json]], None]] = None,
        post: Optional[Callable[[str, bytes, Mapping[str, str]], int]] = None,
    ) -> None:
        if manifest.get("mode") not in ("sync", "async"):
            raise ValueError('manifest["mode"] must be "sync" or "async"')
        self.manifest = manifest
        self._secret = secret
        self._handler = handler
        self._store = store or IdempotencyStore()
        self._on_error = on_error
        self._post = post or _http_post
        self._threads: List[threading.Thread] = []

    # ── HTTP entry point ──────────────────────────────────────────────────────
    def handle(self, method: str, path: str, headers: Mapping[str, str], raw_body: str) -> Tuple[int, Json]:
        """Route one HTTP request; returns (status, JSON body). Header names are case-insensitive."""
        h = {k.lower(): v for k, v in headers.items()}
        if method == "GET" and path.endswith("/health"):
            return 200, {"ok": True}
        if method == "GET" and path.endswith("/.well-known/kazi-agent.json"):
            return 200, self.manifest
        if method != "POST":
            return 405, _failed("METHOD_NOT_ALLOWED", "use POST")

        sig = verify_signature(raw_body, h.get(SIGNATURE_HEADER), self._secret)
        if not sig.ok:
            return 401, _failed("BAD_SIGNATURE", f"signature {str(sig.reason).lower()}")
        try:
            request = json.loads(raw_body)
        except ValueError:
            return 400, _failed("INVALID_REQUEST", "body is not JSON")
        problem = validate_request(request)
        if problem:
            return 400, _failed("INVALID_REQUEST", problem)
        if request["capability"] not in self.manifest.get("capabilities", []):
            return 422, _failed("UNSUPPORTED_CAPABILITY", f"this agent does not offer {request['capability']}")

        key = h.get(IDEMPOTENCY_HEADER) or f"{request['subtaskId']}:{request['attempt']}"
        async_mode = self.manifest["mode"] == "async"
        if not self._store.claim(key):
            prior = self._store.get(key)
            if prior in (None, "PENDING"):
                return (202, {"status": "accepted"}) if async_mode else (409, _failed("IN_PROGRESS", "this job is already running"))
            return (202, {"status": "accepted"}) if async_mode else (200, prior)

        if not async_mode:
            response = self._execute(request, False)
            self._store.complete(key, response)
            return 200, response

        def job() -> None:
            response = self._execute(request, True)
            self._store.complete(key, response)
            callback = {"status": "completed", "output": response["output"]} if response["status"] == "completed" else {"status": "failed", "error": response["error"]}
            self._callback(request, callback)

        t = threading.Thread(target=job, daemon=True)
        self._threads.append(t)
        t.start()
        return 202, {"status": "accepted"}

    def idle(self, timeout: float = 30.0) -> None:
        """Wait for background (async) jobs — handy in tests."""
        for t in list(self._threads):
            t.join(timeout)
        self._threads = [t for t in self._threads if t.is_alive()]

    # ── Internals ─────────────────────────────────────────────────────────────
    def _execute(self, request: Json, async_mode: bool) -> Json:
        def progress(fraction: float, message: Optional[str]) -> None:
            if async_mode:
                body: Json = {"status": "progress", "progress": fraction}
                if message:
                    body["message"] = message[:500]
                self._callback(request, body)

        ctx = AgentContext(request=request, _progress=progress)
        try:
            output = self._handler(ctx)
        except AgentFailure as f:
            return _failed(f.code, f.message)
        except Exception as err:  # noqa: BLE001 — anything else is the agent's bug, reported generically
            if self._on_error:
                self._on_error(err, request)
            return _failed("INTERNAL", "the agent hit an unexpected error")
        problem = validate_output(output)
        if problem:
            return _failed("OUTPUT_INVALID", problem)
        return {"status": "completed", "output": output}

    def _callback(self, request: Json, body: Json) -> None:
        raw = json.dumps(body, separators=(",", ":"), ensure_ascii=False)
        headers = {"content-type": "application/json", SIGNATURE_HEADER: sign_payload(raw, self._secret), SUBTASK_ID_HEADER: request["subtaskId"]}
        for attempt in range(1, 6):
            try:
                status = self._post(request["callbackUrl"], raw.encode("utf-8"), headers)
                if status < 300 or (400 <= status < 500 and status != 429):
                    return
            except OSError as err:
                if attempt == 5 and self._on_error:
                    self._on_error(err, request)
            time.sleep(0.5 * 2**attempt)


def _http_post(url: str, body: bytes, headers: Mapping[str, str]) -> int:
    req = urllib.request.Request(url, data=body, headers=dict(headers), method="POST")
    try:
        with urllib.request.urlopen(req, timeout=30) as res:  # noqa: S310 — Kazi's callback URL from a signed request
            return int(res.status)
    except urllib.error.HTTPError as err:
        return int(err.code)
