// dashToken reads the operator's DASHBOARD_TOKEN from localStorage (set in
// TenantManager). Wrapped because localStorage throws in a sandboxed frame.
export function dashToken() {
  try {
    return typeof localStorage !== 'undefined' ? localStorage.getItem('dashToken') : null
  } catch {
    return null
  }
}

// withToken appends ?token= when a dashboard token is configured.
//
// EventSource cannot set request headers, so an SSE GET has no way to carry
// X-Auth-Token; the server's documented fallback is the ?token= query param
// (httpx.tokenQueryMatches). Without this, setting DASHBOARD_TOKEN — the
// mitigation operators are told to use — silently 403s their own provisioning
// and teardown streams. Tokenless deployments are unchanged: no token in
// localStorage, no query param, and the stream is authorized by fetch metadata.
export function withToken(url) {
  const t = dashToken()
  if (!t) return url
  return `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(t)}`
}

// tokenFetch is fetch() with the X-Auth-Token header added when a dashboard
// token is configured, and it returns the plain Response, so a caller keeps its
// own response handling. Every write (POST/PUT/PATCH/DELETE) to /api/ goes
// through httpx.WriteGuard, which on a DASHBOARD_TOKEN deployment refuses any
// write without the token (403). A bare fetch() write therefore works on a
// tokenless install and fails on exactly the deployments that set the token.
// authFetch.guard.test.js fails the build if a bare fetch() write comes back.
export function tokenFetch(url, opts = {}) {
  const token = dashToken()
  if (!token) return fetch(url, opts)
  return fetch(url, { ...opts, headers: { ...(opts.headers || {}), 'X-Auth-Token': token } })
}

// vpost POSTs JSON and always resolves {ok, data}, never throws.
export const vpost = (url, body) =>
  tokenFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .then(async (r) => ({ ok: r.ok, data: await r.json().catch(() => ({})) }))
    .catch(() => ({ ok: false, data: { error: 'network error' } }))

export async function authFetch(url, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) }
  try {
    const r = await tokenFetch(url, { ...opts, headers })
    const data = await r.json().catch(() => null)
    const tokenRequired = r.status === 401 || r.status === 403
    return { status: r.status, ok: r.ok, data, tokenRequired }
  } catch {
    return { status: 0, ok: false, data: { error: 'network error' }, tokenRequired: false }
  }
}
