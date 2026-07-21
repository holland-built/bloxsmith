const FIELD_SPECS={
  dns_zone:{label:'DNS Zone',endpoint:'/api/edit/dns_zone',fields:[
    {key:'fqdn',label:'FQDN',kind:'text',placeholder:'zone.example.com.',required:true},
    {key:'view',label:'View ID',kind:'text',placeholder:'view id',required:true},
    {key:'comment',label:'Comment',kind:'text'},
    {key:'tags',label:'Tags (key=value, key2=value2)',kind:'text',placeholder:'env=prod,team=noc'},
  ]},
  subnet:{label:'Subnet',endpoint:'/api/edit/subnet',fields:[
    {key:'block_id',label:'Address Block ID',kind:'text',placeholder:'block id',required:true},
    {key:'cidr',label:'CIDR (prefix length)',kind:'number',placeholder:'24',required:true},
    {key:'name',label:'Name',kind:'text'},
    {key:'comment',label:'Comment',kind:'text'},
    {key:'tags',label:'Tags (key=value, key2=value2)',kind:'text'},
  ]},
  address_block:{label:'Address Block',endpoint:'/api/edit/address_block',fields:[
    {key:'address',label:'Address',kind:'text',placeholder:'10.20.0.0',required:true},
    {key:'cidr',label:'CIDR (prefix length)',kind:'number',placeholder:'16',required:true},
    {key:'space',label:'IP Space',kind:'text',placeholder:'my-ip-space',required:true},
    {key:'comment',label:'Comment',kind:'text'},
    {key:'tags',label:'Tags (key=value, key2=value2)',kind:'text'},
  ]},
  dhcp_range:{label:'DHCP Range',endpoint:'/api/edit/dhcp_range',fields:[
    {key:'start',label:'Start address',kind:'text',placeholder:'10.20.0.100',required:true},
    {key:'end',label:'End address',kind:'text',placeholder:'10.20.0.200',required:true},
    {key:'space',label:'IP Space',kind:'text',placeholder:'my-ip-space',required:true},
    {key:'tags',label:'Tags (key=value, key2=value2)',kind:'text'},
  ]},
  host:{label:'Host',endpoint:'/api/edit/host',fields:[
    {key:'name',label:'Name',kind:'text',placeholder:'host.example.com',required:true},
    {key:'addresses',label:'Addresses (comma-separated)',kind:'text',placeholder:'10.0.0.5, 10.0.0.6',required:true},
    {key:'comment',label:'Comment',kind:'text'},
  ]},
  tags:{label:'Tags (block re-tag)',endpoint:'/api/retag/block',fields:[
    {key:'template',label:'Site template',kind:'text',placeholder:'template name'},
    {key:'site',label:'Site',kind:'text',placeholder:'site name'},
    {key:'address',label:'Block address',kind:'text',placeholder:'10.20.0.0'},
    {key:'cidr',label:'CIDR (prefix length)',kind:'number',placeholder:'16'},
    {key:'status',label:'Status',kind:'text',placeholder:'available'},
    {key:'ip_space',label:'IP Space',kind:'text',placeholder:'my-ip-space'},
  ]},
};
const EDITOR_TYPES=[
  {key:'dns_zone',label:'DNS Zone'},
  {key:'subnet',label:'Subnet'},
  {key:'address_block',label:'Address Block'},
  {key:'dhcp_range',label:'DHCP Range'},
  {key:'host',label:'Host'},
  {key:'tags',label:'Tags'},
];
// Phase 3: which /api/edit types support PATCH update vs DELETE (per _EDIT_RESOURCES).
const EDIT_UPDATE_TYPES=['dns_zone','subnet','dhcp_range','host'];
const EDIT_DELETE_TYPES=['dns_zone','subnet','dhcp_range','host','address_block'];

/* EditorTab — consolidated create surface for the 6 FIELD_SPECS-backed resource
   types (plan brainstorms/resource-editor-plan-2026-07-11.md, Phase 2; DNS Record
   and IP Address are handled by SelfServiceTab, not duplicated here). Each type
   renders a generic Panel form driven by FIELD_SPECS, dry-run-default ON,
   role-gated below operator. Deep-link params (type + per-field prefill, e.g.
   #editor?type=host&name=foo) seed the initial type/fields so Phase 3 row-level
   Edit/New links can pre-fill this form. */
function EditorTab(){
  const {params}=useRoute();
  const {locked}=useData();
  const {confirm}=useCommit();   // shared confirm→diff→rollback dialog for LIVE writes
  const whoamiApi=useApi('/api/whoami');
  const role=(whoamiApi.data&&whoamiApi.data.role)||'viewer';
  const isViewer=role==='viewer';
  const initialType=(params.type&&EDITOR_TYPES.some(t=>t.key===params.type))?params.type:'dns_zone';
  const [type,setType]=useState(initialType);
  const [editId,setEditId]=useState(params.id||null); // Phase 3: id present → edit (PATCH/DELETE) mode
  const [fields,setFields]=useState({});
  const [dry,setDry]=useState(true);
  const [busy,setBusy]=useState(false);
  const [preview,setPreview]=useState(null);
  const [err,setErr]=useState(null);

  // Re-seed the form whenever the type changes (including the initial
  // deep-link type) so #editor?type=host&name=foo prefills the Name field.
  useEffect(()=>{
    const spec=FIELD_SPECS[type];
    const seed={};
    if(spec) spec.fields.forEach(f=>{ if(params[f.key]!=null) seed[f.key]=params[f.key]; });
    setFields(seed);setDry(true);setPreview(null);setErr(null);
  },[type]);

  if(locked) return null;

  const spec=FIELD_SPECS[type];
  const isUpdate=!!editId&&EDIT_UPDATE_TYPES.includes(type); // PATCH vs POST branch
  const canDelete=!!editId&&EDIT_DELETE_TYPES.includes(type);

  const setField=(k,v)=>setFields(prev=>({...prev,[k]:v}));

  // Plain-English name for the object under edit — shown in the confirm dialog header/summary.
  const objLabel=()=>String(fields.fqdn||fields.name||fields.cidr||fields.address||fields.start||editId||(spec&&spec.label)||'').trim()||(spec&&spec.label)||type;

  const parseTags=(str)=>{
    const out={};
    String(str||'').split(',').forEach(pair=>{
      const i=pair.indexOf('=');
      if(i<0) return;
      const k=pair.slice(0,i).trim();
      if(k) out[k]=pair.slice(i+1).trim();
    });
    return out;
  };

  const submit=()=>{
    if(!spec||busy) return;
    // Required-field check applies to create only — a PATCH update legitimately sends a partial body.
    if(!isUpdate){
      const missing=spec.fields.find(f=>f.required&&!String(fields[f.key]||'').trim());
      if(missing){ toast('Missing required field: '+missing.label,'err'); return; }
    }
    const body={};
    spec.fields.forEach(f=>{
      const raw=fields[f.key];
      if(raw==null||raw==='') return;
      if(f.key==='tags') body.tags=parseTags(raw);
      else if(f.key==='addresses') body.addresses=String(raw).split(',').map(s=>s.trim()).filter(Boolean).map(a=>({address:a}));
      else if(f.kind==='number') body[f.key]=Number(raw);
      else body[f.key]=raw;
    });
    body.dry=dry;
    // Branch POST /api/edit/<type>  vs  PATCH /api/edit/<type>/<id> purely on presence of an editId.
    const method=isUpdate?'PATCH':'POST';
    const url=isUpdate?(spec.endpoint+'/'+encodeURIComponent(editId)):spec.endpoint;
    const isRetag=type==='tags';
    const verb=isRetag?'retag':(isUpdate?'update':'create');
    // The network call — shared by the dry-run preview path and the live confirm dialog.
    const doFetch=()=>fetch(url,{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
      .then(async r=>({ok:r.ok,data:await r.json().catch(()=>({}))}))
      .catch(()=>({ok:false,data:{error:'network error'}}));

    // DRY-RUN — unchanged: mutates nothing, renders the preview, no confirm dialog.
    if(dry){
      setBusy(true);setErr(null);setPreview(null);
      doFetch().then(({ok,data})=>{
        setBusy(false);
        const j=data||{};
        if(!ok||j.error||j.ok===false){
          const msg=(j&&j.error)||'request failed';
          setErr(msg);toast('Dry run failed: '+msg,'err');return;
        }
        setPreview(j); toast('Dry run complete','ok');
      });
      return;
    }

    // LIVE — route the real write through the shared confirm→diff→rollback dialog.
    const label=objLabel();
    const past=verb==='retag'?'retagged':verb+'d'; // created / updated / retagged
    confirm({
      verb, resource:type, label,
      summary:[{glyph:verb==='create'?'+':'~', text:verb+' '+spec.label+' '+label}],
      danger:false, rollback:null,
      doneText:spec.label+' '+past, errText:spec.label+' '+verb+' failed',
      run:async()=>{
        const {ok,data}=await doFetch();
        const j=data||{};
        if(!ok||j.error||j.ok===false) return {ok:false,error:(j&&j.error)||'request failed'};
        return {ok:true,data:j};
      },
    }).then(()=>{ setErr(null);setPreview(null); if(!isUpdate) setFields({}); }).catch(()=>{});
  };

  // Delete flow — route through the shared confirm dialog (danger → typed-DELETE gate),
  // then DELETE /api/edit/<type>/<id>, and on success reset back to create mode.
  const del=()=>{
    if(!spec||!editId||busy) return;
    const label=objLabel();
    confirm({
      verb:'delete', resource:type, label,
      summary:[{glyph:'−', text:'delete '+spec.label+' '+label}],
      danger:true, note:'This permanently deletes the resource from the tenant.', rollback:null,
      doneText:spec.label+' deleted', errText:spec.label+' delete failed',
      run:async()=>{
        const {ok,data}=await fetch(spec.endpoint+'/'+encodeURIComponent(editId),{method:'DELETE'})
          .then(async r=>({ok:r.ok,data:await r.json().catch(()=>({}))}))
          .catch(()=>({ok:false,data:{error:'network error'}}));
        const j=data||{};
        if(!ok||j.error||j.ok===false) return {ok:false,error:(j&&j.error)||'delete failed'};
        return {ok:true};
      },
    }).then(()=>{ setEditId(null);setFields({});setPreview(null);setErr(null); }).catch(()=>{});
  };

  const previewBody=preview?(preview.would_create||preview.would_update||preview):null;

  return <div className="page fadein">
    <PageHeader title="Editor" subtitle="Directly edit DNS/DHCP records and objects"/>
    <div className="dly-seg" role="group" aria-label="Editor resource type" style={{marginBottom:'var(--s3)'}}>
      {EDITOR_TYPES.map(t=>
        <button key={t.key} className={'dly-seg-btn'+(type===t.key?' on':'')} onClick={()=>{setType(t.key);setEditId(null);}}>{t.label}</button>)}
    </div>
    <div className="mono" style={{fontSize:'var(--t11)',color:'var(--text-faint)',marginBottom:'var(--s3)'}}>
      Editor-created subnets and address blocks are ad-hoc — unlike Provision, they are not tracked by a site template.
    </div>
    {isViewer?<Astryx.Badge variant="warning" label="Viewer role — read-only"/>:null}
    <div className="grid-2">
          <Panel title={(spec&&spec.label)+(isUpdate?' — Update':' — Create')}>
            <div className="form-col">
              {spec&&spec.fields.map(f=>
                <label key={f.key} className="mono field-lbl">
                  {f.label}{f.required?' *':''}
                  <input className="vault-in" type={f.kind==='number'?'number':'text'}
                    value={fields[f.key]||''} placeholder={f.placeholder||''}
                    onChange={e=>setField(f.key,e.target.value)}/>
                </label>)}
              <label className="check-row">
                <input type="checkbox" checked={dry} onChange={e=>setDry(e.target.checked)}/>
                Dry-run (no changes)
              </label>
              {err?<div className="mono" style={{color:'var(--crit)',fontSize:'var(--t11)'}}>{err}</div>:null}
              <Astryx.Button variant="primary" isDisabled={busy||isViewer} onClick={submit}>
                {busy?'Submitting…':(dry?'Preview':(isUpdate?'Update':'Submit'))}
              </Astryx.Button>
              {canDelete&&!isViewer?<button className="btn" style={{borderColor:'var(--crit)',color:'var(--crit)'}}
                disabled={busy} onClick={del}>Delete {spec.label}</button>:null}
              {isViewer?<div className="mono field-lbl">
                Viewer role is read-only — creating resources requires operator or admin.
              </div>:null}
            </div>
          </Panel>
          {previewBody?<Panel title="Preview">
            <Astryx.Badge variant="warning" label="DRY RUN"/>
            <pre className="mono" style={{fontSize:'var(--t11)',whiteSpace:'pre-wrap',marginTop:'var(--s2)',maxHeight:'420px',overflow:'auto'}}>
              {JSON.stringify(previewBody,null,2)}
            </pre>
          </Panel>:null}
        </div>
  </div>;
}
// ═══ END: EDITOR ═══


/* DriftTab — read-only: pick a site template (+ optional ip_space override),
   POST /api/drift/check, render a status chip + drifts grouped by category.
   No writes, no dry-run toggle, no confirm gate — nothing here mutates. */
/* driftMark — pure presentation helper: classify a drift item into the shared
   glyph-diff vocabulary (+ only-in-template, − only-in-live, ~ changed) from its
   existing message text. No color signal — glyph + text label only, same law as
   diffRows/dt-diff. Derives from the message the backend already sends
   (detect_drift, server.py) — changes no drift logic. */
