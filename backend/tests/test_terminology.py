from pathlib import Path

import pytest

from app.checkers.terminology import TerminologyChecker
from app.core.models import Category, Language, Severity, Source
from app.services.terminology import TerminologyStore


@pytest.fixture
def store(tmp_path: Path) -> TerminologyStore:
    return TerminologyStore(tmp_path / "test.db")


class TestStore:
    def test_create_and_list_domains(self, store: TerminologyStore) -> None:
        domain = store.create_domain("Cloud", "Cloud platform docs")
        assert domain.id
        assert domain.name == "Cloud"
        assert [d.name for d in store.list_domains()] == ["Cloud"]

    def test_update_domain(self, store: TerminologyStore) -> None:
        domain = store.create_domain("Cloud")
        updated = store.update_domain(domain.id, name="Cloud Docs", description="x")
        assert updated is not None
        assert updated.name == "Cloud Docs"
        assert store.update_domain(9999, name="nope") is None

    def test_delete_domain_cascades_terms(self, store: TerminologyStore) -> None:
        domain = store.create_domain("Cloud")
        store.create_term(
            domain.id,
            language=Language.EN,
            preferred="virtual machine",
            forbidden_variants=["VM instance"],
        )
        assert store.delete_domain(domain.id) is True
        assert store.list_domains() == []
        assert store.list_terms(domain.id) == []

    def test_create_and_update_term(self, store: TerminologyStore) -> None:
        domain = store.create_domain("Cloud")
        term = store.create_term(
            domain.id,
            language=Language.EN,
            preferred="sign in",
            forbidden_variants=["login", "log-in"],
            definition="Authenticating with the service.",
        )
        assert term.forbidden_variants == ["login", "log-in"]
        assert term.case_sensitive is False
        updated = store.update_term(term.id, preferred="sign in to")
        assert updated is not None
        assert updated.preferred == "sign in to"
        assert updated.forbidden_variants == ["login", "log-in"]

    def test_list_terms_filters_by_language(self, store: TerminologyStore) -> None:
        domain = store.create_domain("Cloud")
        store.create_term(domain.id, language=Language.EN, preferred="sign in")
        store.create_term(domain.id, language=Language.DE, preferred="anmelden")
        en_terms = store.list_terms(domain.id, language=Language.EN)
        assert [t.preferred for t in en_terms] == ["sign in"]

    def test_delete_term(self, store: TerminologyStore) -> None:
        domain = store.create_domain("Cloud")
        term = store.create_term(domain.id, language=Language.EN, preferred="x")
        assert store.delete_term(term.id) is True
        assert store.delete_term(term.id) is False


class TestChecker:
    def test_flags_forbidden_variant_and_suggests_preferred(
        self, store: TerminologyStore
    ) -> None:
        domain = store.create_domain("Cloud")
        store.create_term(
            domain.id,
            language=Language.EN,
            preferred="sign in",
            forbidden_variants=["login", "log-in"],
        )
        checker = TerminologyChecker(store)
        findings = checker.check("Please Login to continue.", Language.EN, domain.id)
        assert len(findings) == 1
        f = findings[0]
        assert f.category == Category.TERMINOLOGY
        assert f.severity == Severity.ERROR
        assert f.source == Source.TERMINOLOGY
        assert f.span.text == "Login"
        assert f.suggestions == ["sign in"]
        assert "sign in" in f.message

    def test_case_sensitive_term(self, store: TerminologyStore) -> None:
        domain = store.create_domain("Cloud")
        store.create_term(
            domain.id,
            language=Language.EN,
            preferred="GitHub",
            forbidden_variants=["Github"],
            case_sensitive=True,
        )
        checker = TerminologyChecker(store)
        assert checker.check("On GitHub today", Language.EN, domain.id) == []
        assert len(checker.check("On Github today", Language.EN, domain.id)) == 1

    def test_only_checks_requested_language_and_domain(
        self, store: TerminologyStore
    ) -> None:
        domain = store.create_domain("Cloud")
        other = store.create_domain("Legal")
        store.create_term(
            domain.id,
            language=Language.DE,
            preferred="anmelden",
            forbidden_variants=["einloggen"],
        )
        checker = TerminologyChecker(store)
        assert checker.check("einloggen", Language.EN, domain.id) == []
        assert checker.check("einloggen", Language.DE, other.id) == []
        assert len(checker.check("einloggen", Language.DE, domain.id)) == 1
