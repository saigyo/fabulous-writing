// Re-capture the README screenshots (docs/images/*.png).
//
// Prerequisites:
//   1. Backend and frontend dev servers running (ports 8000 / 5173),
//      with the seeded "Product docs" terminology domain present.
//   2. A Playwright Chromium build:  npx playwright install --only-shell chromium
//   3. Ollama running: the editor shot switches the EN Standard profile to
//      the local tier so the slow local model keeps the LLM status line and
//      the "Checking…" button visible long enough to capture (the profile's
//      original tier is restored via the API afterwards); the scorecard shot
//      waits for that same check to finish.
//   4. Every feature router requires a logged-in caller (M2). FW_ADMIN_EMAIL
//      and FW_ADMIN_PASSWORD must be set in the environment this script runs
//      in and must match the bootstrap admin the target backend seeded —
//      the script logs in as that admin, both for its own API staging calls
//      and to drive the browser past the login gate.
//
// The script stages its own scratch documents and project folders through
// the API (distinctive names; it ABORTS on a 409 rather than reuse yours)
// and deletes them again in a finally block — your own documents are never
// opened or modified. They WOULD still be visible in the sidebar shots,
// though, so for publishable screenshots run against a scratch stack and
// point the script at it:
//
//   cd backend && PYTHONPATH=$PWD uv run python <scratch-backend.py>   # :8001, temp DB
//   cd frontend && VITE_API_URL=http://127.0.0.1:8001 npm run build \
//     && npx vite preview --port 4199 --strictPort &
//   FW_ADMIN_EMAIL=... FW_ADMIN_PASSWORD=... \
//     SHOTS_API=http://127.0.0.1:8001 SHOTS_APP=http://localhost:4199 npm run screenshots
//   cd frontend && npm run build   # restore the production dist afterwards
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

const API = process.env.SHOTS_API ?? 'http://localhost:8000'
const APP = process.env.SHOTS_APP ?? 'http://localhost:5173'

const ADMIN_EMAIL = process.env.FW_ADMIN_EMAIL
const ADMIN_PASSWORD = process.env.FW_ADMIN_PASSWORD
if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
  throw new Error(
    'FW_ADMIN_EMAIL and FW_ADMIN_PASSWORD must be set — every feature ' +
      'router requires a logged-in caller as of M2, and this script logs ' +
      "in as the target backend's bootstrap admin to drive both its own " +
      'API staging calls and the browser.',
  )
}

// The one unauthenticated call this script makes. Every other request —
// staging, cleanup, and the profile switch/restore — goes through api()
// below so the bearer token is never attached in more than one place.
async function login() {
  const res = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  })
  if (!res.ok) {
    throw new Error(`POST /api/auth/login: ${res.status} (check FW_ADMIN_EMAIL/FW_ADMIN_PASSWORD)`)
  }
  const { token } = await res.json()
  return token
}

const token = await login()

// The single authenticated request helper. Every API call in this script —
// staging, cleanup, folder creation, and the profile switch/restore — routes
// through this one function so the bearer header is attached in exactly one
// place; nothing here reaches for a bare fetch() of its own. `raw: true`
// returns the unparsed Response instead of throwing on a non-OK status, for
// the one caller (makeFolder) that needs to distinguish a 409 from the rest.
async function api(pathname, init = {}, { raw = false } = {}) {
  const res = await fetch(`${API}${pathname}`, {
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    ...init,
  })
  if (raw) return res
  if (!res.ok) {
    throw new Error(`${init.method ?? 'GET'} ${pathname}: ${res.status}`)
  }
  return res.status === 204 ? null : res.json()
}

// The EN Standard profile is temporarily switched to the local tier (see
// header comment); remember its pre-run state for restoration.
const standardProfile = (await api('/api/profiles?language=en')).find(
  (p) => p.name === 'Standard',
)

// --- Scratch content -------------------------------------------------------
// Created via the API before the browser starts, deleted in the finally
// block. Creation order matters twice: names must not collide with existing
// folders (abort on 409 — never reuse or delete the owner's folders), and
// the LAST-created document is the most recent one, which the app opens.

const scratch = { folderIds: [], docIds: [] }

async function makeFolder(name) {
  const res = await api(
    '/api/folders',
    { method: 'POST', body: JSON.stringify({ name }) },
    { raw: true },
  )
  if (res.status === 409) {
    throw new Error(
      `A folder named '${name}' already exists — refusing to touch it. ` +
        'Rename yours or adjust the scratch names in this script.',
    )
  }
  if (!res.ok) throw new Error(`POST /api/folders: ${res.status}`)
  const folder = await res.json()
  scratch.folderIds.push(folder.id)
  return folder
}

async function makeDoc(name, folderId = null) {
  const doc = await api('/api/documents', {
    method: 'POST',
    body: JSON.stringify({
      name,
      name_source: 'user',
      language: 'en',
      ...(folderId !== null ? { folder_id: folderId } : {}),
    }),
  })
  scratch.docIds.push(doc.id)
  return doc
}

async function stageScratchContent() {
  const blog = await makeFolder('Blog posts')
  const guides = await makeFolder('Product guides')
  await makeDoc('Meeting notes')
  await makeDoc('Getting started', guides.id)
  await makeDoc('Install & configure', guides.id)
  await makeDoc('Why writing tools need determinism', blog.id)
  // Created last => most recent => the document the app opens.
  await makeDoc('Launch announcement', blog.id)

  // Folder defaults on "Product guides" for the dialog shot: language +
  // Technical Documentation profile + the seeded Product docs domain.
  const profiles = await api('/api/profiles?language=en')
  const techdocs = profiles.find((p) => p.name.includes('Technical'))
  const domains = await api('/api/domains')
  const productDocs = domains.find((d) => d.name === 'Product docs')
  if (techdocs) {
    await api(`/api/folders/${guides.id}/defaults`, {
      method: 'PUT',
      body: JSON.stringify({
        default_language: 'en',
        default_profile_id: techdocs.id,
        default_domain_ids: productDocs ? [productDocs.id] : null,
        default_llm_auto: true,
      }),
    })
  } else {
    console.log('note: no Technical Documentation profile — folder defaults shot will be sparse')
  }
}

async function cleanupScratchContent() {
  for (const id of scratch.docIds) {
    await api(`/api/documents/${id}`, { method: 'DELETE' }).catch((e) =>
      console.log(`cleanup: document ${id}: ${e.message}`),
    )
  }
  for (const id of scratch.folderIds) {
    await api(`/api/folders/${id}`, { method: 'DELETE' }).catch((e) =>
      console.log(`cleanup: folder ${id}: ${e.message}`),
    )
  }
  console.log(
    `cleanup: removed ${scratch.docIds.length} scratch documents, ${scratch.folderIds.length} folders`,
  )
}

await stageScratchContent()

const browser = await chromium.launch({ executablePath: chromiumExecutable() })
const page = await browser.newPage({
  viewport: { width: 1600, height: 860 },
  deviceScaleFactor: 2,
})
page.on('pageerror', (e) => console.log('[pageerror]', e.message))

try {
  await page.goto(`${APP}/`, { waitUntil: 'networkidle' })
  await page.evaluate(() => localStorage.clear())
  await page.reload({ waitUntil: 'networkidle' })

  // Task 7 gates the whole app behind a login screen: the reload above now
  // lands on it rather than the editor. Drive it with the same admin
  // credentials used for the API staging calls (selectors are the input
  // type and the form's own class, not translated label text, so this does
  // not depend on the UI locale the app happens to pick).
  await page.locator('input[type="email"]').fill(ADMIN_EMAIL)
  await page.locator('input[type="password"]').fill(ADMIN_PASSWORD)
  await page.locator('.login-submit').click()
  await page.locator('.view-switch').waitFor()
  await page.waitForTimeout(800)

  const languageSelect = page.locator(
    '.header-controls label:has-text("Language") select',
  )

  // The editor shot switches the header to the local tier and dirties/saves
  // the profile, so it comes late — the other shots then show the pristine
  // seeded profile state and an idle header. The scorecard shot reuses the
  // editor shot's completed check, so it comes last.

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

  // Shot 4: the document sidebar with the scratch folders and documents and
  // the "Product guides" folder menu open (New document here / Folder
  // defaults / Rename / Delete). Clipped to the sidebar plus a margin for
  // the menu flyout.
  await page.locator('.view-switch button', { hasText: 'Editor' }).click()
  await page.waitForTimeout(400)
  const guidesGroup = page.locator('.folder-group', {
    has: page.locator('.folder-name', { hasText: 'Product guides' }),
  })
  await guidesGroup.locator('.folder-head').hover()
  await guidesGroup.locator('.folder-head .doc-menu-button').click()
  await page.waitForTimeout(300)
  const sidebarBox = await page.locator('.doc-sidebar').boundingBox()
  await page.screenshot({
    path: `${outDir}/documents.png`,
    clip: {
      x: sidebarBox.x,
      y: sidebarBox.y,
      width: sidebarBox.width + 210,
      height: Math.min(sidebarBox.height, 640),
    },
  })
  console.log('documents.png captured')

  // Shot 5: the folder-defaults dialog for "Product guides", pre-filled via
  // the API during staging (language + profile + domain + auto).
  await guidesGroup
    .locator('.folder-head .doc-menu button', { hasText: 'Folder defaults' })
    .click()
  await page.locator('.folder-defaults-dialog').waitFor()
  await page.waitForTimeout(600) // profile list fetch settles the selects
  await page.locator('.folder-defaults-dialog').screenshot({
    path: `${outDir}/folder-defaults.png`,
  })
  console.log('folder-defaults.png captured')
  await page.locator('.fd-cancel').click()
  await page.waitForTimeout(200)

  // Shot 6: editor with the EN Standard profile's example text loaded into
  // the (empty) scratch document; a terminology finding selected so the
  // one-click fix and rewrite button are visible, and the LLM check caught
  // mid-run (status line + "Checking…"). The example no longer auto-selects
  // a domain, so pick "Product docs" and save it into the EN Standard
  // profile together with the local tier (keeps the shot's profile selector
  // clean instead of showing the dirty marker; the tier is restored via the
  // API afterwards).
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

  // Shot 7: the quality score expanded into its scorecard, cropped to the
  // sidebar header + panel with a slice of the editor for context. Needs the
  // LLM check (and its craft scorecard) to COMPLETE first.
  await page
    .locator('.check-status', { hasText: 'tokens' })
    .waitFor({ state: 'detached', timeout: 300000 })
    .catch(() => console.log('note: LLM check still running — scorecard may be mechanics-only'))
  await page.waitForTimeout(800)
  await page.locator('.score-badge').click()
  await page.locator('.score-panel').waitFor()
  await page.waitForTimeout(300)
  const headerBox = await page.locator('.sidebar-header').boundingBox()
  const panelBox = await page.locator('.score-panel').boundingBox()
  const left = Math.max(0, panelBox.x - 420)
  const top = Math.max(0, headerBox.y - 10)
  const right = Math.min(1600, panelBox.x + panelBox.width + 14)
  await page.screenshot({
    path: `${outDir}/scorecard.png`,
    clip: {
      x: left,
      y: top,
      width: right - left,
      height: panelBox.y + panelBox.height + 14 - top,
    },
  })
  console.log(
    'scorecard.png captured, dimensions:',
    await page.locator('.score-dimension-row').count(),
  )
} finally {
  await browser.close()
  await cleanupScratchContent()

  // Restore the EN Standard profile's pre-run LLM settings (the domain save
  // is intentional and stays; the local-tier switch is shot-only). Re-fetch
  // so only the LLM fields are reverted.
  if (standardProfile) {
    const now = (await api('/api/profiles?language=en')).find(
      (p) => p.id === standardProfile.id,
    )
    const { id, is_standard: _is_standard, language: _language, ...payload } = {
      ...now,
      llm_tier: standardProfile.llm_tier,
      llm_provider: standardProfile.llm_provider,
      llm_model: standardProfile.llm_model,
    }
    const res = await api(
      `/api/profiles/${id}`,
      { method: 'PUT', body: JSON.stringify(payload) },
      { raw: true },
    )
    console.log(`Standard profile restored (llm_tier=${standardProfile.llm_tier}): ${res.status}`)
  }
}
console.log(`DONE — screenshots written to ${outDir}`)
