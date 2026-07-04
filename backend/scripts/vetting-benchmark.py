"""False-reject benchmark for the suggestion spell gate.

Treats every word of the demo texts as a suggestion candidate with an EMPTY
document whitelist (worst case) and reports how many words the frequency-only
gate (M1) would reject vs. the frequency+hunspell union gate (M2).

Run:  uv run python scripts/vetting-benchmark.py
"""

import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND))

from app.checkers.llm.vetting import (  # noqa: E402
    _SPELL_LANGUAGES,
    _WORD,
    _hunspell,
    _spell_checker,
)


DEMOS = BACKEND / "demos"
DICTS = BACKEND / "dictionaries"


def main() -> None:
    print(f"{'lang':<6}{'words':>7}{'freq-rejects':>14}{'union-rejects':>15}  rescued words")
    for language, code in _SPELL_LANGUAGES.items():
        text = (DEMOS / f"{language.value}.txt").read_text(encoding="utf-8")
        words = [w for w in _WORD.findall(text) if not any(c.isdigit() for c in w)]
        checker = _spell_checker(code)
        dictionary = _hunspell(code, DICTS)
        freq_unknown = sorted(
            {w for w in words if w.lower() in checker.unknown([w.lower()])}
        )
        rescued = [
            w for w in freq_unknown if dictionary is not None and dictionary.lookup(w)
        ]
        union_unknown = [w for w in freq_unknown if w not in rescued]
        print(
            f"{code:<6}{len(words):>7}{len(freq_unknown):>14}{len(union_unknown):>15}"
            f"  {', '.join(rescued) or '—'}"
        )
        if union_unknown:
            print(f"{'':<6}still rejected: {', '.join(union_unknown)}")


if __name__ == "__main__":
    main()
