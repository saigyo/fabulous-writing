import type { Messages } from '../i18n'

// GoTrue's weak_password reason vocabulary. Priority: the most actionable
// message wins when several reasons arrive -- a breached password must be
// said out loud even if it is also too short.
export function mapWeakPasswordReasons(reasons: string[] | undefined, m: Messages): string {
  if (reasons?.includes('pwned')) return m.pwWeakPwned
  if (reasons?.includes('characters')) return m.pwWeakCharacters
  if (reasons?.includes('length')) return m.pwWeakLength
  return m.pwWeakGeneric
}
