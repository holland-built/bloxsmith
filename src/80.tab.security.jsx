const SEC_SEV_RANK={critical:0,high:1,medium:2,low:3};
const secSevColor=s=>({critical:'var(--crit)',high:'var(--warn)'})[String(s||'').toLowerCase()]||'var(--text-dim)';
const secAckKey=e=>String(e.event_time)+'|'+String(e.qname);
// SOC-insights keys humanize into headers wider than their column ('totalVerifiedAssets' →
// 'Total Verified Assets', clipped to 'TOTALV…'). Exact-key only: unknown keys fall through
// to the generic path, so the actions/events/threat-lookup tables sharing secAutoCols are
// untouched. totalTimeSaved/timeSaved stay distinct — both can appear in one row.
const SEC_LABELS={totalEvents:'Events',totalVerifiedAssets:'Verified',totalTimeSaved:'Total saved',timeSaved:'Saved'};
function secHumanize(k){const s=String(k).replace(/^InsightsSummaryView\./,'');return SEC_LABELS[s]||s.replace(/[_.]/g,' ').replace(/\b\w/g,c=>c.toUpperCase()).trim();}
function secAutoCols(rows,tableId){
  // Sample up to 20 rows, not just the first — the first row can be missing keys others have.
  const sample=(rows||[]).filter(r=>r&&typeof r==='object').slice(0,20);
  const seen=new Set(),keys=[];
  sample.forEach(r=>Object.keys(r).forEach(k=>{if(!seen.has(k)){seen.add(k);keys.push(k);}}));
  // Dead columns (null/undefined/'' across the whole sample) waste width that matters.
  const live=keys.filter(k=>sample.some(r=>r[k]!=null&&r[k]!==''));
  // Drop constant columns (Source=Infoblox, State=Active in every row) — but decide
  // constancy over the FULL dataset (bounded 500), NOT the 20-row `sample`. A column
  // constant in the sample yet varied later (e.g. Severity all "crit" up top, a "low"
  // deeper down) must keep its column — the rare value is the signal, and a dropped
  // column here is gone entirely (not even deferred to the ⋯ Cols manager).
  const allRows=(rows||[]).filter(r=>r&&typeof r==='object');
  const varied=live.filter(k=>{
    let first,seen=false;
    for(let i=0;i<allRows.length&&i<500;i++){
      const v=allRows[i][k]; if(v==null||v==='') continue;
      const nv=typeof v==='string'?v.trim():v;
      if(!seen){ seen=true; first=nv; } else if(nv!==first) return true; // 2+ distinct → keep
    }
    return false; // 0-1 distinct non-blank across the whole dataset → constant, drop
  });
  const base=varied.length?varied:live;
  // Priority: name/severity/status/counts first — opaque ids and duplicate timestamps last.
  const rank=k=>{
    const s=k.toLowerCase();
    if(/name|title|label/.test(s)) return 0;
    if(/severity|status|state/.test(s)) return 1;
    if(/count|total|events|assets|saved/.test(s)) return 2;
    if(/source|feed/.test(s)) return 3;
    if(/time|date|started|recent/.test(s)) return 4;
    if(s==='id'||/id$/.test(s)) return 5;
    return 2.5;
  };
  const ordered=base.slice().sort((a,b)=>rank(a)-rank(b));
  const cols=ordered.map(k=>{
    const v=sample.map(r=>r[k]).find(x=>x!=null);
    const isNum=typeof v==='number';
    const isObj=v!=null&&typeof v==='object';
    const s=k.toLowerCase();
    const wide=/time|date|started|recent/.test(s)||s==='id'||/id$/.test(s);
    // Object/array values: DataTable renders those safely elsewhere — don't let them claim width.
    const minWidth=isObj?80:isNum?70:wide?140:110;
    return {key:k,label:secHumanize(k),mono:isNum,align:isNum?'right':'left',minWidth};
  });
  // Cap what's visible by default in a narrow card; overflow columns stay reachable via the
  // "⋯ Cols" manager (DataTable's own hiddenCols/LS convention — id = tableId||csvName) so
  // nothing is silently dropped, just deferred. Only seeds once; a user's own toggle wins after.
  const CAP=8;
  if(tableId&&cols.length>CAP&&LS.get('cols.'+tableId,null)===null){
    LS.set('cols.'+tableId,cols.slice(CAP).map(c=>c.key));
  }
  return cols;
}
function secEvtAge(t){
  if(t==null||t==='') return '—';
  let ms;
  if(typeof t==='number') ms=t<1e12?t*1000:t;
  else if(/^\d+$/.test(String(t))){const n=Number(t);ms=n<1e12?n*1000:n;}
  else ms=new Date(t).getTime();
  if(isNaN(ms)) return String(t);
  return relAge(new Date(ms));
}
function SecHead({title,at,onRetry,error,children}){
  return <div style={{display:'flex',alignItems:'center',gap:'var(--s3)',marginBottom:'var(--s3)',flexWrap:'wrap'}}>
    <h2 style={{margin:0,fontSize:'var(--t13)',fontWeight:600}}>{title}</h2>
    {children}
    <span style={{marginLeft:'auto'}}><Freshness at={at} onRetry={onRetry} error={error}/></span>
  </div>;
}
function SecSection({title,children}){
  return <section>
    <h3 style={{margin:'0 0 var(--s2)',fontSize:'var(--t12)',fontWeight:600,color:'var(--text-dim)'}}>{title}</h3>
    {children}
  </section>;
}
const secChip=active=>({height:22,padding:'0 var(--s2)',fontSize:'var(--t11)',background:'transparent',color:active?'var(--accent-text)':'var(--text-dim)',border:'1px solid '+(active?'var(--accent)':'var(--border)'),borderRadius:'var(--r-ctl)',cursor:'pointer'});
function SecChips({options,value,onChange}){
  return <span style={{display:'inline-flex',gap:'var(--s1)'}}>
    {options.map(o=><button key={o.v} style={secChip(value===o.v)} onClick={()=>onChange(o.v)}>{o.label}</button>)}
  </span>;
}

/* Peek (F4) — full event detail with inline ack toggle + two-step Block. */
function SecEventPeek({e,acks,toggleAck,onExplain}){
  const [acked,setAcked]=useState(!!acks[secAckKey(e)]);
  const {confirm:commit}=useCommit();
  const fields=[
    ['Time',secEvtAge(e.event_time)+' · '+String(e.event_time??'—')],
    ['Query',e.qname],
    ['Severity',e.severity],
    ['Action',e.policy_action],
    ['Feed',e.feed_name],
    ['Threat',e.threat_indicator],
    ['Device',e.device],
    ['Network',e.network],
  ];
  // Same shared confirm→diff→rollback dialog as the rest of the write paths; block
  // and unblock are inverses so the operator gets a one-click rollback receipt.
  const postDomain=async(domain,u)=>{
    try{
      const r=await fetch(u,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({domain})});
      const body=await r.json().catch(()=>({}));
      if(r.status===401) return {ok:false,error:'requires bridge token'};
      if(r.ok&&body.ok) return {ok:true,data:body};
      return {ok:false,error:body.error||('HTTP '+r.status)};
    }catch(err){ return {ok:false,error:String((err&&err.message)||err)}; }
  };
  const doBlock=()=>{
    const domain=String(e.qname||'').trim(); if(!domain) return;
    commit({
      verb:'block', resource:'domain', label:domain,
      summary:[{glyph:'−', text:'Block resolution of '+domain+' network-wide'}],
      note:'Every client on this tenant will stop resolving the domain.',
      doneText:'Blocked '+domain,
      run:()=>postDomain(domain,'/api/block-domain'),
      rollback:{label:'Unblock '+domain, run:()=>postDomain(domain,'/api/unblock-domain')},
    }).catch(()=>{});
  };
  return <div style={{display:'flex',flexDirection:'column',gap:'var(--s3)'}}>
    <dl style={{margin:0,display:'grid',gridTemplateColumns:'auto 1fr',gap:'var(--s1) var(--s3)',fontSize:'var(--t12)'}}>
      {fields.map(([k,v])=><React.Fragment key={k}>
        <dt style={{color:'var(--text-dim)'}}>{k}</dt>
        <dd className="mono" style={{margin:0,color:k==='Severity'?secSevColor(v):'var(--text)',wordBreak:'break-all'}}>{v==null||v===''?'—':String(v)}</dd>
      </React.Fragment>)}
    </dl>
    <label style={{display:'flex',alignItems:'center',gap:'var(--s2)',fontSize:'var(--t12)'}}>
      <input type="checkbox" checked={acked} onChange={()=>{setAcked(x=>!x);toggleAck(e);}}/>
      Acknowledged
    </label>
    <div style={{display:'flex',gap:'var(--s2)',alignItems:'center',flexWrap:'wrap'}}>
      <button className="btn" disabled={!e.qname} onClick={doBlock}>Block domain</button>
      {onExplain&&<button className="btn btn-ghost" onClick={()=>onExplain([e])}>Explain</button>}
    </div>
  </div>;
}

function SecTriageInbox({api,sevF,setSevF,acks,setAcks,toggleAck,clearAcks,triageRef,initialPeekKey,range,onExplain}){
  const {data,error,locked,fetchedAt,refetch,loading}=api;
  const {confirm:commit}=useCommit();
  const [actF,setActF]=useState('all');
  // Real 24h activity — bucket ALL events per qname by hour-of-day from real event_time.
  const activityByQname=useMemo(()=>{
    const evs=(data&&Array.isArray(data.events))?data.events:[];
    const parseHour=t=>{
      if(t==null||t==='') return null;
      let ms;
      if(typeof t==='number') ms=t<1e12?t*1000:t;
      else if(/^\d+$/.test(String(t))){const n=Number(t);ms=n<1e12?n*1000:n;}
      else ms=new Date(t).getTime();
      if(isNaN(ms)) return null;
      return new Date(ms).getHours();
    };
    const m={};
    evs.forEach(e=>{
      const q=e&&e.qname; if(!q) return;
      const h=parseHour(e.event_time); if(h==null) return;
      if(!m[q]) m[q]=new Array(24).fill(0);
      m[q][h]++;
    });
    return m;
  },[data]);
  if(locked) return null;
  if(loading&&!data) return <div><SecHead title="Triage inbox"/><Skeleton rows={8}/></div>;
  const d=data||{};
  const counts=d.counts||{};
  const events=Array.isArray(d.events)?d.events:[];
  let rows=events.filter(e=>{
    const sev=String(e.severity||'').toLowerCase();
    if(sevF!=='all'&&sev!==sevF) return false;
    const act=String(e.policy_action||'').toLowerCase();
    if(actF==='blocked'&&!(act==='block'||act==='redirect')) return false;
    if(actF==='logged'&&act!=='log') return false;
    if(range){const t=parseTs(e.event_time);if(!isFinite(t)||t<range[0]||t>range[1]) return false;}
    return true;
  });
  rows=rows.map((e,i)=>({e,i})).sort((A,B)=>{
    const aa=acks[secAckKey(A.e)]?1:0,ab=acks[secAckKey(B.e)]?1:0;
    if(aa!==ab) return aa-ab;
    const ra=SEC_SEV_RANK[String(A.e.severity||'').toLowerCase()]??9,rb=SEC_SEV_RANK[String(B.e.severity||'').toLowerCase()]??9;
    if(ra!==rb) return ra-rb;
    return String(B.e.event_time||'').localeCompare(String(A.e.event_time||''));
  }).map(x=>x.e);
  const cols=[
    // MUST stay labeled: this sits immediately right of DataTable's own row-select
    // checkbox (td.dt-check), so two identical boxes end up side by side — one
    // selects a row, this one MUTATES alert state. label:'' left the only
    // distinction in an aria-label sighted users never see. 'Ack' is the whole
    // affordance. Width is 48 (not 28) because thead th pads 0 var(--s3) each
    // side: 28 left a 4px content box that clipped both the word and the
    // checkbox itself into a half-drawn glyph.
    {key:'ack',label:'Ack',width:48,render:(_,e)=>{
      const acked=!!acks[secAckKey(e)];
      return <input type="checkbox" checked={acked} onClick={ev=>ev.stopPropagation()} onChange={()=>toggleAck(e)} aria-label="Acknowledge event"/>;
    }},
    {key:'severity',label:'Severity',mono:true,pivot:true,render:v=><span style={{color:secSevColor(v),textTransform:'uppercase'}}>{v||'—'}</span>},
    {key:'qname',label:'Query',mono:true,copy:true,primary:true,minWidth:220,render:v=>v||'—'},
    {key:'spark',label:'24h',render:(_,e)=>{const arr=activityByQname[e.qname];if(!arr)return <span className="mono" style={{color:'var(--text-faint)'}}>—</span>;const nz=arr.filter(x=>x>0).length;return nz>=2?<MiniBars values={arr} width={64} height={16}/>:<span className="mono" style={{color:'var(--text-faint)'}}>—</span>;}},
    {key:'policy_action',label:'Action',pivot:true,render:v=>v||'—'},
    {key:'feed_name',label:'Feed',hideSm:true,pivot:true,render:(v,e)=>{
      if(!v) return <span style={{color:'var(--text-dim)'}}>—</span>;
      const ind=e.threat_indicator;
      return <HoverCard trigger={<span style={{color:'var(--text-dim)',borderBottom:'1px dotted var(--border)'}}>{v}</span>}
        content={<span className="mono" style={{fontSize:'var(--t11)',color:'var(--text-dim)',wordBreak:'break-all'}}>
          <span style={{color:'var(--text-faint)'}}>Feed </span>{v}{ind?<><br/><span style={{color:'var(--text-faint)'}}>Indicator </span>{String(ind)}</>:null}
        </span>}/>;
    }},
    {key:'device',label:'Device',hideSm:true,render:v=>v||'—'},
    {key:'event_time',label:'Time',mono:true,align:'right',render:v=><span style={{color:'var(--text-faint)'}}>{secEvtAge(v)}</span>},
  ];
  const bulkActions=(rws)=>[
    {label:'Ack '+rws.length,flash:true,run:()=>{
      const prev={...acks};
      const next={...acks};
      rws.forEach(e=>{next[secAckKey(e)]=true;});
      setAcks(next);LS.set('acks',next);
      toast(rws.length+' acked','ok',{duration:5000,action:{label:'Undo',run:()=>{setAcks(prev);LS.set('acks',prev);}}});
    }},
    {label:'Block domains',flash:true,run:()=>{
      // Bulk block routed through the shared confirm→diff→rollback dialog: the loop
      // + ok/fail tally moves into run(); one Unblock receipt covers the whole batch.
      const domains=[...new Set(rws.map(e=>e.qname).filter(Boolean))];
      const N=domains.length;
      const summary=domains.slice(0,8).map(d=>({glyph:'−',text:'block '+d}));
      if(domains.length>8) summary.push({glyph:'−',text:'+'+(domains.length-8)+' more'});
      const loop=async u=>{
        let ok=0,fail=0,auth=false;
        for(const domain of domains){
          try{
            const r=await fetch(u,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({domain})});
            if(r.status===401){auth=true;break;}
            const body=await r.json().catch(()=>({}));
            if(r.ok&&body.ok)ok++;else fail++;
          }catch(e){fail++;}
        }
        return {ok,fail,auth};
      };
      return commit({
        verb:'block', resource:'domains', label:N+' domains',
        summary, danger:false, doneText:'Blocked '+N+' domains',
        run:async()=>{const {ok,fail,auth}=await loop('/api/block-domain');
          return {ok:!auth&&fail===0,error:auth?'requires bridge token':(fail?fail+' failed':undefined),data:{ok,fail}};},
        rollback:{label:'Unblock '+N+' domains', run:async()=>{const {fail}=await loop('/api/unblock-domain');return {ok:fail===0};}},
      }).catch(()=>{});
    }},
    ...(onExplain?[{label:'Explain '+rws.length,run:()=>onExplain(rws)}]:[]),
  ];
  return <div ref={triageRef}>
    <SecHead title="Triage inbox" at={fetchedAt} onRetry={refetch} error={error}>
      <span className="mono" style={{fontSize:'var(--t12)'}}>
        <span style={{color:'var(--crit)'}}>critical {counts.critical||0}</span>{' · '}
        <span style={{color:'var(--warn)'}}>high {counts.high||0}</span>{' · '}
        <span style={{color:'var(--text-dim)'}}>medium {counts.medium||0}</span>{' · '}
        <span style={{color:'var(--text-dim)'}}>low {counts.low||0}</span>
      </span>
      <span className="mono" style={{fontSize:'var(--t11)',color:'var(--text-faint)'}}>
        {(d.blocked||0)+' blocked · '+(d.logged||0)+' logged · '+(d.total||0)+' total'}
      </span>
    </SecHead>
    <div style={{display:'flex',alignItems:'center',gap:'var(--s3)',marginBottom:'var(--s3)',flexWrap:'wrap'}}>
      <SecChips value={sevF} onChange={setSevF} options={[{v:'all',label:'all'},{v:'critical',label:'critical'},{v:'high',label:'high'},{v:'medium',label:'medium'},{v:'low',label:'low'}]}/>
      <span style={{width:1,height:16,background:'var(--border)'}}/>
      <SecChips value={actF} onChange={setActF} options={[{v:'all',label:'all'},{v:'blocked',label:'blocked'},{v:'logged',label:'logged'}]}/>
      <button className="fresh-retry" style={{marginLeft:'auto'}} onClick={clearAcks}>Clear acks</button>
    </div>
    {rows.length===0
      ? <div className="dt-empty">No events</div>
      : <DataTable cols={cols} rows={rows} tableId="triage" filterable
          searchSchema={{fields:{severity:{type:'enum'},policy_action:{type:'enum'}},aliases:{sev:'severity',action:'policy_action',query:'qname'}}}
          rowKey={r=>String(r.event_time)+'|'+String(r.qname)}
          scrollBody={480} columnToggle
          problemsOnly={{label:'Hide acked',test:e=>!acks[secAckKey(e)],default:true}}
          selectable bulkActions={bulkActions} initialPeekKey={initialPeekKey}
          renderPeek={e=><SecEventPeek e={e} acks={acks} toggleAck={toggleAck} onExplain={onExplain}/>}/>}
  </div>;
}

function SecEntities({entities}){
  if(entities==null) return null;
  if(Array.isArray(entities)){
    if(!entities.length) return <div className="dt-empty">No matches</div>;
    if(typeof entities[0]==='object'&&entities[0]) return <DataTable cols={secAutoCols(entities)} rows={entities} csvName="threat-lookup"/>;
  }
  return <pre className="mono" style={{fontSize:'var(--t11)',color:'var(--text-dim)',whiteSpace:'pre-wrap',margin:0,padding:'var(--s3)',background:'var(--raised)',border:'1px solid var(--border)',borderRadius:'var(--r-ctl)',maxHeight:'var(--panel-md)',overflow:'auto'}}>{JSON.stringify(entities,null,2)}</pre>;
}
/* External intel (Dossier) — defensive render of /api/dossier summary + sources. */
function SecDossierSourceVal({src}){
  const bits=[];
  if(Array.isArray(src.records)) bits.push(src.records.length+' record'+(src.records.length===1?'':'s'));
  if(src.geo&&typeof src.geo==='object') bits.push('geo: '+[src.geo.country,src.geo.city].filter(Boolean).join(', '));
  else if(src.geo) bits.push('geo: '+String(src.geo));
  if(src.whois&&typeof src.whois==='object') bits.push('whois: '+[src.whois.registrar,src.whois.created].filter(Boolean).join(' · '));
  else if(src.whois) bits.push('whois: '+String(src.whois));
  // actor/malware/detail are free-shape upstream: String() on an object yields the
  // useless "[object Object]" (seen live on a real google.com dossier). geo/whois
  // above already special-case their object form; these three fell through. Route
  // them via the shared safeCellContent so an object degrades to a readable JSON
  // preview instead of leaking Object's default toString.
  if(src.actor) bits.push('actor: '+safeCellContent(src.actor));
  if(src.malware) bits.push('malware: '+(Array.isArray(src.malware)?src.malware.map(m=>safeCellContent(m)).join(', '):safeCellContent(src.malware)));
  if(src.detail) bits.push(String(safeCellContent(src.detail)));
  return <span style={{color:'var(--text-dim)',wordBreak:'break-word'}}>{bits.length?bits.join(' · '):'—'}</span>;
}
function SecDossier({dossier}){
  if(!dossier) return null;
  if(dossier.unavailable) return <div style={{color:'var(--text-faint)',fontSize:'var(--t11)',marginTop:'var(--s3)'}}>External intel unavailable: {String(dossier.unavailable)}</div>;
  const sum=dossier.summary||{};
  const sources=Array.isArray(dossier.sources)?dossier.sources:[];
  const mal=!!sum.malicious;
  const pill=(text,tone)=><span className="mono" style={{fontSize:'var(--t11)',padding:'1px var(--s2)',borderRadius:'var(--r-ctl)',color:tone==='crit'?'var(--crit)':'var(--ok)',border:'1px solid '+(tone==='crit'?'var(--crit)':'var(--border)')}}>{text}</span>;
  const meta=[['Max threat level',sum.max_threat_level],['Country',sum.country],['Registrar',sum.registrar],['Actor',sum.actor]].filter(x=>x[1]!=null&&x[1]!=='');
  const classes=Array.isArray(sum.threat_classes)?sum.threat_classes:[];
  const props=Array.isArray(sum.properties)?sum.properties:[];
  return <div style={{marginTop:'var(--s4)',paddingTop:'var(--s3)',borderTop:'1px solid var(--border)'}}>
    <h3 style={{margin:'0 0 var(--s2)',fontSize:'var(--t12)',fontWeight:600,color:'var(--text-dim)'}}>External intel (Dossier)</h3>
    <div style={{display:'flex',alignItems:'center',gap:'var(--s2)',flexWrap:'wrap',marginBottom:'var(--s2)'}}>
      {mal?pill('malicious','crit'):pill('clean','ok')}
      {sum.max_threat_level!=null&&<span className="mono" style={{fontSize:'var(--t11)',color:'var(--text-dim)'}}>threat {String(sum.max_threat_level)}</span>}
      {(dossier.type||'')&&<span className="mono" style={{fontSize:'var(--t11)',color:'var(--text-faint)'}}>{String(dossier.type)}</span>}
    </div>
    {(classes.length||props.length)>0&&<div style={{display:'flex',gap:'var(--s1)',flexWrap:'wrap',marginBottom:'var(--s2)'}}>
      {classes.map((c,i)=><span key={'c'+i} className="chip">{String(c)}</span>)}
      {props.map((p,i)=><span key={'p'+i} className="chip" style={{color:'var(--text-faint)'}}>{String(p)}</span>)}
    </div>}
    {meta.length>0&&<dl style={{margin:'0 0 var(--s2)',display:'grid',gridTemplateColumns:'auto 1fr',gap:'2px var(--s3)',fontSize:'var(--t11)'}}>
      {meta.map(([k,v])=><React.Fragment key={k}><dt style={{color:'var(--text-dim)'}}>{k}</dt><dd className="mono" style={{margin:0,wordBreak:'break-all'}}>{String(v)}</dd></React.Fragment>)}
    </dl>}
    {sources.length>0&&<DataTable csvName="dossier-sources"
      cols={[{key:'source',label:'Source',mono:true,render:v=>v||'—'},{key:'_v',label:'Detail',render:(_,r)=><SecDossierSourceVal src={r}/>}]}
      rows={sources.map((s,i)=>({...(s&&typeof s==='object'?s:{detail:s}),_k:i}))} rowKey={r=>r._k}/>}
    {!sources.length&&<div className="mono" style={{fontSize:'var(--t11)',color:'var(--text-faint)'}}>No sources reported.</div>}
  </div>;
}
function SecThreatLookup(){
  const [q,setQ]=useState('');
  const [busy,setBusy]=useState(false);
  const [res,setRes]=useState(null);
  const [dossier,setDossier]=useState(null);
  const [err,setErr]=useState(null);
  const {confirm:commit}=useCommit();
  const lookup=async()=>{
    const query=q.trim(); if(!query) return;
    setBusy(true);setErr(null);setRes(null);setDossier(null);
    fetch('/api/dossier?q='+encodeURIComponent(query),{cache:'no-store'})
      .then(r=>r.json().catch(()=>null))
      .then(j=>{if(j)setDossier(j);})
      .catch(()=>{});
    try{
      const r=await fetch('/api/threat-lookup?q='+encodeURIComponent(query),{cache:'no-store'});
      const body=await r.json().catch(()=>null);
      if(!r.ok||(body&&body.error)) setErr((body&&body.error)||('HTTP '+r.status));
      else setRes(body||{entities:[],query});
    }catch(e){setErr(String((e&&e.message)||e));}
    setBusy(false);
  };
  // Shared confirm→diff→rollback dialog. Block and unblock are each other's inverse,
  // so every write leaves a real one-click rollback receipt.
  const postDomain=async(domain,u)=>{
    try{
      const r=await fetch(u,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({domain})});
      const body=await r.json().catch(()=>({}));
      if(r.status===401) return {ok:false,error:'requires bridge token'};
      if(r.ok&&body.ok) return {ok:true,data:body};
      return {ok:false,error:body.error||('HTTP '+r.status)};
    }catch(e){ return {ok:false,error:String((e&&e.message)||e)}; }
  };
  const doWrite=(kind)=>{
    const domain=q.trim(); if(!domain) return;
    const url=kind==='block'?'/api/block-domain':'/api/unblock-domain';
    const invUrl=kind==='block'?'/api/unblock-domain':'/api/block-domain';
    commit({
      verb:kind, resource:'domain', label:domain,
      summary:[{glyph:kind==='block'?'−':'+', text:(kind==='block'?'Block resolution of ':'Restore resolution of ')+domain+' network-wide'}],
      note:kind==='block'?'Every client on this tenant will stop resolving the domain.':'Clients on this tenant can resolve the domain again.',
      doneText:(kind==='block'?'Blocked ':'Unblocked ')+domain,
      run:()=>postDomain(domain,url),
      rollback:{label:(kind==='block'?'Unblock ':'Re-block ')+domain, run:()=>postDomain(domain,invUrl)},
    }).catch(()=>{});
  };
  return <div>
    <SecHead title="Threat lookup"/>
    <div style={{display:'flex',gap:'var(--s2)',marginBottom:'var(--s3)',flexWrap:'wrap'}}>
      <input className="mono" value={q} onChange={e=>setQ(e.target.value)} onKeyDown={e=>{if(e.key==='Enter')lookup();}}
        placeholder="domain, IP, or host…" aria-label="Threat lookup query"
        style={{flex:'1 1 260px',minWidth:200,height:28,padding:'0 var(--s3)',fontSize:'var(--t12)',color:'var(--text)',background:'var(--raised)',border:'1px solid var(--border)',borderRadius:'var(--r-ctl)'}}/>
      <button className="btn" onClick={lookup} disabled={busy||!q.trim()}>{busy?'Looking up…':'Lookup'}</button>
    </div>
    {err&&<div className="dt-empty" style={{color:'var(--crit)'}}>{err}</div>}
    {res&&<div style={{marginBottom:'var(--s3)'}}><SecEntities entities={res.entities}/></div>}
    <SecDossier dossier={dossier}/>
    <div style={{display:'flex',alignItems:'center',gap:'var(--s2)',flexWrap:'wrap',marginTop:'var(--s3)'}}>
      <button className="btn" disabled={!q.trim()} onClick={()=>doWrite('block')}>Block domain</button>
      <button className="btn btn-ghost" disabled={!q.trim()} onClick={()=>doWrite('unblock')}>Unblock domain</button>
    </div>
  </div>;
}

function SecArrayTable({rows,csvName}){
  // BOUNDED by default: cap the rendered domain at 50 so an unentitled-but-noisy tenant
  // can't dump hundreds of feed/list/host rows into a card. DataTable's own maxRows keeps
  // CSV/sort on the full set and surfaces a "Showing 50 of N · Show all" expander.
  if(!Array.isArray(rows)||!rows.length) return <div className="dt-empty">None</div>;
  if(typeof rows[0]!=='object'||rows[0]===null) return <DataTable cols={[{key:'value',label:'Value'}]} rows={rows.map(v=>({value:v}))} maxRows={50} csvName={csvName}/>;
  return <DataTable cols={secAutoCols(rows)} rows={rows} maxRows={50} csvName={csvName}/>;
}
function SecRoaming({re}){
  if(!re||typeof re!=='object') return null;
  const byStatus=re.by_status||{};
  const tc=Array.isArray(re.top_countries)?re.top_countries:[];
  return <SecSection title="Roaming endpoints">
    <div style={{display:'flex',alignItems:'baseline',gap:'var(--s4)',marginBottom:'var(--s2)',flexWrap:'wrap'}}>
      <span className="kpi-num">{re.total||0}</span>
      <span className="mono" style={{fontSize:'var(--t11)',color:'var(--text-dim)'}}>
        {Object.entries(byStatus).map(([k,v])=>k+' '+v).join(' · ')||'no status data'}
      </span>
    </div>
    {tc.length>0&&<DataTable cols={[{key:'country',label:'Country'},{key:'count',label:'Endpoints',mono:true,align:'right'}]}
      rows={tc.map(p=>Array.isArray(p)?{country:p[0],count:p[1]}:p)} maxRows={50} csvName="roaming-countries"/>}
  </SecSection>;
}
function SecDomainPanels(){
  const {data,error,locked,fetchedAt,refetch,loading}=useApi('/api/hub/domains');
  if(locked) return null;
  if(loading&&!data) return <div><SecHead title="Domain protection"/><Skeleton rows={10}/></div>;
  if(error&&!data) return <div><SecHead title="Domain protection" at={fetchedAt} onRetry={refetch} error={error}/><ErrorState error={error} onRetry={refetch}/></div>;
  const d=data||{};
  const hosts=d.host_inventory&&Array.isArray(d.host_inventory.hosts)?d.host_inventory.hosts:(Array.isArray(d.hosts)?d.hosts:null);
  return <div>
    <SecHead title="Domain protection" at={fetchedAt} onRetry={refetch} error={error}/>
    <div style={{display:'flex',flexDirection:'column',gap:'var(--s6)'}}>
      {Array.isArray(d.threat_feeds)&&d.threat_feeds.length>0&&<SecSection title="Threat feeds"><SecArrayTable rows={d.threat_feeds} csvName="threat-feeds"/></SecSection>}
      {Array.isArray(d.named_lists)&&d.named_lists.length>0&&<SecSection title="Named lists"><SecArrayTable rows={d.named_lists} csvName="named-lists"/></SecSection>}
      {Array.isArray(d.security_policies)&&d.security_policies.length>0&&<SecSection title="Security policies"><SecArrayTable rows={d.security_policies} csvName="security-policies"/></SecSection>}
      {d.roaming_endpoints&&<SecRoaming re={d.roaming_endpoints}/>}
      {Array.isArray(d.anycast_ha)&&d.anycast_ha.length>0&&<SecSection title="Anycast HA"><SecArrayTable rows={d.anycast_ha} csvName="anycast-ha"/></SecSection>}
      {Array.isArray(d.dfp_services)&&d.dfp_services.length>0&&<SecSection title="DFP services"><SecArrayTable rows={d.dfp_services} csvName="dfp-services"/></SecSection>}
      {hosts&&hosts.length>0&&<SecSection title="Hosts"><SecArrayTable rows={hosts} csvName="hosts"/></SecSection>}
    </div>
  </div>;
}

function SecInsights(){
  // Empty/unavailable → render nothing (no header, no box). Perpetually empty on
  // stateless tenants; only wrap real rows in a Panel of their own.
  const api=useApi('/api/insights');
  const {data,locked}=api;
  if(locked) return null;
  const rows=!data?[]:(Array.isArray(data)?data:(data.data||data.results||data.items||[]));
  if(!rows.length) return null;
  return <Panel size="s6" title="SOC insights" api={api}>
    <DataTable cols={secAutoCols(rows,'soc-insights')} rows={rows} maxRows={50} csvName="soc-insights"/>
  </Panel>;
}
function SecActions(){
  // Empty/unavailable → render nothing (no header, no box). Only real rows get a Panel.
  const api=useApi('/api/actions');
  const {data,locked}=api;
  if(locked) return null;
  const rows=!data?[]:(Array.isArray(data)?data:(data.actions||data.results||data.data||[]));
  if(!rows.length) return null;
  return <Panel size="s6" title="Actions" api={api}>
    <DataTable cols={secAutoCols(rows,'actions')} rows={rows} maxRows={50} csvName="actions"/>
  </Panel>;
}

function SecLookalikes(){
  const {data,error,locked,fetchedAt,refetch,loading}=useApi('/api/lookalikes');
  const {confirm:commit}=useCommit();
  if(locked) return null;
  if(loading&&!data) return <div><SecHead title="Lookalike domains"/><Skeleton rows={8}/></div>;
  const d=data||{};
  if(d.unavailable) return <div><SecHead title="Lookalike domains" at={fetchedAt} onRetry={refetch} error={error}/><div className="dt-empty">Not entitled · {String(d.unavailable)}</div></div>;
  if(error&&!data) return <div><SecHead title="Lookalike domains" at={fetchedAt} onRetry={refetch} error={error}/><ErrorState error={error} onRetry={refetch}/></div>;
  const rows=Array.isArray(d.domains)?d.domains:[];
  const cols=[
    {key:'lookalike',label:'Lookalike',mono:true,copy:true,primary:true,id:true,render:v=>v||'—'},
    {key:'target',label:'Target',mono:true,id:true,render:v=><span style={{color:'var(--text-dim)'}}>{v||'—'}</span>},
    // tipFn, not the raw-value fallback: render() suppresses it (40.table.jsx:218), so the
    // full rationale — ~130 chars in a 61px cell — was unreachable without an explicit tip.
    {key:'reason',label:'Reason',hideSm:true,render:v=>v||'—',tipFn:r=>r.reason||null},
    {key:'suspicious',label:'Suspicious',render:heatCell(r=>r.suspicious?1:0,{crit:1,tip:'Flagged: host marked suspicious',fmt:(v,r)=>r.suspicious?'yes':'no'})},
    {key:'detected_at',label:'Detected',mono:true,align:'right',render:v=><span style={{color:'var(--text-faint)'}}>{secEvtAge(v)}</span>},
  ];
  const bulkActions=rws=>{
    // Bulk block routed through the shared confirm→diff→rollback dialog: loop + tally
    // move into run(); the batch gets a single Unblock rollback receipt.
    const domains=[...new Set(rws.map(r=>r.lookalike).filter(Boolean))];
    const N=domains.length;
    const summary=domains.slice(0,8).map(d=>({glyph:'−',text:'block '+d}));
    if(domains.length>8) summary.push({glyph:'−',text:'+'+(domains.length-8)+' more'});
    const loop=async u=>{
      let ok=0,fail=0,auth=false;
      for(const domain of domains){
        try{
          const r=await fetch(u,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({domain})});
          if(r.status===401){auth=true;break;}
          const body=await r.json().catch(()=>({}));
          if(r.ok&&body.ok)ok++;else fail++;
        }catch(e){fail++;}
      }
      return {ok,fail,auth};
    };
    return [
      {label:'Block domains',flash:true,run:()=>commit({
        verb:'block', resource:'domains', label:N+' domains',
        summary, danger:false, doneText:'Blocked '+N+' domains',
        run:async()=>{const {ok,fail,auth}=await loop('/api/block-domain');
          return {ok:!auth&&fail===0,error:auth?'requires bridge token':(fail?fail+' failed':undefined),data:{ok,fail}};},
        rollback:{label:'Unblock '+N+' domains', run:async()=>{const {fail}=await loop('/api/unblock-domain');return {ok:fail===0};}},
      }).catch(()=>{})},
    ];
  };
  return <div>
    <SecHead title="Lookalike domains" at={fetchedAt} onRetry={refetch} error={error}>
      <span className="mono" style={{fontSize:'var(--t11)',color:'var(--text-faint)'}}>{rows.length+' detected'+(Array.isArray(d.targets)&&d.targets.length?' · '+d.targets.length+' target'+(d.targets.length===1?'':'s'):'')}</span>
    </SecHead>
    {rows.length===0
      ? <div className="dt-empty">No lookalike domains</div>
      : <DataTable cols={cols} rows={rows} tableId="lookalikes" csvName="lookalike-domains"
          scrollBody={480} rowKey={r=>String(r.lookalike)} selectable bulkActions={bulkActions}/>}
  </div>;
}
function SecSynthBand({api,acks,setSevF,triageRef}){
  const {delta}=useSnapshots();
  if(!api||!api.data) return null;
  const d=api.data||{};
  const events=Array.isArray(d.events)?d.events:[];
  const sevOf=e=>String(e.severity||'').toLowerCase();
  const unacked=events.filter(e=>!acks[secAckKey(e)]);
  const uCrit=unacked.filter(e=>sevOf(e)==='critical').length;
  const uHigh=unacked.filter(e=>sevOf(e)==='high').length;
  const blocked=Number(d.blocked)||0;
  const total=Number(d.total)||events.length;
  const tone=uCrit>0?'crit':uHigh>0?'warn':'ok';
  const pool=uCrit>0?unacked.filter(e=>sevOf(e)==='critical'):unacked;
  const topDev=(()=>{
    const freq={};
    pool.forEach(e=>{const v=e.device;if(v)freq[v]=(freq[v]||0)+1;});
    const arr=Object.entries(freq).sort((a,b)=>b[1]-a[1]);
    return arr.length?arr[0][0]:null;
  })();
  const verdict=uCrit>0
    ? uCrit+' critical threat'+(uCrit===1?'':'s')+' awaiting triage'+(topDev?' (top target: '+topDev+')':'')
    : 'No unacknowledged critical threats — '+blocked+' blocked automatically';
  const facts=[
    {label:'Unacked critical', value:uCrit, delta:{v:delta('sec.crit'),good:'down'}},
    {label:'Unacked high', value:uHigh, delta:{v:delta('sec.high'),good:'down'}},
    {label:'Blocked', value:blocked, delta:{v:delta('sec.blocked'),good:'up'}},
    {label:'Total events', value:total},
  ];
  const jump=sev=>{setSevF(sev);if(triageRef&&triageRef.current)triageRef.current.scrollIntoView({behavior:'smooth',block:'start'});};
  const chips=[
    uCrit>0?{label:'Triage '+uCrit+' critical', onClick:()=>jump('critical')}:null,
    uHigh>0?{label:'Triage '+uHigh+' high', onClick:()=>jump('high')}:null,
    topDev?{label:'Top target: '+topDev, onClick:()=>jump(uCrit>0?'critical':'all')}:null,
  ].filter(Boolean);
  const counts=d.counts||{};
  const sevChips=[
    {k:'critical',c:'crit',n:counts.critical},
    {k:'high',c:'high',n:counts.high},
    {k:'medium',c:'med',n:counts.medium},
    {k:'low',c:'low',n:counts.low},
  ];
  return <React.Fragment>
    <SynthBand tone={tone} verdict={verdict} facts={facts} chips={chips}/>
    <div style={{display:'flex',gap:'var(--s2)',flexWrap:'wrap'}}>
      {sevChips.map(s=><button key={s.k} className="svc" onClick={()=>jump(s.k)}
          style={{cursor:'pointer',flexDirection:'row',alignItems:'center',justifyContent:'space-between',gap:'var(--s3)'}}>
        <span className={'sev '+s.c}>{s.k}</span>
        <span className="mono">{s.n||0}</span>
      </button>)}
    </div>
  </React.Fragment>;
}

function ThreatRibbonPanel(){
  const feed=useApi('/api/csp/threats',{poll:30000});
  const rows=(feed.data&&feed.data.rows)||[];
  const status=feed.data&&feed.data.status;
  const totals=rows.reduce((m,r)=>{const a=String(r.action||'').toLowerCase();const n=Number(r.requests)||0;
    if(a==='block')m.block+=n;else if(a==='allow')m.allow+=n;return m;},{block:0,allow:0});
  const cols=[
    {key:'day',label:'Day',mono:true},
    {key:'action',label:'Action',render:v=><Astryx.Badge variant={String(v||'').toLowerCase()==='block'?'error':'success'} label={v||'—'}/>},
    {key:'requests',label:'Requests',mono:true,align:'right'},
  ];
  return <Panel size="s6" title="Threat ribbon" api={feed}>
    {feed.error||status==='error' ? <ErrorState error="feed unavailable — CSP returned an error" onRetry={feed.refetch}/>
     : rows.length===0 ? <div style={{padding:16,color:'var(--text-faint)',fontSize:12}}>No data in the current window</div>
     : <div>
        <div style={{display:'flex',gap:'var(--s5)',marginBottom:'var(--s3)'}}>
          <div><span className="kpi-num" style={{color:'var(--crit)'}}>{totals.block}</span><div style={{fontSize:'var(--t11)',color:'var(--text-dim)'}}>Blocked</div></div>
          <div><span className="kpi-num">{totals.allow}</span><div style={{fontSize:'var(--t11)',color:'var(--text-dim)'}}>Allowed</div></div>
        </div>
        <DataTable cols={cols} rows={rows} rowKey={r=>String(r.day)+'|'+String(r.action)} tableId="csp-threats" csvName="csp-threats" defaultSort={{key:'day',dir:'desc'}} scrollBody={480}/>
      </div>}
  </Panel>;
}
function CtemExposurePanel({feed}){
  const d=(feed.data&&feed.data.data)||null;
  const status=feed.data&&feed.data.status;
  const matrix=(d&&Array.isArray(d.matrix))?d.matrix:[];
  const hourly=(d&&Array.isArray(d.hourly_counts))?d.hourly_counts.map(Number).filter(isFinite):[];
  const empty=!d||(!d.total_exposures&&!matrix.length&&!hourly.length);
  const cols=[
    {key:'severity',label:'Severity',mono:true},
    {key:'priority',label:'Priority',mono:true},
    {key:'count',label:'Count',mono:true,align:'right'},
  ];
  return <Panel size="s6" title="CTEM exposure" api={feed}>
    {feed.error||status==='error' ? <ErrorState error="feed unavailable — CSP returned an error" onRetry={feed.refetch}/>
     : empty ? <div style={{padding:16,color:'var(--text-faint)',fontSize:12}}>No data in the current window</div>
     : <div>
        <div style={{display:'flex',alignItems:'baseline',gap:'var(--s4)',marginBottom:'var(--s2)',flexWrap:'wrap'}}>
          <span className="kpi-num">{d.total_exposures||0}</span>
          <span style={{fontSize:'var(--t11)',color:'var(--text-dim)'}}>total exposures</span>
          {hourly.length>=2&&<Sparkline values={hourly} width={64} height={26}/>}
        </div>
        {matrix.length>0&&<DataTable cols={cols} rows={matrix} rowKey={(r,i)=>String(r.severity)+'|'+String(r.priority)+'|'+i} tableId="csp-ctem-matrix" csvName="csp-ctem-matrix" scrollBody={480}/>}
        {d.last_scan_at&&<div style={{marginTop:'var(--s2)',fontSize:'var(--t11)',color:'var(--text-faint)'}}>Last scan: {String(d.last_scan_at)}</div>}
      </div>}
  </Panel>;
}
function CtemAssetsPanel({feed}){
  const d=(feed.data&&feed.data.data)||null;
  const status=feed.data&&feed.data.status;
  const providers=(d&&Array.isArray(d.providers))?d.providers:[];
  const technologies=(d&&Array.isArray(d.technologies))?d.technologies:[];
  const ports=(d&&Array.isArray(d.ports))?d.ports:[];
  const empty=!d||(!d.asset_count&&!providers.length&&!technologies.length&&!ports.length);
  const chipRow=(label,arr,cap)=>{
    if(!arr.length) return null;
    const shown=cap?arr.slice(0,cap):arr;
    const rest=arr.length-shown.length;
    return <div style={{marginBottom:'var(--s3)'}}>
      <div style={{fontSize:'var(--t11)',color:'var(--text-dim)',marginBottom:'var(--s1)'}}>{label}</div>
      <div style={{display:'flex',gap:'var(--s1)',flexWrap:'wrap'}}>
        {shown.map((s,i)=><Astryx.Badge key={label+i} variant="default" label={String(s)}/>)}
        {rest>0&&<Astryx.Badge variant="default" label={'+'+rest+' more'}/>}
      </div>
    </div>;
  };
  return <Panel size="s6" title="CTEM assets" api={feed}>
    {feed.error||status==='error' ? <ErrorState error="feed unavailable — CSP returned an error" onRetry={feed.refetch}/>
     : empty ? <div style={{padding:16,color:'var(--text-faint)',fontSize:12}}>No data in the current window</div>
     : <div>
        <div style={{marginBottom:'var(--s3)'}}><span className="kpi-num">{d.asset_count||0}</span> <span style={{fontSize:'var(--t11)',color:'var(--text-dim)'}}>assets</span></div>
        <div style={{maxHeight:'var(--panel-md)',overflow:'auto'}}>
          {chipRow('Providers',providers,30)}
          {chipRow('Technologies',technologies,30)}
          {chipRow('Ports',ports,30)}
        </div>
      </div>}
  </Panel>;
}
function ExposureFindingsPanel({feed}){
  const d=(feed.data&&feed.data.data)||null;
  const status=feed.data&&feed.data.status;
  const rows=(d&&Array.isArray(d.rows))?d.rows:[];
  const cols=[
    {key:'title',label:'Title',primary:true,minWidth:280,render:v=>v||'—'},
    {key:'severity',label:'Severity',mono:true,align:'right'},
    {key:'status',label:'Status'},
    {key:'last_seen_at',label:'Last seen',mono:true,align:'right',render:v=><span style={{color:'var(--text-faint)'}}>{secEvtAge(v)}</span>},
  ];
  return <Panel size="s6" title="Exposure findings" api={feed}>
    {feed.error||status==='error' ? <ErrorState error="feed unavailable — CSP returned an error" onRetry={feed.refetch}/>
     : rows.length===0 ? <div style={{padding:16,color:'var(--text-faint)',fontSize:12}}>No data in the current window</div>
     : <DataTable cols={cols} rows={rows} rowKey={(r,i)=>String(r.title)+'|'+i} tableId="sec-exposures" csvName="exposures"
         filterable filterKeys={['title','status']} defaultSort={{key:'severity',dir:'desc'}} scrollBody={480}/>}
  </Panel>;
}
function RiskiestAssetsPanel({feed}){
  const d=(feed.data&&feed.data.data)||null;
  const status=feed.data&&feed.data.status;
  const rows=(d&&Array.isArray(d.rows))?d.rows:[];
  const cols=[
    {key:'domain_name',label:'Domain',primary:true,render:v=>v||'—'},
    {key:'ip_address',label:'IP',mono:true},
    {key:'exposures',label:'Exposures',mono:true,align:'right'},
    {key:'status',label:'Status'},
    {key:'last_seen_at',label:'Last seen',mono:true,align:'right',render:v=><span style={{color:'var(--text-faint)'}}>{secEvtAge(v)}</span>},
  ];
  return <Panel size="s6" title="Riskiest assets" api={feed}>
    {feed.error||status==='error' ? <ErrorState error="feed unavailable — CSP returned an error" onRetry={feed.refetch}/>
     : rows.length===0 ? <div style={{padding:16,color:'var(--text-faint)',fontSize:12}}>No data in the current window</div>
     : <DataTable cols={cols} rows={rows} rowKey={(r,i)=>String(r.domain_name)+'|'+i} tableId="sec-asset-risk" csvName="riskiest-assets"
         defaultSort={{key:'exposures',dir:'desc'}} scrollBody={480}/>}
  </Panel>;
}
function ExposedHostnamesPanel({feed}){
  const d=(feed.data&&feed.data.data)||null;
  const status=feed.data&&feed.data.status;
  const rows=(d&&Array.isArray(d.rows))?d.rows:[];
  const count=(d&&d.count)||rows.length;
  const cols=[{key:'hostname',label:'Hostname',mono:true,primary:true,render:v=>v||'—'}];
  // Shape-first: a 200-row list of hostnames is a wall. Lead with the concentration —
  // how many distinct registrable domains they collapse into, and the top few — so the
  // operator reads the exposure's spread before scrolling. Derived from real rows only.
  const domStats=(()=>{
    const freq={};
    rows.forEach(r=>{const h=String((r&&r.hostname)||'').toLowerCase().replace(/\.$/,'');if(!h)return;const dom=h.split('.').slice(-2).join('.')||h;freq[dom]=(freq[dom]||0)+1;});
    const arr=Object.entries(freq).sort((a,b)=>b[1]-a[1]);
    return {n:arr.length,top:arr.slice(0,3)};
  })();
  return <Panel size="md" title="Exposed hostnames" api={feed}>
    {feed.error||status==='error' ? <ErrorState error="feed unavailable — CSP returned an error" onRetry={feed.refetch}/>
     : rows.length===0 ? <div style={{padding:16,color:'var(--text-faint)',fontSize:12}}>No data in the current window</div>
     : <div>
        <div style={{marginBottom:'var(--s3)'}}><span className="kpi-num">{count}</span> <span style={{fontSize:'var(--t11)',color:'var(--text-dim)'}}>exposed hostnames</span></div>
        {domStats.n>0&&<div className="mono" style={{marginBottom:'var(--s3)',fontSize:'var(--t11)',color:'var(--text-dim)'}}>
          {'across '+domStats.n+' domain'+(domStats.n===1?'':'s')}{domStats.top.length?' · '+domStats.top.map(([dom,c])=>dom+' ('+c+')').join(' · '):''}
        </div>}
        <DataTable cols={cols} rows={rows} rowKey={(r,i)=>String(r.hostname)+'|'+i} tableId="sec-exp-hosts" csvName="exposed-hostnames"
          filterable maxRows={200} scrollBody={480}/>
      </div>}
  </Panel>;
}
function ExposedIPsPanel({feed}){
  const d=(feed.data&&feed.data.data)||null;
  const status=feed.data&&feed.data.status;
  const rows=(d&&Array.isArray(d.rows))?d.rows:[];
  const count=(d&&d.count)||rows.length;
  const cols=[{key:'ip',label:'IP',mono:true,primary:true,render:v=>v||'—'}];
  return <Panel size="md" title="Exposed IPs" api={feed}>
    {feed.error||status==='error' ? <ErrorState error="feed unavailable — CSP returned an error" onRetry={feed.refetch}/>
     : rows.length===0 ? <div style={{padding:16,color:'var(--text-faint)',fontSize:12}}>No data in the current window</div>
     : <div>
        <div style={{marginBottom:'var(--s3)'}}><span className="kpi-num">{count}</span> <span style={{fontSize:'var(--t11)',color:'var(--text-dim)'}}>exposed IPs</span></div>
        <DataTable cols={cols} rows={rows} rowKey={(r,i)=>String(r.ip)+'|'+i} tableId="sec-exp-ips" csvName="exposed-ips"
          filterable scrollBody={480}/>
      </div>}
  </Panel>;
}
// CTEM / attack-surface entitlement gate. Each of the 6 feeds below hits a paid
// Infoblox add-on endpoint; on an unentitled tenant they ALL return empty and used to
// render 6 dead cards. CtemBelt owns the 6 fetches (single source of truth) and passes
// each feed into its panel, so there's no double-fetch and the gate decision matches
// exactly what the panels render. It collapses to one honest tile ONLY when every feed
// has resolved successfully with zero rows. Any rows, any still-loading, or ANY error
// ⇒ render the cards — an outage or an entitled-but-clean tenant must never be
// mislabeled "not detected". ctemFeedRows mirrors each panel's own row-extraction.
function ctemFeedRows(feed,kind){
  const fd=feed.data; if(!fd) return false;
  const d=fd.data;
  if(kind==='exposure'){
    const matrix=(d&&Array.isArray(d.matrix))?d.matrix:[];
    const hourly=(d&&Array.isArray(d.hourly_counts))?d.hourly_counts:[];
    return !!(d&&(d.total_exposures||matrix.length||hourly.length));
  }
  if(kind==='assets'){
    const p=(d&&Array.isArray(d.providers))?d.providers:[];
    const t=(d&&Array.isArray(d.technologies))?d.technologies:[];
    const po=(d&&Array.isArray(d.ports))?d.ports:[];
    return !!(d&&(d.asset_count||p.length||t.length||po.length));
  }
  const rows=(d&&Array.isArray(d.rows))?d.rows:[];
  return rows.length>0;
}
function CtemBelt(){
  const exposure=useApi('/api/csp/ctem-exposure',{poll:300000});
  const assets=useApi('/api/csp/ctem-assets',{poll:300000});
  const exposures=useApi('/api/csp/exposures',{poll:300000});
  const assetRisk=useApi('/api/csp/asset-risk',{poll:300000});
  const hostnames=useApi('/api/csp/exposed-hostnames',{poll:300000});
  const ips=useApi('/api/csp/exposed-ips',{poll:300000});
  const feeds=[[exposure,'exposure'],[assets,'assets'],[exposures,'rows'],[assetRisk,'rows'],[hostnames,'rows'],[ips,'rows']];
  const cards=<React.Fragment>
    <div className="dc12 t-s6"><CtemExposurePanel feed={exposure}/></div>
    <div className="dc8 t-s6"><CtemAssetsPanel feed={assets}/></div>
    <div className="dc8 t-s6"><ExposureFindingsPanel feed={exposures}/></div>
    <div className="dc8 t-s6"><RiskiestAssetsPanel feed={assetRisk}/></div>
    <div className="dc12 t-md"><ExposedHostnamesPanel feed={hostnames}/></div>
    <div className="dc12 t-md"><ExposedIPsPanel feed={ips}/></div>
  </React.Fragment>;
  // Locked vault: preserve prior behavior (render cards) — don't mislabel as unentitled.
  if(feeds.some(([f])=>f.locked)) return cards;
  const anyRows=feeds.some(([f,k])=>ctemFeedRows(f,k));
  // Any error (fetch failure OR HTTP-200 status:"error") means we can't conclude
  // "unentitled" — an outage or backend error must keep the cards (which surface their
  // own error state), never collapse to the "not detected" tile.
  const anyError=feeds.some(([f])=>f.error||(f.data&&f.data.status==='error'));
  // Only collapse once every feed has fully settled — resolved (data | error) AND not
  // mid-flight (a background poll retains stale data with loading=true; don't collapse
  // on that). Until then keep the cards so we never flash the tile during a refresh.
  const allSettled=feeds.every(([f])=>!f.loading&&(f.data!=null||f.error));
  if(anyRows||anyError||!allSettled) return cards;
  // Honest wording: all six paid endpoints returned zero rows. We CAN'T prove that's an
  // absent subscription vs an entitled tenant with nothing to show, so don't assert
  // "not detected" — just report no data and name the add-on.
  return <div className="dc24 t-s6"><Panel size="s6" title="CTEM / attack-surface">
    <div style={{padding:16,color:'var(--text-faint)',fontSize:12}}>No CTEM / attack-surface data. These panels (a paid Infoblox add-on) appear here once the subscription returns findings.</div>
  </Panel></div>;
}
function SecurityTab(){
  const sec=useApi('/api/hub/security',{poll:60000});
  const route=useRoute();
  const time=useTimeRange();                 // global time window (P1 slice 5)
  const {data:allData}=useData();            // shared feed — carries auditLogs for annotations
  const [sevF,setSevF]=useState('all');
  const [range,setRange]=useState(null);
  const [acks,setAcks]=useState(()=>LS.get('acks',{}));
  const triageRef=useRef(null);
  const ai=useAiExplain();
  const toggleAck=e=>{const k=secAckKey(e);setAcks(p=>{const n={...p};if(n[k])delete n[k];else n[k]=true;LS.set('acks',n);return n;});};
  const clearAcks=()=>{setAcks({});LS.set('acks',{});};
  const secEvents=sec.data&&Array.isArray(sec.data.events)?sec.data.events:[];
  // Event annotations (part 4): audit/config-change ticks from the shared feed's
  // auditLogs (norm_audit → {ts,user,action,resource,result}). Empty ⇒ no ticks.
  const auditLogs=(allData&&Array.isArray(allData.auditLogs))?allData.auditLogs:[];
  const annotations=auditLogs.map(a=>({ts:a.ts,who:a.user,what:a.action,
    title:(a.action||'change')+' · '+(a.resource||''),
    rows:[['Who',a.user||'—'],['What',((a.action||'')+' '+(a.resource||'')).trim()||'—'],
          ['When',a.ts||'—'],['Result',a.result||'—']]}));
  const tWin=time.window;
  // Capture-to-zoom (part 2): a drag reports its window here; encode it as an
  // absolute `<from>-<to>` token in the global time hash. null ⇒ clear.
  const onZoom=r=>time.setRange(r?(Math.round(r[0])+'-'+Math.round(r[1])):null);
  // The triage inbox is a time-filtered table: it reads the local brush range if
  // set, else the global window — so a global preset/zoom narrows it too (part 1).
  const effRange=range||(tWin?[tWin.from,tWin.to]:null);
  const resetZoom=<button className="vh-reset" onClick={()=>{time.setRange(null);setRange(null);}}
    aria-label="Reset zoom — clear the time window">Reset zoom ✕</button>;
  return <div className="page">
    <SecSynthBand api={sec} acks={acks} setSevF={setSevF} triageRef={triageRef}/>
    <div className="dash">
      {/* Band 1 — event volume (brush/zoom histogram) */}
      <div className="dc24 t-s4">
        <Panel size="s4" title="Event volume" side={time.token?resetZoom:'brush to filter'} empty={secEvents.length===0}>
          <VolumeHistogram rows={secEvents} tsKey="event_time" buckets={48} onRange={setRange} selected={range}
            onZoom={onZoom} annotations={annotations} windowRange={tWin?[tWin.from,tWin.to]:null}/>
        </Panel>
      </div>
      {/* Band 2 — triage inbox (peek drawer) */}
      <div className="dc24 t-lg">
        <Panel size="lg">
          <SecTriageInbox api={sec} sevF={sevF} setSevF={setSevF} acks={acks} setAcks={setAcks} toggleAck={toggleAck} clearAcks={clearAcks} triageRef={triageRef} initialPeekKey={route.params.peek} range={effRange} onExplain={ai.open}/>
        </Panel>
      </div>
      {/* Band 3 — threat lookup (search form) | lookalike domains */}
      <div className="dc8 t-s6"><Panel size="s6"><SecThreatLookup/></Panel></div>
      <div className="dc16 t-s6"><Panel size="s6"><SecLookalikes/></Panel></div>
      {/* Band 4 — SOC insights | actions | domain protection */}
      <div className="dc8 t-s6"><SecInsights/></div>
      <div className="dc8 t-s6"><SecActions/></div>
      <div className="dc8 t-s6"><Panel size="s6"><SecDomainPanels/></Panel></div>
      {/* Band 5 — threat ribbon | CTEM exposure (from CtemBelt) */}
      <div className="dc12 t-s6"><ThreatRibbonPanel/></div>
      {/* Bands 5-7 — CTEM / attack-surface belt emits its own dc+tier wrappers */}
      <CtemBelt/>
    </div>
    {ai.node}
  </div>;
}
// ═══ END: SECURITY ═══

// ═══ REGION: ASKGLOBAL ═══
/* Ask console, audit log, command palette, saved views, alert rules. */
(function injectAskGlobalStyles(){
  if(document.getElementById('bx-askglobal-styles')) return;
  const s=document.createElement('style');s.id='bx-askglobal-styles';
  s.textContent=`
  .ask-bar{display:flex;gap:8px;}
  .ask-in{flex:1 1 auto;height:36px;padding:0 12px;font-size:13px;color:var(--text);background:var(--raised);border:1px solid var(--border-input);border-radius:var(--r-ctl);}
  .ask-in:focus{border-color:var(--accent);}
  .ask-busy{margin-top:8px;font-size:12px;color:var(--text-faint);}
  .ai-ctx{font-size:11px;color:var(--text-faint);}
  .ai-convo{flex:1 1 auto;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:12px;}
  .ai-empty{font-size:12px;color:var(--text-faint);padding:8px 0;}
  .ai-foot{margin-top:auto;display:flex;flex-direction:column;gap:8px;padding-top:8px;border-top:1px solid var(--border);}
  .ask-item{padding:16px;}
  .ask-q{font-size:12px;color:var(--text-dim);margin-bottom:8px;}
  .ask-a{font-size:13px;line-height:1.5;color:var(--text);white-space:pre-wrap;}
  .ask-err{font-size:12px;color:var(--text-faint);}
  .ask-chips{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px;}
  .chip-btn{cursor:pointer;transition:border-color .12s ease;}
  .chip-btn:hover{border-color:var(--border-strong);color:var(--text);}
  .ask-trace{display:flex;flex-direction:column;gap:6px;margin-top:12px;padding-left:12px;border-left:1px solid var(--border);}
  .ask-trace-row{font-size:11px;color:var(--text);}
  .ask-trace-row .args{color:var(--text-faint);}
  .alerts-row{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--text);padding:6px 0;}
  .alerts-num{width:56px;height:26px;padding:0 8px;font-size:12px;color:var(--text);background:var(--raised);border:1px solid var(--border);border-radius:var(--r-ctl);}
  .pal-list{margin-top:8px;max-height:var(--panel-md);overflow-y:auto;padding:4px;}
  .pal-row{display:flex;align-items:center;justify-content:space-between;gap:12px;width:100%;padding:8px 12px;font-size:12px;color:var(--text);text-align:left;background:transparent;border:none;border-left:1px solid transparent;cursor:pointer;}
  .pal-row.sel{background:var(--hover);border-left-color:var(--accent);}
  .pal-kind{font-size:11px;color:var(--text-faint);flex:0 0 auto;}
  .pal-empty{padding:12px;font-size:12px;color:var(--text-faint);text-align:center;}
  .pal-confirm{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 12px;font-size:12px;color:var(--text);}
  .views-slot{position:relative;display:inline-flex;}
  .views-overlay{position:fixed;inset:0;z-index:60;}
  .views-menu{right:0;top:calc(100% + 6px);width:280px;background:var(--surface);border:1px solid var(--border);border-radius:var(--r-panel);padding:6px;}
  .views-folder{padding:6px 8px 2px;font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:var(--text-faint);}
  .views-row{display:flex;align-items:center;gap:4px;padding:0 2px;}
  .views-item{display:flex;align-items:center;justify-content:space-between;gap:8px;width:100%;min-width:0;padding:6px 8px;font-size:12px;color:var(--text);text-align:left;background:transparent;border:none;border-radius:var(--r-ctl);cursor:pointer;}
  .views-item:hover{background:var(--hover);}
  .views-item .vname{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
  .views-date{font-size:10px;color:var(--text-faint);flex:0 0 auto;}
  .views-mini{height:20px;padding:0 6px;font-size:10px;color:var(--text-dim);background:transparent;border:1px solid var(--border);border-radius:var(--r-ctl);cursor:pointer;flex-shrink:0;}
  .views-mini:hover{border-color:var(--border-strong);color:var(--text);}
  .views-mini.crit:hover{border-color:var(--crit);color:var(--crit);}
  .views-confirm-q{flex:1;padding:0 6px;font-size:11px;color:var(--crit);}
  .views-divider{height:1px;margin:6px 8px;background:var(--border);}
  .views-empty{padding:8px;font-size:11px;color:var(--text-faint);}
  /* Watch expressions — reuse .views-* chrome; badge/count are text-only. */
  .watch-badge{margin-left:6px;padding:0 5px;min-width:16px;height:15px;display:inline-flex;align-items:center;justify-content:center;font-size:10px;line-height:1;color:var(--text-dim);background:var(--raised);border:1px solid var(--border);border-radius:8px;}
  .watch-item .watch-count{flex:0 0 auto;padding:0 6px;font-size:11px;color:var(--text-dim);background:var(--raised);border:1px solid var(--border);border-radius:8px;}
  /* Delta-since-last-visit — subtle monochrome strip; glyph+count, never color-only. */
  .delta-wrap{position:relative;display:flex;justify-content:flex-end;padding:4px 16px 0;}
  .delta-chip{display:inline-flex;align-items:center;gap:8px;padding:2px 10px;font-size:11px;color:var(--text);background:var(--surface);border:1px solid var(--border);border-radius:var(--r-ctl);cursor:pointer;}
  .delta-chip:hover{border-color:var(--border-strong);}
  .delta-since{color:var(--text-faint);text-transform:uppercase;letter-spacing:.05em;font-size:10px;}
  .delta-seg{display:inline-flex;align-items:center;gap:3px;color:var(--text);}
  .delta-glyph{color:var(--text);font-weight:600;}
  .delta-pop{right:16px;top:calc(100% + 4px);width:280px;max-height:320px;overflow:auto;background:var(--surface);border:1px solid var(--border);border-radius:var(--r-panel);padding:6px;}
  .delta-pop-row{display:flex;align-items:center;gap:8px;padding:4px 8px;font-size:12px;color:var(--text);}
  .delta-pop-row .vname{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
  `;
  document.head.appendChild(s);
})();

/* Saved-view helpers shared by ViewsMenu + CommandPalette.
   Server (view_write) persists only name/widgets/order/layout/folder/saved_at
   and drops unknown top-level keys, so the route is mirrored inside layout
   (opaque to the server) as well as sent top-level per the view schema. */
