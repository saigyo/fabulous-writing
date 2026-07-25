// Shared registration slot for aborting an in-flight check. Deliberately a
// leaf module: it imports nothing from checking/controller.ts,
// auth/session.ts or documents/documents.ts, and nothing here imports back
// into this module from any of them.
//
// Why this has to be its own module rather than controller.ts registering
// straight into session.ts (or vice versa): documents/hydration.ts already
// imports cancelCheck from controller.ts, and session.ts already imports
// from documents.ts — so controller.ts <-> session.ts wiring directly would
// close a real cycle: controller -> session -> documents -> hydration ->
// controller. That cycle is not merely untidy, it crashes: whichever of
// controller.ts/session.ts is entered *second* in the module graph's
// depth-first evaluation finds the other's registration slot still in its
// temporal dead zone. Task 7's LoginGate imports session.ts directly, so
// once that lands, session.ts can easily become the first of the two
// reached — this is not a hypothetical ordering.
let handler: () => void = () => {}

export function setCancelCheckHandler(fn: () => void): void {
  handler = fn
}

/** Aborts a running check's SSE subscription — see controller.ts's
 * cancelCheck() for what it actually does. A no-op before controller.ts has
 * registered itself. */
export function cancelInFlightCheck(): void {
  handler()
}
