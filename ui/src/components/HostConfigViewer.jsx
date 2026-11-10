import { useEffect, useRef, useState } from 'react'
import { Empty, FeedUnavailable, FOCUS_RING, Skeleton } from './ui.jsx'
import { dialogKeyDown } from '../lib/focusTrap.js'

// The DNS or DHCP settings one host loaded, read through GET /api/host-config.
// The server hides every password and secret key before the text gets here
// (go/internal/dashboard/hosts.go RedactConfig), so nothing on this side has
// to know what a secret looks like.

const TYPES = [
  { id: 'dns', label: 'DNS' },
  { id: 'dhcp', label: 'DHCP' },
]

// host_type "6" is a NIOS grid member. The config tool has nothing for one:
// asked live on 2026-11-10 it answered "none of [named.conf] present".
export const NIOS_GRID_MEMBER = '6'

function fmtWhen(v) {
  const t = Date.parse(v)
  return Number.isNaN(t) ? '' : new Date(t).toLocaleString()
}

// The server withholds a whole file when it holds a secret it cannot safely
// hide (hosts.go safeToShow). Such a file is named, never shown or copied.
const WITHHELD = "This file holds a secret in a form Bloxsmith can't safely hide, so it isn't shown."

// What the copy button puts on the clipboard: every shown file, each under its name.
function allText(files) {
  const shown = files.filter((f) => !f.withheld)
  if (files.length === 1) return shown[0].text
  return shown.map((f) => `# ${f.name}\n${f.text}`).join('\n\n')
}

export default function HostConfigViewer({ host, onClose }) {
  const [type, setType] = useState('dns')
  const [state, setState] = useState({ loading: true })
  const [copied, setCopied] = useState('')
  const [attempt, setAttempt] = useState(0)
  const panelRef = useRef(null)
  // The tab on screen now, so a copy that finishes after a switch to the
  // other tab does not report on it.
  const typeRef = useRef(type)
  typeRef.current = type
  const gridMember = String(host.host_type ?? '') === NIOS_GRID_MEMBER

  useEffect(() => {
    if (gridMember) return
    const ctl = new AbortController()
    setState({ loading: true })
    setCopied('')
    // Switching DNS/DHCP aborts the older read. Every state update below checks
    // the signal, so a superseded read can never paint over the newer one, and
    // an abort is never reported as a failure.
    const live = () => !ctl.signal.aborted
    fetch(`/api/host-config?ophid=${encodeURIComponent(host.ophid)}&type=${type}`, { cache: 'no-store', signal: ctl.signal })
      .then(async (r) => {
        let body = null
        try {
          body = await r.json()
        } catch (e) {
          if (e.name === 'AbortError') throw e
        }
        if (!r.ok || !body) throw new Error(body?.error || `The server answered ${r.status}.`)
        if (live()) setState({ data: body })
      })
      .catch((e) => {
        if (live() && e.name !== 'AbortError') setState({ error: e.message || 'Could not load the settings.' })
      })
    return () => ctl.abort()
  }, [host.ophid, type, gridMember, attempt])

  // Focus moves into the viewer on open and back to the row on close.
  useEffect(() => {
    const opener = document.activeElement
    panelRef.current?.focus()
    return () => {
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus()
    }
  }, [])

  const onKeyDown = (e) => dialogKeyDown(e, panelRef.current, onClose)

  const data = state.data
  const files = data?.status === 'ok' ? data.files || [] : []
  const label = TYPES.find((t) => t.id === type).label

  async function copy() {
    const forType = type
    let msg
    try {
      await navigator.clipboard.writeText(allText(files))
      msg = 'Copied.'
    } catch {
      msg = 'Could not copy. Select the text and copy it by hand.'
    }
    if (typeRef.current === forType) setCopied(msg)
  }

  let body
  if (gridMember) {
    body = <Empty>This is a NIOS grid member. Infoblox keeps no DNS or DHCP settings file for it here.</Empty>
  } else if (state.loading) {
    body = <Skeleton h={320} />
  } else if (state.error || data?.status === 'error') {
    body = (
      <FeedUnavailable
        label={`${label} settings did not load`}
        reason={state.error || data.reason}
        onRetry={() => setAttempt((n) => n + 1)}
      />
    )
  } else if (files.length === 0) {
    body = <Empty>{`This host has no ${label} settings saved.`}</Empty>
  } else {
    body = (
      <div className="flex flex-col gap-4">
        {files.map((f) => (
          <section key={f.name} aria-label={f.name}>
            {files.length > 1 && <h3 className="text-note font-semibold text-muted mb-1 font-mono">{f.name}</h3>}
            {f.withheld ? (
              <p className="text-note text-muted bg-field border border-line rounded-control p-3">{WITHHELD}</p>
            ) : (
              <pre
                tabIndex={0}
                className={`font-mono text-note leading-relaxed text-txt bg-field border border-line rounded-control p-3 overflow-x-auto whitespace-pre outline-none ${FOCUS_RING}`}
              >
                {f.text}
              </pre>
            )}
          </section>
        ))}
      </div>
    )
  }

  const when = fmtWhen(data?.retrieved_at)
  const facts = [data?.version && `version ${data.version}`, when && `saved ${when}`].filter(Boolean).join(' · ')

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/40" onClick={onClose} onKeyDown={onKeyDown}>
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="host-config-title"
        tabIndex={-1}
        data-host-config=""
        className="h-full w-full max-w-[760px] bg-card border-l border-card-border flex flex-col outline-none"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 pt-4 pb-3 border-b border-line flex flex-col gap-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 id="host-config-title" className="text-copy font-semibold truncate">
                Settings on {host.name || 'this host'}
              </h2>
              <p className="text-note text-muted mt-0.5">
                What this host loaded, as Infoblox last saved it. Passwords and secret keys show as (hidden).
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              className={`shrink-0 px-2 py-1 rounded-control border border-border bg-field text-field-txt text-note ${FOCUS_RING}`}
            >
              Close
            </button>
          </div>
          {!gridMember && (
            <div className="flex items-center gap-3 flex-wrap">
              <div role="group" aria-label="Which settings" className="inline-flex rounded-control border border-border bg-field p-0.5">
                {TYPES.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    aria-pressed={type === t.id}
                    onClick={() => setType(t.id)}
                    className={`px-3 py-1 rounded-control text-note font-medium ${FOCUS_RING} ${
                      type === t.id ? 'bg-line text-txt' : 'text-dim hover:text-muted'
                    }`}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
              {files.some((f) => !f.withheld) && (
                <button
                  type="button"
                  onClick={copy}
                  className={`px-2.5 py-1 rounded-control bg-accent text-on-accent text-note font-medium ${FOCUS_RING}`}
                >
                  Copy
                </button>
              )}
              <span role="status" className="text-note text-muted">{copied}</span>
              {facts && <span className="text-note text-dim ml-auto">{facts}</span>}
            </div>
          )}
        </div>
        <div className="flex-1 overflow-y-auto p-4">{body}</div>
      </div>
    </div>
  )
}
