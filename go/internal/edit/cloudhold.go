package edit

import (
	"fmt"
	"net/netip"

	"bloxsmith/internal/rest"
)

// Each public cloud keeps a few addresses of every network for itself. The
// network job's "This network is for" choice holds those back in Infoblox as
// address reservations, so nobody hands one out to a device by mistake.
//
// The addresses are counted from the network's first address, never a literal
// .1: 10.0.0.32/28 on AWS keeps .33, .34 and .35. Network and broadcast are
// never handed out anyway, so they are not held.

// Held is one address a cloud keeps, with the words a person sees beside it.
type Held struct {
	Address string `json:"address"`
	Label   string `json:"label"`
}

var cloudNames = map[string]string{"aws": "AWS", "azure": "Azure", "gcp": "Google Cloud"}

// CloudSizeCheck is the plain reason a cloud refuses this network size, or "".
// AWS allows /16 to /28; Azure and Google Cloud go down to /29.
func CloudSizeCheck(cloud string, cidr int) string {
	switch cloud {
	case "", "none":
		return ""
	case "aws":
		if cidr > 28 {
			return "AWS does not allow a network smaller than /28 (16 addresses). Pick a bigger size."
		}
	case "azure", "gcp":
		if cidr > 29 {
			return cloudNames[cloud] + " does not allow a network smaller than /29 (8 addresses). Pick a bigger size."
		}
	default:
		return "Pick None, AWS, Azure or Google Cloud."
	}
	return ""
}

// CloudHeld lists the addresses cloud keeps in the IPv4 network p. Empty for
// None, an unknown cloud, IPv6, or a network too small to hold them.
func CloudHeld(cloud string, p netip.Prefix) []Held {
	if !p.Addr().Is4() || p.Bits() > 29 {
		return nil
	}
	p = p.Masked()
	b := p.Addr().As4()
	first := uint32(b[0])<<24 | uint32(b[1])<<16 | uint32(b[2])<<8 | uint32(b[3])
	last := first | (uint32(1)<<(32-p.Bits()) - 1)
	at := func(v uint32, why string) Held {
		a := netip.AddrFrom4([4]byte{byte(v >> 24), byte(v >> 16), byte(v >> 8), byte(v)})
		return Held{Address: a.String(), Label: "Kept by " + cloudNames[cloud] + ": " + why}
	}
	switch cloud {
	case "aws":
		return []Held{at(first+1, "router"), at(first+2, "DNS"), at(first+3, "future use")}
	case "azure":
		return []Held{at(first+1, "gateway"), at(first+2, "DNS"), at(first+3, "DNS")}
	case "gcp":
		return []Held{at(first+1, "gateway"), at(last-1, "reserved by Google")}
	}
	return nil
}

// holdCloudAddresses reserves each address cloud keeps in the network Build
// just made. held carries the ID of every reservation made, so Remove can
// delete it; notHeld names each one that was refused or whose answer could not
// be read. Nothing is retried or rolled back: the network stays either way.
//
// POST /api/ddi/v1/ipam/address with address, space and comment is the
// Infoblox call for one address (Ipamsvc AddressCreate). The label goes in the
// comment, which is free text; names is left out because whether a name may
// hold spaces could not be checked without writing to a tenant.
func (c *Client) holdCloudAddresses(cloud string, made netip.Prefix, space string) (held, notHeld []any) {
	held, notHeld = []any{}, []any{}
	for _, h := range CloudHeld(cloud, made) {
		body := M{"address": h.Address, "space": space, "comment": h.Label, "tags": withMadeTag(nil)}
		resp, status, _ := c.Rest.Write("POST", "/api/ddi/v1/ipam/address", body, nil)
		id := pyStr(asMap(resultOrSelf(resp))["id"])
		switch {
		case (status == 200 || status == 201) && id != "":
			held = append(held, M{"id": id, "address": h.Address, "label": h.Label})
		case rest.UnclearFailure(status):
			notHeld = append(notHeld, M{"address": h.Address, "label": h.Label,
				"reason": "Infoblox did not say whether it was held, so check it by hand"})
		default:
			notHeld = append(notHeld, M{"address": h.Address, "label": h.Label,
				"reason": fmt.Sprintf("Infoblox refused it (%s)", statusPhrase(status))})
		}
	}
	return held, notHeld
}
