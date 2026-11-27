import { useCallback, useEffect, useRef, useState } from 'react'
import {
  createDomain,
  deleteDomain,
  getConcept,
  getConcepts,
  getDomains,
  HttpError,
  updateDomain,
} from '../api/client'
import { hasFeature } from '../auth/policy'
import { sessionGeneration } from '../auth/session'
import { useCrudError } from '../hooks/useCrudError'
import { ConfirmDialog } from '../ui/ConfirmDialog'
import { useLocale, useMessages } from '../i18n'
import { useStore } from '../state/store'
import type { Concept, Language, TransferOutcome } from '../types'
import { ConceptEntry } from './ConceptEntry'
import { ConceptList } from './ConceptList'

interface OpenConcept {
  conceptId: number | null
  language: Language
}

export function TerminologyView() {
  const domains = useStore((s) => s.domains)
  const setDomains = useStore((s) => s.setDomains)
  const user = useStore((s) => s.user)
  const isAdmin = user?.is_admin ?? false
  const canCreate = hasFeature(user, 'custom_domains')
  // Bumped only by login() committing (see its own comment in
  // state/store.ts) — including the silent same-user re-login the
  // password-change flow performs (auth/AccountMenu.tsx). Depending on it
  // below re-fires the mount effect on that re-login, so a pre-login
  // refreshDomains() call still in flight at that moment gets a replacement
  // instead of being discarded with nothing to follow it (Copilot round-9
  // U2, same mechanism as Header's domains fetch in App.tsx).
  const authGeneration = useStore((s) => s.authGeneration)
  const [activeDomainId, setActiveDomainId] = useState<number | null>(null)
  const [concepts, setConcepts] = useState<Concept[]>([])
  const [open, setOpen] = useState<OpenConcept | null>(null)
  // Set together with `open`, so a late answer compares against the entry
  // shown from the moment it changes, not from the next effect.
  const openRef = useRef<OpenConcept | null>(null)
  const showEntry = useCallback((next: OpenConcept | null) => {
    openRef.current = next
    setOpen(next)
  }, [])
  // The entry builds its state once from the concept it is given; raised on
  // each merge or move so it starts over from the patched list.
  const [transfers, setTransfers] = useState(0)
  const [pendingDelete, setPendingDelete] = useState<{ id: number; name: string; count: number } | null>(null)
  const [newDomain, setNewDomain] = useState('')
  const [newShared, setNewShared] = useState(false)
  const unsaved = useStore((s) => s.terminologyUnsaved)
  const setUnsaved = useStore((s) => s.setTerminologyUnsaved)
  const [pendingLeave, setPendingLeave] = useState<(() => void) | null>(null)
  const m = useMessages()
  const locale = useLocale()
  const [listLanguage, setListLanguage] = useState<Language>(locale)
  const { error, run } = useCrudError(m.changeFailed)

  useEffect(() => {
    if (!unsaved) return
    const hold = (event: BeforeUnloadEvent) => event.preventDefault()
    window.addEventListener('beforeunload', hold)
    return () => window.removeEventListener('beforeunload', hold)
  }, [unsaved])

  function leaveEntry(action: () => void) {
    if (unsaved) setPendingLeave(() => action)
    else action()
  }

  // Only the latest request's answer is applied. A superseded call settles
  // with the latest one, so a caller that awaits it sees the list applied.
  const domainsRequestRef = useRef(0)
  const latestDomainsRef = useRef<Promise<void>>(Promise.resolve())
  const refreshDomains = useCallback(() => {
    const gen = sessionGeneration()
    const requestId = ++domainsRequestRef.current
    const request: Promise<void> = getDomains().then((domains) => {
      if (sessionGeneration() !== gen) return
      if (domainsRequestRef.current !== requestId) return latestDomainsRef.current
      setDomains(domains)
    })
    latestDomainsRef.current = request
    return request
  }, [setDomains])

  useEffect(() => {
    void refreshDomains()
  }, [refreshDomains, authGeneration])

  useEffect(() => {
    const missing = activeDomainId === null || !domains.some((d) => d.id === activeDomainId)
    if (missing && domains.length > 0) {
      setActiveDomainId(domains[0].id)
    }
  }, [domains, activeDomainId])

  // Guard policy composed of two independent checks:
  // - the request counter orders same-domain fetches, so a stale fetch for
  //   the CURRENT domain (e.g. an in-flight load superseded by a newer one)
  //   is discarded instead of overwriting more recent rows;
  // - activeDomainRef rejects cross-domain starts and completions, so a
  //   fetch for a domain the user has since switched away from cannot
  //   apply its rows. Late answers from an entry (conceptSaved,
  //   conceptGone, removeDomain) read it to act on the domain shown when
  //   they arrive; it is null once the view has unmounted.
  const activeDomainRef = useRef<number | null>(null)
  useEffect(
    () => () => {
      activeDomainRef.current = null
    },
    [],
  )
  const conceptsRequestRef = useRef(0)
  const conceptsPendingRef = useRef(false)
  const loadConcepts = useCallback((domainId: number) => {
    if (activeDomainRef.current !== domainId) return Promise.resolve()
    const requestId = ++conceptsRequestRef.current
    conceptsPendingRef.current = true
    return getConcepts(domainId)
      .then((fetched) => {
        if (conceptsRequestRef.current === requestId && activeDomainRef.current === domainId) {
          setConcepts(fetched)
        }
      })
      // A failed list load leaves the list as it is; nothing awaits it.
      .catch(() => {})
      .finally(() => {
        if (conceptsRequestRef.current === requestId) conceptsPendingRef.current = false
      })
  }, [])

  useEffect(() => {
    // Clear immediately on domain change so the previous domain's rows never
    // stay interactive (or visible) while the new domain's fetch is in flight.
    activeDomainRef.current = activeDomainId
    setConcepts([])
    showEntry(null)
    if (activeDomainId !== null) {
      void loadConcepts(activeDomainId)
    }
  }, [activeDomainId, loadConcepts, showEntry])

  const [creating, setCreating] = useState(false)
  function addDomain() {
    const name = newDomain.trim()
    if (!name || creating) return
    leaveEntry(() =>
      void run(async () => {
        setCreating(true)
        try {
          showEntry(null)
          const domain = await createDomain(name, newShared)
          setNewDomain('')
          setNewShared(false)
          await refreshDomains()
          if (!useStore.getState().terminologyUnsaved) setActiveDomainId(domain.id)
        } finally {
          setCreating(false)
        }
      }),
    )
  }

  const deleteAskRef = useRef(0)
  async function askRemoveDomain(domain: { id: number; name: string }) {
    const ask = ++deleteAskRef.current
    await run(async () => {
      const inDomain = await getConcepts(domain.id)
      if (ask !== deleteAskRef.current) return
      if (!useStore.getState().domains.some((d) => d.id === domain.id)) return
      const count = inDomain.filter((c) => c.domain_ids.length === 1).length
      setPendingDelete({ id: domain.id, name: domain.name, count })
    })
  }

  async function removeDomain(id: number) {
    if (activeDomainRef.current === id) showEntry(null)
    await run(async () => {
      await deleteDomain(id)
      try {
        await refreshDomains()
      } catch (e) {
        setDomains(useStore.getState().domains.filter((d) => d.id !== id))
        throw e
      } finally {
        if (activeDomainRef.current === id) setActiveDomainId(null)
      }
    })
  }

  const [renamingId, setRenamingId] = useState<number | null>(null)
  const [renameValue, setRenameValue] = useState('')

  function startRename(domain: { id: number; name: string }) {
    setRenamingId(domain.id)
    setRenameValue(domain.name)
  }

  async function saveRename() {
    const name = renameValue.trim()
    const id = renamingId
    if (id === null || !name) return // empty: stay open until corrected or cancelled
    await run(async () => {
      await updateDomain(id, name)
      setRenamingId((current) => (current === id ? null : current))
      await refreshDomains()
    })
  }

  // `entry` is the open object the entry was rendered with. An answer from
  // an entry the writer has left may be older than what the list shows by
  // now, so it only triggers a reload of the active domain's list.
  function conceptSaved(entry: OpenConcept, saved: Concept) {
    const active = activeDomainRef.current
    if (openRef.current !== entry) {
      if (active !== null) void loadConcepts(active)
      return
    }
    setConcepts((list) => {
      const rest = list.filter((c) => c.id !== saved.id)
      return active !== null && saved.domain_ids.includes(active) ? [...rest, saved] : rest
    })
    // A list answer still on its way was read before this save; fetch again
    // so it cannot replace the list without the saved concept.
    if (conceptsPendingRef.current && active !== null) void loadConcepts(active)
    if (entry.conceptId !== saved.id) showEntry({ ...entry, conceptId: saved.id })
  }

  // The entry that asked closes. Another entry for the same concept closes
  // when the concept was deleted, or when it is open in the domain the
  // concept was removed from.
  function conceptGone(entry: OpenConcept, deleted: boolean, fromDomainId: number) {
    const current = openRef.current
    const active = activeDomainRef.current
    const sameConcept = current !== null && current.conceptId === entry.conceptId
    if (current === entry || (sameConcept && (deleted || active === fromDomainId))) showEntry(null)
    if (active !== null) void loadConcepts(active)
  }

  // Bound like conceptSaved. For an entry the view has closed meanwhile the
  // outcome may be older than the list and belong to another domain, so it
  // only triggers a reload of the active domain's list.
  function conceptTransferred(entry: OpenConcept, outcome: TransferOutcome, kind: 'merge' | 'move') {
    const active = activeDomainRef.current
    if (active === null) return
    if (openRef.current !== entry) {
      void loadConcepts(active)
      return
    }
    const { target, source } = outcome
    const sourceId = outcome.basis.source.concept_id
    setConcepts((list) => [
      ...list.filter((c) => c.id !== target.id && c.id !== sourceId),
      ...[target, source].filter((c): c is Concept => c !== null && c.domain_ids.includes(active)),
    ])
    const shown = kind === 'move' && source !== null ? source : target
    // Unlinked from this domain between preview and run: not in the list.
    if (shown.domain_ids.includes(active)) {
      setTransfers((n) => n + 1)
      showEntry({ ...entry, conceptId: shown.id })
    } else {
      showEntry(null)
    }
    void loadConcepts(active)
  }

  // A dialog's preview found the open concept changed elsewhere; the list
  // still holds the old copy, so reopening alone would not help. Bound like
  // conceptSaved. A failure other than 404 is thrown for the dialog to show.
  async function conceptReloaded(entry: OpenConcept) {
    const id = entry.conceptId
    if (id === null) return
    let fresh: Concept | null = null
    try {
      fresh = await getConcept(id)
    } catch (e) {
      const gone = e instanceof HttpError && e.status === 404
      if (!gone && openRef.current === entry) throw e
    }
    const active = activeDomainRef.current
    if (active === null) return
    if (openRef.current !== entry) {
      void loadConcepts(active)
      return
    }
    if (fresh !== null && fresh.domain_ids.includes(active)) {
      const current = fresh
      setConcepts((list) => [...list.filter((c) => c.id !== id), current])
      setTransfers((n) => n + 1)
      showEntry({ ...entry })
    } else {
      showEntry(null)
    }
    void loadConcepts(active)
  }

  const activeDomain = domains.find((domain) => domain.id === activeDomainId) ?? null
  const readOnly = activeDomain !== null && activeDomain.is_global && !isAdmin

  return (
    <div className="terminology">
      {error && <p className="crud-error">{error}</p>}
      <aside className="domain-list">
        <h2>{m.domains}</h2>
        {domains.map((domain) => {
          const editable = !domain.is_global || isAdmin
          return (
            <div
              key={domain.id}
              className={`domain-row${domain.id === activeDomainId ? ' selected' : ''}`}
              onClick={() => domain.id !== activeDomainId && leaveEntry(() => setActiveDomainId(domain.id))}
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
                <span onDoubleClick={() => editable && startRename(domain)}>{domain.name}</span>
              )}
              {domain.is_global && (
                <span className="global-badge" title={m.globalBadgeTitle}>
                  {m.globalBadge}
                </span>
              )}
              {editable && (
                <>
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
                      void askRemoveDomain(domain)
                    }}
                  >
                    ✕
                  </button>
                </>
              )}
            </div>
          )
        })}
        {canCreate && (
          <div className="add-domain">
            <input
              value={newDomain}
              placeholder={m.newDomainPlaceholder}
              disabled={creating}
              onChange={(event) => setNewDomain(event.target.value)}
              onKeyDown={(event) => event.key === 'Enter' && addDomain()}
            />
            <button className="plain-button" disabled={creating} onClick={addDomain}>
              {m.add}
            </button>
          </div>
        )}
        {canCreate && isAdmin && (
          <label className="add-domain-shared">
            <input
              type="checkbox"
              checked={newShared}
              disabled={creating}
              onChange={(event) => setNewShared(event.target.checked)}
            />
            {m.sharedDomain}
          </label>
        )}
      </aside>
      {pendingDelete !== null && (
        <ConfirmDialog
          title={m.deleteDomainTitle}
          message={m.deleteDomainConfirm(pendingDelete.name, pendingDelete.count)}
          confirmLabel={m.deleteDomainTitle}
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => {
            const { id } = pendingDelete
            setPendingDelete(null)
            if (id === activeDomainId) leaveEntry(() => void removeDomain(id))
            else void removeDomain(id)
          }}
        />
      )}
      {activeDomain !== null && open === null && (
        <ConceptList
          domain={activeDomain}
          concepts={concepts}
          domains={domains}
          readOnly={readOnly}
          canCreate={canCreate}
          language={listLanguage}
          onLanguageChange={setListLanguage}
          onOpen={(conceptId, language) => showEntry({ conceptId, language })}
          onCreate={(language) => showEntry({ conceptId: null, language })}
        />
      )}
      {activeDomain !== null && open !== null && (
        <ConceptEntry
          key={transfers}
          domain={activeDomain}
          domains={domains}
          concept={concepts.find((c) => c.id === open.conceptId) ?? null}
          newLanguage={open.language}
          readOnly={readOnly}
          candidates={concepts.filter((c) => c.id !== open.conceptId)}
          canCreate={canCreate}
          onBack={() => showEntry(null)}
          onSaved={(saved) => conceptSaved(open, saved)}
          onGone={(deleted) => conceptGone(open, deleted, activeDomain.id)}
          onTransferred={(outcome, kind) => conceptTransferred(open, outcome, kind)}
          onReloadConcept={() => conceptReloaded(open)}
          onUnsavedChange={setUnsaved}
        />
      )}
      {pendingLeave !== null && (
        <ConfirmDialog
          title={m.leaveUnsavedTitle}
          message={m.leaveUnsavedConfirm}
          confirmLabel={m.leaveUnsaved}
          onCancel={() => setPendingLeave(null)}
          onConfirm={() => {
            setPendingLeave(null)
            pendingLeave()
          }}
        />
      )}
    </div>
  )
}
