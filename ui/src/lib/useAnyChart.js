import { useState } from 'react'
import { SLOW_COLD_TIMEOUT_MS, useApi } from './api.js'
import { anyUrl, settleAny } from './chartAnyData.js'

/**
 * The state of the "other Infoblox data" picker. Nothing is fetched until
 * active, so the common charts never load the catalog.
 */
export function useAnyChart(active, opts) {
  const list = useApi(active ? '/api/chart/cubes' : null, { coldMs: SLOW_COLD_TIMEOUT_MS })
  const [raw, setPicks] = useState({ cube: '' })
  const fields = useApi(active && raw.cube ? `/api/chart/fields?${new URLSearchParams({ cube: raw.cube })}` : null, { coldMs: SLOW_COLD_TIMEOUT_MS })
  const set = fields.data?.status === 'ok' && fields.data.cube?.name === raw.cube ? fields.data.cube : null
  const picks = settleAny(set, raw, opts.tops)
  const result = useApi(active && set && picks.measure ? anyUrl(picks) : null)
  return { list, fields, set, picks, setPicks, result }
}
