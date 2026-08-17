"""Covers app.main's lazy PEP 562 `__getattr__` for the module-level `app`.

`uvicorn app.main:app` resolves the `app` attribute by importing `app.main`
and then doing `getattr(module, "app")`; since there is no `app =
create_app()` assignment at module scope (see `__getattr__`'s own
docstring for why), this `__getattr__` hook is the single line deciding
whether that command works at all in production. It had no regression test.
"""

import pytest
from uvicorn.importer import import_from_string

import app.main as main_module
from app.core.auth import AuthConfigError
from app.core.config import Settings
from app.main import create_app
from app.services.db.sqlite import connect


def test_lazy_app_attribute_builds_once_and_is_cached(monkeypatch):
    # A sentinel factory avoids constructing a real app (and therefore
    # avoids touching real settings or the default database) while still
    # exercising the exact lookup path `uvicorn app.main:app` uses.
    sentinel = object()
    calls = 0

    def fake_create_app():
        nonlocal calls
        calls += 1
        return sentinel

    monkeypatch.setattr(main_module, "create_app", fake_create_app)
    # Remove any cached `app` so __getattr__ actually runs on first access
    # below, regardless of what earlier tests in this process did.
    main_module.__dict__.pop("app", None)
    try:
        resolved = import_from_string("app.main:app")
        assert resolved is sentinel
        assert calls == 1

        # A second access must hit the module's now-cached `app` global, not
        # call the factory again.
        resolved_again = import_from_string("app.main:app")
        assert resolved_again is sentinel
        assert calls == 1
    finally:
        # Do not leak the sentinel `app` (or a real one, if a later test
        # imports app.main fresh) into other tests' module state.
        main_module.__dict__.pop("app", None)


def test_unknown_attribute_still_raises_attribute_error():
    # __getattr__ must remain a normal PEP 562 hook for anything that is not
    # `app`, not swallow every missing-attribute lookup on the module.
    with pytest.raises(AttributeError, match="no attribute 'does_not_exist'"):
        main_module.does_not_exist


def test_failed_startup_closes_the_pool(tmp_path, monkeypatch):
    # create_app wraps its post-create_database body in
    # `except BaseException: db.close(); raise` so a pool's worker threads
    # never outlive a failed startup. Nothing else in the suite exercises
    # that handler: SQLite's close() is a documented no-op, and the PG
    # smoke test only exercises a clean shutdown. A fake Database whose
    # connect() itself raises fails inside the try on the very first store
    # construction (TerminologyStore) -- a genuine post-factory startup
    # failure -- so this pins both that create_app re-raises it AND that
    # close() was called exactly once first.
    sentinel = RuntimeError("boom")
    close_calls = 0

    class FakeDatabase:
        dialect = "sqlite"

        def connect(self):
            raise sentinel

        def raw_connect(self):
            raise sentinel

        def close(self):
            nonlocal close_calls
            close_calls += 1

    monkeypatch.setattr(main_module, "create_database", lambda settings: FakeDatabase())
    settings = Settings(db_path=tmp_path / "t.db", rules_dir=tmp_path / "rules")
    with pytest.raises(RuntimeError) as exc_info:
        create_app(settings)
    assert exc_info.value is sentinel
    assert close_calls == 1


def test_seeders_run_after_admin_bootstrap(tmp_path, monkeypatch):
    # Spec §9 startup order: migrations -> admin seeding -> global
    # seeders. With bootstrap credentials missing and no users, create_app
    # must fail BEFORE the seeders write any global row.
    monkeypatch.delenv("FW_ADMIN_EMAIL", raising=False)
    monkeypatch.delenv("FW_ADMIN_PASSWORD", raising=False)
    settings = Settings(db_path=tmp_path / "t.db", rules_dir=tmp_path / "rules")
    with pytest.raises(AuthConfigError):
        create_app(settings)
    with connect(tmp_path / "t.db") as conn:
        assert conn.execute("SELECT count(*) FROM domains").fetchone()[0] == 0
        assert conn.execute("SELECT count(*) FROM profiles").fetchone()[0] == 0
