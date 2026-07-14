function subseqMatch(needle,hay){
  if(!needle) return false;
  let i=0; for(let j=0;j<hay.length&&i<needle.length;j++){ if(hay[j]===needle[i]) i++; }
  return i===needle.length;
}

/* CommandPalette — ⌘K overlay (Shell owns open state) + topbar ViewsMenu portal. */
function CommandPalette({open,onClose}){
  const power=usePower();
  const {data}=useData();
  const inputRef=useRef(null);
  const [q,setQ]=useState('');
  const [sel,setSel]=useState(0);
  const [views,setViews]=useState([]);
  const [confirmBlock,setConfirmBlock]=useState(null);
  const [blocking,setBlocking]=useState(false);
  const [slot,setSlot]=useState(null);
  // Mount the saved-views dropdown into the topbar without editing Shell.
  useEffect(()=>{setSlot(document.querySelector('.tools-slot'));},[]);
  useEffect(()=>{
    if(!open) return;
    setQ('');setSel(0);setConfirmBlock(null);
    if(inputRef.current) inputRef.current.focus();
    fetch('/api/views').then(r=>r.ok?r.json():null).then(d=>setViews((d&&d.views)||[])).catch(()=>{});
  },[open]);
  useEffect(()=>{setSel(0);},[q]);
  const typed=q.trim();
  const needle=typed.toLowerCase();
  const base=[
    ...TABS.map(t=>({label:'Go to '+TAB_LABELS[t],kind:'nav',run:()=>{nav(t);onClose();}})),
    ...PROVISION_TOOLS.map(t=>({label:'Go to Provision · '+t.label,kind:'nav',
      run:()=>{nav('provision',{tool:t.key});onClose();}})),
    {label:'Ask AI',kind:'ai',run:()=>{onClose();window.dispatchEvent(new CustomEvent('bx:ai-open',{detail:{q:''}}));}},
    {label:'Alert rules',kind:'nav',run:()=>{onClose();window.dispatchEvent(new CustomEvent('bx:ai-open',{detail:{q:''}}));}},
    // F3 — Copy link to this view. The hash already IS the canonical, deep-linkable
    // URL (parseHash/nav, tab + ?params survive reload — see the router above), so
    // this reuses location.href verbatim rather than re-serializing anything, and
    // reuses the F1 toast/aria-live bus for the "Link copied" announcement.
    {label:'Copy link to this view',kind:'action',run:()=>{
      onClose();
      if(navigator.clipboard&&navigator.clipboard.writeText) navigator.clipboard.writeText(location.href);
      toast('Link copied','ok',{duration:1500});
    }},
    ...views.map(v=>({label:'View: '+v.name,kind:'view',run:()=>{onClose();applyViewByName(v.name);}})),
  ];
  // F8a — contextual bulk actions for the active table's selection (or its cursor row as a 1-row selection).
  const ctxItems=[];
  if(open&&power&&power.getActive){
    const entry=power.getActive();
    const api=entry&&entry.api&&entry.api.current;
    if(api&&api.getState){
      const st=api.getState();
      const rowsSel=st.selected&&st.selected.size>0?st.selectedRows:(st.cursorRow?[st.cursorRow]:[]);
      if(rowsSel.length&&st.buildActions){
        st.buildActions(rowsSel).forEach(a=>ctxItems.push({label:a.label+' ('+rowsSel.length+')',kind:'action',
          run:()=>{onClose();try{a.run&&a.run();}catch(e){}}}));
      }
      // F2 — "Export current view": CSV of the active table's full (filtered/sorted) rows.
      if(st.rows&&st.rows.length&&st.columns){
        ctxItems.push({label:'Export current view',kind:'action',
          run:()=>{onClose();downloadCSV(String((entry&&entry.label)||'export')+'.csv',st.rows,st.columns);}});
      }
      // F2 — "Ask AI about selection": seed the AI drawer's initialQ with the selected rows
      // (via the same bx:ai-open handoff the palette's other Ask actions already use).
      if(rowsSel.length){
        ctxItems.push({label:'Ask AI about selection ('+rowsSel.length+')',kind:'action',
          run:()=>{
            onClose();
            const col=(st.columns&&st.columns[0])||{key:Object.keys(rowsSel[0]||{})[0]};
            const names=rowsSel.slice(0,10).map(r=>String((col&&r[col.key])??'')).join(', ');
            const q='Tell me about these '+rowsSel.length+' selected row'+(rowsSel.length===1?'':'s')+': '+names+(rowsSel.length>10?', …':'');
            window.dispatchEvent(new CustomEvent('bx:ai-open',{detail:{q}}));
          }});
      }
      // F6 — time-as-preset: inject last:Nh/last:Nd into the active table's OWN
      // search input (same state F4's typeahead/history already drive). Deliberately
      // NOT a global control — rides the normal query path, no hash/snapshot changes.
      if(typeof api.setFilter==='function'){
        [['Last 1h','last:1h'],['Last 24h','last:24h'],['Last 7d','last:7d']].forEach(([label,token])=>{
          ctxItems.push({label,kind:'action',run:()=>{
            onClose();
            const cur=String(st.filter||'').replace(/(^|\s)-?last:\S+/gi,' ').trim();
            api.setFilter(cur?cur+' '+token:token);
          }});
        });
      }
    }
  }
  const items=[...ctxItems,...base.filter(c=>c.label.toLowerCase().includes(needle))];
  if(typed){
    items.push({label:'Ask: '+typed,kind:'ask',run:()=>{onClose();window.dispatchEvent(new CustomEvent('bx:ai-open',{detail:{q:typed||''}}));}});
    items.push({label:'Block domain: '+typed,kind:'block',run:()=>setConfirmBlock(typed)});
    // F8b — fuzzy go-to jump into subnets / zones / hosts (subsequence match, cap 8).
    const dd=data||{};
    const go=[];
    const add=(label,fn)=>{ if(go.length<8&&label&&subseqMatch(needle,String(label).toLowerCase())) go.push({label:'Go: '+label,kind:'go',run:()=>{onClose();fn();}}); };
    (Array.isArray(dd.subnets)?dd.subnets:[]).forEach(s=>{const l=s.addr||s.name;add(l,()=>nav('network',{peek:s.addr||s.name}));});
    (Array.isArray(dd.zones)?dd.zones:[]).forEach(z=>add(z.fqdn,()=>nav('dns',{peek:z.fqdn})));
    (Array.isArray(dd.hosts)?dd.hosts:[]).forEach(h=>add(h.name,()=>nav('infra',{peek:h.name})));
    go.forEach(g=>items.push(g));
  }
  const runBlock=()=>{
    const domain=confirmBlock;
    if(!domain||blocking) return;
    setBlocking(true);
    fetch('/api/block-domain',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({domain})})
      .then(async r=>{
        const j=await r.json().catch(()=>({}));
        if(r.ok&&j.ok!==false) toast('Blocked '+domain+' network-wide','ok');
        else toast('Block failed: '+((j&&j.error)||('HTTP '+r.status)),'err');
      })
      .catch(()=>toast('Block failed — server unreachable','err'))
      .finally(()=>{setBlocking(false);setConfirmBlock(null);onClose();});
  };
  const onKey=e=>{
    if(e.key==='Escape'){e.preventDefault(); if(confirmBlock) setConfirmBlock(null); else onClose(); return;}
    if(confirmBlock){ if(e.key==='Enter'){e.preventDefault();runBlock();} return; }
    if(e.key==='ArrowDown'){e.preventDefault();setSel(s=>Math.min(s+1,Math.max(items.length-1,0)));}
    else if(e.key==='ArrowUp'){e.preventDefault();setSel(s=>Math.max(s-1,0));}
    else if(e.key==='Enter'){e.preventDefault();const it=items[sel];if(it)it.run();}
  };
  return <>
    {slot?ReactDOM.createPortal(<WatchMenu/>,slot):null}
    {slot?ReactDOM.createPortal(<ViewsMenu/>,slot):null}
    {open&&<div className="palette-scrim" onClick={onClose}>
      <div className="palette" onClick={e=>e.stopPropagation()}>
        <input ref={inputRef} className="palette-in mono" value={q} onChange={e=>setQ(e.target.value)}
          onKeyDown={onKey} placeholder="Type a command, question, or domain…"
          aria-label="Command palette" role="combobox" aria-expanded="true"
          aria-activedescendant={(!confirmBlock&&items.length>0)?('pal-'+sel):undefined}/>
        <div className="panel pal-list" role="listbox" aria-label="Commands">
          {confirmBlock
            ? <div className="pal-confirm">
                <span>Block <span className="mono">{confirmBlock}</span> network-wide?</span>
                <span style={{display:'inline-flex',gap:8}}>
                  <button className="btn" style={{borderColor:'var(--crit)',color:'var(--crit)'}}
                    disabled={blocking} onClick={runBlock}>{blocking?'Blocking…':'Confirm block'}</button>
                  <button className="btn" disabled={blocking} onClick={()=>setConfirmBlock(null)}>Cancel</button>
                </span>
              </div>
            : items.length===0
              ? <div className="pal-empty">No matching commands</div>
              : items.map((it,i)=>
                <button key={it.kind+':'+it.label} id={'pal-'+i} className={'pal-row'+(i===sel?' sel':'')}
                  role="option" aria-selected={i===sel}
                  onMouseEnter={()=>setSel(i)} onClick={()=>it.run()}>
                  <span>{it.label}</span>
                  <span className="pal-kind mono">{it.kind}</span>
                </button>)}
        </div>
      </div>
    </div>}
  </>;
}

/* ViewsMenu — topbar saved-views dropdown (GET/POST/DELETE /api/views). */
function ViewsMenu(){
  const {bind}=useHoverDetail();
  const [open,setOpen]=useState(false);
  const [views,setViews]=useState([]);
  const [err,setErr]=useState('');
  const [confirmDel,setConfirmDel]=useState(null);
  const refresh=useCallback(()=>{
    fetch('/api/views').then(r=>r.ok?r.json():Promise.reject())
      .then(d=>{setViews((d&&d.views)||[]);setErr('');})
      .catch(()=>setErr('Views unavailable'));
  },[]);
  useEffect(()=>{if(open){refresh();setConfirmDel(null);}},[open,refresh]);
  const saveCurrent=()=>{
    const name=window.prompt('Save current view as:');
    if(!name||!name.trim()) return;
    saveCurrentView(name.trim())
      .then(res=>{
        if(res.ok){toast('View "'+name.trim()+'" saved','ok');refresh();}
        else toast('Save failed: '+(res.error||'unknown error'),'err');
      })
      .catch(()=>toast('Save failed — server unreachable','err'));
  };
  const del=name=>{
    fetch('/api/views/'+encodeURIComponent(name),{method:'DELETE'})
      .then(r=>{ if(r.ok){toast('Deleted "'+name+'"','ok');refresh();} else toast('Delete failed','err'); })
      .catch(()=>toast('Delete failed — server unreachable','err'))
      .finally(()=>setConfirmDel(null));
  };
  const folders=[...new Set(views.map(v=>(v.folder||'').trim()))]
    .sort((a,b)=>{if(!a)return 1;if(!b)return -1;return a.localeCompare(b);});
  return <span className="views-slot">
    <button className="btn" aria-haspopup="menu" aria-expanded={open}
      {...bind({title:'Saved views',rows:[['What','Named snapshots of your filters & layout'],['Add','"Save current…" inside this menu']]})} onClick={()=>setOpen(o=>!o)}>Views</button>
    {open&&<>
      <div className="views-overlay" onClick={()=>setOpen(false)}/>
      <div className="dt-popover views-menu" role="menu">
        <button className="views-item" onClick={()=>{setOpen(false);saveCurrent();}}>Save current…</button>
        <div className="views-divider"/>
        {err&&<div className="views-empty">{err}</div>}
        {!err&&views.length===0&&<div className="views-empty">No saved views</div>}
        {folders.map(f=><div key={f||'(ungrouped)'}>
          {(f||folders.length>1)?<div className="views-folder">{f||'Ungrouped'}</div>:null}
          {views.filter(v=>((v.folder||'').trim())===f).map(v=>
            <div key={v.name} className="views-row">
              {confirmDel===v.name
                ? <>
                    <span className="views-confirm-q">Delete {v.name}?</span>
                    <button className="views-mini crit" onClick={()=>del(v.name)}>delete</button>
                    <button className="views-mini" onClick={()=>setConfirmDel(null)}>keep</button>
                  </>
                : <>
                    <button className="views-item" style={{flex:1}}
                      onClick={()=>{setOpen(false);applyViewByName(v.name);}}>
                      <span className="vname">{v.name}</span>
                      {v.saved_at?<span className="views-date mono">{String(v.saved_at).slice(0,10)}</span>:null}
                    </button>
                    <button className="views-mini crit" aria-label={'Delete view '+v.name}
                      onClick={()=>setConfirmDel(v.name)}>✕</button>
                  </>}
            </div>)}
        </div>)}
      </div>
    </>}
  </span>;
}

/* WatchMenu — topbar saved-query dropdown. Mirrors ViewsMenu's markup/interaction
   (reuses .views-* classes) but is 100% client-side: watches live in bx.watches
   LS and each row shows a LIVE match count against the shared /api/data feed.
   "Watch current query…" saves whatever BQL query is in the current tab's sq=
   hash param; clicking a watch re-applies it via nav (the same sq= surface). */
function WatchMenu(){
  const {bind}=useHoverDetail();
  const [open,setOpen]=useState(false);
  const [watches,setWatches]=useState(()=>readWatches());
  const {data}=useData();
  const {tab,params}=useRoute();
  const curQuery=((params&&params.sq)||'').trim();
  // Shared KebabMenu/AbMenu menu behaviour: first item focused on open, ↑/↓
  // roves, Esc closes and returns focus to the trigger.
  const btnRef=useRef(null),menuRef=useRef(null);
  const close=()=>{ setOpen(false); if(btnRef.current) btnRef.current.focus(); };
  useEffect(()=>{ if(!open||!menuRef.current) return;
    const f=menuRef.current.querySelector('button:not(:disabled)'); if(f) f.focus(); },[open]);
  const move=delta=>{ const b=menuRef.current?Array.from(menuRef.current.querySelectorAll('button:not(:disabled)')):[];
    if(!b.length) return; let i=b.indexOf(document.activeElement); i=(i+delta+b.length)%b.length; b[i].focus(); };
  useEffect(()=>{
    const on=()=>setWatches(readWatches());
    window.addEventListener('bx:watches',on);
    return ()=>window.removeEventListener('bx:watches',on);
  },[]);
  const save=()=>{
    if(!curQuery){ toast('No active query to watch — search a table first','warn'); return; }
    const name=window.prompt('Save current query as a watch:',curQuery);
    if(!name||!name.trim()) return;
    addWatch({name:name.trim(),tab,query:curQuery,created:Date.now()});
    setWatches(readWatches());
    toast('Watch "'+name.trim()+'" saved','ok');
  };
  const apply=w=>{ setOpen(false); nav(w.tab,{sq:w.query}); toast('Watch "'+w.name+'" applied','ok'); };
  const del=name=>{ removeWatch(name); setWatches(readWatches()); };
  return <span className="views-slot watch-slot">
    <button ref={btnRef} className="btn" aria-haspopup="menu" aria-expanded={open}
      aria-label={'Watches'+(watches.length?', '+watches.length+' saved':'')}
      {...bind({title:'Watches',rows:[['What','Saved searches with a live match count'],['Add','Search a table, then save the query']]})} onClick={()=>setOpen(o=>!o)}>
      Watches{watches.length?<span className="watch-badge mono" aria-hidden="true">{watches.length}</span>:null}
    </button>
    {open&&<>
      <div className="views-overlay" onClick={close}/>
      <div ref={menuRef} className="dt-popover views-menu" role="menu" aria-label="Watches"
        onKeyDown={e=>{ if(e.key==='Escape'){ e.preventDefault(); e.stopPropagation(); close(); }
          else if(e.key==='ArrowDown'){ e.preventDefault(); move(1); }
          else if(e.key==='ArrowUp'){ e.preventDefault(); move(-1); } }}>
        <button className="views-item" role="menuitem" onClick={()=>save()}>Watch current query…</button>
        <div className="views-divider"/>
        {watches.length===0&&<div className="views-empty">No watches yet — search a table, then save the query.</div>}
        {watches.map(w=>{
          const n=watchCount(data,w);
          return <div key={w.name} className="views-row watch-row">
            <button className="views-item watch-item" role="menuitem" style={{flex:1}} onClick={()=>apply(w)}>
              <span className="vname">{w.name}</span>
              <span className="watch-count mono" aria-label={n+' matching row'+(n===1?'':'s')}>{n}</span>
            </button>
            <button className="views-mini crit" role="menuitem" aria-label={'Delete watch '+w.name}
              onClick={()=>del(w.name)}>✕</button>
          </div>;
        })}
      </div>
    </>}
  </span>;
}
// ═══ END: ASKGLOBAL ═══

const PROVISION_TOOLS=[
  {key:'provision',  label:'Provision',    comp:ProvisionTab,   desc:'Carve a new subnet from available address space — pick a parent block + prefix, or provision a full templated site.'},
  {key:'selfservice',label:'Self-Service', comp:SelfServiceTab, desc:'Grab the next free address (or a batch) from a subnet or tag match, and optionally create its DNS record in one step.'},
  {key:'editor',     label:'Editor',       comp:EditorTab,      desc:'Directly create or edit DNS/DHCP objects — zones, subnets, blocks, ranges, hosts, and tags.'},
  {key:'drift',      label:'Drift',        comp:DriftTab,       desc:'Compare running DHCP/DNS config to its source-of-truth template; review + reconcile differences.'},
];
// ProvisionGroupTab — one top-level tab that hosts the four write-surfaces as a
// .dly-seg sub-tab bar. Active tool comes from ?tool= (default 'provision').
function ProvisionGroupTab(props){
  const {params}=useRoute();
  const {bind}=useHoverDetail();
  const found=PROVISION_TOOLS.find(t=>t.key===params.tool);
  const active=found?found.key:'provision';
  const Active=(found||PROVISION_TOOLS[0]).comp;
  return <div className="page fadein">
    <div className="dly-seg" role="group" aria-label="Provisioning tools"
         style={{marginBottom:'var(--s3)'}}>
      {PROVISION_TOOLS.map(t=>
        <button key={t.key} className={'dly-seg-btn'+(t.key===active?' on':'')}
          aria-current={t.key===active?'page':undefined}
          onClick={()=>nav('provision',{tool:t.key})}
          {...bind({title:t.label,rows:[['What it does',t.desc]]})}>{t.label}</button>)}
    </div>
    <Active {...props}/>
  </div>;
}

const TAB_COMPONENTS={
  overview:OverviewTab,
  daily:DailyTab,
  network:NetworkTab,
  dns:DnsTab,
  infra:InfraTab,
  security:SecurityTab,
  incidents:IncidentsTab,
  audit:AuditTab,
  provision:ProvisionGroupTab,
};

/* ─────────────────────────────────────────────────────────────
   7. Top bar + Shell.
   ───────────────────────────────────────────────────────────── */
/* ThemeToggle — flips document theme + persists. Text label only (no glyphs). */
