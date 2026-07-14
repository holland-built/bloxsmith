#!/usr/bin/env node
/* build_ui.js — Bloxsmith UI transform (Phase 1, Option B: precompile, no bundler).
 *
 * Reads every src/*.jsx, lowers JSX to react/jsx-runtime calls using the ALREADY-
 * VENDORED babel.min.js (@babel/standalone) — no @babel/core, no node_modules, no
 * network. Writes a flat <name>.js next to index.html for the container to serve as
 * a native ES module (resolved via vendor.importmap.json).
 *
 * Naming contract (keeps the transform dumb — Babel only touches JSX, never imports):
 *   - Source modules are FLAT in src/:  src/<name>.jsx
 *   - They import siblings by their OUTPUT name:  import {x} from './<name>.js'
 *   - Output is FLAT at repo root:  ./<name>.js   (Dockerfile COPY *.js picks it up)
 *   - react / react/jsx-runtime / react-dom/client / @astryxdesign/core resolve via
 *     the importmap — leave those bare specifiers alone.
 *
 * Usage:  node scripts/build_ui.js          # build
 *         node scripts/build_ui.js --check   # fail if any output is stale (CI gate)
 *
 * Run this before committing UI changes, and in CI before `docker build`.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const Babel = require(path.join(ROOT, 'babel.min.js'));

const CHECK = process.argv.includes('--check');
const BANNER = '/* AUTO-GENERATED from src/%s by scripts/build_ui.js — do not edit. */\n';

function transform(code, filename) {
  return Babel.transform(code, {
    filename,
    presets: [['react', { runtime: 'automatic' }]],
    // no minify: readable output stays greppable + diff-friendly in review
    retainLines: false,
  }).code;
}

function main() {
  if (!fs.existsSync(SRC)) {
    console.error('build_ui: no src/ directory — nothing to build.');
    process.exit(CHECK ? 0 : 0);
  }
  const files = fs.readdirSync(SRC).filter(f => f.endsWith('.jsx')).sort();
  if (files.length === 0) {
    console.error('build_ui: src/ has no .jsx files.');
    return;
  }
  let stale = 0, built = 0;
  for (const f of files) {
    const base = f.replace(/\.jsx$/, '.js');
    const srcPath = path.join(SRC, f);
    const outPath = path.join(ROOT, base);
    const code = BANNER.replace('%s', f) + transform(fs.readFileSync(srcPath, 'utf8'), f) + '\n';
    const prev = fs.existsSync(outPath) ? fs.readFileSync(outPath, 'utf8') : null;
    if (prev === code) continue;
    if (CHECK) {
      console.error(`STALE: ${base} does not match src/${f} — run: node scripts/build_ui.js`);
      stale++;
    } else {
      fs.writeFileSync(outPath, code);
      console.log(`built ${base}`);
      built++;
    }
  }
  if (CHECK && stale) process.exit(1);
  if (CHECK) console.log(`build_ui --check: all ${files.length} module(s) current.`);
  else console.log(`build_ui: ${built} rebuilt, ${files.length - built} unchanged.`);
}

main();
