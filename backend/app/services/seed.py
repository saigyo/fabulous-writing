"""Seed an empty terminology store with an example domain.

Gives fresh installations something to demo: one style-guide domain with a few
representative terms per language. Never touches a store that already has
domains; disable entirely via `seed_terminology: false` in config.yaml.
"""

from app.core.models import Language
from app.services.terminology import TerminologyStore

DOMAIN_NAME = "Product docs"
DOMAIN_DESCRIPTION = "Example style-guide terminology (seeded — edit or delete freely)"

# language, preferred, forbidden variants, definition
DEFAULT_TERMS: list[tuple[Language, str, list[str], str]] = [
    (Language.EN, "sign in", ["login", "log-in"], "As a verb, use 'sign in'; 'login' is only a noun."),
    (Language.EN, "email", ["e-mail"], "House style: no hyphen."),
    (Language.EN, "website", ["web site"], "One word."),
    (Language.DE, "Anwendung", ["App"], "Im Fließtext „Anwendung“ verwenden."),
    (Language.DE, "anmelden", ["einloggen"], "Kein Denglisch in der Dokumentation."),
    (Language.DE, "E-Mail", ["Email"], "Mit Bindestrich — „Email“ ist Glasschmelz."),
    (Language.FR, "application", ["appli"], "Pas d'abréviation dans la documentation."),
    (Language.FR, "courriel", ["e-mail", "mél"], "Terme recommandé en français."),
    (Language.FR, "se connecter", ["se loguer"], "Éviter l'anglicisme."),
    (Language.ES, "aplicación", ["app"], "Sin abreviaturas en la documentación."),
    (Language.ES, "correo electrónico", ["email", "e-mail"], "Término preferido en español."),
    (Language.ES, "iniciar sesión", ["loguearse"], "Evitar el anglicismo."),
    (Language.IT, "applicazione", ["app"], "Niente abbreviazioni nella documentazione."),
    (Language.IT, "accedere", ["loggarsi"], "Evitare l'anglicismo."),
    (Language.IT, "sito web", ["website"], "Preferire la forma italiana."),
    (Language.JA, "利用者", ["ユーザー"], "文書では「利用者」を使う。"),
    (Language.JA, "設定", ["コンフィグ"], "カタカナ語を避ける。"),
    (Language.ZH, "用户", ["使用者"], "统一使用“用户”。"),
    (Language.ZH, "登录", ["登陆"], "“登陆”是上岸，登录系统用“登录”。"),
]


def seed_terminology(store: TerminologyStore) -> bool:
    """Populate an empty store with the example domain. Returns True if seeded."""
    if store.list_domains():
        return False
    domain = store.create_domain(DOMAIN_NAME, DOMAIN_DESCRIPTION)
    for language, preferred, variants, definition in DEFAULT_TERMS:
        store.create_term(
            domain.id,
            language=language,
            preferred=preferred,
            forbidden_variants=variants,
            definition=definition,
        )
    return True
