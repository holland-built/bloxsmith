// What Bloxsmith made and deleted, newest first, from the runs record
// (go/internal/runs). The caller wraps it in its own <Card> with a literal
// title, so "Arrange this page" can name the panel (arrangeNames.test.js).
// Each item still there gets Delete with its one check.
// Delete is offered only on items made on the tenant in use now: a list id
// from another tenant could name a different list here.
import { useApi } from '../lib/api.js'
import { COLORS, Empty, FetchError } from './ui.jsx'
import DeleteCheck from './DeleteCheck.jsx'
import { canDelete, KIND_WORDS, when } from '../lib/madeDelete.js'

const STATE_WORDS = { created: '', removed: 'deleted', gone: 'was already gone', failed: 'could not be deleted' }
const PAGE_WORDS = { '': 'Automate', address: 'Get an address', dns: 'Get an address', lists: 'Site lists', editor: 'Editor', delete: 'Delete' }

export default function MadeList({ sources, ro, empty = 'Nothing made here yet.' }) {
  // Every 10 seconds, so something just made on the page shows without a reload.
  const api = useApi('/api/desk/runs', { poll: 10000 })
  const tenant = api.data?.tenant
  const all = api.data?.runs ?? []
  const list = sources ? all.filter((r) => sources.includes(r.source || '')) : all
  const here = (r) => !r.tenant || r.tenant === tenant

  return (
    <>
      {list.length === 0
        ? (!api.loading && <Empty>{empty}</Empty>)
        : (
          <ul data-made-list="">
            {list.map((r) => (
              <li key={r.id} data-made-run={r.id} className="flex flex-col gap-1 px-3 py-2 border-b border-border last:border-b-0">
                <p className="text-copy font-medium text-txt">{r.title}</p>
                <p className="text-note text-muted">
                  {[when(r.created), !sources && PAGE_WORDS[r.source || ''], r.source === 'delete' && r.note, !here(r) && 'another tenant']
                    .filter(Boolean).join(', ')}
                </p>
                {r.error && <p className="text-note" style={{ color: COLORS.warn }}>{r.error}</p>}
                {r.source !== 'delete' && r.note && <p className="text-note text-muted">{r.note}</p>}
                {r.source !== 'delete' && (
                  <ul className="flex flex-col gap-1">
                    {r.objects.map((o) => (
                      <li key={o.kind + o.id} className="flex flex-wrap items-start gap-x-3 gap-y-1 text-note">
                        <span className="flex-1 min-w-[12rem] break-words">
                          {KIND_WORDS[o.kind] || o.kind}: {o.label}
                          {STATE_WORDS[o.state] ? <span className="text-muted"> ({STATE_WORDS[o.state]})</span> : null}
                        </span>
                        {o.state === 'created' && canDelete(o.kind) && here(r) && (
                          <DeleteCheck kind={o.kind} id={o.id} what={o.label} ro={ro} onDone={api.refetch} />
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        )}
      <FetchError error={api.error} stale={list.length > 0} />
    </>
  )
}
