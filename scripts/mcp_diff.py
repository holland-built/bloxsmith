#!/usr/bin/env python3
"""Compare a live Infoblox CSP /mcp catalog against the committed baselines.

WHY THIS IS A FILE AND NOT A HEREDOC IN mcp-drift.yml. It used to be the latter,
and it compared NAMES ONLY. On 2026-08-14 Infoblox marked 17 of 54 analytics
cubes deprecated — each gaining a successor, a sunset date and a rewritten
description, two of them cubes Bloxsmith queries today — and the nightly job
reported "Cubes: 0 added, 0 removed" and opened nothing. It was not broken. It
was answering a narrower question than the one anybody thought it was asking.

A detector that cannot be run outside CI cannot be tested, and an untested
detector is a belief. As a file it takes a known-answer test:

    scripts/mcp_diff.py --selftest

which runs a built-in pair of fixtures through the real comparison functions and
asserts the exact findings, so this class of blind spot fails loudly here rather
than silently in production.

Usage:
    mcp_diff.py --live-dir DIR --snap-dir DIR [--github-output FILE]

Prints the markdown report on stdout. With --github-output, also writes
`changed=` and a `body<<BODYEOF` heredoc for the workflow to consume.
Exit code is 0 whether or not drift was found — drift is a finding, not an
error. Nonzero means the comparison itself could not run.
"""
import argparse
import datetime
import json
import os
import re
import sys

# Cube metadata worth watching. Everything here has bitten or could bite:
# `deprecated`/`sunsetDate` carry a deadline, `successor` names the migration
# target, `version` moves when the shape changes underneath a query.
CUBE_META_FIELDS = ("deprecated", "lifecycleStage", "successor", "sunsetDate", "version")


def _norm(v):
    """Absent, null and empty-string are the SAME state, not three states.

    Without this, the first cube to gain an explicit `"deprecated": false` where
    the key was previously absent reports as drift while nothing has changed —
    and a job that cries wolf gets ignored, which is the failure mode this whole
    file exists to prevent.
    """
    if v is None:
        return None
    if isinstance(v, str) and v.strip() == "":
        return None
    return v


def _load(path):
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


# --- tools --------------------------------------------------------------------

def _tool_map(path):
    """{tool_name: {"params": {name: type}, "required": set, "description": str}}

    catalog_tools.py stores params as FORMATTED STRINGS ("name*:type"), so a
    plain list comparison would flag a reordered JSON Schema `properties` object
    as drift. Parsing back into a mapping makes the comparison order-independent,
    which is what the API actually guarantees.
    """
    out = {}
    for t in _load(path):
        if not isinstance(t, dict) or not t.get("name"):
            continue
        params = {}
        for raw in t.get("params") or []:
            spec = str(raw)
            name, _, typ = spec.partition(":")
            params[name.rstrip("*")] = typ
        out[t["name"]] = {
            "params": params,
            "required": set(t.get("required") or []),
            "description": (t.get("description") or "").strip(),
        }
    return out


def diff_tools(snap_path, live_path):
    snap, live = _tool_map(snap_path), _tool_map(live_path)
    added = sorted(set(live) - set(snap))
    removed = sorted(set(snap) - set(live))
    changed, desc_changed = [], []
    for n in sorted(set(snap) & set(live)):
        s, l = snap[n], live[n]
        bits = []
        gained = sorted(set(l["params"]) - set(s["params"]))
        lost = sorted(set(s["params"]) - set(l["params"]))
        retyped = sorted(f"{p} {s['params'][p]}->{l['params'][p]}"
                         for p in set(s["params"]) & set(l["params"])
                         if s["params"][p] != l["params"][p])
        # A tool that silently gains a REQUIRED parameter breaks every existing
        # caller just as thoroughly as a tool that was deleted.
        now_required = sorted(l["required"] - s["required"])
        now_optional = sorted(s["required"] - l["required"])
        if gained:
            bits.append(f"new params: {', '.join(gained)}")
        if lost:
            bits.append(f"dropped params: {', '.join(lost)}")
        if retyped:
            bits.append(f"retyped: {', '.join(retyped)}")
        if now_required:
            bits.append(f"NOW REQUIRED: {', '.join(now_required)}")
        if now_optional:
            bits.append(f"no longer required: {', '.join(now_optional)}")
        if bits:
            changed.append(f"{n}: {'; '.join(bits)}")
        if s["description"] != l["description"]:
            desc_changed.append(n)
    return {"added": added, "removed": removed, "changed": changed,
            "desc_changed": desc_changed}


# --- services -----------------------------------------------------------------

def _service_map(path):
    data = _load(path)
    svc = data.get("all_services", {}).get("services", [])
    return {s.get("service_name"): s for s in svc if isinstance(s, dict)}


def diff_services(snap_path, live_path):
    snap, live = _service_map(snap_path), _service_map(live_path)
    added = sorted(set(live) - set(snap))
    removed = sorted(set(snap) - set(live))
    changed = []
    for n in sorted(set(snap) & set(live)):
        s, l = snap[n], live[n]
        bits = []
        if _norm(s.get("paths_count")) != _norm(l.get("paths_count")):
            bits.append(f"paths {s.get('paths_count')} -> {l.get('paths_count')}")
        if _norm(s.get("version")) != _norm(l.get("version")):
            bits.append(f"version {s.get('version')} -> {l.get('version')}")
        if bits:
            changed.append(f"{n}: {', '.join(bits)}")
    return {"added": added, "removed": removed, "changed": changed}


# --- cubes --------------------------------------------------------------------

def _find_cube_list(obj):
    """First list found under a 'cubes' key, at any depth."""
    if isinstance(obj, dict):
        if isinstance(obj.get("cubes"), list):
            return obj["cubes"]
        for v in obj.values():
            found = _find_cube_list(v)
            if found is not None:
                return found
    return None


def _cube_map(path):
    out = {}
    for c in _find_cube_list(_load(path)) or []:
        if not isinstance(c, dict) or not c.get("name"):
            continue
        meta = c.get("meta") if isinstance(c.get("meta"), dict) else {}
        out[c["name"]] = {
            "meta": {f: _norm(meta.get(f)) for f in CUBE_META_FIELDS},
            "description": (c.get("description") or "").strip(),
        }
    return out


def diff_cubes(snap_path, live_path):
    snap, live = _cube_map(snap_path), _cube_map(live_path)
    added = sorted(set(live) - set(snap))
    removed = sorted(set(snap) - set(live))
    newly_deprecated, undeprecated, meta_changed, desc_changed = [], [], [], []
    for n in sorted(set(snap) & set(live)):
        s, l = snap[n], live[n]
        was, now = bool(s["meta"]["deprecated"]), bool(l["meta"]["deprecated"])
        if now and not was:
            newly_deprecated.append({
                "name": n,
                "successor": l["meta"]["successor"] or "(none named)",
                "sunset": l["meta"]["sunsetDate"] or "(no date)",
            })
        elif was and not now:
            undeprecated.append(n)
        bits = [f"{f} {s['meta'][f]!r} -> {l['meta'][f]!r}"
                for f in CUBE_META_FIELDS
                if f != "deprecated" and s["meta"][f] != l["meta"][f]]
        # Deprecation is reported in its own section; don't say it twice.
        if bits and not (now and not was):
            meta_changed.append(f"{n}: {'; '.join(bits)}")
        if s["description"] != l["description"]:
            desc_changed.append(n)
    return {"added": added, "removed": removed,
            "newly_deprecated": newly_deprecated, "undeprecated": undeprecated,
            "meta_changed": meta_changed, "desc_changed": desc_changed}


# --- sunset deadlines ---------------------------------------------------------
#
# A DEADLINE NOTHING WATCHES IS A DEADLINE THAT PASSES.
#
# Everything above answers "what changed since last night". A sunset date answers
# "what breaks on a date whether or not anything changes", and the two are not the
# same question. On 2026-08-14 Infoblox marked NstarDnsActivity and HostMetrics —
# both queried by this repo — for removal on 2027-07-16 and 2027-07-01. Nothing
# will change between now and then. A change-detector is silent for eleven months
# and then two dashboard panels return nothing.
#
# So this section fires on the calendar, not on a diff, and its verdict is a
# SEPARATE output (`deadline_alert`) from `changed`. A countdown that can only
# speak on a day something else happened to drift is not a countdown.

BAND_SOON, BAND_URGENT, BAND_PASSED = 180, 60, 0

# Directories worth grepping, and what to leave out. Test files mention these cube
# names far more often than production code does; counting them would overstate the
# blast radius and, worse, would keep alerting after a real migration because a
# fixture still named the old cube.
SRC_ROOTS = ("go", "ui/src")
SRC_EXTS = (".go", ".jsx", ".js")
SRC_SKIP_DIRS = ("go/web", "node_modules", "third_party")


def used_cubes(names, root="."):
    """{cube_name: [files]} for cubes referenced by PRODUCTION source.

    Matches `CubeName.` — cube fields are always addressed as `Cube.field` in a
    query body, so the trailing dot is what distinguishes a real reference from a
    substring of a longer identifier.
    """
    hits = {}
    pats = {n: re.compile(re.escape(n) + r"\.") for n in names}
    for base in SRC_ROOTS:
        top = os.path.join(root, base)
        for dirpath, dirnames, filenames in os.walk(top):
            rel_dir = os.path.relpath(dirpath, root)
            if any(rel_dir == s or rel_dir.startswith(s + os.sep) for s in SRC_SKIP_DIRS):
                dirnames[:] = []
                continue
            for fn in filenames:
                if not fn.endswith(SRC_EXTS) or fn.endswith("_test.go"):
                    continue
                path = os.path.join(dirpath, fn)
                try:
                    text = open(path, encoding="utf-8", errors="ignore").read()
                except OSError:
                    continue
                for n, pat in pats.items():
                    if pat.search(text):
                        hits.setdefault(n, []).append(os.path.relpath(path, root))
    return {n: sorted(f) for n, f in hits.items()}


def _band(days):
    if days is None:
        return "unknown"
    if days <= BAND_PASSED:
        return "passed"
    if days <= BAND_URGENT:
        return "urgent"
    if days <= BAND_SOON:
        return "soon"
    return "watch"


def deadlines(live_cube_map, root=".", today=None):
    """Deprecated cubes THIS REPO USES, with days remaining and a severity band."""
    today = today or datetime.date.today()
    deprecated = {n: c for n, c in live_cube_map.items() if c["meta"]["deprecated"]}
    used = used_cubes(deprecated.keys(), root)
    rows = []
    for n in sorted(used):
        meta = deprecated[n]["meta"]
        raw = meta["sunsetDate"]
        days = None
        if raw:
            try:
                days = (datetime.date.fromisoformat(str(raw)[:10]) - today).days
            except ValueError:
                days = None  # malformed — treated as unknown, which still alerts
        successor = meta["successor"]
        rows.append({
            "name": n, "sunset": raw or "(no date given)", "days": days,
            "band": _band(days), "successor": successor or "(none named)",
            # A successor that is not published yet cannot be migrated to. That is
            # the difference between "plan this" and "do this", so it is stated.
            "successor_available": bool(successor) and successor in live_cube_map,
            "files": used[n],
        })
    # `watch` is informational. Anything nearer than that, or any deadline we could
    # not read, opens an issue on its own.
    alert = any(r["band"] in ("soon", "urgent", "passed", "unknown") for r in rows)
    return {"rows": rows, "alert": alert}


def render_deadlines(d):
    if not d["rows"]:
        return []
    label = {"passed": "🔴 SUNSET PASSED", "urgent": "🔴 URGENT", "soon": "🟠 SOON",
             "watch": "🟡 watch", "unknown": "🔴 NO READABLE DATE"}
    out = ["## Deprecated cubes this repo actually queries", "",
           "| cube | days left | sunset | successor | available yet? |",
           "| --- | ---: | --- | --- | --- |"]
    for r in d["rows"]:
        days = "?" if r["days"] is None else str(r["days"])
        out.append(f"| `{r['name']}` {label[r['band']]} | {days} | {r['sunset']} | "
                   f"`{r['successor']}` | {'yes' if r['successor_available'] else '**NOT PUBLISHED**'} |")
    out.append("")
    for r in d["rows"]:
        out.append(f"- `{r['name']}` is used in: {', '.join(f'`{f}`' for f in r['files'])}")
    out += ["",
            "A successor marked **NOT PUBLISHED** cannot be migrated to — the cube "
            "does not exist on the live surface. When it appears, the Cubes section "
            "above will report it as added, and that is the signal to scope the "
            "migration.", ""]
    return out


# --- report -------------------------------------------------------------------

def _fmt(items):
    return ", ".join(items) if items else "_none_"


def render(t, s, c, d=None):
    # The opening line has to tell the truth in BOTH directions. It used to say
    # "no longer matches" unconditionally, which meant a clean run printed a
    # drift headline into the log and then quietly set changed=false — the report
    # contradicting its own verdict. Anyone reading the log would believe the
    # wrong thing, which is how the name-only blind spot survived so long.
    if any_change(t, s, c):
        out = ["The live Infoblox CSP `/mcp` surface no longer matches the committed "
               "baselines.", ""]
    elif d and d["alert"]:
        out = ["The live Infoblox CSP `/mcp` surface matches the committed baselines — "
               "**nothing has drifted**. This is a DEADLINE notice: a cube this repo "
               "queries is scheduled for removal.", ""]
    else:
        out = ["The live Infoblox CSP `/mcp` surface matches the committed baselines. "
               "Nothing to do.", ""]

    # Deadlines first when they are the reason the job is speaking.
    if d and d["alert"]:
        out += render_deadlines(d)

    # Deprecation first and on its own. It is the only class of change here with
    # a DEADLINE attached, and it is the one the name-only check used to miss
    # entirely.
    if c["newly_deprecated"]:
        out += [f"## ⚠️ {len(c['newly_deprecated'])} cube(s) newly DEPRECATED", "",
                "| cube | successor | sunset |", "| --- | --- | --- |"]
        out += [f"| `{d['name']}` | `{d['successor']}` | {d['sunset']} |"
                for d in c["newly_deprecated"]]
        out += ["", "Nothing breaks on the day this is reported. Check whether "
                "anything in `go/` or `ui/src/` queries these before the sunset "
                "date, and open real work if so — this issue is a notice, not a "
                "fix.", ""]

    out += ["## Tools", "",
            f"**Added ({len(t['added'])}):** {_fmt(t['added'])}", "",
            f"**Removed ({len(t['removed'])}):** {_fmt(t['removed'])}", "",
            f"**Signature changed ({len(t['changed'])}):** "
            f"{'; '.join(t['changed']) if t['changed'] else '_none_'}", "",
            f"**Description changed ({len(t['desc_changed'])}):** "
            f"{_fmt(t['desc_changed'])}", "",
            "Refresh: `python scripts/catalog_tools.py > scripts/out_tools.json`", "",
            "## Services", "",
            f"**Added ({len(s['added'])}):** {_fmt(s['added'])}", "",
            f"**Removed ({len(s['removed'])}):** {_fmt(s['removed'])}", "",
            f"**Changed ({len(s['changed'])}):** "
            f"{'; '.join(s['changed']) if s['changed'] else '_none_'}", "",
            "Refresh: `python scripts/catalog_services.py > scripts/out_services.json`", "",
            "## Cubes", "",
            f"**Added ({len(c['added'])}):** {_fmt(c['added'])}", "",
            f"**Removed ({len(c['removed'])}):** {_fmt(c['removed'])}", "",
            f"**Newly deprecated ({len(c['newly_deprecated'])}):** "
            f"{_fmt([d['name'] for d in c['newly_deprecated']])}", "",
            f"**No longer deprecated ({len(c['undeprecated'])}):** "
            f"{_fmt(c['undeprecated'])}", "",
            f"**Metadata changed ({len(c['meta_changed'])}):** "
            f"{'; '.join(c['meta_changed']) if c['meta_changed'] else '_none_'}", "",
            f"**Description changed ({len(c['desc_changed'])}):** "
            f"{_fmt(c['desc_changed'])}", "",
            "Refresh: `python scripts/catalog_cubes.py > scripts/out_cubes.json`", ""]
    # When drift is the headline, deadlines go at the end as context rather than
    # competing with it.
    if d and d["rows"] and not d["alert"]:
        out += render_deadlines(d)
    elif d and d["rows"] and any_change(t, s, c):
        out += render_deadlines(d)
    out.append("Check nothing broke before committing the refreshed baseline(s).")
    return "\n".join(out)


def any_change(t, s, c):
    return any([t["added"], t["removed"], t["changed"], t["desc_changed"],
                s["added"], s["removed"], s["changed"],
                c["added"], c["removed"], c["newly_deprecated"],
                c["undeprecated"], c["meta_changed"], c["desc_changed"]])


# --- selftest -----------------------------------------------------------------

def _selftest():
    """Known-answer test over the exact failure this file was written for.

    Every case below is one the name-only check got wrong, plus the
    normalisation cases that would make the new check cry wolf.
    """
    import tempfile
    j = os.path.join

    def w(d, name, obj):
        p = os.path.join(d, name)
        with open(p, "w", encoding="utf-8") as fh:
            json.dump(obj, fh)
        return p

    d = tempfile.mkdtemp()
    fails = []

    def check(label, got, want):
        if got != want:
            fails.append(f"{label}: got {got!r}, expected {want!r}")

    # Cubes: same names both sides — the case that reported "0 added, 0 removed".
    snap_c = w(d, "sc.json", {"all_cubes": {"cubes": [
        {"name": "HostMetrics", "description": "old", "meta": {}},
        {"name": "Stable", "description": "same", "meta": {"version": "1.0.0"}},
        {"name": "WasDeprecated", "description": "x", "meta": {"deprecated": True}},
        {"name": "NullVsAbsent", "description": "y", "meta": {"successor": None}},
    ]}})
    live_c = w(d, "lc.json", {"all_cubes": {"cubes": [
        {"name": "HostMetrics", "description": "new text", "meta": {
            "deprecated": True, "successor": "HostMetricsV1", "sunsetDate": "2027-07-01"}},
        {"name": "Stable", "description": "same", "meta": {"version": "1.0.0"}},
        {"name": "WasDeprecated", "description": "x", "meta": {"deprecated": False}},
        {"name": "NullVsAbsent", "description": "y", "meta": {"successor": ""}},
    ]}})
    c = diff_cubes(snap_c, live_c)
    check("cubes added", c["added"], [])
    check("cubes removed", c["removed"], [])
    check("newly deprecated", [x["name"] for x in c["newly_deprecated"]], ["HostMetrics"])
    check("successor captured", c["newly_deprecated"][0]["successor"] if c["newly_deprecated"] else None,
          "HostMetricsV1")
    check("sunset captured", c["newly_deprecated"][0]["sunset"] if c["newly_deprecated"] else None,
          "2027-07-01")
    check("undeprecated", c["undeprecated"], ["WasDeprecated"])
    check("desc changed", c["desc_changed"], ["HostMetrics"])
    # None vs "" vs absent must NOT be drift, or the job cries wolf.
    check("null-vs-empty is not drift", [m for m in c["meta_changed"] if "NullVsAbsent" in m], [])
    check("unchanged cube is silent", [m for m in c["meta_changed"] if "Stable" in m], [])

    # Tools: reordered params are NOT drift; a new required param IS.
    snap_t = w(d, "st.json", [
        {"name": "keep", "description": "d", "params": ["b:string", "a*:int"], "required": ["a"]},
        {"name": "gains_req", "description": "d", "params": ["x:string"], "required": []},
        {"name": "goes", "description": "d", "params": [], "required": []},
    ])
    live_t = w(d, "lt.json", [
        {"name": "keep", "description": "d", "params": ["a*:int", "b:string"], "required": ["a"]},
        {"name": "gains_req", "description": "d", "params": ["x*:string"], "required": ["x"]},
        {"name": "arrives", "description": "d", "params": [], "required": []},
    ])
    t = diff_tools(snap_t, live_t)
    check("tools added", t["added"], ["arrives"])
    check("tools removed", t["removed"], ["goes"])
    check("param reorder is not drift", [x for x in t["changed"] if x.startswith("keep")], [])
    check("new required is drift", [x for x in t["changed"] if x.startswith("gains_req")],
          ["gains_req: NOW REQUIRED: x"])

    # Identical input on both sides must report NOTHING. A detector that flags an
    # unchanged pair is as useless as one that misses a real change.
    c_same = diff_cubes(snap_c, snap_c)
    t_same = diff_tools(snap_t, snap_t)
    s_empty = {"added": [], "removed": [], "changed": []}
    check("no false drift on identical input", any_change(t_same, s_empty, c_same), False)

    # ...AND IT MUST ALSO BE ABLE TO SAY YES. Until now every assertion about
    # any_change() expected False, so `def any_change(...): return False` passed
    # this whole selftest — measured, by doing exactly that. main() sets
    # `changed = any_change(t, s, c)` and mcp-drift.yml gates its issue on that
    # output, so a version that can only stay quiet is the same dead detector as
    # the ImportError that left this workflow green for two nights.
    #
    # One case PER FIELD, not one case in total. any_change is an any([...]) over
    # thirteen fields; a single positive case would pass while twelve of them were
    # deleted. This way, dropping a category from that list fails by its own name.
    # c["newly_deprecated"] is in here for a reason: it is the field that exists
    # because the name-only check missed 17 cube deprecations.
    _empty_t = {"added": [], "removed": [], "changed": [], "desc_changed": []}
    _empty_s = {"added": [], "removed": [], "changed": []}
    _empty_c = {"added": [], "removed": [], "newly_deprecated": [],
                "undeprecated": [], "meta_changed": [], "desc_changed": []}
    for which, field in ([("tools", f) for f in _empty_t]
                         + [("services", f) for f in _empty_s]
                         + [("cubes", f) for f in _empty_c]):
        one_t, one_s, one_c = dict(_empty_t), dict(_empty_s), dict(_empty_c)
        {"tools": one_t, "services": one_s, "cubes": one_c}[which][field] = ["something"]
        check(f"any_change reports {which}.{field}", any_change(one_t, one_s, one_c), True)
    check("no drift when every field is empty",
          any_change(dict(_empty_t), dict(_empty_s), dict(_empty_c)), False)

    # --- deadlines ------------------------------------------------------------
    # Every boundary, both sides. A band rule with no test rots the first time
    # someone edits a threshold, and this one is the difference between eleven
    # months of warning and none.
    for days, want in [(181, "watch"), (180, "soon"), (61, "soon"), (60, "urgent"),
                       (1, "urgent"), (0, "passed"), (-5, "passed"), (None, "unknown")]:
        check(f"band at {days} days", _band(days), want)

    # A fake repo tree, so usage detection is exercised rather than assumed.
    repo = tempfile.mkdtemp()
    os.makedirs(j(repo, "go", "internal", "dashboard"))
    os.makedirs(j(repo, "go", "web"))
    with open(j(repo, "go", "internal", "dashboard", "analytics.go"), "w") as fh:
        fh.write('x := "UsedCube.total_count"\n')
    # Test files and the built UI bundle must NOT count as usage — otherwise a
    # stale fixture keeps the alarm ringing after a real migration.
    with open(j(repo, "go", "internal", "dashboard", "analytics_test.go"), "w") as fh:
        fh.write('x := "TestOnlyCube.total_count"\n')
    with open(j(repo, "go", "web", "bundle.js"), "w") as fh:
        fh.write('"BundleOnlyCube.x"\n')

    today = datetime.date(2026, 8, 14)

    def cube(name, deprecated=False, sunset=None, successor=None):
        return {name: {"meta": {"deprecated": deprecated, "lifecycleStage": None,
                                "successor": successor, "sunsetDate": sunset,
                                "version": None}, "description": ""}}

    m = {}
    m.update(cube("UsedCube", True, "2027-07-01", "UsedCubeV1"))   # used + deprecated
    m.update(cube("TestOnlyCube", True, "2027-07-01", "X"))        # only in a _test.go
    m.update(cube("BundleOnlyCube", True, "2027-07-01", "X"))      # only in go/web
    m.update(cube("UnusedCube", True, "2026-09-01", "Y"))          # deprecated, unused
    d = deadlines(m, root=repo, today=today)
    check("only production usage counts", [r["name"] for r in d["rows"]], ["UsedCube"])
    check("321 days out is watch", d["rows"][0]["band"], "watch")
    check("watch alone does not alert", d["alert"], False)
    check("absent successor flagged", d["rows"][0]["successor_available"], False)

    # Same cube, successor now published -> migration is actually possible.
    m2 = dict(m)
    m2.update(cube("UsedCubeV1"))
    d2 = deadlines(m2, root=repo, today=today)
    check("published successor detected", d2["rows"][0]["successor_available"], True)

    # Inside 180 days: must alert with ZERO drift. This is the whole point.
    d3 = deadlines(m, root=repo, today=datetime.date(2027, 3, 1))
    check("122 days out is soon", d3["rows"][0]["band"], "soon")
    check("soon alerts", d3["alert"], True)

    # Malformed and missing dates alert rather than passing silently — an
    # unreadable deadline on a cube we query is itself the problem.
    d4 = deadlines(cube("UsedCube", True, "not-a-date", "Z"), root=repo, today=today)
    check("malformed date is unknown", d4["rows"][0]["band"], "unknown")
    check("malformed date alerts", d4["alert"], True)
    d5 = deadlines(cube("UsedCube", True, None, "Z"), root=repo, today=today)
    check("missing date alerts", d5["alert"], True)

    # A cube we use that is NOT deprecated must be invisible here.
    check("healthy cube is silent", deadlines(cube("UsedCube"), root=repo, today=today)["rows"], [])

    # THE CENTRAL CLAIM: no drift at all, and the job still speaks.
    check("zero drift + live deadline still alerts",
          (any_change(t_same, s_empty, c_same), d3["alert"]), (False, True))

    if fails:
        for f in fails:
            print(f"selftest FAIL: {f}", file=sys.stderr)
        print(f"selftest: {len(fails)} failure(s)", file=sys.stderr)
        return 1
    print("selftest: ok")
    return 0


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--live-dir", help="directory holding live_{tools,services,cubes}.json")
    ap.add_argument("--snap-dir", default="scripts",
                    help="directory holding out_{tools,services,cubes}.json")
    ap.add_argument("--github-output", help="path to write changed= and body<<BODYEOF")
    ap.add_argument("--repo-root", default=".",
                    help="repo root to grep for cube usage (default: cwd)")
    ap.add_argument("--today", help="ISO date to evaluate deadlines against (testing)")
    ap.add_argument("--selftest", action="store_true")
    a = ap.parse_args()

    if a.selftest:
        return _selftest()
    if not a.live_dir:
        ap.error("--live-dir is required unless --selftest")

    j = os.path.join
    t = diff_tools(j(a.snap_dir, "out_tools.json"), j(a.live_dir, "live_tools.json"))
    s = diff_services(j(a.snap_dir, "out_services.json"), j(a.live_dir, "live_services.json"))
    c = diff_cubes(j(a.snap_dir, "out_cubes.json"), j(a.live_dir, "live_cubes.json"))
    d = deadlines(_cube_map(j(a.live_dir, "live_cubes.json")), root=a.repo_root,
                  today=datetime.date.fromisoformat(a.today) if a.today else None)

    body = render(t, s, c, d)
    changed = any_change(t, s, c)
    print(body)
    if a.github_output:
        with open(a.github_output, "a", encoding="utf-8") as fh:
            fh.write(f"changed={'true' if changed else 'false'}\n")
            # SEPARATE from `changed` on purpose — the workflow fires the issue
            # step on either, so a deadline can speak on a day nothing drifted.
            fh.write(f"deadline_alert={'true' if d['alert'] else 'false'}\n")
            # The band set, so the workflow can comment ONLY when a cube crosses
            # into a new band instead of every single night for months.
            fh.write("deadline_bands=" +
                     ",".join(f"{r['name']}:{r['band']}" for r in d["rows"]) + "\n")
            fh.write("body<<BODYEOF\n" + body + "\nBODYEOF\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
