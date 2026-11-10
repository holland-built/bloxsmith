import { lazy, Suspense, useMemo, useState } from 'react'
import { Empty, FeedUnavailable, FIELD_CLS, Skeleton, useChartTheme } from '../components/ui.jsx'
import { MACHINE_TEXT } from '../lib/machineText.js'
import { BigNumber } from '../components/ChartView.jsx'
import { shortLabel, sideways, wideLabel } from '../lib/chartBuilder.js'
import { anyValue, findSets, firstSentence, label } from '../lib/chartAnyData.js'

// Build a chart, "other Infoblox data": any data set Infoblox lists, then one
// of its counts, a field to split by and a window. The list and each data
// set's fields come trimmed from the server (dashboard/chart_cubes.go), which
// also checks every name before a query is sent.

const CategoryBars = lazy(() => import('../charts/CategoryBars.jsx'))

const SEARCH_MAX = 200

function Select({ id, text, value, onChange, children }) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-note text-muted">{text}</label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)} className={`${FIELD_CLS} w-full`}>
        {children}
      </select>
    </div>
  )
}

export function AnyPickers({ opts, any: { list, set, fields, picks, setPicks }, onBack, cube }) {
  const [find, setFind] = useState('')
  const pick = (change) => setPicks((p) => ({ ...p, ...change }))
  const back = (
    <button type="button" onClick={onBack} className="self-start py-1.5 text-copy text-link underline">
      Back to common charts
    </button>
  )
  if (list.loading) return <div className="flex flex-col gap-3"><Skeleton h={120} />{back}</div>
  if (list.error || list.data?.status !== 'ok') {
    return (
      <div className="flex flex-col gap-3">
        <FeedUnavailable label="Could not load the list of Infoblox data" reason={list.data?.reason} />
        {back}
      </div>
    )
  }
  const cubes = list.data.cubes ?? []
  const found = findSets(cubes, find)
  const shown = found.slice(0, SEARCH_MAX)
  const chosen = cubes.find((c) => c.name === picks.cube)
  const options = chosen && !shown.includes(chosen) ? [chosen, ...shown] : shown
  const times = set?.dimensions.filter((d) => d.type === 'time') ?? []
  const splits = set?.dimensions.filter((d) => d.type !== 'time') ?? []
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <label htmlFor="chart-any-find" className="text-note text-muted">Search Infoblox data</label>
        <input
          {...MACHINE_TEXT}
          id="chart-any-find"
          type="search"
          value={find}
          onChange={(e) => setFind(e.target.value)}
          placeholder="For example: DNS, threats, DHCP"
          className={`${FIELD_CLS} w-full`}
        />
        <p className="text-note text-muted" aria-live="polite">
          {find ? `${found.length} of ${cubes.length} match` : `${cubes.length} to choose from`}
        </p>
      </div>
      <Select id="chart-any-cube" text="Data" value={picks.cube} onChange={(v) => setPicks({ cube: v })}>
        <option value="">{options.length ? 'Choose…' : 'Nothing matches'}</option>
        {options.map((c) => <option key={c.name} value={c.name}>{label(c, cube)}</option>)}
      </Select>
      {chosen?.description && <p className="text-note text-muted">{firstSentence(chosen.description)}</p>}
      {picks.cube && (fields.loading ? <Skeleton h={120} /> : !set ? (
        <FeedUnavailable label="Could not load what this data holds" reason={fields.data?.reason} />
      ) : (
        <>
          <Select id="chart-any-measure" text="What to count" value={picks.measure} onChange={(v) => pick({ measure: v })}>
            {set.measures.map((m) => <option key={m.name} value={m.name}>{label(m, cube)}</option>)}
          </Select>
          <Select id="chart-any-split" text="Split by" value={picks.split} onChange={(v) => pick({ split: v })}>
            <option value="">Nothing, one total</option>
            {splits.map((d) => <option key={d.name} value={d.name}>{label(d, cube)}</option>)}
          </Select>
          {picks.split && (
            <Select id="chart-any-top" text="How many" value={String(picks.top)} onChange={(v) => pick({ top: Number(v) })}>
              {opts.tops.map((t) => <option key={t} value={String(t)}>Top {t}</option>)}
            </Select>
          )}
          {times.length > 0 && (
            <Select id="chart-any-window" text="When" value={picks.window} onChange={(v) => pick({ window: v })}>
              {opts.windows.filter((w) => w.value).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
              <option value="all">Any time</option>
            </Select>
          )}
          {times.length > 1 && picks.window !== 'all' && (
            <Select id="chart-any-time" text="Dated by" value={picks.time} onChange={(v) => pick({ time: v })}>
              {times.map((d) => <option key={d.name} value={d.name}>{label(d, cube)}</option>)}
            </Select>
          )}
        </>
      ))}
      {back}
    </div>
  )
}

function AnyChart({ set, picks, rows, cube }) {
  const { COLORS } = useChartTheme()
  const unit = label(set.measures.find((m) => m.name === picks.measure) ?? { name: picks.measure }, cube)
  const all = useMemo(
    () => rows.map((r) => ({ name: picks.split ? String(r[picks.split] ?? '(blank)') : unit, value: anyValue(r[picks.measure]) })),
    [rows, picks, unit],
  )
  // A row without a value is left off the chart and named, never drawn as 0.
  const data = all.filter((d) => d.value !== null)
  const missing = all.filter((d) => d.value === null).map((d) => d.name)
  if (!data.length) return <Empty>Infoblox sent no value for these choices.</Empty>
  if (!picks.split) return <BigNumber label="Your" name={unit} value={data[0].value} />
  const wide = sideways(data)
  // Names too long to sit under a bar get a row each, as ChartView does.
  return (
    <Suspense fallback={<Skeleton h={220} />}>
      {missing.length > 0 && (
        <p className="text-note text-muted mb-2">No value from Infoblox for {missing.join(', ')}, so {missing.length === 1 ? 'it is' : 'they are'} left out.</p>
      )}
      <CategoryBars
        label="Your"
        data={data}
        unit={unit}
        fill={COLORS.series}
        values
        {...(wide
          ? { height: Math.max(160, data.length * 26 + 8), tickFormat: wideLabel, horizontal: true }
          : { height: 220, minTickGap: 8, tickFormat: shortLabel })}
      />
    </Suspense>
  )
}

/** The chart panel's body. */
export function AnyResult({ any: { set, picks, result }, cube }) {
  const status = result.data?.status
  if (!set) return <Empty>Choose the data to chart.</Empty>
  if (result.loading) return <Skeleton h={220} />
  if (result.error || status === 'error') return <FeedUnavailable label="This chart could not be drawn" reason={result.data?.reason} />
  if (status === 'empty') return <Empty>Infoblox has nothing to count for these choices.</Empty>
  return <AnyChart set={set} picks={picks} rows={result.data?.rows ?? []} cube={cube} />
}

/** The "How this chart was made" panel's body. */
export function AnyHow({ any: { set, result } }) {
  if (!result.data?.query) return result.loading && set ? <Skeleton h={120} /> : <Empty>No query has run yet.</Empty>
  return (
    <div className="flex flex-col gap-4">
      <p className="text-note text-muted">
        Sent to <code>{result.data.endpoint}</code> on your Infoblox account. No AI was used.
      </p>
      <details>
        <summary className="text-note font-semibold cursor-pointer select-none">The query as sent</summary>
        <pre className="text-note bg-field border border-border rounded-control p-2 mt-2 overflow-x-auto">
          {JSON.stringify(result.data.query, null, 2)}
        </pre>
      </details>
    </div>
  )
}
