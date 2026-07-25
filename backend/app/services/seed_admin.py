"""Bootstrap the first admin account (auth.mode: local only)."""

import logging
import os
from collections.abc import Mapping

from app.core.auth import ADMIN_SET_MIN_PASSWORD_LENGTH, AuthConfigError, validate_password
from app.services.users import UserStore

logger = logging.getLogger(__name__)


def seed_admin(store: UserStore, env: Mapping[str, str] | None = None) -> None:
    """Create the initial admin from the environment while `users` is empty.

    There is deliberately no API path for this: an unauthenticated bootstrap
    endpoint either stays open forever or depends on someone remembering to
    disable it. Once any user exists the variables are ignored entirely, so
    they can never serve as a standing password reset.
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
    validate_password(password, min_length=ADMIN_SET_MIN_PASSWORD_LENGTH)
    store.create_user(
        email, password, display_name="Administrator", tier="premium", is_admin=True
    )
    logger.info("Seeded the initial admin account (%s)", email)
