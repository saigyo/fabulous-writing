from collections.abc import Callable

from app.core.models import Finding

from ..context import CheckContext
from ..loader import LoadedRule
from .existence import check_existence
from .occurrence import check_occurrence
from .repetition import check_repetition
from .substitution import check_substitution

CheckFn = Callable[[LoadedRule, CheckContext], list[Finding]]

CHECKS: dict[str, CheckFn] = {
    "existence": check_existence,
    "substitution": check_substitution,
    "occurrence": check_occurrence,
    "repetition": check_repetition,
}
