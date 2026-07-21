function leasesInSubnet(leases, subnet) {
  const parts = (subnet.addr||'').split('.').map(Number);
  const cidr = subnet.cidr || 24;
  const octets = cidr <= 8 ? 1 : cidr <= 16 ? 2 : cidr <= 24 ? 3 : 4;
  const prefix = parts.slice(0, octets).join('.');
  return leases.filter(l => (l.addr || '').startsWith(prefix + '.') ||
                            (octets === 4 && l.addr === subnet.addr));
}

const NDA='NstarDnsActivity.';
function utilColor(u){return u>85?'var(--crit)':u>70?'var(--warn)':'var(--ok)';}
/* inline flat utilization bar + mono % (no gradients/shadows) */
function UtilBar(v){
  const u=Math.max(0,Math.min(100,Number(v)||0));
  return <span style={{display:'inline-flex',alignItems:'center',gap:8,justifyContent:'flex-end'}}>
    <span style={{width:60,height:4,background:'var(--raised)',borderRadius:2,overflow:'hidden',flex:'0 0 auto'}}>
      <span style={{display:'block',height:'100%',width:u+'%',background:utilColor(u)}}/>
    </span>
    <span className="mono" style={{minWidth:32,textAlign:'right'}}>{u}%</span>
  </span>;
}
/* 11px mono uppercase lease state — active green, everything else dim */
function StateText(state){
  const active=state==='active';
  return <span className="mono" style={{fontSize:'var(--t11)',textTransform:'uppercase',
    color:active?'var(--ok)':'var(--text-faint)'}}>{state||'—'}</span>;
}
function SectionHead({title,children}){
  return <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:'var(--s3)'}}>
    <h2 style={{margin:0,fontSize:'var(--t13)',fontWeight:600}}>{title}</h2>
    {children}
  </div>;
}

const NET_LEASE_COLS=[
  {key:'addr',label:'IP',mono:true,align:'left',minWidth:130},
  {key:'state',label:'State',align:'left',pivot:true,render:v=>StateText(v)},
  {key:'host',label:'Host'},
];

function NetworkTab(){
  const {params}=useRoute();
  const {data,error,locked,loading,fetchedAt,refetch}=useData();
  const {delta,prev}=useSnapshots();
  // Compare-to-snapshot — subnets AND leases (both tables now have row-level
  // shape in the snapshot store; see diffRows/snapKey/SnapshotWriter). Separate
  // toggle state per table since each has its own "Compare" button.
  // MUST run before any early return (hooks-order rule).
  const [compareOn,setCompareOn]=useState(false);
  const [leaseCompareOn,setLeaseCompareOn]=useState(false);
  // histByAddr — per-subnet util history from the snapshot store. Each snapshot day
  // holds subnets.top:[{a,u}]; assemble values=[u per day] keyed by addr. Only subnets
  // present across ≥2 days get a series → the Trend sparkline renders honestly (no fabrication).
  // MUST run before any early return (hooks-order rule).
  const histByAddr=useMemo(()=>{
    const days=(readSnaps().days||[]).slice().sort((a,b)=>String(a.date).localeCompare(String(b.date)));
    const h={};
    days.forEach(d=>{
      const top=(d&&d.subnets&&Array.isArray(d.subnets.top))?d.subnets.top:[];
      top.forEach(t=>{ if(t&&t.a!=null&&typeof t.u==='number'){ (h[t.a]||(h[t.a]=[])).push(t.u); } });
    });
    return h;
  },[fetchedAt]);
  // NETDNS region UI state — MUST run before any early return (hooks-order rule).
  // expandedSigs: 100%-util collapse groups the user has expanded (see collapseIdentical).
  // Unified BQL search: the subnets table is the single filter surface. Its search string is
  // NetworkTab-owned — seeded from the #…?sq= hash and mirrored back to it (like the f= pivot
  // mirror). Util-band presets + the "capacity by site" bars inject BQL tokens (util>=100,
  // site:X) into it. There is NO per-site chip wall and no separate band/siteFilter state.
  const [subnetQuery,setSubnetQuery]=useState(params.sq||'');
  useEffect(()=>{
    const {tab,params:hp}=parseHash(); const np={...hp};
    if(subnetQuery&&subnetQuery.trim()) np.sq=subnetQuery.trim(); else delete np.sq;
    if((np.sq||'')!==(hp.sq||'')) nav(tab,np); // never touches q (AI drawer)
  },[subnetQuery]);
  const [expandedSigs,setExpandedSigs]=useState(()=>new Set());
  const {bind}=useHoverDetail(); // cursor-following flavor card for subnet + top-consumer rows
  // The "Capacity by site" panel + its site filter were removed: the /16 site dimension was
  // synthetic (fabricated from an addr prefix), so useFilters/site chart state are gone too.
  const _whoNet=useApi('/api/whoami');
  const canEdit=(((_whoNet.data&&_whoNet.data.role)||'viewer')!=='viewer');
  const [leaseChart,leaseToggle]=useChartType(['pie','bar'],'pie');
  if(locked) return null;
  if(loading&&!data) return <div className="page"><Skeleton rows={8} label="Collecting data from Infoblox — first load can take a minute…"/></div>;
  if(error) return <div className="page"><Freshness error onRetry={refetch}/></div>;
  const subnets=(data&&data.subnets)||[];
  const leases=(data&&data.leases)||[];
  const drillKey=params.subnet||null;
  const drill=drillKey?subnets.find(s=>s.addr===drillKey||String(s.id)===drillKey):null;
  const drillLeases=drill?leasesInSubnet(leases,drill):[];

  // ── Synthesis band derivations ──
  const utilOf=s=>Number(s&&s.util)||0;
  const gt85=subnets.filter(s=>utilOf(s)>85).length;
  const b7085=subnets.filter(s=>{const u=utilOf(s);return u>=70&&u<=85;}).length;
  const activeLeases=leases.filter(l=>String(l.state||'').toLowerCase()==='active').length;
  const sorted=[...subnets].sort((a,b)=>utilOf(b)-utilOf(a));
  const worst=sorted[0]||null;
  const nearCount=subnets.filter(s=>utilOf(s)>70).length;
  const tone=gt85>0?'crit':b7085>0?'warn':'ok';
  const verdict=tone==='ok'
    ? 'DHCP capacity healthy — no subnet above 85%'
    : nearCount+' subnet'+(nearCount===1?'':'s')+' near exhaustion — worst: '+((worst&&(worst.name||worst.addr))||'—')+' at '+(worst?utilOf(worst):0)+'%';
  const facts=[
    {label:'Subnets >85%',value:gt85,delta:{v:delta('subnets.gt85'),good:'down'}},
    {label:'Watch 70-85%',value:b7085,delta:delta('subnets.b7085')},
    {label:'Active leases',value:activeLeases.toLocaleString(),delta:{v:delta('leases.active'),good:'up'}},
    {label:'Subnets total',value:subnets.length,delta:{v:delta('subnets.n'),good:'up'}},
  ];
  const chips=sorted.slice(0,3).map(s=>({
    label:(s.name||s.addr||'—')+' · '+utilOf(s)+'%',
    onClick:()=>nav('network',{subnet:s.addr||s.id}),
  }));

  const subnetCols=[
    {key:'name',label:'Subnet',render:(v,r)=>r.__group
      ? <span className="mono" style={{color:'var(--text-dim)',fontSize:'var(--t12)'}}>{r.__count} subnets at 100% ({(r.__group.split('|')[1])||''}) · Expand</span>
      : <span {...bind({title:(r.addr||'')+(r.cidr?('/'+r.cidr):''),
          rows:[['Util',utilOf(r)+'%'],['Site',r.site||'—'],['Leases',String(leasesInSubnet(leases,r).length)]],
          spark:histByAddr[r.addr]})}>{v||'—'}</span>},
    {key:'addr',label:'Network',mono:true,align:'left',render:(v,r)=>(r.addr||'')+(r.cidr?('/'+r.cidr):'')},
    {key:'util',label:'Utilization',align:'right',render:v=>UtilBar(v)},
    {key:'trend',label:'Trend',align:'left',spark:r=>histByAddr[r.addr]},
    {key:'site',label:'Site',hideSm:true,pivot:true},
    ...(canEdit?[{key:'__edit',label:'',align:'right',width:60,render:(v,r)=>r.__group?null:
      <button className="btn" onClick={e=>{e.stopPropagation();nav('editor',{type:'subnet',id:r.id||r.addr,name:r.name,cidr:r.cidr});}}>Edit subnet</button>}]:[]),
  ];

  // ── Address-exhaustion exception list ("Which subnets run out first?") + top consumers ──
  const totalOf=s=>Number(s.total)||Math.pow(2,32-(Number(s.cidr)||32));
  // Rank subnets by fewest free addresses (scarcity ASC), tie-break by util DESC, then collapse
  // runs of ≥5 fully-saturated (100%) subnets sharing a /cidr into one group row (Design C).
  const exhaustionRows=collapseIdentical(
    [...subnets].sort((a,b)=>((totalOf(a)-(Number(a.used)||0))-(totalOf(b)-(Number(b.used)||0)))||utilOf(b)-utilOf(a)),
    s=>utilOf(s)===100?('100|/'+(s.cidr||'')):null, 5);
  const healthyCount=subnets.filter(s=>utilOf(s)<70).length;
  const topN=[...subnets].sort((a,b)=>((totalOf(a)-(Number(a.used)||0))-(totalOf(b)-(Number(b.used)||0)))||utilOf(b)-utilOf(a)).slice(0,15);
  // Lease-state mix for the "Lease states" donut (Donut folds to 5 slices, tolerant of casing).
  const leaseStateCounts={};
  leases.forEach(l=>{const st=String(l.state||'unknown').toLowerCase();leaseStateCounts[st]=(leaseStateCounts[st]||0)+1;});
  const leaseSlices=Object.keys(leaseStateCounts).map(k=>({label:k,value:leaseStateCounts[k],
    color:k==='active'?'var(--ok)':k==='free'?'var(--text-faint)':(k==='expired'||k==='backup'||k==='offered')?'var(--warn)':'var(--accent)'}));
  // The subnets table owns all filtering now via BQL (subnetQuery ⇄ sq=); no pre-scoping here.
  // Still collapse 100%-util noise (≥5 rows sharing a /cidr → one group) unless expanded.
  const subnetRows=collapseIdentical(subnets,
    s=>{const sg=utilOf(s)===100?('100|/'+(s.cidr||'')):null; return (sg&&expandedSigs.has(sg))?null:sg;}, 5);

  // Compare-to-snapshot: prev.subnets.top is the only place the store keeps
  // per-row shape ({a,u} = addr,util for the top-20 by utilization — see
  // SnapshotWriter). Diffing against that (not a fresh snapshot system) means
  // the comparison is necessarily scoped to that top-20 set, not every subnet.
  const prevSubnetRows=(prev&&prev.subnets&&Array.isArray(prev.subnets.top))
    ?prev.subnets.top.map(t=>({addr:t.a,util:t.u})):[];
  const subnetDiff=(compareOn&&prev)
    ?diffRows(prevSubnetRows,subnetRows.filter(r=>!r.__group),r=>String(r.addr||r.id),['util'])
    :null;

  // Compare-to-snapshot (Leases): prev.leases.top mirrors the subnets top-N shape
  // (bounded, sorted by addr — leases have no natural "top" ranking; see
  // SnapshotWriter). Same scoping caveat as subnets: the diff runs against that
  // bounded prior set, not full lease history, so a lease outside the captured
  // top-50 will always read as "added" the first time it reappears.
  const prevLeaseRows=(prev&&prev.leases&&Array.isArray(prev.leases.top))
    ?prev.leases.top.map(t=>({addr:t.a,state:t.s,host:t.h})):[];
  const leaseKeyFn=r=>String(r.ip||r.addr||r.mac);
  const leaseDiff=(leaseCompareOn&&prev)
    ?diffRows(prevLeaseRows,leases,leaseKeyFn,['state','host'])
    :null;

  // Util-band presets → BQL tokens injected into the subnets search (replace any existing util
  // token; clicking the active band clears it). (The synthetic site: injection path was removed.)
  const UTIL_BQL={'100':'util>=100','9099':'util:90-99','7089':'util:70-89','lt70':'util<70'};
  const stripUtil=q=>String(q||'').split(/\s+/).filter(t=>t&&!/^-?util(:|>=|<=|>|<|=)/i.test(t)).join(' ');
  const activeUtilBand=(()=>{const parts=String(subnetQuery).split(/\s+/);for(const id in UTIL_BQL){if(parts.indexOf(UTIL_BQL[id])!==-1)return id;}return null;})();
  const injectUtilBand=id=>{const base=stripUtil(subnetQuery);setSubnetQuery((id==null||activeUtilBand===id)?base:((base?base+' ':'')+UTIL_BQL[id]));};

  return <div className="page fadein">
    <SynthBand tone={tone} verdict={verdict} facts={facts} chips={chips}/>
    {drillKey
      ? <section>
          <SectionRule title="Subnet detail"/>
          {drill
            ? <div className="grid">
                <div className="pcard">
                  <button className="btn btn-ghost" onClick={()=>history.back()}>← Back</button>
                  <div style={{marginTop:'var(--s3)',fontWeight:600}}>{drill.name}</div>
                  <div className="mono" style={{color:'var(--text-dim)',marginTop:'var(--s1)'}}>{drill.addr}/{drill.cidr}</div>
                  <div style={{marginTop:'var(--s3)'}}>{UtilBar(drill.util||0)}</div>
                  <div className="mono" style={{marginTop:'var(--s3)',color:'var(--text-dim)',fontSize:'var(--t12)'}}>
                    {drillLeases.length} lease{drillLeases.length===1?'':'s'} in subnet</div>
                </div>
                <Panel title={'Leases · '+drillLeases.length}>
                  {drillLeases.length
                    ? <DataTable cols={NET_LEASE_COLS} rows={drillLeases} defaultSort={{key:'addr',dir:'asc'}}
                        csvName={'leases-'+(drill.addr||drill.id)}
                        tableId={'drill-leases-'+(drill.addr||drill.id)} rowKey={r=>String(r.ip||r.addr||r.mac)} selectable/>
                    : <div className="dt-empty">No leases in this subnet</div>}
                </Panel>
              </div>
            : <div className="pcard">
                <button className="btn btn-ghost" onClick={()=>history.back()}>← Back</button>
                <div className="dt-empty">Subnet not found</div>
              </div>}
        </section>
      : <React.Fragment>
          <SectionRule title="Capacity & utilization"/>
          <div className="grid">
            <Panel title="Which subnets run out first?" empty={subnets.length===0}>
              <ExceptionPanel
                ariaLabel="Subnets by address exhaustion"
                strip={<ValueBands rows={subnets} valueFn={utilOf} bands={UTIL_BANDS}
                         value={activeUtilBand} onChange={injectUtilBand}/>}
                rows={exhaustionRows}
                topK={8}
                rowKey={(r,i)=>r.__group?('g'+i):(r.addr||r.id||i)}
                toneOf={r=>{const u=r.__group?100:utilOf(r); return u>85?'crit':u>70?'warn':'ok';}}
                onRow={r=>{ if(r.__group) return; nav('network',{subnet:r.addr||r.id}); }}
                renderRow={(r,i)=> r.__group
                  ? <div className="exrow-group">{r.__count} subnets at 100% · same /{r.cidr}</div>
                  : <div className="exrow-body">
                      <div className="exrow-name">
                        <span>{r.name||r.addr}</span>
                        <span className="mono exrow-cidr">{(r.addr||'')+(r.cidr?('/'+r.cidr):'')}</span>
                      </div>
                      {UtilBar(utilOf(r))}
                      <div className="exrow-free mono">
                        <b>{((totalOf(r)-(Number(r.used)||0))).toLocaleString()}</b> free
                        <span className="exrow-sub"> of {totalOf(r).toLocaleString()} · {utilOf(r)}%</span>
                      </div>
                      <Sparkline values={(histByAddr[r.addr]||[]).filter(x=>typeof x==='number')}/>
                    </div>}
                rollup={{count:healthyCount, label:healthyCount+' subnets under 70% — healthy, hidden → View all in table',
                         onClick:()=>{ injectUtilBand(null); const t=document.getElementById('net-subnets-table'); if(t) t.scrollIntoView({behavior:'smooth',block:'start'}); }}}
              />
            </Panel>
            <Panel title="Top consumers" empty={topN.length===0}>
              {/* Same short-sheeting as Overview's Top consumers: .issues carries
                  max-height:var(--body-chart) (220px, a small-chart token) but this card
                  is stretched to ~568px by the taller "Capacity by site" beside it —
                  measured 315px of dead void with rows still hidden. Fill the card and
                  scroll inside it. basis MUST be 0, not auto, or the list's own content
                  re-inflates the card and drags the whole grid row with it.
                  Only correct where a taller sibling defines the row height — the Daily
                  and Infra .issues lists SIZE their own cards, so they keep the cap. */}
              <div className="issues" style={{maxHeight:'none',flex:'1 1 0',minHeight:0}}>
                {topN.map((s,i)=>{
                  const go=()=>nav('network',{subnet:s.addr||s.id});
                  const hb=bind({title:(s.addr||'')+(s.cidr?('/'+s.cidr):''),
                    rows:[['Util',utilOf(s)+'%'],['Site',s.site||'—'],['Leases',String(leasesInSubnet(leases,s).length)]],
                    spark:histByAddr[s.addr]});
                  return <div key={i} className="issue" role="button" tabIndex={0}
                    onClick={go} onKeyDown={e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();go();}}} {...hb}>
                    <span className="rank mono">{i+1}</span>
                    <div className="body">
                      <div className="t mono">{(s.addr||'')+(s.cidr?('/'+s.cidr):'')}</div>
                      <div className="d">{(s.name||'—')+' · '+(s.site||'—')}</div>
                    </div>
                    {UtilBar(s.util||0)}
                    <button className="btn" onClick={e=>{e.stopPropagation();nav('provision',{space:'',cidr:24,from:s.addr});}}>Provision subnet →</button>
                  </div>;
                })}
              </div>
            </Panel>
            <div style={{gridColumn:'1/-1',display:'flex',flexWrap:'wrap',alignItems:'center',gap:'var(--s2)'}}>
              <span className="mono" style={{fontSize:'var(--t11)',color:'var(--text-faint)'}}>Filter</span>
              <ValueBands rows={subnets} valueFn={s=>Number(s.util)||0} bands={UTIL_BANDS}
                value={activeUtilBand} onChange={id=>injectUtilBand(id)}/>
              <span className="mono" style={{fontSize:'var(--t11)',color:'var(--text-faint)'}}>
                Type <code>site:name</code> or <code>util&gt;=90</code> in the table search to scope by site</span>
            </div>
            <div id="net-subnets-table" style={{gridColumn:'1/-1'}}>
              <Panel title="Subnets" side={<span style={{display:'flex',alignItems:'center',gap:'var(--s2)'}}>
                  <button className="btn btn-ghost" aria-pressed={compareOn}
                    disabled={!prev} title={prev?'Diff current top subnets against yesterday\'s snapshot':'A prior daily snapshot is needed'}
                    onClick={()=>{
                      const next=!compareOn; setCompareOn(next);
                      if(next&&prev){
                        const d=diffRows(prevSubnetRows,subnetRows.filter(r=>!r.__group),r=>String(r.addr||r.id),['util']);
                        let added=0,changed=0; d.byKey.forEach(v=>{if(v.type==='+')added++;else changed++;});
                        toast(added+' added · '+changed+' changed · '+d.ghosts.length+' removed','ok');
                      }
                    }}>{compareOn?'Comparing':'Compare to snapshot'}</button>
                  <Freshness at={fetchedAt} onRetry={refetch}/>
                </span>}>
                <DataTable cols={subnetCols} rows={subnetRows} defaultSort={{key:'util',dir:'desc'}}
                  scrollBody={480}
                  problemsOnly={{label:'Problems only',test:s=>utilOf(s)>70,default:true}}
                  onRowClick={r=>{ if(r.__group){ setExpandedSigs(prev=>{const n=new Set(prev); if(n.has(r.__group)) n.delete(r.__group); else n.add(r.__group); return n;}); return; } nav('network',{subnet:r.addr||r.id}); }}
                  csvName="subnets"
                  tableId="subnets" rowKey={r=>r.__group?('grp:'+r.__group):String(r.addr||r.id)} selectable
                  diffMap={subnetDiff?subnetDiff.byKey:null} diffGhosts={subnetDiff?subnetDiff.ghosts:null}
                  filterable filterKeys={['addr','name','site']} query={subnetQuery} onQuery={setSubnetQuery}
                  searchSchema={{fields:{util:{type:'number'},cidr:{type:'number',key:'cidr'}}}}
                  initialPeekKey={params.peek}
                  renderPeek={row=>{
                    const rl=leasesInSubnet(leases,row);
                    return <div>
                      <div style={{fontWeight:600}}>{row.name||'—'}</div>
                      <div className="mono" style={{color:'var(--text-dim)',marginTop:'var(--s1)'}}>{(row.addr||'')+(row.cidr?('/'+row.cidr):'')}</div>
                      <div style={{marginTop:'var(--s3)'}}>{UtilBar(row.util||0)}</div>
                      <div style={{marginTop:'var(--s2)',fontSize:'var(--t12)',color:'var(--text-dim)'}}>Site: {row.site||'—'}</div>
                      <div className="mono" style={{marginTop:'var(--s3)',color:'var(--text-dim)',fontSize:'var(--t12)'}}>{rl.length} lease{rl.length===1?'':'s'} in subnet</div>
                      <div style={{marginTop:'var(--s2)',display:'flex',flexDirection:'column',gap:2}}>
                        {rl.slice(0,20).map((l,i)=><div key={i} style={{display:'flex',justifyContent:'space-between',gap:'var(--s3)',fontSize:'var(--t12)'}}>
                          <span className="mono">{l.addr||'—'}</span>{StateText(l.state)}</div>)}
                        {rl.length>20?<div style={{fontSize:'var(--t11)',color:'var(--text-faint)',marginTop:2}}>+{rl.length-20} more</div>:null}
                      </div>
                    </div>;
                  }}
                  bulkActions={sel=>[{label:'Copy CIDRs',run:()=>{
                    const rows=sel.filter(r=>!r.__group);
                    const txt=rows.map(r=>(r.addr||'')+(r.cidr?('/'+r.cidr):'')).join('\n');
                    if(navigator.clipboard&&navigator.clipboard.writeText) navigator.clipboard.writeText(txt);
                    toast('Copied '+rows.length+' CIDR'+(rows.length===1?'':'s'),'ok');
                  }}]}/>
              </Panel>
            </div>
            <div style={{gridColumn:'1/-1',minWidth:0}}>
            <Panel title={'All leases · '+leases.length} side={
                <button className="btn btn-ghost" aria-pressed={leaseCompareOn}
                  disabled={!prev} title={prev?'Diff current leases against yesterday\'s snapshot':'A prior daily snapshot is needed'}
                  onClick={()=>{
                    const next=!leaseCompareOn; setLeaseCompareOn(next);
                    if(next&&prev){
                      const d=diffRows(prevLeaseRows,leases,leaseKeyFn,['state','host']);
                      let added=0,changed=0; d.byKey.forEach(v=>{if(v.type==='+')added++;else changed++;});
                      toast(added+' added · '+changed+' changed · '+d.ghosts.length+' removed','ok');
                    }
                  }}>{leaseCompareOn?'Comparing leases':'Compare leases to snapshot'}</button>
              }>
              <DataTable cols={NET_LEASE_COLS} rows={leases} defaultSort={{key:'addr',dir:'asc'}} csvName="leases"
                scrollBody={420}
                tableId="all-leases" rowKey={leaseKeyFn} selectable
                diffMap={leaseDiff?leaseDiff.byKey:null} diffGhosts={leaseDiff?leaseDiff.ghosts:null}/>
            </Panel>
            </div>
            <Panel title="Lease states" side={<>{leaseToggle}<span className="mono" style={{color:'var(--text-faint)'}}>{leases.length}</span></>} empty={leases.length===0}>
              <ChartView type={leaseChart} data={leaseSlices} donut={{centerValue:leases.length,centerLabel:"leases"}}/>
            </Panel>
          </div>
        </React.Fragment>}
    <IpamUtilPanel/>
    <DhcpLeasesPanel/>
  </div>;
}

const IPAM_UTIL_COLS=[
  {key:'label',label:'Space',align:'left',id:true},
  {key:'used',label:'Used',align:'right',mono:true},
  {key:'total',label:'Total',align:'right',mono:true},
  {key:'pct',label:'Utilization',align:'right',mono:true,render:v=>(v===''||v==null)?'—':(isNaN(Number(v))?'—':Number(v)+'%')},
];
function IpamUtilPanel(){
  const feed=useApi('/api/csp/ipam-util',{poll:30000});
  const rows=(feed.data&&feed.data.rows)||[];
  const status=feed.data&&feed.data.status;
  return <Panel title="IPAM utilization" api={feed}>
    {feed.error||status==='error'
      ? <ErrorState error="feed unavailable — CSP returned an error" onRetry={feed.refetch}/>
      : rows.length===0
        ? <div style={{padding:16,color:'var(--text-faint)',fontSize:12}}>No data in the current window</div>
        : <DataTable cols={IPAM_UTIL_COLS} rows={rows} defaultSort={{key:'pct',dir:'desc'}}
            filterable scrollBody={480} csvName="ipam-util" tableId="ipam-util" rowKey={r=>String(r.id||r.label)}/>}
  </Panel>;
}

const DHCP_LEASE_COLS=[
  {key:'address',label:'Address',align:'left',id:true},
  {key:'hostname',label:'Hostname',align:'left',render:v=>v||'—'},
  {key:'ends',label:'Ends',mono:true,render:v=>v||'—'},
  {key:'hardware',label:'Hardware',mono:true,render:v=>v||'—'},
  {key:'state',label:'State',align:'left',render:v=>StateText(v)},
];
function DhcpLeasesPanel(){
  const feed=useApi('/api/csp/dhcp-leases',{poll:30000});
  const rows=(feed.data&&feed.data.rows)||[];
  const status=feed.data&&feed.data.status;
  return <Panel title="DHCP leases" api={feed}>
    {feed.error||status==='error'
      ? <ErrorState error="feed unavailable — CSP returned an error" onRetry={feed.refetch}/>
      : rows.length===0
        ? <div style={{padding:16,color:'var(--text-faint)',fontSize:12}}>No data in the current window</div>
        : <DataTable cols={DHCP_LEASE_COLS} rows={rows} defaultSort={{key:'address',dir:'asc'}}
            filterable scrollBody={480} csvName="dhcp-leases" tableId="dhcp-leases" rowKey={r=>r.address}/>}
  </Panel>;
}

