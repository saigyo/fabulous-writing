"""Supabase-mode configuration and token verification (B14 #55)."""

import pydantic
import pytest

from app.core.auth import AuthConfigError
from app.core.config import Settings
from app.core.supabase_auth import (
    SUPABASE_PUBLISHABLE_KEY_ENV,
    SUPABASE_SECRET_KEY_ENV,
    SupabaseCredentials,
    resolve_supabase_credentials,
)

URL = "https://unit-test-project.invalid"

ENV_OK = {
    SUPABASE_PUBLISHABLE_KEY_ENV: "sb_publishable_unit_test",
    SUPABASE_SECRET_KEY_ENV: "sb_secret_unit_test",
}


def supabase_settings(tmp_path, url=URL):
    return Settings(
        db_path=tmp_path / "test.db",
        auth={"mode": "supabase", "supabase": {"url": url}},
    )


class TestResolveCredentials:
    def test_resolves_all_three_values(self, tmp_path):
        creds = resolve_supabase_credentials(supabase_settings(tmp_path), env=ENV_OK)
        assert creds == SupabaseCredentials(
            url=URL,
            publishable_key="sb_publishable_unit_test",
            secret_key="sb_secret_unit_test",
        )

    def test_repr_never_contains_key_material(self, tmp_path):
        creds = resolve_supabase_credentials(supabase_settings(tmp_path), env=ENV_OK)
        assert "sb_publishable_unit_test" not in repr(creds)
        assert "sb_secret_unit_test" not in repr(creds)

    def test_trailing_slash_is_stripped(self, tmp_path):
        creds = resolve_supabase_credentials(
            supabase_settings(tmp_path, url=URL + "/"), env=ENV_OK
        )
        assert creds.url == URL

    def test_missing_url_fails_closed(self, tmp_path):
        settings = Settings(db_path=tmp_path / "test.db", auth={"mode": "supabase"})
        with pytest.raises(AuthConfigError, match="auth.supabase.url"):
            resolve_supabase_credentials(settings, env=ENV_OK)

    @pytest.mark.parametrize("missing", [SUPABASE_PUBLISHABLE_KEY_ENV, SUPABASE_SECRET_KEY_ENV])
    def test_missing_key_names_the_variable_not_the_value(self, tmp_path, missing):
        env = {k: v for k, v in ENV_OK.items() if k != missing}
        with pytest.raises(AuthConfigError) as excinfo:
            resolve_supabase_credentials(supabase_settings(tmp_path), env=env)
        assert missing in str(excinfo.value)
        assert "sb_" not in str(excinfo.value)  # never echo key material

    def test_unknown_supabase_key_fails_loudly(self, tmp_path):
        # Specifically ValidationError: the point is that extra="forbid" sits
        # on the NESTED model (AuthSettings itself has no extra="forbid").
        with pytest.raises(pydantic.ValidationError):
            Settings(
                db_path=tmp_path / "test.db",
                auth={"mode": "supabase", "supabase": {"url": URL, "tpyo": 1}},
            )
