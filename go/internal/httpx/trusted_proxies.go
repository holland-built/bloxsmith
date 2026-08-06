package httpx

// TRUSTED PROXIES: RECOVERING THE REAL CLIENT ADDRESS, AND ONLY WHERE IT IS SAFE.
//
// THE DEFECT. The unlock throttle (unlock_throttle.go) keys its per-client
// failure counter on the peer address, and deliberately ignores X-Forwarded-For
// because that header is attacker-controlled. That is the right default, and it
// stays the default. But it has a consequence the original change recorded only
// as a NAT inconvenience, and it is worse than that:
//
//	BEHIND A REVERSE PROXY, EVERY REQUEST ARRIVES FROM ONE ADDRESS.
//
// docs/DEPLOYMENT.md documents exactly that deployment — the `secure` compose
// profile puts Caddy in front and binds the app to 127.0.0.1 — so it is not a
// hypothetical. There the per-client map degenerates into a SINGLE GLOBAL
// BUCKET: the proxy is the only client the server ever sees. Six wrong guesses
// from anyone reachable through that proxy push that one bucket to the 30-second
// ceiling, and every legitimate operator is refused with it. A control added to
// stop guessing had turned into a lever anybody could pull to deny the operator
// their own vault, which is a worse bug than the one it fixed.
//
// WHY THIS IS OPT-IN AND EMPTY BY DEFAULT. A server cannot detect that it is
// behind a proxy. It can only be TOLD, and the telling has to be out of band —
// by the operator, in config — because anything in the request itself is written
// by whoever sent the request. With TRUSTED_PROXIES unset this file resolves to
// hostOf(RemoteAddr) and changes nothing: no deployment's behaviour moves by
// upgrading, and the LAN deployment the throttle was built for keeps the peer
// address, which there IS the client.
//
// WHY THE CHAIN IS WALKED FROM THE RIGHT. X-Forwarded-For is append-only and
// ordered client-first:
//
//	X-Forwarded-For: <client>, <proxy-1>, <proxy-2>
//
// Each hop appends the address IT saw. So the LEFTMOST entry is the one nobody
// verified — it is whatever the original sender typed, and taking it is the
// classic form of this bug: an attacker sends `X-Forwarded-For: 1.2.3.4`, the
// proxy dutifully appends the attacker's real address to the right of it, and a
// server reading the left end gets a value the attacker chose. A fresh one per
// request resets the lockout at will, and the throttle keeps running, keeps
// counting, and is worth nothing.
//
// Read from the RIGHT instead and every entry is one a hop we trust actually
// observed. Skip entries that are themselves trusted proxies (a chain of two
// proxies appends two) and the first untrusted address is the last one that was
// written by something we trust — the client, as seen by our own edge. An
// attacker can still pad the left end with fake entries, including entries that
// look like trusted proxies; that is why the scan STOPS at the first untrusted
// address rather than continuing past it. Everything the attacker wrote sits to
// the left of the address our proxy appended, and is never reached.
//
// AND THE PEER MUST BE TRUSTED FIRST. If RemoteAddr is not in the set, the
// header is ignored outright, no exceptions — an attacker who can reach the app
// port directly (a LAN peer, a container on the same bridge network) would
// otherwise bypass the whole scheme by sending their own X-Forwarded-For.
//
// WHAT THIS DELIBERATELY DOES NOT TOUCH: isLoopback AND THE AUDIT ACTOR.
// Both also derive from the peer via hostOf, and both keep using the peer. The
// asymmetry is in what a wrong answer costs:
//
//   - The throttle's key selects a RATE-LIMIT BUCKET. Resolve it wrongly and
//     someone is refused for at most 30 seconds, or shares a bucket they should
//     not. No credential is issued, nothing is authorized, nothing is written.
//
//   - isLoopback feeds SameOrigin/WriteOK/ResolveRole. In a tokenless
//     deployment, "this peer is loopback" IS the authorization decision — it
//     grants writes and the admin role. That decision is currently backed by a
//     KERNEL FACT: the connection genuinely came from this machine. An address
//     recovered from a header is a CLAIM, sound only as far as the proxy
//     configuration is, and a single copied-from-a-blog-post `0.0.0.0/0` in
//     TRUSTED_PROXIES would turn `X-Forwarded-For: 127.0.0.1` into a remote
//     admin bypass. Trading a fact for a claim is a downgrade in kind, not in
//     degree, so the loopback check is left alone on purpose.
//
//   - The audit actor labels an entry in a tamper-evident chain. Its job is to
//     record what this process OBSERVED, not what it was told; writing a
//     header-derived address there would faithfully seal an attacker's string
//     into the log, and a reader could no longer tell whether an actor was the
//     peer or a claim. (Recording both — peer plus forwarded-for — is a
//     defensible future change. Silently swapping one for the other is not.)
//
// SCOPE. X-Forwarded-For only. RFC 7239 `Forwarded:` is not read: nothing in
// this deployment's documented front ends (Caddy, nginx, most cloud LBs) sends
// it by default, and a second syntax is a second place to get this wrong.

import (
	"fmt"
	"net/http"
	"net/netip"
	"strings"
)

// TrustedProxies is a parsed TRUSTED_PROXIES list: the addresses and ranges
// whose X-Forwarded-For this process will believe. The nil pointer and the empty
// set are both valid and both mean "trust nothing", which is the default.
type TrustedProxies struct {
	nets []netip.Prefix
}

// ParseTrustedProxies turns the TRUSTED_PROXIES entries into a set, and returns
// a warning describing anything that did not parse.
//
// The warning is a return value rather than a log call because THE SILENT
// FAILURE IS THE ONE THAT MATTERS. A typo'd entry drops the whole scheme back to
// the peer address, which behind a proxy is the single shared bucket described
// at the top of this file — the deployment looks configured, the operator
// believes clients are separated, and the first symptom is everyone being locked
// out at once. A caller that discards this string reintroduces exactly that.
func ParseTrustedProxies(entries []string) (*TrustedProxies, string) {
	p := &TrustedProxies{}
	var bad []string
	for _, e := range entries {
		e = strings.TrimSpace(e)
		if e == "" {
			continue
		}
		n, err := parseAddrOrPrefix(e)
		if err != nil {
			bad = append(bad, e)
			continue
		}
		p.nets = append(p.nets, n)
	}
	if len(bad) == 0 {
		return p, ""
	}
	msg := fmt.Sprintf("TRUSTED_PROXIES: these entries did not parse and are ignored: %s. "+
		"Each entry must be a bare IP (10.0.0.5, ::1) or a CIDR range (10.0.0.0/8, fd00::/8) "+
		"— no ports, no hostnames, no schemes.", strings.Join(bad, ", "))
	if len(p.nets) == 0 {
		msg += " NOTHING is trusted as a result, so X-Forwarded-For is ignored entirely and " +
			"the unlock throttle is keying on the peer address. Behind a reverse proxy that " +
			"is one shared bucket for every client, and a handful of wrong guesses locks out " +
			"everybody."
	}
	return p, msg
}

// parseAddrOrPrefix accepts either form an operator would reasonably write. A
// bare address becomes a host-length prefix so matching has one code path.
func parseAddrOrPrefix(s string) (netip.Prefix, error) {
	if strings.Contains(s, "/") {
		n, err := netip.ParsePrefix(s)
		if err != nil {
			return netip.Prefix{}, err
		}
		// Masked so 10.1.2.3/8 is stored (and logged) as 10.0.0.0/8 rather than
		// echoing back a value whose host bits imply it matches only itself.
		return n.Masked(), nil
	}
	// A bracketed IPv6 literal is what an operator copies out of a URL or a
	// Host header; accept it rather than rejecting a value that is obviously
	// meant. Unmap so ::ffff:10.0.0.1 and 10.0.0.1 are the same entry.
	a, err := netip.ParseAddr(strings.Trim(s, "[]"))
	if err != nil {
		return netip.Prefix{}, err
	}
	a = a.Unmap()
	return netip.PrefixFrom(a, a.BitLen()), nil
}

// Empty reports that nothing is trusted — the default, and the state in which
// this file changes no behaviour at all.
func (p *TrustedProxies) Empty() bool { return p == nil || len(p.nets) == 0 }

// String renders the parsed set for the startup log, so an operator can read
// back what the process actually believes instead of what they meant to type.
func (p *TrustedProxies) String() string {
	if p.Empty() {
		return "(none)"
	}
	out := make([]string, 0, len(p.nets))
	for _, n := range p.nets {
		out = append(out, n.String())
	}
	return strings.Join(out, ", ")
}

// trusts reports whether an address is one of the configured proxies.
func (p *TrustedProxies) trusts(a netip.Addr) bool {
	if p.Empty() || !a.IsValid() {
		return false
	}
	a = a.Unmap()
	for _, n := range p.nets {
		if n.Contains(a) {
			return true
		}
	}
	return false
}

// ClientIP resolves the address the unlock throttle keys on: the peer, unless
// the peer is a trusted proxy and X-Forwarded-For names someone behind it.
//
// The result is a bare host in the same shape hostOf produces ("192.0.2.7",
// "2001:db8::1" — no port, no brackets), because it becomes a map key beside
// keys that came straight from hostOf. Two spellings of one client would be two
// buckets, which is the failure this whole file exists to remove.
//
// EVERY FAILURE PATH RETURNS THE PEER. Unparseable peer, untrusted peer, absent
// header, malformed entry, a chain of nothing but trusted proxies: each falls
// back to the address the kernel reported. Never to a guess, and never to an
// entry that has not passed the checks above — a wrong-but-plausible client
// address is how this control gets quietly disarmed.
func (p *TrustedProxies) ClientIP(r *http.Request) string {
	peer := hostOf(r.RemoteAddr)
	if p.Empty() {
		return peer
	}
	peerAddr, err := netip.ParseAddr(peer)
	if err != nil || !p.trusts(peerAddr) {
		// Not our proxy talking. Whatever X-Forwarded-For it sent is the
		// sender's own invention and is not read at all.
		return peer
	}
	chain := forwardedChain(r)
	for i := len(chain) - 1; i >= 0; i-- {
		a, err := parseForwardedEntry(chain[i])
		if err != nil {
			// Garbage where a trusted hop should have written an address. The
			// chain cannot be reasoned about past this point, and guessing at
			// the next entry along would be trusting something no hop we trust
			// is known to have written.
			return peer
		}
		if p.trusts(a) {
			continue // another one of our own hops; keep walking left
		}
		return a.String()
	}
	// Header absent, or every entry in it is a trusted proxy. The latter happens
	// with a health checker or a proxy calling a proxy; either way no client
	// address was found, so the peer stands.
	return peer
}

// forwardedChain flattens X-Forwarded-For into one client-first list.
//
// Repeated header lines are concatenated in order, which is what RFC 9110 says a
// comma-separated list field means. It matters here: an attacker sends their own
// X-Forwarded-For line and Go keeps it as a SEPARATE value rather than merging
// it, so reading only the first — or only the last — value would read the wrong
// list. Flattening in order puts the entry our own proxy appended last, where
// the right-to-left walk starts.
func forwardedChain(r *http.Request) []string {
	var out []string
	for _, v := range r.Header.Values("X-Forwarded-For") {
		for _, part := range strings.Split(v, ",") {
			if part = strings.TrimSpace(part); part != "" {
				out = append(out, part)
			}
		}
	}
	return out
}

// parseForwardedEntry reads one X-Forwarded-For element as an address.
//
// The bare address is the standard, but a port is accepted because real front
// ends emit one — Azure's load balancer writes "1.2.3.4:5678", and a bracketed
// "[2001:db8::1]:443" is the IPv6 form of the same thing. Those are a documented
// variant, not corruption, and rejecting them would drop a correctly-configured
// deployment back to the single shared bucket for a formatting difference.
func parseForwardedEntry(s string) (netip.Addr, error) {
	if a, err := netip.ParseAddr(strings.Trim(s, "[]")); err == nil {
		return a.Unmap(), nil
	}
	ap, err := netip.ParseAddrPort(s)
	if err != nil {
		return netip.Addr{}, fmt.Errorf("not an address: %q", s)
	}
	return ap.Addr().Unmap(), nil
}
