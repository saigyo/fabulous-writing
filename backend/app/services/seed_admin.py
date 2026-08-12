"""Bootstrap the first admin account (auth.mode: local or supabase)."""

import asyncio
import logging
import os
from collections.abc import Mapping

from app.core.auth import ADMIN_SET_MIN_PASSWORD_LENGTH, AuthConfigError, validate_password
from app.services.supabase_gateway import (
    SupabaseAuthError,
    SupabaseAuthGateway,
    SupabaseUnavailableError,
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
        # asyncio.run is safe here: create_app runs before uvicorn's loop
        # exists, and the gateway builds per-operation clients (no pool
        # crosses loops).

        async def _bootstrap() -> str:
            try:
                return await gateway.create_user(email, password)
            except SupabaseAuthError:
                # Already registered (a re-run against an existing project):
                # link instead of failing.
                existing = await gateway.get_user_id_by_email(email)
                if existing is None:
                    raise
                return existing

        try:
            external_id = asyncio.run(_bootstrap())
        except (SupabaseAuthError, SupabaseUnavailableError) as exc:
            raise AuthConfigError(
                f"Supabase admin bootstrap failed: {type(exc).__name__}"
            ) from exc
        store.create_user(
            email, None, display_name="Administrator", tier="premium",
            is_admin=True, external_id=external_id,
        )
    logger.info("Seeded the initial admin account (%s)", email)
