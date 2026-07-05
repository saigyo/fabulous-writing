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


class TestCasingHelpers:
    def test_exact_casing_is_ok(self) -> None:
        from app.checkers.terminology import _casing_ok

        assert _casing_ok("Use GitHub now", 4, "GitHub", "GitHub") is True

    def test_wrong_casing_is_not_ok(self) -> None:
        from app.checkers.terminology import _casing_ok

        assert _casing_ok("Use Github now", 4, "Github", "GitHub") is False
        assert _casing_ok("Use GITHUB now", 4, "GITHUB", "GitHub") is False

    def test_capitalized_at_sentence_start_is_ok(self) -> None:
        from app.checkers.terminology import _casing_ok

        assert _casing_ok("Sign in here.", 0, "Sign in", "sign in") is True
        text = "Great. Sign in here."
        assert _casing_ok(text, 7, "Sign in", "sign in") is True
        text = "Intro:\n- Sign in here."
        assert _casing_ok(text, 9, "Sign in", "sign in") is True

    def test_capitalized_mid_sentence_is_not_ok(self) -> None:
        from app.checkers.terminology import _casing_ok

        text = "Please Sign in here."
        assert _casing_ok(text, 7, "Sign in", "sign in") is False

    def test_title_case_at_sentence_start_is_not_ok(self) -> None:
        from app.checkers.terminology import _casing_ok

        assert _casing_ok("Sign In here.", 0, "Sign In", "sign in") is False


class TestPreferredCasing:
    def _github_domain(self, store: TerminologyStore) -> int:
        domain = store.create_domain("Dev")
        store.create_term(
            domain.id,
            language=Language.EN,
            preferred="GitHub",
            forbidden_variants=["Git Hub"],
            case_sensitive=True,
        )
        return domain.id

    def test_flags_wrong_casing_of_preferred(self, store: TerminologyStore) -> None:
        domain_id = self._github_domain(store)
        checker = TerminologyChecker(store)
        findings = checker.check("We are on github now.", Language.EN, domain_id)
        assert len(findings) == 1
        f = findings[0]
        assert f.span.text == "github"
        assert f.suggestions == ["GitHub"]
        assert "GitHub" in f.message

    def test_correct_casing_is_not_flagged(self, store: TerminologyStore) -> None:
        domain_id = self._github_domain(store)
        checker = TerminologyChecker(store)
        assert checker.check("We are on GitHub now.", Language.EN, domain_id) == []

    def test_case_insensitive_term_is_not_casing_checked(
        self, store: TerminologyStore
    ) -> None:
        domain = store.create_domain("Dev")
        store.create_term(
            domain.id,
            language=Language.EN,
            preferred="sign in",
            forbidden_variants=["login"],
        )
        checker = TerminologyChecker(store)
        assert checker.check("SIGN IN here.", Language.EN, domain.id) == []

    def test_sentence_start_capitalization_is_allowed(
        self, store: TerminologyStore
    ) -> None:
        domain = store.create_domain("Dev")
        store.create_term(
            domain.id,
            language=Language.EN,
            preferred="sign in",
            forbidden_variants=["login"],
            case_sensitive=True,
        )
        checker = TerminologyChecker(store)
        assert checker.check("Sign in to your account.", Language.EN, domain.id) == []
        findings = checker.check("Please Sign In now.", Language.EN, domain.id)
        assert len(findings) == 1
        assert findings[0].span.text == "Sign In"

    def test_casing_finding_overlapping_variant_is_dropped(
        self, store: TerminologyStore
    ) -> None:
        domain = store.create_domain("Dev")
        store.create_term(
            domain.id,
            language=Language.EN,
            preferred="GitHub",
            forbidden_variants=["Github Enterprise"],
            case_sensitive=True,
        )
        checker = TerminologyChecker(store)
        findings = checker.check("Use Github Enterprise.", Language.EN, domain.id)
        assert len(findings) == 1
        assert findings[0].span.text == "Github Enterprise"


class TestCjkChecker:
    def test_ja_terminology_matches_via_tokens(self, store: TerminologyStore) -> None:
        from app.core.config import NlpSettings
        from app.nlp.registry import NlpRegistry

        domain = store.create_domain("dev")
        store.create_term(
            domain.id,
            language=Language.JA,
            preferred="利用者",
            forbidden_variants=["ユーザー"],
        )
        checker = TerminologyChecker(store, nlp=NlpRegistry(NlpSettings().models))
        text = "ユーザーはこの機能を使います。"
        findings = checker.check(text, Language.JA, domain.id)
        assert len(findings) == 1
        assert findings[0].span.text == "ユーザー"
        assert text[findings[0].span.start : findings[0].span.end] == "ユーザー"
        assert findings[0].suggestions == ["利用者"]

    def test_zh_terminology_matches_without_whitespace(
        self, store: TerminologyStore
    ) -> None:
        from app.core.config import NlpSettings
        from app.nlp.registry import NlpRegistry

        domain = store.create_domain("dev")
        store.create_term(
            domain.id,
            language=Language.ZH,
            preferred="用户",
            forbidden_variants=["使用者"],
        )
        checker = TerminologyChecker(store, nlp=NlpRegistry(NlpSettings().models))
        findings = checker.check("使用者可以使用这个功能。", Language.ZH, domain.id)
        assert len(findings) == 1
        assert findings[0].span.text == "使用者"

    def test_cjk_falls_back_to_substring_without_model(
        self, store: TerminologyStore
    ) -> None:
        from app.nlp.registry import NlpRegistry

        domain = store.create_domain("dev")
        store.create_term(
            domain.id,
            language=Language.JA,
            preferred="利用者",
            forbidden_variants=["ユーザー"],
        )
        checker = TerminologyChecker(store, nlp=NlpRegistry({"ja": "xx_bogus_model"}))
        findings = checker.check("ユーザーは使います。", Language.JA, domain.id)
        assert len(findings) == 1
        assert findings[0].span.text == "ユーザー"
