from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.checks import router as checks_router
from app.api.providers import router as providers_router
from app.api.rules import router as rules_router
from app.api.terminology import router as terminology_router
from app.checkers.llm.claude import ClaudeProvider
from app.checkers.llm.ollama import OllamaProvider
from app.checkers.llm.provider import LLMProvider
from app.checkers.rules.engine import RuleEngine
from app.core.config import Settings, load_settings
from app.services.jobs import JobManager
from app.services.terminology import TerminologyStore

APP_NAME = "Fabulous Writing"


def make_provider_factory(settings: Settings):
    def factory(name: str | None = None, model: str | None = None) -> LLMProvider:
        providers = settings.providers
        chosen = name or providers.default_provider
        if chosen == "claude":
            return ClaudeProvider(model=model or providers.anthropic_model)
        if chosen == "ollama":
            return OllamaProvider(
                base_url=providers.ollama_base_url,
                model=model or providers.ollama_model,
            )
        raise ValueError(f"Unknown LLM provider: {chosen}")

    return factory


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or load_settings()
    app = FastAPI(title=APP_NAME)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.state.settings = settings
    app.state.terminology_store = TerminologyStore(settings.db_path)
    app.state.rule_engine = RuleEngine(settings.rules_dir)
    app.state.jobs = JobManager()
    app.state.provider_factory = make_provider_factory(settings)
    app.include_router(terminology_router)
    app.include_router(checks_router)
    app.include_router(rules_router)
    app.include_router(providers_router)

    @app.get("/api/health")
    def health() -> dict[str, str]:
        return {"status": "ok", "name": APP_NAME}

    return app


app = create_app()
