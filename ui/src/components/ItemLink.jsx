import { lazy, Suspense, useCallback, useRef, useState } from 'react'
import { blockHref, itemHref, MENU_KINDS } from '../lib/itemHref.js'

// Loaded on the first right-click, so pages that never open one do not pay for it.
const ItemMenu = lazy(() => import('./ItemMenu.jsx'))

// How long a finger rests on a name before its menu opens.
const LONG_PRESS_MS = 550

// A name that opens that item's own page (#dossier?kind=…). Used in table name
// cells: the click is kept to the link, so a row that opens something else on
// click does not also do that. A blank value ("—") is shown as plain text.
//
// A network, address block, IP space, address or DNS zone also has a menu of
// what you can do with it (ItemMenu): right-click, Shift+F10 or the Menu key,
// or a long press on a touch screen. Shift+right-click keeps the browser's own
// menu, for "open in new tab" and the like.
export default function ItemLink({ kind, value, id, space, view, className = '', title, label, children }) {
  const href = itemHref({ kind, value, id, space, view }) ?? (kind === 'block' ? blockHref({ value, id }) : null)
  const text = children ?? (value == null || value === '' ? '—' : value)
  const [menuAt, setMenuAt] = useState(null)
  const linkRef = useRef(null)
  const press = useRef({ timer: 0, opened: false })
  const hasMenu = !!href && MENU_KINDS.includes(kind)
  const onClose = useCallback(() => setMenuAt(null), [])

  if (!href) return <span className={className} title={title}>{text}</span>

  const openBelow = () => {
    const r = linkRef.current.getBoundingClientRect()
    setMenuAt({ x: r.left, y: r.bottom + 4 })
  }
  const menuProps = hasMenu
    ? {
        onContextMenu: (e) => {
          if (e.shiftKey) return
          e.preventDefault()
          e.stopPropagation()
          // A keyboard-made contextmenu event has no pointer position.
          if (e.clientX === 0 && e.clientY === 0) openBelow()
          else setMenuAt({ x: e.clientX, y: e.clientY })
        },
        onKeyDown: (e) => {
          if ((e.key === 'F10' && e.shiftKey) || e.key === 'ContextMenu') {
            e.preventDefault()
            e.stopPropagation()
            openBelow()
          }
        },
        onPointerDown: (e) => {
          if (e.pointerType !== 'touch') return
          press.current.opened = false
          clearTimeout(press.current.timer)
          const { clientX: x, clientY: y } = e
          press.current.timer = setTimeout(() => {
            press.current.opened = true
            setMenuAt({ x, y })
          }, LONG_PRESS_MS)
        },
        onPointerUp: () => clearTimeout(press.current.timer),
        onPointerMove: () => clearTimeout(press.current.timer),
        onPointerCancel: () => clearTimeout(press.current.timer),
        'aria-keyshortcuts': 'Shift+F10',
        style: { WebkitTouchCallout: 'none' },
      }
    : {}

  return (
    <>
      <a
        ref={linkRef}
        href={href}
        data-item-link={kind}
        title={title}
        aria-label={label}
        {...menuProps}
        onClick={(e) => {
          e.stopPropagation()
          // The lift after a long press is not a tap on the link.
          if (press.current.opened) {
            e.preventDefault()
            press.current.opened = false
          }
        }}
        className={'text-link hover:underline underline-offset-2 ' + className}
      >
        {text}
      </a>
      {menuAt && (
        <Suspense fallback={null}>
          <ItemMenu item={{ kind, q: value, id, space }} at={menuAt} anchor={linkRef.current} onClose={onClose} />
        </Suspense>
      )}
    </>
  )
}
