import type { Messages } from './i18n/messages'

/**
 * Display text for a domain/profile selection option. Per-owner uniqueness
 * allows a private entry to shadow a global one of the same name (e.g. two
 * "Product docs"), so global entries get the built-in marker appended —
 * plain option/label text can't carry the styled `.global-badge` pill.
 */
export function ownershipLabel(name: string, isGlobal: boolean, m: Messages): string {
  return isGlobal ? `${name} — ${m.globalBadge}` : name
}
