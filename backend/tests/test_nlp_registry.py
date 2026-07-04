from app.core.config import NlpSettings
from app.nlp.registry import NlpRegistry


def make_registry(models: dict[str, str] | None = None) -> NlpRegistry:
    return NlpRegistry(models or NlpSettings().models)


def test_analyze_parses_and_caches_pipeline() -> None:
    registry = make_registry()
    doc = registry.analyze("The report was written by the team.", "en")
    assert doc is not None
    assert [t.text for t in doc][:2] == ["The", "report"]
    assert any(t.dep_ == "auxpass" for t in doc)
    assert registry.get("en") is registry.get("en")


def test_missing_model_reports_unavailable() -> None:
    registry = make_registry({"en": "xx_totally_missing"})
    assert registry.analyze("Hello.", "en") is None
    status = registry.availability()
    assert status["en"].available is False
    assert "xx_totally_missing" in status["en"].hint


def test_unconfigured_language_is_unavailable() -> None:
    registry = make_registry({"en": "en_core_web_sm"})
    assert registry.analyze("Hallo.", "de") is None


def test_ner_disabled_for_speed() -> None:
    registry = make_registry()
    pipeline = registry.get("en")
    assert pipeline is not None
    assert "ner" not in pipeline.pipe_names

def test_ja_ginza_loads_despite_config_quirk() -> None:
    # GiNZA 5.2 ships a config newer confection rejects (split_mode: None);
    # the registry retries with an explicit split mode.
    registry = make_registry()
    doc = registry.analyze("最初の文です。二番目の文です。", "ja")
    assert doc is not None
    assert [s.text for s in doc.sents] == ["最初の文です。", "二番目の文です。"]

def test_is_available_for_installed_model_without_loading() -> None:
    registry = make_registry({"en": "en_core_web_sm"})
    assert registry.is_available("en") is True
    assert registry._pipelines == {}  # availability check must not load


def test_is_available_false_for_missing_model_or_language() -> None:
    registry = make_registry({"en": "xx_bogus_model"})
    assert registry.is_available("en") is False
    assert registry.is_available("tlh") is False


def test_model_name() -> None:
    registry = make_registry({"en": "en_core_web_sm"})
    assert registry.model_name("en") == "en_core_web_sm"
    assert registry.model_name("tlh") is None
