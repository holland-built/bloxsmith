const DAILY_NO_KEY=/no (?:llm|ai)[\s\S]{0,24}(?:key|provider|configured)|configure[\s\S]{0,24}(?:llm|ai|provider)|provider is not configured|add[\s\S]{0,12}api key|no ai provider/i;

function DailyTab(){
  const {data,fetchedAt,refetch,error,locked,loading}=useData();
  const sec=useApi('/api/hub/security');
  const hover=useHoverDetail();

  // ── Snapshot baselines (read straight from the store for period control) ──
  const ti=todayISO();
  const allDays=(readSnaps().days||[]).slice().sort((a,b)=>String(a.date).localeCompare(String(b.date)));
  const priorDays=allDays.filter(d=>d&&d.date<ti);
  const firstRun=priorDays.length===0;
  const yesterdaySnap=priorDays.length?priorDays[priorDays.length-1]:null;
  const wa=new Date();wa.setDate(wa.getDate()-7);const weekAgoISO=wa.toISOString().slice(0,10);
  const weekSnap=priorDays.filter(d=>d.date<=weekAgoISO).slice(-1)[0]||null;

  const [period,setPeriod]=useState(()=>weekSnap&&!yesterdaySnap?'7d':'yesterday');
  const [narrative,setNarrative]=useState(null);
  const narrRef=useRef(false);
  const baseline=period==='7d'?weekSnap:yesterdaySnap;

  // ── Live derivations (numerator for deltas comes from current data) ──
  const subnets=Array.isArray(data&&data.subnets)?data.subnets:[];
  const leases=Array.isArray(data&&data.leases)?data.leases:[];
  const zones=Array.isArray(data&&data.zones)?data.zones:[];
  const hosts=Array.isArray(data&&data.hosts)?data.hosts:[];
  const utilOf=s=>Number(s&&s.util)||0;
  const nSub=subnets.length,nZone=zones.length,nHost=hosts.length;
  const gt85=subnets.filter(s=>utilOf(s)>85).length;
  const b7085=subnets.filter(s=>{const u=utilOf(s);return u>=70&&u<=85;}).length;
  const activeLeases=leases.filter(l=>String(l.state||'').toLowerCase()==='active').length;
  const zoneIssues=zones.filter(z=>Array.isArray(z.issues)&&z.issues.length>0).length;
  const online=hosts.filter(h=>/^(online|up)$/i.test(String(h.status||''))).length;
  const hostsOffline=nHost-online;
  const sortedSubs=[...subnets].sort((a,b)=>utilOf(b)-utilOf(a));
  const worst=sortedSubs[0]||null;
  const worstUtil=worst?Math.round(utilOf(worst)):0;

  const counts=(sec.data&&sec.data.counts)||{};
  const critThreats=Number(counts.critical)||0;
  const highThreats=Number(counts.high)||0;
  const blocked=Number(sec.data&&sec.data.blocked)||0;
  const acks=LS.get('acks',{});
  const secEvents=(sec.data&&Array.isArray(sec.data.events))?sec.data.events:[];
  const unacked=secEvents.filter(e=>!acks[(e.event_time||'')+'|'+(e.qname||'')]);
  const uCrit=unacked.filter(e=>String(e.severity||'').toLowerCase()==='critical').length;
  const uHigh=unacked.filter(e=>String(e.severity||'').toLowerCase()==='high').length;

  const liveSnap={
    subnets:{n:nSub,gt85,b7085},
    leases:{n:leases.length,active:activeLeases},
    zones:{n:nZone,issues:zoneIssues},
    hosts:{n:nHost,online,offline:hostsOffline},
    sec:{crit:critThreats,high:highThreats,blocked},
  };
  const bdelta=(path)=>{
    if(!baseline) return null;
    const cur=snapPath(liveSnap,path),old=snapPath(baseline,path);
    if(typeof cur!=='number'||typeof old!=='number') return null;
    return cur-old;
  };

  // ── 1. One-line narrative — LLM (10s), cached once/day, else template ──
  const dataReady=data!=null;
  const secReady=!!(sec.data||sec.error||sec.locked);
  useEffect(()=>{
    if(narrRef.current) return;
    const cached=LS.get('dailyNarrative',null);
    if(cached&&cached.date===ti&&typeof cached.text==='string'&&cached.text){
      narrRef.current=true;setNarrative(cached.text);return;
    }
    if(!(dataReady&&secReady)) return;
    narrRef.current=true;
    let alive=true;
    const ctrl=new AbortController();
    const timer=setTimeout(()=>ctrl.abort(),10000);
    const ctx=nSub+' subnets, worst subnet utilization '+worstUtil+'%, '+gt85+' subnets over 85% capacity, '+
      critThreats+' critical threats, '+hostsOffline+' of '+nHost+' hosts offline, '+zoneIssues+' DNS zones with issues.';
    const fallback='Network is '+((critThreats>0||gt85>0||hostsOffline>0)?'degraded':'healthy')+': '+
      nSub+' subnets tracked, '+gt85+' near capacity, '+critThreats+' critical threats, '+hostsOffline+' hosts offline.';
    const finish=text=>{ if(!alive) return; setNarrative(text); LS.set('dailyNarrative',{date:ti,text}); };
    fetch('/api/query',{method:'POST',headers:{'Content-Type':'application/json'},signal:ctrl.signal,
      body:JSON.stringify({question:"In one sentence for an executive, summarize today's network health.",context:ctx})})
      .then(async r=>{const j=await r.json().catch(()=>null);return {r,j};})
      .then(({r,j})=>{
        const ans=(j&&typeof j.answer==='string')?j.answer.trim():'';
        const bad=!r.ok||r.status===503||(j&&(j.error||j.locked))||!ans||DAILY_NO_KEY.test(ans)||ans.length<12||/^(no content|n\/?a|none|null|undefined|no data)\.?$/i.test(ans);
        finish(bad?fallback:ans);
      })
      .catch(()=>finish(fallback))
      .finally(()=>clearTimeout(timer));
    return ()=>{alive=false;ctrl.abort();clearTimeout(timer);};
  },[dataReady,secReady]);

  // ── 2. KPI-spark tiles — count-up value + trend from bdelta + 30-day spark ──
  // Per-day series pulled straight from stored snapshot history (no fabrication).
  const seriesOf=path=>allDays.map(dd=>snapPath(dd,path)).filter(v=>typeof v==='number'&&isFinite(v));
  const trendFor=(path,good)=>{
    const dv=bdelta(path);
    if(dv==null) return {trend:null,trendDir:'flat'};
    if(dv===0) return {trend:'● 0',trendDir:'flat'};
    const improving=good==='up'?dv>0:dv<0;
    return {trend:(dv>0?'▲ ':'▼ ')+Math.abs(dv),trendDir:improving?'up':'dn'};
  };
  const kpiTiles=[
    {l:'Subnets >85%',v:gt85,path:'subnets.gt85',good:'down',sub:worstUtil+'% worst · '+b7085+' at 70-85%',col:'var(--crit)'},
    {l:'Active leases',v:activeLeases,path:'leases.active',good:'up',sub:leases.length.toLocaleString()+' total',col:'var(--ok)'},
    {l:'DNS zones',v:nZone,path:'zones.n',good:'up',sub:zoneIssues+' with issues',col:'var(--accent)'},
    {l:'Hosts online',v:online,path:'hosts.online',good:'up',sub:'of '+nHost+' · '+hostsOffline+' offline',col:'var(--ok)'},
    {l:'Critical threats',v:critThreats,path:'sec.crit',good:'down',sub:highThreats+' high',col:'var(--crit)'},
    {l:'Blocked',v:blocked,path:'sec.blocked',good:'up',sub:'today · Infoblox feeds',col:'var(--ok)'},
  ];

  // ── 3. Top movers — overlap of live top-util subnets with baseline snapshot ──
  const baseTop=(baseline&&baseline.subnets&&Array.isArray(baseline.subnets.top))?baseline.subnets.top:[];
  const baseMap={};baseTop.forEach(p=>{if(p&&p.a!=null)baseMap[p.a]=Math.round(Number(p.u)||0);});
  const movers=sortedSubs
    .map(s=>({a:s.addr||s.name||'',u:Math.round(utilOf(s))}))
    .filter(t=>t.a&&(t.a in baseMap))
    .map(t=>({a:t.a,before:baseMap[t.a],after:t.u,d:t.u-baseMap[t.a]}))
    .filter(m=>m.d!==0)
    .sort((x,y)=>Math.abs(y.d)-Math.abs(x.d))
    .slice(0,5);

  // ── 4. Open-issues rollup (crit → warn) — mockup .issue rows w/ hover cards ──
  const issues=[];
  if(uCrit>0) issues.push({sev:'crit',t:uCrit+' unacknowledged critical threat'+(uCrit===1?'':'s'),d:'security · triage now',onClick:()=>nav('security'),hc:{title:'Critical threats',rows:[['unacked',uCrit],['high unacked',uHigh],['blocked',blocked]],spark:seriesOf('sec.crit')}});
  if(gt85>0) issues.push({sev:'crit',t:gt85+' subnet'+(gt85===1?'':'s')+' over 85% capacity',d:worst?('worst '+(worst.addr||worst.name)+' · '+worstUtil+'%'):'capacity',onClick:()=>nav('network',(worst&&utilOf(worst)>85)?{subnet:worst.addr||worst.id}:{}),hc:{title:'Capacity',rows:[['over 85%',gt85],['70-85%',b7085],['worst',worstUtil+'%']],spark:seriesOf('subnets.gt85')}});
  if(hostsOffline>0) issues.push({sev:'crit',t:hostsOffline+' host'+(hostsOffline===1?'':'s')+' offline',d:'infrastructure',onClick:()=>nav('infra'),hc:{title:'Hosts',rows:[['offline',hostsOffline],['online',online],['total',nHost]],spark:seriesOf('hosts.online')}});
  if(uHigh>0) issues.push({sev:'warn',t:uHigh+' unacknowledged high threat'+(uHigh===1?'':'s'),d:'security',onClick:()=>nav('security'),hc:{title:'High threats',rows:[['high',uHigh],['critical',uCrit]],spark:seriesOf('sec.high')}});
  if(zoneIssues>0) issues.push({sev:'warn',t:zoneIssues+' DNS zone'+(zoneIssues===1?'':'s')+' with issues',d:'dns',onClick:()=>nav('dns'),hc:{title:'DNS zones',rows:[['issues',zoneIssues],['total',nZone]],spark:seriesOf('zones.n')}});
  const sevRank={crit:0,warn:1};
  issues.sort((a,b)=>sevRank[a.sev]-sevRank[b.sev]);
  const sevClass=s=>s==='crit'?'crit':'high';

  // ── 5. Panel data: 30-day trend series, hourly security buckets ──
  const trendSeries=[
    {l:'Subnets >85%',s:seriesOf('subnets.gt85'),c:'var(--crit)'},
    {l:'Critical threats',s:seriesOf('sec.crit'),c:'var(--warn)'},
  ];
  const secByHour=Array(12).fill(0);
  {const now=Date.now();
    secEvents.forEach(e=>{const t=parseTs(e.event_time);if(!isFinite(t))return;const dt=(now-t)/3600000;if(dt<0)return;const idx=11-Math.min(11,Math.floor(dt));if(idx>=0)secByHour[idx]++;});}
  const secSev=[
    {l:'crit',n:critThreats,c:'var(--crit)'},
    {l:'high',n:highThreats,c:'var(--warn)'},
    {l:'med',n:Number(counts.medium)||0,c:'var(--accent-text)'},
    {l:'blocked',n:blocked,c:'var(--ok)'},
  ];

  // ── Current-state panels (no history needed) — keep Daily full on first visit ──
  const topSubs=sortedSubs.slice(0,10);
  const attnHosts=hosts.filter(h=>!/^(online|up)$/i.test(String(h.status||''))).slice(0,10);
  const issueZones=zones.filter(z=>Array.isArray(z.issues)&&z.issues.length>0).slice(0,10);

  // Vault locked → gate handles it (after all hooks). Loading → skeleton.
  if(locked) return null;
  if(loading&&!data) return <div className="page"><Skeleton rows={8} label="Collecting data from Infoblox — first load can take a minute…"/></div>;

  const baseLabel=firstRun?'first check-in — no prior day yet'
    :(baseline?('vs '+baseline.date):(weekSnap||yesterdaySnap?'no comparison for this period':'no prior day yet'));

  // Synthesis tone for the answer-first band (matches the narrative's health call).
  const dlyTone=(uCrit>0||critThreats>0)?'crit'
    :((gt85>0||hostsOffline>0||uHigh>0||zoneIssues>0)?'warn':'ok');

  return <div className="page">

    <div className="dly-head">
      <div style={{display:'flex',alignItems:'baseline',gap:8,minWidth:0}}>
        <h2 className="dly-title">Daily summary</h2>
        <span className="dly-base mono">{baseLabel}</span>
      </div>
      <div style={{display:'flex',alignItems:'center',gap:12}}>
        <div className="dly-seg" role="group" aria-label="Comparison period">
          <button className={'dly-seg-btn'+(period==='yesterday'?' on':'')} disabled={!yesterdaySnap}
            title={yesterdaySnap?undefined:'A prior daily snapshot is needed'} onClick={()=>setPeriod('yesterday')}>vs yesterday</button>
          <button className={'dly-seg-btn'+(period==='7d'?' on':'')} disabled={!weekSnap}
            title={weekSnap?undefined:'Needs a snapshot 7+ days old'} onClick={()=>setPeriod('7d')}>vs 7 days</button>
        </div>
        <Freshness at={fetchedAt} error={error} onRetry={refetch}/>
      </div>
    </div>

    <SynthBand tone={dlyTone} verdict={narrative||'Summarizing today’s network health…'} facts={[]} chips={[]}/>

    <div>
      <div className="kpis">
        {kpiTiles.map(t=>{
          const tr=firstRun?{trend:null,trendDir:'flat'}:trendFor(t.path,t.good);
          const sv=seriesOf(t.series||t.path);
          return <KpiSpark key={t.l} label={t.l} value={t.v} sub={t.sub}
            trend={tr.trend} trendDir={tr.trendDir}
            values={sv.length>=2?sv:undefined} color={t.col} fill={1}/>;
        })}
      </div>
      {firstRun&&<div className="dly-note">First visit — trend sparklines and deltas begin after your next daily check-in.</div>}
    </div>

    <div className="grid fadein">

      <Panel title="Open issues" side={<span className="mono">{issues.length} active</span>}>
        {issues.length
          ? issues.map((it,i)=><div className="issue" key={i} role="button" tabIndex={0}
              onClick={it.onClick} onKeyDown={e=>{if(e.key==='Enter'){e.preventDefault();it.onClick();}}}
              {...hover.bind(it.hc)}>
              <span className="rank">{i+1}</span>
              <div className="body"><div className="t">{it.t}</div><div className="d">{it.d}</div></div>
              <span className={'sev '+sevClass(it.sev)}>{sevClass(it.sev)}</span>
            </div>)
          : <div className="issue" style={{cursor:'default'}}>
              <span className="rank">✓</span>
              <div className="body"><div className="t">No open issues</div><div className="d">all systems clear</div></div>
              <span className="sev low">clear</span>
            </div>}
      </Panel>

      <Panel title="Security today" side={<span className="mono">{secEvents.length} events</span>} empty={!secReady}>
        <div className="dly-sev" role="button" tabIndex={0} onClick={()=>nav('security')}
          onKeyDown={e=>{if(e.key==='Enter')nav('security');}}>
          {secSev.map(x=><div className="dly-sev-cell" key={x.l}>
            <div className="dly-sev-n mono" style={{color:x.c}}>{x.n}</div>
            <div className="dly-sev-l">{x.l}</div>
          </div>)}
        </div>
        {secByHour.some(v=>v>0)
          ? <div className="dly-hourly"><MiniBars values={secByHour} width={220} height={30} color="var(--warn)"/>
              <span className="dly-note" style={{marginTop:0}}>events · last 12h</span></div>
          : <div className="dly-note">No security events in the last 12 hours</div>}
      </Panel>

      <Panel title={'Top movers'+(baseline?' · vs '+baseline.date:'')} empty={!(baseline&&movers.length>0)}>
        {movers.map((m,i)=><div className="issue" key={m.a+i} role="button" tabIndex={0}
            onClick={()=>nav('network',{subnet:m.a})} onKeyDown={e=>{if(e.key==='Enter')nav('network',{subnet:m.a});}}
            {...hover.bind({title:m.a,rows:[['before',m.before+'%'],['after',m.after+'%'],['change',(m.d>0?'+':'')+m.d+'%']],spark:[m.before,m.after]})}>
            <span className="rank">{i+1}</span>
            <div className="body"><div className="t mono">{m.a}</div><div className="d">{m.before}% → {m.after}%</div></div>
            <MiniBars values={[m.before,m.after]} width={54} height={16} color={utilColor(m.after)}/>
            <Delta v={m.d} good="down"/>
          </div>)}
      </Panel>

      <Panel title="Capacity & threats" side={<span className="mono">30 days</span>} empty={allDays.length<2}>
        {trendSeries.map(ts=><div className="dly-trow" key={ts.l}>
          <span className="dly-trow-l">{ts.l}</span>
          <span className="dly-trow-s">{ts.s.length>=2
            ? <Sparkline values={ts.s} width={220} height={30} color={ts.c} fill={1}/>
            : <span className="dly-note" style={{marginTop:0}}>building history…</span>}</span>
          <span className="dly-trow-v mono">{ts.s.length?ts.s[ts.s.length-1]:'—'}</span>
        </div>)}
      </Panel>

      <Panel title="Top capacity subnets" side={<span className="mono">by utilization</span>} empty={!topSubs.length}>
        <div className="issues">
          {topSubs.map((s,i)=>{const u=Math.round(utilOf(s));const c=utilColor(u);return <div key={s.id||s.addr||i} className="issue" role="button" tabIndex={0}
              onClick={()=>nav('network',{subnet:s.addr||s.id})} onKeyDown={e=>{if(e.key==='Enter')nav('network',{subnet:s.addr||s.id});}}
              {...hover.bind({title:(s.addr||s.name||'subnet')+(s.cidr?'/'+s.cidr:''),rows:[['used',(s.used!=null?s.used:'—')+' / '+(s.total!=null?s.total:'—')],['util',u+'%'],['site',s.site||'—']],spark:[u*0.4,u*0.6,u*0.8,u]})}>
            <span className="rank">{i+1}</span>
            <div className="body"><div className="t mono">{s.addr||s.name}{s.cidr?'/'+s.cidr:''}</div><div className="d">{s.site||'—'}</div></div>
            <div className="ubar" style={{flex:'none',width:56}}><i style={{width:Math.max(4,u)+'%',background:c}}/></div>
            <span className="mono" style={{flex:'none',width:34,textAlign:'right',fontSize:11,color:c}}>{u}%</span>
          </div>;})}
        </div>
      </Panel>

      <Panel title="Hosts needing attention" side={<span className="mono">{attnHosts.length} of {nHost}</span>} empty={!attnHosts.length}>
        <div className="issues">
          {attnHosts.map((h,i)=>{const st=String(h.status||'').toLowerCase();const sv=st==='error'?'crit':st==='degraded'?'high':st==='offline'?'low':'med';return <div key={h.id||i} className="issue" role="button" tabIndex={0}
              onClick={()=>nav('infra')} onKeyDown={e=>{if(e.key==='Enter')nav('infra');}}
              {...hover.bind({title:h.name||'host',rows:[['ip',h.ip||'—'],['type',h.type||'—'],['status',h.status||'—']]})}>
            <span className={'sd '+(sv==='crit'?'crit':'warn')}/>
            <div className="body"><div className="t">{h.name||'—'}</div><div className="d">{h.ip||''}</div></div>
            <span className={'sev '+sv}>{h.status||'—'}</span>
          </div>;})}
        </div>
      </Panel>

      <Panel title="DNS zones with issues" side={<span className="mono">{zoneIssues} of {nZone}</span>} empty={!issueZones.length}>
        <div className="issues">
          {issueZones.map((z,i)=>{const n=z.issues.length;return <div key={z.id||z.fqdn||i} className="issue" role="button" tabIndex={0}
              onClick={()=>nav('dns')} onKeyDown={e=>{if(e.key==='Enter')nav('dns');}}
              {...hover.bind({title:z.fqdn||'zone',rows:[['view',z.view||'—'],['ttl',z.ttl!=null?z.ttl+'s':'—'],['issues',n]]})}>
            <span className="rank">{i+1}</span>
            <div className="body"><div className="t mono">{z.fqdn||'—'}</div><div className="d">{(z.view||'—')+' · '+n+' issue'+(n===1?'':'s')}</div></div>
            <span className="sev high">{n}</span>
          </div>;})}
        </div>
      </Panel>

    </div>

  </div>;
}
// ═══ END: DAILY ═══

// ═══ REGION: NETDNS ═══
/* leasesInSubnet — ported verbatim from prior build (index-old.html ~L1061).
   Octet-prefix CIDR match: /8→1 octet, /16→2, /24→3, /32→4. */
