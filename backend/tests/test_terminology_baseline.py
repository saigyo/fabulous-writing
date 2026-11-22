import json
import os
from pathlib import Path

from fastapi.testclient import TestClient

from app.core.config import Settings
from app.core.models import Language
from app.main import create_app
from tests.conftest import auth_headers
from tests.terminology_baseline import (
    BASELINE_DOMAINS,
    BASELINE_TEXTS,
    GOLDEN_PATH,
    load_golden,
    normalise,
)


def _client(tmp_path: Path) -> TestClient:
    settings = Settings(
        db_path=tmp_path / "test.db",
        rules_dir=tmp_path / "rules",
        seed_terminology=False,
    )
    client = TestClient(create_app(settings))
    client.headers.update(auth_headers(client))
    return client


def _create_through_api(client: TestClient) -> dict[str, int]:
    ids: dict[str, int] = {}
    for domain in BASELINE_DOMAINS:
        created = client.post("/api/domains", json={"name": domain.name})
        assert created.status_code == 201
        ids[domain.name] = created.json()["id"]
        for term in domain.terms:
            response = client.post(
                f"/api/domains/{ids[domain.name]}/terms",
                json={
                    "language": term.language.value,
                    "preferred": term.preferred,
                    "forbidden_variants": term.forbidden_variants,
                    "definition": term.definition,
                    "case_sensitive": term.case_sensitive,
                },
            )
            assert response.status_code == 201
    return ids


def test_api_path_matches_golden(tmp_path: Path) -> None:
    client = _client(tmp_path)
    ids = _create_through_api(client)
    actual = {
        f"{d.name}/{language.value}": normalise(
            client.post(
                "/api/checks",
                json={
                    "text": BASELINE_TEXTS[language],
                    "language": language.value,
                    "domain_ids": [ids[d.name]],
                    "checkers": ["terminology"],
                },
            ).json()["findings"]
        )
        for d in BASELINE_DOMAINS
        for language in Language
    }
    if os.environ.get("FW_UPDATE_TERMINOLOGY_BASELINE"):
        GOLDEN_PATH.write_text(
            json.dumps(actual, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
    assert actual == load_golden()
