// The hero panels play on their own (the maintainer's call, 2026-11-19) and stop the moment anyone engages:
// no further step starts
// on hover, on keyboard focus inside, on a touch, while the panel is off screen, while the tab is hidden, and
// never at all when the visitor asks for reduced motion. One timer per panel, re-armed only while it may run,
// so an idle page with the panels out of view does no work. A step already playing, and anything a visitor
// clicks, always plays to its end: pausing must never freeze an animation on its hidden first frame.
export function autoplay(panel: HTMLElement, step: () => void, everyMs: number): void {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)')
  let timer = 0
  let visible = false
  let held = 0 // hover, focus and touch each hold the panel; it plays only when nothing does
  const canRun = () => visible && held === 0 && !document.hidden && !reduce.matches
  const arm = () => {
    clearTimeout(timer)
    panel.dataset.autoplay = canRun() ? 'on' : 'paused'
    if (canRun()) timer = window.setTimeout(() => (step(), arm()), everyMs)
  }
  const hold = (on: boolean) => {
    held = Math.max(0, held + (on ? 1 : -1))
    arm()
  }
  new IntersectionObserver(([e]) => ((visible = e.isIntersecting), arm()), { threshold: 0.2 }).observe(panel)
  panel.addEventListener('pointerenter', () => hold(true))
  panel.addEventListener('pointerleave', () => hold(false))
  panel.addEventListener('focusin', () => hold(true))
  panel.addEventListener('focusout', () => hold(false))
  document.addEventListener('visibilitychange', arm)
  reduce.addEventListener('change', arm)
}
