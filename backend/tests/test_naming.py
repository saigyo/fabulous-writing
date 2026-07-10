# coding: utf-8
from app.checkers.llm.prompts import build_title_prompt
from app.core.models import Language
from app.services.naming import clean_title, fallback_name


class TestCleanTitle:
    def test_strips_quotes_trailing_punctuation_and_whitespace(self):
        assert clean_title('  "Great Title."  ') == "Great Title"
        assert clean_title("«Titre génial !»") == "Titre génial"
        assert clean_title("„Guter Titel”…") == "Guter Titel"

    def test_takes_first_line_and_collapses_whitespace(self):
        assert clean_title("A  Good\nTitle explanation below") == "A Good"

    def test_caps_at_80_chars(self):
        assert len(clean_title("x" * 200)) == 80

    def test_empty_is_none(self):
        assert clean_title("") is None
        assert clean_title('"."') is None


class TestFallbackName:
    def test_first_six_words(self):
        assert (
            fallback_name("The quick brown fox jumps over the lazy dog")
            == "The quick brown fox jumps over"
        )

    def test_collapses_whitespace(self):
        assert fallback_name("# Hello\n\n  world  ") == "# Hello world"

    def test_caps_at_40_chars_for_cjk(self):
        assert len(fallback_name("あ" * 100)) == 40

    def test_empty_is_none(self):
        assert fallback_name("   ") is None


class TestTitlePrompt:
    def test_prompt_names_language_and_carries_text(self):
        system, user = build_title_prompt("My document body.", Language.DE)
        assert "German" in system or "Deutsch" in system
        assert "8 words" in system
        assert "My document body." in user

    def test_user_text_is_truncated(self):
        _, user = build_title_prompt("y" * 5000, Language.EN)
        assert len(user) < 1200
