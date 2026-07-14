function AbMenu({label,items}){
  const [open,setOpen]=useState(false);
  const btnRef=useRef(null),menuRef=useRef(null);
  const close=()=>{ setOpen(false); if(btnRef.current) btnRef.current.focus(); };
  useEffect(()=>{ if(!open||!menuRef.current) return;
    const f=menuRef.current.querySelector('button:not(:disabled)'); if(f) f.focus(); },[open]);
  const move=delta=>{ const b=menuRef.current?Array.from(menuRef.current.querySelectorAll('button:not(:disabled)')):[];
    if(!b.length) return; let i=b.indexOf(document.activeElement); i=(i+delta+b.length)%b.length; b[i].focus(); };
  return <span className="ab-menu-wrap" style={{position:'relative',display:'inline-flex'}}>
    <button ref={btnRef} type="button" className="btn" aria-haspopup="true" aria-expanded={open}
      aria-label={label} onClick={()=>setOpen(v=>!v)}>{label}<span aria-hidden="true"> ▾</span></button>
    {open?<><div className="views-overlay" onClick={close}/>
      <div ref={menuRef} className="panel dt-popover dt-copyas-menu ab-menu" role="menu" aria-label={label}
        onClick={e=>e.stopPropagation()}
        onKeyDown={e=>{ if(e.key==='Escape'){ e.preventDefault(); e.stopPropagation(); close(); }
          else if(e.key==='ArrowDown'){ e.preventDefault(); move(1); }
          else if(e.key==='ArrowUp'){ e.preventDefault(); move(-1); } }}>
        {items.map((it,i)=><button key={i} type="button" role="menuitem" className="dt-copyas-item"
          onClick={()=>{ try{it.run&&it.run();}catch(e){} close(); }}>{it.label}</button>)}
      </div></>:null}
  </span>;
}

/* KebabMenu — the ONE shared overflow-menu (⋮) primitive. Mirrors AbMenu's
   open/close + focus-management (Esc closes and returns focus to the trigger,
   ↑/↓ roves, first item auto-focused on open) but presents as a compact icon
   button for SECONDARY / less-frequent actions. RISK CONTROL: primary and
   destructive actions stay visible+labeled OUTSIDE the kebab — only truly
   secondary actions belong here. Reusable app-wide, including on DataTable
   rows (pass a per-row `label` for the a11y name). Reuses the dt-popover /
   dt-copyas-* styles so no bespoke menu chrome. */
function KebabMenu({label,items,align}){
  const [open,setOpen]=useState(false);
  const btnRef=useRef(null),menuRef=useRef(null);
  const name=label||'More actions';
  const close=()=>{ setOpen(false); if(btnRef.current) btnRef.current.focus(); };
  useEffect(()=>{ if(!open||!menuRef.current) return;
    const f=menuRef.current.querySelector('button:not(:disabled)'); if(f) f.focus(); },[open]);
  const move=delta=>{ const b=menuRef.current?Array.from(menuRef.current.querySelectorAll('button:not(:disabled)')):[];
    if(!b.length) return; let i=b.indexOf(document.activeElement); i=(i+delta+b.length)%b.length; b[i].focus(); };
  const its=(items||[]).filter(Boolean);
  return <span className="kebab-wrap" style={{position:'relative',display:'inline-flex'}}>
    <button ref={btnRef} type="button" className="btn kebab-btn" aria-haspopup="menu" aria-expanded={open}
      aria-label={name} title={name} onClick={()=>setOpen(v=>!v)}><span aria-hidden="true">⋮</span></button>
    {open?<><div className="views-overlay" onClick={close}/>
      <div ref={menuRef} className={'panel dt-popover dt-copyas-menu kebab-menu'+(align==='left'?' kebab-left':'')} role="menu" aria-label={name}
        onClick={e=>e.stopPropagation()}
        onKeyDown={e=>{ if(e.key==='Escape'){ e.preventDefault(); e.stopPropagation(); close(); }
          else if(e.key==='ArrowDown'){ e.preventDefault(); move(1); }
          else if(e.key==='ArrowUp'){ e.preventDefault(); move(-1); } }}>
        {its.map((it,i)=><button key={i} type="button" role="menuitem" className="dt-copyas-item kebab-item"
          disabled={!!it.disabled}
          onClick={()=>{ try{it.run&&it.run();}catch(e){} close(); }}>{it.label}</button>)}
      </div></>:null}
  </span>;
}

/* ── ActionBar (F3) — fixed bulk-action bar shown when a selection exists ── */
function ActionBar({count,actions,onClear}){
  const [confirm,setConfirm]=useState(null);
  useEffect(()=>{setConfirm(null);},[count]);
  return <div className="action-bar" role="toolbar" aria-label="Bulk actions">
    <span className="ab-count mono" role="status" aria-live="polite">{count} selected</span>
    {actions.map((a,i)=> a.menu
      ? <AbMenu key={i} label={a.label} items={a.menu}/>
      : confirm===i
      ? <span key={i} className="ab-confirm">
          <span>{typeof a.confirm==='string'?a.confirm:'Confirm?'}</span>
          <button className="btn" onClick={()=>{try{a.run&&a.run();}catch(e){} setConfirm(null);}}>Yes</button>
          <button className="btn btn-ghost" onClick={()=>setConfirm(null)}>No</button>
        </span>
      : <button key={i} className="btn" onClick={()=>a.confirm?setConfirm(i):(a.run&&a.run())}>{a.label}</button>)}
    <button className="btn btn-ghost" onClick={onClear}>Clear</button>
  </div>;
}

/* ── useRowFlash (F5) — flash(keys) tints rows for 400ms then clears ── */
function useRowFlash(){
  const [flashed,setFlashed]=useState(()=>new Set());
  const timers=useRef([]);
  const flash=useCallback(keys=>{
    const ks=(keys||[]).map(String).filter(Boolean);
    if(!ks.length) return;
    setFlashed(prev=>{const n=new Set(prev);ks.forEach(k=>n.add(k));return n;});
    const tm=setTimeout(()=>setFlashed(prev=>{const n=new Set(prev);ks.forEach(k=>n.delete(k));return n;}),400);
    timers.current.push(tm);
  },[]);
  useEffect(()=>()=>{timers.current.forEach(clearTimeout);},[]);
  return {flashed,flash};
}

/* ── DTRow (F3 perf) — memoized row so only cursor/selected/flashed rows re-render.
   cursor/selected/flash arrive as row-scoped booleans; all callbacks come off a
   stable ref (rowApi) so the memo holds across keypresses (subnet table = 5000 rows). ── */
/* safeCellContent — BUG1 guard: a raw API field (or a column render() return)
   can be an object/array (e.g. a DNS SOA record). Handing that straight to
   React throws #31 "Objects are not valid as a React child" with zero error
   boundaries in this app → permanent white screen. Primitives/elements pass
   through unchanged (zero visual diff for every existing table); booleans get
   a visible 'true'/'false' (today they silently render nothing); objects/
   arrays become a capped, single-line JSON preview. Never throws. */
function safeCellContent(v){
  try{
    if(v==null) return '';
    if(typeof v==='boolean') return v?'true':'false';
    if(typeof v==='string'||typeof v==='number') return v;
    if(React.isValidElement(v)) return v;
    if(typeof v==='object'){
      let s; try{s=JSON.stringify(v);}catch(e){s=String(v);}
      s=s==null?'':String(s);
      return s.length>200?s.slice(0,200)+'…':s;
    }
    return String(v);
  }catch(e){ return ''; }
}
/* looksLikeId — conservative auto-detect for the .dt-id treatment: long UUIDs,
   slash-paths (ipam/subnet/…), and long dotted FQDNs. Only ever applied to plain
   (un-rendered) cells, so a column's own renderer always wins. */
function looksLikeId(v){
  if(typeof v!=='string') return false;
  const s=v;
  if(s.length<18||/\s/.test(s)) return false;
  return /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i.test(s)      // uuid
    || (s.indexOf('/')>=0)                                    // path-style id
    || (/^[^@]+\.[^@]+$/.test(s)&&s.length>=28);              // long FQDN
}
/* IdCell — the ONE shared identifier renderer (Part 1 of the cell-legibility
   system). Middle-truncates value to head…tail, monospace, click/Enter copies the
   full value (shared copyText + toast), hover/focus reveals it via useHoverDetail. */
function IdCell({value,label}){
  const {bind}=useHoverDetail();
  const full=value==null?'':String(value);
  if(!full||full==='—') return full||'—';
  const TAIL=6;
  const tail=full.length>TAIL+2?full.slice(-TAIL):'';
  const head=tail?full.slice(0,full.length-TAIL):full;
  const doCopy=e=>{ if(e)e.stopPropagation();
    if(navigator.clipboard&&navigator.clipboard.writeText) navigator.clipboard.writeText(full);
    toast('Copied','ok',{duration:1500}); };
  return <span className="dt-id" role="button" tabIndex={0}
    aria-label={(label?label+': ':'')+full+' — activate to copy'}
    onClick={doCopy}
    onKeyDown={e=>{ if(e.key==='Enter'||e.key===' '){ e.preventDefault(); doCopy(e); } }}
    {...bind({title:label||'Identifier',rows:[['Full value',full]]})}>
    <span className="dt-id-head">{head}</span>
    {tail?<span className="dt-id-tail">{tail}</span>:null}
  </span>;
}
const DTRow=React.memo(function DTRow({r,rkey,cols,rowId,isCursor,isSel,isFlash,clickable,selectable,rowApi,diff,showDiff}){
  const align=c=>c.align||(c.mono?'right':'left');
  const isNum=c=>align(c)==='right';
  const fx=useFilters();
  // Copy-cell / copy-row: raw clipboard write + the shared toast/aria-live bus for
  // a non-color confirmation (no new live-region — Toasts() already renders one).
  const copyText=txt=>{ if(navigator.clipboard&&navigator.clipboard.writeText) navigator.clipboard.writeText(txt); };
  // Row actions live in a dedicated trailing gutter (td.dt-acts) as ONE labeled
  // KebabMenu — not the old hover-revealed ⧉/▾ pair inside the last data cell.
  // That pair had three defects: it painted over the cell's own value (nothing
  // reserved its lane), ⧉ duplicated the menu's own JSON item, and neither glyph
  // said what it did. The menu also lived in a td with overflow:hidden, so it was
  // CLIPPED to the 28px row band — only the first format was ever reachable.
  // KebabMenu owns the open state, focus return, and ↑/↓ roving; the gutter cell
  // sets overflow:visible so the popover is no longer cut off. Formats operate on
  // `cols` (the currently VISIBLE columns) except JSON, which stays the full row.
  const COPY_AS_FORMATS=[
    {id:'csv',label:'CSV',build:()=>rowAsCSV(cols,r)},
    {id:'json',label:'JSON',build:()=>JSON.stringify(r)},
    {id:'bql',label:'BQL filter',build:()=>rowAsBQL(cols,r)},
    {id:'md',label:'Markdown',build:()=>rowAsMarkdown(cols,r)},
  ];
  const copyAsFormat=fmt=>{ copyText(fmt.build()); toast('Copied as '+fmt.label,'ok',{duration:1500}); };
  // Per-row a11y name: 50 buttons all called "Row actions" is useless in a screen
  // reader's element list, so qualify with the row's primary (or first) column value.
  const nameCol=cols.find(c=>c.primary)||cols[0];
  const rowName=nameCol?String(r[nameCol.key]??'').slice(0,60):'';
  const actsLabel='Row actions'+(rowName?' — '+rowName:'');
  // Group C/2 — pivot-on-cell: ordinary (non-.pivot-cell) data cells get a tiny
  // "Filter by this value" action, funneling into the SAME fx.toggle/FilterCtx
  // the .pivot-cell columns already use (~1188), reached via right-click
  // (any row) or Shift+F10/Menu key (non-clickable rows only — clickable rows
  // keep Tab/Enter for row activation; there the affordance is mouse-only so
  // it never fights the row's own keyboard gesture).
  const [pivotMenuCi,setPivotMenuCi]=useState(-1);
  const pivotCellRefs=useRef({});
  const closePivotMenu=ci=>{ setPivotMenuCi(-1); const el=pivotCellRefs.current[ci]; if(el&&el.focus) el.focus(); };
  return <tr id={rowId||undefined}
    className={(clickable?'clickable':'')+(isCursor?' cursor':'')+(isFlash?' flash':'')}
    aria-selected={isCursor?'true':undefined}
    role="row" tabIndex={clickable?0:undefined}
    onClick={clickable?()=>rowApi.current.activate(rkey):undefined}
    onKeyDown={clickable?e=>{if(e.key==='Enter')rowApi.current.activate(rkey);}:undefined}>
    {showDiff?<td className="dt-diff mono">
      {diff?<span aria-label={diff.label} title={diff.label}>{diff.type}</span>:null}
    </td>:null}
    {selectable?<td className="dt-check" onClick={e=>{e.stopPropagation();rowApi.current.check(rkey,e.shiftKey);}}>
      <input type="checkbox" checked={isSel} onChange={()=>{}} aria-label="Select row"/>
    </td>:null}
    {cols.map((c,ci)=>{
      let content; const raw=r[c.key];
      // Identifier cells (Part 1 of the cell-legibility system): explicit column
      // opt-in (c.id / c.type==='id') OR conservative auto-detect on plain cells.
      // Renders via the shared IdCell (middle-truncate + hover-full + click-copy).
      const isId=c.id===true||c.type==='id'||(!c.render&&!c.spark&&looksLikeId(raw));
      if(c.spark){ const sv=c.spark(r); content=(Array.isArray(sv)&&sv.length>=2)?<Sparkline values={sv}/>:(c.render?c.render(raw,r):'—'); }
      else if(isId){ const full=c.idText?c.idText(raw,r):(raw==null?'':String(raw)); content=<IdCell value={full} label={c.label||c.key}/>; }
      else content=safeCellContent(c.render?c.render(raw,r):raw);
      // tooltip contract: explicit tip/tipFn wins → EXPLAIN glossary for coded cells →
      // raw value only for non-custom-rendered scalar cells (fixes useless title="92").
      let tip;
      if(typeof c.tipFn==='function'){ try{tip=c.tipFn(r);}catch(e){} }
      else if(c.tip!=null) tip=c.tip;
      if(tip==null) tip=explain(c.key,raw);
      // Raw-value fallback ONLY for plain, non-custom-rendered scalar cells. A cell with
      // its own render() (e.g. "32m ago" whose raw is a full ISO timestamp, util bars,
      // status badges) must not leak the raw value as a native title tooltip — that's the
      // confusing "2026-07-14T10:46:20" popover over a relative-time cell. Columns that
      // do want a tooltip set c.tip / c.tipFn explicitly.
      if(tip==null&&!c.render&&!c.spark&&(typeof raw==='string'||typeof raw==='number')) tip=String(raw);
      // pivot: clicking a coded value scopes every matching table/panel to it.
      if(c.pivot&&raw!=null&&raw!==''){
        const pv=String(raw), on=fx.has(c.key,pv), lbl=(c.label||c.key)+': '+pv;
        const fire=e=>{ e.stopPropagation(); fx.toggle(c.key,pv,lbl); };
        content=<span className={"pivot-cell"+(on?" active":"")} role="button" tabIndex={0}
          title={tip||('Filter to '+lbl)} aria-pressed={on} aria-label={(on?'Remove filter ':'Filter to ')+lbl}
          onClick={fire}
          onKeyDown={e=>{ if(e.key==='Enter'||e.key===' '){ e.preventDefault(); fire(e); } }}>{content}</span>;
      }
      // table-layout:fixed ignores min-width — a col's floor must be a real `width`
      // (fixed layout treats it as the column width; extra space still goes to the
      // unsized cols). minWidth therefore maps to width here, not min-width.
      const st=(()=>{const w=c.width!=null?c.width:(c.minWidth!=null?c.minWidth:(c.primary?120:null));return w!=null?{width:w}:null;})();
      // Cell copy: plain click copies the raw value. Skipped when the row itself is
      // clickable (row-click already owns that gesture — see DataTable's onRowClick)
      // and on pivot cells (their click already toggles a cross-filter).
      // id cells own their own click-to-copy (of the FULL value) — skip the generic cell copy.
      const copyCell=(clickable||c.pivot||isId)?undefined:e=>{ e.stopPropagation(); copyText(raw==null?'':String(raw)); toast('Copied','ok',{duration:1500}); };
      // canCellPivot: any ordinary (non-.pivot-cell) cell with a real value.
      // Right-click always offers the action; the keyboard path (Shift+F10/Menu
      // key + a focusable cell) is scoped to non-clickable rows (see closePivotMenu note above).
      const canCellPivot=!c.pivot&&raw!=null&&raw!=='';
      const cellKeyboardPivot=canCellPivot&&!clickable;
      const cellMenuOpen=pivotMenuCi===ci;
      const openPivotMenu=e=>{ e.preventDefault(); e.stopPropagation(); setPivotMenuCi(ci); };
      const cellPivotOn=canCellPivot&&fx.has(c.key,String(raw));
      const doCellPivot=e=>{
        if(e) e.stopPropagation();
        const pv=String(raw), lbl=(c.label||c.key)+': '+pv;
        const wasOn=fx.has(c.key,pv);
        fx.toggle(c.key,pv,lbl);
        closePivotMenu(ci);
        if(!wasOn) toast('Filtered to '+lbl,'ok',{duration:1500});
      };
      return <td key={c.key} title={(c.pivot||isId)?undefined:tip}
        ref={canCellPivot?(el=>{pivotCellRefs.current[ci]=el;}):undefined}
        className={(isNum(c)?'num ':'')+(c.mono?'mono':'')+(c.hideSm?' hide-sm':'')+(c.primary?' dt-primary':'')+(copyCell?' dt-copyable':'')+(canCellPivot?' dt-cell-pivot':'')}
        style={st} onClick={copyCell}
        onContextMenu={canCellPivot?openPivotMenu:undefined}
        tabIndex={cellKeyboardPivot?0:undefined}
        onKeyDown={cellKeyboardPivot?e=>{
          if((e.shiftKey&&e.key==='F10')||e.key==='ContextMenu'){ e.preventDefault(); e.stopPropagation(); setPivotMenuCi(ci); }
        }:undefined}>
        {content}
        {cellMenuOpen?<><div className="views-overlay" onClick={e=>{ e.stopPropagation(); closePivotMenu(ci); }}/>
          <div className="panel dt-popover dt-cellpivot-menu" role="menu" aria-label={'Actions for '+String(raw)}
            onClick={e=>e.stopPropagation()}
            onKeyDown={e=>{
              // stopPropagation on EVERY key while the menu is open — without it,
              // Enter bubbles to PowerProvider's global keydown listener (~936,
              // which only excludes input/textarea/select, not popover buttons)
              // and both fires this menu's Enter-activates-button AND the
              // global "open peek for cursor row" shortcut at once.
              if(e.key==='Escape'){ e.preventDefault(); e.stopPropagation(); closePivotMenu(ci); return; }
              e.stopPropagation();
            }}>
            <button type="button" role="menuitem" className="dt-cellpivot-item" autoFocus onClick={doCellPivot}>
              {(cellPivotOn?'Remove filter · ':'Filter by this value · ')}{String(raw)}
            </button>
          </div></>:null}
      </td>;
    })}
    <td className="dt-acts" onClick={e=>e.stopPropagation()}>
      <KebabMenu label={actsLabel} items={COPY_AS_FORMATS.map(fmt=>
        ({label:'Copy row as '+fmt.label, run:()=>copyAsFormat(fmt)}))}/>
    </td>
  </tr>;
});

/* ─────────────────────────────────────────────────────────────
   5. DataTable — sortable primitive with optional CSV export.
   cols:{key,label,mono,align,render,width,spark,copy}
   New OPTIONAL power props (omitted ⇒ today's exact DOM/behavior):
     tableId, rowKey, renderPeek, selectable, bulkActions, filterable, filterKeys, initialPeekKey
   ───────────────────────────────────────────────────────────── */
/* ─────────────────────────────────────────────────────────────
   Bloxsmith Unified Search (BQL) — Phase A pure core.
   parseQuery / deriveSchema / buildPredicate are schema-free-ish,
   hook-free, JSX-free plain functions (usable in Node + browser).
   Sentinel comments below let the test suite slice each block.
   ───────────────────────────────────────────────────────────── */
/* ==BQL:parseQuery:start== */
function parseQuery(str){
  // PURE, schema-free tokenizer. Never throws → on any error, one text token.
  try{
    if(str==null) return [];
    var s=String(str);
    if(s.trim()==='') return [];
    // 1. split on top-level whitespace, quotes suspend splitting.
    var chunks=[], buf='', inq=false;
    for(var i=0;i<s.length;i++){
      var ch=s[i];
      if(ch==='"'){ inq=!inq; buf+=ch; continue; }
      if(!inq && /\s/.test(ch)){ if(buf!==''){ chunks.push(buf); buf=''; } continue; }
      buf+=ch;
    }
    if(buf!=='') chunks.push(buf);
    var tokens=[], pendingNot=false;
    for(var c=0;c<chunks.length;c++){
      var chunk=chunks[c];
      var upper=chunk.toUpperCase();
      // F4: boolean combinators as their own whitespace-delimited chunk.
      // AND/&& is a no-op — bare-space between tokens already means AND, so
      // dropping the marker keeps the flat AND-token-list contract intact.
      if(chunk==='&&'||upper==='AND'){ continue; }
      // OR/|| becomes an explicit marker token buildPredicate splits groups on.
      if(chunk==='||'||upper==='OR'){ tokens.push({kind:'bool', op:'or', raw:chunk}); continue; }
      // NOT (bare word) negates whichever real token comes next; toggles so
      // "NOT NOT x" round-trips instead of jamming true.
      if(upper==='NOT'){ pendingNot=!pendingNot; continue; }
      var negate=false;
      // leading '-' or '!' negates; a lone '-'/'!' is literal text.
      if(chunk.length>1 && (chunk.charAt(0)==='-'||chunk.charAt(0)==='!')){ negate=true; chunk=chunk.slice(1); }
      if(pendingNot){ negate=!negate; pendingNot=false; }
      var raw=chunk; // raw = chunk minus leading '-'/'!'
      // quoted phrase (terminated or unterminated) → text token.
      if(chunk.charAt(0)==='"'){
        var inner=chunk.slice(1);
        if(inner.length && inner.charAt(inner.length-1)==='"') inner=inner.slice(0,-1);
        tokens.push({kind:'text', value:inner, quoted:true, negate:negate, raw:raw});
        continue;
      }
      // find earliest operator; two-char (>=,<=,!=,!~,>>) beats one-char at a match.
      var opIdx=-1, op=null;
      for(var k=0;k<chunk.length;k++){
        var two=chunk.substr(k,2);
        if(two==='>='||two==='<='||two==='!='||two==='!~'||two==='>>'){ opIdx=k; op=two; break; }
        var one=chunk.charAt(k);
        if(one==='>'||one==='<'||one==='='||one===':'||one==='~'){ opIdx=k; op=one; break; }
      }
      if(opIdx===-1){ tokens.push({kind:'text', value:chunk, negate:negate, raw:raw}); continue; }
      var field=chunk.slice(0,opIdx).toLowerCase();
      var rawval=chunk.slice(opIdx+op.length);
      if(field===''){ tokens.push({kind:'text', value:chunk, negate:negate, raw:raw}); continue; }
      // value shaping (mostly op ':')
      var shape;
      var inSet=/^in\(([\s\S]*)\)$/i.exec(rawval);
      var rng=/^(-?\d+(?:\.\d+)?)-(-?\d+(?:\.\d+)?)$/.exec(rawval);
      var cidrFull=/^\d{1,3}(?:\.\d{1,3}){3}\/\d{1,2}$/.test(rawval);
      if(inSet){
        // IN(a,b,c) — same 'or' shape as the comma shorthand, so every
        // downstream match fn (num/str/arr) already knows how to apply it.
        shape={op:'or', values:inSet[1].split(',').map(function(x){return x.trim();}).filter(function(x){return x!=='';})};
      } else if(rng){
        shape={op:'range', lo:Number(rng[1]), hi:Number(rng[2])};
      } else if(rawval.indexOf(',')!==-1){
        shape={op:'or', values:rawval.split(',').filter(function(x){return x!=='';})};
      } else if(field==='cidr' && rawval.charAt(0)==='/'){
        shape={op:'=', value:rawval.slice(1)};
      } else if(cidrFull && (op===':'||op==='>>')){
        // field>>a.b.c.d/n or field:a.b.c.d/n — "row value falls within this
        // CIDR" (F4 CIDR-contains). '=' is left alone as a literal-string escape.
        shape={op:'cidrIn', value:rawval};
      } else if(/^\d+(?:\.\d+)?[mhd]$/.test(rawval)){
        shape={op:op, value:rawval, age:true};
      } else {
        shape={op:op, value:rawval};
      }
      var tok={kind:'field', field:field};
      for(var key in shape){ if(Object.prototype.hasOwnProperty.call(shape,key)) tok[key]=shape[key]; }
      tok.negate=negate; tok.raw=raw;
      tokens.push(tok);
    }
    return tokens;
  }catch(e){
    var v=(str==null)?'':String(str);
    return v===''?[]:[{kind:'text', value:v, negate:false, raw:v}];
  }
}
/* ==BQL:parseQuery:end== */

/* ==BQL:deriveSchema:start== */
function deriveSchema(cols, rows, searchSchema){
  cols=cols||[]; rows=rows||[]; searchSchema=searchSchema||{};
  var fields={}, ageKey=null;
  var ageRe=/(^|_)(ts|time|date|seen|when|_at)$|age/;
  for(var ci=0;ci<cols.length;ci++){
    var col=cols[ci]; if(!col||!col.key) continue;
    var key=col.key, samples=[];
    for(var ri=0;ri<rows.length && samples.length<30;ri++){
      var v=rows[ri]?rows[ri][key]:undefined;
      if(v!==null && v!==undefined) samples.push(v);
    }
    var type, values=null;
    if(samples.length && samples.every(function(x){return typeof x==='number';})) type='number';
    else if(samples.length && samples.every(function(x){return typeof x==='boolean';})) type='boolean';
    else if(samples.some(function(x){return Array.isArray(x);})) type='array';
    else {
      var distinct={}, n=0;
      for(var si=0;si<samples.length;si++){ var sv=String(samples[si]); if(!Object.prototype.hasOwnProperty.call(distinct,sv)){ distinct[sv]=1; n++; } }
      if(n<=12){ type='enum'; values=Object.keys(distinct); } else type='string';
    }
    var def={type:type, key:key};
    if(values) def.values=values;
    fields[key]=def;
    // synthetic age field (first matching column wins)
    if(ageKey===null){
      var isAge=ageRe.test(key);
      if(!isAge && samples.length){
        isAge = samples.some(function(x){return typeof x==='string';}) &&
                samples.every(function(x){return !isNaN(Date.parse(x));});
      }
      if(isAge) ageKey=key;
    }
  }
  if(ageKey!==null) fields['age']={type:'age', key:ageKey};
  // built-in aliases — keep only if the target field exists.
  // F6: 'last' aliases onto the same synthetic age field so `last:24h`/`last:7d`/
  // `last:30m` rides the existing ageMatch comparator (op ':' ⇒ within-window) —
  // no new predicate logic needed, just a friendlier alias name for time presets.
  // F4: 'in' aliases onto the same address field as 'ip' — lets the CIDR-contains
  // operator read as `in:10.0.0.0/8` without a schema override.
  var aliases={}, builtin={sev:'severity', zone:'fqdn', ip:'addr', in:'addr', value:'dns_rdata', last:'age'};
  for(var a in builtin){ if(Object.prototype.hasOwnProperty.call(builtin,a) && fields[builtin[a]]) aliases[a]=builtin[a]; }
  // freeTextKeys: searchSchema override → DataTable filterKeys → all col keys.
  var freeTextKeys = (searchSchema.freeTextKeys && searchSchema.freeTextKeys.length) ? searchSchema.freeTextKeys
    : (searchSchema.filterKeys && searchSchema.filterKeys.length) ? searchSchema.filterKeys
    : cols.map(function(c){return c.key;});
  // searchSchema deep-merges over auto-derived (per-field override).
  if(searchSchema.aliases){ for(var ak in searchSchema.aliases){ if(Object.prototype.hasOwnProperty.call(searchSchema.aliases,ak)) aliases[ak]=searchSchema.aliases[ak]; } }
  if(searchSchema.fields){ for(var fk in searchSchema.fields){ if(Object.prototype.hasOwnProperty.call(searchSchema.fields,fk)){ var base=fields[fk]||{}; var ov=searchSchema.fields[fk]||{}; var merged={}; for(var b in base){ if(Object.prototype.hasOwnProperty.call(base,b)) merged[b]=base[b]; } for(var o in ov){ if(Object.prototype.hasOwnProperty.call(ov,o)) merged[o]=ov[o]; } fields[fk]=merged; } } }
  return {freeTextKeys:freeTextKeys, aliases:aliases, fields:fields};
}
/* ==BQL:deriveSchema:end== */

/* ==BQL:buildPredicate:start== */
function buildPredicate(tokens, schema){
  tokens=tokens||[]; schema=schema||{};
  var fields=schema.fields||{}, aliases=schema.aliases||{}, ftk=schema.freeTextKeys||[];
  if(!tokens.length) return function(){ return true; };
  function textMatch(value, row){
    var needle=String(value).toLowerCase();
    return ftk.some(function(k){ return String(row[k]??'').toLowerCase().includes(needle); });
  }
  function numCmp(op, n, tok){
    switch(op){
      case '=': return n===Number(tok.value);
      case '!=': return n!==Number(tok.value);
      case '>': return n>Number(tok.value);
      case '>=': return n>=Number(tok.value);
      case '<': return n<Number(tok.value);
      case '<=': return n<=Number(tok.value);
      case 'range': return n>=tok.lo && n<=tok.hi;
      case 'or': return tok.values.some(function(x){ return n===Number(x); });
      default: return n===Number(tok.value); // ':'
    }
  }
  function numMatch(tok, v){
    if(v===null||v===undefined||v==='') return false;
    var n=Number(v);
    if(isNaN(n)) return false;
    return numCmp(tok.op, n, tok);
  }
  function strMatch(tok, v){
    var s=String(v==null?'':v).toLowerCase();
    if(tok.op==='=') return s===String(tok.value).toLowerCase();
    if(tok.op==='!=') return s!==String(tok.value).toLowerCase();
    if(tok.op==='or') return tok.values.some(function(x){ return s.indexOf(String(x).toLowerCase())!==-1; });
    // F4: comparators generalized to strings — lexicographic, same as a
    // human alphabetizing; mainly useful for enum/ordinal-ish string fields.
    if(tok.op==='>') return s>String(tok.value).toLowerCase();
    if(tok.op==='>=') return s>=String(tok.value).toLowerCase();
    if(tok.op==='<') return s<String(tok.value).toLowerCase();
    if(tok.op==='<=') return s<=String(tok.value).toLowerCase();
    return s.indexOf(String(tok.value).toLowerCase())!==-1; // ':' / default
  }
  function boolMatch(tok, v){
    var s=String(tok.value).toLowerCase();
    var want = (s==='yes'||s==='true'||s==='1');
    var res = (!!v)===want;
    return tok.op==='!=' ? !res : res;
  }
  // F4: CIDR-contains — "does this row's address/subnet value fall inside
  // the query's CIDR block". Small local ip4-to-int helper; no existing
  // helper elsewhere in the codebase to reuse (grepped for inCidr/ipToInt —
  // none found), kept here since parse/predicate must stay pure + self-contained.
  function ip4ToInt(ip){
    var m=/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(ip==null?'':ip).trim());
    if(!m) return null;
    var a=+m[1],b=+m[2],c=+m[3],d=+m[4];
    if(a>255||b>255||c>255||d>255) return null;
    return ((a*256+b)*256+c)*256+d;
  }
  function cidrContains(cidrStr, addr){
    var parts=String(cidrStr||'').split('/');
    var base=ip4ToInt(parts[0]);
    var bits=parts.length>1?parseInt(parts[1],10):32;
    if(base===null||isNaN(bits)||bits<0||bits>32) return false;
    var n=ip4ToInt(String(addr==null?'':addr).split('/')[0]); // tolerate row value itself being "a.b.c.d/n"
    if(n===null) return false;
    var mask=bits===0?0:(0xFFFFFFFF<<(32-bits))>>>0;
    return (base & mask)===(n & mask);
  }
  function arrMatch(tok, v){
    var arr=Array.isArray(v)?v:[];
    if(tok.op===':'){
      var needle=String(tok.value).toLowerCase();
      return arr.some(function(e){ return String(e).toLowerCase().indexOf(needle)!==-1; });
    }
    if(tok.op==='or'){
      return tok.values.some(function(x){ var nx=String(x).toLowerCase(); return arr.some(function(e){ return String(e).toLowerCase().indexOf(nx)!==-1; }); });
    }
    return numCmp(tok.op, (Array.isArray(v)?v.length:0), tok); // numeric op → length
  }
  function ageMatch(tok, v){
    // epoch-seconds (or ms) numbers → treat as timestamp; else parse a date string.
    var t;
    if(typeof v==='number'){ t = v<1e12 ? v*1000 : v; }
    else if(typeof v==='string' && v.trim()!=='' && /^\d+(?:\.\d+)?$/.test(v.trim())){ var nv=Number(v); t = nv<1e12 ? nv*1000 : nv; }
    else { t = Date.parse(v); }
    if(isNaN(t)) return false;
    var ageMs=Date.now()-t;
    var m=/^(\d+(?:\.\d+)?)([mhd])$/.exec(String(tok.value));
    var limit;
    if(m){ var mult=(m[2]==='m')?60000:(m[2]==='h')?3600000:86400000; limit=Number(m[1])*mult; }
    else limit=Number(tok.value);
    switch(tok.op){
      case '<': return ageMs<limit;
      case '<=': return ageMs<=limit;
      case '>': return ageMs>limit;
      case '>=': return ageMs>=limit;
      case '=': return ageMs===limit;
      case '!=': return ageMs!==limit;
      case 'range': return ageMs>=tok.lo && ageMs<=tok.hi;
      default: return ageMs<=limit; // ':'
    }
  }
  function matchToken(tok, row){
    if(tok.kind==='bool') return true; // OR marker — no row semantics of its own
    if(tok.kind==='text') return textMatch(tok.value, row);
    var field=tok.field;
    var canon = (aliases[field]!==undefined && aliases[field]!==null) ? aliases[field] : (fields[field]?field:null);
    if(canon==null) return textMatch(tok.raw, row); // degrade unknown field → substring
    var def=fields[canon];
    if(!def) return textMatch(tok.raw, row);
    var v=row[def.key];
    // F4: ~ / !~ contains-match are type-agnostic (coerce to string) so they
    // work sanely across number/string/enum/array/age fields alike.
    if(tok.op==='~'||tok.op==='!~'){
      var s=String(v==null?'':v).toLowerCase();
      var needle=String(tok.value).toLowerCase();
      var has=s.indexOf(needle)!==-1;
      return tok.op==='~'?has:!has;
    }
    // F4: CIDR-contains bypasses the type switch — works on any field
    // holding an address/subnet-shaped string, typed 'cidr' or not.
    if(tok.op==='cidrIn') return cidrContains(tok.value, v);
    switch(def.type){
      case 'number': return numMatch(tok, v);
      case 'boolean': return boolMatch(tok, v);
      case 'array': return arrMatch(tok, v);
      case 'age': return ageMatch(tok, v);
      case 'cidr': return numMatch(tok, v); // parser already turned cidr:/30 → =30
      case 'string':
      case 'enum':
      default: return strMatch(tok, v);
    }
  }
  // F4: OR-groups — split the flat AND-token stream on {kind:'bool',op:'or'}
  // markers into independent AND-groups; a row matches if ANY group's tokens
  // all match. No OR present ⇒ a single group ⇒ byte-identical to the
  // pre-existing all-tokens-AND behavior (backward compatible).
  var groups=[[]];
  for(var gi=0;gi<tokens.length;gi++){
    var gtok=tokens[gi];
    if(gtok.kind==='bool' && gtok.op==='or'){ groups.push([]); continue; }
    groups[groups.length-1].push(gtok);
  }
  function groupMatch(grp, row){
    for(var j=0;j<grp.length;j++){
      var tok=grp[j];
      var res=matchToken(tok, row);
      if(tok.negate) res=!res;
      if(!res) return false;
    }
    return true;
  }
  return function(row){
    for(var g=0;g<groups.length;g++){
      if(groupMatch(groups[g], row)) return true;
    }
    return false;
  };
}
/* ==BQL:buildPredicate:end== */

/* ==BQL:cleanBqlAnswer:start== */
// Strips code fences / wrapping quotes / trailing chatter from an LLM's NL→BQL
// translation answer down to a single-line query string. Pure, never throws.
function cleanBqlAnswer(raw){
  try{
    var s=String(raw==null?'':raw).trim();
    s=s.replace(/^```[a-zA-Z]*\n?/,'').replace(/```\s*$/,'').trim();
    s=s.split('\n')[0].trim();
    if(s.length>1){
      var first=s.charAt(0), last=s.charAt(s.length-1);
      if((first==='"'&&last==='"')||(first==='`'&&last==='`')) s=s.slice(1,-1).trim();
    }
    return s;
  }catch(e){ return ''; }
}
/* ==BQL:cleanBqlAnswer:end== */

function DataTable({cols,rows,defaultSort,onRowClick,csvName,
  tableId,rowKey,renderPeek,selectable,bulkActions,filterable,filterKeys,initialPeekKey,
  maxRows,problemsOnly,scrollBody,columnToggle,searchSchema,query,onQuery,
  diffMap,diffGhosts}){
  const power=usePower();
  const fx=useFilters();
  const {filters:globalFilters}=fx;
  const id=tableId||(csvName?String(csvName):null);
  // Shareable-URL view state (Feature 1): sort/colVis/own-filter are seeded from the
  // hash (params namespaced `<id>.sort` / `<id>.cols` / `<id>.q`) so a pasted "Copy
  // link" URL reopens the exact table view, not just the tab — same discipline the
  // `f=` cross-filter mirror (FilterProvider, ~977) and the subnets `sq=` mirror
  // (NetworkTab, ~4280) already use. The mirror-back effects live further down,
  // once all three pieces of state exist.
  const hashParams=id?parseHash().params:null;
  // Feature 7 — multi-column sort. `sort` is always an ORDERED ARRAY of {key,dir}
  // (was a single {key,dir}|null object) — [] = unsorted, [a] = single-sort (the
  // common case, and the ONLY shape ever written to the hash so `<id>.sort` stays
  // byte-compatible with the old "key:dir" format — see serializeSortParam), [a,b,…]
  // = shift-click-appended secondary/tertiary keys, applied in order, stable.
  const [sort,setSort]=useState(()=>{
    const raw=hashParams&&hashParams[id+'.sort'];
    if(raw) return parseSortParam(raw);
    return defaultSort?[defaultSort]:[];
  });
  const [cursor,setCursor]=useState(-1);             // -1 = no visual until a key is pressed
  const [selected,setSelected]=useState(()=>new Set());
  const [filterState,setFilterState]=useState(()=>{
    const raw=hashParams&&hashParams[id+'.q'];
    return raw||'';
  });
  // Controlled-search handoff: when onQuery is supplied the parent owns the filter string
  // (NetworkTab uses it to mirror the subnets search to the #…?sq= hash + inject util/site presets).
  const filterControlled=typeof onQuery==='function';
  const filter=filterControlled?(query||''):filterState;
  const setFilter=filterControlled?onQuery:setFilterState;
  const [showAll,setShowAll]=useState(false);        // maxRows expander
  const [renderLimit,setRenderLimit]=useState(300);  // scrollBody progressive render window
  // scrollBody: default (true) reads the shared --panel-md token; a number → px.
  const scrollPx=scrollBody===true?'var(--panel-md)':(typeof scrollBody==='number'?scrollBody+'px':scrollBody);
  // Baseline affordances: CSV export + column chooser default on for row-heavy tables (opt-out via explicit prop).
  const showCsv=csvName||(rows&&rows.length>12&&tableId);
  const showCols=columnToggle||((cols||[]).length>6);
  // columnToggle: hidden column keys (persisted per tableId + mirrored to `<id>.cols` in
  // the hash — hash wins on initial load so a shared link overrides local prefs; every
  // local toggle afterward still updates BOTH, same as before). Stale keys are ignored on read.
  const [hiddenCols,setHiddenCols]=useState(()=>{
    if(!showCols||!id) return [];
    const raw=hashParams&&hashParams[id+'.cols'];
    if(raw!=null) return raw?raw.split(','):[];
    return LS.get('cols.'+id,[]);
  });
  const [colsMenu,setColsMenu]=useState(false);
  // Feature 8: column reorder (keyed order array) + pin-first, persisted alongside
  // the hidden-columns key above. colOrder is null until the user reorders at
  // least once — effCols then falls back to declaration order.
  const [colOrder,setColOrder]=useState(()=> (showCols&&id)?LS.get('cols.order.'+id,null):null);
  const [pinnedCol,setPinnedCol]=useState(()=> (showCols&&id)?LS.get('cols.pin.'+id,null):null);
  const colsMenuRef=useRef(null);
  const colsBtnRef=useRef(null);
  // Open -> focus the first enabled control inside the popover; Esc/overlay-click ->
  // close + return focus to the Cols button (a11y hard gate: never leave focus
  // stranded in a closed popover).
  useEffect(()=>{
    if(!colsMenu||!colsMenuRef.current) return;
    const first=colsMenuRef.current.querySelector('input:not(:disabled),button:not(:disabled)');
    if(first) first.focus();
  },[colsMenu]);
  const closeColsMenu=useCallback(()=>{
    setColsMenu(false);
    if(colsBtnRef.current) colsBtnRef.current.focus();
  },[]);
  // ── F5: on-demand facet popover — top values+counts for this table's pivot
  // (cross-filterable) columns. Facet click funnels into the SAME fx.toggle used
  // by pivot-cell (~1055), so the resulting chip is the existing FilterBar chip.
  const [facetOpen,setFacetOpen]=useState(false);
  const facetBtnRef=useRef(null);
  const facetMenuRef=useRef(null);
  const [sugOpen,setSugOpen]=useState(false);    // BQL typeahead popover
  const [sugIdx,setSugIdx]=useState(-1);          // highlighted suggestion
  const [cheatOpen,setCheatOpen]=useState(false); // ? grammar cheatsheet
  const cheatBtnRef=useRef(null);
  const cheatPanelRef=useRef(null);
  const [probOn,setProbOn]=useState(()=> problemsOnly ? LS.get('probs.'+(id||'x'),!!problemsOnly.default) : false);
  const setProb=v=>{ setProbOn(v); if(id) LS.set('probs.'+id,v); };
  const [nlBusy,setNlBusy]=useState(false); // NL→BQL translate in flight
  // Recent-queries ring buffer (absorbed query history): {q,pinned}[], most-recent-first, cap 15.
  const recentKey='recentQ.'+(id||'x');
  const [recent,setRecent]=useState(()=>LS.get(recentKey,[]));
  const pushRecent=q=>{
    q=String(q||'').trim(); if(!q) return;
    setRecent(list=>{
      const idx=list.findIndex(e=>e.q===q);
      const pinned=idx>=0?!!list[idx].pinned:false;
      const rest=idx>=0?[...list.slice(0,idx),...list.slice(idx+1)]:list;
      const next=[{q,pinned},...rest].slice(0,15);
      LS.set(recentKey,next);
      return next;
    });
  };
  const togglePin=q=>{
    setRecent(list=>{
      const next=list.map(e=>e.q===q?{...e,pinned:!e.pinned}:e);
      LS.set(recentKey,next);
      return next;
    });
  };
  const {flashed,flash}=useRowFlash();
  const columns=cols||[];
  const data=rows||[];
  const wrapRef=useRef(null);
  const filterRef=useRef(null);
  const apiRef=useRef({});
  const lastClickRef=useRef(null);
  const initRef=useRef(false);

  const keyOf=useCallback((r,i)=>rowKey?String(rowKey(r)):String(i),[rowKey]);

  // problemsOnly toggle is applied FIRST when building the visible set.
  const probTest=useCallback(r=>{ if(!problemsOnly) return false; try{return !!problemsOnly.test(r);}catch(e){return false;} },[problemsOnly]);
  const probRows=useMemo(()=> problemsOnly ? data.filter(probTest) : null,[data,problemsOnly,probTest]);
  const probCount=probRows?probRows.length:0;
  const base=(problemsOnly&&probOn)?probRows:data;

  // BQL search schema: filterKeys drives freeTextKeys (Phase A precedence); searchSchema deep-merges over auto-derived.
  const _schema=useMemo(()=>deriveSchema(columns,base,{...(searchSchema||{}),filterKeys}),[columns,base,searchSchema,filterKeys]);

  // Group C/3 — facet <-> BQL two-way sync. ONE query state: FilterCtx (fx) stays
  // the cross-table source of truth (facet click still funnels into fx.toggle,
  // unchanged — see filter-facets.spec.ts), and this table's own search text is
  // kept in sync alongside it, both directions:
  //   bqlHasEquality(field,value) — does the CURRENT typed query already assert
  //     field=value/field:value? (resolves schema aliases so `sev:` still lights
  //     up a "severity" facet group). Used as an OR alongside fx.has() so typing
  //     BQL marks the matching facet item active even before any click.
  //   mirrorFacetToken(field,value,adding) — after a facet click flips fx, also
  //     add/remove the equivalent `field=value` token in the search box so the
  //     box always shows valid BQL the parser understands. Values the tokenizer
  //     can't represent unquoted (whitespace/comma/parens/quotes) skip the
  //     mirror — the fx chip alone still filters, same as before this feature.
  const bqlHasEquality=useCallback((field,value)=>{
    const toks=parseQuery(filter);
    const fieldLc=String(field).toLowerCase(), valLc=String(value).toLowerCase();
    const aliases=_schema.aliases||{};
    return toks.some(t=>{
      if(t.kind!=='field'||t.negate) return false;
      if(t.op!=='='&&t.op!==':') return false;
      const canon=(aliases[t.field]!=null)?aliases[t.field]:t.field;
      return canon===fieldLc && String(t.value).toLowerCase()===valLc;
    });
  },[filter,_schema]);
  const SAFE_FACET_VAL=/^[^\s,()"]+$/;
  // Tracks which "field=value" text tokens THIS mirror wrote on the facet's
  // behalf (fieldLc\0valLc -> original-case {field,value}) — so the reconcile
  // effect below only ever cleans up tokens IT added, never a token the user
  // typed by hand (that one-way "typed BQL lights up a facet" read, point (a)
  // above, must never get silently rewritten out from under them).
  const mirroredFacetTokens=useRef(new Map());
  const mirrorFacetToken=useCallback((field,value,adding)=>{
    if(!SAFE_FACET_VAL.test(String(value))) return;
    const key=String(field).toLowerCase()+' '+String(value).toLowerCase();
    if(adding) mirroredFacetTokens.current.set(key,{field,value:String(value)});
    else mirroredFacetTokens.current.delete(key);
    const toks=parseQuery(filter);
    const fieldLc=String(field).toLowerCase(), valLc=String(value).toLowerCase();
    const kept=toks.filter(t=>!(t.kind==='field'&&!t.negate&&(t.op==='='||t.op===':')&&t.field===fieldLc&&String(t.value).toLowerCase()===valLc));
    let rebuilt=kept.map(t=>t.kind==='bool'?t.raw:(t.negate?'-':'')+t.raw).join(' ');
    if(adding) rebuilt=(rebuilt?rebuilt+' ':'')+field+'='+value;
    setFilter(rebuilt);
  },[filter,setFilter]);
  // Reconcile: a chip we mirrored can also be removed some OTHER way (the
  // FilterBar × / "Clear all", which call fx.remove/fx.clear directly, not
  // through mirrorFacetToken) — strip its text token too, so the query box
  // never shows a stale filter the chip row no longer backs.
  useEffect(()=>{
    const cur=mirroredFacetTokens.current;
    if(!cur.size) return;
    const stale=[];
    cur.forEach((pair,key)=>{ if(!fx.has(pair.field,pair.value)) stale.push(key); });
    if(!stale.length) return;
    stale.forEach(key=>cur.delete(key));
    const staleLc=stale.map(key=>key.split(' '));
    const toks=parseQuery(filter);
    const kept=toks.filter(t=>{
      if(t.kind!=='field'||t.negate||(t.op!=='='&&t.op!==':')) return true;
      return !staleLc.some(([f,v])=>t.field===f&&String(t.value).toLowerCase()===v);
    });
    setFilter(kept.map(t=>t.kind==='bool'?t.raw:(t.negate?'-':'')+t.raw).join(' '));
  },[globalFilters]); // eslint-disable-line

  // F5 facets: pivot columns are this table's designated cross-filterable fields
  // (same set the pivot-cell already scopes on). Counts computed from `base`
  // (currently loaded rows, pre-filter) — matches the BQL typeahead's distinctVals precedent.
  const facetCols=useMemo(()=>columns.filter(c=>c.pivot),[columns]);
  const showFacets=facetCols.length>0;
  const facetData=useMemo(()=>{
    if(!facetOpen||!showFacets) return [];
    return facetCols.map(c=>{
      const counts={};
      base.forEach(r=>{ const v=r[c.key]; if(v==null||v==='') return; const s=String(v); counts[s]=(counts[s]||0)+1; });
      const values=Object.keys(counts).map(v=>({v,n:counts[v]})).sort((a,b)=>b.n-a.n).slice(0,8);
      return {key:c.key,label:c.label||c.key,values};
    }).filter(g=>g.values.length);
  },[facetOpen,showFacets,facetCols,base]);
  const closeFacets=useCallback(()=>{
    setFacetOpen(false);
    if(facetBtnRef.current) facetBtnRef.current.focus();
  },[]);
  // H2: mirrors the Cols popover's focus-in-on-open (~1423-1427) — without this,
  // Esc only closes the facet popover once the user has already Tabbed a focus
  // target inside it, and screen readers never announce the popover opening.
  useEffect(()=>{
    if(!facetOpen||!facetMenuRef.current) return;
    const first=facetMenuRef.current.querySelector('button:not(:disabled)');
    if(first) first.focus();
  },[facetOpen]);
  // M5: cheatsheet dialog has no focusable content of its own (just text rows),
  // so the panel itself is the focus target (tabIndex={-1}) — same close+return
  // contract as closeFacets/closeColsMenu above.
  const closeCheat=useCallback(()=>{
    setCheatOpen(false);
    if(cheatBtnRef.current) cheatBtnRef.current.focus();
  },[]);
  useEffect(()=>{
    if(!cheatOpen||!cheatPanelRef.current) return;
    cheatPanelRef.current.focus();
  },[cheatOpen]);

  const filtered=useMemo(()=>{
    let out=base;
    if(filterable&&filter.trim()){
      const _tokens=parseQuery(filter);
      const _pred=buildPredicate(_tokens,_schema);
      out=out.filter(_pred);
    }
    // global cross-filter: AND every active filter whose field is a column of THIS table
    // (filters for fields this table lacks are ignored, so unrelated tables don't blank).
    const active=globalFilters.filter(f=>columns.some(c=>c.key===f.field));
    if(active.length) out=out.filter(r=>active.every(f=>filterMatchesRow(r,f)));
    return out;
  },[base,filter,filterable,_schema,columns,globalFilters]);

  const sorted=useMemo(()=>{
    if(!sort||!sort.length) return filtered;
    return [...filtered].sort((a,b)=>{
      for(let i=0;i<sort.length;i++){
        const {key,dir}=sort[i];const mul=dir==='desc'?-1:1;
        const av=a?.[key],bv=b?.[key];
        let cmp;
        if(av==null&&bv==null) cmp=0;
        else if(av==null) cmp=1;
        else if(bv==null) cmp=-1;
        else{
          const an=typeof av==='number',bn=typeof bv==='number';
          cmp=(an&&bn)?(av-bv):String(av).localeCompare(String(bv),undefined,{numeric:true});
        }
        cmp*=mul;
        if(cmp!==0) return cmp;
      }
      return 0;
    });
  },[filtered,sort]);

  // maxRows/scrollBody: cap the rendered domain; CSV/filter/sort keep full `sorted`.
  // scrollBody renders a progressive window (renderLimit); maxRows keeps the legacy cap.
  const visible=sorted.slice(0, scrollBody?renderLimit:(maxRows&&!showAll?maxRows:Infinity));

  // Feature 8: colOrder holds ALL column keys (visible + hidden) in the user's
  // chosen order; stale keys drop out, new columns (schema change) append at
  // the end — same "stale keys ignored" contract as hiddenCols above.
  const orderedAll=useMemo(()=>{
    if(!colOrder||!colOrder.length) return columns;
    const byKey=new Map(columns.map(c=>[c.key,c]));
    const out=colOrder.map(k=>byKey.get(k)).filter(Boolean);
    columns.forEach(c=>{ if(!out.includes(c)) out.push(c); });
    return out;
  },[columns,colOrder]);
  // columnToggle: effective (rendered) columns = ordered cols minus hidden, pinned first.
  // Never yields an empty set; CSV/peek-title still use the full `columns`.
  const effCols=useMemo(()=>{
    // Part 2 of the cell-legibility system — hide-all-empty-columns by default:
    // drop any PLAIN (un-rendered, non-spark, non-id) column whose value is empty
    // in every row. Rendered/spark/id/keepEmpty columns are always kept (they can
    // show content regardless of the raw value). Never yields an empty set.
    const dataRows=rows||[];
    const pruneEmpty=cs=>{
      if(!dataRows.length) return cs;
      const kept=cs.filter(c=> c.render||c.spark||c.id||c.type==='id'||c.keepEmpty
        || dataRows.some(r=>{const v=r&&r[c.key]; return v!=null&&v!=='';}));
      return kept.length?kept:cs;
    };
    if(!showCols) return pruneEmpty(columns);
    let cs=pruneEmpty(orderedAll);
    if(hiddenCols.length){
      const keep=cs.filter(c=>!hiddenCols.includes(c.key));
      cs=keep.length?keep:cs;
    }
    if(pinnedCol){
      const pinned=cs.find(c=>c.key===pinnedCol);
      if(pinned) cs=[pinned,...cs.filter(c=>c.key!==pinnedCol)];
    }
    return cs;
  },[columns,hiddenCols,showCols,orderedAll,pinnedCol,rows]);
  const toggleCol=(key)=>setHiddenCols(prev=>{
    const has=prev.includes(key);
    const next=has?prev.filter(k=>k!==key):[...prev,key];
    if(!has && (columns.length-next.length)<1) return prev; // never hide the last column
    if(id) LS.set('cols.'+id,next);
    return next;
  });
  // moveCol: keyboard reorder (up/down buttons in the Cols popover, not drag-only).
  // Operates on the full column list (orderedAll's key order) so boundary
  // disabling matches what the menu itself renders.
  const moveCol=(key,delta)=>setColOrder(prev=>{
    const base=(prev&&prev.length)?prev.slice():columns.map(c=>c.key);
    columns.forEach(c=>{ if(!base.includes(c.key)) base.push(c.key); });
    const i=base.indexOf(key), j=i+delta;
    if(i<0||j<0||j>=base.length) return prev;
    [base[i],base[j]]=[base[j],base[i]];
    if(id) LS.set('cols.order.'+id,base);
    return base;
  });
  const togglePinCol=(key)=>setPinnedCol(prev=>{
    const next=prev===key?null:key;
    if(id) LS.set('cols.pin.'+id,next);
    return next;
  });

  // Shareable-URL view state (Feature 1), mirror-back half: one-way state -> nav()
  // writes, each guarded so it only calls nav() when the encoded value actually
  // changed (same guard the `sq=`/`f=` mirrors use) — otherwise a hashchange from
  // one effect would re-trigger the others. filterState only mirrors when this
  // table owns its own search box (!filterControlled) — controlled tables (the
  // subnets `sq=` case) keep their existing external mirror untouched.
  useEffect(()=>{
    if(!id) return;
    const {tab,params}=parseHash(); const np={...params};
    const key=id+'.sort';
    const val=serializeSortParam(sort);
    if(val) np[key]=val; else delete np[key];
    if((np[key]||'')!==(params[key]||'')) nav(tab,np);
  },[id,sort]);
  useEffect(()=>{
    if(!id||!showCols) return;
    const {tab,params}=parseHash(); const np={...params};
    const key=id+'.cols';
    const val=hiddenCols.join(',');
    if(val) np[key]=val; else delete np[key];
    if((np[key]||'')!==(params[key]||'')) nav(tab,np);
  },[id,showCols,hiddenCols]);
  useEffect(()=>{
    if(!id||filterControlled||!filterable) return;
    const {tab,params}=parseHash(); const np={...params};
    const key=id+'.q';
    const val=(filterState||'').trim();
    if(val) np[key]=val; else delete np[key];
    if((np[key]||'')!==(params[key]||'')) nav(tab,np);
  },[id,filterControlled,filterable,filterState]);

  // Feature 7 — header click. Plain click ALWAYS collapses to a fresh single-sort
  // on that column (dropping any secondary/tertiary keys) — except when it's
  // already the sole active key, where it keeps the old asc→desc→(clear) cycle.
  // Shift+click appends `key` as the next-priority sort key (stable, in order);
  // shift-clicking a key already IN the list cycles its own direction the same
  // asc→desc→(drop-from-list) way, without disturbing the other active keys.
  const clickSort=(key,shift)=>{
    if(shift){
      setSort(cur=>{
        const list=cur||[];
        const idx=list.findIndex(s=>s.key===key);
        if(idx<0) return [...list,{key,dir:'asc'}];
        if(list[idx].dir==='asc'){ const next=list.slice(); next[idx]={key,dir:'desc'}; return next; }
        return list.filter(s=>s.key!==key);
      });
      return;
    }
    setSort(cur=>{
      const list=cur||[];
      if(list.length===1&&list[0].key===key){
        if(list[0].dir==='asc') return [{key,dir:'desc'}];
        return [];
      }
      return [{key,dir:'asc'}];
    });
  };

  const align=(c)=>c.align||(c.mono?'right':'left');
  const isNum=(c)=>align(c)==='right';
  const rowIdOf=i=>id?(id+'-r-'+i):null;
  const scrollTo=i=>{ const rid=rowIdOf(i);
    const go=()=>{ const el=rid&&document.getElementById(rid); if(el&&el.scrollIntoView) el.scrollIntoView({block:'nearest'}); };
    go(); if(scrollBody) requestAnimationFrame(go); }; // scrollBody: retry after progressive render paints the row
  const openPeekAt=i=>{
    if(!power||!renderPeek) return;
    const r=(scrollBody?sorted:visible)[i]; if(!r) return;
    power.setPeek({tableId:id,render:renderPeek,row:r,
      title:String((columns[0]&&r[columns[0].key])||keyOf(r,i)),
      onFull:onRowClick?()=>onRowClick(r,i):null, returnFocus:wrapRef.current});
  };
  const syncPeek=i=>{ if(power&&power.peek&&power.peek.tableId===id) openPeekAt(i); };
  const clearSel=()=>{ setSelected(new Set()); lastClickRef.current=null; };

  const check=(key,shift)=>{
    const i=visible.findIndex((r,idx)=>keyOf(r,idx)===key);
    setSelected(prev=>{
      const n=new Set(prev);
      if(shift&&lastClickRef.current!=null&&i>=0){
        const a=Math.min(lastClickRef.current,i),b=Math.max(lastClickRef.current,i);
        for(let j=a;j<=b;j++) n.add(keyOf(visible[j],j));
      } else { if(n.has(key)) n.delete(key); else n.add(key); }
      return n;
    });
    if(i>=0) lastClickRef.current=i;
  };

  const buildActions=(rws)=>{
    const acts=[];
    if(showCsv) acts.push({label:'Export CSV',run:()=>downloadCSV(String(csvName||tableId||'export')+'-selected.csv',rws,columns)});
    acts.push({label:'Copy',run:()=>{
      const col=columns.find(c=>c.copy)||columns[0]||{key:'value'};
      const txt=rws.map(r=>String(r[col.key]??'')).join('\n');
      if(navigator.clipboard&&navigator.clipboard.writeText) navigator.clipboard.writeText(txt);
      toast('Copied '+rws.length+' row'+(rws.length===1?'':'s'),'ok');
    }});
    acts.push({label:'Watchlist',run:()=>{
      const prev=LS.get('watchlist',[]);
      const {tab,params}=parseHash();
      const adds=rws.map((r,i)=>({key:keyOf(r,i),label:String((columns[0]&&r[columns[0].key])||keyOf(r,i)),tab,params,added:Date.now()}));
      LS.set('watchlist',[...prev,...adds]);
      flash(adds.map(a=>a.key));
      clearSel();
      toast(adds.length+' added · Undo','ok',{duration:5000,action:{label:'Undo',run:()=>LS.set('watchlist',prev)}});
    }});
    // Feature 8 — READ-ONLY bulk verbs on the current selection. No mutations.
    // 1) Export subset — the selected rows to CSV (works even where showCsv is off).
    acts.push({label:'Export subset',run:()=>{
      downloadCSV(String(csvName||tableId||'export')+'-subset.csv',rws,columns);
      toast('Exported '+rws.length+' row'+(rws.length===1?'':'s'),'ok',{duration:1500});
    }});
    // 2) Copy as — Group B's serializers applied across the whole selection.
    const copyBulk=txt=>{ if(navigator.clipboard&&navigator.clipboard.writeText) navigator.clipboard.writeText(txt); };
    const announce=fmt=>toast('Copied '+rws.length+' row'+(rws.length===1?'':'s')+' as '+fmt,'ok',{duration:1500});
    acts.push({label:'Copy as',menu:[
      {label:'CSV',run:()=>{ const h=columns.map(c=>JSON.stringify(c.label||c.key||c)).join(',');
        copyBulk(h+'\n'+rws.map(r=>csvRowLine(columns,r)).join('\n')); announce('CSV'); }},
      {label:'JSON',run:()=>{ copyBulk(JSON.stringify(rws)); announce('JSON'); }},
      {label:'BQL filter',run:()=>{ copyBulk(rws.map(r=>'('+rowAsBQL(columns,r)+')').join(' OR ')); announce('BQL filter'); }},
      {label:'Markdown',run:()=>{ const head='| '+columns.map(c=>String(c.label||c.key)).join(' | ')+' |';
        const sep='| '+columns.map(()=>'---').join(' | ')+' |';
        copyBulk([head,sep,...rws.map(r=>rowAsMarkdown(columns,r))].join('\n')); announce('Markdown'); }},
    ]});
    // 3) Pivot to filter — every field the selection SHARES a single scalar value on
    // becomes a FilterCtx filter (funnels into the same fx used by cell-pivots).
    acts.push({label:'Pivot to filter',run:()=>{
      let added=0;
      columns.forEach(c=>{
        if(!c.key||String(c.key).startsWith('__')) return;
        const vals=new Set();
        for(const r of rws){ const v=r[c.key];
          if(v==null||v===''||typeof v==='object'){ vals.add(' '); } else vals.add(String(v)); }
        if(vals.size!==1) return;
        const only=[...vals][0]; if(only===' ') return;
        if(!fx.has(c.key,only)){ fx.add(c.key,only,(c.label||c.key)+': '+only); added++; }
      });
      toast(added?('Pivoted to '+added+' filter'+(added===1?'':'s')):'No shared values to pivot on',added?'ok':'err',{duration:1800});
    }});
    if(typeof bulkActions==='function'){
      (bulkActions(rws)||[]).forEach(a=>acts.push({...a,run:()=>{
        const out=a.run&&a.run();
        if(a.flash) flash(rws.map((r,i)=>keyOf(r,i)));
        return out;
      }}));
    }
    return acts;
  };

  // Imperative api — reassigned each render so closures see current state.
  apiRef.current={
    move(delta){ const len=scrollBody?sorted.length:visible.length; setCursor(c=>{ let n=c<0?0:c+delta; n=Math.max(0,Math.min(len-1,n)); if(scrollBody) setRenderLimit(rl=>Math.max(rl,n+50)); scrollTo(n); syncPeek(n); return n; }); return true; },
    openCursor(){ const i=cursor<0?0:cursor; const r=visible[i]; if(!r) return false;
      if(renderPeek){ setCursor(i); openPeekAt(i); return true; }
      if(onRowClick){ onRowClick(r,i); return true; } return false; },
    toggleSelect(){ if(!selectable||cursor<0||cursor>=visible.length) return false; check(keyOf(visible[cursor],cursor),false); return true; },
    copyCursorRow(){ if(cursor<0||cursor>=visible.length) return false;
      const row=visible[cursor];
      if(navigator.clipboard&&navigator.clipboard.writeText) navigator.clipboard.writeText(JSON.stringify(row));
      toast('Row copied (JSON)','ok',{duration:1500}); return true; },
    // Slice 6 — the row the `p` (pin) macro targets: the cursor row, or the first
    // row when no cursor is set yet (mirrors openCursor's cursor<0?0 default).
    pinTarget(){ const i=cursor<0?0:cursor; return (scrollBody?sorted:visible)[i]||null; },
    focusFilter(){ if(!filterable) return false; if(filterRef.current){ filterRef.current.focus(); return true; } return false; },
    // F6: imperative setter so the command palette can inject a query token
    // (e.g. last:24h) into THIS table's own search input — same state the
    // typed input already drives, no new global control.
    setFilter(v){ if(!filterable) return false; setFilter(v); return true; },
    gotoTop(){ if(!visible.length) return false; setCursor(0); scrollTo(0); syncPeek(0); return true; },
    gotoBottom(){ const len=scrollBody?sorted.length:visible.length; if(!len) return false; const i=len-1; if(scrollBody) setRenderLimit(rl=>Math.max(rl,len)); setCursor(i); scrollTo(i); syncPeek(i); return true; },
    clearOrCursor(){ if(selected.size>0){ clearSel(); return true; } if(cursor>=0){ setCursor(-1); return true; } return false; },
    activate(key){ const i=visible.findIndex((r,idx)=>keyOf(r,idx)===key); if(i<0) return; if(onRowClick) onRowClick(visible[i],i); },
    check,
    getState(){
      const keyRow=new Map(); data.forEach((r,i)=>keyRow.set(keyOf(r,i),r));
      const selRows=[...selected].map(k=>keyRow.get(k)).filter(Boolean);
      return {selected,selectedRows:selRows,cursorRow:(cursor>=0&&cursor<visible.length)?visible[cursor]:null,buildActions,filter,
        rows:sorted,columns};
    },
  };

  // Register / unregister with the power layer (only powered when it has an id).
  useEffect(()=>{
    if(!id||!power) return;
    power.register(id,{label:String(csvName||id),api:apiRef});
    return ()=>power.unregister(id);
  },[id]); // eslint-disable-line

  // Keep the cursor in range when the visible list shrinks.
  useEffect(()=>{ setCursor(c=>c>=visible.length?visible.length-1:c); },[visible.length]);

  // initialPeekKey → open peek once for the matching row (nav {peek:key} handoff).
  // Safety: if the key isn't in `visible` but IS in full data, reveal it once
  // (expand maxRows + turn problemsOnly off), then re-run finds it.
  useEffect(()=>{
    if(initRef.current||!initialPeekKey||!renderPeek) return;
    const key=String(initialPeekKey);
    const i=visible.findIndex((r,idx)=>keyOf(r,idx)===key);
    if(i>=0){ initRef.current=true; setCursor(i); openPeekAt(i); return; }
    if(data.some((r,idx)=>keyOf(r,idx)===key)){
      if(problemsOnly&&probOn) setProb(false);
      if(scrollBody) setRenderLimit(Infinity);        // reveal whole set so the target row renders
      else if(maxRows&&!showAll) setShowAll(true);
    }
  },[initialPeekKey,visible]); // eslint-disable-line

  const allKeys=visible.map((r,i)=>keyOf(r,i));
  const allSel=allKeys.length>0&&allKeys.every(k=>selected.has(k));
  const toggleAll=()=>setSelected(prev=>{ const n=new Set(prev); if(allSel) allKeys.forEach(k=>n.delete(k)); else allKeys.forEach(k=>n.add(k)); return n; });

  const showFilter=filterable!==false&&(filterable||rows.length>12);
  const showToolbar=showCsv||showFilter||problemsOnly||showCols||showFacets;
  const noIssues=problemsOnly&&probOn&&probCount===0;
  // Shared empty-state inputs: which filters are actively hiding rows — this
  // table's own BQL/text query AND any cross-filter chip whose field is a column
  // here — plus one action that clears exactly those (funnels through the same
  // setFilter / fx.remove the FilterBar × already uses).
  const ownFilterActive=!!(filterable&&filter.trim());
  const crossFilters=useMemo(()=>globalFilters.filter(f=>columns.some(c=>c.key===f.field)),[globalFilters,columns]);
  const anyFilterActive=ownFilterActive||crossFilters.length>0;
  const clearAllFilters=useCallback(()=>{
    if(ownFilterActive) setFilter('');
    crossFilters.forEach(f=>fx.remove(f.field,f.value,f.label));
  },[ownFilterActive,crossFilters,fx,setFilter]);

  // ── BQL typeahead: context-sensitive suggestions derived from input + schema ──
  // Operates on the in-progress fragment (text after the last space). Additive &
  // degrades gracefully: no schema fields → generic `field:value` example only.
  const bqlSuggest=useMemo(()=>{
    if(!showFilter) return [];
    const fields=_schema.fields||{}, aliases=_schema.aliases||{};
    const fkeys=Object.keys(fields).filter(k=>k!=='age');
    const typeTag=t=>(t==='number'||t==='age'||t==='cidr')?'num':t==='enum'?'enum':t==='boolean'?'bool':t==='array'?'list':'text';
    const distinctVals=(key,filt,cap)=>{
      const counts={};
      for(let i=0;i<base.length;i++){ const v=base[i]?base[i][key]:undefined; if(v==null) continue;
        (Array.isArray(v)?v:[v]).forEach(x=>{ const s=String(x);
          if(filt&&s.toLowerCase().indexOf(String(filt).toLowerCase())===-1) return; counts[s]=(counts[s]||0)+1; }); }
      return Object.keys(counts).map(k=>({v:k,n:counts[k]})).sort((a,b)=>b.n-a.n).slice(0,cap||8);
    };
    const numRange=(key)=>{ let mn=Infinity,mx=-Infinity;
      for(let i=0;i<base.length;i++){ const v=Number(base[i]?base[i][key]:NaN); if(!isNaN(v)){ if(v<mn)mn=v; if(v>mx)mx=v; } }
      return isFinite(mn)?{mn,mx}:null; };
    const text=filter||'', sp=text.lastIndexOf(' ');
    const frag=text.slice(sp+1), prefix=text.slice(0,sp+1);
    const out=[];
    if(text.trim()===''){
      // Recent-queries dropdown (absorbed query history): pinned first, then most-recent.
      const hist=[...recent.filter(e=>e.pinned),...recent.filter(e=>!e.pinned)].slice(0,8);
      hist.forEach(e=>out.push({t:'recent',label:e.q,value:e.q,pinned:!!e.pinned}));
      if(!hist.length){
        const numF=fkeys.filter(k=>fields[k].type==='number');
        const enumF=fkeys.filter(k=>fields[k].type==='enum'&&fields[k].values&&fields[k].values.length);
        if(numF.length){ const k=numF[0], r=numRange(fields[k].key);
          if(r){ const hi=Math.round(r.mn+(r.mx-r.mn)*0.85); out.push({t:'ex',label:k+'>'+hi,insert:k+'>'+hi,meta:'example'}); } }
        if(enumF.length){ const k=enumF[0]; out.push({t:'ex',label:k+':'+fields[k].values[0],insert:k+':'+fields[k].values[0],meta:'example'}); }
        if(out.length<2&&fkeys.length){ const k=fkeys[0]; out.push({t:'ex',label:k+':…',insert:k+':',meta:'example'}); }
        if(!out.length) out.push({t:'ex',label:'field:value',insert:'',meta:'example'});
      }
      out.push({t:'help',label:'? syntax',meta:'grammar'});
      return out;
    }
    const m=/^(-?)([a-zA-Z0-9_]+)(>=|<=|[:=><])(.*)$/.exec(frag);
    if(m){
      const fld=m[2].toLowerCase(), op=m[3], valPart=m[4];
      const canon=(aliases[fld]!=null)?aliases[fld]:(fields[fld]?fld:null);
      const def=canon&&fields[canon];
      if(def){
        if(def.type==='number'||def.type==='cidr'||def.type==='age'){
          const r=numRange(def.key);
          if(r){
            out.push({t:'op',label:fld+'>'+Math.round(r.mn+(r.mx-r.mn)*0.85),insert:prefix+fld+'>'+Math.round(r.mn+(r.mx-r.mn)*0.85),meta:'above'});
            out.push({t:'op',label:fld+':'+r.mn+'-'+r.mx,insert:prefix+fld+':'+r.mn+'-'+r.mx,meta:'range '+r.mn+'–'+r.mx});
            out.push({t:'op',label:fld+'>='+r.mn,insert:prefix+fld+'>='+r.mn,meta:'at least'});
          } else out.push({t:'op',label:fld+'>value',insert:prefix+fld+'>',meta:'compare'});
          return out;
        }
        distinctVals(def.key,valPart,8).forEach(d=>out.push({t:'val',label:fld+op+d.v,insert:prefix+fld+op+d.v,meta:d.n+' rows'}));
        if(out.length) return out;
      }
    }
    const q=frag.toLowerCase().replace(/^-/,'');
    const cand=[];
    fkeys.forEach(k=>{ if(k.toLowerCase().indexOf(q)===0) cand.push({name:k,type:fields[k].type}); });
    Object.keys(aliases).forEach(a=>{ if(a.toLowerCase().indexOf(q)===0&&fields[aliases[a]]) cand.push({name:a,type:fields[aliases[a]].type,alias:aliases[a]}); });
    cand.slice(0,8).forEach(c=>out.push({t:'field',label:c.name+':',insert:prefix+c.name+':',tag:typeTag(c.type),meta:c.alias?('→ '+c.alias):''}));
    return out;
  },[showFilter,_schema,base,filter,recent]);

  // No-match diagnostic: cumulatively AND tokens left-to-right against `base`;
  // name the first token whose addition takes the visible count to zero.
  const bqlNoMatch=useMemo(()=>{
    if(!filterable||!filter.trim()||!base.length) return null;
    const toks=parseQuery(filter);
    if(!toks.length) return null;
    let rws=base;
    for(let i=0;i<toks.length;i++){
      const next=rws.filter(buildPredicate([toks[i]],_schema));
      if(next.length===0) return {token:(toks[i].raw||toks[i].value||String(toks[i].field||''))};
      rws=next;
    }
    return null;
  },[filterable,filter,base,_schema]);
  // NL→BQL: sends the current (plain-English) input text to the existing
  // /api/query AI endpoint with a translation-style prompt fed the table's
  // real field names, then fills the search box with the generated query —
  // visible and still editable, never a hidden black box.
  const translateNL=()=>{
    const q=filter.trim();
    if(!q||nlBusy) return;
    setNlBusy(true);
    const fieldList=Object.keys(_schema.fields||{}).filter(k=>k!=='age').join(', ')||'(none)';
    const prompt='Translate this into a single-line BQL search-box query for a data table. '
      +'Only use these exact field names: '+fieldList+'. '
      +'Syntax: field:value contains, field=value exact, field>N/>=N/<N/<=N compare (numbers or ages like 5m/2h/3d), '
      +'field:lo-hi range, field:a,b any-of, -term exclude, bare words free text. '
      +'Reply with ONLY the query string — no explanation, no markdown, no quotes.\n\nRequest: '+q;
    fetch('/api/query',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({question:prompt,context:''})})
      .then(async r=>{const j=await r.json().catch(()=>null);return {r,j};})
      .then(({r,j})=>{
        if(r.status===503||(j&&j.locked)){ toast('Vault locked — unlock to translate.','err'); return; }
        if(j&&j.error){ toast('Translate failed: '+String(j.error),'err'); return; }
        const bql=cleanBqlAnswer((j&&typeof j.answer==='string')?j.answer:'');
        if(!bql){ toast('No query generated','err'); return; }
        setFilter(bql);
        setSugOpen(false);
        toast('Generated: '+bql,'ok');
        if(filterRef.current) filterRef.current.focus();
      })
      .catch(()=>toast('Translate failed — server unreachable','err'))
      .finally(()=>setNlBusy(false));
  };
  // scrollBody: grow the progressive render window as the user nears the bottom.
  const onBodyScroll=(e)=>{ const el=e.currentTarget;
    if(el.scrollHeight-el.scrollTop-el.clientHeight<200)
      setRenderLimit(rl=>rl<sorted.length?Math.min(sorted.length,rl+300):rl); };
  return <div ref={wrapRef}
    tabIndex={id?0:undefined}
    role={id?'grid':undefined}
    aria-activedescendant={(id&&cursor>=0)?rowIdOf(cursor):undefined}
    onMouseEnter={id&&power?()=>power.setActive(id):undefined}
    onFocus={id&&power?()=>power.setActive(id):undefined}
    style={id?{outline:'none'}:undefined}>
    {showToolbar&&<div className="dt-toolbar" style={{justifyContent:(showFilter||problemsOnly)?'space-between':'flex-end'}}>
      <div style={{display:'flex',alignItems:'center',gap:'var(--s2)',minWidth:0}}>
        {showFilter?<div className="dt-search">
          <input ref={filterRef} className="dt-filter mono" value={filter}
            onChange={e=>{setFilter(e.target.value); setSugOpen(true); setSugIdx(-1);}}
            onFocus={()=>setSugOpen(true)}
            onBlur={()=>setTimeout(()=>setSugOpen(false),120)}
            onKeyDown={e=>{
              if(e.key==='Escape'){ if(sugOpen||cheatOpen){ e.preventDefault(); e.stopPropagation(); setSugOpen(false); setCheatOpen(false); } return; }
              if(e.key==='Enter'){
                if(bqlSuggest.length&&sugOpen&&sugIdx>=0){
                  const s=bqlSuggest[sugIdx];
                  if(s){
                    e.preventDefault();
                    if(s.t==='help'){ setCheatOpen(true); setSugOpen(false); return; }
                    if(s.t==='recent'){ setFilter(s.value); pushRecent(s.value); setSugOpen(false); setSugIdx(-1); return; }
                    if(s.insert!=null){ setFilter(s.insert); setSugIdx(-1); return; }
                  }
                }
                // No suggestion highlighted → this Enter commits the typed query: save to recent history.
                if(filter.trim()) pushRecent(filter.trim());
                setSugOpen(false);
                return;
              }
              if(!bqlSuggest.length) return;
              if(e.key==='ArrowDown'){ e.preventDefault(); setSugOpen(true); setSugIdx(i=>Math.min((i<0?-1:i)+1,bqlSuggest.length-1)); }
              else if(e.key==='ArrowUp'){ e.preventDefault(); setSugIdx(i=>Math.max(i-1,0)); }
              else if(e.key==='Tab'&&sugOpen&&sugIdx>=0){
                const s=bqlSuggest[sugIdx]; if(!s) return; e.preventDefault();
                if(s.t==='help'){ setCheatOpen(true); setSugOpen(false); }
                else if(s.t==='recent'){ setFilter(s.value); setSugIdx(-1); }
                else if(s.insert!=null){ setFilter(s.insert); setSugIdx(-1); }
              }
            }}
            placeholder="Filter…" aria-label="Filter rows"
            role="combobox" aria-autocomplete="list" aria-expanded={sugOpen&&bqlSuggest.length>0}
            aria-activedescendant={(sugOpen&&sugIdx>=0&&bqlSuggest.length>0)?('sug-'+sugIdx):undefined}/>
          <button type="button" className="dt-search-icon-btn dt-nl-btn" aria-label="Translate to search query"
            title="Translate plain English into a search query" disabled={nlBusy||!filter.trim()}
            onMouseDown={e=>e.preventDefault()} onClick={translateNL}>{nlBusy?'…':'NL'}</button>
          <button ref={cheatBtnRef} type="button" className="dt-search-icon-btn dt-cheat-btn" aria-label="Search syntax help"
            onMouseDown={e=>e.preventDefault()} onClick={()=>{setCheatOpen(v=>!v); setSugOpen(false);}}>?</button>
          {sugOpen&&bqlSuggest.length>0?<div className="panel dt-popover dt-suggest" role="listbox" aria-label="Search suggestions">
            {bqlSuggest.map((s,i)=> s.t==='recent'
              ? <div key={'recent:'+s.value} id={'sug-'+i} className={'dt-sug-item dt-sug-recent'+(i===sugIdx?' sel':'')} role="option" aria-selected={i===sugIdx}>
                  <button type="button" className="dt-sug-recent-run"
                    onMouseEnter={()=>setSugIdx(i)} onMouseDown={e=>e.preventDefault()}
                    onClick={()=>{ setFilter(s.value); pushRecent(s.value); setSugOpen(false); if(filterRef.current) filterRef.current.focus(); }}>
                    <span className="dt-sug-label mono">{s.label}</span>
                  </button>
                  <button type="button" className="dt-sug-pin" aria-pressed={!!s.pinned}
                    aria-label={(s.pinned?'Unpin ':'Pin ')+s.label}
                    onMouseDown={e=>e.preventDefault()} onClick={()=>togglePin(s.value)}>
                    {s.pinned?'★':'☆'}
                  </button>
                </div>
              : <button key={s.t+':'+(s.label||i)} id={'sug-'+i} type="button"
                  className={'dt-sug-item'+(i===sugIdx?' sel':'')} role="option" aria-selected={i===sugIdx}
                  onMouseEnter={()=>setSugIdx(i)} onMouseDown={e=>e.preventDefault()}
                  onClick={()=>{ if(s.t==='help'){ setCheatOpen(true); setSugOpen(false); }
                    else if(s.insert!=null){ setFilter(s.insert); if(filterRef.current) filterRef.current.focus(); } }}>
                  <span className="dt-sug-label mono">{s.label}</span>
                  <span style={{display:'inline-flex',alignItems:'center',gap:'6px',flex:'0 0 auto'}}>
                    {s.tag?<span className="dt-sug-tag">{s.tag}</span>:null}
                    {s.meta?<span className="dt-sug-meta">{s.meta}</span>:null}
                  </span>
                </button>)}
          </div>:null}
          {cheatOpen?<><div className="views-overlay" onClick={closeCheat}/>
            <div ref={cheatPanelRef} tabIndex={-1} className="panel dt-popover dt-cheat" role="dialog" aria-label="Search syntax"
              onKeyDown={e=>{ if(e.key==='Escape'){ e.preventDefault(); e.stopPropagation(); closeCheat(); } }}>
              <h4>Search syntax</h4>
              <div className="dt-cheat-row"><code>word</code><span>contains</span></div>
              <div className="dt-cheat-row"><code>field:value</code><span>contains</span></div>
              <div className="dt-cheat-row"><code>field=value</code><span>exact match</span></div>
              <div className="dt-cheat-row"><code>{'util>85'}</code><span>compare</span></div>
              <div className="dt-cheat-row"><code>util:90-99</code><span>range</span></div>
              <div className="dt-cheat-row"><code>a,b</code><span>any of</span></div>
              <div className="dt-cheat-row"><code>IN(a,b)</code><span>any of</span></div>
              <div className="dt-cheat-row"><code>-term</code><span>exclude</span></div>
              <div className="dt-cheat-row"><code>{'field!=value'}</code><span>not equal</span></div>
              <div className="dt-cheat-row"><code>{'field~text'}</code><span>contains</span></div>
              <div className="dt-cheat-row"><code>{'field!~text'}</code><span>excludes</span></div>
              <div className="dt-cheat-row"><code>a OR b</code><span>either</span></div>
              <div className="dt-cheat-row"><code>NOT term</code><span>exclude</span></div>
              <div className="dt-cheat-row"><code>{'in:10.0.0.0/8'}</code><span>in subnet</span></div>
              <div className="dt-cheat-fields"><b>Fields:</b> {Object.keys(_schema.fields||{}).filter(k=>k!=='age').join(', ')||'—'}</div>
            </div></>:null}
        </div>:null}
        {problemsOnly?<button className="prob-toggle" aria-pressed={probOn} onClick={()=>setProb(!probOn)}>
          <span>{problemsOnly.label||'Problems only'}</span>
          <span className="prob-count mono">{probCount} of {data.length}</span>
        </button>:null}
      </div>
      <div className="dt-tools">
        {showFacets?<div className="dt-facet-slot">
          <button ref={facetBtnRef} type="button" className="btn btn-ghost" onClick={()=>setFacetOpen(v=>!v)}
            aria-haspopup="true" aria-expanded={facetOpen} aria-label="Filter by field values" title="Filter by field values">
            Filter{globalFilters.some(f=>facetCols.some(c=>c.key===f.field))?' •':''}
          </button>
          {facetOpen?<><div className="views-overlay" onClick={closeFacets}/>
            <div ref={facetMenuRef} className="panel dt-popover dt-facet-menu" role="dialog" aria-label="Filter by field values"
              onKeyDown={e=>{ if(e.key==='Escape'){ e.preventDefault(); e.stopPropagation(); closeFacets(); } }}>
              {facetData.length===0
                ? <div className="dt-facet-empty">No values to filter</div>
                : facetData.map(g=><div key={g.key} className="dt-facet-group">
                    <div className="dt-facet-label">{g.label}</div>
                    {g.values.map(fv=>{
                      const on=fx.has(g.key,fv.v)||bqlHasEquality(g.key,fv.v);
                      const lbl=g.label+': '+fv.v;
                      return <button key={fv.v} type="button" className={'dt-facet-item'+(on?' active':'')}
                        aria-pressed={on} aria-label={(on?'Remove filter ':'Filter to ')+lbl}
                        onClick={()=>{
                          const adding=!fx.has(g.key,fv.v);
                          fx.toggle(g.key,fv.v,lbl);
                          mirrorFacetToken(g.key,fv.v,adding);
                          if(adding) toast('Filtered to '+lbl,'ok',{duration:1500});
                        }}>
                        <span className="dt-facet-val">{fv.v}</span>
                        <span className="dt-facet-count mono">{fv.n}</span>
                      </button>;
                    })}
                  </div>)}
            </div></>:null}
        </div>:null}
        {showCols?<div className="dt-cols-slot">
          <button ref={colsBtnRef} className="btn btn-ghost" onClick={()=>setColsMenu(v=>!v)}
            aria-haspopup="true" aria-expanded={colsMenu} title="Show/hide, reorder, and pin columns">⋯ Cols</button>
          {colsMenu?<><div className="views-overlay" onClick={closeColsMenu}/>
            <div className="panel dt-popover dt-cols-menu" ref={colsMenuRef} role="group" aria-label="Manage columns"
              onKeyDown={e=>{ if(e.key==='Escape'){ e.preventDefault(); e.stopPropagation(); closeColsMenu(); } }}>
              {orderedAll.map((c,i)=>{
                const label=c.label||c.key;
                const hidden=hiddenCols.includes(c.key);
                const lastVisible=!hidden && (columns.length-hiddenCols.length)<=1;
                const pinned=pinnedCol===c.key;
                return <div key={c.key} className="dt-cols-item">
                  <label className="dt-cols-item-label">
                    <input type="checkbox" checked={!hidden} disabled={lastVisible}
                      onChange={()=>toggleCol(c.key)} aria-label={(hidden?'Show ':'Hide ')+label+' column'}/>
                    <span>{label}{pinned?' · Pinned':''}</span>
                  </label>
                  <span className="dt-cols-item-ctl">
                    <button type="button" className="dt-cols-move" disabled={i===0}
                      aria-label={'Move '+label+' up'} onClick={()=>moveCol(c.key,-1)}>↑</button>
                    <button type="button" className="dt-cols-move" disabled={i===orderedAll.length-1}
                      aria-label={'Move '+label+' down'} onClick={()=>moveCol(c.key,1)}>↓</button>
                    <button type="button" className="dt-cols-pin" aria-pressed={pinned}
                      aria-label={(pinned?'Unpin ':'Pin ')+label+' column'}
                      onClick={()=>togglePinCol(c.key)}>{pinned?'★':'☆'}</button>
                  </span>
                </div>;
              })}
            </div></>:null}
        </div>:null}
        {showCsv?<button className="btn btn-ghost" onClick={()=>downloadCSV(String(csvName||tableId||'export')+'.csv',sorted,columns)}>CSV</button>:null}
      </div>
    </div>}
    <div className={"tbl-wrap"+(scrollBody?" dt-scroll":"")}
      style={scrollBody?{maxHeight:scrollPx,overflowY:'auto'}:undefined}
      onScroll={scrollBody?onBodyScroll:undefined}>
      {/* min-width floor: table.dt is width:100%+table-layout:fixed (index.html), so
          it always shrinks to the container and the .tbl-wrap overflow-x scroller
          never engages — a 13-col table in a 313px panel gets ~24px/col and the
          headers turn to mush. table-layout:fixed distributes the table's OWN
          width (not per-cell min-width, which it ignores — see the width-vs-
          min-width note on cells above), so this is set on <table> itself:
          effCols.length * a ~90px readable floor, plus the narrower fixed-width
          gutters (dt-check 28px, dt-diff 20px, dt-acts 28px — index.html
          --dt-actions-w) that aren't part of effCols. Wide containers never see
          this (the browser only enforces min-width once it exceeds 100%), so
          ordinary 4-6 column tables are pixel-identical to before. */}
      <table className="dt" style={{minWidth:effCols.length*90+(selectable?28:0)+(diffMap?20:0)+28}}>
        <thead><tr>
          {diffMap?<th className="dt-diff" aria-label="Diff status"></th>:null}
          {selectable?<th className="dt-check"><input type="checkbox" checked={allSel} onChange={toggleAll} aria-label="Select all rows"/></th>:null}
          {effCols.map(c=>{
            const sIdx=(sort||[]).findIndex(s=>s.key===c.key);
            const sEntry=sIdx>=0?sort[sIdx]:null;
            // Order badge (1·2·3…) only appears once 2+ sort keys are active — a
            // single active key keeps the bare arrow (unchanged text, old tests
            // assert `.sort-ind` is exactly '↑'/'↓').
            const badge=(sEntry&&sort.length>1)?String(sIdx+1):'';
            const arrow=sEntry?(sEntry.dir==='asc'?'↑':'↓'):'';
            {/* title = the LABEL (never row data — see the custom-render tooltip leak fix):
                headers are now clipped+ellipsised, so this is the only way to read a
                truncated column name. */}
            return <th key={c.key} title={String(c.label!=null?c.label:c.key)}
              className={(isNum(c)?'num':'')+(c.hideSm?' hide-sm':'')+(c.primary?' dt-primary':'')}
              style={(()=>{const w=c.width!=null?c.width:(c.minWidth!=null?c.minWidth:(c.primary?120:null));return w!=null?{width:w}:null;})()}
              aria-sort={sEntry?(sEntry.dir==='asc'?'ascending':'descending'):'none'}
              tabIndex={0}
              onKeyDown={e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();clickSort(c.key,e.shiftKey);}}}
              onClick={e=>clickSort(c.key,e.shiftKey)}>
              {c.label!=null?c.label:c.key}
              <span className="sort-ind">{badge?<b className="sort-order">{badge}</b>:null}{arrow}</span>
            </th>;
          })}
          {/* Row-actions gutter — deliberately unlabeled (an icon-only kebab needs no
              column head); the a11y name lives on each row's own trigger. */}
          <th className="dt-acts"></th>
        </tr></thead>
        <tbody>
          {visible.length===0
            ? <tr><td className="dt-empty" colSpan={(effCols.length||1)+1+(selectable?1:0)+(diffMap?1:0)}>
                {noIssues
                  ? <span className="prob-none">No issues · <button className="prob-none-btn" onClick={()=>setProb(false)}>Show all {data.length}</button></span>
                  : anyFilterActive
                    ? <EmptyState
                        note={bqlNoMatch
                          ? <span className="dt-nomatch">no rows — <code className="mono">{bqlNoMatch.token}</code> matches 0</span>
                          : 'Active filters are hiding all rows.'}
                        chips={[...(ownFilterActive?[filter.trim()]:[]),...crossFilters.map(f=>f.label)]}
                        onClear={clearAllFilters}/>
                    : <EmptyState label="No rows"/>}
              </td></tr>
            : visible.map((r,ri)=>{
                const rk=keyOf(r,ri);
                return <DTRow key={rk} r={r} rkey={rk} cols={effCols} rowId={rowIdOf(ri)}
                  isCursor={ri===cursor} isSel={selected.has(rk)} isFlash={flashed.has(rk)}
                  clickable={!!onRowClick} selectable={!!selectable} rowApi={apiRef}
                  diff={diffMap?diffMap.get(rk):null} showDiff={!!diffMap}/>;
              })}
          {/* Compare-to-snapshot ghosts: prior rows absent from the current table —
              struck-through, non-interactive, glyph+label only (no color signal). */}
          {diffGhosts&&diffGhosts.length?diffGhosts.map((r,gi)=>{
            const gk='ghost-'+(rowKey?String(rowKey(r)):gi);
            return <tr key={gk} className="dt-ghost">
              {diffMap?<td className="dt-diff mono"><span aria-label="removed" title="removed">−</span></td>:null}
              {selectable?<td className="dt-check"/>:null}
              {effCols.map(c=>{
                let content; const raw=r[c.key];
                if(c.spark){ const sv=c.spark(r); content=(Array.isArray(sv)&&sv.length>=2)?<Sparkline values={sv}/>:'—'; }
                else content=safeCellContent(c.render?c.render(raw,r):raw);
                return <td key={c.key} className={(isNum(c)?'num ':'')+(c.mono?'mono':'')+(c.hideSm?' hide-sm':'')}>{content}</td>;
              })}
            </tr>;
          }):null}
        </tbody>
      </table>
    </div>
    {scrollBody&&sorted.length>30?<div className="dt-more">
      <span className="dt-count mono">{sorted.length} rows</span>
    </div>:null}
    {!scrollBody&&maxRows&&sorted.length>maxRows?<div className="dt-more">
      {showAll
        ? <button className="dt-more-btn" onClick={()=>setShowAll(false)}>Show fewer</button>
        : <><span className="mono">Showing {visible.length} of {sorted.length}</span><span>·</span>
            <button className="dt-more-btn" onClick={()=>setShowAll(true)}>Show all</button></>}
    </div>:null}
    {selectable&&selected.size>0?<ActionBar count={selected.size} actions={buildActions(apiRef.current.getState().selectedRows)} onClear={clearSel}/>:null}
  </div>;
}

/* 9. Skeleton loader (shimmer-free). */
function Skeleton({rows=4,label}){
  const widths=[62,88,50,74,42,68];
  return <div aria-busy="true" aria-label={label||'Loading'} style={{padding:'6px 2px'}}>
    {label?<span className="skel-note"><span className="skel-spin" aria-hidden="true"/>{label}</span>:null}
    {Array.from({length:rows}).map((_,i)=>
      <span key={i} className="skel skel-row" style={{width:widths[i%widths.length]+'%'}}/>)}
  </div>;
}

/* ─────────────────────────────────────────────────────────────
   Shared state triad — Loading / Empty / Error. Loading is <Skeleton/>
   (above); Empty + Error live here. ONE standard render every panel and
   table inherits so a blank dark surface never reads as "broken".
   ───────────────────────────────────────────────────────────── */

// ErrorState — inline, semantic (--crit + the literal word "Error", never
// color alone), shows the ACTUAL message and a real, keyboard-reachable Retry.
function ErrorState({error,onRetry}){
  const msg=(error&&error!==true)?String((error&&error.message)||error):'Request failed';
  return <div className="dt-state dt-error" role="alert">
    <span className="dt-error-msg"><span className="dt-error-tag">Error</span>{msg}</span>
    {onRetry?<button type="button" className="fresh-retry" onClick={onRetry}>Retry</button>:null}
  </div>;
}

// EmptyState — "No rows". When filters/BQL are hiding the rows, say so, show the
// active filter chips, and offer a one-click Clear that actually drops them.
function EmptyState({label,note,chips,onClear}){
  return <div className="dt-state dt-empty-state" aria-live="polite">
    <span className="dt-empty-title">{label||'No rows'}</span>
    {note?<span className="dt-empty-note">{note}</span>:null}
    {chips&&chips.length?<span className="dt-empty-chips">
      {chips.map((c,i)=><span key={i} className="chip">{c}</span>)}
    </span>:null}
    {onClear?<button type="button" className="dt-clear-btn" onClick={onClear}>Clear filters</button>:null}
  </div>;
}

/* ─────────────────────────────────────────────────────────────
   6. Hash router — parse #tab?k=v. Legacy redirects. nav() helper.
   ───────────────────────────────────────────────────────────── */
