/* ── HelpModal — plain-English reference for every top-level control, opened from
   the ⋯ More menu ("Help"). Same modal pattern as ShortcutsHelp (src/98): scrim +
   focus-trap + Esc-to-close + `.panel` styling. Scrollable, sectioned; all copy is
   code-verified. Controlled via {open,onClose} instead of self-managing a hotkey. ── */
const HELP_SECTIONS=[
  ['Scratchpad',"A pin-tray for entities. Press `p` on a table row, or 'Pin to scratchpad' in a peek, and items collect in the 'Pinned N' pill at the bottom-right. Open it to trace across tabs, export CSV, or clear. Saved in your browser."],
  ['Watches',"Save a table search (a BQL query) and see a live count of how many rows match right now. Search a table, then 'Watch current query…', click a saved watch to re-run it. Counts only — for real notifications use the Alerts view."],
  ['Views',"Save the current tab and its filters as a named snapshot you can jump back to. Server-saved and groupable into folders. 'Save current…' to add one."],
  ['Wallboard',"A full-screen, hands-off NOC display for a wall monitor — Overview / Network / Security auto-rotate every ~30 seconds. Press Esc or 'Exit' to return."],
  ['Time range',"Scope charts and tables to a recent window (15m / 1h / 24h / 7d), or All to remove the limit. Saved in the URL so you can share or reload it. Currently respected by time-aware panels such as Security; more coming."],
  ['Density',"Compact vs comfortable data-table row size. Affects the sortable data tables (not overview tiles or charts)."],
  ['Theme',"Light or dark, saved per browser."],
  ['Command palette (⌘K)',"Jump to any tab, action, or saved view by typing."],
  ['Keyboard shortcuts',"Press `?` anywhere for the full shortcut list. Highlights: `p` pin row · `⌘K` palette · `?` shortcuts."],
];
function HelpModal({open,onClose}){
  const dialogRef=useRef(null),returnRef=useRef(null);
  useEffect(()=>{ if(open) returnRef.current=document.activeElement; },[open]);
  const close=useCallback(()=>{ onClose&&onClose();
    const r=returnRef.current; if(r&&r.focus){ try{r.focus();}catch(e){} } },[onClose]);
  useEffect(()=>{ if(!open||!dialogRef.current) return;
    const f=dialogRef.current.querySelector('button'); if(f) f.focus(); },[open]);
  if(!open) return null;
  const onKeyDown=e=>{
    if(e.key==='Escape'){ e.preventDefault(); e.stopPropagation(); close(); return; }
    if(e.key==='Tab'){
      const f=dialogRef.current?Array.from(dialogRef.current.querySelectorAll('button,[href],[tabindex]:not([tabindex="-1"])')):[];
      if(!f.length) return;
      const first=f[0],last=f[f.length-1];
      if(e.shiftKey&&document.activeElement===first){ e.preventDefault(); last.focus(); }
      else if(!e.shiftKey&&document.activeElement===last){ e.preventDefault(); first.focus(); }
    }
  };
  return <div className="sc-scrim" onClick={close}>
    <div ref={dialogRef} className="sc-overlay panel" role="dialog" aria-modal="true" aria-label="Help — what each control does"
      onClick={e=>e.stopPropagation()} onKeyDown={onKeyDown}>
      <div className="sc-head">
        <h2 className="sc-title">Help — what each control does</h2>
        <div className="sc-head-acts">
          <button className="btn btn-ghost" onClick={close} aria-label="Close help">Close</button>
        </div>
      </div>
      <div className="help-list">
        {HELP_SECTIONS.map(([title,body],i)=><section key={i} className="help-sec">
          <h3 className="help-sec-title">{title}</h3>
          <p className="help-sec-body">{body}</p>
        </section>)}
      </div>
    </div>
  </div>;
}
