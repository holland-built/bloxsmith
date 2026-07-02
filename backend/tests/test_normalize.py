"""
Synthetic input -> output tests for backend/data/normalize.py's four norm
functions, mirroring the field mappings and severity thresholds documented
in brainstorms/noc-dashboard-step3a-plan-2026-07-02.md:

- norm_subnets: util >= 90 -> "crit", >= 75 -> "warn", else "ok";
  total=0 -> util 0 / severity "ok".
- norm_leases: state in {used, issued, dynamic} -> active/ok, else
  expired/warn; hostname quote-stripping.
- norm_zones: ttl < 60 -> "TTL Too Low" + warn; ttl > 86400 -> "TTL Too
  High" + warn; neg_ttl > 3600 -> "High Neg-TTL" + warn; clean ttl -> no
  issues + ok; view_map resolution.
- norm_views: passthrough + severity "ok".
"""

from backend.data import normalize


# ── norm_subnets ────────────────────────────────────────────────────────

def test_subnet_util_92_is_crit():
    raw = [{"id": "1", "name": "sub-a", "address": "10.0.0.0", "cidr": 24,
            "utilization": {"total": 100, "used": 92}, "tags": {}}]
    out = normalize.norm_subnets(raw)
    assert out[0]["util"] == 92
    assert out[0]["severity"] == "crit"


def test_subnet_util_80_is_warn():
    raw = [{"id": "2", "name": "sub-b", "address": "10.0.1.0", "cidr": 24,
            "utilization": {"total": 100, "used": 80}, "tags": {}}]
    out = normalize.norm_subnets(raw)
    assert out[0]["util"] == 80
    assert out[0]["severity"] == "warn"


def test_subnet_util_30_is_ok():
    raw = [{"id": "3", "name": "sub-c", "address": "10.0.2.0", "cidr": 24,
            "utilization": {"total": 100, "used": 30}, "tags": {}}]
    out = normalize.norm_subnets(raw)
    assert out[0]["util"] == 30
    assert out[0]["severity"] == "ok"


def test_subnet_total_zero_is_util_zero_and_ok():
    raw = [{"id": "4", "name": "sub-d", "address": "10.0.3.0", "cidr": 24,
            "utilization": {"total": 0, "used": 0}, "tags": {}}]
    out = normalize.norm_subnets(raw)
    assert out[0]["util"] == 0
    assert out[0]["severity"] == "ok"


def test_subnet_reads_dhcp_utilization_fallback():
    raw = [{"id": "5", "name": "sub-e", "address": "10.0.4.0", "cidr": 24,
            "dhcp_utilization": {"total_count": 50, "used_count": 45}, "tags": {}}]
    out = normalize.norm_subnets(raw)
    assert out[0]["util"] == 90
    assert out[0]["severity"] == "crit"


def test_subnet_tags_site_fallback_to_location():
    raw = [{"id": "6", "name": "sub-f", "address": "10.0.5.0", "cidr": 24,
            "utilization": {"total": 10, "used": 1}, "tags": {"location": "hq"}}]
    out = normalize.norm_subnets(raw)
    assert out[0]["site"] == "hq"


def test_subnet_tags_site_preferred_over_location():
    raw = [{"id": "7", "name": "sub-g", "address": "10.0.6.0", "cidr": 24,
            "utilization": {"total": 10, "used": 1},
            "tags": {"site": "branch", "location": "hq"}}]
    out = normalize.norm_subnets(raw)
    assert out[0]["site"] == "branch"


def test_subnet_no_tags_defaults_to_dash():
    raw = [{"id": "8", "name": "sub-h", "address": "10.0.7.0", "cidr": 24,
            "utilization": {"total": 10, "used": 1}}]
    out = normalize.norm_subnets(raw)
    assert out[0]["site"] == "–"


# ── norm_leases ─────────────────────────────────────────────────────────

def test_lease_state_used_is_active_ok():
    raw = [{"address": "10.0.0.5", "hostname": "host-a", "state": "used"}]
    out = normalize.norm_leases(raw)
    assert out[0]["state"] == "active"
    assert out[0]["severity"] == "ok"


def test_lease_state_issued_is_active_ok():
    raw = [{"address": "10.0.0.6", "hostname": "host-b", "state": "issued"}]
    out = normalize.norm_leases(raw)
    assert out[0]["state"] == "active"
    assert out[0]["severity"] == "ok"


def test_lease_state_dynamic_is_active_ok():
    raw = [{"address": "10.0.0.7", "hostname": "host-c", "state": "dynamic"}]
    out = normalize.norm_leases(raw)
    assert out[0]["state"] == "active"
    assert out[0]["severity"] == "ok"


def test_lease_state_other_is_expired_warn():
    raw = [{"address": "10.0.0.8", "hostname": "host-d", "state": "free"}]
    out = normalize.norm_leases(raw)
    assert out[0]["state"] == "expired"
    assert out[0]["severity"] == "warn"


def test_lease_hostname_quote_stripping():
    raw = [{"address": "10.0.0.9", "hostname": '"quoted-host"', "state": "used"}]
    out = normalize.norm_leases(raw)
    assert out[0]["host"] == "quoted-host"


def test_lease_hostname_falls_back_to_client_id():
    raw = [{"address": "10.0.0.10", "client_id": "client-xyz", "state": "used"}]
    out = normalize.norm_leases(raw)
    assert out[0]["host"] == "client-xyz"


# ── norm_zones ──────────────────────────────────────────────────────────

def test_zone_ttl_too_low_is_warn():
    raw = [{"id": "z1", "fqdn": "example.com",
            "zone_authority": {"default_ttl": 30, "negative_ttl": 100}, "view": ""}]
    out = normalize.norm_zones(raw)
    assert "TTL Too Low" in out[0]["issues"]
    assert out[0]["severity"] == "warn"
    assert out[0]["anomaly"] is True


def test_zone_ttl_too_high_is_warn():
    raw = [{"id": "z2", "fqdn": "example.org",
            "zone_authority": {"default_ttl": 90000, "negative_ttl": 100}, "view": ""}]
    out = normalize.norm_zones(raw)
    assert "TTL Too High" in out[0]["issues"]
    assert out[0]["severity"] == "warn"


def test_zone_high_neg_ttl_is_warn():
    raw = [{"id": "z3", "fqdn": "example.net",
            "zone_authority": {"default_ttl": 3600, "negative_ttl": 4000}, "view": ""}]
    out = normalize.norm_zones(raw)
    assert "High Neg-TTL" in out[0]["issues"]
    assert out[0]["severity"] == "warn"


def test_zone_clean_ttl_has_no_issues_and_is_ok():
    raw = [{"id": "z4", "fqdn": "example.io",
            "zone_authority": {"default_ttl": 3600, "negative_ttl": 900}, "view": ""}]
    out = normalize.norm_zones(raw)
    assert out[0]["issues"] == []
    assert out[0]["anomaly"] is False
    assert out[0]["severity"] == "ok"


def test_zone_view_map_resolution():
    raw = [{"id": "z5", "fqdn": "example.dev",
            "zone_authority": {"default_ttl": 3600, "negative_ttl": 900},
            "view": "views/abc123"}]
    view_map = {"views/abc123": "internal-view"}
    out = normalize.norm_zones(raw, view_map)
    assert out[0]["view"] == "internal-view"


def test_zone_view_map_miss_falls_back_to_ref_tail():
    raw = [{"id": "z6", "fqdn": "example.test",
            "zone_authority": {"default_ttl": 3600, "negative_ttl": 900},
            "view": "views/unmapped-ref-long"}]
    out = normalize.norm_zones(raw, {})
    # last path segment, truncated to 12 chars
    assert out[0]["view"] == "unmapped-ref"


def test_zone_no_view_defaults_to_default_string():
    raw = [{"id": "z7", "fqdn": "example.blank",
            "zone_authority": {"default_ttl": 3600, "negative_ttl": 900},
            "view": ""}]
    out = normalize.norm_zones(raw, {})
    assert out[0]["view"] == "default"


# ── norm_views ──────────────────────────────────────────────────────────

def test_views_passthrough_and_severity_ok():
    raw = [{"id": "v1", "name": "default", "comment": "the default view"}]
    out = normalize.norm_views(raw)
    assert out[0]["id"] == "v1"
    assert out[0]["name"] == "default"
    assert out[0]["comment"] == "the default view"
    assert out[0]["severity"] == "ok"


def test_views_missing_fields_default_to_empty_string():
    raw = [{}]
    out = normalize.norm_views(raw)
    assert out[0]["id"] == ""
    assert out[0]["name"] == ""
    assert out[0]["comment"] == ""
    assert out[0]["severity"] == "ok"
