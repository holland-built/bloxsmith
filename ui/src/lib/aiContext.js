// The last few questions and answers, sent with a new question so a follow-up
// like "which of those is fullest?" makes sense. The server keeps only the
// first 8000 characters, so this stays under that and keeps the newest turns.
export function chatContext(items) {
  const turns = []
  for (const a of items) {
    if (a.role === 'assistant' && a.text && a.question) turns.push(`Q: ${a.question}\nA: ${a.text.slice(0, 1500)}`)
  }
  const kept = []
  let size = 0
  for (const t of turns.slice(-3).reverse()) {
    if (size + t.length > 7000) break
    kept.unshift(t)
    size += t.length
  }
  return kept.length ? `Earlier in this chat:\n${kept.join('\n\n')}` : ''
}
