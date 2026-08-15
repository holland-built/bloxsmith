import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dossierVerdict, dossierVerdictTone } from './dossierVerdict.js'

// #89: a dossier carrying only a country and a registrar printed "Clean". The
// binary `malicious ? 'Malicious' : 'Clean'` had no way to say the third thing
// a lookup can be — that nothing graded the indicator at all.

test('a graded threat is malicious', () => {
  assert.equal(dossierVerdict({ malicious: true, assessed: true, max_threat_level: 80 }), 'Malicious')
  assert.equal(dossierVerdictTone({ malicious: true, assessed: true }), 'crit')
})

test('somebody looked and found nothing is clean', () => {
  assert.equal(dossierVerdict({ malicious: false, assessed: true, max_threat_level: 0 }), 'Clean')
  assert.equal(dossierVerdictTone({ malicious: false, assessed: true }), 'ok')
})

test('nobody looked is not clean', () => {
  assert.equal(dossierVerdict({ malicious: false, assessed: false, max_threat_level: null }), 'Not assessed')
  assert.equal(dossierVerdictTone({ malicious: false, assessed: false }), 'neutral')
})

test('clean is opt-in: a payload with no assessed field cannot earn it', () => {
  // An older response still sitting in a cache must not keep the defect.
  assert.equal(dossierVerdict({ malicious: false, max_threat_level: 0 }), 'Not assessed')
  assert.equal(dossierVerdict({}), 'Not assessed')
  assert.equal(dossierVerdict(undefined), 'Not assessed')
  assert.equal(dossierVerdict(null), 'Not assessed')
})

test('a truthy-but-not-true assessed does not earn clean either', () => {
  assert.equal(dossierVerdict({ assessed: 'yes' }), 'Not assessed')
  assert.equal(dossierVerdict({ assessed: 1 }), 'Not assessed')
})

test('malicious outranks everything, including a missing assessment', () => {
  assert.equal(dossierVerdict({ malicious: true }), 'Malicious')
})

test('the neutral tone is a real token, not one borrowed from clean or malicious', () => {
  const css = readFileSync(new URL('../index.css', import.meta.url), 'utf8')
  for (const v of ['--pill-neutral-bg', '--pill-neutral-fg']) {
    // Both themes define it; two occurrences is the dark + light pair.
    const hits = css.split(v).length - 1
    assert.ok(hits >= 2, `${v} is defined ${hits} time(s); the pill needs it in both themes`)
  }
})

// A unit test of a helper cannot prove a component calls it. These read the two
// renderers' source, which is the mechanism this repo already uses for that
// question (see panelHelpValues.test.js). Stated for what it is: a source
// assertion, not a render assertion.
const RENDERERS = ['../components/DossierPage.jsx', '../components/DossierPanel.jsx']

test('both renderers import and call the shared verdict helper', () => {
  for (const rel of RENDERERS) {
    const src = readFileSync(new URL(rel, import.meta.url), 'utf8')
    assert.match(src, /from '\.\.\/lib\/dossierVerdict\.js'/, `${rel} does not import the helper`)
    assert.match(src, /dossierVerdict\(/, `${rel} imports the helper but never calls it`)
  }
})

test('neither renderer still carries the inline binary or the fabricated zero', () => {
  for (const rel of RENDERERS) {
    const src = readFileSync(new URL(rel, import.meta.url), 'utf8')
    assert.doesNotMatch(src, /\?\s*'Malicious'\s*:\s*'Clean'/, `${rel} still decides the verdict inline`)
    assert.doesNotMatch(src, /'MALICIOUS'\s*:\s*'CLEAN'/, `${rel} still decides the verdict inline`)
    assert.doesNotMatch(
      src,
      /max_threat_level\)\s*\?\?\s*'0'/,
      `${rel} still prints 0 for a level nobody reported`,
    )
  }
})
