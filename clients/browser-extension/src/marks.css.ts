// Cosmetic overlay mark colors only (spec: B43, C2 browser extension, Task
// 7) — mirrors the .fw-mark-* rules in frontend/src/simulator/simulator.css
// (border-radius + severity backgrounds + the click-flash outline),
// !important-free. Nothing here is load-bearing: textareaAdapter.ts sets
// every geometry/paint-order style that actually matters inline, in JS,
// precisely because an arbitrary host page never loads a stylesheet of ours
// on its own (see that module's header comment). scout.ts injects this once
// as `<style data-fw-marks>` on first connect — GLOBALLY, into the host
// page's own document.head, unlike the affordance chip's shadow-scoped
// styles.
//
// Copilot round 2 (B43 C2), S6a: every rule below is scoped under
// `[data-fw-overlay]` (the attribute textareaAdapter.ts sets on the mirror
// overlay it creates) rather than a bare `.fw-mark*` class selector. Without
// this, an arbitrary host page that happens to use one of these class names
// on its OWN elements (generic enough — "mark", "error", "warning" — to
// plausibly collide) would get restyled by this global stylesheet. Scoping
// under the overlay's own attribute confines every rule to elements actually
// inside a mirror overlay this extension created.
export const MARKS_CSS = `
[data-fw-overlay] .fw-mark {
  border-radius: 2px;
}

[data-fw-overlay] .fw-mark-error {
  background: #f8b4b4;
}

[data-fw-overlay] .fw-mark-warning {
  background: #fde68a;
}

[data-fw-overlay] .fw-mark-suggestion {
  background: #bfdbfe;
}

[data-fw-overlay] .fw-mark-flash {
  outline: 2px solid #6e56cf;
  outline-offset: 1px;
}
`
