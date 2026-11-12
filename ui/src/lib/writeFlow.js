import { useRef, useState } from 'react'
import { tokenFetch } from './authFetch.js'

// Shared Preview -> Apply driver for both cards. Preview posts with dry:true so
// the server does the validating; apply re-posts the same body with dry:false.
// Every field setter goes through markStale, so a preview can never outlive the
// inputs that produced it.
export function useWriteFlow(url) {
  const [status, setStatus] = useState('idle')
  const [stale, setStale] = useState(false)
  const [preview, setPreview] = useState(null)
  // The whole preview answer, for notes the preview body does not carry.
  const [previewReply, setPreviewReply] = useState(null)
  const [message, setMessage] = useState(null)
  const [error, setError] = useState(null)
  // An edit made while Preview is still loading must leave that preview stale,
  // or Apply would send fields the preview never checked.
  const editedWhileBusy = useRef(false)

  function markStale() {
    if (status === 'previewed') setStale(true)
    if (status === 'busy') editedWhileBusy.current = true
  }

  function post(body, dry) {
    editedWhileBusy.current = false
    setStatus('busy')
    setError(null)
    setMessage(null)
    return tokenFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, dry }),
    })
      .then(async (r) => {
        const j = await r.json().catch(() => ({}))
        if (!r.ok || j.error || j.ok === false) {
          setError(j.error || `HTTP ${r.status}`)
          setStatus('idle')
          setPreview(null)
          return null
        }
        return j
      })
      .catch((e) => {
        setError(String(e?.message || e))
        setStatus('idle')
        setPreview(null)
        return null
      })
  }

  function runPreview(body, applyVerb) {
    post(body, true).then((j) => {
      if (!j) return
      // Allocate answers with addresses (and, with a DNS name, the record it
      // would make); the addresses are what it takes, so they lead.
      setPreview(j.addresses || j.record || j)
      setPreviewReply(j)
      setStale(editedWhileBusy.current)
      setStatus('previewed')
      setMessage(`Preview only — nothing has been committed. Review it, then ${applyVerb}.`)
    })
  }

  function runApply(body, doneMsg) {
    post(body, false).then((j) => {
      if (!j) return
      setPreview(null)
      setStale(false)
      setStatus('applied')
      setMessage(doneMsg(j))
    })
  }

  return { status, stale, preview, previewReply, message, error, markStale, runPreview, runApply }
}
