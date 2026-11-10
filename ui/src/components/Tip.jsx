import { useId, useState } from 'react'

// The hover/tap tip the restyled pages share. Hover or keyboard focus shows it,
// a tap toggles it, Escape closes it, and leaving or blurring resets it.
// `prefix` picks the page's class names: `ov` gives ov-tipwrap/ov-tip, Daily
// passes `dy` for dy-tipwrap/dy-tip. With no tip text it is a plain element.
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
      onClick={() => setOpen((o) => o !== true)}
      onBlur={() => setOpen(null)}
      onMouseLeave={() => setOpen((o) => (o === false ? null : o))}
      onKeyDown={(e) => { if (e.key === 'Escape') setOpen(false) }}
      {...rest}
    >
      {children}
      <span role="tooltip" id={id} className={`${prefix}-tip`}>{tip}</span>
    </Tag>
  )
}
