# Plan 020 — Consolidate the 4 write-surfaces into one "Provision" group

## Goal (success criteria)
- Top-level tab bar drops from 12 → 9 tabs: `Provision`, `Drift`, `Self-Service`, `Editor`
  collapse into a single top-level **Provision** tab that holds them as a `.dly-seg` sub-tab bar.
- Legacy deep-links (`#editor?type=host`, `#drift`, `#selfservice`, `#provision`) keep working
  unchanged via a `parseHash` remap — zero callsite edits needed.
- Editor stops embedding the whole Self-Service tool: `dns_record` + `ip_address` types are
  removed from Editor (Self-Service already owns records + IP allocation). No more nested
  double tab-bar / double "Self-Service" header.
- All 4 tools still reachable, still work end-to-end (already verified live on :8080).
- `test_regression.py` passes (assertions updated to the grouped route, coverage NOT weakened).

## Single file: `index.html` (+ `test_regression.py` assertions). Zero backend change.

### Already exists — do NOT recreate (edit in place):
- `TABS` array — `index.html:3051`
- `TAB_LABELS` — `3052`; `TAB_DESCRIPTIONS` — `3055` (leave all keys; harmless)
- `parseHash()` — `3073`; the `if(!TABS.includes(tab)) tab='overview';` gate is at **3089**
- `nav(tab,params)` — `3100` (do NOT change)
- `EDITOR_TYPES` — `8381`; `EditorTab` — `8403`; the embed branch — `8515`
- `TAB_COMPONENTS` map — `8970`
- `CommandPalette` tab entries (`...TABS.map(...)`) — `8711`
- `SelfServiceTab` `7306`, `ProvisionTab` `7827`, `EditorTab` `8403`, `DriftTab` `8568` — all
  KEEP as-is (they become the group's children). `.dly-seg` / `.dly-seg-btn` CSS already exists.

### Edits

1. **`TABS` (3051)** — remove `'drift','selfservice','editor'`; keep `'provision'`:
   `const TABS=['overview','daily','network','dns','infra','security','incidents','audit','provision'];`

2. **`parseHash` remap** — insert immediately BEFORE the `if(!TABS.includes(tab)) tab='overview';`
   line at 3089:
   ```js
   // Legacy standalone routes for the write-surfaces now live under the Provision
   // group as a ?tool= sub-route. Remap old hashes so deep-links/bookmarks survive.
   const PROVISION_TOOL_ROUTES={selfservice:1,editor:1,drift:1};
   if(PROVISION_TOOL_ROUTES[tab]){ params.tool=tab; tab='provision'; }
   ```
   (`#provision` needs no remap — it is the group key and its default tool.)

3. **`PROVISION_TOOLS` const + `ProvisionGroupTab`** — add just ABOVE `TAB_COMPONENTS` (≈8968).
   Order = workflow, `provision` first so it is the default-active tool for `#provision`:
   ```js
   const PROVISION_TOOLS=[
     {key:'provision',  label:'Provision',    comp:ProvisionTab},
     {key:'selfservice',label:'Self-Service', comp:SelfServiceTab},
     {key:'editor',     label:'Editor',       comp:EditorTab},
     {key:'drift',      label:'Drift',        comp:DriftTab},
   ];
   // ProvisionGroupTab — one top-level tab that hosts the four write-surfaces as a
   // .dly-seg sub-tab bar. Active tool comes from ?tool= (default 'provision').
   function ProvisionGroupTab(props){
     const {params}=useRoute();
     const found=PROVISION_TOOLS.find(t=>t.key===params.tool);
     const active=found?found.key:'provision';
     const Active=(found||PROVISION_TOOLS[0]).comp;
     return <div className="page fadein">
       <div className="dly-seg" role="group" aria-label="Provisioning tools"
            style={{marginBottom:'var(--s3)'}}>
         {PROVISION_TOOLS.map(t=>
           <button key={t.key} className={'dly-seg-btn'+(t.key===active?' on':'')}
             aria-current={t.key===active?'page':undefined}
             onClick={()=>nav('provision',{tool:t.key})}>{t.label}</button>)}
       </div>
       <Active {...props}/>
     </div>;
   }
   ```

4. **`TAB_COMPONENTS` (8970)** — replace the four entries `provision/drift/selfservice/editor`
   with a single `provision:ProvisionGroupTab,` (delete the drift/selfservice/editor keys).

5. **Editor dedupe:**
   - `EDITOR_TYPES` (8382–8383): delete the `dns_record` and `ip_address` entries. Leaves the
     6 FIELD_SPECS-backed object types (DNS Zone / Subnet / Address Block / DHCP Range / Host / Tags).
   - `initialType` default (8409): change fallback `'dns_record'` → `'dns_zone'`.
   - Embed branch (8515–8517): remove the
     `{(type==='dns_record'||type==='ip_address') ? <SelfServiceTab/> : <div className="grid-2">…}`
     ternary — render the `<div className="grid-2">…</div>` form unconditionally.
   - Update the EditorTab doc-comment (8403) to drop the "dns_record and ip_address reuse
     SelfServiceTab" sentence — reflect that Editor now handles the 6 object types only.

6. **CommandPalette (8711)** — after the `...TABS.map(...)` spread, add per-tool entries so all
   four are still jump-to-able:
   ```js
   ...PROVISION_TOOLS.map(t=>({label:'Go to Provision · '+t.label,kind:'nav',
     run:()=>{nav('provision',{tool:t.key});onClose();}})),
   ```

7. **`test_regression.py`** — run it; update ONLY assertions that break due to the nav
   restructure (e.g. any that assert `selfservice`/`editor`/`drift` are top-level `TABS`
   members, or that Editor renders a DNS-record surface). Keep asserting the 4 tool components
   still exist and are reachable under the group. Do NOT delete real coverage — re-point it.

### Verify (must pass before done)
- `python3 test_regression.py` green (or the pre-existing red baseline unchanged — see plan 013).
- Manual/route sanity: `#provision`, `#provision?tool=selfservice`, `#drift`, `#editor?type=host`
  all resolve to the group with the right tool active; top bar shows 9 tabs; Editor shows 6
  types with no embedded Self-Service.
