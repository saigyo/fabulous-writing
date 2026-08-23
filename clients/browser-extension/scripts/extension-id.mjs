#!/usr/bin/env node
// Prints the extension ID Chromium derives from public/manifest.json's "key":
// sha256 over the DER public key, first 16 bytes, each nibble mapped 0-15 ->
// a-p ("mpdecimal"). Used by docs and by backend/tests/test_fly_config.py's
// cross-pin (which reimplements the same 6 lines in Python).
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const manifestPath = fileURLToPath(new URL('../public/manifest.json', import.meta.url))
const { key } = JSON.parse(readFileSync(manifestPath, 'utf8'))
const digest = createHash('sha256').update(Buffer.from(key, 'base64')).digest()
const id = [...digest.subarray(0, 16)]
  .flatMap((b) => [b >> 4, b & 0xf])
  .map((n) => String.fromCharCode(97 + n))
  .join('')
console.log(id)
