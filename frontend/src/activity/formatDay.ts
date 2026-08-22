// Locale-aware day formatting for the activity charts' x-axis labels and
// per-day tooltips (B40, #124 — Markus's 2026-08-22 interactive request; see
// docs/superpowers/specs/2026-08-22-b40-activity-usage-diagrams-design.md
// R5's amendment). Presentation only — the ISO `days` strings themselves
// stay the data model's keys everywhere (indexing, sorting, API params).
//
// TIMEZONE TRAP: `new Date(isoDay)` parses a bare "YYYY-MM-DD" string as UTC
// MIDNIGHT (the ES spec's date-only form), so formatting it in any timezone
// west of UTC rolls the displayed date back by one day (e.g. 2026-08-20
// UTC-midnight renders as "19.08.2026" for a UTC-5 viewer). Splitting the
// string and constructing a LOCAL date instead sidesteps that: `new
// Date(y, m - 1, d)` is local midnight for the day the ISO string actually
// names, in whatever timezone the browser runs in.
export function formatDay(isoDay: string, locale: string): string {
  const [y, m, d] = isoDay.split('-').map(Number)
  const date = new Date(y, m - 1, d)
  return new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date)
}
