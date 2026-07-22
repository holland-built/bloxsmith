export async function authFetch(url, opts = {}) {
  let token = null
  try {
    token = typeof localStorage !== 'undefined' ? localStorage.getItem('dashToken') : null
  } catch (e) {
    token = null
  }
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) }
  if (token) headers['X-Auth-Token'] = token
  try {
    const r = await fetch(url, { ...opts, headers })
    const data = await r.json().catch(() => null)
    const tokenRequired = r.status === 401 || r.status === 403
    return { status: r.status, ok: r.ok, data, tokenRequired }
  } catch (e) {
    return { status: 0, ok: false, data: { error: 'network error' }, tokenRequired: false }
  }
}
