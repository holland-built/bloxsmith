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

export async function authFetch(url, opts = {}) {
  const token = dashToken()
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) }
  if (token) headers['X-Auth-Token'] = token
  try {
    const r = await fetch(url, { ...opts, headers })
    const data = await r.json().catch(() => null)
    const tokenRequired = r.status === 401 || r.status === 403
    return { status: r.status, ok: r.ok, data, tokenRequired }
  } catch {
    return { status: 0, ok: false, data: { error: 'network error' }, tokenRequired: false }
  }
}
