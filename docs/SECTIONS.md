# Adding a section

A section is four small files and one line — budget an hour, most of it on the words.

The page today: `index.astro` renders `Hero → Why → Metrics → Features` inside `<main>`, with `Nav`
and `Footer` outside it. The hero is special — `Hero.astro` composes three self-playing panels from
`src/components/hero/` (`RunCard`, `Capabilities`, `ExitCodes`, sharing `panel.module.css`). A normal
new section follows `Why`/`Metrics`/`Features`, not the hero.

1. **Copy in `src/data/`** — if the section's text is more than a few lines, put it in a data file
   (`src/data/site.ts` holds URLs and shared copy; `hero.ts` is the model). Content keeps out of markup
   and gets typechecked.
2. **`src/components/<Name>.astro`** — a `<section class="section" id="slug">` wrapping
   `<div class={\`container ${styles.inner}\`}>`, a `<SectionHeading badge="…">` (the small label +
   heading pair; `Badge.astro` for standalone labels), then the body. `Why.astro` is the closest
   current model.
3. **`src/components/<Name>.module.css`** — the section's styles, scoped. **Colours come from
   `tokens.css` only** — `scripts/colors.test.mjs` fails the build on a literal and on a light token
   without a dark twin. Sizes/positions may be literals.
4. **Place it in `src/pages/index.astro`** — one line inside `<main>`; spacing between sections is
   `--section-gap`, automatic.

## The rules a section lives under

- **Type**: the shared classes in `global.css` for headings/body/labels, plus `mono` for code styling.
  New roles get new classes there, not ad-hoc `font-size`. Fonts are Jost (display), Plus Jakarta Sans
  (text) and JetBrains Mono (code) — `scripts/fonts.mjs` rebuilds the woff2s and their fallback
  metrics if a font is ever swapped.
- **Text**: real HTML (`<ul>`, `<p>`, `<h3>`), never text baked into an image or canvas.
- **Motion**: the bar is `src/scripts/autoplay.ts`. Panels may *self-play* (the maintainer's call for
  the hero), but only through `autoplay(panel, step, everyMs)`, which stops a new step from starting
  on hover, keyboard focus inside, touch, while the panel is off screen (`IntersectionObserver`), while
  the tab is hidden, and never plays under `prefers-reduced-motion` — `data-autoplay` on the panel
  reads `on`/`paused`. One timer, re-armed only while it may run: an idle page does no work. A step
  already playing, and anything a visitor clicked, always plays to its end — pausing must never freeze
  an animation on its hidden first frame. For a plain once-only reveal, copy the arm-on-scroll pattern
  from an existing component (hidden start gated on `html.js`, in-viewport content visible at once).
  No infinite decoration, no pointer/scroll listeners — `check` and `check:browser` both look.
- **a11y**: landmark content in order (`h1 → h2 → h3`), decorative SVG `aria-hidden`, interactive
  things real elements (the hero's "Run again" is a `<button>`). Text pairs ≥ 4.5, boundaries ≥ 3 in
  both themes — a new colour pair goes in `tokens.css` with a dark twin; the browser suite's axe pass
  covers the page.
- **Keys**: focusable things get the shared `:focus-visible` ring; keyboard order follows the DOM, so
  write the DOM in reading order.
- **Scripts**: a component `<script>` becomes a bundled same-origin file (CSP `script-src 'self'`); an
  inline one needs its sha256 swapped into `public/_headers` — `npm run build && npm run check` prints
  it. Nothing loads from another origin.
- **Size**: `check-budget.mjs` gates HTML ≤ 60 KB gz, the page's CSS ≤ `CSS_BUDGET_GZ` gz (current:
  9,328 B), images AVIF/WebP/SVG with explicit dimensions (lazy below the first) ≤ 100 KB; the
  Lighthouse half gates the lab numbers (`scripts/budget-config.mjs`). A heavier section needs a
  measurement and a reason.

## Verification loop (before committing)

```sh
npm run build          # CSP hash for any new inline script comes out of this
npm run check          # _headers swap if a script changed, then this goes green
npm test               # colors + json-ld + budget tests
npm run lint           # oxlint
node scripts/check-budget.mjs
npm run capture        # needs Chromium — adds the section to the 1440/390 light/dark shots
```

`capture.mjs` shoots the whole page, so a new section is covered automatically; the browser suite's
"no blank sections" check covers its reveal state.

## Minimal example (not on the page)

```astro
---
// src/components/Roadmap.astro + Roadmap.module.css
import SectionHeading from './ui/SectionHeading.astro'
import styles from './Roadmap.module.css'
---
<section class="section" id="roadmap">
  <div class={`container ${styles.inner}`}>
    <SectionHeading badge="ROADMAP">
      What's still <span class="soft">unwritten</span>
    </SectionHeading>
    <ul class={styles.list}>
      <li class="t-body">A Windows build</li>
      <li class="t-body">Streaming responses</li>
    </ul>
  </div>
</section>
```

```css
/* Roadmap.module.css */
.inner { display: flex; flex-direction: column; gap: 32px; }
.list { display: grid; gap: 12px; color: var(--c-text); padding-left: 1.2em; }
```

Then `<Roadmap />` between two sections in `index.astro` — no spacing, nav or theme work of its own.
