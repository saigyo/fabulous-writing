import pytest

from app.checkers.terminology import TerminologyChecker
from app.core.config import NlpSettings
from app.core.models import Finding, Language, Severity
from app.nlp.registry import NlpRegistry
from app.services.terminology import ProcessStatus, TermInput, TerminologyStore, UsageStatus
from tests.terminology_helpers import add_concept

P, A, D, F = (
    UsageStatus.PREFERRED,
    UsageStatus.ADMITTED,
    UsageStatus.DEPRECATED,
    UsageStatus.FORBIDDEN,
)
ACTIVE, CANDIDATE = ProcessStatus.ACTIVE, ProcessStatus.CANDIDATE
EN = Language.EN


@pytest.fixture
def store(db) -> TerminologyStore:
    return TerminologyStore(db)


def domain(store: TerminologyStore) -> int:
    return store.create_domain("Dev", owner_id=None).id


def check(
    store: TerminologyStore,
    domain_id: int,
    text: str,
    language: Language = EN,
    nlp: NlpRegistry | None = None,
) -> list[Finding]:
    return TerminologyChecker(store, nlp=nlp).check(text, language, domain_id, owner_id=1)


def test_severity_follows_the_usage_status(store):
    d = domain(store)
    add_concept(store, d, language=EN, terms=[
        ("sign in", P, ACTIVE), ("log on", A, ACTIVE), ("login", F, ACTIVE), ("log-in", D, ACTIVE),
    ])
    findings = check(store, d, "Please login, log-in or log on, then sign in.")
    assert [(f.span.text, f.severity, f.suggestions) for f in findings] == [
        ("login", Severity.ERROR, ["sign in"]),
        ("log-in", Severity.WARNING, ["sign in"]),
    ]


def test_candidates_are_ignored_completely(store):
    d = domain(store)
    add_concept(store, d, language=EN, terms=[("sign in", P, ACTIVE), ("login", F, CANDIDATE)])
    add_concept(store, d, language=EN, terms=[("enter", P, CANDIDATE), ("logon", F, ACTIVE)])
    assert check(store, d, "Please login.") == []
    (finding,) = check(store, d, "Please logon.")
    assert finding.suggestions == []
    assert finding.message == "'logon' is forbidden."


def test_replacement_falls_back_to_the_admitted_terms(store):
    d = domain(store)
    add_concept(store, d, language=EN, terms=[
        ("log on", A, ACTIVE), ("Access", A, ACTIVE), ("login", F, ACTIVE),
    ])
    (finding,) = check(store, d, "Please login.")
    assert finding.suggestions == ["Access", "log on"]
    assert finding.message == "Use 'Access' or 'log on' instead of 'login'."


def test_preferred_term_wins_over_admitted_terms_as_replacement(store):
    d = domain(store)
    add_concept(store, d, language=EN, terms=[
        ("sign in", P, ACTIVE), ("log on", A, ACTIVE), ("login", F, ACTIVE),
    ])
    (finding,) = check(store, d, "Please login.")
    assert finding.suggestions == ["sign in"]


def test_deprecated_and_forbidden_terms_are_never_replacements(store):
    d = domain(store)
    add_concept(store, d, language=EN, terms=[("login", F, ACTIVE), ("log-in", D, ACTIVE)])
    findings = check(store, d, "Please login or log-in.")
    assert [(f.span.text, f.suggestions, f.message) for f in findings] == [
        ("login", [], "'login' is forbidden."),
        ("log-in", [], "'log-in' is deprecated."),
    ]


@pytest.mark.parametrize("preferred, reason, definition, expected", [
    ("sign in", "Legal asked for it.", "Enter the product.",
     "Use 'sign in' instead of 'login'. Legal asked for it. Enter the product."),
    (None, "Legal asked for it.", "Enter the product.",
     "'login' is forbidden. Legal asked for it. Enter the product."),
    ("sign in", "Legal asked for it.", "", "Use 'sign in' instead of 'login'. Legal asked for it."),
    ("sign in", "", "Enter the product.", "Use 'sign in' instead of 'login'. Enter the product."),
])
def test_message_carries_status_reason_then_definition(
    store, preferred, reason, definition, expected
):
    d = domain(store)
    terms = [TermInput(text="login", usage_status=F, status_reason=reason)]
    if preferred is not None:
        terms.insert(0, TermInput(text=preferred, usage_status=P))
    add_concept(store, d, language=EN, terms=terms, definition=definition)
    (finding,) = check(store, d, "Please login.")
    assert finding.message == expected


def test_message_quotes_the_text_as_written(store):
    d = domain(store)
    add_concept(store, d, language=EN, terms=[("sign in", P, ACTIVE), ("login", F, ACTIVE)])
    (finding,) = check(store, d, "Please LOGIN.")
    assert finding.message == "Use 'sign in' instead of 'LOGIN'."
    assert finding.span.text == "LOGIN"


def test_section_with_only_admitted_and_preferred_terms_reports_nothing(store):
    d = domain(store)
    add_concept(store, d, language=EN, terms=[("sign in", P, ACTIVE), ("log on", A, ACTIVE)])
    assert check(store, d, "Please sign in or log on.") == []


def test_rule_id_is_the_uid_of_the_deprecated_term(store):
    d = domain(store)
    concept = add_concept(
        store, d, language=EN, terms=[("sign in", P, ACTIVE), ("log-in", D, ACTIVE)]
    )
    (deprecated,) = [t for t in concept.sections[0].terms if t.text == "log-in"]
    (finding,) = check(store, d, "Please log-in.")
    assert finding.rule_id == f"terminology.{deprecated.uid}"


def test_findings_on_the_same_span_follow_the_preferred_text(store):
    d = domain(store)
    add_concept(store, d, language=EN, terms=[("b", P, ACTIVE), ("login", F, ACTIVE)])
    add_concept(store, d, language=EN, terms=[("a", P, ACTIVE), ("login", F, ACTIVE)])
    findings = check(store, d, "Please login.")
    assert [f.suggestions for f in findings] == [["a"], ["b"]]


def test_sections_with_a_preferred_term_come_first(store):
    d = domain(store)
    add_concept(store, d, language=EN, terms=[("omega", A, ACTIVE), ("login", F, ACTIVE)])
    add_concept(store, d, language=EN, terms=[("zeta", P, ACTIVE), ("login", F, ACTIVE)])
    add_concept(store, d, language=EN, terms=[("login", F, ACTIVE)])
    findings = check(store, d, "Please login.")
    assert [f.suggestions for f in findings] == [["zeta"], ["omega"], []]


_CJK_CASES = [
    (Language.JA, "利用者", "ユーザー", "ユーザーはこの機能を使います。"),
    (Language.ZH, "用户", "使用者", "使用者可以使用这个功能。"),
]


def _cjk_warning(store, language, preferred, deprecated, text, nlp) -> None:
    d = domain(store)
    add_concept(store, d, language=language, terms=[
        (preferred, P, ACTIVE), (deprecated, D, ACTIVE),
    ])
    findings = check(store, d, text, language=language, nlp=nlp)
    assert [(f.span.text, f.severity, f.suggestions) for f in findings] == [
        (deprecated, Severity.WARNING, [preferred]),
    ]


@pytest.mark.parametrize("language, preferred, deprecated, text", _CJK_CASES)
def test_cjk_token_path_reports_deprecated_terms_as_warnings(
    store, language, preferred, deprecated, text
):
    nlp = NlpRegistry(NlpSettings().models)
    _cjk_warning(store, language, preferred, deprecated, text, nlp)


@pytest.mark.parametrize("language, preferred, deprecated, text", _CJK_CASES)
def test_cjk_substring_fallback_reports_deprecated_terms_as_warnings(
    store, language, preferred, deprecated, text
):
    _cjk_warning(store, language, preferred, deprecated, text, None)


def cased(text: str, usage: UsageStatus, reason: str = "") -> TermInput:
    return TermInput(
        text=text,
        usage_status=usage,
        process_status=ACTIVE,
        case_sensitive=True,
        status_reason=reason,
    )


def test_wrong_casing_of_an_admitted_term_is_an_error(store):
    d = domain(store)
    add_concept(store, d, language=EN, terms=[("sign in", P, ACTIVE), cased("GitHub", A)])
    (finding,) = check(store, d, "Open github now.")
    assert finding.severity == Severity.ERROR
    assert finding.suggestions == ["GitHub"]
    assert finding.message == "Use 'GitHub' instead of 'github'."


def test_sentence_start_exception_holds_for_admitted_terms(store):
    d = domain(store)
    add_concept(store, d, language=EN, terms=[("log on", P, ACTIVE), cased("sign in", A)])
    assert check(store, d, "Sign in now.") == []
    (finding,) = check(store, d, "Please Sign in now.")
    assert finding.severity == Severity.ERROR
    assert finding.suggestions == ["sign in"]


def test_casing_of_a_candidate_is_not_checked(store):
    d = domain(store)
    add_concept(store, d, language=EN, terms=[
        ("sign in", P, ACTIVE),
        TermInput(
            text="GitHub", usage_status=A, process_status=CANDIDATE, case_sensitive=True
        ),
    ])
    assert check(store, d, "Open github now.") == []


def test_casing_finding_has_no_status_reason(store):
    d = domain(store)
    add_concept(
        store, d, language=EN, terms=[cased("GitHub", P, "Brand.")], definition="Code hosting."
    )
    (finding,) = check(store, d, "Open github now.")
    assert finding.message == "Use 'GitHub' instead of 'github'. Code hosting."


def test_warning_overlapping_an_error_is_dropped(store):
    d = domain(store)
    add_concept(store, d, language=EN, terms=[("e-mail", F, ACTIVE)])
    add_concept(store, d, language=EN, terms=[("mail", D, ACTIVE)])
    (finding,) = check(store, d, "Send an e-mail.")
    assert (finding.span.text, finding.severity) == ("e-mail", Severity.ERROR)


def test_overlapping_findings_of_the_same_severity_are_both_kept(store):
    d = domain(store)
    add_concept(store, d, language=EN, terms=[("e-mail", F, ACTIVE)])
    add_concept(store, d, language=EN, terms=[("mail", F, ACTIVE)])
    assert len(check(store, d, "Send an e-mail.")) == 2


def test_status_warning_wins_over_a_casing_error(store):
    d = domain(store)
    add_concept(store, d, language=EN, terms=[cased("GitHub", P)])
    add_concept(store, d, language=EN, terms=[("email", P, ACTIVE), ("github", D, ACTIVE)])
    (finding,) = check(store, d, "Open github.")
    assert finding.severity == Severity.WARNING


def test_non_overlapping_warning_next_to_an_error_is_kept(store):
    d = domain(store)
    add_concept(store, d, language=EN, terms=[("sign in", P, ACTIVE), ("login", F, ACTIVE)])
    add_concept(store, d, language=EN, terms=[("log-in", D, ACTIVE)])
    findings = check(store, d, "Please login or log-in.")
    assert [(f.span.text, f.severity) for f in findings] == [
        ("login", Severity.ERROR),
        ("log-in", Severity.WARNING),
    ]


@pytest.mark.parametrize("with_nlp", [True, False])
def test_cjk_casing_covers_admitted_terms(store, with_nlp):
    d = domain(store)
    add_concept(
        store, d, language=Language.JA, terms=[("利用者", P, ACTIVE), cased("GitHub", A)]
    )
    nlp = NlpRegistry(NlpSettings().models) if with_nlp else None
    (finding,) = check(store, d, "GitHubを使います。github を開く。", language=Language.JA, nlp=nlp)
    assert finding.span.text == "github"
    assert finding.suggestions == ["GitHub"]
