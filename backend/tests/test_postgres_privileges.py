"""Privilege-boundary tests for the DML-only app role (B36 spec R6).

A throwaway LOGIN role (unique name: roles are cluster-wide and tests run
in parallel) mirrors the fabwriting_app grant recipe on a throwaway
schema. The real fabwriting_app role is never touched."""

import os
import secrets
import uuid
from collections.abc import Iterator
from urllib.parse import urlsplit

import psycopg
import pytest
from fastapi.testclient import TestClient

from app.core.config import Settings
from app.main import create_app
from app.schema import init_stores
from app.services.db.postgres import PostgresDatabase
from app.services.documents import DocumentStore
from tests.conftest import auth_headers

pytestmark = pytest.mark.skipif(
    not os.environ.get("FW_TEST_DATABASE_URL", "").strip(),
    reason="FW_TEST_DATABASE_URL not set",
)


class Restricted:
    def __init__(self, base_dsn, schema, role, admin_dsn, restricted_dsn):
        self.base_dsn = base_dsn
        self.schema = schema
        self.role = role
        self.admin_dsn = admin_dsn
        self.restricted_dsn = restricted_dsn


def _swap_userinfo(base_dsn: str, user: str, password: str) -> str:
    parts = urlsplit(base_dsn)
    host = parts.hostname or ""
    port = f":{parts.port}" if parts.port else ""
    netloc = f"{user}:{password}@{host}{port}"
    rebuilt = f"{parts.scheme}://{netloc}{parts.path}"
    return rebuilt + (f"?{parts.query}" if parts.query else "")


@pytest.fixture()
def restricted() -> Iterator[Restricted]:
    base_dsn = os.environ["FW_TEST_DATABASE_URL"].strip()
    schema = f"fw_priv_{uuid.uuid4().hex[:12]}"
    role = f"fw_test_role_{uuid.uuid4().hex[:12]}"
    password = secrets.token_urlsafe(16)
    sep = "&" if "?" in base_dsn else "?"
    admin_dsn = f"{base_dsn}{sep}options=-csearch_path%3D{schema}"
    with psycopg.connect(base_dsn, autocommit=True) as admin:
        admin.execute(f'CREATE SCHEMA "{schema}"')
        # Mirrors supabase/migrations/20260817090100_app_role_grants.sql,
        # scoped to the throwaway schema -- and, crucially, applied to the
        # SCHEMA BEFORE init_stores() creates any table in it, matching
        # production order (`db push` grants an empty schema, `init-db`
        # creates tables afterwards under the admin role). In that order an
        # `ON ALL TABLES` grant would match nothing; only the
        # `ALTER DEFAULT PRIVILEGES` clauses make the schema usable, so
        # those -- not a superseded post-hoc grant -- are what this fixture
        # must exercise.
        admin.execute(
            f'CREATE ROLE "{role}" LOGIN NOINHERIT NOBYPASSRLS '
            f"PASSWORD '{password}'"
        )
        admin.execute(f'GRANT USAGE ON SCHEMA "{schema}" TO "{role}"')
        admin.execute(
            f'ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA "{schema}" '
            f'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "{role}"'
        )
        admin.execute(
            f'ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA "{schema}" '
            f'GRANT USAGE, SELECT ON SEQUENCES TO "{role}"'
        )
    db = PostgresDatabase(admin_dsn)
    try:
        init_stores(db)  # admin (postgres) creates the tables, as init-db
        # would -- AFTER the default-privilege grants above, so the tables
        # land already usable to `role` without any per-table grant.
    finally:
        db.close()
    base_restricted = _swap_userinfo(base_dsn, role, password)
    sep2 = "&" if "?" in base_restricted else "?"
    restricted_dsn = f"{base_restricted}{sep2}options=-csearch_path%3D{schema}"
    yield Restricted(base_dsn, schema, role, admin_dsn, restricted_dsn)
    # Teardown discipline: the role is CLUSTER-WIDE — always ATTEMPT
    # DROP ROLE even if the schema drop raises (if the schema drop failed,
    # its surviving grants may still block the role drop, but the attempt
    # costs nothing and covers every schema-side success). No DROP OWNED
    # BY: it requires the role's own privileges, which the non-superuser
    # local `postgres` lacks (permission denied, probed); DROP SCHEMA
    # CASCADE already removes every grant this fixture made.
    with psycopg.connect(base_dsn, autocommit=True) as admin:
        try:
            admin.execute(f'DROP SCHEMA "{schema}" CASCADE')
        finally:
            admin.execute(f'DROP ROLE "{role}"')


def test_api_smoke_under_restricted_role(restricted, tmp_path, monkeypatch):
    monkeypatch.setenv("FW_DATABASE_URL", restricted.restricted_dsn)
    settings = Settings(
        db_path=tmp_path / "unused.db",
        rules_dir=tmp_path / "rules",
        database={"backend": "postgres", "manage_schema": False},
    )
    with TestClient(create_app(settings)) as client:
        client.headers.update(auth_headers(client))
        created = client.post(
            "/api/documents",
            json={"name": "b36 doc", "language": "en", "text": "hello"},
        )
        assert created.status_code == 201, created.text
        listed = client.get("/api/documents")
        assert listed.status_code == 200
        assert any(d["name"] == "b36 doc" for d in listed.json())
        # Term CRUD (spec R6): exercises domains + terms DML and their
        # identity sequences under the restricted role.
        domain = client.post(
            "/api/domains", json={"name": "b36 domain", "description": ""}
        )
        assert domain.status_code == 201, domain.text
        term = client.post(
            f"/api/domains/{domain.json()['id']}/terms",
            json={"language": "en", "preferred": "Fabulous"},
        )
        assert term.status_code == 201, term.text


def test_restricted_role_cannot_create_tables(restricted):
    with psycopg.connect(restricted.restricted_dsn) as conn:
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            conn.execute(f'CREATE TABLE "{restricted.schema}".sneaky (id int)')


def test_restricted_role_cannot_reach_other_schemas(restricted):
    # Portable stand-in for Supabase's auth schema (absent on the CI
    # service container): any schema the role was not granted is opaque.
    other = f"{restricted.schema}_other"
    with psycopg.connect(restricted.base_dsn, autocommit=True) as admin:
        admin.execute(f'CREATE SCHEMA "{other}"')
        admin.execute(f'CREATE TABLE "{other}".secrets (id int)')
    try:
        with psycopg.connect(restricted.restricted_dsn) as conn:
            with pytest.raises(psycopg.errors.InsufficientPrivilege):
                conn.execute(f'SELECT * FROM "{other}".secrets')
    finally:
        with psycopg.connect(restricted.base_dsn, autocommit=True) as admin:
            admin.execute(f'DROP SCHEMA "{other}" CASCADE')


def test_stale_schema_fails_startup_with_remedy(restricted):
    with psycopg.connect(restricted.base_dsn, autocommit=True) as admin:
        admin.execute(
            f'ALTER TABLE "{restricted.schema}".documents DROP COLUMN checked_at'
        )
    db = PostgresDatabase(restricted.restricted_dsn)
    try:
        with pytest.raises(RuntimeError) as exc:
            DocumentStore(db, manage_schema=False)
        assert "checked_at" in str(exc.value)
        assert "init-db" in str(exc.value)
    finally:
        db.close()
