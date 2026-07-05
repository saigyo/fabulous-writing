import type { Messages } from '../i18n/messages'

/** Claude-Code-style live status for the LLM check phase. */
export function llmStatusLabel(
  elapsedMs: number,
  tokens: number | null,
  messages: Messages,
): string {
  const totalSeconds = Math.floor(elapsedMs / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  const elapsed = minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`
  return messages.llmChecking(elapsed, tokens)
}
