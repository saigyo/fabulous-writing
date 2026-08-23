import { beforeEach, vi } from 'vitest'
import { browserMock, resetBrowserMock } from './src/testing/browserMock'
import { chromeMock, resetChromeMock } from './src/testing/chromeMock'

// webextension-polyfill throws at import time unless
// globalThis.chrome.runtime.id exists, so every suite gets this mock
// globally rather than requiring each one to opt in.
vi.mock('webextension-polyfill', () => ({ default: browserMock }))

// sw.ts calls into panelHost.ts (the only chrome.*-touching module) at
// import time, so the global must exist before any suite imports sw.ts.
globalThis.chrome = chromeMock as unknown as typeof chrome

beforeEach(() => {
  resetBrowserMock()
  resetChromeMock()
})
