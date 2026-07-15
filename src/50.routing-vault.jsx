const TABS=['overview','daily','network','dns','infra','security','incidents','audit','provision'];
const TAB_LABELS={overview:'Overview',daily:'Daily',network:'Network',dns:'DNS',infra:'Infra',security:'Security',incidents:'Incidents',audit:'Audit',provision:'Provision',drift:'Drift',selfservice:'Self-Service',editor:'Editor'};
// Nav-tab hover descriptions — shown via useHoverDetail() in TopBar. Terse, accurate
// one-liners on what each tab does + how to use it.
const TAB_DESCRIPTIONS={
  overview:'Health snapshot — capacity by site, top consumers, host status, and a worst-first triage queue.',
  daily:'Daily ops digest — AI-generated summary of what changed, hourly lease activity, and open severities.',
  network:'Subnets and DHCP leases — browse, filter, and drill into utilization and lease state.',
  dns:'DNS zones and records — browse zone health, record counts, and lease-state breakdown.',
  infra:'Infrastructure hosts — status, versions, and per-host detail.',
  security:'Threat events from the Hub — severities, acknowledgements, and event detail.',
  incidents:'Correlated incidents — triage queue, SOC actions, and a live anomaly-event stream.',
  audit:'Immutable, hash-chained audit log of every action taken — chain integrity re-verified on every poll.',
  provision:'Provisioning workspace — Provision (carve subnets/sites), Self-Service (allocate addresses), Editor (edit DNS/DHCP objects), and Drift (reconcile config). Per-tool detail lives on the sub-tab bar.',
};
const LEGACY={home:'overview',map:'network',dhcp:'network',ipam:'network',dns:'dns',
  security:'security',assets:'infra',audit:'audit',search:'overview',ask:'overview',hub:'overview',
  summary:'daily',trends:'daily'};

function parseHash(){
  let h=(location.hash||'').replace(/^#/,'');
  if(!h) return {tab:'overview',params:{}};
  const qi=h.indexOf('?');
  let tab=qi>=0?h.slice(0,qi):h;
  const qs=qi>=0?h.slice(qi+1):'';
  const params={};
  if(qs) new URLSearchParams(qs).forEach((v,k)=>{params[k]=v;});
  // Wallboard (NOC-TV) — #wall is a no-chrome overlay route, not a tab. Flag it here
  // (before the legacy remap / TABS filter) so the Shell can swap in the Wallboard.
  // The inner content defaults to the Overview view; params are still carried through.
  if(tab==='wall') return {tab:'overview',params,wall:true};
  // Ask retired to a drawer: detect the old #ask / #search route BEFORE the legacy
  // remap so its query is carried and the drawer opens (params.drawer='1').
  const wantsDrawer=(tab==='ask'||tab==='search');
  if(LEGACY[tab]) tab=LEGACY[tab];
  // Legacy standalone routes for the write-surfaces now live under the Provision
  // group as a ?tool= sub-route. Remap old hashes so deep-links/bookmarks survive.
  const PROVISION_TOOL_ROUTES={selfservice:1,editor:1,drift:1};
  if(PROVISION_TOOL_ROUTES[tab]){ params.tool=tab; tab='provision'; }
  if(!TABS.includes(tab)) tab='overview';
  if(wantsDrawer) params.drawer='1';
  // Legacy deep-link remap: Overview used to hand off util bands as ?band=… ; Phase D moved to
  // ?sq=… (BQL). Translate old links for one release so bookmarks / history survive.
  if(params.band!=null && params.sq==null){
    var BAND2SQ={'100':'util>=100','9099':'util:90-99','7089':'util:70-89','lt70':'util<70','85':'util>=85','7085':'util>=70'};
    if(BAND2SQ[params.band]) params.sq=BAND2SQ[params.band];
    delete params.band;
  }
  return {tab,params};
}
/* nav(tab,params[,replace]) — writes the hash route.
   replace=true swaps the current history entry instead of pushing a new one; use it
   for state MIRRORS (a table serializing its own sort/cols/search into the URL) as
   opposed to real user navigations. Without it, mounting a table spends a history
   entry, so one user action costs two — and Back then only rewinds the mirror,
   leaving the user stuck on the same screen. location.replace() still fires
   hashchange for a hash-only change, so useRoute stays in sync either way. */
function nav(tab,params,replace){
  const t=LEGACY[tab]||tab;
  let h='#'+t;
  if(params&&Object.keys(params).length){
    h+='?'+new URLSearchParams(params).toString();
  }
  if(replace) location.replace(h); else location.hash=h;
}
function useRoute(){
  const [route,setRoute]=useState(parseHash());
  useEffect(()=>{
    const on=()=>setRoute(parseHash());
    window.addEventListener('hashchange',on);
    return ()=>window.removeEventListener('hashchange',on);
  },[]);
  return route;
}

/* 8. Stub — centered dim panel "<name> — building". */
function Stub({name}){
  return <div className="stub">
    <div className="stub-name">{name}</div>
    <div className="stub-sub">Section — building</div>
  </div>;
}

// ═══ REGION: AUTH ═══
/* Vault auth gate + brand/logo system — ported from prior build (index-old.html).
   Logic (API payloads, state transitions, guards) is verbatim; visuals restyled
   with the new dark tokens. Scoped CSS injected once below. */
(function injectAuthStyles(){
  if(document.getElementById('bx-auth-styles')) return;
  const s=document.createElement('style');s.id='bx-auth-styles';
  s.textContent=`
  .vault-screen{position:fixed;inset:0;z-index:200;display:flex;align-items:center;justify-content:center;background:var(--bg);padding:24px;}
  .vault-card{width:360px;max-width:100%;background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:32px;}
  .vault-logo{font-size:14px;font-weight:600;letter-spacing:-.01em;color:var(--text);margin-bottom:20px;}
  .vault-card h1{font-size:16px;font-weight:600;margin:0 0 8px;color:var(--text);}
  .vault-card p{font-size:12px;line-height:1.5;color:var(--text-dim);margin:0 0 16px;}
  .vault-card label{display:block;font-size:11px;color:var(--text-dim);margin:12px 0 4px;}
  .vault-in,.vault-preset{width:100%;height:32px;padding:0 10px;font-size:13px;font-family:inherit;color:var(--text);background:var(--raised);border:1px solid var(--border-input);border-radius:4px;}
  .vault-in:focus,.vault-preset:focus{border-color:var(--accent);}
  .vault-preset{cursor:pointer;}
  .vault-err{margin-top:10px;font-size:12px;color:var(--crit);}
  .vault-btn{width:100%;height:32px;margin-top:16px;font-size:12px;font-weight:500;color:var(--accent-contrast);background:var(--accent);border:1px solid var(--accent);border-radius:4px;cursor:pointer;}
  .vault-btn:disabled{opacity:.5;cursor:default;}
  .vault-cancel{width:100%;height:30px;margin-top:8px;font-size:12px;color:var(--text);background:transparent;border:1px solid var(--border);border-radius:4px;cursor:pointer;}
  .vault-cancel:disabled{opacity:.5;}
  .vault-boot{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:var(--bg);}
  .vault-spinner{width:28px;height:28px;border:2px solid var(--border);border-top-color:var(--accent);border-radius:50%;animation:vspin .7s linear infinite;}
  @keyframes vspin{to{transform:rotate(360deg);}}
  .acct-slot{position:relative;}
  .acct-trigger{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 10px;font-size:12px;font-weight:500;color:var(--text);background:var(--raised);border:1px solid var(--border);border-radius:4px;cursor:pointer;max-width:220px;}
  .acct-trigger:hover{background:var(--hover);border-color:var(--border-strong);}
  .acct-trigger .dot{color:var(--ok);}
  .acct-trigger .nm{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
  .acct-overlay{position:fixed;inset:0;z-index:60;}
  .acct-menu{position:absolute;right:0;top:calc(100% + 6px);z-index:61;width:300px;max-height:72vh;overflow-y:auto;background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:6px;}
  .acct-sec-label{font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:var(--text-faint);padding:6px 8px 4px;}
  .acct-search{width:100%;height:28px;margin:0 0 6px;padding:0 8px;font-size:12px;color:var(--text);background:var(--raised);border:1px solid var(--border);border-radius:4px;}
  .acct-item{display:flex;align-items:center;gap:6px;flex:1;min-width:0;padding:6px 8px;font-size:12px;color:var(--text);background:transparent;border:none;border-radius:4px;text-align:left;cursor:pointer;}
  .acct-item:hover{background:var(--hover);}
  .acct-item.active,.acct-item.nokey{cursor:default;}
  .acct-item.nokey{color:var(--text-faint);}
  .acct-item .nm{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
  .acct-row{display:flex;align-items:center;gap:4px;padding:0 4px;}
  .acct-divider{height:1px;margin:6px 8px;background:var(--border);}
  .acct-notice{padding:8px;font-size:11px;color:var(--text-faint);line-height:1.5;}
  .tenant-mini,.tenant-rm,.tenant-addkey{height:20px;padding:0 6px;font-size:10px;color:var(--text-dim);background:transparent;border:1px solid var(--border);border-radius:4px;cursor:pointer;flex-shrink:0;}
  .tenant-mini:hover,.tenant-addkey:hover{border-color:var(--border-strong);color:var(--text);}
  .tenant-rm:hover{border-color:var(--crit);color:var(--crit);}
  .menu-item{display:block;width:100%;padding:6px 8px;text-align:left;background:transparent;border:none;border-radius:4px;cursor:pointer;}
  .menu-item:hover{background:var(--hover);}
  .menu-item:disabled{opacity:.5;cursor:default;}
  .menu-lbl{display:block;font-size:12px;color:var(--text);}
  .menu-desc{display:block;font-size:10px;color:var(--text-faint);margin-top:1px;}
  .tenant-confirm{display:flex;align-items:center;gap:6px;flex:1;padding:4px 8px;border-radius:4px;background:var(--crit-tint);border:1px solid var(--crit-tint-border);}
  .tenant-confirm-q{flex:1;font-size:11px;color:var(--crit);}
  .tc-yes,.tc-no{height:20px;width:22px;font-size:11px;border:1px solid var(--border);border-radius:4px;background:transparent;color:var(--text);cursor:pointer;flex-shrink:0;}
  .tc-yes:hover{border-color:var(--crit);color:var(--crit);}
  `;
  document.head.appendChild(s);
})();

/* IB_LOGO — Infoblox mark, base64 (verbatim from prior build) */
const IB_LOGO="data:image/png;base64,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";

// Ordered logo sources tried by BrandLogoImg — browser <img> sends Referer so Brandfetch works
function buildLogoSources(domain){
  return [
    '/api/logo',
    `https://cdn.brandfetch.io/${domain}/w/128/h/128`,
    `https://www.google.com/s2/favicons?domain=${domain}&sz=128`,
    `https://icons.duckduckgo.com/ip3/${domain}.ico`,
  ];
}
// BrandLogoImg: tries sources in order via onError waterfall, falls back to IB_LOGO
function BrandLogoImg({domain, fallback, alt, className, style, onClick, title}){
  const sources = domain ? buildLogoSources(domain) : [];
  const [idx, setIdx] = useState(0);
  useEffect(()=>{ setIdx(0); }, [domain]);
  const src = idx < sources.length ? sources[idx] : (fallback||IB_LOGO);
  return <img className={className} src={src} alt={alt||''} style={style}
    title={title} onClick={onClick}
    referrerPolicy="no-referrer-when-downgrade"
    onError={()=>setIdx(i=>i+1)}/>;
}
function downloadLogo(src){
  if(src.startsWith('data:')){
    const a=document.createElement('a');
    a.href=src; a.download='infoblox-logo.png'; a.click();
  } else {
    fetch(src)
      .then(r=>r.blob())
      .then(blob=>{
        const url=URL.createObjectURL(blob);
        const a=document.createElement('a');
        a.href=url; a.download='infoblox-logo.png';
        document.body.appendChild(a); a.click();
        document.body.removeChild(a); URL.revokeObjectURL(url);
      })
      .catch(()=>window.open(src,'_blank'));
  }
}
function extractDomain(url){
  const s=url.trim().replace(/^https?:\/?\/?/i,'').replace(/^www\./i,'').split('/')[0].split('?')[0];
  try{ return new URL('https://'+s).hostname.replace(/^www\./i,''); }
  catch(e){ return s; }
}

/* vpost — POST JSON, always resolves {ok,data} (ported verbatim). */
const vpost=(url,body)=>fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}).then(async r=>({ok:r.ok,data:await r.json().catch(()=>({}))})).catch(()=>({ok:false,error:'network error'}));

/* AuthContext — carries vault status + accounts + brand to TopBar slots. */
const AuthCtx=React.createContext(null);
function useAuth(){ return React.useContext(AuthCtx)||{}; }

function AuthProvider({vault,onVaultChange,children}){
  const [accounts,setAccounts]=useState([]);
  const [activeAcct,setActiveAcct]=useState('');
  const [acctErr,setAcctErr]=useState('');
  const [switchingAcct,setSwitchingAcct]=useState(false);
  const [acctSearch,setAcctSearch]=useState('');
  const [brand,setBrand]=useState(()=>{const d=LS.get('orgDomain','');const n=LS.get('orgName','');return d?{domain:d,name:n}:null;});

  // CSP accounts this key can act in. Error shape: {accounts:[],active:'',error,status}.
  useEffect(()=>{
    fetch('/api/accounts',{cache:'no-store'}).then(r=>r.json()).then(d=>{
      setAccounts(d.accounts||[]);
      setActiveAcct(d.active||'');
      setAcctErr(d.error||'');
    }).catch(()=>{});
  },[]);
  // Brand override from server (only if user hasn't set one locally).
  useEffect(()=>{
    fetch('/api/brand').then(r=>r.ok?r.json():null).then(b=>{
      if(!b||!b.domain) return;
      if(!LS.get('orgDomain','')){ setBrand({domain:b.domain,name:b.name||''}); LS.set('orgDomain',b.domain); LS.set('orgName',b.name||''); }
    }).catch(()=>{});
  },[]);

  const switchAcct=async(id)=>{
    setAcctSearch('');
    if(id===activeAcct) return;
    setSwitchingAcct(true);
    try{
      const r=await fetch('/api/switch-account',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id})});
      const d=await r.json().catch(()=>({}));
      if(r.status===403){ toast('Not allowed to switch to that account'+(d.error?': '+d.error:''),'err'); }
      else if(d.ok){
        setActiveAcct(d.active);
        LS.del('_dc');
        const nm=(accounts.find(a=>a.id===d.active)||{}).name||'account';
        toast('Switched to '+nm,'ok');
        setTimeout(()=>window.location.reload(),350);
      } else {
        toast('Account switch failed'+(d.error?': '+d.error:''),'err');
      }
    }catch{ toast('Account switch failed — server unreachable','err'); }
    setSwitchingAcct(false);
  };

  const saveBrand=(domain,name)=>{
    setBrand({domain,name});
    LS.set('orgDomain',domain); LS.set('orgName',name);
    fetch('/api/brand',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({domain,name})})
      .catch(()=>toast('Failed to save brand settings — server unreachable','err'));
  };

  const activeAcctName=(accounts.find(a=>a.id===activeAcct)||{}).name;
  const orgDomain=(brand&&brand.domain)||'';
  const orgName=(brand&&brand.name)||activeAcctName||'';
  const val={vault,onVaultChange,accounts,activeAcct,acctErr,switchAcct,switchingAcct,
    acctSearch,setAcctSearch,brand,saveBrand,activeAcctName,orgDomain,orgName};
  return <AuthCtx.Provider value={val}>{children}</AuthCtx.Provider>;
}

function VaultSetup({onDone}) {
  const [p1,setP1]=useState(''),[p2,setP2]=useState(''),[err,setErr]=useState(''),[busy,setBusy]=useState(false);
  const go=async()=>{ setErr('');
    if(p1.length<8){setErr('Passphrase must be at least 8 characters.');return;}
    if(p1!==p2){setErr('Passphrases do not match.');return;}
    setBusy(true); const {ok,data}=await vpost('/api/vault/init',{passphrase:p1}); setBusy(false);
    if(ok&&data.ok) onDone(); else setErr(data.error||'Setup failed.');
  };
  return (<div className="vault-screen"><div className="vault-card">
    <div className="vault-logo">Bloxsmith</div>
    <h1>Create your vault</h1>
    <p>Set a passphrase to encrypt your Infoblox tenant keys at rest. It is never stored — you re-enter it after a restart to unlock. There is no recovery if you forget it.</p>
    <label htmlFor="vs-pass">Passphrase</label>
    <input id="vs-pass" className="vault-in" type="password" value={p1} onChange={e=>setP1(e.target.value)} autoFocus/>
    <label htmlFor="vs-confirm">Confirm passphrase</label>
    <input id="vs-confirm" className="vault-in" type="password" value={p2} onChange={e=>setP2(e.target.value)} onKeyDown={e=>{if(e.key==='Enter')go();}}/>
    {err&&<div className="vault-err">{err}</div>}
    <button className="vault-btn" onClick={go} disabled={busy||!p1||!p2}>{busy?'Creating…':'Create vault'}</button>
  </div></div>);
}

function VaultUnlock({onDone}) {
  const [p,setP]=useState(''),[err,setErr]=useState(''),[busy,setBusy]=useState(false);
  const [confirmVaultReset,setConfirmVaultReset]=useState(false);
  const go=async()=>{ if(!p)return; setErr(''); setBusy(true);
    const {ok,data}=await vpost('/api/vault/unlock',{passphrase:p}); setBusy(false);
    if(ok&&data.ok) onDone(); else setErr(data.error||'Unlock failed.');
  };
  return (<div className="vault-screen"><div className="vault-card">
    <div className="vault-logo">Bloxsmith</div>
    <h1>Unlock vault</h1>
    <p>Enter your passphrase to decrypt your saved tenant keys.</p>
    <label htmlFor="vu-pass">Passphrase</label>
    <input id="vu-pass" className="vault-in" type="password" value={p} onChange={e=>setP(e.target.value)} onKeyDown={e=>{if(e.key==='Enter')go();}} autoFocus/>
    {err&&<div className="vault-err">{err}</div>}
    <button className="vault-btn" onClick={go} disabled={busy||!p}>{busy?'Unlocking…':'Unlock'}</button>
    <div style={{textAlign:'center',marginTop:14}}>
      <button style={{background:'none',border:'none',color:'var(--text-faint)',fontSize:11,cursor:'pointer',textDecoration:'underline',textUnderlineOffset:'2px'}}
        onClick={()=>setConfirmVaultReset(true)}>
        Forgot passphrase? Reset vault
      </button>
    </div>
    {confirmVaultReset&&<div style={{marginTop:12,padding:'10px',border:'1px solid var(--crit-tint-border)',borderRadius:4,background:'var(--crit-tint)'}} role="dialog" aria-label="Confirm vault reset">
      <div style={{fontSize:12,fontWeight:600,color:'var(--text)',marginBottom:4}}>Reset vault?</div>
      <div style={{fontSize:11,color:'var(--text-dim)',lineHeight:1.5,marginBottom:8}}>Permanently deletes the vault and all stored keys. No recovery. You will set a new passphrase.</div>
      <div style={{display:'flex',gap:8}}>
        <button className="tc-yes" style={{width:'auto',padding:'0 10px',color:'var(--crit)',borderColor:'var(--crit)'}} onClick={async()=>{setConfirmVaultReset(false);await vpost('/api/vault/reset',{});onDone();}}>Reset vault</button>
        <button className="tc-no" style={{width:'auto',padding:'0 10px'}} autoFocus onClick={()=>setConfirmVaultReset(false)}>Cancel</button>
      </div>
    </div>}
  </div></div>);
}

function VaultAddTenant({onDone, onCancel, first, editId, editLabel}) {
  const isEdit=!!editId;
  const [key,setKey]=useState(''),[label,setLabel]=useState(editLabel||''),[err,setErr]=useState(''),[busy,setBusy]=useState(false),[test,setTest]=useState('');
  const go=async()=>{ if(!key)return; setErr(''); setBusy(true);
    const {ok,data}=isEdit
      ? await vpost('/api/vault/tenant-update',{id:editId,label,key})
      : await vpost('/api/vault/tenant',{label,key});
    setBusy(false);
    if(ok&&data.ok) onDone(); else setErr(data.error||(isEdit?'Could not replace key.':'Could not add connection.'));
  };
  const doTest=async()=>{ if(!key)return; setTest('Testing…');
    const {ok,data}=await vpost('/api/vault/test-key',{key});
    setTest(ok&&data.ok ? ('Key valid'+(data.name?(' — '+data.name):' (no account name)')) : ('Invalid: '+(data.error||'rejected')));
  };
  useEffect(()=>{ if(!onCancel)return; const h=e=>{if(e.key==='Escape')onCancel();}; window.addEventListener('keydown',h); return ()=>window.removeEventListener('keydown',h); },[onCancel]);
  return (<div className="vault-screen" onClick={onCancel?()=>onCancel():undefined}><div className="vault-card" onClick={e=>e.stopPropagation()}>
    <div className="vault-logo">Bloxsmith</div>
    <h1>{isEdit?`Replace key for ${editLabel||'connection'}`:(first?'Add your first connection':'Add a connection')}</h1>
    <p>{isEdit
      ? 'Paste a new Infoblox API key for this connection — e.g. when the old one was rejected or lacks account access. The connection re-names itself from the new key.'
      : 'Paste an Infoblox API key. The key is encrypted in your vault, and the connection is named automatically from its CSP account.'}</p>
    <label htmlFor="vat-key">Infoblox API key</label>
    <input id="vat-key" className="vault-in" type="password" value={key} onChange={e=>{setKey(e.target.value);setTest('');}} onKeyDown={e=>{if(e.key==='Enter')go();}} placeholder="paste token (any format — Token/Bearer prefix optional)" autoFocus/>
    <label htmlFor="vat-name">Name (optional — auto-named from the portal if blank)</label>
    <input id="vat-name" className="vault-in" value={label} onChange={e=>setLabel(e.target.value)} onKeyDown={e=>{if(e.key==='Enter')go();}} placeholder="leave blank to use the CSP account name"/>
    {test&&<div style={{fontSize:11,marginTop:8,color:test.startsWith('Key valid')?'var(--ok)':(test==='Testing…'?'var(--text-dim)':'var(--crit)')}}>{test}</div>}
    {err&&<div className="vault-err">{err}</div>}
    <button className="vault-btn" onClick={go} disabled={busy||!key}>{busy?(isEdit?'Replacing…':'Adding…'):(isEdit?'Replace key':'Add connection')}</button>
    <button className="vault-cancel" onClick={doTest} disabled={!key}>Test key</button>
    {onCancel&&<button className="vault-cancel" onClick={onCancel}>Cancel</button>}
  </div></div>);
}

/* AI/LLM provider settings — provider-agnostic (verbatim preset map). */
const LLM_PRESETS={
  Groq:{base_url:'',model:'qwen/qwen3-32b'},
  'OpenAI (GPT / Codex)':{base_url:'https://api.openai.com/v1',model:'gpt-4o-mini'},
  'Anthropic (Claude)':{base_url:'https://api.anthropic.com/v1/',model:'claude-opus-4-8'},
  'Google (Gemini)':{base_url:'https://generativelanguage.googleapis.com/v1beta/openai/',model:'gemini-2.5-flash'},
  'OpenRouter (any model)':{base_url:'https://openrouter.ai/api/v1',model:'anthropic/claude-opus-4'},
  Mistral:{base_url:'https://api.mistral.ai/v1',model:'mistral-large-latest'},
  DeepSeek:{base_url:'https://api.deepseek.com',model:'deepseek-chat'},
  'xAI (Grok)':{base_url:'https://api.x.ai/v1',model:'grok-2-latest'},
  Perplexity:{base_url:'https://api.perplexity.ai',model:'sonar'},
  'Together.ai':{base_url:'https://api.together.xyz/v1',model:'meta-llama/Llama-3.3-70B-Instruct-Turbo'},
  'Ollama (local)':{base_url:'http://host.docker.internal:11434/v1',model:'llama3.1'},
};
function VaultSettings({llm, onDone, onCancel}) {
  const [key,setKey]=useState(''),[base,setBase]=useState((llm&&llm.base_url)||''),[model,setModel]=useState((llm&&llm.model)||''),[busy,setBusy]=useState(false),[err,setErr]=useState(''),[test,setTest]=useState('');
  const applyPreset=name=>{ const p=LLM_PRESETS[name]; if(p){setBase(p.base_url);setModel(p.model);setTest('');} };
  const go=async()=>{ setErr(''); setBusy(true);
    const {ok,data}=await vpost('/api/vault/llm',{key,base_url:base,model}); setBusy(false);
    if(ok&&data.ok) onDone(); else setErr(data.error||'Could not save.');
  };
  const doTest=async()=>{ setTest('Testing…');
    const {ok,data}=await vpost('/api/vault/llm-test',{key,base_url:base,model});
    setTest(ok&&data.ok ? ('Connection OK — '+(data.model||'default model')) : ('Failed: '+(data.error||'error')));
  };
  useEffect(()=>{ const h=e=>{if(e.key==='Escape')onCancel();}; window.addEventListener('keydown',h); return ()=>window.removeEventListener('keydown',h); },[onCancel]);
  return (<div className="vault-screen" onClick={()=>onCancel()}><div className="vault-card" onClick={e=>e.stopPropagation()}>
    <div className="vault-logo">AI query provider</div>
    <h1>AI / LLM provider</h1>
    <p>Powers the natural-language query box. Works with any OpenAI-compatible provider. The query box uses tool-calling, so pick a provider/model that supports it. Stored encrypted in your vault.</p>
    <label htmlFor="llm-preset">Provider preset</label>
    <select id="llm-preset" className="vault-preset" defaultValue="" onChange={e=>applyPreset(e.target.value)}>
      <option value="" disabled>Choose a preset…</option>
      {Object.keys(LLM_PRESETS).map(n=><option key={n} value={n}>{n}</option>)}
    </select>
    <label htmlFor="llm-key">API key{llm&&llm.hasKey?' (leave blank to keep current)':''}</label>
    <input id="llm-key" className="vault-in" type="password" value={key} onChange={e=>{setKey(e.target.value);setTest('');}} placeholder={llm&&llm.hasKey?'•••••••• (unchanged)':'gsk_… / sk-… / sk-ant-…'}/>
    <label htmlFor="llm-url">Base URL (blank = Groq)</label>
    <input id="llm-url" className="vault-in" value={base} onChange={e=>{setBase(e.target.value);setTest('');}} placeholder="https://api.openai.com/v1"/>
    <label htmlFor="llm-model">Model</label>
    <input id="llm-model" className="vault-in" value={model} onChange={e=>{setModel(e.target.value);setTest('');}} onKeyDown={e=>{if(e.key==='Enter')go();}} placeholder="qwen/qwen3-32b"/>
    {test&&<div style={{fontSize:11,marginTop:8,color:test.startsWith('Connection OK')?'var(--ok)':(test==='Testing…'?'var(--text-dim)':'var(--crit)')}}>{test}</div>}
    {err&&<div className="vault-err">{err}</div>}
    <button className="vault-btn" onClick={go} disabled={busy}>{busy?'Saving…':'Save provider'}</button>
    <button className="vault-cancel" onClick={doTest}>Test connection</button>
    <button className="vault-cancel" onClick={onCancel}>Cancel</button>
  </div></div>);
}

/* BrandEdit — logo/company name wizard (POST /api/brand {domain,name}). */
function BrandEdit({brand, onSave, onCancel}) {
  const [domain,setDomain]=useState((brand&&brand.domain)||'');
  const [name,setName]=useState((brand&&brand.name)||'');
  const dm=extractDomain(domain);
  const save=()=>{ onSave(dm,name); onCancel(); };
  useEffect(()=>{ const h=e=>{if(e.key==='Escape')onCancel();}; window.addEventListener('keydown',h); return ()=>window.removeEventListener('keydown',h); },[onCancel]);
  return (<div className="vault-screen" onClick={()=>onCancel()}><div className="vault-card" onClick={e=>e.stopPropagation()}>
    <div className="vault-logo">Brand</div>
    <h1>Logo &amp; company name</h1>
    <p>Set your company domain to fetch its logo, plus a display name shown in the top bar.</p>
    <label htmlFor="br-domain">Company domain</label>
    <input id="br-domain" className="vault-in" value={domain} onChange={e=>setDomain(e.target.value)} placeholder="infoblox.com"/>
    <label htmlFor="br-name">Display name</label>
    <input id="br-name" className="vault-in" value={name} onChange={e=>setName(e.target.value)} onKeyDown={e=>{if(e.key==='Enter')save();}} placeholder="Acme Corp"/>
    <div style={{display:'flex',alignItems:'center',gap:8,marginTop:12}}>
      <BrandLogoImg domain={dm} fallback={IB_LOGO} alt="logo preview" style={{width:28,height:28,borderRadius:4,objectFit:'contain',background:'var(--logo-chip)',padding:1}}/>
      <span style={{fontSize:11,color:'var(--text-dim)'}}>{dm||'preview'}</span>
    </div>
    <button className="vault-btn" onClick={save}>Save brand</button>
    <button className="vault-cancel" onClick={onCancel}>Cancel</button>
  </div></div>);
}

/* TenantManager — unified account list + vault management (ported logic). */
function TenantManager({onClose}) {
  const {vault,accounts=[],activeAcct,acctErr,switchAcct,switchingAcct,acctSearch='',setAcctSearch,brand,saveBrand}=useAuth();
  const [open,setOpen]=useState(false),[adding,setAdding]=useState(false),[settings,setSettings]=useState(false),[editBrand,setEditBrand]=useState(false);
  const [confirmRm,setConfirmRm]=useState(null);
  const [editTenant,setEditTenant]=useState(null);
  const [testing,setTesting]=useState(false);
  const [locking,setLocking]=useState(false);
  const [refreshingNames,setRefreshingNames]=useState(false);
  const [switchingKey,setSwitchingKey]=useState(null);
  const tenants=vault.tenants||[];
  const active=tenants.find(t=>t.id===vault.active);
  const activeAcctName=(accounts.find(a=>a.id===activeAcct)||{}).name;
  const headline=activeAcctName||(active&&active.label)||(accounts[0]&&accounts[0].name)||'—';
  const allTenants=vault.vaultMode?(vault.tenants||[]):[];
  const unified=accounts.map(a=>{const t=allTenants.find(t=>t.label===a.name);return{name:a.name,accountId:a.id,tenantId:t?t.id:null,hasKey:!!t,isActive:a.id===activeAcct};}).sort((x,y)=>(y.isActive-x.isActive)||(y.hasKey-x.hasKey)||x.name.localeCompare(y.name));
  const filteredAccts=acctSearch?unified.filter(u=>u.name.toLowerCase().includes(acctSearch.toLowerCase())):unified;
  const showAcctSearch=unified.length>6;
  const hasNoKey=filteredAccts.some(u=>!u.hasKey);
  const hasWithKey=filteredAccts.some(u=>u.hasKey);
  const reload=()=>window.location.reload();
  const close=()=>{ setOpen(false); setConfirmRm(null); setAcctSearch&&setAcctSearch(''); };
  const switchAccount=id=>{ close(); switchAcct&&switchAcct(id); };
  const switchKey=async id=>{
    if(id===vault.active){return;}
    setSwitchingKey(id);
    const {ok,data}=await vpost('/api/vault/active',{id});
    if(!ok||!data.ok){ setSwitchingKey(null); toast('Switch failed: '+(data.error||'unknown'),'err'); return; }
    toast('Switching account…','ok');
    reload();
  };
  const remove=async (id,label)=>{ await vpost('/api/vault/tenant-remove',{id}); toast('Removed '+label,'ok'); reload(); };
  const refreshNames=async()=>{ close(); await vpost('/api/vault/refresh-names',{}); window.location.reload(); };
  const testConn=async()=>{ setTesting(true);
    const {ok,data}=await vpost('/api/vault/conn-test',{}); setTesting(false); close();
    toast(ok&&data.ok ? ('Infoblox OK — '+(data.name||'connected')) : ('Infoblox connection failed: '+((data&&data.error)||'unreachable')), ok&&data.ok?'ok':'err');
  };
  if(adding) return <VaultAddTenant onCancel={()=>setAdding(false)} onDone={reload}/>;
  if(editTenant) return <VaultAddTenant editId={editTenant.id} editLabel={editTenant.label} onCancel={()=>setEditTenant(null)} onDone={reload}/>;
  if(settings) return <VaultSettings llm={vault.llm} onCancel={()=>setSettings(false)} onDone={reload}/>;
  if(editBrand) return <BrandEdit brand={brand} onSave={saveBrand} onCancel={()=>setEditBrand(false)}/>;
  return (
    <div className="acct-slot">
      <button className="acct-trigger" title="Switch account or manage vault" aria-label="Switch account or manage vault"
        aria-expanded={open} disabled={switchingAcct} onClick={()=>open?close():setOpen(true)}>
        <span className="dot">{switchingAcct?'⟳':'●'}</span>
        <span className="nm">{headline}</span>
      </button>
      {open&&(<>
        <div className="acct-overlay" onClick={close}/>
        <div className="acct-menu" role="menu">
          <div className="acct-sec-label">Accounts</div>
          {showAcctSearch&&<input className="acct-search" aria-label="Search accounts" autoFocus placeholder="Search accounts…" value={acctSearch} onChange={e=>setAcctSearch&&setAcctSearch(e.target.value)}/>}
          <div style={{maxHeight:200,overflowY:'auto'}}>
            {filteredAccts.filter(u=>u.hasKey).map(u=>(
              <div key={u.accountId} className="acct-row">
                {confirmRm===u.tenantId ? (
                  <div className="tenant-confirm">
                    <span className="tenant-confirm-q">Remove {u.name}?</span>
                    <button className="tc-yes" title="Remove permanently" aria-label="Confirm removal" onClick={()=>remove(u.tenantId,u.name)}>✓</button>
                    <button className="tc-no" title="Keep" aria-label="Cancel removal" onClick={()=>setConfirmRm(null)}>✕</button>
                  </div>
                ) : (<>
                  <button className={'acct-item'+(u.isActive?' active':'')}
                    disabled={u.isActive||!!switchingKey}
                    onClick={()=>u.isActive?undefined:(u.tenantId&&u.tenantId!==vault.active?switchKey(u.tenantId):switchAccount(u.accountId))}>
                    <span>{u.isActive?'● ':(switchingKey===u.tenantId?'⟳ ':'○ ')}</span>
                    <span className="nm">{u.name}</span>
                  </button>
                  {vault.vaultMode&&<>
                    <button className="tenant-mini" title="Replace this key (e.g. if expired)" aria-label="Replace this key" onClick={()=>{setOpen(false);setEditTenant({id:u.tenantId,label:u.name});}}>chg</button>
                    <button className="tenant-rm" title="Remove key" aria-label="Remove key" onClick={()=>setConfirmRm(u.tenantId)}>✕</button>
                  </>}
                </>)}
              </div>
            ))}
            {hasWithKey&&hasNoKey&&<div className="acct-divider"/>}
            {filteredAccts.filter(u=>!u.hasKey).map(u=>(
              <div key={u.accountId} className="acct-row">
                <button className="acct-item nokey" disabled><span className="nm">{'○ '}{u.name}</span></button>
                {vault.vaultMode&&<button className="tenant-addkey" onClick={e=>{e.stopPropagation();setAdding(true);}}>+ key</button>}
              </div>
            ))}
            {accounts.length===0&&<div className="acct-notice">{acctErr?('Accounts unavailable: '+acctErr):'No accounts found for this key.'}</div>}
          </div>
          <div className="acct-divider"/>
          <div className="acct-sec-label">Manage</div>
          <button className="menu-item" onClick={()=>{close();setEditBrand(true);}}>
            <span className="menu-lbl">Brand / logo</span>
            <span className="menu-desc">Company domain &amp; display name</span>
          </button>
          {vault.vaultMode&&vault.unlocked&&(<>
            <button className="menu-item" disabled={testing} onClick={testConn}>
              <span className="menu-lbl">{testing?'Testing…':'Test Infoblox connection'}</span>
              <span className="menu-desc">Verify the active key reaches CSP</span>
            </button>
            {!hasNoKey&&(<button className="menu-item" onClick={()=>{close();setAdding(true);}}>
              <span className="menu-lbl">+ Add key</span>
              <span className="menu-desc">Store another Infoblox login</span>
            </button>)}
            <button className="menu-item" disabled={refreshingNames} onClick={async()=>{setRefreshingNames(true);await refreshNames();setRefreshingNames(false);}}>
              <span className="menu-lbl">{refreshingNames?'Refreshing…':'Refresh names'}</span>
              <span className="menu-desc">Re-fetch account names from CSP</span>
            </button>
            <button className="menu-item" onClick={()=>{close();setSettings(true);}}>
              <span className="menu-lbl">AI provider</span>
              <span className="menu-desc">LLM for the query box (vault-wide)</span>
            </button>
            <button className="menu-item" disabled={locking} onClick={async()=>{setLocking(true);await vpost('/api/vault/lock',{});window.location.reload();}}>
              <span className="menu-lbl">{locking?'Locking…':'Lock vault'}</span>
              <span className="menu-desc">Hide your saved keys behind the passphrase</span>
            </button>
          </>)}
        </div>
      </>)}
    </div>
  );
}

/* VaultGate — decision tree (ported verbatim). Wraps unlocked children in
   AuthProvider so TopBar slots see accounts/brand. Re-checks on bx:vault-locked. */
function VaultGate({children}){
  const [st,setSt]=useState(null);
  const refresh=useCallback(()=>fetch('/api/vault/status',{cache:'no-store'}).then(r=>r.json()).then(setSt).catch(()=>setSt({vaultMode:false})),[]);
  useEffect(()=>{refresh();},[refresh]);
  useEffect(()=>{
    const on=()=>refresh();
    window.addEventListener('bx:vault-locked',on);
    return ()=>window.removeEventListener('bx:vault-locked',on);
  },[refresh]);
  // Mirror the static #root boot-splash exactly, so React's first paint replaces
  // it with an identical frame — no blink/content-jump from splash → bare spinner.
  if(!st) return <div className="boot-splash"><div className="boot-spinner"/><div className="boot-title">Bloxsmith</div><div className="boot-note">Starting up…</div></div>;
  const wrap=kids=><AuthProvider vault={st} onVaultChange={refresh}>{kids}</AuthProvider>;
  if(!st.vaultMode) return wrap(children);
  if(st.ready)      return wrap(children);
  if(!st.exists)    return <VaultSetup onDone={refresh}/>;
  if(!st.unlocked)  return <VaultUnlock onDone={refresh}/>;
  return <VaultAddTenant first onDone={refresh}/>;
}

/* TopBar logo slot — real brand logo, click downloads it. */
function BrandLogo(){
  const {orgDomain}=useAuth();
  return <span className="brand-logo">
    <BrandLogoImg domain={orgDomain} fallback={IB_LOGO} alt="Logo" title="Download logo"
      style={{width:20,height:20,objectFit:'contain',cursor:'pointer'}}
      onClick={e=>downloadLogo(e.currentTarget.src)}/>
  </span>;
}
/* TopBar account slot — account switcher + vault/brand management. */
function AccountSlot(){
  return <TenantManager/>;
}
// ═══ END: AUTH ═══

/* ─────────────────────────────────────────────────────────────
   SHARED SYNTHESIS PRIMITIVES — answer-first band, signed deltas, and a
   day-over-day snapshot store. Consumed by every tab (not a region body).
   ───────────────────────────────────────────────────────────── */

/* Delta — signed mono +N / −N. `good` names the improving direction
   ('up'|'down'); green when v moves that way, red when against, faint at 0. */
