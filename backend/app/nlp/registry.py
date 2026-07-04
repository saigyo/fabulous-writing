import threading
from dataclasses import dataclass
from typing import Any


@dataclass
class NlpStatus:
    model: str | None
    available: bool
    hint: str = ""


class NlpRegistry:
    """Lazily loads one spaCy pipeline per language (thread-safe).

    A language whose model cannot be loaded is remembered as failed with an
    install hint; callers get None and degrade gracefully.
    """

    def __init__(self, models: dict[str, str]) -> None:
        self._models = models
        self._pipelines: dict[str, Any] = {}
        self._failed: dict[str, str] = {}
        self._lock = threading.Lock()

    def get(self, language: str) -> Any | None:
        model = self._models.get(language)
        if model is None:
            return None
        with self._lock:
            if language in self._pipelines:
                return self._pipelines[language]
            if language in self._failed:
                return None
            try:
                import spacy

                pipeline = spacy.load(model, exclude=["ner"])
            except Exception as exc:
                self._failed[language] = (
                    f"Could not load spaCy model '{model}': {exc}. "
                    "Install it via scripts/install-models.sh."
                )
                return None
            self._pipelines[language] = pipeline
            return pipeline

    def analyze(self, text: str, language: str) -> Any | None:
        pipeline = self.get(language)
        return pipeline(text) if pipeline is not None else None

    def availability(self) -> dict[str, NlpStatus]:
        return {
            language: NlpStatus(
                model=model,
                available=language in self._pipelines,
                hint=self._failed.get(
                    language,
                    "" if language in self._pipelines else f"Model '{model}' not loaded yet.",
                ),
            )
            for language, model in self._models.items()
        }
