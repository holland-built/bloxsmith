function saveCurrentView(name,folder){
  const {tab,params}=parseHash();
  const route={tab,params};
  return fetch('/api/views',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({name,widgets:{},order:[],layout:{route},folder:folder||'',saved_at:new Date().toISOString(),route})})
    .then(async r=>{const j=await r.json().catch(()=>({}));return {ok:r.ok&&j.ok!==false,error:j&&j.error};});
}
function applyViewByName(name){
  fetch('/api/views/'+encodeURIComponent(name))
    .then(r=>r.ok?r.json():Promise.reject('HTTP '+r.status))
    .then(v=>{
      const route=(v&&v.route)||(v&&v.layout&&v.layout.route)||null;
      if(route&&route.tab){ nav(route.tab,route.params||{}); toast('View "'+name+'" applied','ok'); }
      else toast('Legacy view — no route stored','warn');
    })
    .catch(()=>toast('Could not load view "'+name+'"','err'));
}

/* ─────────────────────────────────────────────────────────────
   Watch expressions (P1 slice 7) — a "watch" is just a saved BQL
   query (name + tab + query string) persisted in the SAME bx. LS
   namespace as saved views/scratchpad. Poor-man's alerting: a live
   MATCH COUNT is computed client-side from the shared /api/data feed
   via the existing parseQuery/deriveSchema/buildPredicate — no alert
   engine, no polling, no server. Clicking a watch re-applies its
   query through the existing sq= hash surface (nav). On-demand only.
   ───────────────────────────────────────────────────────────── */
const WATCH_KEY='watches';
function readWatches(){ const v=LS.get(WATCH_KEY,[]); return Array.isArray(v)?v:[]; }
function writeWatches(list){ LS.set(WATCH_KEY,Array.isArray(list)?list:[]); try{window.dispatchEvent(new CustomEvent('bx:watches'));}catch(e){} }
function addWatch(w){ if(!w||!w.name) return; const list=readWatches().filter(x=>x.name!==w.name); list.push(w); writeWatches(list); }
function removeWatch(name){ writeWatches(readWatches().filter(x=>x.name!==name)); }
// watchRows — the primary-entity rows for a tab, read from the shared /api/data
// body (same accessor the tab components use). Watches count against these.
function watchRows(data,tab){
  if(!data||typeof data!=='object') return [];
  switch(tab){
    case 'dns': return Array.isArray(data.zones)?data.zones:[];
    case 'infra': return Array.isArray(data.hosts)?data.hosts:[];
    case 'network':
    default: return Array.isArray(data.subnets)?data.subnets:[];
  }
}
// watchCount — live count of rows matching a watch's BQL query. Reuses the exact
// parse → schema → predicate pipeline the table search uses, so counts match the
// filtered view. Never throws (bad query → 0).
function watchCount(data,watch){
  if(!watch||!watch.query) return 0;
  const rows=watchRows(data,watch.tab);
  if(!rows.length) return 0;
  try{
    const cols=Object.keys(rows[0]||{}).map(k=>({key:k}));
    const schema=deriveSchema(cols,rows,{});
    const pred=buildPredicate(parseQuery(watch.query),schema);
    return rows.filter(pred).length;
  }catch(e){ return 0; }
}

/* Alert rules — LS-only thresholds polled against /api/data every 120s. */
const ALERT_DEFAULTS={subnetUtilOn:false,subnetUtil:85,hostOfflineOn:false};
function AlertRulesPanel(){
  const [rules,setRules]=useState(()=>({...ALERT_DEFAULTS,...LS.get('alertRules',{})}));
  const firedRef=useRef({});
  const save=next=>{setRules(next);LS.set('alertRules',next);};
  const toggle=(key,on)=>{
    if(on&&typeof Notification!=='undefined'&&Notification.permission==='default'){
      try{Notification.requestPermission();}catch(e){}
    }
    save({...rules,[key]:on});
  };
  const anyOn=rules.subnetUtilOn||rules.hostOfflineOn;
  useEffect(()=>{
    if(!anyOn) return;
    let alive=true;
    const notify=m=>{
      toast(m,'warn');
      if(typeof Notification!=='undefined'&&Notification.permission==='granted'){
        try{new Notification('Bloxsmith alert',{body:m});}catch(e){}
      }
    };
    const check=()=>{
      fetch('/api/data',{cache:'no-store'}).then(r=>r.ok?r.json():null).then(d=>{
        if(!alive||!d||d.locked||d.error) return;
        if(rules.subnetUtilOn){
          const thr=Number(rules.subnetUtil)||85;
          (d.subnets||[]).forEach(s=>{
            if((s.util||0)>=thr){
              const k='sub:'+(s.id||s.name);
              if(!firedRef.current[k]){firedRef.current[k]=1;notify('Subnet '+(s.name||s.addr)+' at '+s.util+'% utilization (threshold '+thr+'%)');}
            }
          });
        }
        if(rules.hostOfflineOn){
          (d.hosts||[]).forEach(h=>{
            if(h.status==='offline'){
              const k='host:'+(h.id||h.name);
              if(!firedRef.current[k]){firedRef.current[k]=1;notify('Host '+(h.name||h.id)+' is offline');}
            }
          });
        }
      }).catch(()=>{});
    };
    check();
    const iv=setInterval(check,120000);
    return ()=>{alive=false;clearInterval(iv);};
  },[anyOn,rules.subnetUtilOn,rules.hostOfflineOn,rules.subnetUtil]);
  return <div className="panel" style={{padding:16}}>
    <div style={{fontSize:12,fontWeight:600}}>Alerts</div>
    <div style={{fontSize:11,color:'var(--text-faint)',margin:'4px 0 8px'}}>
      Checked every 2 minutes while this tab is open. Fires a toast plus a browser notification when permitted.
    </div>
    <label className="alerts-row">
      <input type="checkbox" checked={!!rules.subnetUtilOn} onChange={e=>toggle('subnetUtilOn',e.target.checked)}/>
      <span>Subnet utilization at or above</span>
      <input className="alerts-num mono" type="number" min="1" max="100" value={rules.subnetUtil}
        onChange={e=>save({...rules,subnetUtil:e.target.value})} aria-label="Subnet utilization threshold percent"/>
      <span>%</span>
    </label>
    <label className="alerts-row">
      <input type="checkbox" checked={!!rules.hostOfflineOn} onChange={e=>toggle('hostOfflineOn',e.target.checked)}/>
      <span>Any infrastructure host offline</span>
    </label>
  </div>;
}

/* AiDrawer — non-modal right-side AI console over POST /api/query. Mounted in
   Shell (persists across tab switches). This is a functional prop-shell rename of
   the former AskTab; R5 fills/polishes the content. The submit builds an implicit
   context string from the current route + active table state (filter/selection). */
function AiDrawer({open,onClose,initialQ}){
  const power=usePower();
  const {data}=useData();
  const [input,setInput]=useState('');
  const [busy,setBusy]=useState(false);
  const [items,setItems]=useState([]); // newest first, capped at 5
  const askedRef=useRef(null);
  const inRef=useRef(null);
  const drawerRef=useRef(null);
  const [ctx,setCtx]=useState('');
  // Live short context label (mirrors what buildContext() sends on submit).
  useEffect(()=>{
    const upd=()=>{try{const {tab}=parseHash();setCtx((typeof TAB_LABELS!=='undefined'&&TAB_LABELS[tab])||tab||'');}catch(e){setCtx('');}};
    upd(); window.addEventListener('hashchange',upd);
    return ()=>window.removeEventListener('hashchange',upd);
  },[]);
  const push=entry=>setItems(list=>[{id:Date.now()+Math.random(),...entry},...list].slice(0,5));
  // Implicit tab context — current route + active DataTable state (filter/selection).
  const buildContext=()=>{
    try{
      const {tab}=parseHash();
      const a=power&&power.getActive&&power.getActive();
      const st=a&&a.api&&a.api.current&&a.api.current.getState&&a.api.current.getState();
      return 'User is on the '+tab+' tab'
        +(st&&st.filter?', table filter "'+st.filter+'"':'')
        +(st&&st.selected&&st.selected.size?', '+st.selected.size+' rows selected':'')+'.';
    }catch(e){ return ''; }
  };
  const submit=(qArg)=>{
    const q=String(qArg!=null?qArg:input).trim();
    if(!q||busy) return;
    setBusy(true);
    fetch('/api/query',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({question:q,context:buildContext()})})
      .then(async r=>{const j=await r.json().catch(()=>null);return {r,j};})
      .then(({r,j})=>{
        if(r.status===503||(j&&j.locked)){
          window.dispatchEvent(new CustomEvent('bx:vault-locked'));
          push({q,error:'Vault locked — unlock to query.'});
          return;
        }
        if(j&&j.error){ push({q,error:String(j.error)}); return; }
        if(!r.ok&&!(j&&typeof j.answer==='string')){ push({q,error:'HTTP '+r.status}); return; }
        push({
          q,
          answer:(j&&typeof j.answer==='string')?j.answer:'Query returned an unexpected response.',
          suggestions:(j&&Array.isArray(j.suggestions))?j.suggestions:[],
          trace:(j&&Array.isArray(j.trace))?j.trace:null,
        });
      })
      .catch(()=>toast('Query failed — server unreachable','err'))
      .finally(()=>setBusy(false));
  };
  // Slide: CSS class alone proved unreliable here (computed transform stuck
  // off-canvas), so drive transform/visibility inline with !important — authoritative.
  useEffect(()=>{
    const el=drawerRef.current; if(!el) return;
    el.style.setProperty('transform',open?'none':'translateX(100%)','important');
    el.style.setProperty('visibility',open?'visible':'hidden','important');
    el.style.setProperty('pointer-events',open?'auto':'none','important');
  },[open]);
  // Focus the input when the drawer opens (non-modal — no focus trap).
  useEffect(()=>{ if(open&&inRef.current) inRef.current.focus(); },[open]);
  // Click-off + window Escape close (trigger/toasts/action-bar exempt so they don't self-close).
  useEffect(()=>{
    if(!open) return;
    const onDown=e=>{
      const t=e.target;
      if(t&&t.closest&&(t.closest('.ai-drawer')||t.closest('.ai-trigger')||t.closest('.toast')||t.closest('.action-bar'))) return;
      onClose();
    };
    const onEsc=e=>{ if(e.key==='Escape'){ e.preventDefault(); onClose(); } };
    document.addEventListener('pointerdown',onDown);
    window.addEventListener('keydown',onEsc);
    return ()=>{ document.removeEventListener('pointerdown',onDown); window.removeEventListener('keydown',onEsc); };
  },[open,onClose]);
  // initialQ handoff (palette / bx:ai-open / #ask?q=…): prefill + submit once per distinct q.
  useEffect(()=>{
    if(!open) return;
    const q=initialQ;
    if(q&&askedRef.current!==q){ askedRef.current=q; setInput(q); submit(q); }
  },[open,initialQ]); // eslint-disable-line

  // ── suggested questions (real inventory numbers + threat-intel-aware) ──
  const nZone=((data&&data.zones)||[]).length;
  const nHost=((data&&data.hosts)||[]).length;
  // A real flagged domain from the live security events (highest-severity first).
  const evs=(data&&Array.isArray(data.events))?data.events:[];
  const flagged=((evs.find(e=>/crit|high/i.test(String(e&&e.severity||'')))||evs[0]||{}).qname)||'';
  const ask=q=>{setInput(q);submit(q);};
  const suggestions=[
    'Which subnets are nearly full?',
    flagged?'Is '+flagged+' malicious?':'Which domains are on threat feeds?',
    'Any lookalike domains of my brand?',
    'Are any of my '+nZone+' DNS zones misconfigured?',
    'Which of '+nHost+' hosts are offline?',
    'What changed in the last 24 hours?',
  ];

  // Stays mounted across open/close so the conversation (items) survives — slide handled above.
  return <aside ref={drawerRef} className="ai-drawer" role="complementary" aria-label="AI assistant"
    data-open={open?'':undefined} aria-hidden={open?undefined:'true'}
    onKeyDown={e=>{if(e.key==='Escape'){e.preventDefault();onClose();}}}>
    <div className="ai-drawer-head">
      <span className="ai-drawer-title"><span className="ai-dot"/>Ask AI</span>
      <button className="peek-close" aria-label="Close AI assistant" onClick={onClose}>✕</button>
    </div>
    <div className="ai-drawer-body">
      <div className="ai-ctx mono">Context: {ctx?ctx+' tab':'dashboard'}</div>
      <div className="ai-convo">
        {items.length===0&&!busy&&
          <div className="ai-empty">Ask a question or pick a suggestion below.</div>}
        {items.map(it=>
          <div key={it.id} className="panel ask-item">
            <div className="ask-q mono">&gt; {it.q}</div>
            {it.error
              ? <div className="ask-err">{it.error}</div>
              : <div className="ask-a prose">{it.answer}</div>}
            {!!(it.suggestions&&it.suggestions.length)&&<div className="ask-chips">
              {it.suggestions.map((sg,i)=>
                <button key={i} className="chip chip-btn" onClick={()=>ask(sg)}>{sg}</button>)}
            </div>}
            {!!(it.trace&&it.trace.length)&&<div className="ask-trace mono">
              {it.trace.map((t,i)=><div key={i} className="ask-trace-row">
                <span>{t.tool}</span> <span className="args">{JSON.stringify(t.args)}</span>
              </div>)}
            </div>}
          </div>)}
      </div>
      <div className="ai-foot">
        <div className="ask-chips">
          {suggestions.map((sg,i)=><button key={i} className="chip chip-btn" onClick={()=>ask(sg)}>{sg}</button>)}
        </div>
        <div className="ask-bar">
          <input ref={inRef} className="ask-in mono" placeholder="Ask about your network…"
            value={input} onChange={e=>setInput(e.target.value)}
            onKeyDown={e=>{if(e.key==='Enter')submit();}}
            aria-label="Natural-language query"/>
          <button className="btn" style={{height:36}} onClick={()=>submit()} disabled={busy||!input.trim()}>Ask</button>
        </div>
        {busy&&<div className="ask-busy mono">Analyzing…</div>}
        <details className="ai-disclosure">
          <summary>Alerts</summary>
          <AlertRulesPanel/>
        </details>
      </div>
    </div>
  </aside>;
}

/* AuditTab — immutable audit log from /api/audit/log (SHA-256 hash-chained,
   port of Chris Marrison's backend/audit/log.py). Chain integrity is
   re-verified server-side on every poll; a broken chain means an entry was
   edited or removed outside audit_append(). */
function AuditTab(){
  const {data,error,locked,fetchedAt,refetch,loading}=useApi('/api/audit/log',{poll:15000});
  // Expose a stringified `_detail` so free-text BQL search reaches the JSON detail
  // blob (e.g. `teardown`) — the `detail` column itself stays the raw object.
  const rows=useMemo(()=>((data&&data.entries)||[]).map(r=>({...r,
    _detail:(r.detail&&typeof r.detail==='object'&&Object.keys(r.detail).length)?JSON.stringify(r.detail):''})),[data]);
  const chainValid=data?data.chain_valid:null;
  const cols=[
    {key:'ts',label:'Time',mono:true,align:'left',width:190,
      render:v=>v==null?'—':new Date(parseTs(v)).toLocaleString()},
    {key:'actor',label:'Actor',mono:true},
    {key:'event',label:'Event'},
    {key:'detail',label:'Detail',flex:true,render:v=>
      <span className="mono" style={{fontSize:11,color:'var(--text-dim)'}}>{v&&Object.keys(v).length?JSON.stringify(v):'—'}</span>},
  ];

  const total=rows.length;
  const tone=chainValid===false?'crit':'ok';
  const verdict=chainValid===false
    ? 'Audit chain BROKEN at entry '+data.broken_index+' — log may have been tampered with'
    : total+' audit '+(total===1?'entry':'entries')+', hash chain intact';

  return <div className="page">
    <SynthBand tone={tone} verdict={verdict} facts={[]}/>

    <div className="dash">
      <div className="dc24 t-lg">
        <Panel title="Audit log" size="lg"
          side={<span style={{display:'inline-flex',alignItems:'center',gap:'var(--s3)'}}>
            {chainValid!=null && <Astryx.Badge variant={chainValid?'success':'error'} label={chainValid?'Chain valid':'Chain broken'}/>}
            <AuditExportButton/>
            <Freshness at={fetchedAt} error={error} onRetry={refetch}/>
          </span>}>
          {loading&&!data
            ? <Skeleton rows={6}/>
            : locked
              ? <div className="dt-empty">Vault locked — unlock to load the audit log.</div>
              : error
                ? <ErrorState error={error} onRetry={refetch}/>
                : <DataTable cols={cols} rows={rows} defaultSort={{key:'ts',dir:'desc'}} csvName="audit"
                    tableId="audit" rowKey={r=>String(r.hash||((r.ts||'')+'|'+(r.actor||'')+'|'+(r.event||'')))}
                    maxRows={50} selectable filterable filterKeys={['actor','event','_detail']}/>}
        </Panel>
      </div>

      <div className="dc24 t-lg">
        <CspAuditPanel/>
      </div>
    </div>
  </div>;
}

/* CspAuditPanel — the EXTERNAL portal audit feed (who did what in Infoblox CSP),
   read off the shared /api/data feed as auditLogs (same accessor 80.tab.security uses
   for its time-graph ticks). Kept SEPARATE from the local hash-chained log above: that
   one is tamper-evident and covers actions taken in THIS app; this is Infoblox's own
   record and is not chain-verified — different source, different trust. */
function CspAuditPanel(){
  const feed=useData();
  const d=feed.data||{};
  const liveRows=Array.isArray(d.auditLogs)?d.auditLogs:[];
  // Empty and unavailable must NOT look identical — that ambiguity is exactly what let
  // this feed sit dead for months. _meta.auditLogs is 'ok'|'empty'|'error' from server.
  const liveStatus=(d._meta&&d._meta.auditLogs)||(liveRows.length?'ok':null);

  // Server-side search reaches PAST the live 100-row poll window (the tenant churns ~100
  // audit events every ~8 min, so a specific human action falls off the poll fast). When
  // a search is active, its results replace the live view until cleared.
  const [q,setQ]=useState(''), [kind,setKind]=useState(''), [since,setSince]=useState('');
  const [search,setSearch]=useState(null); // null = showing the live feed
  const [busy,setBusy]=useState(false);
  const runSearch=async()=>{
    if(!q&&!kind&&!since){ setSearch(null); return; }
    setBusy(true);
    const p=new URLSearchParams();
    if(q) p.set('q',q); if(kind) p.set('kind',kind);
    if(since){ const t=new Date(Date.now()-({'24h':864e5,'7d':6048e5,'30d':2592e6}[since]||0)); p.set('since',t.toISOString()); }
    try{ const r=await fetch('/api/csp-audit?'+p.toString()); setSearch(await r.json()); }
    catch(e){ setSearch({rows:[],count:0,status:'error'}); }
    setBusy(false);
  };
  const clearSearch=()=>{ setQ(''); setKind(''); setSince(''); setSearch(null); };

  const rows=search?(search.rows||[]):liveRows;
  const status=search?search.status:liveStatus;
  const cols=[
    {key:'ts',label:'Time',mono:true,align:'left',width:190,
      render:v=>v?new Date(parseTs(v)).toLocaleString():'—'},
    // WHO: the USERNAME is the primary text (that's who you're looking for); a small
    // kind tag (person/device/service, derived from the username, not the misleading
    // subject_type) sits beside it. The tag uses the SAME Astryx.Badge as Result, so
    // every badge in this table shares one font/size/shape.
    {key:'user',label:'Who',mono:true,minWidth:240,render:(v,r)=>
      <span style={{display:'inline-flex',alignItems:'center',gap:'var(--s2)',minWidth:0}}>
        <span style={{display:'flex',flexDirection:'column',minWidth:0}}>
          <IdCell value={v||'—'} label="Actor"/>
          {r.who_role?<span style={{fontSize:'var(--t10)',color:'var(--text-faint)'}}>{r.who_role}</span>:null}
        </span>
        {r.who_kind?<Astryx.Badge variant="default" label={r.who_kind}/>:null}
      </span>},
    {key:'action',label:'Action'},
    {key:'resource',label:'Resource'},
    {key:'result',label:'Result',render:v=>
      <Astryx.Badge variant={v==='failure'?'error':'success'} label={v||'—'}/>},
  ];
  return <Panel title="CSP portal audit — external" size="lg"
    side={<Freshness at={feed.data?feed.fetchedAt:null} error={feed.error} onRetry={feed.refetch}/>}>
    <div style={{fontSize:'var(--t12)',color:'var(--text-dim)',marginBottom:'var(--s2)'}}>
      Read-only activity from the Infoblox portal — who changed what in CSP. Separate from
      Bloxsmith's hash-chained action log above: different source, not chain-verified.
    </div>
    {/* Search reaches past the live poll window — the only way to find a specific actor
        or time older than the last ~8 minutes of churn. */}
    <div style={{display:'flex',gap:'var(--s2)',alignItems:'center',flexWrap:'wrap',marginBottom:'var(--s2)'}}>
      <input className="dt-filter mono" placeholder="Search CSP (user or resource)…" value={q}
        onChange={e=>setQ(e.target.value)} onKeyDown={e=>{if(e.key==='Enter')runSearch();}}
        style={{minWidth:200}} aria-label="Search CSP audit"/>
      <select value={kind} onChange={e=>setKind(e.target.value)} aria-label="Actor kind"
        style={{height:28,fontSize:'var(--t12)',background:'var(--raised)',color:'var(--text)',border:'1px solid var(--border)',borderRadius:'var(--r-ctl)'}}>
        <option value="">Any kind</option>
        {/* Person vs machine is by username pattern, NOT subject_type — Infoblox tags
            provider_id service accounts as subject_type=="User", so a raw "User" filter
            returns tokens, not humans. Only these two meaningful buckets are offered. */}
        <option value="people">People only</option>
        <option value="machines">Machines only</option>
      </select>
      <select value={since} onChange={e=>setSince(e.target.value)} aria-label="Time range"
        style={{height:28,fontSize:'var(--t12)',background:'var(--raised)',color:'var(--text)',border:'1px solid var(--border)',borderRadius:'var(--r-ctl)'}}>
        <option value="">Any time</option><option value="24h">Last 24h</option>
        <option value="7d">Last 7d</option><option value="30d">Last 30d</option>
      </select>
      <button className="btn" disabled={busy} onClick={runSearch}>{busy?'Searching…':'Search'}</button>
      {search?<button className="btn btn-ghost" onClick={clearSearch}>Clear · back to live</button>:null}
      {search?<span className="mono" style={{fontSize:'var(--t11)',color:'var(--text-dim)'}}>
        {search.status==='error'?'search failed':(search.count+' result'+(search.count===1?'':'s')+(search.truncated?' (capped at 500)':'')+' — searched CSP directly')}</span>:null}
    </div>
    {feed.locked
      ? <div className="dt-empty">Vault locked — unlock to load the portal audit feed.</div>
      : status==='error'
        ? <div className="dt-empty">{search?'Search failed — CSP returned an error (try fewer/simpler terms).':'Portal audit feed unavailable — CSP returned an error. (This is the external feed, not Bloxsmith’s own log above.)'}</div>
        : rows.length===0
          ? <div className="dt-empty">{search?'No CSP entries match this search.':'No portal audit entries in the current window.'}</div>
          : <DataTable cols={cols} rows={rows} defaultSort={{key:'ts',dir:'desc'}}
              tableId="csp-audit" csvName="csp-audit" rowKey={r=>String(r.id||((r.ts||'')+'|'+(r.user||'')))}
              maxRows={50} scrollBody={480} filterable filterKeys={['user','who_kind','who_role','action','resource','result']}/>}
  </Panel>;
}

/* AuditExportButton — downloads /api/audit/export as a JSON blob (port of
   src/components/AuditExportButton.tsx). */
function AuditExportButton(){
  const [pending,setPending]=useState(false);
  const handleExport=async()=>{
    setPending(true);
    try{
      const r=await fetch('/api/audit/export');
      if(!r.ok){toast('Export failed — HTTP '+r.status,'err');return;}
      const payload=await r.json();
      const blob=new Blob([JSON.stringify(payload,null,2)],{type:'application/json'});
      const url=URL.createObjectURL(blob);
      const a=document.createElement('a');
      a.href=url; a.download='audit-export-'+Date.now()+'.json';
      document.body.appendChild(a); a.click();
      document.body.removeChild(a); URL.revokeObjectURL(url);
    }catch(e){
      toast(String((e&&e.message)||e),'err');
    }finally{
      setPending(false);
    }
  };
  return <Astryx.Button variant="primary" size="sm" isDisabled={pending} onClick={handleExport}>{pending?'Exporting…':'Export Audit Log'}</Astryx.Button>;
}

// ═══ REGION: INCIDENTS ═══
/* SeverityBadge — thin wrapper over Astryx <Badge> (real prop API: variant=
   neutral|info|success|warning|error|<color-name>, label — Badge renders
   [icon,label], NOT children). Keeps call sites (<SeverityBadge severity=.../>)
   unchanged while swapping the old hand-rolled .sev-badge chip. */
