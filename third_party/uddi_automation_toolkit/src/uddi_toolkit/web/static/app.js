// UDDI Toolkit Web UI — app.js
'use strict';

// ── Global state ────────────────────────────────────────────────────────────

let currentTemplate = null;   // filename of template currently loaded on server
let currentTemplateType = 'site';  // 'site' | 'address-block' | 'dns'
let currentTab      = 'builder';

// Map of template name -> type, populated from /api/templates listing
const _templateTypes = {};

// Raw-YAML skeletons seeded when creating a non-site template
const TYPE_SKELETONS = {
  'address-block':
`type: address-block
name: my-block-pool
# ip_space: my-ip-space   # optional, overrides INI default
address_blocks:
  - address: 10.0.0.0
    cidr: 16
    region: EMEA
    environment: production
    status: available
    tags:
      Owner: network-team
    children:
      - address: 10.0.0.0
        cidr: 18
tags:
  CostCentre: CC-0000
`,
  'dns':
`type: dns
# view: default           # optional, overrides INI dns_view
zones:
  - fqdn: corp.example.com
    kind: forward
    create: true
    records:
      - name: www
        type: A
        rdata: 10.0.1.10
      - name: mail
        type: MX
        rdata: {preference: 10, exchange: mail.corp.example.com}
tags:
  Owner: dns-team
`,
};

// Builder form state
let builderType = 'site';   // which form the Builder is currently showing
let subnets  = [];
let hosts    = [];
let tags     = [];
// address-block builder: [{id, address, cidr, region, environment, status,
//   location, comment, children:[{id, address, cidr, region, environment, status, comment}]}]
let blocks   = [];
// dns builder: [{id, fqdn, kind, primary_type, create, comment,
//   records:[{id, name, type, rdata, preference, exchange, ttl}]}]
let zones    = [];
let nextId   = 1;

// ── Init ────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  loadConfig();
  refreshTemplates();
  seedBuilder('site');
  builderUpdate();
  updateExecControls();
});

// ── Config banner ────────────────────────────────────────────────────────────

function loadConfig() {
  fetch('/api/config')
    .then(r => r.json())
    .then(cfg => {
      document.getElementById('status-dot').className = 'ok';
      document.getElementById('status-dot').title = 'Server connected';
      const parts = [];
      if (cfg.url)        parts.push(cfg.url);
      if (cfg.ip_space)   parts.push('space: ' + cfg.ip_space);
      if (cfg.dns_parent) parts.push('parent: ' + cfg.dns_parent);
      document.getElementById('config-info').textContent = parts.join('  ·  ');
    })
    .catch(() => {
      const dot = document.getElementById('status-dot');
      dot.className = 'err';
      dot.title = 'Cannot reach server';
    });
}

// ── Tab switching ────────────────────────────────────────────────────────────

function switchTab(tab) {
  currentTab = tab;

  // When switching to Raw YAML, sync from builder
  if (tab === 'yaml') {
    const yaml = buildYAML();
    const raw  = document.getElementById('raw-editor');
    // Only overwrite if textarea is empty or matches what builder would generate
    if (!raw.value || raw.dataset.fromBuilder === 'true') {
      raw.value = yaml;
      raw.dataset.fromBuilder = 'true';
    }
    if (currentTemplate) {
      document.getElementById('tmpl-name').value = currentTemplate;
    }
  }

  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('tab-' + tab).classList.add('active');
  document.getElementById('tab-btn-' + tab).classList.add('active');
}

// ── Template type helpers ─────────────────────────────────────────────────────

// Short badge label per type
const _TYPE_LABEL = { 'site': 'SITE', 'address-block': 'BLOCK', 'dns': 'DNS', 'unknown': '?' };
const _TYPE_CLASS = { 'site': 't-site', 'address-block': 't-block', 'dns': 't-dns', 'unknown': 't-unknown' };

function _typeBadgeHtml(ttype) {
  const t = ttype || 'unknown';
  return `<span class="tmpl-type-badge ${_TYPE_CLASS[t] || 't-unknown'}">${_TYPE_LABEL[t] || '?'}</span>`;
}

// Client-side type detection mirroring uddi_utils.template_type()
function detectType(yamlText) {
  const text = yamlText || '';
  const m = text.match(/^type:\s*['"]?([a-z-]+)['"]?\s*$/mi);
  if (m && ['site', 'address-block', 'dns'].includes(m[1].toLowerCase())) return m[1].toLowerCase();
  if (/^address_blocks:/m.test(text)) return 'address-block';
  if (/^zones:/m.test(text)) return 'dns';
  if (/^site:/m.test(text) || /^network:/m.test(text)) return 'site';
  return 'unknown';
}

// Apply the current template type to the execute panel + builder tab
function applyTypeToUI() {
  const sel = document.getElementById('action-select');
  const prev = sel.value;
  const labels = {
    provision: 'Provision', decommission: 'Decommission',
    query: 'Query (read-only)', validate: 'Validate template', drift: 'Detect drift',
  };
  const actions = currentTemplateType === 'site'
    ? ['provision', 'decommission', 'query', 'validate', 'drift']
    : ['provision', 'decommission', 'query', 'validate'];
  sel.innerHTML = actions.map(a => `<option value="${a}">${labels[a]}</option>`).join('');
  sel.value = actions.includes(prev) ? prev : 'provision';

  // Builder is create-only: available for builder-authored (new) content of any
  // type, disabled once an existing file is loaded (edit those in Raw YAML).
  const builderBtn = document.getElementById('tab-btn-builder');
  const raw = document.getElementById('raw-editor');
  const builderAuthored = raw.dataset.fromBuilder !== 'false';
  if (builderAuthored) {
    builderBtn.classList.remove('tab-disabled');
    builderBtn.onclick = () => switchTab('builder');
    builderBtn.title = '';
  } else {
    builderBtn.classList.add('tab-disabled');
    builderBtn.title = 'The builder creates new templates; edit existing files in Raw YAML';
    builderBtn.onclick = () => toast('Editing existing templates uses Raw YAML; the builder is for creating new templates');
    if (currentTab === 'builder') switchTab('yaml');
  }
  updateExecControls();
}

// ── Template list (sidebar) ──────────────────────────────────────────────────

// Track which folders are collapsed: Set of folder paths (e.g. 'emea')
const collapsedFolders = new Set();

// Full template list cached for client-side filtering
let _templateList = [];

function refreshTemplates() {
  fetch('/api/templates')
    .then(r => r.json())
    .then(list => {
      _templateList = list || [];
      (_templateList || []).forEach(e => {
        if (e.type === 'file') _templateTypes[e.name] = e.tmpl_type || 'unknown';
      });
      const q = document.getElementById('tmpl-search').value;
      if (q.trim()) {
        _renderFiltered(q.trim());
      } else {
        renderTemplateTree(_templateList);
      }
    })
    .catch(err => toast('Failed to load templates: ' + err.message));
}

function filterTemplates(query) {
  if (!query.trim()) {
    renderTemplateTree(_templateList);
  } else {
    _renderFiltered(query.trim());
  }
}

function _renderFiltered(query) {
  const lower = query.toLowerCase();
  const container = document.getElementById('tmpl-list');
  container.innerHTML = '';

  const matches = _templateList.filter(e =>
    e.type === 'file' && e.name.toLowerCase().includes(lower)
  );

  if (!matches.length) {
    container.innerHTML = '<div style="padding:14px 16px;font-size:12px;color:rgba(255,255,255,0.3)">No matches</div>';
    return;
  }

  matches.forEach(tmpl => {
    const label = tmpl.name;
    const el = document.createElement('div');
    el.className = 'tmpl-item' + (tmpl.name === currentTemplate ? ' active' : '');
    el.title = tmpl.name;
    el.dataset.tmplName = tmpl.name;
    el.onclick = () => loadTemplate(tmpl.name);

    // Highlight matching portion
    const idx = label.toLowerCase().indexOf(lower);
    if (idx >= 0) {
      el.appendChild(document.createTextNode(label.slice(0, idx)));
      const mark = document.createElement('span');
      mark.className = 'tmpl-search-match';
      mark.textContent = label.slice(idx, idx + query.length);
      el.appendChild(mark);
      el.appendChild(document.createTextNode(label.slice(idx + query.length)));
    } else {
      el.textContent = label;
    }
    el.insertAdjacentHTML('beforeend', _typeBadgeHtml(tmpl.tmpl_type));
    container.appendChild(el);
  });
}

function _buildTree(list) {
  // Convert flat [{name, type}] into nested {dirs:{}, files:[]}
  const root = { dirs: {}, files: [] };

  // Ensure dir entries exist first (handles empty folders)
  list.filter(e => e.type === 'dir').forEach(e => {
    const parts = e.name.split('/');
    let node = root;
    parts.forEach(dir => {
      if (!node.dirs[dir]) node.dirs[dir] = { dirs: {}, files: [] };
      node = node.dirs[dir];
    });
  });

  // Then place files
  list.filter(e => e.type === 'file').forEach(tmpl => {
    const parts = tmpl.name.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const dir = parts[i];
      if (!node.dirs[dir]) node.dirs[dir] = { dirs: {}, files: [] };
      node = node.dirs[dir];
    }
    node.files.push(tmpl);
  });

  return root;
}

function renderTemplateTree(list) {
  const container = document.getElementById('tmpl-list');
  container.innerHTML = '';
  if (!list || list.error || !list.length) {
    container.innerHTML = '<div style="padding:14px 16px;font-size:12px;color:rgba(255,255,255,0.3)">No templates found</div>';
    return;
  }
  const tree = _buildTree(list);
  _renderNode(container, tree, '');
}

function _renderNode(container, node, pathPrefix) {
  // Render subdirectories first, then files at this level
  Object.keys(node.dirs).sort().forEach(dirName => {
    const dirPath = pathPrefix ? pathPrefix + '/' + dirName : dirName;
    const collapsed = collapsedFolders.has(dirPath);

    // Folder row
    const folderEl = document.createElement('div');
    folderEl.className = 'tmpl-folder';
    folderEl.dataset.path = dirPath;
    folderEl.innerHTML =
      '<span class="tmpl-folder-arrow">' + (collapsed ? '▶' : '▼') + '</span>' +
      '<span class="tmpl-folder-name">' + dirName + '</span>' +
      '<button class="tmpl-folder-menu-btn" title="Folder options">⋯</button>';
    folderEl.querySelector('.tmpl-folder-name').onclick =
      folderEl.querySelector('.tmpl-folder-arrow').onclick =
        () => _toggleFolder(dirPath);
    folderEl.querySelector('.tmpl-folder-menu-btn').onclick = (e) => {
      e.stopPropagation();
      _showFolderMenu(e, dirPath);
    };
    container.appendChild(folderEl);

    // Folder children container
    const childEl = document.createElement('div');
    childEl.className = 'tmpl-folder-children' + (collapsed ? ' collapsed' : '');
    childEl.dataset.folderPath = dirPath;
    _renderNode(childEl, node.dirs[dirName], dirPath);
    container.appendChild(childEl);
  });

  // Files at this level
  node.files.forEach(tmpl => {
    const label = tmpl.name.split('/').pop();  // basename only
    const el = document.createElement('div');
    el.className = 'tmpl-item' + (tmpl.name === currentTemplate ? ' active' : '');
    el.innerHTML = htmlEsc(label) + _typeBadgeHtml(tmpl.tmpl_type);
    el.title = tmpl.name;
    el.dataset.tmplName = tmpl.name;
    el.onclick = () => loadTemplate(tmpl.name);
    container.appendChild(el);
  });
}

function _toggleFolder(dirPath) {
  if (collapsedFolders.has(dirPath)) {
    collapsedFolders.delete(dirPath);
  } else {
    collapsedFolders.add(dirPath);
  }
  // Update arrow and visibility without a full re-fetch
  document.querySelectorAll('.tmpl-folder').forEach(el => {
    if (el.dataset.path === dirPath) {
      const collapsed = collapsedFolders.has(dirPath);
      el.querySelector('.tmpl-folder-arrow').textContent = collapsed ? '▶' : '▼';
    }
  });
  document.querySelectorAll('.tmpl-folder-children').forEach(el => {
    if (el.dataset.folderPath === dirPath) {
      el.classList.toggle('collapsed', collapsedFolders.has(dirPath));
    }
  });
}

function _templateApiPath(name) {
  // Encode each path segment separately so '/' is preserved in the URL
  return '/api/templates/' + name.split('/').map(encodeURIComponent).join('/');
}

function _markActive(name) {
  document.querySelectorAll('.tmpl-item').forEach(el => {
    el.classList.toggle('active', el.dataset.tmplName === name);
  });
}

// ── Template CRUD ────────────────────────────────────────────────────────────

function loadTemplate(name) {
  fetch(_templateApiPath(name))
    .then(r => r.json())
    .then(data => {
      if (data.error) { toast('Error: ' + data.error); return; }
      const raw = document.getElementById('raw-editor');
      raw.value = data.content;
      raw.dataset.fromBuilder = 'false';
      document.getElementById('tmpl-name').value = data.name;
      document.getElementById('btn-delete').style.display = '';
      currentTemplate = data.name;
      currentTemplateType = _templateTypes[data.name] || detectType(data.content);
      setBadge(data.name);
      _markActive(data.name);
      applyTypeToUI();
      switchTab('yaml');
    })
    .catch(err => toast('Failed to load: ' + err.message));
}

function newTemplate(type) {
  // Default to a site template; the builder's type dropdown can switch it.
  const ttype = ['site', 'address-block', 'dns'].includes(type) ? type : 'site';

  currentTemplate = null;
  setBadge('(unsaved)');
  document.getElementById('tmpl-name').value = '';
  document.getElementById('btn-delete').style.display = 'none';
  _markActive(null);

  // Fresh builder content for the chosen type
  const raw = document.getElementById('raw-editor');
  raw.value = '';
  raw.dataset.fromBuilder = 'true';
  const sel = document.getElementById('builder-type');
  if (sel) sel.value = ttype;
  // clear any state then seed via changeBuilderType
  subnets = []; hosts = []; blocks = []; zones = []; tags = [];
  changeBuilderType(ttype);
  switchTab('builder');
}

function saveRawTemplate() {
  const name    = document.getElementById('tmpl-name').value.trim();
  const content = document.getElementById('raw-editor').value;
  _saveContent(name, content);
}

function builderSave() {
  if (currentTemplate) {
    _saveContent(currentTemplate, buildYAML());
  } else {
    builderSaveAs();
  }
}

function builderSaveAs() {
  let base = '';
  if (builderType === 'site') base = v('site-name').trim();
  else if (builderType === 'address-block') base = v('block-name').trim();
  else if (builderType === 'dns') base = (zones[0] && zones[0].fqdn) || '';
  const defaults = { 'site': 'site-new.yaml', 'address-block': 'blocks/new-pool.yaml', 'dns': 'dns/new.yaml' };
  const suggestion = currentTemplate || (base ? base + '.yaml' : defaults[builderType] || 'new.yaml');
  const name = prompt('Save template as (use folder/name.yaml for subdirectories):', suggestion);
  if (!name) return;
  const finalName = name.endsWith('.yaml') || name.endsWith('.yml') ? name : name + '.yaml';
  document.getElementById('tmpl-name').value = finalName;
  _saveContent(finalName, buildYAML());
}

function _saveContent(name, content) {
  if (!name) { toast('Enter a template filename first'); return; }
  const base = name.split('/').pop();
  if (!base.endsWith('.yaml') && !base.endsWith('.yml')) {
    toast('Filename must end in .yaml or .yml'); return;
  }
  fetch(_templateApiPath(name), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  })
    .then(r => r.json())
    .then(data => {
      if (data.error) { toast('Error: ' + data.error); return; }
      currentTemplate = data.name;
      setBadge(data.name);
      document.getElementById('tmpl-name').value = data.name;
      document.getElementById('btn-delete').style.display = '';
      const raw = document.getElementById('raw-editor');
      if (raw.dataset.fromBuilder !== 'false') {
        raw.value = content;
        raw.dataset.fromBuilder = 'true';
      }
      toast('Saved: ' + data.name);
      refreshTemplates();
    })
    .catch(err => toast('Save failed: ' + err.message));
}

function deleteTemplate() {
  const name = currentTemplate || document.getElementById('tmpl-name').value.trim();
  if (!name) { toast('No template selected'); return; }
  if (!confirm('Delete template "' + name + '"?')) return;
  fetch(_templateApiPath(name), { method: 'DELETE' })
    .then(r => r.json())
    .then(data => {
      if (data.error) { toast('Error: ' + data.error); return; }
      document.getElementById('raw-editor').value = '';
      document.getElementById('tmpl-name').value = '';
      document.getElementById('btn-delete').style.display = 'none';
      currentTemplate = null;
      setBadge('(unsaved)');
      toast('Deleted: ' + name);
      refreshTemplates();
    })
    .catch(err => toast('Delete failed: ' + err.message));
}

function setBadge(text) {
  document.getElementById('current-tmpl-badge').textContent = text;
}

// ── Folder management ─────────────────────────────────────────────────────────

let _ctxMenu = null;

function _closeFolderMenu() {
  if (_ctxMenu) { _ctxMenu.remove(); _ctxMenu = null; }
}

function _showFolderMenu(e, dirPath) {
  _closeFolderMenu();
  const menu = document.createElement('div');
  menu.className = 'folder-ctx-menu';
  menu.innerHTML =
    '<button onclick="_promptRenameFolder(\'' + dirPath.replace(/'/g, "\\'") + '\')">Rename…</button>' +
    '<button onclick="_promptNewSubfolder(\'' + dirPath.replace(/'/g, "\\'") + '\')">New subfolder…</button>' +
    '<button class="danger" onclick="_confirmDeleteFolder(\'' + dirPath.replace(/'/g, "\\'") + '\')">Delete…</button>';
  menu.style.top  = e.clientY + 'px';
  menu.style.left = e.clientX + 'px';
  document.body.appendChild(menu);
  _ctxMenu = menu;
  // Close on any outside click
  setTimeout(() => document.addEventListener('click', _closeFolderMenu, { once: true }), 0);
}

function promptNewFolder() {
  const path = prompt('New folder path (e.g. emea/staging):');
  if (!path || !path.trim()) return;
  _createFolder(path.trim());
}

function _promptNewSubfolder(parentPath) {
  _closeFolderMenu();
  const name = prompt('New subfolder name inside "' + parentPath + '":');
  if (!name || !name.trim()) return;
  _createFolder(parentPath + '/' + name.trim());
}

function _createFolder(path) {
  fetch('/api/folders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  })
    .then(r => r.json())
    .then(data => {
      if (data.error) { toast('Error: ' + data.error); return; }
      toast('Created: ' + data.path);
      refreshTemplates();
    })
    .catch(err => toast('Failed: ' + err.message));
}

function _promptRenameFolder(dirPath) {
  _closeFolderMenu();
  const parts = dirPath.split('/');
  const current = parts[parts.length - 1];
  const newName = prompt('Rename "' + current + '" to:', current);
  if (!newName || !newName.trim() || newName.trim() === current) return;
  const newPath = parts.slice(0, -1).concat(newName.trim()).join('/');
  fetch('/api/folders/' + dirPath.split('/').map(encodeURIComponent).join('/'), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ new_path: newPath }),
  })
    .then(r => r.json())
    .then(data => {
      if (data.error) { toast('Error: ' + data.error); return; }
      // If the active template was inside the renamed folder, update it
      if (currentTemplate && currentTemplate.startsWith(dirPath + '/')) {
        currentTemplate = data.new_path + currentTemplate.slice(dirPath.length);
        setBadge(currentTemplate);
        document.getElementById('tmpl-name').value = currentTemplate;
      }
      toast('Renamed to: ' + data.new_path);
      refreshTemplates();
    })
    .catch(err => toast('Failed: ' + err.message));
}

function _confirmDeleteFolder(dirPath) {
  _closeFolderMenu();
  const confirmed = confirm('Delete folder "' + dirPath + '" and ALL its contents?');
  if (!confirmed) return;
  fetch('/api/folders/' + dirPath.split('/').map(encodeURIComponent).join('/') + '?recursive=true', {
    method: 'DELETE',
  })
    .then(r => r.json())
    .then(data => {
      if (data.error) { toast('Error: ' + data.error); return; }
      if (currentTemplate && currentTemplate.startsWith(dirPath + '/')) {
        currentTemplate = null;
        setBadge('(unsaved)');
        document.getElementById('tmpl-name').value = '';
        document.getElementById('raw-editor').value = '';
        document.getElementById('btn-delete').style.display = 'none';
      }
      toast('Deleted: ' + dirPath);
      refreshTemplates();
    })
    .catch(err => toast('Failed: ' + err.message));
}

// ── Output tab switching ──────────────────────────────────────────────────────

let _outputTab = 'clean';

function switchOutputTab(tab) {
  _outputTab = tab;
  document.getElementById('otab-clean').classList.toggle('active', tab === 'clean');
  document.getElementById('otab-raw').classList.toggle('active', tab === 'raw');
  document.getElementById('output-clean-area').style.display = tab === 'clean' ? '' : 'none';
  document.getElementById('output').style.display            = tab === 'raw'   ? '' : 'none';
}

// ── Clean output parser ───────────────────────────────────────────────────────

const _LOG_RE = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) (DEBUG|INFO|WARNING|ERROR|CRITICAL)\s+[\w.]+: (.+)$/;

const _LEVEL_META = {
  INFO:     { icon: '●', cls: 'ci-info' },
  WARNING:  { icon: '▲', cls: 'ci-warn' },
  ERROR:    { icon: '✗', cls: 'ci-error' },
  CRITICAL: { icon: '✗', cls: 'ci-error' },
  PLAIN:    { icon: '·', cls: 'ci-plain' },
  DRYRUN:   { icon: '◆', cls: 'ci-dryrun' },
};

function _parseCleanLine(text) {
  const m = text.match(_LOG_RE);
  if (m) {
    const level = m[2];
    const msg   = m[3];
    if (level === 'DEBUG') return null;
    const isDryRun = msg.includes('[DRY-RUN]');
    return { level: isDryRun ? 'DRYRUN' : level, msg: isDryRun ? msg.replace('[DRY-RUN] ', '') : msg };
  }
  if (text.startsWith('[EXIT:')) return null;
  const isDryRun = text.includes('[DRY-RUN]');
  if (isDryRun) return { level: 'DRYRUN', msg: text.replace('[DRY-RUN] ', '') };
  if (text.trim()) return { level: 'PLAIN', msg: text };
  return null;
}

function _appendClean(parsed) {
  const area = document.getElementById('output-clean-area');
  const meta = _LEVEL_META[parsed.level] || _LEVEL_META.PLAIN;
  const item = document.createElement('div');
  item.className = 'clean-item ' + meta.cls;
  item.innerHTML =
    '<span class="clean-icon">' + meta.icon + '</span>' +
    '<span class="clean-msg">' + htmlEsc(parsed.msg) + '</span>';
  area.appendChild(item);
  area.parentElement.scrollTop = area.parentElement.scrollHeight;
}

function _appendCleanHeader(text) {
  const area = document.getElementById('output-clean-area');
  const hdr = document.createElement('div');
  hdr.className = 'clean-header';
  hdr.textContent = text;
  area.appendChild(hdr);
}

function _appendCleanSummary(code) {
  const area = document.getElementById('output-clean-area');
  const el = document.createElement('div');
  el.className = 'clean-summary ' + (code === 0 ? 'cs-ok' : 'cs-err');
  el.textContent = code === 0 ? '✓  Completed successfully' : '✗  Failed (exit code ' + code + ')';
  area.appendChild(el);
  area.parentElement.scrollTop = area.parentElement.scrollHeight;
}

// ── Execution ────────────────────────────────────────────────────────────────

function updateExecControls() {
  const action = document.getElementById('action-select').value;
  const siteProvision = action === 'provision' && currentTemplateType === 'site';
  // Decommission confirmation is handled by a browser prompt at run time, so
  // the old --force toggle row is no longer shown.
  document.getElementById('row-force').style.display        = 'none';
  document.getElementById('row-create-zone').style.display   = siteProvision ? '' : 'none';
  document.getElementById('row-reverse-zone').style.display  = siteProvision ? '' : 'none';
  document.getElementById('row-if-not-exists').style.display = siteProvision ? '' : 'none';
  const noStream = action === 'query' || action === 'validate' || action === 'drift';
  document.getElementById('row-dry-run').style.display      = noStream ? 'none' : '';
  if (action === 'query')    { showQueryResults();    return; }
  if (action === 'validate') { showValidateResults(); return; }
  if (action === 'drift')    { showDriftResults();    return; }
  showTerminal();
}

function execute() {
  const name = currentTemplate;
  if (!name) {
    toast('Save a template to the server first (use Save or Save As)');
    return;
  }

  const action      = document.getElementById('action-select').value;
  const dryRun      = document.getElementById('dry-run-toggle').checked;
  const createZone  = document.getElementById('exec-create-zone').checked;
  const reverseZone = document.getElementById('exec-reverse-zone').checked;
  const ifNotExists = document.getElementById('exec-if-not-exists').checked;

  // Decommission is non-interactive on the server, so confirm a real (non
  // dry-run) teardown here in the browser before kicking it off.
  if (action === 'decommission' && !dryRun) {
    if (!confirm('Permanently decommission "' + name + '"?\n\nThis deletes its hosts, '
        + 'DNS zone, DHCP ranges and subnets, and resets the address block. '
        + 'This cannot be undone.')) {
      return;
    }
  }

  document.getElementById('btn-execute').style.display = 'none';
  document.getElementById('btn-stop').style.display = '';

  if (action === 'query')    { _executeQuery(name);    return; }
  if (action === 'validate') { _executeValidate(name); return; }
  if (action === 'drift')    { _executeDrift(name);    return; }

  // Provision / decommission — SSE streaming to terminal
  showTerminal();
  clearOutput();
  const headerLine = '▶ ' + action.toUpperCase() + ': ' + name + (dryRun ? '  [DRY-RUN]' : '');
  appendOutput(headerLine + '\n\n', 'out-dryrun');
  _appendCleanHeader(headerLine);

  const body = { template: name, verbose: true };
  if (action === 'provision') {
    body.dry_run = dryRun;
    body.create_zone = createZone;
    body.create_reverse_zone = reverseZone;
    body.if_not_exists = ifNotExists;
  } else {
    body.dry_run = dryRun;
    // Confirmation already happened in the browser above; the server-side
    // script must run non-interactively (it cannot prompt over SSE).
    body.force = true;
  }

  fetch('/api/' + action, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then(response => {
    const reader  = response.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    function pump() {
      return reader.read().then(({ done, value }) => {
        if (done) { execDone(); return; }
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop();
        lines.forEach(line => {
          if (!line.startsWith('data: ')) return;
          const text = line.slice(6);
          if (text.startsWith('[EXIT:')) {
            const code = parseInt(text.slice(6), 10);
            appendOutput(
              '\n' + (code === 0 ? '✓' : '✗') + ' Exited with code ' + code + '\n',
              code === 0 ? 'out-success' : 'out-error',
            );
            _appendCleanSummary(code);
            execDone();
          } else {
            renderLine(text + '\n');
          }
        });
        return pump();
      }).catch(() => execDone());
    }
    pump();
  }).catch(err => {
    appendOutput('Connection error: ' + err.message + '\n', 'out-error');
    execDone();
  });
}

function _executeQuery(name) {
  showQueryResults();
  document.getElementById('query-results').innerHTML =
    '<div style="padding:20px;text-align:center;color:var(--ibx-muted);font-size:12px">Querying…</div>';

  fetch('/api/query-json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ template: name }),
  })
    .then(r => r.json())
    .then(data => {
      execDone();
      if (data.error) {
        document.getElementById('query-results').innerHTML =
          '<div style="padding:16px;color:var(--ibx-danger);font-size:12px">Error: ' + htmlEsc(data.error) + '</div>';
        return;
      }
      renderQueryResult(data);
    })
    .catch(err => {
      execDone();
      document.getElementById('query-results').innerHTML =
        '<div style="padding:16px;color:var(--ibx-danger);font-size:12px">Connection error: ' + htmlEsc(err.message) + '</div>';
    });
}

function _executeValidate(name) {
  showValidateResults();
  document.getElementById('validate-results').innerHTML =
    '<div style="padding:20px;text-align:center;color:var(--ibx-muted);font-size:12px">Validating…</div>';

  fetch('/api/validate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ template: name }),
  })
    .then(r => r.json())
    .then(data => {
      execDone();
      if (data.error) {
        document.getElementById('validate-results').innerHTML =
          '<div style="padding:16px;color:var(--ibx-danger);font-size:12px">Error: ' + htmlEsc(data.error) + '</div>';
        return;
      }
      renderValidateResult(data);
    })
    .catch(err => {
      execDone();
      document.getElementById('validate-results').innerHTML =
        '<div style="padding:16px;color:var(--ibx-danger);font-size:12px">Connection error: ' + htmlEsc(err.message) + '</div>';
    });
}

function renderValidateResult(r) {
  const isValid = r.valid;
  const errors   = r.errors   || [];
  const warnings = r.warnings || [];

  let html = '<div class="vr-badge-row">';
  html += `<span class="vr-badge ${isValid ? 'ok' : 'err'}">${isValid ? '✓ Valid' : '✗ Invalid'}</span>`;
  html += `<span class="vr-tmpl-name">${htmlEsc(r.template || '')}</span>`;
  html += '</div>';

  if (errors.length) {
    html += `<div class="vr-section-label">Errors (${errors.length})</div>`;
    errors.forEach(e => {
      html += `<div class="vr-item vr-error">
        <span class="vr-field">${htmlEsc(e.field)}</span>
        <span class="vr-msg">${htmlEsc(e.message)}</span>
      </div>`;
    });
  }

  if (warnings.length) {
    html += `<div class="vr-section-label">Warnings (${warnings.length})</div>`;
    warnings.forEach(w => {
      html += `<div class="vr-item vr-warning">
        <span class="vr-field">${htmlEsc(w.field)}</span>
        <span class="vr-msg">${htmlEsc(w.message)}</span>
      </div>`;
    });
  }

  if (!errors.length && !warnings.length) {
    html += '<div class="vr-empty">No issues found.</div>';
  }

  document.getElementById('validate-results').innerHTML = html;
}

function renderQueryResult(r) {
  if (r && r.type === 'address-block') { renderBlockQueryResult(r); return; }
  if (r && r.type === 'dns')           { renderDnsQueryResult(r);   return; }

  const site = r.site || '(unknown)';
  let html = '';

  // ── Site card ──
  html += `<div class="qr-card">
    <div class="qr-card-header">
      <span class="qr-title">Site: ${htmlEsc(site)}</span>
      <span class="qr-badge ${r.found ? 'ok' : 'err'}">${r.found ? 'Provisioned' : 'Not provisioned'}</span>
    </div>
    <div class="qr-card-body">
      <dl>
        <div class="qr-kv"><dt>IP space</dt><dd>${htmlEsc(r.ip_space || '—')}</dd></div>
      </dl>
    </div></div>`;

  // ── DNS zone card ──
  html += `<div class="qr-card">
    <div class="qr-card-header">
      <span class="qr-title">DNS Zone</span>
      <span class="qr-badge ${r.dns_zone_found ? 'ok' : 'err'}">${r.dns_zone_found ? 'Found' : 'Not found'}</span>
    </div>`;
  if (r.dns_zone_found) {
    html += `<div class="qr-card-body">
      <dl><div class="qr-kv"><dt>FQDN</dt><dd>${htmlEsc(r.dns_zone_fqdn)}</dd></div></dl>
    </div>`;
  }
  html += '</div>';

  // ── Subnets card ──
  const subnets = r.subnets || [];
  html += `<div class="qr-card">
    <div class="qr-card-header">
      <span class="qr-title">Subnets</span>
      <span class="qr-badge">${subnets.length}</span>
    </div>
    <div class="qr-card-body">`;

  if (!subnets.length) {
    html += '<div class="qr-no-hosts">No subnets found</div>';
  } else {
    subnets.forEach(s => {
      const cidr  = `${s.address}/${s.cidr}`;
      const sname = s.name || '';
      const hosts = s.hosts || [];
      html += `<div class="qr-subnet">
        <div class="qr-subnet-header">
          <span class="qr-subnet-cidr">${htmlEsc(cidr)}</span>
          ${sname ? `<span class="qr-subnet-name">${htmlEsc(sname)}</span>` : ''}
          <span class="qr-badge" style="margin-left:auto">${hosts.length} host${hosts.length !== 1 ? 's' : ''}</span>
        </div>`;
      if (hosts.length) {
        html += '<div class="qr-hosts">';
        hosts.forEach(h => {
          html += `<div class="qr-host-row">
            <span class="qr-host-name">${htmlEsc(h.name || h.id)}</span>
            <span class="qr-host-ip">${htmlEsc(h.ip || '')}</span>
          </div>`;
        });
        html += '</div>';
      } else {
        html += '<div class="qr-hosts"><div class="qr-no-hosts">No hosts</div></div>';
      }
      html += '</div>';
    });
  }
  html += '</div></div>';

  document.getElementById('query-results').innerHTML = html;
}

function renderBlockQueryResult(r) {
  let html = `<div class="qr-card">
    <div class="qr-card-header"><span class="qr-title">Address Blocks: ${htmlEsc(r.name || '(by address)')}</span></div>
    <div class="qr-card-body">
      <dl><div class="qr-kv"><dt>IP space</dt><dd>${htmlEsc(r.ip_space || '—')}</dd></div></dl>`;

  const renderNode = (node) => {
    const cidr = `${node.address}/${node.cidr}`;
    const meta = [];
    if (node.status)      meta.push(node.status);
    if (node.region)      meta.push(node.region);
    if (node.environment) meta.push(node.environment);
    let h = `<div class="qr-subnet">
      <div class="qr-subnet-header">
        <span class="qr-subnet-cidr">${htmlEsc(cidr)}</span>
        ${meta.length ? `<span class="qr-subnet-name">${htmlEsc(meta.join(' · '))}</span>` : ''}
      </div>`;
    const children = node.children || [];
    if (children.length) {
      h += '<div class="qr-hosts">';
      children.forEach(c => { h += renderNode(c); });
      h += '</div>';
    }
    h += '</div>';
    return h;
  };

  const blocks = r.blocks || [];
  if (!blocks.length) {
    html += '<div class="qr-no-hosts">No blocks found</div>';
  } else {
    blocks.forEach(b => { html += renderNode(b); });
  }
  html += '</div></div>';
  document.getElementById('query-results').innerHTML = html;
}

function renderDnsQueryResult(r) {
  let html = `<div class="qr-card">
    <div class="qr-card-header"><span class="qr-title">DNS</span><span class="qr-badge">view: ${htmlEsc(r.view || '')}</span></div>
  </div>`;

  const zones = r.zones || [];
  if (!zones.length) {
    html += '<div class="qr-card"><div class="qr-card-body"><div class="qr-no-hosts">No zones in template</div></div></div>';
  }
  zones.forEach(z => {
    html += `<div class="qr-card">
      <div class="qr-card-header">
        <span class="qr-title">${htmlEsc(z.fqdn)}</span>
        <span class="qr-badge ${z.found ? 'ok' : 'err'}">${z.found ? 'Found' : 'Not found'}</span>
      </div>
      <div class="qr-card-body">`;
    const records = z.records || [];
    if (!records.length) {
      html += `<div class="qr-no-hosts">${z.found ? 'No records' : '—'}</div>`;
    } else {
      html += '<div class="qr-hosts">';
      records.forEach(rec => {
        html += `<div class="qr-host-row">
          <span class="qr-host-name">${htmlEsc(rec.type)} ${htmlEsc(rec.name)}</span>
          <span class="qr-host-ip">${htmlEsc(rec.rdata || '')}</span>
        </div>`;
      });
      html += '</div>';
    }
    html += '</div></div>';
  });
  document.getElementById('query-results').innerHTML = html;
}

function showTerminal() {
  document.getElementById('output-tabs').style.display      = '';
  document.getElementById('output-area').style.display      = '';
  document.getElementById('query-results').style.display    = 'none';
  document.getElementById('validate-results').style.display = 'none';
  document.getElementById('drift-results').style.display    = 'none';
  document.getElementById('btn-copy-output').style.display  = '';
  switchOutputTab(_outputTab);
}

function showQueryResults() {
  document.getElementById('output-tabs').style.display      = 'none';
  document.getElementById('output-area').style.display      = 'none';
  document.getElementById('query-results').style.display    = '';
  document.getElementById('validate-results').style.display = 'none';
  document.getElementById('drift-results').style.display    = 'none';
  document.getElementById('btn-copy-output').style.display  = 'none';
}

function showValidateResults() {
  document.getElementById('output-tabs').style.display      = 'none';
  document.getElementById('output-area').style.display      = 'none';
  document.getElementById('query-results').style.display    = 'none';
  document.getElementById('validate-results').style.display = '';
  document.getElementById('drift-results').style.display    = 'none';
  document.getElementById('btn-copy-output').style.display  = 'none';
}

function showDriftResults() {
  document.getElementById('output-tabs').style.display      = 'none';
  document.getElementById('output-area').style.display      = 'none';
  document.getElementById('query-results').style.display    = 'none';
  document.getElementById('validate-results').style.display = 'none';
  document.getElementById('drift-results').style.display    = '';
  document.getElementById('btn-copy-output').style.display  = 'none';
}

function _executeDrift(name) {
  showDriftResults();
  document.getElementById('drift-results').innerHTML =
    '<div style="padding:20px;text-align:center;color:var(--ibx-muted);font-size:12px">Checking for drift…</div>';

  fetch('/api/drift', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ template: name }),
  })
    .then(r => r.json())
    .then(data => {
      execDone();
      if (data.error) {
        document.getElementById('drift-results').innerHTML =
          '<div style="padding:16px;color:var(--ibx-danger);font-size:12px">Error: ' + htmlEsc(data.error) + '</div>';
        return;
      }
      renderDriftResult(data);
    })
    .catch(err => {
      execDone();
      document.getElementById('drift-results').innerHTML =
        '<div style="padding:16px;color:var(--ibx-danger);font-size:12px">Connection error: ' + htmlEsc(err.message) + '</div>';
    });
}

function renderDriftResult(r) {
  const found   = r.found;
  const drifted = r.drifted;
  const drifts  = r.drifts || [];
  const summary = r.summary || {};
  const site    = r.site || '(unknown)';
  const subnetCount = r.subnet_count;

  let html = '<div class="dr-badge-row">';
  if (!found) {
    html += '<span class="dr-badge missing">⚠ Not Provisioned</span>';
  } else if (!drifted) {
    html += '<span class="dr-badge ok">✓ No Drift</span>';
  } else {
    const n = summary.total || drifts.length;
    html += `<span class="dr-badge drifted">✗ Drift (${n})</span>`;
  }
  html += `<span class="dr-site-name">${htmlEsc(site)}</span>`;
  if (found && subnetCount != null) html += `<span class="dr-block">${subnetCount} subnet(s)</span>`;
  html += '</div>';

  if (!drifts.length) {
    html += '<div class="dr-empty">Site matches template — no differences detected.</div>';
    document.getElementById('drift-results').innerHTML = html;
    return;
  }

  // Group by category
  const categories = {};
  drifts.forEach(d => {
    (categories[d.category] = categories[d.category] || []).push(d);
  });

  const catLabels = { site: 'Site', subnet: 'Subnets', dns: 'DNS', tags: 'Tags', hosts: 'Hosts' };
  for (const [cat, items] of Object.entries(categories)) {
    const label = catLabels[cat] || cat.charAt(0).toUpperCase() + cat.slice(1);
    html += `<div class="dr-section-label">${htmlEsc(label)}</div>`;
    items.forEach(d => {
      const cls = d.severity === 'error' ? 'dr-error'
                : d.severity === 'warning' ? 'dr-warning' : 'dr-info';
      html += `<div class="dr-item ${cls}">
        <span class="dr-field">${htmlEsc(d.field)}</span>
        <span class="dr-msg">${htmlEsc(d.message)}</span>
      </div>`;
    });
  }

  const errs  = summary.errors   || 0;
  const warns = summary.warnings || 0;
  html += `<div class="dr-summary">${errs} error(s), ${warns} warning(s)</div>`;

  document.getElementById('drift-results').innerHTML = html;
}

function renderLine(text) {
  const lower = text.toLowerCase();
  let cls = '';
  if (lower.includes('[dry-run]'))                              cls = 'out-dryrun';
  else if (lower.includes('error') || lower.includes('failed')) cls = 'out-error';
  else if (lower.includes('warn'))                              cls = 'out-warn';
  else if (lower.includes('complete') || lower.includes('created') || lower.includes('success')) cls = 'out-success';
  appendOutput(text + '\n', cls);
  const parsed = _parseCleanLine(text);
  if (parsed) _appendClean(parsed);
}

function execDone() {
  document.getElementById('btn-execute').style.display = '';
  document.getElementById('btn-stop').style.display = 'none';
}

function stopExec() { execDone(); }

function appendOutput(text, cls) {
  const out  = document.getElementById('output');
  const area = out.parentElement;
  if (cls) {
    const span = document.createElement('span');
    span.className = cls;
    span.textContent = text;
    out.appendChild(span);
  } else {
    out.appendChild(document.createTextNode(text));
  }
  area.scrollTop = area.scrollHeight;
}

function clearOutput() {
  document.getElementById('output').innerHTML = '';
  document.getElementById('output-clean-area').innerHTML = '';
  document.getElementById('query-results').innerHTML = '';
  document.getElementById('validate-results').innerHTML = '';
  document.getElementById('drift-results').innerHTML = '';
  showTerminal();
}

function copyOutput() {
  navigator.clipboard.writeText(document.getElementById('output').textContent)
    .then(() => toast('Output copied'))
    .catch(() => toast('Copy failed'));
}

// ── Builder helpers ──────────────────────────────────────────────────────────

function v(id)   { const el = document.getElementById(id); return el ? el.value : ''; }
function vb(id)  { const el = document.getElementById(id); return el ? el.checked : false; }
function htmlEsc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

function esc(s) {
  if (!s) return '""';
  if (/[:#\[\]{}&*!|>'"%@`,\s]/.test(s) || s.includes('\n')) return '"' + s.replace(/"/g, '\\"') + '"';
  return s;
}

// ── Builder seed ─────────────────────────────────────────────────────────────

function seedBuilder(type) {
  type = type || builderType || 'site';
  builderType = type;
  if (type === 'site') {
    subnets = []; hosts = []; tags = []; nextId = 1;
    addSubnet({ name: '', purpose: 'mgmt',     cidr: 24, dhcp: false });
    addSubnet({ name: '', purpose: 'user-lan', cidr: 24, dhcp: true,  dhcp_start: 10, dhcp_end: 250 });
    addSubnet({ name: '', purpose: 'server',   cidr: 24, dhcp: false });
    addHost({ hostname: 'gw01', subnet: '', comment: 'Site gateway' });
    addTag({ key: 'Owner', value: '' });
  } else if (type === 'address-block') {
    blocks = []; tags = []; nextId = 1;
    addBlock({ address: '10.0.0.0', cidr: 8, region: 'Global', status: 'available', comment: 'Global supernet' });
    addTag({ key: 'Owner', value: 'network-team' });
  } else if (type === 'dns') {
    zones = []; tags = []; nextId = 1;
    addZone({ fqdn: 'corp.example.com', kind: 'forward', create: true });
    addTag({ key: 'Owner', value: 'dns-team' });
  }
}

function clearBuilder(type) {
  type = type || builderType || 'site';
  builderType = type;
  tags = []; nextId = 1;
  if (type === 'site') {
    subnets = []; hosts = [];
    renderSubnets(); renderHosts();
    ['site-name','site-location','net-ip-space','net-subnet-size',
     'dns-parent','dns-view'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
    ['site-region','site-environment'].forEach(id => { const el = document.getElementById(id); if (el) el.selectedIndex = 0; });
    const cz = document.getElementById('dns-create-zone'); if (cz) cz.checked = false;
    const rz = document.getElementById('dns-reverse-zone'); if (rz) rz.checked = false;
  } else if (type === 'address-block') {
    blocks = [];
    renderBlocks();
    ['block-name','block-ip-space'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  } else if (type === 'dns') {
    zones = [];
    renderZones();
    const dv = document.getElementById('dns-builder-view'); if (dv) dv.value = '';
  }
  renderTags();
  builderUpdate();
}

// Switch the Builder between template types (shows the right form + seeds it)
function changeBuilderType(type) {
  builderType = type;
  currentTemplateType = type;
  document.getElementById('builder-site').style.display  = type === 'site' ? '' : 'none';
  document.getElementById('builder-block').style.display = type === 'address-block' ? '' : 'none';
  document.getElementById('builder-dns').style.display   = type === 'dns' ? '' : 'none';
  const empty = (type === 'site' && !subnets.length && !hosts.length) ||
                (type === 'address-block' && !blocks.length) ||
                (type === 'dns' && !zones.length);
  if (empty) {
    seedBuilder(type);
  } else {
    renderSubnets(); renderHosts(); renderBlocks(); renderZones(); renderTags();
  }
  applyTypeToUI();
  builderUpdate();
}

// ── Builder subnets ──────────────────────────────────────────────────────────

function addSubnet(data) {
  const id = nextId++;
  subnets.push({
    id,
    name:      (data && data.name)    || '',
    purpose:   (data && data.purpose) || 'general',
    cidr:      (data && data.cidr)    || 24,
    dhcp:      (data && !!data.dhcp)  || false,
    dhcp_start:(data && data.dhcp_start != null) ? data.dhcp_start : 10,
    dhcp_end:  (data && data.dhcp_end   != null) ? data.dhcp_end   : 250,
  });
  renderSubnets();
  builderUpdate();
}

function removeSubnet(id) {
  subnets = subnets.filter(s => s.id !== id);
  renderSubnets();
  renderHosts();   // subnet dropdown changes
  builderUpdate();
}

function renderSubnets() {
  const container = document.getElementById('subnets-list');
  container.innerHTML = '';
  subnets.forEach((s, i) => {
    const div = document.createElement('div');
    div.className = 'list-item';
    div.innerHTML = `
      <div class="list-item-header">
        <span class="list-item-title">Subnet ${i+1}</span>
        <button class="btn-remove" onclick="removeSubnet(${s.id})">Remove</button>
      </div>
      <div class="field-row thirds">
        <div class="field">
          <label>Name<span class="hint">prefix only</span></label>
          <input type="text" value="${htmlEsc(s.name)}" placeholder="site-mgmt"
            oninput="updateSubnet(${s.id},'name',this.value)">
        </div>
        <div class="field">
          <label>Purpose</label>
          <select onchange="updateSubnet(${s.id},'purpose',this.value)">
            ${['mgmt','user-lan','server','dmz','storage','voice','iot','general'].map(p =>
              `<option value="${p}"${s.purpose===p?' selected':''}>${p}</option>`
            ).join('')}
          </select>
        </div>
        <div class="field">
          <label>CIDR Size</label>
          <input type="number" value="${htmlEsc(s.cidr)}" min="8" max="30" style="width:80px"
            oninput="updateSubnet(${s.id},'cidr',+this.value)">
        </div>
      </div>
      <div class="toggle-field">
        <label class="toggle">
          <input type="checkbox" ${s.dhcp?'checked':''}
            onchange="updateSubnet(${s.id},'dhcp',this.checked);toggleDhcpRange(${s.id},this.checked)">
          <div class="toggle-track"></div><div class="toggle-thumb"></div>
        </label>
        <label>Enable DHCP for this subnet</label>
      </div>
      <div class="dhcp-range-fields${s.dhcp?' visible':''}" id="dhcp-range-${s.id}">
        <div class="field-row" style="margin-top:6px">
          <div class="field">
            <label>DHCP Start offset<span class="hint">host # from base</span></label>
            <input type="number" value="${s.dhcp_start}" min="1" max="254"
              oninput="updateSubnet(${s.id},'dhcp_start',+this.value)">
          </div>
          <div class="field">
            <label>DHCP End offset<span class="hint">host # from base</span></label>
            <input type="number" value="${s.dhcp_end}" min="1" max="254"
              oninput="updateSubnet(${s.id},'dhcp_end',+this.value)">
          </div>
        </div>
      </div>`;
    container.appendChild(div);
  });
}

function updateSubnet(id, key, val) {
  const s = subnets.find(s => s.id === id);
  if (s) { s[key] = val; builderUpdate(); }
  if (key === 'name') renderHosts();
}

function toggleDhcpRange(id, visible) {
  const el = document.getElementById('dhcp-range-' + id);
  if (el) el.classList.toggle('visible', visible);
}

// ── Builder hosts ────────────────────────────────────────────────────────────

function addHost(data) {
  const id = nextId++;
  hosts.push({
    id,
    hostname: (data && data.hostname) || '',
    subnet:   (data && data.subnet)   || '',
    comment:  (data && data.comment)  || '',
  });
  renderHosts();
  builderUpdate();
}

function removeHost(id) {
  hosts = hosts.filter(h => h.id !== id);
  renderHosts();
  builderUpdate();
}

function renderHosts() {
  const container = document.getElementById('hosts-list');
  container.innerHTML = '';
  hosts.forEach((h, i) => {
    const subnetOpts = subnets.map(s =>
      `<option value="${htmlEsc(s.name)}"${h.subnet===s.name?' selected':''}>${htmlEsc(s.name||'(unnamed subnet '+(subnets.indexOf(s)+1)+')')}</option>`
    ).join('');
    const div = document.createElement('div');
    div.className = 'list-item';
    div.innerHTML = `
      <div class="list-item-header">
        <span class="list-item-title">Host ${i+1}</span>
        <button class="btn-remove" onclick="removeHost(${h.id})">Remove</button>
      </div>
      <div class="field-row thirds">
        <div class="field">
          <label>Hostname</label>
          <input type="text" value="${htmlEsc(h.hostname)}" placeholder="gw01"
            oninput="updateHost(${h.id},'hostname',this.value)">
        </div>
        <div class="field">
          <label>Subnet</label>
          <select onchange="updateHost(${h.id},'subnet',this.value)">
            <option value="">— auto (first) —</option>
            ${subnetOpts}
          </select>
        </div>
        <div class="field">
          <label>Comment</label>
          <input type="text" value="${htmlEsc(h.comment)}" placeholder="optional"
            oninput="updateHost(${h.id},'comment',this.value)">
        </div>
      </div>`;
    container.appendChild(div);
  });
}

function updateHost(id, key, val) {
  const h = hosts.find(h => h.id === id);
  if (h) { h[key] = val; builderUpdate(); }
}

// ── Builder tags ─────────────────────────────────────────────────────────────

function addTag(data) {
  const id = nextId++;
  tags.push({ id, key: (data && data.key)||'', value: (data && data.value)||'' });
  renderTags();
  builderUpdate();
}

function removeTag(id) {
  tags = tags.filter(t => t.id !== id);
  renderTags();
  builderUpdate();
}

function renderTags() {
  const container = document.getElementById('tags-list');
  container.innerHTML = '';
  tags.forEach((t, i) => {
    const div = document.createElement('div');
    div.className = 'list-item';
    div.innerHTML = `
      <div class="list-item-header">
        <span class="list-item-title">Tag ${i+1}</span>
        <button class="btn-remove" onclick="removeTag(${t.id})">Remove</button>
      </div>
      <div class="field-row">
        <div class="field">
          <label>Key</label>
          <input type="text" value="${htmlEsc(t.key)}" placeholder="Owner"
            oninput="updateTag(${t.id},'key',this.value)">
        </div>
        <div class="field">
          <label>Value</label>
          <input type="text" value="${htmlEsc(t.value)}" placeholder="network-team"
            oninput="updateTag(${t.id},'value',this.value)">
        </div>
      </div>`;
    container.appendChild(div);
  });
}

function updateTag(id, key, val) {
  const t = tags.find(t => t.id === id);
  if (t) { t[key] = val; builderUpdate(); }
}

// ── Builder: address blocks ───────────────────────────────────────────────────

const _REGIONS = ['', 'AMER', 'EMEA', 'APAC', 'LATAM', 'Global'];
const _ENVS    = ['', 'production', 'staging', 'development', 'lab'];
const _STATUS  = ['available', 'allocated', 'decommissioned'];

function _opts(values, sel) {
  return values.map(x => `<option value="${htmlEsc(x)}"${x === sel ? ' selected' : ''}>${x || '—'}</option>`).join('');
}

function addBlock(data) {
  blocks.push({
    id: nextId++,
    address:     (data && data.address) || '10.0.0.0',
    cidr:        (data && data.cidr) || 16,
    region:      (data && data.region) || '',
    environment: (data && data.environment) || '',
    status:      (data && data.status) || 'available',
    location:    (data && data.location) || '',
    comment:     (data && data.comment) || '',
    children:    [],
  });
  renderBlocks();
  builderUpdate();
}

function removeBlock(id) {
  blocks = blocks.filter(b => b.id !== id);
  renderBlocks();
  builderUpdate();
}

function updateBlock(id, key, val) {
  const b = blocks.find(b => b.id === id);
  if (b) { b[key] = val; builderUpdate(); }
}

function addChild(blockId, data) {
  const b = blocks.find(b => b.id === blockId);
  if (!b) return;
  b.children.push({
    id: nextId++,
    address:     (data && data.address) || '10.0.0.0',
    cidr:        (data && data.cidr) || 24,
    region:      (data && data.region) || '',
    environment: (data && data.environment) || '',
    status:      (data && data.status) || 'available',
    comment:     (data && data.comment) || '',
  });
  renderBlocks();
  builderUpdate();
}

function removeChild(blockId, childId) {
  const b = blocks.find(b => b.id === blockId);
  if (b) { b.children = b.children.filter(c => c.id !== childId); renderBlocks(); builderUpdate(); }
}

function updateChild(blockId, childId, key, val) {
  const b = blocks.find(b => b.id === blockId);
  if (!b) return;
  const c = b.children.find(c => c.id === childId);
  if (c) { c[key] = val; builderUpdate(); }
}

function renderBlocks() {
  const container = document.getElementById('blocks-list');
  container.innerHTML = '';
  blocks.forEach((b, i) => {
    const div = document.createElement('div');
    div.className = 'list-item';
    let kids = '';
    b.children.forEach((c, j) => {
      kids += `
        <div class="list-item" style="margin-left:14px">
          <div class="list-item-header">
            <span class="list-item-title">Child ${j+1}</span>
            <button class="btn-remove" onclick="removeChild(${b.id},${c.id})">Remove</button>
          </div>
          <div class="field-row thirds">
            <div class="field"><label>Address</label>
              <input type="text" value="${htmlEsc(c.address)}" oninput="updateChild(${b.id},${c.id},'address',this.value)"></div>
            <div class="field"><label>CIDR</label>
              <input type="number" value="${htmlEsc(c.cidr)}" min="8" max="30" style="width:80px" oninput="updateChild(${b.id},${c.id},'cidr',+this.value)"></div>
            <div class="field"><label>Status</label>
              <select onchange="updateChild(${b.id},${c.id},'status',this.value)">${_opts(_STATUS, c.status)}</select></div>
          </div>
          <div class="field-row">
            <div class="field"><label>Region</label>
              <select onchange="updateChild(${b.id},${c.id},'region',this.value)">${_opts(_REGIONS, c.region)}</select></div>
            <div class="field"><label>Environment</label>
              <select onchange="updateChild(${b.id},${c.id},'environment',this.value)">${_opts(_ENVS, c.environment)}</select></div>
          </div>
        </div>`;
    });
    div.innerHTML = `
      <div class="list-item-header">
        <span class="list-item-title">Block ${i+1}</span>
        <button class="btn-remove" onclick="removeBlock(${b.id})">Remove</button>
      </div>
      <div class="field-row thirds">
        <div class="field"><label>Address</label>
          <input type="text" value="${htmlEsc(b.address)}" placeholder="10.0.0.0" oninput="updateBlock(${b.id},'address',this.value)"></div>
        <div class="field"><label>CIDR</label>
          <input type="number" value="${htmlEsc(b.cidr)}" min="8" max="30" style="width:80px" oninput="updateBlock(${b.id},'cidr',+this.value)"></div>
        <div class="field"><label>Status</label>
          <select onchange="updateBlock(${b.id},'status',this.value)">${_opts(_STATUS, b.status)}</select></div>
      </div>
      <div class="field-row">
        <div class="field"><label>Region</label>
          <select onchange="updateBlock(${b.id},'region',this.value)">${_opts(_REGIONS, b.region)}</select></div>
        <div class="field"><label>Environment</label>
          <select onchange="updateBlock(${b.id},'environment',this.value)">${_opts(_ENVS, b.environment)}</select></div>
      </div>
      <div class="field-row">
        <div class="field"><label>Location</label>
          <input type="text" value="${htmlEsc(b.location)}" oninput="updateBlock(${b.id},'location',this.value)"></div>
        <div class="field"><label>Comment</label>
          <input type="text" value="${htmlEsc(b.comment)}" oninput="updateBlock(${b.id},'comment',this.value)"></div>
      </div>
      <div style="margin:8px 0 4px"><label>Children<span class="hint">nested blocks (one level)</span></label></div>
      ${kids}
      <button class="btn-add" onclick="addChild(${b.id})">+ Add Child</button>`;
    container.appendChild(div);
  });
}

// ── Builder: DNS zones + records ──────────────────────────────────────────────

function addZone(data) {
  zones.push({
    id: nextId++,
    fqdn:         (data && data.fqdn) || '',
    kind:         (data && data.kind) || 'forward',
    primary_type: (data && data.primary_type) || 'cloud',
    create:       (data && data.create != null) ? !!data.create : true,
    comment:      (data && data.comment) || '',
    records:      [],
  });
  renderZones();
  builderUpdate();
}

function removeZone(id) {
  zones = zones.filter(z => z.id !== id);
  renderZones();
  builderUpdate();
}

function updateZone(id, key, val) {
  const z = zones.find(z => z.id === id);
  if (z) { z[key] = val; builderUpdate(); }
}

function addRecord(zoneId, data) {
  const z = zones.find(z => z.id === zoneId);
  if (!z) return;
  z.records.push({
    id: nextId++,
    name:       (data && data.name) || '',
    type:       (data && data.type) || 'A',
    rdata:      (data && data.rdata) || '',
    preference: (data && data.preference != null) ? data.preference : 10,
    exchange:   (data && data.exchange) || '',
    ttl:        (data && data.ttl) || '',
  });
  renderZones();
  builderUpdate();
}

function removeRecord(zoneId, recId) {
  const z = zones.find(z => z.id === zoneId);
  if (z) { z.records = z.records.filter(r => r.id !== recId); renderZones(); builderUpdate(); }
}

function updateRecord(zoneId, recId, key, val) {
  const z = zones.find(z => z.id === zoneId);
  if (!z) return;
  const r = z.records.find(r => r.id === recId);
  if (r) {
    r[key] = val;
    builderUpdate();
    if (key === 'type') renderZones();   // swap rdata fields (MX vs scalar)
  }
}

const _RECORD_TYPES = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'PTR'];

function renderZones() {
  const container = document.getElementById('zones-list');
  container.innerHTML = '';
  zones.forEach((z, i) => {
    const div = document.createElement('div');
    div.className = 'list-item';
    let recs = '';
    z.records.forEach((r, j) => {
      const rdataFields = r.type === 'MX'
        ? `<div class="field"><label>Preference</label>
             <input type="number" value="${htmlEsc(r.preference)}" min="0" max="65535" style="width:90px" oninput="updateRecord(${z.id},${r.id},'preference',+this.value)"></div>
           <div class="field"><label>Exchange</label>
             <input type="text" value="${htmlEsc(r.exchange)}" placeholder="mail.example.com" oninput="updateRecord(${z.id},${r.id},'exchange',this.value)"></div>`
        : `<div class="field"><label>rdata</label>
             <input type="text" value="${htmlEsc(r.rdata)}" placeholder="10.0.1.10" oninput="updateRecord(${z.id},${r.id},'rdata',this.value)"></div>`;
      recs += `
        <div class="list-item" style="margin-left:14px">
          <div class="list-item-header">
            <span class="list-item-title">Record ${j+1}</span>
            <button class="btn-remove" onclick="removeRecord(${z.id},${r.id})">Remove</button>
          </div>
          <div class="field-row thirds">
            <div class="field"><label>Name<span class="hint">@ = apex</span></label>
              <input type="text" value="${htmlEsc(r.name)}" placeholder="www" oninput="updateRecord(${z.id},${r.id},'name',this.value)"></div>
            <div class="field"><label>Type</label>
              <select onchange="updateRecord(${z.id},${r.id},'type',this.value)">${_opts(_RECORD_TYPES, r.type)}</select></div>
            <div class="field"><label>TTL<span class="hint">optional</span></label>
              <input type="number" value="${htmlEsc(r.ttl)}" min="0" style="width:90px" oninput="updateRecord(${z.id},${r.id},'ttl',this.value)"></div>
          </div>
          <div class="field-row">${rdataFields}</div>
        </div>`;
    });
    div.innerHTML = `
      <div class="list-item-header">
        <span class="list-item-title">Zone ${i+1}</span>
        <button class="btn-remove" onclick="removeZone(${z.id})">Remove</button>
      </div>
      <div class="field-row">
        <div class="field"><label>FQDN</label>
          <input type="text" value="${htmlEsc(z.fqdn)}" placeholder="corp.example.com" oninput="updateZone(${z.id},'fqdn',this.value)"></div>
        <div class="field"><label>Kind</label>
          <select onchange="updateZone(${z.id},'kind',this.value)">${_opts(['forward','reverse'], z.kind)}</select></div>
      </div>
      <div class="field-row">
        <div class="field"><label>Primary type</label>
          <input type="text" value="${htmlEsc(z.primary_type)}" oninput="updateZone(${z.id},'primary_type',this.value)"></div>
        <div class="field"><label>Comment</label>
          <input type="text" value="${htmlEsc(z.comment)}" oninput="updateZone(${z.id},'comment',this.value)"></div>
      </div>
      <div class="toggle-field">
        <label class="toggle">
          <input type="checkbox" ${z.create ? 'checked' : ''} onchange="updateZone(${z.id},'create',this.checked)">
          <div class="toggle-track"></div><div class="toggle-thumb"></div>
        </label>
        <label>Create zone if absent (off = add records to an existing zone)</label>
      </div>
      <div style="margin:8px 0 4px"><label>Records<span class="hint">A/AAAA/CNAME/MX/TXT/PTR</span></label></div>
      ${recs}
      <button class="btn-add" onclick="addRecord(${z.id})">+ Add Record</button>`;
    container.appendChild(div);
  });
}

// ── Build YAML ───────────────────────────────────────────────────────────────

function buildYAML() {
  if (builderType === 'address-block') return buildBlockYAML();
  if (builderType === 'dns') return buildDnsYAML();
  return buildSiteYAML();
}

// Shared template-level tags block (all three types support `tags:`)
function tagsYAML() {
  const valid = tags.filter(t => t.key);
  if (!valid.length) return '';
  let out = '\ntags:\n';
  valid.forEach(t => { out += '  ' + esc(t.key) + ': ' + esc(t.value) + '\n'; });
  return out;
}

function buildSiteYAML() {
  const siteName  = v('site-name').trim();
  const siteEnv   = v('site-environment');
  const siteReg   = v('site-region');
  const siteLoc   = v('site-location').trim();
  const ipSpace   = v('net-ip-space').trim();
  const subSize   = v('net-subnet-size').trim();
  const dnsParent = v('dns-parent').trim();
  const dnsView   = v('dns-view').trim();
  const createZone = vb('dns-create-zone');
  const revZone    = vb('dns-reverse-zone');

  let out = '';

  // ── site: ──
  out += 'site:\n';
  out += '  name:        ' + esc(siteName || 'my-site') + '\n';
  if (siteReg) out += '  region:      ' + siteReg + '\n';
  if (siteEnv) out += '  environment: ' + siteEnv + '\n';
  if (siteLoc) out += '  location:    ' + esc(siteLoc) + '\n';

  // ── network: ──
  out += '\nnetwork:\n';
  if (ipSpace)  out += '  ip_space:    ' + esc(ipSpace) + '\n';
  if (subSize)  out += '  subnet_size: ' + subSize + '\n';
  if (subnets.length) {
    out += '  subnets:\n';
    subnets.forEach(s => {
      out += '    - name:    ' + esc(s.name || (siteName ? siteName + '-' + s.purpose : s.purpose)) + '\n';
      out += '      purpose: ' + s.purpose + '\n';
      out += '      cidr:    ' + s.cidr + '\n';
      out += '      dhcp:    ' + (s.dhcp ? 'true' : 'false') + '\n';
      if (s.dhcp) {
        out += '      dhcp_start: ' + s.dhcp_start + '\n';
        out += '      dhcp_end:   ' + s.dhcp_end + '\n';
      }
    });
  }

  // ── dns: ──
  out += '\ndns:\n';
  if (dnsParent) out += '  parent:      ' + esc(dnsParent) + '\n';
  if (dnsView)   out += '  view:        ' + esc(dnsView) + '\n';
  out += '  create_zone:         ' + createZone + '\n';
  out += '  create_reverse_zone: ' + revZone + '\n';

  // ── hosts: ──
  if (hosts.length) {
    out += '\nhosts:\n';
    hosts.forEach(h => {
      out += '  - hostname: ' + esc(h.hostname || 'gw01') + '\n';
      if (h.subnet) out += '    subnet:   ' + esc(h.subnet) + '\n';
      if (h.comment) out += '    comment:  ' + esc(h.comment) + '\n';
    });
  }

  out += tagsYAML();

  return out;
}

function buildBlockYAML() {
  const name    = v('block-name').trim();
  const ipSpace = v('block-ip-space').trim();

  let out = 'type: address-block\n';
  out += 'name: ' + esc(name || 'my-pool') + '\n';
  if (ipSpace) out += 'ip_space: ' + esc(ipSpace) + '\n';

  out += '\naddress_blocks:\n';
  if (!blocks.length) {
    out += '  []\n';
  } else {
    blocks.forEach(b => {
      out += '  - address: ' + esc(b.address || '10.0.0.0') + '\n';
      out += '    cidr: ' + b.cidr + '\n';
      if (b.region)      out += '    region: ' + esc(b.region) + '\n';
      if (b.environment) out += '    environment: ' + esc(b.environment) + '\n';
      if (b.status)      out += '    status: ' + esc(b.status) + '\n';
      if (b.location)    out += '    location: ' + esc(b.location) + '\n';
      if (b.comment)     out += '    comment: ' + esc(b.comment) + '\n';
      if (b.children && b.children.length) {
        out += '    children:\n';
        b.children.forEach(c => {
          out += '      - address: ' + esc(c.address || '10.0.0.0') + '\n';
          out += '        cidr: ' + c.cidr + '\n';
          if (c.region)      out += '        region: ' + esc(c.region) + '\n';
          if (c.environment) out += '        environment: ' + esc(c.environment) + '\n';
          if (c.status)      out += '        status: ' + esc(c.status) + '\n';
          if (c.comment)     out += '        comment: ' + esc(c.comment) + '\n';
        });
      }
    });
  }

  out += tagsYAML();
  return out;
}

function buildDnsYAML() {
  const view = v('dns-builder-view').trim();

  let out = 'type: dns\n';
  if (view) out += 'view: ' + esc(view) + '\n';

  out += '\nzones:\n';
  if (!zones.length) {
    out += '  []\n';
  } else {
    zones.forEach(z => {
      out += '  - fqdn: ' + esc(z.fqdn || 'example.com') + '\n';
      out += '    kind: ' + (z.kind || 'forward') + '\n';
      if (z.primary_type) out += '    primary_type: ' + esc(z.primary_type) + '\n';
      out += '    create: ' + (z.create ? 'true' : 'false') + '\n';
      if (z.comment) out += '    comment: ' + esc(z.comment) + '\n';
      if (z.records && z.records.length) {
        out += '    records:\n';
        z.records.forEach(r => {
          out += '      - name: ' + esc(r.name || '@') + '\n';
          out += '        type: ' + r.type + '\n';
          if (r.type === 'MX') {
            out += '        rdata: {preference: ' + (r.preference != null ? r.preference : 10) +
                   ', exchange: ' + esc(r.exchange || 'mail.' + (z.fqdn || 'example.com')) + '}\n';
          } else {
            out += '        rdata: ' + esc(r.rdata || '') + '\n';
          }
          if (r.ttl) out += '        ttl: ' + r.ttl + '\n';
        });
      }
    });
  }

  out += tagsYAML();
  return out;
}

// ── YAML syntax highlighter ──────────────────────────────────────────────────

function highlightValue(v) {
  if (v === 'true' || v === 'false' || v === 'null')
    return '<span class="yaml-bool">' + htmlEsc(v) + '</span>';
  if (/^-?\d+(\.\d+)?$/.test(v))
    return '<span class="yaml-number">' + htmlEsc(v) + '</span>';
  return '<span class="yaml-string">' + htmlEsc(v) + '</span>';
}

function highlight(text) {
  return text.split('\n').map(line => {
    if (/^\s*#/.test(line))
      return '<span class="yaml-comment">' + htmlEsc(line) + '</span>';
    if (/^\s*-\s/.test(line) && !/:/.test(line))
      return '<span class="yaml-dash">' + htmlEsc(line) + '</span>';
    const kv = line.match(/^(\s*-?\s*)([^:#\s][^:]*?)(\s*:\s*)(.*)$/);
    if (kv) {
      const [, indent, key, sep, val] = kv;
      return htmlEsc(indent) +
             '<span class="yaml-key">' + htmlEsc(key) + '</span>' +
             htmlEsc(sep) +
             (val ? highlightValue(val) : '');
    }
    const listItem = line.match(/^(\s*-\s+)([^:#\s][^:]*?)(\s*:\s*)(.*)$/);
    if (listItem) {
      const [, dash, key, sep, val] = listItem;
      return '<span class="yaml-dash">' + htmlEsc(dash) + '</span>' +
             '<span class="yaml-key">' + htmlEsc(key) + '</span>' +
             htmlEsc(sep) +
             (val ? highlightValue(val) : '');
    }
    return htmlEsc(line);
  }).join('\n');
}

// ── Builder live update ───────────────────────────────────────────────────────

function builderUpdate() {
  const yaml = buildYAML();

  // YAML preview panel
  document.getElementById('yaml-output').innerHTML = highlight(yaml);

  // Keep raw editor in sync if it was generated from builder
  const raw = document.getElementById('raw-editor');
  if (raw.dataset.fromBuilder !== 'false') {
    raw.value = yaml;
    raw.dataset.fromBuilder = 'true';
  }

  // CLI hints
  const tmplFile = currentTemplate || '<template.yaml>';
  document.getElementById('cli-provision').textContent =
    'uddi provision ' + builderType + ' -t ' + tmplFile + ' -v';
  document.getElementById('cli-decommission').textContent =
    'uddi decommission ' + builderType + ' -t ' + tmplFile + ' --force -v';
}

// ── Builder download / copy ───────────────────────────────────────────────────

function downloadBuilderYAML() {
  const yaml     = buildYAML();
  const siteName = v('site-name').trim() || 'site-new';
  const filename = currentTemplate || (siteName + '.yaml');
  const blob = new Blob([yaml], { type: 'text/yaml' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

function copyBuilderYAML() {
  navigator.clipboard.writeText(buildYAML())
    .then(() => {
      const btn = document.getElementById('copy-yaml-btn');
      btn.textContent = 'Copied!';
      btn.classList.add('active');
      setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('active'); }, 1600);
    })
    .catch(() => toast('Copy failed'));
}

// ── Toast ─────────────────────────────────────────────────────────────────────

function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2400);
}
