function driftMark(d){
  const m=String((d&&d.message)||'');
  if(/live value is/.test(m)) return {mark:'~',label:'changed'};
  if(/is not in the template/.test(m)) return {mark:'−',label:'only in live'};
  return {mark:'+',label:'only in template'};
}
function DriftTab(){
  const {locked}=useData();
  const {bind}=useHoverDetail();
  const templatesApi=useApi('/api/templates');
  const spacesApi=useApi('/api/ipam/spaces');
  const [template,setTemplate]=useState('');
  const [ipSpace,setIpSpace]=useState('');
  const [checking,setChecking]=useState(false);
  const [result,setResult]=useState(null);
  const [err,setErr]=useState(null);
  const [showExample,setShowExample]=useState(false); // sample-render an illustrative drift result
  if(locked) return null;

  const templates=(Array.isArray(templatesApi.data)?templatesApi.data:[]).filter(t=>!t.type||t.type==='site');
  const spaces=(spacesApi.data&&spacesApi.data.spaces)||[];

  const check=()=>{
    if(checking||!template) return;
    setChecking(true);setResult(null);setErr(null);
    fetch('/api/drift/check',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({template,ip_space:ipSpace||undefined})})
      .then(async r=>{
        let body=null; try{body=await r.json();}catch(e){body=null;}
        if(!r.ok||(body&&body.error)){ setErr((body&&body.error)||('HTTP '+r.status)); setChecking(false); return; }
        setResult(body); setChecking(false);
      })
      .catch(e=>{ setErr(String((e&&e.message)||e)); setChecking(false); });
  };

  const groups={};
  if(result&&Array.isArray(result.drifts)){
    result.drifts.forEach(d=>{
      const cat=d.category||'other';
      (groups[cat]||(groups[cat]=[])).push(d);
    });
  }

  return <div className="page fadein">
    <PageHeader title="Drift" subtitle="Compare running DHCP/DNS config to source of truth"/>
    <div className="grid-2">
      <Panel title="Check drift">
        <div className="form-col">
          <label className="mono field-lbl"
            {...bind({title:'Site template',rows:[['What it does','The site blueprint to check. Drift compares this template against what actually exists in Infoblox.']]})}>
            Template
            <select className="vault-in" value={template} onChange={e=>setTemplate(e.target.value)}>
              <option value="">{templatesApi.loading?'Loading templates…':'Select a template'}</option>
              {templates.map(t=><option key={t.name} value={t.name}>
                {t.name+' — '+(t.region||'')+'/'+(t.environment||'')}
              </option>)}
            </select>
          </label>
          <label className="mono field-lbl"
            {...bind({title:'IP space override',rows:[['What it does','Check against this space instead of the template default.']]})}>
            IP space (override)
            <select className="vault-in" value={ipSpace} onChange={e=>setIpSpace(e.target.value)}>
              <option value="">— template default —</option>
              {spaces.map(sp=><option key={sp.id} value={sp.name}>{sp.name}</option>)}
            </select>
          </label>
          <div style={{display:'flex',alignItems:'center',gap:'var(--s2)'}}>
            <button className="btn" disabled={checking||!template} onClick={check}
              {...bind({title:'Check drift',rows:[['What it does','Compare your site template to the live Infoblox state and report the differences. Read-only — it changes nothing.']]})}>{checking?'Checking…':'Check drift'}</button>
            <KebabMenu label="More drift actions" items={[
              {label:showExample?'Hide example':'Show example', run:()=>setShowExample(v=>!v)},
            ]}/>
          </div>
          {showExample?<MarrisExampleDiff/>:null}
        </div>
      </Panel>
      {result?<Panel title="Result">
        {result.found===false
          ? <div className="dt-empty">Site not found for this template</div>
          : <>
              <div style={{display:'flex',alignItems:'center',gap:'var(--s3)',marginBottom:'var(--s3)'}}>
                <span className="mono" style={{fontSize:'var(--t12)'}}>{result.site||template}</span>
                <span className="chip" style={{color:result.drifted?'var(--crit)':'var(--ok)',borderColor:result.drifted?'var(--crit)':'var(--ok)'}}
                  {...bind({title:'Drift status',rows:[['✓ no drift','Live state matches the template — in sync.'],['✕ N items','N differences found between the template and live state.'],['Site not found','Never provisioned from this template.']]})}>
                  {result.drifted?('✕ '+((result.drifts&&result.drifts.length)||0)+' items'):'✓ no drift'}
                </span>
                {result.subnet_count!=null?<span className="mono field-lbl">{result.subnet_count} subnets</span>:null}
              </div>
              {result.summary?<div className="mono" style={{fontSize:'var(--t12)',color:'var(--text-dim)',marginBottom:'var(--s3)'}}>
                {typeof result.summary==='string'
                  ? result.summary
                  : ((result.summary.total??0)+' total · '+(result.summary.errors??0)+' error'+(result.summary.errors===1?'':'s')+' · '+(result.summary.warnings??0)+' warning'+(result.summary.warnings===1?'':'s'))}
              </div>:null}
              {Object.keys(groups).length===0
                ? <div className="dt-empty">No drift items</div>
                : Object.entries(groups).map(([cat,items])=>
                    <div key={cat} style={{marginBottom:'var(--s3)'}}>
                      <div className="mono" style={{fontSize:'var(--t11)',color:'var(--text-faint)',textTransform:'uppercase',marginBottom:'var(--s1)'}}>{cat}</div>
                      {/* Glyph-diff render — shared dt-diff vocabulary (+/−/~), monochrome
                          body text, accessible label per glyph. No color-only signal. */}
                      <table className="dt">
                        <tbody>
                          {items.map((d,i)=>{
                            const g=driftMark(d);
                            return <tr key={i}>
                              <td className="dt-diff mono"><span aria-label={g.label} title={g.label}>{g.mark}</span></td>
                              <td className="mono" style={{fontSize:'var(--t12)'}}>{d.message}</td>
                            </tr>;
                          })}
                        </tbody>
                      </table>
                    </div>)}
            </>}
      </Panel>:null}
      {err?<Panel title="Error"><div className="mono" style={{color:'var(--crit)'}}>{err}</div></Panel>:null}
    </div>
  </div>;
}

/* subsequence match — chars of needle appear in order within hay (fuzzy go-to). */
