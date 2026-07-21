function Delta({v,good}){
  if(v==null) return <span className="mono" style={{color:'var(--text-faint)'}}>—</span>;
  const n=Number(v);
  if(!isFinite(n)) return <span className="mono" style={{color:'var(--text-faint)'}}>—</span>;
  const dir=good==='down'?-1:1;
  const moved=n*dir; // >0 = moved the good way
  const color=n===0?'var(--text-faint)':(moved>0?'var(--ok)':'var(--crit)');
  const sign=n>0?'+':(n<0?'−':'');
  return <span className="mono" style={{color}}>{sign}{Math.abs(n)}</span>;
}

/* SynthBand — full-width answer-first band. Renders with partial/missing
   facts (shows —) and never throws.
   facts: [{label,value,delta}] where delta is a number (good='up') or {v,good}.
   chips: [{label,onClick}]. */
function SynthBand({tone,verdict,facts,chips}){
  // refined verdict band: FLAT severity tint + 3px left stripe (no gradient),
  // pulsing status dot, 15px/600 title, 12.5px dim subline with <b> facts.
  const t=tone==='crit'?'crit':tone==='warn'?'warn':'ok';
  const dot='var(--'+t+')';
  const fx=Array.isArray(facts)?facts:[];
  const cx=Array.isArray(chips)?chips:[];
  const flt=useFilters(); // chips carrying {filter:{field,value,label}} become click-to-filter pivots
  return <div className="band" role="status" aria-live="polite"
    style={{background:'var(--'+t+'-dim)',borderLeft:'3px solid var(--'+t+')'}}>
    <div className="band-verdict">
      <span className="band-dot sd pulse" aria-hidden="true" style={{background:dot}}/>
      <span className="prose" style={{fontSize:14,fontWeight:600,lineHeight:1.4}}>{verdict||'—'}</span>
    </div>
    {fx.length?<div className="band-facts">
      {fx.map((f,i)=>{
        const d=f&&f.delta;
        const hasV=f&&f.value!=null&&f.value!=='';
        return <div className="band-fact" key={i}>
          <span className="band-fact-l">{f&&f.label!=null?f.label:'—'}</span>
          <span className="band-fact-v mono" style={{fontSize:'12px'}}>
            <b style={{color:'var(--text)',fontWeight:600}}>{hasV?f.value:'—'}</b>
            {d!=null?<Delta v={typeof d==='object'?d.v:d} good={typeof d==='object'?d.good:'up'}/>:null}
          </span>
        </div>;
      })}
    </div>:null}
    {cx.length?<div className="band-chips">
      {cx.map((c,i)=>{
        // service chip (.svc, 2-line) when meta/status/name present; else button chip
        const isSvc=c&&(c.meta!=null||c.status!=null||c.name!=null);
        if(isSvc) return <div className="svc" key={i}>
          <div className="t"><span className={'sd '+(c.status||'ok')}/>{c.name!=null?c.name:c.label}</div>
          {c.meta!=null?<div className="m">{c.meta}</div>:null}
        </div>;
        // filter-chip: toggles a global filter pivot (clearable via FilterBar); active = highlighted
        const fdef=c&&c.filter;
        if(fdef&&fdef.field!=null){
          const on=flt.has(fdef.field,fdef.value);
          return <button className={"chip band-chip"+(on?" active":"")} key={i} aria-pressed={on}
            title={(on?'Remove filter · ':'Filter · ')+(fdef.label||(fdef.field+': '+fdef.value))}
            onClick={()=>flt.toggle(fdef.field,fdef.value,fdef.label||(c&&c.label))}>
            {c&&c.label!=null?c.label:'—'}</button>;
        }
        return <button className="chip band-chip" key={i}
          style={{cursor:c&&c.onClick?'pointer':'default'}}
          onClick={c&&c.onClick?c.onClick:undefined}>{c&&c.label!=null?c.label:'—'}</button>;
      })}
    </div>:null}
  </div>;
}

/* Snapshot store — one row per calendar day (last 30), for day-over-day deltas. */
const snapKey='snap';
function todayISO(){ return new Date().toISOString().slice(0,10); }
function readSnaps(){
  const s=LS.get(snapKey,null);
  if(!s||typeof s!=='object'||!Array.isArray(s.days)) return {v:1,days:[]};
  return s;
}
function writeSnap(todayObj){
  if(!todayObj||!todayObj.date) return;
  let days=(readSnaps().days||[]).filter(d=>d&&d.date!==todayObj.date); // same-day overwrite
  days.push(todayObj);
  days.sort((a,b)=>String(a.date).localeCompare(String(b.date)));
  if(days.length>30) days=days.slice(days.length-30); // hard cap: last 30
  LS.set(snapKey,{v:1,days});
}
function snapPath(obj,path){
  if(!obj||!path) return null;
  let cur=obj;
  for(const p of String(path).split('.')){
    if(cur==null||typeof cur!=='object') return null;
    cur=cur[p];
  }
  return cur==null?null:cur;
}
/* useSnapshots → {prev, today, delta(path)}. prev = most recent day < today. */
function useSnapshots(){
  const ti=todayISO();
  const days=(readSnaps().days||[]).slice().sort((a,b)=>String(a.date).localeCompare(String(b.date)));
  const today=days.filter(d=>d.date===ti).slice(-1)[0]||null;
  const prev=days.filter(d=>d.date<ti).slice(-1)[0]||null;
  const delta=(path)=>{
    if(!prev) return null;
    const cur=snapPath(today,path),old=snapPath(prev,path);
    if(typeof cur!=='number'||typeof old!=='number') return null;
    return cur-old;
  };
  return {prev,today,delta};
}

/* diffRows — pure row-level diff against a prior row set (Compare-to-snapshot).
   prevRows/currRows: plain-object arrays. keyFn(row)=>string row identity.
   compareKeys: value keys checked for "changed" (present in prevRow & currRow).
   Returns {byKey:Map<key,{type:'+'|'~',label}>, ghosts:Array<row>} — ghosts are
   prior rows absent from currRows (rendered as struck-through rows by the caller).
   Signal is glyph+label only — no color/style decision made here. */
function diffRows(prevRows,currRows,keyFn,compareKeys){
  const prevMap=new Map((prevRows||[]).filter(Boolean).map(r=>[keyFn(r),r]));
  const currMap=new Map((currRows||[]).filter(Boolean).map(r=>[keyFn(r),r]));
  const byKey=new Map();
  currMap.forEach((r,k)=>{
    const p=prevMap.get(k);
    if(!p){ byKey.set(k,{type:'+',label:'added'}); return; }
    const changed=(compareKeys||[]).some(ck=>String(p[ck])!==String(r[ck]));
    if(changed) byKey.set(k,{type:'~',label:'changed'});
  });
  const ghosts=[];
  prevMap.forEach((r,k)=>{ if(!currMap.has(k)) ghosts.push(r); });
  return {byKey,ghosts};
}

/* SnapshotWriter — mounted in Shell (inside DataProvider). On data present,
   captures today's snapshot (same-day overwrite) after one guarded security fetch. */
function SnapshotWriter(){
  const {data}=useData();
  useEffect(()=>{
    const d=data&&data.data;
    if(!d) return;
    try{
      const subnets=Array.isArray(d.subnets)?d.subnets:[];
      const leases=Array.isArray(d.leases)?d.leases:[];
      const zones=Array.isArray(d.zones)?d.zones:[];
      const hosts=Array.isArray(d.hosts)?d.hosts:[];
      const utilOf=s=>Number(s&&s.util)||0;
      const gt85=subnets.filter(s=>utilOf(s)>85).length;
      const b7085=subnets.filter(s=>{const u=utilOf(s);return u>=70&&u<=85;}).length;
      const top=[...subnets].sort((a,b)=>utilOf(b)-utilOf(a)).slice(0,20)
        .map(s=>({a:s.addr||s.name||'',u:utilOf(s)}));
      const active=leases.filter(l=>String(l.state||'').toLowerCase()==='active').length;
      const zoneIssues=zones.filter(z=>Array.isArray(z.issues)&&z.issues.length>0).length;
      const online=hosts.filter(h=>/^(online|up)$/i.test(String(h.status||''))).length;
      // leaseTop/hostTop — Compare-to-snapshot row-level shape for the Leases and
      // Hosts tables (mirrors subnets.top above). Leases/hosts have no natural
      // "top" ranking like subnet util, so both are sorted by their row key for a
      // deterministic, bounded (50-row) capture rather than an unbounded dump.
      const leaseTop=[...leases].sort((a,b)=>String(a.addr||a.ip||'').localeCompare(String(b.addr||b.ip||'')))
        .slice(0,50).map(l=>({a:l.addr||l.ip||'',s:l.state||'',h:l.host||''}));
      const hostTop=[...hosts].sort((a,b)=>String(a.name||'').localeCompare(String(b.name||'')))
        .slice(0,50).map(h=>({n:h.name||'',s:h.status||''}));
      const base={
        date:todayISO(), ts:Date.now(),
        subnets:{n:subnets.length,gt85,b7085,top},
        leases:{n:leases.length,active,top:leaseTop},
        zones:{n:zones.length,issues:zoneIssues},
        hosts:{n:hosts.length,online,offline:hosts.length-online,top:hostTop},
        sec:{crit:0,high:0,med:0,low:0,blocked:0,logged:0,total:0},
        dns7d:null,
      };
      fetch('/api/hub/security',{cache:'no-store'}).then(r=>r.json()).then(sd=>{
        const c=(sd&&sd.counts)||{};
        base.sec={crit:Number(c.critical)||0,high:Number(c.high)||0,med:Number(c.medium)||0,
          low:Number(c.low)||0,blocked:Number(sd&&sd.blocked)||0,logged:Number(sd&&sd.logged)||0,
          total:Number(sd&&sd.total)||0};
        writeSnap(base);
      }).catch(()=>writeSnap(base));
    }catch(e){}
  },[data&&data.data]);
  return null;
}

/* ─────────────────────────────────────────────────────────────
   Delta-since-last-visit (P1 slice 7) — a per-tab "+N new / ~M
   changed" chip. REUSES the existing snapshot store (readSnaps) +
   diffRows; the only new state is a per-tab last-visit timestamp in
   bx.tabVisit LS. No second snapshot system. Signal is glyph+text
   (monochrome, reuses the .dt-diff +/~ vocabulary) — never color-only.
   ───────────────────────────────────────────────────────────── */
const VISIT_KEY='tabVisit';
// DELTA_TABS — which tabs carry a per-row snapshot shape to diff against. Maps
// current rows (from /api/data) + a prior-snapshot-day → the same {row} arrays
// diffRows already consumes (mirrors NetworkTab/InfraTab's Compare buttons).
const DELTA_TABS={
  network:{
    rows:d=>Array.isArray(d.subnets)?d.subnets:[],
    key:r=>String(r.addr||r.id), cmp:['util'], label:r=>r.name||r.addr||r.id,
    prevRows:day=>(day&&day.subnets&&Array.isArray(day.subnets.top))?day.subnets.top.map(t=>({addr:t.a,util:t.u})):[],
  },
  infra:{
    rows:d=>Array.isArray(d.hosts)?d.hosts:[],
    key:r=>String(r.name||''), cmp:['status'], label:r=>r.name,
    prevRows:day=>(day&&day.hosts&&Array.isArray(day.hosts.top))?day.hosts.top.map(t=>({name:t.n,status:t.s})):[],
  },
};
// baselineSnap — the snapshot the tab looked like AT the user's last visit: the
// most recent snapshot day on-or-before that visit; falls back to the prior day
// (same "most recent day < today" rule useSnapshots.prev uses).
function baselineSnap(lastVisitTs){
  const days=(readSnaps().days||[]).slice().sort((a,b)=>String(a.date).localeCompare(String(b.date)));
  if(!days.length) return null;
  if(lastVisitTs){
    const lv=new Date(lastVisitTs).toISOString().slice(0,10);
    const onOrBefore=days.filter(d=>d&&d.date<=lv).slice(-1)[0];
    if(onOrBefore) return onOrBefore;
  }
  const ti=todayISO();
  return days.filter(d=>d&&d.date<ti).slice(-1)[0]||null;
}
function DeltaChip({tab}){
  const {data}=useData();
  const cfg=DELTA_TABS[tab];
  // Freeze the PRE-visit timestamp for this tab (useState initializer runs before
  // the record-visit effect below), so the chip diffs against the last time the
  // user actually saw the tab — not "now".
  const [baseTs]=useState(()=>{ const v=LS.get(VISIT_KEY,{})||{}; return (v[tab]&&v[tab].ts)||null; });
  const [open,setOpen]=useState(false);
  // Record this visit so the NEXT visit compares against now. Read-modify-write of
  // the shared bx.tabVisit map only — never touches the snapshot/data feeds.
  useEffect(()=>{
    if(!cfg) return;
    const v=LS.get(VISIT_KEY,{})||{}; v[tab]={ts:Date.now(),date:todayISO()}; LS.set(VISIT_KEY,v);
  },[tab,cfg]);
  if(!cfg||!data) return null;
  const rows=cfg.rows(data);
  const base=baselineSnap(baseTs);
  if(!base) return null;
  const {byKey}=diffRows(cfg.prevRows(base),rows,cfg.key,cfg.cmp);
  let added=0,changed=0; byKey.forEach(m=>{ if(m.type==='+')added++; else if(m.type==='~')changed++; });
  if(added===0&&changed===0) return null;
  const items=[];
  rows.forEach(r=>{ const m=byKey.get(cfg.key(r)); if(m) items.push({label:cfg.label(r),mark:m.type,tag:m.label}); });
  return <div className="delta-wrap">
    <button className="delta-chip mono" aria-expanded={open}
      aria-label={added+' new, '+changed+' changed since your last visit — show'}
      onClick={()=>setOpen(o=>!o)}>
      <span className="delta-since">Since last visit</span>
      {added>0?<span className="delta-seg"><span className="delta-glyph" aria-hidden="true">+</span>{added} new</span>:null}
      {changed>0?<span className="delta-seg"><span className="delta-glyph" aria-hidden="true">~</span>{changed} changed</span>:null}
    </button>
    {open&&<>
      <div className="views-overlay" onClick={()=>setOpen(false)}/>
      <div className="dt-popover delta-pop" role="menu" aria-label="Rows changed since last visit">
        {items.map((it,i)=><div key={i} className="delta-pop-row">
          <span className="dt-diff mono"><span aria-label={it.tag} title={it.tag}>{it.mark}</span></span>
          <span className="vname">{it.label}</span>
        </div>)}
      </div>
    </>}
  </div>;
}

/* ─────────────────────────────────────────────────────────────
   SHARED DISPLAY-FORM PRIMITIVES — VolumeHistogram, heatCell/
   trendCell, AiExplain. SVG/CSS only (no chart lib), all width:100% and
   viewBox-scaled so they never cause horizontal overflow at 375px. Token
   colors only; wired into tabs by later agents. Not a region body.
   ───────────────────────────────────────────────────────────── */


/* parseTs — tolerant timestamp → ms epoch (number s/ms, Date, or ISO/string). */
function parseTs(v){
  if(v==null) return NaN;
  if(v instanceof Date) return v.getTime();
  if(typeof v==='number') return v<1e12?v*1000:v;
  const n=Number(v); if(isFinite(n)&&String(v).trim()!=='') return n<1e12?n*1000:n;
  const d=Date.parse(v); return isNaN(d)?NaN:d;
}
/* VolumeHistogram — time-bucketed event volume with the full P1-slice-5 interaction
   kit. New props are ALL optional (unset ⇒ pre-existing behavior, backward-compatible):
     • onZoom(range)   — capture-to-zoom: a drag-select also reports its window here
                         (the caller sets the GLOBAL time range from it). Single-bucket
                         clicks stay local (onRange only) so bucket-filtering is unchanged.
     • annotations     — [{ts,title,rows}] audit/config-change ticks overlaid on the
                         time axis; each is a focusable monochrome mark + hover detail.
     • windowRange     — [from,to] ms of the active global window, shaded as a band. */
function VolumeHistogram({rows,tsKey,buckets,onRange,selected,onZoom,annotations,windowRange}){
  const svgRef=useRef(null);
  const dragRef=useRef(null);           // {u0} while dragging
  const [drag,setDrag]=useState(null);  // {a,b} in 0..100 units
  const [cross,setCross]=useState(null);// {u,i,count} crosshair readout on hover
  const {bind}=useHoverDetail();        // annotation hover cards (reuses the singleton)

  const model=useMemo(()=>{
    const ts=(Array.isArray(rows)?rows:[]).map(r=>parseTs(tsKey?(typeof tsKey==='function'?tsKey(r):r[tsKey]):r&&r.ts)).filter(t=>isFinite(t));
    if(ts.length<2) return null;
    let min=Math.min(...ts),max=Math.max(...ts); if(max<=min) max=min+1;
    const n=Math.max(1,Math.min(48,Number(buckets)||48));
    const span=max-min,bw=span/n;
    const counts=new Array(n).fill(0);
    ts.forEach(t=>{ let i=Math.floor((t-min)/bw); if(i>=n)i=n-1; if(i<0)i=0; counts[i]++; });
    return {min,max,span,n,bw,counts,peak:Math.max(1,...counts)};
  },[rows,tsKey,buckets]);

  if(!model) return null;
  const {min,max,span,n,bw,counts,peak}=model;
  const uToT=u=>min+(u/100)*span;
  const tToU=t=>((t-min)/span)*100;
  const uToBucket=u=>{ let i=Math.floor((u/100)*n); if(i>=n)i=n-1; if(i<0)i=0; return i; };
  const clientToU=px=>{ const el=svgRef.current; if(!el) return 0; const r=el.getBoundingClientRect(); return Math.max(0,Math.min(100,((px-r.left)/r.width)*100)); };
  const bucketSel=i=>{ if(!selected) return false; const c=min+(i+0.5)*bw; return c>=selected[0]&&c<=selected[1]; };

  const onDown=e=>{ const u=clientToU(e.clientX); dragRef.current={u0:u}; setDrag({a:u,b:u}); setCross(null); if(e.currentTarget.setPointerCapture){try{e.currentTarget.setPointerCapture(e.pointerId);}catch(_){}} };
  const onMove=e=>{
    const u=clientToU(e.clientX);
    if(dragRef.current){ setDrag({a:dragRef.current.u0,b:u}); return; }
    const i=uToBucket(u); setCross({u,i,count:counts[i]});   // crosshair readout (part 3)
  };
  const onUp=e=>{
    const d=dragRef.current; dragRef.current=null; const cur=drag; setDrag(null);
    if(!d) return;
    const u1=clientToU(e.clientX);
    if(Math.abs(u1-d.u0)<1.5){ const i=uToBucket(d.u0); if(onRange) onRange([min+i*bw,min+(i+1)*bw]); }   // single bucket → local only
    else { const t0=uToT(Math.min(d.u0,u1)),t1=uToT(Math.max(d.u0,u1)); if(onRange) onRange([t0,t1]); if(onZoom) onZoom([t0,t1]); }  // drag → local + global zoom
    void cur;
  };
  const clearAll=()=>{ if(onRange) onRange(null); if(onZoom) onZoom(null); };

  const fmt=t=>{ const d=new Date(t); return span>2*86400000?d.toLocaleDateString([],{month:'short',day:'numeric'}):d.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}); };
  const fmtFull=t=>{ const d=new Date(t); return d.toLocaleString([],{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}); };
  const labels=[0,0.33,0.66,1].map(f=>fmt(min+f*span));
  const total=counts.reduce((s,c)=>s+c,0);
  // window band (part 1 read-back) clipped to the visible domain
  const win=(Array.isArray(windowRange)&&windowRange.length===2)?[Math.max(0,tToU(windowRange[0])),Math.min(100,tToU(windowRange[1]))]:null;
  const winVisible=win&&win[1]>0&&win[0]<100&&win[1]>win[0];
  // annotation ticks (part 4) — only those inside the domain
  const annots=(Array.isArray(annotations)?annotations:[])
    .map(a=>({...a,ts:parseTs(a.ts)})).filter(a=>isFinite(a.ts)&&a.ts>=min&&a.ts<=max)
    .map(a=>({...a,u:tToU(a.ts)}));

  return <div style={{width:'100%',minWidth:0}}>
    <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',gap:'var(--s2)',marginBottom:'var(--s1)'}}>
      <span className="mono" style={{fontSize:'var(--t11)',color:'var(--text-faint)'}}>{total} event{total===1?'':'s'}</span>
      {selected?<button className="chip vh-clear" style={{cursor:'pointer'}} onClick={clearAll}>Clear ✕</button>:null}
    </div>
    <div className="vh-wrap">
    <svg ref={svgRef} className="vh-svg" viewBox="0 0 100 40" height={120} preserveAspectRatio="none"
        role="img" aria-label={'Volume histogram — '+total+' events'}
        style={{touchAction:'none'}}
        onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp}
        onPointerLeave={e=>{ if(dragRef.current){onUp(e);} setCross(null); }}>
      {winVisible?<rect className="vh-window" x={win[0]} y={0} width={win[1]-win[0]} height={40}/>:null}
      {counts.map((c,i)=>{
        const bwU=100/n,gap=Math.min(bwU*0.2,0.6),x=i*bwU+gap/2,w=Math.max(0.2,bwU-gap);
        const bh=(c/peak)*38,y=40-bh;
        const pick=onRange?()=>onRange([min+i*bw,min+(i+1)*bw]):undefined;
        return <rect key={i} className="vh-bar" x={x} y={y} width={w} height={bh} rx="0.4"
          fill={bucketSel(i)?'var(--accent-text)':'var(--accent)'} vectorEffect="non-scaling-stroke"
          tabIndex={onRange?0:undefined} role={onRange?'button':undefined}
          aria-label={onRange?(c+' events at '+fmt(min+i*bw)+' — filter to this window'):undefined}
          onKeyDown={onRange?(e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();pick();}}):undefined}>
          <title>{c+' · '+fmt(min+i*bw)}</title>
        </rect>;
      })}
      {drag?<rect x={Math.min(drag.a,drag.b)} y={0} width={Math.abs(drag.a-drag.b)} height={40}
        fill="var(--accent)" opacity="0.15" style={{pointerEvents:'none'}}/>:null}
      {annots.map((a,i)=>{
        const who=a.who||a.user||'', what=a.what||a.action||'', rowsD=a.rows||[
          ['Who',who||'—'],['What',what||'—'],['When',fmtFull(a.ts)]];
        const title=a.title||(what?what+' · '+who:'Change');
        return <g key={'an'+i} className="vh-annot" tabIndex={0} role="img"
            aria-label={'Change annotation — '+title+' at '+fmtFull(a.ts)}
            {...bind({title,rows:rowsD})}>
          <rect className="vh-annot-hit" x={a.u-1.5} y={0} width={3} height={40}/>
          <path className="vh-annot-mark" d={'M'+(a.u-1)+',0 L'+(a.u+1)+',0 L'+a.u+',3 Z'}/>
          <rect className="vh-annot-mark" x={a.u-0.12} y={0} width={0.24} height={7}/>
          <title>{title+' · '+fmtFull(a.ts)}</title>
        </g>;
      })}
      {cross?<line className="vh-crosshair" x1={cross.u} y1={0} x2={cross.u} y2={40}/>:null}
    </svg>
    {cross?<div className="vh-readout" style={{left:cross.u+'%'}}>{cross.count} event{cross.count===1?'':'s'} · {fmt(uToT(cross.u))}</div>:null}
    </div>
    <div className="mono" style={{display:'flex',justifyContent:'space-between',fontSize:'var(--t11)',color:'var(--text-faint)',marginTop:'var(--s1)'}}>
      {labels.map((l,i)=><span key={i}>{l}</span>)}
    </div>
  </div>;
}

/* TrendChart — shared multi-series area chart (Daily "Capacity & threats").
   series=[{l,s,c}] where l=label, s=array of daily numbers (oldest→newest, ≤30),
   c=CSS color var. Hand-rolled SVG (no chart lib): filled area + stroke line per
   series, left y-axis gridlines + mono value labels, x-axis day-ago ticks, and a
   hover crosshair with a per-series readout (mirrors VolumeHistogram's
   getBoundingClientRect pointer math + viewBox-scaled paths). Axis text lives in
   HTML overlays (not SVG <text>) because preserveAspectRatio=none stretches SVG
   text horizontally; vertical maps 1:1 so HTML labels position cleanly. Codes
   defensively for differing series lengths (uses the max length). height default 200. */
function TrendChart({series,height,xLabel}){
  const svgRef=useRef(null);
  // xLabel(nFromEnd)=>string renders each x-tick; default = days-ago (unchanged).
  const xlab=(typeof xLabel==='function')?xLabel:(n=>n===0?'now':'-'+n+'d');
  const [cross,setCross]=useState(null); // hovered point index (0..maxLen-1) or null
  const ss=(Array.isArray(series)?series:[]).filter(Boolean).map(x=>({
    l:x&&x.l!=null?x.l:'—', c:(x&&x.c)||'var(--accent)',
    s:(Array.isArray(x&&x.s)?x.s:[]).map(Number).filter(v=>isFinite(v))}));
  const maxLen=ss.reduce((m,x)=>Math.max(m,x.s.length),0);
  const H=Number(height)||200;
  const W=560,padL=36,padR=10,padT=10,padB=22;
  const plotW=W-padL-padR,plotH=H-padT-padB,baseY=padT+plotH;
  const allVals=[]; ss.forEach(x=>x.s.forEach(v=>allVals.push(v)));
  const rawMax=allVals.length?Math.max(...allVals):0;
  const maxY=Math.max(5,Math.ceil(rawMax/5)*5); // guard 0 → 5
  const xFor=i=>maxLen<2?padL:padL+(i/(maxLen-1))*plotW;
  const yFor=v=>baseY-(Math.max(0,Math.min(v,maxY))/maxY)*plotH;
  const legend=<div className="trend-legend">
    {ss.map((x,i)=><span className="trend-leg" key={i}>
      <span className="trend-sw" style={{background:x.c}}/>{x.l}</span>)}
  </div>;
  if(maxLen<2) return <div style={{width:'100%',minWidth:0}}>{legend}
    <div style={{color:'var(--text-faint)',fontSize:'var(--t12)',padding:'var(--s3)'}}>No history yet</div></div>;

  const grids=[0,1,2,3,4].map(k=>maxY*(k/4)); // ~4 gridlines (5 incl. 0)
  const ticks=[]; for(let i=0;i<maxLen;i++){ const ago=maxLen-1-i; if(ago%6===0||i===0) ticks.push({i,ago}); } // every ~6 pts + last
  const clientToIdx=px=>{ const el=svgRef.current; if(!el) return 0;
    const r=el.getBoundingClientRect(); const f=Math.max(0,Math.min(1,(px-r.left)/r.width));
    return Math.round(f*(maxLen-1)); };
  const onMove=e=>setCross(clientToIdx(e.clientX));
  const cx=cross!=null?xFor(cross):0;
  const leftPct=cross!=null?(cx/W)*100:0;
  const ago=cross!=null?(maxLen-1-cross):0;
  const yPct=y=>(y/H)*100;

  return <div style={{width:'100%',minWidth:0}}>
    {legend}
    <div className="trend-wrap" style={{height:H+'px'}}>
      <svg ref={svgRef} className="trend-svg" viewBox={'0 0 '+W+' '+H} preserveAspectRatio="none"
          role="img" aria-label={'Trend chart — '+ss.map(x=>x.l).join(', ')}
          onMouseMove={onMove} onMouseLeave={()=>setCross(null)}>
        {grids.map((gv,k)=><line key={'g'+k} className="trend-grid" x1={padL} y1={yFor(gv)} x2={W-padR} y2={yFor(gv)}/>)}
        {ss.map((x,i)=>{ if(x.s.length<2) return null;
          const pts=x.s.map((v,j)=>[xFor(j),yFor(v)]);
          const d='M'+pts[0][0].toFixed(1)+','+baseY+' '+pts.map(p=>'L'+p[0].toFixed(1)+','+p[1].toFixed(1)).join(' ')+' L'+pts[pts.length-1][0].toFixed(1)+','+baseY+' Z';
          return <path key={'a'+i} d={d} fill={x.c} opacity="0.13" style={{pointerEvents:'none'}}/>;
        })}
        {ss.map((x,i)=>{ if(x.s.length<2) return null;
          const pts=x.s.map((v,j)=>[xFor(j),yFor(v)]);
          const d=pts.map((p,j)=>(j?'L':'M')+p[0].toFixed(1)+','+p[1].toFixed(1)).join(' ');
          return <path key={'l'+i} d={d} fill="none" stroke={x.c} strokeWidth="1.8"
            strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" style={{pointerEvents:'none'}}/>;
        })}
        {cross!=null?<line className="trend-crosshair" x1={cx} y1={padT} x2={cx} y2={baseY}/>:null}
        {cross!=null?ss.map((x,i)=> cross<x.s.length
          ? <circle key={'d'+i} cx={cx} cy={yFor(x.s[cross])} r="2.6" fill={x.c}
              stroke="var(--surface)" strokeWidth="1" style={{pointerEvents:'none'}}/> : null):null}
      </svg>
      {grids.map((gv,k)=><span key={'yl'+k} className="trend-yl mono"
        style={{top:yPct(yFor(gv))+'%',left:'calc('+((padL/W)*100)+'% - 4px)'}}>{Math.round(gv)}</span>)}
      {ticks.map((t,k)=><span key={'xl'+k} className="trend-xl mono"
        style={{left:((xFor(t.i)/W)*100)+'%'}}>{xlab(t.ago)}</span>)}
      {cross!=null?<div className="trend-readout" style={{left:leftPct+'%'}}>
        <div className="trend-readout-h mono">{ago===0?'now':ago+' day'+(ago===1?'':'s')+' ago'}</div>
        {ss.map((x,i)=><div className="trend-readout-r" key={i}>
          <span style={{color:x.c}}>{x.l}</span>
          <b className="mono">{cross<x.s.length?x.s[cross]:'—'}</b>
        </div>)}
      </div>:null}
    </div>
  </div>;
}

/* ── Donut (shared) — slices=[{label,value,color}]. Hard-caps at 5 slices
   (top-4 + folded "other"), center total, side legend w/ counts. Guards empty/zero.
   Optional centerDetail (string) and legendDetail(label,slice)=>string wire the
   center + each legend row into useHoverDetail — no new tooltip system, callers
   that don't pass them get the exact prior behavior. ── */
function Donut({slices,size=120,centerValue,centerLabel,centerDetail,legendDetail}){
  const {bind}=useHoverDetail();
  const raw=(Array.isArray(slices)?slices:[]).filter(s=>s&&(Number(s.value)||0)>0);
  const total=raw.reduce((a,s)=>a+(Number(s.value)||0),0);
  if(!raw.length||total<=0) return <div style={{color:'var(--text-faint)',fontSize:'var(--t12)',padding:'var(--s3)'}}>No data</div>;
  const desc=[...raw].sort((a,b)=>(Number(b.value)||0)-(Number(a.value)||0));
  let parts=desc;
  if(desc.length>5){
    const tail=desc.slice(4);
    parts=[...desc.slice(0,4),{label:'other',value:tail.reduce((a,s)=>a+(Number(s.value)||0),0),color:'var(--text-faint)'}];
  }
  const stroke=Math.max(10,Math.round(size*0.16));
  const r=(size-stroke)/2, C=2*Math.PI*r, cx=size/2;
  let acc=0;
  const segs=parts.map(s=>{ const dash=((Number(s.value)||0)/total)*C; const seg={color:s.color||'var(--accent)',dash,offset:-acc}; acc+=dash; return seg; });
  const aria='Donut chart, total '+total+': '+parts.map(p=>p.label+' '+(Number(p.value)||0)).join(', ');
  const centerBind=centerDetail?bind({title:centerLabel||'Total',rows:[['What it means',centerDetail]]}):null;
  return <div className="donut-wrap" role="img" aria-label={aria}>
    <svg className="donut-svg" width={size} height={size} viewBox={'0 0 '+size+' '+size}>
      <g transform={'rotate(-90 '+cx+' '+cx+')'}>
        {segs.map((s,i)=><circle key={i} cx={cx} cy={cx} r={r} fill="none"
          stroke={s.color} strokeWidth={stroke}
          strokeDasharray={s.dash+' '+(C-s.dash)} strokeDashoffset={s.offset}/>)}
      </g>
      {centerLabel!=null
        ? <g tabIndex={centerDetail?0:undefined} style={centerDetail?{cursor:'help'}:undefined} {...(centerBind||{})}>
            <text x={cx} y={cx-size*0.05} textAnchor="middle" dominantBaseline="central" className="mono"
              fontSize={size*0.20} fontWeight="600" fill="var(--text)">{centerValue!=null?centerValue:total}</text>
            <text x={cx} y={cx+size*0.12} textAnchor="middle" dominantBaseline="central"
              fontSize={size*0.085} fill="var(--text-faint)" style={{textTransform:'uppercase',letterSpacing:'.4px'}}>{centerLabel}</text>
          </g>
        : <text x={cx} y={cx} textAnchor="middle" dominantBaseline="central" className="mono"
            fontSize={size*0.22} fontWeight="600" fill="var(--text)">{centerValue!=null?centerValue:total}</text>}
    </svg>
    <div className="donut-legend">
      {parts.map((p,i)=>{
        const detail=legendDetail?legendDetail(p.label,p):null;
        return <div key={i} className="donut-leg" tabIndex={detail?0:undefined}
          style={detail?{cursor:'help'}:undefined}
          {...(detail?bind({title:p.label,rows:[['Count',Number(p.value)||0],['What it means',detail]]}):{})}>
          <span className="donut-leg-dot" style={{background:p.color||'var(--accent)'}}/>
          <span className="donut-leg-l">{p.label}</span>
          <span className="donut-leg-v mono">{Number(p.value)||0}</span>
          <span className="donut-leg-pct mono">{total>0?Math.round((Number(p.value)||0)/total*100):0}%</span>
        </div>;
      })}
    </div>
  </div>;
}

/* ── HistogramBar (shared) — buckets=[{label,count,color}], 4-6 vertical bars +
   counts, viewBox-scaled (width:100%, no fixed-px overflow). Optional onClick(b,i). ── */
function HistogramBar({buckets,onClick,axisTicks}){
  const bs=(Array.isArray(buckets)?buckets:[]).filter(Boolean);
  if(!bs.length) return <div style={{color:'var(--text-faint)',fontSize:'var(--t12)',padding:'var(--s3)'}}>No data</div>;
  const peak=Math.max(1,...bs.map(b=>Number(b.count)||0)),n=bs.length;
  return <div style={{width:'100%',minWidth:0}}>
    <svg className="histbar-svg" viewBox="0 0 100 40" height={110} preserveAspectRatio="none"
        role="img" aria-label={'Histogram: '+bs.map(b=>(b.label||'')+' '+(Number(b.count)||0)).join(', ')}>
      {bs.map((b,i)=>{
        const bw=100/n,gap=Math.min(bw*0.2,2),x=i*bw+gap/2,w=Math.max(0.5,bw-gap);
        const c=Number(b.count)||0,bh=(c/peak)*38,y=40-bh;
        const fill=b.color||(b.util!=null?utilColor(b.util):'var(--accent)');
        const act=onClick?()=>onClick(b,i):undefined;
        return <rect key={i} className="histbar-bar" x={x} y={y} width={w} height={Math.max(0,bh)}
          fill={fill} vectorEffect="non-scaling-stroke"
          onClick={act}
          tabIndex={onClick?0:undefined} role={onClick?'button':undefined}
          aria-label={onClick?((b.label||'bucket')+', '+c+' — filter'):undefined}
          onKeyDown={onClick?(e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();act();}}):undefined}>
          <title>{(b.label||'')+' · '+c}</title></rect>;
      })}
    </svg>
    {axisTicks
      /* clean axis: only the labelled buckets (first/mid/last), no per-bucket count strip */
      ? <div className="mono" style={{display:'flex',justifyContent:'space-between',fontSize:'var(--t11)',color:'var(--text-faint)',marginTop:'var(--s1)'}}>
          {bs.filter(b=>b.label!=null&&b.label!=='').slice(0,5).map((b,i)=><span key={i}>{b.label}</span>)}
        </div>
      : <div className="mono" style={{display:'flex',fontSize:'var(--t11)',color:'var(--text-faint)',marginTop:'var(--s1)'}}>
          {bs.map((b,i)=><span key={i} style={{flex:'1 1 0',textAlign:'center',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{b.label} {Number(b.count)||0}</span>)}
        </div>}
  </div>;
}

/* ── ValueBands (shared) — value-range filter chips WITH live counts. Pure/controlled.
   props: rows, valueFn(row)→number, bands=[{id,label,test(v)→bool}], value(active id|null),
   onChange(id|null). Each chip shows "{label} · {count}"; active chip gets an accent border;
   clicking the active chip clears (toggles to null). Exported for region tabs (subnet fill %, etc).
   Canonical util bands: UTIL_BANDS. ── */
const UTIL_BANDS=[
  {id:'100',label:'100%',test:u=>u>=100},
  {id:'9099',label:'90-99%',test:u=>u>=90&&u<100},
  {id:'7089',label:'70-89%',test:u=>u>=70&&u<90},
  {id:'lt70',label:'<70%',test:u=>u<70},
];
function ValueBands({rows,valueFn,bands,value,onChange}){
  const rs=Array.isArray(rows)?rows:[];
  const bs=(Array.isArray(bands)?bands:[]).filter(Boolean);
  if(!bs.length) return null;
  return <div className="band-chips" role="group" aria-label="Value filter">
    {bs.map(b=>{
      let count=0;
      for(const r of rs){ try{ if(b.test(valueFn?valueFn(r):r)) count++; }catch(e){} }
      const active=value===b.id;
      return <button key={b.id} type="button"
        className={"chip band-chip"+(active?" active":"")} aria-pressed={active}
        onClick={()=>onChange&&onChange(active?null:b.id)}>
        {(b.label!=null?b.label:b.id)+' · '+count}</button>;
    })}
  </div>;
}

/* ── GroupedBar (shared) — rows=[{label,value,detail,color}], horizontal bars,
   label left (ellipsis), mono value right, cap at max=24 with "+N more". onClick(r,i). ── */
function GroupedBar({rows,max=24,onClick}){
  const rs=(Array.isArray(rows)?rows:[]).filter(Boolean);
  if(!rs.length) return <div style={{color:'var(--text-faint)',fontSize:'var(--t12)',padding:'var(--s3)'}}>No data</div>;
  const peak=Math.max(1,...rs.map(r=>Number(r.value)||0));
  const shown=rs.slice(0,max),extra=rs.length-shown.length;
  return <div className="groupbar" role="list">
    {shown.map((r,i)=>{
      const v=Number(r.value)||0,pct=Math.max(0,Math.min(100,(v/peak)*100));
      return <div key={i} className={'groupbar-row'+(onClick?' clickable':'')} role="listitem"
        title={r.detail!=null?String(r.detail):undefined}
        tabIndex={onClick?0:undefined} onClick={onClick?()=>onClick(r,i):undefined}
        onKeyDown={onClick?e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();onClick(r,i);}}:undefined}>
        <span className="groupbar-l" title={String(r.label||'')}>{r.label}</span>
        <span className="groupbar-track"><span className="groupbar-fill" style={{width:pct+'%',background:r.color||'var(--accent)'}}/></span>
        <span className="groupbar-v mono">{v}</span>
      </div>;
    })}
    {extra>0?<div className="groupbar-more">+{extra} more</div>:null}
  </div>;
}

/* ── ExceptionPanel (shared) — the "summarize + defer" primitive: a bounded,
   consequence-ranked exception list that renders INSIDE a Panel (does not replace
   it). Presentational ONLY — callers pass ready rows (already ranked +
   collapseIdentical'd) and a renderRow; the panel never re-sorts, alphabetizes,
   or computes util/free/ranking, and never encodes value by color alone.
   `strip` slots a caller-built distribution bar (ValueBands / segmented) above the
   list. `toneOf` → a 2px left accent border, redundant to the number renderRow
   prints. `rollup` is the "N normal, hidden → View all in table" defer button,
   shown only when count>0. Mirrors GroupedBar's row/keyboard contract
   (Enter+Space, preventDefault, focus-visible ring); an aria-live region speaks
   shown/total so filter/expand changes aren't conveyed by color alone. ── */
function ExceptionPanel({strip,rows,renderRow,toneOf,onRow,rowKey,topK=8,rollup,maxHeight,ariaLabel}){
  const rs=Array.isArray(rows)?rows:[];
  const total=rs.length;
  const shown=rs.slice(0,Math.max(0,topK));
  const label=ariaLabel||'Exceptions';
  return <div className="expanel">
    {strip!=null?<div className="expanel-strip">{strip}</div>:null}
    <div className="exlist" role="list" aria-label={label}
      style={{maxHeight:maxHeight||'var(--body-chart)',overflow:'auto'}}>
      {shown.length
        ? shown.map((r,i)=>{
            const tone=toneOf?toneOf(r):null;
            const key=rowKey?rowKey(r,i):i;
            return <div key={key}
              className={'exrow'+(tone?' tone-'+tone:'')+(onRow?' clickable':'')}
              role={onRow?'button':'listitem'} tabIndex={onRow?0:undefined}
              onClick={onRow?()=>onRow(r,i):undefined}
              onKeyDown={onRow?e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();onRow(r,i);}}:undefined}>
              {renderRow?renderRow(r,i):null}
            </div>;
          })
        : <div className="dt-empty">Nothing to show</div>}
    </div>
    {rollup&&rollup.count>0
      ? <button type="button" className="exrollup" onClick={rollup.onClick}>
          {rollup.label!=null?rollup.label:(rollup.count+' normal, hidden → View all in table')}</button>
      : null}
    <div className="sr-only" aria-live="polite">{label+': showing '+shown.length+' of '+total}</div>
  </div>;
}

/* ── Chart-type toggle (shared) — screenshot-style "Line · Bar · Pie" text control.
   Canonical order line→bar→pie, filtered to allowed `types`. aria-pressed, active=accent. ── */
const CHART_TYPE_ORDER=['line','bar','pie'];
const CHART_TYPE_LABEL={line:'Line',bar:'Bar',pie:'Pie'};
function ChartTypeToggle({value,onChange,types}){
  const allow=CHART_TYPE_ORDER.filter(t=>(types||[]).includes(t));
  if(allow.length<2) return null;
  return <span className="chart-seg" role="group" aria-label="Chart type">
    {allow.map((t,i)=><React.Fragment key={t}>
      {i>0?<span className="sep" aria-hidden="true">·</span>:null}
      <button type="button" aria-pressed={value===t}
        onClick={()=>onChange&&onChange(t)}>{CHART_TYPE_LABEL[t]}</button>
    </React.Fragment>)}
  </span>;
}
/* useChartType(types,def) → [type, toggleNode]. def defaults to first allowed. */
function useChartType(types,def){
  const [t,setT]=useState(def||(types&&types[0]));
  return [t,<ChartTypeToggle value={t} onChange={setT} types={types}/>];
}
/* ChartView({type,data,barMode,donut,onBar}) — one renderer, data=[{label,value,color}].
   pie→Donut, line→Sparkline(values), bar→GroupedBar (or HistogramBar if barMode==='histogram'). */
function ChartView({type,data,barMode,donut,onBar}){
  const d=Array.isArray(data)?data:[];
  if(type==='pie') return <Donut slices={d} {...(donut||{})}/>;
  if(type==='line') return <Sparkline values={d.map(x=>Number(x.value)||0)}/>;
  if(barMode==='histogram')
    return <HistogramBar buckets={d.map(x=>({label:x.label,count:Number(x.value)||0,color:x.color}))} onClick={onBar}/>;
  return <GroupedBar rows={d} onClick={onBar}/>;
}

/* ── HoverCard (shared) — inline-block wrapper; shows a positioned .panel on
   mouseenter/focus, hides on leave/blur/Escape. Fixed-position, viewport-clamped.
   Flavor only (non-essential info). trigger is tabbable; aria-describedby wired. ── */
function HoverCard({content,trigger}){
  const [open,setOpen]=useState(false);
  const [pos,setPos]=useState({x:0,y:0});
  const wrapRef=useRef(null);
  const idRef=useRef('hc-'+Math.random().toString(36).slice(2,8));
  const show=()=>{
    const el=wrapRef.current; if(!el) return;
    const r=el.getBoundingClientRect(),vw=window.innerWidth,vh=window.innerHeight;
    let x=Math.max(8,Math.min(r.left,vw-288)),y=r.bottom+6;
    if(y>vh-40) y=Math.max(8,r.top-6);
    setPos({x,y}); setOpen(true);
  };
  const hide=()=>setOpen(false);
  return <span className="hovercard" ref={wrapRef} tabIndex={0}
    aria-describedby={open?idRef.current:undefined}
    onMouseEnter={show} onMouseLeave={hide} onFocus={show} onBlur={hide}
    onKeyDown={e=>{if(e.key==='Escape')hide();}}>
    {trigger}
    {open?<span id={idRef.current} role="tooltip" className="panel hovercard-pop"
      style={{left:pos.x,top:pos.y}}>{content}</span>:null}
  </span>;
}

/* heatCell(valueFn?, {warn,crit,mode,fmt}) — factory returning a DataTable
   `render(v,row)` that tints the cell via .heat-warn/.heat-crit when the value
   crosses thresholds. mode: 'gt' (default, crit when v>=crit) | 'lt' | 'range'
   (crit when outside [warn,crit]). valueFn optional — omit to use the cell v. */
function heatCell(a,b){
  const valueFn=typeof a==='function'?a:null;
  const opts=(b&&typeof b==='object')?b:((a&&typeof a==='object')?a:{});
  const {warn,crit,mode='gt',fmt,tip}=opts;
  // threshold explainer shown as a native title on tinted cells (P1-2 tooltip contract).
  const thresh=tip||(mode==='range'?('Flagged when value below '+warn+' or above '+crit)
    :mode==='lt'?('Flagged when value at or below '+(crit!=null?crit:warn))
    :('Flagged when value at or above '+(crit!=null?crit:warn)));
  return (v,row)=>{
    const raw=valueFn?valueFn(row):v;
    const num=Number(raw);
    let cls='';
    if(isFinite(num)){
      if(mode==='range') cls=(num<warn||num>crit)?'heat-crit':'';
      else if(mode==='lt') cls=(crit!=null&&num<=crit)?'heat-crit':(warn!=null&&num<=warn?'heat-warn':'');
      else cls=(crit!=null&&num>=crit)?'heat-crit':(warn!=null&&num>=warn?'heat-warn':'');
    }
    const disp=raw==null||raw===''?'—':(fmt?fmt(raw,row):raw);
    return <span className={'heat'+(cls?' '+cls:'')} title={cls?thresh:undefined}>{disp}</span>;
  };
}
/* trendCell(valuesFn) — factory returning a DataTable `render` that drops an
   inline Sparkline; renders '—' unless the array has ≥2 finite points. */
function trendCell(valuesFn){
  return (v,row)=>{
    const arr=valuesFn?valuesFn(row):v;
    const clean=Array.isArray(arr)?arr.filter(x=>typeof x==='number'&&isFinite(x)):[];
    return clean.length>=2?<Sparkline values={clean}/>:<span className="mono" style={{color:'var(--text-faint)'}}>—</span>;
  };
}

/* ─────────────────────────────────────────────────────────────
   REFINED DISPLAY SYSTEM (shared, ported from mockup-refined.html)
   useCountUp / MiniBars / KpiSpark / HoverDetail+useHoverDetail /
   Panel / SectionRule / utilColor / DrawerShift. Neutral, outside all
   regions; wired into tabs by region agents. Read mockup-refined.html
   for the exact visual (CSS ~14-176, JS helpers ~275-451).
   ───────────────────────────────────────────────────────────── */

/* utilColor(u) — REUSED: a top-level function utilColor already exists (NETDNS
   region). Babel compiles this file in strict/module mode, which forbids a
   duplicate declaration, so the shared block references the hoisted one rather
   than redeclaring it. Region agents removing their local copy must relocate the
   canonical definition here (85 crit / 70 warn / 25 accent / else ok). */

/* esc — minimal HTML escape for the HoverDetail innerHTML portal. */
function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];});}

/* sparkSVG — string sparkline (mockup sparkLine) for the imperative HoverDetail card. */
function sparkSVG(vals,w,h,col,fill){
  const v=(Array.isArray(vals)?vals:[]).filter(x=>typeof x==='number'&&isFinite(x));
  if(v.length<2) return '';
  const mn=Math.min(...v),mx=Math.max(...v),rng=(mx-mn)||1;
  const pts=v.map((n,i)=>[i/(v.length-1)*w,h-((n-mn)/rng)*(h-3)-1.5]);
  const d=pts.map((p,i)=>(i?'L':'M')+p[0].toFixed(1)+' '+p[1].toFixed(1)).join(' ');
  const area='M0 '+h+' '+pts.map(p=>'L'+p[0].toFixed(1)+' '+p[1].toFixed(1)).join(' ')+' L'+w+' '+h+' Z';
  return '<svg width="'+w+'" height="'+h+'">'+(fill?'<path d="'+area+'" fill="'+col+'" opacity=".12"/>':'')
    +'<path d="'+d+'" fill="none" stroke="'+col+'" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/></svg>';
}

/* useCountUp(target,dur=650) — cubic ease-out RAF counter; reduced-motion → instant.
   Keyed to mount + value identity so poll re-renders don't restart it. */
function useCountUp(target,dur){
  const to=Number(target)||0;
  const D=dur==null?650:dur;
  const reduce=()=>{try{return matchMedia('(prefers-reduced-motion:reduce)').matches;}catch(e){return false;}};
  const [n,setN]=useState(()=>reduce()?to:0);
  useEffect(()=>{
    if(reduce()||!isFinite(to)||D<=0){setN(to);return;}
    let raf=0,start=null,alive=true;
    const step=t=>{
      if(!alive) return;
      if(start==null) start=t;
      const p=Math.min(1,(t-start)/D);
      setN(Math.round((1-Math.pow(1-p,3))*to));
      if(p<1) raf=requestAnimationFrame(step);
    };
    setN(0); raf=requestAnimationFrame(step);
    return ()=>{alive=false;if(raf)cancelAnimationFrame(raf);};
  },[to,D]);
  return n;
}

/* MiniBars({values,width=56,height=16,color}) — SVG rect bars (mockup miniBars). */
function MiniBars({values,width=56,height=16,color}){
  const v=Array.isArray(values)?values.filter(x=>typeof x==='number'&&isFinite(x)):[];
  if(v.length<2) return null;
  const mx=Math.max(...v)||1,bw=width/v.length,col=color||'var(--accent)';
  return <svg className="rowspark" viewBox={'0 0 '+width+' '+height} width={width} height={height}
      preserveAspectRatio="none" aria-hidden="true">
    {v.map((n,i)=>{const bh=Math.max(1,(n/mx)*height);
      return <rect key={i} x={(i*bw+0.5).toFixed(1)} y={(height-bh).toFixed(1)}
        width={(bw-1).toFixed(1)} height={bh.toFixed(1)} rx="0.5" fill={col}/>;})}
  </svg>;
}

/* KpiSpark({label,value,sub,trend,trendDir,values,color,fill,bars}) — KPI tile with
   count-up number + bottom-right sparkline (MiniBars when bars). trendDir up|dn|flat. */
function KpiSpark({label,value,sub,trend,trendDir,values,color,fill,bars}){
  const isNum=typeof value==='number'&&isFinite(value);
  const counted=useCountUp(isNum?value:0);
  const disp=isNum?counted.toLocaleString():(value==null?'—':value);
  const tc=trendDir==='dn'?'dn':(trendDir==='flat'||trendDir==='fl')?'fl':'up';
  const col=color||'var(--accent)';
  return <div className="kpi">
    <div className="lbl">{label}</div>
    <div className="num">{disp}</div>
    <div className="sub">
      {trend!=null?<span className={'trend '+tc}>{trend}</span>:null}
      {sub!=null?<span className="txt">{sub}</span>:null}
    </div>
    {values?(bars?<MiniBars values={values} width={64} height={26} color={col}/>
      :<Sparkline values={values} width={64} height={26} color={col} fill={fill}/>):null}
  </div>;
}

/* HoverDetail — singleton, cursor-following, edge-aware floating card (mockup #hc).
   Mount <HoverDetail/> once (in Shell); useHoverDetail().bind({title,rows,spark})
   returns the mouse/focus handlers. Pointer-events:none; flavor only. */
let _hdEl=null;
function HoverDetail(){
  const ref=useRef(null);
  useEffect(()=>{_hdEl=ref.current;return ()=>{if(_hdEl===ref.current)_hdEl=null;};},[]);
  return <div ref={ref} className="hoverdetail" aria-hidden="true"/>;
}
function moveHoverDetail(clientX,clientY){
  const el=_hdEl; if(!el) return;
  const pad=14,w=el.offsetWidth,h=el.offsetHeight;
  let x=clientX+16,y=clientY+16;
  if(x+w>window.innerWidth-pad) x=clientX-w-16;
  if(y+h>window.innerHeight-pad) y=clientY-h-16;
  el.style.left=Math.max(pad,x)+'px'; el.style.top=Math.max(pad,y)+'px';
}
function showHoverDetail(d,clientX,clientY){
  const el=_hdEl; if(!el||!d) return;
  const rows=Array.isArray(d.rows)?d.rows:[];
  const spark=(Array.isArray(d.spark)&&d.spark.length>=2)
    ? '<div class="mini">'+sparkSVG(d.spark,236,26,'var(--accent)',true)+'</div>' : '';
  el.innerHTML='<div class="hh"><span class="sd" style="background:var(--accent)"></span>'+esc(d.title)+'</div>'
    +rows.map(r=>'<div class="kv"><span>'+esc(r[0])+'</span><b>'+esc(r[1])+'</b></div>').join('')+spark;
  el.classList.add('show'); moveHoverDetail(clientX,clientY);
}
function hideHoverDetail(){ if(_hdEl) _hdEl.classList.remove('show'); }
/* hoverDescText — flatten a HoverDetail descriptor's {title,rows} into one plain
   string. The visual hovercard (.hoverdetail) is aria-hidden, so bind() also
   stamps this as aria-description on the bound control — the same explanatory
   copy is then in the accessibility tree for screen-reader users. */
function hoverDescText(d){
  if(!d) return '';
  const rows=Array.isArray(d.rows)?d.rows:[];
  const body=rows.map(r=>String(r[0])+': '+String(r[1])).join('. ');
  const title=d.title!=null?String(d.title):'';
  return (title?title+'. ':'')+body;
}
function useHoverDetail(){
  const bind=useCallback(d=>{
    const desc=hoverDescText(d);
    return {
    onMouseEnter:e=>showHoverDetail(d,e.clientX,e.clientY),
    onMouseMove:e=>{ if(_hdEl&&_hdEl.classList.contains('show')) moveHoverDetail(e.clientX,e.clientY); },
    onMouseLeave:hideHoverDetail,
    onFocus:e=>{const r=e.currentTarget.getBoundingClientRect();showHoverDetail(d,r.left+r.width/2,r.bottom);},
    onBlur:hideHoverDetail,
    ...(desc?{'aria-description':desc}:{}),
    };
  },[]);
  return {bind};
}

/* PanelBoundary — catches THROWN render errors from a panel's children so one
   broken card can't blank the whole app (zero error boundaries existed anywhere
   in this codebase before this — confirmed via grep; a single render throw was
   unmounting the entire dashboard to a permanent white screen). Fallback stays
   inside the existing .pcard-max-note text style (no new tokens) + a .btn-ghost
   Retry. componentDidUpdate resets on children identity change so fresh data
   (a real re-render from the parent, not a timer tick) also clears a stuck error,
   not just the manual Retry click. */
class PanelBoundary extends React.Component{
  constructor(p){ super(p); this.state={err:null}; }
  static getDerivedStateFromError(err){ return {err}; }
  componentDidCatch(err,info){ console.error('[PanelBoundary]',err,info); }
  componentDidUpdate(prev){ if(this.state.err&&prev.children!==this.props.children) this.setState({err:null}); }
  render(){
    if(this.state.err) return <div className="pcard-max-note">
      This panel failed to render.
      <button type="button" className="btn btn-ghost" style={{marginLeft:'var(--s2)'}}
        onClick={()=>this.setState({err:null})}>Retry</button>
    </div>;
    return this.props.children;
  }
}

/* Panel({title,side,api,children,empty}) — .pcard wrapper (header + optional .side /
   Freshness). Renders null when empty (dead-section suppression). */
function Panel({title,side,api,children,empty,size}){
  if(empty) return null;
  const [maxed,setMaxed]=useState(false);
  const overlayRef=useRef(null),returnRef=useRef(null);
  let sideNode=side;
  if(sideNode==null&&api) sideNode=<Freshness at={api.fetchedAt} error={api.error} onRetry={api.refetch}/>;
  const hasHead=title!=null||sideNode!=null;
  const open=useCallback(()=>{ returnRef.current=document.activeElement; setMaxed(true); },[]);
  const close=useCallback(()=>{ setMaxed(false);
    const r=returnRef.current; if(r&&r.focus){ try{r.focus();}catch(e){} } },[]);
  // Focus into the overlay + trap Tab / close on Esc — mirrors ShortcutsHelp.
  useEffect(()=>{ if(!maxed||!overlayRef.current) return;
    const f=overlayRef.current.querySelector('button'); if(f) f.focus(); },[maxed]);
  const onKeyDown=e=>{
    if(e.key==='Escape'){ e.preventDefault(); e.stopPropagation(); close(); return; }
    if(e.key==='Tab'){
      const f=overlayRef.current?Array.from(overlayRef.current.querySelectorAll('button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])')):[];
      if(!f.length) return;
      const first=f[0],last=f[f.length-1];
      if(e.shiftKey&&document.activeElement===first){ e.preventDefault(); last.focus(); }
      else if(!e.shiftKey&&document.activeElement===last){ e.preventDefault(); first.focus(); }
    }
  };
  const maxBtn=hasHead?<button type="button" className="pcard-max" title="Maximize"
    aria-label={"Maximize "+(title!=null?title:"panel")} onClick={open}>⤢</button>:null;
  const head=hasHead?<h3>
    <span>{title}</span>
    <span className="side">{sideNode}{maxBtn}</span>
  </h3>:null;
  return <div className={"pcard"+(size?(" sz-"+size):"")}>
    {head}
    {maxed
      ? <div className="pcard-max-note">Maximized — press Esc or Close to return.</div>
      : <PanelBoundary>{children}</PanelBoundary>}
    {maxed?<div className="pcard-scrim" onClick={close}>
      <div ref={overlayRef} className="pcard-overlay panel" role="dialog" aria-modal="true"
        aria-label={(title!=null?title:"Panel")+" (maximized)"}
        onClick={e=>e.stopPropagation()} onKeyDown={onKeyDown}>
        <div className="pcard-overlay-head">
          <h3 className="pcard-overlay-title">{title!=null?title:"Panel"}</h3>
          <button type="button" className="btn btn-ghost" onClick={close}
            aria-label={"Close maximized "+(title!=null?title:"panel")}>Close</button>
        </div>
        <div className="pcard-overlay-body"><PanelBoundary>{children}</PanelBoundary></div>
      </div>
    </div>:null}
  </div>;
}

/* SectionRule({title}) — .sec-h heading with trailing rule. */
function SectionRule({title}){
  return <div className="sec-h"><h2>{title}</h2><span className="rule"/></div>;
}

/* PageHeader({title,subtitle,actions}) — consistent tab-level page header
   (title + optional subtitle + optional right-aligned actions). */
function PageHeader({title,subtitle,actions}){
  return <div className="page-head">
    <div className="page-head-main">
      <h2 className="page-title">{title}</h2>
      {subtitle?<p className="page-sub">{subtitle}</p>:null}
    </div>
    {actions?<div className="page-actions">{actions}</div>:null}
  </div>;
}

/* DrawerShift — reflows .main beside the right drawers. Sets html[data-drawer]
   from usePower().peek + aiOpen; CSS pads .main (overlay kept on mobile). */
function DrawerShift({aiOpen}){
  const power=usePower();
  const open=!!((power&&power.peek)||aiOpen);
  useEffect(()=>{
    document.documentElement.dataset.drawer=open?'open':'';
    return ()=>{document.documentElement.dataset.drawer='';};
  },[open]);
  return null;
}

/* AiExplain — modal (reuses .palette-scrim) that correlates the given rows via
   POST /api/query. compactRows caps to 25 rows / minimal fields. Escape closes,
   light-touch focus trap. useAiExplain() → {open(rows), node, close} for wiring. */
const AI_EXPLAIN_Q="Correlate these DNS security events: identify common patterns, likely root cause, blast radius (devices/networks affected), and recommended next actions. Be concise.";
function compactRows(rows){
  const list=Array.isArray(rows)?rows.slice(0,25):[];
  return list.map(r=>{
    if(!r||typeof r!=='object') return r;
    const o={}; let n=0;
    for(const k in r){ if(n>=10) break; const val=r[k]; if(val==null) continue;
      const t=typeof val;
      if(t==='string'){ o[k]=val.length>120?val.slice(0,120):val; n++; }
      else if(t==='number'||t==='boolean'){ o[k]=val; n++; }
    }
    return o;
  });
}
function AiExplain({rows,onClose}){
  const [state,setState]=useState('run'); // run | done | err
  const [ans,setAns]=useState('');
  const [sugg,setSugg]=useState([]);
  const [trace,setTrace]=useState(null);
  const [err,setErr]=useState('');
  const panelRef=useRef(null),closeRef=useRef(null);
  useEffect(()=>{
    let alive=true;
    const ctx=JSON.stringify(compactRows(rows)).slice(0,7500);
    fetch('/api/query',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({question:AI_EXPLAIN_Q,context:ctx})})
      .then(async r=>{const j=await r.json().catch(()=>null);return {r,j};})
      .then(({r,j})=>{ if(!alive) return;
        if(r.status===503||(j&&j.locked)){ window.dispatchEvent(new CustomEvent('bx:vault-locked')); setErr('Vault locked — unlock to analyze.'); setState('err'); return; }
        if(j&&j.unavailable){ setErr('AI analysis unavailable — set an LLM provider in account settings.'); setState('err'); return; }
        if(j&&j.error){ setErr(String(j.error)); setState('err'); return; }
        if(!r.ok&&!(j&&typeof j.answer==='string')){ setErr('HTTP '+r.status); setState('err'); return; }
        setAns((j&&typeof j.answer==='string')?j.answer:'No analysis returned.');
        setSugg((j&&Array.isArray(j.suggestions))?j.suggestions:[]);
        setTrace((j&&Array.isArray(j.trace))?j.trace:null);
        setState('done');
      })
      .catch(()=>{ if(alive){ setErr('Analysis failed — server unreachable.'); setState('err'); } });
    return ()=>{alive=false;};
  },[]); // eslint-disable-line
  useEffect(()=>{ if(closeRef.current) closeRef.current.focus(); },[]);
  const onKeyDown=e=>{
    if(e.key==='Escape'){ e.preventDefault(); onClose&&onClose(); return; }
    if(e.key==='Tab'&&panelRef.current){
      const f=panelRef.current.querySelectorAll('button,a[href],input,[tabindex]:not([tabindex="-1"])');
      if(!f.length) return; const first=f[0],last=f[f.length-1];
      if(e.shiftKey&&document.activeElement===first){ e.preventDefault(); last.focus(); }
      else if(!e.shiftKey&&document.activeElement===last){ e.preventDefault(); first.focus(); }
    }
  };
  const cnt=Array.isArray(rows)?Math.min(rows.length,25):0;
  return <div className="palette-scrim" style={{alignItems:'center',paddingTop:0}}
      onMouseDown={e=>{ if(e.target===e.currentTarget) onClose&&onClose(); }}>
    <div ref={panelRef} className="panel" role="dialog" aria-modal="true" aria-label="AI analysis"
      onKeyDown={onKeyDown}
      style={{width:'min(620px,94vw)',maxHeight:'80vh',overflowY:'auto',padding:'var(--s5)'}}>
      <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',gap:'var(--s3)',marginBottom:'var(--s4)'}}>
        <span style={{fontSize:'var(--t14)',fontWeight:600}}>AI correlation · {cnt} event{cnt===1?'':'s'}</span>
        <button ref={closeRef} className="peek-close" aria-label="Close analysis" onClick={()=>onClose&&onClose()}>✕</button>
      </div>
      {state==='run'?<div className="mono" style={{color:'var(--text-dim)',fontSize:'var(--t12)'}}>Analyzing… (LLM — may take a moment)</div>:null}
      {state==='err'?<div style={{color:'var(--text-faint)',fontSize:'var(--t12)'}}>{err}</div>:null}
      {state==='done'?<div>
        <div className="prose" style={{whiteSpace:'pre-wrap',fontSize:'var(--t13)',lineHeight:1.5}}>{ans}</div>
        {sugg.length?<div style={{display:'flex',flexWrap:'wrap',gap:'var(--s2)',marginTop:'var(--s4)'}}>
          {sugg.map((s,i)=><span key={i} className="chip">{s}</span>)}
        </div>:null}
        {trace&&trace.length?<div className="mono" style={{marginTop:'var(--s4)',paddingLeft:'var(--s3)',borderLeft:'1px solid var(--border)',display:'flex',flexDirection:'column',gap:4}}>
          {trace.map((t,i)=><div key={i} style={{fontSize:'var(--t11)',color:'var(--text-faint)'}}>{t&&t.tool} <span>{t?JSON.stringify(t.args):''}</span></div>)}
        </div>:null}
      </div>:null}
    </div>
  </div>;
}
function useAiExplain(){
  const [rows,setRows]=useState(null);
  const open=useCallback(r=>setRows(Array.isArray(r)?r:[]),[]);
  const close=useCallback(()=>setRows(null),[]);
  const node=rows?<AiExplain rows={rows} onClose={close}/>:null;
  return {open,node,close};
}

// ═══ REGION: OVERVIEW ═══
/* Overview — compact stat strip (6 tiles) → controls (Problems-only/All
   scope segment + removable utilization-band chips) → detail grid: capacity
   by site, host status donut + attention list, all-leases table, triage
   queue with per-row provision action. Real data only. */
(function injectOverviewStyles(){
  if(document.getElementById('bx-ov-styles')) return;
  const s=document.createElement('style');s.id='bx-ov-styles';
  s.textContent=`
  .ovx table{border-collapse:collapse;}
  .ovx thead th{text-align:left;color:var(--text-faint);font-weight:600;font-size:10px;text-transform:uppercase;letter-spacing:.1em;padding:6px 16px 6px 0;border-bottom:1px solid var(--border);white-space:nowrap;}
  .ovx tbody td{padding:7px 16px 7px 0;border-bottom:1px solid var(--border2);white-space:nowrap;}
  /* fixed layout + a real right-pad gap: every cell (incl. the primary) clips with ellipsis, so
     columns are always separated and nothing bleeds — no overlap, no horizontal scroll in the panel.
     (Overrides the shared table.dt .dt-primary overflow:visible, which caused the bleed.) */
  .ovx thead th,.ovx tbody td,.ovx table.dt td.dt-primary,.ovx table.dt th.dt-primary{overflow:hidden;text-overflow:ellipsis;}
  .ovx td .code,.ovx td .tag{display:inline-block;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;vertical-align:bottom;}
  .ovx tbody tr{cursor:pointer;transition:background .1s ease;}
  .ovx tbody tr:hover{background:var(--raised);}
  .ovx tbody tr:last-child td{border-bottom:0;}
  .ovx td.r,.ovx th.r{text-align:right;}
  .ovx .code{font-family:'GeistMono',ui-monospace,monospace;border-bottom:1px dotted var(--text-faint);cursor:help;}
  .ovx .lchip{font-size:10px;font-weight:600;padding:2px 7px;border-radius:var(--r-ctl);text-transform:uppercase;letter-spacing:.3px;background:var(--raised);display:inline-block;}
  .ovx .ov-mt{margin-top:8px;}
  /* DETAIL grid (v1 Bloomberg layout) — 12-col span shell for the 5 dashboard panels. */
  .ovx-detail{display:grid;grid-template-columns:repeat(12,minmax(0,1fr));gap:16px;align-items:stretch;grid-auto-flow:dense;min-width:0;}
  .ovx-detail>*{min-width:0;}
  .ovx-detail .span-3{grid-column:span 3;}
  .ovx-detail .span-4{grid-column:span 4;}
  .ovx-detail .span-6{grid-column:span 6;}
  .ovx-detail .span-8{grid-column:span 8;}
  .ovx-detail .span-12{grid-column:span 12;}
  /* Intermediate step: below ~1366px a span-3/4 track is <300px — too narrow for
     donut legends and action rows — so promote to half/full width before the
     single-column collapse at 1100px. */
  @media (min-width:1101px) and (max-width:1366px){
    .ovx-detail .span-3,.ovx-detail .span-4{grid-column:span 6;}
    .ovx-detail .span-6,.ovx-detail .span-8{grid-column:span 12;}
  }
  @media (max-width:1100px){
    .ovx-detail{grid-template-columns:minmax(0,1fr);}
    .ovx-detail .span-3,.ovx-detail .span-4,.ovx-detail .span-6,.ovx-detail .span-8,.ovx-detail .span-12{grid-column:auto;}
  }

  /* Compact inline stat strip — replaces the old full-width verdict banner. */
  .ovx .statstrip{display:flex;flex-wrap:wrap;gap:0;margin:0 2px;border:1px solid var(--border);border-radius:var(--r-panel);background:var(--surface);overflow:hidden;}
  .ovx .stat{padding:8px 16px;border-left:1px solid var(--border);display:flex;flex-direction:column;justify-content:center;gap:2px;min-width:0;flex:1 1 0;}
  .ovx .stat:first-child{border-left:0;}
  .ovx .stat .k{font-size:10px;color:var(--text-faint);text-transform:uppercase;letter-spacing:.4px;white-space:nowrap;}
  .ovx .stat .v{font-size:16px;font-weight:600;font-family:'GeistMono',ui-monospace,monospace;display:flex;align-items:baseline;gap:6px;}
  .ovx .stat .v small{font-size:11px;font-weight:500;color:var(--text-faint);}
  .ovx .stat .v.crit{color:var(--crit);}
  .ovx .stat .v.warn{color:var(--warn);}

  /* Control row — segmented Problems-only/All-subnets scope + removable util-band chips. */
  .ovx .controls{display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin:0 2px;}
  .ovx .seg{display:inline-flex;border:1px solid var(--border-strong);border-radius:var(--r-ctl);overflow:hidden;}
  .ovx .seg button{font:inherit;font-size:11px;cursor:pointer;border:0;background:var(--raised);color:var(--text-dim);padding:5px 11px;display:flex;align-items:center;gap:6px;border-right:1px solid var(--border);}
  .ovx .seg button:last-child{border-right:0;}
  .ovx .seg button[aria-pressed="true"]{background:var(--accent);color:#fff;font-weight:600;}
  .ovx .seg button:focus-visible{outline:2px solid var(--accent-text);outline-offset:-2px;}
  .ovx .seg .glyph{width:12px;text-align:center;}
  .ovx .seg-lbl{font-size:11px;color:var(--text-faint);}
  .ovx .seg-lbl b{color:var(--text);font-weight:600;}
  .ovx .chips-lbl{font-size:10px;color:var(--text-faint);text-transform:uppercase;letter-spacing:.4px;}
  .ovx .chips{display:flex;gap:7px;align-items:center;flex-wrap:wrap;}
  .ovx .band-chip{display:inline-flex;align-items:center;gap:6px;height:auto;padding:3px 6px 3px 9px;cursor:pointer;}
  .ovx .band-chip .cnt{color:var(--text);font-weight:600;}
  .ovx .band-chip .x{color:var(--text-faint);width:13px;text-align:center;}
  .ovx .band-chip.off{color:var(--text-faint);text-decoration:line-through;text-decoration-color:var(--text-faint);}
  .ovx .band-chip.off .cnt{color:var(--text-faint);}

  /* Triage queue rows — worst-first subnets + real action buttons. */
  /* Actions live on their own row under the label — an auto track of 4 buttons
     (~300px max-content) starves the 1fr label to nothing in a span-4 card. */
  .ovx .triage-row{display:grid;grid-template-columns:18px minmax(0,1fr);gap:4px 10px;padding:8px 4px;border-bottom:1px solid var(--border2);align-items:center;}
  .ovx .triage-row:last-child{border-bottom:0;}
  .ovx .triage-row .idx{font-size:10px;color:var(--text-faint);text-align:right;}
  .ovx .triage-row .what{min-width:0;}
  .ovx .triage-row .what .meta{font-size:10px;color:var(--text-dim);margin-top:2px;}
  .ovx .triage-row .act{grid-column:2;display:flex;gap:5px;flex-wrap:wrap;}
  .ovx .btn-accent{background:var(--accent);border-color:var(--accent);color:#fff;}
  .ovx .btn-accent:hover{background:var(--accent);border-color:var(--accent);}

  /* Capacity heatmap — replaces the old scrolling Capacity-by-site bar list.
     No color-only state: every band/cell also carries a text label (legend)
     and a hover/focus detail card with the real numbers. */
  .ovx .dist-wrap{display:flex;flex-direction:column;gap:var(--s2);}
  .ovx .dist-bar{display:flex;height:22px;border-radius:var(--r-ctl);overflow:hidden;border:1px solid var(--border);}
  .ovx .dist-seg{border:0;padding:0;min-width:2px;cursor:pointer;transition:opacity .12s ease;}
  .ovx .dist-seg.off{opacity:.3;}
  .ovx .dist-seg:focus-visible{outline:2px solid var(--accent-text);outline-offset:-2px;}
  .ovx .dist-legend{display:flex;gap:var(--s4);flex-wrap:wrap;font-size:11px;color:var(--text-dim);}
  .ovx .dist-legend b{color:var(--text);font-weight:600;}
  /* Feature 9 — legend swatches are now real buttons (same toggleBandCross as the
     dist-seg bar), so they need button-reset styling to keep the original plain-text look. */
  .ovx .dist-legend-sw{font:inherit;font-size:11px;color:var(--text-dim);background:none;border:0;padding:0;
    cursor:pointer;display:inline-flex;align-items:center;transition:opacity .12s ease;}
  .ovx .dist-legend-sw.off{opacity:.4;}
  .ovx .dist-legend-sw:focus-visible{outline:2px solid var(--accent-text);outline-offset:1px;}
  .ovx .sw{width:8px;height:8px;border-radius:2px;display:inline-block;margin-right:5px;vertical-align:-1px;flex:none;}
  .ovx .sw.crit{background:var(--crit);}
  .ovx .sw.warn{background:var(--warn);}
  .ovx .sw.ok{background:var(--ok);opacity:.6;}

  .ovx .heatmap-wrap{margin-top:var(--s4);}
  .ovx .heatmap{display:grid;grid-template-columns:repeat(auto-fill,minmax(14px,1fr));gap:3px;}
  .ovx .heatcell{aspect-ratio:1;border-radius:2px;cursor:pointer;min-width:0;}
  .ovx .heatcell:hover,.ovx .heatcell:focus-visible{outline:2px solid var(--accent-text);outline-offset:1px;z-index:1;}
  .ovx .heatcell.crit{background:var(--crit);}
  .ovx .heatcell.warn{background:var(--warn);}
  .ovx .heatcell.ok{background:var(--ok);opacity:.6;}
  .ovx .heatmap-legend{display:flex;align-items:center;gap:var(--s4);flex-wrap:wrap;font-size:11px;color:var(--text-dim);margin-top:var(--s2);}
  .ovx .heatmap-note{margin-left:auto;color:var(--text-faint);}
  `;
  document.head.appendChild(s);
})();

/* OvPeek — region-local peek body (not a shared component). Renders a title,
   optional sub-line, and a key/value list (skips empty values). Fed the same
   field lists the old hover cards built, so clicking a preview row shows all. */
function OvPeek({title,sub,rows}){
  return <div>
    <div style={{fontWeight:600}}>{title||'—'}</div>
    {sub!=null&&sub!==''?<div className="mono" style={{color:'var(--text-dim)',marginTop:4,fontSize:'var(--t12)'}}>{sub}</div>:null}
    <div style={{marginTop:8,display:'flex',flexDirection:'column',gap:3}}>
      {(rows||[]).filter(r=>r&&r[1]!=null&&r[1]!=='').map((r,i)=>
        <div key={i} style={{display:'flex',justifyContent:'space-between',gap:12,fontSize:'var(--t12)'}}>
          <span style={{color:'var(--text-faint)'}}>{r[0]}</span>
          <span className="mono" style={{textAlign:'right'}}>{String(r[1])}</span>
        </div>)}
    </div>
  </div>;
}

// Feature 9 — util-band id → inclusive "lo-hi" range string, the same convention
// filterMatchesRow (~998) understands. '100' is open-ended above so it's given a
// generous ceiling rather than a real upper bound.
const UTIL_BAND_RANGE={'100':'100-999999','9099':'90-99','7089':'70-89','lt70':'0-69'};

