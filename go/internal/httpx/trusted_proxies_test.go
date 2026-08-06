package httpx

import (
	"strings"
	"testing"
)

// What these tests defend: WHICH ADDRESS the unlock throttle counts against.
// Get it wrong in one direction and an attacker picks a fresh bucket per guess,
// so the counter measures nothing; get it wrong in the other and every client
// behind a reverse proxy shares one bucket, so a handful of wrong guesses locks
// out the whole deployment. Both are silent — the server answers normally
// either way — which is why every case below is spelled out rather than left to
// the resolution rules "obviously" holding.

// mustProxies parses entries a test asserts are valid, and fails loudly if the
// parser disagrees. A test that silently trusted nothing would pass the
// header-ignored assertions for entirely the wrong reason.
func mustProxies(t *testing.T, entries ...string) *TrustedProxies {
	t.Helper()
	p, warn := ParseTrustedProxies(entries)
	if warn != "" {
		t.Fatalf("ParseTrustedProxies(%v) warned %q, want a clean parse", entries, warn)
	}
	if p.Empty() {
		t.Fatalf("ParseTrustedProxies(%v) trusts nothing", entries)
	}
	return p
}

// --- the resolution rules ----------------------------------------------------

func TestClientIP(t *testing.T) {
	cases := []struct {
		name    string
		trusted []string
		peer    string
		xff     []string // one entry per X-Forwarded-For header line
		want    string
		why     string
	}{
		{
			name: "no proxies configured, header present",
			peer: "203.0.113.5:41000",
			xff:  []string{"1.2.3.4"},
			want: "203.0.113.5",
			why: "the default must ignore X-Forwarded-For completely — believing it unasked lets " +
				"any caller choose their own rate-limit bucket",
		},
		{
			name:    "trusted peer, single client",
			trusted: []string{"10.0.0.7"},
			peer:    "10.0.0.7:44321",
			xff:     []string{"198.51.100.4"},
			want:    "198.51.100.4",
			why:     "this is the case the setting exists for: the client behind our own proxy",
		},
		{
			name:    "trusted peer, two proxy hops appended",
			trusted: []string{"10.0.0.0/24"},
			peer:    "10.0.0.7:44321",
			xff:     []string{"198.51.100.4, 10.0.0.9, 10.0.0.3"},
			want:    "198.51.100.4",
			why: "trusted hops are skipped from the right; stopping at the first entry would " +
				"key on our own proxy and rebuild the single shared bucket",
		},
		{
			name:    "attacker prepends a fake client",
			trusted: []string{"10.0.0.7"},
			peer:    "10.0.0.7:44321",
			xff:     []string{"1.2.3.4, 198.51.100.4"},
			want:    "198.51.100.4",
			why: "the LEFT end is whatever the sender typed. Reading it is the classic form of " +
				"this bug — a fresh value per request resets the lockout at will",
		},
		{
			name:    "attacker prepends fake TRUSTED-looking hops",
			trusted: []string{"10.0.0.0/24"},
			peer:    "10.0.0.7:44321",
			xff:     []string{"1.2.3.4, 10.0.0.99, 198.51.100.4"},
			want:    "198.51.100.4",
			why: "the walk must STOP at the first untrusted address, not keep skipping past it. " +
				"Continuing would let an attacker pad the chain with trusted-looking entries " +
				"until the scan reached the address they chose",
		},
		{
			name:    "untrusted peer sending a header",
			trusted: []string{"10.0.0.7"},
			peer:    "203.0.113.50:9000",
			xff:     []string{"198.51.100.4"},
			want:    "203.0.113.50",
			why: "anyone who can reach the app port directly could otherwise walk around the " +
				"whole scheme by writing their own header",
		},
		{
			name:    "separate header lines are one chain, in order",
			trusted: []string{"10.0.0.7"},
			peer:    "10.0.0.7:44321",
			xff:     []string{"1.2.3.4", "198.51.100.4"},
			want:    "198.51.100.4",
			why: "Go keeps repeated header lines separate. Reading only the first would read " +
				"the attacker's line and ignore the one our proxy appended",
		},
		{
			name:    "malformed entry where the client should be",
			trusted: []string{"10.0.0.7"},
			peer:    "10.0.0.7:44321",
			xff:     []string{"198.51.100.4, not-an-address"},
			want:    "10.0.0.7",
			why: "garbage from a hop we trust means the chain cannot be reasoned about; falling " +
				"back to the peer is the only answer that is not a guess",
		},
		{
			name:    "empty header",
			trusted: []string{"10.0.0.7"},
			peer:    "10.0.0.7:44321",
			want:    "10.0.0.7",
			why:     "a trusted proxy that sends no chain (or a direct health probe) leaves the peer",
		},
		{
			name:    "chain is nothing but trusted proxies",
			trusted: []string{"10.0.0.0/24"},
			peer:    "10.0.0.7:44321",
			xff:     []string{"10.0.0.9, 10.0.0.3"},
			want:    "10.0.0.7",
			why:     "no client address was found, so nothing may be invented in its place",
		},
		{
			name:    "CIDR range matches the peer",
			trusted: []string{"172.18.0.0/16"},
			peer:    "172.18.4.9:33000",
			xff:     []string{"198.51.100.4"},
			want:    "198.51.100.4",
			why:     "a docker bridge network is a range, not a fixed address — CIDR has to work",
		},
		{
			name:    "CIDR range does not match the peer",
			trusted: []string{"172.18.0.0/16"},
			peer:    "172.19.4.9:33000",
			xff:     []string{"198.51.100.4"},
			want:    "172.19.4.9",
			why:     "one octet outside the range is outside the range",
		},
		{
			name:    "IPv6 peer and IPv6 client",
			trusted: []string{"fd00::/8"},
			peer:    "[fd00::7]:44321",
			xff:     []string{"2001:db8::42"},
			want:    "2001:db8::42",
			why: "the key must come back bare and unbracketed, the same shape hostOf produces, " +
				"or one client would occupy two buckets",
		},
		{
			name:    "IPv6 loopback as an explicit entry",
			trusted: []string{"::1"},
			peer:    "[::1]:44321",
			xff:     []string{"2001:db8::42"},
			want:    "2001:db8::42",
			why:     "the secure compose profile puts Caddy on loopback in front of the app",
		},
		{
			name:    "forwarded entry carrying a port",
			trusted: []string{"10.0.0.7"},
			peer:    "10.0.0.7:44321",
			xff:     []string{"198.51.100.4:51514"},
			want:    "198.51.100.4",
			why: "Azure's load balancer writes the port. Rejecting the whole chain over it would " +
				"drop a correctly configured deployment back to one shared bucket",
		},
		{
			name:    "bracketed IPv6 entry carrying a port",
			trusted: []string{"10.0.0.7"},
			peer:    "10.0.0.7:44321",
			xff:     []string{"[2001:db8::42]:51514"},
			want:    "2001:db8::42",
			why:     "same variant, IPv6 spelling",
		},
		{
			name:    "IPv4-mapped IPv6 client is the same client as its IPv4 form",
			trusted: []string{"10.0.0.7"},
			peer:    "10.0.0.7:44321",
			xff:     []string{"::ffff:198.51.100.4"},
			want:    "198.51.100.4",
			why:     "two spellings of one address must not be two buckets",
		},
		{
			name:    "loopback spoof through a trusted proxy",
			trusted: []string{"10.0.0.7"},
			peer:    "10.0.0.7:44321",
			xff:     []string{"127.0.0.1, 198.51.100.4"},
			want:    "198.51.100.4",
			why: "an attacker naming loopback gets no further than any other lie — and this key " +
				"never reaches isLoopback anyway, which is the point of keeping them separate",
		},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			p, _ := ParseTrustedProxies(c.trusted)
			if len(c.trusted) > 0 && p.Empty() {
				t.Fatalf("test setup: %v parsed to nothing", c.trusted)
			}
			got := p.ClientIP(fwdReq(c.peer, c.xff...))
			if got != c.want {
				t.Fatalf("ClientIP(peer=%s, XFF=%v) = %q, want %q — %s", c.peer, c.xff, got, c.want, c.why)
			}
		})
	}
}

// The nil set is what NewUnlockThrottle leaves in place, so it must be safe to
// call methods on and must behave exactly like an unconfigured one. A panic
// here would take down every unlock request on a default deployment.
func TestTrustedProxies_NilIsSafeAndTrustsNothing(t *testing.T) {
	var p *TrustedProxies
	if !p.Empty() {
		t.Fatalf("nil TrustedProxies is not Empty()")
	}
	if got := p.ClientIP(fwdReq("203.0.113.5:41000", "1.2.3.4")); got != "203.0.113.5" {
		t.Fatalf("nil TrustedProxies resolved %q, want the peer 203.0.113.5", got)
	}
	if got := p.String(); got != "(none)" {
		t.Fatalf("nil TrustedProxies prints %q, want %q so the startup log is readable", got, "(none)")
	}
}

// --- parsing and its warnings -------------------------------------------------

func TestParseTrustedProxies_Accepts(t *testing.T) {
	p := mustProxies(t, "10.0.0.7", "172.18.0.0/16", "::1", "fd00::/8", "[2001:db8::1]")
	if n := len(p.nets); n != 5 {
		t.Fatalf("parsed %d of 5 entries: %s", n, p)
	}
	// Host bits are masked off so the log echoes a range the operator can check
	// against their own network, not a value whose host bits imply otherwise.
	q := mustProxies(t, "10.1.2.3/8")
	if got := q.String(); got != "10.0.0.0/8" {
		t.Fatalf("10.1.2.3/8 stored as %q, want 10.0.0.0/8", got)
	}
}

// The failure this warning exists for: the operator believes the deployment is
// proxy-aware, and it is not. Nothing else in the running server would ever say
// so — requests are answered normally, and the symptom arrives later as every
// user being locked out at once by somebody else's wrong guesses.
func TestParseTrustedProxies_WarnsWhenNothingUsableParsed(t *testing.T) {
	p, warn := ParseTrustedProxies([]string{"10.0.0/8", "proxy.internal"})
	if !p.Empty() {
		t.Fatalf("unparseable entries produced a non-empty set: %s", p)
	}
	if warn == "" {
		t.Fatalf("no warning for a TRUSTED_PROXIES that parses to nothing — a typo would silently revert to the peer address and one shared bucket")
	}
	for _, want := range []string{"10.0.0/8", "proxy.internal"} {
		if !strings.Contains(warn, want) {
			t.Errorf("warning does not name %q, so an operator cannot tell which entry to fix: %q", want, warn)
		}
	}
	if !strings.Contains(warn, "NOTHING is trusted") {
		t.Errorf("warning does not say that the whole setting is inert: %q", warn)
	}
}

// A partly-wrong list is the more dangerous shape, because it half works: the
// entries that parsed are in force, and the deployment looks fine until traffic
// arrives through the proxy whose entry was the typo'd one.
func TestParseTrustedProxies_WarnsButKeepsTheGoodEntries(t *testing.T) {
	p, warn := ParseTrustedProxies([]string{"10.0.0.7", "not-an-address"})
	if p.Empty() {
		t.Fatalf("one bad entry threw away the good one — the operator's working proxy stops being trusted because of an unrelated typo")
	}
	if !strings.Contains(warn, "not-an-address") {
		t.Fatalf("warning does not name the bad entry: %q", warn)
	}
	if strings.Contains(warn, "NOTHING is trusted") {
		t.Fatalf("warning claims nothing is trusted while %s is: %q", p, warn)
	}
	if got := p.ClientIP(fwdReq("10.0.0.7:1", "198.51.100.4")); got != "198.51.100.4" {
		t.Fatalf("ClientIP = %q, want 198.51.100.4 — the entry that parsed is not in force", got)
	}
}

// Unset and blank must be silent. A warning on the default configuration is a
// warning every operator learns to ignore, which is how the real one above gets
// missed.
func TestParseTrustedProxies_SilentWhenUnconfigured(t *testing.T) {
	for _, entries := range [][]string{nil, {}, {"", "  "}} {
		p, warn := ParseTrustedProxies(entries)
		if !p.Empty() {
			t.Errorf("ParseTrustedProxies(%#v) trusts %s, want nothing", entries, p)
		}
		if warn != "" {
			t.Errorf("ParseTrustedProxies(%#v) warned %q, want silence on the default", entries, warn)
		}
	}
}
