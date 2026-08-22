// Module-level singleton for the bridge's outbound sender, set once from
// main.tsx — mirrors editor/editorRef.ts's EditorView ref. main.tsx renders
// <EmbedApp /> with no props (spec's sketch), so EmbedApp has no other way
// to reach the outbound object it must wire the check scheduler's onInput
// into (Step 4: "handed to the hostDoc outbound's onInput").
import type { HostDocOutbound } from './hostDoc'

let outbound: HostDocOutbound | null = null

export function setEmbedOutbound(o: HostDocOutbound | null): void {
  outbound = o
}

export function getEmbedOutbound(): HostDocOutbound | null {
  return outbound
}
