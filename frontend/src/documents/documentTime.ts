/** "2 hours ago" in the UI locale; future stamps clamp to now. */
export function relativeTime(iso: string, locale: string, now = Date.now()): string {
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
  const minutes = Math.min(0, Math.round((Date.parse(iso) - now) / 60000))
  if (minutes > -60) return rtf.format(minutes, 'minute')
  const hours = Math.round(minutes / 60)
  if (hours > -24) return rtf.format(hours, 'hour')
  return rtf.format(Math.round(hours / 24), 'day')
}

/** Full localized date + time (tooltip complement to relativeTime). */
export function absoluteTime(iso: string, locale: string): string {
  const stamp = Date.parse(iso)
  if (Number.isNaN(stamp)) return ''
  return new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(stamp)
}
