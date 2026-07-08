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
    FR = "fr"
    ES = "es"
    IT = "it"
    JA = "ja"
    ZH = "zh"


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


class ScoreDimension(BaseModel):
    score: int = Field(ge=1, le=5)
    note: str = ""


class Scorecard(BaseModel):
    """Holistic per-dimension assessment returned alongside LLM findings.

    All six dimensions are required: an incomplete or out-of-range scorecard
    fails validation and is discarded whole (the strict gate; see
    docs/scoring.md).
    """

    consistency: ScoreDimension
    flow: ScoreDimension
    clarity: ScoreDimension
    vividness: ScoreDimension
    tone: ScoreDimension
    structure: ScoreDimension
