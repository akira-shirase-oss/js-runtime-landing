// Loads every built page in headless Chromium with the headers from dist/_headers and fails on any
// Content-Security-Policy violation, page error, failed request or broken image. It also clicks the
// phone menu and the theme toggle and scrolls the sections into view, which proves the hashed
// inline scripts actually ran.
//
//   npm run build && npm run check:browser
//   node scripts/check-csp-browser.mjs --mutate   # serves a CSP with the script hashes removed; must fail
//
// Playwright is not a dependency of this repo. Install it (npm i -D playwright && npx playwright
// install chromium), or point PLAYWRIGHT_MODULE at an existing node_modules/playwright directory.
import { createServer } from 'node:http'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { extname, join, normalize, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const distArg = process.argv.indexOf('--dist')
const dist = resolve(root, distArg > 0 ? process.argv[distArg + 1] : 'dist')
const mutate = process.argv.includes('--mutate')

let playwright
try {
  playwright = await import(
    process.env.PLAYWRIGHT_MODULE ? pathToFileURL(join(process.env.PLAYWRIGHT_MODULE, 'index.mjs')).href : 'playwright'
  )
} catch {
  console.error('check-csp-browser: Playwright not found. Install it, or set PLAYWRIGHT_MODULE (see the top of this file).')
  process.exit(2)
}

// ---------------------------------------------------------------------------------------------
// A static server for dist/ that applies _headers the way Cloudflare Pages does for these rules.

const rules = []
for (const line of readFileSync(join(dist, '_headers'), 'utf8').split(/\r?\n/)) {
  const t = line.trim()
  if (t === '' || t.startsWith('#')) continue
  if (!/^\s/.test(line)) rules.push({ match: new RegExp(`^${t.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`), headers: [] })
  else rules.at(-1).headers.push([t.slice(0, t.indexOf(':')), t.slice(t.indexOf(':') + 1).trim()])
}
const headersFor = (path) => {
  const out = {}
  for (const rule of rules) if (rule.match.test(path)) for (const [name, value] of rule.headers) out[name] = value
  if (mutate && out['Content-Security-Policy']) out['Content-Security-Policy'] = out['Content-Security-Policy'].replace(/ 'sha256-[^']+'/g, '')
  return out
}

const types = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.png': 'image/png',
  '.woff2': 'font/woff2', '.xml': 'application/xml; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
}

const server = createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname)
  let file = normalize(join(dist, path))
  if (file !== dist && !file.startsWith(dist + sep)) return void res.writeHead(403).end()
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html')
  if (!existsSync(file)) return void res.writeHead(404, headersFor(path)).end('not found')
  res.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream', ...headersFor(path) })
  res.end(readFileSync(file))
})
await new Promise((ok) => server.listen(0, '127.0.0.1', ok))
const origin = `http://127.0.0.1:${server.address().port}`

// ---------------------------------------------------------------------------------------------

// Every page: /, /404.html and any future index.html directories.
const pages = (function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : e.name === 'index.html' ? ['/' + relative(dist, join(dir, '/')).split(sep).join('/')] : [],
  )
})(dist)
  .map((p) => (p === '/' ? p : p.replace(/\/?$/, '/')))
  .sort()

const browser = await playwright.chromium.launch()
const version = browser.version()
const problems = []
let interactions = 0

async function visit(path, viewport, act, colorScheme = 'light') {
  const context = await browser.newContext({ viewport, colorScheme })
  await context.addInitScript(() => {
    window.__csp = []
    window.__cls = 0
    document.addEventListener('securitypolicyviolation', (e) =>
      window.__csp.push(`${e.effectiveDirective} blocked ${e.blockedURI || 'inline'} (${e.sourceFile || 'page'}:${e.lineNumber})`),
    )
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) if (!e.hadRecentInput) window.__cls += e.value
    }).observe({ type: 'layout-shift', buffered: true })
  })
  const page = await context.newPage()
  const report = (what) => problems.push(`${path} [${viewport.width}px ${colorScheme}]: ${what}`)
  page.on('pageerror', (e) => report(`page error: ${e.message}`))
  page.on('console', (m) => m.type() === 'error' && report(`console error: ${m.text()}`))
  page.on('requestfailed', (r) => report(`request failed: ${r.url()} (${r.failure()?.errorText})`))
  page.on('response', (r) => r.status() >= 400 && report(`HTTP ${r.status()} for ${r.url()}`))

  const response = await page.goto(origin + path, { waitUntil: 'load' })
  if (!response.headers()['content-security-policy']) report('served without a Content-Security-Policy header')
  // Scroll through the page so lazy assets and the reveal-on-view scripts run too.
  await page.evaluate(async () => {
    for (let y = 0; y < document.body.scrollHeight; y += 600) {
      window.scrollTo(0, y)
      await new Promise((r) => setTimeout(r, 40))
    }
  })
  await page.waitForLoadState('networkidle')
  await page.evaluate(() => document.fonts.ready)
  if (act) await act(page, report)

  const result = await page.evaluate(() => ({
    csp: window.__csp,
    cls: window.__cls,
    broken: [...document.images].filter((i) => i.complete && i.naturalWidth === 0).map((i) => i.currentSrc || i.src),
    fonts: [...document.fonts].filter((f) => f.status === 'loaded').length,
    fontErrors: [...document.fonts].filter((f) => f.status === 'error').map((f) => f.family),
  }))
  for (const v of result.csp) report(`CSP violation: ${v}`)
  for (const src of result.broken) report(`broken image: ${src}`)
  for (const family of result.fontErrors) report(`font failed: ${family}`)
  if (result.fonts === 0) report('no web font loaded')
  if (result.cls > 0) report(`the page shifted while loading (CLS ${result.cls.toFixed(4)})`)
  await context.close()
}

const desktop = { width: 1440, height: 900 }
const phone = { width: 390, height: 844 }

for (const path of pages) {
  await visit(path, desktop)
}
// Every page again with the system in dark mode: the same CSP, no errors, and the dark tokens in force.
for (const path of pages) {
  await visit(path, desktop, async (page, report) => {
    interactions++
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor)
    if (bg === 'rgb(255, 255, 255)') report(`the system asks for dark, but the page background is ${bg}`)
  }, 'dark')
}

// The theme toggle: one button, aria-pressed when dark. On a light system, pressing stores Dark, which a
// reload applies before first paint (the inline head script); pressing again lands on the system's own
// scheme and clears the choice. On a dark system the same goes the other way. With motion allowed the
// switch runs as a view transition, and with reduced motion it doesn't. Blocked storage still switches the page.
const countTransitions = () => {
  window.__vt = 0
  const start = document.startViewTransition?.bind(document)
  if (start) document.startViewTransition = (cb) => { window.__vt++; return start(cb) }
}
const state = (page) =>
  page.evaluate(() => ({
    theme: document.documentElement.dataset.theme ?? null,
    stored: localStorage.getItem('theme'),
    pressed: document.querySelector('[data-theme-toggle]').getAttribute('aria-pressed'),
    vt: window.__vt,
  }))
await visit('/', desktop, async (page, report) => {
  interactions++
  await page.addInitScript(countTransitions)
  await page.reload({ waitUntil: 'networkidle' })
  const toggle = page.locator('[data-theme-toggle]')
  if ((await toggle.getAttribute('aria-pressed')) !== 'false') report('on a light system the toggle starts pressed')
  await toggle.click()
  await page.waitForTimeout(600)
  let s = await state(page)
  if (s.theme !== 'dark' || s.stored !== 'dark' || s.pressed !== 'true') report(`pressing on a light system did not store Dark: ${JSON.stringify(s)}`)
  if (!(s.vt >= 1)) report('with motion allowed, the switch did not run as a view transition')
  await page.reload({ waitUntil: 'domcontentloaded' })
  const early = await page.evaluate(() => ({ theme: document.documentElement.dataset.theme, bg: getComputedStyle(document.documentElement).getPropertyValue('--c-bg').trim() }))
  if (early.theme !== 'dark' || early.bg !== '#121211') report(`a stored Dark is not applied before first paint: ${JSON.stringify(early)}`)
  await page.waitForLoadState('networkidle')
  await page.locator('[data-theme-toggle]').focus()
  await page.keyboard.press('Enter')
  await page.waitForTimeout(600)
  s = await state(page)
  if (s.theme !== null || s.stored !== null || s.pressed !== 'false') report(`pressing back onto the light system did not clear the choice: ${JSON.stringify(s)}`)
  await page.keyboard.press('Space')
  await page.waitForTimeout(600)
  if ((await state(page)).pressed !== 'true') report('Space did not press the toggle')
})
await visit('/', desktop, async (page, report) => {
  interactions++
  const toggle = page.locator('[data-theme-toggle]')
  if ((await toggle.getAttribute('aria-pressed')) !== 'true') report('on a dark system the toggle does not start pressed')
  await toggle.click()
  await page.waitForTimeout(600)
  let s = await state(page)
  if (s.theme !== 'light' || s.stored !== 'light') report(`pressing on a dark system did not store Light: ${JSON.stringify(s)}`)
  await toggle.click()
  await page.waitForTimeout(600)
  s = await state(page)
  if (s.theme !== null || s.stored !== null) report(`pressing back onto the dark system did not clear the choice: ${JSON.stringify(s)}`)
}, 'dark')
{
  // reduced motion: no view transition
  const context = await browser.newContext({ viewport: desktop, reducedMotion: 'reduce' })
  await context.addInitScript(countTransitions)
  const page = await context.newPage()
  await page.goto(origin + '/', { waitUntil: 'networkidle' })
  await page.locator('[data-theme-toggle]').click()
  interactions++
  const s = await state(page)
  if (s.vt !== 0 || s.theme !== 'dark') problems.push(`/ [reduced motion]: the switch ran a view transition (${s.vt}) or did not switch (${s.theme})`)
  await context.close()
}
await visit('/', desktop, async (page, report) => {
  interactions++
  // storage blocked: the toggle still changes the page for this visit
  await page.evaluate(() => { Object.defineProperty(window, 'localStorage', { get() { throw new Error('blocked') } }) })
  await page.locator('[data-theme-toggle]').click()
  await page.waitForTimeout(600)
  if ((await page.evaluate(() => document.documentElement.dataset.theme)) !== 'light') report('with storage blocked, the toggle did not switch to Light')
}, 'dark')

// The hero title prints at load but is real text from the first moment: in the accessibility tree at once,
// fully revealed by 1.5 s, and still when motion is reduced.
{
  const context = await browser.newContext({ viewport: phone })
  const page = await context.newPage()
  await page.goto(origin + '/', { waitUntil: 'domcontentloaded' })
  const tree = await page.locator('h1').ariaSnapshot()
  const early = await page.evaluate(() => { const h = document.querySelector('h1'); return { print: h.dataset.print, lines: getComputedStyle(h).getPropertyValue('--print-lines') } })
  interactions++
  if (!/Run JavaScript/.test(tree)) problems.push(`/ [hero title]: not in the accessibility tree at load (${tree})`)
  if (early.print !== 'go') problems.push(`/ [hero title]: the print was not armed (${JSON.stringify(early)})`)
  await page.waitForTimeout(1500)
  const later = await page.evaluate(() => getComputedStyle(document.querySelector('h1')).clipPath)
  if (later !== 'none' && !/inset\(0px\)/.test(later)) problems.push(`/ [hero title]: not fully shown after 1.5 s (clip-path ${later})`)
  await context.close()
  const still = await browser.newContext({ viewport: phone, reducedMotion: 'reduce' })
  const quiet = await still.newPage()
  await quiet.goto(origin + '/', { waitUntil: 'domcontentloaded' })
  const s = await quiet.evaluate(() => { const h = document.querySelector('h1'); return { print: h.dataset.print ?? null, anim: getComputedStyle(h).animationName } })
  if (s.print !== null || s.anim !== 'none') problems.push(`/ [hero title, reduced motion]: it still prints (${JSON.stringify(s)})`)
  await still.close()
}

// Masks are cheap on an icon and expensive over a large area: no element bigger than 48px may be masked or
// clipped by an SVG mask (the wordmark draws its gaps in its path instead).
for (const viewport of [desktop, phone]) {
  await visit('/', viewport, async (page, report) => {
    interactions++
    const masked = await page.evaluate(() =>
      [...document.querySelectorAll('*')]
        .filter((e) => {
          const s = getComputedStyle(e)
          const css = (s.maskImage && s.maskImage !== 'none') || (s.webkitMaskImage && s.webkitMaskImage !== 'none')
          const svg = e.getAttribute('mask') || (s.mask && s.mask !== 'none' && /url\(/.test(s.mask))
          if (!css && !svg) return false
          const r = e.getBoundingClientRect()
          return r.width > 48 || r.height > 48
        })
        .map((e) => `${e.tagName.toLowerCase()}.${String(e.className?.baseVal ?? e.className).split(' ')[0]} ${Math.round(e.getBoundingClientRect().width)}x${Math.round(e.getBoundingClientRect().height)}`),
    )
    for (const m of masked) report(`a mask over a large element (${m})`)
  })
}

// The footer wordmark prints once when it scrolls into view, the card grids reveal once, and the hero's
// icons stay where they are when the pointer moves (no tracking, no running animation). The wordmark is
// still under reduced motion.
await visit('/', desktop, async (page, report) => {
  interactions++
  const before = await page.evaluate(() => document.querySelector('[data-wordmark]').dataset.print)
  if (before !== 'go' && before !== 'armed') report(`the wordmark was not armed below the fold (data-print=${before})`)
  await page.evaluate(() => document.querySelector('footer').scrollIntoView({ block: 'end' }))
  await page.waitForTimeout(1500)
  const after = await page.evaluate(() => { const w = document.querySelector('[data-wordmark]'); return { print: w.dataset.print, clip: getComputedStyle(w).clipPath } })
  // Finished means back to the plain default: 'none', or an inset whose parsed values are all zero.
  const unclipped = (clip) => clip === 'none' || (clip.startsWith('inset(') && clip.slice(6, -1).trim().split(/\s+/).every((v) => parseFloat(v) === 0))
  if (after.print !== 'go' || !unclipped(after.clip)) report(`the wordmark never finished printing: ${JSON.stringify(after)}`)
  for (const sel of ['[data-why]', '[data-proof]']) {
    const reveal = await page.evaluate((sel) => document.querySelector(sel)?.dataset.reveal, sel)
    if (reveal !== 'shown') report(`${sel} did not reveal in view (data-reveal=${reveal})`)
  }
  // A full-height view (what a full-page capture sees): no section may stay blank.
  const fullHeight = await page.evaluate(() => document.documentElement.scrollHeight)
  await page.setViewportSize({ width: desktop.width, height: fullHeight })
  await page.waitForTimeout(900)
  const blanks = await page.evaluate(() =>
    [...document.querySelectorAll('[data-reveal]')]
      .flatMap((g) => [...g.querySelectorAll('*')])
      .filter((e) => e.children.length === 0 && e.textContent.trim() && getComputedStyle(e).opacity !== '1')
      .map((e) => `${e.tagName.toLowerCase()} "${e.textContent.trim().slice(0, 40)}" at opacity ${getComputedStyle(e).opacity}`)
      .slice(0, 5),
  )
  for (const b of blanks) report(`still hidden in a full-height view: ${b}`)
  await page.evaluate(() => scrollTo(0, 0))
  const boxes = () => page.evaluate(() => [...document.querySelectorAll('[data-hero-field] > span')].map((e) => { const r = e.getBoundingClientRect(); return `${Math.round(r.left)},${Math.round(r.top)}` }).join(' '))
  const at = await boxes()
  await page.mouse.move(40, 200)
  await page.mouse.move(1300, 700, { steps: 10 })
  await page.waitForTimeout(300)
  if ((await boxes()) !== at) report('the hero icons moved with the pointer')
  const running = await page.evaluate(() => document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations === Infinity).length)
  if (running) report(`${running} animation(s) run forever`)
})
{
  const context = await browser.newContext({ viewport: desktop, reducedMotion: 'reduce' })
  const page = await context.newPage()
  await page.goto(origin + '/', { waitUntil: 'networkidle' })
  interactions++
  const still = await page.evaluate(() => ({ print: document.querySelector('[data-wordmark]').dataset.print ?? null, running: document.getAnimations().length }))
  if (still.print !== null || still.running) problems.push(`/ [reduced motion]: something still moves: ${JSON.stringify(still)}`)
  await context.close()
}

// With JavaScript off the page is complete: every section's text is simply there — no reveal, no print,
// no script ever asked to run.
{
  const context = await browser.newContext({ viewport: desktop, javaScriptEnabled: false })
  const page = await context.newPage()
  await page.goto(origin + '/', { waitUntil: 'load' })
  interactions++
  const hidden = await page.evaluate(() => {
    const out = []
    document.querySelectorAll('main section').forEach((s) => {
      const text = s.textContent.trim()
      const visible = [...s.querySelectorAll('*')].some((e) => {
        const st = getComputedStyle(e)
        const r = e.getBoundingClientRect()
        return e.children.length === 0 && e.textContent.trim() && st.opacity === '1' && st.clipPath !== 'inset(0px 0px 100% 0px)' && r.width > 0 && r.height > 0
      })
      if (text && !visible) out.push(`${s.id || s.className}: no visible text`)
    })
    return out
  })
  for (const h of hidden) problems.push(`/ [no JavaScript]: section hidden — ${h}`)
  await context.close()
}

// The fonts actually drawn (Chromium's own record of the platform font per node): titles in Geist Pixel,
// text in Inter, both as the downloaded web fonts, never their local fallbacks.
await visit('/', desktop, async (page, report) => {
  interactions++
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('DOM.enable')
  await cdp.send('CSS.enable')
  const { root } = await cdp.send('DOM.getDocument', { depth: -1 })
  const want = [
    ['main h1', 'Geist Pixel'],
    ['main h2', 'Geist Pixel'],
    ['main p', 'Inter'],
    ['nav a', 'Inter'],
    ['footer p', 'Inter'],
    ['footer a', 'Inter'],
  ]
  for (const [selector, family] of want) {
    // the first match that holds text of its own (Chromium reports only a node's direct text)
    const found = await page.evaluate((selector) => {
      const el = [...document.querySelectorAll(selector)].find((e) => [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()))
      if (el) el.setAttribute('data-font-probe', '')
      return !!el
    }, selector)
    if (!found) continue
    const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: `${selector}[data-font-probe]` })
    if (!nodeId) continue
    const { fonts } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId })
    const main = [...fonts].sort((a, b) => b.glyphCount - a.glyphCount)[0]
    await page.evaluate(() => document.querySelectorAll('[data-font-probe]').forEach((e) => e.removeAttribute('data-font-probe')))
    if (!main || main.familyName !== family || !main.isCustomFont) report(`${selector} is drawn in ${main ? `${main.familyName}${main.isCustomFont ? '' : ' (local)'}` : 'nothing'}, not the ${family} web font`)
  }
})

// The home page's layout system: the header and every section's content column start at the same x (within 1 px),
// and every gap between consecutive sections is the same (within 4 px), at desktop and phone widths.
for (const viewport of [desktop, phone, { width: 360, height: 780 }]) {
  await visit('/', viewport, async (page, report) => {
    interactions++
    const m = await page.evaluate(() => {
      const sections = [...document.querySelectorAll('main > section')]
      const panel = document.querySelector('footer > div')
      const boxes = [sections[0].firstElementChild, ...sections.slice(1), panel].map((e) => e.getBoundingClientRect())
      const gaps = boxes.slice(1).map((b, i) => Math.round(b.top - boxes[i].bottom))
      const lefts = [document.querySelector('header nav > div'), ...sections.slice(1).map((s) => s.firstElementChild), panel.firstElementChild].map((e) => Math.round(e.getBoundingClientRect().left))
      return { gaps, lefts }
    })
    if (Math.max(...m.lefts) - Math.min(...m.lefts) > 1) report(`home sections start at different x: ${m.lefts.join(', ')}`)
    if (Math.max(...m.gaps) - Math.min(...m.gaps) > 4) report(`home section gaps differ: ${m.gaps.join(', ')}`)
  })
}

// The phone menu: the burger opens it, a link tap closes it again.
await visit('/', phone, async (page, report) => {
  await page.locator('[data-nav-toggle]').click()
  const expanded = await page.locator('[data-nav-toggle]').getAttribute('aria-expanded')
  interactions++
  if (expanded !== 'true') report(`the burger did not open the menu (aria-expanded=${expanded})`)
  await page.locator('nav > div + div a').first().click()
  await page.waitForTimeout(200)
  const closed = await page.locator('[data-nav-toggle]').getAttribute('aria-expanded')
  if (closed !== 'false') report(`a menu link did not close the menu (aria-expanded=${closed})`)
})

await browser.close()
server.close()

const label = mutate ? ' (mutated: script hashes removed)' : ''
if (problems.length) {
  console.error(`check-csp-browser${label}: ${problems.length} problem(s) on ${pages.length} pages\n`)
  for (const p of problems.slice(0, 40)) console.error(`  ${p}`)
  if (problems.length > 40) console.error(`  … and ${problems.length - 40} more`)
  process.exit(1)
}
console.log(`check-csp-browser${label}: ${pages.length} pages in light and dark + phone and tablet widths in Chromium ${version}, ` +
  `no CSP violations, errors, layout shifts or broken assets; ${interactions} scripted interactions worked`)
