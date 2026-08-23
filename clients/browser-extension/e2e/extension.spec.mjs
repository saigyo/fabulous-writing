// Playwright e2e for the browser extension (Task 10, B43 C2) — the full
// composed loop: connect -> login -> type -> findings -> overlay -> apply ->
// field text replaced and re-checked. Driven by e2e/run.mjs, which boots a
// real backend and a static fixture server first and passes their addresses
// (implicitly, via the hardcoded ports below) plus the admin credentials.
//
// No Playwright test-runner dependency — plain async function, playwright-
// core only, matching frontend/scripts/capture-screenshots.mjs's own
// pattern. Every assertion step is wrapped so a thrown error carries a
// `.step` name run.mjs can report, and a failure screenshots every open page
// into e2e/.tmp/<run>/failure-*.png before rethrowing.
import assert from 'node:assert/strict'
import path from 'node:path'
import { chromium } from 'playwright-core'

const BACKEND = 'http://localhost:8100'
const FIXTURE_URL = 'http://localhost:8101/fixture.html'

let currentStep = 'setup'

function fail(message) {
  const err = new Error(`${currentStep}: ${message}`)
  err.step = currentStep
  throw err
}

async function step(name, fn) {
  currentStep = name
  console.log(`  [spec] ${name}`)
  return fn()
}

export default async function runSpec({
  adminEmail,
  adminPassword,
  extensionId,
  distDir,
  tmpDir,
  headless,
}) {
  // ---- Step 1: API preflight (fail fast, before any browser work) ----
  let token
  await step('1. API preflight: login + deterministic rules check', async () => {
    const loginRes = await fetch(`${BACKEND}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: adminEmail, password: adminPassword }),
    })
    if (!loginRes.ok) {
      fail(`POST /api/auth/login: ${loginRes.status} ${await loginRes.text()}`)
    }
    ;({ token } = await loginRes.json())

    // "This is is a test." trips the en/grammar/repeated-words rule
    // deterministically (the doubled "is is") with no LLM involved — the
    // 'rules' checker runs unconditionally, so no profile/domain setup is
    // required before this call.
    const checkRes = await fetch(`${BACKEND}/api/checks`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        text: 'This is is a test.',
        language: 'en',
        checkers: ['rules'],
        client: 'web',
      }),
    })
    if (!checkRes.ok) {
      fail(`POST /api/checks: ${checkRes.status} ${await checkRes.text()}`)
    }
    const body = await checkRes.json()
    assert.ok(
      body.findings.some((f) => f.rule_id?.includes('repeated-words')),
      `expected a repeated-words finding, got: ${JSON.stringify(body.findings)}`,
    )
  })

  // ---- Browser setup ----
  let context
  await step('browser launch', async () => {
    const userDataDir = path.join(tmpDir, 'chrome-profile')
    try {
      context = await chromium.launchPersistentContext(userDataDir, {
        // LOAD-BEARING, not stylistic: the default chrome-headless-shell
        // build cannot load extensions — only the full 'chromium' channel's
        // new headless mode can (task brief).
        channel: 'chromium',
        headless,
        // Pinned so UI-text assertions (step 10's disconnected strip) are
        // deterministic regardless of the host machine's own locale — the
        // embed's LocaleSwitcher defaults to the browser's language, and
        // this machine's default resolves to German.
        locale: 'en-US',
        args: [
          `--disable-extensions-except=${distDir}`,
          `--load-extension=${distDir}`,
        ],
      })
    } catch (err) {
      if (/Executable doesn't exist|download|browserType\.launch/i.test(String(err?.message))) {
        fail(
          `Chromium launch failed (${err.message}). Run ` +
          `"npx playwright install chromium" from clients/browser-extension/ and retry.`,
        )
      }
      throw err
    }
  })

  const openPages = []
  let failed = false
  try {
    // Neutralize the extension's own real side panel for the duration of
    // this run. The spec deliberately drives panel.html as a PLAIN TAB
    // (Playwright cannot attach to the actual chrome://side-panel surface —
    // this is the spec's own testing note, matching Task 7's finding that a
    // real CDP-driven click genuinely triggers chrome.sidePanel.open()).
    // Left un-neutralized, step 4's affordance click would open a SECOND,
    // real side-panel document that also connects a 'panel' port under the
    // same windowId — the service worker's panel-port registry (sw.ts) is
    // keyed by windowId only and the last port to connect wins, so that
    // second, unauthenticated document would silently steal every relayed
    // message away from the tab this spec actually drives. Stubbing
    // chrome.sidePanel.open() to reject keeps our manually-opened tab the
    // only 'panel' port for the whole run; the SW's own onError fallback
    // (a transient ctl status 'error' on the field chip) is harmless and is
    // overwritten by the embed's real status the moment it connects.
    await step('neutralize the real side panel (test harness only)', async () => {
      let sw = context.serviceWorkers()[0]
      if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 10000 })
      await sw.evaluate(() => {
        chrome.sidePanel.open = () => Promise.reject(new Error('disabled for e2e'))
      })
    })

    // ---- Step 2: fixture page + scout affordance ----
    const fixture = await context.newPage()
    openPages.push(['fixture', fixture])
    const textarea = fixture.locator('#box')
    const affordanceHost = fixture.locator('[data-fw-affordance]')
    const chip = affordanceHost.locator('button')

    await step('2. fixture page: scout affordance appears on hover', async () => {
      await fixture.goto(FIXTURE_URL)
      await textarea.hover()
      await affordanceHost.waitFor({ state: 'visible', timeout: 10000 })
    })

    // ---- Step 3: options page (set server URL) + panel tab ----
    let panelPage
    await step('3. options page: set server URL (exercises Task 9)', async () => {
      const optionsPage = await context.newPage()
      openPages.push(['options', optionsPage])
      await optionsPage.goto(`chrome-extension://${extensionId}/options.html`)
      await optionsPage.locator('#server-url-input').fill(BACKEND)
      await optionsPage.locator('[data-action="save"]').click()
      await optionsPage
        .locator('[role="status"]')
        .filter({ hasText: 'Saved' })
        .waitFor({ timeout: 5000 })
      await optionsPage.close()

      panelPage = await context.newPage()
      openPages.push(['panel', panelPage])
      await panelPage.goto(`chrome-extension://${extensionId}/panel.html`)
    })

    // ---- Step 4: focus field, click affordance chip ----
    await step('4. fixture: focus textarea, click affordance chip', async () => {
      await fixture.bringToFront()
      await textarea.focus()
      await textarea.hover()
      await affordanceHost.waitFor({ state: 'visible' })
      await chip.click()
      await fixture.waitForFunction(
        () => document.querySelector('[data-fw-affordance]')?.shadowRoot
          ?.querySelector('button')?.dataset.state !== 'idle',
        { timeout: 5000 },
      )
    })

    // ---- Step 5: login inside the embed iframe ----
    let embedFrame
    await step('5. panel: log in inside the embed iframe, wait for sidebar', async () => {
      embedFrame = panelPage.frameLocator('#embed')
      await embedFrame.locator('input[type="email"]').waitFor({ timeout: 15000 })
      await embedFrame.locator('input[type="email"]').fill(adminEmail)
      await embedFrame.locator('input[type="password"]').fill(adminPassword)
      await embedFrame.locator('.login-submit').click()
      await embedFrame.locator('.sidebar').waitFor({ timeout: 15000 })
    })

    // ---- Step 6: type the doubled-word probe text ----
    await step('6. fixture: type "This is is a test."', async () => {
      await fixture.bringToFront()
      await textarea.fill('This is is a test.')
    })

    // ---- Step 7: finding renders + overlay geometry ----
    const mark = fixture.locator('.fw-mirror-overlay .fw-mark').first()
    await step('7. panel: finding renders; fixture: overlay mark + geometry', async () => {
      await embedFrame.locator('.finding-row').first().waitFor({ timeout: 20000 })
      await mark.waitFor({ state: 'visible', timeout: 20000 })

      const textareaBox = await textarea.boundingBox()
      const markBox = await mark.boundingBox()
      assert.ok(textareaBox && markBox, 'expected both bounding boxes to resolve')

      assert.ok(
        markBox.x >= textareaBox.x - 0.5 &&
          markBox.y >= textareaBox.y - 0.5 &&
          markBox.x + markBox.width <= textareaBox.x + textareaBox.width + 0.5 &&
          markBox.y + markBox.height <= textareaBox.y + textareaBox.height + 0.5,
        `mark box ${JSON.stringify(markBox)} not contained in textarea box ${JSON.stringify(textareaBox)}`,
      )

      const lineHeight = await textarea.evaluate((el) => {
        const computed = getComputedStyle(el).lineHeight
        const parsed = parseFloat(computed)
        if (!Number.isNaN(parsed)) return parsed
        // 'normal' (Chrome does not resolve this to a px value on a
        // <textarea> the way it does for most other elements) — measure
        // the font's own used line-height via a same-font probe span, the
        // standard technique: a lone inline box's line box height IS the
        // 'normal' used value for that font.
        const probe = document.createElement('span')
        probe.style.font = getComputedStyle(el).font
        probe.style.position = 'absolute'
        probe.style.visibility = 'hidden'
        probe.textContent = 'M'
        document.body.appendChild(probe)
        const height = probe.getBoundingClientRect().height
        probe.remove()
        return height
      })
      assert.ok(
        markBox.height < 1.5 * lineHeight,
        `mark height ${markBox.height} not < 1.5x line-height ${lineHeight} (multi-line paint?)`,
      )

      assert.ok(
        markBox.x > textareaBox.x + 10,
        `mark x ${markBox.x} not right of textarea start (textarea x ${textareaBox.x}) — the doubled word is mid-sentence`,
      )
    })

    // ---- Step 8: apply the suggestion ----
    await step('8. panel: click apply; fixture: text collapses, mark clears', async () => {
      await embedFrame.locator('.finding-row').first().click()
      const applyButton = embedFrame.locator('.suggestion-button').first()
      await applyButton.waitFor({ timeout: 5000 })
      await applyButton.click()

      await fixture.waitForFunction(
        () => document.querySelector('#box')?.value === 'This is a test.',
        { timeout: 10000 },
      )
      await fixture
        .locator('.fw-mirror-overlay .fw-mark')
        .waitFor({ state: 'detached', timeout: 20000 })
        .catch(async () => {
          // waitFor 'detached' on a locator with zero matches can resolve
          // immediately in some Playwright versions but not others across a
          // count transition — fall back to an explicit count poll.
          await fixture.waitForFunction(
            () => document.querySelectorAll('.fw-mirror-overlay .fw-mark').length === 0,
            { timeout: 20000 },
          )
        })
    })

    // ---- Step 9: chip shows connected state ----
    await step('9. fixture: affordance chip shows the connected state', async () => {
      await fixture.waitForFunction(
        () => document.querySelector('[data-fw-affordance]')?.shadowRoot
          ?.querySelector('button')?.dataset.state === 'connected',
        { timeout: 10000 },
      )
    })

    // ---- Step 10: disconnect ----
    await step('10. disconnect: overlay removed, panel shows disconnected strip', async () => {
      await chip.click()
      await fixture.locator('.fw-mirror-overlay').waitFor({ state: 'detached', timeout: 10000 })
      await embedFrame
        .locator('.embed-connection-strip')
        .filter({ hasText: 'No text field connected.' })
        .waitFor({ timeout: 10000 })
    })

    console.log('  [spec] all 10 steps PASSED')
  } catch (err) {
    failed = true
    for (const [name, page] of openPages) {
      // Tolerate an already-closed page (the options page is explicitly
      // closed on the success path of step 3; a failure elsewhere in that
      // same step can still leave it open and mid-interaction, which is
      // exactly the case this screenshot exists to capture) — skip it
      // rather than let a "Target closed" error from screenshot() itself
      // interrupt diagnostics for the other open pages.
      if (page.isClosed()) continue
      try {
        await page.screenshot({ path: path.join(tmpDir, `failure-${name}.png`) })
      } catch {
        // best-effort diagnostics only
      }
    }
    if (!err.step) err.step = currentStep
    throw err
  } finally {
    await context.close()
    if (!failed) {
      // Nothing else to clean up on the success path — the persistent
      // profile lives under tmpDir, which the caller owns.
    }
  }
}
