#!/usr/bin/env node
// Dependency-free PNG writer: solid rounded violet squares as placeholder
// action/toolbar icons. Rerunnable, deterministic — no image libs, just
// node:zlib deflate plus hand-built IHDR/IDAT/IEND chunks with CRC32.
import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const SIZES = [16, 32, 48, 128]
const VIOLET = [139, 92, 246] // rgb — placeholder brand color, not final art
const outDir = fileURLToPath(new URL('../public/icons/', import.meta.url))
mkdirSync(outDir, { recursive: true })

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(buf) {
  let c = 0xffffffff
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii')
  const lenBuf = Buffer.alloc(4)
  lenBuf.writeUInt32BE(data.length, 0)
  const crcBuf = Buffer.alloc(4)
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf])
}

function insideRoundedRect(x, y, size, radius) {
  const cx = x < radius ? radius : x > size - 1 - radius ? size - 1 - radius : x
  const cy = y < radius ? radius : y > size - 1 - radius ? size - 1 - radius : y
  if (cx === x && cy === y) return true
  const dx = x - cx
  const dy = y - cy
  return dx * dx + dy * dy <= radius * radius
}

function makePng(size) {
  const radius = Math.max(1, Math.round(size * 0.2))
  const rows = []
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 4)
    row[0] = 0 // filter: None
    for (let x = 0; x < size; x++) {
      const o = 1 + x * 4
      const opaque = insideRoundedRect(x, y, size, radius)
      row[o] = VIOLET[0]
      row[o + 1] = VIOLET[1]
      row[o + 2] = VIOLET[2]
      row[o + 3] = opaque ? 255 : 0
    }
    rows.push(row)
  }
  const raw = Buffer.concat(rows)
  const idatData = deflateSync(raw)

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type: RGBA
  ihdr[10] = 0 // compression
  ihdr[11] = 0 // filter
  ihdr[12] = 0 // interlace

  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', idatData),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

for (const size of SIZES) {
  const png = makePng(size)
  const path = new URL(`${size}.png`, `file://${outDir}`)
  writeFileSync(path, png)
  console.log(`wrote ${size}.png (${png.length} bytes)`)
}
