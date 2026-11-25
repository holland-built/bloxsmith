import { missedNote } from './valueModel.js'

// A Value panel's one failure sentence, with the same Try again an
// unavailable panel has (FeedUnavailable in components/ui.jsx).
export default function PanelMissed({ stats, onRetry }) {
  const note = missedNote(stats)
  if (!note) return null
  return (
    <p className="vl-note" data-panel-missed="">
      {note}{' '}
      <button type="button" onClick={onRetry} className="ml-1 px-2.5 py-1 rounded-control border border-border bg-field text-field-txt text-note">Try again</button>
    </p>
  )
}
