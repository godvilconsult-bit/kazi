"""Kazi agent SDK for Python (docs/05-AGENT-SPEC.md). Stdlib only."""

from .agent import AgentContext, AgentFailure, IdempotencyStore, KaziAgent, validate_output, validate_request
from .server import make_server, serve
from .signature import (
    IDEMPOTENCY_HEADER,
    SIGNATURE_HEADER,
    SIGNATURE_TOLERANCE_SECONDS,
    SUBTASK_ID_HEADER,
    VerifyResult,
    sign_payload,
    verify_signature,
)

__all__ = [
    "AgentContext",
    "AgentFailure",
    "IdempotencyStore",
    "KaziAgent",
    "make_server",
    "serve",
    "sign_payload",
    "verify_signature",
    "validate_output",
    "validate_request",
    "VerifyResult",
    "SIGNATURE_HEADER",
    "SUBTASK_ID_HEADER",
    "IDEMPOTENCY_HEADER",
    "SIGNATURE_TOLERANCE_SECONDS",
]
__version__ = "0.1.0"
