import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DIR = path.dirname(fileURLToPath(import.meta.url))
const SOURCES = JSON.parse(fs.readFileSync(path.join(DIR, 'panelSources.json'), 'utf8'))

// The ⓘ sheet names the panel; it must use the title the page shows.
test("Automate's list is named Made here in the panel sources, as on the page", () => {
  const automate = fs.readFileSync(path.join(DIR, '../tabs/Automate.jsx'), 'utf8')
  const title = automate.match(/panelId="automate-recent" title="([^"]+)"/)[1]
  assert.equal(title, 'Made here')
  assert.equal(SOURCES.find((p) => p.id === 'automate-recent').name, title)
})
