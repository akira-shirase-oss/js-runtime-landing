// The budget check passes a small well-formed page and fails on each rule it owns.
//
//   npm test
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { CSS_BUDGET_GZ, HTML_BUDGET_GZ } from './budget-config.mjs'

const script = fileURLToPath(new URL('./check-budget.mjs', import.meta.url))
// High-entropy filler: repeated characters gzip to nothing, so a page has to carry real bytes to miss.
const noise = (bytes) => randomBytes(bytes).toString('base64url')

function site({ html, css = 'body{margin:0}' }) {
  const dir = mkdtempSync(join(tmpdir(), 'budget-'))
  mkdirSync(join(dir, '_astro'), { recursive: true })
  writeFileSync(join(dir, '_astro', 'site.css'), css)
  writeFileSync(join(dir, 'index.html'), `<!doctype html><html><head><link rel="stylesheet" href="/_astro/site.css"></head><body><main>${html}</main></body></html>`)
  return dir
}
const run = (dir) => spawnSync(process.execPath, [script, dir], { encoding: 'utf8' })

test('a small page with a proper image passes', () => {
  const dir = site({ html: '<h1>x</h1><img src="/a.svg" width="10" height="10"><img src="/b.webp" width="10" height="10" loading="lazy">' })
  writeFileSync(join(dir, 'a.svg'), '<svg/>')
  const result = run(dir)
  rmSync(dir, { recursive: true, force: true })
  assert.equal(result.status, 0, result.stderr)
})

test('a PNG, a missing height and a non-lazy second image each fail', () => {
  const dir = site({ html: '<img src="/a.png" width="10"><img src="/b.webp" width="10" height="10">' })
  const result = run(dir)
  rmSync(dir, { recursive: true, force: true })
  assert.equal(result.status, 1)
  for (const want of ['not AVIF, WebP or SVG', 'lacks a width and height', "isn't lazy"]) assert.match(result.stderr, new RegExp(want))
})

test('HTML and CSS over budget each fail', () => {
  const dir = site({ html: '<p>' + noise(HTML_BUDGET_GZ * 2) + '</p>', css: noise(CSS_BUDGET_GZ + 64) })
  const result = run(dir)
  rmSync(dir, { recursive: true, force: true })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /HTML is \d+ bytes gzipped/)
  assert.match(result.stderr, /CSS is \d+ bytes gzipped/)
})

test('an empty dist fails', () => {
  const dir = mkdtempSync(join(tmpdir(), 'budget-'))
  const result = run(dir)
  rmSync(dir, { recursive: true, force: true })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /no HTML page/)
})
