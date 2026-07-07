# Rule Packs + EN/DE Rule Expansion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Use-case rule packs (open-ended `pack:` slug, off by default, per-profile `packs_on`), a mandatory self-documenting/self-testing `examples` block on every rule, and 35 new EN/DE rules exercising the spaCy pattern formalism.

**Architecture:** The pack and examples fields live in `RuleSpec` (loader-validated); activation extends `RuleConfig.is_active` (pack rules need `packs_on`, XOR exceptions unchanged); packs_on flows profile column → API → client `rule_config`. A catalog-wide parametrized pytest runs every rule against its own YAML examples. Spec: `docs/superpowers/specs/2026-07-07-rule-packs-en-de-design.md`.

**Tech Stack:** FastAPI + pydantic + spaCy (Matcher/DependencyMatcher) backend, React 19 + TS + zustand + vitest frontend.

**Conventions:** Work directly on `main` (owner agreement), push after each task. Commits end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`. Backend commands run from `backend/` (`uv run pytest …`), frontend from `frontend/` (`npx vitest run …`, `npm run build`). NLP tests need the seven spaCy models installed (they are, locally and in CI).

---

## File map

| Area | Files |
|---|---|
| Engine | `backend/app/checkers/rules/loader.py` (pack + examples fields), `engine.py` (RuleConfig.packs_on, is_active, default config), `checks/token_pattern.py` (greedy LONGEST) |
| API | `backend/app/api/rules.py` (pack, examples, packs index), `backend/app/api/profiles.py` (packs_on) |
| Storage | `backend/app/services/profiles.py` (packs_on column), `seed_profiles.py` (pack seeds + Blog) |
| Rules | `backend/rules/en/**` (+18), `backend/rules/de/**` (+17), all 49 existing files (examples backfill) |
| Demos | `backend/demos/en-blog.txt`, `de-blog.txt` (new); `en-marketing.txt`, `de-marketing.txt`, `en-technical-documentation.txt`, `de-technical-documentation.txt` (extended) |
| Backend tests | `tests/test_rule_engine.py`, `tests/test_rule_examples.py` (new), `tests/test_rules_api.py`, `tests/test_profiles.py`, `tests/test_profiles_api.py`, `tests/test_check_api.py`, `tests/test_seed.py`, `tests/test_nlp_rules.py` |
| Frontend | `src/types.ts`, `src/api/client.ts`, `src/profiles/profile.ts` (+ test), `src/rules/catalog.ts` (+ test), `src/rules/RulesView.tsx`, `src/profiles/ProfilesView.tsx`, `src/header/ProfileSelector.tsx`, `src/i18n/*` (8 files), `src/App.css` |
| Docs | `backend/rules/README.md`, `docs/backend-architecture.md`, `docs/frontend-architecture.md`, `README.md`, spec implementation notes, `docs/LOGBOOK.md`, `docs/images/*` |

---

### Task 1: Engine — `pack` field and pack-aware activation

**Files:**
- Modify: `backend/app/checkers/rules/loader.py`
- Modify: `backend/app/checkers/rules/engine.py`
- Test: `backend/tests/test_rule_engine.py`

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_rule_engine.py`:

```python
class TestPacks:
    def test_is_active_truth_table(self) -> None:
        config = RuleConfig(
            categories_off=["style"],
            exceptions=["clarity.cherry", "clarity.optout"],
            packs_on=["techdocs"],
        )
        # General rules: unchanged XOR semantics.
        assert config.is_active("clarity", "clarity.plain")
        assert not config.is_active("style", "style.plain")
        # Pack rule, pack on, category on -> active.
        assert config.is_active("clarity", "clarity.pack", pack="techdocs")
        # Pack rule, pack off -> inactive.
        assert not config.is_active("clarity", "clarity.pack", pack="marketing")
        # Pack off + exception -> cherry-picked active.
        assert config.is_active("clarity", "clarity.cherry", pack="marketing")
        # Pack on + exception -> opted out.
        assert not config.is_active("clarity", "clarity.optout", pack="techdocs")
        # Pack on but category off -> inactive (category toggle wins).
        assert not config.is_active("style", "style.pack", pack="techdocs")

    def test_pack_rules_skipped_by_default(self, rules_dir: Path) -> None:
        write_rule(
            rules_dir,
            "en",
            "style/hype.yml",
            """
extends: existence
message: "'%s' is hype."
level: warning
category: style
pack: marketing
tokens: [revolutionary]
""",
        )
        engine = make_engine(rules_dir)
        assert engine.errors == []
        text = "A revolutionary idea."
        # No config and empty config: pack rule stays off.
        assert engine.check(text, Language.EN) == []
        assert engine.check(text, Language.EN, config=RuleConfig()) == []
        # Enabled pack: rule fires.
        active = engine.check(
            text, Language.EN, config=RuleConfig(packs_on=["marketing"])
        )
        assert [f.rule_id for f in active] == ["style.hype"]

    def test_invalid_pack_slug_is_reported(self, rules_dir: Path) -> None:
        write_rule(
            rules_dir,
            "en",
            "style/bad-pack.yml",
            """
extends: existence
message: "x"
category: style
pack: "Tech Docs"
tokens: [x]
""",
        )
        engine = make_engine(rules_dir)
        assert engine.list_rules() == []
        assert len(engine.errors) == 1
        assert "pack" in engine.errors[0].error
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/test_rule_engine.py::TestPacks -v`
Expected: FAIL — `is_active() got an unexpected keyword argument 'pack'` / `packs_on` unknown field.

- [ ] **Step 3: Implement**

In `backend/app/checkers/rules/loader.py`, add to the imports `field_validator` (extend the existing `from pydantic import ...` line) and `import re` at the top. In `RuleSpec`, after the `suggestions` field add:

```python
    # use-case pack (None = general rule, always on unless excepted)
    pack: str | None = None

    @field_validator("pack")
    @classmethod
    def check_pack_slug(cls, value: str | None) -> str | None:
        if value is not None and not re.fullmatch(r"[a-z][a-z0-9-]*", value):
            raise ValueError(
                f"pack '{value}' must be a lowercase slug ([a-z][a-z0-9-]*)"
            )
        return value
```

In `backend/app/checkers/rules/engine.py`, replace `RuleConfig` with:

```python
class RuleConfig(BaseModel):
    """Profile rule selection: category toggles, pack opt-ins, per-rule
    exceptions.

    A general rule is active iff (category not off) XOR (rule id in
    exceptions). A pack rule additionally needs its pack in packs_on:
    (pack on AND category on) XOR exception — so exceptions can opt out of
    one rule of an enabled pack, or cherry-pick one rule without the pack.
    """

    categories_off: list[str] = Field(default_factory=list)
    exceptions: list[str] = Field(default_factory=list)
    packs_on: list[str] = Field(default_factory=list)

    def is_active(self, category: str, rule_id: str, pack: str | None = None) -> bool:
        base = category not in self.categories_off
        if pack is not None:
            base = base and pack in self.packs_on
        return base != (rule_id in self.exceptions)
```

In `RuleEngine.check`, make the default config empty (pack rules off unless asked for) and pass the pack:

```python
    def check(
        self,
        text: str,
        language: Language,
        doc: object | None = None,
        config: RuleConfig | None = None,
    ) -> list[Finding]:
        cfg = config if config is not None else RuleConfig()
        ctx = CheckContext(text=text, doc=doc)
        findings: list[Finding] = []
        for rule in self._rules:
            if rule.language != language:
                continue
            if not cfg.is_active(
                rule.spec.category.value, rule.rule_id, rule.spec.pack
            ):
                continue
            findings.extend(CHECKS[rule.spec.extends](rule, ctx))
        findings.sort(key=lambda f: (f.span.start, f.span.end))
        return findings
```

- [ ] **Step 4: Run the backend suite**

Run: `uv run pytest -q`
Expected: all pass (general-rule behavior is unchanged with `config=None`).

- [ ] **Step 5: Commit**

```bash
git add app/checkers/rules/loader.py app/checkers/rules/engine.py tests/test_rule_engine.py
git commit -m "feat: rule packs — pack field, packs_on activation semantics"
```

---

### Task 2: Engine — `examples` block + catalog example test harness

**Files:**
- Modify: `backend/app/checkers/rules/loader.py`
- Modify: `backend/rules/en/style/weasel-words.yml` (first real example block)
- Create: `backend/tests/test_rule_examples.py`

- [ ] **Step 1: Add `RuleExamples` (optional for now — Task 3 flips it to required)**

In `backend/app/checkers/rules/loader.py`, before `RuleSpec`:

```python
class RuleExamples(BaseModel):
    """Self-documenting example sentences: bad ones must trigger the rule,
    good ones must not. Rendered in the rules view and run as tests."""

    bad: list[str] = Field(min_length=1)
    good: list[str] = Field(min_length=1)
```

In `RuleSpec`, after `pack`:

```python
    examples: RuleExamples | None = None
```

- [ ] **Step 2: Give one real rule examples (harness must have something to bite on)**

Append to `backend/rules/en/style/weasel-words.yml`:

```yaml
examples:
  bad:
    - "This is very interesting and somewhat useful."
  good:
    - "This is a precise and useful result."
```

- [ ] **Step 3: Write the catalog test**

Create `backend/tests/test_rule_examples.py`:

```python
"""Every rule runs against its own YAML examples — the catalog tests itself.

Bad sentences must yield >=1 finding from that rule; good sentences none.
Other rules firing on the same sentence is fine (findings are filtered by
rule id).
"""

from pathlib import Path

import pytest

from app.checkers.rules.engine import RuleConfig, RuleEngine
from app.checkers.rules.loader import LoadedRule, rule_requires_doc
from app.core.config import NlpSettings
from app.core.models import Finding
from app.nlp.registry import NlpRegistry

RULES_DIR = Path(__file__).parent.parent / "rules"
ENGINE = RuleEngine(RULES_DIR)
REGISTRY = NlpRegistry(NlpSettings().models)

# Until examples are mandatory (see the backfill), rules without them are
# simply not parametrized.
RULES = [rule for rule in ENGINE.list_rules() if rule.spec.examples is not None]


def _hits(rule: LoadedRule, sentence: str) -> list[Finding]:
    doc = None
    if rule_requires_doc(rule.spec):
        doc = REGISTRY.analyze(sentence, rule.language.value)
        assert doc is not None, f"spaCy model for '{rule.language.value}' unavailable"
    config = RuleConfig(packs_on=[rule.spec.pack] if rule.spec.pack else [])
    findings = ENGINE.check(sentence, rule.language, doc=doc, config=config)
    return [f for f in findings if f.rule_id == rule.rule_id]


def _rule_id(rule: LoadedRule) -> str:
    return f"{rule.language.value}:{rule.rule_id}"


def test_catalog_loads_without_errors() -> None:
    assert ENGINE.errors == []


@pytest.mark.parametrize("rule", RULES, ids=_rule_id)
def test_bad_examples_fire(rule: LoadedRule) -> None:
    for sentence in rule.spec.examples.bad:
        assert _hits(rule, sentence), (
            f"{rule.rule_id}: expected a finding for bad example {sentence!r}"
        )


@pytest.mark.parametrize("rule", RULES, ids=_rule_id)
def test_good_examples_stay_clean(rule: LoadedRule) -> None:
    for sentence in rule.spec.examples.good:
        hits = _hits(rule, sentence)
        assert not hits, (
            f"{rule.rule_id}: good example {sentence!r} unexpectedly flagged "
            f"{[f.span.text for f in hits]}"
        )
```

- [ ] **Step 4: Run it**

Run: `uv run pytest tests/test_rule_examples.py -v`
Expected: PASS — 1 rule parametrized (weasel-words), both directions green. If the bad example doesn't fire, the harness is broken — fix before continuing.

- [ ] **Step 5: Commit**

```bash
git add app/checkers/rules/loader.py rules/en/style/weasel-words.yml tests/test_rule_examples.py
git commit -m "feat: self-testing rule examples — schema + catalog-wide example test"
```

---

### Task 3: Backfill examples for all 49 rules, then make `examples` required

**Files:**
- Modify: all 48 remaining files under `backend/rules/`
- Modify: `backend/app/checkers/rules/loader.py`
- Modify: `backend/tests/test_rule_engine.py` (write_rule stub helper)
- Test: `backend/tests/test_rule_examples.py`, `tests/test_rule_engine.py`

- [ ] **Step 1: Backfill — append an `examples:` block to every rule file**

The sentences below are lifted from `backend/tests/test_starter_rules.py` where one exists (proven triggers). Append to each file exactly:

```yaml
examples:
  bad:
    - "<bad sentence(s) from the table>"
  good:
    - "<good sentence(s) from the table>"
```

| File | bad | good |
|---|---|---|
| en/style/exclamations.yml | `This is great!!` | `This is great!` |
| en/style/nominalizations.yml | `We made a decision to proceed.` | `We decided to proceed.` |
| en/style/passive-voice.yml | `The report was written by the team.` | `The team wrote the report.` **and** `The team was tired.` |
| en/style/split-infinitive.yml | `We want to quickly finish the report.` | `We want to finish the report quickly.` |
| en/grammar/article-an.yml | `She gave an presentation about writing.` | `She gave an honest answer in an hour.` |
| en/grammar/repeated-words.yml | `It is is fine.` | `It is fine.` |
| en/clarity/wordiness.yml | `We utilize synergy in order to succeed.` | `We use tests to succeed.` |
| en/clarity/long-sentence.yml | `This sentence keeps adding clause after clause because the writer never stops to breathe, piling words upon words until any reader loses the thread entirely and forgets where the whole thing began.` | `Short sentence.` |
| en/vividness/cliches.yml | `At the end of the day, we think outside the box.` | `Ultimately, we find new approaches.` |
| en/vividness/expletive-opener.yml | `There are many issues in the draft.` | `The draft has many issues.` |
| de/style/fuellwoerter.yml | `Das ist halt eigentlich ganz gut.` | `Das ist gut.` |
| de/style/anglizismen.yml | `Wir haben ein Meeting gecancelt.` | `Wir haben ein Treffen abgesagt.` |
| de/style/passiv.yml | `Der Bericht wurde vom Team geschrieben.` | `Das Team schrieb den Bericht.` |
| de/style/wuerde-stil.yml | `Ich würde das Angebot gerne annehmen.` | `Ich nehme das Angebot gerne an.` |
| de/grammar/doppelte-woerter.yml | `Das ist ist ein Fehler.` | `Das ist ein Fehler.` |
| de/grammar/einzigste.yml | `Das ist das einzigste Problem.` | `Das ist das einzige Problem.` |
| de/clarity/lange-saetze.yml | `Dieser Satz reiht Nebensatz an Nebensatz, weil die Autorin niemals innehält, und türmt Wort auf Wort, bis alle Leserinnen und Leser den Faden verlieren und am Ende vergessen, wo alles überhaupt begonnen hat.` | `Der Satz ist kurz.` |
| de/clarity/schachtelsaetze.yml | `Der Satz, der viele Nebensätze, die stören, enthält, ist lang.` | `Der Satz ist kurz, klar und gut.` |
| fr/style/mots-flous.yml | `C'est très intéressant.` | `C'est un résultat précis.` |
| fr/style/voix-passive.yml | `Le rapport a été écrit par l'équipe.` | `L'équipe a écrit le rapport.` |
| fr/grammar/mots-repetes.yml | `C'est est une erreur.` | `C'est une erreur.` |
| fr/grammar/malgre-que.yml | `Malgré que ce soit difficile, nous continuons.` | `Bien que ce soit difficile, nous continuons.` |
| fr/clarity/phrase-longue.yml | `Cette phrase ajoute proposition après proposition parce que la personne qui écrit ne s'arrête jamais pour respirer, empilant des mots sur des mots jusqu'à ce que chaque lecteur perde complètement le fil du propos.` | `La phrase est courte.` |
| fr/clarity/lourdeurs.yml | `Suite à votre message, nous répondrons.` | `Après votre message, nous répondrons.` |
| fr/vividness/cliches.yml | `Au bout du compte, ça marche.` | `Finalement, ça marche.` |
| es/style/muletillas.yml | `Es muy interesante.` | `Es un resultado preciso.` |
| es/style/voz-pasiva.yml | `El informe fue escrito por el equipo.` | `El equipo escribió el informe.` |
| es/grammar/palabras-repetidas.yml | `Esto es es un error.` | `Esto es un error.` |
| es/grammar/dequeismo.yml | `Pienso de que es una buena idea.` | `Pienso que es una buena idea.` |
| es/clarity/frase-larga.yml | `Esta frase añade cláusula tras cláusula porque quien escribe nunca se detiene a respirar, apilando palabras sobre palabras hasta que cualquier lector pierde por completo el hilo y olvida dónde empezó todo.` | `La frase es corta.` |
| es/clarity/circunloquios.yml | `En base a los datos, decidimos.` | `Según los datos, decidimos.` |
| es/vividness/cliches.yml | `Al fin y al cabo, funciona.` | `Finalmente, funciona.` |
| it/style/parole-vaghe.yml | `È molto interessante.` | `È un risultato preciso.` |
| it/style/forma-passiva.yml | `Il rapporto è stato scritto dal team.` | `Il team ha scritto il rapporto.` |
| it/grammar/parole-ripetute.yml | `Questo è è un errore.` | `Questo è un errore.` |
| it/grammar/ma-pero.yml | `Ma però questo non funziona.` | `Ma questo non funziona.` |
| it/clarity/frase-lunga.yml | `Questa frase aggiunge proposizione dopo proposizione perché chi scrive non si ferma mai a respirare, accumulando parole su parole finché ogni lettore perde completamente il filo e dimentica dove era cominciato tutto.` | `La frase è corta.` |
| it/clarity/burocratese.yml | `Al fine di migliorare, cambiamo processo.` | `Per migliorare, cambiamo processo.` |
| it/vividness/cliches.yml | `Alla fine dei conti, funziona.` | `Funziona bene.` |
| ja/style/redundant-potential.yml | `私たちはこの機能を使用することができます。` | `私たちはこの機能を使えます。` |
| ja/style/double-negative.yml | `できないことはない。` | `できます。` |
| ja/style/mazu-saisho.yml | `まず最初に、計画を説明します。` | `最初に、計画を説明します。` |
| ja/clarity/long-sentence.yml | `この機能はとても便利で、この機能はとても便利で、この機能はとても便利で、この機能はとても便利で、この機能はとても便利で、この機能はとても便利で、この機能はとても便利で、この機能はとても便利で、この機能はとても便利で、この機能はとても便利で、この機能はとても便利で、この機能はとても便利で、使いやすいです。` | `短い文です。` |
| ja/clarity/touten-kajou.yml | `これは、とても、長い、複雑な、例文で、あります。` | `これは短い文です。` |
| zh/style/filler.yml | `基本上，这个方法有效。` | `这个方法有效。` |
| zh/style/jinxing.yml | `他对这个项目进行了分析。` | `我们明天讨论这个项目。` |
| zh/clarity/long-sentence.yml | `这个功能非常好用而且这个功能非常好用而且这个功能非常好用而且这个功能非常好用而且这个功能非常好用而且这个功能非常好用而且这个功能非常好用而且这个功能非常好用而且这个功能非常好用而且这个功能非常好用而且大家都喜欢。` | `这个方法有效。` |
| zh/clarity/douhao-guoduo.yml | `这个方法很好，操作简单，成本很低，效果明显，大家都很满意，值得推广，应该继续。` | `这个方法有效。` |

Use double-quoted YAML strings throughout (several sentences contain apostrophes).

- [ ] **Step 2: Run the catalog test against the full backfill**

Run: `uv run pytest tests/test_rule_examples.py -v`
Expected: 49 rules parametrized, all green. If a sentence doesn't trigger (or a good one does), adjust the **sentence** (not the rule) until it honestly demonstrates the rule — these are proven test sentences, so failures should be rare.

- [ ] **Step 3: Teach `write_rule` to stub examples, then flip the field to required**

In `backend/tests/test_rule_engine.py`, replace `write_rule` with:

```python
_STUB_EXAMPLES = """
examples:
  bad: ["trigger sentence"]
  good: ["clean sentence"]
"""


def write_rule(rules_dir: Path, lang: str, relpath: str, content: str) -> None:
    # examples: is schema-required; inline test rules get a stub block so
    # each test states only what it is about.
    if "examples:" not in content:
        content = content.rstrip() + "\n" + _STUB_EXAMPLES
    path = rules_dir / lang / relpath
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
```

In `backend/app/checkers/rules/loader.py`, change the field to required:

```python
    examples: RuleExamples
```

In `backend/tests/test_rule_examples.py`, the filter is now moot — replace the `RULES = ...` line with:

```python
RULES = ENGINE.list_rules()
```

- [ ] **Step 4: Add the loader-enforcement test**

Append to `backend/tests/test_rule_engine.py` (inside `TestPacks` or a new class — writes the file directly to bypass the stub helper):

```python
def test_rule_without_examples_is_reported(tmp_path: Path) -> None:
    rules_dir = tmp_path / "rules"
    path = rules_dir / "en" / "style" / "bare.yml"
    path.parent.mkdir(parents=True)
    path.write_text(
        'extends: existence\nmessage: "x"\ncategory: style\ntokens: [x]\n',
        encoding="utf-8",
    )
    engine = RuleEngine(rules_dir)
    assert engine.list_rules() == []
    assert len(engine.errors) == 1
    assert "examples" in engine.errors[0].error
```

- [ ] **Step 5: Run the full backend suite**

Run: `uv run pytest -q`
Expected: all pass. Failures in `test_rule_engine.py` / `test_nlp_rules.py` mean an inline YAML snippet contains the literal string `examples:` in a comment or the stub broke a YAML document — fix the snippet.

- [ ] **Step 6: Commit**

```bash
git add rules/ tests/test_rule_engine.py tests/test_rule_examples.py app/checkers/rules/loader.py
git commit -m "feat: mandatory rule examples — 49 rules backfilled, loader enforces"
```

---

### Task 4: Rules API — pack, examples, packs index

**Files:**
- Modify: `backend/app/api/rules.py`
- Test: `backend/tests/test_rules_api.py`

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/test_rules_api.py` (follow the file's existing client fixture pattern — it builds the app with the real rules dir):

```python
def test_rules_carry_pack_examples_and_packs_index(client) -> None:
    payload = client.get("/api/rules?language=en").json()
    by_id = {rule["rule_id"]: rule for rule in payload["rules"]}
    weasel = by_id["style.weasel-words"]
    assert weasel["pack"] is None
    assert weasel["examples"]["bad"] and weasel["examples"]["good"]
    # Packs discovered from the catalog (EN pack rules land in Task 7;
    # before that the list is empty — assert the key exists and is sorted).
    assert payload["packs"] == sorted(payload["packs"])
```

(If the file's fixture is named differently, adapt the fixture name only.)

- [ ] **Step 2: Run to verify it fails**

Run: `uv run pytest tests/test_rules_api.py -v`
Expected: FAIL — KeyError `'pack'` / `'packs'`.

- [ ] **Step 3: Implement**

In `backend/app/api/rules.py`:

Add to `RuleInfo`:

```python
    pack: str | None
    examples: dict[str, list[str]]
```

In `_rule_info`, add:

```python
        pack=rule.spec.pack,
        examples=rule.spec.examples.model_dump(),
```

In `_payload`, add a discovered, sorted pack list for the returned rules:

```python
    return {
        "rules": [_rule_info(rule).model_dump() for rule in rules],
        "packs": sorted({rule.spec.pack for rule in rules if rule.spec.pack}),
        "errors": [error.model_dump() for error in engine.errors],
    }
```

(The endpoint is language-filtered, so a flat list is the per-language index; the unfiltered call returns the union.)

- [ ] **Step 4: Run to verify it passes**

Run: `uv run pytest tests/test_rules_api.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/api/rules.py tests/test_rules_api.py
git commit -m "feat: rules API exposes pack, examples, and discovered packs"
```

---

### Task 5: Profiles — `packs_on` column, API, check-API pass-through

**Files:**
- Modify: `backend/app/services/profiles.py`
- Modify: `backend/app/api/profiles.py`
- Modify: `backend/app/services/seed_profiles.py` (only `standard_defaults`)
- Test: `backend/tests/test_profiles.py`, `backend/tests/test_profiles_api.py`, `backend/tests/test_check_api.py`

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_profiles.py` (reuse its store fixture/construction style):

```python
def test_packs_on_roundtrip(tmp_path) -> None:
    store = ProfileStore(tmp_path / "p.sqlite")
    profile = store.create_profile(
        Language.EN, "Docs", packs_on=["techdocs", "blog"]
    )
    assert profile.packs_on == ["techdocs", "blog"]
    updated = store.update_profile(profile.id, packs_on=["techdocs"])
    assert updated is not None and updated.packs_on == ["techdocs"]
    assert store.get_profile(profile.id).packs_on == ["techdocs"]


def test_packs_on_migration_defaults_empty(tmp_path) -> None:
    # A database created before the column existed gets it via _migrate.
    import sqlite3

    db = tmp_path / "old.sqlite"
    conn = sqlite3.connect(db)
    conn.executescript(
        """CREATE TABLE profiles (
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               language TEXT NOT NULL, name TEXT NOT NULL,
               is_standard INTEGER NOT NULL DEFAULT 0,
               categories_off TEXT NOT NULL DEFAULT '[]',
               rule_exceptions TEXT NOT NULL DEFAULT '[]',
               domain_ids TEXT NOT NULL DEFAULT '[]',
               llm_provider TEXT, llm_model TEXT, llm_tier TEXT,
               llm_instructions TEXT NOT NULL DEFAULT '',
               example_text TEXT NOT NULL DEFAULT '',
               UNIQUE(language, name));
           CREATE TABLE profile_seed_markers (language TEXT PRIMARY KEY);
           INSERT INTO profiles (language, name) VALUES ('en', 'Old');"""
    )
    conn.commit()
    conn.close()
    store = ProfileStore(db)
    old = store.list_profiles(Language.EN)[0]
    assert old.packs_on == []
```

Append to `backend/tests/test_profiles_api.py` (reuse its client fixture):

```python
def test_profile_api_carries_packs_on(client) -> None:
    created = client.post(
        "/api/profiles",
        json={"language": "en", "name": "Packy", "packs_on": ["marketing"]},
    ).json()
    assert created["packs_on"] == ["marketing"]
    updated = client.put(
        f"/api/profiles/{created['id']}",
        json={
            "name": "Packy",
            "categories_off": [],
            "rule_exceptions": [],
            "packs_on": ["marketing", "blog"],
            "domain_ids": [],
            "llm_provider": None,
            "llm_model": None,
            "llm_tier": "balanced",
            "llm_instructions": "",
            "example_text": "",
        },
    ).json()
    assert updated["packs_on"] == ["marketing", "blog"]
```

Append to `backend/tests/test_check_api.py` (reuse its client/app fixture; the app uses the real `backend/rules` dir — before Task 7 there are no pack rules, so assert the contract, not a hit):

```python
def test_check_accepts_packs_on(client) -> None:
    response = client.post(
        "/api/checks",
        json={
            "text": "This is very interesting.",
            "language": "en",
            "checkers": ["rules"],
            "rule_config": {
                "categories_off": [],
                "exceptions": [],
                "packs_on": ["marketing"],
            },
        },
    )
    assert response.status_code == 202
```

- [ ] **Step 2: Run to verify they fail**

Run: `uv run pytest tests/test_profiles.py tests/test_profiles_api.py tests/test_check_api.py -v`
Expected: FAIL — unexpected keyword `packs_on` / KeyError. (The check-API test may already pass — `RuleConfig` gained the field in Task 1; that's fine, it pins the contract.)

- [ ] **Step 3: Implement storage**

In `backend/app/services/profiles.py`:

1. `_SCHEMA` profiles table: after `rule_exceptions ...` add
   `packs_on TEXT NOT NULL DEFAULT '[]',`
2. `Profile` model: after `rule_exceptions` add
   `packs_on: list[str] = Field(default_factory=list)`
3. `_row_to_profile`: add `packs_on=json.loads(row["packs_on"]),`
4. `_migrate`: add
   ```python
   if "packs_on" not in columns:
       conn.execute(
           "ALTER TABLE profiles ADD COLUMN packs_on TEXT NOT NULL DEFAULT '[]'"
       )
   ```
5. `create_profile`: add parameter `packs_on: list[str] | None = None,` after
   `rule_exceptions`; add `packs_on` to the INSERT column list and
   `json.dumps(packs_on or []),` to the values (keep column/value order in
   sync).
6. `_UPDATABLE`: add `"packs_on",` after `"rule_exceptions",`.
7. `update_profile` UPDATE statement: add `packs_on = ?,` after
   `rule_exceptions = ?,` and `json.dumps(merged.packs_on),` in the matching
   position.

- [ ] **Step 4: Implement API models**

In `backend/app/api/profiles.py`:
- `ProfileCreate`: add `packs_on: list[str] = Field(default_factory=list)` after `rule_exceptions`.
- `ProfileUpdate`: add `packs_on: list[str]` after `rule_exceptions` (required, like its siblings — senders must carry it).
- Wherever create/update unpack the body into store calls, `packs_on` flows through `model_dump()` untouched — verify the create endpoint passes it (it passes fields explicitly or via dump; extend explicit passing if needed).

In `backend/app/services/seed_profiles.py`, `standard_defaults` gains `"packs_on": [],` (reset must produce a full field set).

- [ ] **Step 5: Run the suite**

Run: `uv run pytest -q`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add app/services/profiles.py app/api/profiles.py app/services/seed_profiles.py tests/test_profiles.py tests/test_profiles_api.py tests/test_check_api.py
git commit -m "feat: profiles store and API carry packs_on"
```

---

### Task 6: Seeding — pack opt-ins, Blog profiles, demo texts

**Files:**
- Modify: `backend/app/services/seed_profiles.py`
- Create: `backend/demos/en-blog.txt`, `backend/demos/de-blog.txt`
- Modify: `backend/demos/en-marketing.txt`, `de-marketing.txt`, `en-technical-documentation.txt`, `de-technical-documentation.txt`
- Test: `backend/tests/test_seed.py`

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/test_seed.py` (adapt fixture/DEMOS path to the file's existing style):

```python
def test_seed_pack_profiles(tmp_path) -> None:
    store = ProfileStore(tmp_path / "profiles.sqlite")
    seed_profiles(store, DEMOS_DIR, seed_examples=True)
    en = {p.name: p for p in store.list_profiles(Language.EN)}
    assert en["Marketing"].packs_on == ["marketing"]
    assert en["Technical Documentation"].packs_on == ["techdocs"]
    assert en["Blog"].packs_on == ["blog"]
    assert en["Blog"].example_text  # demo file exists and is non-empty
    de = {p.name: p for p in store.list_profiles(Language.DE)}
    assert de["Blog"].packs_on == ["blog"]
    # Japanese keeps Marketing/TechDoc (packs are no-ops there for now), no Blog.
    ja = {p.name: p for p in store.list_profiles(Language.JA)}
    assert "Blog" not in ja
```

Run: `uv run pytest tests/test_seed.py -v` — expected FAIL.

- [ ] **Step 2: Implement seeding**

In `backend/app/services/seed_profiles.py`:

Add after `EXAMPLE_LANGUAGES`:

```python
BLOG_LANGUAGES = {Language.EN, Language.DE}

_BLOG_INSTRUCTIONS = {
    Language.EN: (
        "Audience: blog readers. Favor a personal but tight voice; concrete "
        "examples over abstractions; short paragraphs. Flag filler openings, "
        "rambling, and unsupported generalizations."
    ),
    Language.DE: (
        "Zielgruppe: Blog-Leserinnen und -Leser. Persönliche, aber straffe "
        "Sprache; konkrete Beispiele statt Abstraktionen; kurze Absätze. "
        "Markiere Floskel-Einstiege, Abschweifungen und unbelegte "
        "Verallgemeinerungen."
    ),
}
```

In `seed_profiles`, extend the two existing example profiles and add Blog inside the `seed_examples` branch:

- Marketing call: add `packs_on=["marketing"],`
- Technical Documentation call: add `packs_on=["techdocs"],`
- After the Technical Documentation call, add:

```python
            if language in BLOG_LANGUAGES:
                _create_ignoring_collision(
                    store,
                    language,
                    "Blog",
                    packs_on=["blog"],
                    llm_tier="balanced",
                    llm_instructions=_BLOG_INSTRUCTIONS[language],
                    example_text=_demo(demos_dir, f"{language.value}-blog.txt"),
                )
```

- [ ] **Step 3: Demo texts**

Create `backend/demos/en-blog.txt`:

```
Welcome to my blog! In this post, we will take a deep dive into caching. Arguably, it seems that most teams could of shipped with less bugs if caching was understood better. Without further ado, let's dive in!
```

Create `backend/demos/de-blog.txt`:

```
Herzlich willkommen auf meinem Blog! In diesem Beitrag zeige ich euch, wie man bereits schon mit wenigen Handgriffen einen besseren Arbeitsablauf aufbaut. Heute möchte ich zwecks Klarheit ganz ohne lange Vorrede starten.
```

Append to `backend/demos/en-marketing.txt` (own paragraph):

```
Our revolutionary, best-in-class platform is guaranteed to deliver seamless integration — BUY TODAY WITH HUGE SAVINGS!
```

Append to `backend/demos/de-marketing.txt`:

```
Unser einzigartiges Produkt ist ein echter Game Changer — sensationell und unschlagbar!
```

Append to `backend/demos/en-technical-documentation.txt`:

```
Simply click Install and the wizard will guide you through the setup. The user should not edit the generated config, e.g. the port settings.
```

Append to `backend/demos/de-technical-documentation.txt`:

```
Bitte klicken Sie auf Installieren. Man wählt anschließend den Zielordner, und der Assistent wird die Einstellungen speichern. Senden Sie uns bei Fragen eine Email.
```

- [ ] **Step 4: Run the suite** — `uv run pytest -q` (includes `test_demo_texts.py`; fix any assertion it makes about demo files if one trips).

- [ ] **Step 5: Commit**

```bash
git add app/services/seed_profiles.py demos/ tests/test_seed.py
git commit -m "feat: seed pack-enabled Marketing/TechDoc/Blog profiles with demo texts"
```

---

### Task 7: English rules (9 general + 9 pack) + greedy matching

**Files:**
- Create: 18 files under `backend/rules/en/`
- Modify: `backend/app/checkers/rules/checks/token_pattern.py`
- Test: `backend/tests/test_rule_examples.py` (automatic), `backend/tests/test_nlp_rules.py` (greedy)

- [ ] **Step 1: Greedy matching (needed by noun-string) — failing test first**

Append to `backend/tests/test_nlp_rules.py` inside `TestTokenPattern`:

```python
    def test_quantified_pattern_yields_longest_match_only(
        self, rules_dir: Path, registry: NlpRegistry
    ) -> None:
        write_rule(
            rules_dir,
            "en",
            "clarity/noun-string.yml",
            """
extends: token_pattern
message: "'%s' stacks nouns."
category: clarity
pattern:
  - {POS: NOUN, OP: "{4,}"}
""",
        )
        engine = make_engine(rules_dir)
        text = "The server configuration management system update failed."
        doc = registry.analyze(text, "en")
        findings = engine.check(text, Language.EN, doc=doc)
        assert len(findings) == 1
        assert findings[0].span.text == "server configuration management system update"
```

Run: `uv run pytest tests/test_nlp_rules.py -k longest -v` — expected FAIL (multiple overlapping matches).

In `backend/app/checkers/rules/checks/token_pattern.py`, change the add call:

```python
    matcher.add(rule.rule_id, [rule.spec.pattern], greedy="LONGEST")
```

Re-run: PASS. Run `uv run pytest -q` — the existing quantified rules (split-infinitive, würde-stil) must stay green; if a starter test asserted multiple overlapping spans, update it to the LONGEST behavior.

- [ ] **Step 2: Create the 18 rule files** (complete content; `pack:` only on pack rules)

`backend/rules/en/grammar/could-of.yml`:

```yaml
extends: substitution
message: "Use '%s' instead of '%s' — 'of' here is a mishearing of 'have'."
level: error
category: grammar
ignorecase: true
swap:
  could of: could have
  should of: should have
  would of: would have
  might of: might have
  must of: must have
examples:
  bad:
    - "You should of seen the demo."
  good:
    - "You should have seen the demo."
```

`backend/rules/en/grammar/fewer-less.yml`:

```yaml
# Demonstrates: MORPH number agreement in a token pattern.
extends: token_pattern
message: "'%s' — use 'fewer' with countable plurals."
level: warning
category: grammar
pattern:
  - {LOWER: less}
  - {POS: NOUN, MORPH: {IS_SUPERSET: ["Number=Plur"]}}
examples:
  bad:
    - "We shipped less bugs in this release."
  good:
    - "We shipped fewer bugs in this release."
    - "There is less noise now."
```

`backend/rules/en/grammar/dangling-participle.yml`:

```yaml
# Demonstrates: IS_SENT_START plus a bounded non-punctuation gap.
extends: token_pattern
message: "'%s' — the opening participle has nothing to modify (dangling modifier)."
level: warning
category: grammar
pattern:
  - {TAG: VBG, IS_SENT_START: true}
  - {IS_PUNCT: false, OP: "{,8}"}
  - {TEXT: ","}
  - {LOWER: {IN: [it, there]}}
examples:
  bad:
    - "Walking home, it started to rain."
  good:
    - "Walking home, I saw a fox."
    - "Running is fun."
```

`backend/rules/en/grammar/based-off.yml`:

```yaml
extends: substitution
message: "Use '%s' instead of '%s'."
level: warning
category: grammar
ignorecase: true
swap:
  based off( of)?: based on
examples:
  bad:
    - "The design is based off of an older mockup."
  good:
    - "The design is based on an older mockup."
```

`backend/rules/en/style/hedging.yml`:

```yaml
extends: existence
message: "'%s' hedges — commit to the claim or drop it."
level: suggestion
category: style
ignorecase: true
tokens:
  - arguably
  - it seems that
  - it appears that
  - may or may not
  - to some extent
  - for the most part
  - more or less
examples:
  bad:
    - "Arguably, it seems that the fix works."
  good:
    - "The fix works."
```

`backend/rules/en/style/double-negative.yml`:

```yaml
# Demonstrates: combining REGEX and NOT_IN predicates on one attribute.
extends: token_pattern
message: "'%s' — a double negative; consider the direct positive."
level: suggestion
category: style
pattern:
  - {LOWER: {IN: [not, never]}}
  - {POS: ADJ, LOWER: {REGEX: "^(un|in|im|non|il|ir)", NOT_IN: [
      important, impressive, improved, immediate, immense, interesting,
      intense, internal, international, initial, innovative, intelligent,
      intuitive, unique, united, universal, irresistible]}}
examples:
  bad:
    - "Such failures are not uncommon."
    - "The migration is not impossible."
  good:
    - "This detail is not important."
    - "The new API is not intuitive."
```

`backend/rules/en/style/weak-verb-adverb.yml`:

```yaml
# Demonstrates: DependencyMatcher — an advmod hanging off a weak verb.
extends: dependency
message: "'%s' — a weak verb propped by an adverb; one stronger verb often beats the pair (sprinted, dashed, whispered)."
level: suggestion
category: style
pattern:
  - {RIGHT_ID: verb, RIGHT_ATTRS: {LEMMA: {IN: [walk, run, say, look, move, go]}}}
  - {LEFT_ID: verb, REL_OP: ">", RIGHT_ID: adverb, RIGHT_ATTRS: {DEP: advmod, TEXT: {REGEX: "(?i)ly$"}}}
examples:
  bad:
    - "He ran quickly to the station."
  good:
    - "He sprinted to the station."
    - "He ran to the station."
```

`backend/rules/en/clarity/noun-string.yml`:

```yaml
# Demonstrates: a {4,} quantifier (with greedy LONGEST matching).
extends: token_pattern
message: "'%s' — a long noun string; break it up with prepositions or verbs."
level: warning
category: clarity
pattern:
  - {POS: NOUN, OP: "{4,}"}
examples:
  bad:
    - "The server configuration management system update failed."
  good:
    - "The server configuration was updated."
```

`backend/rules/en/clarity/negative-phrasing.yml`:

```yaml
extends: substitution
message: "Use '%s' instead of '%s' — positive phrasing is easier to parse."
level: suggestion
category: clarity
ignorecase: true
swap:
  not able to: unable to
  not possible: impossible
  does not have: lacks
  not sure: unsure
examples:
  bad:
    - "We were not able to reproduce the bug."
  good:
    - "We were unable to reproduce the bug."
```

`backend/rules/en/style/hype-words.yml`:

```yaml
extends: existence
message: "'%s' is marketing hype — show the benefit instead of asserting it."
level: warning
category: style
pack: marketing
ignorecase: true
tokens:
  - world-class
  - revolutionary
  - seamless
  - best-in-class
  - game-changing
  - cutting-edge
  - next-generation
  - state-of-the-art
  - groundbreaking
examples:
  bad:
    - "Our revolutionary, best-in-class platform delivers seamless integration."
  good:
    - "Our platform integrates with your existing tools in one step."
```

`backend/rules/en/style/unverifiable-claims.yml`:

```yaml
extends: existence
message: "'%s' is an unverifiable claim — back it with a number, source, or cut it."
level: warning
category: style
pack: marketing
ignorecase: true
tokens:
  - guaranteed
  - market-leading
  - industry-leading
  - award-winning
  - the best
  - number one
raw:
  - '#1\b'
examples:
  bad:
    - "Our award-winning support is guaranteed to be the best."
  good:
    - "Our support team answers within one hour."
```

`backend/rules/en/style/very-unique.yml`:

```yaml
extends: substitution
message: "Use '%s' instead of '%s' — 'unique' has no degrees."
level: warning
category: style
pack: marketing
ignorecase: true
swap:
  (?:very|completely|totally|most) unique: unique
examples:
  bad:
    - "This is a very unique feature."
  good:
    - "This is a unique feature."
```

`backend/rules/en/style/shouting-caps.yml`:

```yaml
extends: existence
message: "All-caps shouting — use emphasis sparingly, if at all."
level: warning
category: style
pack: marketing
raw:
  - '\b[A-Z]{4,}(?:\s+[A-Z]{4,})+\b'
examples:
  bad:
    - "Get it now with HUGE SAVINGS on every plan."
  good:
    - "Use the HTTP API to fetch results."
```

`backend/rules/en/style/third-person-user.yml`:

```yaml
extends: token_pattern
message: "'%s' — address the reader directly: 'you should…' or the imperative."
level: warning
category: style
pack: techdocs
pattern:
  - {LOWER: the}
  - {LEMMA: {IN: [user, customer, administrator]}}
  - {LEMMA: {IN: [should, must, can, may]}}
examples:
  bad:
    - "The user should click the Save button."
  good:
    - "You can configure the timeout."
    - "The user profile stores preferences."
```

`backend/rules/en/style/future-tense-instruction.yml`:

```yaml
extends: token_pattern
message: "'%s' — describe UI behavior in the present tense ('the dialog opens')."
level: suggestion
category: style
pack: techdocs
pattern:
  - {LOWER: will}
  - {POS: VERB}
examples:
  bad:
    - "The dialog will open."
  good:
    - "The dialog opens automatically."
```

`backend/rules/en/style/condescension.yml`:

```yaml
extends: existence
message: "'%s' can read as condescending when a step is not simple for the reader."
level: suggestion
category: style
pack: techdocs
ignorecase: true
tokens:
  - simply
  - obviously
  - clearly
  - needless to say
  - of course
examples:
  bad:
    - "Simply run the installer; obviously the defaults work."
  good:
    - "Run the installer; the defaults work."
```

`backend/rules/en/style/latin-abbreviations.yml`:

```yaml
# Not a substitution rule: the engine wraps swap keys in \b…\b, and a
# trailing \b after a period never matches before whitespace.
extends: existence
message: "Prefer plain English: 'for example' (e.g.), 'that is' (i.e.), 'and so on' (etc.)."
level: suggestion
category: style
pack: techdocs
raw:
  - '\be\.g\.'
  - '\bi\.e\.'
  - '\betc\.'
examples:
  bad:
    - "Configure the timeouts, e.g. 30 seconds."
  good:
    - "Configure the timeouts, for example 30 seconds."
```

`backend/rules/en/style/throat-clearing.yml`:

```yaml
extends: existence
message: "'%s' is throat-clearing — start with the substance."
level: suggestion
category: style
pack: blog
ignorecase: true
tokens:
  - in this post
  - in this article
  - in this blog post
  - without further ado
  - let's dive in
  - welcome to my blog
examples:
  bad:
    - "In this post, we will look at caching. Let's dive in!"
  good:
    - "Caching cuts load times; here is how it works."
```

- [ ] **Step 3: Run the catalog test**

Run: `uv run pytest tests/test_rule_examples.py -v -k "en:"`
Expected: 29 EN rules parametrized, all green. For failures on NLP rules, first check the parse (`uv run python -c "import spacy; nlp=spacy.load('en_core_web_sm'); print([(t.text,t.pos_,t.tag_,t.morph) for t in nlp('SENTENCE')])"`), then adjust the pattern or the example — whichever is wrong.

- [ ] **Step 4: Full suite + commit**

Run: `uv run pytest -q`

```bash
git add rules/en/ app/checkers/rules/checks/token_pattern.py tests/test_nlp_rules.py
git commit -m "feat: 18 new English rules (general + marketing/techdocs/blog packs)"
```

---

### Task 8: German rules (10 general + 7 pack)

**Files:**
- Create: 17 files under `backend/rules/de/`
- Test: `backend/tests/test_rule_examples.py` (automatic)

- [ ] **Step 1: Create the 17 rule files**

`backend/rules/de/grammar/das-dass.yml`:

```yaml
# Demonstrates: high-precision das/dass heuristic — a complement-taking verb
# before the comma plus a personal pronoun after „das“ excludes both the
# relative-clause and the article reading.
extends: token_pattern
message: "„%s“ — nach diesem Verb leitet „dass“ den Nebensatz ein."
level: warning
category: grammar
pattern:
  - {LEMMA: {IN: [hoffen, glauben, denken, sagen, wissen, meinen, finden, vermuten, behaupten, befürchten]}}
  - {TEXT: ","}
  - {LOWER: das}
  - {POS: PRON}
examples:
  bad:
    - "Ich hoffe, das er morgen kommt."
    - "Sie glaubt, das es funktioniert."
  good:
    - "Das Buch, das er gestern kaufte, ist spannend."
    - "Ich hoffe, dass er morgen kommt."
    - "Ich hoffe, das Angebot gefällt Ihnen."
```

`backend/rules/de/grammar/seit-seid.yml`:

```yaml
# Question form only: "Seit ihr fertig?" is near-certainly the seid-typo,
# while temporal "Seit ihr hier seid, …" continues after a comma.
extends: existence
message: "„Seit“ + Pronomen als Frage — hier ist das Verb „seid“ gemeint."
level: error
category: grammar
raw:
  - '\bSeit (ihr|wir)\b[^,.!?;:]*\?'
examples:
  bad:
    - "Seit ihr mit der Installation fertig?"
  good:
    - "Seit ihr hier seid, läuft alles besser."
    - "Seid ihr mit der Installation fertig?"
```

`backend/rules/de/grammar/wie-als.yml`:

```yaml
# Demonstrates: MORPH Degree=Cmp — comparatives take „als“, not „wie“.
extends: token_pattern
message: "„%s“ — nach dem Komparativ steht „als“, nicht „wie“."
level: warning
category: grammar
pattern:
  - {POS: {IN: [ADJ, ADV]}, MORPH: {IS_SUPERSET: ["Degree=Cmp"]}}
  - {LOWER: wie}
examples:
  bad:
    - "Der neue Server ist schneller wie der alte."
  good:
    - "Der neue Server ist schneller als der alte."
    - "Das System ist so schnell wie erwartet."
```

`backend/rules/de/grammar/deppenapostroph.yml`:

```yaml
extends: existence
message: "Apostroph vor Genitiv-s — im Deutschen meist falsch („Annas Laden“)."
level: warning
category: grammar
raw:
  - "\\w+['’]s\\b"
examples:
  bad:
    - "Anna's Laden ist geöffnet."
  good:
    - "Annas Laden ist geöffnet."
```

`backend/rules/de/grammar/beliebte-fehler.yml`:

```yaml
extends: substitution
message: "„%2$s“ — richtig ist „%1$s“."
level: error
category: grammar
swap:
  Standart: Standard
  Standarts: Standards
  wiederspiegeln: widerspiegeln
  wiederspiegelt: widerspiegelt
  Imbusschlüssel: Inbusschlüssel
  Gallerie: Galerie
  Reperatur: Reparatur
  seperat: separat
  seperate: separate
  seperaten: separaten
examples:
  bad:
    - "Das ist der neue Standart für alle Projekte."
  good:
    - "Das ist der neue Standard für alle Projekte."
```

(If `format_message` does not support positional `%2$s`, use the plain two-placeholder message `"Schreib „%s“ statt „%s“."` — check `app/checkers/rules/text.py` first.)

`backend/rules/de/style/funktionsverbgefuege.yml`:

```yaml
# Demonstrates: REGEX on token text (-ung noun) plus a bounded gap before a
# function verb. Catches „Die Anmeldung erfolgt …“ and „eine Prüfung …
# durchführen“; separated prefixes („führen … durch“) are out of reach.
extends: token_pattern
message: "„%s“ — Funktionsverbgefüge; das einfache Verb ist direkter (prüfen, anmelden …)."
level: suggestion
category: style
pattern:
  - {TEXT: {REGEX: "ung(en)?$"}}
  - {OP: "{,4}", TAG: {NOT_IN: [$.]}}
  - {LEMMA: {IN: [durchführen, vornehmen, erfolgen, tätigen, treffen]}}
examples:
  bad:
    - "Die Anmeldung erfolgt über das Portal."
    - "Wir müssen eine Prüfung der Daten durchführen."
  good:
    - "Wir prüfen die Daten."
```

`backend/rules/de/style/amtsdeutsch.yml`:

```yaml
extends: substitution
message: "„%2$s“ ist Amtsdeutsch — „%1$s“ ist direkter."
level: suggestion
category: style
ignorecase: true
swap:
  zwecks: für
  mittels: mit
  seitens: von
  diesbezüglich: dazu
  im Rahmen von: bei
examples:
  bad:
    - "Zwecks Klärung wenden Sie sich mittels E-Mail an den Support."
  good:
    - "Für die Klärung wenden Sie sich mit einer E-Mail an den Support."
```

(Same `%2$s` caveat as beliebte-fehler — fall back to `"Statt „%s“ besser „%s“."` matching the existing two-placeholder order `(good, matched)` used by `check_substitution`.)

`backend/rules/de/style/doppelmoppel.yml`:

```yaml
extends: existence
message: "„%s“ ist doppelt gemoppelt."
level: suggestion
category: style
ignorecase: true
tokens:
  - bereits schon
  - schon bereits
  - einzig und allein
  - neu renoviert
  - runde Kugel
  - zukünftige Pläne
  - persönlich anwesend
examples:
  bad:
    - "Das war bereits schon gestern klar."
  good:
    - "Das war schon gestern klar."
```

`backend/rules/de/clarity/genitivkette.yml`:

```yaml
# Demonstrates: optional tokens (OP "?") inside a rigid sequence.
extends: token_pattern
message: "„%s“ — Genitivkette; ein Nebensatz oder Verb entzerrt sie."
level: warning
category: clarity
pattern:
  - {POS: NOUN}
  - {LOWER: {IN: [der, des, einer, eines]}}
  - {POS: ADJ, OP: "?"}
  - {POS: NOUN}
  - {LOWER: {IN: [der, des, einer, eines]}}
  - {POS: ADJ, OP: "?"}
  - {POS: NOUN}
examples:
  bad:
    - "Die Prüfung der Umsetzung der Vorgaben der Behörde dauert an."
  good:
    - "Die Behörde prüft, wie die Vorgaben umgesetzt werden."
```

`backend/rules/de/clarity/verbklammer.yml`:

```yaml
# Demonstrates: a long bounded gap ({8,}) up to a separated verb prefix (PTKVZ).
extends: token_pattern
message: "„%s“ — weite Verbklammer; rücke die Verbpartikel näher ans Verb."
level: suggestion
category: clarity
pattern:
  - {POS: VERB}
  - {OP: "{8,}", TAG: {NOT_IN: [$., PTKVZ]}}
  - {TAG: PTKVZ}
examples:
  bad:
    - "Wir schlagen dem Team nach reiflicher Überlegung und langer interner Diskussion einen völlig neuen Ansatz vor."
  good:
    - "Wir schlagen einen neuen Ansatz vor."
```

`backend/rules/de/style/superlativ-inflation.yml`:

```yaml
# raw with \w* suffix: existence tokens are wrapped in \b…\b, which would
# miss inflected forms („einzigartiges“).
extends: existence
message: "„%s“ — Superlativ-Marketing; ein konkreter Nutzen überzeugt mehr."
level: warning
category: style
pack: marketing
ignorecase: true
raw:
  - '\beinzigartig\w*'
  - '\brevolutionär\w*'
  - '\bbahnbrechend\w*'
  - '\bunschlagbar\w*'
  - '\bsensationell\w*'
  - '\bkonkurrenzlos\w*'
  - '\bweltklasse\b'
examples:
  bad:
    - "Unser einzigartiges, revolutionäres Produkt ist unschlagbar."
  good:
    - "Unser Produkt löst konkrete Probleme."
```

`backend/rules/de/style/hype-anglizismen.yml`:

```yaml
extends: existence
message: "„%s“ — Hype-Anglizismus; sag konkret, was das Produkt kann."
level: warning
category: style
pack: marketing
ignorecase: true
tokens:
  - State of the Art
  - State-of-the-Art
  - Game Changer
  - Game-Changer
  - Must-have
  - Next Level
examples:
  bad:
    - "Dieses Must-have ist ein echter Game Changer."
  good:
    - "Dieses Werkzeug verbessert den Arbeitsablauf deutlich."
```

`backend/rules/de/style/man-konstruktion.yml`:

```yaml
extends: token_pattern
message: "„%s“ — in Anleitungen besser direkte Anrede oder Imperativ statt „man“."
level: suggestion
category: style
pack: techdocs
pattern:
  - {LOWER: man, POS: PRON}
examples:
  bad:
    - "Man klickt anschließend auf OK."
  good:
    - "Klicken Sie anschließend auf OK."
```

`backend/rules/de/style/futur-in-anleitungen.yml`:

```yaml
# Analog zum würde-Stil, aber Indikativ: Futur beschreibt UI-Verhalten,
# das Präsens ist direkter. Passiv („wird gespeichert“, VVPP) bleibt außen vor.
extends: token_pattern
message: "„%s“ — beschreibe Verhalten im Präsens („der Dialog öffnet sich“)."
level: suggestion
category: style
pack: techdocs
pattern:
  - {LEMMA: werden, MORPH: {IS_SUPERSET: ["Mood=Ind", "Tense=Pres"]}}
  - {OP: "{,6}", TAG: {NOT_IN: [VVINF, $.]}}
  - {TAG: VVINF}
examples:
  bad:
    - "Der Assistent wird die Einstellungen speichern."
  good:
    - "Der Assistent speichert die Einstellungen."
    - "Die Einstellungen werden gespeichert."
```

`backend/rules/de/style/bitte-in-anleitungen.yml`:

```yaml
extends: existence
message: "„%s“ — in technischen Anleitungen unnötig; der Imperativ genügt."
level: suggestion
category: style
pack: techdocs
ignorecase: true
tokens:
  - bitte
examples:
  bad:
    - "Bitte klicken Sie auf Speichern."
  good:
    - "Klicken Sie auf Speichern."
```

`backend/rules/de/style/e-mail-schreibung.yml`:

```yaml
# case-sensitive, damit „email“ in Code-Kontexten unangetastet bleibt.
extends: substitution
message: "Schreib „%s“ statt „%s“."
level: warning
category: style
pack: techdocs
swap:
  Email: E-Mail
  Emails: E-Mails
  E-mail: E-Mail
  E-mails: E-Mails
  eMail: E-Mail
  eMails: E-Mails
examples:
  bad:
    - "Senden Sie uns eine Email."
  good:
    - "Senden Sie uns eine E-Mail."
```

`backend/rules/de/style/floskel-einstieg.yml`:

```yaml
extends: existence
message: "„%s“ — Floskel-Einstieg; starte mit der Substanz."
level: suggestion
category: style
pack: blog
ignorecase: true
tokens:
  - in diesem Beitrag
  - in diesem Artikel
  - heute möchte ich
  - ohne lange Vorrede
  - willkommen auf meinem Blog
examples:
  bad:
    - "In diesem Beitrag zeige ich euch, wie das geht."
  good:
    - "So funktioniert die neue Suche."
```

**Message-format check (do this first):** the substitution message idiom is `format_message(spec.message, good, match.group())` — placeholder order is (replacement, matched). The `%2$s`-style messages above assume positional support; if `app/checkers/rules/text.py` `format_message` only does sequential `%s`, use these messages instead: beliebte-fehler `"Richtig ist „%s“ (statt „%s“)."`, amtsdeutsch `"„%s“ ist direkter (statt „%s“)."` — same information, sequential order.

- [ ] **Step 2: Run the catalog test**

Run: `uv run pytest tests/test_rule_examples.py -v -k "de:"`
Expected: 25 DE rules, all green. For NLP failures inspect the parse with `de_core_news_sm` (same technique as Task 7) and fix pattern or sentence.

- [ ] **Step 3: Full suite + commit**

Run: `uv run pytest -q`

```bash
git add rules/de/
git commit -m "feat: 17 new German rules (general + marketing/techdocs/blog packs)"
```

---

### Task 9: Frontend plumbing — types, client, activation, PUT senders

**Files:**
- Modify: `frontend/src/types.ts`, `frontend/src/api/client.ts`, `frontend/src/profiles/profile.ts`
- Modify: `frontend/src/profiles/ProfilesView.tsx`, `frontend/src/header/ProfileSelector.tsx`, `frontend/src/rules/RulesView.tsx` (payloads only)
- Test: `frontend/src/profiles/profile.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `frontend/src/profiles/profile.test.ts` (reuse its existing profile factory/fixture style):

```ts
describe('pack-aware rule activation', () => {
  const base = {
    id: 1, language: 'en', name: 'P', is_standard: false,
    categories_off: [], rule_exceptions: [], packs_on: ['techdocs'],
    domain_ids: [], llm_provider: null, llm_model: null, llm_tier: null,
    llm_instructions: '', example_text: '',
  } as Profile

  it('keeps general rules on the XOR semantics', () => {
    expect(isRuleActive(base, 'style', 'style.plain', null)).toBe(true)
  })
  it('activates pack rules only when the pack is on', () => {
    expect(isRuleActive(base, 'style', 'style.docs', 'techdocs')).toBe(true)
    expect(isRuleActive(base, 'style', 'style.hype', 'marketing')).toBe(false)
  })
  it('lets exceptions invert pack membership', () => {
    const p = { ...base, rule_exceptions: ['style.docs', 'style.cherry'] }
    expect(isRuleActive(p, 'style', 'style.docs', 'techdocs')).toBe(false)
    expect(isRuleActive(p, 'style', 'style.cherry', 'marketing')).toBe(true)
  })
  it('lets the category toggle win over the pack', () => {
    const p = { ...base, categories_off: ['style' as Category] }
    expect(isRuleActive(p, 'style', 'style.docs', 'techdocs')).toBe(false)
  })
  it('carries packs_on into the effective rule config', () => {
    expect(effectiveRuleConfig(base)?.packs_on).toEqual(['techdocs'])
  })
})
```

Run: `npx vitest run src/profiles/profile.test.ts` — expected FAIL (signature/type).

- [ ] **Step 2: Types and client**

`frontend/src/types.ts`:
- `RuleInfo`: add `pack: string | null` and `examples: { bad: string[]; good: string[] }`.
- `Profile`: add `packs_on: string[]` after `rule_exceptions`.

`frontend/src/api/client.ts`:
- `RuleConfig`: add `packs_on: string[]`.
- `RulesResponse`: add `packs: string[]`.

(`ProfilePayload = Omit<Profile, 'id' | 'is_standard'>` picks up `packs_on` automatically — `tsc` now flags every PUT sender until Step 4 fixes them.)

- [ ] **Step 3: profile.ts**

```ts
export function effectiveRuleConfig(profile: Profile | null): RuleConfig | null {
  if (!profile) return null
  return {
    categories_off: profile.categories_off,
    exceptions: profile.rule_exceptions,
    packs_on: profile.packs_on,
  }
}

/** Mirrors the backend rule-activation semantics (pack gate, then XOR). */
export function isRuleActive(
  profile: Profile,
  category: Category,
  ruleId: string,
  pack: string | null,
): boolean {
  let base = !profile.categories_off.includes(category)
  if (pack !== null) base = base && profile.packs_on.includes(pack)
  return base !== profile.rule_exceptions.includes(ruleId)
}
```

- [ ] **Step 4: Carry packs_on in every PUT sender**

- `ProfilesView.tsx` `save()`: add `packs_on: merged.packs_on,` to the `updateProfile` body.
- `ProfileSelector.tsx` `saveOverrides()`: add `packs_on: selected.packs_on,`.
- `RulesView.tsx` `saveRuleSelection()`: extend the patch type with `packs_on?: string[]` and the body with `packs_on: patch.packs_on ?? profile.packs_on,`.
- `RulesView.tsx` `RuleCard` call site: change `isRuleActive(profile, group.category, rule.rule_id)` to `isRuleActive(profile, group.category, rule.rule_id, rule.pack)`.
- If `ProfilesView`'s create-profile flow builds a `ProfilePayload`, give it `packs_on: []`.

- [ ] **Step 5: Verify**

Run: `npx vitest run && npm run build`
Expected: tests green, build clean (the build is the real type gate).

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/api/client.ts src/profiles/profile.ts src/profiles/profile.test.ts src/profiles/ProfilesView.tsx src/header/ProfileSelector.tsx src/rules/RulesView.tsx
git commit -m "feat: frontend carries packs_on — types, activation, save payloads"
```

---

### Task 10: Rules view — pack sections + example rendering

**Files:**
- Modify: `frontend/src/rules/catalog.ts`, `frontend/src/rules/RulesView.tsx`
- Modify: `frontend/src/i18n/messages.ts` + all 7 locale files
- Modify: `frontend/src/App.css`
- Test: `frontend/src/rules/catalog.test.ts`

- [ ] **Step 1: Failing test for the pack split**

Append to `frontend/src/rules/catalog.test.ts`:

```ts
describe('splitByPack', () => {
  const rule = (id: string, category: Category, pack: string | null): RuleInfo =>
    ({
      rule_id: id, language: 'en', category, level: 'warning',
      extends: 'existence', message: '', requires_nlp: false, file: '',
      detail: {}, pack, examples: { bad: ['b'], good: ['g'] },
    }) as RuleInfo

  it('separates general rules from pack sections, packs sorted', () => {
    const { general, packs } = splitByPack([
      rule('style.a', 'style', null),
      rule('style.z', 'style', 'techdocs'),
      rule('style.h', 'style', 'marketing'),
      rule('clarity.c', 'clarity', 'marketing'),
    ])
    expect(general.map((g) => g.category)).toEqual(['style'])
    expect(packs.map((p) => p.pack)).toEqual(['marketing', 'techdocs'])
    expect(packs[0].rules.map((r) => r.rule_id)).toEqual(['clarity.c', 'style.h'])
  })
})
```

Run: `npx vitest run src/rules/catalog.test.ts` — FAIL (`splitByPack` missing).

- [ ] **Step 2: Implement `splitByPack` in catalog.ts**

```ts
export interface PackSection {
  pack: string
  rules: RuleInfo[]
}

/** General rules grouped by category; pack rules in one sorted section per pack. */
export function splitByPack(rules: RuleInfo[]): {
  general: RuleGroup[]
  packs: PackSection[]
} {
  const packSlugs = [
    ...new Set(
      rules.map((r) => r.pack).filter((p): p is string => p !== null),
    ),
  ].sort()
  return {
    general: groupRulesByCategory(rules.filter((r) => r.pack === null)),
    packs: packSlugs.map((pack) => ({
      pack,
      rules: rules
        .filter((r) => r.pack === pack)
        .sort((a, b) => a.rule_id.localeCompare(b.rule_id)),
    })),
  }
}
```

- [ ] **Step 3: i18n keys**

`frontend/src/i18n/messages.ts` — add to the `Messages` interface:

```ts
  rulePacks: string
  packName: (slug: string) => string
  packToggleTitle: string
  exampleFlagged: string
  exampleNotFlagged: string
```

Add to each locale (place near the rules-view keys). The `packName` fallback title-cases unknown slugs so user-invented packs display sensibly:

```ts
// en.ts
rulePacks: 'Rule packs',
packName: (slug) =>
  ({ marketing: 'Marketing', techdocs: 'Technical docs', blog: 'Blog' })[slug] ??
  slug.charAt(0).toUpperCase() + slug.slice(1).replace(/-/g, ' '),
packToggleTitle: 'Enable or disable this pack for the selected profile',
exampleFlagged: 'Flags',
exampleNotFlagged: "Doesn't flag",
```

```ts
// de.ts
rulePacks: 'Regelpakete',
packName: (slug) =>
  ({ marketing: 'Marketing', techdocs: 'Technische Doku', blog: 'Blog' })[slug] ??
  slug.charAt(0).toUpperCase() + slug.slice(1).replace(/-/g, ' '),
packToggleTitle: 'Dieses Paket für das gewählte Profil aktivieren oder deaktivieren',
exampleFlagged: 'Meldet',
exampleNotFlagged: 'Meldet nicht',
```

```ts
// fr.ts
rulePacks: 'Packs de règles',
packName: (slug) =>
  ({ marketing: 'Marketing', techdocs: 'Doc technique', blog: 'Blog' })[slug] ??
  slug.charAt(0).toUpperCase() + slug.slice(1).replace(/-/g, ' '),
packToggleTitle: 'Activer ou désactiver ce pack pour le profil sélectionné',
exampleFlagged: 'Signale',
exampleNotFlagged: 'Ne signale pas',
```

```ts
// es.ts
rulePacks: 'Paquetes de reglas',
packName: (slug) =>
  ({ marketing: 'Marketing', techdocs: 'Doc. técnica', blog: 'Blog' })[slug] ??
  slug.charAt(0).toUpperCase() + slug.slice(1).replace(/-/g, ' '),
packToggleTitle: 'Activar o desactivar este paquete para el perfil seleccionado',
exampleFlagged: 'Señala',
exampleNotFlagged: 'No señala',
```

```ts
// it.ts
rulePacks: 'Pacchetti di regole',
packName: (slug) =>
  ({ marketing: 'Marketing', techdocs: 'Doc. tecnica', blog: 'Blog' })[slug] ??
  slug.charAt(0).toUpperCase() + slug.slice(1).replace(/-/g, ' '),
packToggleTitle: 'Attiva o disattiva questo pacchetto per il profilo selezionato',
exampleFlagged: 'Segnala',
exampleNotFlagged: 'Non segnala',
```

```ts
// ja.ts
rulePacks: 'ルールパック',
packName: (slug) =>
  ({ marketing: 'マーケティング', techdocs: '技術文書', blog: 'ブログ' })[slug] ??
  slug.charAt(0).toUpperCase() + slug.slice(1).replace(/-/g, ' '),
packToggleTitle: 'このパックを選択中のプロファイルで有効/無効にします',
exampleFlagged: '検出する',
exampleNotFlagged: '検出しない',
```

```ts
// zh.ts
rulePacks: '规则包',
packName: (slug) =>
  ({ marketing: '营销', techdocs: '技术文档', blog: '博客' })[slug] ??
  slug.charAt(0).toUpperCase() + slug.slice(1).replace(/-/g, ' '),
packToggleTitle: '为所选配置启用或禁用此规则包',
exampleFlagged: '会标记',
exampleNotFlagged: '不标记',
```

- [ ] **Step 4: RulesView — pack sections and pack toggle**

In `RulesView.tsx`, replace the single `groupRulesByCategory(response.rules).map(...)` block: compute `const split = response ? splitByPack(response.rules) : null`, render `split.general` exactly the way the category groups render today, then after it:

```tsx
      {split &&
        split.packs.map((section) => (
          <section key={section.pack} className="rules-group rules-pack">
            <h3>
              <input
                type="checkbox"
                title={m.packToggleTitle}
                checked={profile?.packs_on.includes(section.pack) ?? false}
                disabled={!profile}
                onChange={() => togglePack(section.pack, section.rules)}
              />
              {m.packName(section.pack)}
              <span className="rule-badge pack">{m.rulePacks}</span>
            </h3>
            {section.rules.map((rule) => (
              <RuleCard
                key={rule.rule_id}
                rule={rule}
                active={
                  profile
                    ? isRuleActive(profile, rule.category, rule.rule_id, rule.pack)
                    : false
                }
                onToggle={() => toggleRule(rule.rule_id)}
                canToggle={profile !== null}
              />
            ))}
          </section>
        ))}
```

Add `togglePack` beside `toggleCategory` (same fresh-start semantics — toggling clears the pack's exceptions):

```tsx
  function togglePack(pack: string, rulesInPack: RuleInfo[]) {
    if (!profile) return
    const on = profile.packs_on.includes(pack)
    void saveRuleSelection({
      packs_on: on
        ? profile.packs_on.filter((p) => p !== pack)
        : [...profile.packs_on, pack],
      rule_exceptions: profile.rule_exceptions.filter(
        (id) => !rulesInPack.some((r) => r.rule_id === id),
      ),
    })
  }
```

- [ ] **Step 5: RuleCard — render examples**

In `RuleCard`, after the `rule-detail` paragraph:

```tsx
      <div className="rule-examples">
        {rule.examples.bad.map((sentence) => (
          <p key={sentence} className="rule-example bad">
            <span className="rule-example-mark">✗ {m.exampleFlagged}</span>
            {sentence}
          </p>
        ))}
        {rule.examples.good.map((sentence) => (
          <p key={sentence} className="rule-example good">
            <span className="rule-example-mark">✓ {m.exampleNotFlagged}</span>
            {sentence}
          </p>
        ))}
      </div>
```

- [ ] **Step 6: CSS** — append to `frontend/src/App.css` in the rules-view section:

```css
/* ---- rule examples + pack sections ---- */

.rule-examples {
  margin: 0.35rem 0 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.rule-example {
  margin: 0;
  font-size: 0.8rem;
  color: var(--text-dim);
}

.rule-example-mark {
  display: inline-block;
  min-width: 7.5rem;
  margin-right: 0.5rem;
  font-size: 0.7rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.rule-example.bad .rule-example-mark { color: #e5484d; }
.rule-example.good .rule-example-mark { color: #2a9d63; }

.rule-badge.pack {
  background: var(--accent-soft);
}
```

(Match the existing `.rule-badge` variants for exact colors if these variables differ.)

- [ ] **Step 7: Verify + commit**

Run: `npx vitest run && npm run build`

```bash
git add src/rules/ src/i18n/ src/App.css
git commit -m "feat: rules view — pack sections with toggles, example sentences on rule cards"
```

---

### Task 11: Profile card — rule-pack chips

**Files:**
- Modify: `frontend/src/profiles/ProfilesView.tsx`
- Modify: `frontend/src/App.css`

- [ ] **Step 1: Fetch the discovered packs**

In `ProfilesView` (top-level component), add alongside its existing state:

```tsx
  const [packs, setPacks] = useState<string[]>([])

  useEffect(() => {
    getRules(language)
      .then((response) => setPacks(response.packs))
      .catch(() => setPacks([]))
  }, [language])
```

(`getRules` is already exported from `../api/client`; `language` is the view's current language. Pass `packs` down to the profile card component as a prop.)

- [ ] **Step 2: Chip row in the card**

In the profile card, after the LLM block (`.profile-card-llm`), add:

```tsx
        {packs.length > 0 && (
          <div className="profile-card-packs">
            <span className="field-label">{m.rulePacks}</span>
            <div className="tier-options">
              {packs.map((pack) => {
                const on = profile.packs_on.includes(pack)
                return (
                  <button
                    key={pack}
                    className={`tier-option${on ? ' selected' : ''}`}
                    aria-pressed={on}
                    onClick={() =>
                      onSave({
                        packs_on: on
                          ? profile.packs_on.filter((p) => p !== pack)
                          : [...profile.packs_on, pack],
                      })
                    }
                  >
                    {m.packName(pack)}
                  </button>
                )
              })}
            </div>
          </div>
        )}
```

(The chips reuse the `.tier-option` styling; `aria-pressed` marks them as multi-select toggles rather than radio options.)

- [ ] **Step 3: CSS** — append:

```css
.profile-card-packs {
  margin-top: 0.5rem;
}

.profile-card-packs .field-label {
  display: block;
  margin-bottom: 4px;
}
```

- [ ] **Step 4: Verify end-to-end + commit**

Run: `npx vitest run && npm run build`. Then with backend + frontend running, spot-check in the browser: toggle the marketing pack on the EN Marketing profile, run a check on its example text, confirm hype-word findings appear; open Rules view, confirm pack sections and examples render, pack toggle syncs with the chips.

```bash
git add src/profiles/ProfilesView.tsx src/App.css
git commit -m "feat: profile card — rule-pack chips"
```

---

### Task 12: Documentation, spec notes, screenshots

**Files:**
- Modify: `backend/rules/README.md`, `docs/backend-architecture.md`, `docs/frontend-architecture.md`, `README.md`
- Modify: `docs/superpowers/specs/2026-07-07-rule-packs-en-de-design.md` (implementation notes)
- Modify: `docs/LOGBOOK.md`, `docs/images/*.png`

- [ ] **Step 1: `backend/rules/README.md`** — update the intro (examples are mandatory and double as tests; `pack:` marks use-case rules, off unless the profile enables the pack) and add the 35 new rules to the EN/DE tables with a Pack column (`—` for general). Keep the *Demonstrates* column filled for every NLP rule (the comment headers in the YAML files are the source).

- [ ] **Step 2: Architecture docs** —
  - `docs/backend-architecture.md`: pack activation semantics (the truth table in one sentence: pack gate ANDs into the category toggle, XOR exceptions unchanged; `engine.check` without config now runs general rules only), mandatory examples + `test_rule_examples.py`, greedy LONGEST token matching, `packs_on` profile column with migration.
  - `docs/frontend-architecture.md`: `packs_on` in RuleConfig/save payloads, pack sections + example rendering in the rules view, pack chips in the profile card, `packName` fallback for unknown slugs.

- [ ] **Step 3: Main `README.md`** — feature list & profiles section: rule packs (marketing / technical docs / blog, extensible by dropping YAML files), self-documenting rule examples shown in the Rules view.

- [ ] **Step 4: Spec implementation notes** — append an "Implementation notes" section to the spec recording deviations: (a) das-dass uses a complement-verb list before the comma plus PRON after „das" (higher precision than the sketched pronoun-only pattern); (b) seit-seid narrowed to the question form as an existence/raw rule; (c) `packs_on` is its own profiles column (the rule config was never a single JSON column); (d) the packs index is a flat sorted list per (language-filtered) response, not a dict; (e) `engine.check` with `config=None` now means "general rules only"; (f) token_pattern matching switched to greedy LONGEST; (g) superlativ-inflation uses raw stems because `\b`-wrapped tokens miss German inflection.

- [ ] **Step 5: Logbook + screenshots** — append the work summary with commit pointers to `docs/LOGBOOK.md`. Regenerate README screenshots (`npm run screenshots` from `frontend/`, needs backend :8000 + frontend :5173 running with the seeded data) — `rules.png` must show a rule card with examples and a pack section; `profiles.png` the pack chips. If the servers aren't running, note it and leave the screenshots for a follow-up.

- [ ] **Step 6: Final verification + commit**

Run: `cd backend && uv run pytest -q` and `cd frontend && npx vitest run && npm run build && npm run lint`.

```bash
git add backend/rules/README.md docs/ README.md
git commit -m "docs: rule packs + self-documenting examples — catalogs, architecture, spec notes"
```

---

## Self-review notes

- Spec §1 (pack field, truth table) → Task 1; examples block → Tasks 2–3; §2 API → Tasks 4–5; §3 frontend → Tasks 9–11; §4 seeding → Task 6; §5/§6 rosters → Tasks 7–8 (every roster rule has a file; latin-abbreviations is existence/raw per the spec's own correction); §7 testing → Tasks 1–3 (truth table, loader errors, catalog test), 4–6 (API), 9–10 (frontend); §8 docs → Task 12.
- Known judgment points for the implementer: `%2$s` positional message support (check `format_message` first — fallback messages provided); exact fixture names in `test_rules_api.py` / `test_profiles_api.py` / `test_check_api.py` / `test_seed.py` (adapt names, keep assertions); NLP example sentences may need parse-driven tweaks (procedure given in Tasks 7–8).
