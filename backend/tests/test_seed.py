from app.core.models import Language
from app.services.seed import DOMAIN_NAME, seed_terminology
from app.services.terminology import TerminologyStore, UsageStatus
from tests.terminology_helpers import changes


def make_store(db) -> TerminologyStore:
    return TerminologyStore(db)


def test_seed_creates_domain_with_terms_for_all_languages(db) -> None:
    store = make_store(db)
    assert seed_terminology(store) is True
    domains = store.list_domains(owner_id=1)
    assert len(domains) == 1
    for language in Language:
        sections = store.list_sections(domains[0].id, owner_id=1, language=language)
        assert sections, f"no seeded terms for {language.value}"
        for section in sections:
            usages = [term.usage_status for term in section.terms]
            assert usages.count(UsageStatus.PREFERRED) == 1, (language.value, usages)
            assert UsageStatus.FORBIDDEN in usages, (language.value, usages)


def test_seed_is_logged_with_origin_seed_and_no_user(db) -> None:
    seed_terminology(make_store(db))
    entries = changes(db)
    assert entries
    assert {(entry["origin"], entry["user_id"]) for entry in entries} == {("seed", None)}


def test_seed_only_populates_an_empty_store(db) -> None:
    store = make_store(db)
    seed_terminology(store)
    assert seed_terminology(store) is False  # idempotent
    assert len(store.list_domains(owner_id=1)) == 1


def test_seed_runs_even_when_only_a_user_domain_exists(db) -> None:
    # The presence check looks only at global (owner_id IS NULL) rows, so a
    # user's own domain must not suppress seeding.
    own = make_store(db)
    own.create_domain("Mine", owner_id=1)
    assert seed_terminology(own) is True
    names = {d.name for d in own.list_domains(owner_id=1)}
    assert names == {"Mine", DOMAIN_NAME}


def test_seed_domain_name_constant_matches_the_seeder():
    from app.services.seed import DOMAIN_NAME
    from app.services.terminology import _SEED_DOMAIN_NAME

    assert _SEED_DOMAIN_NAME == DOMAIN_NAME
