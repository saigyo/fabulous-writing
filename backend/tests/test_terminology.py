import sqlite3
from pathlib import Path

import pytest

from app.checkers.terminology import TerminologyChecker
from app.core.models import Category, Language, Severity, Source
from app.services.db.sqlite import SqliteDatabase, connect
from app.services.ownership import GlobalReadOnlyError
from app.services.seed import DOMAIN_NAME, seed_terminology
from app.services.terminology import TerminologyStore


@pytest.fixture
def store(tmp_path: Path) -> TerminologyStore:
    return TerminologyStore(SqliteDatabase(tmp_path / "test.db"))


class TestStore:
    def test_connection_is_closed_after_use(self, store: TerminologyStore) -> None:
        # `with sqlite3.connect(...)` alone only manages the transaction; the
        # store must also close the connection or every operation leaks one.
        with store._connect() as conn:
            conn.execute("SELECT 1")
        with pytest.raises(sqlite3.ProgrammingError):
            conn.execute("SELECT 1")

    def test_create_and_list_domains(self, store: TerminologyStore) -> None:
        domain = store.create_domain("Cloud", "Cloud platform docs", owner_id=None)
        assert domain.id
        assert domain.name == "Cloud"
        assert [d.name for d in store.list_domains(owner_id=1)] == ["Cloud"]

    def test_update_domain(self, store: TerminologyStore) -> None:
        domain = store.create_domain("Cloud", owner_id=None)
        updated = store.update_domain(
            domain.id, owner_id=1, is_admin=True, name="Cloud Docs", description="x"
        )
        assert updated is not None
        assert updated.name == "Cloud Docs"
        assert store.update_domain(9999, owner_id=1, is_admin=True, name="nope") is None

    def test_delete_domain_cascades_terms(self, store: TerminologyStore) -> None:
        domain = store.create_domain("Cloud", owner_id=None)
        store.create_term(
            domain.id,
            owner_id=1,
            is_admin=True,
            language=Language.EN,
            preferred="virtual machine",
            forbidden_variants=["VM instance"],
        )
        assert store.delete_domain(domain.id, owner_id=1, is_admin=True) is True
        assert store.list_domains(owner_id=1) == []
        # The domain is gone, so its terms are unreachable through the same
        # invisible-domain path as a foreign one.
        assert store.list_terms(domain.id, owner_id=1) is None

    def test_create_and_update_term(self, store: TerminologyStore) -> None:
        domain = store.create_domain("Cloud", owner_id=None)
        term = store.create_term(
            domain.id,
            owner_id=1,
            is_admin=True,
            language=Language.EN,
            preferred="sign in",
            forbidden_variants=["login", "log-in"],
            definition="Authenticating with the service.",
        )
        assert term is not None
        assert term.forbidden_variants == ["login", "log-in"]
        assert term.case_sensitive is False
        updated = store.update_term(
            term.id, owner_id=1, is_admin=True, preferred="sign in to"
        )
        assert updated is not None
        assert updated.preferred == "sign in to"
        assert updated.forbidden_variants == ["login", "log-in"]

    def test_list_terms_filters_by_language(self, store: TerminologyStore) -> None:
        domain = store.create_domain("Cloud", owner_id=None)
        store.create_term(
            domain.id, owner_id=1, is_admin=True, language=Language.EN, preferred="sign in"
        )
        store.create_term(
            domain.id, owner_id=1, is_admin=True, language=Language.DE, preferred="anmelden"
        )
        en_terms = store.list_terms(domain.id, owner_id=1, language=Language.EN)
        assert en_terms is not None
        assert [t.preferred for t in en_terms] == ["sign in"]

    def test_delete_term(self, store: TerminologyStore) -> None:
        domain = store.create_domain("Cloud", owner_id=None)
        term = store.create_term(
            domain.id, owner_id=1, is_admin=True, language=Language.EN, preferred="x"
        )
        assert term is not None
        assert store.delete_term(term.id, owner_id=1, is_admin=True) is True
        assert store.delete_term(term.id, owner_id=1, is_admin=True) is False


class TestChecker:
    def test_flags_forbidden_variant_and_suggests_preferred(
        self, store: TerminologyStore
    ) -> None:
        domain = store.create_domain("Cloud", owner_id=None)
        store.create_term(
            domain.id,
            owner_id=1,
            is_admin=True,
            language=Language.EN,
            preferred="sign in",
            forbidden_variants=["login", "log-in"],
        )
        checker = TerminologyChecker(store)
        findings = checker.check(
            "Please Login to continue.", Language.EN, domain.id, owner_id=1
        )
        assert len(findings) == 1
        f = findings[0]
        assert f.category == Category.TERMINOLOGY
        assert f.severity == Severity.ERROR
        assert f.source == Source.TERMINOLOGY
        assert f.span.text == "Login"
        assert f.suggestions == ["sign in"]
        assert "sign in" in f.message

    def test_case_sensitive_term(self, store: TerminologyStore) -> None:
        domain = store.create_domain("Cloud", owner_id=None)
        store.create_term(
            domain.id,
            owner_id=1,
            is_admin=True,
            language=Language.EN,
            preferred="GitHub",
            forbidden_variants=["Github"],
            case_sensitive=True,
        )
        checker = TerminologyChecker(store)
        assert checker.check("On GitHub today", Language.EN, domain.id, owner_id=1) == []
        assert (
            len(checker.check("On Github today", Language.EN, domain.id, owner_id=1))
            == 1
        )

    def test_only_checks_requested_language_and_domain(
        self, store: TerminologyStore
    ) -> None:
        domain = store.create_domain("Cloud", owner_id=None)
        other = store.create_domain("Legal", owner_id=None)
        store.create_term(
            domain.id,
            owner_id=1,
            is_admin=True,
            language=Language.DE,
            preferred="anmelden",
            forbidden_variants=["einloggen"],
        )
        checker = TerminologyChecker(store)
        assert checker.check("einloggen", Language.EN, domain.id, owner_id=1) == []
        assert checker.check("einloggen", Language.DE, other.id, owner_id=1) == []
        assert len(checker.check("einloggen", Language.DE, domain.id, owner_id=1)) == 1


def test_domain_visibility_and_admin_rule(tmp_path):
    store = TerminologyStore(SqliteDatabase(tmp_path / "t.db"))
    shared = store.create_domain("Shared", owner_id=None)
    mine = store.create_domain("Mine", owner_id=1)
    store.create_domain("Theirs", owner_id=2)
    assert {d.name for d in store.list_domains(owner_id=1)} == {"Shared", "Mine"}
    assert store.get_domain(mine.id, owner_id=2) is None
    with pytest.raises(GlobalReadOnlyError):
        store.update_domain(shared.id, owner_id=1, is_admin=False, name="X")
    with pytest.raises(GlobalReadOnlyError):
        store.delete_domain(shared.id, owner_id=1, is_admin=False)
    assert store.update_domain(shared.id, owner_id=1, is_admin=True, name="X").name == "X"


def test_domain_names_unique_per_owner(tmp_path):
    store = TerminologyStore(SqliteDatabase(tmp_path / "t.db"))
    store.create_domain("Docs", owner_id=1)
    store.create_domain("docs", owner_id=2)      # other owner: fine
    store.create_domain("Docs", owner_id=None)   # global partition: fine
    with pytest.raises(ValueError):
        store.create_domain("DOCS", owner_id=1)  # own duplicate, case-insensitive (LOWER)
    with pytest.raises(ValueError):
        store.create_domain("docs", owner_id=None)


def test_terms_inherit_domain_ownership(tmp_path):
    store = TerminologyStore(SqliteDatabase(tmp_path / "t.db"))
    shared = store.create_domain("Shared", owner_id=None)
    theirs = store.create_domain("Theirs", owner_id=2)
    term = store.create_term(
        theirs.id, owner_id=2, is_admin=False,
        language=Language.EN, preferred="ok",
    )
    # Foreign domain: everything is invisible/404-shaped.
    assert store.list_terms(theirs.id, owner_id=1) is None
    assert store.get_term(term.id, owner_id=1) is None
    assert store.create_term(
        theirs.id, owner_id=1, is_admin=False,
        language=Language.EN, preferred="x",
    ) is None
    assert store.update_term(term.id, owner_id=1, is_admin=False, preferred="x") is None
    assert store.delete_term(term.id, owner_id=1, is_admin=False) is False
    # Global domain: reads for everyone, writes for admins.
    with pytest.raises(GlobalReadOnlyError):
        store.create_term(
            shared.id, owner_id=1, is_admin=False,
            language=Language.EN, preferred="x",
        )
    ok = store.create_term(
        shared.id, owner_id=1, is_admin=True,
        language=Language.EN, preferred="sign in",
    )
    assert store.list_terms(shared.id, owner_id=1) == [ok]


def test_migration_backfills_domain_ownership(tmp_path):
    db = tmp_path / "legacy.db"
    with connect(db) as conn:
        conn.execute(
            """CREATE TABLE domains (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                description TEXT NOT NULL DEFAULT ''
            )"""
        )
        conn.execute("INSERT INTO domains (name) VALUES ('Product docs')")
        conn.execute("INSERT INTO domains (name) VALUES ('My own domain')")
    store = TerminologyStore(SqliteDatabase(db))
    by_name = {d.name: d for d in store.list_domains(owner_id=1)}
    assert by_name["Product docs"].is_global is True   # seed-name match
    assert by_name["My own domain"].is_global is False # -> admin (1)
    TerminologyStore(SqliteDatabase(db))  # idempotent


def test_seeder_presence_check_is_global_only(tmp_path):
    store = TerminologyStore(SqliteDatabase(tmp_path / "t.db"))
    store.create_domain("User domain", owner_id=1)
    assert store.has_global_domains() is False   # a user domain must not
    assert seed_terminology(store) is True       # ...suppress seeding: it runs
    assert store.has_global_domains() is True
    seeded = next(d for d in store.list_domains(owner_id=1) if d.name == DOMAIN_NAME)
    assert seeded.is_global is True


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

    def test_sentence_start_detection_covers_each_context(self) -> None:
        from app.checkers.terminology import _sentence_start

        assert _sentence_start("", 0) is True  # start of text
        assert _sentence_start("Done. ", 6) is True  # after punctuation
        assert _sentence_start('Done." ', 7) is True  # closing quote between
        assert _sentence_start("Done.\n\n", 7) is True  # after a newline
        assert _sentence_start("Intro:\n- ", 9) is True  # markdown structure
        assert _sentence_start("Done.", 5) is False  # punctuation, no space
        assert _sentence_start("mid sentence ", 13) is False  # plain space
        assert _sentence_start("Done) ", 6) is False  # bracket is not punctuation

    def test_sentence_start_is_linear_in_document_length(self) -> None:
        # Guards against reintroducing the quadratic regex this replaced
        # (CodeQL py/polynomial-redos): searching for the `$` anchor from
        # every start position re-scanned the whitespace run each time, so a
        # document of newlines cost ~0.5 s at 16k characters and ~20 s at
        # 100k — once per term match, from a single request.
        #
        # `start` is the index of the trailing "x", not len(text): callers
        # only ever pass a match position, and it is what makes the scan walk
        # the whole 200k newline run instead of stopping at the first
        # character.
        #
        # The bound is deliberately loose. The linear scan takes ~5 ms
        # locally, while the quadratic form would need ~80 s at this size, so
        # anything in between separates them; 5 s leaves a shared CI runner
        # three orders of magnitude of headroom over the real cost while
        # still failing decisively on a regression.
        import time

        from app.checkers.terminology import _sentence_start

        text = "\n" * 200_000 + "x"
        started = time.perf_counter()
        assert _sentence_start(text, len(text) - 1) is True
        assert time.perf_counter() - started < 5.0


class TestPreferredCasing:
    def _github_domain(self, store: TerminologyStore) -> int:
        domain = store.create_domain("Dev", owner_id=None)
        store.create_term(
            domain.id,
            owner_id=1,
            is_admin=True,
            language=Language.EN,
            preferred="GitHub",
            forbidden_variants=["Git Hub"],
            case_sensitive=True,
        )
        return domain.id

    def test_flags_wrong_casing_of_preferred(self, store: TerminologyStore) -> None:
        domain_id = self._github_domain(store)
        checker = TerminologyChecker(store)
        findings = checker.check(
            "We are on github now.", Language.EN, domain_id, owner_id=1
        )
        assert len(findings) == 1
        f = findings[0]
        assert f.span.text == "github"
        assert f.suggestions == ["GitHub"]
        assert "GitHub" in f.message

    def test_correct_casing_is_not_flagged(self, store: TerminologyStore) -> None:
        domain_id = self._github_domain(store)
        checker = TerminologyChecker(store)
        assert (
            checker.check("We are on GitHub now.", Language.EN, domain_id, owner_id=1)
            == []
        )

    def test_case_insensitive_term_is_not_casing_checked(
        self, store: TerminologyStore
    ) -> None:
        domain = store.create_domain("Dev", owner_id=None)
        store.create_term(
            domain.id,
            owner_id=1,
            is_admin=True,
            language=Language.EN,
            preferred="sign in",
            forbidden_variants=["login"],
        )
        checker = TerminologyChecker(store)
        assert checker.check("SIGN IN here.", Language.EN, domain.id, owner_id=1) == []

    def test_sentence_start_capitalization_is_allowed(
        self, store: TerminologyStore
    ) -> None:
        domain = store.create_domain("Dev", owner_id=None)
        store.create_term(
            domain.id,
            owner_id=1,
            is_admin=True,
            language=Language.EN,
            preferred="sign in",
            forbidden_variants=["login"],
            case_sensitive=True,
        )
        checker = TerminologyChecker(store)
        assert (
            checker.check(
                "Sign in to your account.", Language.EN, domain.id, owner_id=1
            )
            == []
        )
        findings = checker.check(
            "Please Sign In now.", Language.EN, domain.id, owner_id=1
        )
        assert len(findings) == 1
        assert findings[0].span.text == "Sign In"

    def test_casing_finding_overlapping_variant_is_dropped(
        self, store: TerminologyStore
    ) -> None:
        domain = store.create_domain("Dev", owner_id=None)
        store.create_term(
            domain.id,
            owner_id=1,
            is_admin=True,
            language=Language.EN,
            preferred="GitHub",
            forbidden_variants=["Github Enterprise"],
            case_sensitive=True,
        )
        checker = TerminologyChecker(store)
        findings = checker.check(
            "Use Github Enterprise.", Language.EN, domain.id, owner_id=1
        )
        assert len(findings) == 1
        assert findings[0].span.text == "Github Enterprise"


class TestCjkChecker:
    def test_ja_terminology_matches_via_tokens(self, store: TerminologyStore) -> None:
        from app.core.config import NlpSettings
        from app.nlp.registry import NlpRegistry

        domain = store.create_domain("dev", owner_id=None)
        store.create_term(
            domain.id,
            owner_id=1,
            is_admin=True,
            language=Language.JA,
            preferred="利用者",
            forbidden_variants=["ユーザー"],
        )
        checker = TerminologyChecker(store, nlp=NlpRegistry(NlpSettings().models))
        text = "ユーザーはこの機能を使います。"
        findings = checker.check(text, Language.JA, domain.id, owner_id=1)
        assert len(findings) == 1
        assert findings[0].span.text == "ユーザー"
        assert text[findings[0].span.start : findings[0].span.end] == "ユーザー"
        assert findings[0].suggestions == ["利用者"]

    def test_zh_terminology_matches_without_whitespace(
        self, store: TerminologyStore
    ) -> None:
        from app.core.config import NlpSettings
        from app.nlp.registry import NlpRegistry

        domain = store.create_domain("dev", owner_id=None)
        store.create_term(
            domain.id,
            owner_id=1,
            is_admin=True,
            language=Language.ZH,
            preferred="用户",
            forbidden_variants=["使用者"],
        )
        checker = TerminologyChecker(store, nlp=NlpRegistry(NlpSettings().models))
        findings = checker.check(
            "使用者可以使用这个功能。", Language.ZH, domain.id, owner_id=1
        )
        assert len(findings) == 1
        assert findings[0].span.text == "使用者"

    def test_cjk_falls_back_to_substring_without_model(
        self, store: TerminologyStore
    ) -> None:
        from app.nlp.registry import NlpRegistry

        domain = store.create_domain("dev", owner_id=None)
        store.create_term(
            domain.id,
            owner_id=1,
            is_admin=True,
            language=Language.JA,
            preferred="利用者",
            forbidden_variants=["ユーザー"],
        )
        checker = TerminologyChecker(store, nlp=NlpRegistry({"ja": "xx_bogus_model"}))
        findings = checker.check(
            "ユーザーは使います。", Language.JA, domain.id, owner_id=1
        )
        assert len(findings) == 1
        assert findings[0].span.text == "ユーザー"

    def test_ja_flags_wrong_casing_of_embedded_latin_preferred(
        self, store: TerminologyStore
    ) -> None:
        from app.core.config import NlpSettings
        from app.nlp.registry import NlpRegistry

        domain = store.create_domain("dev", owner_id=None)
        store.create_term(
            domain.id,
            owner_id=1,
            is_admin=True,
            language=Language.JA,
            preferred="GitHub",
            forbidden_variants=["ギットハブ"],
            case_sensitive=True,
        )
        checker = TerminologyChecker(store, nlp=NlpRegistry(NlpSettings().models))
        text = "コードは Github にあります。"
        findings = checker.check(text, Language.JA, domain.id, owner_id=1)
        assert len(findings) == 1
        assert findings[0].span.text == "Github"
        assert findings[0].suggestions == ["GitHub"]
        assert (
            checker.check("コードは GitHub にあります。", Language.JA, domain.id, owner_id=1)
            == []
        )

    def test_cjk_substring_fallback_checks_preferred_casing(
        self, store: TerminologyStore
    ) -> None:
        from app.nlp.registry import NlpRegistry

        domain = store.create_domain("dev", owner_id=None)
        store.create_term(
            domain.id,
            owner_id=1,
            is_admin=True,
            language=Language.JA,
            preferred="GitHub",
            forbidden_variants=["ギットハブ"],
            case_sensitive=True,
        )
        checker = TerminologyChecker(store, nlp=NlpRegistry({"ja": "xx_bogus_model"}))
        findings = checker.check(
            "コードは Github にあります。", Language.JA, domain.id, owner_id=1
        )
        assert len(findings) == 1
        assert findings[0].span.text == "Github"
