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

// How hard a reasoning model thinks before it answers, sent as
// reasoning_effort. Default sends nothing, so the provider decides. Which
// values a model takes varies, so Test sends the choice and fails on a refusal.
const EFFORTS = [
  ['', 'Default (the provider decides)'],
  ['none', 'None'],
  ['minimal', 'Minimal'],
  ['low', 'Low'],
  ['medium', 'Medium'],
  ['high', 'High'],
  ['xhigh', 'Extra high'],
]
const isClaude = (base) => /(^|\.)anthropic\.com/i.test((() => { try { return new URL(base).hostname } catch { return '' } })())

export default function AiProviderForm({ llm, inContainer, idPrefix, onSaved }) {
  // Address and model are settings, shown as stored; the key is a secret,
  // never returned by the server and never prefilled.
  const [ai, setAi] = useState({ base: '', model: '', effort: '', key: '', busy: false, msg: '', err: '', loaded: false })
  // The provider's own model names, filled by "Find models". With the key box
  // empty the server uses the saved key, and only at the saved address.
  const [models, setModels] = useState([])
  const [hasKey, setHasKey] = useState(false)
  // Filled once, so a status reload cannot overwrite what is being typed.
  useEffect(() => {
    if (!llm) return
    setHasKey(!!llm.hasKey)
    setAi((a) => (a.loaded ? a : { ...a, base: llm.base_url || '', model: llm.model || '', effort: llm.effort || '', loaded: true }))
  }, [llm])

  // With the key box empty, Test and Save use the saved key, and the server
  // keeps it at its own address: a different provider needs its own key
  // (vault.LLMTest and vault.SetLLMEffort both refuse otherwise).
  const body = () => ({ key: ai.key, base_url: ai.base.trim(), model: ai.model.trim(), effort: ai.effort })
  const findModels = async () => {
    setAi((a) => ({ ...a, busy: true, err: '', msg: '' }))
    const { ok, data } = await vpost('/api/vault/llm-models', { key: ai.key, base_url: ai.base.trim() })
    if (ok && data.ok && data.models?.length) {
      setModels(data.models)
      setAi((a) => ({ ...a, busy: false, msg: `Found ${data.models.length} models. Pick one from the list.` }))
      return
    }
    setModels([])
    setAi((a) => ({ ...a, busy: false, err: ok && data.ok ? 'The provider listed no models. Type the model name instead.' : 'Could not get the list. Check the key and the address, or type the model name.' }))
  }
  const test = async () => {
    setAi((a) => ({ ...a, busy: true, err: '', msg: '' }))
    const { ok, data } = await vpost('/api/vault/llm-test', body())
    setAi((a) => ok && data.ok
      ? { ...a, busy: false, msg: `It answered (model ${data.model}).${ai.effort && isClaude(ai.base) ? ' Claude ignores the effort setting.' : ''} Save to use it.` }
      : { ...a, busy: false, err: data.error === 'LLM test failed' ? 'No answer. Check the key, the address and the model name.'
        : /stored credential/.test(data.error || '') ? 'This is a different provider than the saved one. Paste its API key to test.'
        : data.error || 'The test did not run.' })
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
    setAi((a) => ({ ...a, busy: false, err: data.error === 'locked' ? 'The vault is locked — unlock it first.'
      : data.error === 'new address needs its key' ? 'This is a different provider than the saved one. Paste its API key to save.'
      : data.error || 'Could not save.' }))
  }

  return (
    <div className="rounded-control border border-border bg-field p-3">
      <div className="flex flex-wrap gap-2 mb-2" role="group" aria-label="Pick a provider">
        {presets(inContainer).map((p) => (
          <button key={p.label} type="button" className={miniBtn}
            onClick={() => { setModels([]); setAi((a) => ({ ...a, base: p.base, model: p.model, msg: '', err: '' })) }}>{p.label}</button>
        ))}
      </div>
      <label htmlFor={`${idPrefix}-base`} className="block text-note text-dim mb-1">Provider address</label>
      <input id={`${idPrefix}-base`} {...MACHINE_TEXT} className={inCls} value={ai.base} placeholder="empty = Groq"
        onChange={(e) => { setModels([]); setAi((a) => ({ ...a, base: e.target.value, msg: '', err: '' })) }} />
      <div className="flex items-end justify-between gap-2 mt-2 mb-1">
        <label htmlFor={`${idPrefix}-model`} className="block text-note text-dim">Model</label>
        <button type="button" className={`${miniBtn} disabled:opacity-50`} onClick={findModels} disabled={ai.busy || !(ai.key || hasKey)}
          title={ai.key || hasKey ? undefined : 'Paste the API key first'}>Find models</button>
      </div>
      {models.length > 0 && (
        <select aria-label="Models this provider offers" className={`${inCls} mb-1.5`} value={models.includes(ai.model) ? ai.model : ''}
          onChange={(e) => setAi((a) => ({ ...a, model: e.target.value, msg: '', err: '' }))}>
          <option value="" disabled>Pick from {models.length} models</option>
          {models.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
      )}
      <input id={`${idPrefix}-model`} {...MACHINE_TEXT} className={inCls} value={ai.model} placeholder="empty = the app's default"
        onChange={(e) => setAi((a) => ({ ...a, model: e.target.value, msg: '', err: '' }))} />
      <label htmlFor={`${idPrefix}-effort`} className="block text-note text-dim mt-2 mb-1">Effort</label>
      <select id={`${idPrefix}-effort`} className={inCls} value={ai.effort}
        onChange={(e) => setAi((a) => ({ ...a, effort: e.target.value, msg: '', err: '' }))}>
        {EFFORTS.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
      </select>
      <div className="text-note text-dim mt-1">How long the model thinks before answering. Higher is slower and uses more of the daily allowance. Not every model takes every level, so Test before saving. Claude ignores it.</div>
      <label htmlFor={`${idPrefix}-key`} className="block text-note text-dim mt-2 mb-1">API key</label>
      <input id={`${idPrefix}-key`} className={inCls} type="password" {...API_KEY_BOX} value={ai.key}
        placeholder={hasKey ? 'a key is saved — leave empty to keep it' : 'paste key (Ollama: any word)'}
        onChange={(e) => setAi((a) => ({ ...a, key: e.target.value, msg: '', err: '' }))} />
      <div className="text-note text-dim mt-1.5">Encrypted in the vault. Test before saving; saving replaces the current key, address, model and effort.</div>
      {ai.err && <div role="alert" className="mt-2 text-note text-crit">{ai.err}</div>}
      {ai.msg && <div role="status" className="mt-2 text-note text-ok">{ai.msg}</div>}
      <div className="flex gap-2 mt-2">
        <button className="px-2.5 py-1.5 rounded-control border border-border text-copy text-field-txt disabled:opacity-50" onClick={test} disabled={ai.busy || !(ai.key || hasKey)}>
          {ai.busy ? 'Working…' : 'Test'}
        </button>
        <button className="flex-1 px-2.5 py-1.5 rounded-control bg-accent border border-accent text-on-accent text-copy disabled:opacity-50" onClick={save} disabled={ai.busy || !(ai.key || hasKey)}>
          Save AI provider
        </button>
      </div>
    </div>
  )
}
