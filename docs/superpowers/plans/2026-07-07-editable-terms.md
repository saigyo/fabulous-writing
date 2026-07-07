# Editable Terms & Domain Rename Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Terms in the terminology table and domain names in the domain list become editable in place (spec: `docs/superpowers/specs/2026-07-07-editable-terms-design.md`).

**Architecture:** Frontend-only. The backend partial-update endpoints (`PUT /api/terms/{id}`, `PUT /api/domains/{id}`) and the client's `updateTerm` already exist. A row edit mode is added to `TermTable` reusing the add-term row's widgets via a shared `TermFieldCells` component driven by a `TermDraft` object; pure draft/parse helpers live in `termTable.ts` (test-first). Domain rename swaps the name for an input on ✎ or double-click.

**Tech Stack:** React 19 + TypeScript, vitest, zustand store, plain CSS in `App.css`. All commands run from `frontend/`.

**Conventions:** Commits go directly on `main` and are pushed. Commit messages end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` (add this to every commit below; omitted in the snippets for brevity).

---

## File map

| File | Change |
|---|---|
| `frontend/src/terminology/termTable.ts` | Add `TermDraft`, `parseVariants`, `termToDraft`, `draftToTermPayload` |
| `frontend/src/terminology/termTable.test.ts` | Tests for the four additions (written first) |
| `frontend/src/api/client.ts` | Add `updateDomain` |
| `frontend/src/i18n/messages.ts` + `en,de,es,fr,it,ja,zh.ts` | 4 new keys |
| `frontend/src/terminology/TerminologyView.tsx` | Row edit mode, add-row refactor, domain rename |
| `frontend/src/App.css` | `.domain-row input` styling |
| `docs/frontend-architecture.md`, `docs/LOGBOOK.md` | Docs |

### Task 1: Draft/parse helpers in termTable.ts (TDD)

**Files:**
- Modify: `frontend/src/terminology/termTable.ts`
- Test: `frontend/src/terminology/termTable.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `frontend/src/terminology/termTable.test.ts` (the file already imports `Term` and has a `term()` factory at the top — reuse them). Extend the existing import line from `'./termTable'` with the new names:

```typescript
import {
  draftToTermPayload,
  filterTerms,
  parseVariants,
  sortTerms,
  termToDraft,
  toggleSort,
  type SortCriterion,
  type TermDraft,
} from './termTable'
```

Append at the end of the file:

```typescript
describe('parseVariants', () => {
  test('splits on commas and trims', () => {
    expect(parseVariants(' login,  log-in ,sign-on')).toEqual(['login', 'log-in', 'sign-on'])
  })

  test('drops empty entries', () => {
    expect(parseVariants('login,, ,')).toEqual(['login'])
    expect(parseVariants('')).toEqual([])
  })
})

describe('termToDraft', () => {
  test('joins variants with a comma and space', () => {
    const draft = termToDraft(
      term({ id: 7, language: 'de', preferred: 'Anwendung', forbidden_variants: ['App', 'Applikation'], definition: 'Software', case_sensitive: true }),
    )
    expect(draft).toEqual({
      language: 'de',
      preferred: 'Anwendung',
      variants: 'App, Applikation',
      definition: 'Software',
      caseSensitive: true,
    })
  })
})

describe('draftToTermPayload', () => {
  const draft: TermDraft = {
    language: 'en',
    preferred: '  sign in ',
    variants: 'login, log-in',
    definition: ' authenticate ',
    caseSensitive: false,
  }

  test('trims fields and parses variants', () => {
    expect(draftToTermPayload(draft)).toEqual({
      language: 'en',
      preferred: 'sign in',
      forbidden_variants: ['login', 'log-in'],
      definition: 'authenticate',
      case_sensitive: false,
    })
  })

  test('returns null when preferred is empty', () => {
    expect(draftToTermPayload({ ...draft, preferred: '   ' })).toBeNull()
  })

  test('round-trips a term through draft and payload', () => {
    const original = term({ id: 9, preferred: 'email', forbidden_variants: ['e-mail', 'E-Mail'] })
    expect(draftToTermPayload(termToDraft(original))).toEqual({
      language: original.language,
      preferred: original.preferred,
      forbidden_variants: original.forbidden_variants,
      definition: original.definition,
      case_sensitive: original.case_sensitive,
    })
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --run src/terminology/termTable.test.ts`
Expected: FAIL — `parseVariants`, `termToDraft`, `draftToTermPayload`, `TermDraft` are not exported.

- [ ] **Step 3: Implement the helpers**

Append to `frontend/src/terminology/termTable.ts`:

```typescript
// Draft of a term as authored in the table's input widgets: forbidden
// variants are one comma-separated string, exactly like the add-term row.
export interface TermDraft {
  language: Language
  preferred: string
  variants: string
  definition: string
  caseSensitive: boolean
}

export function parseVariants(input: string): string[] {
  return input
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean)
}

export function termToDraft(term: Term): TermDraft {
  return {
    language: term.language,
    preferred: term.preferred,
    variants: term.forbidden_variants.join(', '),
    definition: term.definition,
    caseSensitive: term.case_sensitive,
  }
}

/** Trimmed create/update payload, or null when the preferred term is empty. */
export function draftToTermPayload(
  draft: TermDraft,
): Omit<Term, 'id' | 'domain_id'> | null {
  const preferred = draft.preferred.trim()
  if (!preferred) return null
  return {
    language: draft.language,
    preferred,
    forbidden_variants: parseVariants(draft.variants),
    definition: draft.definition.trim(),
    case_sensitive: draft.caseSensitive,
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- --run src/terminology/termTable.test.ts`
Expected: PASS (all, including the pre-existing ones).

- [ ] **Step 5: Commit**

```bash
git add src/terminology/termTable.ts src/terminology/termTable.test.ts
git commit -m "feat(terminology): draft/parse helpers for term editing"
git push
```

### Task 2: updateDomain client function + i18n keys

**Files:**
- Modify: `frontend/src/api/client.ts:132-133`
- Modify: `frontend/src/i18n/messages.ts`, `frontend/src/i18n/{en,de,es,fr,it,ja,zh}.ts`

No unit tests here: the client module has none (thin fetch wrappers), and the i18n test suite (`catalogs` key-parity tests in `src/i18n/i18n.test.ts`) plus the `Messages` type already enforce that every locale gets every key — the compile and existing tests are the check.

- [ ] **Step 1: Add updateDomain to the client**

In `frontend/src/api/client.ts`, directly after `createDomain` (line ~131), add:

```typescript
export const updateDomain = (id: number, name: string) =>
  request<Domain>(`/api/domains/${id}`, {
    method: 'PUT',
    body: JSON.stringify({ name }),
  })
```

(The backend `DomainUpdate` model has all-optional fields; sending only `name` leaves the description untouched.)

- [ ] **Step 2: Add the i18n keys**

In `frontend/src/i18n/messages.ts`, after `caseSensitiveTitle: string` (line ~103), add:

```typescript
  editTermTitle: string
  saveEditTitle: string
  cancelEditTitle: string
  renameDomainTitle: string
```

In each locale file, add the four keys after its `caseSensitiveTitle` line:

`en.ts`:
```typescript
  editTermTitle: 'Edit term',
  saveEditTitle: 'Save changes',
  cancelEditTitle: 'Discard changes',
  renameDomainTitle: 'Rename domain',
```

`de.ts`:
```typescript
  editTermTitle: 'Begriff bearbeiten',
  saveEditTitle: 'Änderungen speichern',
  cancelEditTitle: 'Änderungen verwerfen',
  renameDomainTitle: 'Domäne umbenennen',
```

`es.ts`:
```typescript
  editTermTitle: 'Editar término',
  saveEditTitle: 'Guardar cambios',
  cancelEditTitle: 'Descartar cambios',
  renameDomainTitle: 'Renombrar dominio',
```

`fr.ts`:
```typescript
  editTermTitle: 'Modifier le terme',
  saveEditTitle: 'Enregistrer les modifications',
  cancelEditTitle: 'Annuler les modifications',
  renameDomainTitle: 'Renommer le domaine',
```

`it.ts`:
```typescript
  editTermTitle: 'Modifica termine',
  saveEditTitle: 'Salva le modifiche',
  cancelEditTitle: 'Annulla le modifiche',
  renameDomainTitle: 'Rinomina dominio',
```

`ja.ts`:
```typescript
  editTermTitle: '用語を編集',
  saveEditTitle: '変更を保存',
  cancelEditTitle: '変更を破棄',
  renameDomainTitle: 'ドメイン名を変更',
```

`zh.ts`:
```typescript
  editTermTitle: '编辑术语',
  saveEditTitle: '保存更改',
  cancelEditTitle: '放弃更改',
  renameDomainTitle: '重命名领域',
```

- [ ] **Step 3: Verify tests and build**

Run: `npm test -- --run` then `npm run build`
Expected: all tests pass (key-parity test confirms all seven locales), build green.

- [ ] **Step 4: Commit**

```bash
git add src/api/client.ts src/i18n
git commit -m "feat(terminology): updateDomain client + edit/rename i18n keys"
git push
```

### Task 3: Row edit mode in TermTable

**Files:**
- Modify: `frontend/src/terminology/TerminologyView.tsx` (the `TermTable` component and imports)

Replace the add-row's five separate `useState`s with one `TermDraft`, introduce a shared `TermFieldCells` component for the four input cells, and add edit state. This also gives the add row Enter-to-add for free (previously missing; Escape does nothing there).

- [ ] **Step 1: Update imports**

In `frontend/src/terminology/TerminologyView.tsx`, extend the two import blocks:

```typescript
import {
  createDomain,
  createTerm,
  deleteDomain,
  deleteTerm,
  getDomains,
  getTerms,
  updateTerm,
} from '../api/client'
```

```typescript
import {
  draftToTermPayload,
  filterTerms,
  sortTerms,
  termToDraft,
  toggleSort,
  type SortCriterion,
  type SortKey,
  type TermDraft,
} from './termTable'
```

- [ ] **Step 2: Rewrite TermTable state and handlers**

Replace the body of `TermTable` from the state declarations down to (and including) `addTerm` with:

```typescript
function TermTable({ domainId, terms, onChanged }: TermTableProps) {
  const languages = useStore((s) => s.languages) // still used by the toolbar's language filter
  const m = useMessages()
  const [addDraft, setAddDraft] = useState<TermDraft>({
    language: 'en',
    preferred: '',
    variants: '',
    definition: '',
    caseSensitive: false,
  })
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editDraft, setEditDraft] = useState<TermDraft | null>(null)
  const [sortCriteria, setSortCriteria] = useState<SortCriterion[]>([])
  const [languageFilter, setLanguageFilter] = useState<Language | null>(null)
  const [query, setQuery] = useState('')

  const visibleTerms = sortTerms(filterTerms(terms, languageFilter, query), sortCriteria)

  function onToggleSort(key: SortKey) {
    setSortCriteria((old) => toggleSort(old, key))
  }

  async function addTerm() {
    const payload = draftToTermPayload(addDraft)
    if (!payload) return
    await createTerm(domainId, payload)
    setAddDraft((d) => ({ ...d, preferred: '', variants: '', definition: '' }))
    onChanged()
  }

  function startEdit(term: Term) {
    setEditingId(term.id)
    setEditDraft(termToDraft(term))
  }

  function cancelEdit() {
    setEditingId(null)
    setEditDraft(null)
  }

  async function saveEdit() {
    if (editingId === null || editDraft === null) return
    const payload = draftToTermPayload(editDraft)
    if (!payload) return
    await updateTerm(editingId, payload)
    cancelEdit()
    onChanged()
  }
```

Note: the old `language/preferred/variants/definition/caseSensitive` states are removed from `TermTable`; `languages` stays (the toolbar's language filter uses it) and `TermFieldCells` reads its own copy from the store (Step 4).

- [ ] **Step 3: Rewrite the table body rows**

Replace the `visibleTerms.map(...)` block and the `<tr className="add-term">` block inside the `<tbody>` with:

```tsx
          {visibleTerms.map((term) =>
            term.id === editingId && editDraft ? (
              <tr key={term.id} className="term-edit-row">
                <TermFieldCells
                  draft={editDraft}
                  onChange={setEditDraft}
                  onSubmit={() => void saveEdit()}
                  onCancel={cancelEdit}
                />
                <td>
                  <button
                    className="icon-button"
                    title={m.saveEditTitle}
                    onClick={() => void saveEdit()}
                  >
                    ✓
                  </button>
                  <button className="icon-button" title={m.cancelEditTitle} onClick={cancelEdit}>
                    ✕
                  </button>
                </td>
              </tr>
            ) : (
              <tr key={term.id}>
                <td>{term.language}</td>
                <td>{term.preferred}</td>
                <td>
                  {term.forbidden_variants.join(', ')}
                  {term.case_sensitive && (
                    <span className="case-badge" title={m.caseSensitiveTitle}>
                      Aa
                    </span>
                  )}
                </td>
                <td>{term.definition}</td>
                <td>
                  <button
                    className="icon-button"
                    title={m.editTermTitle}
                    onClick={() => startEdit(term)}
                  >
                    ✎
                  </button>
                  <button
                    className="icon-button"
                    title={m.deleteTermTitle}
                    onClick={() => deleteTerm(term.id).then(onChanged)}
                  >
                    ✕
                  </button>
                </td>
              </tr>
            ),
          )}
          <tr className="add-term">
            <TermFieldCells draft={addDraft} onChange={setAddDraft} onSubmit={() => void addTerm()} />
            <td>
              <button onClick={() => void addTerm()}>{m.add}</button>
            </td>
          </tr>
```

- [ ] **Step 4: Add the shared TermFieldCells component**

Insert after the `TermTable` function (before `SortableHeaderProps`):

```tsx
interface TermFieldCellsProps {
  draft: TermDraft
  onChange: (draft: TermDraft) => void
  onSubmit: () => void
  /** Absent on the add row: Escape only applies to row edit mode. */
  onCancel?: () => void
}

// The four input cells shared by the add-term row and a row in edit mode.
function TermFieldCells({ draft, onChange, onSubmit, onCancel }: TermFieldCellsProps) {
  const languages = useStore((s) => s.languages)
  const m = useMessages()

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === 'Enter') onSubmit()
    if (event.key === 'Escape') onCancel?.()
  }

  return (
    <>
      <td>
        <select
          value={draft.language}
          onChange={(event) => onChange({ ...draft, language: event.target.value as Language })}
        >
          {languages.map((info) => (
            <option key={info.code} value={info.code}>
              {info.code}
            </option>
          ))}
        </select>
      </td>
      <td>
        <input
          value={draft.preferred}
          placeholder={m.preferredPlaceholder}
          onKeyDown={onKeyDown}
          onChange={(event) => onChange({ ...draft, preferred: event.target.value })}
        />
      </td>
      <td>
        <div className="input-with-toggle">
          <input
            value={draft.variants}
            placeholder={m.forbiddenPlaceholder}
            onKeyDown={onKeyDown}
            onChange={(event) => onChange({ ...draft, variants: event.target.value })}
          />
          <button
            type="button"
            className="match-case-toggle"
            aria-pressed={draft.caseSensitive}
            title={m.caseSensitiveTitle}
            onClick={() => onChange({ ...draft, caseSensitive: !draft.caseSensitive })}
          >
            Aa
          </button>
        </div>
      </td>
      <td>
        <input
          value={draft.definition}
          placeholder={m.definitionPlaceholder}
          onKeyDown={onKeyDown}
          onChange={(event) => onChange({ ...draft, definition: event.target.value })}
        />
      </td>
    </>
  )
}
```

(`React.KeyboardEvent` needs no extra import — `import { useEffect, useState } from 'react'` stays, and the qualified type comes from the global JSX namespace; if the compiler complains, use `import type { KeyboardEvent } from 'react'` and drop the qualifier.)

- [ ] **Step 5: Verify tests and build**

Run: `npm test -- --run` then `npm run build`
Expected: PASS / green build.

- [ ] **Step 6: Commit**

```bash
git add src/terminology/TerminologyView.tsx
git commit -m "feat(terminology): row edit mode for terms"
git push
```

### Task 4: Domain rename in the domain list

**Files:**
- Modify: `frontend/src/terminology/TerminologyView.tsx` (the `TerminologyView` component)
- Modify: `frontend/src/App.css` (domain-row input styling)

- [ ] **Step 1: Add rename state and handlers**

Add `updateDomain` to the client import in `TerminologyView.tsx`. Inside `TerminologyView`, after `removeDomain`, add:

```typescript
  const [renamingId, setRenamingId] = useState<number | null>(null)
  const [renameValue, setRenameValue] = useState('')

  function startRename(domain: { id: number; name: string }) {
    setRenamingId(domain.id)
    setRenameValue(domain.name)
  }

  async function saveRename() {
    const name = renameValue.trim()
    if (renamingId === null || !name) return // empty: stay open until corrected or cancelled
    await updateDomain(renamingId, name)
    setRenamingId(null)
    await refreshDomains()
  }
```

- [ ] **Step 2: Rewrite the domain row markup**

Replace the `domains.map(...)` block with:

```tsx
        {domains.map((domain) => (
          <div
            key={domain.id}
            className={`domain-row${domain.id === activeDomainId ? ' selected' : ''}`}
            onClick={() => setActiveDomainId(domain.id)}
          >
            {domain.id === renamingId ? (
              <input
                value={renameValue}
                autoFocus
                onClick={(event) => event.stopPropagation()}
                onChange={(event) => setRenameValue(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void saveRename()
                  if (event.key === 'Escape') setRenamingId(null)
                }}
                onBlur={() => setRenamingId(null)}
              />
            ) : (
              <span onDoubleClick={() => startRename(domain)}>{domain.name}</span>
            )}
            <button
              className="icon-button"
              title={m.renameDomainTitle}
              onClick={(event) => {
                event.stopPropagation()
                startRename(domain)
              }}
            >
              ✎
            </button>
            <button
              className="icon-button"
              title={m.deleteDomainTitle}
              onClick={(event) => {
                event.stopPropagation()
                void removeDomain(domain.id)
              }}
            >
              ✕
            </button>
          </div>
        ))}
```

Behavior notes (from the spec): Enter saves; Escape cancels; blur without Enter cancels (the save on Enter completes before the input unmounts, so the blur handler firing afterwards is harmless); double-click also selects the domain first via the row click — accepted. ✎ uses `stopPropagation` so it does not change the selection.

- [ ] **Step 3: Style the rename input**

In `frontend/src/App.css`, after the `.domain-row` rules (search for `.domain-row`), add:

```css
.domain-row input {
  flex: 1;
  min-width: 0;
  font-size: inherit;
}
```

- [ ] **Step 4: Verify tests and build**

Run: `npm test -- --run` then `npm run build`
Expected: PASS / green build.

- [ ] **Step 5: Commit**

```bash
git add src/terminology/TerminologyView.tsx src/App.css
git commit -m "feat(terminology): rename domains inline"
git push
```

### Task 5: End-to-end verification + docs

**Files:**
- Modify: `docs/frontend-architecture.md` (terminology section)
- Modify: `docs/LOGBOOK.md`
- Scratch: headless-Chrome script (scratchpad, not committed)

- [ ] **Step 1: E2E against the live dev servers**

Both dev servers run locally (frontend :5173, backend :8000). **Use a scratch domain created by the script — never touch existing domains.** Drive with `playwright-core` (chrome channel) from `frontend/` (so the import resolves), modeled on this session's earlier verification scripts. The script must:

1. Open `http://localhost:5173/`, go to the terminology view (`.view-switch button:nth-child(3)`).
2. Create a scratch domain (`e2e-edit-test`), add a term (preferred `colour`, variants `color`, definition `test`).
3. Click the row's ✎, change preferred to `colour (UK)`, toggle `Aa`, press Enter; assert the row shows `colour (UK)` and the `Aa` badge, and that `GET /api/domains/{id}/terms` returns the updated fields.
4. Re-enter edit, press Escape; assert the row is unchanged.
5. Rename the scratch domain to `e2e-edit-test-renamed` via ✎ + Enter; assert the list shows the new name.
6. Delete the scratch domain (cleanup) and assert it is gone.

Expected: all assertions pass; capture a screenshot of the row in edit mode.

- [ ] **Step 2: Update docs**

In `docs/frontend-architecture.md`, find the terminology paragraph and extend it with one sentence: terms support in-place row editing (shared `TermFieldCells` between the add row and edit mode; drafts and parsing in `termTable.ts`), and domains rename inline via ✎/double-click.

Append a LOGBOOK entry (`docs/LOGBOOK.md`): what shipped, the row-edit design choice, and the e2e evidence summary.

- [ ] **Step 3: Full test suite + build one last time**

Run: `npm test -- --run && npm run build`
Expected: green.

- [ ] **Step 4: Commit**

```bash
git add docs/frontend-architecture.md docs/LOGBOOK.md
git commit -m "docs: editable terms + domain rename (architecture, logbook)"
git push
```
