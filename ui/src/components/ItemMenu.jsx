import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { copyText, itemActions } from '../lib/itemActions.js'
import { dialogKeyDown } from '../lib/focusTrap.js'
import { ITEM_WORDS } from '../lib/itemHref.js'

const WORDS = { ...ITEM_WORDS, block: 'Address block' }

// The small menu a name opens on right-click, Shift+F10, the Menu key or a
// long press: what you can do with that item (lib/itemActions.js, the same
// list the item page shows). Each entry opens a job with the details filled
// in; none of them writes anything.
//
// Keyboard as the group menus in App.jsx: focus goes to the first entry, the
// arrows, Home and End move, Enter picks, Escape closes and puts focus back on
// the name. It looks like those menus too (MenuPanel's surface and rows).
//
// Rendered into <body> with fixed position, so a table cell's overflow cannot
// clip it, then moved back inside the window if it would spill over an edge.
export default function ItemMenu({ item, at, anchor, onClose }) {
  const ref = useRef(null)
  const [pos, setPos] = useState({ left: at.x, top: at.y })
  const [copied, setCopied] = useState(false)
  const actions = itemActions(item)
  const word = WORDS[item.kind] || 'Item'

  const close = (refocus = true) => {
    onClose()
    if (refocus) anchor?.focus()
  }

  // Keep it inside the window, 8px from each edge.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const left = Math.max(8, Math.min(at.x, window.innerWidth - r.width - 8))
    const top = at.y + r.height + 8 > window.innerHeight ? Math.max(8, at.y - r.height) : at.y
    setPos({ left, top })
  }, [at.x, at.y])

  useEffect(() => {
    ref.current?.querySelector('[role="menuitem"]')?.focus()
  }, [])

  // A press anywhere else, or the page moving under it, closes it.
  useEffect(() => {
    const onDown = (e) => {
      if (!ref.current?.contains(e.target)) onClose()
    }
    const onMove = () => onClose()
    document.addEventListener('pointerdown', onDown, true)
    window.addEventListener('resize', onMove)
    window.addEventListener('hashchange', onMove)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('resize', onMove)
      window.removeEventListener('hashchange', onMove)
    }
  }, [onClose])

  const onKeyDown = (e) => {
    // The menu sits in <body>, but React passes its events up to whatever
    // holds the name (a table row that opens a drawer, say). They stop here.
    e.stopPropagation()
    const items = [...(ref.current?.querySelectorAll('[role="menuitem"]') ?? [])]
    const i = items.indexOf(document.activeElement)
    const go = (n) => {
      e.preventDefault()
      items[(n + items.length) % items.length]?.focus()
    }
    if (e.key === 'ArrowDown') go(i + 1)
    else if (e.key === 'ArrowUp') go(i - 1)
    else if (e.key === 'Home') go(0)
    else if (e.key === 'End') go(items.length - 1)
    else dialogKeyDown(e, ref.current, () => close())
  }

  const row = 'flex items-center w-full h-8 px-2.5 rounded-control text-copy text-left no-underline text-field-txt hover:bg-line hover:text-txt focus:bg-line focus:text-txt'

  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label={`${word} ${item.q}`}
      data-item-menu={item.kind}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation() }}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      style={{ position: 'fixed', left: pos.left, top: pos.top }}
      className="min-w-[214px] max-w-[min(360px,calc(100vw-16px))] z-50 bg-card border border-border rounded-surface shadow-lg p-1.5"
    >
      <div aria-hidden="true" className="px-2.5 pt-1 pb-1 text-note text-dim truncate">
        {word}: <span className="font-mono">{item.q}</span>
      </div>
      {actions.map((a) =>
        a.href ? (
          <a key={a.key} role="menuitem" href={a.href} data-action={a.key} className={row} onClick={() => close(false)}>
            {a.label}
          </a>
        ) : (
          <button
            key={a.key}
            type="button"
            role="menuitem"
            data-action={a.key}
            className={row}
            onClick={async () => {
              const ok = await copyText(a.copy)
              setCopied(ok ? 'Copied' : 'Could not copy')
              setTimeout(() => close(), 900)
            }}
          >
            {copied || a.label}
          </button>
        ),
      )}
      <span role="status" className="sr-only">{copied === 'Copied' ? `Copied ${item.q}` : copied || ''}</span>
    </div>,
    document.body,
  )
}
