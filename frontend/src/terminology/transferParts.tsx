import { useMessages } from '../i18n'

/** A sentence with one quoted passage, which is set apart wherever the language places it. */
export function Quoted({ sentence, quote }: { sentence: string; quote: string }) {
  const at = sentence.indexOf(quote)
  if (at === -1) return <>{sentence}</>
  return (
    <>
      {sentence.slice(0, at)}
      <span className="transfer-quote">{quote}</span>
      {sentence.slice(at + quote.length)}
    </>
  )
}

/** Cancel and confirm of a merge or move dialog; both are unavailable while the run is pending. */
export function TransferButtons({
  running,
  ready,
  danger,
  label,
  onCancel,
  onConfirm,
}: {
  running: boolean
  ready: boolean
  danger: boolean
  label: string
  onCancel: () => void
  onConfirm: () => void
}) {
  const m = useMessages()
  return (
    <div className="transfer-buttons">
      <button type="button" className="plain-button" disabled={running} onClick={onCancel}>
        {m.dialogCancel}
      </button>
      <button
        type="button"
        className={danger ? 'confirm-dialog-danger' : 'primary-button'}
        disabled={!ready || running}
        onClick={onConfirm}
      >
        {label}
      </button>
    </div>
  )
}
