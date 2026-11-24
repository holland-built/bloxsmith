// Scroll to a panel and move focus to it. A panel taken off the page has no
// element, so focus goes to Arrange panels, where it can be put back. Every
// headline tile that points at a panel jumps this way.
export function jumpToPanel(panelId) {
  const el = document.querySelector(`[data-panel-id="${panelId}"]`)
  if (!el) {
    const arrange = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Arrange panels')
    arrange?.focus()
    return
  }
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  el.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' })
  // A smooth scroll keeps the target it started with. If panels above change
  // height while it runs, it stops in the wrong place (a phone landing ended
  // with the panel's title under the header), so settle it once it stops.
  // Only for this jump: the person's own scroll is never undone, so any wheel,
  // touch or key press, or 2 seconds with no scroll, drops it.
  if (!reduce) {
    const INPUT = ['wheel', 'touchstart', 'keydown']
    const drop = () => {
      window.removeEventListener('scrollend', settle)
      INPUT.forEach((t) => window.removeEventListener(t, drop, true))
    }
    const settle = () => { drop(); el.scrollIntoView({ block: 'start' }) }
    window.addEventListener('scrollend', settle)
    INPUT.forEach((t) => window.addEventListener(t, drop, { capture: true, passive: true }))
    setTimeout(drop, 2000)
  }
  if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1')
  el.focus({ preventScroll: true })
}
