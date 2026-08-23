// Cosmetic overlay mark colors only (spec: B43, C2 browser extension, Task
// 7) — mirrors the .fw-mark-* rules in frontend/src/simulator/simulator.css
// (border-radius + severity backgrounds + the click-flash outline),
// !important-free. Nothing here is load-bearing: textareaAdapter.ts sets
// every geometry/paint-order style that actually matters inline, in JS,
// precisely because an arbitrary host page never loads a stylesheet of ours
// on its own (see that module's header comment). scout.ts injects this once
// as `<style data-fw-marks>` on first connect.
export const MARKS_CSS = `
.fw-mark {
  border-radius: 2px;
}

.fw-mark-error {
  background: #f8b4b4;
}

.fw-mark-warning {
  background: #fde68a;
}

.fw-mark-suggestion {
  background: #bfdbfe;
}

.fw-mark-flash {
  outline: 2px solid #6e56cf;
  outline-offset: 1px;
}
`
