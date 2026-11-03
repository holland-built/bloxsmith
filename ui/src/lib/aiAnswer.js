// The AI answer, as blocks for the chat box in tabs/Ai.jsx.
//
// The model writes markdown (rule 12 in go/internal/ai/schema.go): a bold first
// line, a table, a couple of bullets. lib/markdown.js reads that, with one
// difference for chat. Markdown joins lines that have no blank line between
// them into one paragraph, but the model uses a single line break to mean a new
// line, as the old plain-text box showed it. So every plain line here is its
// own paragraph. Older answers wrote "• " bullets; those become "- " so they
// still show as a list.
import { parseBlocks } from './markdown.js'

const KEEP_TOGETHER = /^\s*(\||[-*]\s|\d+\.\s)/

export function answerBlocks(text) {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n')
    .map((l) => l.replace(/^(\s*)•\s*/, '$1- '))
  const out = []
  for (const l of lines) {
    out.push(l)
    if (!KEEP_TOGETHER.test(l)) out.push('')
  }
  return parseBlocks(out.join('\n'))
}
