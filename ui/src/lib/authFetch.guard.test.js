// Guard: no write leaves the UI without the dashboard token.
//
// The server refuses every POST/PUT/PATCH/DELETE to /api/ without X-Auth-Token
// once DASHBOARD_TOKEN is set (httpx.WriteGuard). About twenty writes once used
// bare fetch(), so they worked on a tokenless install and returned 403 on every
// token deployment. Writes go through authFetch.js (tokenFetch, authFetch,
// vpost), which adds the header. This test reads every ui/src file and fails on
// a bare fetch() that could be a write.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = fileURLToPath(new URL('..', import.meta.url))
const ALLOWED = new Set(['lib/authFetch.js'])

function sourceFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) return sourceFiles(p)
    return /\.(js|jsx|ts|tsx)$/.test(name) && !/\.test\./.test(name) ? [p] : []
  })
}

// Drops comments so prose that mentions fetch() is not read as code. A `//`
// counts only at the start of a line or after whitespace, which keeps URLs in
// strings ('http://...') intact.
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/(^|\s)\/\/.*$/gm, '$1')
}

// The argument text of the call whose "(" is at `open`, split at top-level commas.
function callArgs(src, open) {
  const args = []
  let depth = 0
  let cur = ''
  let quote = null
  for (let i = open + 1; i < src.length; i++) {
    const c = src[i]
    if (quote) {
      cur += c
      if (c === '\\') { cur += src[++i]; continue }
      if (c === quote) quote = null
      continue
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; cur += c; continue }
    if ('([{'.includes(c)) depth++
    if (')]}'.includes(c)) {
      if (depth === 0) { args.push(cur.trim()); return args }
      depth--
    }
    if (c === ',' && depth === 0) { args.push(cur.trim()); cur = ''; continue }
    cur += c
  }
  return args
}

// A second argument is safe only when it is an object literal that names no
// method other than GET/HEAD and spreads nothing in (a spread can carry one).
function writeRisk(opts) {
  if (opts === undefined || opts === '') return null
  if (!opts.startsWith('{')) return 'options passed through, so the method cannot be read'
  if (opts.includes('...')) return 'options spread in, so the method cannot be read'
  const m = opts.match(/\bmethod\b\s*(:\s*(['"`])(\w+)\2)?/)
  if (!m) return null
  if (m[3] && /^(GET|HEAD)$/i.test(m[3])) return null
  return `method ${m[3] || '(computed)'}`
}

export function findBareWrites(files = sourceFiles(SRC)) {
  const found = []
  for (const file of files) {
    const rel = relative(SRC, file).split('\\').join('/')
    if (ALLOWED.has(rel)) continue
    const src = stripComments(readFileSync(file, 'utf8'))
    const line = (i) => src.slice(0, i).split('\n').length
    for (const m of src.matchAll(/(?<![\w$])fetch\s*\(/g)) {
      const risk = writeRisk(callArgs(src, m.index + m[0].length - 1)[1])
      if (risk) found.push(`${rel}:${line(m.index)} fetch() with ${risk}`)
    }
    // fetch handed on as a value (fetchImpl = fetch) reaches writes untokened.
    for (const m of src.matchAll(/(=|[(,])\s*fetch\s*(?=[),;\n])/g)) {
      found.push(`${rel}:${line(m.index)} fetch passed as a value`)
    }
  }
  return found
}

test('every write in ui/src goes through authFetch.js, so it carries the dashboard token', () => {
  const found = findBareWrites()
  assert.deepEqual(found, [], `use tokenFetch/authFetch/vpost from lib/authFetch.js instead:\n${found.join('\n')}`)
})

test('the guard catches each form a bare write has taken', () => {
  const dir = mkdtempSync(join(tmpdir(), 'authguard-'))
  const cases = {
    'literal.jsx': "fetch('/api/x', { method: 'DELETE' })",
    'computed.jsx': "fetch(url, { method, headers: {} })",
    'passthrough.js': 'fetch(url, opts)',
    'spread.js': "fetch(url, { ...(opts || {}), cache: 'no-store' })",
    'value.js': 'export function f(fetchImpl = fetch) {}',
    'read.jsx': "fetch(u, { cache: 'no-store' }); fetch('/api/y'); fetch(u, { method: 'GET' }) // fetch(u, { method: 'POST' })",
    'helper.jsx': "authFetch('/api/x', { method: 'POST' }); tokenFetch(u, { method: 'PATCH' })",
  }
  for (const [name, body] of Object.entries(cases)) writeFileSync(join(dir, name), body)
  const found = findBareWrites(Object.keys(cases).map((n) => join(dir, n))).join('\n')
  for (const name of ['literal', 'computed', 'passthrough', 'spread', 'value']) assert.match(found, new RegExp(name))
  assert.doesNotMatch(found, /\/(read|helper)\.jsx/)
})
