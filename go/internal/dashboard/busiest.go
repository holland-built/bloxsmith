package dashboard

import (
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"

	"golang.org/x/net/publicsuffix"
)

// This tenant's own busiest sites, for Site lists (owner, 2026-11-13: "lets
// offer both and compare" with InfoRank). Last 7 days of DNS queries, each name
// folded into its site, so www.google.com and mail.google.com both count for
// google.com.

const (
	// busiestRows is how many names Infoblox is asked for, busiest first. On
	// the Infoblox Sales tenant (2026-11-13) 5,000 names reached down to names
	// with 3 queries in a week, so 10,000 is close to everything.
	busiestRows = 10000
	busiestTTL  = time.Hour
)

// siteOf folds a DNS name into its site: the registered name under a public
// suffix, so a.b.example.co.uk is example.co.uk. Hosted names under a private
// suffix stay apart (alice.github.io is not github.io). Internal names, such as
// .local, .svc or single-label names, are not sites and give false.
func siteOf(name string) (string, bool) {
	n := canonDomain(name)
	if !publicName(n) {
		return "", false
	}
	site, err := publicsuffix.EffectiveTLDPlusOne(n)
	if err != nil {
		return "", false
	}
	return site, true
}

// BusiestSites returns the n sites this tenant looked up most in the last 7
// days, with their query counts. Counts are summed per site before the top n
// is taken. "estimate" is true when Infoblox gave as many names as were asked
// for, so names further down, and the queries they carry, were not counted.
func (s *Service) BusiestSites(n int) (map[string]any, error) {
	if n < 1 || n > MaxListDomains {
		return nil, fmt.Errorf("top must be between 1 and %d", MaxListDomains)
	}
	v, err := s.Cache.DoTTL("busiest:sites|"+s.Rest.TenantTag(), busiestTTL, func() (any, error) {
		qj, _ := json.Marshal(map[string]any{
			"measures":   []string{cubeDNS + ".total_query_count"},
			"dimensions": []string{cubeDNS + ".qname"},
			"timeDimensions": []map[string]any{{
				"dimension": cubeDNS + ".timestamp", "dateRange": "last 7 days"}},
			"order": map[string]any{cubeDNS + ".total_query_count": "desc"},
			"limit": busiestRows,
		})
		body, st, err := s.cubeGet(cubeEndpoint, qj)
		if errored(st, err) {
			return nil, fmt.Errorf("Infoblox did not answer the DNS traffic query (%s)", httpWord(st))
		}
		rows := cubeData(body)
		return foldSites(rows), nil
	})
	if err != nil {
		return nil, err
	}
	f := v.(folded)
	top := f.sites
	if n < len(top) {
		top = top[:n]
	}
	domains := make([]string, len(top))
	counts := make([]int64, len(top))
	for i, t := range top {
		domains[i], counts[i] = t.site, t.queries
	}
	return map[string]any{"domains": domains, "queries": counts, "total": len(f.sites),
		"names": f.names, "estimate": f.names >= busiestRows, "days": 7}, nil
}

type siteCount struct {
	site    string
	queries int64
}

type folded struct {
	sites []siteCount // busiest first, ties by name
	names int         // DNS names Infoblox returned
}

// foldSites sums Cube rows of name and query count into sites.
func foldSites(rows []any) folded {
	sums := map[string]int64{}
	for _, r := range rows {
		m := asMap(r)
		site, ok := siteOf(fmt.Sprint(m[cubeDNS+".qname"]))
		if !ok {
			continue
		}
		c, err := strconv.ParseFloat(fmt.Sprint(m[cubeDNS+".total_query_count"]), 64)
		if err != nil {
			continue
		}
		sums[site] += int64(c)
	}
	out := make([]siteCount, 0, len(sums))
	for s, c := range sums {
		out = append(out, siteCount{s, c})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].queries != out[j].queries {
			return out[i].queries > out[j].queries
		}
		return out[i].site < out[j].site
	})
	return folded{sites: out, names: len(rows)}
}

// IsDomain reports whether s is a domain name a list can hold.
func IsDomain(s string) bool { return isFQDN(canonDomain(s)) }

// NeverAdd splits domains into those to keep and those on the never-add list.
// A domain is left out when it is a never-add site, or is under one, or has one
// under it: a custom list entry also covers the names under it, so adding
// google.com would let www.google.com in too.
func NeverAdd(domains, never []string) (keep, left []string) {
	nv := make([]string, 0, len(never))
	for _, n := range never {
		if c := canonDomain(n); c != "" {
			nv = append(nv, c)
		}
	}
	under := func(a, b string) bool { return a == b || strings.HasSuffix(a, "."+b) }
	for _, d := range domains {
		out := false
		for _, n := range nv {
			if under(d, n) || under(n, d) {
				out = true
				break
			}
		}
		if out {
			left = append(left, d)
		} else {
			keep = append(keep, d)
		}
	}
	return keep, left
}
