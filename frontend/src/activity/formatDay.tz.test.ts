// Dedicated file (there is no shared formatDay.test.ts to merge into)
// because this sets process.env.TZ before any Date use — vitest isolates
// test files per worker/process, so this cannot leak into other files'
// Date behavior. Runtime TZ changes are honored by Node/V8's Date and Intl
// implementations on the linux/macOS runners this repo's gates run on
// (Date/Intl read TZ lazily, not just at process startup); this would need
// revisiting on a runtime where that isn't true.
//
// Why this file exists: the west-of-UTC regression formatDay.ts guards
// against (see its own TIMEZONE TRAP comment) is invisible to a test suite
// that runs in UTC — a test process's default TZ in CI. Without forcing a
// west-of-UTC zone, swapping the split-construction back to a naive `new
// Date(isoDay)` would still pass every other formatDay/ActivityView test.
//
// tsconfig.app.json (which tsc -b type-checks this file under) declares
// only `"types": ["vite/client"]`, not "node" — typed locally instead of
// pulling in @types/node globally for this one Node runtime global
// (present at test-run time regardless); same idiom as api/sse.test.ts.
declare const process: { env: Record<string, string | undefined> }
process.env.TZ = 'America/New_York'

import { describe, expect, it } from 'vitest'
import { formatDay } from './formatDay'

describe('formatDay: west-of-UTC guard (America/New_York)', () => {
  it('does not roll the date back a day (mid-year, DST)', () => {
    // A naive `new Date('2026-07-26')` parses as UTC midnight, which is
    // 2026-07-25T20:00 in America/New_York (EDT, UTC-4) — the mutation
    // this test catches renders "25.07.2026" instead.
    expect(formatDay('2026-07-26', 'de')).toBe('26.07.2026')
  })

  it('does not roll the date back across a year boundary (winter, no DST)', () => {
    // A naive `new Date('2026-01-01')` parses as UTC midnight, which is
    // 2025-12-31T19:00 in America/New_York (EST, UTC-5) — the mutation
    // this test catches renders "31.12.2025" instead.
    expect(formatDay('2026-01-01', 'de')).toBe('01.01.2026')
  })
})
