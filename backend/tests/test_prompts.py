from app.checkers.llm.prompts import (
    build_prompt,
    build_rewrite_prompt,
    build_suggestion_prompt,
)
from app.core.models import Language


def test_build_prompt_without_instructions_unchanged():
    system, user = build_prompt("Hello.", Language.EN)
    assert "checking profile" not in system
    assert "Respond with ONLY a JSON array" in system


def test_build_prompt_appends_instructions_after_contract():
    system, _ = build_prompt("Hello.", Language.EN, instructions="Audience: kids.")
    assert "Audience: kids." in system
    # The JSON contract must remain, and instructions come after it.
    contract_pos = system.index("Respond with ONLY a JSON array")
    assert system.index("Audience: kids.") > contract_pos


def test_blank_instructions_ignored():
    baseline, _ = build_prompt("Hello.", Language.EN)
    padded, _ = build_prompt("Hello.", Language.EN, instructions="   \n")
    assert padded == baseline


def test_suggestion_and_rewrite_prompts_take_instructions():
    system, _ = build_suggestion_prompt(
        "The cat sat.", 4, 7, "Weak verb.", Language.EN,
        instructions="Prefer playful wording.",
    )
    assert "Prefer playful wording." in system
    system, _ = build_rewrite_prompt(
        "The cat sat.", "Weak verb.", Language.EN,
        instructions="Prefer playful wording.",
    )
    assert "Prefer playful wording." in system
