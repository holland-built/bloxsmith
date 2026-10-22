import { useCallback, useEffect, useState } from 'react'
import SavedChart from './SavedChart.jsx'
import { loadSavedCharts } from '../lib/savedCharts.js'

// Kept apart from SavedChart.jsx so that file exports only components (fast
// refresh, and oxlint --deny-warnings in CI).

/**
 * The saved charts for one page, as panels to put inside its CardGrid. They
 * have to be the grid's own children for Arrange panels to see them, which is
 * why this hands back elements rather than rendering a wrapper.
 */
export function useSavedChartPanels(tab) {
  const [charts, setCharts] = useState([])
  const reload = useCallback(() => {
    let live = true
    loadSavedCharts(tab).then((c) => live && setCharts(c))
    return () => { live = false }
  }, [tab])
  useEffect(reload, [reload])
  return charts.map((c) => <SavedChart key={c.id} panelId={`saved-${c.id}`} chart={c} onRemoved={reload} />)
}
