import type { DocumentSummary, Folder } from '../api/client'

/** Group the recency-ordered flat list by folder. Documents whose folder_id
 * references a vanished folder are shown as ungrouped rather than hidden. */
export function groupDocuments(
  documents: DocumentSummary[],
  folders: Folder[],
): { byFolder: Map<number, DocumentSummary[]>; ungrouped: DocumentSummary[] } {
  const byFolder = new Map<number, DocumentSummary[]>(
    folders.map((f) => [f.id, []]),
  )
  const ungrouped: DocumentSummary[] = []
  for (const doc of documents) {
    const bucket = doc.folder_id !== null ? byFolder.get(doc.folder_id) : undefined
    if (bucket) bucket.push(doc)
    else ungrouped.push(doc)
  }
  return { byFolder, ungrouped }
}
