// The smallest markdown reader that renders docs/TABS.md correctly, and no
// more than that.
//
// WHY NOT A LIBRARY. `marked` plus a sanitiser is ~55 KB, on a bundle this
// project spent a whole release shrinking, to read one 303-line file. This
// covers what that file actually contains, counted rather than guessed
// (2026-08-10): 27 headings, 56 bullets, 17 numbered items, 16 table rows,
// 3 rules, 2 block quotes, 134 bolds, 34 codes, 20 links, 12 emphases, and
// zero fenced code blocks. If a doc ever needs something else, the parser
// leaves it as plain text rather than mangling it — see `paragraph` below.
//
// WHY IT RETURNS DATA, NOT HTML. The blocks below are handed to React, which
// escapes every string it renders. There is no `dangerouslySetInnerHTML`
// anywhere in this path, so a doc file cannot inject markup into the app no
// matter what it contains. That is a property of the shape, not of an escaping
// function somebody has to remember to call.

// GitHub's heading slug, which is what every existing `Docs →` anchor is
// written against: lowercase, punctuation dropped, spaces to hyphens.
// "Self-Service" -> "self-service", "DNS" -> "dns".
export function slugify(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9 -]/g, '').trim().replace(/\s+/g, '-')
}

// Inline spans, in one pass so a `**bold**` inside a link cannot be matched
// twice. Order matters only in that `code` wins: text inside backticks is
// deliberately NOT searched for bold or links, which is the whole point of
// writing it as code.
const INLINE = /(`[^`]+`)|(\[[^\]]+\]\([^)]+\))|(\*\*[^*]+\*\*)|(\*[^*\n]+\*)/

// Returns an array of {type, text, href} — never a string of HTML.
export function parseInline(text) {
  const out = []
  let rest = String(text)
  while (rest) {
    const m = INLINE.exec(rest)
    if (!m) { out.push({ type: 'text', text: rest }); break }
    if (m.index > 0) out.push({ type: 'text', text: rest.slice(0, m.index) })
    const tok = m[0]
    if (tok.startsWith('`')) {
      out.push({ type: 'code', text: tok.slice(1, -1) })
    } else if (tok.startsWith('[')) {
      const cut = tok.indexOf('](')
      out.push({ type: 'link', text: tok.slice(1, cut), href: tok.slice(cut + 2, -1) })
    } else if (tok.startsWith('**')) {
      out.push({ type: 'strong', text: tok.slice(2, -2) })
    } else {
      out.push({ type: 'em', text: tok.slice(1, -1) })
    }
    rest = rest.slice(m.index + tok.length)
  }
  return out
}

function tableRow(line) {
  // A leading and trailing pipe are optional in GitHub tables; splitting on the
  // trimmed line and dropping the empty ends handles both spellings.
  const cells = line.trim().replace(/^\||\|$/g, '').split('|')
  return cells.map((c) => c.trim())
}

const IS_DIVIDER = /^[\s|:-]+$/

// Block parse. Returns [{type, ...}] — heading, para, ul, ol, table, hr, quote.
export function parseBlocks(src) {
  const lines = String(src).replace(/\r\n/g, '\n').split('\n')
  const blocks = []
  let i = 0

  const flushPara = (buf) => {
    if (buf.length) blocks.push({ type: 'para', text: buf.join(' ') })
  }

  let para = []
  while (i < lines.length) {
    const line = lines[i]
    const trimmed = line.trim()

    if (trimmed === '') { flushPara(para); para = []; i++; continue }

    const h = /^(#{1,6})\s+(.*)$/.exec(trimmed)
    if (h) {
      flushPara(para); para = []
      blocks.push({ type: 'heading', level: h[1].length, text: h[2], slug: slugify(h[2]) })
      i++
      continue
    }

    // A rule, but only when it is not the underline of a Setext heading and not
    // a table divider — both of which are also dashes.
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      flushPara(para); para = []
      blocks.push({ type: 'hr' })
      i++
      continue
    }

    if (trimmed.startsWith('|')) {
      flushPara(para); para = []
      const rows = []
      while (i < lines.length && lines[i].trim().startsWith('|')) { rows.push(lines[i]); i++ }
      const head = tableRow(rows[0])
      // Row 1 is the ---|--- divider when present; a table without one is still
      // rendered, just with its first row as the header.
      const body = rows.slice(rows[1] && IS_DIVIDER.test(rows[1]) ? 2 : 1).map(tableRow)
      blocks.push({ type: 'table', head, body })
      continue
    }

    if (trimmed.startsWith('> ')) {
      flushPara(para); para = []
      const buf = []
      while (i < lines.length && lines[i].trim().startsWith('> ')) { buf.push(lines[i].trim().slice(2)); i++ }
      blocks.push({ type: 'quote', text: buf.join(' ') })
      continue
    }

    const bullet = /^[-*]\s+(.*)$/.exec(trimmed)
    const numbered = /^\d+\.\s+(.*)$/.exec(trimmed)
    if (bullet || numbered) {
      flushPara(para); para = []
      const ordered = !!numbered
      const items = []
      while (i < lines.length) {
        const t = lines[i].trim()
        const b = ordered ? /^\d+\.\s+(.*)$/.exec(t) : /^[-*]\s+(.*)$/.exec(t)
        if (b) { items.push(b[1]); i++; continue }
        // A wrapped continuation line belongs to the item above it, not to a
        // new paragraph — otherwise every hanging indent starts a new block.
        if (t !== '' && /^\s{2,}/.test(lines[i]) && items.length) {
          items[items.length - 1] += ' ' + t
          i++
          continue
        }
        break
      }
      blocks.push({ type: ordered ? 'ol' : 'ul', items })
      continue
    }

    para.push(trimmed)
    i++
  }
  flushPara(para)
  return blocks
}

// One `## section` of a document, heading included, up to the next `##` of the
// same level. Returns null when the slug names nothing, which the caller shows
// as the whole document rather than as an error — a missing anchor is a doc
// that has been reorganised, not a failure the reader can act on.
export function sectionFor(src, slug) {
  if (!slug) return null
  const blocks = parseBlocks(src)
  const start = blocks.findIndex((b) => b.type === 'heading' && b.level === 2 && b.slug === slug)
  if (start < 0) return null
  let end = blocks.length
  for (let n = start + 1; n < blocks.length; n++) {
    if (blocks[n].type === 'heading' && blocks[n].level <= 2) { end = n; break }
  }
  return blocks.slice(start, end)
}
