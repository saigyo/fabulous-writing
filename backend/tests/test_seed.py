from pathlib import Path

from app.core.models import Language
from app.services.seed import seed_terminology
from app.services.terminology import TerminologyStore


def make_store(tmp_path: Path) -> TerminologyStore:
    return TerminologyStore(tmp_path / "test.db")


def test_seed_creates_domain_with_terms_for_all_languages(tmp_path: Path) -> None:
    store = make_store(tmp_path)
    assert seed_terminology(store) is True
    domains = store.list_domains()
    assert len(domains) == 1
    for language in Language:
        terms = store.list_terms(domains[0].id, language=language)
        assert terms, f"no seeded terms for {language.value}"
        assert all(term.forbidden_variants for term in terms)


def test_seed_only_populates_an_empty_store(tmp_path: Path) -> None:
    store = make_store(tmp_path)
    seed_terminology(store)
    assert seed_terminology(store) is False  # idempotent
    assert len(store.list_domains()) == 1

    own = make_store(tmp_path / "other")
    own.create_domain("Mine")
    assert seed_terminology(own) is False  # never touches user data
    assert [d.name for d in own.list_domains()] == ["Mine"]
