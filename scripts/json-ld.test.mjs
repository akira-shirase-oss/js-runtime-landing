// JSON-LD must stay data. JSON.stringify leaves `</script>` and `<!--` intact, so a title holding
// either would end the <script type="application/ld+json"> early or swallow the page after it.
//
//   npm test
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { jsonLd } from '../src/lib/json-ld.ts'

const hostile = [
  'Hostile </script><script>alert(document.domain)</script>',
  'Upper case </SCRIPT >',
  'Comment <!-- <script> swallows the next </script>',
  'Closers --> and ]]> and & and < and >',
  'Line separators   and   ',
]

test('hostile strings come out with no "<", so they cannot leave the script element', () => {
  for (const s of hostile) {
    const out = jsonLd({ '@type': 'SoftwareApplication', name: s, nested: [{ name: s }] })
    assert.ok(!out.includes('<'), `"<" survived in ${out}`)
    assert.ok(!/<\/script/i.test(out) && !out.includes('<!--'))
  }
})

test('the escaped JSON parses back to exactly the same data', () => {
  const data = { '@context': 'https://schema.org', items: hostile, n: 1, ok: true, none: null }
  assert.deepEqual(JSON.parse(jsonLd(data)), data)
})

test('every JSON-LD block in src/ is written through jsonLd()', () => {
  const src = fileURLToPath(new URL('../src', import.meta.url))
  const astro = readdirSync(src, { recursive: true }).filter((f) => f.endsWith('.astro'))
  let blocks = 0
  for (const file of astro) {
    const text = readFileSync(join(src, file), 'utf8')
    assert.ok(!/set:html=\{\s*JSON\.stringify/.test(text), `${file} writes raw JSON.stringify output into the page`)
    for (const m of text.matchAll(/<script\b[^>]*application\/ld\+json[^>]*>/g)) {
      blocks++
      assert.match(m[0], /set:html=\{\s*jsonLd\(/, `${file}: ${m[0]} must use set:html={jsonLd(...)}`)
    }
  }
  assert.ok(blocks >= 1, `expected the layout's JSON-LD block, found ${blocks}`)
})
