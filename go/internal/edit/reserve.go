package edit

import (
	"fmt"
	"net"
	"net/netip"
	"strings"

	"bloxsmith/internal/rest"
)

// reserveForDevice is Get an address's "Reserve for a device" choice: one
// address locked to one MAC address as a DHCP fixed address.
//
// It does NOT go through POST nextavailableip the way a plain allocation does.
// The fixed address is itself what holds the address, so the flow is: read the
// next free address (or take the one the preview showed), then create the fixed
// address on it. If that create is refused, nothing was made and there is
// nothing to roll back; a plain allocation's compensating release has no
// counterpart here. If the create's outcome is unknown, the reservation may
// exist and the result says so rather than retrying.
//
// The preview checks that the MAC has no reservation yet, and the live path
// checks again, so a preview never promises what the live path will refuse.
//
// An optional DNS record comes AFTER the reservation. If it fails, the
// reservation stays (the device still gets its address) and the result says
// the record was not made; nothing is released.
func (c *Client) reserveForDevice(objPath, subnetID, name string, dns, dhcp M, dry bool) (M, int) {
	hw, err := net.ParseMAC(strings.TrimSpace(pyStr(dhcp["mac"])))
	if err != nil || len(hw) != 6 {
		return M{"ok": false, "error": "the MAC address must look like aa:bb:cc:dd:ee:ff"}, 400
	}
	mac := hw.String()
	devName := strings.TrimSpace(pyStr(dhcp["name"]))
	if devName == "" {
		devName = name
	}
	if err := validateRecord(dns); err != nil {
		return M{"ok": false, "error": fmt.Sprintf("invalid dns payload: %s", err.Error())}, 400
	}

	space, prefix, msg, status := c.subnetSpace(objPath)
	if status != 0 {
		return M{"ok": false, "error": msg}, status
	}

	existing, err := c.Rest.GetStrict("/api/ddi/v1/dhcp/fixed_address",
		map[string]string{"_filter": fmt.Sprintf(`match_type=="mac" and match_value=="%s"`, mac)})
	if err != nil {
		return M{"ok": false, "error": "could not check for an existing reservation: " + publicErr(err)}, 502
	}
	if len(existing) > 0 {
		e := asMap(existing[0])
		return M{"ok": false, "error": fmt.Sprintf("%s already has a reservation: %s (%s). Use that one, or remove it first",
			mac, pyStr(e["address"]), pyStr(e["name"]))}, 409
	}

	address := strings.TrimSpace(pyStr(dhcp["address"]))
	if address != "" {
		ip, perr := netip.ParseAddr(address)
		if perr != nil || !prefix.Contains(ip) {
			return M{"ok": false, "error": fmt.Sprintf("%s is not an address in this subnet (%s)", address, prefix)}, 400
		}
	} else {
		free, ferr := c.Rest.GetStrict(objPath+"/nextavailableip", map[string]string{"count": "1"})
		if ferr != nil {
			return M{"ok": false, "error": "could not list free addresses: " + publicErr(ferr)}, 502
		}
		if len(free) == 0 {
			return M{"ok": false, "error": "this subnet has no free address"}, 409
		}
		address = pyStr(asMap(free[0])["address"])
	}

	fixed := M{"address": address, "mac": mac, "name": devName}
	if dry {
		fixed["dry_run"] = true
		result := M{"ok": true, "dry_run": true, "subnet_id": subnetID, "would_allocate": 1,
			"addresses": []any{M{"address": address}}, "fixed_address": fixed}
		if name != "" {
			result["name"] = name
		}
		if dns != nil {
			rec := M{"dry_run": true}
			for k, v := range dns {
				rec[k] = v
			}
			result["record"] = rec
		}
		return result, 200
	}

	resp, fstatus, _ := c.Rest.Write("POST", "/api/ddi/v1/dhcp/fixed_address", M{
		"address": address, "match_type": "mac", "match_value": mac,
		"name": devName, "ip_space": space, "tags": withMadeTag(nil),
	}, nil)
	switch {
	case writeUnreadable(resp, fstatus) || outcomeUnknown(fstatus):
		res := createdUnreadable("DHCP reservation", fstatus, "")
		if outcomeUnknown(fstatus) {
			res = createdMaybe("DHCP reservation", fstatus, "")
		}
		res["address"], res["mac"] = address, mac
		return M{CreatedUnreadableKey: true, "addresses": []any{M{"address": address}},
			"fixed_address": res, "error": res["error"]}, statusOr(fstatus, 502)
	case fstatus != 200 && fstatus != 201:
		return M{"ok": false, "error": fmt.Sprintf("the reservation was refused (%s); nothing was created. "+
			"If the address was just taken, preview again", statusPhrase(fstatus)), "detail": resp}, statusOr(fstatus, 502)
	}
	made := asMap(resultOrSelf(resp))
	fixed["ok"], fixed["id"] = true, made["id"]
	out := M{"ok": true, "addresses": []any{M{"id": made["id"], "address": address}}, "fixed_address": fixed}

	if dns != nil {
		rresp, rstatus := c.createAddressRecord(dns, address)
		switch {
		case (rstatus == 200 || rstatus == 201) && asMap(rresp) != nil:
			out["record"] = M{"ok": true, "id": recordID(rresp), "status": rstatus}
		case writeUnreadable(rresp, rstatus) || outcomeUnknown(rstatus):
			// The record may exist: say so, and do not suggest adding it again.
			rec := createdUnreadable("DNS record", rstatus, "The reservation was made")
			if outcomeUnknown(rstatus) {
				rec = createdMaybe("DNS record", rstatus, "The reservation was made")
			}
			delete(out, "ok")
			out[CreatedUnreadableKey] = true
			out["record"] = rec
			out["error"] = rec["error"]
			return out, statusOr(rstatus, 502)
		default:
			out["ok"] = false
			out["record"] = M{"ok": false, "status": rstatus, "detail": rresp}
			out["error"] = fmt.Sprintf("the reservation was made, but the DNS record was not (%s). "+
				"The device still gets %s; add the record on its own", statusPhrase(rstatus), address)
			return out, 502
		}
	}
	return out, 200
}

// subnetSpace reads the subnet's IP space (a fixed address needs it) and its
// range (to check a previewed address really belongs to it). A non-zero status
// means the read failed and msg says why.
func (c *Client) subnetSpace(objPath string) (space string, prefix netip.Prefix, msg string, status int) {
	resp, st, err := c.Rest.GetEx(objPath, map[string]string{"_fields": "space,address,cidr"})
	if err != nil || st != 200 {
		return "", prefix, "could not read the subnet: " + statusPhrase(st), statusOr(st, 502)
	}
	sub := asMap(resultOrSelf(resp))
	cidr, _ := intCoerce(sub["cidr"])
	p, perr := netip.ParsePrefix(fmt.Sprintf("%s/%d", pyStr(sub["address"]), cidr))
	space = pyStr(sub["space"])
	if perr != nil || space == "" {
		return "", prefix, "the subnet's address or IP space could not be read", 502
	}
	return space, p, "", 0
}

func publicErr(err error) string {
	if ue, ok := err.(*rest.UpstreamError); ok {
		return ue.Public()
	}
	return "lookup failed"
}
