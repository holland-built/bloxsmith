// Render caps for the two subnetPreview lists. OV_SHOWN clears every problems-only
// scope (the >70% pool is ~305), so it only bites under "All subnets"; OV_TRIAGE is a
// deliberate top-N — each row is a heavy 4-button action card, not a browse surface.
// Both are stated on screen when they bite; neither ever caps the underlying data.
const OV_SHOWN=300, OV_TRIAGE=6;

function OverviewTab(){
  const {bind}=useHoverDetail();
  const data=useData();
  const power=usePower();
  const fx=useFilters();

  const d=data.data||{};
  const subnets=Array.isArray(d.subnets)?d.subnets:[];
  const leases=Array.isArray(d.leases)?d.leases:[];
  const hosts=Array.isArray(d.hosts)?d.hosts:[];

  const util=s=>Number(s.util)||0;
  const activeLeases=leases.filter(l=>String(l.state||'').toLowerCase()==='active').length;

  // ── host status buckets ──
  const hostAgg=useMemo(()=>{
    let online=0,degraded=0,offline=0,other=0;
    for(const h of hosts){
      const st=String(h.status||'').toLowerCase();
      if(/^(online|up)$/.test(st)) online++;
      else if(/^(degraded|warn|warning)$/.test(st)) degraded++;
      else if(/^(offline|down|off|error)$/.test(st)) offline++;
      else other++;
    }
    return {online,degraded,offline,other};
  },[hosts]);
  const hostSlices=[
    {label:'online',value:hostAgg.online,color:'var(--ok)'},
    {label:'degraded',value:hostAgg.degraded,color:'var(--warn)'},
    {label:'offline',value:hostAgg.offline,color:'var(--crit)'},
    {label:'other',value:hostAgg.other,color:'var(--text-faint)'},
  ];
  const [hostChart,hostToggle]=useChartType(['pie','bar'],'pie');
  const attnHosts=hosts.filter(h=>!/^(online|up)$/i.test(String(h.status||''))).slice(0,6);

  // P1/4 — host-status stat numbers become app-wide cross-filter buttons: clicking
  // one toggles a FilterCtx scope on the shared `status` field (mirrored to the
  // `f=` view-state hash, chip shown + clearable in the FilterBar, and applied to
  // any table with a `status` column — e.g. Infra's host inventory). Announced on
  // the shared aria-live toast bus on add (removal already toasts via fx.remove).
  const hostScopeBtn=(v,n,color,short)=>{
    const active=fx.has('status',v);
    return <button type="button" className={'stat-crossfilter'+(active?' active':'')}
      data-scope={'status:'+v} aria-pressed={active}
      aria-label={'Filter to '+v+' hosts ('+n+') — app-wide scope'}
      onClick={e=>{ e.stopPropagation(); const was=fx.has('status',v);
        fx.toggle('status',v,'Status: '+v);
        if(!was) toast('Filtered · Status: '+v,'ok',{duration:1500}); }}
      style={{color,background:'none',border:'1px solid '+(active?'currentColor':'transparent'),
        borderRadius:4,padding:'0 3px',font:'inherit',lineHeight:'inherit',cursor:'pointer'}}>
      {n} <span className="triad-tag" style={{fontWeight:400,letterSpacing:'.02em'}}>{short}</span></button>;
  };

  // ── stat-strip numbers (real, derived from the subnets already fetched) ──
  const topSubs=useMemo(()=>[...subnets].sort((a,b)=>util(b)-util(a)),[subnets]);
  const worst=topSubs[0]||null;
  const worstUtil=worst?util(worst):0;
  const gt85=subnets.filter(s=>util(s)>85).length;
  const nearExhaust=subnets.filter(s=>util(s)>=90).length;
  const watch7085=subnets.filter(s=>{const u=util(s);return u>70&&u<=85;}).length;

  // ── control row: Problems-only scope + multi-select utilization-band chips ──
  const [probOn,setProbOn]=useState(true);
  const [bandsOn,setBandsOn]=useState(()=>UTIL_BANDS.map(b=>b.id)); // all bands active by default
  const probPool=useMemo(()=>subnets.filter(s=>util(s)>70),[subnets]);
  const probCount=probPool.length;
  const toggleBand=id=>setBandsOn(prev=>prev.includes(id)?prev.filter(x=>x!==id):[...prev,id]);
  // Feature 9 — capacity-panel band trigger (distribution-bar segment / legend
  // swatch ONLY, not the control-row chips above): keeps the existing local
  // preview-scope toggle AND ALSO writes a real, shareable FilterCtx cross-filter
  // (mirrored to the `f=` hash like any other pivot) using the lo-hi range
  // convention filterMatchesRow understands — so it stays live wherever the user
  // navigates next, on any table with a `util` column (e.g. Network's subnets
  // table), not just as an Overview-local preview filter.
  const toggleBandCross=id=>{
    toggleBand(id);
    const range=UTIL_BAND_RANGE[id];
    const band=UTIL_BANDS.find(b=>b.id===id);
    if(range) fx.toggle('util',range,'Utilization: '+(band?band.label:id));
  };
  // Per-band subnet counts (shared by the control-row chips AND the capacity-heatmap
  // distribution bar below — single source of truth, one semantic color per band).
  const bandCounts=useMemo(()=>UTIL_BANDS.map(b=>({
    ...b,
    cnt:subnets.filter(s=>b.test(util(s))).length,
    color:b.id==='lt70'?'var(--ok)':(b.id==='7089'?'var(--warn)':'var(--crit)'),
  })),[subnets]); // eslint-disable-line
  // Preview rows for Top consumers / Triage — Problems-only scope, then AND'd against
  // whichever util bands are still selected (removable chips), worst-first.
  const subnetPreview=useMemo(()=>{
    const pool=probOn?probPool:subnets;
    const active=UTIL_BANDS.filter(b=>bandsOn.includes(b.id));
    const out=active.length?pool.filter(s=>active.some(b=>b.test(util(s)))):[];
    return [...out].sort((a,b)=>util(b)-util(a));
  },[subnets,probPool,probOn,bandsOn]); // eslint-disable-line

  // ── capacity by site (real aggregation, worst-first, full list — no artificial cap) ──
  const siteRows=useMemo(()=>{
    // Backend defaults an untagged subnet's site to "–"; fall back to the /16 prefix so
    // untagged subnets still group into meaningful buckets instead of collapsing to one.
    const siteKey=s=>(s.site&&s.site!=='–')?s.site:(String(s.addr||'').split('.').slice(0,2).join('.')+'.0.0/16');
    const m={};
    for(const s of subnets){
      const nm=siteKey(s);
      const u=util(s);
      const r=m[nm]||(m[nm]={nm,n:0,sum:0,worst:0});
      r.n++; r.sum+=u; if(u>r.worst) r.worst=u;
    }
    return Object.values(m)
      .map(r=>({nm:r.nm,n:r.n,avg:Math.round(r.sum/r.n),worst:r.worst}))
      .sort((a,b)=>b.avg-a.avg);
  },[subnets]);

  // Vault locked → render nothing; the gate handles it. (After all hooks.)
  if(data.locked) return null;
  // First-load harvest → collecting indicator, not a misleading all-zeros board.
  // Overview is the landing tab, so this is the first thing seen; matches the
  // Daily/Network/DNS skeletons on the same shared /api/data feed.
  if(data.loading&&!data.data) return <div className="page"><Skeleton rows={8} label="Collecting data from Infoblox — first load can take a minute…"/></div>;

  // Answer-first band. Every other tab opens with a verdict; Overview — the LANDING
  // tab, the first thing anyone sees — opened with raw counters and made you derive it
  // yourself. It never had one (git log -S SynthBand on this file is empty), so this is
  // a gap against the v2 contract, not a regression. Must sit after the locked/loading
  // returns above, or it renders a verdict over a locked vault.
  // Every value here is already computed above; nothing new is fetched or derived.
  const ovTone=nearExhaust>0?'crit':gt85>0?'warn':'ok';
  const ovVerdict=ovTone==='ok'
    ? 'Capacity is healthy — no subnet is above 85%.'
    : ovTone==='warn'
      ? gt85+' subnet'+(gt85===1?'':'s')+' above 85% — none critical yet.'
      : nearExhaust+' subnet'+(nearExhaust===1?'':'s')+' at or above 90% — new DHCP leases will start failing.';
  const ovFacts=[
    {label:'near exhaustion',value:nearExhaust},
    {label:'>85%',value:gt85},
    {label:'watch 70-85%',value:watch7085},
    {label:'active leases',value:activeLeases},
    {label:'subnets',value:subnets.length},
  ];
  // NO chips: SynthBand renders them as .band-chip — the exact class AND labels the
  // utilization-band control row below already uses. Passing chips here put a SECOND,
  // identical set of band filters on the page. Three specs' strict-mode violations were
  // the symptom; the duplicated control was the defect. The verdict and facts are what
  // Overview was missing — the band filters already exist a few lines down.

  return <div className="page ovx">

    <SynthBand tone={ovTone} verdict={ovVerdict} facts={ovFacts}/>

    <div className="statstrip">
      <div className="stat" tabIndex={0} style={{cursor:'help'}}
        {...bind({title:'Subnets',rows:[['What it means','Total subnets managed across all sites.']]})}>
        <span className="k">Subnets</span><span className="v num">{subnets.length.toLocaleString()}</span></div>
      <div className="stat" tabIndex={0} style={{cursor:'help'}}
        {...bind({title:'Near exhaustion',rows:[
          ['Threshold','Subnets ≥90% full — new DHCP leases will start failing soon.'],
          ['worst N%',worst?('The single most-full subnet overall is at '+worstUtil+'%, whether or not any subnet is near exhaustion.'):'No subnets yet.'],
        ]})}>
        <span className="k">Near exhaustion</span>
        <span className={'v num'+(nearExhaust>0?' crit':'')}>{nearExhaust}{worst?<small>worst {worstUtil}%</small>:null}</span></div>
      <div className="stat" tabIndex={0} style={{cursor:'help'}}
        {...bind({title:'>85% full',rows:[['Threshold','Subnets over 85% full (not counting exactly 85%) — plan additional capacity soon.']]})}>
        <span className="k">&gt;85%</span><span className={'v num'+(gt85>0?' warn':'')}>{gt85}</span></div>
      <div className="stat" tabIndex={0} style={{cursor:'help'}}
        {...bind({title:'Watch 70-85%',rows:[['Threshold','Subnets between 71% and 85% full — healthy for now, but worth watching for growth.']]})}>
        <span className="k">Watch 70-85%</span><span className="v num">{watch7085}</span></div>
      <div className="stat" tabIndex={0} style={{cursor:'help'}}
        {...bind({title:'Active leases',rows:[['What it means','DHCP leases currently marked active — i.e. currently allocated to a device.']]})}>
        <span className="k">Active leases</span><span className="v num">{activeLeases.toLocaleString()}</span></div>
      <div className="stat" tabIndex={0} style={{cursor:'help'}}
        {...bind({title:'Hosts',rows:[
          ['Total',hosts.length.toLocaleString()+' hosts'],
          ['Reading the '+hostAgg.online+'/'+hostAgg.degraded+'/'+hostAgg.offline,hostAgg.online+' online (reachable) / '+hostAgg.degraded+' degraded (reporting a warning) / '+hostAgg.offline+' offline (unreachable)'+(hostAgg.other?' — '+hostAgg.other+' with an unrecognized status':'')+'.'],
        ]})}>
        <span className="k">Hosts</span>
        <span className="v num">{hosts.length.toLocaleString()} <small className="host-triad">
          {hostScopeBtn('online',hostAgg.online,'var(--ok)','up')}/{hostScopeBtn('degraded',hostAgg.degraded,'var(--warn)','deg')}/{hostScopeBtn('offline',hostAgg.offline,'var(--crit)','down')}
        </small></span></div>
    </div>

    <div className="controls">
      <div className="seg" role="group" aria-label="Filter scope">
        <button type="button" aria-pressed={probOn} onClick={()=>setProbOn(true)}>
          <span className="glyph" aria-hidden="true">{probOn?'●':'○'}</span>Problems only</button>
        <button type="button" aria-pressed={!probOn} onClick={()=>setProbOn(false)}>
          <span className="glyph" aria-hidden="true">{!probOn?'●':'○'}</span>All subnets</button>
      </div>
      <span className="seg-lbl">showing <b>{probCount}</b> problem subnet{probCount===1?'':'s'} of <b>{subnets.length}</b></span>

      <span className="chips-lbl">Utilization band</span>
      <div className="chips">
        {bandCounts.map(b=>{
          const on=bandsOn.includes(b.id);
          return <button key={b.id} type="button" className={'chip band-chip'+(on?' active':' off')}
            aria-pressed={on} onClick={()=>toggleBand(b.id)}
            {...bind({title:b.label+' utilization',rows:[['What it means','Show only subnets in this utilization range — click to '+(on?'hide':'show')+'.'],['Currently matching',b.cnt+' subnet'+(b.cnt===1?'':'s')]]})}>
            <span aria-hidden="true" style={{width:7,height:7,borderRadius:2,background:b.color,display:'inline-block'}}/>
            {b.label}<span className="cnt num">{b.cnt}</span><span className="x">{on?'×':'+'}</span>
          </button>;
        })}
      </div>
    </div>

    <div className="ovx-detail">

      <div className="span-6">
        <Panel title="Capacity heatmap" empty={siteRows.length<2}
          side={<span className="mono" tabIndex={0} style={{cursor:'help'}}
            {...bind({title:'Capacity heatmap',rows:[
              ['Grouping','Subnets grouped by tagged site (or by /16 network when untagged).'],
              ['Order','Worst-first, by average utilization.'],
            ]})}>{siteRows.length+' sites'}</span>}>
          {/* Utilization distribution — segmented bar of the 4 UTIL_BANDS counts.
              Click a segment (or a legend swatch below) to toggle that band's local
              preview scope AND write a live FilterCtx cross-filter (toggleBandCross,
              Feature 9) — in place, no navigation; it just also stays active for
              whichever table (anywhere) happens to have a `util` column. */}
          <div className="dist-wrap ov-mt">
            <div className="dist-bar" role="group" aria-label="Utilization distribution — click a band to filter">
              {bandCounts.map(b=>{
                const on=bandsOn.includes(b.id);
                return <button key={b.id} type="button" className={'dist-seg'+(on?'':' off')}
                  style={{flex:b.cnt||0.0001,background:b.color}}
                  aria-pressed={on} onClick={()=>toggleBandCross(b.id)}
                  {...bind({title:b.label+' utilization',rows:[
                    ['Count',b.cnt+' subnet'+(b.cnt===1?'':'s')],
                    ['What it means','Click to '+(on?'hide':'show')+' this band — cross-filters live, same as the legend below.'],
                  ]})}/>;
              })}
            </div>
            <div className="dist-legend">
              {bandCounts.map(b=>{
                const on=bandsOn.includes(b.id);
                return <button key={b.id} type="button" className={'dist-legend-sw'+(on?'':' off')}
                  aria-pressed={on} aria-label={(on?'Hide ':'Show ')+b.label+' utilization band'}
                  onClick={()=>toggleBandCross(b.id)}>
                  <i className="sw" style={{background:b.color}}/>{b.label}<b className="mono"> {b.cnt}</b>
                </button>;
              })}
            </div>
          </div>

          {/* Capacity heatmap — every site as one small colored cell, worst-first
              (siteRows is already sorted worst-first). Hover/focus = avg/worst/subnet
              count; click drills into Network scoped to that site. */}
          <div className="heatmap-wrap">
            <div className="heatmap" role="list" aria-label={siteRows.length+' sites, worst-first'}>
              {siteRows.map((s,i)=>{
                const bnd=s.avg>=90?'crit':s.avg>=70?'warn':'ok';
                // Feature 9 — if a DataTable with a `site` column is already mounted
                // on THIS page, cross-filter it in place (fx.toggle) instead of
                // navigating away; otherwise fall back to the original nav-drill
                // (Overview's own "All leases" table has no `site` column, so today
                // this always nav-drills — same behavior as before this feature).
                const go=()=>{
                  if(power&&power.hasField&&power.hasField('site')) fx.toggle('site',s.nm,'Site: '+s.nm);
                  else nav('network',{f:serializeFilters([{field:'site',value:s.nm}])});
                };
                return <div key={s.nm+'|'+i} className={'heatcell '+bnd} role="button" tabIndex={0}
                  aria-label={s.nm+' — avg '+s.avg+'%, worst '+s.worst+'%, '+s.n+' subnet'+(s.n===1?'':'s')}
                  onClick={go} onKeyDown={e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();go();}}}
                  {...bind({title:s.nm,rows:[['Avg',s.avg+'%'],['Worst',s.worst+'%'],['Subnets',s.n]]})}/>;
              })}
            </div>
            <div className="heatmap-legend">
              <span><i className="sw crit"/>Exhausted ≥90%</span>
              <span><i className="sw warn"/>Warning 70-89%</span>
              <span><i className="sw ok"/>Healthy &lt;70%</span>
              <span className="heatmap-note">click a cell to drill into Network</span>
            </div>
          </div>
        </Panel>
      </div>

      <div className="span-3">
        <Panel title="Top consumers"
          side={<span className="mono" tabIndex={0} style={{cursor:'help'}}
            {...bind({title:'Top consumers',rows:[
              ['Matching','Subnets passing the current scope + utilization-band filters.'],
              ['Order','Biggest address consumers first (by addresses used).'],
            ]})}>{subnetPreview.length} matching</span>}>
          {/* .issues' class-level max-height is a --body-chart (220px) token borrowed
              from the chart-body panels; it doesn't track this pcard's actual height,
              which grid-stretches to match its row (e.g. 638px next to Capacity
              heatmap) — so the list was clamped to a tiny 220px scroller inside a much
              taller, mostly-empty card. Override inline: fill the pcard's flex column
              instead of a fixed pixel cap. */}
          {/* .issues ships max-height:var(--body-chart) — a 220px cap borrowed from the
              small chart bodies. This card is span-3 in a stretch row, so it's ~638px
              tall (sized by the taller Capacity heatmap beside it): 3 rows showed and
              the rest was dead void. Fill the card instead — but flex-BASIS must be 0,
              not auto: with `auto` the list's full 60-row content still counts toward the
              pcard's height, so the card grew to 2198px and dragged every sibling in the
              row up with it. basis:0 + min-height:0 + the class's own overflow-y:auto =
              the list takes only leftover space and scrolls inside it. */}
          <div className="issues" style={{maxHeight:'420px',overflowY:'auto',minHeight:0}}>
            {subnetPreview.length
              ? [...subnetPreview].sort((a,b)=>((Number(b.used)||0)-(Number(a.used)||0))||util(b)-util(a)).slice(0,OV_SHOWN).map((s,i)=>{
                  const go=()=>nav('network',{subnet:s.addr||s.id});
                  const label=(s.addr||s.name||'—')+(s.cidr?('/'+s.cidr):'');
                  const u=util(s);
                  const free=(s.total!=null&&s.used!=null)?Math.max(0,s.total-s.used):null;
                  // "–" is the backend's sentinel for "no site tag" — never render it as a
                  // bare dash line; the CIDR is already visible above, so just omit the line.
                  const hasSite=!!s.site&&s.site!=='–'&&s.site!=='-';
                  return <div key={s.id||s.addr||i} className="issue" role="button" tabIndex={0}
                    onClick={go} onKeyDown={e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();go();}}}
                    {...bind({title:label,rows:[
                      ['Site',hasSite?s.site:'Unscoped (no site tag)'],
                      ['Utilization',u+'% of pool used'],
                      ...(free!=null?[['Free addresses',free]]:[]),
                    ]})}>
                    <span className="rank mono">{i+1}</span>
                    <div className="body">
                      <div className="t mono">{label}</div>
                      {hasSite?<div className="d">{s.site}</div>:null}
                    </div>
                    {UtilBar(u)}
                  </div>;
                })
              : <div style={{color:'var(--text-faint)',fontSize:12,padding:'8px 4px'}}>No subnets match the current filters</div>}
            {/* The side badge counts the whole match set; the list must reconcile with it.
                It scrolls, so it shows everything up to OV_SHOWN — only the degenerate
                "All subnets" scope (thousands of hover-bound, non-virtualized rows) hits
                the cap, and then it says so rather than dropping rows in silence. */}
            {subnetPreview.length>OV_SHOWN
              ? <div role="button" tabIndex={0} onClick={()=>nav('network')}
                  onKeyDown={e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();nav('network');}}}
                  style={{fontSize:'var(--t11)',color:'var(--text-faint)',marginTop:2,cursor:'pointer',padding:'4px'}}>
                  +{subnetPreview.length-OV_SHOWN} more — open Network for the full table</div>
              : null}
          </div>
        </Panel>
      </div>

      <div className="span-3">
        <Panel title="Host status" side={<>{hostToggle}<span>{hosts.length.toLocaleString()+' hosts'}</span></>}>
          <div className="chart-body">
            <ChartView type={hostChart} data={hostSlices} donut={{
              centerValue:hosts.length?Math.round(hostAgg.online/hosts.length*100)+'%':'0',centerLabel:"online",
              centerDetail:'Reachability of your '+hosts.length.toLocaleString()+' managed hosts — the percentage that are currently online.',
              legendDetail:l=>({
                online:'Host responded to reachability checks — considered healthy.',
                degraded:'Host is reachable but reporting a warning status.',
                offline:'Host did not respond — down or unreachable.',
                other:"Status not recognized by the dashboard — not counted as online, degraded, or offline.",
              }[l]||l)}}/>
          </div>
          {attnHosts.length?<div style={{marginTop:10,paddingTop:8,borderTop:'1px solid var(--border)',display:'flex',flexDirection:'column',gap:6}}>
            {attnHosts.map((h,i)=>{
              const st=String(h.status||'').toLowerCase();
              const sv=/^(offline|down|off|error)$/.test(st)?'crit':/^(degraded|warn|warning)$/.test(st)?'high':'low';
              const meaning=sv==='crit'?'Unreachable — investigate connectivity.':sv==='high'?'Reporting a warning — degraded but reachable.':'Status not recognized by the dashboard.';
              const go=()=>nav('infra',{host:h.name});
              return <div key={h.id||h.name||i} role="button" tabIndex={0} onClick={go}
                onKeyDown={e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();go();}}}
                style={{display:'flex',justifyContent:'space-between',alignItems:'center',gap:8,cursor:'pointer'}}
                {...bind({title:'Host '+(h.name||h.ip||'—'),rows:[['Status',h.status||'—'],['What it means',meaning+' Click to investigate.']]})}>
                <span className="mono" style={{fontSize:11,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{h.name||h.ip||'—'}</span>
                <span className={'sev '+sv}>{h.status||'—'}</span>
              </div>;
            })}
          </div>:null}
        </Panel>
      </div>

      <div className="span-8">
        <Panel title="All leases" empty={!leases.length}
          side={<span className="mono" tabIndex={0}
            aria-label={'Hidden columns: MAC address and Lease expires — not provided by this data source'}
            style={{cursor:'help',textDecoration:'underline dotted'}}
            {...bind({title:'Hidden columns',rows:[['MAC address','not provided by this data source'],['Lease expires','not provided by this data source']]})}>
            {leases.length.toLocaleString()+' rows · '+activeLeases.toLocaleString()+' active · MAC column hidden ⓘ'}</span>}>
          <DataTable tableId="ov-leases" csvName="active-leases" scrollBody={280}
            rows={leases} rowKey={r=>String(r.addr||r.ip||'')+'|'+String(r.host||'')}
            onRowClick={()=>nav('network')}
            cols={[
              {key:'addr',label:'IP address',primary:true,minWidth:150,mono:true,align:'left'},
              {key:'state',label:'State',align:'left',render:v=>StateText(v)},
              {key:'host',label:'Hostname',render:v=>v||'—'},
            ]}
            renderPeek={l=><OvPeek title={l.addr} sub={l.host}
              rows={[['Host',l.host],['State',l.state],['Subnet',l.subnet]]}/>}/>
        </Panel>
      </div>

      <div className="span-4">
        {/* The badge says "top 6 of N" whenever the cap bites — the list is a deliberate
            top-N, so the number beside the title must not read as the whole queue. */}
        <Panel title="Triage queue" size="md" side={<span className={'sev '+(subnetPreview.length?'crit':'low')}>{subnetPreview.length>OV_TRIAGE?('top '+OV_TRIAGE+' of '+subnetPreview.length+' need action'):(subnetPreview.length+' need action')}</span>}>
          {subnetPreview.length
            ? subnetPreview.slice(0,OV_TRIAGE).map((s,i)=>{
                const u=util(s);
                const label=(s.addr||s.name||'—')+(s.cidr?('/'+s.cidr):'');
                const free=(s.total!=null&&s.used!=null)?Math.max(0,s.total-s.used):null;
                return <div className="triage-row" key={s.id||s.addr||i}>
                  <span className="idx mono">{i+1}</span>
                  <span className="what">
                    <b className="mono">{label}</b> <span className={'sev '+(u>=90?'crit':u>70?'high':'med')}>{u}%</span>
                    <div className="meta">{(s.site||'—')+(free!=null?(' · '+free+' free'):'')}</div>
                  </span>
                  <span className="act">
                    <button type="button" className="btn btn-accent"
                      {...bind({title:'Provision subnet',rows:[['Site',s.site],['Util',u+'%'],['Free',free!=null?free:'—']]})}
                      onClick={()=>nav('provision',{space:'',cidr:24,from:s.addr})}>Provision →</button>
                    <button type="button" className="btn"
                      {...bind({title:'Review drift',rows:[['Subnet',label],['Site',s.site]]})}
                      onClick={()=>nav('drift')}>Drift</button>
                    <button type="button" className="btn"
                      {...bind({title:'Self-service',rows:[['Subnet',label],['Site',s.site]]})}
                      onClick={()=>nav('selfservice')}>Self-serve</button>
                    <button type="button" className="btn"
                      {...bind({title:'Open in editor',rows:[['Subnet',label],['Site',s.site]]})}
                      onClick={()=>nav('editor',{type:'subnet',id:s.id||s.addr,name:s.name,cidr:s.cidr})}>Editor</button>
                  </span>
                </div>;
              })
            : <div style={{color:'var(--text-faint)',fontSize:12,padding:'10px 4px',textAlign:'center'}}>✓ No subnets need action</div>}
          {subnetPreview.length>OV_TRIAGE
            ? <div role="button" tabIndex={0} onClick={()=>nav('network')}
                onKeyDown={e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();nav('network');}}}
                style={{fontSize:'var(--t11)',color:'var(--text-faint)',marginTop:2,cursor:'pointer',padding:'4px'}}>
                +{subnetPreview.length-OV_TRIAGE} more — see Top consumers or open Network</div>
            : null}
        </Panel>
      </div>

      <div className="span-12">
        <LicenseAlertsPanel/>
      </div>

    </div>
  </div>;
}
// ── License & alerts tile (read-only, appended — see BUILD_SPEC.md) ──
function ovxLicenseStateBadge(v){
  const s=String(v||'').toLowerCase();
  const variant=s==='active'?'success':s==='expired'?'error':'default';
  return <Astryx.Badge variant={variant} label={v||'—'}/>;
}
function ovxAlertSevBadge(v){
  const s=String(v||'').toLowerCase();
  const variant=(s==='high'||s==='critical')?'error':s==='warning'?'warning':'default';
  return <Astryx.Badge variant={variant} label={v||'—'}/>;
}
function ovxExpiryCell(v){
  const t=v?Date.parse(v):NaN;
  if(isNaN(t)) return <span className="mono">{v||'—'}</span>;
  const days=Math.round((t-Date.now())/86400000);
  const soon=days>=0&&days<=30;
  return <span className="mono" style={soon?{color:'var(--sev-crit,#e5484d)',fontWeight:600}:undefined}>{v}</span>;
}
function LicenseAlertsPanel(){
  const feed=useApi('/api/csp/license-alerts',{poll:300000});
  const licenses=(feed.data&&feed.data.licenses)||[];
  const alerts=(feed.data&&feed.data.alerts)||[];
  const status=feed.data&&feed.data.status;
  const licenseCols=[
    {key:'type',label:'Type',primary:true},
    {key:'state',label:'State',render:ovxLicenseStateBadge},
    {key:'expiry',label:'Expiry',render:ovxExpiryCell},
  ];
  const alertCols=[
    {key:'title',label:'Title',primary:true},
    {key:'severity',label:'Severity',render:ovxAlertSevBadge},
    {key:'created_at',label:'Created',mono:true},
  ];
  return <Panel title="Licenses & Portal Alerts" api={feed}>
    {feed.error||status==='error' ? <ErrorState error="feed unavailable — CSP returned an error" onRetry={feed.refetch}/>
     : (licenses.length===0&&alerts.length===0) ? <div style={{padding:16,color:'var(--text-faint)',fontSize:12}}>No data in the current window</div>
     : <>
        {licenses.length===0
          ? <div style={{padding:'8px 4px',color:'var(--text-faint)',fontSize:12}}>No licenses</div>
          : <DataTable cols={licenseCols} rows={licenses} rowKey={r=>String(r.id||r.type)} tableId="ovx-licenses" csvName="ovx-licenses" scrollBody={220}/>}
        {alerts.length===0
          ? <div style={{padding:'8px 4px',color:'var(--text-faint)',fontSize:12}}>No alerts</div>
          : <DataTable cols={alertCols} rows={alerts.slice(0,50)} rowKey={r=>String(r.id||r.title)} tableId="ovx-alerts" csvName="ovx-alerts" scrollBody={280}/>}
       </>}
  </Panel>;
}
// ═══ END: OVERVIEW ═══

// ═══ REGION: DAILY ═══
/* Daily — exec day-over-day summary. Answer-first: one-line narrative (LLM,
   cached once/day, deterministic fallback) → period deltas → top movers →
   open-issues rollup. Reuses useData/useApi/useSnapshots/Delta/Freshness/nav. */
(function injectDailyStyles(){
  if(document.getElementById('bx-daily-styles')) return;
  const s=document.createElement('style');s.id='bx-daily-styles';
  s.textContent=`
  .dly-head{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;}
  .dly-title{margin:0;font-size:13px;font-weight:600;color:var(--text);}
  .dly-base{font-size:11px;color:var(--text-dim);}
  .dly-seg{display:inline-flex;border:1px solid var(--border);border-radius:var(--r-ctl);overflow:hidden;}
  .dly-seg-btn{height:28px;padding:0 12px;font-size:12px;font-weight:500;color:var(--text-dim);background:transparent;border:none;border-right:1px solid var(--border);}
  .dly-seg-btn:last-child{border-right:none;}
  .dly-seg-btn.on{background:var(--raised);color:var(--text);}
  .dly-seg-btn:disabled{color:var(--text-faint);cursor:not-allowed;}
  .dly-note{font-size:11px;color:var(--text-faint);margin-top:8px;}
  .dly-trow{display:flex;align-items:center;gap:10px;padding:7px 0;border-bottom:1px solid var(--border2);}
  .dly-trow:last-child{border-bottom:none;}
  .dly-trow-l{flex:0 0 108px;font-size:12px;color:var(--text-dim);}
  .dly-trow-s{flex:1 1 auto;min-width:0;display:flex;align-items:center;}
  .dly-trow-v{flex:0 0 44px;text-align:right;font-size:12px;color:var(--text);}
  .dly-sev{display:flex;gap:6px;cursor:pointer;margin-bottom:10px;}
  .dly-sev-cell{flex:1 1 0;padding:8px 6px;border:1px solid var(--border);border-radius:var(--r-ctl);text-align:center;background:var(--surface);transition:border-color .12s ease;}
  .dly-sev:hover .dly-sev-cell{border-color:var(--border-strong);}
  .dly-sev-n{font-size:20px;line-height:1.1;}
  .dly-sev-l{font-size:10px;text-transform:uppercase;letter-spacing:.04em;color:var(--text-dim);margin-top:2px;}
  .dly-hourly{display:flex;align-items:center;gap:8px;}
  `;
  document.head.appendChild(s);
})();

