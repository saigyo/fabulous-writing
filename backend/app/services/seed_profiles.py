"""Seed checking profiles: a Standard profile per language, plus deletable
Marketing / Technical Documentation / Blog examples for every language
(tracked in a marker table so deletions stick across restarts)."""

from pathlib import Path

from app.core.models import Language
from app.services.profiles import ProfileStore

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
    Language.FR: (
        "Public : clients potentiels. Privilégier des formulations énergiques, "
        "concrètes, axées sur les bénéfices ; phrases courtes ; voix active. "
        "Signaler le jargon, les affirmations vagues et les tournures hésitantes."
    ),
    Language.ES: (
        "Audiencia: clientes potenciales. Preferir formulaciones enérgicas, "
        "concretas y centradas en los beneficios; frases cortas; voz activa. "
        "Señalar la jerga, las afirmaciones vagas y las expresiones dubitativas."
    ),
    Language.IT: (
        "Pubblico: potenziali clienti. Preferire formulazioni energiche, "
        "concrete, orientate ai benefici; frasi brevi; forma attiva. Segnalare "
        "gergo, affermazioni vaghe e formule esitanti."
    ),
    Language.ZH: (
        "目标读者:潜在客户。倾向有力、具体、以收益为先的表达;短句;主动语态。"
        "指出行话、空泛的主张和含糊其辞。"
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
    Language.FR: (
        "Public : utilisateurs suivant des instructions. Priorité à la précision, "
        "à la terminologie cohérente et aux formulations sans ambiguïté ; "
        "impératif pour les étapes ; signaler le langage marketing et les "
        "quantités vagues."
    ),
    Language.ES: (
        "Audiencia: usuarios que siguen instrucciones. Prioridad a la precisión, "
        "la terminología coherente y las formulaciones inequívocas; imperativo "
        "para los pasos; señalar el lenguaje comercial y las cantidades vagas."
    ),
    Language.IT: (
        "Pubblico: utenti che seguono istruzioni. Priorità a precisione, "
        "terminologia coerente e formulazioni univoche; imperativo per i "
        "passaggi; segnalare linguaggio promozionale e quantità vaghe."
    ),
    Language.ZH: (
        "目标读者:按步骤操作的用户。以准确、术语一致、表达无歧义为最高优先;"
        "步骤使用祈使句;指出营销化语言和模糊的数量表述。"
    ),
}

_BLOG_INSTRUCTIONS = {
    Language.EN: (
        "Audience: blog readers. Favor a personal but tight voice; concrete "
        "examples over abstractions; short paragraphs. Flag filler openings, "
        "rambling, and unsupported generalizations."
    ),
    Language.DE: (
        "Zielgruppe: Blog-Leserinnen und -Leser. Persönliche, aber straffe "
        "Sprache; konkrete Beispiele statt Abstraktionen; kurze Absätze. "
        "Markiere Floskel-Einstiege, Abschweifungen und unbelegte "
        "Verallgemeinerungen."
    ),
    Language.JA: (
        "対象読者:ブログ読者。個人的だが引き締まった文体を推奨。抽象論より"
        "具体例、短い段落。決まり文句の導入・締めくくり、脱線、根拠のない"
        "一般化を指摘すること。"
    ),
    Language.FR: (
        "Public : lecteurs de blog. Style personnel mais resserré ; exemples "
        "concrets plutôt qu'abstractions ; paragraphes courts. Signaler les "
        "introductions creuses, les digressions et les généralisations non "
        "étayées."
    ),
    Language.ES: (
        "Audiencia: lectores de blog. Voz personal pero contenida; ejemplos "
        "concretos en lugar de abstracciones; párrafos cortos. Señalar aperturas "
        "tópicas, divagaciones y generalizaciones sin respaldo."
    ),
    Language.IT: (
        "Pubblico: lettori di blog. Voce personale ma asciutta; esempi concreti "
        "invece di astrazioni; paragrafi brevi. Segnalare aperture di maniera, "
        "divagazioni e generalizzazioni non supportate."
    ),
    Language.ZH: (
        "目标读者:博客读者。提倡个人化而紧凑的文风;用具体例子代替抽象论述;"
        "段落要短。指出套话开头、离题和缺乏依据的概括。"
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


def standard_defaults(language: Language, demos_dir: Path) -> dict:
    """Factory defaults for a language's Standard profile (also used by reset)."""
    return {
        "categories_off": [],
        "rule_exceptions": [],
        "packs_on": [],
        "domain_ids": [],
        "llm_tier": "balanced",
        "llm_provider": None,
        "llm_model": None,
        "llm_instructions": "",
        "example_text": _demo(demos_dir, f"{language.value}.txt"),
    }


def seed_profiles(
    store: ProfileStore,
    demos_dir: Path,
    *,
    seed_examples: bool,
) -> None:
    for language in Language:
        if store.standard_profile(language) is None:
            _create_ignoring_collision(
                store,
                language,
                "Standard",
                is_standard=True,
                **standard_defaults(language, demos_dir),
            )
        if seed_examples and not store.is_example_seeded(language):
            _create_ignoring_collision(
                store,
                language,
                "Marketing",
                packs_on=["marketing"],
                llm_tier="balanced",
                llm_instructions=_MARKETING_INSTRUCTIONS[language],
                example_text=_demo(demos_dir, f"{language.value}-marketing.txt"),
            )
            _create_ignoring_collision(
                store,
                language,
                "Technical Documentation",
                categories_off=["vividness"],
                packs_on=["techdocs"],
                llm_tier="balanced",
                llm_instructions=_TECHDOC_INSTRUCTIONS[language],
                example_text=_demo(
                    demos_dir, f"{language.value}-technical-documentation.txt"
                ),
            )
            _create_ignoring_collision(
                store,
                language,
                "Blog",
                packs_on=["blog"],
                llm_tier="balanced",
                llm_instructions=_BLOG_INSTRUCTIONS[language],
                example_text=_demo(demos_dir, f"{language.value}-blog.txt"),
            )
            # Marker is set even if an insert collided with a user profile —
            # this prevents a retry loop on every subsequent run.
            store.mark_example_seeded(language)
