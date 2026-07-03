from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

APP_NAME = "Fabulous Writing"


def create_app() -> FastAPI:
    app = FastAPI(title=APP_NAME)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.get("/api/health")
    def health() -> dict[str, str]:
        return {"status": "ok", "name": APP_NAME}

    return app


app = create_app()
