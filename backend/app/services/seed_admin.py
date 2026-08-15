"""Bootstrap the first admin account (auth.mode: local or supabase)."""

import logging
import os
from collections.abc import Mapping

from app.core.auth import ADMIN_SET_MIN_PASSWORD_LENGTH, AuthConfigError, validate_password
from app.services.supabase_gateway import (
    SupabaseAuthError,
    SupabaseAuthGateway,
    SupabaseUnavailableError,
    run_sync,
)
from app.services.users import UserStore

logger = logging.getLogger(__name__)


def seed_admin(
    store: UserStore,
    env: Mapping[str, str] | None = None,
    *,
    gateway: SupabaseAuthGateway | None = None,
) -> None:
    """Create the initial admin from the environment while `users` is empty.

    There is deliberately no API path for this: an unauthenticated bootstrap
    endpoint either stays open forever or depends on someone remembering to
    disable it. Once any user exists the variables are ignored entirely, so
    they can never serve as a standing password reset.

    `gateway` is None in local mode (unchanged path: the local row owns both
    the password hash and authority). In supabase mode, Supabase owns the
    credential and the local row owns authority only.
    """
    if store.count() > 0:
        return
    environ = os.environ if env is None else env
    email = environ.get("FW_ADMIN_EMAIL", "").strip()
    password = environ.get("FW_ADMIN_PASSWORD", "")
    if not email or not password:
        raise AuthConfigError(
            "No users exist and FW_ADMIN_EMAIL / FW_ADMIN_PASSWORD are unset: "
            "the instance would have no way to authenticate anyone."
        )
    try:
        validate_password(password, min_length=ADMIN_SET_MIN_PASSWORD_LENGTH)
    except ValueError as exc:
        # Every other startup gate raises AuthConfigError; an operator
        # wrapper catching AuthConfigError around create_app() would
        # otherwise miss exactly this case.
        raise AuthConfigError(str(exc)) from exc
    if gateway is None:
        store.create_user(
            email, password, display_name="Administrator", tier="premium", is_admin=True
        )
    else:
        # Supabase owns the credential; the local row owns authority.
        rotated_existing = False

        async def _bootstrap() -> str:
            nonlocal rotated_existing
            try:
                return await gateway.create_user(email, password)
            except SupabaseAuthError:
                # Already registered (a re-run against an existing project):
                # link instead of failing. The existing identity's credential
                # is unknown to this operator -- without rotating it to the
                # just-configured FW_ADMIN_PASSWORD, the old (unknown)
                # password would keep admin access while the configured one
                # silently could not log in. Mirrors the admin-create
                # reconciliation in app/api/admin.py. A rotation failure
                # propagates out of run_sync() below and is mapped to
                # AuthConfigError by the existing except clause there, same
                # as any other bootstrap failure.
                existing = await gateway.get_user_by_email(email)
                if existing is None:
                    raise
                if existing.provider != "email":
                    # A real Supabase identity sits at this email, but it was
                    # not minted by this app's own email/password flow (an
                    # OAuth/SSO login, most likely). Rotating its password and
                    # linking it anyway would produce an admin row that can
                    # never authenticate: SupabaseTokenVerifier rejects any
                    # token whose FIRST provider (app_metadata.provider) is
                    # not "email" (setup guide §4), regardless of what the
                    # credential is. Fail closed instead of minting a
                    # permanently-locked-out admin.
                    raise AuthConfigError(
                        f"bootstrap email belongs to a non-email identity "
                        f"(provider {existing.provider}); use a different "
                        f"FW_ADMIN_EMAIL or remove that identity"
                    )
                await gateway.change_password(existing.id, password)
                rotated_existing = True
                return existing.id

        try:
            external_id = run_sync(_bootstrap())
        except (SupabaseAuthError, SupabaseUnavailableError) as exc:
            raise AuthConfigError(
                f"Supabase admin bootstrap failed: {type(exc).__name__}"
            ) from exc
        row = store.create_user(
            email, None, display_name="Administrator", tier="premium",
            is_admin=True, external_id=external_id,
        )
        if rotated_existing:
            # Duplicate-account path only (delta-review finding #1, mirrors
            # the admin-create reconciliation in app/api/admin.py): the
            # gateway.change_password rotation above already revoked this
            # identity's REFRESH tokens -- GoTrue's admin password update
            # logs the user out internally -- but any already-issued ACCESS
            # token is a stateless JWT this backend verifies locally and
            # stays valid until its own TTL, and this identity may have
            # outstanding ones from before the bootstrap ran. Marking
            # password_changed_at closes that remaining window by making
            # deps.py's fallback reject them immediately. The fresh-create
            # branch (gateway.create_user succeeded above) needs no mark: a
            # brand-new identity has no pre-existing tokens to evict.
            store.mark_password_changed(row.id)
    logger.info("Seeded the initial admin account (%s)", email)
