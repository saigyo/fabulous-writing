from fastapi import APIRouter, Request
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
