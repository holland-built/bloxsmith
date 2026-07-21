const M_HOST='HostMetrics.host_name', M_NAME='HostMetrics.metric_name', M_VAL='HostMetrics.avg_value';

function infraStatusColor(s){
  const v=(s||'').toLowerCase();
  if(v==='online'||v==='up') return 'var(--ok)';
  if(v==='degraded') return 'var(--warn)';
  if(v==='down'||v==='offline') return 'var(--crit)';
  return 'var(--text-faint)';
}
function fmtMetric(v){
  if(v==null||v==='') return null;
  const n=Number(v);
  if(!isFinite(n)) return null;
  const a=Math.abs(n);
  if(a>=1e6) return (n/1e6).toFixed(1)+'M';
  if(a>=1e3) return (n/1e3).toFixed(1)+'k';
  return n.toFixed(1);
}

function InfraTab({vaultTick}={}){
  const {params}=useRoute();
  const hostParam=params.host||'';
  const {data,error,locked,loading,fetchedAt,refetch}=useData();
  const mx=useApi('/api/host-metrics');
  const _whoInfra=useApi('/api/whoami');
  const canEdit=(((_whoInfra.data&&_whoInfra.data.role)||'viewer')!=='viewer');

  // Re-fetch both feeds once a vault unlock is reported upstream.
  useEffect(()=>{ if(vaultTick){ refetch(); mx.refetch(); } },[vaultTick]);

  // Sensor grid is overwhelming by default — hide behind a disclosure.
  const [showSensors,setShowSensors]=useState(false);
  const {bind:hoverBind}=useHoverDetail();
  // Compare-to-snapshot (Hosts) — MUST run before any early return (hooks-order rule).
  const [hostCompareOn,setHostCompareOn]=useState(false);
  const [infraChart,infraToggle]=useChartType(['pie','bar'],'pie');

  const hosts=(data&&data.hosts)||[];
  const metricRows=(mx.data&&mx.data.metrics)||[];

  // Pivot metrics into rows=host, cols=metric; flag each column's top decile.
  const {hostNames,metricNames,pivot,hotSet,hotByHost}=useMemo(()=>{
    const pv={},hSet=new Set(),mSet=new Set(),cols={};
    metricRows.forEach(r=>{
      const h=r[M_HOST],m=r[M_NAME];
      if(h==null||m==null) return;
      const val=Number(r[M_VAL]);
      hSet.add(h);mSet.add(m);
      (pv[h]||(pv[h]={}))[m]=isFinite(val)?val:null;
      if(isFinite(val)) (cols[m]||(cols[m]=[])).push(val);
    });
    const hot=new Set(),hotByHost={};
    Object.keys(cols).forEach(m=>{
      const vals=cols[m].slice().sort((a,b)=>a-b);
      if(vals.length<2||vals[0]===vals[vals.length-1]) return; // no spread → no tint
      const thr=vals[Math.floor(0.9*(vals.length-1))];
      Object.keys(pv).forEach(h=>{
        const v=pv[h][m];
        if(v!=null&&v>=thr){ hot.add(h+'\u0000'+m); hotByHost[h]=(hotByHost[h]||0)+1; }
      });
    });
    return {
      hostNames:[...hSet].sort((a,b)=>a.localeCompare(b)),
      metricNames:[...mSet].sort((a,b)=>a.localeCompare(b)),
      pivot:pv, hotSet:hot, hotByHost,
    };
  },[metricRows]);

  // ── Synthesis derivations (host status + hottest, day-over-day delta) ──
  const {delta,prev}=useSnapshots();
  const online=hosts.filter(h=>/^(online|up)$/i.test(String(h.status||''))).length;
  const degradedHosts=hosts.filter(h=>/^degraded$/i.test(String(h.status||'')));
  const offlineHosts=hosts.filter(h=>/^(down|offline)$/i.test(String(h.status||'')));
  const total=hosts.length, degraded=degradedHosts.length, offline=offlineHosts.length;
  const byType=useMemo(()=>{const m={};hosts.forEach(h=>{const t=h.type||'—';m[t]=(m[t]||0)+1;});return Object.entries(m).sort((a,b)=>b[1]-a[1]);},[hosts]);
  const hottest=Object.keys(hotByHost).reduce((best,h)=>hotByHost[h]>(hotByHost[best]||0)?h:best,null);

  if(locked||mx.locked) return null;

  // ── Per-host drill panel ──
  if(hostParam){
    const host=hosts.find(h=>h.name===hostParam);
    const drillRows=metricRows
      .filter(r=>r[M_HOST]===hostParam)
      .map(r=>({metric:r[M_NAME],value:Number(r[M_VAL])}));
    const drillCols=[
      {key:'metric',label:'Metric'},
      {key:'value',label:'Value',mono:true,align:'right',render:v=>{const f=fmtMetric(v);return f==null?'·':f;}},
    ];
    return <div className="infra-page">
      <div className="infra-sec">
        <div className="infra-drill-top">
          <button className="infra-back" onClick={()=>history.back()}>← Back</button>
          <span className="infra-h">{hostParam}</span>
          {host&&host.ip?<span className="infra-ip mono">{host.ip}</span>:null}
          {host?<span className="infra-st mono" style={{color:infraStatusColor(host.status)}}>{host.status}</span>:null}
        </div>
      </div>
      <div className="infra-sec">
        <div className="infra-head">
          <span className="infra-h">Metrics</span>
          <Freshness at={mx.fetchedAt} error={mx.error} onRetry={mx.refetch}/>
        </div>
        {mx.loading&&!mx.data ? <Skeleton rows={5}/>
          : drillRows.length===0 ? <div className="infra-dim">No metrics reported</div>
          : <DataTable cols={drillCols} rows={drillRows} defaultSort={{key:'metric',dir:'asc'}}
              tableId="host-metrics" rowKey={r=>String(r.metric)} selectable
              csvName={'infra-'+hostParam+'-metrics'}/>}
      </div>
    </div>;
  }

  // Compare-to-snapshot (Hosts): prev.hosts.top mirrors the subnets top-N shape
  // (bounded, sorted by name — hosts have no natural "top" ranking; see
  // SnapshotWriter). Same scoping caveat as subnets/leases: diff runs against
  // that bounded prior set, not full host history.
  const prevHostRows=(prev&&prev.hosts&&Array.isArray(prev.hosts.top))
    ?prev.hosts.top.map(t=>({name:t.n,status:t.s})):[];
  const hostKeyFn=r=>String(r.name||r.id);
  const hostDiff=(hostCompareOn&&prev)
    ?diffRows(prevHostRows,hosts,hostKeyFn,['status'])
    :null;

  // ── Host inventory ──
  const hostCols=[
    {key:'name',label:'Host',primary:true,minWidth:240},
    {key:'ip',label:'IP',mono:true},
    {key:'type',label:'Type',hideSm:true,pivot:true},
    {key:'status',label:'Status',pivot:true,render:v=><span className="mono infra-st" style={{color:infraStatusColor(v)}}>{v||'—'}</span>},
    ...(canEdit?[{key:'__edit',label:'',align:'right',render:(v,h)=>
      <button className="btn" onClick={e=>{e.stopPropagation();nav('editor',{type:'host',id:h.id||h.name,name:h.name});}}>Edit</button>}]:[]),
  ];

  // ── Answer-first synthesis band ──
  const tone=offline>0?'crit':degraded>0?'warn':'ok';
  const worst=(offlineHosts[0]&&offlineHosts[0].name)||(degradedHosts[0]&&degradedHosts[0].name)||'';
  const verdict=(offline===0&&degraded===0)
    ? 'All '+total+' hosts online — infrastructure healthy'
    : offline+' hosts offline, '+degraded+' degraded'+(worst?' — '+worst+' needs attention':'');
  const dOff={v:delta('hosts.offline'),good:'down'};
  const facts=[
    {label:'Hosts online',value:online+'/'+total,delta:dOff},
    {label:'Degraded',value:degraded},
    {label:'Offline',value:offline,delta:dOff},
    {label:'Hottest host',value:hottest||'—'},
  ];
  // D: status filter chips built from the ACTUAL non-online status strings present
  // (robust to down/offline/degraded) → toggles a global filter on the host table's
  // `status` column (clearable in the top FilterBar). Then the offline-host drill chips.
  const statusVals=[...new Set(hosts.map(h=>String(h.status||'')).filter(v=>v&&!/^(online|up)$/i.test(v)))];
  const chips=[
    ...statusVals.map(v=>{const n=hosts.filter(h=>String(h.status||'')===v).length;
      return {label:'Only '+v+' · '+n,filter:{field:'status',value:v,label:'Status: '+v}};}),
    ...offlineHosts.slice(0,2).map(h=>({label:h.name,onClick:()=>nav('infra',{host:h.name})})),
  ];

  const kpiTiles=[
    {label:'Online',value:online,sub:'of '+total,color:'var(--ok)'},
    {label:'Degraded',value:degraded,color:'var(--warn)'},
    {label:'Offline',value:offline,color:'var(--crit)'},
    ...(byType.length>1?[{label:'Types',value:byType.length,sub:'host types',color:'var(--accent)',values:byType.map(t=>t[1])}]:[]),
  ];
  const attention=[...offlineHosts,...degradedHosts];
  const attnSev=h=>/^(down|offline)$/i.test(String(h.status||''))?'crit':'high';

  return <div className="infra-page">
    <SynthBand tone={tone} verdict={verdict} facts={facts} chips={chips}/>

    <div className="kpis">
      {kpiTiles.map(k=><KpiSpark key={k.label} label={k.label} value={k.value} sub={k.sub}
        color={k.color} values={k.values} bars/>)}
    </div>

    <div className="grid-dense">
      <Panel title="Needs attention" side={attention.length+(attention.length===1?' host':' hosts')}>
        {attention.length
          ? <div className="issues">
              {attention.map((h,i)=><div key={h.name||i} className="issue" role="button" tabIndex={0}
                  onClick={()=>nav('infra',{host:h.name})}
                  onKeyDown={e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();nav('infra',{host:h.name});}}}
                  {...hoverBind({title:h.name,rows:[['IP',h.ip||'—'],['Type',h.type||'—'],['Status',h.status||'—']]})}>
                <span className={'sev '+attnSev(h)}>{attnSev(h)==='crit'?'offline':'degraded'}</span>
                <div className="body">
                  <div className="t">{h.name}</div>
                  <div className="d mono">{h.ip||'—'}{h.type?' · '+h.type:''}</div>
                </div>
              </div>)}
            </div>
          : <div className="infra-dim">All {total} hosts online</div>}
      </Panel>

      <Panel title="Status" side={<>{infraToggle}<span>{total+' hosts'}</span></>}>
        <div className="chart-body">
          <ChartView type={infraChart} data={[
            {label:'online',value:online,color:'var(--ok)'},
            {label:'degraded',value:degraded,color:'var(--warn)'},
            {label:'offline',value:offline,color:'var(--crit)'},
          ]} donut={{centerValue:offline,centerLabel:"offline"}}/>
        </div>
      </Panel>

      <Panel title="By type" empty={byType.length<2} side={byType.length+(byType.length===1?' type':' types')}>
        {byType.length
          ? <div style={{display:'flex',flexDirection:'column',gap:'6px'}}>
              {byType.map(([t,c])=><div key={t} className="infra-panel-row"><span>{t}</span><span className="mono">{c}</span></div>)}
            </div>
          : <div className="infra-dim">No hosts</div>}
      </Panel>

      <Panel title="Hottest host" empty={!hottest}>
        <button className="infra-panel-btn" onClick={()=>{setShowSensors(true);nav('infra',{host:hottest});}}>{hottest} — {hottest?hotByHost[hottest]:0} sensors hot →</button>
      </Panel>
    </div>

    <Panel title="Hosts" side={<div style={{display:'flex',alignItems:'center',gap:'var(--s2)'}}>
        <button className="btn btn-ghost" aria-pressed={hostCompareOn}
          disabled={!prev} title={prev?'Diff current hosts against yesterday\'s snapshot':'A prior daily snapshot is needed'}
          onClick={()=>{
            const next=!hostCompareOn; setHostCompareOn(next);
            if(next&&prev){
              const d=diffRows(prevHostRows,hosts,hostKeyFn,['status']);
              let added=0,changed=0; d.byKey.forEach(v=>{if(v.type==='+')added++;else changed++;});
              toast(added+' added · '+changed+' changed · '+d.ghosts.length+' removed','ok');
            }
          }}>{hostCompareOn?'Comparing hosts':'Compare hosts to snapshot'}</button>
        {canEdit?<button className="btn" onClick={()=>nav('editor',{type:'host'})}>New host</button>:null}<Freshness at={fetchedAt} error={error} onRetry={refetch}/></div>}>
      {loading&&!data ? <Skeleton rows={6}/>
        : error&&!data ? <ErrorState error={error} onRetry={refetch}/>
        : <DataTable cols={hostCols} rows={hosts} defaultSort={{key:'name',dir:'asc'}}
            csvName="infra-hosts" onRowClick={r=>nav('infra',{host:r.name})}
            scrollBody={480} columnToggle
            problemsOnly={{label:'Needs attention',test:h=>!/^(online|up)$/i.test(String(h.status||'')),default:hosts.length>50}}
            {...{tableId:'hosts'}} rowKey={hostKeyFn}
            diffMap={hostDiff?hostDiff.byKey:null} diffGhosts={hostDiff?hostDiff.ghosts:null}
            selectable filterable filterKeys={['name','ip','type','status']}
            searchSchema={{fields:{status:{type:'enum'}}}}
            initialPeekKey={params.peek}
            bulkActions={rws=>[{label:'Copy IPs',run:()=>{
              const ips=rws.map(r=>String(r.ip||'')).filter(Boolean);
              if(navigator.clipboard&&navigator.clipboard.writeText) navigator.clipboard.writeText(ips.join('\n'));
              toast('Copied '+ips.length+' IP'+(ips.length===1?'':'s'),'ok');
            }}]}
            renderPeek={row=>{
              const hm=metricRows.filter(r=>r[M_HOST]===row.name).map(r=>({m:r[M_NAME],v:r[M_VAL]}));
              return <div className="infra-peek">
                <div className="infra-panel-row"><span>Host</span><span className="mono">{row.name}</span></div>
                <div className="infra-panel-row"><span>IP</span><span className="mono">{row.ip||'—'}</span></div>
                <div className="infra-panel-row"><span>Type</span><span>{row.type||'—'}</span></div>
                <div className="infra-panel-row"><span>Status</span><span className="mono infra-st" style={{color:infraStatusColor(row.status)}}>{row.status||'—'}</span></div>
                <div className="infra-panel-div"/>
                <div className="infra-panel-h">Metrics</div>
                {hm.length
                  ? hm.map((x,i)=><div key={i} className="infra-panel-row"><span>{x.m}</span><span className="mono">{fmtMetric(x.v)==null?'·':fmtMetric(x.v)}</span></div>)
                  : <div className="infra-dim">No metrics reported</div>}
              </div>;
            }}/>}
    </Panel>

    <div className="infra-sec">
      <div className="infra-head">
        <button className="infra-panel-btn infra-h" style={{cursor:'pointer'}} onClick={()=>setShowSensors(v=>!v)}>
          {showSensors ? 'Hide sensor grid' : 'Show sensor grid ('+hostNames.length+' hosts × '+metricNames.length+' metrics)'}
        </button>
        {showSensors ? <Freshness at={mx.fetchedAt} error={mx.error} onRetry={mx.refetch}/> : null}
      </div>
      {!showSensors ? null
        : mx.loading&&!mx.data ? <Skeleton rows={6}/>
        : metricNames.length===0 ? <div className="infra-dim">No metrics reported</div>
        : <div className="sensor-wrap">
            <table className="sensor">
              <thead><tr>
                <th className="sensor-hcol">Host</th>
                {metricNames.map(m=><th key={m}>{m}</th>)}
              </tr></thead>
              <tbody>
                {hostNames.map(h=><tr key={h}>
                  <td className="sensor-hcol mono">{h}</td>
                  {metricNames.map(m=>{
                    const f=fmtMetric(pivot[h]&&pivot[h][m]);
                    const hot=hotSet.has(h+'\u0000'+m);
                    return <td key={m} className={'mono'+(f==null?' sensor-null':(hot?' sensor-hot':''))}>
                      {f==null?'·':f}</td>;
                  })}
                </tr>)}
              </tbody>
            </table>
          </div>}
    </div>

    <div className="infra-sec">
      <div className="infra-head"><span className="infra-h">CSP</span><MaintenancePill/></div>
    </div>
    <HostHealthPanel/>
    <OnPremHostsPanel/>
    <JobsPanel/>
    <DfpServicesPanel/>
  </div>;
}
// ── CSP tiles (read-only, appended — see BUILD_SPEC.md) ──
function cspStatusBadge(v){
  const s=String(v||'').toLowerCase();
  const variant=s==='online'?'success':s==='offline'?'error':'default';
  return <Astryx.Badge variant={variant} label={v||'—'}/>;
}
function HostHealthPanel(){
  const feed=useApi('/api/csp/host-health',{poll:15000});
  const rows=(feed.data&&feed.data.rows)||[];
  const status=feed.data&&feed.data.status;
  const cols=[
    {key:'name',label:'Name',primary:true,render:v=><IdCell value={v} label="Host"/>},
    {key:'status',label:'Status',render:cspStatusBadge},
    {key:'version',label:'Version',mono:true},
    {key:'ip',label:'IP',mono:true},
    {key:'nat_ip',label:'NAT IP',mono:true},
    {key:'location',label:'Location'},
  ];
  return <Panel title="Host health" api={feed}>
    {feed.error||status==='error' ? <ErrorState error="feed unavailable — CSP returned an error" onRetry={feed.refetch}/>
     : rows.length===0 ? <div style={{padding:16,color:'var(--text-faint)',fontSize:12}}>No data in the current window</div>
     : <DataTable cols={cols} rows={rows} rowKey={r=>String(r.name)} tableId="csp-host-health" csvName="csp-host-health" scrollBody={480} filterable/>}
  </Panel>;
}
function OnPremHostsPanel(){
  const feed=useApi('/api/csp/onprem-hosts',{poll:30000});
  const rows=(feed.data&&feed.data.rows)||[];
  const status=feed.data&&feed.data.status;
  const cols=[
    {key:'name',label:'Name',primary:true},
    {key:'ophid',label:'OPH ID',render:v=><IdCell value={v} label="OPH ID"/>},
    {key:'app_count',label:'Apps',mono:true,align:'right'},
  ];
  return <Panel title="On-prem hosts" api={feed}>
    {feed.error||status==='error' ? <ErrorState error="feed unavailable — CSP returned an error" onRetry={feed.refetch}/>
     : rows.length===0 ? <div style={{padding:16,color:'var(--text-faint)',fontSize:12}}>No data in the current window</div>
     : <DataTable cols={cols} rows={rows} rowKey={r=>String(r.ophid||r.name)} tableId="csp-onprem-hosts" csvName="csp-onprem-hosts" scrollBody={480} filterable/>}
  </Panel>;
}
function JobsPanel(){
  const feed=useApi('/api/csp/jobs',{poll:15000});
  const rows=(feed.data&&feed.data.rows)||[];
  const status=feed.data&&feed.data.status;
  const cols=[
    {key:'created_at',label:'Created',mono:true},
    {key:'type',label:'Type'},
    {key:'status',label:'Status',render:cspStatusBadge},
    {key:'user',label:'User'},
  ];
  return <Panel title="Jobs" api={feed}>
    {feed.error||status==='error' ? <ErrorState error="feed unavailable — CSP returned an error" onRetry={feed.refetch}/>
     : rows.length===0 ? <div style={{padding:16,color:'var(--text-faint)',fontSize:12}}>No data in the current window</div>
     : <DataTable cols={cols} rows={rows} rowKey={r=>String(r.id||r.created_at)} tableId="csp-jobs" csvName="csp-jobs" defaultSort={{key:'created_at',dir:'desc'}} scrollBody={480}/>}
  </Panel>;
}
function DfpServicesPanel(){
  const feed=useApi('/api/csp/dfp',{poll:30000});
  const rows=(feed.data&&feed.data.rows)||[];
  const status=feed.data&&feed.data.status;
  const cols=[
    {key:'name',label:'Name',primary:true},
    {key:'status',label:'Status',render:cspStatusBadge},
  ];
  return <Panel title="DFP services" api={feed}>
    {feed.error||status==='error' ? <ErrorState error="feed unavailable — CSP returned an error" onRetry={feed.refetch}/>
     : rows.length===0 ? <div style={{padding:16,color:'var(--text-faint)',fontSize:12}}>No data in the current window</div>
     : <DataTable cols={cols} rows={rows} rowKey={r=>String(r.id||r.name)} tableId="csp-dfp" csvName="csp-dfp" scrollBody={480}/>}
  </Panel>;
}
function MaintenancePill(){
  const feed=useApi('/api/csp/maintenance',{poll:60000});
  const enabled=feed.data&&feed.data.enabled;
  const status=feed.data&&feed.data.status;
  if(feed.error||status==='error') return null;
  if(enabled==null) return null;
  return enabled
    ? <Astryx.Badge variant="warning" label="Maintenance ON"/>
    : <Astryx.Badge variant="success" label="Operational"/>;
}
// ═══ END: INFRA ═══

// ═══ REGION: SECURITY ═══
/* Security region — triage inbox, threat lookup, domain panels, SOC insights,
   actions. Reuses useApi, DataTable, Freshness, toast, LS, Skeleton, relAge, tokens. */
