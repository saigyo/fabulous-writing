// Render a markdown job summary from vitest's junit XML and coverage summary.
// CI appends the output to $GITHUB_STEP_SUMMARY so test counts, failures, and
// coverage totals show up directly on the workflow run page.
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const frontend = join(dirname(fileURLToPath(import.meta.url)), '..')

console.log('## Frontend test report\n')

const junitPath = join(frontend, 'test-results.xml')
if (!existsSync(junitPath)) {
  console.log('⚠️ `test-results.xml` missing — the test run crashed before reporting.')
  process.exit(0)
}
const xml = readFileSync(junitPath, 'utf8')

// vitest's junit output is machine-generated; the root <testsuites> attributes
// carry the totals, so attribute regexes are dependable here.
const root = xml.match(/<testsuites\b[^>]*>/)?.[0] ?? ''
const attr = (name) => Number(root.match(new RegExp(`${name}="([\\d.]+)"`))?.[1] ?? 0)
const tests = attr('tests')
const failures = attr('failures')
const errors = attr('errors')
const time = attr('time')
const skipped = (xml.match(/<skipped\b/g) ?? []).length
const passed = tests - failures - errors - skipped

let coverage = 'n/a'
const summaryPath = join(frontend, 'coverage', 'coverage-summary.json')
if (existsSync(summaryPath)) {
  const pct = JSON.parse(readFileSync(summaryPath, 'utf8')).total.lines.pct
  coverage = `${pct}%`
}

console.log('| Tests | Passed | Failed | Errors | Skipped | Duration | Line coverage |')
console.log('|--:|--:|--:|--:|--:|--:|--:|')
console.log(
  `| ${tests} | ${passed} | ${failures} | ${errors} | ${skipped}` +
    ` | ${time.toFixed(1)}s | ${coverage} |`,
)

const decode = (s) =>
  s
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')

// Split per test case so a failure can't be attributed to the preceding
// (self-closing) case; \s in the lookups avoids classname= matching name=.
const failedLines = []
for (const chunk of xml.split(/<testcase\s/).slice(1)) {
  const detail = chunk.match(/<(?:failure|error)\b[^>]*/)
  if (!detail) continue
  const attrs = chunk.slice(0, chunk.indexOf('>'))
  const name = attrs.match(/(?:^|\s)name="([^"]*)"/)?.[1] ?? '?'
  const classname = attrs.match(/(?:^|\s)classname="([^"]*)"/)?.[1] ?? ''
  const message = detail[0].match(/message="([^"]*)"/)?.[1] ?? ''
  failedLines.push(
    `- \`${classname} > ${name}\` — ${decode(message).split('\n')[0].slice(0, 200)}`,
  )
}
if (failedLines.length > 0) {
  console.log('\n### Failures\n')
  for (const line of failedLines) console.log(line)
}

console.log('\nFull HTML coverage report: `frontend-coverage-report` artifact below.')
