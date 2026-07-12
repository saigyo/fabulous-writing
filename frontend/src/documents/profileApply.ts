import { useStore } from '../state/store'
import type { Profile } from '../types'

// One-shot flag: opening a document that switches the language must not let
// the Header's profile effect overwrite the document's own LLM settings.
let suppressProfileApply = false

export function consumeProfileApplySuppression(): boolean {
  const value = suppressProfileApply
  suppressProfileApply = false
  return value
}

export function setProfileApplySuppressed(value: boolean): void {
  suppressProfileApply = value
}

/** Header's language-switch effect calls this once it has picked which
 * profile to show. Normally a real language switch applies the profile's
 * values to the header selectors (autosaving them onto the document). But
 * when opening a document that supplied no profile (profileId is still null
 * — e.g. its profile_id was pruned server-side because the profile was
 * deleted) and this apply is suppressed (see consumeProfileApplySuppression),
 * the document HAS no profile: adopting the fallback into the store — even
 * "display only" — is deferred corruption, because selectProfile
 * unconditionally writes profileId/lastProfileByLanguage, and the next
 * autosave would persist that onto a document that deliberately has none.
 * So this case leaves the store untouched; the selector shows an explicit
 * empty selection instead. */
export function applyHeaderProfileSelection(
  selectProfile: (profile: Profile, apply: boolean) => void,
  chosen: Profile,
  isSwitch: boolean,
): void {
  const suppressed = consumeProfileApplySuppression()
  if (suppressed && useStore.getState().profileId === null) {
    return
  }
  selectProfile(chosen, isSwitch && !suppressed)
}
