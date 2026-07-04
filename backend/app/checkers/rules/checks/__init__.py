from collections.abc import Callable

from app.core.models import Finding

from ..context import CheckContext
from ..loader import LoadedRule
from .dependency import check_dependency
from .existence import check_existence
from .occurrence import check_occurrence
from .repetition import check_repetition
from .substitution import check_substitution
from .token_pattern import check_token_pattern

CheckFn = Callable[[LoadedRule, CheckContext], list[Finding]]

CHECKS: dict[str, CheckFn] = {
    "existence": check_existence,
    "substitution": check_substitution,
    "occurrence": check_occurrence,
    "repetition": check_repetition,
    "token_pattern": check_token_pattern,
    "dependency": check_dependency,
}
