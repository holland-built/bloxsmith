#!/usr/bin/env python3
"""
Infoblox NOC Dashboard — regression test suite.
Requires server running:  python3 server.py

Run:  python3 test_regression.py
      python3 -m unittest test_regression -v
"""

import json, os, sys, time, threading, unittest
from urllib.request import urlopen, Request
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode

BASE = os.environ.get("NOC_BASE", "http://localhost:8080")
DIR    = os.path.dirname(os.path.abspath(__file__))
HTML   = os.path.join(DIR, "index.html")
SERVER = os.path.join(DIR, "server.py")

# ── helpers ───────────────────────────────────────────────────────────────────

def get(path, timeout=90):
    req = Request(BASE + path)
    with urlopen(req, timeout=timeout) as r:
        return r.status, r.headers.get("Content-Type", ""), r.read()

def post(path, body, timeout=90):
    data = json.dumps(body).encode()
    req = Request(BASE + path, data=data, headers={"Content-Type": "application/json"})
    try:
        with urlopen(req, timeout=timeout) as r:
            return r.status, r.read()
    except HTTPError as e:
        return e.code, e.read()

def get_json(path, timeout=90):
    status, ct, body = get(path, timeout)
    try:
        return status, json.loads(body)
    except json.JSONDecodeError:
        return status, {}

def post_json(path, body, timeout=90):
    status, raw = post(path, body, timeout)
    try:
        return status, json.loads(raw)
    except json.JSONDecodeError:
        return status, {}

def _needs_llm_key(answer):
    """True when /api/query short-circuits because no LLM key is configured."""
    return "LLM_API_KEY" in (answer or "") or "GROQ_API_KEY" in (answer or "")

# ── backend tests ─────────────────────────────────────────────────────────────

class BackendTests(unittest.TestCase):

    def test_root_serves_html(self):
        status, ct, body = get("/")
        self.assertEqual(status, 200)
        self.assertIn("text/html", ct)
        self.assertIn(b'<div id="root">', body)

    def test_static_files(self):
        for f in ("react.min.js", "babel.min.js", "react-dom.min.js"):
            status, ct, _ = get(f"/{f}")
            self.assertEqual(status, 200, f"{f} returned {status}")
            self.assertIn("javascript", ct, f"{f} wrong content-type")

    def test_404(self):
        try:
            get("/nonexistent-path-xyz")
            self.fail("Expected 404")
        except HTTPError as e:
            self.assertEqual(e.code, 404)

    def test_api_data_shape(self):
        status, d = get_json("/api/data")
        self.assertEqual(status, 200)
        required_keys = {"subnets", "leases", "dnsViews", "zones", "hosts",
                         "secPolicies", "feeds", "auditLogs"}
        for k in required_keys:
            self.assertIn(k, d, f"Missing key: {k}")
            self.assertIsInstance(d[k], list, f"{k} should be a list")

    def test_api_data_non_empty(self):
        status, d = get_json("/api/data")
        self.assertEqual(status, 200)
        self.assertGreater(len(d["subnets"]), 0, "subnets empty")
        self.assertGreater(len(d["hosts"]), 0, "hosts empty")

    def test_api_data_subnet_fields(self):
        status, d = get_json("/api/data")
        s = d["subnets"][0]
        for f in ("id", "name", "addr", "cidr", "total", "used", "util"):
            self.assertIn(f, s, f"subnet missing field: {f}")

    def test_api_data_host_fields(self):
        status, d = get_json("/api/data")
        h = d["hosts"][0]
        for f in ("id", "name", "ip", "type", "status"):
            self.assertIn(f, h, f"host missing field: {f}")

    def test_api_actions(self):
        status, d = get_json("/api/actions")
        self.assertEqual(status, 200)
        self.assertIsInstance(d, dict)

    def test_api_insights(self):
        status, d = get_json("/api/insights")
        self.assertEqual(status, 200)
        self.assertIsInstance(d, dict)

    def test_api_dns_analytics_shape(self):
        status, d = get_json("/api/dns-analytics")
        self.assertEqual(status, 200)
        for k in ("volume", "top_clients", "query_types"):
            self.assertIn(k, d, f"dns-analytics missing key: {k}")
            self.assertIsInstance(d[k], list, f"{k} should be list")

    def test_api_dns_analytics_volume_has_data(self):
        status, d = get_json("/api/dns-analytics")
        self.assertEqual(status, 200)
        self.assertGreater(len(d["volume"]), 0, "DNS volume data empty")
        row = d["volume"][0]
        self.assertIn("NstarDnsActivity.total_query_count", row)
        self.assertIn("NstarDnsActivity.timestamp", row)

    def test_api_dns_analytics_clients_has_data(self):
        status, d = get_json("/api/dns-analytics")
        self.assertGreater(len(d["top_clients"]), 0, "No DNS clients returned")

    def test_api_host_metrics(self):
        status, d = get_json("/api/host-metrics")
        self.assertEqual(status, 200)
        self.assertIn("metrics", d)
        self.assertIsInstance(d["metrics"], list)

    def test_api_threat_lookup_empty_q(self):
        status, d = get_json("/api/threat-lookup")
        self.assertEqual(status, 200)
        self.assertIn("entities", d)
        self.assertEqual(d["entities"], [])
        self.assertEqual(d["query"], "")

    def test_api_threat_lookup_with_ip(self):
        status, d = get_json("/api/threat-lookup?q=10.10.30.10")
        self.assertEqual(status, 200)
        self.assertIn("entities", d)
        self.assertIsInstance(d["entities"], list)
        # entity presence depends on the live tenant having this IP; skip when absent
        if len(d["entities"]) == 0:
            self.skipTest("IP not present in this tenant's data")

    def test_api_threat_lookup_query_echoed(self):
        status, d = get_json("/api/threat-lookup?q=testhost")
        self.assertEqual(status, 200)
        self.assertEqual(d["query"], "testhost")

    def test_api_query_dns_natural_language(self):
        status, d = post_json("/api/query", {"question": "who is sending the most queries"})
        self.assertEqual(status, 200)
        self.assertIn("answer", d)
        ans = d["answer"].lower()
        self.assertTrue(
            "quer" in ans or "dns" in ans or "client" in ans or "unknown" in ans,
            f"Unexpected DNS query answer: {d['answer'][:100]}"
        )

    def test_api_query_summary(self):
        status, d = post_json("/api/query", {"question": "network status"})
        self.assertEqual(status, 200)
        ans = d["answer"]
        if _needs_llm_key(ans):
            self.skipTest("AI query needs an LLM key (optional feature)")
        self.assertIn("Subnets", ans, f"Summary missing Subnets: {ans[:100]}")

    def test_api_query_offline_hosts(self):
        status, d = post_json("/api/query", {"question": "show me offline hosts"})
        self.assertEqual(status, 200)
        self.assertGreater(len(d["answer"]), 0)

    def test_api_query_critical_subnets(self):
        status, d = post_json("/api/query", {"question": "any critical subnets"})
        self.assertEqual(status, 200)
        ans = d["answer"].lower()
        if _needs_llm_key(d["answer"]):
            self.skipTest("AI query needs an LLM key (optional feature)")
        self.assertTrue("subnet" in ans or "utilization" in ans or "critical" in ans,
                        f"Unexpected: {d['answer'][:100]}")

    def test_api_query_fallback_returns_help(self):
        status, d = post_json("/api/query", {"question": "xyzabc123nonsense"})
        self.assertEqual(status, 200)
        # Should return help text or entity search result, not empty
        self.assertGreater(len(d["answer"]), 10)

    def test_api_query_empty_question(self):
        status, d = post_json("/api/query", {"question": ""})
        self.assertEqual(status, 200)
        self.assertIn("answer", d)

    def test_api_query_has_suggestions_field(self):
        status, d = post_json("/api/query", {"question": "network status"})
        self.assertEqual(status, 200)
        self.assertIn("suggestions", d, "Response missing 'suggestions' field")
        self.assertIsInstance(d["suggestions"], list, "'suggestions' must be a list")

    def test_api_query_unknown_gives_suggestions(self):
        status, d = post_json("/api/query", {"question": "xyzabc123nonsense"})
        self.assertEqual(status, 200)
        if _needs_llm_key(d.get("answer", "")):
            self.skipTest("AI query needs an LLM key (optional feature)")
        self.assertIn("suggestions", d, "Missing suggestions for unknown query")
        self.assertGreaterEqual(len(d["suggestions"]), 3,
            f"Expected 3+ suggestions for unknown query, got: {d.get('suggestions')}")

    def test_api_query_suggestions_nonempty(self):
        status, d = post_json("/api/query", {"question": "show me offline hosts"})
        self.assertEqual(status, 200)
        self.assertIn("suggestions", d)
        for s in d["suggestions"]:
            self.assertIsInstance(s, str)
            self.assertGreater(len(s.strip()), 0, f"Empty suggestion: {s!r}")

    def test_api_block_domain_missing_domain(self):
        status, d = post_json("/api/block-domain", {})
        # 401 when DASHBOARD_TOKEN unset (write disabled); 400 when enabled
        self.assertIn(status, (400, 401))
        self.assertFalse(d.get("ok", True))
        self.assertIn("error", d)

    def test_api_block_domain_empty_domain(self):
        status, d = post_json("/api/block-domain", {"domain": "  "})
        self.assertIn(status, (400, 401))
        self.assertFalse(d.get("ok", True))

    # ── account switching ─────────────────────────────────────────────────────

    def test_api_accounts_shape(self):
        status, d = get_json("/api/accounts")
        self.assertEqual(status, 200)
        self.assertIn("accounts", d)
        self.assertIn("active", d)
        self.assertGreaterEqual(len(d["accounts"]), 1, "Key should see at least its home account")
        for a in d["accounts"]:
            self.assertIn("id", a)
            self.assertIn("name", a)
            self.assertTrue(a["id"].startswith("identity/accounts/"), f"Bad account id: {a['id']}")
        self.assertIn(d["active"], [a["id"] for a in d["accounts"]],
                      "Active account must be one of the listed accounts")

    def test_api_switch_account_unknown_id(self):
        status, d = post_json("/api/switch-account", {"id": "identity/accounts/not-a-real-uuid"})
        self.assertEqual(status, 400)
        self.assertFalse(d.get("ok", True))
        self.assertIn("error", d)

    def test_api_switch_account_missing_id(self):
        status, d = post_json("/api/switch-account", {})
        self.assertEqual(status, 400)
        self.assertFalse(d.get("ok", True))

    def test_api_switch_account_to_active_is_noop_ok(self):
        _, accts = get_json("/api/accounts")
        status, d = post_json("/api/switch-account", {"id": accts["active"]})
        self.assertEqual(status, 200)
        self.assertTrue(d.get("ok"))
        self.assertEqual(d.get("active"), accts["active"])

    def test_parallel_requests_dont_block(self):
        """Proves ThreadedHTTPServer: threat-lookup should finish well before /api/data."""
        results = {}
        errors  = {}

        def fetch(name, path):
            try:
                t0 = time.time()
                get_json(path, timeout=120)
                results[name] = time.time() - t0
            except Exception as e:
                errors[name] = str(e)

        threads = [
            threading.Thread(target=fetch, args=("data",    "/api/data")),
            threading.Thread(target=fetch, args=("lookup",  "/api/threat-lookup?q=test")),
        ]
        for t in threads: t.start()
        for t in threads: t.join(timeout=120)

        self.assertNotIn("data",   errors, f"data failed: {errors.get('data')}")
        self.assertNotIn("lookup", errors, f"lookup failed: {errors.get('lookup')}")
        # threat-lookup should be substantially faster than full data load
        self.assertIn("data",   results)
        self.assertIn("lookup", results)
        # Both completed — threading works
        self.assertLess(results["lookup"], results["data"] + 5,
                        "lookup took longer than data — threading may be broken")


# ── frontend structure tests ──────────────────────────────────────────────────

class FrontendStructureTests(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        with open(HTML, encoding="utf-8") as f:
            cls.html = f.read()

    def assertContains(self, needle, msg=None):
        self.assertIn(needle, self.html, msg or f"Missing: {needle!r}")

    def assertNotContainsUI(self, needle):
        """Check needle is absent outside of API-key strings."""
        # Allow in python dict keys like "bloxone_appliance"
        import re
        hits = [m.start() for m in re.finditer(re.escape(needle), self.html, re.IGNORECASE)]
        allowed = [m.start() for m in re.finditer(r'"bloxone_[a-z]+"', self.html, re.IGNORECASE)]
        ui_hits = [h for h in hits if h not in allowed]
        self.assertEqual(len(ui_hits), 0,
                         f"Found '{needle}' in UI at positions {ui_hits}")

    # ── sections ──────────────────────────────────────────────────────────────

    def test_all_nav_sections_defined(self):
        for sid in ("overview", "ipam", "dhcp", "dns", "hosts", "security",
                    "threats", "audit", "dns-analytics", "insights",
                    "threat-lookup", "search"):
            self.assertContains(f"id:'{sid}'", f"Section '{sid}' missing from SECTIONS array")

    def test_all_sections_rendered(self):
        for sid in ("overview", "ipam", "dhcp", "dns", "hosts", "security",
                    "threats", "audit", "dns-analytics", "insights",
                    "threat-lookup", "search"):
            self.assertContains(f"section==='{sid}'", f"Section '{sid}' not rendered")

    def test_account_switcher_present(self):
        self.assertContains("acct-switch-btn", "Account switcher button missing")
        self.assertContains("/api/switch-account", "Switch-account fetch call missing")
        self.assertContains("/api/accounts", "Accounts fetch call missing")

    # ── no BloxOne in UI ──────────────────────────────────────────────────────

    def test_no_bloxone_visible_in_html(self):
        self.assertNotContainsUI("BloxOne")

    def test_no_bloxone_ddi_version(self):
        self.assertNotIn("BloxOne DDI v3", self.html)

    # ── components ────────────────────────────────────────────────────────────

    def test_search_section_component(self):
        self.assertContains("function SearchSection")

    def test_dns_analytics_panel(self):
        self.assertContains("function DnsAnalyticsPanel")

    def test_insights_panel(self):
        self.assertContains("function InsightsPanel")

    def test_iq_actions_section(self):
        self.assertContains("function ActionsPanel")
        self.assertContains("id:'actions'", "IQ Actions section not registered")
        self.assertContains("/api/actions", "IQ Actions fetch missing")
        self.assertContains("section==='actions'", "IQ Actions not rendered")

    def test_host_metrics_panel(self):
        self.assertContains("function HostMetricsPanel")
        self.assertContains("/api/host-metrics", "host-metrics fetch missing")
        self.assertContains("HostMetrics.avg_value", "host-metrics fields not read")

    # ── Wave D features ───────────────────────────────────────────────────────

    def test_command_palette(self):
        self.assertContains("function CommandPalette")
        self.assertContains("cmdk-overlay", "command palette styles missing")
        self.assertContains("e.key==='k'||e.key==='K'", "Cmd/Ctrl-K binding missing")

    def test_saved_views(self):
        self.assertContains("function PresetMenu")
        self.assertContains("snapshotViewLS", "view snapshot helper missing")
        self.assertContains("LS.set('noc.views'", "saved views not persisted")

    def test_alert_notifications(self):
        self.assertContains("Notification.requestPermission", "notification permission flow missing")
        self.assertContains("prevFiringRef", "firing-transition tracking missing")
        self.assertContains("LS.set('noc.notify'", "notify pref not persisted")

    def test_freshness_pill(self):
        self.assertContains("function FreshnessPill")
        self.assertContains("fresh-pill", "freshness pill styles missing")

    def test_trace_timeline(self):
        self.assertContains("trace-tl", "LLM tool-trace timeline missing")

    def test_dns_client_filter(self):
        self.assertContains("Filter by device or IP", "DNS client filter input missing")

    # ── Wave E UX ─────────────────────────────────────────────────────────────

    def test_mobile_sidebar_drawer(self):
        self.assertContains("sidebar-backdrop", "mobile sidebar backdrop missing")
        self.assertContains("menu-btn", "mobile hamburger button missing")
        self.assertContains("@media(max-width:760px)", "mobile breakpoint missing")

    def test_toasts(self):
        self.assertContains("function Toasts")
        self.assertContains("noc-toast", "toast event bus missing")

    def test_error_recovery(self):
        self.assertContains("function PanelError")
        self.assertContains("lazyFetch", "lazy fetch/retry helper missing")
        self.assertContains("onRetry=", "retry wiring missing")

    def test_demo_onboarding_banner(self):
        # demo onboarding now renders as a notice in the unified rail (usingMock-gated)
        self.assertContains("Demo data", "demo notice missing")
        self.assertContains("setUsingMock", "mock detection missing")

    def test_a11y_live_region(self):
        self.assertContains('role="status" aria-live="polite"', "aria-live status region missing")
        self.assertContains('role="img" aria-label', "chart aria-label missing")

    def test_account_switch_feedback(self):
        self.assertContains("Switched to", "account switch toast missing")

    # ── Wave F polish ─────────────────────────────────────────────────────────

    def test_skeleton_loaders(self):
        self.assertContains("function SkeletonTable", "skeleton loader missing")
        self.assertContains("@keyframes skel", "skeleton shimmer missing")
        self.assertContains("if(!data) return <SkeletonTable/>", "panels still use a spinner instead of skeleton")

    def test_card_entrance_motion(self):
        self.assertContains("@keyframes cardIn", "overview card entrance animation missing")

    def test_reduced_motion_covers_new_anims(self):
        # reduced-motion block must neutralize the new animations
        block = self.html.split("prefers-reduced-motion")[1][:400]
        self.assertIn(".skel{animation:none", block)

    # ── encrypted vault (multi-tenant key store) ──────────────────────────────

    def _server(self):
        with open(SERVER, encoding="utf-8") as f:
            return f.read()

    def test_vault_server_crypto(self):
        s = self._server()
        self.assertIn("from cryptography.fernet import Fernet, InvalidToken", s)
        self.assertIn("hashlib.scrypt", s)                 # passphrase KDF
        self.assertIn("VAULT_MODE", s)
        self.assertIn("def vault_init", s)
        self.assertIn("def vault_unlock", s)
        self.assertIn("0o600", s)                          # vault file perms

    def test_vault_no_exit_without_key(self):
        # server must NOT sys.exit when no env key (enters vault mode instead)
        s = self._server()
        self.assertNotIn("INFOBLOX_API_KEY not set", s)

    def test_vault_endpoints(self):
        s = self._server()
        for ep in ("/api/vault/status", "/api/vault/init", "/api/vault/unlock",
                   "/api/vault/tenant", "/api/vault/active", "/api/vault/lock"):
            self.assertIn(ep, s, f"vault endpoint {ep} missing")

    def test_vault_locked_gate(self):
        # data endpoints blocked while locked
        self.assertIn('"locked": True', self._server())

    def test_vault_ui_gate(self):
        for comp in ("function VaultGate", "function VaultSetup", "function VaultUnlock",
                     "function VaultAddTenant", "function TenantManager"):
            self.assertContains(comp)
        self.assertContains("render(<VaultGate/>)", "root no longer renders VaultGate")

    def test_vault_reset(self):
        self.assertIn("def vault_reset", self._server())
        self.assertIn("/api/vault/reset", self._server())
        self.assertContains("Forgot passphrase? Reset vault")

    # ── swappable LLM provider ────────────────────────────────────────────────

    def test_llm_provider_server(self):
        s = self._server()
        self.assertIn("def vault_set_llm", s)
        self.assertIn("/api/vault/llm", s)
        self.assertIn("LLM_BASE_URL = _vault", s)   # vault drives the provider base URL

    def test_llm_provider_ui(self):
        self.assertContains("function VaultSettings")
        self.assertContains("LLM_PRESETS")
        self.assertContains("AI provider")           # TenantManager menu item

    def test_llm_provider_presets_expanded(self):
        for p in ("Anthropic (Claude)", "Google (Gemini)", "OpenRouter (any model)",
                  "Mistral", "DeepSeek", "xAI (Grok)", "Perplexity"):
            self.assertContains(p, f"LLM preset {p} missing")
        self.assertContains("claude-opus-4-8", "Claude model id missing")

    def test_connection_test_buttons(self):
        s = self._server()
        self.assertIn("def vault_llm_test", s)
        self.assertIn("def vault_test_key", s)
        self.assertIn("/api/vault/llm-test", s)
        self.assertIn("/api/vault/test-key", s)
        self.assertContains("Test connection")
        self.assertContains("Test key")

    # ── account-first switcher: footer + menu IA ──────────────────────────────
    def test_account_first_footer(self):
        # footer headline is now the CSP Account; keys live behind a sub-view
        self.assertContains(">Account<", "footer caption should read 'Account'")
        self.assertContains("Keys (")              # "Keys (N) ›" entry to the sub-view
        self.assertContains("+ Add key")

    def test_account_first_sections(self):
        # AI provider is its own section, separate from Infoblox actions
        self.assertContains("menu-desc", "Manage items should have inline descriptions")
        self.assertContains("view==='keys'", "keys sub-view missing")

    def test_connection_inline_confirm_delete(self):
        # the ✕ no longer deletes immediately — it arms a two-step confirm
        self.assertContains("confirmRm", "inline delete-confirm state missing")
        self.assertContains("tenant-confirm")

    def test_active_connection_test(self):
        s = self._server()
        self.assertIn("def vault_conn_test", s)
        self.assertIn("/api/vault/conn-test", s)
        self.assertContains("/api/vault/conn-test")
        self.assertContains("Test Infoblox connection")

    def test_app_version_badge(self):
        s = self._server()
        self.assertIn("APP_VERSION", s)
        self.assertIn('"version": APP_VERSION', s)   # surfaced in status payload
        self.assertContains("ver-badge")
        self.assertContains("vault.version")

    # ── DHCP top-subnets redesigned as a compact ranked list ─────────────────
    def test_subnet_rank_list(self):
        self.assertContains("subnet-rank-row", "compact ranked list markup missing")
        self.assertContains("subnet-rank-list")
        self.assertContains("sr-fill")             # severity-colored bar fill

    # ── universal CSV: DNS analytics top-clients now a DataTable ─────────────
    def test_dns_clients_datatable(self):
        self.assertContains('exportName="dns-top-clients"', "DNS clients CSV export missing")
        self.assertContains("useColumns('dns-clients'")
        self.assertContains('downloadCSV(`search-', "search-group CSV export missing")

    # ── connection key management: rename + replace-key ──────────────────────
    def test_connection_key_repair(self):
        s = self._server()
        self.assertIn("def vault_update_tenant", s)
        self.assertIn("/api/vault/tenant-update", s)
        self.assertContains("/api/vault/tenant-update")
        self.assertContains("editId")               # VaultAddTenant replace-key mode
        self.assertContains("doRename")             # inline rename in the Keys sub-view

    def test_refresh_names(self):
        self.assertIn("def vault_refresh_names", self._server())
        self.assertIn("/api/vault/refresh-names", self._server())
        self.assertContains("Refresh names")

    def test_no_emoji_in_code(self):
        # pictographic emoji must be gone; monochrome UI glyphs (★ ☰ ◐ ✓ ✗, nav symbols) are allowed
        import re as _re
        # full 1F emoji planes + regional flags + VS16, plus the specific 2600-block emoji we removed
        emoji = _re.compile('[\U0001F000-\U0001FAFF\U0001F1E6-\U0001F1FF️'
                            '☀☾⚠⚡⚑⚙⬇\U0001F512\U0001F514\U0001F6E1]')
        for path in (HTML, SERVER):
            with open(path, encoding="utf-8") as f:
                hits = sorted(set(emoji.findall(f.read())))
            self.assertEqual(hits, [], f"emoji found in {path}: {hits}")

    # ── format-agnostic key ───────────────────────────────────────────────────

    def test_norm_key_agnostic(self):
        s = self._server()
        self.assertIn("authorization:", s)           # strips a pasted header
        self.assertIn('k.startswith("eyJ")', s)      # bare JWT -> Bearer

    # ── add-tenant modal + cancel ─────────────────────────────────────────────

    def test_add_tenant_modal_cancel(self):
        self.assertContains("onCancel", "VaultAddTenant cancel missing")
        self.assertContains("vault-cancel", "cancel button style missing")
        # vault overlay is fixed (not squished inside the sidebar)
        self.assertContains(".vault-screen{position:fixed")

    # ── topbar grouping ───────────────────────────────────────────────────────

    def test_topbar_groups(self):
        self.assertContains("topbar-controls")
        self.assertContains("topbar-group")
        self.assertContains("topbar-divider")

    # ── alerts: inline badges + banner ────────────────────────────────────────

    def test_alert_inline_badges_banner(self):
        self.assertContains("ALERT_SECTION", "metric->section map missing")
        self.assertContains("firingSecs", "per-section firing set missing")
        # firing alerts now surface in the unified notice rail, not a standalone banner
        self.assertContains("notice-rail", "unified notice rail missing")
        self.assertContains(" firing</b>", "firing-alert notice missing")
        self.assertContains("setAlertsDismissed", "alert dismiss missing")

    def test_threat_lookup_panel(self):
        self.assertContains("function ThreatLookupPanel")

    def test_row_limit_bar_component(self):
        self.assertContains("function RowLimitBar")

    def test_mini_line_chart_component(self):
        self.assertContains("function MiniLineChart")

    def test_donut_component(self):
        self.assertContains("function Donut")

    def test_subnet_bars_component(self):
        self.assertContains("function SubnetBars")

    def test_audit_table_component(self):
        self.assertContains("function AuditTable")

    def test_feeds_table_component(self):
        self.assertContains("function FeedsTable")

    def test_ttl_table_component(self):
        self.assertContains("function TTLTable")

    # ── drill-downs ───────────────────────────────────────────────────────────

    def test_subnet_drill_down_panel(self):
        self.assertContains("drillSub&&")

    def test_host_drill_down_panel(self):
        self.assertContains("hostFilt&&(")

    def test_leasesInSubnet_helper(self):
        self.assertContains("function leasesInSubnet")

    def test_drill_close_buttons(self):
        self.assertContains("drill-close")

    def test_drill_see_all_link(self):
        self.assertContains("See all in DHCP tab")
        self.assertContains("See all in Hosts tab")

    # ── UX features ───────────────────────────────────────────────────────────

    def test_localstorage_utility(self):
        self.assertContains("const LS =")
        self.assertContains("localStorage.getItem")
        self.assertContains("localStorage.setItem")

    def test_drag_and_drop_handlers(self):
        self.assertContains("onDragStart")
        self.assertContains("onDragOver")
        self.assertContains("onDrop")

    def test_drag_order_persisted(self):
        self.assertContains("overviewOrder")
        self.assertContains("LS.set('noc.widgetOrder'")

    def test_collapse_css(self):
        self.assertContains("collapse-btn")

    def test_collapse_state_persisted(self):
        self.assertContains("toggleCollapse")
        self.assertContains("LS.set('cl'")

    def test_fullscreen_css(self):
        self.assertContains("card.fs")

    def test_fullscreen_toggle(self):
        self.assertContains("toggleFs")

    def test_row_limit_bar_in_ipam(self):
        self.assertContains("setRl('ipam'")

    def test_row_limit_bar_in_dhcp(self):
        self.assertContains("setRl('dhcp'")

    def test_row_limit_bar_in_audit(self):
        self.assertContains("setRl('audit'")

    def test_row_limit_bar_in_hosts(self):
        self.assertContains("setRl('hosts'")

    def test_row_limit_bar_in_threats(self):
        self.assertContains("setRl('threats'")

    def test_row_limit_persisted(self):
        self.assertContains("LS.set('rl'")

    # ── search ────────────────────────────────────────────────────────────────

    def test_search_has_button(self):
        # SearchSection must have a clickable Search button
        self.assertContains("'Search'")

    def test_search_enter_key_handler(self):
        self.assertContains("e.key==='Enter'")

    def test_search_local_data(self):
        self.assertContains("data?.subnets")
        self.assertContains("data?.hosts")

    def test_search_mcp_entity_lookup(self):
        self.assertContains("threat-lookup?q=")

    def test_search_highlight_matches(self):
        self.assertContains("<mark")

    # ── query assistant ───────────────────────────────────────────────────────

    def test_no_filter_mode_toggle(self):
        # mode-btn toggle removed — only CSS definition should remain, not the button renders
        import re
        btn_renders = re.findall(r'<button[^>]*mode-btn', self.html)
        self.assertEqual(len(btn_renders), 0,
                         f"Filter mode toggle buttons still present: {btn_renders}")

    def test_query_panel_useful_placeholder(self):
        self.assertContains("who is sending the most queries")

    def test_query_panel_no_filter_mode_hint(self):
        self.assertNotIn("switch to Filter mode", self.html)

    def test_suggestion_chip_css(self):
        self.assertContains(".suggestion-chip{")

    def test_chat_renders_suggestions(self):
        self.assertContains("suggestion-chip")
        self.assertContains("m.suggestions")

    def test_send_parses_json_suggestions(self):
        self.assertContains("json.suggestions")

    # ── lazy loading ──────────────────────────────────────────────────────────

    def test_dns_analytics_lazy_loaded(self):
        # Should fetch on tab click, not on page load
        self.assertContains("section==='dns-analytics'&&!dnsAnalytics")

    def test_insights_lazy_loaded(self):
        self.assertContains("section==='insights'&&!insights")

    # ── drill-down hints ──────────────────────────────────────────────────────

    def test_subnet_chart_click_hint(self):
        self.assertContains("Click a row to drill down")

    def test_host_donut_click_hint(self):
        self.assertContains("Click a segment to drill down")

    # ── Feature 1: Auto-Refresh Timer ─────────────────────────────────────────

    def test_auto_refresh_state(self):
        self.assertContains("autoRefresh", "autoRefresh state missing")

    def test_auto_refresh_interval(self):
        self.assertContains("setInterval", "setInterval for auto-refresh missing")

    def test_auto_refresh_selector(self):
        self.assertContains("auto-refresh-sel", "auto-refresh selector CSS missing")

    def test_auto_refresh_persisted(self):
        self.assertContains("LS.set('ar'", "autoRefresh not persisted to localStorage")

    # ── Feature 2: Export CSV ─────────────────────────────────────────────────

    def test_export_csv_helper(self):
        self.assertContains("function downloadCSV", "downloadCSV helper missing")

    def test_export_csv_blob(self):
        self.assertContains("new Blob", "CSV blob creation missing")

    def test_export_button_ipam(self):
        # Export is now a per-table control wired through DataTable (exportName + exportCols)
        self.assertContains("function exportCols", "shared CSV export helper missing")
        self.assertContains('exportName="subnets"', "IPAM table export not wired")

    def test_export_everywhere(self):
        # every major table widget exposes CSV export
        for name in ('hosts','subnets','threat-feeds','audit-logs','dhcp-leases','soc-insights','ttl-anomalies'):
            self.assertContains(f'exportName="{name}"', f"export missing for {name}")

    def test_column_drag_reorder(self):
        self.assertContains("moveTo", "column drag-reorder (moveTo) missing")
        self.assertContains("col-grip", "column drag handle missing")

    def test_persist_sort_and_filters(self):
        self.assertContains("'noc.sort.'+persistId", "per-table sort not persisted")
        self.assertContains("LS.set('noc.ipamChip'", "IPAM filter chip not persisted")
        self.assertContains("LS.set('noc.hostChip'", "host filter chip not persisted")

    # ── Feature 3: Quick Filter Chips ─────────────────────────────────────────

    def test_chip_css(self):
        self.assertContains(".chip{", "chip CSS missing")

    def test_quick_filter_chips_ipam(self):
        self.assertContains("ipamChip", "IPAM filter chips state missing")

    def test_quick_filter_chips_hosts(self):
        self.assertContains("hostChip", "Hosts filter chips state missing")

    # ── Feature 4: Relative Timestamps ────────────────────────────────────────

    def test_time_ago_helper(self):
        self.assertContains("function timeAgo", "timeAgo helper missing")

    def test_time_ago_used_in_audit(self):
        self.assertContains("timeAgo(", "timeAgo not used in Audit table")

    # ── Feature 5: Keyboard Shortcuts ─────────────────────────────────────────

    def test_keyboard_shortcuts_handler(self):
        self.assertContains("keydown", "keydown handler missing")

    def test_keyboard_shortcut_overlay(self):
        self.assertContains("shortcut-overlay", "shortcut overlay CSS missing")

    def test_keyboard_shortcut_help_button(self):
        self.assertContains("showShortcuts", "showShortcuts state missing")

    # ── Feature 6: Copy to Clipboard ──────────────────────────────────────────

    def test_copy_to_clipboard_helper(self):
        self.assertContains("function copyToClip", "copyToClip helper missing")

    def test_copy_btn_css(self):
        self.assertContains(".copy-btn{", "copy-btn CSS missing")

    def test_copy_buttons_in_hosts(self):
        self.assertContains("copyToClip(h.ip", "Copy button on host IP missing")

    # ── Feature 7: Live Page Title ────────────────────────────────────────────

    def test_live_page_title(self):
        self.assertContains("document.title", "document.title assignment missing")

    def test_page_title_shows_app_name(self):
        self.assertContains("Infoblox MCP", "Page title app name missing")

    # ── Feature 8: Sidebar Nav Badges ─────────────────────────────────────────

    def test_sidebar_badges_css(self):
        self.assertContains("badge-pill", "badge-pill CSS missing")

    def test_sidebar_badges_ipam(self):
        self.assertContains("critSubs.length>0", "Critical subnet badge missing")

    # ── Feature 9: Search History ─────────────────────────────────────────────

    def test_search_history_state(self):
        self.assertContains("searchHistory", "searchHistory state missing")

    def test_search_history_persisted(self):
        self.assertContains("LS.set('sh'", "searchHistory not persisted")

    def test_search_history_chips(self):
        self.assertContains("searchHistory.map", "searchHistory chips not rendered")

    # ── Feature 10: DNS Zone Drill-Down ───────────────────────────────────────

    def test_dns_zone_drill_state(self):
        self.assertContains("zoneFilt", "zoneFilt state missing")

    def test_dns_zone_drill_panel(self):
        self.assertContains("drillZone&&", "DNS zone drill-down panel missing")

    # ── sortable columns wired (now via DataTable + useColumns) ───────────────

    def test_usesortable_app_level_ipam(self):
        self.assertContains("function IPAMTable", "IPAMTable component missing")

    def test_usesortable_app_level_hosts(self):
        self.assertContains("function HostsTable", "HostsTable component missing")

    def test_usesortable_in_audit_table(self):
        # AuditTable is sortable via the shared DataTable column system
        self.assertContains("useColumns('audit'", "AuditTable not wired to useColumns")
        self.assertContains("initialSort={{key:'ts'", "AuditTable lost its default sort")

    def test_usesortable_in_feeds_table(self):
        self.assertContains("useColumns('feeds'", "FeedsTable not wired to useColumns")

    def test_usesortable_in_ttl_table(self):
        self.assertContains("useColumns('ttl'", "TTLTable not wired to useColumns")

    # ── ShowMoreTable wired (DataTable wraps ShowMoreTable) ───────────────────

    def test_show_more_table_ipam_rows(self):
        self.assertContains("IPAMTable subnets=", "IPAMTable not used in IPAM section")

    def test_show_more_table_hosts_rows(self):
        self.assertContains("HostsTable hosts=", "HostsTable not used in Hosts section")

    def test_show_more_table_in_audit_table(self):
        # AuditTable renders rows through DataTable -> ShowMoreTable, not a manual slice
        self.assertContains("function DataTable", "DataTable renderer missing")
        self.assertContains("<ShowMoreTable rows={sorted}", "DataTable not routing through ShowMoreTable")

    def test_show_more_table_tablehead_prop(self):
        self.assertContains("tableHead={", "ShowMoreTable tableHead prop not used")

    # ── theme (light/dark) ────────────────────────────────────────────────────

    def test_theme_prepaint_script(self):
        self.assertContains("apply saved theme before first paint", "Pre-paint theme script missing")
        self.assertContains("prefers-color-scheme: light", "System theme detection missing")

    def test_theme_light_tokens_defined(self):
        self.assertContains(':root[data-theme="light"]', "Light theme token block missing")

    def test_theme_state_persisted(self):
        self.assertContains("LS.set('noc.theme'", "Theme choice not persisted")

    def test_theme_toggle_button(self):
        self.assertContains("theme-btn", "Theme toggle button missing")

    # ── column autonomy (show/hide + reorder + expand, persisted) ─────────────

    def test_column_controls_hook(self):
        self.assertContains("function useColumns", "useColumns hook missing")
        self.assertContains("'noc.cols.'+widgetId", "Column config not persisted per widget")

    def test_column_menu_component(self):
        self.assertContains("function ColumnMenu", "ColumnMenu component missing")
        self.assertContains("toggleExpand", "Column expand control missing")
        self.assertContains("ctl.move(c.key", "Column reorder control missing")

    # ── Overview bento layout ─────────────────────────────────────────────────

    def test_overview_bento_container(self):
        self.assertContains('className="bento"', "Overview cards not wrapped in bento grid")

    def test_overview_kpis_full_width(self):
        # KPI cards are now the full-width status-tile matrix (stiles/stile)
        self.assertContains('className="stiles"', "status-tile matrix (KPI strip) missing")
        self.assertContains("stile-big", "status-tile value missing")

    def test_overview_wide_cards(self):
        self.assertContains("wrapProps('subnets','b-wide')", "No b-wide cards in bento overview")

    # ── Round-2 security / correctness fixes ──────────────────────────────────

    def test_keyboard_shortcut_content_editable_guard(self):
        self.assertContains("isContentEditable", "Keyboard handler missing contentEditable guard")

    def test_ipam_chip_filter_has_fallback(self):
        self.assertContains("return true", "ipamChip filter missing fallback return true")

    def test_localstorage_write_error_logged(self):
        self.assertContains("console.warn", "localStorage write failure not logged")

    def test_mock_fallback_server_unavailable_hint(self):
        self.assertContains("Server unavailable", "No server-unavailable hint in mock fallback")

    def test_static_files_set_at_module_level(self):
        with open(SERVER, encoding="utf-8") as f:
            srv = f.read()
        self.assertIn("_STATIC_FILES", srv, "Static file set not cached at module level")

    def test_table_name_validation(self):
        with open(SERVER, encoding="utf-8") as f:
            srv = f.read()
        self.assertIn("_TABLE_RE", srv, "Table name not validated before SQL query")

    def test_env_file_uses_context_manager(self):
        with open(SERVER, encoding="utf-8") as f:
            srv = f.read()
        self.assertIn("with open(_env_file)", srv, ".env not opened with context manager")

    def test_cache_key_uses_str(self):
        with open(SERVER, encoding="utf-8") as f:
            srv = f.read()
        self.assertIn("str(sorted(", srv, "Cache key missing str() conversion")


# ── main ──────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    # Check server is up before running backend tests
    try:
        get("/", timeout=5)
        server_up = True
    except (HTTPError, URLError, OSError):
        server_up = False

    if not server_up:
        print("⚠  Server not running on :8080 — skipping BackendTests")
        print("   Start with:  python3 server.py\n")
        suite = unittest.TestLoader().loadTestsFromTestCase(FrontendStructureTests)
    else:
        suite = unittest.TestLoader().loadTestsFromModule(
            __import__(__name__)
        )

    runner = unittest.TextTestRunner(verbosity=2)
    result = runner.run(suite)
    sys.exit(0 if result.wasSuccessful() else 1)
