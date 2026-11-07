import json
import os
from pathlib import Path
from types import SimpleNamespace

os.environ["OPENAI_API_KEY"] = "test-openai-key"
os.environ["ADDON_API_TOKEN"] = "test-addon-token"

from fastapi.testclient import TestClient

import main

SAMPLES_DIR = Path(__file__).resolve().parents[2] / "samples"


client = TestClient(main.app)
VALID_EMAIL = {
    "subject": "Project meeting",
    "sender": "sender@example.com",
    "reply_to": "sender@example.com",
    "body": "The meeting starts at 10:30.",
    "links": [],
}
AUTH_HEADERS = {"X-Addon-Token": "test-addon-token"}


class FakeResponses:
    def __init__(self, parsed=None, error=None):
        self.parsed = parsed
        self.error = error
        self.calls = []

    def parse(self, **kwargs):
        self.calls.append(kwargs)
        if self.error:
            raise self.error
        return SimpleNamespace(output_parsed=self.parsed)


def install_fake_client(monkeypatch, *, parsed=None, error=None):
    responses = FakeResponses(parsed=parsed, error=error)
    monkeypatch.setattr(
        main,
        "openai_client",
        SimpleNamespace(responses=responses),
    )
    return responses


def test_health_endpoint():
    response = client.get("/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_analyze_rejects_missing_token(monkeypatch):
    responses = install_fake_client(monkeypatch)

    response = client.post("/analyze", json=VALID_EMAIL)

    assert response.status_code == 401
    assert response.json() == {"detail": "Unauthorized."}
    assert responses.calls == []


def test_analyze_rejects_wrong_token(monkeypatch):
    responses = install_fake_client(monkeypatch)

    response = client.post(
        "/analyze",
        json=VALID_EMAIL,
        headers={"X-Addon-Token": "wrong-token"},
    )

    assert response.status_code == 401
    assert responses.calls == []


def test_analyze_returns_structured_assessment(monkeypatch):
    assessment = main.EmailAssessment(
        risk_score=12,
        verdict="Low risk",
        explanation="The message contains a routine scheduling update.",
        evidence=["The sender and reply-to addresses match."],
        limitations=["The sender identity was not independently verified."],
    )
    responses = install_fake_client(monkeypatch, parsed=assessment)

    response = client.post(
        "/analyze",
        json=VALID_EMAIL,
        headers=AUTH_HEADERS,
    )

    assert response.status_code == 200
    assert response.json() == assessment.model_dump()
    assert len(responses.calls) == 1
    request = responses.calls[0]
    assert request["model"] == "gpt-6-luna"
    assert request["text_format"] is main.EmailAssessment
    assert request["store"] is False
    assert "untrusted evidence" in request["input"]


def test_analyze_returns_unavailable_on_provider_failure(monkeypatch):
    install_fake_client(
        monkeypatch,
        error=RuntimeError("simulated provider failure"),
    )

    response = client.post(
        "/analyze",
        json=VALID_EMAIL,
        headers=AUTH_HEADERS,
    )

    assert response.status_code == 502
    assert response.json() == {"detail": "Email analysis unavailable."}
    assert "risk_score" not in response.json()


def test_analyze_returns_unavailable_without_structured_output(monkeypatch):
    install_fake_client(monkeypatch, parsed=None)

    response = client.post(
        "/analyze",
        json=VALID_EMAIL,
        headers=AUTH_HEADERS,
    )

    assert response.status_code == 502
    assert response.json() == {"detail": "Email analysis unavailable."}


def test_analyze_rejects_oversized_body(monkeypatch):
    responses = install_fake_client(monkeypatch)
    oversized_email = {**VALID_EMAIL, "body": "x" * 20_001}

    response = client.post(
        "/analyze",
        json=oversized_email,
        headers=AUTH_HEADERS,
    )

    assert response.status_code == 422
    assert responses.calls == []


def test_analyze_returns_unavailable_on_timeout(monkeypatch):
    install_fake_client(monkeypatch, error=TimeoutError("simulated timeout"))

    response = client.post(
        "/analyze",
        json=VALID_EMAIL,
        headers=AUTH_HEADERS,
    )

    assert response.status_code == 502
    assert response.json() == {"detail": "Email analysis unavailable."}


def test_analyze_returns_unavailable_without_openai_client(monkeypatch):
    monkeypatch.setattr(main, "openai_client", None)

    response = client.post(
        "/analyze",
        json=VALID_EMAIL,
        headers=AUTH_HEADERS,
    )

    assert response.status_code == 503
    assert response.json() == {"detail": "Service unavailable."}


def test_evaluation_samples_match_email_schema():
    catalog = json.loads((SAMPLES_DIR / "catalog.json").read_text())

    assert catalog
    for case in catalog:
        payload = json.loads((SAMPLES_DIR / case["file"]).read_text())
        email = main.EmailInput.model_validate(payload)
        assert email.subject
        assert email.sender
        assert email.body
