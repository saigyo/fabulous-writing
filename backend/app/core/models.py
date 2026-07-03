import uuid
from enum import Enum

from pydantic import BaseModel, Field


class Category(str, Enum):
    SPELLING = "spelling"
    GRAMMAR = "grammar"
    STYLE = "style"
    CLARITY = "clarity"
    VIVIDNESS = "vividness"
    CORRECTNESS = "correctness"
    TERMINOLOGY = "terminology"


class Severity(str, Enum):
    ERROR = "error"
    WARNING = "warning"
    SUGGESTION = "suggestion"


class Source(str, Enum):
    LLM = "llm"
    RULE = "rule"
    TERMINOLOGY = "terminology"


class Language(str, Enum):
    EN = "en"
    DE = "de"


class Span(BaseModel):
    start: int
    end: int
    text: str


class Finding(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    category: Category
    severity: Severity
    source: Source
    rule_id: str | None = None
    message: str
    span: Span
    suggestions: list[str] = Field(default_factory=list)
