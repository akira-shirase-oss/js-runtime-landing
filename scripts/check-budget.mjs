// The static half of the performance budget: bytes, formats and markup, checked on the built site.
// Run after the build; any miss fails:
//
//   node scripts/check-budget.mjs [dir]      (dir defaults to dist/)
//
// - HTML: at most HTML_BUDGET_GZ bytes gzipped per page.
// - CSS: each page's total stylesheets-plus-<style> payload, gzipped, at most CSS_BUDGET_GZ — the
//   budget is what the page loads today; heavier means a regression to explain, not silent growth.
// - Images: AVIF, WebP or SVG (SVG for icons), explicit width and height, lazy below the first, and
//   at most IMAGE_BUDGET bytes each.
// The numbers are in scripts/budget-config.mjs. The lab half (Lighthouse) is scripts/lighthouse-budget.mjs.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { CSS_BUDGET_GZ, HTML_BUDGET_GZ, IMAGE_BUDGET } from './budget-config.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const dist = resolve(process.argv[2] ?? join(root, 'dist'))
const failures = []
const fail = (page, message) => failures.push(`${page}: ${message}`)

const walk = (dir) => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : [join(dir, n)]))
const pages = walk(dist).filter((f) => f.endsWith('.html'))
const nameOf = (file) => '/' + file.slice(dist.length + 1).split(sep).join('/').replace(/index\.html$/, '')

for (const file of pages) {
  const page = nameOf(file)
  const html = readFileSync(file, 'utf8')
  const gz = gzipSync(html).length
  if (gz > HTML_BUDGET_GZ) fail(page, `HTML is ${gz} bytes gzipped (budget ${HTML_BUDGET_GZ})`)

  let cssGz = 0
  for (const m of html.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*href="([^"]+)"/g)) {
    const path = join(dist, m[1])
    if (existsSync(path)) cssGz += gzipSync(readFileSync(path)).length
  }
  for (const m of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)) cssGz += gzipSync(m[1]).length
  if (cssGz > CSS_BUDGET_GZ) fail(page, `CSS is ${cssGz} bytes gzipped (budget ${CSS_BUDGET_GZ})`)

  const images = [...html.matchAll(/<img\b([^>]*)>/g)].map((m) => m[1])
  images.forEach((attrs, i) => {
    const src = attrs.match(/\bsrc="([^"]+)"/)?.[1] ?? ''
    if (!/\.(avif|webp|svg)(\?|$)/i.test(src)) fail(page, `image ${src} is not AVIF, WebP or SVG`)
    if (!/\bwidth="\d+"/.test(attrs) || !/\bheight="\d+"/.test(attrs)) fail(page, `image ${src} lacks a width and height`)
    if (i > 0 && !/\bloading="lazy"/.test(attrs)) fail(page, `image ${src} is below the first and isn't lazy`)
    const path = join(dist, src.split('?')[0])
    if (src.startsWith('/') && existsSync(path) && statSync(path).size > IMAGE_BUDGET) fail(page, `image ${src} is ${statSync(path).size} bytes (budget ${IMAGE_BUDGET})`)
  })
}

if (pages.length === 0) fail('dist', 'no HTML page was built')
if (failures.length > 0) {
  console.error(`check-budget: ${failures.length} miss(es)\n${failures.map((f) => `  - ${f}`).join('\n')}`)
  process.exit(1)
}
console.log(`check-budget: ${pages.length} page(s): HTML ≤ ${HTML_BUDGET_GZ / 1024} KB gzipped, CSS ≤ ${CSS_BUDGET_GZ} B gzipped, images in budget`)
