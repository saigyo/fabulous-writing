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
//
// Copilot round 3, S3: the severity fills below are translucent (rgba, alpha
// ~0.35) rather than opaque pastel hex — same hues as before, just letting
// the host page's own background show through. GitHub's dark mode (this
// extension's acceptance benchmark) is the concrete failure an opaque fill
// caused: the field's light foreground text sat directly on top of a bright,
// opaque pastel highlight with no contrast to the dark page around it. A
// translucent fill instead tints whatever's underneath — dark on a dark
// host, light on a light one — so the host's own text/background contrast is
// preserved either way. The flash outline is adjusted the same way for
// consistency, though it's decorative-only (it doesn't cover any text, so it
// carries no contrast risk of its own). Deliberately NOT applied to
// frontend/src/simulator/simulator.css — the simulator keeps its own opaque
// palette; it only ever renders on its own known-light page, so it has no
// dark-host case to guard against.
export const MARKS_CSS = `
[data-fw-overlay] .fw-mark {
  border-radius: 2px;
}

[data-fw-overlay] .fw-mark-error {
  background: rgba(248, 180, 180, 0.35);
}

[data-fw-overlay] .fw-mark-warning {
  background: rgba(253, 230, 138, 0.35);
}

[data-fw-overlay] .fw-mark-suggestion {
  background: rgba(191, 219, 254, 0.35);
}

[data-fw-overlay] .fw-mark-flash {
  outline: 2px solid rgba(110, 86, 207, 0.9);
  outline-offset: 1px;
}
`
