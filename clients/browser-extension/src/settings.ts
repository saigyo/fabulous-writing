import browser from 'webextension-polyfill'

export const DEFAULT_SERVER_URL = 'https://fabulous-writing.fly.dev'

const STORAGE_KEY = 'serverUrl'

/** Origin only (scheme http/https + host [+ port]); trailing slash stripped.
 *  Returns null for anything else — the caller shows a validation error. */
export function normalizeServerUrl(input: string): string | null {
  let url: URL
  try {
    url = new URL(input)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
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
