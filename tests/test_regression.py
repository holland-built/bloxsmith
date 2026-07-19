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
# This file lives in tests/, so the repo root is one level up. Resolve from the
# root — index.html/server.py are NOT siblings of this file.
DIR    = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HTML   = os.path.join(DIR, "index.html")
SERVER = os.path.join(DIR, "server.py")
CHECK_SH = os.path.join(DIR, "scripts", "check.sh")
CI_YML   = os.path.join(DIR, ".github", "workflows", "docker-publish.yml")

# ── helpers ───────────────────────────────────────────────────────────────────

def get(path, timeout=90):
    req = Request(BASE + path)
    try:
        with urlopen(req, timeout=timeout) as r:
            return r.status, r.headers.get("Content-Type", ""), r.read()
    except HTTPError as e:
        # 4xx/5xx (e.g. admin-gated 403) are returned, not raised, so callers
        # can assert on the status the way post() already allows.
        return e.code, e.headers.get("Content-Type", ""), e.read()

def post(path, body, timeout=90):
    data = json.dumps(body).encode()
    # Origin header makes the harness same-origin so P2's CSRF write-gate
    # (_write_ok → _same_origin when DASHBOARD_TOKEN is unset) admits the POST.
    req = Request(BASE + path, data=data,
                  headers={"Content-Type": "application/json", "Origin": BASE})
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

def _degraded_ai(ans):
    """True when /api/query returned its graceful timeout/error envelope
    (transient — LLM or upstream tool slow/unavailable), not a real answer."""
    low = (ans or "").lower()
    return ("timed out" in low) or ("ai error" in low) or ("request failed" in low)

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
        # the compiled app bundle serve as javascript, the Astryx stylesheet as CSS.
        # Phase 1: in-browser Babel is retired — app.bundle.js (precompiled from
        # src/*.jsx) is the runtime JS asset. See plans/STACK-EVOLUTION-PLAN.md.
        for f in ("app.bundle.js", "assets/vendor.react-19-2-7.8c3b2ed6.js"):
            status, ct, _ = get(f"/{f}")
            self.assertEqual(status, 200, f"{f} returned {status}")
            self.assertIn("javascript", ct, f"{f} wrong content-type")
        status, ct, _ = get("/assets/vendor.astryx.css")
        self.assertEqual(status, 200, f"assets/vendor.astryx.css returned {status}")
        self.assertIn("css", ct, "assets/vendor.astryx.css wrong content-type")

    def test_404(self):
        # SPA fallback: non-API paths serve index.html (200); unknown /api/* paths 404
        status, ct, body = get("/nonexistent-path-xyz")
        self.assertEqual(status, 200)
        self.assertIn("text/html", ct)
        self.assertIn(b"<title>Bloxsmith", body)
        # get() now returns 4xx instead of raising, so assert on the status.
        status, _, _ = get("/api/nonexistent-xyz")
        self.assertEqual(status, 404, "Expected 404 for unknown /api/* path")

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
        if status == 500:
            self.skipTest("upstream Infoblox MCP 500 for this tenant")
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
        if _degraded_ai(d["answer"]) or _needs_llm_key(d["answer"]):
            self.skipTest("AI query degraded/needs LLM key (transient/optional)")
        ans = d["answer"].lower()
        self.assertTrue(
            "quer" in ans or "dns" in ans or "client" in ans or "unknown" in ans,
            f"Unexpected DNS query answer: {d['answer'][:100]}"
        )

    def test_api_query_summary(self):
        status, d = post_json("/api/query", {"question": "network status"})
        self.assertEqual(status, 200)
        ans = d["answer"]
        if _needs_llm_key(ans) or _degraded_ai(ans):
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
        # Phase 1: the SPA's JS moved out of an inline <script> into src/*.jsx
        # fragments (compiled to app.bundle.js); CSS still lives inline in index.html.
        # Concatenate index.html + the RAW JSX source so both CSS assertions (from the
        # HTML) and JS assertions (from the source, verbatim-identical to the old inline
        # script) resolve unchanged.
        parts = []
        with open(HTML, encoding="utf-8") as f:
            parts.append(f.read())
        srcdir = os.path.join(DIR, "src")
        if os.path.isdir(srcdir):
            for name in sorted(os.listdir(srcdir)):
                if name.endswith(".jsx"):
                    with open(os.path.join(srcdir, name), encoding="utf-8") as f:
                        parts.append(f.read())
        cls.html = "\n".join(parts)

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

    # ── P1 slice 5: time & graph interaction system ─────────────────────────────

    def test_time_range_folds_into_view_state_hash(self):
        # Global time window travels in the EXISTING hash serializer as `t=` (same
        # parseHash/nav path as f= / <id>.q) — no second store, no snapshot desync.
        self.assertContains("function TimeProvider(",
                            "Global time-range provider must exist")
        self.assertContains("function useTimeRange(",
                            "useTimeRange hook must exist")
        self.assertContains("function timeWindowFor(",
                            "timeWindowFor() must resolve preset/absolute tokens")
        self.assertContains("parseHash().params.t",
                            "TimeProvider must seed the window from the `t=` hash param")
        self.assertContains("const TIME_PRESETS=",
                            "Time presets (15m/1h/24h/7d) must be declared")
        # Provider is mounted app-wide (inside FilterProvider) so every tab reads it.
        # Phase 2 inserts CommitProvider between TimeProvider and Shell.
        self.assertContains("<FilterProvider><TimeProvider><CommitProvider><Shell/>",
                            "TimeProvider must wrap Shell app-wide (CommitProvider nested inside)")
        # Snapshot keying / data-fetch left untouched: useSnapshots + DataProvider intact.
        self.assertContains("function useSnapshots(",
                            "useSnapshots must remain (time picker must not touch it)")

    def test_time_range_control_in_topbar(self):
        # Header control: preset buttons (keyboard-reachable) + reset ("All").
        self.assertContains("function TimeRangeControl(",
                            "TopBar time-range control must exist")
        self.assertContains('<TimeRangeControl/>',
                            "TimeRangeControl must be mounted in the TopBar")
        self.assertContains('className="tr-preset"',
                            "Time presets must render as buttons")
        self.assertContains('data-preset=',
                            "Preset buttons must carry data-preset for deep-linking")

    def test_volume_histogram_interaction_kit(self):
        # Crosshair readout, annotation ticks, capture-to-zoom, window band — all in
        # the shared VolumeHistogram primitive (no forked chart lib).
        vh = self.html[self.html.index("function VolumeHistogram("):]
        vh = vh[:vh.index("\nfunction ", 1)]
        self.assertIn("vh-crosshair", vh, "Crosshair cursor must render")
        self.assertIn("vh-readout", vh, "Crosshair value+timestamp readout must render")
        self.assertIn("vh-annot", vh, "Audit annotation ticks must render")
        self.assertIn("onZoom", vh, "Capture-to-zoom callback must be wired")
        self.assertIn("windowRange", vh, "Global window band must be read")
        # Monochrome + text (no color-only): annotation marks use text tokens, not hue.
        self.assertIn("vh-annot-mark", vh, "Annotation marks must be present")

    def test_security_wires_time_interactions(self):
        # SecurityTab feeds audit annotations + capture-to-zoom + reset into the chart.
        sec = self.html[self.html.index("function SecurityTab("):]
        sec = sec[:sec.index("// ═══ END: SECURITY")]
        self.assertIn("useTimeRange()", sec, "SecurityTab must read the global time window")
        self.assertIn("auditLogs", sec, "SecurityTab must source annotations from auditLogs")
        self.assertIn("vh-reset", sec, "A reset-zoom affordance must be offered")

    # ── P1/4 app-wide cross-filter: stat tiles + health strip ───────────────────

    def test_host_status_tiles_cross_filter(self):
        # The Overview "Hosts" card's online/degraded/offline numbers are real
        # cross-filter buttons that toggle a FilterCtx scope on the shared `status`
        # field (chip + `f=` hash + Infra-table filter), not inert colored spans.
        self.assertContains("stat-crossfilter",
                            "host-status cross-filter buttons (.stat-crossfilter) missing")
        self.assertContains("hostScopeBtn(",
                            "hostScopeBtn helper (host tile -> app scope) missing")
        self.assertContains("fx.toggle('status',v,'Status: '+v)",
                            "host tile must toggle the app-wide status FilterCtx scope")
        # aria-pressed reflects the active scope (keyboard-reachable real button).
        ov = self.html[self.html.index("function OverviewTab("):]
        ov = ov[:ov.index("\nfunction ", 1)]
        self.assertIn("aria-pressed={active}", ov,
                      "host-status tile button must expose aria-pressed")
        self.assertIn("data-scope=", ov, "host-status tile must carry data-scope")

    def test_health_strip_present_and_mounted(self):
        # Slim always-visible per-service health ribbon: component exists, is mounted
        # in the shell, and renders a TEXT status label (never color-only) + sparkline.
        self.assertContains("function HealthStrip(", "HealthStrip component missing")
        self.assertContains("<HealthStrip/>", "HealthStrip not mounted in the shell")
        self.assertContains("HEALTH_TXT=", "HealthStrip text status map (HEALTH_TXT) missing")
        hs = self.html[self.html.index("function HealthStrip("):]
        hs = hs[:hs.index("\nfunction ", 1)]
        self.assertIn('className="health-status"', hs,
                      "health segment must render a TEXT status label (not color-only)")
        self.assertIn("<Sparkline", hs, "health segment must render a Sparkline")
        self.assertIn("aria-pressed={active}", hs,
                      "health segment button must expose aria-pressed for the active tab")
        for svc in ("'DNS'", "'DHCP'", "'IPAM'", "'Security'"):
            self.assertIn(svc, hs, f"health strip missing service {svc}")

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

    def test_pageheader_shared_and_used_by_functional_tabs(self):
        # Shared PageHeader primitive exists (component + .page-head CSS)...
        self.assertContains("function PageHeader(", "PageHeader component missing")
        self.assertContains(".page-head{", "PageHeader .page-head CSS missing")
        # ...and each of the 4 functional tabs mounts it at the top of its page.
        for fn, title in (("SelfServiceTab", "Self-Service"), ("ProvisionTab", "Provision"),
                          ("EditorTab", "Editor"), ("DriftTab", "Drift")):
            body = self.html[self.html.index("function " + fn + "("):]
            body = body[:body.index("\nfunction ", 1)]
            self.assertIn('<PageHeader title="' + title + '"', body,
                          f"{fn} must render <PageHeader title=\"{title}\" .../>")

    def test_marris_tabs_carry_hover_descriptions(self):
        # Provision / Drift / Self-Service (Marris provisioning surface) each expose
        # plain-English hover descriptions via the shared useHoverDetail() popup —
        # never native title=. Assert each tab pulls bind() from useHoverDetail and
        # attaches a bound description with a plain-English "What it" row.
        for fn in ("ProvisionTab", "DriftTab", "SelfServiceTab"):
            body = self.html[self.html.index("function " + fn + "("):]
            body = body[:body.index("\nfunction ", 1)]
            self.assertIn("const {bind}=useHoverDetail();", body,
                          f"{fn} must pull bind from useHoverDetail()")
            self.assertIn("...bind({title:", body,
                          f"{fn} must attach at least one bind() hover description")
            self.assertIn("What it", body,
                          f"{fn} hover descriptions must be plain-English ('What it does/means')")

    def test_marris_tabs_reskinned_to_shared_primitives(self):
        # Content reskin of the Marris provisioning surface to the app's shared
        # design primitives (presentation only — no fetch/handler/SSE change).
        # DriftTab: the drift result renders via the shared glyph-diff vocabulary
        # (dt-diff cells + / − / ~ + text label), NOT a color-only severity list.
        self.assertContains("function driftMark(", "driftMark glyph classifier missing")
        drift = self.html[self.html.index("function DriftTab("):]
        drift = drift[:drift.index("\nfunction ", 1)]
        self.assertIn('className="dt-diff mono"', drift,
                      "DriftTab result must render the shared dt-diff glyph column")
        self.assertIn("driftMark(d)", drift,
                      "DriftTab must classify each drift item via driftMark()")
        self.assertNotIn("secSevColor(d.severity)", drift,
                         "DriftTab drift items must not be color-only (no secSevColor severity coloring)")
        # SelfServiceTab: every tabular panel renders the shared DataTable (tableId),
        # not hand-rolled rows — inline edit/delete survive as row-action renderers.
        ss = self.html[self.html.index("function SelfServiceTab("):]
        ss = ss[:ss.index("\nfunction ", 1)]
        for tid in ("ss-dns-records", "ss-ip-addresses", "ss-inv-addresses", "ss-inv-records"):
            self.assertIn('tableId="' + tid + '"', ss,
                          f"SelfServiceTab tabular panel must render DataTable tableId=\"{tid}\"")
        # ProvisionTab: form + streaming-log sections wrapped in the shared Panel/.pcard,
        # mode controls use the shared segmented-control primitive.
        prov = self.html[self.html.index("function ProvisionTab("):]
        prov = prov[:prov.index("\nfunction ", 1)]
        self.assertIn("<Panel title=", prov, "ProvisionTab sections must use the shared Panel")
        self.assertIn('className="dly-seg"', prov,
                      "ProvisionTab mode controls must use the shared segmented-control")

    def test_marris_kebab_shared_component(self):
        # P2 slice 8: a single shared KebabMenu (⋮) primitive consolidates SECONDARY
        # actions on the Marris tabs. It mirrors AbMenu's accessibility contract:
        # icon trigger with aria-haspopup=menu / aria-expanded, a role="menu" popover
        # of role="menuitem" buttons, Esc-close + focus-return, arrow-key roving.
        self.assertContains("function KebabMenu(", "shared KebabMenu component missing")
        kebab = self.html[self.html.index("function KebabMenu("):]
        kebab = kebab[:kebab.index("\nfunction ", 1)]
        self.assertIn('className="btn kebab-btn"', kebab, "KebabMenu trigger must use .kebab-btn")
        self.assertIn('aria-haspopup="menu"', kebab, "KebabMenu trigger must declare aria-haspopup=menu")
        self.assertIn("aria-expanded={open}", kebab, "KebabMenu trigger must expose aria-expanded")
        self.assertIn('role="menu"', kebab, "KebabMenu popover must be role=menu")
        self.assertIn('role="menuitem"', kebab, "KebabMenu items must be role=menuitem")
        self.assertIn("e.key==='Escape'", kebab, "KebabMenu must close on Escape")
        self.assertIn("btnRef.current.focus()", kebab, "KebabMenu must return focus to its trigger on close")
        self.assertIn(".kebab-btn{", self.html, "KebabMenu compact-icon CSS missing")
        # Each Marris tab wires the shared KebabMenu for its secondary actions.
        for fn in ("ProvisionTab", "DriftTab", "SelfServiceTab"):
            body = self.html[self.html.index("function " + fn + "("):]
            body = body[:body.index("\nfunction ", 1)]
            self.assertIn("<KebabMenu", body, f"{fn} must use the shared KebabMenu for secondary actions")
        # RISK CONTROL: the destructive action stays a VISIBLE, labeled button —
        # never demoted into a kebab menuitem.
        prov = self.html[self.html.index("function ProvisionTab("):]
        prov = prov[:prov.index("\nfunction ", 1)]
        self.assertIn("Tear down this site", prov,
                      "destructive teardown must remain a visible, labeled action")
        self.assertNotIn("{label:'Tear down this site'", prov,
                         "destructive teardown must NOT be buried inside the kebab menu")

    def test_marris_real_examples_seeded(self):
        # P2 slice 8: inline MARRIS_EXAMPLES seed real, illustrative templates/sample
        # data so the tabs teach themselves. Prefill / sample-render ONLY — the loaders
        # must never call a real API (function-preserving: no fetch / EventSource added).
        self.assertContains("const MARRIS_EXAMPLES=", "MARRIS_EXAMPLES seed constant missing")
        ex = self.html[self.html.index("const MARRIS_EXAMPLES="):]
        ex = ex[:ex.index("\nfunction ", 1)]
        # Provision site template (london / EMEA / production, subnets + DNS parent + hosts + tags).
        for tok in ("site:'london'", "region:'EMEA'", "environment:'production'",
                    "internal.example.com", "gw01", "dns01", "Owner:'neteng'", "CostCentre"):
            self.assertIn(tok, ex, f"Provision site example missing {tok!r}")
        # Address-block regional pool + DNS zone example.
        self.assertIn("global:'10.0.0.0/8'", ex, "address-block example pool missing")
        self.assertIn("zone:'corp.example.com'", ex, "DNS zone example missing")
        # Drift worked example — in-sync + changed + missing, rendered via shared glyph-diff.
        self.assertIn("label:'in sync'", ex, "drift example must include in-sync items")
        self.assertIn("label:'changed'", ex, "drift example must include a changed item")
        self.assertIn("label:'missing'", ex, "drift example must include a missing item")
        self.assertContains("function MarrisExampleDiff(", "example glyph-diff renderer missing")
        mdiff = self.html[self.html.index("function MarrisExampleDiff("):]
        mdiff = mdiff[:mdiff.index("\nfunction ", 1)]
        self.assertIn('className="dt-diff mono"', mdiff,
                      "drift example must reuse the shared dt-diff glyph column")
        self.assertNotIn("fetch(", mdiff, "example render must not call any API")
        # Self-service allocate prefill (tag environment=prod).
        self.assertIn("tagKey:'environment'", ex, "self-service allocate example missing tag prefill")
        self.assertIn("tagValue:'prod'", ex, "self-service allocate example missing tag value")
        # Examples are clearly LABELED as examples in the UI.
        self.assertIn('className="mx-tag"', self.html, "example callout must carry an 'Example' label")
        self.assertIn(".marris-example{", self.html, "example callout styling missing")

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

    # ── site-wide cell-legibility system (P0 slice 2) ──────────────────────────
    def test_cell_legibility_id_renderer(self):
        # One shared identifier renderer: middle-truncate + hover-full + click-copy.
        self.assertContains("function IdCell(", "shared IdCell identifier renderer missing")
        self.assertContains("function looksLikeId(", "looksLikeId auto-detect helper missing")
        self.assertContains("useHoverDetail(", "IdCell must reuse useHoverDetail for hover-full")
        # Structural middle-truncation: flexing head (ellipsis) + fixed tail.
        for sel in (".dt-id{", ".dt-id .dt-id-head", ".dt-id .dt-id-tail"):
            self.assertContains(sel, f"cell-legibility id CSS {sel!r} missing")
        # Keyboard reachable + copies the FULL value (not truncated text).
        self.assertContains("tabIndex={0}")
        self.assertContains("navigator.clipboard.writeText(full)",
                            "IdCell must copy the full identifier value")
        # DTRow wires the id column type (explicit opt-in OR auto-detect on plain cells).
        self.assertContains("c.id===true||c.type==='id'",
                            "DTRow must recognise the id column type")

    def test_cell_legibility_table_fit_default(self):
        # table-layout:fixed is the shared default so tables fit (no h-scroll).
        self.assertContains("table.dt{width:100%;border-collapse:collapse;"
                            "font-size:var(--dt-fs);table-layout:fixed;}",
                            "table.dt must default to table-layout:fixed")
        # Primary column clips with ellipsis now (no more overflow:visible bleed).
        self.assertContains("table.dt td.dt-primary,table.dt th.dt-primary{"
                            "white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}",
                            "dt-primary must ellipsize under the table-fit default")
        self.assertNotIn("table.dt td.dt-primary,table.dt th.dt-primary{"
                         "white-space:nowrap;overflow:visible;text-overflow:clip;}",
                         self.html)
        # Hide-all-empty-columns pruning in effCols.
        self.assertContains("const pruneEmpty=", "effCols must prune all-empty columns")

    def test_cell_legibility_applied_to_target_columns(self):
        # Triage ENTITIES + Security Lookalike domain/target columns use the id type.
        self.assertContains("{key:'sample_entities',label:'Entities',id:true",
                            "Triage Entities column must use the id column type")
        self.assertContains("{key:'lookalike',label:'Lookalike',mono:true,copy:true,primary:true,id:true",
                            "Lookalike domain column must use the id column type")
        self.assertContains("{key:'target',label:'Target',mono:true,id:true",
                            "Lookalike target column must use the id column type")

    # ── command palette + Cmd/Ctrl-K ───────────────────────────────────────────

    def test_command_palette(self):
        self.assertContains("function CommandPalette", "CommandPalette missing")
        self.assertContains("e.key==='k'||e.key==='K'", "Cmd/Ctrl-K binding missing")
        # H3: the palette combobox must expose the highlighted row to AT too.
        # Phase 2 moved block-domain confirmation into the shared commit dialog, so the
        # palette no longer has its own confirmBlock guard on the combobox.
        self.assertContains("aria-activedescendant={items.length>0?('pal-'+sel):undefined}",
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

    # ── Group E: read-only bulk actions + shortcut overlay ─────────────────────

    def test_bulk_readonly_actions(self):
        # Feature 8 — the selection ActionBar gains three READ-ONLY verbs built in
        # DataTable.buildActions: Export subset (downloadCSV), Copy as (a fan-out
        # menu reusing the Group B serializers), Pivot to filter (fx.add of shared
        # values). Count is live-announced. No mutation verbs are added.
        self.assertContains("label:'Export subset'", "bulk Export-subset action missing")
        self.assertContains("label:'Copy as',menu:[", "bulk Copy-as fan-out menu missing")
        self.assertContains("label:'Pivot to filter'", "bulk Pivot-to-filter action missing")
        self.assertContains("function AbMenu(", "ActionBar fan-out menu component missing")
        self.assertContains('role="status" aria-live="polite">{count} selected',
                            "ActionBar selection count is not live-announced")

    def test_shortcut_overlay(self):
        # Feature 10 — a global "?" opens a focus-trapped, plain-text shortcut
        # overlay (role=dialog, aria-modal) that lists the plan's new verbs.
        self.assertContains("function ShortcutsHelp(", "ShortcutsHelp overlay component missing")
        self.assertContains('aria-label="Keyboard shortcuts"', "shortcut overlay dialog label missing")
        self.assertContains("if(e.key!=='?'", "'?' key handler for shortcut overlay missing")
        self.assertContains("<ShortcutsHelp/>", "ShortcutsHelp not mounted in the Shell tree")
        for verb in ("Shift + click", "Copy as", "Copy link", "Pivot on the focused cell"):
            self.assertIn(verb, self.html, f"shortcut overlay missing verb: {verb!r}")

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

    # ── shared loading/empty/error state triad (P0 slice 3) ─────────────────────

    def test_state_triad_shared_components(self):
        # One standard render for each of the three data-surface states.
        self.assertContains("function ErrorState(", "shared ErrorState component missing")
        self.assertContains("function EmptyState(", "shared EmptyState component missing")
        self.assertContains("function Skeleton(", "shared Skeleton (loading) component missing")
        # Error is semantic (word "Error" + role=alert), not color-only, and shows
        # the actual message plus a real Retry button.
        self.assertContains('className="dt-state dt-error"', "ErrorState must use the shared dt-error skin")
        self.assertContains('role="alert"', "ErrorState must announce via role=alert")
        self.assertContains(">Error<", "ErrorState must carry the literal 'Error' tag (not color-only)")
        # Empty is filter-aware: detects active filters and offers a real Clear action.
        self.assertContains("const anyFilterActive=", "DataTable empty state must detect active filters")
        self.assertContains("const clearAllFilters=", "DataTable empty state must offer a Clear-filters action")
        self.assertContains(">Clear filters<", "EmptyState must expose a 'Clear filters' button")
        self.assertContains('aria-live="polite"', "EmptyState must announce via aria-live")
        # Error/empty CSS tokens are present and semantic (uses --crit).
        self.assertContains(".dt-error{color:var(--crit);}", "dt-error must use the --crit status token")

    def test_state_triad_wired_into_tabs(self):
        # Call sites inherit the shared triad rather than bespoke blank/pill renders.
        self.assertContains("<ErrorState error={error} onRetry={refetch}/>",
                            "tab error paths must render the shared ErrorState")
        # The old message-less 'failed · Retry' empty-cell render is gone.
        self.assertNotIn('<div className="dt-empty">failed · <button className="fresh-retry"', self.html,
                         "bespoke message-less error render must be replaced by ErrorState")

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
        self.assertContains("assets/Geist-400.woff2", "Geist font not loaded")
        self.assertContains("assets/GeistMono-400.woff2", "GeistMono font not loaded")
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

    def test_panel_size_scale_tokens(self):
        # Shared panel-size scale — one source of truth for body heights.
        for tok in ("--panel-sm:220px", "--panel-md:340px", "--panel-lg:560px"):
            self.assertContains(tok, f"panel-size token {tok!r} missing")
        # size classes route through the scale
        for cls in (".pcard.sz-sm{min-height:var(--panel-sm)",
                    ".pcard.sz-md{min-height:var(--panel-md)",
                    ".pcard.sz-lg{min-height:var(--panel-lg)"):
            self.assertContains(cls, f"panel size class {cls!r} missing")
        # DataTable scrollBody default reads the token (no ad-hoc 420 fallback)
        self.assertContains("scrollBody===true?'var(--panel-md)'",
                            "DataTable scrollBody default must route through --panel-md")
        # ad-hoc panel-body max-heights were rerouted to the scale
        self.assertNotIn("max-height:340px", self.html, "ad-hoc 340px max-height must use --panel-md")
        self.assertNotIn("maxHeight:320,", self.html, "ad-hoc maxHeight:320 must use --panel-md")

    def test_panel_maximize_on_shared_component(self):
        # Maximize affordance + fullscreen overlay live on the shared Panel.
        pan = self.html[self.html.index("function Panel("):]
        pan = pan[:pan.index("\nfunction ", 1)]
        self.assertIn("function Panel({title,side,api,children,empty,size})", self.html,
                      "Panel must accept a size prop")
        self.assertIn('className="pcard-max"', pan, "Panel header must render the maximize button")
        self.assertIn('aria-label={"Maximize "', pan, "maximize button must be labeled")
        self.assertIn('className="pcard-overlay panel"', pan, "Panel must render a fullscreen overlay")
        self.assertIn('role="dialog"', pan, "maximize overlay must be a dialog")
        self.assertIn("e.key==='Escape'", pan, "overlay must close on Escape")
        self.assertIn("returnRef.current=document.activeElement", pan,
                      "maximize must capture the trigger for focus return")
        self.assertIn("try{r.focus();}", pan, "maximize must return focus to the trigger")

    def test_compact_incident_strip(self):
        # The tall incidents SynthBand is now a dense inline strip (keeps --crit).
        self.assertContains(".inc-strip{", "compact incident strip CSS missing")
        inc = self.html[self.html.index("function IncidentsTab("):]
        inc = inc[:inc.index("// ═══ END: INCIDENTS")]
        self.assertIn('className={"inc-strip "+tone}', inc, "IncidentsTab must render the compact strip")
        self.assertNotIn("<SynthBand", inc, "IncidentsTab must not use the tall SynthBand banner")

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
        # react-dom to local vendored files. Phase 1: in-browser Babel is retired —
        # index.html loads the precompiled app.bundle.js as a native ES module.
        # See plans/STACK-EVOLUTION-PLAN.md.
        self.assertContains('<script type="importmap">', "React ESM importmap missing")
        self.assertContains('"react": "./assets/vendor.react-', "react importmap entry missing")
        self.assertContains('"react-dom/client": "./assets/vendor.react-dom-', "react-dom/client importmap entry missing")
        self.assertContains('<script type="module" src="./app.bundle.js">',
                            "index.html must load the compiled app.bundle.js as a native module")
        # In-browser Babel must no longer be loaded at runtime.
        self.assertEqual(self.html.count('<script src="babel.min.js">'), 0,
                         "in-browser babel.min.js must not be loaded (retired in Phase 1)")
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
        # Adding the Incidents tab must not drop any pre-existing tab. Plan 020
        # grouped drift/selfservice/editor under the single 'provision' top-level
        # tab as PROVISION_TOOLS sub-routes — assert the group survives and every
        # tool is still reachable, not that they remain separate top-level TABS.
        m = re.search(r"const TABS=\[([^\]]*)\]", self.html)
        self.assertIsNotNone(m, "const TABS=[...] array not found in index.html")
        tabs = re.findall(r"'([a-z]+)'", m.group(1))
        for t in ("overview", "daily", "network", "dns", "infra", "security",
                  "audit", "provision"):
            self.assertIn(t, tabs, f"pre-existing tab {t!r} was removed from TABS")
        self.assertContains("const PROVISION_TOOLS=", "PROVISION_TOOLS group map missing")
        pt = self.html[self.html.index("const PROVISION_TOOLS="):]
        pt = pt[:pt.index("];")]
        for t in ("provision", "selfservice", "editor", "drift"):
            self.assertIn("key:'" + t + "'", pt, f"tool {t!r} missing from PROVISION_TOOLS group")

    def test_provision_role_gated(self):
        # Plan 019 Phase 3: ProvisionTab must know the caller's role (via
        # /api/whoami) and gate live teardown on role==='admin'.
        self.assertContains("/api/whoami", "ProvisionTab must fetch /api/whoami")
        self.assertTrue("role==='admin'" in self.html or 'role==="admin"' in self.html,
                         "no admin role check found in index.html")

    # ── resource editor tab (resource-editor-plan-2026-07-11, Phase 2) ────────

    def test_editor_tab_registered(self):
        # Plan 020: 'editor' is no longer a standalone top-level tab — it's grouped
        # under 'provision' as a PROVISION_TOOLS sub-route (ProvisionGroupTab).
        self.assertContains("editor:'Editor'", "editor label missing from TAB_LABELS")
        self.assertContains("const PROVISION_TOOLS=", "PROVISION_TOOLS group map missing")
        pt = self.html[self.html.index("const PROVISION_TOOLS="):]
        pt = pt[:pt.index("];")]
        self.assertIn("key:'editor'", pt, "'editor' tool missing from PROVISION_TOOLS group")
        self.assertIn("comp:EditorTab", pt, "editor tool must map to EditorTab component")
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
        # Group C/3 extended the facet onClick to also mirror a BQL token into
        # the search box (see test_facet_bql_sync below), but it must still
        # call fx.toggle with these exact args — the shared pivot mechanism.
        self.assertContains("fx.toggle(g.key,fv.v,lbl)", "facet click must funnel into fx.toggle (shared pivot mechanism)")
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

    def test_pivot_on_cell(self):
        """Group C/2 — pivot-on-cell: ordinary (non-.pivot-cell) DataTable cells get
        a right-click / Shift+F10 "Filter by this value" action that funnels into the
        SAME fx.toggle used by .pivot-cell columns and the facet popover. Guarded so
        it never hijacks a row that already owns the click gesture via onRowClick."""
        self.assertContains("const canCellPivot=!c.pivot&&raw!=null&&raw!=='';",
                             "canCellPivot guard (non-pivot columns with a real value) missing")
        self.assertContains("const cellKeyboardPivot=canCellPivot&&!clickable;",
                             "keyboard affordance must be scoped OFF for onRowClick rows (guard)")
        self.assertContains("onContextMenu={canCellPivot?openPivotMenu:undefined}",
                             "right-click must be available on every ordinary pivotable cell")
        self.assertContains("(e.shiftKey&&e.key==='F10')||e.key==='ContextMenu'",
                             "Shift+F10 / Menu key must open the cell pivot action")
        self.assertContains("dt-cellpivot-menu", "cell pivot action menu class missing")
        self.assertContains("role=\"menuitem\"", "cell pivot action must expose role=menuitem")
        self.assertContains("fx.toggle(c.key,pv,lbl);\n        closePivotMenu(ci);",
                             "cell pivot action must funnel into the shared fx.toggle mechanism")
        self.assertContains("if(!wasOn) toast('Filtered to '+lbl", "cell pivot add must announce via toast")

    def test_facet_bql_sync(self):
        """Group C/3 — facet <-> BQL two-way sync: typing a field:value/field=value
        query marks the matching facet item active (bqlHasEquality), and clicking a
        facet mirrors a token into the table's own search box (mirrorFacetToken),
        reconciled if the chip is later removed some other way (FilterBar ×)."""
        self.assertContains("const bqlHasEquality=useCallback((field,value)=>{", "bqlHasEquality helper missing")
        self.assertContains("const mirrorFacetToken=useCallback((field,value,adding)=>{", "mirrorFacetToken helper missing")
        self.assertContains("const on=fx.has(g.key,fv.v)||bqlHasEquality(g.key,fv.v);",
                             "facet 'active' state must OR fx.has with the parsed BQL text")
        self.assertContains("mirrorFacetToken(g.key,fv.v,adding);", "facet click must mirror into the query text")
        self.assertContains("if(adding) toast('Filtered to '+lbl", "facet add must announce via toast")
        self.assertContains("const mirroredFacetTokens=useRef(new Map());",
                             "mirror must track its own writes to reconcile external chip removal")
        self.assertContains("if(!cur.size) return;\n    const stale=[];",
                             "reconcile effect (stale mirrored tokens after external chip removal) missing")

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

    def test_view_state_hash_sync(self):
        """Feature B1 — shareable-URL view state: DataTable mirrors its own sort,
        hidden columns, and (when it owns its own search box) filter string to the
        hash, namespaced `<tableId>.sort` / `<tableId>.cols` / `<tableId>.q`, and
        restores them from the hash on mount — so 'Copy link to this view' (F3)
        reproduces the exact table view, not just the tab. Extends, not forks: the
        pre-existing `f=` pivot mirror (FilterProvider) and `sq=` subnets mirror
        (NetworkTab) are untouched."""
        self.assertContains("hashParams[id+'.sort']", "sort restore-from-hash read missing")
        self.assertContains("hashParams[id+'.q']", "filter restore-from-hash read missing")
        self.assertContains("hashParams[id+'.cols']", "hidden-columns restore-from-hash read missing")
        self.assertContains("const key=id+'.sort';", "sort mirror-to-hash write missing")
        self.assertContains("const key=id+'.cols';", "hidden-columns mirror-to-hash write missing")
        self.assertContains("const key=id+'.q';", "filter mirror-to-hash write missing")
        # Controlled tables (subnets' external sq= mirror) must be left alone —
        # DataTable's own filter mirror only fires when it owns the search box.
        self.assertContains("if(!id||filterControlled||!filterable) return;",
                             "filter hash mirror must skip externally-controlled (onQuery) tables")

    def test_copy_as_format_menu(self):
        """Feature B6 — copy-as: extends the F1 row-copy affordance (⧉, unchanged)
        with a second 'Copy as…' trigger opening a 4-format menu (CSV/JSON/BQL
        filter/Markdown), keyboard-reachable (arrow+Enter, Esc returns focus to
        the trigger), announced via the shared toast bus."""
        self.assertContains("row-copyas-wrap", "copy-as wrapper (holds both row-copy buttons) missing")
        self.assertContains('aria-label="Copy row as…"', "copy-as menu trigger aria-label missing")
        self.assertContains('aria-label="Copy row as JSON"', "original F1 row-copy button must be unchanged")
        self.assertContains('role="menu" aria-label="Copy row as"', "copy-as menu role/label missing")
        self.assertContains("function rowAsCSV(columns,row)", "rowAsCSV serializer missing")
        self.assertContains("function rowAsBQL(columns,row)", "rowAsBQL serializer missing")
        self.assertContains("function rowAsMarkdown(columns,row)", "rowAsMarkdown serializer missing")
        self.assertContains("toast('Copied as '+fmt.label", "copy-as must announce via the toast bus")
        self.assertContains("moveCopyAsFocus", "arrow-key menu navigation missing")
        self.assertContains("if(copyAsBtnRef.current) copyAsBtnRef.current.focus();",
                             "closing the copy-as menu must return focus to its trigger")

    def test_vim_row_nav_guarded(self):
        """Feature 5 — j/k/g/G/x/Enter//' cursor keys (PowerProvider's global
        keydown listener) must all be gated by the same not-in-input guard, and
        the cursor row must carry a non-color-only signal (ring + aria state)."""
        for key in ("'j'", "'k'", "'x'", "'g'", "'G'"):
            self.assertContains(f"e.key==={key}", f"PowerProvider must handle key {key}")
        self.assertContains("t.closest('input,textarea,select,[contenteditable=\"true\"]')",
                             "global keydown listener must guard against typing in inputs")
        self.assertContains("aria-activedescendant={(id&&cursor>=0)?rowIdOf(cursor):undefined}",
                             "table wrapper must expose aria-activedescendant for the cursor row")
        self.assertContains("aria-selected={isCursor?'true':undefined}",
                             "cursor row must expose aria-selected (non-color-only signal)")
        self.assertContains("inset 0 0 0 1px var(--accent-text)", "cursor row must render a visible ring, not just a background tint")

    def test_multi_column_sort(self):
        """Feature 7 — shift-click appends a secondary/tertiary sort key (stable,
        in order); plain click resets to single-sort; aria-sort + an order badge
        mark each active column; the hash codec stays backward-compatible with
        the old single-key 'key:dir' format."""
        self.assertContains("function parseSortParam(raw)", "multi-sort hash parser missing")
        self.assertContains("function serializeSortParam(arr)", "multi-sort hash serializer missing")
        self.assertContains("const clickSort=(key,shift)=>{", "header click handler must accept a shift flag")
        self.assertContains("onClick={e=>clickSort(c.key,e.shiftKey)}", "header onClick must pass shiftKey through")
        self.assertContains('aria-sort={sEntry?(sEntry.dir===\'asc\'?\'ascending\':\'descending\'):\'none\'}',
                             "sorted header must expose aria-sort")
        self.assertContains('className="sort-order"', "multi-sort order badge missing")
        # Backward compat: a lone sort key still serializes to the old bare "key:dir" form.
        self.assertContains("(arr||[]).map(s=>s.key+':'+(s.dir||'asc')).join(',')",
                             "serializeSortParam must degrade to the old single-key format for one entry")

    def test_heatmap_table_crossfilter(self):
        """Feature 9 — a distribution-band segment/legend-swatch cross-filters via
        FilterCtx in place (toggleBandCross); a heatmap cell funnels into
        fx.toggle instead of nav ONLY when a co-located table exposes the
        matching column (PowerCtx.hasField), else it keeps the original nav-drill."""
        self.assertContains("const hasField=useCallback(field=>{", "PowerCtx must expose hasField for co-located-table detection")
        self.assertContains("hasField", "PowerCtx value object must publish hasField")
        self.assertContains("const toggleBandCross=id=>{", "capacity-panel band trigger must cross-filter via FilterCtx")
        self.assertContains("function filterMatchesRow(row,f)", "range-aware cross-filter matcher missing")
        self.assertContains("if(power&&power.hasField&&power.hasField('site')) fx.toggle('site',s.nm,'Site: '+s.nm);",
                             "heatmap cell must cross-filter in place when a co-located table has a `site` column")
        self.assertContains("else nav('network',{f:serializeFilters([{field:'site',value:s.nm}])});",
                             "heatmap cell must still nav-drill when no co-located table matches")

    def test_entity_triage_cluster(self):
        """P1 slice 6 — entity-triage cluster (peek trace + pin scratchpad + macros),
        all built on ONE shared entity inference and the EXISTING peek/LS/nav infra.
        No forked drawer or second storage system."""
        # Shared entity model + trace + scratchpad plumbing (pure helpers).
        self.assertContains("function entityOf(row,tableId){",
                            "entityOf() must infer the entity + BQL predicate for a row")
        self.assertContains("function traceTo(tab,ent){",
                            "traceTo() cross-tab trace must exist")
        self.assertContains("nav(tab,{f:ent.pred.field+':'+ent.pred.value})",
                            "trace must reuse nav + the shared `f=` cross-filter (BQL predicate)")
        self.assertContains("const SCRATCH_KEY='scratchpad';",
                            "scratchpad must key off the shared LS helper (bx.scratchpad)")
        self.assertContains("function pinEntity(ent){",
                            "pinEntity() must exist")
        self.assertContains("LS.set(SCRATCH_KEY,",
                            "scratchpad must persist via the existing LS helper, not a new store")
        # ONE shared EntityPeek reused by the single PeekDrawer (no second drawer).
        self.assertContains("function EntityPeek(",
                            "shared EntityPeek block must exist")
        self.assertContains("<EntityPeek row={peek.row} tableId={peek.tableId}",
                            "PeekDrawer must render the shared EntityPeek (unified, not forked)")
        self.assertContains('className="ep-trace-btn"',
                            "EntityPeek must render cross-tab trace buttons")
        self.assertContains("const TRACE_TARGETS=",
                            "trace targets (DHCP/DNS/Audit/Security) must be declared")
        # On-demand scratchpad tray (focus-managed dialog, exports via existing serializers).
        self.assertContains("function Scratchpad(",
                            "Scratchpad tray component must exist")
        self.assertContains("<Scratchpad/>",
                            "Scratchpad must be mounted in the Shell")
        self.assertContains('className="scratch-badge"',
                            "on-demand pin badge must exist (no standing chrome)")
        self.assertContains('role="dialog" aria-modal="true" aria-label="Scratchpad"',
                            "scratchpad tray must be a focus-trapped dialog")
        self.assertContains("downloadCSV('scratchpad.csv'",
                            "tray export must reuse the existing downloadCSV helper")
        # Keyboard macros o/t/p wired into the existing PowerProvider vim-nav + listed in help.
        self.assertContains("pinTarget(){",
                            "DataTable must expose pinTarget() for the `p` macro")
        self.assertContains("else if(e.key==='o'){ handled=api.openCursor(); }",
                            "`o` macro must open the peek")
        self.assertContains("['t','Trace the row across DHCP / DNS / Audit / Security'],",
                            "shortcut overlay must document the `t` macro")
        self.assertContains("['p','Pin the row to the scratchpad'],",
                            "shortcut overlay must document the `p` macro")

    # ── P1 slice 7: watch expressions + delta-since-last-visit ──────────────────

    def test_watch_expressions_reuse_saved_query_infra(self):
        """A watch is a saved BQL query (name+tab+query) in the shared bx. LS
        namespace, with a LIVE match count computed client-side via the existing
        parseQuery/deriveSchema/buildPredicate. No backend alert engine, no second
        store. Clicking a watch re-applies it through the existing sq= hash surface."""
        # Client-side store keyed off the shared LS helper (bx.watches) — not a server.
        self.assertContains("const WATCH_KEY='watches';",
                            "watches must persist under the shared bx. LS namespace")
        self.assertContains("function readWatches(",
                            "readWatches() must read the LS-backed watch list")
        self.assertContains("function addWatch(",
                            "addWatch() must exist")
        # Live count reuses the EXACT BQL pipeline the table search uses.
        self.assertContains("function watchCount(",
                            "watchCount() must compute a live match count")
        self.assertContains("buildPredicate(parseQuery(watch.query),schema)",
                            "watch count must reuse parseQuery/buildPredicate (no new matcher)")
        # Topbar menu, mounted alongside ViewsMenu; apply re-uses nav + the sq= surface.
        self.assertContains("function WatchMenu(",
                            "WatchMenu topbar dropdown must exist")
        self.assertContains("ReactDOM.createPortal(<WatchMenu/>,slot)",
                            "WatchMenu must mount in the topbar (portal), like ViewsMenu")
        self.assertContains("nav(w.tab,{sq:w.query})",
                            "clicking a watch must re-apply its query via nav + the sq= hash")
        self.assertContains('className="watch-count mono"',
                            "each watch row must render its live match count as text")

    def test_delta_since_last_visit_reuses_snapshot_infra(self):
        """Per-tab '+N new / ~M changed since last visit' chip built on the EXISTING
        snapshot store (readSnaps) + diffRows; the only new state is a per-tab
        last-visit timestamp in bx.tabVisit LS. Signal is glyph+text (monochrome,
        the shared .dt-diff +/~ vocabulary), never color-only."""
        self.assertContains("const VISIT_KEY='tabVisit';",
                            "last-visit timestamps must persist under the shared bx. LS namespace")
        self.assertContains("function baselineSnap(",
                            "baselineSnap() must pick the snapshot at/after the last visit")
        self.assertContains("function DeltaChip(",
                            "DeltaChip component must exist")
        # Reuses the existing snapshot + row-diff machinery (no second snapshot system).
        self.assertContains("diffRows(cfg.prevRows(base),rows,cfg.key,cfg.cmp)",
                            "delta must diff current rows against the prior snapshot via diffRows")
        self.assertContains("<DeltaChip tab={tab} key={'delta-'+tab}/>",
                            "DeltaChip must be mounted per-tab in the Shell (outside .main)")
        # Glyph+count text, not color-only: reuses the .dt-diff +/~ vocabulary.
        self.assertContains('className="delta-chip mono"',
                            "delta chip must render as a monochrome glyph+text chip")
        self.assertContains('className="delta-glyph"',
                            "delta counts must carry a +/~ glyph (not color alone)")
        self.assertContains('<span className="dt-diff mono"><span aria-label={it.tag}',
                            "surfaced rows must reuse the shared dt-diff glyph+aria-label vocabulary")

    # ── Wallboard (NOC-TV) mode + first-run ghost tour (P2 slice 9, final) ───────

    def test_wallboard_mode(self):
        # #wall is a no-chrome overlay route (flagged in parseHash), the Shell swaps
        # in the Wallboard instead of the TopBar/nav, and the Wallboard reuses the
        # existing HealthStrip (health tiles) + a tab body (Overview carries the
        # capacity heatmap + worst-offenders + triage). Esc / a corner control exit.
        self.assertContains("function Wallboard(", "Wallboard component missing")
        self.assertContains("if(tab==='wall') return {tab:'overview',params,wall:true}",
                            "parseHash must flag the #wall route")
        self.assertContains("if(route.wall){", "Shell must swap in the Wallboard for #wall")
        self.assertContains("<Wallboard/>", "Wallboard not mounted for the wall route")
        self.assertContains("function enterWall(", "header wallboard toggle helper missing")
        self.assertContains("function exitWall(", "wallboard exit helper missing")
        self.assertContains('className="kbd wall-toggle"', "TopBar wallboard toggle button missing")
        wb = self.html[self.html.index("function Wallboard("):]
        wb = wb[:wb.index("\nfunction ", 1)]
        self.assertIn("<HealthStrip/>", wb, "wallboard must reuse the HealthStrip health tiles")
        self.assertIn("TAB_COMPONENTS[cur.tab]", wb, "wallboard must render a reused tab body (heatmap/triage)")
        self.assertIn("e.key==='Escape'", wb, "wallboard must exit on Esc")
        self.assertIn("reduceMotion()", wb, "wallboard auto-rotate must honor reduced-motion")
        self.assertIn("setInterval", wb, "wallboard must support ~30s auto-rotation")
        self.assertIn("aria-label={paused?'Resume auto-rotation':'Pause auto-rotation'}", wb,
                      "wallboard auto-rotation must be pausable + keyboard reachable")

    def test_first_run_ghost_tour(self):
        # One-time, non-modal callouts pointing at the 5 power features; "seen" persists
        # in LS (bx.tourSeen); re-summonable from the "?" overlay via the bx:tour event.
        self.assertContains("function GhostTour(", "GhostTour component missing")
        self.assertContains("<GhostTour/>", "GhostTour not mounted in the Shell tree")
        self.assertContains("const TOUR_KEY='tourSeen'", "tour 'seen' LS key missing")
        self.assertContains("Show tour again", "re-summon control missing from the '?' overlay")
        self.assertContains("new CustomEvent('bx:tour')", "'?' overlay must broadcast bx:tour to re-summon")
        gt = self.html[self.html.index("const TOUR_STEPS="):]
        gt = gt[:gt.index("function App(")]
        for feat in ("BQL search", "Command palette", "Pivot on cell", "Compare snapshots", "Vim row-nav"):
            self.assertIn(feat, gt, f"ghost tour missing power feature: {feat!r}")
        self.assertIn("LS.set(TOUR_KEY,true)", gt, "dismiss must persist 'seen' in LS")
        self.assertIn("bx:tour", gt, "GhostTour must listen for the re-summon event")
        self.assertIn("aria-label=\"Skip the feature tour\"", gt, "tour must always offer a skip/dismiss")
        # Non-modal — never an aria-modal dialog that could block the app.
        self.assertNotIn('aria-modal="true"', gt, "the ghost tour must never be a modal dialog")


class OverviewRedesignTests(unittest.TestCase):
    """Static source assertions for the v1 (Bloomberg-grid) Overview rebuild —
    brainstorms/design-bloxsmith-overview-plan-2026-07-12.md. Pure regex/substring
    checks against index.html; no browser (see tests/overview-redesign.spec.ts for
    the DOM-level Playwright coverage of the same 10 fixes)."""

    @classmethod
    def setUpClass(cls):
        # Phase 1: the SPA's JS moved out of an inline <script> into src/*.jsx
        # fragments (compiled to app.bundle.js); CSS still lives inline in index.html.
        # Concatenate index.html + the RAW JSX source so both CSS assertions (from the
        # HTML) and JS assertions (from the source, verbatim-identical to the old inline
        # script) resolve unchanged.
        parts = []
        with open(HTML, encoding="utf-8") as f:
            parts.append(f.read())
        srcdir = os.path.join(DIR, "src")
        if os.path.isdir(srcdir):
            for name in sorted(os.listdir(srcdir)):
                if name.endswith(".jsx"):
                    with open(os.path.join(srcdir, name), encoding="utf-8") as f:
                        parts.append(f.read())
        cls.html = "\n".join(parts)

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
        # Host status renders the host-mix chart via the shared ChartView (pie/bar
        # toggle), fed the hostSlices data — the earlier standalone <Donut> was
        # refactored into ChartView's donut mode.
        ov = self._overview_tab()
        self.assertIn("data={hostSlices}", ov, "host-status chart must be fed hostSlices")
        self.assertIn("donut={{", ov, "host-status ChartView must use donut mode")
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
            "Subnets grouped by tagged site (or by /16 network when untagged).",
            "Reachability of your '+hosts.length.toLocaleString()+' managed hosts",
            "Host did not respond — down or unreachable.",
        ):
            self.assertIn(needle, ov, f"Missing hover description text: {needle!r}")
        # Never fall back to a native title= for these new descriptions.
        self.assertIn("useHoverDetail()", ov)

    def test_capacity_heatmap_replaces_site_bar_list(self):
        """Capacity-by-site 502-row .siterow bar list → distribution bar +
        per-site heatmap. See tests/capacity-heatmap.spec.ts for DOM coverage."""
        ov = self._overview_tab()
        self.assertNotIn('className="siterow', ov, "old .siterow bar-list markup must be gone from Overview")
        self.assertNotIn('className="sites ov-mt"', ov, "old .sites bar-list wrapper must be gone from Overview")
        self.assertIn('className="dist-bar"', ov, "utilization distribution segmented bar missing")
        self.assertIn("toggleBand(b.id)", ov)
        self.assertIn('className="heatmap"', ov, "capacity heatmap grid missing")
        self.assertIn("siteRows.map", ov, "heatmap must render one cell per siteRow")
        self.assertIn("bnd=s.avg>=90?'crit':s.avg>=70?'warn':'ok'", ov,
                      "heatmap cell band thresholds must match the contract (crit>=90, warn 70-89, ok<70)")
        self.assertIn('className="heatmap-legend"', ov, "heatmap legend missing (no color-only state)")

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
        # NUL-safe read (index.html carries stray NUL bytes). Phase 1: the BQL sentinel
        # blocks moved into src/*.jsx, so read index.html + the raw JSX source.
        def _read(p):
            with open(p, "rb") as f:
                return f.read().replace(b"\x00", b" ").decode("utf-8", "replace")
        parts = [_read(HTML)]
        srcdir = os.path.join(DIR, "src")
        if os.path.isdir(srcdir):
            for name in sorted(os.listdir(srcdir)):
                if name.endswith(".jsx"):
                    parts.append(_read(os.path.join(srcdir, name)))
        cls.src = "\n".join(parts)

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

// ── F4: operator richness ──────────────────────────────────────────────
// != comparator (string field) — same result set as the existing '-' negate,
// via a wholly different code path (numCmp/strMatch '!=' branch).
chk('type!=PTR comparator', eqArr(names('type!=PTR'), ['alpha','charlie']));
chk('type!=PTR matches -type:PTR', eqArr(names('type!=PTR'), names('-type:PTR')));
// ~ contains / !~ excludes (type-agnostic substring)
chk('tag~foo contains', eqArr(names('tag~foo'), ['alpha']));
chk('tag!~foo excludes', eqArr(names('tag!~foo'), ['bravo','charlie','delta']));
// IN(a,b,c) set membership — same shape/result as the comma shorthand
chk('severity:IN(critical,high) set', eqArr(names('severity:IN(critical,high)'), names('sev:critical,high')));
// AND — explicit keyword / && symbol both no-ops vs. bare-space (backward-compat)
chk('explicit AND == bare-space', eqArr(names('type:A AND util>60'), names('type:A util>60')));
chk('&& == bare-space', eqArr(names('type:A && util>60'), names('type:A util>60')));
chk('AND narrows correctly', eqArr(names('type:A AND util>60'), ['alpha']));
// OR — union across two independent AND-groups; || is a synonym
chk('OR unions groups', eqArr(names('type:PTR OR util>85'), ['alpha','bravo','delta']));
chk('|| == OR', eqArr(names('type:PTR || util>85'), names('type:PTR OR util>85')));
// NOT — bare word and leading '!' both equivalent to the existing leading '-'
chk('NOT term == -term', eqArr(names('NOT type:PTR'), names('-type:PTR')));
chk('!term == -term', eqArr(names('!type:PTR'), names('-type:PTR')));

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

    def test_bql_cidr_contains(self):
        # Feature 4 (operator richness): `field>>CIDR` and the built-in `in:`
        # alias both mean "row's address value falls inside this CIDR block" —
        # bypasses def.type entirely (works whether or not the field is
        # explicitly typed 'cidr'), reusing a small local ip4-to-int helper
        # since no such helper existed anywhere else in the codebase.
        harness = r"""
const rows=[
  {name:'net1', addr:'10.1.0.0'},
  {name:'net2', addr:'10.200.5.1'},
  {name:'net3', addr:'172.16.0.5'},
  {name:'net4', addr:'11.0.0.1'},
];
const cols=[{key:'name'},{key:'addr'}];
const schema=deriveSchema(cols, rows, {});
function names(q){ return rows.filter(buildPredicate(parseQuery(q), schema)).map(r=>r.name).sort(); }
function eqArr(a,b){ return JSON.stringify(a)===JSON.stringify(b); }
let fails=0;
function chk(l,c){ if(!c){ console.error('FAIL '+l); fails++; } }
chk("'in' aliases onto addr field", schema.aliases.in==='addr');
chk('addr>>10.0.0.0/8 CIDR-contains', eqArr(names('addr>>10.0.0.0/8'), ['net1','net2']));
chk('in:10.0.0.0/8 alias == addr>> form', eqArr(names('in:10.0.0.0/8'), names('addr>>10.0.0.0/8')));
chk('addr>>172.16.0.0/16 isolates net3', eqArr(names('addr>>172.16.0.0/16'), ['net3']));
if(fails){ console.error(fails+' cidr-contains assertion(s) failed'); process.exit(1); }
console.log('CIDR_OK');
"""
        res = self._node(harness)
        self.assertEqual(res.returncode, 0,
                         f"cidr-contains Node run failed:\nSTDOUT:{res.stdout}\nSTDERR:{res.stderr}")
        self.assertIn("CIDR_OK", res.stdout)

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


class ToolingDriftTests(unittest.TestCase):
    """The type-check command is DELIBERATELY duplicated in two places:
    scripts/check.sh (what you run locally) and the CI workflow (inlined so the
    workflow never depends on repo file layout — moving check.sh root->scripts/
    would otherwise have broken CI). Nothing enforces they stay identical, so
    this test does: if either copy changes, this fails instead of drifting."""

    TYPECHECK_CMD = "npx -y --package typescript@latest tsc --noEmit -p tsconfig.json"

    def test_typecheck_command_identical_in_check_sh_and_ci(self):
        for label, path in (("scripts/check.sh", CHECK_SH), (".github/workflows/docker-publish.yml", CI_YML)):
            with open(path, encoding="utf-8") as fh:
                body = fh.read()
            self.assertIn(
                self.TYPECHECK_CMD, body,
                f"{label} no longer contains the exact type-check command "
                f"'{self.TYPECHECK_CMD}'. These two copies are intentional twins — "
                f"update BOTH (see the comment atop scripts/check.sh)."
            )


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
