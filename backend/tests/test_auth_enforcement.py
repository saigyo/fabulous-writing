"""Every /api/* route requires authentication except the two public ones.

Walks the app's own OpenAPI schema rather than listing endpoints by hand, so
this test fails the moment someone adds a router or endpoint to app/main.py
without wiring the get_current_user dependency, instead of silently rotting
like a hand-maintained list would.
"""

import re

import pytest
from fastapi.testclient import TestClient

from app.core.config import Settings
from app.main import create_app

PUBLIC = {("/api/health", "GET"), ("/api/auth/login", "POST")}

# Path params vary by router ({check_id}, {document_id}, {domain_id},
# {term_id}, {profile_id}, {folder_id}, {user_id}, ...); substituting "1"
# generically means a newly added path param needs no update here.
_PATH_PARAM = re.compile(r"\{[^}]+\}")


@pytest.fixture()
def anon_client(tmp_path) -> TestClient:
    """An intentionally unauthenticated client.

    `authed_client` (Task 9) is the wrong tool here -- it comes with a
    Bearer header pre-attached, which is exactly what this test must not
    have. There is also no shared `client` fixture in conftest.py; the ones
    named `client` in other test modules are module-local. tmp_path settings
    keep this off the real `backend/data/fabulous.db`.
    """
    settings = Settings(db_path=tmp_path / "test.db", rules_dir=tmp_path / "rules")
    return TestClient(create_app(settings))


def _api_routes(client: TestClient) -> list[tuple[str, str]]:
    """(path, method) pairs for every operation FastAPI has registered.

    Read from the app's own OpenAPI schema rather than `app.routes`: this
    FastAPI version wraps included routers in an internal, lazily-resolved
    representation, while `openapi()` is the stable, public way to get the
    fully flattened route table.
    """
    schema = client.app.openapi()
    return [
        (path, method.upper())
        for path, methods in schema["paths"].items()
        for method in methods
    ]


def test_every_api_route_requires_auth_except_the_public_allowlist(
    anon_client: TestClient,
) -> None:
    routes = _api_routes(anon_client)
    assert PUBLIC.issubset(routes), (
        "the public allowlist references a route the app no longer exposes"
    )
    protected = [route for route in routes if route not in PUBLIC]
    assert protected, "route walk found no protected routes to check"
    for path, method in protected:
        concrete_path = _PATH_PARAM.sub("1", path)
        response = anon_client.request(method, concrete_path)
        assert response.status_code == 401, (
            f"{method} {concrete_path} returned {response.status_code}, "
            "not 401 -- an unauthenticated caller reached past the auth "
            "dependency (a 404/422 here would mean the nonexistent id was "
            "resolved before auth ran, which is exactly the regression this "
            "test exists to catch)"
        )


def test_preflight_to_an_authenticated_route_is_not_401(anon_client: TestClient) -> None:
    response = anon_client.options(
        "/api/documents",
        headers={
            "Origin": "http://localhost:5173",
            "Access-Control-Request-Method": "GET",
            # The header the Bearer client actually triggers a preflight for.
            # Without it this test passes even if allow_headers stops
            # permitting Authorization -- while every authenticated browser
            # request fails.
            "Access-Control-Request-Headers": "authorization",
        },
    )
    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == "http://localhost:5173"
    assert "authorization" in response.headers["access-control-allow-headers"].lower()
