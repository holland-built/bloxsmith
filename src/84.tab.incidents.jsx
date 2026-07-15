const SEVERITY_TO_ASTRYX_VARIANT={crit:'error',warn:'warning',ok:'success'};
function SeverityBadge({severity}){
  const s=severity==='crit'?'crit':severity==='warn'?'warn':'ok';
  return <Astryx.Badge variant={SEVERITY_TO_ASTRYX_VARIANT[s]} label={s.toUpperCase()}/>;
}

/* SnoozeControl — port of src/components/SnoozeControl.tsx. POSTs
   /api/alerts/snooze {category,minutes}; onSnoozed() refetches the triage list. */
const SNOOZE_DURATIONS=[{minutes:15,label:'15m'},{minutes:60,label:'1h'},{minutes:240,label:'4h'}];
function SnoozeControl({category,onSnoozed}){
  const [minutes,setMinutes]=useState(SNOOZE_DURATIONS[0].minutes);
  const [pending,setPending]=useState(false);
  const handleSnooze=async()=>{
    setPending(true);
    const {ok,data}=await vpost('/api/alerts/snooze',{category,minutes});
    setPending(false);
    if(ok&&data&&data.ok){ toast('Snoozed '+category+' for '+minutes+'m','ok'); onSnoozed&&onSnoozed(); }
    else toast('Snooze failed: '+((data&&data.error)||'unknown'),'err');
  };
  return <span style={{display:'inline-flex',alignItems:'center',gap:'var(--s2)'}} onClick={e=>e.stopPropagation()}>
    <select value={minutes} disabled={pending} aria-label="Snooze duration"
      onChange={e=>setMinutes(Number(e.target.value))}
      style={{height:26,fontSize:11,background:'var(--raised)',border:'1px solid var(--border)',borderRadius:'var(--r-ctl)',color:'var(--text)'}}>
      {SNOOZE_DURATIONS.map(d=><option key={d.minutes} value={d.minutes}>{d.label}</option>)}
    </select>
    <Astryx.Button type="button" variant="secondary" size="sm" isDisabled={pending} onClick={handleSnooze}>{pending?'Snoozing…':'Snooze'}</Astryx.Button>
  </span>;
}

/* IncidentSignalsPeek — drills a triage row (one correlated category, e.g.
   "129 subnet utilization") into its actual members. correlate() only keeps
   sample_entities=group[:5] in the list payload, so this fetches the real,
   uncapped set from /api/incidents/<category> — ON DEMAND: the effect fires
   only when this component mounts (i.e. only when the peek opens for this
   row), keyed+remounted per category via the `key` set at the call site, and
   is fully separate from incApi's 20s poll (never re-runs on a re-render). */
function IncidentSignalsPeek({row}){
  const category=row.category||row.key;
  const [state,setState]=useState({loading:true,error:null,data:null});
  const load=()=>{
    setState(s=>({...s,loading:true,error:null}));
    const ctrl=new AbortController();
    fetch('/api/incidents/'+encodeURIComponent(category),{cache:'no-store',signal:ctrl.signal})
      .then(async r=>{
        let body=null; try{body=await r.json();}catch(e){}
        if(!r.ok||!body) throw new Error((body&&body.error)||('HTTP '+r.status));
        setState({loading:false,error:null,data:body});
      })
      .catch(e=>{ if(e.name==='AbortError') return; setState({loading:false,error:String((e&&e.message)||e),data:null}); });
    return ()=>ctrl.abort();
  };
  useEffect(load,[category]); // eslint-disable-line
  const data=state.data;
  const signals=(data&&Array.isArray(data.signals))?data.signals:[];
  // count is the TRUE per-category total (pre-cap) — known instantly from the
  // triage row itself, so the header reads correctly even before the fetch lands;
  // once the fetch resolves, its count is the source of truth (same value, server-verified).
  const trueCount=(data&&typeof data.count==='number')?data.count:(Number(row.count)||0);

  const sigCols=[
    {key:'entity_id',label:'Entity',id:true},
    {key:'severity',label:'Sev',width:70,render:v=><SeverityBadge severity={v}/>},
    {key:'message',label:'Message'},
    {key:'detected_at',label:'Detected',mono:true,align:'right',render:v=>secEvtAge(v)},
  ];

  return <div>
    <div style={{fontWeight:600}}>{row.message||category}</div>
    <div style={{marginTop:4,display:'flex',alignItems:'center',gap:8,fontSize:'var(--t12)'}}>
      <SeverityBadge severity={row.severity}/>
      <span className="mono" style={{color:'var(--text-dim)'}}>{category}</span>
      <span style={{color:'var(--text-faint)'}}>·</span>
      <span className="mono" style={{color:'var(--text-dim)'}}>{trueCount.toLocaleString()} total</span>
    </div>
    {data&&data.truncated
      ? <div style={{marginTop:8,fontSize:'var(--t12)',color:'var(--warn)'}}>
          Showing {signals.length.toLocaleString()} of {trueCount.toLocaleString()} — list capped server-side.</div>
      : null}
    <div style={{marginTop:12}}>
      {state.loading
        ? <Skeleton rows={5}/>
        : state.error
          ? <div style={{fontSize:'var(--t12)',color:'var(--crit)'}}>
              Failed to load signals: {state.error} <button className="btn btn-ghost" onClick={load}>Retry</button></div>
          : signals.length===0
            ? <div style={{fontSize:'var(--t12)',color:'var(--text-faint)'}}>No signals returned for this category.</div>
            : <DataTable cols={sigCols} rows={signals} rowKey={(s,i)=>String(s.entity_id||i)+'|'+i}
                tableId={'incidents-peek-'+category} csvName={'incident-'+category} scrollBody={340}
                filterable maxRows={500}/>}
    </div>
  </div>;
}

/* MCP IQ Actions/events carry 'priority' (low/medium/high), not this app's
   ok/warn/crit vocabulary — map client-side, same as backend/data/fetch_mcp.py's
   _PRIORITY_MAP did server-side in the source app. */
const MCP_PRIORITY_TO_SEVERITY={low:'ok',medium:'warn',high:'crit'};
function mcpSeverity(row){
  if(row&&row.severity) return row.severity;
  const p=String((row&&row.priority)||'').toLowerCase();
  return MCP_PRIORITY_TO_SEVERITY[p]||'ok';
}

/* incMessage — server.py:2855 builds the triage message as
   f"{count} {category.replace('-',' ')}" → "129 subnet utilization", which reads as
   a PROPERTY of one thing, not a set of 129 ("why only 3 incidents?"). Restate the
   three known categories (server.py:2890/2902/2914) with a plural noun so the row
   says what it contains. Unknown categories keep the server string verbatim.
   PERMANENT FIX: one line in correlate() — server.py is out of scope here. */
const INC_MESSAGE={
  'subnet-utilization':c=>c+' subnet'+(c===1?'':'s')+' over threshold',
  'dns-ttl-anomaly':c=>c+' zone'+(c===1?'':'s')+' with TTL anomalies',
  'dhcp-expired-lease':c=>c+' expired lease'+(c===1?'':'s'),
};
function incMessage(row){
  const f=INC_MESSAGE[row&&row.category];
  return f?f(Number(row.count)||0):row.message;
}

/* IncEntitiesCell — sample_entities is group[:5]; rendering the join made the cell
   read as THE entities. Show the first two as real IdCells (hover-full/click-copy
   preserved) + the count that is actually behind the row. */
const INC_ENT_SHOWN=2;
function IncEntitiesCell({row}){
  const sample=Array.isArray(row.sample_entities)?row.sample_entities:[];
  if(!sample.length) return '—';
  const shown=sample.slice(0,INC_ENT_SHOWN);
  const more=Math.max(0,(Number(row.count)||sample.length)-shown.length);
  return <span style={{display:'flex',alignItems:'center',gap:4,minWidth:0}}>
    {shown.map((e,i)=><IdCell key={i} value={e} label="Entity"/>)}
    {more?<span style={{flex:'0 0 auto',whiteSpace:'nowrap',color:'var(--text-dim)'}}>+{more} more</span>:null}
  </span>;
}

/* IncidentsTab — port of TriagePanel + McpIncidentQueue + McpEventStream onto
   this app's DataTable/Panel/SynthBand idioms (pattern = AuditTab).
   - Triage: /api/incidents (server-correlated Signals from subnet/zone/lease
     data — no new upstream call).
   - SOC queue: /api/actions (existing IQ Actions endpoint, reused as-is).
   - Event stream: /api/mcp/events (new MCP anomaly-event endpoint). */
function IncidentsTab(){
  const incApi=useApi('/api/incidents',{poll:20000});
  const actionsApi=useApi('/api/actions',{poll:30000});
  const eventsApi=useApi('/api/mcp/events',{poll:30000});

  const incidents=(incApi.data&&incApi.data.incidents)||[];
  const crit=incidents.filter(i=>i.severity==='crit').length;
  const warn=incidents.filter(i=>i.severity==='warn').length;
  const tone=crit>0?'crit':warn>0?'warn':'ok';
  // Each row is an aggregated category (e.g. "129 subnet utilization"), not one
  // incident — incidents.length is always the category count, never the real
  // volume. `count` carries the real per-category total; sum it for the true
  // issue volume and for actual critical volume (not critical-category count).
  // Number(...)||0 guards missing/non-numeric count so we never render NaN;
  // fall total back to the category count only if no row carries a count at all.
  const catCount=incidents.length;
  const totalVol=incidents.reduce((s,i)=>s+(Number(i.count)||0),0)||catCount;
  const critVol=incidents.filter(i=>i.severity==='crit').reduce((s,i)=>s+(Number(i.count)||0),0);
  const verdict=incidents.length
    ? totalVol+' active '+(totalVol===1?'issue':'issues')+' · '+catCount+' categor'+(catCount===1?'y':'ies')+(critVol?(' · '+critVol+' critical'):'')
    : 'No issues detected — all metrics within normal thresholds';

  // Message is transformed in the ROW DATA, not via a column render: a render would
  // pin the column open against effCols' hide-all-empty pruning (40.table.jsx:915).
  // Falsy messages pass through untouched so an empty column still prunes.
  const triageRows=incidents.map(i=>i.message?{...i,message:incMessage(i)}:i);

  const triageCols=[
    // Persistent affordance that the row opens — never hover-gated. aria-expanded
    // lives on the <tr> (DTRow, 40.table.jsx), not here.
    {key:'__peek',label:'',width:24,sortable:false,
      render:()=><span aria-hidden="true" style={{color:'var(--text-faint)'}}>›</span>},
    {key:'severity',label:'Sev',width:70,render:v=><SeverityBadge severity={v}/>},
    {key:'count',label:'Count',mono:true,align:'right',width:70},
    {key:'message',label:'Message'},
    {key:'sample_entities',label:'Entities',render:(_,row)=><IncEntitiesCell row={row}/>,
      tipFn:r=>(r.sample_entities||[]).join(', ')+' — '+r.count+' total'},
    // Rows are peekOnClick now, so this cell must swallow its own clicks — snoozing
    // a category must never also drill into it.
    {key:'snooze',label:'',width:190,sortable:false,render:(_,row)=>
      <span onClick={e=>e.stopPropagation()}>
        <SnoozeControl category={row.category} onSnoozed={incApi.refetch}/>
      </span>},
  ];

  const actionsRows=Array.isArray(actionsApi.data)
    ? actionsApi.data
    : (actionsApi.data&&(actionsApi.data.actions||actionsApi.data.results||actionsApi.data.data))||[];
  const actionsCols=actionsRows.length
    ? [{key:'_sev',label:'Sev',width:70,render:(_,row)=><SeverityBadge severity={mcpSeverity(row)}/>},
       ...secAutoCols(actionsRows).filter(c=>c.key!=='severity')]
    : [];

  const eventsRows=Array.isArray(eventsApi.data)?eventsApi.data:[];
  const eventsCols=eventsRows.length?secAutoCols(eventsRows):[];

  return <div className="page">
    <div className={"inc-strip "+tone} role="status" aria-live="polite"
      style={{borderLeft:'3px solid var(--'+tone+')'}}>
      <span className={"sd pulse "+tone} aria-hidden="true"/>
      <span className="inc-strip-txt">{verdict}</span>
    </div>

    <Panel title="Triage" api={incApi} size="md">
      <Astryx.Card variant="default" padding={0}>
        {incApi.loading&&!incApi.data
          ? <Skeleton rows={4}/>
          : incApi.locked
            ? <div className="dt-empty">Vault locked — unlock to load incidents.</div>
            : incidents.length===0
              ? <div className="dt-empty">No issues detected — all metrics within normal thresholds.</div>
              : <DataTable cols={triageCols} rows={triageRows} rowKey={r=>r.key} tableId="incidents-triage"
                  filterable searchSchema={{fields:{count:{type:'number'}}}} csvName="incidents" maxRows={50}
                  peekOnClick
          renderPeek={row=><IncidentSignalsPeek row={row} key={row.category||row.key}/>}/>}
      </Astryx.Card>
    </Panel>

    <Panel title="SOC queue (IQ Actions)" api={actionsApi} empty={!actionsRows.length}>
      <DataTable cols={actionsCols} rows={actionsRows}
        rowKey={r=>String((r&&(r.id||r.display_id))||JSON.stringify(r).slice(0,40))}
        tableId="incidents-soc" csvName="soc-queue" maxRows={50} filterable/>
    </Panel>

    <Panel title="MCP event stream" api={eventsApi} empty={!eventsRows.length}>
      <DataTable cols={eventsCols} rows={eventsRows}
        rowKey={r=>String((r&&(r.ophid||r.event_id||r.id))||JSON.stringify(r).slice(0,40))}
        tableId="incidents-events" csvName="mcp-events" maxRows={50}/>
    </Panel>
  </div>;
}
// ═══ END: INCIDENTS ═══

// ═══ REGION: PROVISION ═══
/* RTYPE_HINTS/RTYPE_OPTIONS — DNS Records mode uses ONE value input (not
   per-type structured fields); the placeholder changes by type so the user
   knows the expected format. Backend parses the raw string. */
