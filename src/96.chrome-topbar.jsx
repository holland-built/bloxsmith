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

/* ── UpdateBadge styles — scoped, tokens only. Passive "update available" banner:
   version chip + (when a newer release exists) the OS-relevant update script the
   user double-clicks, with a hover/focus tooltip revealing the two docker commands
   it runs. Mirrors the .script-peek behavior from the update-flow mockup. ── */
(function injectUpdateStyles(){
  if(document.getElementById('bx-update-styles')) return;
  const s=document.createElement('style');s.id='bx-update-styles';
  s.textContent=`
  .update-slot{position:relative;display:flex;flex-direction:column;align-items:flex-start;gap:6px;font-size:var(--t12);}
  .update-version{color:var(--text-dim);}
  .update-dot{width:6px;height:6px;border-radius:50%;background:var(--accent);flex:0 0 auto;}
  .update-avail{display:flex;flex-direction:column;align-items:flex-start;gap:6px;}
  .update-avail-text{display:inline-flex;align-items:center;gap:6px;color:var(--accent-text);}
  .update-avail-text b{font-weight:600;color:var(--accent-text);}
  .update-uptodate{color:var(--text-dim);}
  .update-script{position:relative;display:inline-flex;flex-direction:column;gap:1px;
    padding:6px 10px;background:var(--raised);border:1px solid var(--border);
    border-radius:var(--r-ctl);cursor:help;outline:none;}
  .update-script:hover,.update-script:focus,.update-script:focus-visible{border-color:var(--accent);}
  .update-script-name{font-size:var(--t11);color:var(--accent-text);}
  .update-script-sub{font-size:var(--t11);color:var(--text-dim);}
  .update-peek{position:absolute;bottom:calc(100% + 8px);left:0;z-index:70;min-width:220px;
    display:flex;flex-direction:column;gap:3px;padding:10px 12px;
    background:var(--surface);color:var(--text);border:1px solid var(--border-strong);
    border-radius:var(--r-panel);box-shadow:0 8px 24px rgba(0,0,0,.4);
    opacity:0;visibility:hidden;transform:translateY(4px);pointer-events:none;
    transition:opacity .12s ease,transform .12s ease;}
  .update-script:hover .update-peek,.update-script:focus .update-peek,
  .update-script:focus-within .update-peek{opacity:1;visibility:visible;transform:translateY(0);}
  .update-peek-head{font-size:var(--t11);text-transform:uppercase;letter-spacing:.05em;color:var(--text-dim);margin-bottom:2px;}
  .update-peek-c{color:var(--text-dim);}
  .update-peek-line{font-size:var(--t11);line-height:1.6;white-space:nowrap;color:var(--text);}
  .update-menu-link{font-size:var(--t11);color:var(--text-dim);text-decoration:underline;text-underline-offset:2px;}
  `;
  document.head.appendChild(s);
})();

/* detectUpdateScript — client-side OS sniff → the update script the user double-clicks.
   macOS → update.command, Windows → update.bat, Linux → update.sh (default .command).
   Mirrors the mockup's navigator.userAgentData?.platform || navigator.platform logic. */
function detectUpdateScript(){
  const p=String((navigator.userAgentData&&navigator.userAgentData.platform)||navigator.platform||'').toLowerCase();
  if(p.indexOf('win')===0||p.indexOf('windows')!==-1) return {file:'update.bat',os:'Windows'};
  if(p.indexOf('linux')!==-1||p.indexOf('x11')!==-1) return {file:'update.sh',os:'Linux'};
  if(p.indexOf('mac')!==-1) return {file:'update.command',os:'macOS'};
  return {file:'update.command',os:'macOS'};
}

/* UpdateBadge — passive "update available" banner (renders inside the ⋯ MoreMenu panel).
   The app only SIGNALS: it shows the running version and, when a newer release exists,
   names the OS-relevant update script the user double-clicks (docker compose pull &&
   up -d, revealed on hover/focus) plus a release-notes link. It never applies, polls,
   or rolls back — no /api/update/apply, /status, or /rollback-* calls. Checks once on
   mount via GET /api/update/check; a small "Check now" re-hits the same endpoint. */
function UpdateBadge(){
  const [info,setInfo]=useState(null);      // {current,latest,available,url}
  const [checking,setChecking]=useState(false);
  const check=async()=>{
    setChecking(true);
    try{
      const r=await fetch('/api/update/check',{cache:'no-store'});
      setInfo(await r.json());
    }catch(e){ /* older/File-mode server — stay silent */ }
    setChecking(false);
  };
  useEffect(()=>{ check(); },[]);

  if(!info||info.current==null) return null;
  const {current,latest,available,url}=info;
  const script=detectUpdateScript();

  return <span className="update-slot">
    <span className="mono update-version">Bloxsmith v{current}</span>
    {available
      ? <span className="update-avail">
          <span className="update-avail-text">
            <span className="update-dot" aria-hidden="true"/>Update available → <b>{latest}</b>
          </span>
          <span className="update-script" tabIndex={0} role="button"
            aria-label={'Double-click '+script.file+' to update ('+script.os+'). It runs docker compose pull, then docker compose up -d.'}>
            <span className="update-peek mono" role="tooltip">
              <span className="update-peek-head">what {script.file} runs</span>
              <span className="update-peek-line update-peek-c"># get the new version + restart</span>
              <span className="update-peek-line">docker compose pull</span>
              <span className="update-peek-line">docker compose up -d</span>
            </span>
            <span className="mono update-script-name">{script.file}</span>
            <span className="update-script-sub">{script.os} · double-click to update</span>
          </span>
          {url&&<a className="update-menu-link" href={url} target="_blank" rel="noopener noreferrer">View release notes</a>}
        </span>
      : <span className="update-uptodate">Up to date</span>}
    <button className="kbd" disabled={checking} onClick={check}>
      {checking?'Checking…':'Check now'}
    </button>
  </span>;
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

