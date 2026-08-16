from pathlib import Path

from app.core.models import Language
from app.services.db.sqlite import SqliteDatabase
from app.services.seed import DOMAIN_NAME, seed_terminology
from app.services.terminology import TerminologyStore


def make_store(tmp_path: Path) -> TerminologyStore:
    return TerminologyStore(SqliteDatabase(tmp_path / "test.db"))


def test_seed_creates_domain_with_terms_for_all_languages(tmp_path: Path) -> None:
    store = make_store(tmp_path)
    assert seed_terminology(store) is True
    domains = store.list_domains(owner_id=1)
    assert len(domains) == 1
    for language in Language:
        terms = store.list_terms(domains[0].id, owner_id=1, language=language)
        assert terms, f"no seeded terms for {language.value}"
        assert all(term.forbidden_variants for term in terms)


def test_seed_only_populates_an_empty_store(tmp_path: Path) -> None:
    store = make_store(tmp_path)
    seed_terminology(store)
    assert seed_terminology(store) is False  # idempotent
    assert len(store.list_domains(owner_id=1)) == 1


def test_seed_runs_even_when_only_a_user_domain_exists(tmp_path: Path) -> None:
    # The presence check looks only at global (owner_id IS NULL) rows, so a
    # user's own domain must not suppress seeding.
    own = make_store(tmp_path / "other")
    own.create_domain("Mine", owner_id=1)
    assert seed_terminology(own) is True
    names = {d.name for d in own.list_domains(owner_id=1)}
    assert names == {"Mine", DOMAIN_NAME}


def test_seed_domain_name_constant_matches_the_seeder():
    from app.services.seed import DOMAIN_NAME
    from app.services.terminology import _SEED_DOMAIN_NAME

    assert _SEED_DOMAIN_NAME == DOMAIN_NAME
