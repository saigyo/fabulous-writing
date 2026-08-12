"""Every /api/* route requires authentication except the two public ones.

Walks the app's own route table rather than listing endpoints by hand, so
this test fails the moment someone adds a router or endpoint to app/main.py
without wiring the get_current_user dependency, instead of silently rotting
like a hand-maintained list would.
"""

import re

import pytest
from fastapi.routing import APIRoute
from fastapi.testclient import TestClient

from app.core.config import Settings
from app.main import create_app

try:
    from fastapi.routing import _IncludedRouter
except ImportError:  # pragma: no cover - only if a future FastAPI drops this
    _IncludedRouter = None

PUBLIC = {
    ("/api/health", "GET"), ("/api/auth/login", "POST"), ("/api/auth/refresh", "POST"),
    ("/api/auth/reset-request", "POST"), ("/api/auth/reset-confirm", "POST"),
}

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


def _openapi_routes(client: TestClient) -> set[tuple[str, str]]:
    """(path, method) pairs read from the app's OpenAPI schema.

    Stable and public, but silently blind to any route declared
    `include_in_schema=False` -- exactly the flag idiomatically used for
    internal/ops/debug endpoints, which are the ones most likely to be
    forgotten when auth is wired up. Kept only as a cross-check below, not
    as the source of truth for which routes get exercised.
    """
    schema = client.app.openapi()
    return {
        (path, method.upper())
        for path, methods in schema["paths"].items()
        for method in methods
    }


def _walked_routes(routes) -> set[tuple[str, str]]:
    """(path, method) pairs found by recursing the app's actual route tree.

    Unlike the OpenAPI schema, this also sees `include_in_schema=False`
    routes. On this FastAPI version (0.140.0), `app.include_router(...)`
    wraps the router in `fastapi.routing._IncludedRouter`, a lazily-resolved
    indirection that a plain `isinstance(route, APIRoute)` walk over
    `app.routes` fails to see through entirely -- it finds only the one
    route declared directly on `app` (`/api/health`), 1 of 41. Recursing
    into `_IncludedRouter.original_router.routes` is what actually reaches
    the registered `APIRoute` objects, `include_in_schema=False` and all.
    """
    pairs: set[tuple[str, str]] = set()
    for route in routes:
        if isinstance(route, APIRoute):
            pairs.update((route.path, method.upper()) for method in route.methods)
        elif _IncludedRouter is not None and isinstance(route, _IncludedRouter):
            pairs |= _walked_routes(route.original_router.routes)
    return pairs


def test_every_api_route_requires_auth_except_the_public_allowlist(
    anon_client: TestClient,
) -> None:
    openapi_routes = _openapi_routes(anon_client)
    walked_routes = _walked_routes(anon_client.app.routes)
    # `_IncludedRouter.original_router` is a private attribute. If a future
    # FastAPI version changes its shape, `_walked_routes` could quietly
    # start returning fewer routes than it should -- this assertion is what
    # turns that into a loud failure instead of an enforcement test that
    # silently checks less than it used to. The OpenAPI schema is public and
    # stable, so it's a trustworthy lower bound even though it can't be the
    # source of truth on its own (it can't see include_in_schema=False).
    assert openapi_routes <= walked_routes, (
        "the route-tree walk found fewer routes than the OpenAPI schema -- "
        "the private _IncludedRouter walk may no longer match this "
        "FastAPI version's internals"
    )

    assert PUBLIC <= walked_routes, (
        "the public allowlist references a route the app no longer exposes"
    )
    for path, method in PUBLIC:
        response = anon_client.request(method, _PATH_PARAM.sub("1", path))
        assert response.status_code != 401, (
            f"{method} {path} is meant to be public but rejected an "
            "anonymous request with 401"
        )

    protected = walked_routes - PUBLIC
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
