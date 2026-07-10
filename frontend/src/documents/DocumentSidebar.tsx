import { useState } from 'react'
import type { DocumentSummary } from '../api/client'
import { useLocale, useMessages } from '../i18n'
import { useStore } from '../state/store'
import {
  createNewDocument,
  initDocuments,
  openDocument,
  removeDocument,
  renameDocument,
} from './documents'

/** "2 hours ago" in the UI locale; future stamps clamp to now. */
// oxlint-disable-next-line react/only-export-components -- pure helper, unit-tested in isolation
export function relativeTime(iso: string, locale: string, now = Date.now()): string {
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
  const minutes = Math.min(0, Math.round((Date.parse(iso) - now) / 60000))
  if (minutes > -60) return rtf.format(minutes, 'minute')
  const hours = Math.round(minutes / 60)
  if (hours > -24) return rtf.format(hours, 'hour')
  return rtf.format(Math.round(hours / 24), 'day')
}

export function DocumentSidebar() {
  const m = useMessages()
  const collapsed = useStore((s) => s.docSidebarCollapsed)
  const toggle = useStore((s) => s.toggleDocSidebar)
  const documents = useStore((s) => s.documents)
  const error = useStore((s) => s.docListError)

  if (collapsed) {
    return (
      <aside className="doc-sidebar collapsed">
        <button
          className="doc-sidebar-toggle"
          title={m.docSidebarShow}
          aria-label={m.docSidebarShow}
          onClick={toggle}
        >
          ▸
        </button>
      </aside>
    )
  }
  return (
    <aside className="doc-sidebar">
      <div className="doc-sidebar-head">
        <button className="doc-new" onClick={() => void createNewDocument()}>
          + {m.docNew}
        </button>
        <button
          className="doc-sidebar-toggle"
          title={m.docSidebarHide}
          aria-label={m.docSidebarHide}
          onClick={toggle}
        >
          ◂
        </button>
      </div>
      {error && (
        <p className="doc-list-error">
          {m.docListError}{' '}
          <button onClick={() => void initDocuments()}>{m.docRetry}</button>
        </p>
      )}
      <ul className="doc-list">
        {documents.map((doc) => (
          <DocumentItem key={doc.id} doc={doc} />
        ))}
      </ul>
    </aside>
  )
}

function DocumentItem({ doc }: { doc: DocumentSummary }) {
  const m = useMessages()
  const locale = useLocale()
  const isCurrent = useStore((s) => s.docMeta?.id === doc.id)
  const [menuOpen, setMenuOpen] = useState(false)
  const [renaming, setRenaming] = useState(false)

  const commitRename = (value: string) => {
    setRenaming(false)
    if (value.trim() && value.trim() !== doc.name) {
      void renameDocument(doc.id, value)
    }
  }

  return (
    <li className={isCurrent ? 'doc-item current' : 'doc-item'}>
      {renaming ? (
        <input
          className="doc-rename-input"
          defaultValue={doc.name}
          autoFocus
          onFocus={(e) => e.target.select()}
          onBlur={(e) => commitRename(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitRename(e.currentTarget.value)
            if (e.key === 'Escape') setRenaming(false)
          }}
        />
      ) : (
        <button
          className="doc-open"
          onClick={() => {
            if (!isCurrent) void openDocument(doc.id)
          }}
        >
          <span className="doc-name">{doc.name}</span>
          <span className="doc-time">{relativeTime(doc.updated_at, locale)}</span>
        </button>
      )}
      <div className="doc-actions">
        <button
          className="doc-menu-button"
          aria-label={m.docMenu}
          onClick={() => setMenuOpen((open) => !open)}
        >
          ⋯
        </button>
        {menuOpen && (
          <div className="doc-menu" onMouseLeave={() => setMenuOpen(false)}>
            <button
              onClick={() => {
                setMenuOpen(false)
                setRenaming(true)
              }}
            >
              {m.docRename}
            </button>
            <button
              className="doc-menu-delete"
              onClick={() => {
                setMenuOpen(false)
                if (window.confirm(m.docDeleteConfirm(doc.name))) {
                  void removeDocument(doc.id)
                }
              }}
            >
              {m.docDelete}
            </button>
          </div>
        )}
      </div>
    </li>
  )
}
