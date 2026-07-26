import sqlite3
from pathlib import Path

import pytest
from pydantic import ValidationError
from fastapi.testclient import TestClient

from app.core.auth import AuthConfigError
from app.core.config import AuthSettings, Settings
from app.main import create_app

DOC_ENDPOINTS = ("/docs", "/redoc", "/openapi.json")


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


def test_create_app_refuses_supabase_mode_before_writing_user_tables(tmp_path: Path) -> None:
    """auth.mode != 'local' must fail closed before UserStore ever touches
    the database, not just before an admin gets seeded into it. Merely
    asserting the exception would also pass with UserStore constructed
    ahead of the guard: the `users`/`admin_audit` tables would already
    exist by the time the check ran, they would just stay empty. Other
    stores (terminology, documents, folders, profiles) legitimately create
    the db file itself regardless of auth mode, so the file existing is
    not the signal — the absence of the auth-owned tables is.
    """
    db_path = tmp_path / "test.db"
    settings = Settings(
        db_path=db_path, rules_dir=tmp_path / "rules", auth=AuthSettings(mode="supabase")
    )
    with pytest.raises(AuthConfigError, match="supabase"):
        create_app(settings)
    conn = sqlite3.connect(db_path)
    try:
        tables = {
            row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
        }
    finally:
        conn.close()
    assert "users" not in tables
    assert "admin_audit" not in tables


def test_cors_allows_only_the_configured_origin(tmp_path):
    # A deliberately NON-default origin. Testing with the default
    # http://localhost:5173 would pass against an implementation that simply
    # hard-codes that string in place of "*" and never reads settings.cors —
    # which is the entire point of this task.
    configured = "https://writing.example.test"
    settings = Settings(
        db_path=tmp_path / "test.db",
        rules_dir=tmp_path / "rules",
        cors={"origins": [configured]},
    )
    client = TestClient(create_app(settings))

    def preflight(origin: str):
        return client.options(
            "/api/health",
            headers={"Origin": origin, "Access-Control-Request-Method": "GET"},
        )

    assert preflight(configured).headers["access-control-allow-origin"] == configured
    # The default is denied when it is not the configured value — this is the
    # assertion a hard-coded implementation fails.
    assert "access-control-allow-origin" not in preflight("http://localhost:5173").headers
    assert "access-control-allow-origin" not in preflight("https://evil.example.com").headers


def test_environment_defaults_to_production(tmp_path: Path) -> None:
    # The security-relevant behaviour: a Settings built with no explicit
    # environment must fail closed (docs off), not silently favour dev. A
    # future refactor that flips this default must fail this assertion loudly.
    settings = Settings(db_path=tmp_path / "test.db", rules_dir=tmp_path / "rules")
    assert settings.environment == "production"


def test_environment_rejects_invalid_value(tmp_path: Path) -> None:
    with pytest.raises(ValidationError):
        Settings(
            db_path=tmp_path / "test.db",
            rules_dir=tmp_path / "rules",
            environment="prod",  # not one of the three permitted values
        )


def test_docs_endpoints_reachable_in_dev(tmp_path: Path) -> None:
    settings = Settings(
        db_path=tmp_path / "test.db", rules_dir=tmp_path / "rules", environment="dev"
    )
    client = TestClient(create_app(settings))
    for path in DOC_ENDPOINTS:
        response = client.get(path)
        assert response.status_code == 200, f"{path} returned {response.status_code} in dev"


@pytest.mark.parametrize("environment", ["staging", "production"])
def test_docs_endpoints_not_registered_outside_dev(tmp_path: Path, environment: str) -> None:
    settings = Settings(
        db_path=tmp_path / "test.db", rules_dir=tmp_path / "rules", environment=environment
    )
    client = TestClient(create_app(settings))
    for path in DOC_ENDPOINTS:
        response = client.get(path)
        assert response.status_code == 404, (
            f"{path} returned {response.status_code} in {environment!r}, expected 404 "
            "-- the route must not be registered at all outside dev"
        )
