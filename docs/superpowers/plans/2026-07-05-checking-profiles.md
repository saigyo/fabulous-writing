# Checking Profiles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Language-specific checking profiles bundling rule selection, terminology domains, LLM provider/model, extra LLM instructions, and an example text — with a seeded Standard (+ demo Marketing / Technical Documentation) profile per language, header selection with ephemeral overrides, a Profiles view, and rule editing on the rules page.

**Architecture:** Profiles live in the existing SQLite DB beside `domains`/`terms` (`ProfileStore`, seeded at startup; example seeding tracked in a marker table). The check API stays profile-agnostic: the frontend resolves the selected profile + header overrides into explicit request fields (`domain_ids`, `rule_config`, `llm_instructions`). The header dirty marker is computed (profile vs. header state), never stored.

**Tech Stack:** FastAPI + pydantic + sqlite3 (backend), React + zustand + vitest (frontend), pytest, Playwright for end-to-end verification.

**Conventions:** This repo commits directly on `main` (explicitly agreed with Markus — no feature branch). Spec: `docs/superpowers/specs/2026-07-05-checking-profiles-design.md`. Backend tests: `cd backend && uv run pytest`. Frontend tests: `cd frontend && npx vitest run`. Commit messages end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

**One deliberate deviation from the spec:** profiles store a **concrete** `llm_provider` captured at seed/creation time instead of `NULL = config default` (the providers API exposes no "default provider" flag, and a concrete value removes all null-resolution logic from the dirty computation). `llm_model` stays nullable (`NULL` = provider's default model, which the frontend already resolves via `effectiveModel`). The spec has been amended accordingly.

---

## File map

**Backend — create:**
- `backend/app/services/profiles.py` — `Profile` model + `ProfileStore` (schema, CRUD, domain pruning)
- `backend/app/services/seed_profiles.py` — Standard + example seeding, factory defaults, marker table use
- `backend/app/api/profiles.py` — CRUD router
- `backend/demos/en-marketing.txt`, `en-technical-documentation.txt`, `de-marketing.txt`, `de-technical-documentation.txt`, `ja-marketing.txt`, `ja-technical-documentation.txt` — example-profile seed texts
- `backend/tests/test_profiles.py`, `backend/tests/test_profiles_api.py`

**Backend — modify:**
- `backend/app/core/config.py` — `seed_example_profiles: bool = True`
- `backend/app/main.py` — ProfileStore on `app.state`, seeding call, router
- `backend/app/api/terminology.py` — domain delete prunes profiles
- `backend/app/checkers/rules/engine.py` — `RuleConfig` + filtered `check()`
- `backend/app/checkers/llm/prompts.py` — `build_prompt(..., instructions)`, suggestion/rewrite prompt instructions
- `backend/app/checkers/llm/checker.py` — pass instructions through
- `backend/app/api/checks.py` — `domain_ids`, `rule_config`, `llm_instructions`
- `backend/app/api/suggestions.py` — `llm_instructions` on both request models
- `backend/app/api/languages.py` — remove the demo endpoint
- `backend/tests/test_languages_api.py`, `backend/tests/test_check_api.py`, `backend/tests/test_rule_engine.py` — adapt/extend

**Frontend — create:**
- `frontend/src/profiles/profile.ts` — `applyProfileToHeader`, `isProfileDirty`, `effectiveRuleConfig` (pure helpers)
- `frontend/src/profiles/profile.test.ts`
- `frontend/src/profiles/ProfilesView.tsx` — management view
- `frontend/src/header/DomainMultiSelect.tsx` — checkbox dropdown
- `frontend/src/header/ProfileSelector.tsx` — selector + dirty marker + save/reset

**Frontend — modify:**
- `frontend/src/types.ts` — `Profile` type
- `frontend/src/api/client.ts` — profile CRUD, new check fields, drop `getDemoText`
- `frontend/src/state/store.ts` — `domainIds`, `profiles`, `profileId`, `lastProfileByLanguage`
- `frontend/src/App.tsx` — header wiring, LoadExampleButton, Profiles tab
- `frontend/src/checking/controller.ts`, `frontend/src/checking/suggest.ts` — new request fields
- `frontend/src/rules/RulesView.tsx` — per-profile toggles (write-through)
- `frontend/src/i18n/messages.ts` + all 7 catalogs + `frontend/src/i18n/i18n.test.ts`
- `frontend/src/App.css`

---

### Task 1: Example-profile demo seed files

Pure data. Each text is short, plants defects matching its profile, and reuses defect patterns the language's rules catch (see `backend/tests/test_demo_texts.py` for the spirit).

**Files:**
- Create: `backend/demos/en-marketing.txt`, `backend/demos/en-technical-documentation.txt`, `backend/demos/de-marketing.txt`, `backend/demos/de-technical-documentation.txt`, `backend/demos/ja-marketing.txt`, `backend/demos/ja-technical-documentation.txt`

- [ ] **Step 1: Create the six files with exactly this content**

`backend/demos/en-marketing.txt`:
```
Introducing SuperWidget — quite possibly the best productivity tool ever made!! It is very fast, extremely powerful, and somewhat magical. At the end of the day, our game-changing solution was built by a team that thinks outside the box. There are many reasons to utilize SuperWidget in order to supercharge your workflow. Simply login today and and see the difference.
```

`backend/demos/en-technical-documentation.txt`:
```
The configuration file is read by the application when it is started by the user. In order to make a modification of the settings, the utilization of the admin panel is recommended. It should be noted that the the server must be restarted. To quickly enable the feature, the flag can be set by the operator, which is very easy. There are many settings which are extremely flexible, and due to the fact that the defaults are fairly sensible, tuning them is rarely needed. Login credentials are stored somewhere in the config.
```

`backend/demos/de-marketing.txt`:
```
Das neue SuperWidget ist wirklich sehr innovativ und eigentlich ziemlich revolutionär!! Es ist quasi das beste Tool überhaupt, mit dem Sie Ihren Workflow einfach mal eben supercharen können. Downloaden Sie es noch heute und und erleben Sie den Unterschied, der von unserem Team mit viel Liebe entwickelt wurde.
```

`backend/demos/de-technical-documentation.txt`:
```
Die Konfigurationsdatei wird beim Start von der Anwendung eingelesen, wobei die Einstellungen eigentlich ziemlich einfach über das Admin-Panel geändert werden können, was allerdings erst nach einem Neustart des Servers, der von dem Administrator durchgeführt werden muss, wirksam wird. Das Feature kann quasi einfach aktiviert werden. Die Credentials werden irgendwo in der der Config gespeichert.
```

`backend/demos/ja-marketing.txt`:
```
新しいSuperWidgetは、とてもすごくて、かなり画期的で、たぶん史上最高のツールです!!今すぐダウンロードして、あなたのワークフローをすごく効率化しましょう。私たちのチームが心を込めて開発した、その違いをぜひぜひ体験してください。
```

`backend/demos/ja-technical-documentation.txt`:
```
設定ファイルはアプリケーションの起動時に読み込まれます。設定の変更は管理パネルから行うことが推奨されますが、変更はサーバーが再起動されることによって反映されます。この機能はたぶん簡単に有効化できます。認証情報は設定のどこかにに保存されます。
```

- [ ] **Step 2: Sanity-check the EN texts fire rules** (the DE/JA texts are exercised by the seeding tests later)

Run: `cd backend && uv run python -c "
from pathlib import Path
from app.checkers.rules.engine import RuleEngine
from app.core.models import Language
e = RuleEngine(Path('rules'))
for f in ['en-marketing.txt', 'en-technical-documentation.txt']:
    found = e.check(Path('demos', f).read_text(), Language.EN)
    print(f, len(found))
    assert len(found) >= 5, f
"`
Expected: both files print a count ≥ 5.

- [ ] **Step 3: Commit**

```bash
git add backend/demos && git commit -m "feat: demo seed texts for example checking profiles

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: ProfileStore — schema, model, CRUD

**Files:**
- Create: `backend/app/services/profiles.py`
- Test: `backend/tests/test_profiles.py`

- [ ] **Step 1: Write the failing tests**

`backend/tests/test_profiles.py`:
```python
import pytest

from app.core.models import Language
from app.services.profiles import ProfileStore


@pytest.fixture()
def store(tmp_path):
    return ProfileStore(tmp_path / "test.db")


def test_create_and_list_profiles(store):
    p = store.create_profile(
        Language.DE,
        "Marketing",
        categories_off=["correctness"],
        rule_exceptions=["style.weasel-words"],
        domain_ids=[1, 4],
        llm_provider="ollama",
        llm_model=None,
        llm_instructions="Zielgruppe: Kunden.",
        example_text="Beispieltext.",
    )
    assert p.id > 0 and p.name == "Marketing" and not p.is_standard
    listed = store.list_profiles(Language.DE)
    assert [x.name for x in listed] == ["Marketing"]
    assert listed[0].rule_exceptions == ["style.weasel-words"]
    assert store.list_profiles(Language.EN) == []


def test_duplicate_name_raises(store):
    store.create_profile(Language.EN, "Blog", llm_provider="ollama")
    with pytest.raises(ValueError, match="exists"):
        store.create_profile(Language.EN, "Blog", llm_provider="ollama")


def test_update_profile(store):
    p = store.create_profile(Language.EN, "Blog", llm_provider="ollama")
    updated = store.update_profile(p.id, name="Blog posts", domain_ids=[2])
    assert updated.name == "Blog posts" and updated.domain_ids == [2]
    assert store.get_profile(p.id).domain_ids == [2]
    assert store.update_profile(9999, name="x") is None


def test_delete_profile(store):
    p = store.create_profile(Language.EN, "Blog", llm_provider="ollama")
    assert store.delete_profile(p.id) is True
    assert store.delete_profile(p.id) is False
    assert store.list_profiles(Language.EN) == []


def test_remove_domain_everywhere(store):
    a = store.create_profile(Language.EN, "A", domain_ids=[1, 2], llm_provider="ollama")
    b = store.create_profile(Language.DE, "B", domain_ids=[2, 3], llm_provider="ollama")
    store.remove_domain_everywhere(2)
    assert store.get_profile(a.id).domain_ids == [1]
    assert store.get_profile(b.id).domain_ids == [3]
```

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && uv run pytest tests/test_profiles.py -q`
Expected: FAIL — `ModuleNotFoundError`/`ImportError` for `app.services.profiles`.

- [ ] **Step 3: Implement `backend/app/services/profiles.py`**

```python
import json
import sqlite3
from pathlib import Path

from pydantic import BaseModel, Field

from app.core.models import Language

_SCHEMA = """
CREATE TABLE IF NOT EXISTS profiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    language TEXT NOT NULL,
    name TEXT NOT NULL,
    is_standard INTEGER NOT NULL DEFAULT 0,
    categories_off TEXT NOT NULL DEFAULT '[]',
    rule_exceptions TEXT NOT NULL DEFAULT '[]',
    domain_ids TEXT NOT NULL DEFAULT '[]',
    llm_provider TEXT,
    llm_model TEXT,
    llm_instructions TEXT NOT NULL DEFAULT '',
    example_text TEXT NOT NULL DEFAULT '',
    UNIQUE(language, name)
);
CREATE TABLE IF NOT EXISTS profile_seed_markers (
    language TEXT PRIMARY KEY
);
"""


class Profile(BaseModel):
    id: int
    language: Language
    name: str
    is_standard: bool = False
    categories_off: list[str] = Field(default_factory=list)
    rule_exceptions: list[str] = Field(default_factory=list)
    domain_ids: list[int] = Field(default_factory=list)
    llm_provider: str | None = None
    llm_model: str | None = None
    llm_instructions: str = ""
    example_text: str = ""


def _row_to_profile(row: sqlite3.Row) -> Profile:
    return Profile(
        id=row["id"],
        language=Language(row["language"]),
        name=row["name"],
        is_standard=bool(row["is_standard"]),
        categories_off=json.loads(row["categories_off"]),
        rule_exceptions=json.loads(row["rule_exceptions"]),
        domain_ids=json.loads(row["domain_ids"]),
        llm_provider=row["llm_provider"],
        llm_model=row["llm_model"],
        llm_instructions=row["llm_instructions"],
        example_text=row["example_text"],
    )


class ProfileStore:
    """Checking profiles, stored beside domains/terms in the same SQLite DB."""

    def __init__(self, db_path: Path) -> None:
        self.db_path = db_path
        db_path.parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as conn:
            conn.executescript(_SCHEMA)

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        return conn

    def list_profiles(self, language: Language) -> list[Profile]:
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT * FROM profiles WHERE language = ?"
                " ORDER BY is_standard DESC, name",
                (language.value,),
            ).fetchall()
        return [_row_to_profile(row) for row in rows]

    def get_profile(self, profile_id: int) -> Profile | None:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM profiles WHERE id = ?", (profile_id,)
            ).fetchone()
        return _row_to_profile(row) if row else None

    def create_profile(
        self,
        language: Language,
        name: str,
        *,
        is_standard: bool = False,
        categories_off: list[str] | None = None,
        rule_exceptions: list[str] | None = None,
        domain_ids: list[int] | None = None,
        llm_provider: str | None = None,
        llm_model: str | None = None,
        llm_instructions: str = "",
        example_text: str = "",
    ) -> Profile:
        try:
            with self._connect() as conn:
                cursor = conn.execute(
                    """INSERT INTO profiles
                       (language, name, is_standard, categories_off, rule_exceptions,
                        domain_ids, llm_provider, llm_model, llm_instructions, example_text)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (
                        language.value,
                        name,
                        int(is_standard),
                        json.dumps(categories_off or []),
                        json.dumps(rule_exceptions or []),
                        json.dumps(domain_ids or []),
                        llm_provider,
                        llm_model,
                        llm_instructions,
                        example_text,
                    ),
                )
                profile_id = cursor.lastrowid
        except sqlite3.IntegrityError as exc:
            raise ValueError(f"Profile '{name}' already exists for {language.value}") from exc
        assert profile_id is not None
        profile = self.get_profile(profile_id)
        assert profile is not None
        return profile

    _UPDATABLE = (
        "name",
        "categories_off",
        "rule_exceptions",
        "domain_ids",
        "llm_provider",
        "llm_model",
        "llm_instructions",
        "example_text",
    )

    def update_profile(self, profile_id: int, **fields: object) -> Profile | None:
        current = self.get_profile(profile_id)
        if current is None:
            return None
        unknown = set(fields) - set(self._UPDATABLE)
        assert not unknown, f"not updatable: {unknown}"
        merged = current.model_copy(update=fields)
        try:
            with self._connect() as conn:
                conn.execute(
                    """UPDATE profiles SET name = ?, categories_off = ?,
                       rule_exceptions = ?, domain_ids = ?, llm_provider = ?,
                       llm_model = ?, llm_instructions = ?, example_text = ?
                       WHERE id = ?""",
                    (
                        merged.name,
                        json.dumps(merged.categories_off),
                        json.dumps(merged.rule_exceptions),
                        json.dumps(merged.domain_ids),
                        merged.llm_provider,
                        merged.llm_model,
                        merged.llm_instructions,
                        merged.example_text,
                        profile_id,
                    ),
                )
        except sqlite3.IntegrityError as exc:
            raise ValueError(
                f"Profile '{merged.name}' already exists for {merged.language.value}"
            ) from exc
        return merged

    def delete_profile(self, profile_id: int) -> bool:
        with self._connect() as conn:
            cursor = conn.execute("DELETE FROM profiles WHERE id = ?", (profile_id,))
        return cursor.rowcount > 0

    def remove_domain_everywhere(self, domain_id: int) -> None:
        """Drop a deleted terminology domain from every profile."""
        with self._connect() as conn:
            rows = conn.execute("SELECT id, domain_ids FROM profiles").fetchall()
            for row in rows:
                ids = json.loads(row["domain_ids"])
                if domain_id in ids:
                    conn.execute(
                        "UPDATE profiles SET domain_ids = ? WHERE id = ?",
                        (json.dumps([d for d in ids if d != domain_id]), row["id"]),
                    )

    # -- seed markers ------------------------------------------------------

    def is_example_seeded(self, language: Language) -> bool:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT 1 FROM profile_seed_markers WHERE language = ?",
                (language.value,),
            ).fetchone()
        return row is not None

    def mark_example_seeded(self, language: Language) -> None:
        with self._connect() as conn:
            conn.execute(
                "INSERT OR IGNORE INTO profile_seed_markers (language) VALUES (?)",
                (language.value,),
            )

    def standard_profile(self, language: Language) -> Profile | None:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM profiles WHERE language = ? AND is_standard = 1",
                (language.value,),
            ).fetchone()
        return _row_to_profile(row) if row else None
```

- [ ] **Step 4: Run to verify pass**

Run: `cd backend && uv run pytest tests/test_profiles.py -q`
Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add backend/app/services/profiles.py backend/tests/test_profiles.py
git commit -m "feat: ProfileStore with CRUD and domain pruning

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Profile seeding (Standard + examples + markers + config switch)

**Files:**
- Create: `backend/app/services/seed_profiles.py`
- Modify: `backend/app/core/config.py` (add one field to `Settings`)
- Test: extend `backend/tests/test_profiles.py`

- [ ] **Step 1: Add the failing tests to `backend/tests/test_profiles.py`**

Append:
```python
from app.core.models import Language as L  # noqa: E402
from app.services.seed_profiles import (  # noqa: E402
    EXAMPLE_LANGUAGES,
    seed_profiles,
    standard_defaults,
)

DEMOS = __import__("pathlib").Path(__file__).parent.parent / "demos"


def test_seed_creates_standard_for_every_language(store):
    seed_profiles(store, DEMOS, default_provider="ollama", seed_examples=False)
    for lang in Language:
        std = store.standard_profile(lang)
        assert std is not None and std.name == "Standard"
        assert std.llm_provider == "ollama" and std.llm_model is None
        assert std.categories_off == [] and std.rule_exceptions == []
        assert std.example_text == (DEMOS / f"{lang.value}.txt").read_text(
            encoding="utf-8"
        )


def test_seed_is_idempotent(store):
    seed_profiles(store, DEMOS, default_provider="ollama", seed_examples=True)
    seed_profiles(store, DEMOS, default_provider="ollama", seed_examples=True)
    for lang in Language:
        names = [p.name for p in store.list_profiles(lang)]
        assert names.count("Standard") == 1
        if lang in EXAMPLE_LANGUAGES:
            assert names.count("Marketing") == 1
            assert names.count("Technical Documentation") == 1


def test_example_seeding_and_deletion_sticks(store):
    seed_profiles(store, DEMOS, default_provider="ollama", seed_examples=True)
    marketing = [
        p for p in store.list_profiles(L.EN) if p.name == "Marketing"
    ][0]
    assert not marketing.is_standard
    assert "customer" in marketing.llm_instructions.lower()
    assert marketing.example_text.startswith("Introducing SuperWidget")
    store.delete_profile(marketing.id)
    seed_profiles(store, DEMOS, default_provider="ollama", seed_examples=True)
    assert "Marketing" not in [p.name for p in store.list_profiles(L.EN)]


def test_seed_examples_off(store):
    seed_profiles(store, DEMOS, default_provider="ollama", seed_examples=False)
    assert [p.name for p in store.list_profiles(L.EN)] == ["Standard"]
    # Turning the switch on later seeds the not-yet-marked languages.
    seed_profiles(store, DEMOS, default_provider="ollama", seed_examples=True)
    assert "Marketing" in [p.name for p in store.list_profiles(L.EN)]


def test_standard_defaults_reads_demo(store):
    defaults = standard_defaults(L.EN, DEMOS, default_provider="claude")
    assert defaults["llm_provider"] == "claude"
    assert defaults["example_text"].startswith("At the end of the day")
```

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && uv run pytest tests/test_profiles.py -q`
Expected: FAIL — cannot import `app.services.seed_profiles`.

- [ ] **Step 3: Implement `backend/app/services/seed_profiles.py`**

```python
"""Seed checking profiles: a Standard profile per language, plus deletable
Marketing / Technical Documentation examples for EN, DE, JA (tracked in a
marker table so deletions stick across restarts)."""

from pathlib import Path

from app.core.models import Language
from app.services.profiles import ProfileStore

EXAMPLE_LANGUAGES = {Language.EN, Language.DE, Language.JA}

_MARKETING_INSTRUCTIONS = {
    Language.EN: (
        "Audience: prospective customers. Favor energetic, benefit-led, concrete "
        "phrasing; short sentences; active voice. Flag jargon, hedging, and vague "
        "claims that are not backed by specifics."
    ),
    Language.DE: (
        "Zielgruppe: potenzielle Kundinnen und Kunden. Bevorzuge energische, "
        "nutzenorientierte, konkrete Formulierungen; kurze Sätze; Aktiv statt "
        "Passiv. Markiere Fachjargon, vage Behauptungen und Abschwächungen."
    ),
    Language.JA: (
        "対象読者:見込み顧客。エネルギッシュで、利点を先に示す具体的な表現を優先。"
        "短い文、能動態を推奨。専門用語、曖昧な主張、根拠のない誇張を指摘すること。"
    ),
}

_TECHDOC_INSTRUCTIONS = {
    Language.EN: (
        "Audience: users following instructions. Prioritize precision, consistent "
        "terminology, and unambiguous phrasing; prefer imperative mood for steps; "
        "flag marketing language and vague quantifiers."
    ),
    Language.DE: (
        "Zielgruppe: Nutzerinnen und Nutzer, die Anleitungen folgen. Präzision, "
        "konsistente Terminologie und eindeutige Formulierungen haben Vorrang; "
        "für Schritte Imperativ bevorzugen; Marketingsprache und vage "
        "Mengenangaben markieren."
    ),
    Language.JA: (
        "対象読者:手順に従う利用者。正確さ、一貫した用語、曖昧さのない表現を最優先。"
        "手順は命令形を推奨。マーケティング的な表現や曖昧な数量表現を指摘すること。"
    ),
}


def _demo(demos_dir: Path, filename: str) -> str:
    path = demos_dir / filename
    return path.read_text(encoding="utf-8") if path.is_file() else ""


def standard_defaults(
    language: Language, demos_dir: Path, default_provider: str
) -> dict:
    """Factory defaults for a language's Standard profile (also used by reset)."""
    return {
        "categories_off": [],
        "rule_exceptions": [],
        "domain_ids": [],
        "llm_provider": default_provider,
        "llm_model": None,
        "llm_instructions": "",
        "example_text": _demo(demos_dir, f"{language.value}.txt"),
    }


def _create_ignoring_collision(
    store: ProfileStore, language: Language, name: str, **fields: object
) -> None:
    """A pre-existing profile occupying a seeded name wins; seeding skips it."""
    try:
        store.create_profile(language, name, **fields)
    except ValueError:
        pass


def seed_profiles(
    store: ProfileStore,
    demos_dir: Path,
    *,
    default_provider: str,
    seed_examples: bool,
) -> None:
    for language in Language:
        if store.standard_profile(language) is None:
            _create_ignoring_collision(
                store,
                language,
                "Standard",
                is_standard=True,
                **standard_defaults(language, demos_dir, default_provider),
            )
        if (
            seed_examples
            and language in EXAMPLE_LANGUAGES
            and not store.is_example_seeded(language)
        ):
            _create_ignoring_collision(
                store,
                language,
                "Marketing",
                llm_provider=default_provider,
                llm_instructions=_MARKETING_INSTRUCTIONS[language],
                example_text=_demo(demos_dir, f"{language.value}-marketing.txt"),
            )
            _create_ignoring_collision(
                store,
                language,
                "Technical Documentation",
                categories_off=["vividness"],
                llm_provider=default_provider,
                llm_instructions=_TECHDOC_INSTRUCTIONS[language],
                example_text=_demo(
                    demos_dir, f"{language.value}-technical-documentation.txt"
                ),
            )
            # Marker is set even when an insert was skipped: a collision must
            # not cause an endless retry (and re-collision) on every startup.
            store.mark_example_seeded(language)
```

Also add two collision tests (`test_seed_survives_name_collisions`,
`test_seed_survives_user_profile_named_standard`): pre-create a profile named
"Technical Documentation" (resp. "Standard") and assert seeding neither
crashes nor duplicates, sets the marker, and stays quiet on the next run.

- [ ] **Step 4: Add the config switch in `backend/app/core/config.py`**

In `class Settings`, directly below `seed_terminology: bool = True`:
```python
    # Seed Marketing / Technical Documentation example profiles (EN, DE, JA)
    # the first time profiles are seeded for a language.
    seed_example_profiles: bool = True
```

- [ ] **Step 5: Run to verify pass**

Run: `cd backend && uv run pytest tests/test_profiles.py tests/test_config.py -q`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add backend/app/services/seed_profiles.py backend/app/core/config.py backend/tests/test_profiles.py
git commit -m "feat: seed Standard and example checking profiles

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Profiles CRUD API + app wiring + domain-deletion pruning

**Files:**
- Create: `backend/app/api/profiles.py`
- Modify: `backend/app/main.py`, `backend/app/api/terminology.py`
- Test: `backend/tests/test_profiles_api.py`

- [ ] **Step 1: Write the failing tests**

`backend/tests/test_profiles_api.py`:
```python
import pytest
from fastapi.testclient import TestClient

from app.core.config import Settings
from app.main import create_app


@pytest.fixture()
def client(tmp_path):
    settings = Settings(db_path=tmp_path / "test.db", seed_terminology=False)
    return TestClient(create_app(settings))


def _standard(client, language="en"):
    profiles = client.get(f"/api/profiles?language={language}").json()
    return next(p for p in profiles if p["is_standard"])


def test_list_profiles_contains_seeded(client):
    profiles = client.get("/api/profiles?language=de").json()
    names = [p["name"] for p in profiles]
    assert "Standard" in names and "Marketing" in names


def test_create_update_delete_profile(client):
    created = client.post(
        "/api/profiles",
        json={"language": "en", "name": "Blog", "llm_provider": "ollama"},
    )
    assert created.status_code == 201
    pid = created.json()["id"]

    updated = client.put(
        f"/api/profiles/{pid}",
        json={"name": "Blog posts", "categories_off": ["vividness"],
              "rule_exceptions": [], "domain_ids": [], "llm_provider": "ollama",
              "llm_model": None, "llm_instructions": "Casual tone.",
              "example_text": "Sample."},
    )
    assert updated.status_code == 200
    assert updated.json()["name"] == "Blog posts"

    assert client.delete(f"/api/profiles/{pid}").status_code == 204
    assert client.delete(f"/api/profiles/{pid}").status_code == 404


def test_duplicate_name_conflict(client):
    body = {"language": "en", "name": "Standard", "llm_provider": "ollama"}
    assert client.post("/api/profiles", json=body).status_code == 409


def test_standard_guards(client):
    std = _standard(client)
    assert client.delete(f"/api/profiles/{std['id']}").status_code == 409
    renamed = dict(std, name="Renamed")
    renamed.pop("id"), renamed.pop("is_standard"), renamed.pop("language")
    assert client.put(f"/api/profiles/{std['id']}", json=renamed).status_code == 409


def test_reset_standard(client):
    std = _standard(client)
    body = {k: v for k, v in std.items()
            if k not in ("id", "is_standard", "language")}
    body["llm_instructions"] = "changed"
    client.put(f"/api/profiles/{std['id']}", json=body)
    reset = client.post(f"/api/profiles/{std['id']}/reset")
    assert reset.status_code == 200
    assert reset.json()["llm_instructions"] == ""
    assert reset.json()["example_text"].startswith("At the end of the day")

    other = client.post(
        "/api/profiles",
        json={"language": "en", "name": "Other", "llm_provider": "ollama"},
    ).json()
    assert client.post(f"/api/profiles/{other['id']}/reset").status_code == 409


def test_update_prunes_dead_domain_ids(client):
    domain = client.post("/api/domains", json={"name": "Docs"}).json()
    std = _standard(client)
    body = {k: v for k, v in std.items()
            if k not in ("id", "is_standard", "language")}
    body["domain_ids"] = [domain["id"], 424242]
    updated = client.put(f"/api/profiles/{std['id']}", json=body).json()
    assert updated["domain_ids"] == [domain["id"]]


def test_domain_deletion_prunes_profiles(client):
    domain = client.post("/api/domains", json={"name": "Docs"}).json()
    std = _standard(client)
    body = {k: v for k, v in std.items()
            if k not in ("id", "is_standard", "language")}
    body["domain_ids"] = [domain["id"]]
    client.put(f"/api/profiles/{std['id']}", json=body)
    client.delete(f"/api/domains/{domain['id']}")
    assert _standard(client)["domain_ids"] == []
```

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && uv run pytest tests/test_profiles_api.py -q`
Expected: FAIL — 404s (router missing) after `create_app` works.

- [ ] **Step 3: Implement `backend/app/api/profiles.py`**

Dead rule exceptions are pruned on save against the loaded rule set; dead domain ids against existing domains.

```python
from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, Field

from app.core.models import Language
from app.services.profiles import Profile, ProfileStore
from app.services.seed_profiles import standard_defaults

router = APIRouter(prefix="/api", tags=["profiles"])


class ProfileCreate(BaseModel):
    language: Language
    name: str
    categories_off: list[str] = Field(default_factory=list)
    rule_exceptions: list[str] = Field(default_factory=list)
    domain_ids: list[int] = Field(default_factory=list)
    llm_provider: str | None = None
    llm_model: str | None = None
    llm_instructions: str = ""
    example_text: str = ""


class ProfileUpdate(BaseModel):
    name: str
    categories_off: list[str]
    rule_exceptions: list[str]
    domain_ids: list[int]
    llm_provider: str | None
    llm_model: str | None
    llm_instructions: str
    example_text: str


def _store(request: Request) -> ProfileStore:
    return request.app.state.profile_store


def _pruned(request: Request, language: Language,
            rule_exceptions: list[str], domain_ids: list[int]) -> tuple[list[str], list[int]]:
    known_rules = {
        r.rule_id
        for r in request.app.state.rule_engine.list_rules()
        if r.language == language
    }
    known_domains = {d.id for d in request.app.state.terminology_store.list_domains()}
    return (
        [r for r in rule_exceptions if r in known_rules],
        [d for d in domain_ids if d in known_domains],
    )


@router.get("/profiles")
def list_profiles(request: Request, language: Language) -> list[Profile]:
    return _store(request).list_profiles(language)


@router.post("/profiles", status_code=201)
def create_profile(request: Request, body: ProfileCreate) -> Profile:
    if not body.name.strip():
        raise HTTPException(422, "Profile name must not be empty")
    exceptions, domains = _pruned(
        request, body.language, body.rule_exceptions, body.domain_ids
    )
    try:
        return _store(request).create_profile(
            body.language,
            body.name.strip(),
            categories_off=body.categories_off,
            rule_exceptions=exceptions,
            domain_ids=domains,
            llm_provider=body.llm_provider,
            llm_model=body.llm_model,
            llm_instructions=body.llm_instructions,
            example_text=body.example_text,
        )
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc


@router.put("/profiles/{profile_id}")
def update_profile(request: Request, profile_id: int, body: ProfileUpdate) -> Profile:
    store = _store(request)
    current = store.get_profile(profile_id)
    if current is None:
        raise HTTPException(404, "Profile not found")
    if not body.name.strip():
        raise HTTPException(422, "Profile name must not be empty")
    if current.is_standard and body.name.strip() != current.name:
        raise HTTPException(409, "The Standard profile cannot be renamed")
    exceptions, domains = _pruned(
        request, current.language, body.rule_exceptions, body.domain_ids
    )
    try:
        updated = store.update_profile(
            profile_id,
            name=body.name.strip(),
            categories_off=body.categories_off,
            rule_exceptions=exceptions,
            domain_ids=domains,
            llm_provider=body.llm_provider,
            llm_model=body.llm_model,
            llm_instructions=body.llm_instructions,
            example_text=body.example_text,
        )
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc
    assert updated is not None
    return updated


@router.delete("/profiles/{profile_id}", status_code=204)
def delete_profile(request: Request, profile_id: int) -> Response:
    store = _store(request)
    profile = store.get_profile(profile_id)
    if profile is None:
        raise HTTPException(404, "Profile not found")
    if profile.is_standard:
        raise HTTPException(409, "The Standard profile cannot be deleted")
    store.delete_profile(profile_id)
    return Response(status_code=204)


@router.post("/profiles/{profile_id}/reset")
def reset_profile(request: Request, profile_id: int) -> Profile:
    store = _store(request)
    profile = store.get_profile(profile_id)
    if profile is None:
        raise HTTPException(404, "Profile not found")
    if not profile.is_standard:
        raise HTTPException(409, "Only the Standard profile can be reset")
    settings = request.app.state.settings
    defaults = standard_defaults(
        profile.language, settings.demos_dir, settings.providers.default_provider
    )
    updated = store.update_profile(profile_id, **defaults)
    assert updated is not None
    return updated
```

- [ ] **Step 4: Wire into `backend/app/main.py`**

Add imports:
```python
from app.api.profiles import router as profiles_router
from app.services.profiles import ProfileStore
from app.services.seed_profiles import seed_profiles
```
In `create_app`, after the `seed_terminology` block (order matters: the rule engine is created *before* profiles so `_pruned` works — move `app.state.rule_engine = RuleEngine(settings.rules_dir)` above if needed, keeping existing line order otherwise):
```python
    app.state.profile_store = ProfileStore(settings.db_path)
    seed_profiles(
        app.state.profile_store,
        settings.demos_dir,
        default_provider=settings.providers.default_provider,
        seed_examples=settings.seed_example_profiles,
    )
```
And register the router beside the others:
```python
    app.include_router(profiles_router)
```

- [ ] **Step 5: Prune profiles on domain deletion in `backend/app/api/terminology.py`**

Replace the `delete_domain` endpoint body:
```python
@router.delete("/domains/{domain_id}", status_code=204)
def delete_domain(request: Request, domain_id: int) -> Response:
    if not _store(request).delete_domain(domain_id):
        raise HTTPException(404, "Domain not found")
    request.app.state.profile_store.remove_domain_everywhere(domain_id)
    return Response(status_code=204)
```

- [ ] **Step 6: Run to verify pass (full backend suite — the wiring touches everything)**

Run: `cd backend && uv run pytest -q`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add backend/app/api/profiles.py backend/app/main.py backend/app/api/terminology.py backend/tests/test_profiles_api.py
git commit -m "feat: profiles CRUD API with Standard guards and seeding wiring

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: RuleConfig in the rule engine

**Files:**
- Modify: `backend/app/checkers/rules/engine.py`
- Test: extend `backend/tests/test_rule_engine.py`

- [ ] **Step 1: Add failing tests to `backend/tests/test_rule_engine.py`**

Append (adjust the imports at the top of the file to include `RuleConfig`):
```python
from app.checkers.rules.engine import RuleConfig


def _rule_ids(findings):
    return {f.rule_id for f in findings}


def test_rule_config_none_means_all_active(tmp_path):
    engine = _engine_with_two_rules(tmp_path)
    text = "This is very good. The cat cat sat."
    assert _rule_ids(engine.check(text, Language.EN)) == {
        "style.test-weasel", "grammar.test-repeat",
    }


def test_rule_config_category_off(tmp_path):
    engine = _engine_with_two_rules(tmp_path)
    text = "This is very good. The cat cat sat."
    config = RuleConfig(categories_off=["style"], exceptions=[])
    assert _rule_ids(engine.check(text, Language.EN, config=config)) == {
        "grammar.test-repeat",
    }


def test_rule_config_exception_inverts(tmp_path):
    engine = _engine_with_two_rules(tmp_path)
    text = "This is very good. The cat cat sat."
    # Category on + exception -> rule off.
    config = RuleConfig(categories_off=[], exceptions=["grammar.test-repeat"])
    assert _rule_ids(engine.check(text, Language.EN, config=config)) == {
        "style.test-weasel",
    }
    # Category off + exception -> rule back on.
    config = RuleConfig(categories_off=["style"], exceptions=["style.test-weasel"])
    assert "style.test-weasel" in _rule_ids(engine.check(text, Language.EN, config=config))


def test_rule_config_unknown_ids_harmless(tmp_path):
    engine = _engine_with_two_rules(tmp_path)
    config = RuleConfig(categories_off=["nosuchcategory"], exceptions=["gone.rule"])
    text = "This is very good."
    assert "style.test-weasel" in _rule_ids(engine.check(text, Language.EN, config=config))


def _engine_with_two_rules(tmp_path):
    (tmp_path / "en" / "style").mkdir(parents=True)
    (tmp_path / "en" / "grammar").mkdir(parents=True)
    (tmp_path / "en" / "style" / "test-weasel.yml").write_text(
        "extends: existence\nmessage: \"'%s' is weak.\"\ncategory: style\n"
        "ignorecase: true\ntokens: [very]\n"
    )
    (tmp_path / "en" / "grammar" / "test-repeat.yml").write_text(
        "extends: repetition\nmessage: \"'%s' is repeated.\"\ncategory: grammar\n"
    )
    return RuleEngine(tmp_path)
```

Note: `categories_off` is `list[str]` (not the `Category` enum) so an unknown/legacy value degrades to "matches nothing" instead of a validation error — mirrors the harmless-unknown-ids requirement.

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && uv run pytest tests/test_rule_engine.py -q`
Expected: FAIL — `ImportError: cannot import name 'RuleConfig'`.

- [ ] **Step 3: Implement in `backend/app/checkers/rules/engine.py`**

Add after the imports:
```python
from pydantic import BaseModel, Field


class RuleConfig(BaseModel):
    """Profile rule selection: category toggles + per-rule exceptions.

    A rule is active iff (category not off) XOR (rule id in exceptions):
    exceptions invert their category's toggle, so new rule files follow
    their category automatically.
    """

    categories_off: list[str] = Field(default_factory=list)
    exceptions: list[str] = Field(default_factory=list)

    def is_active(self, category: str, rule_id: str) -> bool:
        return (category not in self.categories_off) != (rule_id in self.exceptions)
```
Change `check` to:
```python
    def check(
        self,
        text: str,
        language: Language,
        doc: object | None = None,
        config: RuleConfig | None = None,
    ) -> list[Finding]:
        ctx = CheckContext(text=text, doc=doc)
        findings: list[Finding] = []
        for rule in self._rules:
            if rule.language != language:
                continue
            if config is not None and not config.is_active(
                rule.spec.category.value, rule.rule_id
            ):
                continue
            findings.extend(CHECKS[rule.spec.extends](rule, ctx))
        findings.sort(key=lambda f: (f.span.start, f.span.end))
        return findings
```

- [ ] **Step 4: Run to verify pass**

Run: `cd backend && uv run pytest tests/test_rule_engine.py tests/test_starter_rules.py tests/test_nlp_rules.py -q`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add backend/app/checkers/rules/engine.py backend/tests/test_rule_engine.py
git commit -m "feat: RuleConfig filtering (category toggles XOR exceptions)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: LLM instructions in prompts, checker, and suggestion endpoints

**Files:**
- Modify: `backend/app/checkers/llm/prompts.py`, `backend/app/checkers/llm/checker.py`, `backend/app/api/suggestions.py`
- Test: extend the prompts assertions in `backend/tests/test_llm_checker.py` (or create `backend/tests/test_prompts.py` if prompt tests don't exist there)

- [ ] **Step 1: Write failing tests** — create `backend/tests/test_prompts.py`:

```python
from app.checkers.llm.prompts import (
    build_prompt,
    build_rewrite_prompt,
    build_suggestion_prompt,
)
from app.core.models import Language


def test_build_prompt_without_instructions_unchanged():
    system, user = build_prompt("Hello.", Language.EN)
    assert "checking profile" not in system
    assert "Respond with ONLY a JSON array" in system


def test_build_prompt_appends_instructions_after_contract():
    system, _ = build_prompt("Hello.", Language.EN, instructions="Audience: kids.")
    assert "Audience: kids." in system
    # The JSON contract must remain, and instructions come after it.
    contract_pos = system.index("Respond with ONLY a JSON array")
    assert system.index("Audience: kids.") > contract_pos


def test_blank_instructions_ignored():
    baseline, _ = build_prompt("Hello.", Language.EN)
    padded, _ = build_prompt("Hello.", Language.EN, instructions="   \n")
    assert padded == baseline


def test_suggestion_and_rewrite_prompts_take_instructions():
    system, _ = build_suggestion_prompt(
        "The cat sat.", 4, 7, "Weak verb.", Language.EN,
        instructions="Prefer playful wording.",
    )
    assert "Prefer playful wording." in system
    system, _ = build_rewrite_prompt(
        "The cat sat.", "Weak verb.", Language.EN,
        instructions="Prefer playful wording.",
    )
    assert "Prefer playful wording." in system
```

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && uv run pytest tests/test_prompts.py -q`
Expected: FAIL — unexpected keyword argument `instructions`.

- [ ] **Step 3: Implement in `backend/app/checkers/llm/prompts.py`**

Add a helper and thread `instructions: str = ""` through all three builders:
```python
def _with_instructions(system: str, instructions: str) -> str:
    """Append profile instructions without touching the output contract."""
    text = instructions.strip()
    if not text:
        return system
    return (
        system
        + "\nAdditional review instructions from the writer's checking profile"
        + " (style and focus guidance only — the output format rules above"
        + " still apply unchanged):\n"
        + text
        + "\n"
    )
```
- `build_prompt(text, language, instructions="")` → `system = _with_instructions(system, instructions)` before returning.
- `build_suggestion_prompt(..., instructions="")` and `build_rewrite_prompt(..., instructions="")` → same, applied to their `system` string. Keep all existing parameters and their order; `instructions` is keyword-with-default at the end.

- [ ] **Step 4: Thread through `backend/app/checkers/llm/checker.py`**

`LLMChecker.check` gains the parameter:
```python
    async def check(
        self,
        text: str,
        language: Language,
        on_progress: ProgressCallback | None = None,
        instructions: str = "",
    ) -> list[Finding]:
        system, user = build_prompt(text, language, instructions=instructions)
        ...
```
(only the signature and the `build_prompt` call change).

- [ ] **Step 5: Accept `llm_instructions` in `backend/app/api/suggestions.py`**

Both request models gain:
```python
    llm_instructions: str = ""
```
and the two prompt-builder calls pass `instructions=body.llm_instructions`.

- [ ] **Step 6: Run to verify pass**

Run: `cd backend && uv run pytest tests/test_prompts.py tests/test_llm_checker.py tests/test_suggestions_api.py -q`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add backend/app/checkers/llm/prompts.py backend/app/checkers/llm/checker.py backend/app/api/suggestions.py backend/tests/test_prompts.py
git commit -m "feat: profile LLM instructions injected into check/suggest/rewrite prompts

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Check API extensions + demo endpoint removal

**Files:**
- Modify: `backend/app/api/checks.py`, `backend/app/api/languages.py`
- Test: extend `backend/tests/test_check_api.py`; trim `backend/tests/test_languages_api.py`

- [ ] **Step 1: Add failing tests to `backend/tests/test_check_api.py`** (reuse that file's existing client/FakeProvider fixtures — read them first and follow their patterns):

```python
def test_check_with_multiple_domains(client_with_two_domains):
    """Terminology findings come from the union of all selected domains."""
    client, ids = client_with_two_domains  # two domains, one forbidden term each
    body = {"text": "Use login and e-mail.", "language": "en",
            "domain_ids": ids, "checkers": ["terminology"]}
    findings = client.post("/api/checks", json=body).json()["findings"]
    assert len(findings) == 2


def test_check_with_rule_config(client):
    body = {"text": "This is very good.", "language": "en",
            "checkers": ["rules"],
            "rule_config": {"categories_off": ["style"], "exceptions": []}}
    findings = client.post("/api/checks", json=body).json()["findings"]
    assert all(f["category"] != "style" for f in findings)


def test_check_passes_llm_instructions_to_provider(client_with_recording_provider):
    """The FakeProvider records the system prompt; instructions must appear."""
    client, recorder = client_with_recording_provider
    body = {"text": "Hello.", "language": "en", "checkers": ["llm"],
            "llm_instructions": "Audience: kids."}
    client.post("/api/checks", json=body)
    assert "Audience: kids." in recorder.last_system
```

Self-contained fixtures (append to the same file; also add `def test_check_with_rule_config(client)` a plain `client` fixture if the file has none — reuse the existing one if it does):

```python
import pytest
from fastapi.testclient import TestClient

from app.core.config import Settings
from app.main import create_app


@pytest.fixture()
def client_with_two_domains(tmp_path):
    settings = Settings(db_path=tmp_path / "t.db", seed_terminology=False)
    client = TestClient(create_app(settings))
    ids = []
    for name, preferred, forbidden in [
        ("Docs", "sign in", ["login"]),
        ("Style", "email", ["e-mail"]),
    ]:
        domain = client.post("/api/domains", json={"name": name}).json()
        client.post(
            f"/api/domains/{domain['id']}/terms",
            json={"language": "en", "preferred": preferred,
                  "forbidden_variants": forbidden},
        )
        ids.append(domain["id"])
    return client, ids


class RecordingProvider:
    """Fake LLM provider that records the system prompt it was given."""

    name = "fake"

    def __init__(self):
        self.last_system = None

    async def generate(self, system, user, on_progress=None):
        self.last_system = system
        return "[]"


@pytest.fixture()
def client_with_recording_provider(tmp_path):
    settings = Settings(db_path=tmp_path / "t.db", seed_terminology=False)
    app = create_app(settings)
    recorder = RecordingProvider()
    app.state.provider_factory = lambda name=None, model=None: recorder
    return TestClient(app), recorder
```

If the file already defines a FakeProvider with a compatible `generate` signature, extend it with a `last_system` attribute instead of adding `RecordingProvider`.

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && uv run pytest tests/test_check_api.py -q`
Expected: new tests FAIL (unknown request fields are ignored by pydantic → wrong behavior asserted).

- [ ] **Step 3: Extend `backend/app/api/checks.py`**

`CheckRequest` — replace `domain_id` and add the new fields:
```python
from app.checkers.rules.engine import RuleConfig


class CheckRequest(BaseModel):
    text: str
    language: Language
    domain_ids: list[int] = Field(default_factory=list)
    checkers: list[CheckerName] = Field(
        default_factory=lambda: ["rules", "terminology", "llm"]
    )
    rule_config: RuleConfig | None = None
    llm_provider: str | None = None
    llm_model: str | None = None
    llm_instructions: str = ""
```
In `create_check`:
```python
    if "rules" in body.checkers:
        doc = app.state.nlp.analyze(body.text, body.language.value)
        if doc is None:
            job.skipped_rules = app.state.rule_engine.nlp_rule_ids(body.language)
        findings = app.state.rule_engine.check(
            body.text, body.language, doc=doc, config=body.rule_config
        )
        job.add_findings("rules", findings)
    if "terminology" in body.checkers and body.domain_ids:
        checker = TerminologyChecker(app.state.terminology_store, nlp=app.state.nlp)
        findings = []
        for domain_id in body.domain_ids:
            findings.extend(checker.check(body.text, body.language, domain_id))
        job.add_findings("terminology", findings)
```
`_run_llm` gains `instructions: str = ""` and passes it:
```python
        findings = await checker.check(
            text, language, on_progress=on_progress, instructions=instructions
        )
```
with the call site passing `instructions=body.llm_instructions`.

- [ ] **Step 4: Remove the demo endpoint from `backend/app/api/languages.py`**

Delete the `get_demo_text` endpoint function (and its now-unused imports, if any). Remove the demo-endpoint tests from `backend/tests/test_languages_api.py`. Keep `backend/tests/test_demo_texts.py` untouched — the demo files remain the seed source and must keep firing rules.

- [ ] **Step 5: Run the full backend suite**

Run: `cd backend && uv run pytest -q`
Expected: all pass (fix any `domain_id` stragglers the suite reveals).

- [ ] **Step 6: Commit**

```bash
git add backend/app/api/checks.py backend/app/api/languages.py backend/tests/test_check_api.py backend/tests/test_languages_api.py
git commit -m "feat: check API takes domain_ids, rule_config, llm_instructions

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: Frontend types + API client

**Files:**
- Modify: `frontend/src/types.ts`, `frontend/src/api/client.ts`

- [ ] **Step 1: Add the `Profile` type to `frontend/src/types.ts`**

```typescript
export interface Profile {
  id: number
  language: Language
  name: string
  is_standard: boolean
  categories_off: Category[]
  rule_exceptions: string[]
  domain_ids: number[]
  llm_provider: string | null
  llm_model: string | null
  llm_instructions: string
  example_text: string
}
```

- [ ] **Step 2: Extend `frontend/src/api/client.ts`**

Replace `domain_id` in `CheckRequest` and add the new fields:
```typescript
export interface RuleConfig {
  categories_off: Category[]
  exceptions: string[]
}

export interface CheckRequest {
  text: string
  language: Language
  domain_ids: number[]
  checkers: string[]
  rule_config?: RuleConfig | null
  llm_provider?: string | null
  llm_model?: string | null
  llm_instructions?: string
}
```
Add `llm_instructions?: string` to `SuggestionRequest` (and to the rewrite request interface beside it). Remove `getDemoText`. Add profile CRUD:
```typescript
export type ProfilePayload = Omit<Profile, 'id' | 'is_standard'>

export const getProfiles = (language: Language) =>
  request<Profile[]>(`/api/profiles?language=${language}`)
export const createProfile = (payload: ProfilePayload) =>
  request<Profile>('/api/profiles', { method: 'POST', body: JSON.stringify(payload) })
export const updateProfile = (id: number, payload: Omit<ProfilePayload, 'language'>) =>
  request<Profile>(`/api/profiles/${id}`, { method: 'PUT', body: JSON.stringify(payload) })
export const deleteProfile = (id: number) =>
  request<void>(`/api/profiles/${id}`, { method: 'DELETE' })
export const resetProfile = (id: number) =>
  request<Profile>(`/api/profiles/${id}/reset`, { method: 'POST' })
```
Import `Category` and `Profile` from `../types`.

- [ ] **Step 3: Typecheck** (call sites break in later tasks' files only after they exist; the client itself must compile)

Run: `cd frontend && npx tsc -b --noEmit 2>&1 | head`
Expected: errors ONLY in `controller.ts`/`App.tsx` (still sending `domain_id`, importing `getDemoText`) — these are fixed in Tasks 9–10. If other files error, fix them now.

- [ ] **Step 4: Commit** (together with Task 9 if you prefer compiling commits — otherwise commit here and note the transient breakage)

```bash
git add frontend/src/types.ts frontend/src/api/client.ts
git commit -m "feat: frontend profile types and API client

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: Store changes + pure profile helpers (TDD)

**Files:**
- Create: `frontend/src/profiles/profile.ts`, `frontend/src/profiles/profile.test.ts`
- Modify: `frontend/src/state/store.ts`, `frontend/src/checking/controller.ts`, `frontend/src/checking/suggest.ts`

- [ ] **Step 1: Write the failing tests** — `frontend/src/profiles/profile.test.ts`:

```typescript
import { describe, expect, it } from 'vitest'
import type { Profile } from '../types'
import { applyProfileToHeader, effectiveRuleConfig, isProfileDirty } from './profile'

function profile(overrides: Partial<Profile> = {}): Profile {
  return {
    id: 1,
    language: 'en',
    name: 'Standard',
    is_standard: true,
    categories_off: [],
    rule_exceptions: [],
    domain_ids: [2, 1],
    llm_provider: 'ollama',
    llm_model: null,
    llm_instructions: '',
    example_text: 'Example.',
    ...overrides,
  }
}

describe('applyProfileToHeader', () => {
  it('copies domains, provider, and model', () => {
    expect(applyProfileToHeader(profile({ llm_model: 'llama3.1' }))).toEqual({
      domainIds: [2, 1],
      provider: 'ollama',
      model: 'llama3.1',
    })
  })

  it('keeps the current provider when the profile has none', () => {
    const p = profile({ llm_provider: null })
    expect(applyProfileToHeader(p, 'claude')).toEqual({
      domainIds: [2, 1],
      provider: 'claude',
      model: null,
    })
  })
})

describe('isProfileDirty', () => {
  const header = { domainIds: [1, 2], provider: 'ollama', model: null }

  it('is clean when values match (domain order ignored)', () => {
    expect(isProfileDirty(profile(), header)).toBe(false)
  })

  it('is dirty on any difference', () => {
    expect(isProfileDirty(profile(), { ...header, domainIds: [1] })).toBe(true)
    expect(isProfileDirty(profile(), { ...header, provider: 'claude' })).toBe(true)
    expect(isProfileDirty(profile(), { ...header, model: 'x' })).toBe(true)
  })

  it('a null profile provider matches any header provider', () => {
    expect(isProfileDirty(profile({ llm_provider: null }), header)).toBe(false)
  })
})

describe('effectiveRuleConfig', () => {
  it('maps the profile fields', () => {
    const p = profile({ categories_off: ['style'], rule_exceptions: ['a.b'] })
    expect(effectiveRuleConfig(p)).toEqual({
      categories_off: ['style'],
      exceptions: ['a.b'],
    })
  })

  it('is null without a profile', () => {
    expect(effectiveRuleConfig(null)).toBeNull()
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && npx vitest run src/profiles/profile.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `frontend/src/profiles/profile.ts`**

```typescript
import type { RuleConfig } from '../api/client'
import type { Profile } from '../types'

export interface HeaderSettings {
  domainIds: number[]
  provider: string
  model: string | null
}

/** Values the header selectors take when this profile is selected. */
export function applyProfileToHeader(
  profile: Profile,
  currentProvider?: string,
): HeaderSettings {
  return {
    domainIds: [...profile.domain_ids],
    provider: profile.llm_provider ?? currentProvider ?? 'ollama',
    model: profile.llm_model,
  }
}

/** True when the header selectors differ from the stored profile. */
export function isProfileDirty(profile: Profile, header: HeaderSettings): boolean {
  const a = new Set(profile.domain_ids)
  const b = new Set(header.domainIds)
  if (a.size !== b.size || [...a].some((id) => !b.has(id))) return true
  if (profile.llm_provider !== null && profile.llm_provider !== header.provider)
    return true
  return (profile.llm_model ?? null) !== (header.model ?? null)
}

export function effectiveRuleConfig(profile: Profile | null): RuleConfig | null {
  if (!profile) return null
  return {
    categories_off: profile.categories_off,
    exceptions: profile.rule_exceptions,
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd frontend && npx vitest run src/profiles/profile.test.ts`
Expected: PASS.

- [ ] **Step 5: Store changes in `frontend/src/state/store.ts`**

- Replace `domainId: number | null` with `domainIds: number[]` (initial `[]`), and `setDomainId` with `setDomainIds: (domainIds: number[]) => void`.
- Add state: `profiles: Profile[]` (initial `[]`), `profileId: number | null` (initial `null`), `lastProfileByLanguage: Record<string, number>` (initial `{}`).
- Add actions:
```typescript
      setProfiles: (profiles) => set({ profiles }),
      // apply=true copies the profile's values into the header selectors.
      selectProfile: (profile, apply) =>
        set((state) => ({
          profileId: profile.id,
          lastProfileByLanguage: {
            ...state.lastProfileByLanguage,
            [profile.language]: profile.id,
          },
          ...(apply ? applyProfileToHeader(profile, state.provider) : {}),
        })),
```
  with the matching interface entries `setProfiles: (profiles: Profile[]) => void` and `selectProfile: (profile: Profile, apply: boolean) => void`, importing `applyProfileToHeader` from `../profiles/profile` and `Profile` from `../types`.
- `partialize` additions: `domainIds: state.domainIds, lastProfileByLanguage: state.lastProfileByLanguage` (drop `domainId`). The old persisted `domainId` key is silently ignored — acceptable one-time loss of a single selector value.

- [ ] **Step 6: Fix the check/suggest call sites**

`frontend/src/checking/controller.ts` — in `runCheck`, look up the profile and send the new fields:
```typescript
  const profile = state.profiles.find((p) => p.id === state.profileId) ?? null
  ...
    result = await postCheck({
      text,
      language: state.language,
      domain_ids: state.domainIds,
      checkers,
      rule_config: effectiveRuleConfig(profile),
      llm_provider: state.provider,
      llm_model: effectiveModel(state.model, state.provider, state.providers),
      llm_instructions: profile?.llm_instructions ?? '',
    })
```
(import `effectiveRuleConfig` from `../profiles/profile`).

`frontend/src/checking/suggest.ts` — both request bodies gain:
```typescript
    llm_instructions:
      state.profiles.find((p) => p.id === state.profileId)?.llm_instructions ?? '',
```

- [ ] **Step 7: Full frontend tests + typecheck**

Run: `cd frontend && npx vitest run && npx tsc -b --noEmit 2>&1 | head`
Expected: tests pass; remaining type errors only in `App.tsx` (`domainId`, `getDemoText`) — fixed next task. If `Sidebar.tsx` or others error, fix them now.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/profiles frontend/src/state/store.ts frontend/src/checking/controller.ts frontend/src/checking/suggest.ts
git commit -m "feat: profile state, dirty helpers, and check request fields

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 10: i18n keys (all 7 catalogs)

**Files:**
- Modify: `frontend/src/i18n/messages.ts`, `en.ts`, `de.ts`, `fr.ts`, `es.ts`, `it.ts`, `ja.ts`, `zh.ts`, `i18n.test.ts`

- [ ] **Step 1: Add a failing test to `frontend/src/i18n/i18n.test.ts`**

```typescript
  test('profile messages exist', () => {
    expect(en.profile).toBe('Profile')
    expect(en.domainsSelected(2)).toBe('2 domains')
    expect(catalogs.de.domainsSelected(2)).toBe('2 Domänen')
  })
```
Run: `cd frontend && npx vitest run src/i18n/i18n.test.ts` — expected FAIL.

- [ ] **Step 2: Extend the `Messages` interface** in `frontend/src/i18n/messages.ts` (in the Header section):

```typescript
  profile: string
  profileModifiedTitle: string
  saveToProfile: string
  resetToProfile: string
  domainsSelected: (n: number) => string
  viewProfiles: string
```
and a new "Profiles view" section:
```typescript
  profilesTitle: string
  newProfilePlaceholder: string
  createProfileTitle: string
  deleteProfileTitle: string
  resetStandardTitle: string
  standardNotDeletable: string
  llmInstructionsLabel: string
  llmInstructionsHint: string
  exampleTextLabel: string
  profileSaved: string
```
and in the Rules-view section:
```typescript
  editingRulesFor: (profileName: string, languageName: string) => string
  categoryToggleTitle: string
  ruleToggleTitle: string
```

- [ ] **Step 3: Add the values to all seven catalogs**

Complete translations (one row per key; `{n}` marks the function argument):

| Key | en | de | fr | es | it | ja | zh |
|---|---|---|---|---|---|---|---|
| profile | Profile | Profil | Profil | Perfil | Profilo | プロファイル | 配置 |
| profileModifiedTitle | Settings differ from this profile | Einstellungen weichen vom Profil ab | Les réglages diffèrent de ce profil | La configuración difiere del perfil | Le impostazioni differiscono dal profilo | 設定がプロファイルと異なります | 当前设置与配置不同 |
| saveToProfile | Save changes to the profile | Änderungen im Profil speichern | Enregistrer les modifications dans le profil | Guardar los cambios en el perfil | Salva le modifiche nel profilo | 変更をプロファイルに保存 | 将更改保存到配置 |
| resetToProfile | Reset to the profile's values | Auf Profilwerte zurücksetzen | Rétablir les valeurs du profil | Restablecer los valores del perfil | Ripristina i valori del profilo | プロファイルの値に戻す | 恢复为配置的值 |
| domainsSelected(n) | n===0 ? 'none' : n===1 ? (name shown instead) : `${n} domains` | `${n} Domänen` | `${n} domaines` | `${n} dominios` | `${n} domini` | `${n} 個のドメイン` | `${n} 个领域` |
| viewProfiles | Profiles | Profile | Profils | Perfiles | Profili | プロファイル | 配置 |
| profilesTitle | Checking profiles | Prüfprofile | Profils de vérification | Perfiles de comprobación | Profili di controllo | チェックプロファイル | 检查配置 |
| newProfilePlaceholder | New profile… | Neues Profil… | Nouveau profil… | Nuevo perfil… | Nuovo profilo… | 新しいプロファイル… | 新配置… |
| createProfileTitle | Create from the current settings | Aus den aktuellen Einstellungen erstellen | Créer à partir des réglages actuels | Crear a partir de la configuración actual | Crea dalle impostazioni attuali | 現在の設定から作成 | 从当前设置创建 |
| deleteProfileTitle | Delete profile | Profil löschen | Supprimer le profil | Eliminar perfil | Elimina profilo | プロファイルを削除 | 删除配置 |
| resetStandardTitle | Reset to defaults | Auf Standardwerte zurücksetzen | Rétablir les valeurs par défaut | Restablecer valores predeterminados | Ripristina i valori predefiniti | 既定値にリセット | 重置为默认值 |
| standardNotDeletable | The Standard profile cannot be deleted | Das Standard-Profil kann nicht gelöscht werden | Le profil Standard ne peut pas être supprimé | El perfil Standard no se puede eliminar | Il profilo Standard non può essere eliminato | Standardプロファイルは削除できません | 无法删除 Standard 配置 |
| llmInstructionsLabel | Extra LLM instructions | Zusätzliche LLM-Anweisungen | Instructions LLM supplémentaires | Instrucciones LLM adicionales | Istruzioni LLM aggiuntive | LLM への追加指示 | 额外的 LLM 指令 |
| llmInstructionsHint | Appended to the built-in check prompt (tone, audience, focus) | Wird an den eingebauten Prüf-Prompt angehängt (Ton, Zielgruppe, Fokus) | Ajoutées au prompt de vérification intégré (ton, audience, priorités) | Se añaden al prompt de comprobación integrado (tono, audiencia, enfoque) | Aggiunte al prompt di controllo integrato (tono, pubblico, priorità) | 組み込みのチェックプロンプトに追加されます(トーン・読者・重点) | 附加到内置检查提示词(语气、受众、重点) |
| exampleTextLabel | Example text | Beispieltext | Texte d'exemple | Texto de ejemplo | Testo di esempio | サンプルテキスト | 示例文本 |
| profileSaved | Profile saved | Profil gespeichert | Profil enregistré | Perfil guardado | Profilo salvato | プロファイルを保存しました | 配置已保存 |
| editingRulesFor(p, l) | `Editing rules for: ${p} (${l})` | `Regeln bearbeiten für: ${p} (${l})` | `Modification des règles pour : ${p} (${l})` | `Editando reglas para: ${p} (${l})` | `Modifica delle regole per: ${p} (${l})` | `ルールを編集中:${p}(${l})` | `正在编辑规则:${p}(${l})` |
| categoryToggleTitle | Toggle this whole category for the profile | Ganze Kategorie für das Profil umschalten | Activer/désactiver toute la catégorie pour le profil | Activar/desactivar toda la categoría para el perfil | Attiva/disattiva l'intera categoria per il profilo | このカテゴリー全体を切り替え | 为该配置切换整个类别 |
| ruleToggleTitle | Toggle this rule for the profile | Diese Regel für das Profil umschalten | Activer/désactiver cette règle pour le profil | Activar/desactivar esta regla para el perfil | Attiva/disattiva questa regola per il profilo | このルールを切り替え | 为该配置切换此规则 |

`domainsSelected` is only called with `n >= 2` (0 shows `domainNone`, 1 shows the domain's name — handled by the component), so every catalog implements simply `(n) => \`${n} …\`` per the table (en: `` (n) => `${n} domains` ``).

- [ ] **Step 4: Run to verify pass**

Run: `cd frontend && npx vitest run src/i18n/i18n.test.ts`
Expected: PASS (the keys-equality test enforces all seven catalogs).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/i18n
git commit -m "feat: i18n messages for checking profiles

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 11: Header — profile selector, domain multi-select, load-example

**Files:**
- Create: `frontend/src/header/ProfileSelector.tsx`, `frontend/src/header/DomainMultiSelect.tsx`
- Modify: `frontend/src/App.tsx`, `frontend/src/App.css`

- [ ] **Step 1: `frontend/src/header/DomainMultiSelect.tsx`**

```tsx
import { useEffect, useRef, useState } from 'react'
import { useMessages } from '../i18n'
import { useStore } from '../state/store'

/** Compact checkbox dropdown for selecting terminology domains. */
export function DomainMultiSelect() {
  const domains = useStore((s) => s.domains)
  const domainIds = useStore((s) => s.domainIds)
  const setDomainIds = useStore((s) => s.setDomainIds)
  const m = useMessages()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function onClickOutside(event: MouseEvent) {
      if (!ref.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onClickOutside)
    return () => document.removeEventListener('mousedown', onClickOutside)
  }, [open])

  const selected = domains.filter((d) => domainIds.includes(d.id))
  const label =
    selected.length === 0
      ? m.domainNone
      : selected.length === 1
        ? selected[0].name
        : m.domainsSelected(selected.length)

  function toggle(id: number) {
    setDomainIds(
      domainIds.includes(id)
        ? domainIds.filter((d) => d !== id)
        : [...domainIds, id],
    )
  }

  return (
    <div className="domain-multiselect" ref={ref}>
      <button className="domain-multiselect-toggle" onClick={() => setOpen(!open)}>
        {label} ▾
      </button>
      {open && (
        <div className="domain-multiselect-menu">
          {domains.map((domain) => (
            <label key={domain.id}>
              <input
                type="checkbox"
                checked={domainIds.includes(domain.id)}
                onChange={() => toggle(domain.id)}
              />
              {domain.name}
            </label>
          ))}
          {domains.length === 0 && <span className="dim">{m.domainNone}</span>}
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 2: `frontend/src/header/ProfileSelector.tsx`**

```tsx
import { updateProfile } from '../api/client'
import { useMessages } from '../i18n'
import { isProfileDirty } from '../profiles/profile'
import { useStore } from '../state/store'

export function ProfileSelector() {
  const profiles = useStore((s) => s.profiles)
  const profileId = useStore((s) => s.profileId)
  const selectProfile = useStore((s) => s.selectProfile)
  const domainIds = useStore((s) => s.domainIds)
  const provider = useStore((s) => s.provider)
  const model = useStore((s) => s.model)
  const m = useMessages()

  const selected = profiles.find((p) => p.id === profileId) ?? null
  const dirty =
    selected !== null && isProfileDirty(selected, { domainIds, provider, model })

  async function saveOverrides() {
    if (!selected) return
    const saved = await updateProfile(selected.id, {
      name: selected.name,
      categories_off: selected.categories_off,
      rule_exceptions: selected.rule_exceptions,
      domain_ids: domainIds,
      llm_provider: provider,
      llm_model: model,
      llm_instructions: selected.llm_instructions,
      example_text: selected.example_text,
    })
    useStore.getState().setProfiles(
      profiles.map((p) => (p.id === saved.id ? saved : p)),
    )
  }

  return (
    <label className="profile-select" title={dirty ? m.profileModifiedTitle : undefined}>
      {m.profile}
      <select
        value={profileId ?? ''}
        onChange={(e) => {
          const next = profiles.find((p) => p.id === Number(e.target.value))
          if (next) selectProfile(next, true)
        }}
      >
        {profiles.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
            {p.id === profileId && dirty ? ' ✱' : ''}
          </option>
        ))}
      </select>
      {dirty && (
        <span className="profile-dirty-actions">
          <button title={m.saveToProfile} onClick={() => void saveOverrides()}>
            💾
          </button>
          <button
            title={m.resetToProfile}
            onClick={() => selected && selectProfile(selected, true)}
          >
            ↩
          </button>
        </span>
      )}
    </label>
  )
}
```

- [ ] **Step 3: Wire the header in `frontend/src/App.tsx`**

- Remove the `getDemoText` import; add `getProfiles` and the two new components.
- In `Header`'s `useEffect`, fetch profiles whenever the language changes and select the remembered/Standard profile **without** applying on first load, **with** applying on language change:
```tsx
  const language = useStore((s) => s.language)
  const initialLoad = useRef(true)
  useEffect(() => {
    getProfiles(language)
      .then((profiles) => {
        const store = useStore.getState()
        store.setProfiles(profiles)
        const remembered = profiles.find(
          (p) => p.id === store.lastProfileByLanguage[language],
        )
        const chosen =
          remembered ?? profiles.find((p) => p.is_standard) ?? profiles[0]
        if (chosen) store.selectProfile(chosen, !initialLoad.current)
        initialLoad.current = false
      })
      .catch(() => {})
  }, [language])
```
  (import `useRef` from react; keep the existing providers/domains/languages effect as is).
- Insert `<ProfileSelector />` as the first element inside `.header-controls`.
- Replace the whole domain `<label>…</label>` block with:
```tsx
        <label>
          {m.domain}
          <DomainMultiSelect />
        </label>
```
- Replace `LoadExampleButton` (drop the domain-defaulting side effect and the fetch):
```tsx
function LoadExampleButton() {
  const m = useMessages()
  const profiles = useStore((s) => s.profiles)
  const profileId = useStore((s) => s.profileId)
  const exampleText =
    profiles.find((p) => p.id === profileId)?.example_text ?? ''
  return (
    <button
      className="load-example"
      title={m.exampleTitle}
      disabled={!exampleText.trim()}
      onClick={() => setEditorText(exampleText)}
    >
      ⤓ {m.loadExample}
    </button>
  )
}
```

- [ ] **Step 4: CSS in `frontend/src/App.css`** (beside the header styles)

```css
/* ---- profile selector + domain multi-select ---- */

.profile-dirty-actions button {
  border: none;
  background: none;
  cursor: pointer;
  font-size: 0.8rem;
  padding: 0 0.15rem;
}

.domain-multiselect { position: relative; display: inline-block; }

.domain-multiselect-toggle {
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg);
  padding: 0.15rem 0.5rem;
  cursor: pointer;
  font-size: 0.85rem;
}

.domain-multiselect-menu {
  position: absolute;
  top: 100%;
  left: 0;
  z-index: 30;
  min-width: 11rem;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 0.4rem 0.6rem;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.12);
}

.domain-multiselect-menu label {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.85rem;
  white-space: nowrap;
}
```

- [ ] **Step 5: Verify build + tests, then live-check in the browser**

Run: `cd frontend && npx vitest run && npm run build`
Expected: green. Then with both dev servers running, verify manually or via a quick Playwright script: profile dropdown lists Standard/Marketing/Technical Documentation (EN), switching to Marketing changes the selectors, changing the model shows ✱ + save/reset buttons, reset clears it, Load example inserts the marketing text.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/header frontend/src/App.tsx frontend/src/App.css
git commit -m "feat: header profile selector, domain multi-select, per-profile example

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 12: Profiles view

**Files:**
- Create: `frontend/src/profiles/ProfilesView.tsx`
- Modify: `frontend/src/App.tsx` (tab), `frontend/src/state/store.ts` (`ActiveView` union), `frontend/src/App.css`

- [ ] **Step 1: Extend `ActiveView`**

In `frontend/src/state/store.ts`: `export type ActiveView = 'editor' | 'rules' | 'terminology' | 'profiles'`.

- [ ] **Step 2: Implement `frontend/src/profiles/ProfilesView.tsx`**

```tsx
import { useState } from 'react'
import {
  createProfile,
  deleteProfile,
  resetProfile,
  updateProfile,
} from '../api/client'
import { DomainMultiSelect } from '../header/DomainMultiSelect'
import { useMessages } from '../i18n'
import { useStore } from '../state/store'
import type { Profile } from '../types'

export function ProfilesView() {
  const profiles = useStore((s) => s.profiles)
  const profileId = useStore((s) => s.profileId)
  const language = useStore((s) => s.language)
  const m = useMessages()
  const [newName, setNewName] = useState('')
  const [error, setError] = useState<string | null>(null)

  const selected = profiles.find((p) => p.id === profileId) ?? null

  function refresh(next: Profile[], select?: Profile) {
    const store = useStore.getState()
    store.setProfiles(next)
    if (select) store.selectProfile(select, true)
  }

  async function create() {
    if (!newName.trim()) return
    const state = useStore.getState()
    const base = selected
    try {
      const created = await createProfile({
        language,
        name: newName.trim(),
        categories_off: base?.categories_off ?? [],
        rule_exceptions: base?.rule_exceptions ?? [],
        domain_ids: state.domainIds,
        llm_provider: state.provider,
        llm_model: state.model,
        llm_instructions: base?.llm_instructions ?? '',
        example_text: base?.example_text ?? '',
      })
      setNewName('')
      setError(null)
      refresh([...profiles, created], created)
    } catch (e) {
      setError(String(e))
    }
  }

  async function save(profile: Profile, patch: Partial<Profile>) {
    const merged = { ...profile, ...patch }
    try {
      const saved = await updateProfile(profile.id, {
        name: merged.name,
        categories_off: merged.categories_off,
        rule_exceptions: merged.rule_exceptions,
        domain_ids: merged.domain_ids,
        llm_provider: merged.llm_provider,
        llm_model: merged.llm_model,
        llm_instructions: merged.llm_instructions,
        example_text: merged.example_text,
      })
      setError(null)
      refresh(profiles.map((p) => (p.id === saved.id ? saved : p)))
    } catch (e) {
      setError(String(e))
    }
  }

  async function remove(profile: Profile) {
    await deleteProfile(profile.id)
    const rest = profiles.filter((p) => p.id !== profile.id)
    const fallback = rest.find((p) => p.is_standard) ?? rest[0]
    refresh(rest, profile.id === profileId ? fallback : undefined)
  }

  async function reset(profile: Profile) {
    const restored = await resetProfile(profile.id)
    refresh(profiles.map((p) => (p.id === restored.id ? restored : p)))
  }

  return (
    <div className="profiles-view">
      <header className="profiles-header">
        <h2>{m.profilesTitle}</h2>
        <div className="profiles-create">
          <input
            placeholder={m.newProfilePlaceholder}
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void create()}
          />
          <button title={m.createProfileTitle} onClick={() => void create()}>
            {m.add}
          </button>
        </div>
      </header>
      {error && <p className="profiles-error">{error}</p>}
      <div className="profiles-list">
        {profiles.map((profile) => (
          <ProfileCard
            key={profile.id}
            profile={profile}
            active={profile.id === profileId}
            onSave={(patch) => void save(profile, patch)}
            onDelete={() => void remove(profile)}
            onReset={() => void reset(profile)}
          />
        ))}
      </div>
    </div>
  )
}

function ProfileCard({
  profile,
  active,
  onSave,
  onDelete,
  onReset,
}: {
  profile: Profile
  active: boolean
  onSave: (patch: Partial<Profile>) => void
  onDelete: () => void
  onReset: () => void
}) {
  const m = useMessages()
  const providers = useStore((s) => s.providers)
  const domains = useStore((s) => s.domains)
  const [name, setName] = useState(profile.name)
  const [instructions, setInstructions] = useState(profile.llm_instructions)
  const [example, setExample] = useState(profile.example_text)

  const activeProvider = providers.find((p) => p.name === profile.llm_provider)

  return (
    <section className={`profile-card${active ? ' selected' : ''}`}>
      <div className="profile-card-title">
        <input
          value={name}
          disabled={profile.is_standard}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => name !== profile.name && onSave({ name })}
        />
        {profile.is_standard ? (
          <button title={m.resetStandardTitle} onClick={onReset}>↺</button>
        ) : (
          <button title={m.deleteProfileTitle} onClick={onDelete}>✕</button>
        )}
      </div>
      <label>
        {m.domain}
        <select
          multiple
          value={profile.domain_ids.map(String)}
          onChange={(e) =>
            onSave({
              domain_ids: [...e.target.selectedOptions].map((o) => Number(o.value)),
            })
          }
        >
          {domains.map((d) => (
            <option key={d.id} value={d.id}>{d.name}</option>
          ))}
        </select>
      </label>
      <label>
        {m.llm}
        <select
          value={profile.llm_provider ?? ''}
          onChange={(e) => onSave({ llm_provider: e.target.value, llm_model: null })}
        >
          {providers.map((p) => (
            <option key={p.name} value={p.name}>{p.name}</option>
          ))}
        </select>
      </label>
      <label>
        {m.model}
        <select
          value={profile.llm_model ?? activeProvider?.default_model ?? ''}
          onChange={(e) => onSave({ llm_model: e.target.value })}
        >
          {(activeProvider?.models.length
            ? activeProvider.models
            : [activeProvider?.default_model ?? '']
          ).map((model) => (
            <option key={model} value={model}>{model}</option>
          ))}
        </select>
      </label>
      <label className="profile-textarea">
        {m.llmInstructionsLabel}
        <textarea
          rows={3}
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          onBlur={() =>
            instructions !== profile.llm_instructions &&
            onSave({ llm_instructions: instructions })
          }
        />
        <span className="hint">{m.llmInstructionsHint}</span>
      </label>
      <label className="profile-textarea">
        {m.exampleTextLabel}
        <textarea
          rows={4}
          value={example}
          onChange={(e) => setExample(e.target.value)}
          onBlur={() =>
            example !== profile.example_text && onSave({ example_text: example })
          }
        />
      </label>
    </section>
  )
}
```
Note the deliberate simplicity: fields save on blur/change via `onSave`; the small native `multiple` select is fine here (the compact dropdown stays a header refinement).

- [ ] **Step 3: Add the tab in `frontend/src/App.tsx`**

Beside the terminology button:
```tsx
        <button
          className={store.activeView === 'profiles' ? 'active' : ''}
          onClick={() => store.setActiveView('profiles')}
        >
          {m.viewProfiles}
        </button>
```
and in `App`: `{activeView === 'profiles' && <ProfilesView />}`.

- [ ] **Step 4: CSS**

```css
/* ---- profiles view ---- */

.profiles-view { padding: 1rem 1.5rem; max-width: 60rem; }
.profiles-header { display: flex; align-items: baseline; gap: 1rem; }
.profiles-create { display: flex; gap: 0.4rem; }
.profiles-error { color: #e5484d; }
.profiles-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(24rem, 1fr)); gap: 1rem; }

.profile-card {
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 0.8rem 1rem;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.profile-card.selected { border-color: var(--accent); }
.profile-card-title { display: flex; gap: 0.5rem; }
.profile-card-title input { font-weight: 600; flex: 1; }
.profile-card label { display: flex; flex-direction: column; gap: 0.2rem; font-size: 0.85rem; }
.profile-textarea .hint { color: var(--text-dim); font-size: 0.75rem; }
```

- [ ] **Step 5: Verify + commit**

Run: `cd frontend && npx vitest run && npm run build` — green; browser-check create/rename/delete/reset.

```bash
git add frontend/src/profiles/ProfilesView.tsx frontend/src/App.tsx frontend/src/state/store.ts frontend/src/App.css
git commit -m "feat: profiles management view

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 13: Rules page — per-profile toggles (write-through)

**Files:**
- Modify: `frontend/src/rules/RulesView.tsx`

- [ ] **Step 1: Wire the selected profile into `RulesView`**

Add to the component: read `profiles`, `profileId` from the store; `const profile = profiles.find((p) => p.id === profileId) ?? null`. A rule's active state:
```typescript
function isRuleActive(profile: Profile, category: string, ruleId: string): boolean {
  return (
    !profile.categories_off.includes(category as Category) !==
    profile.rule_exceptions.includes(ruleId)
  )
}
```
(put this small helper in `frontend/src/profiles/profile.ts` with two vitest cases mirroring the backend XOR tests, then import it).

Write-through helper inside `RulesView`:
```typescript
  async function saveRuleSelection(patch: {
    categories_off?: Category[]
    rule_exceptions?: string[]
  }) {
    if (!profile) return
    const saved = await updateProfile(profile.id, {
      name: profile.name,
      categories_off: patch.categories_off ?? profile.categories_off,
      rule_exceptions: patch.rule_exceptions ?? profile.rule_exceptions,
      domain_ids: profile.domain_ids,
      llm_provider: profile.llm_provider,
      llm_model: profile.llm_model,
      llm_instructions: profile.llm_instructions,
      example_text: profile.example_text,
    })
    useStore.getState().setProfiles(
      useStore.getState().profiles.map((p) => (p.id === saved.id ? saved : p)),
    )
  }

  function toggleCategory(category: Category, rulesInCategory: RuleInfo[]) {
    if (!profile) return
    const off = profile.categories_off.includes(category)
    void saveRuleSelection({
      categories_off: off
        ? profile.categories_off.filter((c) => c !== category)
        : [...profile.categories_off, category],
      // Toggling a category clears its exceptions (fresh start).
      rule_exceptions: profile.rule_exceptions.filter(
        (id) => !rulesInCategory.some((r) => r.rule_id === id),
      ),
    })
  }

  function toggleRule(ruleId: string) {
    if (!profile) return
    const isException = profile.rule_exceptions.includes(ruleId)
    void saveRuleSelection({
      rule_exceptions: isException
        ? profile.rule_exceptions.filter((id) => id !== ruleId)
        : [...profile.rule_exceptions, ruleId],
    })
  }
```

- [ ] **Step 2: Render the banner and the toggles**

Under the `rules-header` `<h2>`, when a profile is selected:
```tsx
        {profile && (
          <p className="rules-profile-banner">
            {m.editingRulesFor(profile.name, languageName)}
          </p>
        )}
```
In each category `<h3>`, add before the name:
```tsx
              <input
                type="checkbox"
                title={m.categoryToggleTitle}
                checked={!profile?.categories_off.includes(group.category)}
                disabled={!profile}
                onChange={() => toggleCategory(group.category, group.rules)}
              />
```
And pass into each `RuleCard` an `active` flag + toggle, rendering a switch checkbox in the card header with `title={m.ruleToggleTitle}` and dimming inactive cards (`className={active ? '' : 'rule-inactive'}`, CSS `.rule-inactive { opacity: 0.45; }` + `.rules-profile-banner { color: var(--text-dim); }`).

- [ ] **Step 3: Verify + commit**

Run: `cd frontend && npx vitest run && npm run build` — green. Browser-check: unchecking a category dims all its rules; re-enabling a single rule inside a disabled category works (XOR); switching profiles switches the checkbox states; a check run reflects the change (disable `style` in Standard EN, load example, `style` findings disappear).

```bash
git add frontend/src/rules/RulesView.tsx frontend/src/profiles/profile.ts frontend/src/profiles/profile.test.ts frontend/src/App.css
git commit -m "feat: rules page edits the selected profile's rule selection

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 14: End-to-end verification + logbook

- [ ] **Step 1: Full test suites**

Run: `cd backend && uv run pytest -q` and `cd frontend && npx vitest run && npm run build`
Expected: all green.

- [ ] **Step 2: Playwright end-to-end pass** (both dev servers running; scratchpad script in the style of `verify-source-filter.mjs`)

Verify, capturing screenshots:
1. Header shows the profile selector with Standard/Marketing/Technical Documentation for EN.
2. Selecting Marketing → Load example inserts the SuperWidget text; rule findings appear.
3. Override the model → "Marketing ✱" + save/reset buttons; reset clears the marker.
4. Save path: override a domain, click save, reload the page → profile keeps the domain.
5. Rules page: banner names the profile; toggling `style` off removes style findings from the next check; toggling one style rule back on re-adds only that rule's findings (XOR).
6. Profiles view: create "Blog" from current settings, edit its instructions, delete it; Standard shows reset instead of delete.
7. Standard delete attempt via `curl -X DELETE localhost:8000/api/profiles/<std-id>` → 409.

- [ ] **Step 3: Logbook + push**

Append a summary entry to `docs/LOGBOOK.md` with commit pointers, then `git push` and watch CI (`gh run list --json headSha,name,status,conclusion`).

---

## Self-review notes

- Spec coverage: data model + seeding (Tasks 1–3), CRUD API + guards + pruning (4), rule XOR (5), prompt injection + suggest/rewrite (6), check API + demo-endpoint removal (7), frontend resolution + dirty/save/reset (8–11), Profiles view (12), rules-page editing (13), e2e (14). Example texts: Task 1 + seeding in 3 + button in 11.
- The `Category` union type on the frontend already exists in `types.ts`; `categories_off` uses it client-side and plain strings server-side (deliberate, see Task 5 note).
- `updateProfile` payload shape is identical at all four call sites (ProfileSelector, ProfilesView, RulesView): full replacement per `ProfileUpdate`.
