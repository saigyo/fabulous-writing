// In-memory stand-in for the global `chrome` namespace. panelHost.ts is the
// only module allowed to touch chrome.* directly (chrome.sidePanel,
// chrome.action) — sw.ts calls into it at import time (initPanelBehavior()
// at module top level), so any suite that imports sw.ts needs this global
// present before that import runs — see vitest.setup.ts.
import { vi } from 'vitest'

const sidePanelSetPanelBehavior = vi.fn(async () => {})
const sidePanelOpen = vi.fn(async () => {})
const actionSetBadgeText = vi.fn(async () => {})

export const chromeMock = {
  sidePanel: {
    setPanelBehavior: sidePanelSetPanelBehavior,
    open: sidePanelOpen,
  },
  action: {
    setBadgeText: actionSetBadgeText,
  },
}

export function resetChromeMock(): void {
  sidePanelSetPanelBehavior.mockClear()
  sidePanelOpen.mockClear()
  actionSetBadgeText.mockClear()
}
