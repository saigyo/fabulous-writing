// Extracted from Header() (App.tsx) so LoginForm's card can use the exact
// same markup instead of a second copy that would drift from this one —
// see App.css's `.wordmark` comment for the styling side of the same point.
export function Wordmark() {
  return (
    <h1 className="wordmark">
      Fabulous <span className="accent">Writing</span>
    </h1>
  )
}
