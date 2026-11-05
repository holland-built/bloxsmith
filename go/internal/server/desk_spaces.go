package server

import (
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"bloxsmith/internal/rest"
)

// GET /api/desk/spaces lists every IP space in the order the desk suggests
// them, each with the reason in plain words:
//
//  1. Spaces this install built in before, newest first.
//  2. Spaces whose name contains the signed-in login (the part of the email
//     before the @). Most spaces on a shared demo tenant are named after the
//     person who uses them. This is a convenience, never an access check, and
//     the login itself is never sent to the browser.
//  3. Every other space, most free addresses first.
//
// Any of the three sources can be missing (no runs yet, /v2/current_user not
// answering, no utilization); the list still comes back, just less sorted.
func (d *Deps) deskSpaces(w http.ResponseWriter, r *http.Request) {
	defer d.recover500(w, r, "/api/desk/spaces")
	spaces, ok := d.getStrictOrErr(w, r, "/api/ddi/v1/ipam/ip_space", map[string]string{"_fields": "id,name"})
	if !ok {
		return
	}
	c := d.restFor(r)
	d.json(w, r, 200, map[string]any{"spaces": rankSpaces(spaces, d.builtSpaces(), spaceFree(c), signedInLogin(c))})
}

type spaceRow struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Yours  bool   `json:"yours"`
	Reason string `json:"reason"`
	rank   int
	when   string
	free   int
}

func rankSpaces(spaces []any, built map[string]string, free map[string][2]int, login string) []spaceRow {
	login = strings.ToLower(login)
	out := make([]spaceRow, 0, len(spaces))
	for _, s := range spaces {
		m, _ := s.(map[string]any)
		row := spaceRow{ID: anyStr(m["id"]), Name: anyStr(m["name"]), rank: 3, free: -1}
		if row.ID == "" {
			continue
		}
		if f, ok := free[row.ID]; ok {
			row.free = f[0]
			if f[1] > 0 {
				row.Reason = fmt.Sprintf("%s of %s addresses free", commas(f[0]), commas(f[1]))
			} else {
				row.Reason = "No networks yet"
			}
		}
		switch {
		case built[row.ID] != "":
			row.rank, row.Yours, row.when = 1, true, built[row.ID]
			row.Reason = "You built here " + shortDate(row.when)
		case len(login) >= 3 && strings.Contains(strings.ToLower(row.Name), login):
			row.rank, row.Yours = 2, true
			row.Reason = "Named for you"
		}
		out = append(out, row)
	}
	sort.SliceStable(out, func(i, j int) bool {
		a, b := out[i], out[j]
		if a.rank != b.rank {
			return a.rank < b.rank
		}
		if a.rank == 1 && a.when != b.when {
			return a.when > b.when
		}
		if a.free != b.free {
			return a.free > b.free
		}
		return strings.ToLower(a.Name) < strings.ToLower(b.Name)
	})
	return out
}

// builtSpaces maps each IP space a desk run built in to the newest run's time.
func (d *Deps) builtSpaces() map[string]string {
	out := map[string]string{}
	l := d.ledger()
	if l == nil {
		return out
	}
	rs, err := l.List()
	if err != nil {
		return out
	}
	for _, r := range rs {
		// Only a run that made something counts; a failed Build built nothing.
		if r.Space != "" && len(r.Objects) > 0 && r.Created > out[r.Space] {
			out[r.Space] = r.Created
		}
	}
	return out
}

// spaceFree maps space ID to [free, total] addresses, from the same IPAM tree
// the IPAM utilization panel reads. Empty when it does not answer.
func spaceFree(c *rest.Client) map[string][2]int {
	out := map[string][2]int{}
	body, st, err := c.GetEx("/api/ddi/v1/ipam/htree", map[string]string{"view": "SPACE", "_limit": "2000", "_fields": "id,utilization"})
	if err != nil || st != 200 {
		return out
	}
	for _, it := range rest.Unwrap(body) {
		m, _ := it.(map[string]any)
		u, _ := m["utilization"].(map[string]any)
		total, used := atoiAny(u["total"]), atoiAny(u["used"])
		if id := anyStr(m["id"]); id != "" && u != nil {
			out[id] = [2]int{max(total-used, 0), total}
		}
	}
	return out
}

// signedInLogin is the part of the signed-in email before the @, or "".
func signedInLogin(c *rest.Client) string {
	body, st, err := c.GetEx("/v2/current_user", nil)
	if err != nil || st != 200 {
		return ""
	}
	m, _ := body.(map[string]any)
	res, _ := m["result"].(map[string]any)
	email := anyStr(res["email"])
	if at := strings.IndexByte(email, '@'); at > 0 {
		return email[:at]
	}
	return ""
}

func atoiAny(v any) int {
	switch x := v.(type) {
	case float64:
		return int(x)
	case string:
		n, _ := strconv.Atoi(x)
		return n
	}
	return 0
}

func commas(n int) string {
	s := strconv.Itoa(n)
	for i := len(s) - 3; i > 0; i -= 3 {
		s = s[:i] + "," + s[i:]
	}
	return s
}

func shortDate(iso string) string {
	t, err := time.Parse(time.RFC3339, iso)
	if err != nil {
		return "before"
	}
	return "on " + t.Local().Format("Jan 2")
}
