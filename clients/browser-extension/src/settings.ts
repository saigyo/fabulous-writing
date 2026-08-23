import browser from 'webextension-polyfill'

export const DEFAULT_SERVER_URL = 'https://fabulous-writing.fly.dev'

const STORAGE_KEY = 'serverUrl'

// Copilot round 5, F2: credentials and the document text being checked both
// go to whatever origin this resolves to — plain http:// to a non-loopback
// host is readable (and tamperable) by anyone on the network path. Only a
// loopback host — where "the network path" is the same machine — is exempt;
// every other host must use https://. Matches localhost/*.localhost by name,
// the 127.0.0.0/8 literal range by IP, and the [::1] IPv6 literal; a bare
// numeric or bracketed hostname that ISN'T one of those forms falls through
// to the https-required branch, same as any other remote host.
function isLoopbackHost(hostname: string): boolean {
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) return true
  if (hostname === '[::1]' || hostname === '::1') return true
  const octets = hostname.split('.')
  if (octets.length === 4 && octets.every((o) => /^\d{1,3}$/.test(o) && Number(o) <= 255)) {
    return Number(octets[0]) === 127
  }
  return false
}

/** Origin only (scheme http/https + host [+ port]); trailing slash stripped.
 *  https:// is required for any non-loopback host — http:// is accepted only
 *  for localhost/127.0.0.0/8/[::1]. Returns null for anything else — the
 *  caller shows a validation error. */
export function normalizeServerUrl(input: string): string | null {
  let url: URL
  try {
    url = new URL(input)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (url.protocol === 'http:' && !isLoopbackHost(url.hostname)) return null
  if (url.pathname !== '/') return null
  if (url.search !== '' || url.hash !== '' || url.username !== '' || url.password !== '') return null
  return url.origin
}

export async function getServerUrl(): Promise<string> {
  const stored = await browser.storage.local.get(STORAGE_KEY)
  const value = stored[STORAGE_KEY]
  return typeof value === 'string' ? value : DEFAULT_SERVER_URL
}

export async function setServerUrl(url: string): Promise<void> {
  await browser.storage.local.set({ [STORAGE_KEY]: url })
}

export function onServerUrlChanged(cb: (url: string) => void): void {
  browser.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return
    const change = changes[STORAGE_KEY]
    if (change === undefined) return
    if (typeof change.newValue !== 'string') return
    cb(change.newValue)
  })
}
