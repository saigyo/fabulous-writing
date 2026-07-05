# Terminology Case Sensitivity — Design

Date: 2026-07-05
Status: approved (discussed and agreed in session)

## Problem

Two related shortcomings around the `case_sensitive` flag on terminology terms:

1. **The flag is half-implemented semantically.** Today it only controls whether
   *forbidden variants* match exact-case (`TerminologyChecker._check_regex` toggles
   `re.IGNORECASE`). The preferred term itself is never checked: with preferred
   "GitHub" (case-sensitive), the text "github" or "GITHUB" passes silently. It cannot
   be worked around with variants — a case-insensitive variant "github" would also
   flag every correctly-cased "GitHub".
2. **The UI control is cryptic and breaks visually.** The add-term row shows a bare
   checkbox with the text "Aa" inside an inline `<label>`; when the last table column
   narrows, the label wraps between checkbox and text (checkbox stacked above "Aa"),
   and checkbox/text baselines differ per browser. The only explanation is a hover
   tooltip. Worse, the flag is **write-only**: existing rows never show whether a term
   is case-sensitive.

## Design

### Semantics: one flag — "casing matters for this term"

`case_sensitive: true` on a term now means two things:

1. **Forbidden variants match exact-case only** (existing behavior, unchanged).
2. **Wrong casing of the preferred term is flagged** (new): occurrences of the
   preferred term in any casing *other than the stored one* become terminology
   findings, with the correctly-cased preferred form as the one-click suggestion.
   Message shape reuses the existing one: `Use 'GitHub' instead of 'Github'.`
   (+ definition, if any); severity `error`, category `terminology`, rule id
   `terminology.<term-id>` — same as variant findings.

For `case_sensitive: false` (the default) nothing changes: any casing of the
preferred term is acceptable and only variants are flagged.

### Sentence-start exception

A lowercase preferred term ("sign in") must not be flagged when conventionally
capitalized at a sentence start ("Sign in to your account."). A match is therefore
accepted if:

- it equals the preferred form exactly, **or**
- it equals the preferred form with only the first letter uppercased **and** it sits
  at a *sentence start*.

*Sentence start* is a deliberate heuristic (no spaCy dependency): position 0 of the
text, or preceded by sentence-ending punctuation (`.`, `!`, `?`, `…`, optionally
followed by closing quotes/brackets) plus whitespace, or preceded by a newline
optionally followed by markdown structure characters (list markers, heading `#`,
blockquote `>`). Mid-sentence "Sign In" or "SIGN IN" is always flagged.

Terms whose preferred form already starts with an uppercase letter or a non-cased
character (brand names, CJK) are unaffected by the exception: the capitalized variant
equals the preferred form itself.

### Overlap suppression

A wrong-casing match may overlap a forbidden-variant match (e.g. variant
"Github Enterprise" containing a miscased "Github"). Variant findings win: a
preferred-casing finding whose span overlaps any forbidden-variant finding of the
same check run is dropped.

### Matching per language path

Mirrors the three existing variant-matching paths in `TerminologyChecker`:

- **Regex path** (non-CJK): case-insensitive `\b…\b` search for the preferred term
  of each case-sensitive term; flag matches that fail the acceptance rule above.
- **CJK PhraseMatcher path**: an additional `PhraseMatcher(attr="LOWER")` over the
  preferred forms of case-sensitive terms; flag matched spans whose text differs from
  the preferred form (subject to the sentence-start exception). This matters for
  Latin terms embedded in Japanese/Chinese text ("GitHub" in Japanese docs); pure CJK
  strings have no case, lowercasing is the identity, so they never produce findings.
- **CJK substring fallback** (no spaCy model): lowercased substring search,
  same comparison.

### UI: match-case toggle + row badge

Replaces the checkbox (option 1 from the session discussion):

- **Add row:** the checkbox+label is replaced by a small toggle **button** labeled
  "Aa" — the match-case convention from editor search fields. It sits *inside the
  forbidden-variants cell*, right of the input (that is the field whose matching it
  primarily controls), in a flex wrapper so nothing can wrap. Pressed state is
  communicated via `aria-pressed` and a visible accent style; the existing localized
  tooltip (`caseSensitiveTitle`, "Case-sensitive matching") is kept as `title`.
  The last cell then contains only the Add button.
- **Existing rows:** terms with `case_sensitive: true` show a small "Aa" badge after
  their forbidden variants, with the same tooltip — the flag is no longer write-only.
- `.case-label` CSS is removed; new `.input-with-toggle`, `.match-case-toggle`,
  `.case-badge` styles are added.

No new i18n keys: the existing `caseSensitiveTitle` message serves toggle and badge
in all seven locales. The "Aa" glyph itself is locale-neutral by convention.

## Not in scope

- Editing existing terms (including toggling their case sensitivity) — separate
  feature; delete + re-add remains the workaround.
- Localizing backend finding messages (rule/terminology messages are
  English-authored throughout the backend today).
- No API or DB changes: `case_sensitive` is already stored and transported.

## Testing

- **Backend (pytest, TDD):** wrong-casing flagged with correct span/suggestion;
  correct casing not flagged; case-insensitive terms never casing-checked;
  sentence-start exception (start of text, after `.`/`!`/`?` + space, after newline;
  mid-sentence capitalized still flagged; ALL-CAPS at sentence start still flagged);
  overlap suppression; CJK path with embedded Latin term (model present) and
  substring fallback (bogus model).
- **Frontend:** the repo has no component-test harness (pure-logic vitest only), and
  this change is JSX/CSS with no extractable logic — verified by lint, build, and
  live browser check; the terminology screenshot is refreshed.
