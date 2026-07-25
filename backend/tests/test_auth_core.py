import pytest

from app.core.auth import AuthConfigError, resolve_auth_secret
from app.core.config import Settings


def test_secret_from_env_is_returned():
    secret = "x" * 32
    assert resolve_auth_secret(ephemeral_ok=False, env={"FW_AUTH_SECRET": secret}) == secret


def test_short_secret_is_rejected():
    with pytest.raises(AuthConfigError, match="at least 32"):
        resolve_auth_secret(ephemeral_ok=False, env={"FW_AUTH_SECRET": "tooshort"})


def test_missing_secret_fails_closed():
    with pytest.raises(AuthConfigError, match="FW_AUTH_SECRET"):
        resolve_auth_secret(ephemeral_ok=False, env={})


def test_missing_secret_is_generated_when_ephemeral_allowed(caplog):
    with caplog.at_level("WARNING"):
        secret = resolve_auth_secret(ephemeral_ok=True, env={})
    assert len(secret) >= 32
    # The warning must announce the fact without ever printing the value.
    assert "ephemeral" in caplog.text.lower()
    assert secret not in caplog.text


def test_auth_settings_defaults_are_closed():
    settings = Settings()
    assert settings.auth.mode == "local"
    assert settings.auth.ephemeral_secret is False
    assert settings.auth.allow_additional_admins is False


def test_auth_settings_load_from_mapping():
    settings = Settings.model_validate(
        {"auth": {"mode": "local", "ephemeral_secret": True, "allow_additional_admins": True}}
    )
    assert settings.auth.ephemeral_secret is True
    assert settings.auth.allow_additional_admins is True
