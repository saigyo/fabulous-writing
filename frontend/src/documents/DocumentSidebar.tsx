import { useCallback, useRef, useState } from 'react'
import type { DocumentSummary, Folder } from '../api/client'
import { HttpError } from '../api/client'
import { useDismissOnOutsideClick } from '../hooks/useDismissOnOutsideClick'
import { useLocale, useMessages } from '../i18n'
import { useStore } from '../state/store'
import { absoluteTime, relativeTime } from './documentTime'
import {
  createNewDocument,
  initDocuments,
  moveDocumentToFolder,
  openDocument,
  removeDocument,
  removeFolder,
  renameDocument,
} from './documents'
import { addFolder, renameFolderById } from './folders'
import { FolderDefaultsDialog } from './FolderDefaultsDialog'
import { groupDocuments } from './grouping'

function PanelIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="1.5" y="2.5" width="13" height="11" rx="2" stroke="currentColor" />
      <path d="M6 2.5v11" stroke="currentColor" />
    </svg>
  )
}

function FolderPlusIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M1.5 4.5a2 2 0 0 1 2-2h2.6l1.4 1.6h5a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2v-7.6Z"
        stroke="currentColor"
      />
      <path d="M8 7.2v4M6 9.2h4" stroke="currentColor" />
    </svg>
  )
}

function ChevronIcon({ collapsed }: { collapsed: boolean }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="none"
      aria-hidden="true"
      className={collapsed ? 'folder-chevron-icon collapsed' : 'folder-chevron-icon'}
    >
      <path d="M4 2.5 8 6l-4 3.5" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  )
}

export function DocumentSidebar() {
  const m = useMessages()
  const collapsed = useStore((s) => s.docSidebarCollapsed)
  const toggle = useStore((s) => s.toggleDocSidebar)
  const documents = useStore((s) => s.documents)
  const error = useStore((s) => s.docListError)
  const folders = useStore((s) => s.folders)
  const [creatingFolder, setCreatingFolder] = useState(false)
  const grouped = groupDocuments(documents, folders)

  if (collapsed) {
    return (
      <aside className="doc-sidebar collapsed">
        <button
          className="doc-sidebar-toggle"
          title={m.docSidebarShow}
          aria-label={m.docSidebarShow}
          onClick={toggle}
        >
          <PanelIcon />
        </button>
      </aside>
    )
  }
  return (
    <aside className="doc-sidebar">
      <div className="doc-sidebar-head">
        <button className="doc-new" onClick={() => void createNewDocument()}>
          <span className="doc-new-icon" aria-hidden="true">
            +
          </span>
          {m.docNew}
        </button>
        <button
          className="doc-sidebar-toggle"
          title={m.folderNew}
          aria-label={m.folderNew}
          onClick={() => setCreatingFolder(true)}
        >
          <FolderPlusIcon />
        </button>
        <button
          className="doc-sidebar-toggle"
          title={m.docSidebarHide}
          aria-label={m.docSidebarHide}
          onClick={toggle}
        >
          <PanelIcon />
        </button>
      </div>
      {error && (
        <p className="doc-list-error">
          {m.docListError}{' '}
          <button onClick={() => void initDocuments()}>{m.docRetry}</button>
        </p>
      )}
      {creatingFolder && (
        <NewFolderInput onDone={() => setCreatingFolder(false)} />
      )}
      {folders.map((folder) => (
        <FolderGroup
          key={folder.id}
          folder={folder}
          documents={grouped.byFolder.get(folder.id) ?? []}
        />
      ))}
      {folders.length > 0 && grouped.ungrouped.length > 0 && (
        <hr className="doc-list-divider" />
      )}
      <ul className="doc-list">
        {grouped.ungrouped.map((doc) => (
          <DocumentItem key={doc.id} doc={doc} />
        ))}
      </ul>
    </aside>
  )
}

function NewFolderInput({ onDone }: { onDone: () => void }) {
  const m = useMessages()
  const [conflict, setConflict] = useState(false)

  const commit = async (value: string) => {
    const name = value.trim()
    if (!name) {
      onDone()
      return
    }
    try {
      await addFolder(name)
      onDone()
    } catch (error) {
      if (error instanceof HttpError && error.status === 409) {
        setConflict(true) // keep the input open; the name is taken
      } else {
        useStore.getState().setDocListError(true)
        onDone()
      }
    }
  }

  return (
    <input
      className={conflict ? 'new-folder-input conflict' : 'new-folder-input'}
      placeholder={m.folderNamePlaceholder}
      autoFocus
      onChange={() => setConflict(false)}
      onBlur={(e) => void commit(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') void commit(e.currentTarget.value)
        if (e.key === 'Escape') onDone()
      }}
    />
  )
}

function FolderGroup({
  folder,
  documents,
}: {
  folder: Folder
  documents: DocumentSummary[]
}) {
  const m = useMessages()
  const collapsed = useStore((s) => s.docFoldersCollapsed.includes(folder.id))
  const toggleCollapsed = useStore((s) => s.toggleFolderCollapsed)
  const holdsCurrent = useStore(
    (s) => s.docMeta !== null && documents.some((d) => d.id === s.docMeta!.id),
  )
  const [menuOpen, setMenuOpen] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [conflict, setConflict] = useState(false)
  const [defaultsOpen, setDefaultsOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const closeMenu = useCallback(() => setMenuOpen(false), [])
  useDismissOnOutsideClick(menuRef, menuOpen, closeMenu)

  const commitRename = async (value: string) => {
    const name = value.trim()
    if (!name || name === folder.name) {
      setRenaming(false)
      return
    }
    try {
      await renameFolderById(folder.id, name)
      setRenaming(false)
    } catch (error) {
      if (error instanceof HttpError && error.status === 409) {
        setConflict(true) // keep the input open; the name is taken
      } else {
        useStore.getState().setDocListError(true)
        setRenaming(false)
      }
    }
  }

  return (
    <div className="folder-group">
      <div
        className={
          collapsed && holdsCurrent ? 'folder-head has-current' : 'folder-head'
        }
      >
        {renaming ? (
          <input
            className={conflict ? 'doc-rename-input conflict' : 'doc-rename-input'}
            defaultValue={folder.name}
            autoFocus
            onFocus={(e) => e.target.select()}
            onChange={() => setConflict(false)}
            onBlur={(e) => void commitRename(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void commitRename(e.currentTarget.value)
              if (e.key === 'Escape') {
                setConflict(false)
                setRenaming(false)
              }
            }}
          />
        ) : (
          <button
            className="folder-toggle"
            onClick={() => toggleCollapsed(folder.id)}
          >
            <ChevronIcon collapsed={collapsed} />
            <span className="folder-name">{folder.name}</span>
          </button>
        )}
        <div className="doc-actions" ref={menuRef}>
          <button
            className="doc-menu-button"
            aria-label={m.folderMenu}
            onClick={() => setMenuOpen((open) => !open)}
          >
            ⋯
          </button>
          {menuOpen && (
            <div className="doc-menu">
              <button
                onClick={() => {
                  setMenuOpen(false)
                  void createNewDocument(folder.id)
                }}
              >
                {m.folderNewDocument}
              </button>
              <button
                onClick={() => {
                  setMenuOpen(false)
                  setDefaultsOpen(true)
                }}
              >
                {m.folderDefaults}
              </button>
              <button
                onClick={() => {
                  setMenuOpen(false)
                  setRenaming(true)
                }}
              >
                {m.folderRename}
              </button>
              <button
                className="doc-menu-delete"
                onClick={() => {
                  setMenuOpen(false)
                  if (window.confirm(m.folderDeleteConfirm(folder.name))) {
                    removeFolder(folder.id).catch(() => {
                      useStore.getState().setDocListError(true)
                    })
                  }
                }}
              >
                {m.folderDelete}
              </button>
            </div>
          )}
        </div>
      </div>
      {!collapsed && (
        <ul className="doc-list folder-docs">
          {documents.map((doc) => (
            <DocumentItem key={doc.id} doc={doc} />
          ))}
        </ul>
      )}
      {defaultsOpen && (
        <FolderDefaultsDialog
          folder={folder}
          onClose={() => setDefaultsOpen(false)}
        />
      )}
    </div>
  )
}

function DocumentItem({ doc }: { doc: DocumentSummary }) {
  const m = useMessages()
  const locale = useLocale()
  const isCurrent = useStore((s) => s.docMeta?.id === doc.id)
  const folders = useStore((s) => s.folders)
  const [menuOpen, setMenuOpen] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [moving, setMoving] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const closeMenu = useCallback(() => {
    setMenuOpen(false)
    setMoving(false)
  }, [])
  useDismissOnOutsideClick(menuRef, menuOpen, closeMenu)

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
          title={absoluteTime(doc.edited_at, locale)}
          onClick={() => {
            if (!isCurrent) void openDocument(doc.id)
          }}
        >
          <span className="doc-name">{doc.name}</span>
          <span className="doc-time">{relativeTime(doc.edited_at, locale)}</span>
        </button>
      )}
      <div className="doc-actions" ref={menuRef}>
        <button
          className="doc-menu-button"
          aria-label={m.docMenu}
          onClick={() => {
            setMenuOpen((open) => !open)
            setMoving(false)
          }}
        >
          ⋯
        </button>
        {menuOpen && (
          <div className="doc-menu">
            <button
              onClick={() => {
                setMenuOpen(false)
                setMoving(false)
                setRenaming(true)
              }}
            >
              {m.docRename}
            </button>
            <button onClick={() => setMoving((open) => !open)}>
              {m.folderMoveTo} ▸
            </button>
            {moving && (
              <div className="doc-submenu">
                <button
                  disabled={doc.folder_id === null}
                  onClick={() => {
                    setMenuOpen(false)
                    setMoving(false)
                    void moveDocumentToFolder(doc.id, null)
                  }}
                >
                  {m.folderNone}
                </button>
                {folders.map((folder) => (
                  <button
                    key={folder.id}
                    disabled={doc.folder_id === folder.id}
                    onClick={() => {
                      setMenuOpen(false)
                      setMoving(false)
                      void moveDocumentToFolder(doc.id, folder.id)
                    }}
                  >
                    {folder.name}
                  </button>
                ))}
              </div>
            )}
            <button
              className="doc-menu-delete"
              onClick={() => {
                setMenuOpen(false)
                setMoving(false)
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
