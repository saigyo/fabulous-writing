"""Source-level guard for the "one gate" Global Constraint (spec §7.2): every
LLM-invoking route must resolve its provider through app/api/llm_gate.py
rather than touching app.state.provider_factory directly. A new endpoint that
calls the factory itself would silently bypass tier policy, quota and
concurrency enforcement — this test fails the moment that happens, without
relying on a shell grep that could be skipped or miscopied.
"""

from pathlib import Path

APP_DIR = Path(__file__).parent.parent / "app"

ALLOWED = {
    APP_DIR / "main.py",
    APP_DIR / "api" / "llm_gate.py",
}


def test_only_llm_gate_and_main_reference_provider_factory() -> None:
    referencing = {
        path
        for path in APP_DIR.rglob("*.py")
        if "__pycache__" not in path.parts and "provider_factory" in path.read_text()
    }
    assert referencing == ALLOWED
