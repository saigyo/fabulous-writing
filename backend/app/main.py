import os

from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.admin import router as admin_router
from app.api.auth import LoginThrottle, router as auth_router
from app.api.checks import router as checks_router
from app.api.deps import get_current_user
from app.api.documents import router as documents_router
from app.api.folders import router as folders_router
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
from app.core.auth import AuthConfigError, LocalTokenVerifier, resolve_auth_secret
from app.core.config import BUILTIN_ENV_KEYS, Settings, load_settings
from app.nlp.registry import NlpRegistry
from app.services.documents import DocumentStore
from app.services.folders import FolderStore
from app.services.jobs import JobManager
from app.services.profiles import ProfileStore
from app.services.seed import seed_terminology
from app.services.seed_admin import seed_admin
from app.services.seed_profiles import seed_profiles
from app.services.terminology import TerminologyStore
from app.services.usage import UsageStore
from app.services.users import UserStore

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
                api_key=os.environ.get(BUILTIN_ENV_KEYS["openai"]),
                model=model or providers.openai_model,
                exclude_models=OPENAI_EXCLUDED_MODEL_FRAGMENTS,
            )
        if chosen == "mistral":
            return OpenAICompatProvider(
                name="mistral",
                base_url=providers.mistral_base_url,
                api_key=os.environ.get(BUILTIN_ENV_KEYS["mistral"]),
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
    # Outside dev, the three doc routes are not registered at all (rather
    # than registered-then-gated behind auth): a route that does not exist
    # cannot be probed, while a route gated behind auth still confirms it is
    # there. All three go together -- /docs and /redoc are useless without
    # /openapi.json, and leaving that reachable would defeat the point.
    docs_kwargs = (
        {}
        if settings.environment == "dev"
        else {"docs_url": None, "redoc_url": None, "openapi_url": None}
    )
    app = FastAPI(title=APP_NAME, **docs_kwargs)
    # allow_credentials is deliberately left unset (defaults to False): Bearer-
    # header auth does not need CORS credentials mode, and enabling it
    # alongside a permissive origin list is a common mistake.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors.origins,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.state.settings = settings
    app.state.terminology_store = TerminologyStore(settings.db_path)
    app.state.rule_engine = RuleEngine(settings.rules_dir)
    app.state.jobs = JobManager()
    app.state.nlp = NlpRegistry(settings.nlp.models)
    app.state.provider_factory = make_provider_factory(settings)
    app.state.document_store = DocumentStore(settings.db_path)
    app.state.folder_store = FolderStore(settings.db_path)
    app.state.profile_store = ProfileStore(settings.db_path)
    app.state.usage_store = UsageStore(settings.db_path)
    if settings.auth.mode != "local":
        raise AuthConfigError(
            "auth.mode 'supabase' is not implemented yet (sub-project 2)"
        )
    app.state.user_store = UserStore(settings.db_path)
    app.state.auth_secret = resolve_auth_secret(
        ephemeral_ok=settings.auth.ephemeral_secret
    )
    app.state.token_verifier = LocalTokenVerifier(app.state.auth_secret)
    app.state.login_throttle = LoginThrottle()
    seed_admin(app.state.user_store)
    # Startup sweep (spec §6.6): single-process deployment — no 'started'
    # row can belong to a live run of a process that no longer exists.
    app.state.usage_store.sweep_all_started()
    # Global seeders last (spec §9): migrations (store constructors) -> admin
    # bootstrap -> seeders, so a failing bootstrap aborts before any global
    # row is written.
    if settings.seed_terminology:
        seed_terminology(app.state.terminology_store)
    seed_profiles(
        app.state.profile_store,
        settings.demos_dir,
        seed_examples=settings.seed_example_profiles,
    )
    # Every feature router requires a logged-in caller. Attached here at
    # inclusion, rather than edited into each of the ten router files, so the
    # policy lives in one readable place and a router added to this list
    # without the dependency is visible in the diff. auth_router is excluded
    # because POST /auth/login must stay public; its own endpoints (GET
    # /auth/me, POST /auth/password) declare get_current_user individually.
    # admin_router is excluded too: it already carries require_admin (a
    # strictly stronger check) on itself.
    protected = [
        terminology_router, checks_router, languages_router, rules_router,
        providers_router, suggestions_router, documents_router,
        folders_router, profiles_router, routing_router,
    ]
    for router in protected:
        app.include_router(router, dependencies=[Depends(get_current_user)])
    app.include_router(auth_router)
    app.include_router(admin_router)

    @app.get("/api/health")
    def health() -> dict[str, str]:
        return {"status": "ok", "name": APP_NAME}

    return app


def __getattr__(name: str):
    """Build the default app lazily, on first attribute access (PEP 562).

    `uvicorn app.main:app` needs a module-level `app`, but building it
    eagerly at import time — as a plain `app = create_app()` — ran
    `create_app()` (and its fail-closed auth/admin bootstrap) as a side
    effect of *any* import of this module, including `from app.main import
    create_app` in test files. That fired during pytest's collection
    phase, before conftest's fixtures set the test secret and bootstrap
    credentials, and against the default (real) `db_path`. Deferring the
    call until something actually asks for `app` keeps `create_app` itself
    a plain, side-effect-free import.
    """
    if name == "app":
        instance = create_app()
        globals()["app"] = instance
        return instance
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
