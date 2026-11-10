package dashboard

import (
	"testing"
)

// Every test here drives a PURE assembler. Service.Mcp is a concrete
// *mcp.Client, not an interface, so the fetch half cannot be faked without a
// wire fake — which is why assets.go pushes every decision worth pinning into
// assembleAssetInventory / assembleAssetFilters / assembleAssetDetail /
// normalizeAssetQuery. Same split threatintel_test.go uses for
// assembleAssetsResult.

// cubeRow builds one row as QueryCube hands it over: keys still carry the
// "AssetDetails_ch_agg." prefix that flattenCubeRow strips.
func assetCubeRow(kv map[string]any) map[string]any {
	out := map[string]any{}
	for k, v := range kv {
		out[assetsCube+"."+k] = v
	}
	return out
}

func listRow(cqid, name, typ, provider, vendor, lastSeen string) map[string]any {
	return assetCubeRow(map[string]any{
		"cqid": cqid, "name": name, "taxonomy_type_label": typ,
		"providers_label": provider, "vendor": vendor, "last_seen": lastSeen,
	})
}

// countRows builds the single-row reply a measures-only cube query returns.
// The value is a STRING because that is what parseInline produces off the
// wire (see internal/mcp.parseInline and tiles_test.go's fixture) — passing a
// float64 here would test a shape production never sees.
func countRows(v string) []map[string]any {
	return []map[string]any{assetCubeRow(map[string]any{"assetsCount": v})}
}

func defaultQuery() AssetQuery {
	return normalizeAssetQuery("", "", "", "", 0)
}

// --- normalizeAssetQuery: the sort whitelist ---------------------------------

// TestNormalizeAssetQuery_SortIsWhitelistedNotSanitised is the security-shaped
// one. The sort key arrives from a query string and ends up as a KEY in the
// cube's `order` argument. Nothing about the input may survive except
// membership in assetSortDims — a value that is not a key falls back to the
// default, it is not passed through, escaped, or trimmed into shape.
func TestNormalizeAssetQuery_SortIsWhitelistedNotSanitised(t *testing.T) {
	for _, bad := range []string{
		"AssetDetails_ch_agg.account_id", // a real dimension, still not offered
		"name; drop",
		"NAME",  // case matters: the map is the contract
		"name ", // no trimming into a match
		"",
		"../../etc",
	} {
		got := normalizeAssetQuery("", "", bad, "", 0)
		if got.Sort != assetDefaultSort {
			t.Errorf("sort %q -> %q, want the default %q (only assetSortDims keys are accepted)",
				bad, got.Sort, assetDefaultSort)
		}
		if _, ok := assetSortDims[got.Sort]; !ok {
			t.Fatalf("sort %q produced %q, which is not a key of assetSortDims — it must never reach the cube", bad, got.Sort)
		}
	}
	for key := range assetSortDims {
		if got := normalizeAssetQuery("", "", key, "", 0); got.Sort != key {
			t.Errorf("sort %q -> %q, want it accepted", key, got.Sort)
		}
	}
}

func TestNormalizeAssetQuery_DirAndPage(t *testing.T) {
	for _, bad := range []string{"", "ASC", "descending", "1"} {
		if got := normalizeAssetQuery("", "", "", bad, 0); got.Dir != assetDefaultDir {
			t.Errorf("dir %q -> %q, want %q", bad, got.Dir, assetDefaultDir)
		}
	}
	if got := normalizeAssetQuery("", "", "", "asc", 0); got.Dir != "asc" {
		t.Errorf("dir asc -> %q, want asc", got.Dir)
	}
	// A negative page must not become a negative offset upstream.
	if got := normalizeAssetQuery("", "", "", "", -5); got.Page != 0 {
		t.Errorf("page -5 -> %d, want 0", got.Page)
	}
}

func TestNormalizeAssetQuery_ClampsLongInput(t *testing.T) {
	long := make([]byte, assetQueryMax+50)
	for i := range long {
		long[i] = 'a'
	}
	got := normalizeAssetQuery(string(long), string(long), "", "", 0)
	if len(got.Q) != assetQueryMax || len(got.Type) != assetQueryMax {
		t.Errorf("q=%d type=%d, want both clamped to %d", len(got.Q), len(got.Type), assetQueryMax)
	}
}

// --- assetFilters ------------------------------------------------------------

// An unfiltered query must send NO filters argument at all, not an empty
// array — assets.go refuses to send a shape the live probe never exercised.
func TestAssetFilters_NilWhenNothingFiltered(t *testing.T) {
	if f := assetFilters(defaultQuery()); f != nil {
		t.Errorf("filters = %v, want nil so the argument is omitted entirely", f)
	}
}

func TestAssetFilters_SearchAndType(t *testing.T) {
	f := assetFilters(normalizeAssetQuery("lap", "Laptop", "", "", 0))
	if len(f) != 2 {
		t.Fatalf("filters = %d, want 2", len(f))
	}
	if f[0]["member"] != assetsCube+".name" || f[0]["operator"] != "contains" {
		t.Errorf("search filter = %+v, want contains on name", f[0])
	}
	if f[1]["member"] != assetsCube+".taxonomy_type_label" || f[1]["operator"] != "equals" {
		t.Errorf("type filter = %+v, want equals on taxonomy_type_label", f[1])
	}
}

// --- assembleAssetInventory: the could-not-look contract ---------------------

// TestAssembleAssetInventory_NilRowsIsErrorNotEmpty is the core house rule.
// QueryCube returns nil on any transport/HTTP/parse failure, so nil rows mean
// the job COULD NOT LOOK. That must never render as an empty table.
func TestAssembleAssetInventory_NilRowsIsErrorNotEmpty(t *testing.T) {
	got := assembleAssetInventory(defaultQuery(), nil, countRows("2620"))
	if got["availability"] != "error" {
		t.Fatalf("availability = %v, want error for a failed list query", got["availability"])
	}
	if got["reason"] == nil || got["reason"] == "" {
		t.Error("reason is empty: the UI has nothing to put on screen")
	}
	// The killer detail: a failed read must not carry a total, even though the
	// count query succeeded. There is no row set for that number to describe.
	if got["total"] != nil {
		t.Errorf("total = %v, want nil on a failed read", got["total"])
	}
}

// TestAssembleAssetInventory_EmptyNonNilIsLookedAndFoundNothing is the other
// half of the same rule, and the one that is easy to get wrong: an empty but
// NON-NIL slice means the query ran and this tenant has nothing matching.
func TestAssembleAssetInventory_EmptyNonNilIsLookedAndFoundNothing(t *testing.T) {
	got := assembleAssetInventory(defaultQuery(), []map[string]any{}, countRows("0"))
	if got["availability"] != "ok" {
		t.Fatalf("availability = %v, want ok — the query succeeded, it just matched nothing", got["availability"])
	}
	if _, hasReason := got["reason"]; hasReason {
		t.Error("reason present on a successful read: nothing failed, so there is nothing to explain")
	}
	rows, ok := got["rows"].([]any)
	if !ok || rows == nil {
		t.Fatalf("rows = %#v, want a non-nil empty slice (nil encodes as JSON null and loses the distinction)", got["rows"])
	}
	if len(rows) != 0 {
		t.Errorf("rows = %d, want 0", len(rows))
	}
	// A genuine zero stays a zero. Only an unknown becomes nil.
	if got["total"] != 0 {
		t.Errorf("total = %v, want 0 for a real zero", got["total"])
	}
}

// TestAssembleAssetInventory_FailedCountKeepsGoodRows: the two queries fail
// independently and are judged independently. A dead count must not throw
// away a page of trustworthy rows, and it must yield null — never 0, and
// never len(rows) dressed up as a total.
func TestAssembleAssetInventory_FailedCountKeepsGoodRows(t *testing.T) {
	rows := []map[string]any{
		listRow("c1", "host-a", "Laptop", "Jamf", "Apple", "2026-08-05"),
		listRow("c2", "host-b", "Server", "AWS", "Dell", "2026-08-04"),
	}
	got := assembleAssetInventory(defaultQuery(), rows, nil)
	if got["availability"] != "ok" {
		t.Fatalf("availability = %v, want ok — the rows are trustworthy", got["availability"])
	}
	if got["total"] != nil {
		t.Errorf("total = %v, want nil — a failed count is not zero and is not the row count", got["total"])
	}
	if got["total"] == 0 {
		t.Fatal("total = 0 for a FAILED count: that is a fabricated fact about the tenant")
	}
	if n := len(got["rows"].([]any)); n != 2 {
		t.Errorf("rows = %d, want 2 kept", n)
	}
}

// An empty-but-successful count reply is an unrecognised shape (a measures-only
// query returns exactly one row), so it is unknown, not zero.
func TestAssembleAssetInventory_EmptyCountReplyIsUnknownNotZero(t *testing.T) {
	got := assembleAssetInventory(defaultQuery(), []map[string]any{}, []map[string]any{})
	if got["total"] != nil {
		t.Errorf("total = %v, want nil — an empty count reply is not evidence of zero assets", got["total"])
	}
}

func TestAssembleAssetInventory_ShapesRowsForTheUI(t *testing.T) {
	got := assembleAssetInventory(defaultQuery(),
		[]map[string]any{listRow("c1", "host-a", "Laptop", "Jamf", "Apple", "2026-08-05")},
		countRows("2620"))
	row := got["rows"].([]any)[0].(map[string]any)
	for k, want := range map[string]string{
		"cqid": "c1", "name": "host-a", "type": "Laptop",
		"provider": "Jamf", "vendor": "Apple", "last_seen": "2026-08-05",
	} {
		if row[k] != want {
			t.Errorf("row[%q] = %v, want %q", k, row[k], want)
		}
	}
	if got["total"] != 2620 {
		t.Errorf("total = %v, want 2620", got["total"])
	}
}

// A row missing every optional field must still produce a complete row object
// with empty strings — a missing KEY would make the browser render "undefined".
func TestAssembleAssetInventory_MissingFieldsBecomeEmptyStrings(t *testing.T) {
	got := assembleAssetInventory(defaultQuery(),
		[]map[string]any{assetCubeRow(map[string]any{"cqid": "c9"})}, countRows("1"))
	row := got["rows"].([]any)[0].(map[string]any)
	for _, k := range []string{"name", "type", "provider", "vendor", "last_seen"} {
		v, present := row[k]
		if !present {
			t.Errorf("row is missing key %q entirely", k)
		}
		if v != "" {
			t.Errorf("row[%q] = %v, want an empty string", k, v)
		}
	}
}

// has_more exists so the UI can offer a next page when total is nil. It is
// "a full page came back", which is one page pessimistic by design.
func TestAssembleAssetInventory_HasMore(t *testing.T) {
	full := make([]map[string]any, assetsPageSize)
	for i := range full {
		full[i] = listRow("c"+string(rune('a'+i%26)), "n", "Laptop", "Jamf", "Apple", "2026-08-05")
	}
	if got := assembleAssetInventory(defaultQuery(), full, nil); got["has_more"] != true {
		t.Error("has_more = false on a full page, want true")
	}
	if got := assembleAssetInventory(defaultQuery(), full[:3], nil); got["has_more"] != false {
		t.Error("has_more = true on a short page, want false")
	}
}

// --- assembleAssetFilters ----------------------------------------------------

func TestAssembleAssetFilters_NilTypesIsError(t *testing.T) {
	got := assembleAssetFilters(nil, countRows("2620"))
	if got["availability"] != "error" {
		t.Fatalf("availability = %v, want error", got["availability"])
	}
	if got["total"] != nil {
		t.Errorf("total = %v, want nil on a failed read", got["total"])
	}
}

func TestAssembleAssetFilters_EmptyTenantIsOkNotError(t *testing.T) {
	got := assembleAssetFilters([]map[string]any{}, countRows("0"))
	if got["availability"] != "ok" {
		t.Fatalf("availability = %v, want ok for a tenant with genuinely no assets", got["availability"])
	}
	if types, _ := got["types"].([]any); types == nil {
		t.Error("types = nil, want a non-nil empty slice")
	}
}

func TestAssembleAssetFilters_ChipsAndBlankLabel(t *testing.T) {
	got := assembleAssetFilters([]map[string]any{
		assetCubeRow(map[string]any{"taxonomy_type_label": "Laptop", "assetsCount": "125"}),
		assetCubeRow(map[string]any{"taxonomy_type_label": "", "assetsCount": "9"}), // dropped: unclickable
		assetCubeRow(map[string]any{"taxonomy_type_label": "Server"}),               // count missing
	}, countRows("2620"))
	types := got["types"].([]any)
	if len(types) != 2 {
		t.Fatalf("types = %d, want 2 (the blank label is dropped)", len(types))
	}
	if first := types[0].(map[string]any); first["label"] != "Laptop" || first["count"] != 125 {
		t.Errorf("types[0] = %+v, want Laptop/125", first)
	}
	// A chip whose measure is missing shows no number rather than a wrong one.
	if second := types[1].(map[string]any); second["label"] != "Server" || second["count"] != nil {
		t.Errorf("types[1] = %+v, want Server with a nil count", second)
	}
	if got["total"] != 2620 {
		t.Errorf("total = %v, want 2620", got["total"])
	}
}

// --- assembleAssetDetail: three outcomes, not two ----------------------------

func TestAssembleAssetDetail_NilIsError(t *testing.T) {
	got := assembleAssetDetail(nil)
	if got["availability"] != "error" {
		t.Fatalf("availability = %v, want error", got["availability"])
	}
	if got["detail"] != nil {
		t.Errorf("detail = %v, want nil", got["detail"])
	}
}

// The middle state: the query ran and the asset is not there (deleted between
// the page load and the click). That is a different fact from "we could not
// ask", and folding them together would show a failure banner for a machine
// that was simply decommissioned.
func TestAssembleAssetDetail_ZeroRowsIsEmptyNotError(t *testing.T) {
	got := assembleAssetDetail([]map[string]any{})
	if got["availability"] != "empty" {
		t.Fatalf("availability = %v, want empty", got["availability"])
	}
	if got["availability"] == "error" {
		t.Fatal(`availability = "error": an asset that no longer exists is not a broken lookup`)
	}
}

func TestAssembleAssetDetail_ShapesTheRow(t *testing.T) {
	got := assembleAssetDetail([]map[string]any{assetCubeRow(map[string]any{
		"cqid": "c1", "os": "macOS 15.2", "ip_addresses": "10.0.0.4",
		"mac_addresses": "aa:bb", "model": "MacBookPro18,3", "location": "AMER",
	})})
	if got["availability"] != "ok" {
		t.Fatalf("availability = %v, want ok", got["availability"])
	}
	d := got["detail"].(map[string]any)
	if d["os"] != "macOS 15.2" || d["ip_addresses"] != "10.0.0.4" || d["location"] != "AMER" {
		t.Errorf("detail = %+v", d)
	}
}

// A found asset with every detail field blank is still "ok" — 72% of assets
// have no OS recorded, and that is a fact about the tenant, not a failure.
func TestAssembleAssetDetail_AllBlankFieldsIsStillOk(t *testing.T) {
	got := assembleAssetDetail([]map[string]any{assetCubeRow(map[string]any{"cqid": "c1"})})
	if got["availability"] != "ok" {
		t.Fatalf("availability = %v, want ok", got["availability"])
	}
	if d := got["detail"].(map[string]any); d["os"] != "" {
		t.Errorf("os = %v, want an empty string", d["os"])
	}
}

// --- cubeList: the JSON-array dimensions -------------------------------------

// providers_label, ip_addresses and mac_addresses arrive as JSON ARRAYS
// serialised into a string. Measured live 2026-08-06: an AWS-discovered asset
// returns providers_label as the six characters ["AWS"], and an asset with no
// addresses returns the two characters []. Both were reaching the browser raw
// before this — [] being the worse of the two, since it is a non-empty string
// and therefore defeats every "is this blank" check downstream.
func TestCubeList(t *testing.T) {
	for in, want := range map[string]string{
		`["AWS"]`:                 "AWS",
		`["AWS", "Jamf"]`:         "AWS, Jamf",
		`[]`:                      "", // the whole point: becomes a real blank
		`["10.0.0.4","10.0.0.5"]`: "10.0.0.4, 10.0.0.5",
		`[""]`:                    "",
		// Scalars must survive untouched.
		"AWS":            "AWS",
		"macOS 15.2":     "macOS 15.2",
		"":               "",
		"MacBookPro18,3": "MacBookPro18,3",
		// Unparseable but array-looking: degrade to the raw value, never to
		// nothing. Showing something odd beats silently dropping a field.
		`[not json`: `[not json`,
	} {
		if got := cubeList(in); got != want {
			t.Errorf("cubeList(%q) = %q, want %q", in, got, want)
		}
	}
	if got := cubeList(nil); got != "" {
		t.Errorf("cubeList(nil) = %q, want an empty string", got)
	}
}

func TestAssembleAssetInventory_FlattensProviderArray(t *testing.T) {
	got := assembleAssetInventory(defaultQuery(),
		[]map[string]any{assetCubeRow(map[string]any{"cqid": "c1", "providers_label": `["AWS"]`})},
		countRows("1"))
	if p := got["rows"].([]any)[0].(map[string]any)["provider"]; p != "AWS" {
		t.Errorf("provider = %q, want AWS — the raw JSON array must not reach the table", p)
	}
}

func TestAssembleAssetDetail_FlattensAddressArrays(t *testing.T) {
	got := assembleAssetDetail([]map[string]any{assetCubeRow(map[string]any{
		"cqid": "c1", "ip_addresses": `[]`, "mac_addresses": `["aa:bb","cc:dd"]`,
	})})
	d := got["detail"].(map[string]any)
	if d["ip_addresses"] != "" {
		t.Errorf(`ip_addresses = %q, want "" — an empty array must read as "not recorded", not as the characters []`, d["ip_addresses"])
	}
	if d["mac_addresses"] != "aa:bb, cc:dd" {
		t.Errorf("mac_addresses = %q, want a joined list", d["mac_addresses"])
	}
}

// --- the dimension guardrail -------------------------------------------------

// TestAssetDimensionSetsRespectTheGuardrail pins the hardest live constraint:
// the cube refuses a 7th dimension outright ("Query blocked by guardrail"), so
// a query with seven does not degrade, it returns nothing. A future edit that
// adds "just one more column" fails here instead of in production.
func TestAssetDimensionSetsRespectTheGuardrail(t *testing.T) {
	const maxDims = 6
	for name, set := range map[string][]string{
		"assetListDims": assetListDims, "assetDetailDims": assetDetailDims,
	} {
		if len(set) > maxDims {
			t.Errorf("%s has %d dimensions; the cube blocks anything over %d", name, len(set), maxDims)
		}
		if set[0] != assetsCube+".cqid" {
			t.Errorf("%s[0] = %q, want cqid — without it rows group by the dimension tuple and distinct assets collapse into one row", name, set[0])
		}
	}
}

// --- issue #138: rows that identify no asset ---------------------------------
//
// The third state. assembleAssetInventory used to split only on listRows ==
// nil — the query failed, or it ran and returned rows — and #138 is neither:
// rows came back and not one of them carries an asset. Measured live twice, on
// two different builds, as a single row of six empty strings under a header
// claiming 2,355 assets, with has_more false hiding the other ~2,300 and
// availability "ok", so the bad answer was CACHED and served again.
//
// WHY THE ASSERTIONS BELOW CHECK total AND has_more AND NOT JUST availability.
// The harm in #138 was not that a blank row rendered, it was that the payload
// around it stayed CONFIDENT: a total of 2,355 over one blank line reads as
// real data, and has_more false is what hid the rest. A fix that flipped
// availability to "error" while still reporting 2,355 would pass a naive test
// and leave the operator with the same lie.
//
// THE CACHING HALF IS NOT RETESTED HERE and that is deliberate. It is not a
// decision this package makes: cache.Do stores only when the fetch returned a
// nil error (cache.go:204), FetchAssetInventory converts availability "error"
// into errAssetFeedDegraded (assets.go), and cache's own
// TestDoFailureIsNotSharedAsSuccess already pins the contract. Restating it
// here would need a wire fake for the concrete *mcp.Client and would prove
// nothing new.

// noCqidRow is the shape measured live: the row that arrived carried the count
// aggregate and NOTHING the list query asked for, so cqid is absent as a key
// rather than present and blank.
func noCqidRow() map[string]any {
	return map[string]any{assetsCube + ".assetsCount": "2355"}
}

func TestAssembleAssetInventory_RowWithNoCqidIsNotAnAsset(t *testing.T) {
	// The byte-for-byte offline reproduction from issue #138: the same
	// count-only reply arrives as BOTH the list and the count answer.
	countOnly := []map[string]any{noCqidRow()}
	got := assembleAssetInventory(defaultQuery(), countOnly, countOnly)

	if got["availability"] != "error" {
		t.Errorf("availability = %v, want error — a row identifying no asset must not render as one", got["availability"])
	}
	if rows := got["rows"].([]any); len(rows) != 0 {
		t.Errorf("rows = %v, want none", rows)
	}
	// The header number is the actual harm. 2,355 over a blank line reads as
	// real data; nil is the only honest answer once the page is not trusted.
	if got["total"] != nil {
		t.Errorf("total = %v, want nil — a page nobody can identify must claim no count", got["total"])
	}
	if got["has_more"] != false {
		t.Errorf("has_more = %v, want false", got["has_more"])
	}
	if got["reason"] == nil || got["reason"] == "" {
		t.Error("reason is empty — the panel has nothing to tell the operator")
	}
}

func TestAssembleAssetInventory_BlankAndWhitespaceCqidAreAlsoRejected(t *testing.T) {
	// A cqid of "" or of spaces fails every use the real one has: it collides
	// as a React row key and round-trips to an asset-detail query matching
	// nothing. Absent and blank must get the same answer.
	for _, cqid := range []string{"", " ", "\t", "   \n "} {
		rows := []map[string]any{listRow(cqid, "laptop-7", "Laptop", "Jamf", "Apple", "2026-08-05")}
		got := assembleAssetInventory(defaultQuery(), rows, countRows("2355"))
		if got["availability"] != "error" {
			t.Errorf("cqid %q: availability = %v, want error", cqid, got["availability"])
		}
		if got["total"] != nil {
			t.Errorf("cqid %q: total = %v, want nil", cqid, got["total"])
		}
	}
}

// A page that mixes real assets with a phantom row is not the page that was
// asked for, so the WHOLE page degrades rather than the bad row being dropped.
// Dropping it would force a choice between lying in has_more — 49 of 50 rows
// hides every later page, the exact harm #138 is about — and inventing a
// partial-trust state the wire contract cannot express.
//
// The position is varied because an implementation that returned early on the
// first row, or only checked the last, would pass a single-position test.
func TestAssembleAssetInventory_OneBadRowFailsTheWholePage(t *testing.T) {
	for _, pos := range []int{0, 1, 25, assetsPageSize - 2, assetsPageSize - 1} {
		full := make([]map[string]any, assetsPageSize)
		for i := range full {
			full[i] = listRow("c"+string(rune('a'+i%26))+string(rune('a'+i/26)),
				"n", "Laptop", "Jamf", "Apple", "2026-08-05")
		}
		full[pos] = noCqidRow()

		got := assembleAssetInventory(defaultQuery(), full, countRows("2355"))
		if got["availability"] != "error" {
			t.Errorf("bad row at %d: availability = %v, want error", pos, got["availability"])
		}
		if rows := got["rows"].([]any); len(rows) != 0 {
			t.Errorf("bad row at %d: served %d rows, want none — a partial page is not what was asked for", pos, len(rows))
		}
		if got["has_more"] != false {
			t.Errorf("bad row at %d: has_more = %v, want false", pos, got["has_more"])
		}
	}
}

// The other direction, and the one that would break real tenants if the
// predicate were widened past cqid. name is 84.4% filled and vendor 81.1%, so
// a device carrying nothing but a cqid is an ordinary asset, not a phantom.
func TestAssembleAssetInventory_CqidOnlyRowIsAnAssetAndStillRenders(t *testing.T) {
	rows := []map[string]any{assetCubeRow(map[string]any{"cqid": "c9"})}
	got := assembleAssetInventory(defaultQuery(), rows, countRows("1"))
	if got["availability"] != "ok" {
		t.Fatalf("availability = %v, want ok — a sparse asset is still an asset", got["availability"])
	}
	if n := len(got["rows"].([]any)); n != 1 {
		t.Errorf("rows = %d, want 1", n)
	}
	if got["total"] != 1 {
		t.Errorf("total = %v, want 1", got["total"])
	}
}

// The empty tenant must not be caught by any of this: no rows at all is
// "looked and found nothing", which is a good answer and stays cacheable.
func TestAssembleAssetInventory_EmptyTenantIsStillOkAfterTheCheck(t *testing.T) {
	got := assembleAssetInventory(defaultQuery(), []map[string]any{}, countRows("0"))
	if got["availability"] != "ok" {
		t.Errorf("availability = %v, want ok", got["availability"])
	}
	if got["total"] != 0 {
		t.Errorf("total = %v, want 0", got["total"])
	}
}

// unusableAssetRow's reason text is the only evidence the log carries, and
// #138's upstream cause is still a hypothesis — which of the two shapes
// arrives is what would tell the candidates apart, so they must not collapse
// into one string.
func TestUnusableAssetRow_ReportsWhichRowAndWhy(t *testing.T) {
	good := listRow("c1", "n", "Laptop", "Jamf", "Apple", "2026-08-05")

	if _, _, found := unusableAssetRow([]map[string]any{good, good}); found {
		t.Error("flagged a page of real assets")
	}
	if _, _, found := unusableAssetRow(nil); found {
		t.Error("flagged an empty page")
	}

	i, why, found := unusableAssetRow([]map[string]any{good, noCqidRow()})
	if !found || i != 1 {
		t.Fatalf("index = %d found = %v, want 1 true", i, found)
	}
	if why != "no cqid field at all" {
		t.Errorf("why = %q, want the absent-key wording", why)
	}

	blank := listRow("", "n", "Laptop", "Jamf", "Apple", "2026-08-05")
	if _, why, _ := unusableAssetRow([]map[string]any{blank}); why != "an empty cqid" {
		t.Errorf("why = %q, want the empty-value wording — absent and blank are different evidence", why)
	}
}
