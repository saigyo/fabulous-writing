import json
from dataclasses import dataclass, field
from pathlib import Path

from app.core.models import Language

GOLDEN_PATH = Path(__file__).parent / "data" / "terminology_baseline.json"


@dataclass(frozen=True)
class BaselineTerm:
    language: Language
    preferred: str
    forbidden_variants: list[str]
    definition: str = ""
    case_sensitive: bool = False


@dataclass(frozen=True)
class BaselineDomain:
    name: str
    is_global: bool
    terms: list[BaselineTerm] = field(default_factory=list)


L = Language

BASELINE_DOMAINS: list[BaselineDomain] = [
    BaselineDomain(
        "Baseline global",
        True,
        [
            BaselineTerm(L.EN, "GitHub", ["Github"], "The code hosting product.", True),
            BaselineTerm(L.EN, "sign in", ["login", "log in"], "", True),
            BaselineTerm(L.DE, "Anmeldung", ["Login"], "Vorgang der Authentifizierung.", True),
            BaselineTerm(L.DE, "Datei", ["File"]),
            BaselineTerm(L.FR, "courriel", ["email"], "Adresse électronique."),
            BaselineTerm(L.FR, "connexion", ["login"], "", True),
            BaselineTerm(L.JA, "ログイン", ["サインイン"], "認証すること。"),
        ],
    ),
    BaselineDomain(
        "Baseline own",
        False,
        [
            BaselineTerm(L.EN, "email", ["e-mail"], "Electronic mail."),
            BaselineTerm(L.ES, "correo electrónico", ["email"]),
            BaselineTerm(L.ES, "contraseña", ["password"], "Secreto del usuario.", True),
            BaselineTerm(L.IT, "posta elettronica", ["email"]),
            BaselineTerm(L.IT, "accesso", ["login"], "", True),
            BaselineTerm(L.ZH, "登录", ["登入"], "验证身份。"),
        ],
    ),
]

BASELINE_TEXTS: dict[Language, str] = {
    L.EN: (
        "Sign in to GitHub first. Please login now, or log in later. "
        "Open Github and then Sign in again, or sign in later. Send an email, not an e-mail."
    ),
    L.DE: "Die Anmeldung ist fertig. Anmeldung klappt. Zuerst die anmeldung, dann Login und die File.",
    L.FR: "Votre connexion est prête. Une Connexion échoue. Envoyez un email, sinon un login par courriel.",
    L.ES: "Escriba su contraseña. Una Contraseña falla. Envíe un correo electrónico o un email con su password.",
    L.IT: "Il tuo accesso è pronto. Un Accesso fallisce. Invia una posta elettronica o un email dopo il login.",
    L.JA: "ログインしてください。サインインは使わないでください。",
    L.ZH: "请登录系统。不要使用登入功能。",
}


def normalise(findings: list[dict]) -> list[dict]:
    keep = ("severity", "category", "source", "message", "suggestions", "span")
    rows = [{key: finding[key] for key in keep} for finding in findings]
    return sorted(rows, key=lambda f: (f["span"]["start"], f["span"]["end"], f["message"]))


def load_golden() -> dict[str, list[dict]]:
    return json.loads(GOLDEN_PATH.read_text(encoding="utf-8"))
