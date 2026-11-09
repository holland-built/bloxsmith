package dashboard

import (
	"strings"

	"golang.org/x/net/publicsuffix"
)

// publicName reports whether a zone's name ends in a real, ICANN-run top-level
// domain such as .com or .co.uk, so it could be visible on the internet. Reverse
// zones (.arpa) and private names such as .local, .lab or .internal are not.
//
// Only zones the internet can see need DNSSEC; signing internal zones is
// rarely worth it (owner, 2026-11-09). The name alone cannot prove a zone is
// published, since a .com zone may be an internal split-horizon copy, so the
// wording elsewhere says "public names", not "external zones".
func publicName(fqdn string) bool {
	name := strings.ToLower(strings.TrimSuffix(strings.TrimSpace(fqdn), "."))
	if name == "" || name == "arpa" || strings.HasSuffix(name, ".arpa") {
		return false
	}
	suffix, icann := publicsuffix.PublicSuffix(name)
	return icann && suffix != name
}
