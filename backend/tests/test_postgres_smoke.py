"""End-to-end PG-mode smoke (spec §R7): one app, real Postgres, exercising
login, a CRUD round-trip, and one metered check. The full API matrix
deliberately stays SQLite-only."""

import json
import os
import uuid
from collections.abc import Iterator
from pathlib import Path

import psycopg
import pytest
from fastapi.testclient import TestClient

from app.checkers.llm.provider import FakeProvider, TokenUsage
from app.core.config import Settings
from app.main import create_app
from tests.conftest import auth_headers

pytestmark = pytest.mark.skipif(
    not os.environ.get("FW_TEST_DATABASE_URL", "").strip(),
    reason="FW_TEST_DATABASE_URL not set",
)

TEXT = "The results were very good. We move on."


@pytest.fixture()
def pg_client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    """A TestClient whose app runs entirely on a throwaway Postgres schema.

    Same admin-connection create/drop pattern as conftest's pg_database, but
    NOT that fixture: the app builds its own PostgresDatabase through
    create_database, which reads FW_DATABASE_URL from the environment, so
    the schema-scoped DSN is monkeypatched in before create_app() runs.
    Context-managed TestClient so the lifespan's pool-close on shutdown
    actually runs (otherwise the pool leaks and pytest's zero-warnings gate
    trips on a ResourceWarning).
    """
    base_dsn = os.environ["FW_TEST_DATABASE_URL"].strip()
    schema = f"fw_smoke_{uuid.uuid4().hex[:12]}"
    with psycopg.connect(base_dsn, autocommit=True) as admin:
        admin.execute(f'CREATE SCHEMA "{schema}"')
    sep = "&" if "?" in base_dsn else "?"
    dsn = f"{base_dsn}{sep}options=-csearch_path%3D{schema}"
    monkeypatch.setenv("FW_DATABASE_URL", dsn)
    settings = Settings(
        db_path=tmp_path / "test.db",
        rules_dir=tmp_path / "rules",
        database={"backend": "postgres"},
    )
    try:
        with TestClient(create_app(settings)) as client:
            client.headers.update(auth_headers(client))
            yield client
    finally:
        with psycopg.connect(base_dsn, autocommit=True) as admin:
            admin.execute(f'DROP SCHEMA "{schema}" CASCADE')


def test_login_crud_and_metered_check_on_postgres(pg_client: TestClient) -> None:
    # auth_headers() (in the fixture above) already proved login: it logged
    # in for real over /api/auth/login and every request below carries that
    # bearer token.
    folder = pg_client.post("/api/folders", json={"name": "Reports"})
    assert folder.status_code == 201
    folder_id = folder.json()["id"]

    created = pg_client.post(
        "/api/documents",
        json={
            "name": "Smoke Doc",
            "language": "en",
            "text": TEXT,
            "folder_id": folder_id,
        },
    )
    assert created.status_code == 201
    doc = created.json()
    assert doc["name"] == "Smoke Doc"
    assert doc["folder_id"] == folder_id

    fetched = pg_client.get(f"/api/documents/{doc['id']}")
    assert fetched.status_code == 200
    body = fetched.json()
    assert body["text"] == TEXT
    assert body["folder_id"] == folder_id

    # Provider-injection setup lifted unchanged from
    # test_suggestions_api.py's make_client (FakeProvider swapped in via
    # app.state.provider_factory) -- one metered LLM run through the real
    # gate/ledger path, exercised here against Postgres instead of SQLite.
    pg_client.app.state.provider_factory = lambda name=None, model=None: FakeProvider(
        json.dumps(["excellent"]),
        usage=TokenUsage(input_tokens=40, output_tokens=6),
    )
    suggestion = pg_client.post(
        "/api/suggestions",
        json={
            "text": TEXT,
            "span": {"start": 17, "end": 26},
            "message": "'very good' is vague praise.",
            "language": "en",
        },
    )
    assert suggestion.status_code == 200
    assert suggestion.json()["suggestions"] == ["excellent"]

    # Unlike the SQLite tests (which open db_path directly), the ledger is
    # read through the app's own database -- opening a SQLite file here
    # would create an empty stray file and fail with "no such table".
    with pg_client.app.state.usage_store.db.connect() as conn:
        rows = conn.execute("SELECT * FROM llm_usage ORDER BY id").fetchall()
    assert len(rows) == 1
    assert rows[0]["status"] == "completed"
