from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from app.core.models import Language

router = APIRouter(prefix="/api", tags=["languages"])

LANGUAGE_NAMES = {
    Language.EN: "English",
    Language.DE: "Deutsch",
    Language.FR: "Français",
    Language.ES: "Español",
    Language.IT: "Italiano",
    Language.JA: "日本語",
    Language.ZH: "中文",
}


class LanguageInfo(BaseModel):
    code: Language
    name: str
    nlp_available: bool
    model: str | None


@router.get("/languages/{code}/demo")
def get_demo_text(request: Request, code: str) -> dict[str, str]:
    """A flawed example text that showcases the language's checks."""
    try:
        language = Language(code)
    except ValueError:
        raise HTTPException(404, "Unknown language")
    path = request.app.state.settings.demos_dir / f"{language.value}.txt"
    if not path.is_file():
        raise HTTPException(404, "No demo text for this language")
    return {"text": path.read_text(encoding="utf-8").strip()}


@router.get("/languages")
def list_languages(request: Request) -> list[LanguageInfo]:
    nlp = request.app.state.nlp
    return [
        LanguageInfo(
            code=language,
            name=LANGUAGE_NAMES[language],
            nlp_available=nlp.is_available(language.value),
            model=nlp.model_name(language.value),
        )
        for language in Language
    ]
