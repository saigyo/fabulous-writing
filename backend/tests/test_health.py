from pathlib import Path

from fastapi.testclient import TestClient

from app.core.config import Settings
from app.main import create_app


def test_health_returns_ok(tmp_path: Path) -> None:
    # A bare create_app() would build against the default (real) db_path —
    # forbidden for tests, and now also side-effect-heavy (it seeds the
    # admin account). Every other app_client fixture in this suite passes
    # tmp_path settings for the same reason; this test just does it inline
    # since it needs no other fixtures.
    settings = Settings(db_path=tmp_path / "test.db", rules_dir=tmp_path / "rules")
    client = TestClient(create_app(settings))
    response = client.get("/api/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok", "name": "Fabulous Writing"}
