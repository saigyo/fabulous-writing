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
