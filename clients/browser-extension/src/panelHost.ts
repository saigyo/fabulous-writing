// THE Chromium-only module (spec: "All chrome.sidePanel calls live in a thin
// panel-host abstraction"). Firefox (C4) swaps this file for a sidebar_action
// variant; nothing else in the extension may touch chrome.*.
export function initPanelBehavior(): void {
  // Fallback opener: clicking the toolbar icon opens the panel WITHOUT any
  // gesture-propagation question. Called once at SW top level.
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
}

export function openPanel(windowId: number, onError: (e: unknown) => void): void {
  // MUST be called synchronously inside the port.onMessage handler for the
  // affordance click — sidePanel.open requires a user gesture, and any await
  // before it drops the gesture context. Whether activation propagates from a
  // content-script click over a long-lived port is a Chromium behavior we
  // VERIFY manually in Task 7 step 5; if it ever regresses, onError surfaces
  // it (the sw sends ctl status phase 'error' to the chip) and the toolbar-
  // icon fallback above still works.
  chrome.sidePanel.open({ windowId }).catch(onError)
}

export function setBadge(tabId: number, text: string): void {
  // .catch: the post-disconnect badge clear targets the LAST connected tab
  // (registry rule 5), which may already be closed — a rejected promise for
  // a gone tab is expected, not an error.
  chrome.action.setBadgeText({ tabId, text }).catch(() => {})
}
