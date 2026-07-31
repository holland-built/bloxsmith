package config

import (
	"os"
	"path/filepath"
	"testing"
)

// This file exercises the package that decides which passphrase, which
// dashboard token, and which Host headers the whole running server trusts.
// Two production bugs this week were precedence bugs in exactly this area
// (vault-passphrase status reporting the opposite of what the server would
// actually do). Every test below is written to fail loudly, with a message
// that says what an operator would actually observe if the rule broke.
//
// CAUTION FOR FUTURE EDITORS: LoadDotEnv calls os.Setenv on the REAL process
// environment, and envOrigin (recordOrigin/OriginOf) is a package-level map
// with no reset function. Every test here uses env var keys and origin keys
// that are unique to that test (a CONFIG_TEST_* prefix plus the test name)
// so that no test's os.Setenv or recordOrigin call is visible to another
// test's assertions, regardless of run order. Tests that call os.Setenv
// directly (not via t.Setenv, because LoadDotEnv's setdefault behavior must
// be exercised against a key that is already set before LoadDotEnv runs, or
// because a key must remain unset going in) explicitly os.Unsetenv in
// t.Cleanup. envOrigin itself is never reset — that is a real limitation:
// once a key is written to envOrigin by any test, it stays there for the
// rest of the process. Every OriginOf assertion below is therefore against
// a key exclusive to that test, never reused.

// writeEnvFile writes a temp .env file with the given raw lines and returns
// its path.
func writeEnvFile(t *testing.T, lines ...string) string {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, ".env")
	content := ""
	for _, l := range lines {
		content += l + "\n"
	}
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

// unsetEnv guarantees key is unset for the duration of the test, restoring
// whatever the real environment had (if anything) afterward. Needed instead
// of t.Setenv when the test's whole point is exercising the not-yet-set
// case, or when LoadDotEnv's own os.Setenv must be free to act without
// t.Setenv's Cleanup racing it.
func unsetEnv(t *testing.T, key string) {
	t.Helper()
	orig, had := os.LookupEnv(key)
	_ = os.Unsetenv(key)
	t.Cleanup(func() {
		if had {
			_ = os.Setenv(key, orig)
		} else {
			_ = os.Unsetenv(key)
		}
	})
}

// ---------------------------------------------------------------------
// 1. PRECEDENCE: LoadDotEnv is setdefault. A value already in the real
// environment wins over the .env file. This is the exact rule the
// "which passphrase wins" question rests on, and the rule the
// vault-passphrase status bug got backwards.
// ---------------------------------------------------------------------

func TestLoadDotEnv_RealEnvWinsOverFile(t *testing.T) {
	key := "CONFIG_TEST_PRECEDENCE_ENV_WINS"
	t.Setenv(key, "from-real-env")

	path := writeEnvFile(t, key+"=from-file")
	LoadDotEnv(path)

	if got := os.Getenv(key); got != "from-real-env" {
		t.Fatalf("%s = %q after LoadDotEnv, want %q: the real environment must win over the .env file (setdefault), or an operator's exported VAULT_PASSPHRASE would be silently overridden by whatever .env happens to be lying around", key, got, "from-real-env")
	}
}

// ---------------------------------------------------------------------
// 2. FIRST FILE WINS: loading two .env files in order, the first file to
// set a key keeps it. This is how the binary-dir / cwd / service-dir
// chain behaves in main.go.
// ---------------------------------------------------------------------

func TestLoadDotEnv_FirstFileWins(t *testing.T) {
	key := "CONFIG_TEST_FIRST_FILE_WINS"
	unsetEnv(t, key)

	file1 := writeEnvFile(t, key+"=first")
	file2 := writeEnvFile(t, key+"=second")

	LoadDotEnv(file1)
	LoadDotEnv(file2)

	if got := os.Getenv(key); got != "first" {
		t.Fatalf("%s = %q after loading file1 then file2, want %q: the first file in the chain (e.g. the binary's own directory) must win, or an operator's carefully placed override .env would be silently beaten by a later, unrelated one", key, got, "first")
	}
}

// ---------------------------------------------------------------------
// 3. QUOTE STRIPPING: KEY="Token abc" and KEY='x' lose their surrounding
// quotes; a value with quotes only in the middle keeps them. A stray
// quote landing in an API key produces a baffling auth failure.
// ---------------------------------------------------------------------

func TestLoadDotEnv_QuoteStripping(t *testing.T) {
	dq := "CONFIG_TEST_QUOTE_DOUBLE"
	sq := "CONFIG_TEST_QUOTE_SINGLE"
	mid := "CONFIG_TEST_QUOTE_MIDDLE"
	for _, k := range []string{dq, sq, mid} {
		unsetEnv(t, k)
	}

	path := writeEnvFile(t,
		dq+`="Token abc"`,
		sq+`='x'`,
		mid+`=abc"mid"def`,
	)
	LoadDotEnv(path)

	if got := os.Getenv(dq); got != "Token abc" {
		t.Fatalf(`%s = %q, want "Token abc": surrounding double quotes must be stripped or a bearer token literally becomes the string "Token abc" with quote characters baked in, and every request auths with the wrong header value`, dq, got)
	}
	if got := os.Getenv(sq); got != "x" {
		t.Fatalf("%s = %q, want \"x\": surrounding single quotes must be stripped", sq, got)
	}
	if got := os.Getenv(mid); got != `abc"mid"def` {
		t.Fatalf(`%s = %q, want %q: quotes that are NOT the first+last character must be left alone — only symmetric surrounding quotes are stripped`, mid, got, `abc"mid"def`)
	}
}

// ---------------------------------------------------------------------
// 4. Lines that must be IGNORED: blank, # comments, and any line with no
// '='. A parser that trips on these would either crash on a normal .env
// file or silently swallow the real setting that follows.
// ---------------------------------------------------------------------

func TestLoadDotEnv_IgnoresBlankCommentsAndNoEquals(t *testing.T) {
	valid := "CONFIG_TEST_IGNORE_VALID"
	noEq := "CONFIG_TEST_IGNORE_NOEQ" // deliberately never appears with '=' below
	unsetEnv(t, valid)
	unsetEnv(t, noEq)

	path := writeEnvFile(t,
		"",
		"   ",
		"# a comment line",
		"   # indented comment",
		"this line has no equals sign at all",
		valid+"=ok",
	)
	LoadDotEnv(path)

	if got := os.Getenv(valid); got != "ok" {
		t.Fatalf("%s = %q, want %q: a real KEY=VALUE line after blank/comment/no-equals lines must still be parsed, not skipped or corrupted by the junk lines above it", valid, got, "ok")
	}
	if _, ok := os.LookupEnv(noEq); ok {
		t.Fatalf("a line with no '=' must never set any environment variable")
	}
}

// ---------------------------------------------------------------------
// 5. ORIGIN TRACKING: OriginOf returns the ABSOLUTE path of the file a key
// came from; "" for a key set in the real environment (not a file), and
// "" for a key that was never set at all. Those last two look identical
// through OriginOf alone — the caller must additionally check
// os.LookupEnv to tell them apart. Assert both, distinctly.
// ---------------------------------------------------------------------

func TestOriginOf_FileEnvAndUnsetAreDistinguishable(t *testing.T) {
	fileKey := "CONFIG_TEST_ORIGIN_FILE"
	envKey := "CONFIG_TEST_ORIGIN_ENV"
	unsetKey := "CONFIG_TEST_ORIGIN_UNSET" // intentionally never touched

	unsetEnv(t, fileKey)
	path := writeEnvFile(t, fileKey+"=fromfile")
	LoadDotEnv(path)

	wantAbs, err := filepath.Abs(path)
	if err != nil {
		t.Fatal(err)
	}
	if got := OriginOf(fileKey); got != wantAbs {
		t.Fatalf("OriginOf(%s) = %q, want the absolute path %q: a relative or mismatched path here is exactly the class of bug that made vault-passphrase status describe the wrong vault's file", fileKey, got, wantAbs)
	}
	if !filepath.IsAbs(OriginOf(fileKey)) {
		t.Fatalf("OriginOf(%s) = %q is not absolute", fileKey, OriginOf(fileKey))
	}

	// envKey: set directly in the real environment, never loaded from a file.
	t.Setenv(envKey, "fromenv")
	if got := OriginOf(envKey); got != "" {
		t.Fatalf("OriginOf(%s) = %q, want \"\": a key set in the real process environment did not come from any .env file", envKey, got)
	}
	if _, ok := os.LookupEnv(envKey); !ok {
		t.Fatalf("sanity check failed: %s should be set via t.Setenv", envKey)
	}

	// unsetKey: never set anywhere.
	if got := OriginOf(unsetKey); got != "" {
		t.Fatalf("OriginOf(%s) = %q, want \"\": an unset key must also report empty origin", unsetKey, got)
	}
	if _, ok := os.LookupEnv(unsetKey); ok {
		t.Fatalf("sanity check failed: %s must be unset", unsetKey)
	}

	// The critical distinction: OriginOf alone cannot tell "real env" from
	// "unset" apart (both are ""), so the caller MUST additionally consult
	// os.LookupEnv. Prove both states really do collapse to the same
	// OriginOf value, so nobody "fixes" this test by making them differ.
	if OriginOf(envKey) != OriginOf(unsetKey) {
		t.Fatalf("OriginOf(envKey)=%q and OriginOf(unsetKey)=%q, want them equal (both \"\") — the two states are only distinguishable via os.LookupEnv, per OriginOf's doc comment", OriginOf(envKey), OriginOf(unsetKey))
	}
}

// TestOriginOf_RelativeInputBecomesAbsolute exercises the actual
// absolute-ing of the path, which the test above cannot: t.TempDir()
// already returns an absolute path, so passing it straight through would
// pass even if recordOrigin's filepath.Abs call were deleted entirely. This
// test instead builds a path RELATIVE to the process's current directory
// and confirms OriginOf still reports it in absolute form — the same
// mismatch class as the vault-passphrase status bug, where a relative path
// recorded from one shell's cwd would describe the wrong file once printed
// or compared from elsewhere.
func TestOriginOf_RelativeInputBecomesAbsolute(t *testing.T) {
	key := "CONFIG_TEST_ORIGIN_RELATIVE"
	unsetEnv(t, key)

	cwd, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	absPath := writeEnvFile(t, key+"=fromfile")
	relPath, err := filepath.Rel(cwd, absPath)
	if err != nil {
		t.Fatal(err)
	}
	if filepath.IsAbs(relPath) {
		t.Fatalf("test setup failed: relPath %q is still absolute, filepath.Rel could not make it relative to cwd %q", relPath, cwd)
	}

	LoadDotEnv(relPath)

	got := OriginOf(key)
	if !filepath.IsAbs(got) {
		t.Fatalf("OriginOf(%s) = %q after loading a RELATIVE path, want an absolute path: a relative origin is meaningless once printed or compared outside the loading shell's cwd", key, got)
	}
	if got != absPath {
		t.Fatalf("OriginOf(%s) = %q, want %q (the absolute form of the relative path that was loaded)", key, got, absPath)
	}
}

// ---------------------------------------------------------------------
// 6. splitList: comma lists drop blanks and whitespace; an unset/empty var
// yields len 0 so callers can test "not configured". AllowedHosts uses
// this directly to re-arm the DNS-rebinding guard on a wildcard bind — a
// wrongly parsed empty entry is a hole in that guard.
// ---------------------------------------------------------------------

func TestSplitList(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want []string
	}{
		{"empty string yields zero entries (AllowedHosts not configured)", "", nil},
		{"single value", "example.com", []string{"example.com"}},
		{"multiple values", "a.com,b.com,c.com", []string{"a.com", "b.com", "c.com"}},
		{"blank entries between commas are dropped", "a.com,,b.com", []string{"a.com", "b.com"}},
		{"whitespace-only entries are dropped, not kept as blank hosts", "a.com, ,b.com", []string{"a.com", "b.com"}},
		{"surrounding whitespace on real entries is trimmed", " a.com , b.com ", []string{"a.com", "b.com"}},
		{"only commas and spaces yields zero entries", " , , ", nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := splitList(tc.in)
			if len(got) != len(tc.want) {
				t.Fatalf("splitList(%q) = %#v (len %d), want %#v (len %d)", tc.in, got, len(got), tc.want, len(tc.want))
			}
			for i := range got {
				if got[i] != tc.want[i] {
					t.Fatalf("splitList(%q)[%d] = %q, want %q", tc.in, i, got[i], tc.want[i])
				}
			}
		})
	}

	// The exact scenario AllowedHosts relies on: an env var that was never
	// set must parse to len 0, not a slice containing one empty string —
	// the latter would look "configured" and change the DNS-rebinding
	// guard's behavior on a wildcard bind.
	unsetKey := "CONFIG_TEST_SPLITLIST_UNSET"
	unsetEnv(t, unsetKey)
	if got := splitList(os.Getenv(unsetKey)); len(got) != 0 {
		t.Fatalf("splitList(os.Getenv(unset)) = %#v, want len 0 so callers can detect ALLOWED_HOSTS is not configured", got)
	}
}

// ---------------------------------------------------------------------
// 7. `or` vs `getDefault`: `or` treats an EMPTY string as unset (Python's
// `x or default`); `getDefault` treats an explicitly-set empty string as
// set (Python's os.environ.get(k, default)). This distinction is
// deliberate per the doc comments on both functions — pin it so nobody
// "simplifies" one into the other.
// ---------------------------------------------------------------------

func TestOr_EmptyEnvFallsBackToDefault(t *testing.T) {
	unsetKeyName := "CONFIG_TEST_OR_UNSET"
	unsetEnv(t, unsetKeyName)
	if got := or(unsetKeyName, "fallback"); got != "fallback" {
		t.Fatalf("or(unset, fallback) = %q, want %q", got, "fallback")
	}

	emptyKey := "CONFIG_TEST_OR_EMPTY"
	t.Setenv(emptyKey, "")
	if got := or(emptyKey, "fallback"); got != "fallback" {
		t.Fatalf(`or(explicitly-empty, fallback) = %q, want %q: "or" must treat an explicitly empty env var as unset (Python "x or default" semantics) — e.g. HOST="" in the environment must still fall back to "localhost", not bind to an empty host`, got, "fallback")
	}

	setKey := "CONFIG_TEST_OR_SET"
	t.Setenv(setKey, "actual-value")
	if got := or(setKey, "fallback"); got != "actual-value" {
		t.Fatalf("or(set, fallback) = %q, want %q", got, "actual-value")
	}
}

func TestGetDefault_ExplicitEmptyIsPreservedNotDefaulted(t *testing.T) {
	unsetKeyName := "CONFIG_TEST_GETDEFAULT_UNSET"
	unsetEnv(t, unsetKeyName)
	if got := getDefault(unsetKeyName, "/vault"); got != "/vault" {
		t.Fatalf("getDefault(unset, /vault) = %q, want %q", got, "/vault")
	}

	emptyKey := "CONFIG_TEST_GETDEFAULT_EMPTY"
	t.Setenv(emptyKey, "")
	if got := getDefault(emptyKey, "/vault"); got != "" {
		t.Fatalf(`getDefault(explicitly-empty, /vault) = %q, want "": unlike "or", getDefault must treat an explicitly-set empty string as a real, deliberate value (Python os.environ.get semantics) and NOT silently substitute the default`, got)
	}

	setKey := "CONFIG_TEST_GETDEFAULT_SET"
	t.Setenv(setKey, "/custom-vault")
	if got := getDefault(setKey, "/vault"); got != "/custom-vault" {
		t.Fatalf("getDefault(set, /vault) = %q, want %q", got, "/custom-vault")
	}
}

// ---------------------------------------------------------------------
// 8. Load(dir): the fields that matter most — Port default 8080, VaultMode
// true exactly when APIKey is empty, and LLMAPIKey falling back to
// GroqAPIKey. Every relevant var is explicitly unset first so this test
// does not depend on (or leak into) whatever happens to be in the
// ambient environment the suite runs under.
// ---------------------------------------------------------------------

// loadRelevantKeys lists every env var Load(dir) reads, per config.go.
var loadRelevantKeys = []string{
	"INFOBLOX_API_KEY", "INFOBLOX_URL", "PORT", "HOST", "ALLOWED_HOSTS",
	"APP_REPO", "DISABLE_UPDATE_CHECK", "DASHBOARD_TOKEN", "BLOCK_LIST_ID",
	"GROQ_API_KEY", "LLM_API_KEY", "LLM_MODEL", "LLM_BASE_URL",
	"VAULT_DIR", "VAULT_PASSPHRASE", "VAULT_PASSPHRASE_FILE", "TEMPLATES_DIR",
	"AUDIT_TRUST_DIR", "AUDIT_KEY", "AUDIT_KEY_FILE",
}

func clearLoadEnv(t *testing.T) {
	t.Helper()
	for _, k := range loadRelevantKeys {
		unsetEnv(t, k)
	}
}

func TestLoad_PortDefaultsTo8080(t *testing.T) {
	clearLoadEnv(t)
	c := Load("/tmp/dir")
	if c.Port != "8080" {
		t.Fatalf("Load().Port = %q with PORT unset, want %q: the server would bind to the wrong port, or an empty one", c.Port, "8080")
	}
}

func TestLoad_VaultModeTrueWhenAPIKeyEmpty(t *testing.T) {
	clearLoadEnv(t)
	c := Load("/tmp/dir")
	if !c.VaultMode {
		t.Fatalf("Load().VaultMode = false with INFOBLOX_API_KEY unset, want true: without an API key the server must run in vault mode, or it would try (and fail) to authenticate directly with no key at all")
	}
	if c.APIKey != "" {
		t.Fatalf("Load().APIKey = %q, want empty", c.APIKey)
	}
}

func TestLoad_VaultModeFalseWhenAPIKeySet(t *testing.T) {
	clearLoadEnv(t)
	t.Setenv("INFOBLOX_API_KEY", "real-api-key")
	c := Load("/tmp/dir")
	if c.VaultMode {
		t.Fatalf("Load().VaultMode = true with INFOBLOX_API_KEY set, want false: an operator who explicitly configured a direct API key would be forced into vault mode anyway, ignoring their key")
	}
	if c.APIKey != "real-api-key" {
		t.Fatalf("Load().APIKey = %q, want %q", c.APIKey, "real-api-key")
	}
}

func TestLoad_LLMAPIKeyFallsBackToGroqAPIKey(t *testing.T) {
	clearLoadEnv(t)
	t.Setenv("GROQ_API_KEY", "groq-key")
	c := Load("/tmp/dir")
	if c.LLMAPIKey != "groq-key" {
		t.Fatalf("Load().LLMAPIKey = %q with only GROQ_API_KEY set, want %q: the fallback that lets an operator configure just GROQ_API_KEY must actually work, or every AI query fails with no key", c.LLMAPIKey, "groq-key")
	}

	// LLM_API_KEY, when set, must take priority over GROQ_API_KEY.
	t.Setenv("LLM_API_KEY", "explicit-llm-key")
	c2 := Load("/tmp/dir")
	if c2.LLMAPIKey != "explicit-llm-key" {
		t.Fatalf("Load().LLMAPIKey = %q with both LLM_API_KEY and GROQ_API_KEY set, want the explicit LLM_API_KEY (%q) to win", c2.LLMAPIKey, "explicit-llm-key")
	}
}

func TestLoad_AllowedHostsEmptyWhenUnconfigured(t *testing.T) {
	clearLoadEnv(t)
	c := Load("/tmp/dir")
	if len(c.AllowedHosts) != 0 {
		t.Fatalf("Load().AllowedHosts = %#v with ALLOWED_HOSTS unset, want empty: a non-empty default here would silently widen the DNS-rebinding guard's trusted Host list", c.AllowedHosts)
	}
}
