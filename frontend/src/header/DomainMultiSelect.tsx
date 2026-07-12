import { useRef, useState } from 'react'
import { useDismissOnOutsideClick } from '../hooks/useDismissOnOutsideClick'
import { useMessages } from '../i18n'
import { useStore } from '../state/store'

/** Compact checkbox dropdown for selecting terminology domains. */
export function DomainMultiSelect() {
  const domains = useStore((s) => s.domains)
  const domainIds = useStore((s) => s.domainIds)
  const setDomainIds = useStore((s) => s.setDomainIds)
  const m = useMessages()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useDismissOnOutsideClick(ref, open, () => setOpen(false))

  const selected = domains.filter((d) => domainIds.includes(d.id))
  const label =
    selected.length === 0
      ? m.domainNone
      : selected.length === 1
        ? selected[0].name
        : m.domainsSelected(selected.length)

  function toggle(id: number) {
    setDomainIds(
      domainIds.includes(id)
        ? domainIds.filter((d) => d !== id)
        : [...domainIds, id],
    )
  }

  return (
    <div className="domain-multiselect" ref={ref}>
      <button className="domain-multiselect-toggle" onClick={() => setOpen(!open)}>
        {label} ▾
      </button>
      {open && (
        <div className="domain-multiselect-menu">
          {domains.map((domain) => (
            <label key={domain.id}>
              <input
                type="checkbox"
                checked={domainIds.includes(domain.id)}
                onChange={() => toggle(domain.id)}
              />
              {domain.name}
            </label>
          ))}
          {domains.length === 0 && <span className="dim">{m.domainNone}</span>}
        </div>
      )}
    </div>
  )
}
