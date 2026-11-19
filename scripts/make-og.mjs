// Renders the share image (public/og.png, 1200 x 630) without a browser: the brand block's
// white -> #0061FF gradient with the "jsrt" pixel wordmark in navy, drawn from the same cell path
// the footer uses, so the card people see in a link preview is the page's own look.
//
//   node scripts/make-og.mjs      (commit the result)
//
// PNG with no dependencies: each row a filter-0 scanline, zlib-deflated, three chunks with CRC32.
import { deflateSync } from 'node:zlib'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { wordmark } from '../src/components/ui/wordmark-cells.ts'

const root = fileURLToPath(new URL('..', import.meta.url))
const W = 1200
const H = 630
const TOP = [0xff, 0xff, 0xff]
const BOTTOM = [0x00, 0x61, 0xff]
const INK = [0x08, 0x14, 0x2b] // --c-on-brand

// The cell path is a list of 9-unit squares on a 10-unit pitch: `M{x} {y}h9v9h-9z` for the first,
// then `m{dx} {dy}h9v9h-9z` relative moves for the rest.
const cells = []
let cx = 0
let cy = 0
for (const m of wordmark.path.matchAll(/([Mm])(-?\d+) (-?\d+)h9v9h-9z/g)) {
  cx = m[1] === 'M' ? Number(m[2]) : cx + Number(m[2])
  cy = m[1] === 'M' ? Number(m[3]) : cy + Number(m[3])
  cells.push([cx, cy])
}
const SCALE = 2 // 410x230 units -> 820x460 px, centred
const ox = Math.round((W - wordmark.width * SCALE) / 2)
const oy = Math.round((H - wordmark.height * SCALE) / 2)

const px = new Uint8Array(W * H * 3)
for (let y = 0; y < H; y++) {
  const t = y / (H - 1)
  const [r, g, b] = TOP.map((c, i) => Math.round(c + (BOTTOM[i] - c) * t))
  for (let x = 0; x < W; x++) {
    const at = (y * W + x) * 3
    px[at] = r
    px[at + 1] = g
    px[at + 2] = b
  }
}
for (const [cellX, cellY] of cells) {
  for (let y = 0; y < 9 * SCALE; y++) {
    const py = oy + cellY * SCALE + y
    if (py < 0 || py >= H) continue
    for (let x = 0; x < 9 * SCALE; x++) {
      const pxx = ox + cellX * SCALE + x
      if (pxx < 0 || pxx >= W) continue
      const at = (py * W + pxx) * 3
      px[at] = INK[0]
      px[at + 1] = INK[1]
      px[at + 2] = INK[2]
    }
  }
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc32 = (buf) => {
  let c = 0xffffffff
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
const chunk = (type, data) => {
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'ascii')
  data.copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
  return out
}
const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(W, 0)
ihdr.writeUInt32BE(H, 4)
ihdr[8] = 8 // bit depth
ihdr[9] = 2 // truecolour RGB
const raw = Buffer.alloc(H * (1 + W * 3))
for (let y = 0; y < H; y++) Buffer.from(px.buffer, y * W * 3, W * 3).copy(raw, y * (1 + W * 3) + 1)
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
])

writeFileSync(join(root, 'public', 'og.png'), png)
console.log(`make-og: public/og.png, ${W} x ${H}, ${(png.length / 1024).toFixed(1)} KB, ${cells.length} cells`)
