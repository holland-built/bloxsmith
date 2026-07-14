
/* ─────────────────────────────────────────────────────────────
   1. LS — namespaced (bx.) localStorage JSON helper
   ───────────────────────────────────────────────────────────── */
const LS={
  get(key,fallback){
    try{const v=localStorage.getItem('bx.'+key);return v==null?fallback:JSON.parse(v);}
    catch(e){return fallback;}
  },
  set(key,val){
    try{localStorage.setItem('bx.'+key,JSON.stringify(val));}catch(e){}
  },
  del(key){try{localStorage.removeItem('bx.'+key);}catch(e){}},
};

/* Honor the OS reduced-motion setting for JS-driven motion (CSS transitions/animations
   are already killed globally by the @media (prefers-reduced-motion) rule). Used by the
   wallboard auto-rotate so a wall display never animates under reduce. */
function reduceMotion(){ try{return matchMedia('(prefers-reduced-motion:reduce)').matches;}catch(e){return false;} }

/* Wallboard (NOC-TV) mode — a no-chrome, zero-interaction full-screen view reached
   via the #wall hash or the header toggle. _wallReturn remembers where to land on exit. */
let _wallReturn='#overview';
function enterWall(){
  try{ const h=location.hash; _wallReturn=(h&&h!=='#'&&h!=='#wall')?h:'#overview'; }catch(e){ _wallReturn='#overview'; }
  location.hash='#wall';
}
function exitWall(){ let r=_wallReturn||'#overview'; if(!r||r==='#wall'||r==='#') r='#overview'; location.hash=r; }
const WALL_VIEWS=[
  {tab:'overview',label:'Overview'},
  {tab:'network', label:'Network'},
  {tab:'security',label:'Security'},
];

/* downloadCSV — ported verbatim from prior build (helper for DataTable).
   csvRowLine is split out so the per-row copy-as-format menu (the dt-acts
   KebabMenu) can reuse the exact same cell-escaping for a single-row CSV copy. */
function csvRowLine(columns,row){ return columns.map(c=>JSON.stringify(row[c.key]??'')).join(','); }
function downloadCSV(filename, rows, columns){
  const header=columns.map(c=>JSON.stringify(c.label||c.key||c)).join(',');
  const body=rows.map(r=>csvRowLine(columns,r)).join('\n');
  const blob=new Blob([header+'\n'+body],{type:'text/csv'});
  const a=document.createElement('a');
  a.href=URL.createObjectURL(blob);
  a.download=filename;
  a.click();
  URL.revokeObjectURL(a.href);
}
/* Copy-as-format serializers (Feature 6) — one row, four shapes. CSV/JSON reuse the
   same serializers as CSV export / the existing row-JSON copy; BQL-filter and
   Markdown are new but equally pure/testable in isolation. */
function rowAsCSV(columns,row){
  const header=columns.map(c=>JSON.stringify(c.label||c.key)).join(',');
  return header+'\n'+csvRowLine(columns,row);
}
function rowAsBQL(columns,row){
  return columns.filter(c=>c.key&&row[c.key]!=null&&row[c.key]!==''&&typeof row[c.key]!=='object')
    .map(c=>c.key+':'+String(row[c.key])).join(' AND ');
}
function rowAsMarkdown(columns,row){
  return '| '+columns.map(c=>{ const v=row[c.key]; return (v==null?'':String(v)).replace(/\|/g,'\\|'); }).join(' | ')+' |';
}

/* collapseIdentical(rows, sigFn, min=5) — pure helper. Groups rows whose sigFn(row)
   returns a non-null signature into ONE synthetic row when a group has ≥min members:
     {__group:sig, __count:n, __rows:[...], ...representative(first row)}
   Rows with a null/undefined signature pass through untouched, in place. Callers set
   rowKey to handle synthetic keys ('grp:'+__group) and intercept onRowClick when
   r.__group to expand (caller-managed expandedSigs state). Order is preserved by the
   first appearance of each signature. */
function collapseIdentical(rows,sigFn,min){
  const m=(min==null?5:min);
  const list=Array.isArray(rows)?rows:[];
  const groups=new Map();      // sig → [rows]
  const order=[];              // entries: {sig} for a group, or {row} passthrough
  list.forEach(r=>{
    let sig=null; try{ sig=sigFn?sigFn(r):null; }catch(e){ sig=null; }
    if(sig==null||sig===''){ order.push({row:r}); return; }
    sig=String(sig);
    if(!groups.has(sig)){ groups.set(sig,[]); order.push({sig}); }
    groups.get(sig).push(r);
  });
  const out=[];
  order.forEach(o=>{
    if(o.row!==undefined){ out.push(o.row); return; }
    const rws=groups.get(o.sig);
    if(rws.length>=m){ out.push({...rws[0],__group:o.sig,__count:rws.length,__rows:rws}); }
    else rws.forEach(r=>out.push(r));
  });
  return out;
}

/* ─────────────────────────────────────────────────────────────
   Entity-triage cluster (P1 slice 6) — shared plumbing for the
   peek's trace buttons, the pin-to-scratchpad tray, and the
   keyboard macros. All four features key off ONE inferred entity.
   ───────────────────────────────────────────────────────────── */
/* entityOf(row,tableId) → {kind,key,label,pred} | null. Infers what a table row
   represents (subnet / lease / zone / host / event / audit) and the single BQL
   predicate {field,value} that identifies it across DDI planes (the IP is the
   universal join key where present). Pure — used by trace, pin, and macros. */
function entityOf(row,tableId){
  if(!row||typeof row!=='object') return null;
  const tid=String(tableId||'');
  const ip=row.addr||row.ip;
  let kind,field,value;
  if(tid.indexOf('subnet')>=0||(row.cidr!=null&&(row.util!=null||ip!=null))){ kind='subnet'; field='addr'; value=row.addr||row.id; }
  else if(tid.indexOf('lease')>=0||row.mac!=null||(ip!=null&&row.state!=null)){ kind='lease'; field='addr'; value=ip||row.mac; }
  else if(row.fqdn!=null){ kind='zone'; field='fqdn'; value=row.fqdn; }
  else if(tid.indexOf('host')>=0||(row.status!=null&&(row.version!=null||row.name!=null))){ kind='host'; field='host'; value=row.name||row.host||row.hostname; }
  else if(row.qname!=null||row.event_time!=null){ kind='event'; field='qname'; value=row.qname||row.query; }
  else if(row.event!=null&&(row.actor!=null||row.hash!=null)){ kind='audit'; field='actor'; value=row.actor; }
  else { kind='record'; field='id'; value=row.id||ip||row.name; }
  value=value==null?'':String(value);
  return {kind,key:kind+':'+value,label:value||kind,pred:{field,value}};
}
// The cross-tab trace targets: label → destination tab. One-click DDI-plane hops.
const TRACE_TARGETS=[
  {label:'Show in DHCP',tab:'network'},
  {label:'Show in DNS',tab:'dns'},
  {label:'Show in Audit',tab:'audit'},
  {label:'Show in Security',tab:'security'},
];
// traceTo — nav to a plane carrying the entity's BQL predicate in the shared `f=`
// cross-filter param (field:value IS a BQL predicate; every DataTable on the
// destination that owns that column AND-filters to it). Reuses nav — no new route.
function traceTo(tab,ent){ if(!ent||!ent.pred) return; nav(tab,{f:ent.pred.field+':'+ent.pred.value}); }

/* Scratchpad — session pin tray, persisted via the shared LS helper (bx.scratchpad).
   pinEntity/unpinEntity mutate LS + fire a 'bx:scratch' event the <Scratchpad/>
   tray subscribes to (same broadcast pattern as the toast bus). On-demand only —
   the tray/badge render nothing when empty. */
const SCRATCH_KEY='scratchpad';
function scratchList(){ const v=LS.get(SCRATCH_KEY,[]); return Array.isArray(v)?v:[]; }
function pinEntity(ent){
  if(!ent||!ent.key) return false;
  const cur=scratchList();
  if(cur.some(e=>e.key===ent.key)){ toast('Already pinned · '+(ent.label||ent.key),'ok',{duration:1500}); return false; }
  LS.set(SCRATCH_KEY,[...cur,{key:ent.key,kind:ent.kind,label:ent.label,pred:ent.pred,added:Date.now()}]);
  window.dispatchEvent(new CustomEvent('bx:scratch'));
  toast('Pinned · '+(ent.label||ent.key),'ok',{duration:1500});
  return true;
}
function unpinEntity(key){ LS.set(SCRATCH_KEY,scratchList().filter(e=>e.key!==key)); window.dispatchEvent(new CustomEvent('bx:scratch')); }
function clearScratch(){ LS.set(SCRATCH_KEY,[]); window.dispatchEvent(new CustomEvent('bx:scratch')); }

/* ─────────────────────────────────────────────────────────────
   2. useApi — fetch hook with vault-lock handling.
   Locked-handling pattern ported from prior build: a JSON body of
   {locked:true} or {error:'vault locked'}, or HTTP 503, is treated as
   "locked" (NOT an error) and dispatches window 'bx:vault-locked' so
   App can re-check /api/vault/status. Any other non-OK → error string.
   ───────────────────────────────────────────────────────────── */
