import {
  createFolder as apiCreateFolder,
  putFolderDefaults,
  renameFolder as apiRenameFolder,
  type DocumentCreatePayload,
  type Folder,
  type FolderDefaults,
} from '../api/client'
import { useStore } from '../state/store'
import { sortedByName } from './list'

/** Overlay a folder's set defaults on a document-create payload. Unset
 * (null) defaults leave the header-derived values alone. Creation-time
 * only: moves never touch settings. */
export function applyFolderDefaults(
  payload: DocumentCreatePayload,
  folder: Folder | undefined,
): DocumentCreatePayload {
  if (!folder) return payload
  const out = { ...payload }
  if (folder.default_language !== null) {
    if (
      folder.default_language !== payload.language &&
      folder.default_profile_id === null
    ) {
      // The header profile belongs to the header language; it must not
      // leak onto a document created in a different default language.
      out.profile_id = null
    }
    out.language = folder.default_language
  }
  if (folder.default_profile_id !== null)
    out.profile_id = folder.default_profile_id
  if (folder.default_domain_ids !== null)
    out.domain_ids = folder.default_domain_ids
  const llmSet =
    folder.default_llm_provider !== null ||
    folder.default_llm_model !== null ||
    folder.default_llm_tier !== null
  if (llmSet) {
    // One composite unit, mirroring the header selector's pin-vs-tier model.
    out.llm_provider = folder.default_llm_provider
    out.llm_model = folder.default_llm_model
    out.llm_tier = folder.default_llm_tier
  }
  if (folder.default_llm_auto !== null) out.llm_auto = folder.default_llm_auto
  return out
}

/** Persist a folder's defaults (full replace) and update it in place.
 * Errors are rethrown: the defaults dialog shows them inline. */
export async function saveFolderDefaults(
  id: number,
  defaults: FolderDefaults,
): Promise<void> {
  const updated = await putFolderDefaults(id, defaults)
  const store = useStore.getState()
  store.setFolders(store.folders.map((f) => (f.id === id ? updated : f)))
}

/** Create a folder. Errors are rethrown: the sidebar shows a 409 inline. */
export async function addFolder(name: string): Promise<void> {
  const folder = await apiCreateFolder(name.trim())
  const store = useStore.getState()
  store.setFolders(sortedByName([...store.folders, folder]))
}

export async function renameFolderById(id: number, name: string): Promise<void> {
  const renamed = await apiRenameFolder(id, name.trim())
  const store = useStore.getState()
  store.setFolders(
    sortedByName(store.folders.map((f) => (f.id === id ? renamed : f))),
  )
}
