#!/usr/bin/env node
// Reads src/styles/tokens.light.css, inverts the lightness of each
// --color-*: #hex; declaration, and writes src/styles/tokens.dark.css.
//
// Usage: node scripts/gen-dark-tokens.mjs

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(__dirname, '../src/styles/tokens.light.css');
const OUT = path.resolve(__dirname, '../src/styles/tokens.dark.css');

const HEADER = '/* GENERATED — do not edit. Run: node scripts/gen-dark-tokens.mjs */';

function hexToRgb(hex) {
  const h = hex.replace('#', '');
  const full = h.length === 3
    ? h.split('').map((c) => c + c).join('')
    : h;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  return { r, g, b };
}

function rgbToHsl(r, g, b) {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;

  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r:
        h = (g - b) / d + (g < b ? 6 : 0);
        break;
      case g:
        h = (b - r) / d + 2;
        break;
      case b:
        h = (r - g) / d + 4;
        break;
    }
    h /= 6;
  }

  return { h, s, l };
}

function hue2rgb(p, q, t) {
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}

function hslToRgb(h, s, l) {
  let r;
  let g;
  let b;

  if (s === 0) {
    r = g = b = l;
  } else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1 / 3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1 / 3);
  }

  return {
    r: Math.round(r * 255),
    g: Math.round(g * 255),
    b: Math.round(b * 255),
  };
}

function toHex(n) {
  return n.toString(16).padStart(2, '0');
}

function rgbToHex(r, g, b) {
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function invertHexLightness(hex) {
  const { r, g, b } = hexToRgb(hex);
  const { h, s, l } = rgbToHsl(r, g, b);
  const newL = 1 - l;
  const rgb = hslToRgb(h, s, newL);
  return rgbToHex(rgb.r, rgb.g, rgb.b);
}

function parseTokens(css) {
  const tokens = [];
  const re = /(--color-[a-zA-Z0-9-]+)\s*:\s*(#[0-9a-fA-F]{3,6})\s*;/g;
  let match;
  while ((match = re.exec(css)) !== null) {
    tokens.push({ name: match[1], value: match[2] });
  }
  return tokens;
}

function main() {
  const css = readFileSync(SRC, 'utf8');
  const tokens = parseTokens(css);

  if (tokens.length === 0) {
    throw new Error(`No --color-* hex declarations found in ${SRC}`);
  }

  const lines = tokens.map(
    ({ name, value }) => `  ${name}: ${invertHexLightness(value)};`
  );

  const output =
    `${HEADER}\n\n[data-theme="dark"] {\n${lines.join('\n')}\n}\n`;

  writeFileSync(OUT, output);
  console.log(`Wrote ${OUT} (${tokens.length} tokens)`);
}

main();
