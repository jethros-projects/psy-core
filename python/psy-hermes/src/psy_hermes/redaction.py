"""Python-side regex redaction.

Mirrors `src/redactor.ts` defaults so the same patterns are caught before
the payload crosses the stdio boundary into the Node ingest subprocess.
The TypeScript side runs an equivalent tier on its end (defense in depth).

Order matters: the Anthropic key pattern must fire before the broader
OpenAI pattern, otherwise `sk-ant-...` would be mislabeled.
"""

from __future__ import annotations

import re
from collections.abc import Callable
from typing import Any

#: (pattern, replacement) tuples. Order is significant.
DEFAULT_PATTERNS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"\bsk-ant-[A-Za-z0-9_-]{16,}\b"), "[REDACTED-anthropic-key]"),
    (re.compile(r"\bsk-[A-Za-z0-9][A-Za-z0-9_-]{16,}\b"), "[REDACTED-openai-key]"),
    (re.compile(r"\bAKIA[0-9A-Z]{16}\b"), "[REDACTED-aws-access-key]"),
    (re.compile(r"\bAIza[0-9A-Za-z_-]{20,}\b"), "[REDACTED-google-key]"),
    (re.compile(r"\bgithub_pat_[A-Za-z0-9_]{20,}\b"), "[REDACTED-github-pat]"),
    (re.compile(r"\bgh[pousr]_[A-Za-z0-9_]{20,}\b"), "[REDACTED-github-token]"),
    (re.compile(r"\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b"), "Bearer [REDACTED-token]"),
    (
        re.compile(r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b"),
        "[REDACTED-jwt]",
    ),
    (
        re.compile(
            r"-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]+?-----END [A-Z ]+PRIVATE KEY-----",
        ),
        "[REDACTED-pem-private-key]",
    ),
    (
        re.compile(
            r"""(?ix)
            (
              ["']?
              (?:api[_-]?key|secret|token|password|authorization)
              ["']?
              \s*[:=]\s*
              ["']?
            )
            [^"',\s}]+
            """,
        ),
        r"\1[REDACTED-secret]",
    ),
]


def redact_text(content: str, patterns: list[tuple[re.Pattern[str], str]] | None = None) -> str:
    """Apply each pattern to `content` in order, returning the redacted text."""
    next_value = content
    for pattern, replacement in patterns or DEFAULT_PATTERNS:
        next_value = pattern.sub(replacement, next_value)
    return next_value


def redact_payload(payload: Any, patterns: list[tuple[re.Pattern[str], str]] | None = None) -> Any:
    """Recursively redact every string inside a JSON-shaped payload.

    Mirrors the TS-side `redactInPlace` behavior so a payload that is
    redacted on the Python side can travel intact through ingest without
    triggering further changes server-side.
    """
    if isinstance(payload, str):
        return redact_text(payload, patterns)
    if isinstance(payload, list):
        return [redact_payload(item, patterns) for item in payload]
    if isinstance(payload, dict):
        return {key: redact_payload(value, patterns) for key, value in payload.items()}
    return payload


Redactor = Callable[[Any], Any]


def resolve_redactor(name: str) -> Redactor | None:
    """Resolve a redactor name into a callable (or `None` for opt-out).

    `default` (the default) returns the regex tier; `none` disables Python-
    side redaction (server-side still runs unless `--no-redact` is set on
    the ingest binary). Anything else is treated as a Python dotted path
    `module.attr` and imported lazily; this keeps the surface ergonomic
    without paying an import cost on common configs.
    """
    if name == "default":
        return redact_payload
    if name == "none":
        return None
    # Custom dotted path: import lazily.
    module_path, _, attr = name.rpartition(".")
    if not module_path or not attr:
        raise ValueError(f"redactor must be 'default', 'none', or a dotted path; got {name!r}")
    import importlib

    module = importlib.import_module(module_path)
    redactor = getattr(module, attr)
    if not callable(redactor):
        raise TypeError(f"redactor {name!r} is not callable")
    return redactor
