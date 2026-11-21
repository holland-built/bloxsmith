// One number on the Value page: the figure, what it is, and any note under it.
// A number that could not be read arrives here as a word.
export default function ValueStat({ s }) {
  return (
    <div className="vl-stat" data-stat={s.key} data-state={s.state}>
      <dt>{s.label}</dt>
      <dd className={s.state === 'ok' ? 'vl-num' : 'vl-num vl-word'}>{s.text}</dd>
      {s.line && <dd className="vl-note">{s.line}</dd>}
      {s.note && <dd className="vl-note">{s.note}</dd>}
      {s.hosts?.length > 0 && (
        <dd>
          <details>
            <summary>Each server ({s.hosts.length})</summary>
            <ul>{s.hosts.map((h) => <li key={h.name}>{h.name}: {h.text}</li>)}</ul>
          </details>
        </dd>
      )}
    </div>
  )
}
