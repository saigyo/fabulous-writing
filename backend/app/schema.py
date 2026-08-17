"""Construct every store with schema DDL enabled: the single
schema-creation entry point (init-db, the import tool). Deliberately free
of any postgres driver import — sqlite-only deployments run this too."""

from app.services.db import Database
from app.services.documents import DocumentStore
from app.services.folders import FolderStore
from app.services.profiles import ProfileStore
from app.services.terminology import TerminologyStore
from app.services.usage import UsageStore
from app.services.users import UserStore


def init_stores(db: Database) -> None:
    """Create or migrate the full schema (idempotent, additive)."""
    UserStore(db)
    FolderStore(db)
    DocumentStore(db)
    TerminologyStore(db)
    ProfileStore(db)
    UsageStore(db)
