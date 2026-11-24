import { useCallback, useEffect, useRef, useState } from 'react'
import { createDomain, deleteDomain, getConcepts, getDomains, updateDomain } from '../api/client'
import { hasFeature } from '../auth/policy'
import { sessionGeneration } from '../auth/session'
import { useCrudError } from '../hooks/useCrudError'
import { ConfirmDialog } from '../ui/ConfirmDialog'
import { useLocale, useMessages } from '../i18n'
import { useStore } from '../state/store'
import type { Concept, Language } from '../types'
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
  const [pendingDelete, setPendingDelete] = useState<{ id: number; name: string; count: number } | null>(null)
  const [newDomain, setNewDomain] = useState('')
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

  const refreshDomains = useCallback(() => {
    const gen = sessionGeneration()
    return getDomains().then((domains) => {
      if (sessionGeneration() === gen) setDomains(domains)
    })
  }, [setDomains])

  useEffect(() => {
    void refreshDomains()
  }, [refreshDomains, authGeneration])

  useEffect(() => {
    if (activeDomainId === null && domains.length > 0) {
      setActiveDomainId(domains[0].id)
    }
  }, [domains, activeDomainId])

  // Guard policy composed of two independent checks:
  // - the request counter orders same-domain fetches, so a stale fetch for
  //   the CURRENT domain (e.g. an in-flight load superseded by a newer one)
  //   is discarded instead of overwriting more recent rows;
  // - activeDomainRef rejects cross-domain starts and completions, so the
  //   entry's onGone callback — which closes over the domain id at the
  //   render it was wired to — cannot refetch or apply results for a
  //   domain the user has since switched away from (its own fetch resolving
  //   later would otherwise "win" the counter race against the domain the
  //   user is actually looking at).
  const activeDomainRef = useRef<number | null>(null)
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
      .finally(() => {
        if (conceptsRequestRef.current === requestId) conceptsPendingRef.current = false
      })
  }, [])

  useEffect(() => {
    // Clear immediately on domain change so the previous domain's rows never
    // stay interactive (or visible) while the new domain's fetch is in flight.
    activeDomainRef.current = activeDomainId
    setConcepts([])
    setOpen(null)
    if (activeDomainId !== null) {
      void loadConcepts(activeDomainId)
    }
  }, [activeDomainId, loadConcepts])

  function addDomain() {
    const name = newDomain.trim()
    if (!name) return
    leaveEntry(() =>
      void run(async () => {
        setOpen(null)
        const domain = await createDomain(name)
        setNewDomain('')
        await refreshDomains()
        if (!useStore.getState().terminologyUnsaved) setActiveDomainId(domain.id)
      }),
    )
  }

  async function askRemoveDomain(domain: { id: number; name: string }) {
    await run(async () => {
      const inDomain = await getConcepts(domain.id)
      const count = inDomain.filter((c) => c.domain_ids.length === 1).length
      setPendingDelete({ id: domain.id, name: domain.name, count })
    })
  }

  async function removeDomain(id: number) {
    await run(async () => {
      await deleteDomain(id)
      if (activeDomainId === id) setActiveDomainId(null)
      await refreshDomains()
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
    if (renamingId === null || !name) return // empty: stay open until corrected or cancelled
    await run(async () => {
      await updateDomain(renamingId, name)
      setRenamingId(null)
      await refreshDomains()
    })
  }

  // `entry` is the open object the entry was rendered with: an answer that
  // arrives after the writer left that entry updates the list only.
  function conceptSaved(entry: OpenConcept, saved: Concept) {
    setConcepts((list) => {
      const rest = list.filter((c) => c.id !== saved.id)
      return activeDomainRef.current !== null && saved.domain_ids.includes(activeDomainRef.current)
        ? [...rest, saved]
        : rest
    })
    // A list answer still on its way was read before this save; fetch again
    // so it cannot replace the list without the saved concept.
    if (conceptsPendingRef.current && activeDomainRef.current !== null) {
      void loadConcepts(activeDomainRef.current)
    }
    setOpen((current) =>
      current === entry && current.conceptId !== saved.id ? { ...current, conceptId: saved.id } : current,
    )
  }

  function conceptGone(entry: OpenConcept, domainId: number) {
    setOpen((current) => (current === entry ? null : current))
    void loadConcepts(domainId)
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
              onChange={(event) => setNewDomain(event.target.value)}
              onKeyDown={(event) => event.key === 'Enter' && addDomain()}
            />
            <button className="plain-button" onClick={addDomain}>{m.add}</button>
          </div>
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
          onOpen={(conceptId, language) => setOpen({ conceptId, language })}
          onCreate={(language) => setOpen({ conceptId: null, language })}
        />
      )}
      {activeDomain !== null && open !== null && (
        <ConceptEntry
          domain={activeDomain}
          domains={domains}
          concept={concepts.find((c) => c.id === open.conceptId) ?? null}
          newLanguage={open.language}
          readOnly={readOnly}
          onBack={() => setOpen(null)}
          onSaved={(saved) => conceptSaved(open, saved)}
          onGone={() => conceptGone(open, activeDomain.id)}
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
