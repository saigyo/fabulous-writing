#!/usr/bin/env node
// Orchestration for the browser-extension Playwright e2e (Task 10, B43 C2).
// Boots a real backend against a throwaway tmp DB, a static server for
// e2e/fixture.html, then drives extension.spec.mjs's own flow. Local-only —
// not part of CI (it boots a backend); run via `npm run e2e`.
//
// Ports: backend 8100, fixture server 8101. NEVER 5173/8000 (the owner's own
// dev servers) — if either of ours is occupied, this aborts rather than
// killing whatever is holding it.
import { spawn } from 'node:child_process'
import { randomBytes, createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { createReadStream, existsSync, readdirSync, readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { createServer as createNetProbe } from 'node:net'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const EXT_DIR = path.resolve(HERE, '..')
const REPO_ROOT = path.resolve(EXT_DIR, '../..')
const BACKEND_DIR = path.join(REPO_ROOT, 'backend')
const FRONTEND_DIST = path.join(REPO_ROOT, 'frontend', 'dist')
const EXT_DIST = path.join(EXT_DIR, 'dist')

const BACKEND_PORT = 8100
const FIXTURE_PORT = 8101
const HEALTH_URL = `http://localhost:${BACKEND_PORT}/api/health`
const ADMIN_EMAIL = 'e2e-admin@example.com'

// Only processes THIS run spawns are ever torn down — never the occupant of
// an already-bound port (see checkPortFree below).
let backendChild = null
let fixtureServer = null
let tearingDown = false

function log(msg) {
  console.log(`[e2e] ${msg}`)
}

async function checkPortFree(port) {
  await new Promise((resolve, reject) => {
    const probe = createNetProbe()
    probe.once('error', (err) => {
      probe.close()
      if (err.code === 'EADDRINUSE') {
        reject(new Error(
          `port ${port} is already in use — refusing to start (this script ` +
          `never kills the occupant). Free it yourself and re-run.`,
        ))
      } else {
        reject(err)
      }
    })
    probe.once('listening', () => probe.close(() => resolve()))
    probe.listen(port, '127.0.0.1')
  })
}

function deriveExtensionId() {
  // Mirrors scripts/extension-id.mjs exactly (that script is a CLI, not an
  // importable module — this re-derives the same id from the same source).
  const { key } = JSON.parse(readFileSync(path.join(EXT_DIR, 'public', 'manifest.json'), 'utf8'))
  const digest = createHash('sha256').update(Buffer.from(key, 'base64')).digest()
  return [...digest.subarray(0, 16)]
    .flatMap((b) => [b >> 4, b & 0xf])
    .map((n) => String.fromCharCode(97 + n))
    .join('')
}

async function preflight() {
  const manifestPath = path.join(EXT_DIST, 'manifest.json')
  const embedPath = path.join(FRONTEND_DIST, 'embed.html')
  if (!existsSync(manifestPath)) {
    throw new Error(
      `missing ${manifestPath} — run "npm run build" in clients/browser-extension/ first`,
    )
  }
  if (!existsSync(embedPath)) {
    throw new Error(
      `missing ${embedPath} — run "npm run build" in frontend/ first`,
    )
  }
  // frontend/src/api/client.ts's BASE falls back to the literal
  // 'http://localhost:8000' when VITE_API_URL is unset at build time — the
  // right default for the frontend's own two-origin dev flow (5173 -> 8000),
  // but fatal here: the embed is served BY our own throwaway backend (8100)
  // and must call it via relative /api paths (the Dockerfile's own
  // single-origin build sets VITE_API_URL=""), or every request silently
  // targets a backend that was never started for this run. Grepping the
  // built bundle for the baked-in fallback turns a several-minute "why does
  // login just time out" investigation into an immediate, actionable error.
  const assetsDir = path.join(FRONTEND_DIST, 'assets')
  if (!existsSync(assetsDir)) {
    // embedPath already confirmed frontend/dist/embed.html exists, so a
    // missing assets/ here means a broken or partial build, not a normal
    // "not built yet" state — that already failed loudly above. Silently
    // skipping the VITE_API_URL check in this case would let a broken
    // build sail past preflight and fail confusingly later instead.
    throw new Error(
      `missing ${assetsDir} — frontend/dist looks incomplete (embed.html ` +
      `is present but assets/ is not). Rebuild with: ` +
      `cd frontend && VITE_API_URL="" npm run build`,
    )
  }
  const offender = readdirSync(assetsDir)
    .filter((f) => f.endsWith('.js'))
    .find((f) => readFileSync(path.join(assetsDir, f), 'utf8').includes('://localhost:8000'))
  if (offender) {
    throw new Error(
      `${assetsDir}/${offender} was built with the default VITE_API_URL ` +
      `fallback (http://localhost:8000) baked in — the embed would call a ` +
      `backend this e2e never starts. Rebuild with: ` +
      `cd frontend && VITE_API_URL="" npm run build`,
    )
  }
  await checkPortFree(BACKEND_PORT)
  await checkPortFree(FIXTURE_PORT)
}

function randomPassword() {
  // >= 12 chars, base64url alphabet only (no shell/YAML-hostile characters);
  // env-only, never written to a file or logged.
  return randomBytes(16).toString('base64url')
}

async function writeBackendConfig(tmpDir, extensionId) {
  const dbPath = path.join(tmpDir, 'fabulous.db')
  // Non-negotiable per the task brief: Settings.db_path defaults to
  // backend/data/fabulous.db (anchored at the backend dir, not cwd) — an
  // omitted override here would run every check against the owner's own
  // live database. Assert the resolved path lands inside e2e/.tmp BEFORE
  // the backend is ever spawned.
  const resolvedDb = path.resolve(dbPath)
  const resolvedTmp = path.resolve(tmpDir)
  if (!resolvedDb.startsWith(resolvedTmp + path.sep)) {
    throw new Error(
      `refusing to start: resolved db_path ${resolvedDb} is not inside ${resolvedTmp}`,
    )
  }
  // rules_dir/dictionaries_dir and every other path key are left at their
  // defaults on purpose (task brief): they point at the repo's own
  // read-only rule/dictionary content, and redirecting them into the tmp
  // dir would remove the very rules the deterministic probe below depends
  // on (the doubled-word repetition rule).
  const yaml = `# Generated by e2e/run.mjs — do not edit, regenerated every run.
environment: dev
db_path: ${dbPath}
auth:
  mode: local
  ephemeral_secret: true
frontend:
  dist_dir: ${FRONTEND_DIST}
embed:
  allowed_ancestors:
    - chrome-extension://${extensionId}
`
  const configPath = path.join(tmpDir, 'config.yaml')
  await writeFile(configPath, yaml, 'utf8')
  return { configPath, resolvedDb }
}

function spawnBackend(configPath, adminPassword) {
  const child = spawn(
    'uv',
    ['--directory', BACKEND_DIR, 'run', 'uvicorn', 'app.main:app', '--port', String(BACKEND_PORT)],
    {
      env: {
        ...process.env,
        FW_CONFIG_FILE: configPath,
        FW_ADMIN_EMAIL: ADMIN_EMAIL,
        FW_ADMIN_PASSWORD: adminPassword,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  const chunks = []
  child.stdout.on('data', (d) => chunks.push(d))
  child.stderr.on('data', (d) => chunks.push(d))
  child.on('exit', (code, signal) => {
    // uvicorn's own graceful-shutdown handler turns our teardown SIGTERM
    // into exit code 143 (128+SIGTERM) rather than a signal-terminated
    // process — expected and not worth a diagnostic dump.
    if (!tearingDown && code !== null && code !== 0) {
      console.error(`[e2e] backend exited early with code ${code} (signal ${signal})`)
      console.error(Buffer.concat(chunks).toString('utf8').slice(-4000))
    }
  })
  child.__log = () => Buffer.concat(chunks).toString('utf8')
  return child
}

async function waitForHealth(timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    if (backendChild.exitCode !== null) {
      throw new Error(
        `backend process exited (code ${backendChild.exitCode}) before becoming healthy:\n` +
        backendChild.__log().slice(-4000),
      )
    }
    try {
      const res = await fetch(HEALTH_URL)
      if (res.ok) return
      lastError = new Error(`health check returned ${res.status}`)
    } catch (err) {
      lastError = err
    }
    await sleep(300)
  }
  throw new Error(`backend did not become healthy within ${timeoutMs}ms: ${lastError}`)
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
}

function spawnFixtureServer() {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    let rel = decodeURIComponent(url.pathname)
    if (rel === '/') rel = '/fixture.html'
    const resolved = path.resolve(HERE, '.' + rel)
    if (resolved !== HERE && !resolved.startsWith(HERE + path.sep)) {
      res.writeHead(403).end()
      return
    }
    if (!existsSync(resolved)) {
      res.writeHead(404).end()
      return
    }
    const ext = path.extname(resolved)
    res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'application/octet-stream' })
    createReadStream(resolved).pipe(res)
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(FIXTURE_PORT, '127.0.0.1', () => resolve(server))
  })
}

async function killChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGTERM')
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    sleep(5000),
  ])
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL')
  }
}

let teardownPromise = null

// Idempotent: safe to call more than once (e.g. a signal arriving while the
// main()-driven teardown is already in flight) — killChild is a no-op on an
// already-exited child, and the fixtureServer/backendChild refs are nulled
// after the first run, so a second call's guarded blocks just skip straight
// through. teardownPromise additionally collapses concurrent callers onto
// the SAME in-flight teardown rather than racing two parallel ones.
function teardown() {
  if (teardownPromise) return teardownPromise
  teardownPromise = (async () => {
    log('teardown: stopping backend and fixture server (only processes this run spawned)')
    tearingDown = true
    if (fixtureServer) {
      await new Promise((resolve) => fixtureServer.close(resolve))
      fixtureServer = null
    }
    if (backendChild) {
      await killChild(backendChild)
      backendChild = null
    }
  })()
  return teardownPromise
}

// Ctrl+C (SIGINT) or a SIGTERM (e.g. `kill` without -9) otherwise takes
// Node's default action — immediate exit with no teardown — which leaves
// uvicorn bound to 8100 and the next run's preflight refusing to start.
// Registering these makes an interrupted run tear down exactly like a
// resolved/rejected main() does, then exit with the conventional
// 128+signal code.
for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
  process.on(signal, async () => {
    log(`received ${signal}, tearing down`)
    await teardown()
    process.exit(code)
  })
}

async function main() {
  log('preflight: checking built artifacts and ports 8100/8101')
  await preflight()

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const tmpDir = path.join(HERE, '.tmp', timestamp)
  await mkdir(tmpDir, { recursive: true })
  log(`tmp dir: ${tmpDir}`)

  const extensionId = deriveExtensionId()
  const adminPassword = randomPassword()
  const { configPath, resolvedDb } = await writeBackendConfig(tmpDir, extensionId)
  log(`backend config written (db_path resolves inside tmp: ${resolvedDb})`)

  log('spawning backend (uv run uvicorn, port 8100)')
  backendChild = spawnBackend(configPath, adminPassword)
  await waitForHealth()
  log('backend healthy')

  log('spawning fixture static server (port 8101)')
  fixtureServer = await spawnFixtureServer()

  log('running extension.spec.mjs')
  const { default: runSpec } = await import('./extension.spec.mjs')
  await runSpec({
    adminEmail: ADMIN_EMAIL,
    adminPassword,
    extensionId,
    distDir: EXT_DIST,
    tmpDir,
    headless: !process.env.HEADFUL,
  })
  log('extension.spec.mjs PASSED')
}

main()
  .then(() => teardown())
  .then(() => process.exit(0))
  .catch(async (err) => {
    console.error(`[e2e] FAILED at step: ${err?.step ?? 'unknown'}`)
    console.error(err?.stack ?? String(err))
    await teardown()
    process.exit(1)
  })
