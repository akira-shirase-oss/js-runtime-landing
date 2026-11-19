// Font pipeline: one source file + its licence in, a self-hosted woff2 + the CSS out.
//
//   node scripts/fonts.mjs <font-file> [--name 'Family Name'] [--out public/fonts/name-latin.woff2]
//
// - Subsets to the site's character set: ASCII + Latin-1, plus every non-ASCII codepoint that appears
//   in src/ (the punctuation the copy actually uses — found by scanning, not guessed).
// - Writes the woff2 to --out (default public/fonts/<slug>-latin.woff2).
// - Prints the two @font-face blocks to paste into src/styles/global.css: the real face and a local
//   fallback (Arial/Helvetica/Liberation Sans) whose size-adjust and metric overrides make the swap
//   invisible — the same overrides the shipped fonts carry, so CLS stays 0.
// - Refuses to run without a licence file next to the font: a font is only self-hostable because its
//   licence says so (OFL-*.txt, LICENSE*, LICENCE* in the same directory).
//
// Formats: .ttf/.otf read directly, .woff2 is decoded with wawoff2 first, .woff is refused — decode it
// first (a woff carries no advantage). Subsetting uses harfbuzz (subset-font): layout tables and
// variable-font axes survive, which a glyph-list rebuild (opentype.js) cannot promise.
//
// One difference from how the shipped files were made: the three woff2s in public/fonts/ (Jost, Plus
// Jakarta Sans, JetBrains Mono) were produced with fontTools' instancer — their variable axes are
// pinned to the weights the site uses, so they're static instances. This script subsets but keeps the
// font's full axes, so its output is a variable subset, a few KB bigger for the same coverage. For a
// font the site will pin, run `fonttools varLib.instancer` on the source first and feed that in — the
// subset, fallback metrics and licence gate work the same either way.
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import subsetFont from 'subset-font'
import wawoff2 from 'wawoff2'
import * as opentype from 'opentype.js'

const root = fileURLToPath(new URL('..', import.meta.url))
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 ? process.argv[i + 1] : fallback
}
const usage = 'usage: node scripts/fonts.mjs <font-file> [--name "Family"] [--out path]'
const source = process.argv[2] && !process.argv[2].startsWith('--') ? resolve(process.argv[2]) : null
if (!source || !existsSync(source)) {
  console.error(source ? `fonts: no such file: ${source}` : usage)
  process.exit(2)
}

const bytes = readFileSync(source)
const magic = bytes.subarray(0, 4).toString('latin1')
// Everything downstream works on raw sfnt (TrueType-flavoured OpenType): woff2 is inflated first.
let sfnt
if (magic === 'wOF2') {
  sfnt = Buffer.from(await wawoff2.decompress(bytes))
} else if (magic === 'wOFF') {
  console.error('fonts: WOFF input — decode it to TTF first (wawoff2 or fonttools); WOFF adds nothing')
  process.exit(2)
} else if (magic === 'ttcf') {
  console.error('fonts: a .ttc collection — extract the single face first')
  process.exit(2)
} else {
  sfnt = bytes // ttf/otf signature is whatever the tables are; opentype.js validates it
}

const font = opentype.parse(sfnt.buffer.slice(sfnt.byteOffset, sfnt.byteOffset + sfnt.byteLength))
const family = arg('name', font.names.fontFamily?.en ?? basename(source, extname(source)))
const slug = family.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
const out = resolve(arg('out', join(root, 'public/fonts', `${slug}-latin.woff2`)))

// A licence file must sit next to the font: OFL-*.txt, LICENSE*, LICENCE* in the same directory —
// preferring one that names this font (OFL-Inter.txt for Inter) over any other font's.
const licences = readdirSync(dirname(source)).filter((n) => /^(OFL|LICENSE|LICENCE)[^/]*(\.(txt|md))?$/i.test(n))
const familyKey = family.toLowerCase().replace(/[^a-z0-9]+/g, '')
const licence = licences.find((n) => n.toLowerCase().replace(/[^a-z0-9]+/g, '').includes(familyKey)) ?? licences[0]
if (!licence) {
  console.error(`fonts: no licence file (OFL*/LICENSE*) next to ${source}; a font is only self-hostable because its licence says so`)
  process.exit(2)
}

// The character set: ASCII + Latin-1 (letters, digits, punctuation) + the General Punctuation block
// (typographic quotes, dashes, ellipses — the safe floor), plus every codepoint used in src/ —
// including \uXXXX escapes and &#xNN; entities, which is how the copy actually carries them — so a
// new section can't silently lose a character.
const codes = new Set()
for (let c = 0x20; c <= 0x7e; c++) codes.add(c)
for (let c = 0xa0; c <= 0xff; c++) codes.add(c)
for (let c = 0x2000; c <= 0x206f; c++) codes.add(c)
const srcFiles = []
const collect = (d) => {
  for (const n of readdirSync(d)) {
    const p = join(d, n)
    if (statSync(p).isDirectory()) collect(p)
    else if (/\.(astro|ts|css|mjs)$/.test(n)) srcFiles.push(p)
  }
}
collect(join(root, 'src'))
const extra = new Set()
const add = (cp) => { if (cp >= 0x80 && cp <= 0x10ffff) { codes.add(cp); extra.add(cp) } }
for (const file of srcFiles) {
  const body = readFileSync(file, 'utf8')
  for (const ch of body) add(ch.codePointAt(0))
  for (const m of body.matchAll(/\\u\{([0-9a-fA-F]{1,6})\}|\\u([0-9a-fA-F]{4})|&#[xX]([0-9a-fA-F]+)|&#(\d+)/g)) {
    add(parseInt(m[1] ?? m[2] ?? m[3] ?? m[4], m[3] ? 16 : m[4] ? 10 : 16))
  }
}
const text = String.fromCodePoint(...codes)

// The font may simply not carry a codepoint the site actually uses: say which, so the miss is seen,
// not silent. (Only the site-scanned set — the punctuation block is speculative inclusion, not a gap.)
const missing = [...extra].filter((cp) => font.charToGlyphIndex(String.fromCodePoint(cp)) === 0)

// Subset to woff2; the source's own tables (fvar included) carry through.
const subset = await subsetFont(sfnt, text, { targetFormat: 'woff2' })
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, Buffer.from(subset))

// Fallback metrics against the platform sans (Arial; Helvetica and Liberation Sans share its metrics
// for this purpose). Scheme — the same one the shipped overrides follow: the fallback's glyphs are
// scaled by size-adjust so its ascent matches the web font's ascent, then each metric override states
// the web font's own fraction of em *after* that scale (override% = web-fraction / size-adjust), so
// the declared line box equals the real font's. Arial's metrics: unitsPerEm 2048, ascender 1854.
const upm = font.unitsPerEm
const hhea = font.tables.hhea
const asc = (hhea.ascender ?? font.tables.os2?.sTypoAscender) / upm
const desc = Math.abs(hhea.descender ?? font.tables.os2?.sTypoDescender ?? 0) / upm
const gap = (hhea.lineGap ?? 0) / upm
const arialAsc = 1854 / 2048
const sizeAdjust = asc / arialAsc
const pct = (x) => `${(x * 100).toFixed(2)}%`

// Weight: a variable font's wght axis becomes the @font-face range; a static one stays 400.
const wght = font.tables.fvar?.axes?.find((a) => a.tag === 'wght')
const weight = wght ? `${Math.round(wght.minValue)} ${Math.round(wght.maxValue)}` : '400'

console.log(`fonts: ${family} (${basename(source)}) — ${codes.size} codepoints (${extra.size} found in src), ${font.glyphs.length} glyphs → ${out.replace(root + '/', '')} (${subset.byteLength} bytes)`)
console.log(`fonts: licence ok — ${licence}`)
for (const cp of missing) {
  console.warn(`fonts: ⚠ ${family} has no U+${cp.toString(16).toUpperCase()} "${String.fromCodePoint(cp)}" — the site uses it; it will render in the fallback`)
}
console.log()
console.log(`@font-face {
  font-family: '${family}';
  src: url('/fonts/${basename(out)}') format('woff2');
  font-weight: ${weight};
  font-style: normal;
  font-display: swap;
}

@font-face {
  font-family: '${family} Fallback';
  src: local('Arial'), local('Helvetica'), local('Liberation Sans');
  size-adjust: ${pct(sizeAdjust)};
  ascent-override: ${pct(asc / sizeAdjust)};
  descent-override: ${pct(desc / sizeAdjust)};
  line-gap-override: ${pct(gap / sizeAdjust)};
}`)
