// In-memory stand-in for the `browser` namespace (webextension-polyfill's
// default export). Real webextension-polyfill throws at import time unless
// `globalThis.chrome.runtime.id` exists, so any suite that transitively
// imports it needs this mocked out globally — see vitest.setup.ts.
import { vi } from 'vitest'

type Listener<Args extends unknown[]> = (...args: Args) => void

function createEventTarget<Args extends unknown[]>() {
  const listeners = new Set<Listener<Args>>()
  return {
    addListener: (fn: Listener<Args>) => listeners.add(fn),
    removeListener: (fn: Listener<Args>) => listeners.delete(fn),
    hasListener: (fn: Listener<Args>) => listeners.has(fn),
    emit: (...args: Args) => listeners.forEach((fn) => fn(...args)),
  }
}

export interface MockPort {
  name: string
  postMessage: ReturnType<typeof vi.fn>
  disconnect: ReturnType<typeof vi.fn>
  onMessage: ReturnType<typeof createEventTarget<[unknown]>>
  onDisconnect: ReturnType<typeof createEventTarget<[MockPort]>>
  // Only present on ports handed to an onConnect listener (the
  // background/service-worker side) — mirrors webextension-polyfill's
  // Runtime.Port.sender, used by sw.ts to read tabId/windowId for field ports.
  sender?: { tab?: { id?: number; windowId?: number } }
}

type StorageChange = { oldValue?: unknown; newValue?: unknown }
type StorageKeys = string | string[] | Record<string, unknown> | null | undefined

const store = new Map<string, unknown>()
const storageOnChanged = createEventTarget<[Record<string, StorageChange>, string]>()

function readKeys(keys: StorageKeys): Record<string, unknown> {
  if (keys == null) return Object.fromEntries(store)
  if (typeof keys === 'string') return store.has(keys) ? { [keys]: store.get(keys) } : {}
  if (Array.isArray(keys)) {
    const out: Record<string, unknown> = {}
    for (const key of keys) if (store.has(key)) out[key] = store.get(key)
    return out
  }
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(keys)) out[key] = store.has(key) ? store.get(key) : keys[key]
  return out
}

export const connectMock = vi.fn((connectInfo?: { name?: string }): MockPort => ({
  name: connectInfo?.name ?? '',
  postMessage: vi.fn(),
  disconnect: vi.fn(),
  onMessage: createEventTarget<[unknown]>(),
  onDisconnect: createEventTarget<[MockPort]>(),
}))

// The onConnect-side counterpart of connectMock: builds the port object a
// background listener (sw.ts's `browser.runtime.onConnect.addListener`)
// receives, including `sender.tab` for field ports. The test drives the
// connection by calling `browserMock.runtime.onConnect.emit(port)`.
export function createMockPort(name: string, sender?: MockPort['sender']): MockPort {
  return {
    name,
    postMessage: vi.fn(),
    disconnect: vi.fn(),
    onMessage: createEventTarget<[unknown]>(),
    onDisconnect: createEventTarget<[MockPort]>(),
    sender,
  }
}

const runtimeOnConnect = createEventTarget<[MockPort]>()

const storageLocalGet = vi.fn(async (keys?: StorageKeys) => readKeys(keys))

const storageLocalSet = vi.fn(async (items: Record<string, unknown>) => {
  const changes: Record<string, StorageChange> = {}
  for (const [key, value] of Object.entries(items)) {
    changes[key] = { oldValue: store.get(key), newValue: value }
    store.set(key, value)
  }
  storageOnChanged.emit(changes, 'local')
})

const storageLocalRemove = vi.fn(async (keys: string | string[]) => {
  const list = Array.isArray(keys) ? keys : [keys]
  const changes: Record<string, StorageChange> = {}
  for (const key of list) {
    if (store.has(key)) {
      changes[key] = { oldValue: store.get(key) }
      store.delete(key)
    }
  }
  storageOnChanged.emit(changes, 'local')
})

const storageLocalClear = vi.fn(async () => {
  const changes: Record<string, StorageChange> = {}
  for (const [key, value] of store) changes[key] = { oldValue: value }
  store.clear()
  storageOnChanged.emit(changes, 'local')
})

const runtimeGetManifest = vi.fn(() => ({ version: '0.1.0' }))
const windowsGetCurrent = vi.fn(async () => ({ id: 1 }))

export const browserMock = {
  storage: {
    local: {
      get: storageLocalGet,
      set: storageLocalSet,
      remove: storageLocalRemove,
      clear: storageLocalClear,
    },
    onChanged: storageOnChanged,
  },
  runtime: {
    connect: connectMock,
    getManifest: runtimeGetManifest,
    onConnect: runtimeOnConnect,
  },
  windows: {
    getCurrent: windowsGetCurrent,
  },
}

export function resetBrowserMock(): void {
  store.clear()
  connectMock.mockClear()
  storageLocalGet.mockClear()
  storageLocalSet.mockClear()
  storageLocalRemove.mockClear()
  storageLocalClear.mockClear()
  runtimeGetManifest.mockClear()
  windowsGetCurrent.mockClear()
}

export default browserMock
