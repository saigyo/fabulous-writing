# B43 C3: ContentEditable Adapter — Design

**Date:** 2026-09-12
**Status:** Approved concept, pre-implementation
**Parent:** docs/superpowers/specs/2026-08-22-b43-embeddable-clients-design.md (umbrella;
this spec details slice C3, which that document defers to "its own spec on pickup")
**Issue:** #134 (C3 checklist item)

## Goal

A `FieldAdapter` for contentEditable editing hosts, proving the umbrella spec's
capability model: the adapter ships **without any protocol, embed, or backend
change** — that absence is C3's exit criterion. Markings use the CSS Custom
Highlight API; replacement is Range-based best-effort, exactly as the umbrella
spec pre-declared.

**Acceptance benchmark (decided at pickup):** plain/lightly-formatted
contentEditable is the reliable target — the extension e2e fixture page plus one
real plain-contentEditable site (e.g. Gmail compose). Additionally one
**framework-editor smoke test** (a Lexical editor, e.g. Reddit's comment
composer) with the observed behavior *documented*, not required to pass: the bar
there is "degrade gracefully, never corrupt."

## Non-goals

- No overlay fallback where the Custom Highlight API is unavailable — the
  adapter reports `mark: 'none'` and the sidebar remains fully functional.
  (Geometry-mirroring an arbitrary rich-text DOM is exactly the trap the
  Highlight API exists to avoid.)
- No formatting-preserving replacement guarantees inside framework editors
  (ProseMirror/Lexical/Quill own their DOM; we go through the browser's editing
  pipeline and verify afterwards — see Replacement).
- No `<input>` adapter (still future work, per detect.ts's own note).
- No protocol, embed surface, or backend changes of any kind.

## Adapter core

New module `frontend/src/simulator/contentEditableAdapter.ts` exporting
`createContentEditableAdapter(root: HTMLElement): FieldAdapter` — same home,
role, and lift path as `textareaAdapter.ts`: reference implementation backing
the simulator's demo field, imported directly by the extension's `session.ts`.

### Text model: the segment map

The adapter's single source of truth for text↔DOM correspondence. A TreeWalker
pass over the editing root collects every text node with its flat UTF-16 start
offset. Rules:

- **Skipped subtrees:** `script`, `style`, `noscript`, `template`.
- **Newline synthesis:** one `'\n'` per `<br>`, and one `'\n'` at each
  block-element boundary from a fixed tag set (`address`, `article`, `aside`,
  `blockquote`, `div`, `dd`, `dl`, `dt`, `fieldset`, `figcaption`, `figure`,
  `footer`, `form`, `h1`–`h6`, `header`, `hr`, `li`, `main`, `nav`, `ol`, `p`,
  `pre`, `section`, `table`, `tr`, `td`, `th`, `ul` — one exported constant,
  the module's single authority), emitted only between
  content (no leading newline, no doubled newlines from nested empty blocks).
  Synthetic newlines belong to no text node; the map records the positions.
- **Deterministic and DOM-based**, deliberately diverging from CSS-driven
  `innerText` (which depends on computed styles and layout). Offsets are UTF-16
  code units — the protocol's normative unit, so astral characters need tests
  but no conversion on the host side.

The map powers everything:

- `extract()`: concatenation of segments and synthetic newlines.
- Flat offset → `(node, offset)`: for building marking/replacement Ranges.
- DOM position → flat offset: for click-to-select caret mapping.

Rebuilt on every change tick (below); never patched incrementally in v1.

### Markings: CSS Custom Highlight API

- One `Highlight` object per severity (registered as `fw-<severity>`), plus
  `fw-selected` and `fw-flash`; `Highlight.priority` orders selection/flash
  above severity colors.
- A once-per-document injected `<style>` carries the `::highlight(fw-…)` rules —
  paint-only properties (background-color, text-decoration), same palette as
  the extension's MARKS_CSS. `::highlight()` styling only applies from real
  stylesheets, hence the injection; it is idempotent (keyed element id).
- `setMarkings(spans)` stores the spans and builds Ranges via the segment map
  with the same clamp/drop semantics as the textarea adapter's `render()`
  (clamp to text length, drop empty). Overlapping findings need no
  partitioning here: multiple Highlights paint independently, and
  `fw-selected`/`fw-flash` carry their own single-finding Ranges.
- Ranges are **re-anchored on every change tick** (rebuilt from stored spans
  against the fresh segment map), so they never dangle after DOM mutations.
- The Highlight API mutates no DOM → it cannot trigger the adapter's own
  MutationObserver, and there is no geometry syncing at all — no overlay, no
  drift interval, none of the textarea adapter's mirror machinery.
- **Feature gate:** if `CSS.highlights` is undefined, `capabilities()` reports
  `mark: 'none'` and all marking methods no-op. The registry is accessed
  through a small feature-detect seam (an injectable accessor) so unit tests
  under happy-dom can stub a Map-like fake.
- `capabilities()`: `{ mark: 'native', replace: 'best-effort' }` (or
  `mark: 'none'` per the gate).
- `flashFinding(id)`: scroll the finding's start into view
  (`block: 'nearest'` on the start node's element ancestor), add the finding's
  Range to `fw-flash` for the same 700 ms the textarea adapter uses.
- `setSelected(id | null)`: maintain the `fw-selected` Highlight; null clears.

### Change detection

Two sources, one coalesced handler:

- `input` event on the editing root — user edits, including inside framework
  editors.
- A subtree MutationObserver (`childList` + `characterData`, subtree) — catches
  programmatic/framework rewrites that fire no `input` (model-driven
  re-renders, sanitizer passes).

Both coalesce into one microtask tick that rebuilds the segment map, re-anchors
all Highlight Ranges, and fires the `onChange` callback (the session then sends
`textChanged` with a fresh `extract()`).

### Replacement: best-effort, self-healing

Order matters; each step refuses with `{ ok: false, text: extract() }` on
failure:

1. **Validate the vector** — integers, `0 ≤ from ≤ to ≤ text.length` — before
   any comparison, same reasoning as the textarea adapter (clamping must never
   legitimize a stale request).
2. **Verify `expectedText`** against the current extraction's `[from, to)`.
3. **Apply:** save the currently focused element (through shadow roots, as the
   textarea adapter does), focus the root with `preventScroll`, set the
   selection to the mapped Range, then `document.execCommand('insertText',
   false, insert)` — the real editing pipeline: native undo preserved,
   `beforeinput`/`input` fire, framework editors interpret the edit through
   their own model. Where execCommand is absent or returns false: Range
   surgery (`deleteContents()` + `insertNode(text)`) plus a bubbling synthetic
   `InputEvent` — the happy-dom-tested branch.
4. **Post-verify:** re-extract and check that `insert` actually occupies
   `[from, from + insert.length)`. A framework that rewrote the result yields
   `ok: false` with the real text — the embed re-syncs from the echo instead of
   desyncing. Degrade gracefully, never corrupt.
5. Restore focus and return `{ ok, text: extract() }`.

`dispose()`: remove listeners/observer, clear the adapter's Highlight
registrations (shared style element stays — it is inert without registrations).

## Extension integration (no protocol changes)

- **`detect.ts`:** eligibility extends to *editing hosts* — `el.isContentEditable`
  with a non-editable parent (the root of the editable region, not inner
  nodes), same `MIN_FIELD_WIDTH/HEIGHT`, same disabled/readonly analogue
  (`contenteditable="false"` ancestors are already excluded by
  `isContentEditable`). The eligible type widens from `HTMLTextAreaElement` to
  `EligibleField = HTMLTextAreaElement | HTMLElement`; focus/hover targets
  resolve inner nodes up to their editing root (focusin inside a rich field
  lands on descendants).
- **`session.ts`:** choose the adapter by element kind (`createTextareaAdapter`
  vs `createContentEditableAdapter`); `meta.fieldKind: 'contenteditable'`
  (free-form string on the wire — no protocol change). Click-to-select reads
  the caret from `document.getSelection()` mapped through the segment map
  (exposed by the adapter for this purpose) instead of `selectionStart`, then
  the same `findingIdAt` cycling. The caret accessor is an **extra method on
  the factory's return type** (`FieldAdapter & { caretOffset(): number | null }`),
  NOT an addition to `FieldAdapter` in `protocol.ts` — the shared protocol
  module stays byte-identical, per the exit criterion.
- **`reacquire.ts`:** fingerprint generalized — id/aria-label when unique at
  capture (same F1 rule), else index among *editing roots* in the same scope;
  the form/document scoping rules (F2) carry over unchanged.
- **`scout.ts`:** type widening and root-resolution only; affordance,
  grace-window, and registry logic untouched.

## Simulator

A second demo field — a contentEditable `<div>` with light inline markup
(a `<strong>`/`<em>`/`<br>`-bearing sample) — with its own Connect button.
Connecting either field replaces the other, per the protocol's one-connected-
field rule; `main.ts` generalizes its `fieldEl`/`adapter` pair to an active
field/adapter selection. The desync probe (`?desync=1`) keeps working against
whichever field is connected.

## Testing

- **Frontend vitest (happy-dom):** segment-map semantics — nested inline
  markup, `<br>` and block boundaries, empty blocks, astral characters;
  offset→Range resolution; caret→offset mapping; replacement validate/verify/
  refuse paths, the surgery fallback branch, and post-verification (a test
  host that rewrites the DOM on input proves the `ok: false` re-sync path);
  Highlight registry behavior via the Map-like stub (per-severity sets,
  selected/flash lifecycle, re-anchoring after mutations); `mark: 'none'`
  gate when the registry accessor returns undefined. Mutation-verified guard
  tests per house rule (restore by re-editing, never `git checkout`).
- **Extension vitest:** detect eligibility (editing host vs inner node vs
  `contenteditable="false"`), session adapter selection + fieldKind +
  selection-based click mapping, reacquire fingerprint generalization.
- **Playwright e2e (real Chromium — real Highlight API and execCommand):**
  fixture page gains a contentEditable field: connect → login → type →
  findings → `CSS.highlights` registrations asserted → apply suggestion → DOM
  text replaced and re-checked → undo (Ctrl+Z) restores; desync-refusal probe
  against the contentEditable field.
- **Acceptance (manual checklist):** plain-contentEditable benchmark on a real
  site (e.g. Gmail compose): connect, findings, highlights, replacement,
  undo. Framework smoke test on a Lexical editor (e.g. Reddit's composer):
  observed behavior documented in the checklist results; required outcome is
  only graceful degradation (refusals over corruption).

## Risks & mitigations

- **Framework editors reverting edits** → post-verification returns
  `ok: false` and the embed re-syncs from the echo (protocol already treats
  nothing as applied until `replaceResult` confirms).
- **Highlight ranges dangling after DOM rewrites** → ranges are rebuilt from
  stored spans on every change tick, never reused across mutations.
- **happy-dom gaps** (no `CSS.highlights`, no `execCommand`) → both sit behind
  seams that unit tests stub or that fall back to the tested branch, same
  pattern the textarea adapter established.
- **Newline-model divergence from what the backend sees** → the embed checks
  exactly the extracted text; findings offsets are relative to that same text,
  so consistency, not visual fidelity, is what correctness needs. The
  deterministic DOM rule is documented in the module comment.
