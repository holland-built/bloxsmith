import { useEffect, useState } from 'react'
import { FIELD_CLS } from './ui.jsx'
import { API_KEY_BOX } from '../lib/secretBox.js'
import { MACHINE_TEXT } from '../lib/machineText.js'

// The AI tab's provider: one form, used in Settings > Integrations and in the
// setup checklist. Any provider that takes OpenAI-style chat requests works;
// Claude's API does, at the address below. The values for each preset are the
// ones docs/DEPLOYMENT.md lists.

const vpost = (url, body) =>
  fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .then(async (r) => ({ ok: r.ok, data: await r.json().catch(() => ({})) }))
    .catch(() => ({ ok: false, data: { error: 'network error' } }))

const inCls = `${FIELD_CLS} w-full`
const miniBtn = 'px-2 py-1 rounded-control border border-border text-note text-muted hover:text-txt hover:border-border-hover'

// Ollama runs on this computer. From inside a container, "localhost" is the
// container itself, so the preset points at the host instead.
const presets = (inContainer) => [
  { label: 'Groq (free, default)', base: '', model: '' },
  { label: 'Claude', base: 'https://api.anthropic.com/v1', model: 'claude-sonnet-5-5' },
  { label: 'Gemini', base: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-3.5-flash-lite' },
  { label: 'OpenAI', base: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  { label: 'Ollama (on this computer)', base: inContainer ? 'http://host.docker.internal:11434/v1' : 'http://localhost:11434/v1', model: 'llama3.1' },
]

export default function AiProviderForm({ llm, inContainer, idPrefix, onSaved }) {
  // Address and model are settings, shown as stored; the key is a secret,
  // never returned by the server and never prefilled.
  const [ai, setAi] = useState({ base: '', model: '', key: '', busy: false, msg: '', err: '', loaded: false })
  const [hasKey, setHasKey] = useState(false)
  // Filled once, so a status reload cannot overwrite what is being typed.
  useEffect(() => {
    if (!llm) return
    setHasKey(!!llm.hasKey)
    setAi((a) => (a.loaded ? a : { ...a, base: llm.base_url || '', model: llm.model || '', loaded: true }))
  }, [llm])

  // Test sends the typed key to the typed address, so nothing stored is sent
  // anywhere new (vault.LLMTest refuses a new address with the stored key).
  // Save needs the key too: the server stores key, address and model together,
  // so Save stays off until a key is typed and can never blank a saved one.
  const body = () => ({ key: ai.key, base_url: ai.base.trim(), model: ai.model.trim() })
  const test = async () => {
    setAi((a) => ({ ...a, busy: true, err: '', msg: '' }))
    const { ok, data } = await vpost('/api/vault/llm-test', body())
    setAi((a) => ok && data.ok
      ? { ...a, busy: false, msg: `It answered (model ${data.model}). Save to use it.` }
      : { ...a, busy: false, err: data.error === 'LLM test failed' ? 'No answer. Check the key, the address and the model name.' : data.error || 'The test did not run.' })
  }
  const save = async () => {
    setAi((a) => ({ ...a, busy: true, err: '', msg: '' }))
    const { ok, data } = await vpost('/api/vault/llm', body())
    if (ok && data.ok !== false) {
      setHasKey(true)
      setAi((a) => ({ ...a, key: '', busy: false, msg: 'Saved. The AI tab uses it from the next question.' }))
      onSaved?.()
      return
    }
    setAi((a) => ({ ...a, busy: false, err: data.error === 'locked' ? 'The vault is locked — unlock it first.' : data.error || 'Could not save.' }))
  }

  return (
    <div className="rounded-control border border-border bg-field p-3">
      <div className="flex flex-wrap gap-2 mb-2" role="group" aria-label="Pick a provider">
        {presets(inContainer).map((p) => (
          <button key={p.label} type="button" className={miniBtn}
            onClick={() => setAi((a) => ({ ...a, base: p.base, model: p.model, msg: '', err: '' }))}>{p.label}</button>
        ))}
      </div>
      <label htmlFor={`${idPrefix}-base`} className="block text-note text-dim mb-1">Provider address</label>
      <input id={`${idPrefix}-base`} {...MACHINE_TEXT} className={inCls} value={ai.base} placeholder="empty = Groq"
        onChange={(e) => setAi((a) => ({ ...a, base: e.target.value, msg: '', err: '' }))} />
      <label htmlFor={`${idPrefix}-model`} className="block text-note text-dim mt-2 mb-1">Model</label>
      <input id={`${idPrefix}-model`} {...MACHINE_TEXT} className={inCls} value={ai.model} placeholder="empty = the app's default"
        onChange={(e) => setAi((a) => ({ ...a, model: e.target.value, msg: '', err: '' }))} />
      <label htmlFor={`${idPrefix}-key`} className="block text-note text-dim mt-2 mb-1">API key</label>
      <input id={`${idPrefix}-key`} className={inCls} type="password" {...API_KEY_BOX} value={ai.key}
        placeholder={hasKey ? 'a key is saved — type a new one to change anything here' : 'paste key (Ollama: any word)'}
        onChange={(e) => setAi((a) => ({ ...a, key: e.target.value, msg: '', err: '' }))} />
      <div className="text-note text-dim mt-1.5">Encrypted in the vault. Test before saving; saving replaces the current key, address and model.</div>
      {ai.err && <div role="alert" className="mt-2 text-note text-crit">{ai.err}</div>}
      {ai.msg && <div role="status" className="mt-2 text-note text-ok">{ai.msg}</div>}
      <div className="flex gap-2 mt-2">
        <button className="px-2.5 py-1.5 rounded-control border border-border text-copy text-field-txt disabled:opacity-50" onClick={test} disabled={ai.busy || !ai.key}>
          {ai.busy ? 'Working…' : 'Test'}
        </button>
        <button className="flex-1 px-2.5 py-1.5 rounded-control bg-accent border border-accent text-on-accent text-copy disabled:opacity-50" onClick={save} disabled={ai.busy || !ai.key}>
          Save AI provider
        </button>
      </div>
    </div>
  )
}
