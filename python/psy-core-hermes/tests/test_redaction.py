"""Regex redactor parity with src/redactor.ts."""

from __future__ import annotations

from pathlib import Path

import pytest

from psy_core.hermes.redaction import redact_payload, redact_text, resolve_redactor


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


@pytest.mark.parametrize(
        ("content", "marker"),
        [
            ("google=AIza" + "C" * 24, "REDACTED-google-key"),
            ("pat=github_pat_" + "D" * 24, "REDACTED-github-pat"),
            ("git auth ghp_" + "E" * 24, "REDACTED-github-token"),
            ("password = hunter2", "REDACTED-secret"),
        ],
    )
def test_additional_default_secret_patterns_redact(content: str, marker: str) -> None:
    assert marker in redact_text(content)


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


def test_resolve_redactor_default_and_none() -> None:
    assert resolve_redactor("default") is redact_payload
    assert resolve_redactor("none") is None


def test_resolve_redactor_imports_custom_callable(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    module = tmp_path / "custom_redactor.py"
    module.write_text(
        "def redact(value):\n"
        "    return {'custom': value}\n",
        encoding="utf-8",
    )
    monkeypatch.syspath_prepend(str(tmp_path))

    redactor = resolve_redactor("custom_redactor.redact")

    assert redactor({"secret": "value"}) == {"custom": {"secret": "value"}}
