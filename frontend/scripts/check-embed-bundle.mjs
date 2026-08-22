#!/usr/bin/env node
// Bundle guard (B43 C1, spec's tree-shaking claim): the embed entry must
// never pull CodeMirror into its chunk graph — that's the whole point of
// the host-document shim (hostDoc.ts) replacing the CodeMirror EditorView.
// A stray value-import anywhere reachable from src/embed/main.tsx (e.g. a
// future autosave fix importing editor/editorRef.ts) would silently regress
// this, so it's checked here rather than trusted.
//
// Runs its own in-memory Vite build (write: false) so it can inspect each
// output chunk's actual module graph (OutputChunk.moduleIds) — the real
// module identities that were bundled in, not a post-minification guess
// from grepping file contents (bundled code doesn't retain import
// specifiers as strings).
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { build } from 'vite'

const root = fileURLToPath(new URL('..', import.meta.url))

const result = await build({
  root,
  configFile: path.join(root, 'vite.config.ts'),
  logLevel: 'warn',
  build: { write: false },
})

const outputs = Array.isArray(result) ? result : [result]
const chunks = new Map()
for (const r of outputs) {
  for (const item of r.output) {
    if (item.type === 'chunk') chunks.set(item.fileName, item)
  }
}

// The chunk's `name` is the rollupOptions.input key ('embed', from
// vite.config.ts) — facadeModuleId is the embed.html file itself (Vite's
// HTML entry handling), not src/embed/main.tsx.
const entryChunk = [...chunks.values()].find((c) => c.isEntry && c.name === 'embed')
if (!entryChunk) {
  console.error('FAIL: could not find the embed entry chunk in the build output.')
  process.exit(1)
}

const seen = new Set()
const queue = [entryChunk.fileName]
while (queue.length > 0) {
  const fileName = queue.shift()
  if (seen.has(fileName)) continue
  seen.add(fileName)
  const chunk = chunks.get(fileName)
  if (!chunk) continue
  for (const imp of [...chunk.imports, ...chunk.dynamicImports]) queue.push(imp)
}

const offenders = []
for (const fileName of seen) {
  const chunk = chunks.get(fileName)
  for (const id of chunk.moduleIds) {
    if (id.includes('/node_modules/@codemirror/') || id.includes('/node_modules/codemirror/')) {
      offenders.push({ chunk: fileName, module: id })
    }
  }
}

if (offenders.length > 0) {
  console.error(`FAIL: ${offenders.length} CodeMirror module(s) reachable from the embed entry:`)
  for (const o of offenders) console.error(`  ${o.chunk} <- ${o.module}`)
  process.exit(1)
}

console.log(
  `OK: embed entry graph (${seen.size} chunk(s): ${[...seen].join(', ')}) is free of @codemirror/codemirror modules.`,
)
