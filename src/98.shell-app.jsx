function Shell(){
  const route=useRoute();
  const tab=route.tab;
  const [org]=useState(null);        // A2 fills real org name
  const [paletteOpen,setPaletteOpen]=useState(false);
  const [aiOpen,setAiOpen]=useState(false);
  const [aiQ,setAiQ]=useState('');
  const [vaultTick,setVaultTick]=useState(0);
  const drawerRef=useRef(null);      // last-handled route-drawer signature (open-once)

  // Re-check vault status whenever any request reports it locked.
  useEffect(()=>{
    const onLocked=()=>{
      fetch('/api/vault/status',{cache:'no-store'})
        .then(r=>r.json()).then(()=>setVaultTick(t=>t+1)).catch(()=>{});
    };
    window.addEventListener('bx:vault-locked',onLocked);
    return ()=>window.removeEventListener('bx:vault-locked',onLocked);
  },[]);

  // ⌘K toggles the palette; ⌘I toggles the AI drawer.
  useEffect(()=>{
    const onKey=(e)=>{
      if((e.metaKey||e.ctrlKey)&&(e.key==='k'||e.key==='K')){
        e.preventDefault();setPaletteOpen(o=>!o);
      }
      if((e.metaKey||e.ctrlKey)&&(e.key==='i'||e.key==='I')){
        e.preventDefault();setAiOpen(o=>!o);
      }
    };
    window.addEventListener('keydown',onKey);
    return ()=>window.removeEventListener('keydown',onKey);
  },[]);

  // window 'bx:ai-open' (detail.q) → open drawer + carry query.
  useEffect(()=>{
    const on=e=>{ const q=(e&&e.detail&&e.detail.q)||''; setAiQ(q); setAiOpen(true); };
    window.addEventListener('bx:ai-open',on);
    return ()=>window.removeEventListener('bx:ai-open',on);
  },[]);

  // Legacy #ask / #search deep-link → parseHash set params.drawer; open once.
  useEffect(()=>{
    if(route.params&&route.params.drawer){
      const q=route.params.q||'';
      const sig=(route.params.drawer||'')+'|'+q;
      if(drawerRef.current!==sig){ drawerRef.current=sig; setAiQ(q); setAiOpen(true); }
    }
  },[route]);

  const Active=TAB_COMPONENTS[tab]||OverviewTab;
  const fresh=<span className="fresh-slot"/>; // A2 wires real freshness

  // Wallboard (NOC-TV) mode swaps out ALL chrome — no TopBar / nav / FilterBar. Its own
  // Esc + corner control return to the normal app. Still under the shared data/filter
  // providers (wraps in PowerProvider like the normal shell) so reused widgets work.
  if(route.wall){
    return <PowerProvider><Wallboard/></PowerProvider>;
  }

  return <PowerProvider>
    <div>
      <DemoChrome/>
      <TopBar tab={tab} org={org} fresh={fresh} onPalette={()=>setPaletteOpen(true)} onAi={()=>setAiOpen(o=>!o)} aiOpen={aiOpen}/>
      <HealthStrip/>
      <FilterBar/>
      <DeltaChip tab={tab} key={'delta-'+tab}/>
      <main className="main" key={tab}>
        <Active vaultTick={vaultTick}/>
      </main>
      <CommandPalette open={paletteOpen} onClose={()=>setPaletteOpen(false)}/>
      <AiDrawer open={aiOpen} onClose={()=>setAiOpen(false)} initialQ={aiQ}/>
      <PeekDrawer/>
      <Scratchpad/>
      <RollbackDock/>
      <Toasts/>
      <ShortcutsHelp/>
      <GhostTour/>
      <SnapshotWriter/>
      <DrawerShift aiOpen={aiOpen}/>
      <HoverDetail/>
    </div>
  </PowerProvider>;
}

/* ── ShortcutsHelp (Feature 10) — global "?" opens a focus-trapped modal listing
   every app shortcut, including the verbs shipped across this plan. Esc closes and
   returns focus to wherever it was. Plain-text rows, neutral (no color coding). ── */
const SHORTCUTS=[
  ['j  /  k','Move the row cursor down / up'],
  ['g g  /  G','Jump to the first / last row'],
  ['Enter  /  o','Open the row detail (peek)'],
  ['t','Trace the row across DHCP / DNS / Audit / Security'],
  ['p','Pin the row to the scratchpad'],
  ['x','Toggle selection on the cursor row'],
  ['y','Copy the cursor row as JSON'],
  ['/','Focus the table search'],
  ['Shift + click','Add a column to the multi-sort (header)'],
  ['Menu  /  Shift + F10','Pivot on the focused cell'],
  ['Copy as…','Copy row / selection as CSV, JSON, BQL, or Markdown'],
  ['Copy link','Copy a deep link to the current view'],
  ['⌘ K','Open the command palette'],
  ['⌘ I','Toggle the AI assistant'],
  ['Esc','Close · clear selection'],
  ['?','Show this shortcut help'],
];
function ShortcutsHelp(){
  const [open,setOpen]=useState(false);
  const dialogRef=useRef(null),returnRef=useRef(null);
  useEffect(()=>{
    const onKey=e=>{
      if(e.key!=='?'||e.metaKey||e.ctrlKey||e.altKey) return;
      const t=e.target;
      if(t&&t.closest&&t.closest('input,textarea,select,[contenteditable="true"]')) return;
      e.preventDefault();
      returnRef.current=document.activeElement;
      setOpen(true);
    };
    window.addEventListener('keydown',onKey);
    return ()=>window.removeEventListener('keydown',onKey);
  },[]);
  const close=useCallback(()=>{ setOpen(false);
    const r=returnRef.current; if(r&&r.focus){ try{r.focus();}catch(e){} } },[]);
  useEffect(()=>{ if(!open||!dialogRef.current) return;
    const f=dialogRef.current.querySelector('button'); if(f) f.focus(); },[open]);
  if(!open) return null;
  const onKeyDown=e=>{
    if(e.key==='Escape'){ e.preventDefault(); e.stopPropagation(); close(); return; }
    if(e.key==='Tab'){
      const f=dialogRef.current?Array.from(dialogRef.current.querySelectorAll('button,[href],[tabindex]:not([tabindex="-1"])')):[];
      if(!f.length) return;
      const first=f[0],last=f[f.length-1];
      if(e.shiftKey&&document.activeElement===first){ e.preventDefault(); last.focus(); }
      else if(!e.shiftKey&&document.activeElement===last){ e.preventDefault(); first.focus(); }
    }
  };
  return <div className="sc-scrim" onClick={close}>
    <div ref={dialogRef} className="sc-overlay panel" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts"
      onClick={e=>e.stopPropagation()} onKeyDown={onKeyDown}>
      <div className="sc-head">
        <h2 className="sc-title">Keyboard shortcuts</h2>
        <div className="sc-head-acts">
          <button className="btn btn-ghost" onClick={()=>{ close(); try{window.dispatchEvent(new CustomEvent('bx:tour'));}catch(e){} }}>Show tour again</button>
          <button className="btn btn-ghost" onClick={close} aria-label="Close shortcut help">Close</button>
        </div>
      </div>
      <dl className="sc-list">
        {SHORTCUTS.map(([k,d],i)=><div key={i} className="sc-row">
          <dt><span className="kbd">{k}</span></dt><dd>{d}</dd>
        </div>)}
      </dl>
    </div>
  </div>;
}

/* ── Scratchpad (slice 6) — the on-demand pin tray. A floating "Pinned (N)" badge
   appears ONLY when pins exist (no standing chrome); it toggles a focus-trapped
   overlay listing the pinned entities with per-row trace/remove + whole-tray
   export (Copy JSON / Copy text / CSV — reuses copyText + downloadCSV). State is
   the LS scratchpad, refreshed on the shared 'bx:scratch' broadcast. ── */
function Scratchpad(){
  const [items,setItems]=useState(()=>scratchList());
  const [open,setOpen]=useState(false);
  const badgeRef=useRef(null),dialogRef=useRef(null);
  useEffect(()=>{
    const on=()=>setItems(scratchList());
    window.addEventListener('bx:scratch',on);
    window.addEventListener('storage',on);   // cross-tab / reload safety
    return ()=>{ window.removeEventListener('bx:scratch',on); window.removeEventListener('storage',on); };
  },[]);
  useEffect(()=>{ if(!items.length) setOpen(false); },[items.length]);
  useEffect(()=>{ if(!open||!dialogRef.current) return;
    const f=dialogRef.current.querySelector('button'); if(f) f.focus(); },[open]);
  const close=useCallback(()=>{ setOpen(false); const b=badgeRef.current; if(b&&b.focus){ try{b.focus();}catch(_){} } },[]);
  const copyText=txt=>{ if(navigator.clipboard&&navigator.clipboard.writeText) navigator.clipboard.writeText(txt); };
  const exportCols=[{key:'kind',label:'Kind'},{key:'label',label:'Entity'},{key:'field',label:'Field'},{key:'value',label:'Value'}];
  const flatRows=()=>items.map(e=>({kind:e.kind,label:e.label,field:e.pred&&e.pred.field,value:e.pred&&e.pred.value}));
  const copyJSON=()=>{ copyText(JSON.stringify(items,null,2)); toast('Copied '+items.length+' pin'+(items.length===1?'':'s')+' as JSON','ok',{duration:1500}); };
  const copyTextList=()=>{ copyText(items.map(e=>e.label).join('\n')); toast('Copied '+items.length+' pin'+(items.length===1?'':'s'),'ok',{duration:1500}); };
  const csv=()=>{ downloadCSV('scratchpad.csv',flatRows(),exportCols); toast('Exported '+items.length+' pin'+(items.length===1?'':'s'),'ok',{duration:1500}); };
  if(!items.length&&!open) return null;
  const onKeyDown=e=>{
    if(e.key==='Escape'){ e.preventDefault(); e.stopPropagation(); close(); return; }
    if(e.key==='Tab'&&dialogRef.current){
      const f=Array.from(dialogRef.current.querySelectorAll('button,[href],[tabindex]:not([tabindex="-1"])'));
      if(!f.length) return; const first=f[0],last=f[f.length-1];
      if(e.shiftKey&&document.activeElement===first){ e.preventDefault(); last.focus(); }
      else if(!e.shiftKey&&document.activeElement===last){ e.preventDefault(); first.focus(); }
    }
  };
  return <>
    <button ref={badgeRef} className="scratch-badge" aria-haspopup="dialog" aria-expanded={open?'true':'false'}
      aria-label={'Scratchpad — '+items.length+' pinned'} onClick={()=>setOpen(o=>!o)}>
      <span className="scratch-badge-dot" aria-hidden="true"/>Pinned <span className="scratch-badge-n mono">{items.length}</span>
    </button>
    {open?<div className="scratch-scrim" onClick={close}>
      <div ref={dialogRef} className="scratch-tray panel" role="dialog" aria-modal="true" aria-label="Scratchpad"
        onClick={e=>e.stopPropagation()} onKeyDown={onKeyDown}>
        <div className="scratch-head">
          <h2 className="scratch-title">Scratchpad <span className="mono scratch-title-n">{items.length}</span></h2>
          <button className="btn btn-ghost" onClick={close} aria-label="Close scratchpad">Close</button>
        </div>
        <ul className="scratch-list">
          {items.map(e=><li key={e.key} className="scratch-item">
            <span className="scratch-kind">{e.kind}</span>
            <span className="scratch-label mono">{e.label}</span>
            <span className="scratch-item-acts">
              <button className="scratch-trace" aria-label={'Trace '+e.label+' in DHCP'}
                onClick={()=>{ close(); traceTo('network',{pred:e.pred}); }}>Trace</button>
              <button className="scratch-rm" aria-label={'Remove '+e.label+' from scratchpad'}
                onClick={()=>unpinEntity(e.key)}>✕</button>
            </span>
          </li>)}
        </ul>
        <div className="scratch-foot">
          <button className="btn" onClick={copyJSON}>Copy JSON</button>
          <button className="btn" onClick={copyTextList}>Copy text</button>
          <button className="btn" onClick={csv}>CSV</button>
          <button className="btn btn-ghost scratch-clear" onClick={()=>clearScratch()}>Clear all</button>
        </div>
      </div>
    </div>:null}
  </>;
}

/* ── Wallboard + first-run ghost tour styles (P2 slice 9) — scoped, tokens only,
   status colors stay semantic, accent is identity-only. Bigger type for the wall
   so tiles/heatmap/triage read from across a room. ── */
(function injectWallTourStyles(){
  if(document.getElementById('bx-walltour-styles')) return;
  const s=document.createElement('style');s.id='bx-walltour-styles';
  s.textContent=`
  /* Wallboard shell — full-screen, no chrome. */
  .wallboard{position:fixed;inset:0;z-index:120;display:flex;flex-direction:column;background:var(--bg);overflow:auto;font-size:15px;}
  .wall-topline{position:sticky;top:0;z-index:2;display:flex;align-items:center;justify-content:space-between;gap:16px;
    padding:10px 20px;border-bottom:1px solid var(--border);background:var(--surface);}
  .wall-brand{display:flex;align-items:center;gap:10px;min-width:0;}
  .wall-title{font-size:16px;font-weight:600;letter-spacing:-.01em;color:var(--text);white-space:nowrap;}
  .wall-views{display:flex;align-items:center;gap:6px;flex-wrap:wrap;justify-content:center;flex:1 1 auto;}
  .wall-view-dot{font-size:13px;color:var(--text-faint);padding:2px 10px;border:1px solid transparent;border-radius:var(--r-ctl);}
  .wall-view-dot.active{color:var(--text);font-weight:600;background:var(--raised);border-color:var(--border-strong);}
  .wall-ctl{display:flex;align-items:center;gap:8px;flex:0 0 auto;}
  .wall-btn{height:30px;padding:0 12px;font-size:13px;font-weight:500;color:var(--text);background:var(--raised);
    border:1px solid var(--border);border-radius:var(--r-ctl);cursor:pointer;}
  .wall-btn:hover{border-color:var(--border-strong);}
  .wall-btn:focus-visible{outline:2px solid var(--accent);outline-offset:1px;}
  .wall-main{flex:1 1 auto;padding:16px 20px 28px;}
  /* Room-legible bump for the reused Overview widgets (dense, just larger). */
  .wallboard .statstrip .v.num{font-size:26px;}
  .wallboard .statstrip .k{font-size:12px;}
  .wallboard .heatcell{width:22px;height:22px;}
  .wallboard .triage-row{font-size:14px;}
  .wallboard .health-strip{font-size:13px;}

  /* First-run ghost tour — non-modal corner callout, never blocks the app. */
  .tour-callout{position:fixed;right:20px;bottom:20px;z-index:90;width:340px;max-width:calc(100vw - 40px);
    background:var(--surface);border:1px solid var(--border-strong);border-radius:var(--r-panel);
    box-shadow:0 12px 34px rgba(0,0,0,.34);padding:14px 16px;color:var(--text);}
  .tour-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:10px;}
  .tour-eyebrow{font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:var(--text-faint);}
  .tour-x{height:24px;padding:0 8px;font-size:11px;color:var(--text-dim);background:transparent;
    border:1px solid var(--border);border-radius:var(--r-ctl);cursor:pointer;}
  .tour-x:hover{border-color:var(--border-strong);color:var(--text);}
  .tour-x:focus-visible{outline:2px solid var(--accent);outline-offset:1px;}
  .tour-steps{list-style:none;margin:0 0 10px;padding:0;display:flex;flex-direction:column;gap:2px;}
  .tour-step{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--text-faint);padding:2px 0;}
  .tour-step.active{color:var(--text);font-weight:600;}
  .tour-step-dot{font-size:10px;color:var(--text-faint);}
  .tour-step.active .tour-step-dot{color:var(--accent);}
  .tour-body{border-top:1px solid var(--border);padding-top:10px;}
  .tour-title{margin:0 0 4px;font-size:14px;font-weight:600;color:var(--text);display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
  .tour-key{font-size:11px;color:var(--text-dim);background:var(--raised);border:1px solid var(--border);border-radius:4px;padding:1px 6px;}
  .tour-desc{margin:0;font-size:12px;line-height:1.5;color:var(--text-dim);}
  .tour-foot{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:12px;}
  .tour-count{font-size:11px;color:var(--text-faint);}
  .tour-acts{display:flex;gap:6px;}
  .sc-head-acts{display:flex;align-items:center;gap:8px;}
  `;
  document.head.appendChild(s);
})();

/* Wallboard (NOC-TV) — reuses the existing HealthStrip (health tiles) + the tab bodies
   (Overview carries the capacity heatmap, worst-offenders/top-consumers, and triage
   queue). No new data path. Optional auto-rotation cycles a couple of views every ~30s,
   pausable, and disabled entirely under reduced-motion. Esc / the corner Exit control
   return to the app. Zero-interaction by design. */
function Wallboard(){
  const [view,setView]=useState(0);
  const [paused,setPaused]=useState(false);
  const exitRef=useRef(null);
  const VIEWS=WALL_VIEWS;
  // Esc exits back to the normal app.
  useEffect(()=>{
    const onKey=e=>{ if(e.key==='Escape'){ e.preventDefault(); exitWall(); } };
    window.addEventListener('keydown',onKey);
    return ()=>window.removeEventListener('keydown',onKey);
  },[]);
  // Auto-rotate ~30s — never under reduced-motion, never while paused.
  useEffect(()=>{
    if(paused||reduceMotion()||VIEWS.length<2) return;
    const id=setInterval(()=>setView(v=>(v+1)%VIEWS.length),30000);
    return ()=>clearInterval(id);
  },[paused,VIEWS.length]);
  useEffect(()=>{ if(exitRef.current){ try{exitRef.current.focus();}catch(e){} } },[]);
  const cur=VIEWS[view]||VIEWS[0];
  const Body=TAB_COMPONENTS[cur.tab]||OverviewTab;
  const canRotate=VIEWS.length>1 && !reduceMotion();
  return <div className="wallboard" data-wall role="region" aria-label="Wallboard — NOC display">
    <div className="wall-topline">
      <div className="wall-brand"><BrandLogo/><span className="wall-title">Bloxsmith · NOC</span></div>
      <div className="wall-views" role="group" aria-label="Wallboard views">
        {VIEWS.map((v,i)=><span key={v.tab} className={'wall-view-dot'+(i===view?' active':'')}
          aria-current={i===view?'true':undefined}>{v.label}</span>)}
      </div>
      <div className="wall-ctl">
        {canRotate?<button className="wall-btn" onClick={()=>setPaused(p=>!p)} aria-pressed={paused}
          aria-label={paused?'Resume auto-rotation':'Pause auto-rotation'}>{paused?'Paused':'Rotating'}</button>:null}
        <button ref={exitRef} className="wall-btn wall-exit" onClick={exitWall}
          aria-label="Exit wallboard mode (Esc)">Exit ✕</button>
      </div>
    </div>
    <HealthStrip/>
    <main className="wall-main" key={cur.tab}>
      <Body/>
    </main>
    <Toasts/>
    <HoverDetail/>
  </div>;
}

/* First-run ghost tour — a one-time, non-modal set of callouts pointing at the 5 power
   features. Shows once (persisted in LS bx.tourSeen), re-summonable from the "?" overlay
   via the shared 'bx:tour' event. Never modal, never traps focus, always dismissible
   (Skip / Esc). No JS motion (CSS entrance is killed globally under reduced-motion). */
const TOUR_KEY='tourSeen';
const TOUR_STEPS=[
  {id:'bql',    title:'BQL search',        key:'/',     body:'Filter any table with field:value queries — press / to focus the search, then type e.g. util>85 or state:active.'},
  {id:'palette',title:'Command palette',   key:'⌘K',    body:'Jump anywhere and run actions instantly — press ⌘K (Ctrl-K) to open the command palette.'},
  {id:'pivot',  title:'Pivot on cell',     key:'Menu',  body:'Press the Menu key (or Shift+F10) on any focused cell to pivot the whole view on that value.'},
  {id:'compare',title:'Compare snapshots', key:'',      body:'Every tab keeps a day-over-day snapshot — the delta chip shows what changed since your last visit, worst-first.'},
  {id:'vim',    title:'Vim row-nav',       key:'j / k', body:'Drive the table from the keyboard: j / k to move the cursor, g g / G to jump, Enter to open a row.'},
];
function GhostTour(){
  const [open,setOpen]=useState(false);
  const [step,setStep]=useState(0);
  // Auto-open once on first run.
  useEffect(()=>{
    if(!LS.get(TOUR_KEY,false)){ const t=setTimeout(()=>setOpen(true),400); return ()=>clearTimeout(t); }
  },[]);
  // Re-summon from the "?" overlay (or anywhere) via a broadcast.
  useEffect(()=>{
    const on=()=>{ setStep(0); setOpen(true); };
    window.addEventListener('bx:tour',on);
    return ()=>window.removeEventListener('bx:tour',on);
  },[]);
  const dismiss=useCallback(()=>{ setOpen(false); LS.set(TOUR_KEY,true); },[]);
  // Keyboard-dismissible: Esc closes + persists. Non-modal — no focus trap.
  useEffect(()=>{
    if(!open) return;
    const onKey=e=>{ if(e.key==='Escape'){ dismiss(); } };
    window.addEventListener('keydown',onKey);
    return ()=>window.removeEventListener('keydown',onKey);
  },[open,dismiss]);
  if(!open) return null;
  const s=TOUR_STEPS[step]||TOUR_STEPS[0];
  const last=step>=TOUR_STEPS.length-1;
  const next=()=>{ if(last) dismiss(); else setStep(v=>v+1); };
  const prev=()=>setStep(v=>Math.max(0,v-1));
  const onCardKey=e=>{
    if(e.key==='ArrowRight'){ e.preventDefault(); next(); }
    else if(e.key==='ArrowLeft'){ e.preventDefault(); prev(); }
  };
  return <aside className="tour-callout" role="region" aria-label="Feature tour — 5 power features" onKeyDown={onCardKey}>
    <div className="tour-head">
      <span className="tour-eyebrow">New here? 5 power features</span>
      <button className="tour-x" onClick={dismiss} aria-label="Skip the feature tour">Skip ✕</button>
    </div>
    <ol className="tour-steps">
      {TOUR_STEPS.map((t,i)=><li key={t.id} className={'tour-step'+(i===step?' active':'')}
        aria-current={i===step?'step':undefined}>
        <span className="tour-step-dot" aria-hidden="true">{i===step?'●':'○'}</span>{t.title}
      </li>)}
    </ol>
    <div className="tour-body">
      <h3 className="tour-title">{s.title}{s.key?<span className="tour-key mono">{s.key}</span>:null}</h3>
      <p className="tour-desc">{s.body}</p>
    </div>
    <div className="tour-foot">
      <span className="tour-count mono">{step+1} / {TOUR_STEPS.length}</span>
      <span className="tour-acts">
        <button className="btn btn-ghost" onClick={prev} disabled={step===0}>Back</button>
        <button className="btn" onClick={next}>{last?'Done':'Next'}</button>
      </span>
    </div>
  </aside>;
}

function App(){
  return <VaultGate><DataProvider><FilterProvider><TimeProvider><CommitProvider><Shell/></CommitProvider></TimeProvider></FilterProvider></DataProvider></VaultGate>;
}

ReactDOM.createRoot(document.getElementById('root')).render(<App/>);
