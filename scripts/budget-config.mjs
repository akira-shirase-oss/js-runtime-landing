// The performance budget, shared by scripts/check-budget.mjs (bytes) and scripts/lighthouse-budget.mjs
// (lab metrics). Raise a number only with a measurement and the maintainer's approval: "always top
// notch performance". Ported from products/colophon-landing (the same numbers, adapted to a single-page
// site: there is no blog to reuse, so CSS is budgeted per page by bytes).
export const HTML_BUDGET_GZ = 60 * 1024
export const CSS_BUDGET_GZ = 6610 // the landing page's two stylesheets, gzipped, on 19 November 2026
export const IMAGE_BUDGET = 100 * 1024
/** The page types Lighthouse measures: paths under dist/, one entry each. */
export const PAGES = ['/']
/** A page measured the same way and printed, never gated — the machine's alibi when a run looks slow. */
export const CONTROL = '/404.html'
/** Lighthouse, mobile, median of five runs (five, not three: one noisy run on a shared CI runner can't move it).
 *
 *  ownScriptMs is the strict part: the main-thread work the page itself causes (Script Evaluation plus
 *  Script Parsing & Compilation), which runner noise can't fake. TBT 150 matches the evidence the
 *  family collected on GitHub's runner: pages score 46–59 ms there against 0 on a quiet laptop. */
export const LIGHTHOUSE = { lcpMs: 2000, cls: 0, tbtMs: 150, ownScriptMs: 50, performance: 95, seo: 100, accessibility: 100 }
/** One page type's whole Lighthouse measurement (all its runs) may take this long before it fails and
 *  the next type starts, so one slow page can't eat the job's time. */
export const PAGE_DEADLINE_MS = 5 * 60 * 1000
