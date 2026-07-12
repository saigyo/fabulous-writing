import { listDocuments, listFolders, type DocumentFull, type DocumentSummary, type Folder } from '../api/client'
import { useStore } from '../state/store'

export function summaryOf(doc: DocumentFull): DocumentSummary {
  return {
    id: doc.id,
    name: doc.name,
    language: doc.language,
    folder_id: doc.folder_id,
    created_at: doc.created_at,
    edited_at: doc.edited_at,
    checked_at: doc.checked_at,
    updated_at: doc.updated_at,
  }
}

export async function refreshDocuments(): Promise<void> {
  try {
    useStore.getState().setDocuments(await listDocuments())
    useStore.getState().setDocListError(false)
  } catch {
    useStore.getState().setDocListError(true)
  }
}

export async function refreshFolders(): Promise<void> {
  try {
    useStore.getState().setFolders(await listFolders())
  } catch {
    useStore.getState().setDocListError(true)
  }
}

export function sortedByName(folders: Folder[]): Folder[] {
  return [...folders].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
  )
}
