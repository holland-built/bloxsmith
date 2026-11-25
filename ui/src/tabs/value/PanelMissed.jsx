import { missedNote } from './valueModel.js'

// A Value panel's one failure line, in the look every other failed list
// has (FetchError in components/ui.jsx): what failed in red, why in muted
// text, then Try again, all at body size. It used to be small grey text
// with its own retry story ("This page retries every 5 minutes"), beside
// panels that said it the shared way (GUI audit R3-A5). `what` names the
// figures, as FetchError's does.
export default function PanelMissed({ stats, what, onRetry }) {
  if (!missedNote(stats)) return null
  return (
    <div role="alert" className="text-copy mb-2 flex flex-wrap items-center gap-x-2 gap-y-1" data-panel-missed="">
      <span>
        <span className="font-semibold text-crit">{`Could not load ${what}.`}</span>
        <span className="text-muted" data-failure-reason=""> Infoblox did not answer.</span>
      </span>
      <button type="button" onClick={onRetry} className="px-2.5 py-1.5 rounded-control border border-border bg-field text-field-txt text-copy">Try again</button>
    </div>
  )
}
