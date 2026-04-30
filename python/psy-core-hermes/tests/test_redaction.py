"""Regex redactor parity with src/redactor.ts."""

from __future__ import annotations

from psy_core.hermes.redaction import redact_payload, redact_text


def test_anthropic_key_takes_priority_over_openai_pattern() -> None:
    secret = "sk-ant-" + "A" * 32
    out = redact_text(f"key={secret} more")
    assert "REDACTED-anthropic-key" in out
    assert "REDACTED-openai-key" not in out


def test_openai_key_redacts() -> None:
    secret = "sk-" + "A" * 24
    out = redact_text(f"key={secret}")
    assert "REDACTED-openai-key" in out


def test_aws_access_key_redacts() -> None:
    out = redact_text("aws=AKIA" + "B" * 16)
    assert "REDACTED-aws-access-key" in out


def test_bearer_token_redacts() -> None:
    out = redact_text("Authorization: Bearer abc.def_GHI-jkl_mnopqr")
    assert "[REDACTED-token]" in out


def test_jwt_redacts() -> None:
    jwt = "eyJ" + "x" * 12 + "." + "x" * 12 + "." + "x" * 12
    out = redact_text(jwt)
    assert "[REDACTED-jwt]" in out


def test_pem_block_redacts() -> None:
    pem = (
        "-----BEGIN RSA PRIVATE KEY-----\nABCDEF123\n-----END RSA PRIVATE KEY-----"
    )
    out = redact_text(pem)
    assert "[REDACTED-pem-private-key]" in out


def test_redact_payload_walks_nested_strings_and_lists() -> None:
    payload = {
        "args": {"text": "sk-ant-" + "X" * 40},
        "history": ["plain", "Bearer abcdefghijklmnopqrstuv"],
    }
    out = redact_payload(payload)
    assert isinstance(out, dict)
    assert "REDACTED-anthropic-key" in out["args"]["text"]
    assert "[REDACTED-token]" in out["history"][1]


def test_redact_payload_passes_non_strings_through_unchanged() -> None:
    payload = {"count": 7, "ok": True, "ratio": 0.5, "missing": None}
    assert redact_payload(payload) == payload
