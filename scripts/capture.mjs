// Screenshots the built site for review: 1440 and 390 px wide, light and dark, full page.
//
//   npm run build && npm run capture          # writes captures/home-{1440,390}-{light,dark}.png
//   node scripts/capture.mjs --dist dist      # another build directory
//
// Playwright is not a dependency of this repo. Install it (npm i -D playwright && npx playwright
// install chromium), or point PLAYWRIGHT_MODULE at an existing node_modules/playwright directory.
// The screenshots are for people, not for CI: captures/ is gitignored.
import { createServer } from 'node:http'
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join, normalize, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const distArg = process.argv.indexOf('--dist')
const dist = join(root, distArg > 0 ? process.argv[distArg + 1] : 'dist')
const out = join(root, 'captures')

const playwright = await import(
  process.env.PLAYWRIGHT_MODULE ? pathToFileURL(join(process.env.PLAYWRIGHT_MODULE, 'index.mjs')).href : 'playwright'
).catch(() => {
  console.error('capture: Playwright not found. Install it, or set PLAYWRIGHT_MODULE (see the top of this file).')
  process.exit(2)
})

if (!existsSync(join(dist, 'index.html'))) {
  console.error('capture: no build at dist/. Run npm run build first.')
  process.exit(1)
}

const types = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.xml': 'application/xml', '.txt': 'text/plain',
}
const server = createServer((req, res) => {
  let file = normalize(join(dist, decodeURIComponent(new URL(req.url, 'http://x').pathname)))
  if (file !== dist && !file.startsWith(dist + sep)) return void res.writeHead(403).end()
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html')
  if (!existsSync(file)) return void res.writeHead(404).end()
  res.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream' })
  res.end(readFileSync(file))
})
await new Promise((ok) => server.listen(0, '127.0.0.1', ok))
const origin = `http://127.0.0.1:${server.address().port}`

mkdirSync(out, { recursive: true })
const browser = await playwright.chromium.launch()
const shots = []
for (const width of [1440, 390]) {
  const viewport = { width, height: width > 500 ? 900 : 844 }
  for (const colorScheme of ['light', 'dark']) {
    const page = await browser.newPage({ viewport, colorScheme })
    await page.goto(origin + '/', { waitUntil: 'networkidle' })
    await page.evaluate(() => document.fonts.ready)
    // Walk the page like a reader: step to the bottom so every reveal and the footer wordmark's print
    // fire, then back to the top. 'instant' matters — the page's smooth scroll-behavior turns a plain
    // scrollTo into an animated glide that a fast loop only ever chases, and the wordmark stays armed.
    await page.evaluate(async () => {
      const pause = () => new Promise((r) => setTimeout(r, 60))
      const bottom = () => Math.max(document.documentElement.scrollHeight, document.body.scrollHeight) - innerHeight
      for (let y = 0; y < bottom(); y += Math.round(innerHeight * 0.75)) {
        window.scrollTo({ top: y, behavior: 'instant' })
        await pause()
      }
      window.scrollTo({ top: bottom(), behavior: 'instant' })
      await pause()
      window.scrollTo({ top: 0, behavior: 'instant' })
    })
    // Then wait, strictly, for every once-only effect to be done: no grid left pending, and the
    // wordmark's clip fully released ('none', or an inset whose values all parse to zero).
    await page.waitForFunction(() => {
      const pending = [...document.querySelectorAll('[data-reveal]')].some((g) => g.dataset.reveal === 'pending')
      const clip = getComputedStyle(document.querySelector('[data-wordmark]')).clipPath
      const unclipped = clip === 'none' || (clip.startsWith('inset(') && clip.slice(6, -1).trim().split(/\s+/).every((v) => parseFloat(v) === 0))
      return !pending && unclipped
    })
    await page.waitForTimeout(400)
    const name = `home-${width}-${colorScheme}.png`
    await page.screenshot({ path: join(out, name), fullPage: true })
    shots.push(name)
    await page.close()
  }
}
await browser.close()
server.close()
console.log(`capture: ${shots.length} screenshots in ${out}`)
for (const s of shots) console.log(`  ${s}`)
