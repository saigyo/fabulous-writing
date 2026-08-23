// Client tag for the check API: which surface (web, embed, browser-extension, etc.)
// issued this check. Persisted separately from the session/document lifecycle.

// Keep in sync with backend/app/api/checks.py's CheckRequest.client Literal
// — the backend's own client-enum site. Neither side generates the other; a
// new client surface must be added to both by hand, or a tag this allowlist
// accepts still 422s server-side (a mismatch the other direction: an entry
// removed here without a matching backend change just stops being sent, no
// error either side).
const ALLOWLIST = new Set<string>([
  'web',
  'embed',
  'browser-extension',
  'vscode',
  'jetbrains',
  'simulator',
])

let tag: string = 'web'

export function clientTag(): string {
  return tag
}

export function setClientTag(value: string): void {
  // Finding 11: an unknown value leaves the tag UNCHANGED, not forced back
  // to 'web' — a forced fallback would silently overwrite a deliberate
  // earlier tag (e.g. embed/main.tsx's boot-time setClientTag('embed')) the
  // moment a host sends a hello whose kind the allowlist doesn't recognize
  // yet, misattributing every check that host's session runs to 'web'.
  if (ALLOWLIST.has(value)) tag = value
}
