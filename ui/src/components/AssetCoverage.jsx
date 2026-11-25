import { SLOW_COLD_TIMEOUT_MS, useApi } from '../lib/api.js'
import { Card, FeedUnavailable, Skeleton } from './ui.jsx'
import { HeadlineStrip } from './kit.jsx'

// Coverage gaps on the Assets tab: devices the network sources saw that a
// tool meant to know every device (Infoblox Endpoint, a security agent, an
// asset register, device management) never reported. The server works the
// counts out from one grouped read (go/internal/dashboard/assetcoverage.go).
//
// Each tile is a link to #assets?gap=<source>, which filters the list to the
// same devices the tile counted. A count the server could not trust arrives as
// null and reads "couldn't count", never as a number.

// The network sources in everyday words, with Infoblox's own name kept only
// where it already is one (GUI audit B10: "NIOS Grid" on its own meant
// nothing to the owner).
const SOURCE_WORD = {
  'DHCP Logs': 'DHCP logs',
  'NIOS Grid': 'your Infoblox servers',
  'NIOS-X Discovery': 'network discovery',
  'Network Insight': 'network discovery',
}
const sourceWord = (s) => SOURCE_WORD[s] ?? s

// "a or b", "a, b or c"
function orList(xs) {
  return xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} or ${xs[xs.length - 1]}`
}

export default function AssetCoverage({ panelId, gap }) {
  const cov = useApi('/api/csp/asset-coverage', { coldMs: SLOW_COLD_TIMEOUT_MS })
  const d = cov.data
  const unavailable = !!cov.error || d?.availability === 'error'
  const gaps = d?.gaps ?? []
  const seenBy = `seen by ${orList([...new Set((d?.network ?? []).map(sourceWord))])}`

  const items = gaps.map((g) => {
    const counted = typeof g.count === 'number'
    return {
      panelId,
      // The plain kind of tool leads ("the Infoblox agent"); the product's own
      // name follows in the note, as a hint to find it in Infoblox.
      label: g.role ? `Seen on the network, not by ${g.role === 'Infoblox agent' ? 'the' : 'a'} ${g.role}` : `Seen on the network, not in ${g.source}`,
      value: counted ? g.count.toLocaleString() : null,
      note: [g.role ? g.source : '', counted ? seenBy : "couldn't count"].filter(Boolean).join(' · '),
      tone: counted && g.count > 0 ? 'warn' : undefined,
      // The tile that is already showing goes back to every device.
      href: g.source === gap ? '#assets' : `#assets?gap=${encodeURIComponent(g.source)}`,
    }
  })

  return (
    <Card span={6} panelId={panelId} title="Coverage gaps" note="devices a tool has not reported">
      {cov.loading && !d ? (
        <Skeleton h={72} />
      ) : unavailable ? (
        <FeedUnavailable reason={d?.reason || cov.error?.message} label="Coverage gaps unavailable" onRetry={() => cov.refetch()} />
      ) : gaps.length === 0 ? (
        <p className="text-note text-muted">
          {(d?.network ?? []).length === 0
            ? 'Nothing to compare: no source here sees devices on the network (DHCP logs, your Infoblox servers or network discovery).'
            : 'Nothing to compare: no Infoblox agent (Infoblox Endpoint), security agent, asset register or device management tool sends devices to this account.'}
        </p>
      ) : (
        <>
          <HeadlineStrip label="Coverage gaps" items={items} />
          {d?.reason && <p className="text-note text-muted">{d.reason[0].toUpperCase() + d.reason.slice(1)}.</p>}
        </>
      )}
    </Card>
  )
}
