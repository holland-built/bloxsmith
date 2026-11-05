import { useEffect, useRef, useState } from 'react'
import { useApi } from '../lib/api.js'
import AiProviderForm from './AiProviderForm.jsx'
import DemoSettingsForm from './DemoSettingsForm.jsx'

// "Finish setting up": the optional setup after the first Infoblox key. It
// opens once over the dashboard (VaultGate sends bx:open-setup), and
// Settings > Setup checklist opens it again. Nothing here is required, and
// every form is the same one its usual page uses, so a setting has one home.

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
const linkBtn = 'text-note font-medium text-link underline underline-offset-2'

function Item({ id, title, why, checking, done, doneText, open, onToggle, info, children }) {
  return (
    <li className="py-3 border-t border-line-2" data-setup-item={id}>
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <h3 className="text-copy font-semibold">{title}</h3>
          <p className="text-note text-muted">{why}</p>
          <p className={`text-note mt-0.5 ${done && !checking ? 'text-ok' : 'text-dim'}`} data-setup-state={checking ? 'checking' : done ? 'set' : 'not-set'}>
            {checking ? 'Checking…' : done ? `✓ ${doneText}` : 'Not set up yet'}
          </p>
        </div>
        <button type="button" className={linkBtn} aria-expanded={open} aria-controls={`setup-${id}`} onClick={onToggle}>
          {info ? (open ? 'Hide' : 'Details') : open ? 'Do this later' : done ? 'Change' : 'Set up'}
        </button>
      </div>
      {open && <div id={`setup-${id}`} className="mt-3">{children}</div>}
    </li>
  )
}

export default function SetupChecklist({ onClose, onOpenBrand, brandOpen }) {
  const panelRef = useRef(null)
  const [open, setOpen] = useState(null)
  const vault = useApi('/api/vault/status')
  const demo = useApi('/api/demo/status')
  const brand = useApi('/api/brand')
  const templates = useApi('/api/templates')

  useEffect(() => { panelRef.current?.focus() }, [])
  // The logo dialog is App's; read the brand again once it closes.
  const brandWasOpen = useRef(brandOpen)
  useEffect(() => {
    if (brandWasOpen.current && !brandOpen) brand.refetch()
    brandWasOpen.current = brandOpen
  }, [brandOpen, brand])

  const toggle = (id) => setOpen((o) => (o === id ? null : id))
  const inContainer = !!vault.data?.inContainer
  const demoReady = !!demo.data?.settings?.hasJoinToken && (demo.data?.problems || []).length === 0
  const brandName = brand.data?.name || brand.data?.domain || ''
  const sites = (Array.isArray(templates.data) ? templates.data : []).filter((t) => !t.type || t.type === 'site')
  const regions = [...new Set(sites.map((t) => String(t.name || '').split('/')[0]).filter(Boolean))]

  const onKeyDown = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); onClose(); return }
    if (e.key !== 'Tab') return
    const items = [...panelRef.current.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null)
    if (!items.length) return
    const first = items[0]
    const last = items[items.length - 1]
    const cur = document.activeElement
    if (e.shiftKey && (cur === first || cur === panelRef.current)) { e.preventDefault(); last.focus() }
    else if (!e.shiftKey && cur === last) { e.preventDefault(); first.focus() }
  }

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 px-4" onKeyDown={onKeyDown}>
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="setup-title"
        tabIndex={-1}
        data-setup-checklist=""
        className="w-[560px] max-w-full max-h-[85vh] overflow-y-auto bg-card border border-card-border rounded-surface p-5 outline-none"
      >
        <div className="flex items-center mb-1">
          <h2 id="setup-title" className="text-copy font-semibold">Finish setting up</h2>
          <span className="flex-1" />
          <button className="text-muted text-copy" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <p className="text-note text-muted mb-3">
          The dashboard works already. Everything here is optional; skip what you do not need, and
          open this again any time from Settings &gt; Setup checklist.
        </p>

        <ul>
          <Item id="ai" title="AI answers" why="Ask questions about your network in plain words on the AI tab."
            checking={!vault.data} done={!!vault.data?.llm?.hasKey} doneText="An AI provider is saved" open={open === 'ai'} onToggle={() => toggle('ai')}>
            {/* Wait for the status: in a container the Ollama button points elsewhere. */}
            {vault.data ? <AiProviderForm llm={vault.data.llm} inContainer={inContainer} idPrefix="setup-ai" onSaved={vault.refetch} />
              : <p className="text-note text-dim">Checking…</p>}
          </Item>

          <Item id="demo" title="Demo server" why="Build a NIOS-X DNS server on your Proxmox host for customer demos."
            checking={!demo.data} done={demoReady} doneText="Saved and ready" open={open === 'demo'} onToggle={() => toggle('demo')}>
            {!vault.data ? <p className="text-note text-dim">Checking…</p> : inContainer ? (
              <p className="text-note text-txt" data-setup-docker="">
                The demo server needs the desktop version of Bloxsmith. This copy runs in Docker, which cannot reach
                Proxmox or run OpenTofu. The README&rsquo;s Demo server section shows how to install the desktop version.
              </p>
            ) : (
              <DemoSettingsForm st={demo.data} onSaved={demo.refetch} />
            )}
          </Item>

          <Item id="brand" title="Logo and company name" why="Shown at the top of every page and on reports."
            checking={!brand.data} done={!!brandName} doneText={brandName} open={open === 'brand'} onToggle={() => toggle('brand')}>
            <button type="button" className="px-3 py-2 rounded-control bg-accent text-on-accent text-copy font-medium" onClick={onOpenBrand}>
              Open logo and company name
            </button>
          </Item>

          <Item id="templates" title="Site templates" why="Used to build branch offices, demo labs and whole sites."
            checking={!templates.data} done={sites.length > 0} doneText={`${sites.length} site templates installed${regions.length ? `: ${regions.join(', ')}` : ''}`}
            open={open === 'templates'} onToggle={() => toggle('templates')} info>
            <p className="text-note text-txt">
              {sites.length > 0
                ? 'Templates come with each release, so there is nothing to set up. Updating Bloxsmith brings new ones.'
                : 'None are installed. The release download and the container image include them; for a copy built from source, run scripts/fetch_templates.py.'}
            </p>
          </Item>
        </ul>

        <div className="flex justify-end mt-4">
          <button type="button" className="px-4 py-2 rounded-control bg-accent text-on-accent text-copy font-medium" onClick={onClose}>
            Finish
          </button>
        </div>
      </div>
    </div>
  )
}
