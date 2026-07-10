import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.checks import router as checks_router
from app.api.documents import router as documents_router
from app.api.languages import router as languages_router
from app.api.profiles import router as profiles_router
from app.api.providers import router as providers_router
from app.api.routing import router as routing_router
from app.api.rules import router as rules_router
from app.api.suggestions import router as suggestions_router
from app.api.terminology import router as terminology_router
from app.api.providers import OPENAI_EXCLUDED_MODEL_FRAGMENTS
from app.checkers.llm.bedrock import BedrockProvider
from app.checkers.llm.claude import ClaudeProvider
from app.checkers.llm.ollama import OllamaProvider
from app.checkers.llm.openai_compat import OpenAICompatProvider
from app.checkers.llm.provider import LLMProvider
from app.checkers.rules.engine import RuleEngine
from app.core.config import Settings, load_settings
from app.nlp.registry import NlpRegistry
from app.services.documents import DocumentStore
from app.services.jobs import JobManager
from app.services.profiles import ProfileStore
from app.services.seed import seed_terminology
from app.services.seed_profiles import seed_profiles
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
        if chosen == "openai":
            return OpenAICompatProvider(
                name="openai",
                base_url=providers.openai_base_url,
                api_key=os.environ.get("OPENAI_API_KEY"),
                model=model or providers.openai_model,
                exclude_models=OPENAI_EXCLUDED_MODEL_FRAGMENTS,
            )
        if chosen == "mistral":
            return OpenAICompatProvider(
                name="mistral",
                base_url=providers.mistral_base_url,
                api_key=os.environ.get("MISTRAL_API_KEY"),
                model=model or providers.mistral_model,
            )
        if chosen == "bedrock":
            return BedrockProvider(
                model=model or providers.bedrock_model,
                region=providers.bedrock_region,
            )
        extra = providers.extra_providers.get(chosen)
        if extra is not None:
            return OpenAICompatProvider(
                name=chosen,
                base_url=extra.base_url,
                api_key=os.environ.get(f"{chosen.upper()}_API_KEY"),
                model=model or extra.default_model,
                exclude_models=tuple(extra.exclude_model_fragments),
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
    if settings.seed_terminology:
        seed_terminology(app.state.terminology_store)
    app.state.rule_engine = RuleEngine(settings.rules_dir)
    app.state.jobs = JobManager()
    app.state.nlp = NlpRegistry(settings.nlp.models)
    app.state.provider_factory = make_provider_factory(settings)
    app.state.document_store = DocumentStore(settings.db_path)
    app.state.profile_store = ProfileStore(settings.db_path)
    seed_profiles(
        app.state.profile_store,
        settings.demos_dir,
        seed_examples=settings.seed_example_profiles,
    )
    app.include_router(terminology_router)
    app.include_router(checks_router)
    app.include_router(languages_router)
    app.include_router(rules_router)
    app.include_router(providers_router)
    app.include_router(suggestions_router)
    app.include_router(documents_router)
    app.include_router(profiles_router)
    app.include_router(routing_router)

    @app.get("/api/health")
    def health() -> dict[str, str]:
        return {"status": "ok", "name": APP_NAME}

    return app


app = create_app()
