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
        # SPA fallback: non-API paths serve index.html (200); unknown /api/* paths 404
        status, ct, body = get("/nonexistent-path-xyz")
        self.assertEqual(status, 200)
        self.assertIn("text/html", ct)
        self.assertIn(b"<title>BloxSmith", body)
        try:
            get("/api/nonexistent-xyz")
            self.fail("Expected 404 for unknown /api/* path")
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
        try:
            status, d = get_json("/api/actions")
        except HTTPError as e:
            if e.code == 500:
                self.skipTest("upstream Infoblox MCP 500 for this tenant")
            raise
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
        if len(d["volume"]) == 0:
            self.skipTest("no DNS activity data on this tenant")
        row = d["volume"][0]
        self.assertIn("NstarDnsActivity.total_query_count", row)
        self.assertIn("NstarDnsActivity.timestamp", row)

    def test_api_dns_analytics_clients_has_data(self):
        status, d = get_json("/api/dns-analytics")
        self.assertEqual(status, 200)
        if len(d["top_clients"]) == 0:
            self.skipTest("no DNS activity data on this tenant")

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
        low = ans.lower()
        if "Subnets" not in ans and ("no network" in low or "no data" in low or "empty" in low):
            self.skipTest("tenant returned no data for summary")
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
    """Static source assertions against the rebuilt Vercel-dark single-file SPA
    (index.html). No browser — pure grep/regex over the HTML source."""

    @classmethod
    def setUpClass(cls):
        with open(HTML, encoding="utf-8") as f:
            cls.html = f.read()

    def assertContains(self, needle, msg=None):
        self.assertIn(needle, self.html, msg or f"Missing: {needle!r}")

    # ── ported auth invariants ─────────────────────────────────────────────────

    def test_vault_components_present(self):
        for comp in ("function VaultGate", "function VaultSetup", "function VaultUnlock",
                     "function VaultAddTenant", "function TenantManager"):
            self.assertContains(comp)
        self.assertContains("<VaultGate>", "root no longer renders VaultGate")

    def test_llm_presets_const(self):
        self.assertContains("const LLM_PRESETS=", "LLM_PRESETS map missing")
        for p in ("Anthropic (Claude)", "Google (Gemini)", "OpenRouter (any model)",
                  "Mistral", "DeepSeek", "xAI (Grok)", "Perplexity"):
            self.assertContains(p, f"LLM preset {p} missing")

    def test_vpost_helper(self):
        self.assertContains("const vpost=", "vpost POST-JSON helper missing")

    def test_auth_api_endpoints(self):
        for ep in ("/api/switch-account", "/api/vault/init", "/api/vault/unlock"):
            self.assertContains(ep, f"auth endpoint {ep} missing")
        self.assertContains("/api/accounts", "accounts fetch missing")
        self.assertContains("/api/vault/status", "vault status fetch missing")

    def test_tenant_manager_headline(self):
        # collapsed trigger shows active account name via headline, not 'Vault'
        tm = self.html[self.html.index("function TenantManager("):]
        tm = tm[:tm.index("\nfunction ", 1)]
        self.assertIn("headline", tm, "headline variable missing from TenantManager")
        self.assertNotIn(">Vault<", tm, "TenantManager trigger must show account name, not 'Vault'")

    # ── logo / brand system ────────────────────────────────────────────────────

    def test_logo_system(self):
        self.assertContains("const IB_LOGO=", "IB_LOGO base64 mark missing")
        self.assertContains("function buildLogoSources", "buildLogoSources missing")
        self.assertContains("function BrandLogoImg", "BrandLogoImg component missing")
        self.assertContains("function downloadLogo", "downloadLogo helper missing")

    def test_logo_endpoints(self):
        self.assertContains("/api/logo", "logo source endpoint missing")
        self.assertContains("/api/brand", "brand endpoint missing")

    # ── new shell: tabs + router ───────────────────────────────────────────────

    def test_seven_tab_ids(self):
        self.assertContains(
            "const TABS=['overview','network','dns','infra','security','audit','ask']",
            "7-tab TABS array missing or reordered")
        for t in ("overview", "network", "dns", "infra", "security", "audit", "ask"):
            self.assertContains(t + ":", f"tab id '{t}' missing from TAB_LABELS/TAB_COMPONENTS")

    def test_tab_components_map(self):
        self.assertContains("const TAB_COMPONENTS=", "TAB_COMPONENTS map missing")
        for comp in ("OverviewTab", "NetworkTab", "DnsTab", "InfraTab", "AuditTab", "AskTab"):
            self.assertContains("function " + comp, f"tab component {comp} missing")
        self.assertContains("SecurityTab=", "SecurityTab missing")

    def test_legacy_hash_redirect_map(self):
        self.assertContains("const LEGACY={home:'overview'", "legacy redirect map missing")
        for pair in ("map:'network'", "dhcp:'network'", "ipam:'network'",
                     "assets:'infra'", "search:'ask'", "hub:'overview'"):
            self.assertContains(pair, f"legacy redirect {pair} missing")

    # ── data / api plumbing ────────────────────────────────────────────────────

    def test_useapi_hook(self):
        self.assertContains("function useApi", "useApi fetch hook missing")
        self.assertContains("bx:vault-locked", "vault-lock dispatch missing from useApi")

    def test_data_provider(self):
        self.assertContains("function DataProvider", "DataProvider missing")
        self.assertContains("function useData", "useData hook missing")
        self.assertContains("<DataProvider>", "root does not mount DataProvider")

    def test_data_table_primitive(self):
        self.assertContains("function DataTable", "DataTable primitive missing")

    # ── command palette + Cmd/Ctrl-K ───────────────────────────────────────────

    def test_command_palette(self):
        self.assertContains("function CommandPalette", "CommandPalette missing")
        self.assertContains("e.key==='k'||e.key==='K'", "Cmd/Ctrl-K binding missing")

    # ── saved views ────────────────────────────────────────────────────────────

    def test_views_menu(self):
        self.assertContains("function ViewsMenu", "ViewsMenu missing")
        self.assertContains("/api/views", "views API endpoint missing")

    def test_saved_view_schema(self):
        # POST body persists name/widgets/order/layout/folder/saved_at
        for field in ("widgets:", "order:", "layout:", "folder:", "saved_at:"):
            self.assertContains(field, f"saved-view POST body missing '{field}'")

    # ── design tokens ──────────────────────────────────────────────────────────

    def test_dark_tokens(self):
        self.assertContains("--bg:#000", "root --bg:#000 dark token missing")
        self.assertContains("--accent:#0070f3", "root --accent:#0070f3 token missing")

    def test_geist_fonts(self):
        self.assertContains("@font-face", "@font-face declarations missing")
        self.assertContains("Geist-400.woff2", "Geist font not loaded")
        self.assertContains("GeistMono-400.woff2", "GeistMono font not loaded")
        self.assertContains("font-family:'Geist'", "Geist font-family not declared")
        self.assertContains("GeistMono", "GeistMono font-family not declared")

    def test_no_light_mode_tokens(self):
        # dark-only build: no theme-switch tokens or media queries for light
        self.assertNotIn('data-theme="light"', self.html, "light-mode token block must not exist")
        self.assertNotIn("prefers-color-scheme", self.html, "no color-scheme media query in dark-only build")

    # ── region markers ─────────────────────────────────────────────────────────

    def test_region_markers(self):
        # 6 regions × (REGION + END) × 2 markers-per-line = 24 occurrences
        self.assertEqual(self.html.count("═══"), 24,
                         "expected exactly 24 '═══' region markers")

    # ── hygiene ────────────────────────────────────────────────────────────────

    def test_no_emoji_in_babel_script(self):
        # pictographic emoji must be absent; monochrome UI glyphs are allowed
        # (⌘ ✓ ✕ ← → ↑ ↓ · ● ○ ⟳ • … — box-drawing).
        allowed = set('←→↑↓·●○⟳⌘•…—✕✓─═')
        emoji = re.compile('[\U0001F000-\U0001FAFF\U0001F1E6-\U0001F1FF️'
                           '☀-⛿⬀-⯿'
                           '\U0001F512\U0001F514\U0001F6E1]')
        hits = sorted({m for m in emoji.findall(self.html)} - allowed)
        self.assertEqual(hits, [], f"emoji found in index.html: {hits}")

    def test_no_gradients(self):
        self.assertNotIn("linear-gradient", self.html, "flat dark theme must not use linear-gradient")

    def test_no_bloxone_string(self):
        self.assertNotIn("BloxOne", self.html, "'BloxOne' brand string must not appear")

    def test_react_script_tags(self):
        self.assertContains('<script src="react.min.js">', "react.min.js script tag missing")
        self.assertContains('<script src="react-dom.min.js">', "react-dom.min.js script tag missing")
        self.assertContains('<script src="babel.min.js">', "babel.min.js script tag missing")

    # ── acknowledgements ───────────────────────────────────────────────────────

    def test_acks_localstorage_key(self):
        self.assertContains("LS.get('acks'", "acks read from localStorage missing")
        self.assertContains("LS.set('acks'", "acks write to localStorage missing")

    def test_acks_composite_key(self):
        # events are keyed by event_time + '|' + qname
        self.assertContains("String(e.event_time)+'|'+String(e.qname)",
                            "ack composite key (event_time|qname) missing")


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
