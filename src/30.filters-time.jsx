const EXPLAIN={
  severity:{critical:'Critical — immediate action required',high:'High — urgent review',medium:'Medium — monitor',low:'Low — informational',info:'Informational'},
  policy_action:{block:'Blocked — request denied',blocked:'Blocked — request denied',redirect:'Redirected — sent to walled garden',log:'Logged — allowed but recorded',allow:'Allowed — permitted',allowed:'Allowed — permitted'},
  state:{active:'Active — lease currently in use',free:'Free — address available',backup:'Backup — held by failover peer',expired:'Expired — past lease end',offered:'Offered — pending client ACK'},
  status:{online:'Online — reachable',offline:'Offline — unreachable',active:'Active',inactive:'Inactive',degraded:'Degraded — partial availability'},
};
function explain(field,value){ const m=EXPLAIN[field]; if(!m||value==null) return null; return m[String(value).toLowerCase()]||null; }

function parseFilterStr(s){
  if(!s) return [];
  return String(s).split(',').map(tok=>{
    const ci=tok.indexOf(':'); if(ci<0) return null;
    const field=decodeURIComponent(tok.slice(0,ci));
    const value=decodeURIComponent(tok.slice(ci+1));
    if(!field) return null;
    return {field,value,label:(explain(field,value)?field+': '+value:field+': '+value)};
  }).filter(Boolean);
}
function serializeFilters(arr){ return (arr||[]).map(f=>encodeURIComponent(f.field)+':'+encodeURIComponent(f.value)).join(','); }
function parseFilterHash(){ const {params}=parseHash(); return parseFilterStr(params.f); }
// Range-aware cross-filter matching (Feature 9): FilterCtx filters are normally an
// exact string match (see DataTable's `active` filter below). A value shaped like
// "lo-hi" (e.g. the capacity-heatmap util bands: "90-99", "100-999999") is instead
// matched as an inclusive numeric range — same lo-hi convention the BQL range
// syntax (util:90-99) already uses elsewhere, just applied to a plain scalar
// column instead of the search box. Any non-numeric-range value falls back to the
// existing exact-match behavior untouched.
const RANGE_VALUE_RE=/^(-?\d+(?:\.\d+)?)-(-?\d+(?:\.\d+)?)$/;
function filterMatchesRow(row,f){
  const m=RANGE_VALUE_RE.exec(String(f.value));
  if(m){
    const n=Number(row[f.field]);
    if(isNaN(n)) return false;
    return n>=Number(m[1])&&n<=Number(m[2]);
  }
  return String(row[f.field])===String(f.value);
}
// Feature 7 — multi-column sort hash codec. Single-key form ("key:dir") is
// byte-identical to the pre-multi-sort format so old links / saved views still
// parse; a comma joins additional keys ("a:asc,b:desc") in priority order.
function parseSortParam(raw){
  if(!raw) return [];
  return String(raw).split(',').map(tok=>{
    const ci=tok.indexOf(':'); const key=ci>=0?tok.slice(0,ci):tok; const dir=ci>=0?tok.slice(ci+1):'asc';
    return key?{key,dir:dir==='desc'?'desc':'asc'}:null;
  }).filter(Boolean);
}
function serializeSortParam(arr){ return (arr||[]).map(s=>s.key+':'+(s.dir||'asc')).join(','); }

const FilterCtx=React.createContext(null);
const NO_FILTERS={filters:[],add(){},remove(){},toggle(){},clear(){},has(){return false;}};
function useFilters(){ return React.useContext(FilterCtx)||NO_FILTERS; }

function FilterProvider({children}){
  const [filters,setFilters]=useState(()=>parseFilterHash());
  const ref=useRef(filters); ref.current=filters;
  useEffect(()=>{
    const on=()=>{ const next=parseFilterHash();
      if(serializeFilters(next)!==serializeFilters(ref.current)) setFilters(next); };
    window.addEventListener('hashchange',on);
    return ()=>window.removeEventListener('hashchange',on);
  },[]);
  const write=useCallback(next=>{
    setFilters(next); ref.current=next;
    const {tab,params}=parseHash(); const p={...params};
    const s=serializeFilters(next); if(s) p.f=s; else delete p.f;
    nav(tab,p);
  },[]);
  const same=(f,field,value)=>f.field===field&&String(f.value)===String(value);
  const add=useCallback((field,value,label)=>{ const cur=ref.current;
    if(cur.some(f=>same(f,field,value))) return;
    write([...cur,{field,value:String(value),label:label||(field+': '+value)}]); },[write]);
  // remove(): announces the removal on the shared toast/aria-live bus (F5 facet-chip
  // removal + FilterBar's × both funnel through here — no separate confirmation UI).
  const remove=useCallback((field,value,label)=>{ const cur=ref.current;
    const existing=cur.find(f=>same(f,field,value));
    write(cur.filter(f=>!same(f,field,value)));
    if(existing) toast('Filter removed · '+(label||existing.label),'ok',{duration:1500}); },[write]);
  const toggle=useCallback((field,value,label)=>{ const cur=ref.current;
    if(cur.some(f=>same(f,field,value))) remove(field,value,label);
    else write([...cur,{field,value:String(value),label:label||(field+': '+value)}]); },[write,remove]);
  const clear=useCallback(()=>write([]),[write]);
  const has=useCallback((field,value)=>ref.current.some(f=>same(f,field,value)),[]);
  const val=useMemo(()=>({filters,add,remove,toggle,clear,has}),[filters,add,remove,toggle,clear,has]);
  return <FilterCtx.Provider value={val}>{children}</FilterCtx.Provider>;
}

/* ── Global time-range (P1 slice 5, part 1) ───────────────────────────────────
   A single app-level time window, serialized into the EXISTING view-state hash
   as `t=` (same parseHash/nav path as `f=` / `<id>.q`) so it travels with the
   shareable URL and NEVER desyncs the deep-link — the reason the earlier global
   picker was deferred. It touches ONLY the hash; snapshot keying + data-fetch
   (useSnapshots/useData) are untouched, so day-over-day deltas stay stable.

   `t=` holds one of two shapes, both round-trippable and backward-compatible
   (unset ⇒ current behavior):
     • a relative preset token  — `15m` / `1h` / `24h` / `7d`  (window = now-N…now)
     • an absolute epoch window — `<fromMs>-<toMs>`            (from capture-to-zoom)  */
const TIME_PRESETS=[
  {k:'15m',label:'15m',long:'15 minutes',ms:15*60000},
  {k:'1h', label:'1h', long:'hour',ms:3600000},
  {k:'24h',label:'24h',long:'24 hours',ms:86400000},
  {k:'7d', label:'7d', long:'7 days',ms:7*86400000},
];
/* timeWindowFor(token) → {from,to,label}|null. now-relative for presets, absolute
   for `<from>-<to>`. Returns null for unset/garbage → callers fall back to their
   own (pre-existing) domain, keeping every chart backward-compatible. */
function timeWindowFor(token){
  if(!token) return null;
  const p=TIME_PRESETS.find(p=>p.k===token);
  if(p){ const to=Date.now(); return {from:to-p.ms,to,label:p.label}; }
  const m=/^(\d+)-(\d+)$/.exec(token);
  if(m){ const from=Number(m[1]),to=Number(m[2]); if(isFinite(from)&&isFinite(to)&&to>from) return {from,to,label:'custom'}; }
  return null;
}
const TimeCtx=React.createContext(null);
const NO_TIME={token:null,window:null,setRange(){}};
function useTimeRange(){ return React.useContext(TimeCtx)||NO_TIME; }
function TimeProvider({children}){
  const [token,setToken]=useState(()=>parseHash().params.t||null);
  const ref=useRef(token); ref.current=token;
  useEffect(()=>{
    const on=()=>{ const next=parseHash().params.t||null; if(next!==ref.current) setToken(next); };
    window.addEventListener('hashchange',on);
    return ()=>window.removeEventListener('hashchange',on);
  },[]);
  // setRange mirrors to the hash the same guarded way the `f=`/`<id>.q` mirrors do.
  const setRange=useCallback(next=>{
    setToken(next); ref.current=next;
    const {tab,params}=parseHash(); const p={...params};
    if(next) p.t=next; else delete p.t;
    nav(tab,p);
  },[]);
  const win=useMemo(()=>timeWindowFor(token),[token]);
  const val=useMemo(()=>({token,window:win,setRange}),[token,win,setRange]);
  return <TimeCtx.Provider value={val}>{children}</TimeCtx.Provider>;
}

/* TimeRangeControl — TopBar dropdown of presets + reset, behind a .tr-trigger.
   Buttons (keyboard-reachable by default); the active preset is aria-current. An
   absolute zoom window marks no preset current, but the reset ("All") still
   clears it. Optional — unset = default. */
function TimeRangeControl(){
  const {token,setRange}=useTimeRange();
  const {bind}=useHoverDetail();
  const [open,setOpen]=useState(false);
  const active=TIME_PRESETS.find(p=>p.k===token);
  return <span className="timerange" role="group" aria-label="Time range" style={{position:'relative',display:'inline-flex'}}>
    <button type="button" className="kbd tr-trigger" aria-haspopup="menu" aria-expanded={open}
      {...bind({title:'Time range',rows:[['What it does','Filters every chart & table on the page to a recent window'],['Presets','Last 15m · 1h · 24h · 7d, or All for no limit']]})}
      onClick={()=>setOpen(o=>!o)}>{active?('Last '+active.label):'Time range'} ▾</button>
    {open&&<>
      <div className="views-overlay" onClick={()=>setOpen(false)}/>
      <div className="dt-popover views-menu" role="menu">
        {TIME_PRESETS.map(p=>
          <button key={p.k} type="button" className="tr-preset" data-preset={p.k}
            aria-current={token===p.k?'true':undefined}
            aria-label={'Last '+p.label}
            {...bind({title:'Time range · last '+p.long,rows:[['What it does','Filters every chart & table to the last '+p.long]]})}
            onClick={()=>{setRange(p.k);setOpen(false);}}>{p.label}</button>)}
        <button type="button" className="tr-reset" aria-label="Clear time range (show all)"
          {...bind({title:'Time range · All',rows:[['What it does','Removes the time filter — show data from all time']]})}
          onClick={()=>{setRange(null);setOpen(false);}}>All</button>
      </div>
    </>}
  </span>;
}

/* ── FilterBar — sticky strip of active pivots under the TopBar. Hidden when empty. ── */
function FilterBar(){
  const {filters,remove,clear}=useFilters();
  if(!filters.length) return null;
  return <div className="filter-bar" role="region" aria-label="Active filters">
    <span className="filter-bar-label">Filters</span>
    {filters.map((f,i)=><button key={f.field+'|'+f.value+'|'+i} className="chip active"
      title={'Remove filter · '+(explain(f.field,f.value)||f.label)}
      aria-label={'Remove filter '+f.label}
      onClick={()=>remove(f.field,f.value,f.label)}>
      {f.label}<span className="x">✕</span></button>)}
    <button className="filter-clear" onClick={()=>clear()}>Clear all</button>
  </div>;
}

/* ── EntityPeek (slice 6) — the ONE shared triage block rendered inside every
   peek: recent audit lines for the entity + cross-tab trace buttons + a pin
   button. Reused by PeekDrawer for whatever row/tableId produced the peek, so
   there's no second drawer/storage — trace reuses nav+`f=`, pin reuses the LS
   scratchpad. Data comes from the already-mounted /api/data feed (no new fetch). */
function EntityPeek({row,tableId,onClose}){
  const ent=entityOf(row,tableId);
  const data=useData();
  if(!ent) return null;
  const d=(data&&data.data)||{};
  const logs=Array.isArray(d.auditLogs)?d.auditLogs:(Array.isArray(d.audit)?d.audit:[]);
  const needle=(ent.pred&&ent.pred.value||'').toLowerCase();
  // Recent audit lines that mention this entity (best-effort scan of every field).
  const related=needle?logs.filter(l=>{
    try{ return Object.values(l).some(v=>v!=null&&String(v).toLowerCase().indexOf(needle)>=0); }catch(_){ return false; }
  }).slice(0,3):[];
  const pin=()=>{ pinEntity(ent); };
  return <div className="ep">
    <div className="ep-sec">
      <div className="ep-sec-label">Recent audit</div>
      {related.length
        ? related.map((l,i)=><div key={i} className="ep-audit mono">
            <span className="ep-audit-ev">{String(l.event||l.action||'—')}</span>
            <span className="ep-audit-meta">{String(l.actor||l.who||'')}{l.ts?' · '+relAge(l.ts):''}</span>
          </div>)
        : <div className="ep-empty">No audit lines for this entity.</div>}
    </div>
    <div className="ep-sec">
      <div className="ep-sec-label">Trace across planes</div>
      <div className="ep-traces">
        {TRACE_TARGETS.map(t=>
          <button key={t.tab} type="button" className="ep-trace-btn"
            aria-label={t.label+' — filter to '+ent.pred.field+':'+ent.pred.value}
            onClick={()=>{ if(onClose) onClose(); traceTo(t.tab,ent); }}>{t.label}</button>)}
      </div>
    </div>
    <button type="button" className="ep-pin" onClick={pin}
      aria-label={'Pin '+ent.label+' to the scratchpad'}>Pin to scratchpad</button>
  </div>;
}

/* ── PeekDrawer (F4) — conditionally mounted (unmounted = zero width, overflow-safe).
   Focuses close on open, traps Tab, returns focus to the table wrapper on close. ── */
function PeekDrawer(){
  const power=usePower();
  const peek=power&&power.peek;
  const asideRef=useRef(null);
  const closeRef=useRef(null);
  const tid=peek?peek.tableId:null;
  useEffect(()=>{
    if(!peek) return;
    const ret=peek.returnFocus;
    if(closeRef.current) closeRef.current.focus();
    return ()=>{ if(ret&&ret.focus){ try{ret.focus();}catch(e){}} };
  },[tid]); // eslint-disable-line
  if(!peek) return null;
  const onKeyDown=e=>{
    if(e.key==='Escape'){ e.preventDefault(); power.closePeek(); return; }
    if(e.key==='Tab'&&asideRef.current){
      const f=asideRef.current.querySelectorAll('button,a[href],input,select,textarea,[tabindex]:not([tabindex="-1"])');
      if(!f.length) return;
      const first=f[0],last=f[f.length-1];
      if(e.shiftKey&&document.activeElement===first){ e.preventDefault(); last.focus(); }
      else if(!e.shiftKey&&document.activeElement===last){ e.preventDefault(); first.focus(); }
    }
  };
  return <aside className="peek" role="dialog" aria-modal="true" aria-label="Row detail"
    ref={asideRef} onKeyDown={onKeyDown}>
    <div className="peek-head">
      <span className="peek-title mono">{peek.title||'Detail'}</span>
      <button ref={closeRef} className="peek-close" aria-label="Close detail" onClick={()=>power.closePeek()}>✕</button>
    </div>
    <div className="peek-body">
      {peek.render?peek.render(peek.row):null}
      <EntityPeek row={peek.row} tableId={peek.tableId} onClose={()=>power.closePeek()}/>
    </div>
    {peek.onFull?<div className="peek-foot">
      <button className="peek-full" onClick={()=>{const f=peek.onFull;power.closePeek();f();}}>Open full view →</button>
    </div>:null}
  </aside>;
}

/* ── AbMenu — a single ActionBar action that fans out into a small format menu
   (Feature 8 "Copy as"). Reuses the DTRow copy-as popover styling + focus model:
   open focuses first item, Arrow moves, Esc closes and returns focus to trigger. ── */
