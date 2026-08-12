"""Supabase-mode authentication: configuration and token verification.

Identity only: Supabase authenticates who the caller is; every
authorization decision (is_admin, tier, is_active) stays with the local
users table, so nothing in a Supabase JWT's claims can grant privileges.
"""

import logging
import os
from collections.abc import Mapping
from dataclasses import dataclass, field

from app.core.auth import AuthConfigError
from app.core.config import Settings

logger = logging.getLogger(__name__)

SUPABASE_PUBLISHABLE_KEY_ENV = "FW_SUPABASE_PUBLISHABLE_KEY"
SUPABASE_SECRET_KEY_ENV = "FW_SUPABASE_SECRET_KEY"


@dataclass(frozen=True)
class SupabaseCredentials:
    url: str              # normalized: no trailing slash
    # repr=False on both keys: the dataclass repr would otherwise put key
    # material into any debug log, --showlocals dump, or exception chain
    # that formats this object.
    publishable_key: str = field(repr=False)  # user-flow GoTrue calls
    secret_key: str = field(repr=False)       # admin API only; never leaves the backend


def resolve_supabase_credentials(
    settings: Settings, env: Mapping[str, str] | None = None
) -> SupabaseCredentials:
    """Fail-closed startup gate for supabase mode.

    Messages name the missing variable, never any value: a config error
    report must not become a credential at rest in a log file.
    """
    supabase = settings.auth.supabase
    if supabase is None or not supabase.url.strip():
        raise AuthConfigError(
            "auth.mode is 'supabase' but auth.supabase.url is not configured"
        )
    environ = os.environ if env is None else env
    publishable = environ.get(SUPABASE_PUBLISHABLE_KEY_ENV, "")
    secret = environ.get(SUPABASE_SECRET_KEY_ENV, "")
    if not publishable:
        raise AuthConfigError(f"{SUPABASE_PUBLISHABLE_KEY_ENV} is unset")
    if not secret:
        raise AuthConfigError(f"{SUPABASE_SECRET_KEY_ENV} is unset")
    return SupabaseCredentials(
        url=supabase.url.strip().rstrip("/"),
        publishable_key=publishable,
        secret_key=secret,
    )
