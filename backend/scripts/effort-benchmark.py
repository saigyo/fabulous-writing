"""Latency / token / findings benchmark for Claude thinking effort (#132).

Runs the real LLM check (prompt, streaming provider, parsing, anchoring,
vetting) over the demo texts for each model/effort pair and prints one row
per pair: median and max wall time, total output tokens (thinking
included, billed as output), and total findings.

Needs ANTHROPIC_API_KEY; costs real money (~36 calls with the defaults).

Run:  uv run python scripts/effort-benchmark.py [--model M] [--raw findings.json]
"""

import argparse
import asyncio
import json
import statistics
import sys
import time
from pathlib import Path

BACKEND = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND))

from app.checkers.llm.checker import LLMChecker  # noqa: E402
from app.checkers.llm.claude import ClaudeProvider  # noqa: E402
from app.core.models import Language  # noqa: E402

DEMOS = BACKEND / "demos"

# (model, effort); None = no output_config, i.e. the model's own default
# (high on Sonnet 5 / Opus 5 / Sonnet 5.5, medium on Opus 5.5).
CONFIGS = [
    ("claude-sonnet-5", None),
    ("claude-opus-5", None),
    ("claude-sonnet-5-5", "low"),
    ("claude-sonnet-5-5", "medium"),
    ("claude-sonnet-5-5", None),
    ("claude-opus-5-5", "low"),
    ("claude-opus-5-5", "medium"),
    ("claude-opus-5-5", None),
    ("claude-opus-5-5", "high"),
]


def _texts() -> list[tuple[str, Language, str]]:
    def demo(name: str) -> str:
        return (DEMOS / f"{name}.txt").read_text(encoding="utf-8").strip()

    def joined(lang: str) -> str:
        names = [lang] + [f"{lang}-{kind}" for kind in ("blog", "marketing", "technical-documentation")]
        return "\n\n".join(demo(n) for n in names)

    return [
        ("en", Language.EN, demo("en")),
        ("de", Language.DE, demo("de")),
        ("en-long", Language.EN, joined("en")),
        ("de-long", Language.DE, joined("de")),
    ]


async def _run(model: str, effort: str | None, name: str, language: Language, text: str) -> dict:
    checker = LLMChecker(ClaudeProvider(model=model, effort=effort))
    started = time.monotonic()
    row: dict = {"model": model, "effort": effort or "default", "text": name, "chars": len(text)}
    try:
        result = await checker.check(text, language, on_progress=lambda _n: None)
    except Exception as exc:  # recorded, not fatal: failures are data here
        row.update(ok=False, error=f"{type(exc).__name__}: {exc}", seconds=time.monotonic() - started)
        usage = getattr(exc, "usage", None)
        row["output_tokens"] = getattr(usage, "output_tokens", None)
        return row
    row.update(
        ok=True,
        seconds=time.monotonic() - started,
        output_tokens=result.usage.output_tokens,
        findings=len(result.findings),
        scorecard=result.scorecard is not None,
        messages=[f"{f.span.text!r}: {f.message}" for f in result.findings],
    )
    return row


async def main(raw: Path | None, model: str | None) -> None:
    configs = [c for c in CONFIGS if model is None or c[0] == model]
    texts = _texts()
    gate = asyncio.Semaphore(4)

    async def guarded(*args) -> dict:
        async with gate:
            return await _run(*args)

    rows = await asyncio.gather(
        *(guarded(m, e, n, lang, t) for m, e in configs for n, lang, t in texts)
    )
    print(f"{'model':<19}{'effort':<9}{'ok':>5}{'med s':>8}{'max s':>8}{'out tok':>9}{'findings':>10}")
    for name, effort in configs:
        mine = [r for r in rows if r["model"] == name and r["effort"] == (effort or "default")]
        ok = [r for r in mine if r["ok"]]
        secs = [r["seconds"] for r in mine]
        tokens = [r["output_tokens"] for r in mine if r["output_tokens"] is not None]
        print(
            f"{name:<19}{effort or 'default':<9}{len(ok):>3}/{len(mine)}"
            f"{statistics.median(secs):>8.1f}{max(secs):>8.1f}"
            f"{sum(tokens):>9}{sum(r['findings'] for r in ok):>10}"
        )
    for r in rows:
        if not r["ok"]:
            print(f"FAILED {r['model']} {r['effort']} {r['text']}: {r['error']}")
    if raw is not None:
        raw.write_text(json.dumps(rows, indent=2, ensure_ascii=False), encoding="utf-8")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--raw", type=Path, help="write per-run rows incl. findings as JSON")
    parser.add_argument("--model", help="run only this model's configs")
    args = parser.parse_args()
    asyncio.run(main(args.raw, args.model))
