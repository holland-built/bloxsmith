import { useId, useState } from 'react'

// The hover/tap tip the restyled pages share. Hover or keyboard focus shows it,
// a tap toggles it, Escape closes it, and leaving or blurring resets it.
// `prefix` picks the page's class names: `ov` gives ov-tipwrap/ov-tip, Daily
// passes `dy` for dy-tipwrap/dy-tip. With no tip text it is a plain element.

// Slides an opening tip sideways so it stays 8px inside the screen. It is
// measured while hidden because a tap opens it only after this runs.
function keepOnScreen(wrap) {
  const tip = wrap.querySelector(':scope > [role="tooltip"]')
  if (!tip) return
  const { display, visibility } = tip.style
  tip.style.visibility = 'hidden'
  tip.style.display = 'block'
  tip.style.setProperty('--tip-shift', '0px')
  const { left, right } = tip.getBoundingClientRect()
  const edge = document.documentElement.clientWidth - 8
  const shift = left < 8 ? 8 - left : right > edge ? Math.max(edge - right, 8 - left) : 0
  tip.style.setProperty('--tip-shift', `${shift}px`)
  tip.style.display = display
  tip.style.visibility = visibility
}

export default function Tip({ tip, children, className = '', as: Tag = 'span', prefix = 'ov', ...rest }) {
  const id = useId()
  // null follows hover and focus; true is opened by a tap; false is closed by
  // Escape, which has to beat :focus-visible (a key press turns it on).
  const [open, setOpen] = useState(null)
  if (!tip) return <Tag className={className} {...rest}>{children}</Tag>
  return (
    <Tag
      className={`${prefix}-tipwrap ${className}`}
      tabIndex={0}
      aria-describedby={id}
      data-open={open === true || undefined}
      data-closed={open === false || undefined}
      onFocus={(e) => keepOnScreen(e.currentTarget)}
      onPointerEnter={(e) => keepOnScreen(e.currentTarget)}
      onClick={(e) => { keepOnScreen(e.currentTarget); setOpen((o) => o !== true) }}
      onBlur={() => setOpen(null)}
      onMouseLeave={() => setOpen((o) => (o === false ? null : o))}
      onKeyDown={(e) => { if (e.key === 'Escape') setOpen(false) }}
      {...rest}
    >
      {children}
      {/* A click on the open tip, to select its words, must not close it. */}
      <span role="tooltip" id={id} className={`${prefix}-tip`} onClick={(e) => e.stopPropagation()}>{tip}</span>
    </Tag>
  )
}
