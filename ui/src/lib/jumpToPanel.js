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
  if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1')
  el.focus({ preventScroll: true })
}
