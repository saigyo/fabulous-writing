from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.terminology import router as terminology_router
from app.checkers.rules.engine import RuleEngine
from app.core.config import Settings
from app.services.terminology import TerminologyStore

APP_NAME = "Fabulous Writing"


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings()
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
    app.include_router(terminology_router)

    @app.get("/api/health")
    def health() -> dict[str, str]:
        return {"status": "ok", "name": APP_NAME}

    return app


app = create_app()
