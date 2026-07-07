// Re-capture the README screenshots (docs/images/*.png).
//
// Prerequisites:
//   1. Backend and frontend dev servers running (ports 8000 / 5173),
//      with the seeded "Product docs" terminology domain present.
//   2. A Playwright Chromium build:  npx playwright install --only-shell chromium
//   3. Ollama running: the editor shot switches the EN Standard profile to
//      the local tier so the slow local model keeps the LLM status line and
//      the "Checking…" button visible long enough to capture (the profile's
//      original tier is restored via the API afterwards).
//
// Run from frontend/:  npm run screenshots
import { existsSync, readdirSync } from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import { chromium } from 'playwright-core'

const outDir =
  process.env.SHOTS_DIR ??
  path.join(path.dirname(fileURLToPath(import.meta.url)), '../../docs/images')

function chromiumExecutable() {
  const standard = chromium.executablePath()
  if (standard && existsSync(standard)) return standard
  // Fall back to a cached headless shell (what `--only-shell` installs).
  const cache = path.join(
    os.homedir(),
    process.platform === 'darwin' ? 'Library/Caches/ms-playwright' : '.cache/ms-playwright',
  )
  for (const entry of readdirSync(cache).sort().reverse()) {
    if (!entry.startsWith('chromium_headless_shell-')) continue
    const dir = path.join(cache, entry)
    for (const sub of readdirSync(dir)) {
      const bin = path.join(
        dir,
        sub,
        process.platform === 'win32' ? 'chrome-headless-shell.exe' : 'chrome-headless-shell',
      )
      if (existsSync(bin)) return bin
    }
  }
  throw new Error(
    'No Chromium found. Run: npx playwright install --only-shell chromium',
  )
}

const API = 'http://localhost:8000'

// The EN Standard profile is temporarily switched to the local tier (see
// header comment); remember its pre-run state for restoration.
const standardProfile = (await (await fetch(`${API}/api/profiles?language=en`)).json()).find(
  (p) => p.name === 'Standard',
)

const browser = await chromium.launch({ executablePath: chromiumExecutable() })
const page = await browser.newPage({
  viewport: { width: 1600, height: 860 },
  deviceScaleFactor: 2,
})
page.on('pageerror', (e) => console.log('[pageerror]', e.message))

await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' })
await page.evaluate(() => localStorage.clear())
await page.reload({ waitUntil: 'networkidle' })
await page.waitForTimeout(800)

const languageSelect = page.locator(
  '.header-controls label:has-text("Language") select',
)

// The editor shot switches the header to the local tier and dirties/saves
// the profile, so it comes LAST — the other shots then show the pristine
// seeded profile state and an idle header.

// Shot 1: rule catalog for German with one spaCy pattern expanded; framed on
// the Stil section heading so the category dot/count/chevron and the
// category checkbox are in view.
await languageSelect.selectOption('de')
await page.locator('.view-switch button', { hasText: 'Rules' }).click()
await page.waitForTimeout(800)
await page
  .locator('.rule-card', { hasText: 'style.wuerde-stil' })
  .locator('summary')
  .click()
await page.waitForTimeout(300)
await page
  .locator('.rules-group', { has: page.locator('.rule-card', { hasText: 'style.wuerde-stil' }) })
  .locator('h3')
  .evaluate((el) => el.scrollIntoView())
await page.waitForTimeout(300)
await page.screenshot({ path: `${outDir}/rules.png` })
console.log('rules.png captured, cards:', await page.locator('.rule-card').count())

// Shot 2: terminology view with the seeded Product docs domain (the fuller
// of the seeded domains).
await page.locator('.view-switch button', { hasText: 'Terminology' }).click()
await page.waitForTimeout(600)
await page.locator('.domain-row', { hasText: 'Product docs' }).click()
await page.waitForTimeout(600)
await page.screenshot({ path: `${outDir}/terminology.png` })
console.log('terminology.png captured')

// Shot 3: profiles view with the seeded EN profiles (Standard selected).
// Scroll so the Marketing card's rule-pack chips are fully in view (it sits
// below the fold otherwise, since Standard's card is tall).
await languageSelect.selectOption('en')
await page.waitForTimeout(600)
await page.locator('.view-switch button', { hasText: 'Profiles' }).click()
await page.waitForTimeout(600)
const marketingPacks = page
  .locator('.profile-card', { has: page.locator('.profile-card-title input[value="Marketing"]') })
  .locator('.profile-card-packs')
await marketingPacks.scrollIntoViewIfNeeded()
await page.waitForTimeout(200)
await page.screenshot({ path: `${outDir}/profiles.png` })
console.log('profiles.png captured, cards:', await page.locator('.profile-card').count())

// Shot 4 (last): editor with the EN Standard profile's example text; a
// terminology finding selected so the one-click fix and rewrite button are
// visible, and the LLM check caught mid-run (status line + "Checking…").
// The example no longer auto-selects a domain, so pick "Product docs" and
// save it into the EN Standard profile together with the local tier
// (keeps the shot's profile selector clean instead of showing the dirty
// marker; the tier is restored via the API afterwards).
await page.locator('.view-switch button', { hasText: 'Editor' }).click()
await page.waitForTimeout(400)
await page.locator('.domain-multiselect-toggle').click()
await page
  .locator('.domain-multiselect-menu label', { hasText: 'Product docs' })
  .locator('input')
  .check()
await page.keyboard.press('Escape')
await page.mouse.click(700, 400) // close the menu
// Local tier: slow enough to reliably catch the running LLM check.
await page.locator('.llm-select-row select').selectOption('local')
await page.waitForTimeout(400)
const saveButton = page.locator('.profile-dirty-actions .icon-button').first()
if (await saveButton.isVisible().catch(() => false)) {
  await saveButton.click()
  await page.waitForTimeout(600)
}
await page.locator('.load-example').click()
await page.waitForTimeout(2500)
const loginRow = page.locator('.finding-row', { hasText: 'login' }).first()
await loginRow.click()
await page.waitForTimeout(400)
await loginRow.evaluate((el) => el.closest('.sidebar')?.scrollBy(0, 200))
// Catch the live LLM status with its token counter (needs a running Ollama;
// generous timeout — a cold local model loads for a while before streaming).
await page
  .locator('.check-status', { hasText: 'tokens' })
  .waitFor({ timeout: 90000 })
  .catch(() => console.log('note: no LLM token status captured (LLM idle or too fast)'))
await page.waitForTimeout(3000) // let the timer/counter reach a representative value
await page.screenshot({ path: `${outDir}/editor.png` })
console.log('editor.png captured, findings:', await page.locator('.finding-row').count())

await browser.close()

// Restore the EN Standard profile's pre-run LLM settings (the domain save is
// intentional and stays; the local-tier switch is shot-only). Re-fetch so
// only the LLM fields are reverted.
if (standardProfile) {
  const now = (await (await fetch(`${API}/api/profiles?language=en`)).json()).find(
    (p) => p.id === standardProfile.id,
  )
  const { id, is_standard, language, ...payload } = {
    ...now,
    llm_tier: standardProfile.llm_tier,
    llm_provider: standardProfile.llm_provider,
    llm_model: standardProfile.llm_model,
  }
  const res = await fetch(`${API}/api/profiles/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  console.log(`Standard profile restored (llm_tier=${standardProfile.llm_tier}): ${res.status}`)
}
console.log(`DONE — screenshots written to ${outDir}`)
