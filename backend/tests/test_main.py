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
