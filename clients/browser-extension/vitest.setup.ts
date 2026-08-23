import { beforeEach, vi } from 'vitest'
import { browserMock, resetBrowserMock } from './src/testing/browserMock'

// webextension-polyfill throws at import time unless
// globalThis.chrome.runtime.id exists, so every suite gets this mock
// globally rather than requiring each one to opt in.
vi.mock('webextension-polyfill', () => ({ default: browserMock }))

beforeEach(() => {
  resetBrowserMock()
})
