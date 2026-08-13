"""Supabase-mode configuration and token verification (B14 #55)."""

import logging
import time

import jwt
import pydantic
import pytest
from cryptography.hazmat.primitives.asymmetric.ec import SECP256R1, generate_private_key

from app.core.auth import AuthConfigError, InvalidToken
from app.core.config import Settings
from app.core.supabase_auth import (
    SUPABASE_PUBLISHABLE_KEY_ENV,
    SUPABASE_SECRET_KEY_ENV,
    SupabaseCredentials,
    SupabaseTokenVerifier,
    resolve_supabase_credentials,
    resolve_supabase_user,
)
from app.services.users import UserStore
from tests.fakes_supabase import StaticJWKSClient

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


class TestUserStoreExternalId:
    def test_create_and_get_by_external_id(self, tmp_path):
        store = UserStore(tmp_path / "u.db")
        created = store.create_user(
            "a@example.com", None, external_id="uuid-1", tier="basic"
        )
        fetched = store.get_by_external_id("uuid-1")
        assert fetched is not None and fetched.id == created.id
        assert store.get_by_external_id("uuid-absent") is None

    def test_mark_password_changed_sets_timestamp_without_touching_hash(self, tmp_path):
        # Created WITH a password so the "touches no hash" contract is
        # actually observable — a password-less row would make the final
        # assertion pass with the whole method deleted.
        store = UserStore(tmp_path / "u.db")
        user = store.create_user("a@example.com", "local-password-1", external_id="uuid-1")
        assert user.password_changed_at is None
        assert store.mark_password_changed(user.id) is True
        after = store.get_user(user.id)
        assert after.password_changed_at is not None
        assert after.token_epoch == user.token_epoch + 1
        assert store.verify_credentials("a@example.com", "local-password-1") is not None

    def test_mark_password_changed_backdates_by_iat_leeway(self, tmp_path):
        # The recorded instant is _utcnow() MINUS IAT_LEEWAY_SECONDS: the
        # timestamp is compared (deps.py fallback, strict <) against iat
        # values minted by SUPABASE's clock at second granularity. Without
        # the backdate, Supabase trailing our clock by sub-second amounts
        # across a second boundary would 401 the frontend's silent re-login
        # right after a password change. Cost: tokens minted in the final
        # leeway window before the change stay valid at our layer — the
        # gateway's global sign-out is the second eviction layer for those.
        from datetime import UTC, datetime, timedelta

        from app.core.auth import IAT_LEEWAY_SECONDS

        store = UserStore(tmp_path / "u.db")
        user = store.create_user("a@example.com", "local-password-1")
        before = datetime.now(UTC)
        store.mark_password_changed(user.id)
        recorded = datetime.fromisoformat(store.get_user(user.id).password_changed_at)
        offset = before - recorded
        assert timedelta(seconds=IAT_LEEWAY_SECONDS - 2) <= offset <= timedelta(
            seconds=IAT_LEEWAY_SECONDS + 2
        )


class TestResolveSupabaseUserAdoptionRace:
    """resolve_supabase_user's adopt-by-email path (finding 1, Copilot round
    1): the write is now UserStore.link_external_id's atomic conditional
    UPDATE, not a read-then-write `update_user`. Both cases below simulate a
    concurrent write landing strictly BETWEEN this call's own read (which
    sees external_id=None) and its write, by monkeypatching link_external_id
    to perform that concurrent write itself before reporting the loss."""

    def test_lost_race_to_a_different_subject_fails_closed(self, tmp_path):
        store = UserStore(tmp_path / "race1.db")
        existing = store.create_user("a@example.com", "local-password-1")
        original_link = store.link_external_id

        def racing_link(user_id, external_id):
            # A concurrent request for a DIFFERENT subject wins the race,
            # landing between our read and our write.
            store.link_external_id = original_link
            original_link(user_id, "uuid-other-winner")
            return False

        store.link_external_id = racing_link
        with pytest.raises(InvalidToken):
            resolve_supabase_user(store, subject="uuid-mine", email="a@example.com")
        assert store.get_user(existing.id).external_id == "uuid-other-winner"

    def test_lost_race_to_the_same_subject_is_idempotent(self, tmp_path):
        store = UserStore(tmp_path / "race2.db")
        existing = store.create_user("a@example.com", "local-password-1")
        original_link = store.link_external_id

        def racing_link(user_id, external_id):
            # A concurrent DUPLICATE request for the SAME subject wins the
            # race first; this call's own write loses but the outcome (this
            # row linked to our own subject) is exactly what we wanted.
            store.link_external_id = original_link
            original_link(user_id, external_id)
            return False

        store.link_external_id = racing_link
        resolved = resolve_supabase_user(store, subject="uuid-mine", email="a@example.com")
        assert resolved.id == existing.id
        assert resolved.external_id == "uuid-mine"


def es256_keypair():
    private = generate_private_key(SECP256R1())
    return private, private.public_key()


def mint(private, *, kid="kid-1", url=URL, sub="uuid-1", email="a@example.com", **over):
    claims = {
        "sub": sub,
        "email": email,
        "iat": int(time.time()),
        "exp": int(time.time()) + 3600,
        "iss": f"{url}/auth/v1",
        "aud": "authenticated",
        "role": "authenticated",
        "is_anonymous": False,
    }
    claims.update(over)
    claims = {k: v for k, v in claims.items() if v is not None}
    return jwt.encode(claims, private, algorithm="ES256", headers={"kid": kid})


@pytest.fixture()
def verifier_setup(tmp_path):
    private, public = es256_keypair()
    store = UserStore(tmp_path / "v.db")
    jwks = StaticJWKSClient({"kid-1": public})
    verifier = SupabaseTokenVerifier(URL, store, jwks_client=jwks)
    return private, store, verifier


class TestSupabaseTokenVerifier:
    def test_valid_token_resolves_linked_user(self, verifier_setup):
        private, store, verifier = verifier_setup
        user = store.create_user("a@example.com", None, external_id="uuid-1")
        verified = verifier.verify(mint(private))
        assert verified.user_id == user.id
        assert verified.epoch is None

    def test_unknown_subject_jit_provisions_default_tier_non_admin(self, verifier_setup):
        private, store, verifier = verifier_setup
        verified = verifier.verify(mint(private, sub="uuid-new", email="new@example.com"))
        row = store.get_by_external_id("uuid-new")
        assert row is not None and verified.user_id == row.id
        assert row.tier == "basic" and row.is_admin is False and row.is_active is True
        assert row.email == "new@example.com"

    def test_unlinked_admin_row_adopts_only_via_email_match(self, verifier_setup):
        # Decision on record, not an accident: in a mixed/migrated deployment
        # an UNLINKED admin row is handed to the first Supabase identity
        # presenting a verified token for exactly that email. The operator
        # controls who can register that address at Supabase (invitation-only,
        # signup off), which is what makes this adoption acceptable.
        private, store, verifier = verifier_setup
        admin = store.create_user(
            "admin@example.com", "admin-password-12", is_admin=True, tier="premium"
        )
        verified = verifier.verify(
            mint(private, sub="uuid-a", email="admin@example.com")
        )
        assert verified.user_id == admin.id
        assert store.get_user(admin.id).external_id == "uuid-a"

    def test_jit_links_existing_unlinked_local_user_by_email(self, verifier_setup):
        # A pre-existing local-mode account adopting its Supabase identity.
        private, store, verifier = verifier_setup
        local = store.create_user("a@example.com", "local-password-1", tier="premium")
        verified = verifier.verify(mint(private, sub="uuid-9"))
        assert verified.user_id == local.id
        assert store.get_user(local.id).external_id == "uuid-9"
        assert store.get_user(local.id).tier == "premium"  # authority untouched

    def test_email_collision_with_different_subject_fails_closed(self, verifier_setup):
        private, store, verifier = verifier_setup
        store.create_user("a@example.com", None, external_id="uuid-other")
        with pytest.raises(InvalidToken):
            verifier.verify(mint(private, sub="uuid-1"))

    def test_missing_email_claim_on_unknown_subject_fails_closed(self, verifier_setup):
        private, store, verifier = verifier_setup
        with pytest.raises(InvalidToken):
            verifier.verify(mint(private, sub="uuid-new", email=None))

    @pytest.mark.parametrize(
        "kwargs",
        [
            {"exp": int(time.time()) - 10},
            {"iss": "https://evil.invalid/auth/v1"},
            {"aud": "anon"},
            {"iat": int(time.time()) + 3600},  # beyond IAT_LEEWAY_SECONDS
            {"is_anonymous": True},   # anonymous sign-ins: rejected on claims
            {"role": "anon"},         # not the authenticated role
        ],
    )
    def test_bad_claims_rejected(self, verifier_setup, kwargs):
        private, store, verifier = verifier_setup
        store.create_user("a@example.com", None, external_id="uuid-1")
        with pytest.raises(InvalidToken):
            verifier.verify(mint(private, **kwargs))

    def test_hs256_token_rejected(self, verifier_setup):
        _, store, verifier = verifier_setup
        store.create_user("a@example.com", None, external_id="uuid-1")
        # 32+ bytes, not just any string: PyJWT emits InsecureKeyLengthWarning
        # for a SHA256 HMAC key under 32 bytes, which would break the
        # zero-warnings gate (same convention as test_auth_core.py's SECRET).
        forged = jwt.encode(
            {"sub": "uuid-1", "iat": int(time.time()), "exp": int(time.time()) + 60,
             "iss": f"{URL}/auth/v1", "aud": "authenticated"},
            "any-shared-secret-any-shared-secret", algorithm="HS256", headers={"kid": "kid-1"},
        )
        with pytest.raises(InvalidToken):
            verifier.verify(forged)

    def test_unknown_kid_rejected(self, verifier_setup):
        private, store, verifier = verifier_setup
        with pytest.raises(InvalidToken):
            verifier.verify(mint(private, kid="kid-unknown"))

    def test_wrong_key_signature_rejected(self, verifier_setup):
        _, store, verifier = verifier_setup
        other_private, _ = es256_keypair()
        with pytest.raises(InvalidToken):
            verifier.verify(mint(other_private))

    def test_jwks_outage_logs_a_warning_and_fails_closed(self, tmp_path, caplog):
        # finding 4 (Copilot round 1): a JWKS fetch failure (unreachable
        # endpoint, outage) must not collapse into an unexplained 401 with
        # nothing in the log to distinguish it from an ordinary bad token.
        private, _public = es256_keypair()
        store = UserStore(tmp_path / "jwks-outage.db")

        class BoomJWKSClient:
            def get_signing_key_from_jwt(self, token):
                raise jwt.exceptions.PyJWKClientError("JWKS endpoint unreachable")

        verifier = SupabaseTokenVerifier(URL, store, jwks_client=BoomJWKSClient())
        token = mint(private)
        with caplog.at_level(logging.WARNING, logger="app.core.supabase_auth"):
            with pytest.raises(InvalidToken):
                verifier.verify(token)
        warnings = [r for r in caplog.records if r.levelno == logging.WARNING]
        assert any("JWKS retrieval failed" in r.message for r in warnings)
        # The raw token itself is never written to the log.
        assert all(token not in r.message for r in caplog.records)
