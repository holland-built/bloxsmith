/* ─────────────────────────────────────────────────────────────
   First-run wizard — the one-time front door for a fresh Bloxsmith
   instance. Self-gating: shows ONLY when this is genuinely first-run
   (never seen AND the shared data feed is empty AND not already in
   demo mode). Two doors: connect a real CSP tenant (guides the user
   to the existing account-menu vault flow) or load demo data (flips
   the persistent DEMO banner + lands on Provision). Never blocks a
   populated or already-onboarded instance.
   ───────────────────────────────────────────────────────────── */
const WIZARD_KEY='wizardSeen';

function FirstRunWizard(){
  const data=useData();
  const [dismissed,setDismissed]=useState(()=>!!LS.get(WIZARD_KEY,false));
  const dialogRef=useRef(null);
  const firstBtnRef=useRef(null);

  const dismiss=useCallback(()=>{ LS.set(WIZARD_KEY,true); setDismissed(true); },[]);

  // Emptiness of the shared feed (a fresh/unconnected instance has no records).
  const d=data.data||{};
  const subnets=Array.isArray(d.subnets)?d.subnets:[];
  const hosts=Array.isArray(d.hosts)?d.hosts:[];
  const zones=Array.isArray(d.zones)?d.zones:[];
  const empty=subnets.length===0 && hosts.length===0 && zones.length===0;
  const stillLoading=data.loading&&!data.data;
  const open = !dismissed && empty && !isDemoMode() && !stillLoading;

  // Esc = skip. Non-negotiable dismissal path; only wired while open.
  useEffect(()=>{
    if(!open) return;
    const onKey=e=>{ if(e.key==='Escape'){ e.preventDefault(); dismiss(); } };
    window.addEventListener('keydown',onKey);
    return ()=>window.removeEventListener('keydown',onKey);
  },[open,dismiss]);

  // Focus the first card button on mount so the wizard is keyboard-driveable.
  useEffect(()=>{ if(open&&firstBtnRef.current){ try{firstBtnRef.current.focus();}catch(e){} } },[open]);

  if(!open) return null;

  const connectCsp=()=>{
    dismiss();
    try{ window.dispatchEvent(new CustomEvent('bx:add-tenant')); }catch(e){}
    toast('Open the account menu (top-right) to connect your tenant','ok');
  };
  const loadDemo=()=>{
    dismiss();
    setDemoMode(true);
    nav('provision');
    toast('Demo mode on — use Provision → Seed demo data to populate the sandbox','ok');
  };

  return ReactDOM.createPortal(
    <div className="wiz-scrim" onClick={dismiss}>
      <div ref={dialogRef} className="wiz-card" role="dialog" aria-modal="true"
        aria-labelledby="wiz-title" onClick={e=>e.stopPropagation()}>
        <div className="wiz-head">
          <h1 id="wiz-title" className="wiz-title">Welcome to Bloxsmith</h1>
          <p className="wiz-sub">Pick how you want to start — connect your live Infoblox tenant, or explore a safe sandbox.</p>
        </div>
        <div className="wiz-choices">
          <div className="wiz-choice">
            <h2 className="wiz-choice-title">Connect your CSP tenant</h2>
            <p className="wiz-choice-sub">Point Bloxsmith at your Infoblox tenant to see and manage live data.</p>
            <button ref={firstBtnRef} type="button" className="btn btn-accent wiz-btn" onClick={connectCsp}>Connect CSP</button>
          </div>
          <div className="wiz-choice">
            <h2 className="wiz-choice-title">Load demo data</h2>
            <p className="wiz-choice-sub">Explore a realistic sandbox — nothing you do touches a real tenant.</p>
            <button type="button" className="btn wiz-btn" onClick={loadDemo}>Load demo data</button>
          </div>
        </div>
        <div className="wiz-foot">
          <button type="button" className="wiz-skip" onClick={dismiss}>Skip for now</button>
        </div>
      </div>
    </div>, document.body);
}

/* styles — injected once at module eval (mirrors src/15.mutations.jsx), tokens only */
(function(){
  if(typeof document==='undefined') return;
  if(document.getElementById('bx-wizard-styles')) return;
  const css=`
  .wiz-scrim{position:fixed;inset:0;z-index:130;background:var(--scrim);display:flex;
    align-items:center;justify-content:center;padding:24px;}
  .wiz-card{width:min(720px,96vw);background:var(--raised);border:1px solid var(--border-strong);
    border-radius:var(--r-panel);padding:var(--s4);display:flex;flex-direction:column;gap:var(--s4);
    box-shadow:0 16px 48px rgba(0,0,0,.5);}
  .wiz-head{display:flex;flex-direction:column;gap:6px;text-align:center;}
  .wiz-title{margin:0;font-size:var(--t20,20px);font-weight:700;letter-spacing:-.01em;color:var(--text);}
  .wiz-sub{margin:0;font-size:var(--t13,13px);color:var(--text-dim);}
  .wiz-choices{display:flex;gap:var(--s3);flex-wrap:wrap;}
  .wiz-choice{flex:1 1 260px;display:flex;flex-direction:column;gap:8px;background:var(--bg);
    border:1px solid var(--border);border-radius:var(--r-panel);padding:var(--s4);}
  .wiz-choice-title{margin:0;font-size:var(--t14,14px);font-weight:600;color:var(--text);}
  .wiz-choice-sub{margin:0;flex:1 1 auto;font-size:var(--t12,12px);line-height:1.5;color:var(--text-dim);}
  .wiz-btn{margin-top:6px;align-self:flex-start;}
  .wiz-foot{display:flex;justify-content:center;}
  .wiz-skip{font-size:var(--t12,12px);color:var(--text-dim);background:none;border:none;
    cursor:pointer;text-decoration:underline;}
  .wiz-skip:hover{color:var(--text);}
  .wiz-skip:focus-visible,.wiz-btn:focus-visible{outline:2px solid var(--accent);outline-offset:1px;}
  `;
  const s=document.createElement('style');
  s.id='bx-wizard-styles';
  s.setAttribute('data-bx','wizard');
  s.textContent=css;
  document.head.appendChild(s);
})();
