"""Run the synthetic evaluation set against a live /analyze endpoint.

This is a manual evaluation helper, not part of the automated test suite.
It spends a small amount of OpenAI credit for each sample.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import httpx
from dotenv import load_dotenv


ROOT = Path(__file__).resolve().parents[1]
SAMPLES_DIR = ROOT / "samples"
CATALOG_PATH = SAMPLES_DIR / "catalog.json"
DEFAULT_URL = "https://email-risk-analyzer.fastapicloud.dev/analyze"


def load_catalog() -> list[dict]:
    return json.loads(CATALOG_PATH.read_text())


def load_email(filename: str) -> dict:
    return json.loads((SAMPLES_DIR / filename).read_text())


def main() -> int:
    load_dotenv(Path(__file__).with_name(".env"))
    token = os.environ.get("ADDON_API_TOKEN")
    if not token:
        print("ADDON_API_TOKEN is not configured in backend/.env")
        return 1

    url = os.environ.get("ANALYZE_URL", DEFAULT_URL)
    catalog = load_catalog()
    rows: list[dict] = []

    print(f"Evaluating {len(catalog)} samples against {url}\n")

    with httpx.Client(timeout=45.0) as client:
        for case in catalog:
            email = load_email(case["file"])
            response = client.post(
                url,
                json=email,
                headers={"X-Addon-Token": token},
            )
            payload = response.json()
            actual = payload.get("verdict", f"HTTP {response.status_code}")
            matched = actual == case["expected_verdict"]
            rows.append(
                {
                    "id": case["id"],
                    "expected": case["expected_verdict"],
                    "actual": actual,
                    "score": payload.get("risk_score"),
                    "matched": matched,
                    "explanation": payload.get("explanation"),
                    "limitations": payload.get("limitations"),
                    "error": None if response.status_code == 200 else payload,
                }
            )
            mark = "match" if matched else "different"
            print(
                f"{case['id']}: expected {case['expected_verdict']}, "
                f"got {actual} ({payload.get('risk_score')}) [{mark}]"
            )

    output_path = SAMPLES_DIR / "evaluation-results.json"
    output_path.write_text(json.dumps(rows, indent=2) + "\n")
    print(f"\nWrote {output_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
