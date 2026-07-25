import { listDocuments, listFolders, type DocumentFull, type DocumentSummary, type Folder } from '../api/client'
import { useStore } from '../state/store'
import { currentGeneration } from './autosave'

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

// Both functions below are called from runInit() (documents.ts), whose own
// stillCurrent() guard covers everything up to the point it calls in here —
// but not the fetch these make internally. Without their own check, a
// session ending mid-fetch would still land the outgoing user's documents
// or folder names into the incoming user's store once the fetch resolves;
// cancelling documents.ts's timers cannot stop a fetch already in flight,
// so each of these has to check for itself, at the point of its own write.
export async function refreshDocuments(): Promise<void> {
  const gen = currentGeneration()
  try {
    const documents = await listDocuments()
    if (gen !== currentGeneration()) return
    useStore.getState().setDocuments(documents)
    useStore.getState().setDocListError(false)
  } catch {
    if (gen !== currentGeneration()) return
    useStore.getState().setDocListError(true)
  }
}

export async function refreshFolders(): Promise<void> {
  const gen = currentGeneration()
  try {
    const folders = await listFolders()
    if (gen !== currentGeneration()) return
    useStore.getState().setFolders(folders)
  } catch {
    if (gen !== currentGeneration()) return
    useStore.getState().setDocListError(true)
  }
}

export function sortedByName(folders: Folder[]): Folder[] {
  return [...folders].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
  )
}
