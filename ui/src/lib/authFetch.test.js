// The dashboard token goes only to this page's own origin.
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { tokenFetch, withToken } from './authFetch.js'

const saved = {}
let sent

beforeEach(() => {
  for (const k of ['location', 'localStorage', 'fetch']) saved[k] = Object.getOwnPropertyDescriptor(globalThis, k)
  const define = (k, v) => Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true })
  define('location', new URL('http://localhost:8090/#incidents'))
  define('localStorage', { getItem: (k) => (k === 'dashToken' ? 's3cret' : null) })
  sent = []
  define('fetch', async (url, opts = {}) => { sent.push({ url, headers: opts.headers || {} }); return new Response('{}') })
})

afterEach(() => {
  for (const [k, d] of Object.entries(saved)) {
    if (d) Object.defineProperty(globalThis, k, d)
    else delete globalThis[k]
  }
})

test('a relative /api/ URL gets the token header', async () => {
  await tokenFetch('/api/x', { method: 'POST', headers: { 'Content-Type': 'application/json' } })
  assert.equal(sent[0].headers['X-Auth-Token'], 's3cret')
  assert.equal(sent[0].headers['Content-Type'], 'application/json')
})

test('a same-origin absolute URL gets the token header', async () => {
  await tokenFetch('http://localhost:8090/api/x', { method: 'POST' })
  assert.equal(sent[0].headers['X-Auth-Token'], 's3cret')
})

test('another origin never gets the token header', async () => {
  await tokenFetch('https://other.example/api/x', { method: 'POST', headers: { 'Content-Type': 'application/json' } })
  assert.equal(sent[0].headers['X-Auth-Token'], undefined)
  assert.equal(sent[0].headers['Content-Type'], 'application/json')
  // Same host on another port is another origin too.
  await tokenFetch('http://localhost:9999/api/x', { method: 'POST' })
  assert.equal(sent[1].headers['X-Auth-Token'], undefined)
})

test('withToken adds ?token= only for this origin', () => {
  assert.equal(withToken('/api/s/stream?dry=1'), '/api/s/stream?dry=1&token=s3cret')
  assert.equal(withToken('http://localhost:8090/api/s'), 'http://localhost:8090/api/s?token=s3cret')
  assert.equal(withToken('https://other.example/api/s'), 'https://other.example/api/s')
})
