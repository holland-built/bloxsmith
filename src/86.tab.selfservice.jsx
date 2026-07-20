const RTYPE_OPTIONS=['A','AAAA','CNAME','MX','TXT','SRV','PTR','NS','CAA','DNAME'];
const RTYPE_HINTS={
  A:'192.0.2.10',
  AAAA:'2001:db8::10',
  CNAME:'target.example.com.',
  MX:'10 mail.example.com.',
  TXT:'"some text"',
  SRV:'10 0 443 host.example.com.',
  PTR:'host.example.com.',
  NS:'ns1.example.com.',
  CAA:'0 issue "letsencrypt.org"',
  DNAME:'target.example.com.',
};

/* MARRIS_EXAMPLES — inline illustrative templates + sample data so the
   provisioning tabs (Provision / Drift / Self-Service) teach themselves
   instead of opening empty. Grounded in Chris Marris's UDDI automation /
   self-service toolkit schemas + the Universal DDI API guide. These are
   PREFILL / SAMPLE-RENDER only: the UI loads them with one click and NEVER
   auto-submits or calls a real API. Clearly labeled "Example" in the UI. */
const MARRIS_EXAMPLES={
  provision:{
    // Full-site template — london / EMEA / production, 3 subnets + DNS + hosts.
    site:{
      site:'london', region:'EMEA', environment:'production',
      subnets:[
        {role:'mgmt',   cidr:24, dhcp:false},
        {role:'lan',    cidr:24, dhcp:true, dhcp_range:{start_offset:10, end_offset:250}},
        {role:'server', cidr:24, dhcp:false},
      ],
      dns:{ parent_zone:'internal.example.com', hosts:['gw01','dns01'] },
      tags:{ Owner:'neteng', CostCentre:'CC-1000' },
    },
    // Prefill for the (editable) Subnet-mode form — a single LAN subnet from the
    // london site. Space/Block stay user-picked (they are live IDs); the plain
    // fields below are illustrative and safe to seed.
    subnetForm:{ cidr:24, name:'london-lan', comment:'EMEA / production — LAN subnet (example)', makeZone:true },
    // Regional address-block pool — Global /8 → region×env /16 children.
    addressBlock:{
      global:'10.0.0.0/8',
      children:[
        {region:'AMER', environment:'prod', cidr:16, address:'10.10.0.0'},
        {region:'AMER', environment:'dev',  cidr:16, address:'10.11.0.0'},
        {region:'EMEA', environment:'prod', cidr:16, address:'10.20.0.0'},
        {region:'EMEA', environment:'dev',  cidr:16, address:'10.21.0.0'},
        {region:'APAC', environment:'prod', cidr:16, address:'10.30.0.0'},
        {region:'APAC', environment:'dev',  cidr:16, address:'10.31.0.0'},
      ],
      tags:{ Region:'<region>', Environment:'<env>', Status:'available' },
    },
    // DNS zone example — corp.example.com with A / CNAME / MX records.
    dns:{
      zone:'corp.example.com',
      records:[
        {name:'www', type:'A',     value:'10.20.0.10'},
        {name:'app', type:'CNAME', value:'www.corp.example.com.'},
        {name:'@',   type:'MX',    value:'10 mail.corp.example.com.'},
      ],
    },
  },
  // Worked "template vs live" drift result — some in-sync, one changed, one missing.
  drift:{
    site:'london',
    items:[
      {mark:'=', label:'in sync',  message:"Subnet 'mgmt' 10.20.0.0/24 matches the template"},
      {mark:'=', label:'in sync',  message:"Zone 'internal.example.com' matches the template"},
      {mark:'~', label:'changed',  message:"Tag 'Owner': expected 'neteng', live value is 'unknown'"},
      {mark:'−', label:'missing',  message:"Host 'dns01' is in the template but not live"},
    ],
  },
  // Self-service prefills — next-free allocate by tag + a DNS record create.
  selfservice:{
    allocate:{ tagKey:'environment', tagValue:'prod', count:1, name:'example-app-01',
               note:'next-free /24 host from environment=prod' },
    dns:{ zone:'corp.example.com', name:'example-web', type:'A', value:'10.20.0.42' },
  },
};

/* MarrisExampleDiff — sample-render of MARRIS_EXAMPLES.drift in the shared
   dt-diff glyph vocabulary (=/~/− etc), monochrome + text label per glyph
   (no color-only), wrapped in a clearly-labeled .marris-example callout. */
function MarrisExampleDiff(){
  const ex=MARRIS_EXAMPLES.drift;
  return <div className="marris-example">
    <div className="mx-head">
      <span className="mx-tag">Example</span>
      <span className="mono" style={{fontSize:'var(--t12)',color:'var(--text-dim)'}}>
        {ex.site} — illustrative drift result, not real data
      </span>
    </div>
    <table className="dt"><tbody>
      {ex.items.map((d,i)=><tr key={i}>
        <td className="dt-diff mono"><span aria-label={d.label} title={d.label}>{d.mark}</span></td>
        <td className="mono" style={{fontSize:'var(--t12)'}}>{d.message}</td>
      </tr>)}
    </tbody></table>
  </div>;
}

/* SelfServiceTab — 4-mode self-service surface (mirrors ProvisionTab's
   mode-switch pattern):
   - Allocate: original self-service IP allocation form (unchanged), POSTs
     /api/selfservice/allocate (subnet_id OR tag_key/tag_value + count + name,
     optional dns block). Dry-run defaults ON.
   - DNS Records: full CRUD against /api/dns/records for a chosen zone.
   - IP Manager: subnet availability + allocated-address release.
   - Inventory: read-only cascading drilldown (space→subnet→addresses,
     zone→records). No write buttons.
   All hooks run unconditionally above the locked-gate so switching modes
   never violates hooks-before-return. */
function SelfServiceTab(){
  const {locked}=useData();
  const {bind}=useHoverDetail();
  const {confirm}=useCommit();
  const zonesApi=useApi('/api/dns/zones');
  const [mode,setMode]=useState('allocate'); // 'allocate' | 'dns' | 'ipman' | 'inventory'

  // Allocate mode (unchanged).
  const [subnetId,setSubnetId]=useState('');
  const [tagKey,setTagKey]=useState('');
  const [tagValue,setTagValue]=useState('');
  const [count,setCount]=useState(1);
  const [name,setName]=useState('');
  const [dnsOn,setDnsOn]=useState(false);
  const [zoneId,setZoneId]=useState('');
  const [recName,setRecName]=useState('');
  const [recType,setRecType]=useState('A');
  const [recValue,setRecValue]=useState('');
  const [dry,setDry]=useState(true);
  const [busy,setBusy]=useState(false);
  const [result,setResult]=useState(null);
  const [err,setErr]=useState(null);
  const [ssExample,setSsExample]=useState(false); // show the allocate example note after "Try example"

  // DNS Records mode.
  const [dnsZoneId,setDnsZoneId]=useState('');
  const recordsApi=useApi(dnsZoneId?('/api/dns/records?zone='+encodeURIComponent(dnsZoneId)):null);
  const [addName,setAddName]=useState('');
  const [addType,setAddType]=useState('A');
  const [addValue,setAddValue]=useState('');
  const [addTtl,setAddTtl]=useState('');
  const [addComment,setAddComment]=useState('');
  const [addBusy,setAddBusy]=useState(false);
  const [addErr,setAddErr]=useState(null);
  const [editingId,setEditingId]=useState(null);
  const [editValue,setEditValue]=useState('');
  const [editTtl,setEditTtl]=useState('');
  const [editComment,setEditComment]=useState('');
  const [editDisabled,setEditDisabled]=useState(false);
  const [editBusy,setEditBusy]=useState(false);
  const [deletingId,setDeletingId]=useState(null);

  // IP Manager + Inventory share the space list.
  const spacesApi=useApi('/api/ipam/spaces');

  // IP Manager mode.
  const [ipSpace,setIpSpace]=useState('');
  const [ipBlock,setIpBlock]=useState('');
  const ipBlocksApi=useApi(ipSpace?('/api/ipam/blocks?space='+encodeURIComponent(ipSpace)):null);
  const [ipSubnetId,setIpSubnetId]=useState('');
  const ipSubnetsApi=useApi(ipSpace?('/api/ipam/subnets?space='+encodeURIComponent(ipSpace)+(ipBlock?('&block='+encodeURIComponent(ipBlock)):'')):null);
  const availApi=useApi(ipSubnetId?('/api/ipam/availability?subnet='+encodeURIComponent(ipSubnetId)):null);
  const addrApi=useApi(ipSubnetId?('/api/ipam/addresses?subnet='+encodeURIComponent(ipSubnetId)):null);
  const [releasingId,setReleasingId]=useState(null);

  // Inventory mode (read-only) — its own drilldown state, independent of IP Manager.
  const [invSpace,setInvSpace]=useState('');
  const [invBlock,setInvBlock]=useState('');
  const invBlocksApi=useApi(invSpace?('/api/ipam/blocks?space='+encodeURIComponent(invSpace)):null);
  const [invSubnetId,setInvSubnetId]=useState('');
  const invSubnetsApi=useApi(invSpace?('/api/ipam/subnets?space='+encodeURIComponent(invSpace)+(invBlock?('&block='+encodeURIComponent(invBlock)):'')):null);
  const invAddrApi=useApi(invSubnetId?('/api/ipam/addresses?subnet='+encodeURIComponent(invSubnetId)):null);
  const [invZoneId,setInvZoneId]=useState('');
  const invRecordsApi=useApi(invZoneId?('/api/dns/records?zone='+encodeURIComponent(invZoneId)):null);

  if(locked) return null;

  const zones=(zonesApi.data&&zonesApi.data.zones)||[];
  const spaces=(spacesApi.data&&spacesApi.data.spaces)||[];
  const records=Array.isArray(recordsApi.data)?recordsApi.data:[];
  const ipBlocks=(ipBlocksApi.data&&ipBlocksApi.data.blocks)||[];
  const ipSubnets=Array.isArray(ipSubnetsApi.data)?ipSubnetsApi.data:[];
  const availability=availApi.data||null;
  const addresses=Array.isArray(addrApi.data)?addrApi.data:[];
  const invBlocks=(invBlocksApi.data&&invBlocksApi.data.blocks)||[];
  const invSubnets=Array.isArray(invSubnetsApi.data)?invSubnetsApi.data:[];
  const invAddresses=Array.isArray(invAddrApi.data)?invAddrApi.data:[];
  const invRecords=Array.isArray(invRecordsApi.data)?invRecordsApi.data:[];

  const addRecord=()=>{
    if(!dnsZoneId||addBusy) return;
    const body={zone_id:dnsZoneId,name_in_zone:addName,type:addType,value:addValue};
    if(addTtl!=='') body.ttl=Number(addTtl);
    if(addComment) body.comment=addComment;
    const nm=addName||'@';
    confirm({
      verb:'create', resource:'DNS record', label:nm+' '+addType,
      summary:[{glyph:'+', text:'create '+addType+' record '+nm}],
      danger:false, rollback:null, doneText:'Record added', errText:'Add record failed',
      run:()=>{
        setAddBusy(true);setAddErr(null);
        return fetch('/api/dns/records',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
          .then(async r=>{
            const j=await r.json().catch(()=>({}));
            setAddBusy(false);
            if(!r.ok||j.error||j.ok===false){
              const msg=(j&&j.error)||('HTTP '+r.status);
              setAddErr(msg);return {ok:false,error:msg};
            }
            setAddName('');setAddValue('');setAddTtl('');setAddComment('');setAddErr(null);
            recordsApi.refetch();
            return {ok:true};
          })
          .catch(e=>{setAddBusy(false);const msg=String((e&&e.message)||e);setAddErr(msg);return {ok:false,error:msg};});
      },
    }).catch(()=>{});
  };

  const startEdit=(r)=>{
    setEditingId(r.id);setEditValue(r.dns_rdata||'');
    setEditTtl(r.ttl!=null?String(r.ttl):'');setEditComment(r.comment||'');setEditDisabled(!!r.disabled);
  };
  const cancelEdit=()=>setEditingId(null);
  const saveEdit=()=>{
    if(editBusy||editingId==null) return;
    const rec=records.find(r=>r.id===editingId);
    const nm=(rec&&rec.name_in_zone)||'@';
    const body={id:editingId,value:editValue,comment:editComment,disabled:editDisabled};
    body.ttl=editTtl!==''?Number(editTtl):undefined;
    confirm({
      verb:'update', resource:'DNS record', label:nm,
      summary:[{glyph:'~', text:'update record '+nm}],
      danger:false, rollback:null, doneText:'Record updated', errText:'Edit failed',
      run:()=>{
        setEditBusy(true);
        return fetch('/api/dns/records',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
          .then(async r=>{
            const j=await r.json().catch(()=>({}));
            setEditBusy(false);
            if(!r.ok||j.error||j.ok===false){
              const msg=(j&&j.error)||('HTTP '+r.status);
              return {ok:false,error:msg};
            }
            setEditingId(null);recordsApi.refetch();
            return {ok:true};
          })
          .catch(e=>{setEditBusy(false);return {ok:false,error:String((e&&e.message)||e)};});
      },
    }).catch(()=>{});
  };
  const deleteRecord=(r)=>{
    const nm=r.name_in_zone||'@';
    const rdata=r.dns_rdata||'';
    confirm({
      verb:'delete', resource:'DNS record', label:nm,
      summary:[{glyph:'−', text:'delete '+(r.type||'')+' record '+nm+' → '+rdata}],
      danger:true, note:'This permanently removes the record from the tenant.',
      rollback:null, doneText:'Record deleted', errText:'Delete failed',
      run:()=>{
        setDeletingId(r.id);
        return fetch('/api/dns/records/'+encodeURIComponent(r.id),{method:'DELETE'})
          .then(async resp=>{
            const j=await resp.json().catch(()=>({}));
            setDeletingId(null);
            if(!resp.ok||j.error||j.ok===false){
              const msg=(j&&j.error)||('HTTP '+resp.status);
              return {ok:false,error:msg};
            }
            recordsApi.refetch();
            return {ok:true};
          })
          .catch(e=>{setDeletingId(null);return {ok:false,error:String((e&&e.message)||e)};});
      },
    }).catch(()=>{});
  };

  const recordCols=[
    {key:'name_in_zone',label:'Name',primary:true,render:v=>v||'@'},
    {key:'type',label:'Type',mono:true},
    {key:'ttl',label:'TTL',mono:true,align:'right',render:(v,r)=>r.id===editingId
      ?<input className="vault-in" style={{width:70}} type="number" min="0" value={editTtl} onChange={e=>setEditTtl(e.target.value)}/>
      :v},
    {key:'dns_rdata',label:'Value',mono:true,render:(v,r)=>r.id===editingId
      ?<input className="vault-in" value={editValue} onChange={e=>setEditValue(e.target.value)}/>
      :(v||'—')},
    {key:'comment',label:'Comment',render:(v,r)=>r.id===editingId
      ?<input className="vault-in" value={editComment} onChange={e=>setEditComment(e.target.value)}/>
      :(v||'—')},
    {key:'disabled',label:'Disabled',render:(v,r)=>r.id===editingId
      ?<input type="checkbox" checked={editDisabled} onChange={e=>setEditDisabled(e.target.checked)}/>
      :(v?'yes':'no')},
    {key:'actions',label:'',width:150,render:(_,r)=>r.id===editingId
      ?<span style={{display:'flex',gap:6}}>
          <button className="btn" disabled={editBusy} onClick={saveEdit}>{editBusy?'Saving…':'Save'}</button>
          <button className="btn" disabled={editBusy} onClick={cancelEdit}>Cancel</button>
        </span>
      :<span style={{display:'flex',gap:6}}>
          <button className="btn" onClick={()=>startEdit(r)} {...bind({title:'Edit record',rows:[['What it does','Modify this record in place — change its value, TTL, comment, or disable it.']]})}>Edit</button>
          <button className="btn" disabled={deletingId===r.id} onClick={()=>deleteRecord(r)} {...bind({title:'Delete record',rows:[['What it does','Permanently remove this DNS record from the zone.']]})}>{deletingId===r.id?'Deleting…':'Delete'}</button>
        </span>},
  ];

  const releaseAddress=(r)=>{
    const addr=r.address||r.name||r.id;
    confirm({
      verb:'release', resource:'IP address', label:addr,
      summary:[{glyph:'−', text:'release '+addr}],
      danger:true, rollback:null, doneText:'Address released', errText:'Release failed',
      run:()=>{
        setReleasingId(r.id);
        return fetch('/api/ipam/addresses/'+encodeURIComponent(r.id),{method:'DELETE'})
          .then(async resp=>{
            let j=null;try{j=await resp.json();}catch(e){j=null;}
            setReleasingId(null);
            if(!resp.ok||(j&&j.error)||(j&&j.ok===false)){
              const msg=(j&&j.error)||('HTTP '+resp.status);
              return {ok:false,error:msg};
            }
            addrApi.refetch();availApi.refetch();
            return {ok:true};
          })
          .catch(e=>{setReleasingId(null);return {ok:false,error:String((e&&e.message)||e)};});
      },
    }).catch(()=>{});
  };

  const addrCols=[
    {key:'address',label:'Address',mono:true,primary:true},
    {key:'name',label:'Name',render:v=>v||'—'},
    {key:'comment',label:'Comment',render:v=>v||'—'},
    {key:'state',label:'State',render:v=>StateText(v)},
    {key:'actions',label:'',width:150,render:(_,r)=>
      <button className="btn" disabled={releasingId===r.id} onClick={()=>releaseAddress(r)} {...bind({title:'Release address',rows:[['What it does','Return this address to the free pool so it can be allocated again.']]})}>{releasingId===r.id?'Releasing…':'Release'}</button>},
  ];

  const invAddrCols=[
    {key:'address',label:'Address',mono:true,primary:true},
    {key:'name',label:'Name',render:v=>v||'—'},
    {key:'comment',label:'Comment',render:v=>v||'—'},
    {key:'state',label:'State',render:v=>StateText(v)},
  ];
  const invRecordCols=[
    {key:'name_in_zone',label:'Name',primary:true,render:v=>v||'@'},
    {key:'type',label:'Type',mono:true},
    {key:'ttl',label:'TTL',mono:true,align:'right'},
    {key:'dns_rdata',label:'Value',mono:true,render:v=>v||'—'},
    {key:'comment',label:'Comment',render:v=>v||'—'},
    {key:'disabled',label:'Disabled',render:v=>v?'yes':'no'},
  ];
  const subnetLabel=s=>(s.address||'')+(s.cidr?('/'+s.cidr):'')+(s.name?(' — '+s.name):'');

  const submit=()=>{
    const body={
      count:Number(count)||1,
      name,
      dry,
    };
    if(subnetId) body.subnet_id=subnetId;
    if(tagKey) body.tag_key=tagKey;
    if(tagValue) body.tag_value=tagValue;
    if(dnsOn) body.dns={zone_id:zoneId,name:recName,type:recType,value:recValue};
    // Fetch + panel state; no toast — caller (dry path) or the commit dialog (live path) toasts.
    const doPost=()=>{
      setBusy(true);setErr(null);setResult(null);
      return fetch('/api/selfservice/allocate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
        .then(async r=>{
          const j=await r.json().catch(()=>({}));
          setBusy(false);
          if(!r.ok||j.ok===false){
            const msg=(j&&j.error)||('HTTP '+r.status);
            setErr(msg);return {ok:false,error:msg};
          }
          setResult(j);
          return {ok:true,data:j};
        })
        .catch(e=>{setBusy(false);const msg=String((e&&e.message)||e);setErr(msg);return {ok:false,error:msg};});
    };
    if(dry){
      doPost().then(res=>{res.ok?toast('Dry run complete','ok'):toast('Allocation failed: '+res.error,'err');});
      return;
    }
    confirm({
      verb:'allocate', resource:'IP address', label:name,
      summary:[{glyph:'+', text:'allocate '+(Number(count)||1)+' address(es)'+(dnsOn?' + DNS record':'')}],
      danger:false, rollback:null, doneText:'Allocation complete', errText:'Allocation failed',
      run:doPost,
    }).catch(()=>{});
  };

  // Example prefill (secondary, kebab): seeds the allocate form with illustrative
  // values — next-free /24 host from environment=prod. Prefill only, never submits.
  const loadAllocateExample=()=>{
    const ex=MARRIS_EXAMPLES.selfservice.allocate;
    setSubnetId('');setTagKey(ex.tagKey);setTagValue(ex.tagValue);
    setCount(ex.count);setName(ex.name);setDnsOn(false);setResult(null);setErr(null);setSsExample(true);
    toast('Example loaded — review, nothing submitted','ok',{duration:1800});
  };
  const resetAllocate=()=>{
    setSubnetId('');setTagKey('');setTagValue('');setCount(1);setName('');setDnsOn(false);
    setZoneId('');setRecName('');setRecType('A');setRecValue('');setResult(null);setErr(null);setSsExample(false);
  };

  return <div className="page fadein">
    <PageHeader title="Self-Service" subtitle="Requests users have queued for address space"/>
    <div className="dly-seg" role="group" aria-label="Self-service mode" style={{marginBottom:'var(--s3)'}}>
      <button className={'dly-seg-btn'+(mode==='allocate'?' on':'')} onClick={()=>setMode('allocate')}
        {...bind({title:'Allocate',rows:[['What it does','Grab the next free address (or addresses) from a subnet — or from whatever subnet matches a tag — and optionally create a DNS record in one step.']]})}>Allocate</button>
      <button className={'dly-seg-btn'+(mode==='dns'?' on':'')} onClick={()=>setMode('dns')}
        {...bind({title:'DNS Records',rows:[['What it does','Create, edit, or delete individual DNS records (A/AAAA/CNAME/MX/TXT/PTR/SRV) inside a chosen zone.']]})}>DNS Records</button>
      <button className={'dly-seg-btn'+(mode==='ipman'?' on':'')} onClick={()=>setMode('ipman')}
        {...bind({title:'IP Manager',rows:[['What it does','See how full a subnet is, and release addresses you no longer need back to the free pool.']]})}>IP Manager</button>
      <button className={'dly-seg-btn'+(mode==='inventory'?' on':'')} onClick={()=>setMode('inventory')}
        {...bind({title:'Inventory',rows:[['What it does','Read-only drilldown: browse IP spaces → blocks → subnets → addresses, and DNS zones → records. Nothing is changed.']]})}>Inventory</button>
    </div>
    {mode==='allocate'?<div className="grid">
      <Panel title="Request">
        <div className="form-col">
          <label className="mono field-lbl"
            {...bind({title:'Subnet ID',rows:[['What it does','Allocate from this exact subnet. Leave blank to instead find a subnet by tag (key/value below).']]})}>
            Subnet ID (or leave blank and use tag key/value below)
            <input className="vault-in" value={subnetId} onChange={e=>setSubnetId(e.target.value)} placeholder="subnet id"/>
          </label>
          <label className="mono field-lbl"
            {...bind({title:'Tag key',rows:[['What it does','Find a subnet by a tag name instead of an ID — e.g. region, environment, or status. Pairs with Tag value below.']]})}>
            Tag key
            <input className="vault-in" value={tagKey} onChange={e=>setTagKey(e.target.value)} placeholder="env"/>
          </label>
          <label className="mono field-lbl"
            {...bind({title:'Tag value',rows:[['What it does','The value that tag must equal — e.g. prod. The next free address is taken from the first subnet whose tag matches.']]})}>
            Tag value
            <input className="vault-in" value={tagValue} onChange={e=>setTagValue(e.target.value)} placeholder="prod"/>
          </label>
          <label className="mono field-lbl"
            {...bind({title:'Count',rows:[['What it does','How many next-available addresses to allocate in this one request.']]})}>
            Count
            <input className="vault-in" type="number" min="1" value={count} onChange={e=>setCount(e.target.value)}/>
          </label>
          <label className="mono field-lbl"
            {...bind({title:'Name',rows:[['What it does','Label recorded on the allocation — who requested it or what it is for (the Owner).']]})}>
            Name
            <input className="vault-in" value={name} onChange={e=>setName(e.target.value)} placeholder="requester / purpose"/>
          </label>
          <label className="check-row"
            {...bind({title:'Create DNS record',rows:[['What it does','Also create a DNS record pointing at the address you just allocated, in the same step.']]})}>
            <input type="checkbox" checked={dnsOn} onChange={e=>setDnsOn(e.target.checked)}/>
            <span>Create DNS record</span>
          </label>
          {dnsOn?<div style={{display:'flex',flexDirection:'column',gap:'var(--s3)',paddingLeft:'var(--s4)'}}>
            <label className="mono field-lbl"
              {...bind({title:'DNS zone',rows:[['What it does','The forward zone the new record is created in.']]})}>
              Zone
              <select className="vault-in" value={zoneId} onChange={e=>setZoneId(e.target.value)}>
                <option value="">{zonesApi.loading?'Loading zones…':'Select a zone'}</option>
                {zones.map(z=><option key={z.id} value={z.id}>{z.fqdn}</option>)}
              </select>
            </label>
            <label className="mono field-lbl"
              {...bind({title:'Record name',rows:[['What it does','Host label within the zone — e.g. "web" becomes web.your-zone.']]})}>
              Record name
              <input className="vault-in" value={recName} onChange={e=>setRecName(e.target.value)} placeholder="host"/>
            </label>
            <label className="mono field-lbl"
              {...bind({title:'Record type',rows:[['A','name → IPv4 address'],['AAAA','name → IPv6 address'],['CNAME','alias → another name'],['TXT','free text (SPF, verification)']]})}>
              Type
              <select className="vault-in" value={recType} onChange={e=>setRecType(e.target.value)}>
                <option value="A">A</option>
                <option value="AAAA">AAAA</option>
                <option value="CNAME">CNAME</option>
                <option value="TXT">TXT</option>
              </select>
            </label>
            <label className="mono field-lbl"
              {...bind({title:'Record value',rows:[['What it does','What the record points to. Leave blank and it auto-fills with the IP just allocated.']]})}>
              Value
              <input className="vault-in" value={recValue} onChange={e=>setRecValue(e.target.value)} placeholder="auto-fills from allocated IP if blank"/>
            </label>
          </div>:null}
          <label className="check-row"
            {...bind({title:'Dry-run',rows:[['What it does','Preview every step and make NO changes. Turn this off to actually allocate.']]})}>
            <input type="checkbox" checked={dry} onChange={e=>setDry(e.target.checked)}/>
            <span>Dry-run (no changes made)</span>
          </label>
          <div style={{display:'flex',alignItems:'center',gap:'var(--s2)'}}>
            <button className="btn" disabled={busy||!name} onClick={submit}
              {...bind({title:'Submit request',rows:[['What it does','Run the allocation — or, with Dry-run on, just preview it.']]})}>{busy?'Submitting…':'Submit'}</button>
            <KebabMenu label="More allocate actions" items={[
              {label:'Try example', run:loadAllocateExample},
              {label:'Reset form', run:resetAllocate},
            ]}/>
          </div>
          {ssExample?<div className="marris-example">
            <div className="mx-head"><span className="mx-tag">Example</span>
              <span className="mono" style={{fontSize:'var(--t12)',color:'var(--text-dim)'}}>prefilled — nothing submitted</span></div>
            <pre className="mx-body mono">{MARRIS_EXAMPLES.selfservice.allocate.note}
{'\n'}allocate: environment=prod · count 1 · name example-app-01</pre>
          </div>:null}
        </div>
      </Panel>
      {result?<Panel title="Result">
        <div className="mono" style={{fontSize:'var(--t12)'}}>
          {(result.addresses||[]).length} address{(result.addresses||[]).length===1?'':'es'} allocated{result.dry?' (dry run)':''}
        </div>
        <div style={{marginTop:'var(--s2)',display:'flex',flexDirection:'column',gap:2}}>
          {(result.addresses||[]).map((a,i)=><div key={i} className="mono" style={{fontSize:'var(--t12)'}}>{typeof a==='string'?a:JSON.stringify(a)}</div>)}
        </div>
        {result.record?<div className="mono" style={{marginTop:'var(--s3)',fontSize:'var(--t12)',color:'var(--text-dim)'}}>
          Record: {JSON.stringify(result.record)}
        </div>:null}
      </Panel>:null}
      {err?<Panel title="Error"><div className="mono" style={{color:'var(--crit)'}}>{err}</div></Panel>:null}
    </div>:null}
    {mode==='dns'?<div className="grid">
      <Panel title="Zone">
        <div className="form-col">
          <label className="mono field-lbl"
            {...bind({title:'DNS zone',rows:[['What it does','Pick the zone whose records you want to view and edit in the table below.']]})}>
            Zone
            <select className="vault-in" value={dnsZoneId} onChange={e=>setDnsZoneId(e.target.value)}>
              <option value="">{zonesApi.loading?'Loading zones…':'Select a zone'}</option>
              {zones.map(z=><option key={z.id} value={z.id}>{z.fqdn}</option>)}
            </select>
          </label>
        </div>
      </Panel>
      {dnsZoneId?<Panel title="Add record">
        <div className="form-col">
          <label className="mono field-lbl"
            {...bind({title:'Record name',rows:[['What it does','Host label within the zone; leave blank for the zone apex (@).']]})}>
            Name
            <input className="vault-in" value={addName} onChange={e=>setAddName(e.target.value)} placeholder="host (blank = @)"/>
          </label>
          <label className="mono field-lbl"
            {...bind({title:'Record type',rows:[['A / AAAA','name → IPv4 / IPv6 address'],['CNAME','alias to another name'],['MX','mail exchanger for the domain'],['TXT','free text (SPF, verification)'],['PTR','reverse lookup: IP → name'],['SRV','service location (host + port)']]})}>
            Type
            <select className="vault-in" value={addType} onChange={e=>setAddType(e.target.value)}>
              {RTYPE_OPTIONS.map(t=><option key={t} value={t}>{t}</option>)}
            </select>
          </label>
          <label className="mono field-lbl"
            {...bind({title:'Record value',rows:[['What it does','What this record points to; the exact format depends on the type above.']]})}>
            Value
            <input className="vault-in" value={addValue} onChange={e=>setAddValue(e.target.value)} placeholder={RTYPE_HINTS[addType]||'value'}/>
          </label>
          <label className="mono field-lbl"
            {...bind({title:'TTL (seconds)',rows:[['What it does','How long resolvers may cache this record. Blank uses the zone default.']]})}>
            TTL (optional)
            <input className="vault-in" type="number" min="0" value={addTtl} onChange={e=>setAddTtl(e.target.value)} placeholder="default"/>
          </label>
          <label className="mono field-lbl"
            {...bind({title:'Comment',rows:[['What it does','Optional free-text note stored alongside the record.']]})}>
            Comment (optional)
            <input className="vault-in" value={addComment} onChange={e=>setAddComment(e.target.value)}/>
          </label>
          <button className="btn" disabled={addBusy||!addValue} onClick={addRecord}
            {...bind({title:'Add record',rows:[['What it does','Create this record in the selected zone.']]})}>{addBusy?'Adding…':'Add record'}</button>
          {addErr?<div className="mono" style={{fontSize:'var(--t11)',color:'var(--crit)'}}>{addErr}</div>:null}
        </div>
      </Panel>:null}
      <Panel title="Records" api={dnsZoneId?recordsApi:undefined}>
        {!dnsZoneId?<div className="dt-empty">Select a zone</div>
          :recordsApi.loading?<Skeleton rows={3}/>
          :records.length===0?<div className="dt-empty">No records</div>
          :<DataTable tableId="ss-dns-records" rowKey={r=>r.id} cols={recordCols} rows={records}
              defaultSort={{key:'name_in_zone',dir:'asc'}} filterable filterKeys={['name_in_zone','type','dns_rdata']}
              searchSchema={{fields:{ttl:{type:'number'}},aliases:{name:'name_in_zone',value:'dns_rdata'}}}/>}
      </Panel>
    </div>:null}
    {mode==='ipman'?<div className="grid">
      <Panel title="Subnet">
        <div className="form-col">
          <label className="mono field-lbl"
            {...bind({title:'IP space',rows:[['What it does','The top-level Infoblox address container to work inside.']]})}>
            Space
            <select className="vault-in" value={ipSpace} onChange={e=>{setIpSpace(e.target.value);setIpBlock('');setIpSubnetId('');}}>
              <option value="">{spacesApi.loading?'Loading spaces…':'Select a space'}</option>
              {spaces.map(sp=><option key={sp.id} value={sp.id}>{sp.name}</option>)}
            </select>
          </label>
          <label className="mono field-lbl"
            {...bind({title:'Address block',rows:[['What it does','Narrow to one block (a large CIDR range) within the space. Optional — leave as All blocks.']]})}>
            Block (optional)
            <select className="vault-in" value={ipBlock} onChange={e=>{setIpBlock(e.target.value);setIpSubnetId('');}} disabled={!ipSpace}>
              <option value="">{ipBlocksApi.loading?'Loading blocks…':'All blocks'}</option>
              {ipBlocks.map(b=><option key={b.id} value={b.id}>{b.name||b.cidr||b.address}</option>)}
            </select>
          </label>
          <label className="mono field-lbl"
            {...bind({title:'Subnet',rows:[['What it does','The subnet whose usage and allocated addresses you want to inspect and manage.']]})}>
            Subnet
            <select className="vault-in" value={ipSubnetId} onChange={e=>setIpSubnetId(e.target.value)} disabled={!ipSpace}>
              <option value="">{ipSubnetsApi.loading?'Loading subnets…':'Select a subnet'}</option>
              {ipSubnets.map(s=><option key={s.id} value={s.id}>{subnetLabel(s)}</option>)}
            </select>
          </label>
        </div>
      </Panel>
      {ipSubnetId?<Panel title="Availability" api={availApi}>
        {availability?<div style={{display:'flex',flexDirection:'column',gap:'var(--s2)'}}>
            {UtilBar(availability.pct)}
            <div className="mono" style={{fontSize:'var(--t12)',color:'var(--text-dim)'}}>
              {availability.used ?? 0} used · {availability.free ?? 0} free · {availability.total ?? 0} total
            </div>
          </div>
          :<div className="dt-empty">{availApi.loading?'Loading…':'No data'}</div>}
      </Panel>:null}
      <Panel title="Addresses" api={ipSubnetId?addrApi:undefined}>
        {!ipSubnetId?<div className="dt-empty">Select a subnet</div>
          :addrApi.loading?<Skeleton rows={3}/>
          :addresses.length===0?<div className="dt-empty">No allocated addresses</div>
          :<DataTable tableId="ss-ip-addresses" rowKey={r=>r.id} cols={addrCols} rows={addresses}
              defaultSort={{key:'address',dir:'asc'}} filterable filterKeys={['address','name','comment']}/>}
      </Panel>
    </div>:null}
    {mode==='inventory'?<div className="grid">
      <Panel title="Space / Block / Subnet">
        <div className="form-col">
          <label className="mono field-lbl"
            {...bind({title:'IP space',rows:[['What it does','Start the read-only drilldown here: the Infoblox address container to browse.']]})}>
            Space
            <select className="vault-in" value={invSpace} onChange={e=>{setInvSpace(e.target.value);setInvBlock('');setInvSubnetId('');}}>
              <option value="">{spacesApi.loading?'Loading spaces…':'Select a space'}</option>
              {spaces.map(sp=><option key={sp.id} value={sp.id}>{sp.name}</option>)}
            </select>
          </label>
          <label className="mono field-lbl"
            {...bind({title:'Address block',rows:[['What it does','Narrow the drilldown to one block within the space. Optional.']]})}>
            Block (optional)
            <select className="vault-in" value={invBlock} onChange={e=>{setInvBlock(e.target.value);setInvSubnetId('');}} disabled={!invSpace}>
              <option value="">{invBlocksApi.loading?'Loading blocks…':'All blocks'}</option>
              {invBlocks.map(b=><option key={b.id} value={b.id}>{b.name||b.cidr||b.address}</option>)}
            </select>
          </label>
          <label className="mono field-lbl"
            {...bind({title:'Subnet',rows:[['What it does','Pick a subnet to list its addresses (read-only) on the right.']]})}>
            Subnet
            <select className="vault-in" value={invSubnetId} onChange={e=>setInvSubnetId(e.target.value)} disabled={!invSpace}>
              <option value="">{invSubnetsApi.loading?'Loading subnets…':'Select a subnet'}</option>
              {invSubnets.map(s=><option key={s.id} value={s.id}>{subnetLabel(s)}</option>)}
            </select>
          </label>
        </div>
      </Panel>
      <Panel title="Addresses" api={invSubnetId?invAddrApi:undefined}>
        {!invSubnetId?<div className="dt-empty">Select a subnet</div>
          :invAddrApi.loading?<Skeleton rows={3}/>
          :invAddresses.length===0?<div className="dt-empty">No addresses</div>
          :<DataTable tableId="ss-inv-addresses" rowKey={r=>r.id} cols={invAddrCols} rows={invAddresses}
              defaultSort={{key:'address',dir:'asc'}} filterable filterKeys={['address','name','comment']}/>}
      </Panel>
      <Panel title="Zone">
        <div className="form-col">
          <label className="mono field-lbl"
            {...bind({title:'DNS zone',rows:[['What it does','Browse this zone\'s DNS records read-only (DNS view → zone → records).']]})}>
            Zone
            <select className="vault-in" value={invZoneId} onChange={e=>setInvZoneId(e.target.value)}>
              <option value="">{zonesApi.loading?'Loading zones…':'Select a zone'}</option>
              {zones.map(z=><option key={z.id} value={z.id}>{z.fqdn}</option>)}
            </select>
          </label>
        </div>
      </Panel>
      <Panel title="Records" api={invZoneId?invRecordsApi:undefined}>
        {!invZoneId?<div className="dt-empty">Select a zone</div>
          :invRecordsApi.loading?<Skeleton rows={3}/>
          :invRecords.length===0?<div className="dt-empty">No records</div>
          :<DataTable tableId="ss-inv-records" rowKey={r=>r.id} cols={invRecordCols} rows={invRecords}
              defaultSort={{key:'name_in_zone',dir:'asc'}} filterable filterKeys={['name_in_zone','type','dns_rdata']}
              searchSchema={{fields:{ttl:{type:'number'}},aliases:{name:'name_in_zone',value:'dns_rdata'}}}/>}
      </Panel>
    </div>:null}
  </div>;
}

/* ProvisionTab — 3-mode provisioning surface: Subnet (original deep-linkable
   wizard, unchanged), Full site (template-driven site provision), Seed demo
   (one-click multi-region demo data seed). All three modes stream over SSE
   using the same EventSource-in-a-ref lifecycle: closed on {done}/{error} AND
   on unmount cleanup, and start() refuses to open a second stream while one
   is live. Each mode owns its own ref/log/streaming state so switching modes
   never fights over a single stream. */
