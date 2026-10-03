// Run with: npm test  (node --test, no test framework dependency)
//
// ---------------------------------------------------------------------------
// THREE COLOUR ROLES, KEPT APART.
//
// Until 2026-10-03 one token, --color-accent, was the button fill, the chart
// line and the mark for "healthy". That worked while the accent was a
// near-white. It is a blue now (the owner chose Grafana's scheme), and a blue
// chart line or a blue "healthy" dot is the wrong answer for both:
//
//   --color-accent   what you click or focus
//   --color-series   a measured series: a chart line, a bar that is not a state
//   --color-ok       a state: healthy, valid, allowed
//
// tests/contrast.spec.ts measures the palette. It cannot see which token a call
// site reaches for, so a chart could go back to the accent tomorrow and stay
// green there. This file is that other half.
//
// It also pins the one thing the audit of 2026-10-03 found the palette itself
// doing wrong: the ok pill was grey in dark theme and blue in light, so the
// same word changed colour with the theme.
// ---------------------------------------------------------------------------

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const css = fs.readFileSync(path.join(SRC, 'index.css'), 'utf8')

// The dark values live in @theme and the first :root block; the light ones in
// the [data-theme="light"] block.
const lightStart = css.indexOf(':root[data-theme="light"] {')
const lightEnd = css.indexOf('\n}', lightStart)
const light = css.slice(lightStart, lightEnd)
const dark = css.slice(0, lightStart)

const value = (block, token) => {
  const m = block.match(new RegExp(`${token}:\\s*(#[0-9a-fA-F]{6})\\s*;`))
  return m ? m[1] : null
}

function hue(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
  const max = Math.max(r, g, b)
  const d = max - Math.min(r, g, b)
  if (d === 0) return null
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  return (h * 60 + 360) % 360
}
const isGreen = (hex) => {
  const h = hue(hex)
  return h !== null && h >= 90 && h <= 170
}

test('the series colour exists in both themes', () => {
  assert.ok(lightStart > 0, 'could not find the light theme block in index.css')
  assert.ok(value(dark, '--color-series'), 'dark theme has no --color-series')
  assert.ok(value(light, '--color-series'), 'light theme has no --color-series')
})

test('the ok pill is green in both themes', () => {
  for (const [name, block] of [['dark', dark], ['light', light]]) {
    for (const token of ['--pill-ok-bg', '--pill-ok-fg']) {
      const v = value(block, token)
      assert.ok(v, `${name} theme has no ${token}`)
      assert.ok(isGreen(v), `${name} ${token} is ${v}, which is not a green`)
    }
  }
})

function jsxFiles(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) jsxFiles(p, out)
    else if (e.name.endsWith('.jsx')) out.push(p)
  }
  return out
}

test('no chart is drawn in the button colour', () => {
  const files = jsxFiles(SRC)
  assert.ok(files.length > 20, `expected to scan >20 .jsx files, scanned ${files.length}`)
  // The props a chart component takes its series colour through. Not
  // `allowedColor`: the cap on the threat-feed bars is the events that were
  // let through, which the help copy calls blue, the same blue as a Low
  // severity. That is information, and the accent is the blue there is.
  const chartProp = /\b(color|fill|stroke)=\{COLORS\.accent\}/
  const bad = []
  for (const f of files) {
    fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      if (chartProp.test(line)) bad.push(`${path.relative(SRC, f)}:${i + 1}`)
    })
  }
  assert.deepEqual(bad, [], `a chart series uses COLORS.accent; use COLORS.series:\n  ${bad.join('\n  ')}`)
})

test('"healthy" is drawn in the ok colour, not the button colour', () => {
  const kit = fs.readFileSync(path.join(SRC, 'components/kit.jsx'), 'utf8')
  const ui = fs.readFileSync(path.join(SRC, 'components/ui.jsx'), 'utf8')
  assert.match(kit, /ok:\s*\{[^}]*dot:\s*'var\(--color-ok\)'/, 'StatusPill draws its ok dot in something other than --color-ok')
  assert.match(ui, /label:\s*'Healthy',\s*color:\s*'var\(--color-ok\)'/, 'utilStatus draws Healthy in something other than --color-ok')
})
