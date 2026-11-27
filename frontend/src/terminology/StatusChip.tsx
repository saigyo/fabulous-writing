import { useMessages } from '../i18n'
import type { ConceptTerm } from '../types'

export function StatusChip({ term, incoming = false }: { term: ConceptTerm; incoming?: boolean }) {
  const m = useMessages()
  const candidate = term.process_status === 'candidate'
  const name =
    `${term.text}, ${m.statusName(term.usage_status)}` +
    (candidate ? `, ${m.statusCandidate}` : '') +
    (incoming ? `, ${m.statusIncoming}` : '')
  return (
    <span
      role="img"
      aria-label={name}
      title={name}
      className={`status-chip status-${term.usage_status}${candidate ? ' candidate' : ''}${incoming ? ' incoming' : ''}`}
    >
      {incoming && <span className="status-chip-plus">+</span>}
      {term.text}
    </span>
  )
}
