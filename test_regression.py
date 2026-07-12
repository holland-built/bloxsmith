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
        # React 19 ESM boot: react/react-dom UMD are gone; the vendored ESM bundle +
        # Babel serve as javascript, and the Astryx stylesheet as CSS. See plans/018.
        for f in ("babel.min.js", "vendor.react-19-2-7.8c3b2ed6.js"):
            status, ct, _ = get(f"/{f}")
            self.assertEqual(status, 200, f"{f} returned {status}")
            self.assertIn("javascript", ct, f"{f} wrong content-type")
        status, ct, _ = get("/vendor.astryx.css")
        self.assertEqual(status, 200, f"vendor.astryx.css returned {status}")
        self.assertIn("css", ct, "vendor.astryx.css wrong content-type")

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

    # ── threat-intel + degraded-widget endpoints (new build) ──────────────────

    def test_api_dossier(self):
        # External-intel dossier: 200 with a `sources` payload OR `unavailable`
        # (Threat IQ is tenant-gated — skip like the LLM-flake tests when absent).
        status, d = get_json("/api/dossier?q=eicar.co")
        self.assertEqual(status, 200)
        self.assertTrue("sources" in d or "unavailable" in d,
                        f"dossier missing both 'sources' and 'unavailable': {list(d)[:8]}")
        if d.get("unavailable"):
            self.skipTest("dossier unavailable (Threat IQ not entitled on this tenant)")
        self.assertIn("summary", d, "entitled dossier must carry a 'summary'")

    def test_api_lookalikes(self):
        status, d = get_json("/api/lookalikes")
        self.assertEqual(status, 200)
        self.assertTrue("domains" in d or "unavailable" in d,
                        f"lookalikes missing both 'domains' and 'unavailable': {list(d)[:8]}")
        if "domains" in d:
            self.assertIsInstance(d["domains"], list, "'domains' must be a list")

    def _assert_no_500(self, path):
        # Degraded-widget contract: the widget endpoint must degrade to a 200
        # envelope (real data OR {"data":[], "unavailable":...}), never 500.
        try:
            status, ct, body = get(path)
        except HTTPError as e:
            self.fail(f"{path} returned HTTP {e.code}, must never 500 (degrade to 200 envelope)")
        self.assertEqual(status, 200, f"{path} returned {status}, must never 500")

    def test_api_insights_no_500(self):
        self._assert_no_500("/api/insights")

    def test_api_actions_no_500(self):
        self._assert_no_500("/api/actions")

    # ── immutable audit log (plan 019 Phase 1) ─────────────────────────────────

    def test_audit_log_shape(self):
        status, d = get_json("/api/audit/log")
        self.assertEqual(status, 200)
        self.assertIn("entries", d)
        self.assertIsInstance(d["entries"], list)
        self.assertIn("chain_valid", d)
        self.assertIn("broken_index", d)
        if d["entries"]:
            entry = d["entries"][0]
            for k in ("ts", "event", "actor", "detail", "prev_hash", "hash"):
                self.assertIn(k, entry, f"audit entry missing key: {k}")

    def test_audit_chain_valid(self):
        # A fresh GET (which itself is not mutating) still triggers real
        # write-authorized entries from prior test runs in this suite — the
        # chain must always verify as intact.
        status, d = get_json("/api/audit/log")
        self.assertEqual(status, 200)
        self.assertTrue(d["chain_valid"], f"audit chain broken at index {d.get('broken_index')}")

    def test_audit_export_is_json_pack(self):
        # Plan 019 Phase 3: /api/audit/export is now admin-gated. This test
        # environment has no DASHBOARD_TOKEN, so the resolved role tops out
        # at operator — expect 403, not 200 (adaptation from Phase 1's test).
        status, d = get_json("/api/audit/export")
        self.assertIn(status, (200, 403), f"unexpected status: {status}: {d}")
        if status == 200:
            for k in ("entries", "chain_valid", "broken_index", "exported_at", "app_version"):
                self.assertIn(k, d, f"audit export missing key: {k}")
            self.assertIsInstance(d["entries"], list)
        else:
            self.assertIn("error", d)

    # ── RBAC (plan 019 Phase 3) ─────────────────────────────────────────────────

    def test_whoami(self):
        status, d = get_json("/api/whoami")
        self.assertEqual(status, 200)
        self.assertIn("role", d)
        self.assertIn(d["role"], ("viewer", "operator", "admin"))
        self.assertIn("token_auth", d)
        self.assertIsInstance(d["token_auth"], bool)

    def test_teardown_block_requires_admin_without_token(self):
        # Without a DASHBOARD_TOKEN, this test environment resolves to at
        # most operator role — and docker's NAT can even make loopback
        # resolve to viewer — so any non-2xx auth rejection is correct; the
        # only wrong outcome is the teardown actually running (200).
        status, d = post_json("/api/teardown/block", {"template": "nonexistent-template-rbac-probe"})
        self.assertIn(status, (401, 403),
                       f"teardown/block should be blocked without an admin token, got {status}: {d}")

    # ── incident correlation + snooze (plan 019 Phase 2) ───────────────────────

    def test_incidents_shape(self):
        status, d = get_json("/api/incidents")
        self.assertEqual(status, 200)
        self.assertIn("incidents", d)
        self.assertIn("snoozes", d)
        self.assertIsInstance(d["incidents"], list)
        self.assertIsInstance(d["snoozes"], dict)
        if d["incidents"]:
            inc = d["incidents"][0]
            for k in ("key", "category", "severity", "count", "sample_entities",
                      "first_detected_at", "message", "entity_type"):
                self.assertIn(k, inc, f"incident missing key: {k}")

    def test_mcp_events_no_500(self):
        self._assert_no_500("/api/mcp/events")
        status, d = get_json("/api/mcp/events")
        self.assertEqual(status, 200)
        self.assertIsInstance(d, list)

    def test_snooze_roundtrip(self):
        category = "test-snooze-category"
        status, d = post_json("/api/alerts/snooze", {"category": category, "minutes": 15})
        self.assertEqual(status, 200, f"snooze POST failed: {d}")
        self.assertTrue(d.get("ok"), f"snooze not ok: {d}")
        status, d = get_json("/api/incidents")
        self.assertEqual(status, 200)
        self.assertIn(category, d["snoozes"], "snoozed category missing from active_snoozes()")
        self.assertFalse(
            any(i["category"] == category for i in d["incidents"]),
            "snoozed category still present in incidents (snooze not applied)")
        # validation: missing/invalid minutes must 400, never silently succeed
        status, d = post_json("/api/alerts/snooze", {"category": "x", "minutes": 0})
        self.assertEqual(status, 400)
        status, d = post_json("/api/alerts/snooze", {"minutes": 15})
        self.assertEqual(status, 400)

    # ── Cloud Resource Editor — Phase 1 (resource-editor-plan-2026-07-11) ──────

    def test_edit_zone_dry_returns_payload_no_write(self):
        # No "dry" key sent → _truthy_dry defaults to a preview; nothing is
        # ever written to the upstream API by this test.
        status, d = post_json("/api/edit/dns_zone",
                               {"fqdn": "test-edit-zone.example.com.", "view": "dns/view/test-id"})
        self.assertEqual(status, 200, f"edit zone dry-run failed: {d}")
        self.assertTrue(d.get("dry_run"), f"dry_run missing/false: {d}")
        self.assertIn("would_create", d)

    def test_edit_bad_resource_404(self):
        status, d = post_json("/api/edit/nonsense", {})
        self.assertEqual(status, 404)

    def test_edit_missing_required_400(self):
        # subnet create without block_id must 400 before any write attempt.
        status, d = post_json("/api/edit/subnet", {"cidr": 28})
        self.assertEqual(status, 400)

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
        if status == 500:
            self.skipTest("upstream LLM 500 (transient) for this tenant")
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


    # ── cache warmer + AI tools (calm-by-default build) ───────────────────────

    def test_cache_warmer_source(self):
        src = _server_src()
        self.assertIn("_warm_loop", src, "_warm_loop cache-warmer missing from server.py")
        self.assertIn("WARM_INTERVAL", src, "WARM_INTERVAL missing from server.py")
        m = re.search(r"WARM_INTERVAL\s*=\s*(\d+)", src)
        self.assertIsNotNone(m, "WARM_INTERVAL constant not assigned an int literal")
        self.assertLess(int(m.group(1)), 300, "WARM_INTERVAL must be < 300s")

    def test_ai_tools_registered(self):
        src = _server_src()
        for tool in ("dossier_lookup", "lookalike_domains", "asset_insights"):
            self.assertIn(tool, src, f"AI tool '{tool}' missing from server.py")

    def test_api_data_warm(self):
        # Second sequential /api/data should be served warm (cache) — fast 200.
        try:
            s1, _ = get_json("/api/data")
        except (HTTPError, URLError, OSError) as e:
            self.skipTest(f"first /api/data errored: {e}")
        if s1 != 200:
            self.skipTest(f"first /api/data returned {s1}")
        t0 = time.time()
        s2, ct, _ = get("/api/data")
        elapsed = time.time() - t0
        self.assertEqual(s2, 200)
        self.assertLess(elapsed, 1.5, f"warm /api/data took {elapsed:.2f}s (>1.5s)")

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

    # ── AI drawer slide-in / keep-mounted (Phase C) ─────────────────────────────

    def test_ai_drawer_slidein(self):
        # Slide state is driven by the [data-open] attribute (never transitionend).
        self.assertContains(".ai-drawer[data-open]",
                            "AI drawer must expose the [data-open] slide state in CSS")
        self.assertContains("data-open={open?'':undefined}",
                            "AiDrawer <aside> must carry the data-open attribute")
        # Keep-mounted: the old unmount-on-close guard is gone (conversation survives).
        ad = self.html[self.html.index("function AiDrawer("):]
        ad = ad[:ad.index("\nfunction ", 1)]
        self.assertNotIn("if(!open) return null", ad,
                        "AiDrawer must stay mounted when closed (no early return null)")
        # Trigger reflects open state for a11y.
        self.assertContains("aria-expanded={aiOpen}",
                            "AI trigger button must expose aria-expanded")

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

    # ── layout: deterministic stretch grids + height discipline (Phases A+B) ────

    def test_grid_stretch(self):
        # All 5 grid families dropped auto-fill for deterministic columns and
        # stretch cards (paired with height caps). .ovx-detail lives in a
        # JS-injected <style> string; the others in the main <style>.
        for sel in (r"\.grid-2", r"\.grid-3", r"\.grid", r"\.grid-dense", r"\.ovx-detail"):
            # anchor on the base rule (starts with display:grid); the responsive
            # media-query overrides start with grid-template-columns and are skipped.
            m = re.search(sel + r"\{display:grid;([^}]*)\}", self.html)
            self.assertIsNotNone(m, f"grid base rule {sel} not found")
            body = m.group(1)
            self.assertIn("align-items:stretch", body, f"{sel} missing align-items:stretch")
            self.assertIn("grid-auto-flow:dense", body, f"{sel} missing grid-auto-flow:dense")
            self.assertNotIn("auto-fill", body, f"{sel} still uses auto-fill")

    def test_height_tokens(self):
        self.assertContains("--body-table:280px", "--body-table token missing")
        self.assertContains("--body-chart:220px", "--body-chart token missing")
        self.assertContains(".chart-body{", ".chart-body class missing")
        # ov-subnets / ov-hosts were retired in the v1 (Bloomberg-grid) Overview
        # rebuild — Top capacity subnets and Hosts needing attention are now
        # custom list panels (siteRows/attnHosts), not DataTables. ov-leases is
        # the one Overview DataTable that survived; it must still carry the
        # height token.
        for tid in ("ov-leases",):
            seg = self.html[self.html.index(f'tableId="{tid}"'):]
            seg = seg[:seg.index("/>")]
            self.assertIn("scrollBody={280}", seg, f"{tid} DataTable missing scrollBody={{280}}")

    # ── new shell: tabs + router ───────────────────────────────────────────────

    def test_core_tab_ids_in_order(self):
        # Structural invariant, not a frozen snapshot: the TABS array must
        # CONTAIN the required core tabs in this order. New tabs (provision,
        # drift, …) may be appended/interleaved and auto-enroll. AI stays a
        # drawer, so 'ask' must never be a tab.
        REQUIRED = ["overview", "daily", "network", "dns", "infra", "security", "audit"]
        m = re.search(r"const TABS=\[([^\]]*)\]", self.html)
        self.assertIsNotNone(m, "const TABS=[...] array not found in index.html")
        tabs = re.findall(r"'([a-z]+)'", m.group(1))
        # every required tab present…
        missing = [t for t in REQUIRED if t not in tabs]
        self.assertEqual(missing, [], f"required tabs missing from TABS: {missing} (got {tabs})")
        # …and in the required relative order (subsequence check)
        pos = [tabs.index(t) for t in REQUIRED]
        self.assertEqual(pos, sorted(pos),
                         f"core tabs out of order in TABS: {tabs}")
        self.assertNotIn("ask", tabs, f"'ask' must not be a tab (AI is a drawer): {tabs}")
        for t in REQUIRED:
            self.assertContains(t + ":", f"tab id '{t}' missing from TAB_LABELS/TAB_COMPONENTS")

    def test_tab_components_map(self):
        self.assertContains("const TAB_COMPONENTS=", "TAB_COMPONENTS map missing")
        for comp in ("OverviewTab", "NetworkTab", "DnsTab", "InfraTab", "AuditTab", "AiDrawer"):
            self.assertContains("function " + comp, f"tab component {comp} missing")
        self.assertContains("function SecurityTab", "SecurityTab missing")
        # AskTab is gone; the AI is a drawer, so TAB_COMPONENTS carries no 'ask:' entry.
        tc = self.html[self.html.index("const TAB_COMPONENTS="):]
        tc = tc[:tc.index("};")]
        self.assertNotIn("ask:", tc, "TAB_COMPONENTS must not contain an 'ask:' entry")

    def test_legacy_hash_redirect_map(self):
        self.assertContains("const LEGACY={home:'overview'", "legacy redirect map missing")
        for pair in ("map:'network'", "dhcp:'network'", "ipam:'network'",
                     "assets:'infra'", "search:'overview'", "ask:'overview'", "hub:'overview'"):
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
        # H3: the palette combobox must expose the highlighted row to AT too.
        self.assertContains("aria-activedescendant={(!confirmBlock&&items.length>0)?('pal-'+sel):undefined}",
                             "command palette aria-activedescendant missing")
        self.assertContains("id={'pal-'+i}", "palette row id missing (needed for aria-activedescendant)")

    def test_command_palette_actions(self):
        # F2 — the palette runs ACTIONS (Export current view / Ask AI about
        # selection), not just navigation. Both are built from the active
        # table's getState() inside CommandPalette's ctxItems block.
        self.assertContains("Export current view", "palette Export-current-view action missing")
        self.assertContains("Ask AI about selection", "palette Ask-AI-about-selection action missing")
        self.assertContains("rows:sorted,columns", "DataTable getState() must expose rows+columns for palette export")

    def test_copy_link_action(self):
        # F3 — "Copy link to this view" palette action copies location.href
        # (the hash router already makes it canonical + deep-linkable).
        self.assertContains("Copy link to this view", "palette Copy-link-to-this-view action missing")

    # ── unified search (BQL) discoverability layer ─────────────────────────────

    def test_search_typeahead(self):
        # DataTable filter grows a context-sensitive typeahead popover: combobox
        # input + listbox of role="option" suggestions, driven by bqlSuggest.
        self.assertContains("const bqlSuggest=", "bqlSuggest typeahead memo missing")
        self.assertContains('className="dt-search"', "dt-search wrapper missing")
        self.assertContains('className="panel dt-popover dt-suggest"', "dt-suggest popover missing")
        self.assertContains('role="listbox"', "suggestions listbox role missing")
        self.assertContains('role="combobox"', "filter combobox role missing")
        self.assertContains('role="option"', "suggestion option role missing")
        self.assertContains('aria-autocomplete="list"', "combobox aria-autocomplete missing")
        # H3: the combobox must expose the keyboard-highlighted option to AT.
        self.assertContains("aria-activedescendant={(sugOpen&&sugIdx>=0&&bqlSuggest.length>0)?('sug-'+sugIdx):undefined}",
                             "search combobox aria-activedescendant missing")
        self.assertContains("id={'sug-'+i}", "suggestion option id missing (needed for aria-activedescendant)")

    def test_search_cheatsheet(self):
        # The ? ghost button opens a one-card grammar reference panel.
        self.assertContains('className="dt-search-icon-btn dt-cheat-btn"', "? cheatsheet button missing")
        self.assertContains('className="panel dt-popover dt-cheat"', "cheatsheet panel missing")
        self.assertContains(">Search syntax<", "cheatsheet heading missing")
        for g in ("field:value", "field=value", "exact match", "compare",
                  "range", "any of", "exclude"):
            self.assertContains(g, f"cheatsheet grammar row {g!r} missing")
        self.assertContains('className="dt-cheat-fields"', "cheatsheet field list missing")
        # M4: the ? button must be keyboard-reachable (no tabIndex={-1} escape hatch).
        self.assertNotIn('className="dt-search-icon-btn dt-cheat-btn" tabIndex={-1}', self.html,
                          "? cheatsheet button must not be tabIndex={-1}")
        # M5: cheatsheet dialog gets a real focus-in-on-open + Esc-close-to-trigger contract.
        self.assertContains("cheatPanelRef.current.focus();", "cheatsheet dialog focus-in-on-open missing")
        self.assertContains("if(cheatBtnRef.current) cheatBtnRef.current.focus();",
                             "closing the cheatsheet must return focus to the ? trigger")

    def test_search_nomatch_diagnostic(self):
        # Zero-row query names the first token that took the count to 0 + Clear.
        self.assertContains("const bqlNoMatch=", "no-match diagnostic memo missing")
        self.assertContains('className="dt-nomatch"', "no-match empty-state span missing")
        self.assertContains('className="dt-clear-btn"', "no-match Clear button missing")

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

    def test_light_mode_tokens(self):
        # v2 ships a real light theme: [data-theme="light"] token block, a
        # prefers-color-scheme default in the boot script, and light --bg value.
        self.assertContains('[data-theme="light"]', "light-mode token block missing")
        self.assertContains("prefers-color-scheme", "prefers-color-scheme default missing from boot script")
        self.assertContains("--bg:#fafafa", "light --bg:#fafafa value missing")

    def test_theme_toggle(self):
        # persisted theme via LS 'theme' key (stored as bx.theme) + a ThemeToggle control
        self.assertContains("bx.theme", "bx.theme localStorage key missing")
        self.assertContains("LS.set('theme'", "theme persistence (LS.set('theme')) missing")
        self.assertContains("function ThemeToggle", "ThemeToggle component missing")

    def test_synth_band(self):
        # synthesis band component defined exactly once
        self.assertEqual(self.html.count("function SynthBand"), 1,
                         "expected exactly one SynthBand definition")

    def test_no_max_width_1200(self):
        # v2 full-bleed: the old 1200px content caps were removed
        self.assertNotIn("max-width:1200", self.html, "max-width:1200 cap must be gone (full-bleed)")
        self.assertNotIn("maxWidth:1200", self.html, "maxWidth:1200 cap must be gone (full-bleed)")

    def test_snapshot_module(self):
        # daily-summary trend engine: snapshot store hook + writer
        self.assertContains("useSnapshots", "useSnapshots hook missing")
        self.assertContains("SnapshotWriter", "SnapshotWriter component missing")

    def test_compare_to_snapshot_diff(self):
        # Row-level Compare-to-snapshot: pure diffRows() reuses the existing
        # snapshot store (no parallel snapshot system), DataTable/DTRow render a
        # +/~/- gutter glyph + aria label (never a color-only signal), and
        # removed rows render as struck-through ghost rows.
        self.assertContains("function diffRows(", "diffRows pure helper missing")
        self.assertContains("dt-diff", "diff gutter column class missing")
        self.assertContains("dt-ghost", "ghost/removed row class missing")
        self.assertContains("Compare to snapshot", "Compare-to-snapshot toolbar affordance missing")
        # HARD GATE: the gutter glyph must carry an aria label, not just a
        # bare glyph/color — this is the string that renders it.
        self.assertContains("aria-label={diff.label}", "diff glyph must carry an aria-label")

    def test_compare_to_snapshot_leases_hosts(self):
        # F7 extended beyond Subnets: Leases (Network tab) and Hosts (Infra tab)
        # reuse diffRows()/dt-diff — no parallel diff mechanism or snapshot store.
        self.assertContains("Compare leases to snapshot", "Leases Compare-to-snapshot toolbar affordance missing")
        self.assertContains("Compare hosts to snapshot", "Hosts Compare-to-snapshot toolbar affordance missing")
        self.assertContains("leases:{n:leases.length,active,top:leaseTop}", "SnapshotWriter missing leases row-level top-N capture")
        self.assertContains("hosts:{n:hosts.length,online,offline:hosts.length-online,top:hostTop}", "SnapshotWriter missing hosts row-level top-N capture")

    def test_daily_view(self):
        self.assertContains("DailyTab", "DailyTab component missing")
        self.assertContains("dailyNarrative", "dailyNarrative missing")

    # ── region markers ─────────────────────────────────────────────────────────

    def test_region_markers(self):
        # Structural invariant: every region is opened AND closed exactly once.
        # Adding a region (e.g. PROVISION) no longer breaks this test.
        opens = re.findall(r"REGION:\s*([A-Z0-9_]+)", self.html)
        closes = re.findall(r"END:\s*([A-Z0-9_]+)", self.html)
        self.assertGreater(len(opens), 0, "no REGION: markers found in index.html")
        self.assertEqual(sorted(opens), sorted(closes),
                         f"unbalanced region markers: opened={sorted(opens)} closed={sorted(closes)}")
        # no duplicate region names (each opened once)
        self.assertEqual(len(opens), len(set(opens)),
                         f"duplicate REGION: names: {opens}")

    # ── hygiene ────────────────────────────────────────────────────────────────

    def test_no_emoji_in_babel_script(self):
        # pictographic emoji must be absent; monochrome UI glyphs are allowed
        # (⌘ ✓ ✕ ← → ↑ ↓ · ● ○ ⟳ • … — box-drawing; ★ ☆ pin toggle).
        # Dingbats (U+2700-27BF) is included so stray pictographs like ✨
        # (SPARKLES, U+2728) can't sneak back in — ✓/✕ (U+2713/2717) also live
        # in that block, so they stay explicitly allow-listed below.
        allowed = set('←→↑↓·●○⟳⌘•…—✕✓─═★☆')
        emoji = re.compile('[\U0001F000-\U0001FAFF\U0001F1E6-\U0001F1FF️'
                           '☀-⛿⬀-⯿'
                           '✀-➿'
                           '\U0001F512\U0001F514\U0001F6E1]')
        hits = sorted({m for m in emoji.findall(self.html)} - allowed)
        self.assertEqual(hits, [], f"emoji found in index.html: {hits}")

    def test_no_gradients(self):
        self.assertNotIn("linear-gradient", self.html, "flat dark theme must not use linear-gradient")

    def test_no_bloxone_string(self):
        self.assertNotIn("BloxOne", self.html, "'BloxOne' brand string must not appear")

    def test_react_script_tags(self):
        # React 19 ESM boot (no UMD — React 19 ships none): importmap maps react/
        # react-dom to local vendored files, Babel stays for in-browser JSX, and the
        # app block runs as a module. See plans/018.
        self.assertContains('<script type="importmap">', "React ESM importmap missing")
        self.assertContains('"react": "./vendor.react-', "react importmap entry missing")
        self.assertContains('"react-dom/client": "./vendor.react-dom-', "react-dom/client importmap entry missing")
        self.assertContains('<script src="babel.min.js">', "babel.min.js script tag missing")
        self.assertContains('type="text/babel" data-type="module"', "app block must run as a Babel module")
        # The dead UMD tags must be gone.
        self.assertEqual(self.html.count('src="react.min.js"'), 0, "legacy UMD react.min.js tag must be removed")

    # ── acknowledgements ───────────────────────────────────────────────────────

    def test_acks_localstorage_key(self):
        self.assertContains("LS.get('acks'", "acks read from localStorage missing")
        self.assertContains("LS.set('acks'", "acks write to localStorage missing")

    def test_acks_composite_key(self):
        # events are keyed by event_time + '|' + qname
        self.assertContains("String(e.event_time)+'|'+String(e.qname)",
                            "ack composite key (event_time|qname) missing")

    # ── power-interaction layer ────────────────────────────────────────────────

    def test_power_datatable_props(self):
        # DataTable's optional power props are destructured in its signature.
        for prop in ("renderPeek", "selectable", "bulkActions", "rowKey",
                     "initialPeekKey", "filterable"):
            self.assertContains(prop, f"DataTable power prop '{prop}' missing")

    def test_peek_drawer(self):
        self.assertContains("function PeekDrawer", "PeekDrawer component missing")
        self.assertContains('className="peek"', "peek drawer class missing")
        self.assertContains("aria-activedescendant",
                            "aria-activedescendant (keyboard cursor link) missing")

    def test_keyboard_nav(self):
        # global keydown handler dispatches j/k to the active table's imperative api
        self.assertContains("const PowerCtx=", "PowerCtx registry missing")
        self.assertContains("function usePower", "usePower hook missing")
        self.assertContains("window.addEventListener('keydown'",
                            "global keydown listener missing")
        self.assertContains("e.key==='j'", "j-key cursor-down binding missing")

    def test_sparkline(self):
        self.assertContains("function Sparkline", "Sparkline component missing")
        # no-fabrication guard: fewer than 2 points renders nothing
        self.assertContains("v.length<2", "Sparkline <2-point guard missing")
        self.assertIn(">=2", self.html, "Sparkline series >=2 guard string missing")

    def test_density_toggle(self):
        self.assertContains("LS.set('density'", "density persistence missing")
        self.assertContains("--row-h", "--row-h density CSS var missing")
        self.assertContains("data-density", "data-density attribute selector missing")

    def test_watchlist(self):
        self.assertTrue(
            "LS.get('watchlist'" in self.html or "LS.set('watchlist'" in self.html,
            "watchlist localStorage access missing")

    def test_action_bar(self):
        self.assertContains("action-bar", "action-bar bulk-action class missing")
        self.assertContains("Export CSV", "Export CSV built-in bulk action missing")
        self.assertContains("label:'Copy'", "Copy built-in bulk action missing")

    # ── display-form primitives (new build) ────────────────────────────────────

    def _region(self, name):
        s = self.html.index("REGION: " + name)
        e = self.html.index("END: " + name, s)
        return self.html[s:e]

    def test_display_primitives(self):
        # Calm-by-default chart set: Donut / HistogramBar / GroupedBar / HoverCard /
        # VolumeHistogram / Sparkline all defined; Treemap fully removed.
        for needle in ("function Donut", "function HistogramBar", "function GroupedBar",
                       "function HoverCard", "VolumeHistogram", "function Sparkline"):
            self.assertContains(needle, f"display primitive '{needle}' missing")
        self.assertEqual(self.html.count("Treemap"), 0, "Treemap must be fully removed")

    def test_dossier_wired(self):
        # External-intel (Dossier) lookup wired into the SECURITY region.
        self.assertIn("/api/dossier", self._region("SECURITY"),
                      "/api/dossier not referenced inside the SECURITY region")

    def test_lookalikes_wired(self):
        self.assertIn("/api/lookalikes", self._region("SECURITY"),
                      "/api/lookalikes not referenced inside the SECURITY region")

    def test_network_charts(self):
        # Network tab now renders a GroupedBar (per-site) instead of a Treemap.
        self.assertContains("<GroupedBar", "GroupedBar not wired into the Network tab")
        self.assertEqual(self.html.count("<Treemap"), 0, "Treemap markup must be absent")
        self.assertEqual(self.html.count("Treemap"), 0,
                         "Treemap must be fully removed (0 occurrences)")

    # ── Unified Search (BQL) Phase D — Network chip wall killed → query presets ──

    def _network_tab(self):
        # Slice the NetworkTab function body (OverviewTab's own capacity list is
        # earlier in the file, so its siteRows.map chart is correctly excluded).
        i = self.html.index("function NetworkTab(")
        j = self.html.index("\nfunction ", i + 1)
        return self.html[i:j]

    def test_no_site_chip_wall(self):
        # PHASE D: the per-site filter-chip wall (one <button> per /16 site group,
        # rendered by siteRows.map(...) with a chipStyle) is GONE from NetworkTab,
        # along with the siteFilter state that fed it. Users type `site:X` instead.
        net = self._network_tab()
        self.assertNotIn("siteRows.map", net,
                         "NetworkTab still renders a per-site chip wall (siteRows.map)")
        self.assertNotIn("chipStyle", net, "dead chipStyle helper still present in NetworkTab")
        self.assertNotIn("setSiteFilter", self.html, "siteFilter state must be fully removed")
        self.assertNotIn("useState(params.band", self.html, "Network band useState must be removed")

    def test_valuebands_inject_query(self):
        # Value-band chips are now one-click BQL presets that inject a util token
        # into the subnets search (replacing any existing util token).
        self.assertContains("const UTIL_BQL=", "UTIL_BQL preset→BQL map missing")
        for bql in ("util>=100", "util:90-99", "util:70-89", "util<70"):
            self.assertContains(bql, f"util-band preset BQL '{bql}' missing")
        for fn in ("injectUtilBand", "siteFilter"):
            self.assertContains(fn, f"preset-injection helper '{fn}' missing")
        # subnets DataTable is a controlled-search handoff (query/onQuery ⇄ sq= hash).
        self.assertContains("query={subnetQuery} onQuery={setSubnetQuery}",
                            "subnets DataTable missing controlled-query handoff")
        self.assertContains("np.sq=subnetQuery", "subnets search not mirrored to the sq= hash")

    def test_band_legacy_remap(self):
        # parseHash translates legacy ?band=… deep links to ?sq=… (BQL) for one release.
        ph = self.html[self.html.index("function parseHash("):]
        ph = ph[:ph.index("\nfunction ", 1)]
        self.assertIn("BAND2SQ", ph, "parseHash legacy band→sq map (BAND2SQ) missing")
        self.assertIn("params.sq=BAND2SQ[params.band]", ph,
                      "parseHash does not remap band→sq")
        self.assertIn("delete params.band", ph, "parseHash does not drop the legacy band param")

    def test_datatable_capped(self):
        # DataTable caps default rows and offers a 'Show all' escape hatch + problems filter.
        for needle in ("maxRows", "problemsOnly", "Show all", "dt-more"):
            self.assertContains(needle, f"DataTable cap primitive '{needle}' missing")

    def test_ai_drawer(self):
        # The AI is a persistent drawer opened by an event + Cmd/Ctrl+I.
        self.assertContains('className="ai-drawer"', "ai-drawer class missing")
        self.assertContains("bx:ai-open", "bx:ai-open event missing")
        self.assertContains("(e.metaKey||e.ctrlKey)&&(e.key==='i'",
                            "Cmd/Ctrl+I AI-drawer binding missing")

    def test_problems_badge(self):
        self.assertContains("ProblemsBadge", "ProblemsBadge component missing")
        self.assertContains("problems-badge", "problems-badge class missing")

    def test_collapse_helper(self):
        self.assertContains("collapseIdentical", "collapseIdentical helper missing")

    def test_audit_tab_real_feed(self):
        # Plan 019 Phase 1: AuditTab must read the real hash-chained audit log,
        # not the old mock data.auditLogs/data.audit source, and offer a chain
        # status badge + export button.
        self.assertContains("useApi('/api/audit/log'", "AuditTab must poll /api/audit/log via useApi")
        self.assertContains("AuditExportButton", "AuditExportButton component missing")
        self.assertContains("/api/audit/export", "AuditExportButton must fetch /api/audit/export")
        self.assertContains("sev-badge", "chain-valid sev-badge missing from AuditTab")
        self.assertNotIn("data.auditLogs||data.audit", self.html,
                         "AuditTab must no longer read the mock data.auditLogs/data.audit source")

    # ── incidents tab (plan 019 Phase 2) ────────────────────────────────────────

    def test_incidents_tab_present(self):
        self.assertContains("'incidents'", "'incidents' entry missing from TABS")
        self.assertContains("incidents:'Incidents'", "incidents label missing from TAB_LABELS")
        self.assertContains("incidents:IncidentsTab", "incidents:IncidentsTab entry missing from TAB_COMPONENTS")
        for comp in ("function IncidentsTab", "function SeverityBadge", "function SnoozeControl"):
            self.assertContains(comp, f"{comp} missing")
        self.assertContains("/api/incidents", "IncidentsTab must fetch /api/incidents")
        self.assertContains("/api/mcp/events", "IncidentsTab must fetch /api/mcp/events")
        self.assertContains("/api/alerts/snooze", "SnoozeControl must POST /api/alerts/snooze")

    def test_no_tab_removed(self):
        # Adding the Incidents tab must not drop any pre-existing tab.
        m = re.search(r"const TABS=\[([^\]]*)\]", self.html)
        self.assertIsNotNone(m, "const TABS=[...] array not found in index.html")
        tabs = re.findall(r"'([a-z]+)'", m.group(1))
        for t in ("overview", "daily", "network", "dns", "infra", "security",
                  "audit", "provision", "drift", "selfservice"):
            self.assertIn(t, tabs, f"pre-existing tab {t!r} was removed from TABS")

    def test_provision_role_gated(self):
        # Plan 019 Phase 3: ProvisionTab must know the caller's role (via
        # /api/whoami) and gate live teardown on role==='admin'.
        self.assertContains("/api/whoami", "ProvisionTab must fetch /api/whoami")
        self.assertTrue("role==='admin'" in self.html or 'role==="admin"' in self.html,
                         "no admin role check found in index.html")

    # ── resource editor tab (resource-editor-plan-2026-07-11, Phase 2) ────────

    def test_editor_tab_registered(self):
        self.assertContains("'editor'", "'editor' entry missing from TABS")
        self.assertContains("editor:'Editor'", "editor label missing from TAB_LABELS")
        self.assertContains("editor:EditorTab", "editor:EditorTab entry missing from TAB_COMPONENTS")
        self.assertContains("function EditorTab", "EditorTab component missing")

    def test_editor_field_specs(self):
        self.assertContains("const FIELD_SPECS=", "FIELD_SPECS map missing")
        fs = self.html[self.html.index("const FIELD_SPECS="):]
        fs = fs[:fs.index("\nconst EDITOR_TYPES=")]
        for res in ("dns_zone", "subnet", "address_block", "dhcp_range", "host"):
            self.assertIn(res + ":", fs, f"FIELD_SPECS missing entry for {res!r}")

    def test_editor_uses_design_system(self):
        et = self.html[self.html.index("function EditorTab("):]
        et = et[:et.index("\nfunction ", 1)]
        self.assertIn("Panel", et, "EditorTab must use the Panel primitive")
        self.assertIn("dly-seg", et, "EditorTab must use the dly-seg segmented picker")
        self.assertIn("Astryx.Button", et, "EditorTab must use Astryx.Button")
        self.assertIn("Dry-run", et, "EditorTab must offer a dry-run checkbox")

    # ── resource editor — Phase 3 (deep-links + update/delete) ────────────────

    def test_editor_deeplinks(self):
        """Row-level Edit/New buttons in DnsTab/NetworkTab/InfraTab nav('editor',{...})
        with a resource type. Require at least 2 of the 3 tab regions to carry one."""
        self.assertIn("nav('editor',{", self.html,
                      "no nav('editor',{...}) deep-links found in index.html")
        present = [t for t in ("type:'dns_zone'", "type:'subnet'", "type:'host'")
                   if ("nav('editor',{" + t) in self.html]
        self.assertGreaterEqual(len(present), 2,
                                f"expected editor deep-links for >=2 of dns_zone/subnet/host, found: {present}")

    def test_editor_update_delete(self):
        """EditorTab branches POST vs PATCH on an id and offers a DELETE flow."""
        et = self.html[self.html.index("function EditorTab("):]
        et = et[:et.index("\nfunction ", 1)]
        self.assertIn("PATCH", et, "EditorTab must issue a PATCH for update mode")
        self.assertIn("DELETE", et, "EditorTab must issue a DELETE for the delete flow")
        self.assertIn("/api/edit/", self.html[self.html.index("const FIELD_SPECS="):],
                      "editor forms must target /api/edit/ endpoints")
        self.assertIn("editId", et, "EditorTab must track an editId (id-present edit mode)")

    def test_searchschema_present(self):
        """Phase E: major DataTables carry an explicit searchSchema= override so BQL
        power queries get reliable field types (not just 30-row auto-derivation)."""
        self.assertIn("searchSchema={{", self.html, "no searchSchema overrides found")
        # subnets: numeric util/cidr
        self.assertIn("searchSchema={{fields:{util:{type:'number'},cidr:{type:'number',key:'cidr'}}}}",
                      self.html, "subnets searchSchema (util/cidr number) missing")
        # zones: numeric ttl + array issues + zone alias
        self.assertIn("issues:{type:'array'}", self.html, "zones issues:{type:'array'} override missing")
        self.assertIn("aliases:{zone:'fqdn'}", self.html, "zones zone->fqdn alias missing")
        # hosts: enum status
        self.assertIn("searchSchema={{fields:{status:{type:'enum'}}}}", self.html,
                      "hosts status:{type:'enum'} override missing")
        # security events: enum severity/policy_action + aliases
        self.assertIn("policy_action:{type:'enum'}", self.html,
                      "security policy_action:{type:'enum'} override missing")
        self.assertIn("action:'policy_action'", self.html, "security action->policy_action alias missing")

    def test_copy_cell_and_copy_row(self):
        """Copy-cell/copy-row: DTRow copies a cell's raw value on click (non-clickable
        rows only) and offers a row-JSON copy affordance + a keyboard shortcut
        (cursor + 'y'), both confirmed via the shared toast/aria-live bus."""
        self.assertContains("copyText(raw==null?'':String(raw))", "cell-copy clipboard write missing")
        self.assertContains("row-copy-btn", "row-copy affordance (button) missing")
        self.assertContains('aria-label="Copy row as JSON"', "row-copy button aria-label missing")
        self.assertContains("copyCursorRow", "keyboard row-copy (cursor + shortcut) missing")
        self.assertContains("e.key==='y'", "'y' keyboard shortcut for row-copy missing")

    def test_filter_facets_popover(self):
        """F5: on-demand faceted Filter popover (dt-tools). Facet click funnels into
        the SAME cross-filter mechanism pivot-cell already uses (fx.toggle/FilterCtx),
        so the resulting chip is the existing FilterBar chip; removal announces via toast."""
        self.assertContains("dt-facet-menu", "facet popover panel missing")
        self.assertContains('aria-label="Filter by field values"', "Filter trigger button aria-label missing")
        self.assertContains("facetCols=useMemo(()=>columns.filter(c=>c.pivot)", "facets must derive from pivot columns")
        self.assertContains("onClick={()=>fx.toggle(g.key,fv.v,lbl)}", "facet click must funnel into fx.toggle (shared pivot mechanism)")
        self.assertContains("if(e.key==='Escape'){ e.preventDefault(); e.stopPropagation(); closeFacets(); }",
                             "facet popover must close on Escape")
        self.assertContains("if(facetBtnRef.current) facetBtnRef.current.focus();",
                             "closing the facet popover must return focus to the trigger")
        self.assertContains("toast('Filter removed · '+(label||existing.label)", "filter removal must announce via toast")
        # H2: opening the facet popover must move focus into it (mirrors the Cols
        # popover's ~1423 pattern) — otherwise Esc only works after manually Tabbing in.
        self.assertContains("if(!facetOpen||!facetMenuRef.current) return;",
                             "facet popover focus-in-on-open effect missing")
        self.assertContains("facetMenuRef.current.querySelector('button:not(:disabled)')",
                             "facet popover must focus its first control on open")

    def test_nl_button_no_emoji(self):
        # H1: the NL-translate button used a sparkles emoji (✨) as its label — the
        # toolbar convention is a terse monochrome text tag, not a pictograph.
        self.assertContains("{nlBusy?'…':'NL'}", "NL-translate button must render the text tag 'NL', not an emoji")
        self.assertNotIn("✨", self.html, "sparkles emoji must not appear anywhere in index.html")
        self.assertContains('aria-label="Translate to search query"', "NL button aria-label missing")

    def test_nl_button_reveal_on_need(self):
        # M1: the NL button was always-mounted + greyed at rest (standing chrome
        # in every search field). It must now hide until the search field is
        # focused or holds text, mirroring the .row-copy-btn reveal pattern.
        self.assertContains(".dt-nl-btn{right:23px;opacity:0;pointer-events:none;}",
                             "NL button must default to hidden (opacity:0) at rest")
        self.assertContains(".dt-search:focus-within .dt-nl-btn:not(:disabled),",
                             "NL button reveal-on-focus/non-empty rule missing")

    def test_column_manager(self):
        """Feature 8: extends the existing dt-cols-menu show/hide popover with
        keyboard reorder (per-row up/down, not drag-only), pin-first, and
        per-tableId LS persistence for both, plus popover focus management
        (open -> first control, Esc -> close + focus returns to the Cols button)."""
        self.assertContains("const moveCol=(key,delta)=>setColOrder(prev=>", "column reorder handler missing")
        self.assertContains("const togglePinCol=(key)=>setPinnedCol(prev=>", "column pin handler missing")
        self.assertContains("LS.get('cols.order.'+id,null)", "column order must be read from per-tableId LS key")
        self.assertContains("LS.set('cols.order.'+id,base)", "column order must persist to per-tableId LS key")
        self.assertContains("LS.get('cols.pin.'+id,null)", "pinned column must be read from per-tableId LS key")
        self.assertContains("LS.set('cols.pin.'+id,next)", "pinned column must persist to per-tableId LS key")
        self.assertContains('aria-label={\'Move \'+label+\' up\'}', "reorder-up button must be labeled per column")
        self.assertContains('aria-label={\'Move \'+label+\' down\'}', "reorder-down button must be labeled per column")
        self.assertContains("if(first) first.focus();",
                             "opening the Cols popover must focus its first enabled control")
        self.assertContains("if(colsBtnRef.current) colsBtnRef.current.focus();",
                             "closing the Cols popover must return focus to the Cols button")


class OverviewRedesignTests(unittest.TestCase):
    """Static source assertions for the v1 (Bloomberg-grid) Overview rebuild —
    brainstorms/design-bloxsmith-overview-plan-2026-07-12.md. Pure regex/substring
    checks against index.html; no browser (see tests/overview-redesign.spec.ts for
    the DOM-level Playwright coverage of the same 10 fixes)."""

    @classmethod
    def setUpClass(cls):
        with open(HTML, encoding="utf-8") as f:
            cls.html = f.read()

    def _overview_tab(self):
        i = self.html.index("function OverviewTab(")
        j = self.html.index("\n// ═══ END: OVERVIEW", i)
        return self.html[i:j]

    def assertContains(self, needle, msg=None):
        self.assertIn(needle, self.html, msg or f"Missing: {needle!r}")

    def test_stat_strip_replaces_banner(self):
        ov = self._overview_tab()
        self.assertIn('className="statstrip"', ov, "compact stat strip missing from Overview")
        self.assertNotIn("<SynthBand", ov, "old full-width verdict banner (SynthBand) must be gone from Overview")
        self.assertNotIn('className="kpis fadein"', ov, "old big KPI tile banner must be gone from Overview")

    def test_leases_table_no_mac_column(self):
        ov = self._overview_tab()
        leases_tbl = ov[ov.index('tableId="ov-leases"'):]
        leases_tbl = leases_tbl[:leases_tbl.index("/>")]
        self.assertNotIn("label:'MAC'", leases_tbl, "leases table must not render a MAC column")
        self.assertIn("MAC column hidden", ov, "'MAC column hidden' note missing from the leases panel")

    def test_problems_only_segmented_control(self):
        ov = self._overview_tab()
        self.assertIn('className="seg"', ov, "segmented Problems-only/All-subnets control missing")
        self.assertIn("aria-pressed={probOn}", ov, "segmented control must expose aria-pressed state")

    def test_band_chips_removable(self):
        ov = self._overview_tab()
        self.assertIn("toggleBand", ov, "utilization-band chips must be individually toggleable")
        self.assertIn("bandsOn.includes", ov, "band chips must be multi-select (array membership), not single-select")

    def test_host_status_donut(self):
        ov = self._overview_tab()
        self.assertIn("<Donut slices={hostSlices}", ov, "host-status donut missing")
        self.assertIn("attnHosts", ov, "needs-attention host list missing from Host status panel")

    def test_triage_queue_real_rows(self):
        ov = self._overview_tab()
        self.assertIn('className="triage-row"', ov, "triage queue rows missing")
        for action in ("Provision", "Drift", "Self-serve", "Editor"):
            self.assertIn(action, ov, f"triage queue missing the {action} action")
        self.assertIn("No subnets need action", ov, "triage queue empty state missing")

    def test_action_tooltips_use_hovercard_not_title(self):
        ov = self._overview_tab()
        triage = ov[ov.index('className="triage-row"'):]
        for action in ("Provision subnet", "Review drift", "Self-service", "Open in editor"):
            self.assertIn("bind({title:'" + action + "'", triage, f"{action} tooltip must use useHoverDetail().bind(), not native title=")
        self.assertNotIn("title='Provision", triage, "triage actions must not use a native title= tooltip")

    def test_hover_descriptions_present_with_real_thresholds(self):
        """Plain-English hover descriptions phase — every cryptic Overview number
        must carry a bind() description that states the real threshold, not a
        made-up one. See tests/overview-descriptions.spec.ts for DOM coverage."""
        ov = self._overview_tab()
        for needle in (
            "Total subnets managed across all sites.",
            "Subnets ≥90% full — new DHCP leases will start failing soon.",
            "Subnets over 85% full (not counting exactly 85%)",
            "Subnets between 71% and 85% full",
            "DHCP leases currently marked active",
            "online (reachable) / '+hostAgg.degraded+' degraded (reporting a warning)",
            "Show only subnets in this utilization range",
            "Average utilization across this site's",
            "Worst single subnet in this site.",
            "Subnets grouped by tagged site (or by /16 network when untagged).",
            "Reachability of your '+hosts.length.toLocaleString()+' managed hosts",
            "Host did not respond — down or unreachable.",
        ):
            self.assertIn(needle, ov, f"Missing hover description text: {needle!r}")
        # Never fall back to a native title= for these new descriptions.
        self.assertIn("useHoverDetail()", ov)

    def test_top_consumers_no_lonely_dash(self):
        ov = self._overview_tab()
        top = ov[ov.index('title="Top consumers"'):ov.index('title="Host status"')]
        self.assertIn("hasSite", top, "Top consumers must gate the site line on a real site tag")
        self.assertNotIn("s.site||'—'", top, "Top consumers must not render a bare '—' when the site tag is missing")


class ServerSecurityTests(unittest.TestCase):
    """Static (no running server) checks on server.py hardening from plans 014/015.
    Extracts the CSP-filter escaper by symbol and exercises it directly — the module
    can't be imported here (optional deps like groq), so we exec just the escaper block."""

    @classmethod
    def setUpClass(cls):
        cls.src = open(SERVER, encoding="utf-8").read()
        lines = cls.src.split("\n")
        start = next(i for i, l in enumerate(lines) if l.startswith("_CSP_CTRL"))
        end = next(i for i in range(start, len(lines))
                   if lines[i].strip() == "return s" and "_cspq_field" in "\n".join(lines[start:i + 1]))
        ns = {"re": re}
        exec(compile("\n".join(lines[start:end + 1]), "<esc>", "exec"), ns)
        cls.cspq = staticmethod(ns["_cspq"])
        cls.cspf = staticmethod(ns["_cspq_field"])

    def test_cspq_escapes_quote_and_backslash(self):
        # A user value can't break out of its double-quoted CSP clause.
        self.assertEqual(self.cspq('a"b'), 'a\\"b')
        self.assertEqual(self.cspq("\\x"), "\\\\x")

    def test_cspq_passes_through_ids_and_fqdns(self):
        for v in ("host.example.com", "ipam/subnet/12-ab", "10.0.0.0"):
            self.assertEqual(self.cspq(v), v, f"{v!r} must pass through unchanged")

    def test_cspq_rejects_control_chars(self):
        with self.assertRaises(ValueError):
            self.cspq("x\x00y")

    def test_cspq_field_allowlist(self):
        self.assertEqual(self.cspf("tag.name-1"), "tag.name-1")
        for bad in ("a b", 'a"b', "a==b", "a\x00b"):
            with self.assertRaises(ValueError):
                self.cspf(bad)

    def test_no_unescaped_filter_interpolation(self):
        # Every f-string CSP clause value must route through _cspq/int(); no raw =="{...}".
        raw = re.findall(r'=="\{(?!_cspq|int\()', self.src)
        self.assertEqual(raw, [], f"{len(raw)} unescaped CSP filter interpolation site(s) remain")

    def test_json_gzip_wired(self):
        # Plan 015: large JSON responses gzip when the client advertises it.
        for needle in ("Content-Encoding", "gzip.compress", "Accept-Encoding"):
            self.assertIn(needle, self.src, f"gzip primitive {needle!r} missing from server.py")

    def test_rbac_layer_present(self):
        # Plan 019 Phase 3: lightweight three-role RBAC layered on _write_ok()/
        # _write_guard() — no sessions, no FastAPI/authlib (that's the deferred
        # OIDC/SCIM scope, see plan 019's scoping note).
        for needle in ("_ROLE_ORDER", "def _resolve_role", "def _role_at_least",
                       'audit_append("rbac_denied"'):
            self.assertIn(needle, self.src, f"RBAC primitive {needle!r} missing from server.py")
        self.assertNotIn("from fastapi", self.src)
        self.assertNotIn("import authlib", self.src)

    def test_edit_paths_mutating(self):
        # resource-editor-plan-2026-07-11 Phase 1: /api/edit/* must be gated
        # by _write_ok()/_write_guard() (MUTATING_PATHS exact entry + the
        # _is_mutating prefix branch for the id-suffixed PATCH/DELETE routes),
        # and every create/update/delete branch must be operator-gated and
        # audit-logged.
        self.assertIn('"/api/edit"', self.src, "MUTATING_PATHS missing /api/edit exact-path entry")
        self.assertIn('path.startswith("/api/edit/")', self.src,
                      "_is_mutating (or a route dispatcher) missing the /api/edit/ prefix check")
        for verb in ("create", "update", "delete"):
            needle = 'f"edit-{resource}-%s"' % verb
            self.assertIn(needle, self.src, f"/api/edit {verb} branch missing its audit_append event name")
        self.assertGreaterEqual(self.src.count('"operator role required"'), 3,
                                 "expected an operator-role gate on each /api/edit verb (create/update/delete)")

    def test_audit_module_wired(self):
        # Plan 019 Phase 1: hash-chained audit module + routes + central
        # write-authorized breadcrumb must all be present.
        for needle in ("def audit_append", "def audit_read", "def audit_verify_chain",
                       "_audit_entry_hash", "/api/audit/log", "/api/audit/export",
                       'audit_append("write-authorized"'):
            self.assertIn(needle, self.src, f"audit primitive {needle!r} missing from server.py")

    def test_audit_persists_on_vault_volume(self):
        # AUDIT_LOG_FILE must live next to VAULT_FILE (the mounted noc-vault
        # volume), not a fresh/re-probed directory, so it survives restarts.
        self.assertIn("AUDIT_LOG_FILE = os.path.join(_STATE_DIR", self.src,
                      "AUDIT_LOG_FILE must be derived from the vault's state dir")
        self.assertIn("_STATE_DIR = os.path.dirname(VAULT_FILE)", self.src,
                      "_STATE_DIR must reuse VAULT_FILE's resolved directory, not re-probe")

    def test_correlate_groups_by_category(self):
        # Plan 019 Phase 2: exec-extract the pure correlate() fn (+ its
        # _SEVERITY_ORDER/_SAMPLE_CAP constants) by symbol, same technique as
        # the _cspq escaper above — server.py can't be imported here (optional
        # deps like groq/mcp).
        lines = self.src.split("\n")
        start = next(i for i, l in enumerate(lines) if l.startswith("_SEVERITY_ORDER = {"))
        end = next(i for i in range(start, len(lines)) if lines[i].strip() == "return incidents")
        ns = {}
        exec(compile("\n".join(lines[start:end + 1]), "<esc>", "exec"), ns)
        correlate = ns["correlate"]

        self.assertEqual(correlate([]), [])

        signals = [
            {"category": "subnet-utilization", "severity": "warn", "entity_id": "s1",
             "entity_type": "subnet", "detected_at": 100.0},
            {"category": "subnet-utilization", "severity": "crit", "entity_id": "s2",
             "entity_type": "subnet", "detected_at": 50.0},
            {"category": "dns-ttl-anomaly", "severity": "warn", "entity_id": "z1",
             "entity_type": "zone", "detected_at": 75.0},
        ]
        incidents = correlate(signals)
        by_cat = {i["category"]: i for i in incidents}
        self.assertEqual(set(by_cat), {"subnet-utilization", "dns-ttl-anomaly"})

        su = by_cat["subnet-utilization"]
        self.assertEqual(su["count"], 2, "2 same-category signals must collapse into 1 incident")
        self.assertEqual(su["severity"], "crit", "incident severity must be the worst of its group")
        self.assertEqual(su["sample_entities"], ["s1", "s2"])
        self.assertEqual(su["first_detected_at"], 50.0, "must take the earliest detected_at")
        self.assertEqual(su["entity_type"], "subnet")
        self.assertEqual(su["key"], "subnet-utilization")

        dt = by_cat["dns-ttl-anomaly"]
        self.assertEqual(dt["count"], 1)
        self.assertEqual(dt["severity"], "warn")

    def test_incidents_primitives_wired(self):
        # Correlate/signals/snooze module + routes must all be present.
        for needle in ("def correlate(signals)", "def build_signals(data)",
                       "def snooze(category, minutes)", "def is_snoozed(category)",
                       "def active_snoozes()", "ALERT_STATE_FILE = os.path.join(_STATE_DIR",
                       '"/api/incidents"', '"/api/mcp/events"', '"/api/alerts/snooze"',
                       'audit_append("snooze"'):
            self.assertIn(needle, self.src, f"incidents primitive {needle!r} missing from server.py")


class BqlParserTests(unittest.TestCase):
    """BloxSmith Unified Search (BQL) Phase A — exercises the three PURE JS
    functions (parseQuery/deriveSchema/buildPredicate) sliced by sentinel from
    index.html and executed under Node (same extract-and-exec technique as the
    _cspq / correlate server tests above, but for JS). Skips if `node` absent."""

    SENTINELS = ("parseQuery", "deriveSchema", "buildPredicate", "cleanBqlAnswer")

    @classmethod
    def setUpClass(cls):
        # NUL-safe read (index.html carries stray NUL bytes).
        with open(HTML, "rb") as f:
            cls.src = f.read().replace(b"\x00", b" ").decode("utf-8", "replace")

    def _block(self, name):
        a = self.src.index(f"/* ==BQL:{name}:start== */")
        b = self.src.index(f"/* ==BQL:{name}:end== */")
        self.assertLess(a, b, f"BQL sentinel block {name} malformed/missing")
        return self.src[a:b]

    def _node(self, harness):
        import shutil, subprocess, tempfile
        node = shutil.which("node")
        if not node:
            self.skipTest("node not found on PATH")
        code = "\n".join(self._block(n) for n in self.SENTINELS) + "\n" + harness
        with tempfile.NamedTemporaryFile("w", suffix=".mjs", delete=False,
                                         dir=os.environ.get("TMPDIR", "/tmp")) as f:
            f.write(code)
            path = f.name
        try:
            return subprocess.run([node, path], capture_output=True, text=True, timeout=30)
        finally:
            os.unlink(path)

    def test_bql_predicate_semantics(self):
        # One Node run asserts the whole contract; exits 1 (with a FAIL line) on
        # any mismatch so a red bar names the exact case that broke.
        harness = r"""
function iso(msAgo){ return new Date(Date.now()-msAgo).toISOString(); }
const H=3600000, M=60000;
const rows=[
  {name:'alpha',   util:90,   severity:'critical', type:'A',   issues:['dup','stale'], seen:iso(1*H),  cidr:30, tag:'has foo:bar here'},
  {name:'bravo',   util:80,   severity:'high',     type:'PTR', issues:[],              seen:iso(48*H), cidr:24, tag:'nothing'},
  {name:'charlie', util:50,   severity:'low',      type:'A',   issues:['warn'],        seen:iso(2*H),  cidr:30, tag:'nothing'},
  {name:'delta',   util:null, severity:'high',     type:'PTR', issues:['x'],           seen:iso(10*M), cidr:16, tag:'nothing'},
];
const cols=[{key:'name'},{key:'util'},{key:'severity'},{key:'type'},{key:'issues'},{key:'seen'},{key:'cidr'},{key:'tag'}];
const schema=deriveSchema(cols, rows, {fields:{cidr:{type:'cidr'}}});
let fails=0;
function chk(label, cond){ if(!cond){ console.error('FAIL '+label); fails++; } }
function names(q){ return rows.filter(buildPredicate(parseQuery(q), schema)).map(r=>r.name).sort(); }
function eqArr(a,b){ return JSON.stringify(a)===JSON.stringify(b); }

// schema shape
chk('alias sev->severity kept', schema.aliases.sev==='severity');
chk('age synthetic field -> seen key', schema.fields.age && schema.fields.age.type==='age' && schema.fields.age.key==='seen');
chk('freeTextKeys = all col keys', eqArr(schema.freeTextKeys, cols.map(c=>c.key)));
chk('util typed number', schema.fields.util.type==='number');
chk('severity typed enum', schema.fields.severity.type==='enum');
chk('issues typed array', schema.fields.issues.type==='array');
chk('cidr override type', schema.fields.cidr.type==='cidr');

// bare word == substring
chk('bare word substring', eqArr(names('charlie'), ['charlie']));
// numeric >
chk('util>85 numeric', eqArr(names('util>85'), ['alpha']));
// range
chk('util:70-89 range', eqArr(names('util:70-89'), ['bravo']));
// OR + alias
chk('sev:critical,high OR+alias', eqArr(names('sev:critical,high'), ['alpha','bravo','delta']));
// alias single
chk('alias sev:low', eqArr(names('sev:low'), ['charlie']));
// negate
chk('-type:PTR negate', eqArr(names('-type:PTR'), ['alpha','charlie']));
// age
chk('age<24h', eqArr(names('age<24h'), ['alpha','charlie','delta']));
// cidr slash === numeric equality
chk('cidr:/30 == cidr=30', eqArr(names('cidr:/30'), names('cidr=30')) && eqArr(names('cidr:/30'), ['alpha','charlie']));
// array length
chk('issues>0 array-length', eqArr(names('issues>0'), ['alpha','charlie','delta']));
// unknown field degrades to substring (non-empty on a matching row)
chk('foo:bar degrades to substring', names('foo:bar').length>=1 && names('foo:bar').indexOf('alpha')!==-1);
// missing-number excluded from numeric compares (delta.util===null)
chk('missing number excluded', names('util>0').indexOf('delta')===-1 && eqArr(names('util>0'), ['alpha','bravo','charlie']));
// empty query matches everything
chk('empty query all rows', names('').length===rows.length);

if(fails){ console.error(fails+' BQL assertion(s) failed'); process.exit(1); }
console.log('BQL_OK');
"""
        res = self._node(harness)
        self.assertEqual(res.returncode, 0,
                         f"BQL Node run failed:\nSTDOUT:{res.stdout}\nSTDERR:{res.stderr}")
        self.assertIn("BQL_OK", res.stdout)

    def test_bql_age_epoch(self):
        # Regression: audit `ts` is epoch-SECONDS, so the age synthetic field must
        # treat a numeric timestamp as seconds (Date.parse would give NaN). Also
        # tolerate ms timestamps (>1e12) and leave ISO-string parsing intact.
        harness = r"""
const nowS=Math.floor(Date.now()/1000);
const rows=[
  {name:'fresh',   ts:nowS-3600},          // 1h ago  (epoch seconds)
  {name:'stale',   ts:nowS-48*3600},       // 48h ago (epoch seconds)
  {name:'freshMs', ts:Date.now()-3600000}, // 1h ago  (epoch ms, >1e12)
];
const cols=[{key:'name'},{key:'ts'}];
const schema=deriveSchema(cols, rows, {});
function names(q){ return rows.filter(buildPredicate(parseQuery(q), schema)).map(r=>r.name).sort(); }
function eqArr(a,b){ return JSON.stringify(a)===JSON.stringify(b); }
let fails=0;
function chk(l,c){ if(!c){ console.error('FAIL '+l); fails++; } }
chk('age synthetic maps to ts key', schema.fields.age && schema.fields.age.key==='ts');
chk('age<24h includes fresh (s) + freshMs (ms), excludes stale', eqArr(names('age<24h'), ['fresh','freshMs']));
chk('age>24h isolates stale', eqArr(names('age>24h'), ['stale']));
if(fails){ console.error(fails+' age-epoch assertion(s) failed'); process.exit(1); }
console.log('AGE_OK');
"""
        res = self._node(harness)
        self.assertEqual(res.returncode, 0,
                         f"age-epoch Node run failed:\nSTDOUT:{res.stdout}\nSTDERR:{res.stderr}")
        self.assertIn("AGE_OK", res.stdout)

    def test_bql_last_preset_alias(self):
        # Feature 6 (time-as-preset): `last:Nh`/`last:Nd`/`last:Nm` aliases onto
        # the same synthetic age field as `age:Nh` (deriveSchema builtin alias
        # last->age), so it rides the existing ageMatch comparator — within-window
        # rows match, out-of-window rows are excluded. No new predicate branch.
        harness = r"""
function iso(msAgo){ return new Date(Date.now()-msAgo).toISOString(); }
const H=3600000, M=60000;
const rows=[
  {name:'fresh',  seen:iso(1*H)},
  {name:'stale',  seen:iso(48*H)},
  {name:'recent', seen:iso(10*M)},
];
const cols=[{key:'name'},{key:'seen'}];
const schema=deriveSchema(cols, rows, {});
function names(q){ return rows.filter(buildPredicate(parseQuery(q), schema)).map(r=>r.name).sort(); }
function eqArr(a,b){ return JSON.stringify(a)===JSON.stringify(b); }
let fails=0;
function chk(l,c){ if(!c){ console.error('FAIL '+l); fails++; } }
chk("'last' aliases onto synthetic age field", schema.aliases.last==='age');
chk('last:24h includes fresh+recent, excludes stale', eqArr(names('last:24h'), ['fresh','recent']));
chk('last:30m isolates recent only', eqArr(names('last:30m'), ['recent']));
chk('last:7d includes all three', eqArr(names('last:7d'), ['fresh','recent','stale']));
if(fails){ console.error(fails+' last-preset assertion(s) failed'); process.exit(1); }
console.log('LAST_OK');
"""
        res = self._node(harness)
        self.assertEqual(res.returncode, 0,
                         f"last-preset Node run failed:\nSTDOUT:{res.stdout}\nSTDERR:{res.stderr}")
        self.assertIn("LAST_OK", res.stdout)

    def test_clean_bql_answer_strips_wrapping(self):
        # NL→BQL translator (Feature 4): the AI endpoint's free-text "answer" must
        # be reduced to a bare, single-line query before it fills the search box —
        # strip a ```-fenced block, wrapping quotes, and any trailing chatter line.
        harness = "console.log(JSON.stringify(cleanBqlAnswer('```\\nutil>85\\n```\\nextra line')));"
        res = self._node(harness)
        self.assertEqual(res.stdout.strip(), json.dumps("util>85"),
                         f"cleanBqlAnswer did not strip fences/trailing text:\nSTDOUT:{res.stdout}\nSTDERR:{res.stderr}")

    def test_bql_blocks_are_valid_babel_module(self):
        # The three sliced blocks must parse as valid JS inside the app's Babel
        # module (same transform the browser applies to the text/babel script).
        import shutil, subprocess, tempfile
        node = shutil.which("node")
        if not node:
            self.skipTest("node not found on PATH")
        babel = os.path.join(DIR, "babel.min.js")
        if not os.path.exists(babel):
            self.skipTest("babel.min.js not present")
        blocks = "\n".join(self._block(n) for n in self.SENTINELS)
        driver = (
            "const Babel=require(" + repr(babel) + ");\n"
            "const code=" + json.dumps(blocks) + ";\n"
            "try{ Babel.transform(code,{presets:['react'],sourceType:'module'}); "
            "console.log('BABEL_OK'); }\n"
            "catch(e){ console.error(String(e && e.message || e)); process.exit(1); }\n"
        )
        with tempfile.NamedTemporaryFile("w", suffix=".cjs", delete=False,
                                         dir=os.environ.get("TMPDIR", "/tmp")) as f:
            f.write(driver)
            path = f.name
        try:
            res = subprocess.run([node, path], capture_output=True, text=True, timeout=60)
        finally:
            os.unlink(path)
        self.assertEqual(res.returncode, 0,
                         f"Babel could not parse BQL blocks:\nSTDERR:{res.stderr}")
        self.assertIn("BABEL_OK", res.stdout)


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
        loader = unittest.TestLoader()
        suite = unittest.TestSuite()
        for cls in (FrontendStructureTests, ServerSecurityTests):
            suite.addTests(loader.loadTestsFromTestCase(cls))
    else:
        suite = unittest.TestLoader().loadTestsFromModule(
            __import__(__name__)
        )

    runner = unittest.TextTestRunner(verbosity=2)
    result = runner.run(suite)
    sys.exit(0 if result.wasSuccessful() else 1)
