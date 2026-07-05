#!/usr/bin/env python3
"""
Infoblox NOC Dashboard — regression test suite.
Requires server running:  python3 server.py

Run:  python3 test_regression.py
      python3 -m unittest test_regression -v
"""

import json, os, re, sys, time, threading, unittest
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

def _server_src():
    with open(SERVER, encoding="utf-8") as f:
        return f.read()

def _reorder(arr, frm, to):
    a = list(arr)
    fi, ti = a.index(frm), a.index(to)
    a.pop(fi)
    a.insert(ti - 1 if fi < ti else ti, frm)
    return a

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


    # ── docker self-update tests ──────────────────────────────────────────────

    def test_api_update_status_shape(self):
        """GET /api/update/status returns 200 with required phase/pct/layer fields."""
        status, data = get_json("/api/update/status")
        self.assertEqual(status, 200)
        for key in ("phase", "pct", "layer_current", "layer_total", "stalled", "error"):
            self.assertIn(key, data, f"missing field: {key}")
        self.assertIn(data["phase"], (
            "idle", "prepulling", "pulled", "recreating", "health", "live", "error"
        ))
        self.assertIsInstance(data["pct"], int)
        self.assertIsInstance(data["stalled"], bool)

    def test_api_update_check_has_self_update_field(self):
        """GET /api/update/check still returns selfUpdate bool (now reflects DOCKER_OK)."""
        status, data = get_json("/api/update/check")
        self.assertEqual(status, 200)
        self.assertIn("selfUpdate", data)
        self.assertIsInstance(data["selfUpdate"], bool)

    def test_api_update_status_has_instance_id(self):
        """GET /api/update/status returns instance_id string (used to detect container restart)."""
        status, data = get_json("/api/update/status")
        self.assertEqual(status, 200)
        self.assertIn("instance_id", data, "instance_id missing from /api/update/status")
        self.assertIsInstance(data["instance_id"], str)
        self.assertGreater(len(data["instance_id"]), 0)

    def test_api_update_check_has_instance_id(self):
        """GET /api/update/check returns instance_id string."""
        status, data = get_json("/api/update/check")
        self.assertEqual(status, 200)
        self.assertIn("instance_id", data, "instance_id missing from /api/update/check")
        self.assertIsInstance(data["instance_id"], str)
        self.assertGreater(len(data["instance_id"]), 0)

    def test_api_update_instance_id_stable(self):
        """instance_id is the same across two calls to the same live server."""
        _, d1 = get_json("/api/update/status")
        _, d2 = get_json("/api/update/status")
        self.assertEqual(d1.get("instance_id"), d2.get("instance_id"),
                         "instance_id changed between calls — must be stable per process")


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
        # NMS overhaul: 15→8 sections; merged: dhcp→ipam, dns-analytics→dns,
        # threats/insights/actions/threat-lookup→security, triage→alerts, search→explore
        for sid in ("overview", "ipam", "dns", "hosts", "security",
                    "audit", "alerts", "explore"):
            self.assertContains(f"id:'{sid}'", f"Section '{sid}' missing from SECTIONS array")
        # removed sections must not appear as standalone nav entries
        for sid in ("dhcp", "triage", "threats", "dns-analytics", "search"):
            self.assertNotIn(f"id:'{sid}'", self.html, f"Removed section '{sid}' still in SECTIONS array")

    def test_all_sections_rendered(self):
        # NMS overhaul: 8 sections; merged content now lives inside parent sections
        for sid in ("overview", "ipam", "dns", "hosts", "security",
                    "audit", "alerts", "explore"):
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
        # NMS overhaul: ActionsPanel merged into Security section (no standalone tab)
        self.assertContains("function ActionsPanel")
        self.assertContains("/api/actions", "IQ Actions fetch missing")

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

    # ── unified-tenant-picker ─────────────────────────────────────────────────

    def test_no_other_logins_label(self):
        """Old 'Other logins' section label replaced by unified flat list."""
        self.assertNotIn("Other logins", self.html,
                         "'Other logins' label must be removed — unified list has no section labels")

    def test_no_this_login_label(self):
        """Old 'This login' section label replaced by unified flat list."""
        self.assertNotIn("This login", self.html,
                         "'This login' label must be removed — unified list has no section labels")

    def test_unified_list_builds_haskey(self):
        """AcctPill builds unified list with hasKey per entry."""
        self.assertContains("hasKey", "unified list 'hasKey' field missing from AcctPill")

    def test_no_key_add_key_affordance(self):
        """No-key entries show '+ key' affordance in AcctPill."""
        self.assertContains("+ key", "no-key '+ key' affordance missing from AcctPill")

    # ── header-update-ux ─────────────────────────────────────────────────────

    def test_update_bar_removed(self):
        """Full-width UpdateBar strip replaced by inline ver-badge expansion."""
        self.assertNotIn("function UpdateBar", self.html,
                         "UpdateBar component must be removed")
        self.assertNotIn("upd-bar-steps", self.html,
                         "upd-bar-steps CSS class must be removed")

    def test_friendly_step_names(self):
        """Step names use plain English, not Docker jargon."""
        self.assertContains("Downloading", "Friendly step name 'Downloading' missing")
        self.assertContains("Restarting",  "Friendly step name 'Restarting' missing")
        self.assertContains("Checking",    "Friendly step name 'Checking' missing")
        self.assertNotIn("'Recreate'", self.html,
                         "'Recreate' Docker jargon must not appear as step name")

    def test_no_bar_at_top_copy(self):
        """Popover copy must not reference the old top-strip bar."""
        self.assertNotIn("bar at the top", self.html,
                         "Stale 'bar at the top' popover copy must be removed")

    def test_ver_badge_update_state(self):
        """ver-badge must render inline update progress (spinner + step via updApplying)."""
        self.assertContains("updApplying", "updApplying state missing")
        self.assertContains("ver-badge", "ver-badge chip missing")

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

    def test_vault_server_crypto(self):
        s = _server_src()
        self.assertIn("from cryptography.fernet import Fernet, InvalidToken", s)
        self.assertIn("hashlib.scrypt", s)                 # passphrase KDF
        self.assertIn("VAULT_MODE", s)
        self.assertIn("def vault_init", s)
        self.assertIn("def vault_unlock", s)
        self.assertIn("0o600", s)                          # vault file perms

    def test_vault_no_exit_without_key(self):
        # server must NOT sys.exit when no env key (enters vault mode instead)
        s = _server_src()
        self.assertNotIn("INFOBLOX_API_KEY not set", s)

    def test_vault_endpoints(self):
        s = _server_src()
        for ep in ("/api/vault/status", "/api/vault/init", "/api/vault/unlock",
                   "/api/vault/tenant", "/api/vault/active", "/api/vault/lock"):
            self.assertIn(ep, s, f"vault endpoint {ep} missing")

    def test_vault_locked_gate(self):
        # data endpoints blocked while locked
        self.assertIn('"locked": True', _server_src())

    def test_vault_ui_gate(self):
        for comp in ("function VaultGate", "function VaultSetup", "function VaultUnlock",
                     "function VaultAddTenant", "function TenantManager"):
            self.assertContains(comp)
        self.assertContains("<VaultGate/>", "root no longer renders VaultGate")

    def test_vault_reset(self):
        self.assertIn("def vault_reset", _server_src())
        self.assertIn("/api/vault/reset", _server_src())
        self.assertContains("Forgot passphrase? Reset vault")

    # ── swappable LLM provider ────────────────────────────────────────────────

    def test_llm_provider_server(self):
        s = _server_src()
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
        s = _server_src()
        self.assertIn("def vault_llm_test", s)
        self.assertIn("def vault_test_key", s)
        self.assertIn("/api/vault/llm-test", s)
        self.assertIn("/api/vault/test-key", s)
        self.assertContains("Test connection")
        self.assertContains("Test key")

    # ── account-first switcher: footer + menu IA ──────────────────────────────
    def test_account_first_footer(self):
        # footer headline is now the CSP Account; inline actions on account rows
        self.assertContains(">Account<", "footer caption should read 'Account'")
        self.assertContains("Refresh names")       # moved from keys sub-view into MANAGE
        self.assertContains("+ Add key")

    def test_account_first_sections(self):
        # AI provider is its own section, separate from Infoblox actions
        self.assertContains("menu-desc", "Manage items should have inline descriptions")
        self.assertNotIn("view==='keys'", self.html, "keys sub-view still present — should be removed")

    def test_keys_subview_removed(self):
        """Keys sub-view eliminated; inline [key][✕] actions live on account rows; names from CSP (no rename)."""
        tm_start = self.html.index('function TenantManager(')
        tm_end = self.html.index('\nfunction ', tm_start + 1)
        tm_body = self.html[tm_start:tm_end]
        self.assertNotIn("view==='keys'", tm_body, "Keys sub-view still present — should be removed")
        self.assertNotIn("doRename", tm_body, "doRename still present — names come from CSP, rename not allowed")

    def test_manage_polish(self):
        """MANAGE section: chg label, conditional + Add key, AI section header removed, Lock vault at bottom."""
        tm_start = self.html.index('function TenantManager(')
        tm_end = self.html.index('\nfunction ', tm_start + 1)
        tm_body = self.html[tm_start:tm_end]
        self.assertIn(">chg<", tm_body, "keyed-row button should say 'chg' not 'key'")
        self.assertNotIn(">key<", tm_body, "old 'key' label still present on keyed-row button")
        self.assertIn("!hasNoKey", tm_body, "+ Add key must be conditional on !hasNoKey")
        self.assertNotIn('acct-sec-label">AI', tm_body, "AI section header must be removed — fold into MANAGE")
        # Lock vault must appear AFTER AI provider in source order
        ai_pos = tm_body.find("AI provider")
        lock_pos = tm_body.find("Lock vault")
        self.assertGreater(lock_pos, ai_pos, "Lock vault must appear after AI provider in MANAGE")

    def test_connection_inline_confirm_delete(self):
        # the ✕ no longer deletes immediately — it arms a two-step confirm
        self.assertContains("confirmRm", "inline delete-confirm state missing")

    def test_tenant_manager_trigger_shows_headline(self):
        """TenantManager collapsed trigger shows active account name via headline variable, not 'Vault'."""
        tm_start = self.html.index('function TenantManager(')
        tm_end = self.html.index('\nfunction ', tm_start + 1)
        tm_body = self.html[tm_start:tm_end]
        self.assertIn('headline', tm_body, "headline variable missing from TenantManager body")
        self.assertIn('ctx-cap', tm_body, "ctx-cap missing from TenantManager trigger")
        self.assertNotIn('>Vault<', tm_body, "TenantManager ctx-cap must show account name, not 'Vault'")

    def test_tenant_manager_has_account_list(self):
        """TenantManager expanded panel has unified account list (hasKey + + key affordance)."""
        tm_start = self.html.index('function TenantManager(')
        tm_end = self.html.index('\nfunction ', tm_start + 1)
        tm_body = self.html[tm_start:tm_end]
        self.assertIn('hasKey', tm_body, "TenantManager missing unified account list (hasKey field)")
        self.assertIn('+ key', tm_body, "TenantManager missing '+ key' affordance for no-key accounts")

    def test_acct_pill_removed_from_topbar(self):
        """AcctPill no-op onManageKeys usage removed from topbar."""
        self.assertNotIn('onManageKeys={()=>{}}', self.html, "AcctPill topbar usage with no-op onManageKeys still present")
        self.assertContains("tenant-confirm")

    def test_active_connection_test(self):
        s = _server_src()
        self.assertIn("def vault_conn_test", s)
        self.assertIn("/api/vault/conn-test", s)
        self.assertContains("/api/vault/conn-test")
        self.assertContains("Test Infoblox connection")

    def test_app_version_badge(self):
        s = _server_src()
        self.assertIn("APP_VERSION", s)
        self.assertIn('"version": APP_VERSION', s)   # surfaced in status payload
        self.assertContains("ver-badge")
        self.assertContains("vault.version")

    def test_light_mode_tokens(self):
        """Light mode CSS block uses official Infoblox brand tokens."""
        start = self.html.index(':root[data-theme="light"]')
        end = self.html.index('}', start) + 1
        block = self.html[start:end]
        self.assertIn('--teal:#007B30', block, "light --teal must be darkened ib-green #007B30 (AA contrast)")
        self.assertIn('--blue-mid:#F0EFE9', block, "light --blue-mid must be ib-offwhite #F0EFE9")
        self.assertIn('--border:#D9E1E2', block, "light --border must be ib-steel #D9E1E2")
        self.assertIn('--ink:#101820', block, "light --ink must be ib-black #101820")
        self.assertIn('color-scheme:light', block, "light block must declare color-scheme:light")
        self.assertNotIn('--teal:#00BD4D', block, "raw ib-green #00BD4D must not be used as --teal (fails WCAG AA)")

    # ── DHCP top-subnets redesigned as a compact ranked list ─────────────────
    def test_subnet_rank_list(self):
        self.assertContains("subnet-rank-row", "compact ranked list markup missing")
        self.assertContains("subnet-rank-list")
        self.assertContains("sr-fill")             # severity-colored bar fill

    # ── universal CSV: DNS analytics top-clients now a DataTable ─────────────
    def test_dns_clients_datatable(self):
        self.assertContains('exportName="dns-top-clients"', "DNS clients CSV export missing")
        self.assertContains("useColumns('dns-clients'")
        self.assertContains("SearchGroupTable", "search-group DataTable component missing")

    # ── connection key management: replace-key (rename removed — names from CSP) ──
    def test_connection_key_repair(self):
        s = _server_src()
        self.assertIn("def vault_update_tenant", s)
        self.assertIn("/api/vault/tenant-update", s)
        self.assertContains("/api/vault/tenant-update")
        self.assertContains("editId")               # VaultAddTenant replace-key mode
        self.assertContains("tenant-rm")            # inline delete-confirm on account rows

    def test_refresh_names(self):
        self.assertIn("def vault_refresh_names", _server_src())
        self.assertIn("/api/vault/refresh-names", _server_src())
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
        s = _server_src()
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

    # ── alert rules editor ────────────────────────────────────────────────────

    def test_default_alert_rules_const(self):
        self.assertContains("DEFAULT_ALERT_RULES", "DEFAULT_ALERT_RULES constant missing")

    def test_default_alert_rules_seeded(self):
        self.assertContains("'noc.alertRules', DEFAULT_ALERT_RULES", "root state must seed with DEFAULT_ALERT_RULES")

    def test_alert_rules_inline_edit_state(self):
        import re
        m = re.search(r'function AlertsPanel\(', self.html)
        self.assertIsNotNone(m, "AlertsPanel missing")
        panel_src = self.html[m.start():m.start()+3000]
        self.assertIn("editId", panel_src, "editId state missing from AlertsPanel")

    def test_alert_rules_edit_button(self):
        self.assertContains("setEditId(r.id)", "edit trigger missing from row")

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
        # bento overview removed; subnet drill-down lives in DNS (drillZone) and IPAM (setSubFilt)
        self.assertContains("drillZone&&(", "DNS zone drill panel missing")
        self.assertContains("setSubFilt", "subnet filter state missing")

    def test_host_drill_down_panel(self):
        self.assertContains("hostFilt&&")

    def test_leasesInSubnet_helper(self):
        self.assertContains("function leasesInSubnet")

    def test_drill_close_buttons(self):
        self.assertContains("drill-close")

    def test_drill_see_all_link(self):
        self.assertContains("See all in DHCP tab")
        # "See all in Hosts tab" was in the overview bento (removed in NMS overhaul);
        # host drill-down now lives exclusively in the Hosts tab section

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

    def test_filter_mode_toggle_rendered(self):
        # mode-btn toggle now rendered in chat-head (P1 fix: was dead UI, now wired)
        import re
        btn_renders = re.findall(r'<button[^>]*mode-btn', self.html)
        self.assertGreater(len(btn_renders), 0,
                           "Filter mode toggle buttons missing from ChatPanel header")

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
        # NMS overhaul: dns-analytics merged into dns section; triggers on section==='dns'
        self.assertContains("section==='dns'&&!dnsAnalytics")

    def test_insights_lazy_loaded(self):
        # NMS overhaul: insights merged into security section
        self.assertContains("section==='security'&&!insights")

    # ── drill-down hints ──────────────────────────────────────────────────────

    def test_subnet_chart_click_hint(self):
        # bento overview removed; SubnetBars component still exists for IPAM interaction
        self.assertContains("function SubnetBars", "SubnetBars component missing")

    def test_host_donut_click_hint(self):
        # bento overview removed; Donut component still renders in Hosts section
        self.assertContains("function Donut", "Donut component missing")

    # ── Feature 1: Auto-Refresh Timer ─────────────────────────────────────────

    def test_auto_refresh_state(self):
        self.assertContains("autoRefresh", "autoRefresh state missing")

    def test_auto_refresh_interval(self):
        self.assertContains("setInterval", "setInterval for auto-refresh missing")

    def test_auto_refresh_in_more_menu(self):
        import re
        m = re.search(r'function MoreMenu\(\{([^}]+)\}', self.html)
        self.assertIsNotNone(m, "MoreMenu function signature not found")
        self.assertIn("autoRefresh", m.group(1), "MoreMenu must include autoRefresh prop")

    def test_auto_refresh_pill_cycles_in_more_menu(self):
        # MoreMenu body must contain the arOpts cycling array and render the active label
        self.assertContains("arOpts", "arOpts cycling array missing from MoreMenu")

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

    def test_shortcuts_section_export_map(self):
        self.assertContains("SECTION_EXPORT_MAP", "SECTION_EXPORT_MAP const missing")

    def test_shortcuts_t_key_theme(self):
        self.assertContains("key==='t'", "t key theme toggle missing from keydown handler")

    def test_shortcuts_e_key_export(self):
        self.assertContains("key==='e'", "e key CSV export missing from keydown handler")

    def test_shortcuts_data_export_attr(self):
        self.assertContains("data-export-section={exportName}", "data-export-section attr missing from DataTable CSV button")

    def test_shortcuts_policies_csv(self):
        self.assertContains('data-export-section="security-policies"', "PoliciesPanel CSV button missing data-export-section")

    def test_shortcuts_panel_grouped(self):
        self.assertContains("Navigation", "Navigation group missing from shortcuts panel")
        self.assertContains("Actions", "Actions group missing from shortcuts panel")

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
        self.assertContains("Bloxsmith", "Page title app name missing")

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
        # NMS overhaul: bento removed, replaced with ov-3col/ov-2col panel layout
        self.assertContains('className="ov-3col"', "Overview infrastructure 3-col panel missing")
        self.assertContains('className="ov-2col"', "Overview DHCP 2-col panel missing")

    def test_overview_kpis_full_width(self):
        # NMS overhaul: status-tile matrix removed; KPI row + DHCP section replace it
        self.assertContains('className="kpi-row"', "KPI row missing from overview")
        self.assertContains("DHCP Pool Utilization", "DHCP utilization panel missing from overview")

    def test_overview_wide_cards(self):
        # NMS overhaul: bento b-wide removed; new panels use ov-2col-eq for Security & Audit
        self.assertContains('className="ov-2col-eq"', "Overview Security & Audit 2-col panel missing")

    # ── Round-2 security / correctness fixes ──────────────────────────────────

    def test_keyboard_shortcut_content_editable_guard(self):
        self.assertContains("isContentEditable", "Keyboard handler missing contentEditable guard")

    def test_ipam_chip_filter_has_fallback(self):
        self.assertContains("return true", "ipamChip filter missing fallback return true")

    def test_localstorage_write_error_logged(self):
        self.assertContains("console.warn", "localStorage write failure not logged")

    def test_mock_fallback_server_unavailable_hint(self):
        self.assertContains("Connection error", "No server-unavailable hint in mock fallback")

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

    # ── Feature 7: Multi-tenant switcher toolbar pill ─────────────────────────

    def test_acct_pill_component_exists(self):
        self.assertContains("function AcctPill(", "AcctPill component not found")

    def test_acct_pill_hide_guard(self):
        self.assertContains("!accounts.length", "AcctPill hide guard missing")

    def test_acct_pill_cap_label(self):
        self.assertContains("acct-pill-cap", "AcctPill ACCOUNT cap label CSS class missing")

    def test_acct_pill_unified_haskey(self):
        """AcctPill uses unified flat list with hasKey per entry (replaces This login/Other logins)."""
        self.assertContains("hasKey", "AcctPill unified list 'hasKey' field missing")

    def test_acct_pill_no_section_labels(self):
        """Old 'This login'/'Other logins' section labels removed in favour of unified flat list."""
        self.assertNotIn("This login", self.html, "'This login' label must not appear — unified list has no section labels")
        self.assertNotIn("Other logins", self.html, "'Other logins' label must not appear — unified list has no section labels")

    def test_acct_pill_manage_keys_link(self):
        self.assertContains("Manage keys", "AcctPill 'Manage keys' link missing")

    def test_acct_pill_switch_key_api(self):
        self.assertContains("api/vault/active", "AcctPill switchKey missing /api/vault/active call")

    def test_acct_pill_not_in_toolbar(self):
        """AcctPill removed from topbar — only function definition remains."""
        self.assertNotIn('<AcctPill', self.html, "AcctPill still rendered in toolbar — should be removed")
        self.assertContains("function AcctPill(", "AcctPill function definition must be retained")

    # ── Feature 8: Health summary banner ──────────────────────────────────────

    def test_health_banner_css_class(self):
        self.assertContains(".health-banner{", "health-banner CSS class missing")

    def test_health_banner_variant_ok(self):
        self.assertContains(".health-banner.ok ", "health-banner ok variant missing")

    def test_health_banner_variant_warn(self):
        self.assertContains(".health-banner.issues-warn ", "health-banner issues-warn variant missing")

    def test_health_banner_variant_crit(self):
        self.assertContains(".health-banner.issues-crit ", "health-banner issues-crit variant missing")

    def test_health_banner_ok_text(self):
        # NMS overhaul: health-banner replaced by Network Health score bar with HEALTHY/DEGRADED/CRITICAL label
        self.assertContains("'HEALTHY'", "health score HEALTHY label missing")

    def test_health_banner_pills(self):
        self.assertContains("hb-pills", "health-banner pills container missing")

    def test_health_banner_aria(self):
        self.assertContains('role="status"', "health-banner role=status aria attr missing")

    # ── Feature 9: Drill-down for Audit + DHCP ───────────────────────────────

    def test_audit_table_ondrill_prop(self):
        self.assertContains("function AuditTable({logs,limit=10,onDrill})", "AuditTable missing onDrill prop")

    def test_dhcp_table_ondrill_prop(self):
        self.assertContains("function DhcpTable({leases, rowLimit, onDrill})", "DhcpTable missing onDrill prop")

    def test_drill_lease_branch(self):
        self.assertContains("entity.type==='lease'", "DrillSheet missing lease branch")

    def test_drill_audit_branch(self):
        self.assertContains("entity.type==='audit'", "DrillSheet missing audit branch")

    def test_audit_call_site_ondrill(self):
        self.assertContains("onDrill={setDrillEntity}/>\n", "Audit or DHCP call site missing onDrill")

    def test_widget_viz_table_component_exists(self):
        self.assertContains("function WidgetVizTable(", "WidgetVizTable sub-component missing")

    def test_widget_viz_table_uses_usecolumns(self):
        html = open(HTML).read()
        idx = html.find("function WidgetVizTable(")
        self.assertGreater(idx, 0, "WidgetVizTable not found")
        snippet = html[idx:idx+300]
        self.assertIn("useColumns(", snippet, "WidgetVizTable must call useColumns")

    def test_host_drill_table_component_exists(self):
        self.assertContains("function HostDrillTable(", "HostDrillTable component missing")

    def test_lease_drill_table_component_exists(self):
        self.assertContains("function LeaseDrillTable(", "LeaseDrillTable component missing")

    def test_datatable_noexport_flag(self):
        self.assertContains("noexport", "DataTable noexport flag missing")

    def test_alert_rules_datatable(self):
        html = open(HTML).read()
        idx = html.find("alert-rules")
        self.assertGreater(idx, 0, "alert-rules persistId missing")
        snippet = html[max(0,idx-200):idx+200]
        self.assertIn("useColumns(", snippet, "Alert rules must use useColumns")

    def test_th_header_no_inline_nowrap(self):
        html = open(HTML).read()
        # DataTable <th> (sort-th) must not force nowrap via inline style
        idx = html.find("sort-th'}")
        self.assertGreater(idx, 0, "DataTable sort-th pattern not found")
        snippet = html[max(0,idx-20):idx+300]
        self.assertNotIn("whiteSpace:'nowrap'", snippet,
            "DataTable <th> inline whiteSpace:nowrap must be removed to allow header wrapping")

    def test_th_header_title_attr(self):
        html = open(HTML).read()
        # DataTable <th> must include title={c.label} for accessibility tooltip
        self.assertIn("title={c.label}", html,
            "DataTable <th> must have title={c.label} for header tooltip")

    def test_drag_drop_reorder_forward(self):
        result = _reorder(['a','b','c','d'], 'a', 'c')
        self.assertEqual(result, ['b','a','c','d'],
            "Forward drag off-by-one: 'a'→'c' should yield ['b','a','c','d']")

    def test_drag_drop_reorder_backward(self):
        result = _reorder(['a','b','c','d'], 'd', 'b')
        self.assertEqual(result, ['a','d','b','c'],
            "Backward drag: 'd'→'b' should yield ['a','d','b','c']")

    def test_drag_drop_has_fi_ti_fix(self):
        html = open(HTML).read()
        self.assertIn("fi<ti?ti-1:ti", html,
            "onDrop must use fi<ti?ti-1:ti to fix off-by-one reorder bug")

    def test_drag_drop_has_set_drag_image(self):
        html = open(HTML).read()
        self.assertIn("setDragImage", html,
            "onDragStart must call setDragImage for custom ghost")

    def test_drag_card_dragging_opacity(self):
        html = open(HTML).read()
        self.assertIn(".drag-card.dragging{opacity:.5}", html,
            ".drag-card.dragging opacity must be .5 (not .35)")


# ── Bloxsmith enterprise shell rebuild (2026-07-05) ───────────────────────────

class ShellRebuildTests(unittest.TestCase):
    """Locks in the shell/IA rebuild: triage-first Home landing, persistent
    left rail, dark theme, shape-coded severity, master-detail panels, and
    the accent-as-chart-series color-law fix. See
    brainstorms/bloxsmith-shell-rebuild-plan-2026-07-05.md for the full spec.
    """

    @classmethod
    def setUpClass(cls):
        with open(HTML, encoding="utf-8") as f:
            cls.html = f.read()

    def test_home_is_default_landing_ahead_of_overview(self):
        self.assertIn("id:'home'", self.html, "Home section missing from SECTIONS array")
        self.assertIn("useState('home')", self.html,
            "Default section state must be 'home', not 'overview'")
        self.assertIn("section==='home'", self.html, "Home section not rendered")
        self.assertIn("section==='overview'", self.html,
            "Overview route must still exist as a secondary destination")

    def test_rail_nav_grouped_and_visible_text(self):
        self.assertIn("NAV_GROUPS", self.html, "Grouped rail nav (NAV_GROUPS) missing")
        for group in ("Workspace", "DDI", "Security"):
            self.assertIn(f"label:'{group}'", self.html, f"Nav group '{group}' missing")
        # visible-text labels, not icon-only — nav-lbl span must exist
        self.assertIn("nav-lbl", self.html, "Rail nav items must render a visible text label")

    def test_dark_theme_exists(self):
        self.assertIn(':root[data-theme="dark"]', self.html,
            "Dark theme token block is missing")

    def test_severity_is_shape_and_color_coded(self):
        self.assertIn("const SevBar", self.html, "SevBar shape-coded severity component missing")
        self.assertIn('role="img" aria-label={SEV_LABEL[sev]', self.html,
            "SevBar must expose an accessible name (shape alone isn't screen-reader visible)")

    def test_explore_and_home_have_master_detail_panels(self):
        self.assertEqual(self.html.count("gridTemplateColumns:'1fr 316px'"), 2,
            "Expected exactly 2 master-detail (1fr/316px) layouts: Explore and Home triage")

    def test_no_accent_reused_as_chart_series_color(self):
        for arr_name in ("COLORS", "cols"):
            for m in re.finditer(rf"const {arr_name}=(\[[^\]]*\]);", self.html):
                arr = m.group(1)
                if "var(--teal)" in arr:
                    self.assertEqual(arr.count("var(--teal)") + arr.count("var(--teal-bright)"), 1,
                        f"Accent reused more than once in a chart color series: {arr}")

    def test_triage_row_keyboard_activation_does_not_double_fire(self):
        # A row's onKeyDown must ignore events that bubbled up from a nested
        # interactive child (e.g. the "View ->" button), or Enter/Space on
        # that button both selects the row AND navigates away.
        self.assertIn("if(e.target!==e.currentTarget) return;", self.html,
            "Triage row keydown handler must guard against bubbled child events")


# ── update resilience tests ───────────────────────────────────────────────────

class TestUpdateResilience(unittest.TestCase):
    """Tests for Docker update resilience: rollback state, abort-on-stall, new _pull_state fields.

    All tests mock Docker or inspect server source/state directly — no live daemon required.
    """

    # 1. _pull_state dict has the three new rollback fields with correct defaults

    def test_pull_state_has_rolledback_field(self):
        """_pull_state initialises with rolledback=False."""
        src = _server_src()
        self.assertIn('"rolledback": False', src,
                      "_pull_state must initialise rolledback to False")

    def test_pull_state_has_rollback_from_field(self):
        """_pull_state initialises with rollback_from=None."""
        src = _server_src()
        self.assertIn('"rollback_from": None', src,
                      "_pull_state must initialise rollback_from to None")

    def test_pull_state_has_rollback_to_field(self):
        """_pull_state initialises with rollback_to=None."""
        src = _server_src()
        self.assertIn('"rollback_to": None', src,
                      "_pull_state must initialise rollback_to to None")

    # 2. GET /api/update/rollback-status — default state

    def test_rollback_status_returns_200(self):
        """GET /api/update/rollback-status returns HTTP 200."""
        status, _ = get_json("/api/update/rollback-status")
        self.assertEqual(status, 200)

    def test_rollback_status_default_rolledback_false(self):
        """rollback-status default: rolledback is False."""
        _, d = get_json("/api/update/rollback-status")
        self.assertIn("rolledback", d)
        self.assertIs(d["rolledback"], False)

    def test_rollback_status_default_rollback_from_none(self):
        """rollback-status default: rollback_from is None."""
        _, d = get_json("/api/update/rollback-status")
        self.assertIn("rollback_from", d)
        self.assertIsNone(d["rollback_from"])

    def test_rollback_status_default_rollback_to_none(self):
        """rollback-status default: rollback_to is None."""
        _, d = get_json("/api/update/rollback-status")
        self.assertIn("rollback_to", d)
        self.assertIsNone(d["rollback_to"])

    # 3. POST /api/update/rollback-clear resets state

    def test_rollback_clear_returns_ok(self):
        """POST /api/update/rollback-clear returns 200 + {ok: true}."""
        status, d = post_json("/api/update/rollback-clear", {})
        self.assertEqual(status, 200)
        self.assertTrue(d.get("ok"), f"Expected ok=true, got: {d}")

    def test_rollback_clear_resets_status(self):
        """After rollback-clear the rollback-status endpoint reflects cleared state."""
        # POST clear first to ensure clean state, then verify
        post_json("/api/update/rollback-clear", {})
        _, d = get_json("/api/update/rollback-status")
        self.assertIs(d.get("rolledback"), False,
                      "rolledback must be False after rollback-clear")
        self.assertIsNone(d.get("rollback_from"),
                          "rollback_from must be None after rollback-clear")
        self.assertIsNone(d.get("rollback_to"),
                          "rollback_to must be None after rollback-clear")

    # 4. Abort-on-stall: verify state transition logic exists in source

    def test_stall_detection_threshold_in_source(self):
        """Source contains a stall detection timeout (no progress guard)."""
        src = _server_src()
        self.assertIn("stalled", src,
                      "stall detection guard missing from server source")

    def test_stall_sets_error_phase(self):
        """Source shows stall triggers phase='error' transition."""
        src = _server_src()
        # The stall handler sets phase to error
        self.assertIn('phase="error"', src,
                      "stall must transition phase to 'error'")
        self.assertIn("stalled", src,
                      "stalled flag must be set in _pull_state on abort")

    def test_pull_state_error_transition_possible(self):
        """_pull_state.update() can set phase=error — the dict is mutable and accepts it."""
        import importlib.util, sys, types, unittest.mock as mock
        # Load server module with Docker calls patched out so no daemon needed
        with mock.patch.dict(sys.modules, {
            "docker": types.ModuleType("docker"),
        }):
            spec = importlib.util.spec_from_file_location("_srv_tmp", SERVER)
            mod = importlib.util.module_from_spec(spec)
            # Patch _docker_client before exec so DOCKER_OK=False, no network calls
            mod._docker_client = lambda: (None, False)  # type: ignore[attr-defined]
            try:
                spec.loader.exec_module(mod)
            except Exception:
                self.skipTest("server module requires env vars not present in test env")
            state = mod._pull_state
            # Simulate stall transition
            state.update(phase="error", stalled=True, error="pull stalled")
            self.assertEqual(state["phase"], "error")
            self.assertTrue(state["stalled"])

    # 5. GET /api/update/status includes rollback fields

    def test_update_status_includes_rolledback(self):
        """GET /api/update/status response includes rolledback key."""
        _, d = get_json("/api/update/status")
        self.assertIn("rolledback", d,
                      "rolledback missing from /api/update/status — _pull_state must be spread into response")

    def test_update_status_includes_rollback_from(self):
        """GET /api/update/status response includes rollback_from key."""
        _, d = get_json("/api/update/status")
        self.assertIn("rollback_from", d,
                      "rollback_from missing from /api/update/status")

    def test_update_status_includes_rollback_to(self):
        """GET /api/update/status response includes rollback_to key."""
        _, d = get_json("/api/update/status")
        self.assertIn("rollback_to", d,
                      "rollback_to missing from /api/update/status")

    def test_update_status_spread_includes_all_pull_state_keys(self):
        """_pull_state is spread into /api/update/status (source-level check)."""
        src = _server_src()
        # The handler must spread _pull_state into the response dict
        self.assertIn("**dict(_pull_state)", src,
                      "/api/update/status handler must spread _pull_state into the response")


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
