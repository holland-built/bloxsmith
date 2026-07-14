/* ─────────────────────────────────────────────────────────────
   Phase 2 — write-path safety: one shared confirm→diff→rollback dialog,
   persistent rollback receipts, and a visible demo-mode.

   Every tenant-mutating write should flow through useCommit().confirm(descriptor)
   so the operator sees, in ONE decisive step: which tenant (plain English), the
   blast radius (before→after glyph diff, not raw JSON), and — after — a rollback
   button that persists at the point of action (not a transient toast).

   descriptor = {
     verb, resource,                 // 'delete', 'subnet', … (labels only)
     label,                          // plain-English object name (e.g. '10.0.0.0/24')
     tenantLabel,                    // optional override; defaults to active account
     summary: [{glyph:'+'|'~'|'−', text}],   // blast-radius rows
     note,                           // optional extra caution line
     danger: bool,                   // destructive → red + typed-DELETE gate
     run: async () => ({ok, data, error}),   // performs the write
     rollback: {label, run: async()=>({ok})} | null,   // inverse; null = no undo
     doneText, errText,              // optional toast overrides
   }
   ───────────────────────────────────────────────────────────── */

const GLYPH_LABEL = {'+':'added','~':'changed','−':'removed','-':'removed'};

/* ── demo mode (LS 'mode'==='demo') — set by the first-run wizard's "load demo
   data" door; cleared only when a real tenant connects. Persistent + broadcast so
   the whole session stays visibly non-production. ── */
function isDemoMode(){ return LS.get('mode', null) === 'demo'; }
function setDemoMode(on){ LS.set('mode', on ? 'demo' : null); window.dispatchEvent(new CustomEvent('bx:mode')); }
function useDemoMode(){
  const [demo, setDemo] = useState(isDemoMode());
  useEffect(()=>{ const on=()=>setDemo(isDemoMode()); window.addEventListener('bx:mode', on);
    return ()=>window.removeEventListener('bx:mode', on); }, []);
  return demo;
}

/* ── rollback receipts — persisted so undo survives navigation (not just a toast) ── */
const RCPT_KEY='receipts';
let _rcptSeq=0;
function readReceipts(){ const v=LS.get(RCPT_KEY, []); return Array.isArray(v) ? v : []; }
function writeReceipts(l){ LS.set(RCPT_KEY, l.slice(0,50)); window.dispatchEvent(new CustomEvent('bx:receipts')); }
function pushReceipt(r){ writeReceipts([{...r, undone:false}, ...readReceipts()]); }
function markReceiptUndone(id){ writeReceipts(readReceipts().map(r=> r.id===id ? {...r, undone:true} : r)); }
function useReceipts(){
  const [list, setList] = useState(readReceipts());
  useEffect(()=>{ const on=()=>setList(readReceipts()); window.addEventListener('bx:receipts', on);
    return ()=>window.removeEventListener('bx:receipts', on); }, []);
  return list;
}

/* ── one shared dialog for the whole app ── */
const CommitCtx=React.createContext(null);
function useCommit(){ return React.useContext(CommitCtx) || {confirm: async()=>{ throw new Error('no CommitProvider'); }}; }

function CommitProvider({children}){
  const [desc, setDesc] = useState(null);
  const resolver = useRef(null);
  const auth = useAuth();
  const tenant = (auth && (auth.activeAcctName || auth.orgName)) || 'this tenant';

  const confirm = useCallback((d)=> new Promise((resolve, reject)=>{
    resolver.current = {resolve, reject};
    setDesc({...d, _tenant: d.tenantLabel || tenant});
  }), [tenant]);

  const close = (result)=>{ const r = resolver.current; resolver.current = null; setDesc(null);
    if(r){ result ? r.resolve(result) : r.reject(new Error('cancelled')); } };

  return <CommitCtx.Provider value={{confirm}}>
    {children}
    {desc ? <CommitDialog desc={desc} onDone={close}/> : null}
  </CommitCtx.Provider>;
}

function CommitDialog({desc, onDone}){
  const demo = useDemoMode();
  const [busy, setBusy] = useState(false);
  const [typed, setTyped] = useState('');
  const danger = !!desc.danger;
  const ready = !danger || typed.trim().toUpperCase() === 'DELETE';

  const run = async ()=>{
    if(!ready || busy) return;
    setBusy(true);
    try{
      const res = await desc.run();
      const ok = res && res.ok !== false;
      if(!ok){ toast(desc.errText || ('Write failed' + (res && res.error ? (': ' + res.error) : '')), 'crit'); setBusy(false); return; }
      if(desc.rollback){
        pushReceipt({ id: 'r' + (++_rcptSeq) + '-' + (readReceipts().length),
          verb: desc.verb, resource: desc.resource, label: desc.label || desc.resource,
          tenant: desc._tenant, undo: null, _live: true });
        // undo closure can't be JSON-persisted; keep it in-memory keyed by id
        _liveUndo[_lastReceiptId()] = desc.rollback;
      }
      toast(desc.doneText || ((desc.verb || 'change') + ' applied'), 'ok');
      onDone({ok:true, data: res && res.data});
    }catch(e){ toast('Write failed: ' + ((e && e.message) || e), 'crit'); setBusy(false); }
  };

  return ReactDOM.createPortal(
    <div className="commit-scrim" onClick={()=> !busy && onDone(null)}>
      <div className={'commit' + (danger ? ' danger' : '')} role="dialog" aria-modal="true"
        aria-label="Confirm change" onClick={e=>e.stopPropagation()}
        onKeyDown={e=>{ if(e.key === 'Escape' && !busy){ e.preventDefault(); onDone(null); } }}>
        <div className="commit-head">
          <span className={'commit-verb' + (danger ? ' danger' : '')}>{(desc.verb || 'change').toUpperCase()}</span>
          <span className="commit-res mono">{desc.label || desc.resource}</span>
        </div>
        <div className="commit-tenant">
          Writing to <b>{desc._tenant}</b>{demo ? <span className="commit-demo">DEMO</span> : null}
        </div>
        {Array.isArray(desc.summary) && desc.summary.length ?
          <div className="commit-diff" role="group" aria-label="Blast radius">
            {desc.summary.map((s,i)=>
              <div key={i} className="commit-diff-row">
                <span className="dt-diff mono"><span aria-label={GLYPH_LABEL[s.glyph] || 'changed'}>{s.glyph || '~'}</span></span>
                <span>{s.text}</span>
              </div>)}
          </div> : null}
        {desc.note ? <div className="commit-note">{desc.note}</div> : null}
        {danger ?
          <div className="commit-type">
            <label>Type <b>DELETE</b> to confirm this permanent change</label>
            <input autoFocus className="commit-in mono" value={typed} placeholder="DELETE"
              onChange={e=>setTyped(e.target.value)} onKeyDown={e=>{ if(e.key === 'Enter') run(); }}/>
          </div> : null}
        <div className="commit-actions">
          <button type="button" className="btn" disabled={busy} onClick={()=>onDone(null)}>Cancel</button>
          <button type="button" className={'btn ' + (danger ? 'btn-crit' : 'btn-accent')}
            disabled={!ready || busy} onClick={run}>{busy ? 'Working…' : (danger ? 'Delete' : 'Confirm')}</button>
        </div>
      </div>
    </div>, document.body);
}

/* undo closures live in-memory (functions can't be JSON-persisted); the receipt in
   LS survives navigation for display, the closure survives for the session. */
const _liveUndo = {};
function _lastReceiptId(){ const l = readReceipts(); return l.length ? l[0].id : null; }

/* RollbackDock — persistent, always-reachable undo for recent writes. Sits bottom-left;
   shows the newest few un-undone receipts with a real Undo button. */
function RollbackDock(){
  const list = useReceipts().filter(r=> !r.undone && _liveUndo[r.id]).slice(0, 3);
  const [busy, setBusy] = useState(null);
  if(!list.length) return null;
  const undo = async (r)=>{
    const fn = _liveUndo[r.id];
    if(!fn || busy) return;
    setBusy(r.id);
    try{
      const res = await fn.run();
      if(res && res.ok !== false){ markReceiptUndone(r.id); delete _liveUndo[r.id];
        toast('Rolled back ' + (r.label || r.resource), 'ok'); }
      else toast('Rollback failed', 'crit');
    }catch(e){ toast('Rollback failed: ' + ((e && e.message) || e), 'crit'); }
    setBusy(null);
  };
  return <div className="rollback-dock" role="region" aria-label="Undo recent changes">
    {list.map(r=>
      <div key={r.id} className="rollback-item">
        <span className="rollback-what"><b>{r.verb}</b> <span className="mono">{r.label}</span></span>
        <button type="button" className="rollback-undo" disabled={busy === r.id} onClick={()=>undo(r)}>
          {busy === r.id ? '…' : 'Undo'}</button>
      </div>)}
  </div>;
}

/* DemoChrome — unmissable, persistent all-session banner whenever demo data is loaded,
   so nobody ever mistakes a sandbox for a live tenant. */
function DemoChrome(){
  const demo = useDemoMode();
  if(!demo) return null;
  return <div className="demo-rail" role="status" aria-label="Demo mode — not a live tenant">
    <span className="demo-badge">DEMO DATA</span>
    <span className="demo-msg">Sandbox — nothing here is a live tenant.</span>
    <button type="button" className="demo-exit" onClick={()=>{ setDemoMode(false); toast('Left demo mode', 'ok'); }}>
      Exit demo</button>
  </div>;
}

/* styles — injected once at module eval (mirrors how other fragments ship scoped CSS) */
(function(){
  if(typeof document === 'undefined') return;
  const css = `
  .commit-scrim{position:fixed;inset:0;z-index:120;background:var(--scrim);display:flex;
    align-items:center;justify-content:center;padding:24px;}
  .commit{width:min(520px,94vw);background:var(--raised);border:1px solid var(--border-strong);
    border-radius:var(--r-panel);padding:var(--s4);display:flex;flex-direction:column;gap:var(--s3);
    box-shadow:0 12px 40px rgba(0,0,0,.5);}
  .commit.danger{border-color:var(--crit-tint-border);}
  .commit-head{display:flex;align-items:baseline;gap:var(--s2);}
  .commit-verb{font-size:var(--t11);font-weight:700;letter-spacing:.06em;color:var(--accent-text,var(--accent));
    border:1px solid var(--border-strong);border-radius:4px;padding:1px 6px;}
  .commit-verb.danger{color:var(--crit);border-color:var(--crit-tint-border);background:var(--crit-tint);}
  .commit-res{font-size:var(--t14);font-weight:600;color:var(--text);overflow:hidden;text-overflow:ellipsis;}
  .commit-tenant{font-size:var(--t12);color:var(--text-dim);}
  .commit-tenant b{color:var(--text);}
  .commit-demo{margin-left:6px;font-size:var(--t10,10px);font-weight:700;letter-spacing:.06em;color:var(--warn);
    border:1px solid var(--warn);border-radius:3px;padding:0 4px;}
  .commit-diff{display:flex;flex-direction:column;gap:2px;background:var(--bg);border:1px solid var(--border);
    border-radius:var(--r-ctl);padding:var(--s2) var(--s3);max-height:200px;overflow:auto;}
  .commit-diff-row{display:flex;align-items:baseline;gap:var(--s2);font-size:var(--t12);color:var(--text);}
  .commit-diff-row .dt-diff{width:16px;flex:none;}
  .commit-note{font-size:var(--t11);color:var(--text-dim);}
  .commit-type{display:flex;flex-direction:column;gap:4px;}
  .commit-type label{font-size:var(--t11);color:var(--crit);}
  .commit-in{height:34px;padding:0 var(--s3);font-size:var(--t13,13px);color:var(--text);background:var(--bg);
    border:1px solid var(--crit-tint-border);border-radius:var(--r-ctl);}
  .commit-actions{display:flex;justify-content:flex-end;gap:var(--s2);margin-top:var(--s2);}
  .btn-crit{background:var(--crit);color:#fff;border-color:var(--crit);}
  .btn-crit:disabled{opacity:.5;cursor:not-allowed;}

  .rollback-dock{position:fixed;left:12px;bottom:12px;z-index:80;display:flex;flex-direction:column;gap:6px;
    max-width:min(320px,90vw);}
  .rollback-item{display:flex;align-items:center;justify-content:space-between;gap:var(--s3);
    background:var(--raised);border:1px solid var(--border-strong);border-radius:var(--r-ctl);
    padding:6px 10px;font-size:var(--t12);color:var(--text);box-shadow:0 4px 16px rgba(0,0,0,.35);}
  .rollback-what b{text-transform:capitalize;color:var(--text-dim);font-weight:600;}
  .rollback-undo{font-size:var(--t11);color:var(--accent-text,var(--accent));background:none;border:none;
    cursor:pointer;padding:0 2px;font-weight:600;}
  .rollback-undo:disabled{opacity:.5;cursor:default;}

  .demo-rail{display:flex;align-items:center;gap:var(--s3);padding:5px var(--s4);
    background:color-mix(in srgb,var(--warn) 12%,var(--bg));border-bottom:2px solid var(--warn);
    font-size:var(--t12);color:var(--text);}
  .demo-badge{font-size:var(--t10,10px);font-weight:700;letter-spacing:.08em;color:var(--warn);
    border:1px solid var(--warn);border-radius:3px;padding:1px 6px;}
  .demo-msg{color:var(--text-dim);}
  .demo-exit{margin-left:auto;font-size:var(--t11);color:var(--text-dim);background:none;border:none;
    cursor:pointer;text-decoration:underline;}
  `;
  const s = document.createElement('style');
  s.setAttribute('data-bx','commit');
  s.textContent = css;
  document.head.appendChild(s);
})();
