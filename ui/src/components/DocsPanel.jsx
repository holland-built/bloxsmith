import { useEffect, useRef, useState } from 'react'
import { parseInline, sectionFor, parseBlocks } from '../lib/markdown.js'

// The tab documentation, read inside the app instead of on GitHub.
//
// WHY IT IS A SIDE PANEL AND NOT A DIALOG OR A TAB. This is reference material
// about the page you are looking at, so the page has to stay looked-at: a
// centred dialog covers the thing the doc is describing, and a 16th destination
// in a nav that already folds into a ⋯ at narrow widths buys a contents list
// nobody asked for. A panel down the right keeps both on screen at once.
//
// WHY IT IS STILL MODAL. It has the same dialog role, focus trap and Escape
// handling as HeaderHelp, because a reader who opens it with the keyboard has
// to be able to get out of it the same way. The only difference is where it
// sits. That machinery is deliberately the same shape as HeaderHelp's, which
// is itself a copy of TenantManager's — a third subtly different focus trap in
// one app is the one that rots.
//
// WHY THE DOC IS IMPORTED AND NOT FETCHED. `docs/TABS.md` is pulled in at build
// time with Vite's `?raw`, so the file in the repository IS what the app shows.
// There is no endpoint, no copy step into go/, and no way for the in-app copy
// to drift from the one on GitHub — which was the failure mode of every other
// option. It is behind a dynamic import so its ~14 KB is paid only by readers
// who open this panel, the same rule the charts now follow.
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

const DOCS_REPO_URL = 'https://github.com/holland-built/bloxsmith/blob/master/docs/TABS.md'

function Inline({ text }) {
  return (
    <>
      {parseInline(text).map((tok, i) => {
        if (tok.type === 'strong') return <strong key={i} className="font-semibold text-field-txt">{tok.text}</strong>
        if (tok.type === 'em') return <em key={i}>{tok.text}</em>
        if (tok.type === 'code') return <code key={i} className="font-mono text-note px-1 py-0.5 rounded-mark bg-field text-field-txt">{tok.text}</code>
        if (tok.type === 'link') {
          // Links inside the doc point at GitHub, other docs, or Infoblox. They
          // leave the app, so they say so and open in their own tab.
          return (
            <a key={i} href={tok.href} target="_blank" rel="noreferrer" className="text-accent underline underline-offset-2">
              {tok.text}
            </a>
          )
        }
        return <span key={i}>{tok.text}</span>
      })}
    </>
  )
}

function Blocks({ blocks }) {
  return blocks.map((b, i) => {
    switch (b.type) {
      case 'heading': {
        // The section's own h2 is the panel's title, rendered by the header
        // above, so inside the body every heading drops one level. That keeps
        // the panel to a single h2 and stops the document outline growing a
        // second top-level heading beside the page's own.
        const cls = b.level <= 2
          ? 'text-copy font-semibold text-field-txt mt-4 mb-1.5 first:mt-0'
          : 'text-note font-semibold text-field-txt mt-3 mb-1'
        const Tag = b.level <= 2 ? 'h3' : 'h4'
        return <Tag key={i} className={cls}>{b.text}</Tag>
      }
      case 'para':
        return <p key={i} className="text-note leading-relaxed text-muted mb-2"><Inline text={b.text} /></p>
      case 'ul':
        return (
          <ul key={i} className="list-disc pl-4 mb-2">
            {b.items.map((it, n) => <li key={n} className="text-note leading-relaxed text-muted mb-0.5"><Inline text={it} /></li>)}
          </ul>
        )
      case 'ol':
        return (
          <ol key={i} className="list-decimal pl-4 mb-2">
            {b.items.map((it, n) => <li key={n} className="text-note leading-relaxed text-muted mb-0.5"><Inline text={it} /></li>)}
          </ol>
        )
      case 'table':
        return (
          <div key={i} className="overflow-x-auto mb-2">
            <table className="w-full border-collapse text-note">
              <thead>
                <tr>
                  {b.head.map((h, n) => (
                    <th key={n} className="text-left font-semibold text-field-txt border-b border-card-border px-1.5 py-1"><Inline text={h} /></th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {b.body.map((row, n) => (
                  <tr key={n}>
                    {row.map((c, m) => (
                      <td key={m} className="align-top text-muted border-b border-card-border px-1.5 py-1"><Inline text={c} /></td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      case 'quote':
        return (
          <blockquote key={i} className="border-l-2 border-card-border pl-2.5 my-2 text-note leading-relaxed text-dim">
            <Inline text={b.text} />
          </blockquote>
        )
      case 'hr':
        return <hr key={i} className="border-0 border-t border-card-border my-3" />
      default:
        return null
    }
  })
}

export default function DocsPanel({ anchor, onClose }) {
  const panelRef = useRef(null)
  const [doc, setDoc] = useState(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => { panelRef.current?.focus() }, [])

  useEffect(() => {
    let alive = true
    import('../../../docs/TABS.md?raw')
      .then((m) => { if (alive) setDoc(m.default) })
      .catch(() => { if (alive) setFailed(true) })
    return () => { alive = false }
  }, [])

  const onKeyDown = (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      onClose()
      return
    }
    if (e.key !== 'Tab') return
    const items = [...panelRef.current.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null)
    if (!items.length) {
      e.preventDefault()
      panelRef.current.focus()
      return
    }
    const first = items[0]
    const last = items[items.length - 1]
    const cur = document.activeElement
    if (e.shiftKey && (cur === first || cur === panelRef.current)) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && cur === last) {
      e.preventDefault()
      first.focus()
    }
  }

  // A section that does not exist falls back to the whole document rather than
  // to an error: an anchor stops matching when the docs are REORGANISED, which
  // is not something the reader did or can fix, and the thing they wanted is
  // still in there.
  const section = doc ? sectionFor(doc, anchor) : null
  const blocks = doc ? (section ?? parseBlocks(doc)) : []
  const showingWholeDoc = !!doc && section === null
  // The title comes from the document's own heading, not from a prop the caller
  // has to keep in step with it. A tab renamed in docs/TABS.md renames itself
  // here; there is no second copy of the name to go stale.
  const title = section?.[0]?.type === 'heading' ? section[0].text : null

  return (
    <div className="fixed inset-0 z-[200] bg-black/40 flex justify-end" onClick={onClose} onKeyDown={onKeyDown}>
      <aside
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="docs-title"
        tabIndex={-1}
        className="w-[420px] max-w-full h-full overflow-y-auto bg-card border-l border-card-border p-5 outline-none"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center mb-3">
          <h2 id="docs-title" className="text-copy font-semibold">{title ? `Docs — ${title}` : 'Docs'}</h2>
          <span className="flex-1" />
          <button className="text-muted text-copy" onClick={onClose} aria-label="Close">✕</button>
        </div>

        {failed ? (
          // Says what is still available rather than only what broke.
          <p className="text-note leading-relaxed text-muted">
            The documentation could not be loaded.{' '}
            <a href={DOCS_REPO_URL} target="_blank" rel="noreferrer" className="text-accent underline underline-offset-2">
              Read it on GitHub
            </a>
            .
          </p>
        ) : !doc ? (
          <p className="text-note text-dim">Loading…</p>
        ) : (
          <>
            {showingWholeDoc && (
              <p className="text-note leading-relaxed text-dim mb-3">
                This tab has no section of its own yet, so the whole document is below.
              </p>
            )}
            {/* The section heading is the panel's title above, so it is not
                repeated in the body. */}
            <Blocks blocks={section ? blocks.slice(1) : blocks} />
            <p className="mt-4 pt-3 border-t border-card-border text-note">
              <a href={DOCS_REPO_URL} target="_blank" rel="noreferrer" className="text-accent underline underline-offset-2">
                All tabs, on GitHub →
              </a>
            </p>
          </>
        )}
      </aside>
    </div>
  )
}
