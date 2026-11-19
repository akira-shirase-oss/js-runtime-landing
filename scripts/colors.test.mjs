// Every colour lives in src/styles/tokens.css, as a light value on :root with its dark twin. Components,
// pages and the global styles use var(--…) only, so a new screen can't forget dark mode.
// Exempt, by explicit path only: the token file itself and the static SVG assets, which are drawn once
// in one colour and tinted through CSS masks where they need to follow the theme.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const EXEMPT = new Set([
  'src/styles/tokens.css',
  'public/favicon.svg',
  'public/icons/arrow.svg',
  'public/icons/github.svg',
  'public/icons/x.svg',
])
const SCANNED = /\.(css|astro|ts|mjs|js|md|mdx|svg|html)$/

const files = (dir) =>
  readdirSync(join(root, dir), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name)) : SCANNED.test(e.name) ? [join(dir, e.name).split(sep).join('/')] : [],
  )

// A literal colour: hex, a colour function, or a named colour as the value of a colour property or attribute.
const NAMED = 'white|black|red|green|blue|gray|grey|silver|yellow|orange|pink|purple|violet|navy|teal|maroon|olive|lime|aqua|fuchsia|gold|beige|ivory|coral|salmon|tomato|crimson|indigo|lavender|plum|khaki|tan'
const LITERAL = [
  /#[0-9a-f]{3,8}\b/gi,
  /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/gi,
  new RegExp(`(?:color|background(?:-color)?|fill|stroke|border(?:-[a-z]+)?|outline|box-shadow|text-shadow|stop-color)\\s*[:=]\\s*["']?[^;"'>]*(?<![-\\w])(?:${NAMED})\\b`, 'gi'),
]

test('no hard-coded colour outside the token file', () => {
  const found = []
  for (const file of [...files('src'), ...files('public').filter((f) => f.endsWith('.svg'))]) {
    if (EXEMPT.has(file)) continue
    const lines = readFileSync(join(root, file), 'utf8').split('\n')
    lines.forEach((line, i) => {
      // `#` followed by hex digits is also an id in a URL fragment or an href: only flag it in a colour position.
      for (const re of LITERAL) {
        for (const m of line.matchAll(re)) {
          if (re === LITERAL[0] && /(?:href|id|url\()\s*=?\s*["']?[^"']*$/.test(line.slice(0, m.index))) continue
          found.push(`${file}:${i + 1}: ${m[0]}`)
        }
      }
    })
  }
  assert.deepEqual(found, [], `hard-coded colours (use a token from src/styles/tokens.css):\n${found.join('\n')}`)
})

test('every light token has a dark twin, in both dark blocks, and nothing else is in them', () => {
  const css = readFileSync(join(root, 'src/styles/tokens.css'), 'utf8')
  const block = (selector) => {
    const at = css.indexOf(selector)
    assert.ok(at >= 0, `tokens.css has no ${selector} block`)
    const open = css.indexOf('{', at + selector.length - 1)
    let depth = 0
    for (let i = open; i < css.length; i++) {
      if (css[i] === '{') depth++
      else if (css[i] === '}' && --depth === 0) return css.slice(open + 1, i)
    }
    throw new Error(`unclosed ${selector}`)
  }
  const names = (text) => [...text.matchAll(/(--c-[\w-]+)\s*:/g)].map((m) => m[1]).sort()
  const light = names(block(':root {'))
  const media = names(block(':root:not([data-theme="light"]) {'))
  const forced = names(block(':root[data-theme="dark"] {'))
  assert.ok(light.length > 10, 'the light palette is on :root')
  assert.deepEqual(media, light, 'the prefers-color-scheme dark block names exactly the light tokens')
  assert.deepEqual(forced, light, 'the data-theme="dark" block names exactly the light tokens')
  assert.match(css, /@media \(prefers-color-scheme: dark\)\s*{\s*:root:not\(\[data-theme="light"\]\)/, 'the system dark set yields to an explicit Light choice')
})

test('the scanner itself catches each kind of literal', () => {
  const probe = ['color: #fff;', 'background: rgba(0, 0, 0, 0.3)', 'fill="#000"', 'stop-color="white"', 'border: 1px solid black']
  for (const line of probe) assert.ok(LITERAL.some((re) => { re.lastIndex = 0; return re.test(line) }), line)
  for (const line of ['href="/#proof"', 'color: var(--c-ink)', 'fill="currentColor"', 'background: transparent', 'fill: var(--c-px-blue)']) {
    const hit = LITERAL.some((re) => { re.lastIndex = 0; const m = re.exec(line); return m && !(re === LITERAL[0] && /href/.test(line)) })
    assert.ok(!hit, `false positive: ${line}`)
  }
  void relative
})
