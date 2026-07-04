from dataclasses import dataclass
from typing import Any


@dataclass
class CheckContext:
    text: str
    doc: Any | None = None  # spaCy Doc when the language's model is loaded
