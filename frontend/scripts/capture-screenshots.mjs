// Re-capture the README screenshots (docs/images/*.png).
//
// Prerequisites:
//   1. Backend and frontend dev servers running (ports 8000 / 5173),
//      with the seeded "Product docs" terminology domain present.
//   2. A Playwright Chromium build:  npx playwright install --only-shell chromium
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

// Shot 1: editor with the EN Standard profile's example text; terminology
// finding selected so the one-click fix and rewrite button are visible.
// The example no longer auto-selects a domain, so pick "Product docs" and
// save it into the EN Standard profile (idempotent; keeps the shot's
// profile selector clean instead of showing the dirty marker).
await languageSelect.selectOption('en')
await page.locator('.domain-multiselect-toggle').click()
await page
  .locator('.domain-multiselect-menu label', { hasText: 'Product docs' })
  .locator('input')
  .check()
await page.keyboard.press('Escape')
await page.mouse.click(700, 400) // close the menu
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
// Catch the live LLM status with its token counter (needs a running Ollama).
await page
  .locator('.check-status', { hasText: 'tokens' })
  .waitFor({ timeout: 30000 })
  .catch(() => console.log('note: no LLM token status captured (LLM idle or too fast)'))
await page.waitForTimeout(3000) // let the timer/counter reach a representative value
await page.screenshot({ path: `${outDir}/editor.png` })
console.log('editor.png captured, findings:', await page.locator('.finding-row').count())

// Shot 2: rule catalog for German with one spaCy pattern expanded.
await languageSelect.selectOption('de')
await page.locator('.view-switch button', { hasText: 'Rules' }).click()
await page.waitForTimeout(800)
await page
  .locator('.rule-card', { hasText: 'style.wuerde-stil' })
  .locator('summary')
  .click()
await page.waitForTimeout(300)
await page.screenshot({ path: `${outDir}/rules.png` })
console.log('rules.png captured, cards:', await page.locator('.rule-card').count())

// Shot 3: terminology view with the seeded domain.
await page.locator('.view-switch button', { hasText: 'Terminology' }).click()
await page.waitForTimeout(600)
await page.screenshot({ path: `${outDir}/terminology.png` })
console.log('terminology.png captured')

// Shot 4: profiles view with the seeded EN profiles (Standard selected).
await languageSelect.selectOption('en')
await page.waitForTimeout(600)
await page.locator('.view-switch button', { hasText: 'Profiles' }).click()
await page.waitForTimeout(600)
await page.screenshot({ path: `${outDir}/profiles.png` })
console.log('profiles.png captured, cards:', await page.locator('.profile-card').count())

await browser.close()
console.log(`DONE — screenshots written to ${outDir}`)
