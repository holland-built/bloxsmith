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

/* MCP IQ Actions/events carry 'priority' (low/medium/high), not this app's
   ok/warn/crit vocabulary — map client-side, same as backend/data/fetch_mcp.py's
   _PRIORITY_MAP did server-side in the source app. */
const MCP_PRIORITY_TO_SEVERITY={low:'ok',medium:'warn',high:'crit'};
function mcpSeverity(row){
  if(row&&row.severity) return row.severity;
  const p=String((row&&row.priority)||'').toLowerCase();
  return MCP_PRIORITY_TO_SEVERITY[p]||'ok';
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
  const verdict=incidents.length
    ? incidents.length+' active '+(incidents.length===1?'incident':'incidents')+(crit?(' · '+crit+' critical'):'')
    : 'No issues detected — all metrics within normal thresholds';

  const triageCols=[
    {key:'severity',label:'Sev',width:70,render:v=><SeverityBadge severity={v}/>},
    {key:'count',label:'Count',mono:true,align:'right',width:70},
    {key:'message',label:'Message'},
    {key:'sample_entities',label:'Entities',id:true,idText:v=>(Array.isArray(v)?v:[]).join(', '),render:v=>(Array.isArray(v)?v:[]).join(', ')||'—'},
    {key:'snooze',label:'',width:190,sortable:false,render:(_,row)=>
      <SnoozeControl category={row.category} onSnoozed={incApi.refetch}/>},
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
              : <DataTable cols={triageCols} rows={incidents} rowKey={r=>r.key} tableId="incidents-triage"
                  filterable searchSchema={{fields:{count:{type:'number'}}}} csvName="incidents" maxRows={50}/>}
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
