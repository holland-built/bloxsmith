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

/* incAckKey — the ack identity, same shape as Security's secAckKey (event_time|qname).
   (category, entity_id) is stamp_first_seen's own key, so it survives a re-poll;
   detected_at pins the ack to ONE OCCURRENCE. When a signal resolves and later
   returns, stamp_first_seen issues a fresh `first` (15min grace, server.py:2827),
   detected_at changes, and the row comes back UNACKED — a re-broken subnet is a
   new problem, not one you already dismissed. Floor(): detected_at is a float
   epoch, so a sub-second drift must not mint a new key.
   Stale keys self-limit: an entry for a vanished occurrence is inert, Clear acks flushes. */
const incAckKey=s=>s.category+'|'+s.entity_id+'|'+Math.floor(Number(s.detected_at)||0);

/* MCP IQ Actions/events carry 'priority' (low/medium/high), not this app's
   ok/warn/crit vocabulary — map client-side, same as backend/data/fetch_mcp.py's
   _PRIORITY_MAP did server-side in the source app. */
const MCP_PRIORITY_TO_SEVERITY={low:'ok',medium:'warn',high:'crit'};
function mcpSeverity(row){
  if(row&&row.severity) return row.severity;
  const p=String((row&&row.priority)||'').toLowerCase();
  return MCP_PRIORITY_TO_SEVERITY[p]||'ok';
}

/* IncCategoryChips — the rollup, demoted from table rows to a filter/snooze strip.
   Triage now lists individual signals, so `incidents` has one job left: name each
   category, carry its true count, and host its SnoozeControl. Clicking a chip
   filters the table to that category (74.tab.network.jsx:277's query/onQuery). */
function IncCategoryChips({incidents,query,onQuery,onSnoozed}){
  if(!incidents.length) return null;
  // Bound the strip: too many categories would wrap into a wall of chips. Show the
  // first ~8, roll the rest into a single "+N more" indicator.
  const CHIP_CAP=8;
  const shown=incidents.slice(0,CHIP_CAP);
  const overflow=incidents.length-shown.length;
  return <div style={{display:'flex',alignItems:'center',gap:'var(--s3)',flexWrap:'wrap',marginBottom:'var(--s3)'}}>
    {shown.map(i=>{
      const on=query===i.category;
      return <span key={i.key||i.category}
        style={{display:'inline-flex',alignItems:'center',gap:'var(--s2)',padding:'2px var(--s2)',
          background:on?'var(--raised)':'transparent',border:'1px solid var(--border)',borderRadius:'var(--r-ctl)'}}>
        <button className="btn btn-ghost" aria-pressed={on}
          title={on?'Clear this filter':'Filter Triage to '+i.category}
          onClick={()=>onQuery(on?'':i.category)}
          style={{display:'inline-flex',alignItems:'center',gap:'var(--s2)',fontSize:'var(--t12)'}}>
          <span className={'sd '+(i.severity==='crit'?'crit':i.severity==='warn'?'warn':'ok')} aria-hidden="true"/>
          <span className="mono">{(Number(i.count)||0).toLocaleString()}</span>
          <span>{i.category}</span>
        </button>
        <SnoozeControl category={i.category} onSnoozed={onSnoozed}/>
      </span>;
    })}
    {overflow>0
      ? <span className="mono" title={overflow+' more categor'+(overflow===1?'y':'ies')}
          style={{fontSize:'var(--t12)',color:'var(--text-dim)',padding:'2px var(--s2)'}}>+{overflow} more</span>
      : null}
  </div>;
}

/* IncidentsTab — port of TriagePanel + McpIncidentQueue onto
   this app's DataTable/Panel/SynthBand idioms (pattern = AuditTab).
   - Triage: /api/incidents (server-correlated Signals from subnet/zone/lease
     data — no new upstream call).
   - SOC queue: /api/actions (existing IQ Actions endpoint, reused as-is). */
function IncidentsTab(){
  const incApi=useApi('/api/incidents',{poll:20000});
  const actionsApi=useApi('/api/actions',{poll:30000});

  const [acks,setAcks]=useState(()=>LS.get('inc_acks',{}));
  const [incQuery,setIncQuery]=useState('');
  // 'inc_acks', NOT Security's 'acks' bucket: two different key shapes in one bucket
  // would have each tab's Hide-acked reading the other's garbage.
  const toggleAck=s=>{const k=incAckKey(s);setAcks(p=>{const n={...p};if(n[k])delete n[k];else n[k]=true;LS.set('inc_acks',n);return n;});};
  const clearAcks=()=>{setAcks({});LS.set('inc_acks',{});};

  const incidents=(incApi.data&&incApi.data.incidents)||[];
  // Tolerate a server that predates the signals feed: old shape → empty table +
  // the existing dt-empty line, never a crash on undefined.
  const signals=(incApi.data&&Array.isArray(incApi.data.signals))?incApi.data.signals:[];
  const signalsTotal=(incApi.data&&typeof incApi.data.signals_total==='number')?incApi.data.signals_total:signals.length;
  const crit=incidents.filter(i=>i.severity==='crit').length;
  const warn=incidents.filter(i=>i.severity==='warn').length;
  const tone=crit>0?'crit':warn>0?'warn':'ok';
  // The banner still reads the ROLLUP, not the table: `incidents` is one entry per
  // aggregated category, so incidents.length is the category count, never the real
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

  const triageCols=[
    // Sits beside DataTable's own select box (td.dt-check), so it MUST stay labeled:
    // that one selects, this one mutates ack state (80.tab.security.jsx:186's lesson).
    {key:'ack',label:'Ack',width:48,sortable:false,render:(_,s)=>
      <input type="checkbox" checked={!!acks[incAckKey(s)]} onClick={e=>e.stopPropagation()}
        onChange={()=>toggleAck(s)} aria-label="Acknowledge signal"/>},
    {key:'severity',label:'Sev',width:70,render:v=><SeverityBadge severity={v}/>},
    {key:'entity_id',label:'Entity',id:true},
    {key:'message',label:'Message',render:(v,r)=><span>{r.category?<span className="tag" style={{marginRight:6}}>{r.category}</span>:null}{v}</span>},
    {key:'detected_at',label:'Age',mono:true,align:'right',render:v=>secEvtAge(v)},
  ];

  const actionsRows=Array.isArray(actionsApi.data)
    ? actionsApi.data
    : (actionsApi.data&&(actionsApi.data.actions||actionsApi.data.results||actionsApi.data.data))||[];
  const actionsCols=actionsRows.length
    ? [{key:'_sev',label:'Sev',width:70,render:(_,row)=><SeverityBadge severity={mcpSeverity(row)}/>},
       ...secAutoCols(actionsRows).filter(c=>c.key!=='severity')]
    : [];

  return <div className="page">
    <div className={"inc-strip "+tone} role="status" aria-live="polite"
      style={{borderLeft:'3px solid var(--'+tone+')'}}>
      <span className={"sd pulse "+tone} aria-hidden="true"/>
      <span className="inc-strip-txt">{verdict}</span>
    </div>

    <IncCategoryChips incidents={incidents} query={incQuery} onQuery={setIncQuery}
      onSnoozed={incApi.refetch}/>

    <div className="dash">
    <div className="dc24 t-s6">
    <Panel title="Triage" api={incApi} size="s6"
      side={<button className="fresh-retry" onClick={clearAcks}>Clear acks</button>}>
      <Astryx.Card variant="default" padding={0}>
        {incApi.loading&&!incApi.data
          ? <Skeleton rows={4}/>
          : incApi.locked
            ? <div className="dt-empty">Vault locked — unlock to load incidents.</div>
            : signals.length===0
              ? <div className="dt-empty">No issues detected — all metrics within normal thresholds.</div>
              : <React.Fragment>
                  {incApi.data&&incApi.data.signals_truncated
                    ? <div style={{padding:'var(--s2) var(--s3)',fontSize:'var(--t12)',color:'var(--warn)'}}>
                        Showing {signals.length.toLocaleString()} of {signalsTotal.toLocaleString()} — list capped server-side.</div>
                    : null}
                  {/* No defaultSort: severity is a STRING, so sorting it desc reads
                      warn > ok > crit — it would bury the criticals. The server
                      already ships crit-first/oldest-first (server.py:5281), and an
                      unset sort keeps input order (40.table.jsx:901). */}
                  <DataTable cols={triageCols} rows={signals} tableId="incidents-triage"
                    rowKey={r=>incAckKey(r)} scrollBody={480} filterable csvName="incidents"
                    query={incQuery} onQuery={setIncQuery}
                    searchSchema={{fields:{severity:{type:'enum'},category:{type:'enum'}},aliases:{sev:'severity',entity:'entity_id'}}}
                    problemsOnly={{label:'Hide acked',test:s=>!acks[incAckKey(s)],default:true}}
                    selectable bulkActions={sel=>[
                      {label:'Ack '+sel.length,flash:true,run:()=>{
                        const prev={...acks};
                        const next={...acks};
                        sel.forEach(s=>{next[incAckKey(s)]=true;});
                        setAcks(next);LS.set('inc_acks',next);
                        toast(sel.length+' acked','ok',{duration:5000,action:{label:'Undo',run:()=>{setAcks(prev);LS.set('inc_acks',prev);}}});
                      }},
                    ]}
                    peekOnClick
                    renderPeek={s=><div>
                      <div style={{fontWeight:600}}>{s.message||s.category}</div>
                      <div style={{marginTop:4,display:'flex',alignItems:'center',gap:8,fontSize:'var(--t12)'}}>
                        <SeverityBadge severity={s.severity}/>
                        <span className="mono" style={{color:'var(--text-dim)'}}>{s.category}</span>
                        <span style={{color:'var(--text-faint)'}}>·</span>
                        <span className="mono" style={{color:'var(--text-dim)'}}>{secEvtAge(s.detected_at)}</span>
                      </div>
                      <div style={{marginTop:'var(--s3)',fontSize:'var(--t12)',color:'var(--text-dim)'}}>
                        Entity <IdCell value={s.entity_id} label="Entity"/>
                      </div>
                    </div>}/>
                </React.Fragment>}
      </Astryx.Card>
    </Panel>
    </div>

    <div className="dc24 t-md">
    <Panel title="SOC queue (IQ Actions)" api={actionsApi} empty={!actionsRows.length} size="md">
      <DataTable cols={actionsCols} rows={actionsRows}
        rowKey={r=>String((r&&(r.id||r.display_id))||JSON.stringify(r).slice(0,40))}
        tableId="incidents-soc" csvName="soc-queue" maxRows={50} filterable/>
    </Panel>
    </div>
    </div>
  </div>;
}
// ═══ END: INCIDENTS ═══

// ═══ REGION: PROVISION ═══
/* RTYPE_HINTS/RTYPE_OPTIONS — DNS Records mode uses ONE value input (not
   per-type structured fields); the placeholder changes by type so the user
   knows the expected format. Backend parses the raw string. */
