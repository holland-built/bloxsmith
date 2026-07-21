function DnsTab(){
  const {params}=useRoute();
  const {data,error,locked,loading,fetchedAt,refetch}=useData();
  const an=useApi('/api/dns-analytics');
  const _whoDns=useApi('/api/whoami');
  const canEdit=(((_whoDns.data&&_whoDns.data.role)||'viewer')!=='viewer');
  const {confirm:commit}=useCommit();
  const {delta}=useSnapshots();
  const [volChart,volToggle]=useChartType(['bar','line'],'bar');
  if(locked) return null;
  if(loading&&!data) return <div className="page"><Skeleton rows={8} label="Collecting data from Infoblox — first load can take a minute…"/></div>;
  if(error) return <div className="page"><Freshness error onRetry={refetch}/></div>;
  const zones=(data&&data.zones)||[];
  const zoneCols=[
    {key:'fqdn',label:'Zone',mono:true,align:'left',minWidth:220},
    {key:'view',label:'View',hideSm:true,pivot:true},
    {key:'ttl',label:'TTL',mono:true,align:'right',
      render:heatCell(r=>Number(r.ttl),{warn:60,crit:86400,mode:'range',tip:'Flagged: TTL under 60s or over 24h'})},
    {key:'issues',label:'Issues',align:'left',render:v=>(v&&v.length)
      ? <span className="mono" style={{fontSize:'var(--t11)',color:'var(--crit)'}}>{v.join(', ')}</span> : ''},
    ...(canEdit?[{key:'__edit',label:'',align:'right',width:60,render:(v,z)=>
      <button className="btn" onClick={e=>{e.stopPropagation();nav('editor',{type:'dns_zone',id:z.id,fqdn:z.fqdn,view:z.view});}}>Edit</button>}]:[]),
  ];

  const volume=(an.data&&an.data.volume)||[];
  const clients=((an.data&&an.data.top_clients)||[]).map(r=>({
    device:r[NDA+'device_name']||'—',ip:r[NDA+'device_ip']||'—',
    queries:Number(r[NDA+'total_query_count'])||0}));
  const qtypes=((an.data&&an.data.query_types)||[]).map(r=>({
    type:r[NDA+'query_type']||'?',count:Number(r[NDA+'total_query_count'])||0})).sort((a,b)=>b.count-a.count);
  const qmax=Math.max(1,...qtypes.map(q=>q.count));
  const fmtDay=(r)=>{const t=r[NDA+'timestamp.day']||r[NDA+'timestamp']||r.timestamp||'';
    const d=new Date(t);return isNaN(d)?String(t).slice(5,10):(d.getMonth()+1)+'/'+d.getDate();};
  const clientCols=[
    {key:'device',label:'Device'},
    {key:'ip',label:'IP',mono:true,align:'left'},
    {key:'queries',label:'Queries',mono:true,align:'right',render:v=>Number(v).toLocaleString()},
  ];
  const anLoading=an.loading&&!an.data;

  // ── Synthesis band derivations ──
  const issueCount=zones.filter(z=>Array.isArray(z.issues)&&z.issues.length>0).length;
  const anomalyCount=zones.filter(z=>z.anomaly).length;
  const volCounts=volume.map(r=>Number(r[NDA+'total_query_count'])||0);
  const volTotal=volCounts.reduce((a,b)=>a+b,0);
  const volAvg=volCounts.length?volTotal/volCounts.length:0;
  const volLast=volCounts.length?volCounts[volCounts.length-1]:0;
  const volPct=volAvg?Math.round((volLast-volAvg)/volAvg*100):0;
  const pctStr=(volPct>=0?'+':'')+volPct+'%';
  const tone=(issueCount>0||anomalyCount>0)?'crit':'ok';
  const verdict=tone==='ok'
    ? ('DNS healthy — no zone issues'+(volAvg>0&&volPct===0?', volume steady':''))
    : (issueCount>0?issueCount+' zone'+(issueCount===1?'':'s')+' with issues'
        :anomalyCount+' volume anomaly flag'+(anomalyCount===1?'':'s'))+(volAvg>0?('; volume '+pctStr+' vs weekly average'):'');
  const facts=[
    {label:'Zones',value:zones.length,delta:{v:delta('zones.n'),good:'up'}},
    {label:'Zones w/ issues',value:issueCount,delta:{v:delta('zones.issues'),good:'down'}},
    {label:'Anomalies',value:anomalyCount},
    {label:'7d volume',value:volTotal.toLocaleString()+(volAvg>0?(' ('+pctStr+')'):'')},
  ];
  // D: problem-zone chips were dead labels — now isolate that zone in the table
  // via a removable global filter on the fqdn column (clearable in FilterBar).
  const chips=zones
    .filter(z=>(Array.isArray(z.issues)&&z.issues.length>0)||z.anomaly)
    .slice(0,3).map(z=>({label:z.fqdn||'—',filter:{field:'fqdn',value:z.fqdn||'',label:'Zone: '+(z.fqdn||'—')}}));

  // Analytics panels render ONLY when their array is non-empty and no fetch error
  // (graceful empties → no dead bands). If all three are empty the whole analytics block renders nothing.
  const volBuckets=volume.slice(0,7).map(r=>({label:fmtDay(r),count:Number(r[NDA+'total_query_count'])||0}));
  const volEmpty=!(volume.length&&!an.error);
  const clientsEmpty=!(clients.length&&!an.error);
  const qtypesEmpty=!(qtypes.length&&!an.error);
  const allEmpty=volEmpty&&clientsEmpty&&qtypesEmpty;

  return <div className="page fadein">
    <SynthBand tone={tone} verdict={verdict} facts={facts} chips={chips}/>
    <Panel title="DNS zones" side={<div style={{display:'flex',alignItems:'center',gap:'var(--s2)'}}>{canEdit?<button className="btn" onClick={()=>nav('editor',{type:'dns_zone'})}>New zone</button>:null}<Freshness at={fetchedAt} onRetry={refetch}/></div>}>
      <DataTable cols={zoneCols} rows={zones} defaultSort={{key:'fqdn',dir:'asc'}} csvName="zones"
        scrollBody={480} columnToggle
        problemsOnly={{label:'Problems only',test:z=>(z.issues&&z.issues.length)||z.anomaly,default:true}}
        tableId="zones" rowKey={r=>String(r.fqdn)} selectable
        filterable filterKeys={['fqdn','view']}
        searchSchema={{fields:{ttl:{type:'number'},issues:{type:'array'}},aliases:{zone:'fqdn'}}}
        initialPeekKey={params.peek}
        renderPeek={row=><div>
          <div className="mono" style={{fontWeight:600}}>{row.fqdn}</div>
          <div style={{marginTop:'var(--s2)',fontSize:'var(--t12)',color:'var(--text-dim)'}}>View: {row.view||'—'}</div>
          <div className="mono" style={{marginTop:'var(--s1)',fontSize:'var(--t12)',color:'var(--text-dim)'}}>TTL: {row.ttl??'—'}</div>
          <div style={{marginTop:'var(--s3)'}}>
            <div className="band-fact-l">Issues</div>
            {(Array.isArray(row.issues)&&row.issues.length)
              ? <div className="mono" style={{fontSize:'var(--t12)',color:'var(--crit)',marginTop:2}}>{row.issues.join(', ')}</div>
              : <div style={{fontSize:'var(--t12)',color:'var(--text-faint)',marginTop:2}}>none</div>}
          </div>
          {row.anomaly?<div className="mono" style={{marginTop:'var(--s2)',fontSize:'var(--t11)',color:'var(--warn)'}}>anomaly flagged</div>:null}
        </div>}
        bulkActions={sel=>{
          // Route the bulk zone-block through the shared confirm→diff→rollback dialog:
          // one decisive step showing the blast radius, then a one-click Unblock receipt.
          const domains=[...new Set(sel.map(z=>z.fqdn).filter(Boolean))];
          const N=domains.length;
          const summary=domains.slice(0,8).map(d=>({glyph:'−',text:'block '+d}));
          if(domains.length>8) summary.push({glyph:'−',text:'+'+(domains.length-8)+' more'});
          const loop=async u=>{
            let ok=0,fail=0;
            for(const domain of domains){
              try{
                const r=await fetch(u,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({domain})});
                const j=await r.json().catch(()=>({}));
                if(r.ok&&j.ok!==false)ok++;else fail++;
              }catch(e){fail++;}
            }
            return {ok,fail};
          };
          return [{
            label:'Block domain',
            flash:true,
            run:()=>commit({
              verb:'block', resource:'domains', label:N+' domains',
              summary, danger:false, doneText:'Blocked '+N+' domains',
              run:async()=>{const {ok,fail}=await loop('/api/block-domain');return {ok:fail===0,error:fail?fail+' failed':undefined,data:{ok,fail}};},
              rollback:{label:'Unblock '+N+' domains', run:async()=>{const {fail}=await loop('/api/unblock-domain');return {ok:fail===0};}},
            }).catch(()=>{}),
          }];
        }}/>
    </Panel>
    {anLoading
      ? <Skeleton rows={3}/>
      : allEmpty
      ? null
      : <React.Fragment>
          <div className="sec-h">
            <h2>DNS analytics</h2><span className="rule"/>
          </div>
          <div className="grid-dense">
            <Panel title="Query volume · 7d"
              side={<>{volToggle}<Freshness at={an.fetchedAt} onRetry={an.refetch} error={an.error?true:undefined}/></>}
              empty={volEmpty}>
              <ChartView type={volChart} data={volBuckets.map(b=>({label:b.label,value:b.count,color:b.color}))} barMode="histogram"/>
            </Panel>
            <Panel title="Top clients" empty={clientsEmpty}>
              <DataTable cols={clientCols} rows={clients} defaultSort={{key:'queries',dir:'desc'}} csvName="top-clients" scrollBody={280}/>
            </Panel>
            <Panel title="Query types" empty={qtypesEmpty}>
              <div className="sites">
                {qtypes.map((q,i)=><div key={i} className="siterow">
                  <span className="nm">{q.type}</span>
                  <span className="track"><i style={{width:Math.round(q.count/qmax*100)+'%',background:'var(--accent)'}}/></span>
                  <span className="pc mono">{q.count.toLocaleString()}</span>
                </div>)}
              </div>
            </Panel>
          </div>
        </React.Fragment>}
    <DnsTilesRow/>
  </div>;
}
function DnsServicesPanel(){
  const feed=useApi('/api/csp/dns-services',{poll:30000});
  const rows=(feed.data&&feed.data.rows)||[];
  const status=feed.data&&feed.data.status;
  const cols=[
    {key:'name',label:'Name',align:'left',render:(v,r)=><IdCell value={v} label={r.id}/>},
    {key:'comment',label:'Comment',align:'left'},
    {key:'pool_id',label:'Pool ID',mono:true,align:'left'},
  ];
  return <Panel title="DNS services" api={feed}>
    {feed.error||status==='error' ? <ErrorState error="feed unavailable — CSP returned an error" onRetry={feed.refetch}/>
     : rows.length===0 ? <div style={{padding:16,color:'var(--text-faint)',fontSize:12}}>No data in the current window</div>
     : <DataTable cols={cols} rows={rows} filterable filterKeys={['name','comment']} scrollBody={360} csvName="dns-services"/>}
  </Panel>;
}

function DnsQpsPanel(){
  const feed=useApi('/api/csp/dns-qps',{poll:30000});
  const rows=(feed.data&&feed.data.rows)||[];
  const status=feed.data&&feed.data.status;
  const values=rows.map(r=>Number(r.avg_value)||0);
  const current=values.length?values[values.length-1]:null;
  const cols=[
    {key:'hour',label:'Hour',align:'left'},
    {key:'avg_value',label:'Avg QPS',mono:true,align:'right',render:v=>Number(v).toLocaleString()},
  ];
  return <Panel title="DNS QPS" api={feed}>
    {feed.error||status==='error' ? <ErrorState error="feed unavailable — CSP returned an error" onRetry={feed.refetch}/>
     : rows.length===0 ? <div style={{padding:16,color:'var(--text-faint)',fontSize:12}}>No data in the current window</div>
     : <div style={{display:'flex',flexDirection:'column',gap:'var(--s3)'}}>
         <div style={{display:'flex',alignItems:'center',gap:'var(--s3)'}}>
           <Sparkline values={values}/>
           <div>
             <div style={{fontSize:'var(--t11)',color:'var(--text-faint)'}}>current QPS</div>
             <div className="kpi-num" style={{fontSize:'var(--t16)'}}>{current!==null?current.toLocaleString():'—'}</div>
           </div>
         </div>
         <DataTable cols={cols} rows={rows} scrollBody={220} csvName="dns-qps"/>
       </div>}
  </Panel>;
}

function DnsTilesRow(){
  return <div className="grid-dense">
    <DnsServicesPanel/>
    <DnsQpsPanel/>
  </div>;
}
// ═══ END: NETDNS ═══

// ═══ REGION: INFRA ═══
/* InfraTab — host inventory + PRTG-style sensor grid + per-host metric drill.
   Reuses useApi / DataTable / Freshness / Skeleton / nav / useRoute + dark tokens.
   Metric rows use LITERAL dotted keys from the HostMetrics cube. */
(function injectInfraStyles(){
  if(document.getElementById('bx-infra-styles')) return;
  const s=document.createElement('style');s.id='bx-infra-styles';
  s.textContent=`
  .infra-page{width:100%;max-width:100%;min-width:0;display:flex;flex-direction:column;gap:32px;}
  .infra-sec{display:flex;flex-direction:column;gap:12px;min-width:0;max-width:100%;}
  .infra-head{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:20px;}
  .infra-h{font-size:13px;font-weight:600;color:var(--text);}
  .infra-dim{font-size:12px;color:var(--text-faint);padding:6px 0;}
  .infra-drill-top{display:flex;align-items:center;gap:12px;flex-wrap:wrap;}
  .infra-back{font-size:12px;color:var(--accent-text);background:transparent;border:none;padding:0;}
  .infra-ip{font-size:12px;color:var(--text-dim);}
  .infra-st{font-size:11px;text-transform:uppercase;}
  .sensor-wrap{max-width:100%;min-width:0;overflow-x:auto;}
  table.sensor{border-collapse:collapse;font-size:12px;white-space:nowrap;}
  table.sensor th{height:30px;padding:0 12px;font-size:11px;font-weight:500;color:var(--text-dim);
    text-transform:uppercase;text-align:right;border-bottom:1px solid var(--border);}
  table.sensor td{height:30px;padding:0 12px;text-align:right;color:var(--text);border-bottom:1px solid var(--border);}
  table.sensor .sensor-hcol{position:sticky;left:0;z-index:1;text-align:left;background:var(--bg);}
  table.sensor td.sensor-null{color:var(--text-faint);}
  table.sensor td.sensor-hot{color:var(--warn);}
  .infra-panel{border:1px solid var(--border);border-radius:8px;background:var(--surface);padding:16px;display:flex;flex-direction:column;gap:12px;align-self:start;}
  .infra-panel-h{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;color:var(--text-dim);}
  .infra-stat{display:flex;align-items:center;gap:10px;font-size:12px;color:var(--text);}
  .infra-stat-dot{width:8px;height:8px;border-radius:50%;flex:0 0 auto;}
  .infra-stat-l{flex:1 1 auto;}
  .infra-stat-v{color:var(--text);}
  .infra-panel-div{height:1px;background:var(--border);margin:2px 0;}
  .infra-panel-row{display:flex;align-items:center;justify-content:space-between;gap:12px;font-size:12px;color:var(--text-dim);}
  .infra-panel-btn{font-size:12px;color:var(--accent-text);background:transparent;border:none;padding:0;cursor:pointer;text-align:left;}
  .infra-page .issues{max-height:var(--body-table);overflow-y:auto;}
  .infra-page .grid-dense .issues{max-height:var(--panel-md);overflow-y:auto;}
  `;
  document.head.appendChild(s);
})();

