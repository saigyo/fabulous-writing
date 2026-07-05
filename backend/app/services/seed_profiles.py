"""Seed checking profiles: a Standard profile per language, plus deletable
Marketing / Technical Documentation examples for EN, DE, JA (tracked in a
marker table so deletions stick across restarts)."""

from pathlib import Path

from app.core.models import Language
from app.services.profiles import ProfileStore

EXAMPLE_LANGUAGES = {Language.EN, Language.DE, Language.JA}

_MARKETING_INSTRUCTIONS = {
    Language.EN: (
        "Audience: prospective customers. Favor energetic, benefit-led, concrete "
        "phrasing; short sentences; active voice. Flag jargon, hedging, and vague "
        "claims that are not backed by specifics."
    ),
    Language.DE: (
        "Zielgruppe: potenzielle Kundinnen und Kunden. Bevorzuge energische, "
        "nutzenorientierte, konkrete Formulierungen; kurze Sätze; Aktiv statt "
        "Passiv. Markiere Fachjargon, vage Behauptungen und Abschwächungen."
    ),
    Language.JA: (
        "対象読者:見込み顧客。エネルギッシュで、利点を先に示す具体的な表現を優先。"
        "短い文、能動態を推奨。専門用語、曖昧な主張、根拠のない誇張を指摘すること。"
    ),
}

_TECHDOC_INSTRUCTIONS = {
    Language.EN: (
        "Audience: users following instructions. Prioritize precision, consistent "
        "terminology, and unambiguous phrasing; prefer imperative mood for steps; "
        "flag marketing language and vague quantifiers."
    ),
    Language.DE: (
        "Zielgruppe: Nutzerinnen und Nutzer, die Anleitungen folgen. Präzision, "
        "konsistente Terminologie und eindeutige Formulierungen haben Vorrang; "
        "für Schritte Imperativ bevorzugen; Marketingsprache und vage "
        "Mengenangaben markieren."
    ),
    Language.JA: (
        "対象読者:手順に従う利用者。正確さ、一貫した用語、曖昧さのない表現を最優先。"
        "手順は命令形を推奨。マーケティング的な表現や曖昧な数量表現を指摘すること。"
    ),
}


def _demo(demos_dir: Path, filename: str) -> str:
    path = demos_dir / filename
    return path.read_text(encoding="utf-8") if path.is_file() else ""


def _create_ignoring_collision(
    store: ProfileStore, language: Language, name: str, **fields
) -> None:
    """A pre-existing profile occupying a seeded name wins; seeding skips it."""
    try:
        store.create_profile(language, name, **fields)
    except ValueError:
        pass


def standard_defaults(
    language: Language, demos_dir: Path, default_provider: str
) -> dict:
    """Factory defaults for a language's Standard profile (also used by reset)."""
    return {
        "categories_off": [],
        "rule_exceptions": [],
        "domain_ids": [],
        "llm_provider": default_provider,
        "llm_model": None,
        "llm_instructions": "",
        "example_text": _demo(demos_dir, f"{language.value}.txt"),
    }


def seed_profiles(
    store: ProfileStore,
    demos_dir: Path,
    *,
    default_provider: str,
    seed_examples: bool,
) -> None:
    for language in Language:
        if store.standard_profile(language) is None:
            _create_ignoring_collision(
                store,
                language,
                "Standard",
                is_standard=True,
                **standard_defaults(language, demos_dir, default_provider),
            )
        if (
            seed_examples
            and language in EXAMPLE_LANGUAGES
            and not store.is_example_seeded(language)
        ):
            _create_ignoring_collision(
                store,
                language,
                "Marketing",
                llm_provider=default_provider,
                llm_instructions=_MARKETING_INSTRUCTIONS[language],
                example_text=_demo(demos_dir, f"{language.value}-marketing.txt"),
            )
            _create_ignoring_collision(
                store,
                language,
                "Technical Documentation",
                categories_off=["vividness"],
                llm_provider=default_provider,
                llm_instructions=_TECHDOC_INSTRUCTIONS[language],
                example_text=_demo(
                    demos_dir, f"{language.value}-technical-documentation.txt"
                ),
            )
            # Marker is set even if an insert collided with a user profile —
            # this prevents a retry loop on every subsequent run.
            store.mark_example_seeded(language)
