import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { sectionFor, slugify } from './markdown.js'

// Each page's Help button looks up the section of docs/TABS.md whose heading
// matches the page's name in App.jsx. Renaming a page without its heading
// makes Help show the whole manual instead (fix 7, 2026-11-24: "Daily report").
test('every page name in App.jsx has its own Help section', () => {
  const app = readFileSync(new URL('../App.jsx', import.meta.url), 'utf8')
  const tabs = app.slice(app.indexOf('const TABS = ['), app.indexOf('\n]', app.indexOf('const TABS = [')))
  const labels = [...tabs.matchAll(/label: '([^']+)'/g)].map((m) => m[1])
  assert.ok(labels.length > 10)
  const doc = readFileSync(new URL('../../../docs/TABS.md', import.meta.url), 'utf8')
  assert.deepEqual(labels.filter((l) => !sectionFor(doc, slugify(l))), [])
})
