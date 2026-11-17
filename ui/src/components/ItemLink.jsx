import { itemHref } from '../lib/itemHref.js'

// A name that opens that item's own page (#dossier?kind=…). Used in table name
// cells: the click is kept to the link, so a row that opens something else on
// click does not also do that. A blank value ("—") is shown as plain text.
export default function ItemLink({ kind, value, id, space, view, className = '', title, children }) {
  const href = itemHref({ kind, value, id, space, view })
  const text = children ?? (value == null || value === '' ? '—' : value)
  if (!href) return <span className={className} title={title}>{text}</span>
  return (
    <a
      href={href}
      data-item-link={kind}
      title={title}
      onClick={(e) => e.stopPropagation()}
      className={'text-link hover:underline underline-offset-2 ' + className}
    >
      {text}
    </a>
  )
}
