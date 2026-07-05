# Checking Profiles — Design

Date: 2026-07-05
Status: approved in brainstorming session with Markus

## Purpose

A **checking profile** is a language-specific, named bundle of check settings:
which rules are active, which terminology domains apply, which LLM
provider/model to use, and extra instructions for the LLM check. Use case:
different profiles for product documentation, technical documentation,
marketing copy, emails, blog posts, etc.

Every language always has at least one profile: a seeded, editable,
non-deletable **Standard** profile. Users create additional profiles through
the UI. Selecting a profile resets the header selectors to the profile's
values; the user can always override them ad hoc.

## Decisions (settled with Markus)

| Topic | Decision |
|---|---|
| Custom LLM prompt | **Extra instructions only**, injected into the built-in system prompt template. The JSON output contract and verbatim-quote rules stay intact so anchoring keeps working. No full-template replacement. |
| Rule selection model | **Category toggles + per-rule exceptions.** A rule is active iff `(category not in categories_off) != (rule_id in rule_exceptions)` (exceptions invert the category toggle). New rule files automatically follow their category's toggle. |
| Header overrides | **Ephemeral with a computed dirty marker.** Overrides apply to checks immediately, are never written to the profile implicitly; explicit save/reset actions appear when dirty. |
| Standard profile | **Editable, not deletable, not renamable.** Seeded per language at startup; a reset action restores its factory defaults. |
| Rule-selection editing | **On the rules page itself** (write-through to the profile). Name, domains, provider/model, instructions are edited in a new Profiles view. |
| Domains in header | The domain selector becomes a **multi-select**; the check API takes `domain_ids: list[int]`. |
| Storage | **SQLite**, beside `domains`/`terms`. Profiles are UI-authored; file-based storage would force the server to write YAML and use fragile name references. |
| Checker on/off set | Stays **out of profiles**: a profile with no domains simply yields no terminology findings; the LLM auto-toggle remains a global user preference. |
| Example profiles | **Marketing** and **Technical Documentation** are seeded for EN, DE, and JA (config switch `seed_example_profiles`, default true). Ordinary deletable profiles; seeding is tracked per language so deletions stick across restarts. Purpose: demonstrating profile switching out of the box. |
| Example texts | Each profile carries its own **example text**, seeded with the profile and editable in the Profiles view. The header's "Load example" button loads the selected profile's text, so demos show rule/LLM behavior on fitting material (marketing copy vs. tech docs). The per-language demo endpoint is replaced. |

## Data model

New table, created idempotently at startup like `domains`/`terms`:

```sql
CREATE TABLE IF NOT EXISTS profiles (
  id INTEGER PRIMARY KEY,
  language TEXT NOT NULL,                      -- 'en' | 'de' | ...
  name TEXT NOT NULL,
  is_standard INTEGER NOT NULL DEFAULT 0,
  categories_off TEXT NOT NULL DEFAULT '[]',   -- JSON: ["vividness", ...]
  rule_exceptions TEXT NOT NULL DEFAULT '[]',  -- JSON: ["style.weasel-words", ...]
  domain_ids TEXT NOT NULL DEFAULT '[]',       -- JSON: [1, 3]
  llm_provider TEXT,                           -- NULL = config default
  llm_model TEXT,                              -- NULL = provider default
  llm_instructions TEXT NOT NULL DEFAULT '',
  example_text TEXT NOT NULL DEFAULT '',
  UNIQUE(language, name)
)
```

- **Seeding (Standard):** at startup, every supported language without an
  `is_standard = 1` row gets one: name "Standard", everything on, no
  exceptions, no domains, NULL provider/model, empty instructions, and
  `example_text` read from the existing `backend/demos/<lang>.txt`.
- **Seeding (examples):** if the config switch `seed_example_profiles`
  (config.yaml, default `true`) is on, EN, DE, and JA each get two ordinary,
  deletable profiles — **Marketing** and **Technical Documentation** — the
  first time seeding runs for that language. A marker table records which
  languages have been example-seeded:

  ```sql
  CREATE TABLE IF NOT EXISTS profile_seed_markers (
    language TEXT PRIMARY KEY
  )
  ```

  Seeding checks the marker, not the profiles' existence, so a deleted
  example profile stays deleted across restarts. Turning the switch on later
  seeds any languages not yet marked. Preset content:

  | Preset | categories_off | rule_exceptions | llm_instructions (gist, localized per language) |
  |---|---|---|---|
  | Marketing | `[]` | disable rules that fight marketing tone where they exist (e.g. EN intensifiers/weasel-word style rules) — exact ids picked from the loaded rule set at implementation time | Audience: prospective customers. Favor energetic, benefit-led, concrete phrasing; short sentences; active voice. Flag jargon, hedging, and vague claims. |
  | Technical Documentation | `["vividness"]` | none | Audience: users following instructions. Prioritize precision, consistent terminology, and unambiguous phrasing; prefer imperative mood for steps; flag marketing language and vague quantifiers. |

  Both presets: no domains, NULL provider/model. Their example texts come
  from new seed files `backend/demos/<lang>-marketing.txt` and
  `backend/demos/<lang>-technical-documentation.txt` (EN, DE, JA), authored
  at implementation time: short flawed texts whose defects match the profile
  (hype, vague claims, and hedging for Marketing; ambiguity, inconsistent
  terminology, and passive steps for Technical Documentation). The demos
  directory is the **seed source only** — after seeding, the profile row owns
  the text.
- **Rule activation semantics** (applied by the rule engine):
  `active(rule) = (rule.category not in categories_off) XOR (rule.rule_id in rule_exceptions)`.
  Exceptions referencing rules that no longer exist are ignored at check time
  and pruned when the profile is next saved.
- **Category toggle interaction:** toggling a category in the UI clears that
  category's exceptions (fresh start).
- **Domain integrity:** deleting a terminology domain removes its id from all
  profiles' `domain_ids` in the same transaction.

## API

CRUD mirroring the terminology API (`backend/app/api/profiles.py`):

- `GET /api/profiles?language=de` → list of profiles for the language.
- `POST /api/profiles` → create. Validates: non-empty unique name per
  language; 409 on conflict.
- `PUT /api/profiles/{id}` → full update. Renaming Standard → 409. Prunes
  dead rule exceptions and dead domain ids on save.
- `DELETE /api/profiles/{id}` → 409 if `is_standard`.
- `POST /api/profiles/{id}/reset` → restore factory defaults, including the
  example text re-read from the demos seed file; Standard only
  (409 otherwise). UI exposes it only for Standard.

Profile shape over the wire:

```json
{
  "id": 3,
  "language": "de",
  "name": "Marketing",
  "is_standard": false,
  "categories_off": ["correctness"],
  "rule_exceptions": ["style.weasel-words"],
  "domain_ids": [1, 4],
  "llm_provider": "claude",
  "llm_model": null,
  "llm_instructions": "Audience: consumers. Prefer energetic, benefit-led phrasing...",
  "example_text": "Introducing the all-new SuperWidget, quite possibly the best..."
}
```

`GET /api/languages/{code}/demo` is removed; the frontend reads
`example_text` from the already-fetched selected profile.

### Check API (profile-agnostic)

The check request never references a profile id. The **frontend resolves**
profile + ephemeral overrides into explicit fields — that is what makes
overrides trivial:

- `domain_id: int | None` → **`domain_ids: list[int]`** (default `[]`). The
  terminology checker compiles the union of the selected domains' terms.
- New **`rule_config: {"categories_off": [...], "exceptions": [...]} | None`**.
  `None`/omitted = all rules active (backward compatible). The rule engine
  resolves it against its loaded rules.
- New **`llm_instructions: str`** (default `""`). Injected into the built-in
  system prompt template as a clearly delimited extra section, e.g.
  "Additional review instructions from the writer's checking profile: ...".
  The JSON contract portion of the template is not touched.
- `llm_provider` / `llm_model` unchanged.

The suggestion and rewrite endpoints also accept `llm_instructions` so tone
guidance carries into suggested fixes and rewrites.

## Frontend

### Header

- New **profile selector**, placed first among the selectors. Lists the
  current language's profiles. Switching language selects that language's
  **last-used profile** (persisted per language in localStorage), falling
  back to Standard.
- Selecting a profile **copies** its domains/provider/model into the existing
  header state; rule config and instructions apply implicitly (they are not
  header selectors).
- **Dirty marker is computed, not stored:** the selector shows "Marketing ✱"
  whenever the current header state differs from the stored profile. When
  dirty, two small actions appear: **save** (PUT header values into the
  profile) and **reset** (re-copy profile values into the header). Header
  values already persist in localStorage, so overrides survive reload and the
  marker recomputes.
- The **domain selector becomes a multi-select**: compact checkbox dropdown;
  closed label shows "none", the single domain's name, or "2 domains".
- The **"Load example" button** inserts the selected profile's
  `example_text` into the editor; it is disabled when that text is empty.
  Its current side effect of defaulting the domain selector is dropped —
  the profile governs domains now.
- Any profile/selector change triggers the usual re-check debounce.

### Profiles view

New view (tab, like Terminology) managing the current language's profiles:

- List with the selected profile highlighted.
- **Create**: name input; the new profile starts as a copy of the current
  effective settings — the selected profile including any header overrides —
  so "tweak, then fork" works naturally.
- **Rename / delete**: blocked for Standard (delete button replaced by
  "reset to defaults").
- **Edit non-rule fields**: domains (same multi-select component),
  provider/model (same selectors as the header), a textarea for
  `llm_instructions` with a hint that these are appended to the built-in
  check prompt, and a textarea for `example_text`.

### Rules page

Becomes the **rule-selection editor** for the selected profile:

- Banner: "Editing rules for: Marketing (Deutsch)".
- Per-category toggle in each category header; per-rule switch on each rule.
- Displayed active state always equals the XOR semantics.
- Toggles **write through** immediately via `PUT /api/profiles/{id}` (the
  rules page is the profile's rule editor; no dirty semantics here).
- Toggling a category clears its exceptions.

### State (zustand)

- `profiles: Profile[]` (fetched per language), `profileId: number | null`,
  `lastProfileByLanguage: Record<Language, number>` (persisted).
- `domainId: number | null` → **`domainIds: number[]`** (persisted).
- Dirty computation: pure function `isDirty(profile, headerState)` comparing
  domains (as sets), provider, model.
- Check scheduling passes `domain_ids`, `rule_config`, `llm_instructions`
  from the selected profile (with header overrides for domains/provider/model).

## Errors and edge cases

- Backend offline: profile selector keeps the last-fetched list (same
  degradation as the providers selector today).
- Duplicate/empty profile names: 409/422 surfaced inline in the Profiles view.
- Dead references: unknown rule ids in `rule_exceptions` and unknown ids in
  `domain_ids` are ignored at check time, pruned on save.
- Deleting the selected profile: selection falls back to Standard.
- Existing users (no stored profile selection): header keeps its persisted
  values; the selector shows Standard with the dirty marker if they differ.

## Testing

- **Backend (pytest):** seeding idempotency (run init twice, one Standard per
  language, examples not duplicated); example-profile deletion sticks across
  a re-init (marker table); `seed_example_profiles: false` seeds no examples;
  XOR activation semantics including unknown ids; CRUD guards
  (Standard delete/rename → 409, duplicate name → 409, reset restores
  defaults); multi-domain terminology union; `llm_instructions` present in
  the generated system prompt while the JSON contract remains; domain
  deletion prunes profiles; seeded example texts match the demo seed files
  (replacing the current demo-endpoint tests).
- **Frontend (vitest):** `isDirty` comparison (set semantics for domains);
  profile→header copy; rules-page activation resolution; last-profile-per-
  language selection on language switch.
- **End-to-end (Playwright):** create profile from current settings, switch
  profiles and watch selectors reset, override a selector → dirty marker →
  save and reset paths, toggle a category and a single rule on the rules page
  and observe check results change, delete guard on Standard.

## Implementation phasing (single plan, ordered)

1. Backend: table + seeding + CRUD API.
2. Backend: check API extensions (`domain_ids`, `rule_config`,
   `llm_instructions`) and engine/checker/prompt support.
3. Frontend: store changes + multi-select domain component + header profile
   selector with dirty/save/reset.
4. Frontend: Profiles view.
5. Frontend: rules page editing.
6. End-to-end verification.
