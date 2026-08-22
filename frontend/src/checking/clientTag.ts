// Client tag for the check API: which surface (web, embed, browser-extension, etc.)
// issued this check. Persisted separately from the session/document lifecycle.

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
  tag = ALLOWLIST.has(value) ? value : 'web'
}
