// Lighthouse on every page type, served with dist/_headers (the real content security policy).
// Mobile emulation, five runs, the median of each number; any miss fails:
//
//   LCP ≤ 2.0 s · CLS = 0 · TBT ≤ 150 ms · the page's own script work ≤ 50 ms · Performance ≥ 95 ·
//   SEO = 100 · Accessibility = 100 (numbers and the reason for them in scripts/budget-config.mjs)
//   and at 390 and 360 px wide, nothing wider than the screen
//
//   node scripts/lighthouse-budget.mjs [--runs 5] [--dist dist]
//
// Lab numbers on a shared CI runner are observations, not capacity; the thresholds are there so a
// regression past them fails the build. Lighthouse and a browser are not dependencies of the site:
// install them (CI does, pinned) or point LIGHTHOUSE_MODULE / PLAYWRIGHT_MODULE at existing
// node_modules/<name> directories.
import { createServer } from 'node:http'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { extname, join, normalize, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { CONTROL, LIGHTHOUSE as THRESHOLDS, PAGES, PAGE_DEADLINE_MS } from './budget-config.mjs'

const arg = (name, fallback) => (process.argv.includes(`--${name}`) ? process.argv[process.argv.indexOf(`--${name}`) + 1] : fallback)
const root = fileURLToPath(new URL('..', import.meta.url))
const dist = resolve(root, arg('dist', 'dist'))
const runs = Number(arg('runs', '5'))

const load = async (name, env) =>
  import(process.env[env] ? pathToFileURL(join(process.env[env], name === 'lighthouse' ? 'core/index.js' : 'index.mjs')).href : name)
const { default: lighthouse } = await load('lighthouse', 'LIGHTHOUSE_MODULE')
const { chromium } = await load('playwright', 'PLAYWRIGHT_MODULE')
const { launch } = await import(process.env.LIGHTHOUSE_MODULE ? pathToFileURL(join(process.env.LIGHTHOUSE_MODULE, '..', 'chrome-launcher', 'dist', 'index.js')).href : 'chrome-launcher')

// dist/ with its _headers, as Cloudflare Pages serves it (the same rules check-csp-browser applies).
const rules = []
for (const line of readFileSync(join(dist, '_headers'), 'utf8').split(/\r?\n/)) {
  const t = line.trim()
  if (t === '' || t.startsWith('#')) continue
  if (!/^\s/.test(line)) rules.push({ match: new RegExp(`^${t.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`), headers: [] })
  else rules.at(-1).headers.push([t.slice(0, t.indexOf(':')), t.slice(t.indexOf(':') + 1).trim()])
}
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png', '.jpg': 'image/jpeg', '.xml': 'application/xml', '.txt': 'text/plain' }
const server = createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname)
  let file = normalize(join(dist, path))
  if (!file.startsWith(dist)) return void res.writeHead(400).end()
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html')
  const found = existsSync(file)
  const headers = { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' }
  for (const rule of rules) if (rule.match.test(path)) for (const [k, v] of rule.headers) headers[k.toLowerCase()] = v
  res.writeHead(found ? 200 : 404, headers).end(found ? readFileSync(file) : '')
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const origin = `http://127.0.0.1:${server.address().port}`

const chrome = await launch({ chromePath: chromium.executablePath(), chromeFlags: ['--headless=new', '--no-sandbox'] })
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]
const failures = []
const rows = []
// One page type: its runs, in sequence. Returns the completed samples.
async function measure(path) {
  const samples = []
  for (let i = 0; i < runs; i++) {
    // A run Lighthouse itself couldn't complete (NO_NAVSTART and the like, seen on a loaded machine) is retried
    // once; a second failure fails the budget. Every number used below comes from a completed run.
    const audit = () => lighthouse(origin + path, { port: chrome.port, output: 'json', logLevel: 'error', onlyCategories: ['performance', 'seo', 'accessibility'] })
    let { lhr } = await audit()
    if (lhr.runtimeError) ({ lhr } = await audit())
    if (lhr.runtimeError) {
      failures.push(`${path}: Lighthouse could not load the page twice in a row (${lhr.runtimeError.code})`)
      continue
    }
    const a = lhr.audits
    samples.push({
      performance: Math.round(lhr.categories.performance.score * 100),
      seo: Math.round(lhr.categories.seo.score * 100),
      accessibility: Math.round(lhr.categories.accessibility.score * 100),
      lcpMs: a['largest-contentful-paint'].numericValue,
      cls: a['cumulative-layout-shift'].numericValue,
      tbtMs: a['total-blocking-time'].numericValue,
      failed: Object.values(a).filter((x) => x.scoreDisplayMode === 'binary' && x.score === 0).map((x) => x.id),
      benchmarkIndex: lhr.environment.benchmarkIndex,
      breakdown: (a['mainthread-work-breakdown'].details?.items ?? []).map((i) => `${i.groupLabel} ${Math.round(i.duration)} ms`).join(', '),
      longTasks: (a['long-tasks'].details?.items ?? []).slice(0, 4).map((i) => `${i.url.replace(origin, '') || 'Unattributable'} ${Math.round(i.duration)} ms`).join(', '),
      // The work the page itself causes: its scripts being parsed and run.
      ownScriptMs: (a['mainthread-work-breakdown'].details?.items ?? [])
        .filter((i) => i.group === 'scriptEvaluation' || i.group === 'scriptParseCompile')
        .reduce((sum, i) => sum + i.duration, 0),
    })
    const x = samples.at(-1)
    console.log(`  ${path} run ${i + 1}: Performance ${x.performance}, LCP ${Math.round(x.lcpMs)} ms, TBT ${Math.round(x.tbtMs)} ms, own script ${Math.round(x.ownScriptMs)} ms, CLS ${x.cls.toFixed(3)}, benchmarkIndex ${Math.round(x.benchmarkIndex)}; main thread: ${x.breakdown}; long tasks: ${x.longTasks || 'none'}`)
  }
  return samples
}

for (const path of PAGES) {
  // Sequential, each type under its own deadline: a page that hangs fails alone and the next type still runs.
  let timer
  const deadline = new Promise((resolve) => (timer = setTimeout(() => resolve('deadline'), PAGE_DEADLINE_MS)))
  const samples = await Promise.race([measure(path), deadline])
  clearTimeout(timer)
  if (samples === 'deadline') {
    failures.push(`${path}: Lighthouse didn't finish ${runs} runs within ${PAGE_DEADLINE_MS / 60000} minutes`)
    continue
  }
  if (samples.length === 0) continue
  const m = Object.fromEntries(['performance', 'seo', 'accessibility', 'lcpMs', 'cls', 'tbtMs', 'ownScriptMs'].map((k) => [k, median(samples.map((s) => s[k]))]))
  rows.push({ path, ...m })
  const misses = [
    m.lcpMs > THRESHOLDS.lcpMs && `LCP ${Math.round(m.lcpMs)} ms > ${THRESHOLDS.lcpMs}`,
    m.cls > THRESHOLDS.cls && `CLS ${m.cls.toFixed(3)} > 0`,
    m.tbtMs > THRESHOLDS.tbtMs && `TBT ${Math.round(m.tbtMs)} ms > ${THRESHOLDS.tbtMs}`,
    m.ownScriptMs > THRESHOLDS.ownScriptMs && `the page's own script work ${Math.round(m.ownScriptMs)} ms > ${THRESHOLDS.ownScriptMs}`,
    m.performance < THRESHOLDS.performance && `Performance ${m.performance} < ${THRESHOLDS.performance}`,
    m.seo < THRESHOLDS.seo && `SEO ${m.seo} < 100 (failing: ${[...new Set(samples.flatMap((s) => s.failed))].join(', ')})`,
    m.accessibility < THRESHOLDS.accessibility && `Accessibility ${m.accessibility} < 100 (failing: ${[...new Set(samples.flatMap((s) => s.failed))].join(', ')})`,
  ].filter(Boolean)
  for (const miss of misses) failures.push(`${path}: ${miss}`)
}
{
  // The control: an existing page measured the same way and printed, never gated. If it misses too on a
  // given machine, the miss is the machine's, not the page's.
  const { lhr } = await lighthouse(origin + CONTROL, { port: chrome.port, output: 'json', logLevel: 'error', onlyCategories: ['performance'] })
  if (!lhr.runtimeError) {
    const a = lhr.audits
    console.log(`lighthouse-budget: control ${CONTROL} (one run, not gated): Performance ${Math.round(lhr.categories.performance.score * 100)}, LCP ${(a['largest-contentful-paint'].numericValue / 1000).toFixed(2)} s, TBT ${Math.round(a['total-blocking-time'].numericValue)} ms, benchmarkIndex ${Math.round(lhr.environment.benchmarkIndex)}`)
  }
}
await chrome.kill()

// At phone width (390 and 360), nothing is wider than the screen: no sideways page scroll, and nothing
// in main wider than its own box. Every built page — this check is cheap.
const everyPage = readdirSync(dist, { recursive: true })
  .map(String)
  .filter((p) => p.endsWith('index.html') || p === '404.html')
  .map((p) => '/' + p.replace(/index\.html$/, '').replace(/\\/g, '/'))
const browser = await chromium.launch()
for (const width of [390, 360]) {
  const page = await browser.newPage({ viewport: { width, height: 844 } })
  for (const path of everyPage) {
    await page.goto(origin + path, { waitUntil: 'load' })
    const wide = await page.evaluate(() => {
      const out = []
      if (document.documentElement.scrollWidth > window.innerWidth) out.push(`the page scrolls sideways by ${document.documentElement.scrollWidth - window.innerWidth}px`)
      for (const el of document.querySelectorAll('main *')) {
        if (el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX !== 'visible' && el.tagName !== 'PRE')
          out.push(`<${el.tagName.toLowerCase()}> is ${el.scrollWidth}px wide in a ${el.clientWidth}px box`)
      }
      return out
    })
    for (const w of wide) failures.push(`${path} at ${width}px: ${w}`)
  }
  await page.close()
}
await browser.close()
server.close()

for (const r of rows) {
  console.log(`lighthouse-budget: ${r.path} (median of ${runs}, mobile): Performance ${r.performance}, SEO ${r.seo}, Accessibility ${r.accessibility}, LCP ${(r.lcpMs / 1000).toFixed(2)} s, CLS ${r.cls.toFixed(3)}, TBT ${Math.round(r.tbtMs)} ms, own script ${Math.round(r.ownScriptMs)} ms`)
}
if (PAGES.length === 0) failures.push('no page configured in PAGES')
if (failures.length > 0) {
  console.error(`lighthouse-budget: ${failures.length} miss(es)\n${failures.map((f) => `  - ${f}`).join('\n')}`)
  process.exit(1)
}
console.log('lighthouse-budget: every page type within budget')
