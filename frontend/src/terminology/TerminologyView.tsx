import { useCallback, useEffect, useRef, useState } from 'react'
import { createDomain, deleteDomain, getConcepts, getDomains, updateDomain } from '../api/client'
import { hasFeature } from '../auth/policy'
import { sessionGeneration } from '../auth/session'
import { useCrudError } from '../hooks/useCrudError'
import { ConfirmDialog } from '../ui/ConfirmDialog'
import { useLocale, useMessages } from '../i18n'
import { useStore } from '../state/store'
import type { Concept, Language } from '../types'
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
  const locale = useLocale()
  const [newDomain, setNewDomain] = useState('')
  const m = useMessages()
  const { error, run } = useCrudError(m.changeFailed)

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
  // - activeDomainRef rejects cross-domain starts and completions, so a
  //   mutation's onChanged callback — which closes over the domain id at
  //   the render it was wired to — cannot refetch or apply results for a
  //   domain the user has since switched away from (its own fetch resolving
  //   later would otherwise "win" the counter race against the domain the
  //   user is actually looking at).
  const activeDomainRef = useRef<number | null>(null)
  const conceptsRequestRef = useRef(0)
  const loadConcepts = useCallback((domainId: number) => {
    if (activeDomainRef.current !== domainId) return Promise.resolve()
    const requestId = ++conceptsRequestRef.current
    return getConcepts(domainId).then((fetched) => {
      if (conceptsRequestRef.current === requestId && activeDomainRef.current === domainId) {
        setConcepts(fetched)
      }
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

  async function addDomain() {
    if (!newDomain.trim()) return
    await run(async () => {
      const domain = await createDomain(newDomain.trim())
      setNewDomain('')
      await refreshDomains()
      setActiveDomainId(domain.id)
    })
  }

  async function askRemoveDomain(domain: { id: number; name: string }) {
    await run(async () => {
      const inDomain = await getConcepts(domain.id)
      const count = inDomain.filter((c) => c.domain_ids.length === 1).length
      setPendingDelete({ id: domain.id, name: domain.name, count })    })
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

  const activeDomain = domains.find((domain) => domain.id === activeDomainId) ?? null

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
              onKeyDown={(event) => event.key === 'Enter' && void addDomain()}
            />
            <button onClick={() => void addDomain()}>{m.add}</button>
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
            void removeDomain(id)
          }}
        />
      )}
      {activeDomain !== null && open === null && (
        <ConceptList
          domain={activeDomain}
          concepts={concepts}
          domains={domains}
          readOnly={activeDomain.is_global && !isAdmin}
          canCreate={canCreate}
          onOpen={(conceptId) => setOpen({ conceptId, language: locale })}
          onCreate={(language) => setOpen({ conceptId: null, language })}
        />
      )}
      {activeDomain !== null && open !== null && (
        <section className="concept-list">
          <button type="button" onClick={() => setOpen(null)}>
            ← {m.concepts}
          </button>
        </section>
      )}
    </div>
  )
}
