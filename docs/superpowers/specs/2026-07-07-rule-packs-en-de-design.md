# Rule Packs + EN/DE Rule Expansion — Design

**Status:** approved design, phase 1 of 3
**Date:** 2026-07-07

## Goal

Grow the deterministic rule catalog per language — first with general-purpose
grammar/style rules, then with use-case-specific rules (marketing, technical
documentation, blog posts) that profiles can switch on and off as a group.
Phase 1 (this spec) delivers the pack mechanism plus the English and German
rule sets; phase 2 covers Japanese (including a small engine extension for
document-scoped checks); phase 3 covers French, Spanish, Italian, and Chinese.

A second goal is to exercise the linguistic pattern formalism
(`token_pattern` / `dependency` on the spaCy pipelines) more heavily: most new
rules that benefit from POS/morph/dependency context use it, and each one
doubles as a cookbook example in `backend/rules/README.md`.

## Background: why packs need first-class support

Rule activation today is `(category not in categories_off) XOR (rule_id in
exceptions)`. New rule files therefore auto-activate in **every** profile.
That is right for general rules (a new grammar check should just start
working) and wrong for use-case rules (a marketing hype-word check must not
fire on a technical manual). Packs give use-case rules an off-by-default
home without touching the semantics of existing rules or stored profiles.

## Design decisions (confirmed with owner)

| Topic | Decision |
|---|---|
| Pack representation | Open-ended `pack:` slug field on rules; pack list discovered from the catalog, no registry |
| Phasing | 1: mechanism + EN/DE · 2: Japanese (+ `scope: document`) · 3: FR/ES/IT/ZH |
| Seed profiles | Per language: Standard, Marketing, Technical docs, Blog — the last three with their pack enabled and a fitting example text |
| Severities | error = near-certain, warning = context-aware heuristic, suggestion = taste; individual levels adjustable later |
| Rule examples | Mandatory `examples` block (bad + good sentences) on every rule; existing 49 rules backfilled; examples render in the rule cards and drive a catalog-wide parametrized test |

## 1. Pack mechanism (engine)

### RuleSpec

`RuleSpec` gains one optional field:

```python
pack: str | None = None
```

Validated at load time against `^[a-z][a-z0-9-]*$`; a violating file becomes a
`RuleError` (reported, not fatal), like any other invalid rule. `pack` is
orthogonal to `category`: a marketing rule is still a `style` or `clarity`
rule and keeps its sidebar color and category grouping.

### RuleConfig

```python
class RuleConfig(BaseModel):
    categories_off: list[str] = Field(default_factory=list)
    exceptions: list[str] = Field(default_factory=list)
    packs_on: list[str] = Field(default_factory=list)      # NEW
```

Activation:

- **General rule** (`pack is None`):
  `(category not in categories_off) XOR (rule_id in exceptions)` — unchanged.
- **Pack rule**:
  `(pack in packs_on and category not in categories_off) XOR (rule_id in exceptions)`.

Consequences (this is the activation truth table the engine tests pin down):

| Rule | packs_on | exception | active |
|---|---|---|---|
| pack rule | no | no | **no** (off by default everywhere) |
| pack rule | yes | no | yes (category on) |
| pack rule | yes | yes | no (opt out of one rule of an enabled pack) |
| pack rule | no | yes | yes (cherry-pick one rule without the pack) |
| pack rule | yes, but category off | no | no (category toggle still wins) |
| general rule | — | — | exactly today's behavior |

`packs_on` defaults to `[]`: stored profiles and old clients keep their
current behavior without migration (rule_config already lives in a JSON
column).

Pack names referencing no existing rule are harmless (same as stale
exceptions). The set of packs of a language is **discovered**: the distinct
`pack` values among its loaded rules. Adding a new use case (e.g.
`legal-writing`) means adding rule files with that slug — no backend code,
no registry, no migration.

### Rule file layout

Pack rules live in the same `<lang>/<category>/<name>.yml` tree as general
rules — the `pack:` field, not the directory, carries pack membership; the
rule id stays `<category>.<name>`.

### Self-documenting examples

Every rule carries an `examples` block — sentences in the rule's language
that pin down its behavior:

```yaml
examples:
  bad:        # each sentence MUST yield ≥1 finding from this rule
    - "Ich hoffe, das er morgen kommt."
  good:       # each sentence MUST yield no finding from this rule
    - "Das Buch, das er gestern kaufte, ist spannend."
```

```python
class RuleExamples(BaseModel):
    bad: list[str] = Field(min_length=1)
    good: list[str] = Field(min_length=1)

class RuleSpec(BaseModel):
    ...
    examples: RuleExamples          # required — no default
```

`examples` is **required**: a rule file without at least one bad and one
good sentence is a `RuleError` at load time (reported, not fatal — same as
any schema violation). All 49 existing rules are backfilled in this phase.
The examples serve three purposes at once:

1. **Documentation** — rendered in the rule card (§3), so writers see
   concrete flagged/unflagged sentences instead of reverse-engineering a
   pattern.
2. **Tests** — a catalog-wide parametrized pytest runs every rule against
   its own examples (§7); new rules are behavior-locked by writing YAML,
   with no accompanying Python test needed.
3. **Spec precision** — for the heuristic NLP rules, the `good` sentences
   encode the false-positive guards this spec calls out (das-dass, noun
   string, double negative, …).

## 2. API + storage

- `GET /api/rules`: each rule entry gains `"pack": str | null` and
  `"examples": {"bad": [...], "good": [...]}`. The response gains a
  per-language pack index, e.g. `"packs": {"en": ["blog", "marketing",
  "techdocs"], "de": [...]}` (sorted, discovered).
- `POST /api/checks`: `rule_config.packs_on` accepted (defaults `[]`).
- Profiles: `rule_config` JSON passes `packs_on` through CRUD unchanged
  (no schema migration; missing key = `[]` on read).

## 3. Frontend

- **Types** (`frontend/src/types.ts`): `Rule.pack: string | null`,
  `RuleConfig.packs_on: string[]`, packs index on the rules response.
- **Rules view**: general rules render as today. Below them, one section
  per discovered pack (heading = localized pack name) listing that pack's
  rules, with a pack-level toggle (when a profile is selected) that
  adds/removes the pack in the profile's `packs_on` — mirroring the
  existing category-toggle interaction. Per-rule checkboxes keep working
  via `exceptions`.
- **Rule card examples**: each rule card renders its `examples` — bad
  sentences under a localized "Flags" label (✗), good sentences under
  "Doesn't flag" (✓). The sentences themselves are in the rule's language
  by construction; only the two labels are i18n keys (`exampleFlagged`,
  `exampleNotFlagged`, all seven locales). This turns the rules view into
  the user-facing rule documentation.
- **Profile card** (ProfilesView): a "Rule packs" chip row under the
  existing rule settings — one chip per discovered pack of the profile's
  language, toggling membership in `packs_on` (multi-select chips, visual
  style of the tier chips).
- **Check flow**: the store's effective rule_config (profile + local edits)
  simply carries `packs_on`; no controller logic changes.
- **i18n**: display names for the three seeded packs (`packMarketing`,
  `packTechdocs`, `packBlog`) in all seven locales; unknown slugs fall back
  to the title-cased slug ("legal-writing" → "Legal writing").

## 4. Seeding

`seed_profiles` seeds per language, for en and de in this phase:

| Profile | packs_on | Example text |
|---|---|---|
| Standard | `[]` | existing |
| Marketing | `["marketing"]` | existing text, extended to trigger the new marketing rules |
| Technical docs | `["techdocs"]` | new: a short install/usage instruction with third-person user, future tense, "simply", "please", e.g./i.e. |
| Blog | `["blog"]` | new: a post opener with throat-clearing, rhetorical questions |

Seeding fills an empty profiles table only (unchanged); existing
installations keep their profiles and can enable packs via the profile card.
Other languages keep their current Standard/Marketing seeds until their
phase adds pack rules (an enabled pack with no rules is a no-op).

## 5. Rule roster — English

Severity policy: **error** = near-certain, **warning** = heuristic with
POS/morph context, **suggestion** = taste. Substitution messages follow the
existing two-placeholder idiom ("Use '%s' instead of '%s'."); swap keys are
regex fragments wrapped in `\b…\b` by the engine, so inflected variants can
be expressed inline („Standart(s)?“). Lists below name the minimum entries;
the implementation plan fixes the full lists.

### General (pack: none)

| id | extends | level | Flags |
|---|---|---|---|
| grammar.could-of | substitution | error | "could of" → "could have"; also should/would/must/might of |
| grammar.fewer-less | token_pattern | warning | `{LOWER: less}` + `{POS: NOUN, MORPH: {IS_SUPERSET: [Number=Plur]}}` — "less bugs" → "fewer bugs" |
| grammar.dangling-participle | token_pattern | warning | sentence-initial `{TAG: VBG, IS_SENT_START: true}` … `{TEXT: ","}` `{LOWER: {IN: [it, there]}}` — "Walking home, it started to rain" |
| grammar.based-off | substitution | warning | "based off of" → "based on", "based off" → "based on" |
| style.hedging | existence | suggestion | "it seems that", "arguably", "may or may not", "to some extent", "for the most part" |
| style.double-negative | token_pattern | suggestion | `{LOWER: not}` + `{POS: ADJ, LOWER: {REGEX: "^(un|in|im|non)"}}` — "not uncommon" → consider "common" (guard list for non-negating stems: important, interesting, innovative, immediate, unique …) |
| style.weak-verb-adverb | dependency | suggestion | `advmod` -ly adverb on weak verbs (walk, run, say, look, go, move) — "ran quickly" → a stronger verb |
| clarity.noun-string | token_pattern | warning | `{POS: NOUN, OP: "{4,}"}` — 4+ stacked nouns ("server configuration management system update") |
| clarity.negative-phrasing | substitution | suggestion | "not able to" → "unable to", "does not have" → "lacks", "not possible" → "impossible" |

### Pack `marketing`

| id | extends | level | Flags |
|---|---|---|---|
| style.hype-words | existence | warning | "world-class", "revolutionary", "seamless", "best-in-class", "game-changing", "cutting-edge", "next-generation" |
| style.unverifiable-claims | existence | warning | "guaranteed", "#1", "the best", "market-leading", "award-winning" (unsubstantiated claim markers) |
| style.very-unique | substitution | warning | "very unique" → "unique", "most unique" → "unique", "completely unique" → "unique" |
| style.shouting-caps | existence | warning | `raw` regex for 2+ consecutive ALL-CAPS words (≥4 letters each; excludes acronym-length tokens) |

### Pack `techdocs`

| id | extends | level | Flags |
|---|---|---|---|
| style.third-person-user | token_pattern | warning | `{LOWER: the}` `{LEMMA: {IN: [user, customer, administrator]}}` `{LEMMA: {IN: [should, must, can, may]}}` — prefer direct address ("you") |
| style.future-tense-instruction | token_pattern | suggestion | `{LOWER: will}` `{POS: VERB}` — "the dialog will open" → present tense "opens" |
| style.condescension | existence | suggestion | "simply", "just", "obviously", "easy", "of course", "clearly" |
| style.latin-abbreviations | existence | suggestion | `raw`: `\be\.g\.`, `\bi\.e\.`, `\betc\.` — advise "for example" / "that is" / "and so on" in the message. (Not a substitution rule: the engine wraps swap keys in `\b…\b`, and a trailing `\b` after a period never matches before whitespace.) |

### Pack `blog`

| id | extends | level | Flags |
|---|---|---|---|
| style.throat-clearing | existence | suggestion | "in this post", "in this article", "welcome to my blog", "without further ado", "let's dive in" |

## 6. Rule roster — German

### General (pack: none)

| id | extends | level | Flags |
|---|---|---|---|
| grammar.das-dass | token_pattern | warning | `{TEXT: ","}` `{LOWER: das}` `{POS: PRON, MORPH: {IS_SUPERSET: [PronType=Prs]}}` — „Ich hoffe, das er kommt“ → „dass“ (Personalpronomen direkt nach „das“ schließt Relativsatz-Lesart weitgehend aus) |
| grammar.seit-seid | token_pattern | error | `{LOWER: seit}` `{LOWER: {IN: [ihr, wir]}}` — „Seit ihr fertig?“ → „Seid“ |
| grammar.wie-als | token_pattern | warning | `{MORPH: {IS_SUPERSET: [Degree=Cmp]}, POS: {IN: [ADJ, ADV]}}` `{LOWER: wie}` — „größer wie“ → „größer als“ |
| grammar.deppenapostroph | existence | warning | `raw`: `\w+'s\b` — „Anna's Laden“ → „Annas Laden“ |
| grammar.beliebte-fehler | substitution | error | „Standart“ → „Standard“, „wiederspiegeln“ → „widerspiegeln“, „Imbus“ → „Inbus“, „Gallerie“ → „Galerie“, „Reperatur“ → „Reparatur“ (inkl. flektierter Formen) |
| style.funktionsverbgefuege | token_pattern | suggestion | `{LEMMA: {IN: [durchführen, vornehmen, treffen, erfolgen, tätigen]}}` in Nachbarschaft eines -ung-Nomens (`{TEXT: {REGEX: "ung(en)?$"}}`, OP-Gap) — „eine Prüfung durchführen“ → „prüfen“; auch umgekehrte Reihenfolge („erfolgt die Anmeldung“) |
| style.amtsdeutsch | substitution | suggestion | „zwecks“ → „für“, „mittels“ → „mit“, „seitens“ → „von“, „diesbezüglich“ → „dazu“, „im Rahmen von“ → „bei“ |
| style.doppelmoppel | existence | suggestion | „bereits schon“, „einzig und allein“, „neu renoviert“, „runde Kugel“, „zukünftige Pläne“, „persönlich anwesend“ |
| clarity.genitivkette | token_pattern | warning | 3+ verkettete `{POS: DET}? {POS: NOUN}`-Genitivglieder — „die Prüfung der Umsetzung der Vorgaben der Behörde“ |
| clarity.verbklammer | token_pattern | suggestion | `{POS: VERB}` `{OP: "{8,}", TAG: {NOT_IN: [$., PTKVZ]}}` `{TAG: PTKVZ}` — weit getrennte Verbpartikel („schlägt … erst nach vielen Wörtern … vor“) |

### Pack `marketing`

| id | extends | level | Flags |
|---|---|---|---|
| style.superlativ-inflation | existence | warning | „einzigartig“, „revolutionär“, „weltklasse“, „bahnbrechend“, „unschlagbar“ |
| style.hype-anglizismen | existence | warning | „State of the Art“, „Game Changer“, „Must-have“, „Next Level“ |

### Pack `techdocs`

| id | extends | level | Flags |
|---|---|---|---|
| style.man-konstruktion | token_pattern | suggestion | `{LOWER: man}` `{POS: VERB}`-Umgebung — in Anleitungen direkte Anrede oder Imperativ bevorzugen |
| style.futur-in-anleitungen | token_pattern | suggestion | `{LEMMA: werden}` + Infinitiv-Gap (analog würde-Stil, aber `Mood=Ind`) — „Der Dialog wird sich öffnen“ → Präsens |
| style.bitte-in-anleitungen | existence | suggestion | „bitte“ — in technischen Anleitungen unnötig |
| style.e-mail-schreibung | substitution | warning | „Email“ → „E-Mail“, „Emails“ → „E-Mails“ (case-sensitiv, um „email“ in Code-Kontexten nicht zu treffen — `ignorecase: false`) |

### Pack `blog`

| id | extends | level | Flags |
|---|---|---|---|
| style.floskel-einstieg | existence | suggestion | „in diesem Beitrag“, „in diesem Artikel“, „heute möchte ich“, „ohne lange Vorrede“ |

## 7. Testing

- **Engine**: `is_active` truth-table tests (pack × packs_on × category_off ×
  exception); loader tests for invalid pack slugs and for missing/empty
  `examples` (both reported as RuleError).
- **Example-driven catalog test** (replaces per-rule golden tests): one
  parametrized pytest iterates every loaded rule and runs it in isolation
  against its own examples — each `bad` sentence must yield ≥1 finding
  with the rule's id, each `good` sentence must yield none. NLP rules
  follow the existing convention when a spaCy model is unavailable
  (skipped with a report). The heuristic false-positive guards from §5/§6
  live in the rules' `good` lists (e.g. das-dass: „Das Buch, das er
  gestern kaufte, ist spannend.“; double-negative: "not important";
  noun-string: three nouns).
- **API**: `/api/rules` carries pack, examples, and the packs index; a check
  with `packs_on: ["marketing"]` activates exactly the pack rules.
- **Frontend**: pack chip toggling maps to `packs_on` in save payloads;
  rules-view pack toggle; example rendering in the rule card; fallback
  display name for unknown slugs.

## 8. Documentation

- `backend/rules/README.md`: new rows incl. pack column; the NLP rules
  double as cookbook examples (each row's *Demonstrates* filled in).
- `docs/backend-architecture.md`: pack activation semantics.
- `docs/frontend-architecture.md`: pack UI (rules view, profile card).
- Main `README.md`: packs in the feature list / profiles section.
- `docs/LOGBOOK.md` entry.

## 9. Out of scope (later phases)

- **Phase 2 — Japanese**: ら抜き言葉, さ入れ言葉, 二重敬語, の連続, 冗長表現,
  い抜き言葉 (pack-gated), 〜と思います-hedging (techdocs); plus the
  `scope: document` occurrence extension for です・ます / だ・である
  consistency.
- **Phase 3 — FR/ES/IT/ZH**: pléonasmes, «pallier à», «après que»+subjonctif;
  queísmo, «habían muchos», redundancias; «a me mi», «qual'è», «piuttosto
  che»; 的/地/得, 「大约…左右」.
- Pack metadata beyond the slug (descriptions, authors) — YAGNI until a
  concrete need appears.
- LLM-prompt awareness of packs (the LLM checker is profile-instructed via
  `llm_instructions` already).
