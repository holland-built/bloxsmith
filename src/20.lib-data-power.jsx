function useApi(url,{poll}={}){
  const [data,setData]=useState(null);
  const [error,setError]=useState(null);
  const [locked,setLocked]=useState(false);
  const [loading,setLoading]=useState(!!url);
  const [fetchedAt,setFetchedAt]=useState(null);
  const [tick,setTick]=useState(0);

  const refetch=useCallback(()=>setTick(t=>t+1),[]);

  useEffect(()=>{
    if(!url) return;
    const ctrl=new AbortController();
    let alive=true;
    setLoading(true);
    fetch(url,{signal:ctrl.signal,cache:'no-store'})
      .then(async r=>{
        let body=null;
        try{body=await r.json();}catch(e){body=null;}
        if(!alive) return;
        const jsonLocked=body&&(body.locked===true||body.error==='vault locked');
        if(r.status===503||jsonLocked){
          setLocked(true);setError(null);setLoading(false);setFetchedAt(new Date());
          window.dispatchEvent(new CustomEvent('bx:vault-locked'));
          return;
        }
        if(!r.ok||(body&&body.error)){
          setError((body&&body.error)||('HTTP '+r.status));
          setLoading(false);setFetchedAt(new Date());
          return;
        }
        setLocked(false);setError(null);setData(body);setLoading(false);setFetchedAt(new Date());
      })
      .catch(e=>{
        if(e.name==='AbortError'||!alive) return;
        setError(String((e&&e.message)||e));setLoading(false);setFetchedAt(new Date());
      });
    let iv=null;
    if(poll&&poll>0) iv=setInterval(refetch,poll);
    return ()=>{alive=false;ctrl.abort();if(iv)clearInterval(iv);};
  },[url,poll,tick,refetch]);

  return {data,error,locked,fetchedAt,refetch,loading};
}

/* DataCtx — ONE shared /api/data feed. The payload is multi-MB (5000 subnets),
   so every tab refetching it on mount showed skeletons for seconds. Provider
   mounts once inside VaultGate; all tabs read this instead of their own useApi. */
const DataCtx=React.createContext(null);
function useData(){ return React.useContext(DataCtx)||{data:null,error:null,locked:false,fetchedAt:null,refetch:()=>{},loading:false}; }
function DataProvider({children}){
  const api=useApi('/api/data');
  return <DataCtx.Provider value={api}>{children}</DataCtx.Provider>;
}

/* ─────────────────────────────────────────────────────────────
   3. Freshness — "updated Ns ago" mono pill; red + Retry on error.
   ───────────────────────────────────────────────────────────── */
function relAge(at){
  if(!at) return '';
  const s=Math.max(0,Math.round((Date.now()-new Date(at).getTime())/1000));
  if(s<60) return s+'s ago';
  const m=Math.floor(s/60);if(m<60) return m+'m ago';
  const h=Math.floor(m/60);if(h<24) return h+'h ago';
  return Math.floor(h/24)+'d ago';
}
function Freshness({at,onRetry,error}){
  const [,force]=useState(0);
  useEffect(()=>{const iv=setInterval(()=>force(x=>x+1),1000);return ()=>clearInterval(iv);},[]);
  if(error){
    return <span className="fresh err mono">
      failed{onRetry?<> · <button className="fresh-retry" onClick={onRetry}>Retry</button></>:null}
    </span>;
  }
  if(!at) return null;
  return <span className="fresh mono">updated {relAge(at)}</span>;
}

/* ─────────────────────────────────────────────────────────────
   4. Toast bus — global toast(msg,kind) + <Toasts/> renderer.
   Flat, 1px border, text-only (no green checkmark icons).
   ───────────────────────────────────────────────────────────── */
let _toastPush=null;let _toastSeq=0;
/* toast(msg,kind[,opts]) — opts={action:{label,run},duration}. The 2-arg form is
   unchanged (default 4000ms, no action) so every existing caller is untouched. */
function toast(msg,kind,opts){
  if(_toastPush) _toastPush({id:++_toastSeq,msg,kind:kind||'ok',
    action:opts&&opts.action,duration:(opts&&opts.duration)||4000});
}
function Toasts(){
  const [items,setItems]=useState([]);
  useEffect(()=>{
    _toastPush=(t)=>{
      setItems(list=>[...list,t]);
      setTimeout(()=>setItems(list=>list.filter(x=>x.id!==t.id)),t.duration||4000);
    };
    return ()=>{_toastPush=null;};
  },[]);
  const dismiss=id=>setItems(list=>list.filter(x=>x.id!==id));
  return <div className="toasts" role="status" aria-live="polite" aria-atomic="false"
    style={items.length?null:{pointerEvents:'none'}}>
    {items.map(t=><div key={t.id} className={'toast '+(t.kind||'ok')}>
      <span>{t.msg}</span>
      {t.action?<button className="toast-action" onClick={()=>{try{t.action.run();}catch(e){} dismiss(t.id);}}>{t.action.label}</button>:null}
    </div>)}
  </div>;
}

/* ─────────────────────────────────────────────────────────────
   5. DataTable — sortable primitive with optional CSV export.
   cols:{key,label,mono,align,render,width}
   ───────────────────────────────────────────────────────────── */
/* ── Sparkline (F7) — ~15-line SVG, normalized to the viewBox, guards flat/empty ── */
function Sparkline({values,width=72,height=18,color,fill}){
  const v=Array.isArray(values)?values.filter(x=>typeof x==='number'&&isFinite(x)):[];
  if(v.length<2) return null;
  const min=Math.min(...v),max=Math.max(...v),span=(max-min)||1;
  const col=color||'var(--accent)';
  const pts=v.map((n,i)=>{
    const x=(i/(v.length-1))*width;
    const y=height-((n-min)/span)*(height-3)-1.5;
    return [x,y];
  });
  const line=pts.map((p,i)=>(i?'L':'M')+p[0].toFixed(1)+' '+p[1].toFixed(1)).join(' ');
  const area='M0 '+height+' '+pts.map(p=>'L'+p[0].toFixed(1)+' '+p[1].toFixed(1)).join(' ')+' L'+width+' '+height+' Z';
  return <svg className="spark" width={width} height={height} viewBox={'0 0 '+width+' '+height} aria-hidden="true">
    {fill?<path d={area} fill={col} opacity="0.12"/>:null}
    <path d={line} fill="none" stroke={col} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round"/>
  </svg>;
}

/* ── PowerCtx (F1) — registry of keyboard-driven tables + peek + density.
   One global keydown listener (F2) dispatches to the active table's imperative api. ── */
const PowerCtx=React.createContext(null);
function usePower(){ return React.useContext(PowerCtx); }
function PowerProvider({children}){
  const tablesRef=useRef(new Map());   // id → {label, api:ref}
  const activeRef=useRef(null);
  const [activeId,setActiveId]=useState(null);
  const [peek,setPeekState]=useState(null);
  const peekRef=useRef(null);
  const [density,setDensityState]=useState(()=>(typeof document!=='undefined'&&document.documentElement.dataset.density)||'compact');

  const setActive=useCallback(id=>{ activeRef.current=id; setActiveId(id); },[]);
  const setPeek=useCallback(p=>{ peekRef.current=p; setPeekState(p); },[]);
  const closePeek=useCallback(()=>{ peekRef.current=null; setPeekState(null); },[]);
  const register=useCallback((id,entry)=>{ tablesRef.current.set(id,entry); if(!activeRef.current) setActive(id); },[setActive]);
  const unregister=useCallback(id=>{
    tablesRef.current.delete(id);
    if(peekRef.current&&peekRef.current.tableId===id){ peekRef.current=null; setPeekState(null); }
    if(activeRef.current===id){ setActive(tablesRef.current.keys().next().value||null); }
  },[setActive]);
  const getActive=useCallback(()=> activeRef.current?tablesRef.current.get(activeRef.current):null,[]);
  const setDensity=useCallback(v=>{ document.documentElement.dataset.density=v; LS.set('density',v); setDensityState(v); },[]);
  // Feature 9 — is a DataTable with a `field` column currently mounted anywhere
  // on THIS page? Lets a widget (the capacity heatmap) decide, at click time,
  // between cross-filtering a co-located table in place (fx.toggle) vs. navigating
  // to a page that has one (nav-drill) — see OverviewTab's heatcell onClick.
  const hasField=useCallback(field=>{
    for(const entry of tablesRef.current.values()){
      const api=entry&&entry.api&&entry.api.current;
      if(!api||typeof api.getState!=='function') continue;
      let st; try{ st=api.getState(); }catch(e){ continue; }
      if(st&&Array.isArray(st.columns)&&st.columns.some(c=>c&&c.key===field)) return true;
    }
    return false;
  },[]);

  useEffect(()=>{
    const gg={t:0};
    const onKey=e=>{
      if(e.metaKey||e.ctrlKey||e.altKey) return; // leave ⌘K etc. alone
      const t=e.target;
      if(t&&t.closest&&t.closest('input,textarea,select,[contenteditable="true"]')) return;
      if(document.querySelector('.palette-scrim,.vault-screen,.acct-menu,.views-menu')) return;
      const entry=activeRef.current?tablesRef.current.get(activeRef.current):null;
      const api=entry&&entry.api&&entry.api.current;
      if(peekRef.current){
        if(e.key==='Escape'){ e.preventDefault(); closePeek(); return; }
        if((e.key==='j'||e.key==='ArrowDown')&&api){ e.preventDefault(); api.move(1); return; }
        if((e.key==='k'||e.key==='ArrowUp')&&api){ e.preventDefault(); api.move(-1); return; }
        // Macros while the peek is open: p pins THIS entity, t jumps focus to its
        // trace buttons (slice 6 — o is a no-op here, the peek is already open).
        if(e.key==='p'){ e.preventDefault(); const pk=peekRef.current; pinEntity(entityOf(pk&&pk.row,pk&&pk.tableId)); return; }
        if(e.key==='t'){ e.preventDefault(); const b=document.querySelector('.peek .ep-trace-btn'); if(b) b.focus(); return; }
        return;
      }
      if(!api) return;
      let handled=false;
      if(e.key==='j'||e.key==='ArrowDown'){ api.move(1); handled=true; }
      else if(e.key==='k'||e.key==='ArrowUp'){ api.move(-1); handled=true; }
      else if(e.key==='Enter'){ handled=api.openCursor(); }
      // Slice 6 macros on the cursor row: o open peek, t trace (open peek + focus
      // its trace buttons), p pin to scratchpad. y (copy id) already exists below.
      else if(e.key==='o'){ handled=api.openCursor(); }
      else if(e.key==='t'){ handled=api.openCursor(); if(handled) requestAnimationFrame(()=>{ const b=document.querySelector('.peek .ep-trace-btn'); if(b) b.focus(); }); }
      else if(e.key==='p'){ let row=null; try{ row=api.pinTarget&&api.pinTarget(); }catch(_){} if(row){ pinEntity(entityOf(row,activeRef.current)); handled=true; } }
      else if(e.key==='x'){ handled=api.toggleSelect(); }
      else if(e.key==='y'){ handled=api.copyCursorRow(); }
      else if(e.key==='/'){ handled=api.focusFilter(); }
      else if(e.key==='G'){ handled=api.gotoBottom(); }
      else if(e.key==='g'){ const now=Date.now(); if(now-gg.t<400){ handled=api.gotoTop(); gg.t=0; } else { gg.t=now; handled=true; } }
      else if(e.key==='Escape'){ handled=api.clearOrCursor(); }
      if(handled) e.preventDefault();
    };
    window.addEventListener('keydown',onKey);
    return ()=>window.removeEventListener('keydown',onKey);
  },[closePeek]);

  const val={activeId,setActive,register,unregister,getActive,peek,setPeek,closePeek,density,setDensity,hasField};
  return <PowerCtx.Provider value={val}>{children}</PowerCtx.Provider>;
}

/* ─────────────────────────────────────────────────────────────
   Global click-to-pivot / cross-filter layer.
   Filters = [{field,value,label}]. Clicking a CODED value anywhere adds a
   filter; every DataTable AND-filters rows whose field matches one of ITS
   columns (unrelated tables ignore it). Mirrored to the URL hash `f=` param
   (field:value,…) via parseHash/nav so pivots are deep-linkable + survive reload.
   ───────────────────────────────────────────────────────────── */
// EXPLAIN — enum-code glossary. Default tooltip for coded/pivot columns so every
// coded chip explains itself. Keyed by column key → lowercased value → text.
