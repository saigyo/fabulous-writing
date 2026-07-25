from datetime import UTC, datetime, timedelta

import jwt
import pytest

from app.core.auth import (
    ADMIN_SET_MIN_PASSWORD_LENGTH,
    SELF_MIN_PASSWORD_LENGTH,
    TOKEN_AUDIENCE,
    TOKEN_ISSUER,
    AuthConfigError,
    InvalidToken,
    LocalTokenVerifier,
    check_password,
    hash_password,
    issue_token,
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


def test_check_password_with_malformed_stored_hash_returns_false():
    # hash_password() is the only writer today, so this is unreachable via
    # normal operation, but a Supabase-era migration or a hand-edited row
    # could leave a non-empty, non-bcrypt value in password_hash. bcrypt's
    # own checkpw() raises ValueError on that input; check_password's
    # contract is to never raise, so this must return False, not 500 the
    # login path.
    assert check_password("any password", "not-a-real-bcrypt-hash") is False


# 64 bytes, not merely the 32-byte minimum: the foreign-algorithm test
# below signs with HS512, and PyJWT emits InsecureKeyLengthWarning for a
# SHA512 key under 64 bytes — which would break the zero-warnings gate.
SECRET = "s" * 64


def test_issued_token_verifies_to_the_local_user_id():
    verifier = LocalTokenVerifier(SECRET)
    assert verifier.verify(issue_token(42, SECRET)) == 42


def test_token_signed_with_another_secret_is_rejected():
    with pytest.raises(InvalidToken):
        LocalTokenVerifier(SECRET).verify(issue_token(1, "other" * 10))


def test_expired_token_is_rejected():
    long_ago = datetime.now(UTC) - timedelta(hours=25)
    with pytest.raises(InvalidToken):
        LocalTokenVerifier(SECRET).verify(issue_token(1, SECRET, now=long_ago))


def test_token_with_foreign_algorithm_is_rejected():
    # The classic JWT bugs: 'alg: none' and RS256->HS256 confusion. A
    # permissive decode accepts them; a pinned single-algorithm decode
    # does not.
    forged = jwt.encode(
        {"sub": "1", "iss": TOKEN_ISSUER, "aud": TOKEN_AUDIENCE,
         "iat": int(datetime.now(UTC).timestamp()),
         "exp": int((datetime.now(UTC) + timedelta(hours=1)).timestamp())},
        SECRET,
        algorithm="HS512",
    )
    with pytest.raises(InvalidToken):
        LocalTokenVerifier(SECRET).verify(forged)


@pytest.mark.parametrize("claim", ["iss", "aud"])
def test_token_for_another_project_is_rejected(claim):
    payload = {
        "sub": "1",
        "iss": TOKEN_ISSUER,
        "aud": TOKEN_AUDIENCE,
        "iat": int(datetime.now(UTC).timestamp()),
        "exp": int((datetime.now(UTC) + timedelta(hours=1)).timestamp()),
    }
    payload[claim] = "some-other-project"
    forged = jwt.encode(payload, SECRET, algorithm="HS256")
    with pytest.raises(InvalidToken):
        LocalTokenVerifier(SECRET).verify(forged)


def test_token_issued_far_in_the_future_is_rejected_but_small_skew_is_tolerated():
    verifier = LocalTokenVerifier(SECRET)
    # 30s of clock drift must still work; 10 minutes must not.
    near = datetime.now(UTC) + timedelta(seconds=30)
    assert verifier.verify(issue_token(7, SECRET, now=near)) == 7
    far = datetime.now(UTC) + timedelta(minutes=10)
    with pytest.raises(InvalidToken):
        verifier.verify(issue_token(7, SECRET, now=far))


def test_garbage_token_is_rejected():
    with pytest.raises(InvalidToken):
        LocalTokenVerifier(SECRET).verify("not-a-token")


@pytest.mark.parametrize("bad_iat", ["not-a-number", ["x"], {"a": 1}])
def test_malformed_iat_is_rejected_not_leaked(bad_iat):
    # iat is caller-controlled and must never crash the verifier with a
    # raw ValueError/TypeError from the drift computation; it must be
    # translated to InvalidToken like every other malformed claim.
    payload = {
        "sub": "1",
        "iss": TOKEN_ISSUER,
        "aud": TOKEN_AUDIENCE,
        "iat": bad_iat,
        "exp": int((datetime.now(UTC) + timedelta(hours=1)).timestamp()),
    }
    forged = jwt.encode(payload, SECRET, algorithm="HS256")
    with pytest.raises(InvalidToken):
        LocalTokenVerifier(SECRET).verify(forged)
