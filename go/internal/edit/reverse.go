package edit

import (
	"errors"
	"fmt"
	"net/netip"
	"strings"

	"bloxsmith/internal/rest"
)

// Infoblox makes the reverse (PTR) record a preview asks for (create_ptr with
// check_rmz) only when a reverse zone in the record's DNS view covers the
// address. The preview looks that up first, so the operator hears it before
// pressing Create rather than finding the PTR missing later.

// reverseNames lists the reverse zone names that could hold addr's PTR, most
// specific first: 5.16.172.in-addr.arpa., 16.172.in-addr.arpa., then
// 172.in-addr.arpa. for 172.16.5.9; every nibble boundary for IPv6. The
// address's own name is left out, as the Proxmox plugin's walk does
// (InfobloxPlugin.pm get_reversedns_zone).
func reverseNames(addr netip.Addr) []string {
	addr = addr.Unmap()
	if addr.Is4() {
		b := addr.As4()
		return []string{
			fmt.Sprintf("%d.%d.%d.in-addr.arpa.", b[2], b[1], b[0]),
			fmt.Sprintf("%d.%d.in-addr.arpa.", b[1], b[0]),
			fmt.Sprintf("%d.in-addr.arpa.", b[0]),
		}
	}
	hex := fmt.Sprintf("%x", addr.As16())
	out := make([]string, 0, len(hex)-1)
	for k := len(hex) - 1; k >= 1; k-- {
		nibbles := make([]string, k)
		for i := range k {
			nibbles[i] = hex[k-1-i : k-i]
		}
		out = append(out, strings.Join(nibbles, ".")+".ip6.arpa.")
	}
	return out
}

// reverseZone reports the reverse zone in view that would hold the PTR record
// for addr, or "" when none does. All the parent names are asked in one read.
func (c *Client) reverseZone(view string, addr netip.Addr) (string, error) {
	v, err := rest.CSPQ(view)
	if err != nil {
		return "", err
	}
	names := reverseNames(addr)
	ors := make([]string, len(names))
	for i, n := range names {
		ors[i] = fmt.Sprintf(`fqdn=="%s"`, n)
	}
	rows, err := c.Rest.GetStrict("/api/ddi/v1/dns/auth_zone", map[string]string{
		"_filter": fmt.Sprintf(`view=="%s" and (%s)`, v, strings.Join(ors, " or ")),
		"_fields": "fqdn",
	})
	if err != nil {
		return "", err
	}
	have := map[string]bool{}
	for _, r := range rows {
		have[strings.TrimSuffix(pyStr(asMap(r)["fqdn"]), ".")] = true
	}
	for _, n := range names {
		if have[strings.TrimSuffix(n, ".")] {
			return n, nil
		}
	}
	return "", nil
}

// zoneView is the DNS view a forward zone belongs to.
func (c *Client) zoneView(zoneID string) (string, error) {
	path, err := ObjectPath("dns/auth_zone", zoneID)
	if err != nil {
		return "", err
	}
	body, status, err := c.Rest.GetEx(path, map[string]string{"_fields": "view"})
	if err != nil {
		return "", err
	}
	view := pyStr(asMap(asMap(body)["result"])["view"])
	if status != 200 || view == "" {
		return "", errors.New("zone view unavailable")
	}
	return view, nil
}

// ptrNote is what a preview says about the reverse (PTR) record it would ask
// for: "" when a reverse zone covers address, else one plain sentence.
func (c *Client) ptrNote(zoneID, address string) string {
	ip, err := netip.ParseAddr(strings.TrimSpace(address))
	if err != nil {
		return ""
	}
	view, err := c.zoneView(zoneID)
	zone := ""
	if err == nil {
		zone, err = c.reverseZone(view, ip)
	}
	switch {
	case err != nil:
		return fmt.Sprintf("Could not check whether a reverse zone covers %s, so the reverse (PTR) record may not be made.", ip)
	case zone == "":
		return fmt.Sprintf("No reverse zone covers %s, so no reverse (PTR) record will be made.", ip)
	}
	return ""
}

// addPTRNote puts ptrNote on a preview reply when dns asks for a PTR.
func (c *Client) addPTRNote(out M, dns M, address string) {
	rtype := strings.ToUpper(pyStrOr(dns, "type", "A"))
	if dns == nil || !truthy(dns["create_ptr"], false) || (rtype != "A" && rtype != "AAAA") {
		return
	}
	if v := strings.TrimSpace(pyStr(dns["value"])); v != "" {
		address = v
	}
	if note := c.ptrNote(pyStr(dns["zone_id"]), address); note != "" {
		out["reverse_note"] = note
	}
}
