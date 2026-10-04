// Run with: npm test  (node --test, no test framework dependency)
//
// ---------------------------------------------------------------------------
// A TEXT BOX OR A DROPDOWN IS DRAWN WITH THE FIELD BORDER, NOT THE CONTROL ONE.
//
// A text field has nothing but its outline to say where it is: no label inside
// it, often no fill that differs from the panel behind it. WCAG 1.4.11 asks for
// 3:1 on that outline. --color-border, the hairline every button uses, is
// about 1.6:1 in both themes, and until 2026-10-04 fields used it too. The
// owner was shown three live variants (leave it, stronger on fields, stronger
// on every control) and chose the second: --color-field-border, on
// <input>, <select> and <textarea> only.
//
// tests/contrast.spec.ts measures the colour itself and every field it can
// reach on a page. It cannot reach a field inside a dialog nobody opened, or
// one somebody adds tomorrow with the old class copied from a button. This file
// is that other half: it reads the source.
// ---------------------------------------------------------------------------

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function jsxFiles(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) jsxFiles(p, out)
    else if (e.name.endsWith('.jsx')) out.push(p)
  }
  return out
}

// `border-border` as a whole class: not `border-border-hover`, and not the tail
// of `border-card-border` or `border-field-border`.
const CONTROL_BORDER = /(?<![\w-])border-border(?![\w-])/

// The opening tag of every <input>, <select> and <textarea>. Braces are
// tracked so the `=>` of a handler does not end the tag early, and a match on
// a comment line is not a tag.
function fieldTags(src) {
  const out = []
  const re = /<(input|select|textarea)\b/g
  let m
  while ((m = re.exec(src))) {
    const lineStart = src.lastIndexOf('\n', m.index) + 1
    if (/\/\/|\/\*|^\s*\*/.test(src.slice(lineStart, m.index))) continue
    let i = m.index + m[0].length
    let depth = 0
    for (; i < src.length; i++) {
      const ch = src[i]
      if (ch === '{') depth++
      else if (ch === '}') depth--
      else if (ch === '>' && depth === 0) break
    }
    out.push({ text: src.slice(m.index, i + 1), line: src.slice(0, m.index).split('\n').length })
  }
  return out
}

const files = jsxFiles(SRC)

test('the scan sees the app', () => {
  assert.ok(files.length > 20, `expected to scan >20 .jsx files, scanned ${files.length}`)
  const tags = files.flatMap((f) => fieldTags(fs.readFileSync(f, 'utf8')))
  assert.ok(tags.length > 40, `expected >40 field tags, found ${tags.length}`)
})

test('FIELD_CLS, the shared field style, uses the field border', () => {
  const ui = fs.readFileSync(path.join(SRC, 'components', 'ui.jsx'), 'utf8')
  const def = /export const FIELD_CLS = `([^`]*)`/.exec(ui)
  assert.ok(def, 'FIELD_CLS has been renamed or is no longer one template literal')
  assert.match(def[1], /(?<![\w-])border-field-border(?![\w-])/, 'FIELD_CLS does not use border-field-border')
  assert.doesNotMatch(def[1], CONTROL_BORDER, 'FIELD_CLS still carries the control border as well')
})

test('no field is drawn with the control border, by its own classes or by a local style constant', () => {
  const bad = []
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8')
    const rel = path.relative(SRC, f)
    const names = new Set()
    for (const tag of fieldTags(src)) {
      const cls = /className=(\{[^]*\}|"[^"]*")/.exec(tag.text)?.[1] ?? ''
      if (CONTROL_BORDER.test(cls)) bad.push(`${rel}:${tag.line} a field's className holds border-border`)
      // The constants a field's className names, so their definitions in this
      // file are read too: Ai.jsx kept a field style of its own for years.
      for (const id of cls.match(/\b[A-Za-z_]\w*Cls\b|\b[A-Z_]+_CLS\b/g) ?? []) names.add(id)
    }
    for (const name of names) {
      // The statement: its first line, then every indented line under it. A
      // blank line or a line at column 0 ends it.
      const def = new RegExp(`const ${name} =[ \\t]*\\n?([^\\n]*(?:\\n[ \\t]+[^\\n]*)*)`).exec(src)
      if (def && CONTROL_BORDER.test(def[1])) bad.push(`${rel}: ${name}, used by a field, holds border-border`)
    }
  }
  assert.deepEqual(bad, [], `use border-field-border on a text box or dropdown:\n  ${bad.join('\n  ')}`)
})
