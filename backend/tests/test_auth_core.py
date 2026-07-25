import pytest

from app.core.auth import (
    ADMIN_SET_MIN_PASSWORD_LENGTH,
    SELF_MIN_PASSWORD_LENGTH,
    AuthConfigError,
    check_password,
    hash_password,
    resolve_auth_secret,
    validate_password,
)
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


def test_hash_and_check_roundtrip():
    stored = hash_password("correct horse battery")
    assert stored != "correct horse battery"  # never stored in the clear
    assert check_password("correct horse battery", stored) is True
    assert check_password("wrong password", stored) is False


def test_check_password_against_missing_hash_is_false():
    # An account with no local password (Supabase-managed, or never set)
    # must not authenticate, and must still cost bcrypt time so response
    # timing cannot distinguish it from a wrong password.
    assert check_password("anything", None) is False


def test_password_length_rules():
    assert validate_password("12345678", min_length=SELF_MIN_PASSWORD_LENGTH) == "12345678"
    with pytest.raises(ValueError, match="at least 8"):
        validate_password("1234567", min_length=SELF_MIN_PASSWORD_LENGTH)
    with pytest.raises(ValueError, match="at least 12"):
        validate_password("12345678", min_length=ADMIN_SET_MIN_PASSWORD_LENGTH)


def test_password_byte_limit():
    # Password with multi-byte character to exercise byte-vs-character distinction.
    # 'あ' is 3 bytes in UTF-8, so "あ" * 25 = 75 bytes, exceeds bcrypt's 72-byte limit.
    over_long = "あ" * 25
    assert len(over_long) == 25  # 25 characters
    assert len(over_long.encode()) == 75  # but 75 bytes
    with pytest.raises(ValueError, match="at most 72 bytes"):
        validate_password(over_long, min_length=SELF_MIN_PASSWORD_LENGTH)


def test_check_password_with_over_long_input_returns_false():
    over_long = "あ" * 25  # 75 bytes, exceeds bcrypt limit
    # Against a real stored hash: must return False, not raise
    stored = hash_password("correct horse battery")
    assert check_password(over_long, stored) is False
    # Against None (timing-equalisation path): must return False, not raise
    assert check_password(over_long, None) is False


def test_hash_password_with_over_long_input_raises():
    over_long = "あ" * 25  # 75 bytes, exceeds bcrypt limit
    # hash_password is a write path; over-long input is a programming error.
    # It must raise to prevent accidentally storing a truncated password.
    with pytest.raises(ValueError, match="validate_password"):
        hash_password(over_long)


def test_false_accept_regression_distinct_passwords_with_same_prefix():
    # Two distinct passwords sharing a 72-byte prefix must not cross-match.
    # Construct a 72-byte valid password and store it.
    valid_72_byte = "x" * 72
    assert len(valid_72_byte.encode()) == 72
    stored = hash_password(valid_72_byte)

    # An over-long candidate with the same 72-byte prefix must still return False.
    # (After hash_password rejects over-long input, no over-long password can be
    # stored, so the truncation cannot produce a false accept.)
    candidate_with_suffix = "x" * 72 + "AAAA"
    assert len(candidate_with_suffix.encode()) == 76  # exceeds limit
    assert check_password(candidate_with_suffix, stored) is False


def test_check_password_with_empty_string_hash_returns_false():
    # Empty-string password_hash must return False and not crash.
    assert check_password("any password", "") is False
