function ProvisionTab(){
  const {params}=useRoute();
  const {locked}=useData();
  const {bind}=useHoverDetail();
  const whoamiApi=useApi('/api/whoami');
  const role=(whoamiApi.data&&whoamiApi.data.role)||'viewer';
  const isAdmin=role==='admin';
  const [mode,setMode]=useState('subnet'); // 'subnet' | 'site' | 'seed'
  const spacesApi=useApi('/api/ipam/spaces');
  const [space,setSpace]=useState(params.space||'');
  const [block,setBlock]=useState(params.block||'');
  const blocksApi=useApi(space?('/api/ipam/blocks?space='+encodeURIComponent(space)):null);
  const [cidr,setCidr]=useState(params.cidr||24);
  const [name,setName]=useState(params.from||params.name||'');
  const [comment,setComment]=useState('');
  const [makeZone,setMakeZone]=useState(false);
  const [dry,setDry]=useState(true);
  const [log,setLog]=useState([]);
  const [streaming,setStreaming]=useState(false);
  const [success,setSuccess]=useState(null);
  const [streamErr,setStreamErr]=useState(null);
  const esRef=useRef(null);
  // Marris examples (secondary, kebab): 'site'|'addressBlock'|'dns' = which
  // illustrative example callout to sample-render. Prefill / sample only.
  const [examplePanel,setExamplePanel]=useState(null);

  // Full site mode.
  const templatesApi=useApi('/api/templates');
  const [siteTemplate,setSiteTemplate]=useState('');
  const [siteSpace,setSiteSpace]=useState('');
  const [siteDry,setSiteDry]=useState(true);
  const [siteLog,setSiteLog]=useState([]);
  const [siteStreaming,setSiteStreaming]=useState(false);
  const [siteSuccess,setSiteSuccess]=useState(null);
  const [siteErr,setSiteErr]=useState(null);
  const siteEsRef=useRef(null);

  // Per-site teardown (site mode).
  const [siteTeardownDry,setSiteTeardownDry]=useState(true);
  const [siteTeardownConfirm,setSiteTeardownConfirm]=useState('');
  const [siteTeardownLog,setSiteTeardownLog]=useState([]);
  const [siteTeardownStreaming,setSiteTeardownStreaming]=useState(false);
  const [siteTeardownResult,setSiteTeardownResult]=useState(null);
  const [siteTeardownErr,setSiteTeardownErr]=useState(null);
  const siteTeardownEsRef=useRef(null);

  // Seed demo mode.
  const [seedRegions,setSeedRegions]=useState({amer:true,emea:true,apac:true});
  const [seedSpace,setSeedSpace]=useState('');
  const [seedDry,setSeedDry]=useState(true);
  const [seedLog,setSeedLog]=useState([]);
  const [seedRows,setSeedRows]=useState({});
  const [seedStreaming,setSeedStreaming]=useState(false);
  const [seedSummary,setSeedSummary]=useState(null);
  const [seedErr,setSeedErr]=useState(null);
  const seedEsRef=useRef(null);

  // Seed demo teardown (Phase 2) — live (dry-off) runs require typing DELETE.
  const [teardownDry,setTeardownDry]=useState(true);
  const [teardownConfirm,setTeardownConfirm]=useState('');
  const [teardownLog,setTeardownLog]=useState([]);
  const [teardownRows,setTeardownRows]=useState({});
  const [teardownStreaming,setTeardownStreaming]=useState(false);
  const [teardownSummary,setTeardownSummary]=useState(null);
  const [teardownErr,setTeardownErr]=useState(null);
  const teardownEsRef=useRef(null);

  useEffect(()=>{ setSpace(params.space||''); },[params.space]);
  // Cleanup: close any live streams on unmount so none leak past this tab.
  useEffect(()=>()=>{
    if(esRef.current){ esRef.current.close(); esRef.current=null; }
    if(siteEsRef.current){ siteEsRef.current.close(); siteEsRef.current=null; }
    if(siteTeardownEsRef.current){ siteTeardownEsRef.current.close(); siteTeardownEsRef.current=null; }
    if(seedEsRef.current){ seedEsRef.current.close(); seedEsRef.current=null; }
    if(teardownEsRef.current){ teardownEsRef.current.close(); teardownEsRef.current=null; }
  },[]);

  if(locked) return null;

  const spaces=(spacesApi.data&&spacesApi.data.spaces)||[];
  const blocks=(blocksApi.data&&blocksApi.data.blocks)||[];
  const templates=Array.isArray(templatesApi.data)?templatesApi.data:[];

  const start=()=>{
    if(streaming||esRef.current) return; // guard: never open a second concurrent stream
    setLog([]);setSuccess(null);setStreamErr(null);setStreaming(true);
    const qs=new URLSearchParams({space,block,cidr:String(cidr||24),name,comment,
      make_zone:makeZone?'1':'0',dry:dry?'1':'0'});
    const es=new EventSource('/api/provision/stream?'+qs.toString());
    esRef.current=es;
    const stop=()=>{ if(esRef.current){ esRef.current.close(); esRef.current=null; } setStreaming(false); };
    es.onmessage=(e)=>{
      let j=null; try{ j=JSON.parse(e.data); }catch(parseErr){ return; }
      setLog(prev=>[...prev,j]);
      if(j&&j.error){ setStreamErr(j.error); stop(); toast('Provision failed: '+j.error,'err'); }
      else if(j&&j.done){ setSuccess(j.subnet||null); stop(); toast('Subnet provisioned','ok'); }
    };
    es.onerror=()=>{
      if(!esRef.current) return; // already closed via done/error message
      setStreamErr(prev=>prev||'Stream connection error');
      stop();
    };
  };

  const siteStart=()=>{
    if(siteStreaming||siteEsRef.current) return; // guard: never open a second concurrent stream
    setSiteLog([]);setSiteSuccess(null);setSiteErr(null);setSiteStreaming(true);
    const qs=new URLSearchParams({template:siteTemplate,dry:siteDry?'1':'0'});
    if(siteSpace) qs.set('ip_space',siteSpace);
    const es=new EventSource('/api/provision/site/stream?'+qs.toString());
    siteEsRef.current=es;
    const stop=()=>{ if(siteEsRef.current){ siteEsRef.current.close(); siteEsRef.current=null; } setSiteStreaming(false); };
    es.onmessage=(e)=>{
      let j=null; try{ j=JSON.parse(e.data); }catch(parseErr){ return; }
      setSiteLog(prev=>[...prev,j]);
      if(j&&j.error){ setSiteErr(j.error); stop(); toast('Site provision failed: '+j.error,'err'); }
      else if(j&&j.done){ setSiteSuccess(j.result||null); stop(); toast('Site provisioned','ok'); }
    };
    es.onerror=()=>{
      if(!siteEsRef.current) return; // already closed via done/error message
      setSiteErr(prev=>prev||'Stream connection error');
      stop();
    };
  };

  const siteTeardownStart=()=>{
    if(siteTeardownStreaming||siteTeardownEsRef.current) return; // guard: never open a second concurrent stream
    if(!siteTeardownDry&&!isAdmin){ toast('Admin (dashboard token) required for live teardown','err'); return; }
    if(!siteTeardownDry&&!siteTeardownConfirm.trim()){ toast('Type the site name to confirm','err'); return; }
    if(!siteTeardownDry&&!window.confirm("This permanently deletes the site '"+siteTemplate+"' and its objects. Continue?")) return;
    setSiteTeardownLog([]);setSiteTeardownResult(null);setSiteTeardownErr(null);setSiteTeardownStreaming(true);
    const qs=new URLSearchParams({template:siteTemplate,dry:siteTeardownDry?'1':'0'});
    if(siteSpace) qs.set('ip_space',siteSpace);
    if(!siteTeardownDry) qs.set('confirm',siteTeardownConfirm.trim());
    const es=new EventSource('/api/teardown/site/stream?'+qs.toString());
    siteTeardownEsRef.current=es;
    const stop=()=>{ if(siteTeardownEsRef.current){ siteTeardownEsRef.current.close(); siteTeardownEsRef.current=null; } setSiteTeardownStreaming(false); };
    es.onmessage=(e)=>{
      let j=null; try{ j=JSON.parse(e.data); }catch(parseErr){ return; }
      setSiteTeardownLog(prev=>[...prev,j]);
      if(j&&j.error){ setSiteTeardownErr(j.error); stop(); toast('Site teardown failed: '+j.error,'err'); }
      else if(j&&j.done){ setSiteTeardownResult(j.result||null); stop(); toast('Site torn down','ok'); }
    };
    es.onerror=()=>{
      if(!siteTeardownEsRef.current) return; // already closed via done/error message
      setSiteTeardownErr(prev=>prev||'Stream connection error');
      stop();
    };
  };

  const seedStart=()=>{
    if(seedStreaming||seedEsRef.current) return; // guard: never open a second concurrent stream
    const regionList=Object.keys(seedRegions).filter(r=>seedRegions[r]);
    if(!regionList.length){ toast('Select at least one region','err'); return; }
    if(!seedDry&&!window.confirm('This writes many real objects to the live portal. Continue?')) return;
    setSeedLog([]);setSeedRows({});setSeedSummary(null);setSeedErr(null);setSeedStreaming(true);
    const qs=new URLSearchParams({dry:seedDry?'1':'0',regions:regionList.join(',')});
    if(seedSpace) qs.set('ip_space',seedSpace);
    const es=new EventSource('/api/provision/seed-demo/stream?'+qs.toString());
    seedEsRef.current=es;
    const stop=()=>{ if(seedEsRef.current){ seedEsRef.current.close(); seedEsRef.current=null; } setSeedStreaming(false); };
    es.onmessage=(e)=>{
      let j=null; try{ j=JSON.parse(e.data); }catch(parseErr){ return; }
      setSeedLog(prev=>[...prev,j]);
      if(j&&j.template){ setSeedRows(prev=>({...prev,[j.template]:{phase:j.phase,error:j.error}})); }
      if(j&&j.error&&!j.template){ setSeedErr(j.error); stop(); toast('Seed demo failed: '+j.error,'err'); }
      else if(j&&j.done){ setSeedSummary(j.summary||null); stop(); toast('Seed demo complete','ok'); }
    };
    es.onerror=()=>{
      if(!seedEsRef.current) return; // already closed via done/error message
      setSeedErr(prev=>prev||'Stream connection error');
      stop();
    };
  };

  const teardownStart=()=>{
    if(teardownStreaming||teardownEsRef.current) return; // guard: never open a second concurrent stream
    if(!teardownDry&&!isAdmin){ toast('Admin (dashboard token) required for live teardown','err'); return; }
    if(!teardownDry&&teardownConfirm.trim()!=='DELETE'){ toast('Type DELETE to confirm live teardown','err'); return; }
    const regionList=Object.keys(seedRegions).filter(r=>seedRegions[r]);
    if(!regionList.length){ toast('Select at least one region','err'); return; }
    if(!teardownDry&&!window.confirm('This permanently deletes every seed-created object in '+(seedSpace||'the default space')+'. Continue?')) return;
    setTeardownLog([]);setTeardownRows({});setTeardownSummary(null);setTeardownErr(null);setTeardownStreaming(true);
    const qs=new URLSearchParams({dry:teardownDry?'1':'0',regions:regionList.join(','),confirm:teardownDry?'':'DELETE'});
    if(seedSpace) qs.set('ip_space',seedSpace);
    const es=new EventSource('/api/teardown/seed-demo/stream?'+qs.toString());
    teardownEsRef.current=es;
    const stop=()=>{ if(teardownEsRef.current){ teardownEsRef.current.close(); teardownEsRef.current=null; } setTeardownStreaming(false); };
    es.onmessage=(e)=>{
      let j=null; try{ j=JSON.parse(e.data); }catch(parseErr){ return; }
      setTeardownLog(prev=>[...prev,j]);
      if(j&&j.template){ setTeardownRows(prev=>({...prev,[j.template]:{phase:j.phase,error:j.error}})); }
      if(j&&j.error&&!j.template){ setTeardownErr(j.error); stop(); toast('Teardown failed: '+j.error,'err'); }
      else if(j&&j.done){ setTeardownSummary(j.summary||null); stop(); toast('Teardown complete','ok'); }
    };
    es.onerror=()=>{
      if(!teardownEsRef.current) return; // already closed via done/error message
      setTeardownErr(prev=>prev||'Stream connection error');
      stop();
    };
  };

  // Subnet-mode "Load example": prefill the editable form from the london site
  // template's LAN subnet + open the site-template example callout. Space/Block
  // stay user-picked (live IDs). Prefill only — never opens a stream / submits.
  const loadSubnetExample=()=>{
    const ex=MARRIS_EXAMPLES.provision.subnetForm;
    setCidr(ex.cidr);setName(ex.name);setComment(ex.comment);setMakeZone(ex.makeZone);
    setExamplePanel('site');
    toast('Example loaded — review, nothing provisioned','ok',{duration:1800});
  };
  const copyExample=(obj,what)=>{
    try{ if(navigator.clipboard&&navigator.clipboard.writeText) navigator.clipboard.writeText(JSON.stringify(obj,null,2)); }catch(e){}
    toast((what||'Example')+' copied (JSON)','ok',{duration:1500});
  };
  const resetSubnet=()=>{ setCidr(24);setName('');setComment('');setMakeZone(false);setExamplePanel(null); };
  // MarrisExamplePanel — render the named provision example as a labeled callout.
  const ExamplePanel=()=>{
    if(!examplePanel) return null;
    const P=MARRIS_EXAMPLES.provision;
    let title='', body='';
    if(examplePanel==='site'){ title='Site template — london / EMEA / production';
      body=JSON.stringify(P.site,null,2); }
    else if(examplePanel==='addressBlock'){ title='Address-block pool — Global /8 → region×env /16';
      body=JSON.stringify(P.addressBlock,null,2); }
    else { title='DNS zone — corp.example.com'; body=JSON.stringify(P.dns,null,2); }
    return <div className="marris-example">
      <div className="mx-head"><span className="mx-tag">Example</span>
        <span className="mono" style={{fontSize:'var(--t12)',color:'var(--text-dim)'}}>{title} — illustrative, not real data</span></div>
      <pre className="mx-body mono">{body}</pre>
    </div>;
  };

  return <div className="page fadein">
    <PageHeader title="Provision" subtitle="Carve new subnets or full sites from available address space"
      actions={<span className={'sev-badge '+(isAdmin?'ok':role==='operator'?'warn':'crit')}
        {...bind({title:'Your role',rows:[['What it means','Your access level. Live (non-dry-run) teardown requires admin (a dashboard token).']]})}>{role.toUpperCase()}</span>}/>
    <div className="dly-seg" role="group" aria-label="Provision mode" style={{marginBottom:'var(--s3)'}}>
      <button className={'dly-seg-btn'+(mode==='subnet'?' on':'')} onClick={()=>setMode('subnet')}
        {...bind({title:'Subnet mode',rows:[['What it does','Carve a single new subnet from a block — optionally with a matching DNS zone.']]})}>Subnet</button>
      <button className={'dly-seg-btn'+(mode==='site'?' on':'')} onClick={()=>setMode('site')}
        {...bind({title:'Full site mode',rows:[['What it does','Provision an entire site from a template: blocks, subnets, DHCP ranges and DNS zones in one run.']]})}>Full site</button>
      <button className={'dly-seg-btn'+(mode==='seed'?' on':'')} onClick={()=>setMode('seed')}
        {...bind({title:'Seed demo mode',rows:[['What it does','One-click load of demo sites, subnets and zones across regions, from the template library.']]})}>Seed demo</button>
    </div>
    {mode==='subnet'?<div className="grid-2">
      <Panel title="Request">
        <div className="form-col">
          <label className="mono field-lbl"
            {...bind({title:'IP space',rows:[['What it does','The Infoblox address container to provision the new subnet from.']]})}>
            Space
            <select className="vault-in" value={space} onChange={e=>{setSpace(e.target.value);setBlock('');}}>
              <option value="">{spacesApi.loading?'Loading spaces…':'Select a space'}</option>
              {spaces.map(sp=><option key={sp.id} value={sp.id}>{sp.name}</option>)}
            </select>
          </label>
          <label className="mono field-lbl"
            {...bind({title:'Address block',rows:[['What it does','The parent block the new subnet is carved out of.']]})}>
            Block
            <select className="vault-in" value={block} onChange={e=>setBlock(e.target.value)} disabled={!space}>
              <option value="">{blocksApi.loading?'Loading blocks…':'Select a block'}</option>
              {blocks.map(b=><option key={b.id} value={b.id}>{b.name||b.cidr||b.address}</option>)}
            </select>
          </label>
          <label className="mono field-lbl"
            {...bind({title:'Subnet size (CIDR prefix)',rows:[['What it does','Prefix length for the new subnet. Bigger number = smaller subnet.'],['Examples','/24 = 256 addresses · /26 = 64 · /30 = 4']]})}>
            CIDR
            <input className="vault-in" type="number" min="1" max="32" value={cidr} onChange={e=>setCidr(e.target.value)}/>
          </label>
          <label className="mono field-lbl"
            {...bind({title:'Name',rows:[['What it does','Label for the new subnet.']]})}>
            Name
            <input className="vault-in" value={name} onChange={e=>setName(e.target.value)} placeholder="subnet name"/>
          </label>
          <label className="mono field-lbl"
            {...bind({title:'Comment',rows:[['What it does','Optional free-text note stored on the subnet.']]})}>
            Comment
            <input className="vault-in" value={comment} onChange={e=>setComment(e.target.value)} placeholder="optional"/>
          </label>
          <label className="check-row"
            {...bind({title:'Create matching DNS zone',rows:[['What it does','Also create the forward DNS zone for this subnet — not just the address space.']]})}>
            <input type="checkbox" checked={makeZone} onChange={e=>setMakeZone(e.target.checked)}/>
            <span>Create matching DNS zone</span>
          </label>
          <label className="check-row"
            {...bind({title:'Dry-run',rows:[['What it does','Preview every provisioning step and make NO changes. Turn off to actually create.']]})}>
            <input type="checkbox" checked={dry} onChange={e=>setDry(e.target.checked)}/>
            <span>Dry-run (no changes made)</span>
          </label>
          <div style={{display:'flex',alignItems:'center',gap:'var(--s2)'}}>
            <button className="btn" disabled={streaming||!space} onClick={start}
              {...bind({title:'Provision',rows:[['What it does','Run the provision (or its dry-run preview); each step streams live in the log.']]})}>{streaming?'Provisioning…':'Provision'}</button>
            <KebabMenu label="More provision actions" items={[
              {label:'Load example', run:loadSubnetExample},
              {label:'Copy example (JSON)', run:()=>copyExample(MARRIS_EXAMPLES.provision.site,'Site template')},
              {label:'Reset form', run:resetSubnet},
            ]}/>
          </div>
          <ExamplePanel/>
        </div>
      </Panel>
      <Panel title={<span {...bind({title:'Live log',rows:[['What it does','Live output of each provisioning step, streamed from the server via SSE as it runs.']]})}>Live log</span>}>
        {log.length===0
          ? <div className="dt-empty">No output yet</div>
          : <div className="mono" style={{display:'flex',flexDirection:'column',gap:2,fontSize:'var(--t12)',maxHeight:'var(--panel-md)',overflow:'auto'}}>
              {log.map((l,i)=><div key={i} style={{color:l.error?'var(--crit)':l.done?'var(--ok)':'var(--text-dim)'}}>
                {l.error?('✕ '+l.error):l.done?('✓ done — subnet '+((l.subnet&&(l.subnet.address||l.subnet.id))||'')):(l.step||JSON.stringify(l))}
              </div>)}
            </div>}
      </Panel>
      {success?<Panel title="Success">
        <div className="mono" style={{fontSize:'var(--t12)'}}>
          Subnet id: {success.id ?? '—'} · {success.address||''}{success.cidr?('/'+success.cidr):''}
        </div>
      </Panel>:null}
      {streamErr?<Panel title="Error"><div className="mono" style={{color:'var(--crit)'}}>{streamErr}</div></Panel>:null}
    </div>:null}
    {mode==='site'?<div className="grid-2">
      <Panel title="Request">
        <div className="form-col">
          <label className="mono field-lbl"
            {...bind({title:'IP space override',rows:[['What it does','Provision into this space instead of the template default. Blocks inside are found by Region + Environment + Status=available tags — no hardcoded CIDR.']]})}>
            IP space (override)
            <select className="vault-in" value={siteSpace} onChange={e=>setSiteSpace(e.target.value)}>
              <option value="">— template default —</option>
              {spaces.map(sp=><option key={sp.id} value={sp.name}>{sp.name}</option>)}
            </select>
          </label>
          <label className="mono field-lbl"
            {...bind({title:'Site template',rows:[['What it does','The site blueprint to provision. Its Region / Environment tags decide which available block gets used.'],['Format','name — Region/Environment (invalid templates are marked).']]})}>
            Template
            <select className="vault-in" value={siteTemplate} onChange={e=>setSiteTemplate(e.target.value)}>
              <option value="">{templatesApi.loading?'Loading templates…':'Select a template'}</option>
              {templates.map(t=><option key={t.name} value={t.name}>
                {t.name+' — '+(t.region||'')+'/'+(t.environment||'')+(t.valid===false?' (invalid)':'')}
              </option>)}
            </select>
          </label>
          <label className="check-row"
            {...bind({title:'Dry-run',rows:[['What it does','Preview every step of the site build and make NO changes. Turn off to actually provision.']]})}>
            <input type="checkbox" checked={siteDry} onChange={e=>setSiteDry(e.target.checked)}/>
            <span>Dry-run (no changes made)</span>
          </label>
          <div style={{display:'flex',alignItems:'center',gap:'var(--s2)'}}>
            <button className="btn" disabled={siteStreaming||!siteTemplate} onClick={siteStart}
              {...bind({title:'Provision site',rows:[['What it does','Build the whole site from the template — blocks, subnets, DHCP ranges and DNS zones — or preview it as a dry-run.']]})}>{siteStreaming?'Provisioning…':'Provision site'}</button>
            <KebabMenu label="More site actions" items={[
              {label:'Load site example', run:()=>setExamplePanel('site')},
              {label:'Load address-block example', run:()=>setExamplePanel('addressBlock')},
              {label:'Load DNS example', run:()=>setExamplePanel('dns')},
              {label:'Copy site template (JSON)', run:()=>copyExample(MARRIS_EXAMPLES.provision.site,'Site template')},
            ]}/>
          </div>
          <ExamplePanel/>
          <div style={{borderTop:'1px solid var(--border)',marginTop:'var(--s3)',paddingTop:'var(--s3)',display:'flex',flexDirection:'column',gap:'var(--s3)'}}>
            <div className="mono" style={{fontSize:'var(--t11)',color:'var(--crit)'}}
              {...bind({title:'Tear down / decommission',rows:[['What it does','Undo a site provision — permanently delete every object it created.']]})}>
              Tear down this site — permanently deletes its provisioned objects.
            </div>
            <label className="check-row"
              {...bind({title:'Dry-run',rows:[['What it does','Preview the teardown only — nothing is deleted. Turn off (admin) to actually decommission.']]})}>
              <input type="checkbox" checked={siteTeardownDry} onChange={e=>setSiteTeardownDry(e.target.checked)}/>
              <span>Dry-run (no changes made)</span>
            </label>
            {!siteTeardownDry?(isAdmin?<label className="mono field-lbl"
              {...bind({title:'Confirm teardown',rows:[['What it does','Type the site name to unlock the live teardown — a safety gate against accidental deletion.']]})}>
              Type the site name to confirm
              <input className="vault-in" value={siteTeardownConfirm} onChange={e=>setSiteTeardownConfirm(e.target.value)} placeholder={siteTemplate||'site name'}/>
            </label>:<div className="mono" style={{fontSize:'var(--t11)',color:'var(--warn)'}}>Admin (dashboard token) required for live teardown</div>):null}
            <button className="btn" disabled={siteTeardownStreaming||!siteTemplate||(!siteTeardownDry&&(!isAdmin||!siteTeardownConfirm.trim()))} onClick={siteTeardownStart}
              {...bind({title:'Tear down this site',rows:[['What it does','Permanently delete this site\'s provisioned objects. This decommissions the site.']]})}>
              {siteTeardownStreaming?'Tearing down…':'Tear down this site'}
            </button>
          </div>
        </div>
      </Panel>
      <Panel title={<span {...bind({title:'Live log',rows:[['What it does','Live per-step output of the site build, streamed from the server via SSE.']]})}>Live log</span>}>
        {siteLog.length===0
          ? <div className="dt-empty">No output yet</div>
          : <div className="mono" style={{display:'flex',flexDirection:'column',gap:2,fontSize:'var(--t12)',maxHeight:'var(--panel-md)',overflow:'auto'}}>
              {siteLog.map((l,i)=><div key={i} style={{color:l.error?'var(--crit)':l.done?'var(--ok)':'var(--text-dim)'}}>
                {l.error?('✕ '+l.error):l.done?'✓ done':(l.step||JSON.stringify(l))}
              </div>)}
            </div>}
      </Panel>
      {siteSuccess?<Panel title="Success">
        <div className="mono" style={{fontSize:'var(--t12)'}}>{JSON.stringify(siteSuccess)}</div>
      </Panel>:null}
      {siteErr?<Panel title="Error"><div className="mono" style={{color:'var(--crit)'}}>{siteErr}</div></Panel>:null}
      {siteTeardownLog.length?<Panel title="Teardown log">
        <div className="mono" style={{display:'flex',flexDirection:'column',gap:2,fontSize:'var(--t12)',maxHeight:'var(--panel-md)',overflow:'auto'}}>
          {siteTeardownLog.map((l,i)=><div key={i} style={{color:l.error?'var(--crit)':l.done?'var(--ok)':'var(--text-dim)'}}>
            {l.error?('✕ '+l.error):l.done?'✓ done':(l.step||JSON.stringify(l))}
          </div>)}
        </div>
      </Panel>:null}
      {siteTeardownResult?<Panel title="Teardown result">
        <div className="mono" style={{fontSize:'var(--t12)'}}>{JSON.stringify(siteTeardownResult)}</div>
      </Panel>:null}
      {siteTeardownErr?<Panel title="Teardown error"><div className="mono" style={{color:'var(--crit)'}}>{siteTeardownErr}</div></Panel>:null}
    </div>:null}
    {mode==='seed'?<div className="grid-2">
      <Panel title="Seed multi-region demo data">
        <div className="mono" style={{fontSize:'var(--t11)',color:'var(--text-faint)',marginBottom:'var(--s3)'}}>
          Provisions a full set of demo sites, subnets, and zones across the selected regions from the template library. Dry-run is on by default — review the plan before writing real objects.
        </div>
        <div className="form-col">
          {['amer','emea','apac'].map(r=>
            <label key={r} className="check-row"
              {...bind({title:'Region — '+r.toUpperCase(),rows:[['What it does','Include this region\'s demo sites in the seed. Region is a lifecycle tag also used to discover which blocks to provision from.']]})}>
              <input type="checkbox" checked={!!seedRegions[r]} onChange={e=>setSeedRegions(prev=>({...prev,[r]:e.target.checked}))}/>
              <span>{r.toUpperCase()}</span>
            </label>)}
          <label className="mono field-lbl"
            {...bind({title:'IP space override',rows:[['What it does','Seed into this space instead of each template\'s default.']]})}>
            IP space (override)
            <select className="vault-in" value={seedSpace} onChange={e=>setSeedSpace(e.target.value)}>
              <option value="">— template default —</option>
              {spaces.map(sp=><option key={sp.id} value={sp.name}>{sp.name}</option>)}
            </select>
          </label>
          <label className="check-row"
            {...bind({title:'Dry-run',rows:[['What it does','Preview the seed plan and write NO objects. Turn off to create real demo data.']]})}>
            <input type="checkbox" checked={seedDry} onChange={e=>setSeedDry(e.target.checked)}/>
            <span>Dry-run (no changes made)</span>
          </label>
          <button className="btn" disabled={seedStreaming} onClick={seedStart}
            {...bind({title:'Seed demo data',rows:[['What it does','Provision the selected regions\' demo sites, subnets and zones (or preview them with Dry-run on).']]})}>{seedStreaming?'Seeding…':'Seed Demo Data'}</button>
          <div style={{borderTop:'1px solid var(--border)',marginTop:'var(--s3)',paddingTop:'var(--s3)',display:'flex',flexDirection:'column',gap:'var(--s3)'}}>
            <div className="mono" style={{fontSize:'var(--t11)',color:'var(--crit)'}}
              {...bind({title:'Tear down demo',rows:[['What it does','Undo the seed — permanently delete every object it created in the target space.']]})}>
              Tear down demo — permanently deletes every seed-created object in {seedSpace||'the default space'}.
            </div>
            <label className="check-row"
              {...bind({title:'Dry-run',rows:[['What it does','Preview the teardown — nothing is deleted. Turn off (admin) to remove seed data.']]})}>
              <input type="checkbox" checked={teardownDry} onChange={e=>setTeardownDry(e.target.checked)}/>
              <span>Dry-run (no changes made)</span>
            </label>
            {!teardownDry?(isAdmin?<label className="mono field-lbl"
              {...bind({title:'Confirm teardown',rows:[['What it does','Type DELETE to unlock live removal of every seed-created object — a safety gate.']]})}>
              Type DELETE to confirm
              <input className="vault-in" value={teardownConfirm} onChange={e=>setTeardownConfirm(e.target.value)} placeholder="DELETE"/>
            </label>:<div className="mono" style={{fontSize:'var(--t11)',color:'var(--warn)'}}>Admin (dashboard token) required for live teardown</div>):null}
            <button className="btn" disabled={teardownStreaming||(!teardownDry&&(!isAdmin||teardownConfirm.trim()!=='DELETE'))} onClick={teardownStart}
              {...bind({title:'Tear down demo',rows:[['What it does','Permanently delete every seed-created object in the target space.']]})}>
              {teardownStreaming?'Tearing down…':'Tear down demo'}
            </button>
          </div>
        </div>
      </Panel>
      <Panel title={<span {...bind({title:'Progress',rows:[['What it does','Per-template status as each demo site is provisioned.']]})}>Progress</span>}>
        {Object.keys(seedRows).length===0
          ? <div className="dt-empty">No output yet</div>
          : <div style={{display:'flex',flexDirection:'column',gap:2}}>
              {Object.entries(seedRows).map(([tpl,row])=>
                <div key={tpl} className="mono" style={{fontSize:'var(--t12)',color:row.error?'var(--crit)':'var(--text-dim)'}}>
                  {tpl}: {row.error?('✕ '+row.error):(row.phase||'…')}
                </div>)}
            </div>}
      </Panel>
      <Panel title={<span {...bind({title:'Live log',rows:[['What it does','Live per-step output of the seed run, streamed from the server via SSE.']]})}>Live log</span>}>
        {seedLog.length===0
          ? <div className="dt-empty">No output yet</div>
          : <div className="mono" style={{display:'flex',flexDirection:'column',gap:2,fontSize:'var(--t12)',maxHeight:'var(--panel-md)',overflow:'auto'}}>
              {seedLog.map((l,i)=><div key={i} style={{color:l.error?'var(--crit)':l.done?'var(--ok)':'var(--text-dim)'}}>
                {l.error?(l.template?('✕ '+l.template+': '+l.error):('✕ '+l.error)):l.done?'✓ done':(l.template?(l.template+' — '+(l.phase||'')):JSON.stringify(l))}
              </div>)}
            </div>}
      </Panel>
      {seedSummary?<Panel title="Summary">
        <div className="mono" style={{fontSize:'var(--t12)'}}>
          Succeeded: {seedSummary.succeeded ?? 0} · Failed: {seedSummary.failed ?? 0} · Skipped: {seedSummary.skipped ?? 0}
        </div>
      </Panel>:null}
      {seedErr?<Panel title="Error"><div className="mono" style={{color:'var(--crit)'}}>{seedErr}</div></Panel>:null}
      <Panel title="Teardown progress">
        {Object.keys(teardownRows).length===0
          ? <div className="dt-empty">No output yet</div>
          : <div style={{display:'flex',flexDirection:'column',gap:2}}>
              {Object.entries(teardownRows).map(([tpl,row])=>
                <div key={tpl} className="mono" style={{fontSize:'var(--t12)',color:row.error?'var(--crit)':'var(--text-dim)'}}>
                  {tpl}: {row.error?('✕ '+row.error):(row.phase||'…')}
                </div>)}
            </div>}
      </Panel>
      <Panel title="Teardown log">
        {teardownLog.length===0
          ? <div className="dt-empty">No output yet</div>
          : <div className="mono" style={{display:'flex',flexDirection:'column',gap:2,fontSize:'var(--t12)',maxHeight:'var(--panel-md)',overflow:'auto'}}>
              {teardownLog.map((l,i)=><div key={i} style={{color:l.error?'var(--crit)':l.done?'var(--ok)':'var(--text-dim)'}}>
                {l.error?(l.template?('✕ '+l.template+': '+l.error):('✕ '+l.error)):l.done?'✓ done':(l.template?(l.template+' — '+(l.phase||'')):(l.step||JSON.stringify(l)))}
              </div>)}
            </div>}
      </Panel>
      {teardownSummary?<Panel title="Teardown summary">
        <div className="mono" style={{fontSize:'var(--t12)'}}>
          Succeeded: {teardownSummary.succeeded ?? 0} · Failed: {teardownSummary.failed ?? 0} · Skipped: {teardownSummary.skipped ?? 0}
        </div>
      </Panel>:null}
      {teardownErr?<Panel title="Teardown error"><div className="mono" style={{color:'var(--crit)'}}>{teardownErr}</div></Panel>:null}
    </div>:null}
  </div>;
}
// ═══ END: PROVISION ═══
// ═══ REGION: EDITOR ═══
/* FIELD_SPECS — hardcoded field metadata (no schema endpoint), same idiom
   as RTYPE_HINTS above, for the 5 NEW /api/edit/<type> resource types Phase
   1 added server-side, plus 'tags' (targets the existing /api/retag/block
   block-status re-tag endpoint — not a literal free-form tag editor).
   dns_record/ip_address are intentionally absent here: EditorTab reuses
   SelfServiceTab's DNS-record CRUD + Allocate forms verbatim for those two
   types instead of a generic field-driven form (plan's do-NOT-touch
   SelfServiceTab blast-radius rule). */
