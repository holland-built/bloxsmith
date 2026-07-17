function ThemeToggle(){
  const [theme,setTheme]=useState(()=>document.documentElement.dataset.theme||'dark');
  const toggle=()=>{
    const next=theme==='dark'?'light':'dark';
    document.documentElement.dataset.theme=next;
    LS.set('theme',next);
    setTheme(next);
  };
  return <button className="kbd" onClick={toggle}
    aria-label="Toggle color theme" title="Toggle light / dark theme">
    {theme==='dark'?'Light':'Dark'}
  </button>;
}

/* DensityToggle — flips compact/comfortable row height + persists (LS.set('density',…)). */
function DensityToggle(){
  const [d,setD]=useState(()=>document.documentElement.dataset.density||'compact');
  const toggle=()=>{
    const next=d==='compact'?'comfortable':'compact';
    document.documentElement.dataset.density=next;
    LS.set('density',next);
    setD(next);
  };
  return <button className="kbd" onClick={toggle}
    aria-label="Toggle row density" title="Toggle compact / comfortable rows">
    {d==='compact'?'Compact':'Comfort'}
  </button>;
}

/* ProblemsBadge — topbar chip summarizing the network's open problems. Count =
   unacked-critical threats + subnets over 85% util + offline hosts. Crit-tinted
   when >0, hidden at 0. Click navigates to the dominant contributor. */
function ProblemsBadge(){
  const {bind}=useHoverDetail();
  const {data}=useData();
  const sec=useApi('/api/hub/security');
  const acks=LS.get('acks',{});
  const events=(sec.data&&Array.isArray(sec.data.events))?sec.data.events:[];
  const unackedCrit=events.filter(e=>String(e.severity||'').toLowerCase()==='critical'
    &&!acks[String(e.event_time)+'|'+String(e.qname)]).length;
  const hotSubs=((data&&data.subnets)||[]).filter(s=>(Number(s.util)||0)>85).length;
  const offline=((data&&data.hosts)||[]).filter(h=>/^(down|offline)$/i.test(String(h.status||''))).length;
  const total=unackedCrit+hotSubs+offline;
  if(total<=0) return null;
  const go=()=>{ if(unackedCrit>0) nav('security'); else if(hotSubs>0) nav('network'); else nav('infra'); };
  return <button className="problems-badge crit problems-badge--bell" onClick={go}
    {...bind({title:total+' issues need attention',rows:[['Unacked critical',unackedCrit],['Subnets >85% util',hotSubs],['Hosts offline',offline],['Click','Jumps to the biggest contributor']]})}
    aria-label={total+' problems need attention'}>
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{display:'block'}}><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>
    <span className="mono">{total}</span>
  </button>;
}

/* ── HealthStrip (P1/4) — slim, always-visible service-health ribbon under the
   TopBar. One thin line: per-service dot (semantic color) + TEXT status label
   (never color-only) + a tiny sparkline, for DNS / DHCP / IPAM / Security. Each
   segment is a real button that navigates to that service's tab (aria-pressed
   reflects the active tab). Health is derived from the same shared feeds the
   tabs already read (no new heavy fetch beyond the small security hub call). ── */
const HEALTH_TXT={ok:'Operational',warn:'Degraded',crit:'Critical'};
function HealthStrip(){
  const {data}=useData();
  const sec=useApi('/api/hub/security');
  const route=useRoute();
  const d=data||{};
  const subnets=Array.isArray(d.subnets)?d.subnets:[];
  const zones=Array.isArray(d.zones)?d.zones:[];
  const util=s=>Number(s.util)||0;

  // DHCP / IPAM — capacity pressure across subnets (same thresholds Overview uses).
  const bands=[0,0,0,0]; // <70, 70-89, 90-99, 100
  subnets.forEach(s=>{const u=util(s); if(u>=100)bands[3]++; else if(u>=90)bands[2]++; else if(u>=70)bands[1]++; else bands[0]++;});
  const near=subnets.filter(s=>util(s)>=90).length;
  const over85=subnets.filter(s=>util(s)>85).length;
  const tight=subnets.some(s=>util(s)>=95);

  // DNS — zone health (unhealthy = a zone reporting a down/error/critical status).
  const zHealthy=zones.filter(z=>/^(ok|healthy|active|up|)$/i.test(String(z.status||''))).length;
  const zDown=zones.some(z=>/^(down|error|critical|fail)/i.test(String(z.status||'')));
  const zBad=zones.length-zHealthy;

  // Security — threat counts from the hub.
  const sc=(sec.data&&sec.data.counts)||{};
  const crit=Number(sc.critical)||0, high=Number(sc.high)||0, med=Number(sc.medium)||0;

  const lvl=(isCrit,isWarn)=>isCrit?'crit':isWarn?'warn':'ok';
  const col=sev=>'var(--'+(sev==='crit'?'crit':sev==='warn'?'warn':'ok')+')';
  const services=[
    {id:'dns',      label:'DNS',      tab:'dns',      sev:lvl(zDown, zBad>0),           values:[zHealthy, zones.length||0]},
    {id:'dhcp',     label:'DHCP',     tab:'network',  sev:lvl(near>0, over85>0),        values:bands},
    {id:'ipam',     label:'IPAM',     tab:'network',  sev:lvl(tight, over85>0),         values:bands},
    {id:'security', label:'Security', tab:'security', sev:lvl(crit>0, high>0),          values:[crit,high,med]},
  ];

  return <div className="health-strip" role="group" aria-label="Service health">
    <span className="health-strip-label">Service health</span>
    {services.map(s=>{
      const active=route.tab===s.tab;
      return <button key={s.id} type="button" className={'health-seg '+s.sev+(active?' active':'')}
        aria-pressed={active}
        aria-label={s.label+' — '+HEALTH_TXT[s.sev]+'. Open the '+s.label+' section.'}
        onClick={()=>nav(s.tab)}>
        <i className={'health-dot '+s.sev} aria-hidden="true"/>
        <span className="health-svc">{s.label}</span>
        <span className="health-status">{HEALTH_TXT[s.sev]}</span>
        <Sparkline values={s.values} width={40} height={14} color={col(s.sev)}/>
      </button>;
    })}
  </div>;
}

/* ViewOptions — gear-icon popover consolidating the three display toggles (density, theme,
   wallboard) into one control. Open/overlay-click/Escape interaction mirrors ViewsMenu;
   the Wall button calls the module-level enterWall() (global, in scope everywhere). */
function ViewOptions(){
  const [open,setOpen]=useState(false);
  useEffect(()=>{
    if(!open) return;
    const onKey=e=>{ if(e.key==='Escape') setOpen(false); };
    window.addEventListener('keydown',onKey);
    return ()=>window.removeEventListener('keydown',onKey);
  },[open]);
  const {bind}=useHoverDetail();
  return <span className="view-options">
    <button className="kbd" aria-haspopup="menu" aria-expanded={open}
      aria-label="View options"
      {...bind({title:'View options',rows:[['Density','Compact ↔ comfortable rows'],['Theme','Light ↔ dark'],['Wallboard','Full-screen NOC display (#wall)']]})}
      onClick={()=>setOpen(o=>!o)}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{display:'block'}}><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg></button>
    {open&&<>
      <div className="views-overlay" onClick={()=>setOpen(false)}/>
      <div className="view-options-menu" role="menu">
        <DensityToggle/>
        <ThemeToggle/>
        <button className="kbd wall-toggle" onClick={enterWall}
          aria-label="Enter wallboard mode" title="Wallboard — no-chrome NOC display">Wall</button>
      </div>
    </>}
  </span>;
}

/* ── UpdateBadge styles — scoped, tokens only, mirrors view-options/acct-menu
   popover conventions already used in the topbar. ── */
(function injectUpdateStyles(){
  if(document.getElementById('bx-update-styles')) return;
  const s=document.createElement('style');s.id='bx-update-styles';
  s.textContent=`
  .update-slot{position:relative;display:inline-flex;align-items:center;gap:var(--s2);}
  .update-version{color:var(--text-dim);}
  .update-pill{display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 var(--s2);
    font-size:var(--t11);color:var(--accent-text);background:var(--accent-dim);
    border:1px solid var(--accent);border-radius:var(--r-ctl);cursor:pointer;text-decoration:none;white-space:nowrap;}
  .update-pill:hover{border-color:var(--accent-text);}
  .update-dot{width:6px;height:6px;border-radius:50%;background:var(--accent);flex:0 0 auto;}
  .update-menu{position:absolute;top:calc(100% + 6px);right:0;z-index:60;width:240px;
    display:flex;flex-direction:column;gap:var(--s2);padding:var(--s3);
    background:var(--surface);border:1px solid var(--border);border-radius:var(--r-panel);
    box-shadow:0 8px 24px rgba(0,0,0,.4);}
  .update-menu-head{font-size:var(--t12);font-weight:600;color:var(--text);}
  .update-menu-err{font-size:var(--t11);color:var(--crit);}
  .update-menu-link{font-size:var(--t11);color:var(--text-dim);text-decoration:underline;text-underline-offset:2px;}
  .update-menu-status{font-size:var(--t11);color:var(--text-dim);padding:1px 0;}
  .update-progress{display:flex;flex-direction:column;gap:6px;}
  .update-progress-phase{font-size:var(--t12);color:var(--text-dim);}
  .update-progress-bar{height:4px;border-radius:2px;background:var(--raised);overflow:hidden;}
  .update-progress-fill{height:100%;background:var(--accent);transition:width .3s ease;}
  .update-rollback-banner{position:fixed;top:0;left:0;right:0;z-index:150;display:flex;align-items:center;
    justify-content:center;gap:12px;padding:8px 16px;font-size:var(--t12);color:var(--text);
    background:var(--warn-tint);border-bottom:1px solid var(--border-strong);}
  .update-rollback-x{height:22px;padding:0 8px;font-size:var(--t11);color:var(--text-dim);background:transparent;
    border:1px solid var(--border);border-radius:var(--r-ctl);cursor:pointer;}
  `;
  document.head.appendChild(s);
})();

const UPDATE_PHASE_TXT={
  idle:'Preparing…', prepulling:'Downloading update…', pulled:'Downloaded — starting…',
  checking:'Checking new version…', recreating:'Restarting service…',
  live:'Finishing up…', done:'Updated — reloading…', error:'Update failed',
  rolledback:'Update failed — rolled back',
};

/* UpdateBadge — version chip + self-update flow (topbar-right, next to AccountSlot).
   Reuses the `update` object already carried on vault status (fetched once by
   VaultGate) — no second poller for that. Only polls /api/update/status while an
   update is actively applying, and checks /api/update/rollback-status once on
   mount. Feature-detects vault.update so a File-mode/older server (no update key)
   never crashes this. */
function UpdateBadge(){
  const {vault}=useAuth();
  const upd=vault&&vault.update;
  const [open,setOpen]=useState(false);
  const [applying,setApplying]=useState(false);
  const [phase,setPhase]=useState('');
  const [pct,setPct]=useState(0);
  const [err,setErr]=useState('');
  const [rollback,setRollback]=useState(null);
  const pollRef=useRef(null);
  const startIdRef=useRef(null);

  useEffect(()=>{
    fetch('/api/update/rollback-status',{cache:'no-store'}).then(r=>r.json()).then(d=>{
      if(d&&d.rolledback) setRollback(d);
    }).catch(()=>{});
  },[]);

  useEffect(()=>{
    if(!open) return;
    const onKey=e=>{ if(e.key==='Escape'&&!applying) setOpen(false); };
    window.addEventListener('keydown',onKey);
    return ()=>window.removeEventListener('keydown',onKey);
  },[open,applying]);

  useEffect(()=>()=>{ if(pollRef.current) clearInterval(pollRef.current); },[]);

  const stopPoll=()=>{ if(pollRef.current){ clearInterval(pollRef.current); pollRef.current=null; } };

  const startPoll=()=>{
    stopPoll();
    pollRef.current=setInterval(async()=>{
      try{
        const r=await fetch('/api/update/status',{cache:'no-store'});
        const d=await r.json();
        if(d.instance_id&&startIdRef.current&&d.instance_id!==startIdRef.current){
          stopPoll(); setPhase('done');
          setTimeout(()=>window.location.reload(),600);
          return;
        }
        setPhase(d.phase||''); setPct(Number(d.pct)||0);
        if(d.phase==='rolledback'||d.phase==='error'){
          stopPoll(); setApplying(false); setErr(d.error||'Update failed');
        }
      }catch(e){ /* server likely mid-recreate — keep polling silently */ }
    },2000);
  };

  const dismissRollback=async()=>{ setRollback(null); await vpost('/api/update/rollback-clear',{}); };

  const apply=async()=>{
    setErr('');
    const {ok,data}=await vpost('/api/update/apply',{});
    if(!ok||!data||data.ok===false){
      setErr(data&&data.error==='cooldown' ? ('Try again in '+(data.retry_after||0)+'s') : ((data&&data.error)||'Could not start update'));
      return;
    }
    startIdRef.current=upd&&upd.instance_id;
    setApplying(true); setPhase('checking'); setPct(0);
    startPoll();
  };

  const [checking,setChecking]=useState(false);
  const [checkMsg,setCheckMsg]=useState('');
  const [override,setOverride]=useState(null); // fresh /api/update/check result, overrides the once-fetched vault.update
  const checkNow=async()=>{
    setChecking(true); setCheckMsg('');
    try{
      const r=await fetch('/api/update/check',{cache:'no-store'});
      const d=await r.json();
      setOverride(d);
      setCheckMsg(d.available?('Update available → v'+d.latest):'Up to date');
    }catch(e){ setCheckMsg('Check failed — try again'); }
    setChecking(false);
  };
  const doRollback=async()=>{
    setErr('');
    const {ok,data}=await vpost('/api/update/rollback-apply',{});
    if(!ok||!data||data.ok===false){
      setErr((data&&data.error)||'Could not start rollback'); return;
    }
    startIdRef.current=(override||upd).instance_id;
    setApplying(true); setPhase('checking'); setPct(0);
    startPoll();
  };

  if(!upd) return null;
  const {current,latest,available,url,selfUpdate,cooldown,prevVersion}=override||upd;

  return <>
    {rollback&&<div className="update-rollback-banner" role="status">
      <span>Rolled back from v{rollback.rollback_from} to v{rollback.rollback_to} — the update failed a health check.</span>
      <button className="update-rollback-x" onClick={dismissRollback} aria-label="Dismiss rollback notice">✕</button>
    </div>}
    <span className="update-slot">
      <span className="mono update-version" role="button" tabIndex={0} style={{cursor:'pointer'}}
        aria-haspopup="menu" aria-expanded={open} aria-label={'Bloxsmith v'+current+' — updates'}
        onClick={()=>setOpen(o=>!o)}
        onKeyDown={e=>{ if(e.key==='Enter'||e.key===' '){ e.preventDefault(); setOpen(o=>!o); } }}>
        v{current}
      </span>
      {available&&(selfUpdate
        ? <button className="update-pill" aria-haspopup="menu" aria-expanded={open}
            aria-label={'Update available, v'+latest} onClick={()=>setOpen(o=>!o)}>
            <span className="update-dot" aria-hidden="true"/>update available → v{latest}
          </button>
        : <a className="update-pill" href={url} target="_blank" rel="noopener noreferrer"
            aria-label={'Update available, v'+latest+' — opens the GitHub release'}>
            <span className="update-dot" aria-hidden="true"/>update available → v{latest}
          </a>
      )}
      {open&&<>
        <div className="views-overlay" onClick={()=>{ if(!applying) setOpen(false); }}/>
        <div className="update-menu" role="menu">
          <div className="update-menu-head">{available?('Update to v'+latest):('Bloxsmith v'+current)}</div>
          {!applying?(<>
            {err&&<div className="update-menu-err">{err}</div>}
            {checkMsg&&<div className="update-menu-status mono">{checkMsg}</div>}
            {available&&selfUpdate&&<button className="btn" disabled={cooldown>0} onClick={apply}>
              {cooldown>0?('Try again in '+cooldown+'s'):'Update now'}
            </button>}
            <button className="btn" disabled={checking} onClick={checkNow}>
              {checking?'Checking…':'Check now'}
            </button>
            {selfUpdate&&prevVersion&&<button className="btn" disabled={cooldown>0} onClick={doRollback}>
              Rollback to v{prevVersion}
            </button>}
            {url&&available&&<a className="update-menu-link" href={url} target="_blank" rel="noopener noreferrer">View release notes</a>}
          </>):(
            <div className="update-progress">
              <div className="update-progress-phase">{UPDATE_PHASE_TXT[phase]||phase||'Working…'}</div>
              <div className="update-progress-bar"><div className="update-progress-fill" style={{width:Math.max(4,pct)+'%'}}/></div>
              {err&&<div className="update-menu-err">{err}</div>}
            </div>
          )}
        </div>
      </>}
    </span>
  </>;
}

/* MoreMenu — topbar overflow: command palette, Watches/Views (portal target),
   ViewOptions, and UpdateBadge, all consolidated behind one ⋯ trigger. The
   .tools-slot inside stays mounted at all times (display:none when closed)
   because WatchMenu/ViewsMenu resolve their portal target once on mount. */
function MoreMenu({onPalette}){
  const [open,setOpen]=useState(false);
  const rootRef=useRef(null);
  useEffect(()=>{ if(!open) return;
    const onKey=e=>{ if(e.key==='Escape') setOpen(false); };
    const onDown=e=>{ if(rootRef.current && !rootRef.current.contains(e.target)) setOpen(false); };
    window.addEventListener('keydown',onKey);
    document.addEventListener('pointerdown',onDown,true);
    return ()=>{ window.removeEventListener('keydown',onKey); document.removeEventListener('pointerdown',onDown,true); };
  },[open]);
  return <span ref={rootRef} className="more-menu" style={{position:'relative',display:'inline-flex'}}>
    <button className="kbd" aria-haspopup="menu" aria-expanded={open}
      aria-label="More tools — Watches, Views, command palette, display, software update"
      onClick={()=>setOpen(o=>!o)}>⋯</button>
    {/* tools-slot stays mounted ALWAYS (Watches/Views portal into it on mount); just hidden when closed */}
    <div className="more-panel panel" role="menu" style={{display:open?'block':'none'}}>
      <div className="more-row"><button className="kbd" onClick={()=>{onPalette();setOpen(false);}}>Command palette <span className="mono">⌘K</span></button></div>
      <div className="more-row tools-slot"></div>            {/* Watches + Views portal here */}
      <div className="more-row"><ViewOptions/></div>
      <div className="more-row"><UpdateBadge/></div>
    </div>
  </span>;
}

function TopBar({tab,org,fresh,onPalette,onAi,aiOpen}){
  const {orgName}=useAuth();
  const orgLabel=orgName||org;
  const {bind}=useHoverDetail();
  return <header className="topbar">
    <div className="brand">
      <BrandLogo/>
      <span className="brand-name">Bloxsmith</span>
      {orgLabel?<span className="brand-org">{orgLabel}</span>:null}
    </div>
    <nav className="tabbar" aria-label="Sections">
      {TABS.map(t=><button key={t}
        className={'tab'+(t===tab?' active':'')}
        aria-current={t===tab?'page':undefined}
        onClick={()=>nav(t)}
        {...bind({title:TAB_LABELS[t],rows:[['What it does',TAB_DESCRIPTIONS[t]]]})}>{TAB_LABELS[t]}</button>)}
    </nav>
    <div className="topbar-right">
      <span className="tb-group">{fresh}<TimeRangeControl/></span>
      <span className="tb-group"><ProblemsBadge/></span>
      <span className="tb-group"><button className={"kbd ai-trigger ai-trigger--accent"+(aiOpen?" ai-trigger--open":"")} onClick={onAi} aria-label="Open AI assistant" aria-expanded={aiOpen} {...bind({title:'Ask AI  ·  ⌘I',rows:[['What','Natural-language assistant over your live NOC data'],['Shortcut','⌘I / Ctrl-I']]})}><span>Ask AI</span><span className="mono">⌘I</span></button></span>
      <span className="tb-group"><MoreMenu onPalette={onPalette}/></span>
      <span className="tb-group"><AccountSlot/></span>
    </div>
  </header>;
}

