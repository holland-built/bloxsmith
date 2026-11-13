package dashboard

import (
	"fmt"
	"strconv"
	"strings"
	"sync"
)

// The threat check Site lists runs before adding sites (owner, 2026-11-13:
// "Dossier check before adding", a risky site flagged and left out unless the
// owner ticks it). It reads Infoblox's threat data, the source Dossier draws
// on, through the bulk lookup: 100 sites took 0.4s on the Infoblox Sales
// tenant, where one Dossier lookup took over 25s. 400 sites in one request
// failed there with a 500, so batches stay at 100. Nothing is cached: Apply
// checks again, so a site listed after the preview is caught, and the
// fingerprint makes Apply refuse when the result changed.

const (
	checkBatch   = 100
	checkWorkers = 4
)

// SiteThreat is one site Infoblox lists as a threat now.
type SiteThreat struct {
	Domain   string `json:"domain"`
	Class    string `json:"class"`
	Property string `json:"property"`
	Level    int    `json:"level"`
}

// CheckSites looks domains up in Infoblox's threat data. risky holds the ones
// listed with a threat level above 0, in the order given. unchecked holds the
// ones whose lookup failed, with reason; a site that could not be checked is
// never reported clean.
func (s *Service) CheckSites(domains []string) (risky []SiteThreat, unchecked []string, reason string) {
	found := map[string]*SiteThreat{}
	var mu sync.Mutex
	failed := map[string]bool{}
	batches := chunk(domains, checkBatch)
	next := make(chan []string)
	var wg sync.WaitGroup
	for w := 0; w < checkWorkers && w < len(batches); w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for b := range next {
				got, why := s.checkBatch(b)
				mu.Lock()
				if why != "" {
					for _, d := range b {
						failed[d] = true
					}
					reason = why
				} else {
					for d, t := range got {
						found[d] = t
					}
				}
				mu.Unlock()
			}
		}()
	}
	for _, b := range batches {
		next <- b
	}
	close(next)
	wg.Wait()

	for _, d := range domains {
		switch {
		case failed[d]:
			unchecked = append(unchecked, d)
		case found[d] != nil:
			risky = append(risky, *found[d])
		}
	}
	return risky, unchecked, reason
}

// checkBatch looks up at most checkBatch domains in one request. The map holds
// only the risky ones; why is set when the lookup itself failed.
func (s *Service) checkBatch(b []string) (map[string]*SiteThreat, string) {
	body, st, err := s.Rest.GetEx("/tide/api/data/threats/state/host", map[string]string{"host": strings.Join(b, ",")})
	switch {
	case st == 403:
		return nil, "this Infoblox subscription does not include threat data"
	case errored(st, err):
		return nil, fmt.Sprintf("Infoblox did not answer the threat lookup (%s)", httpWord(st))
	}
	// Anything unexpected in the reply makes the whole batch "could not
	// check": a record that cannot be read must never let a site pass as clean.
	const unreadable = "Infoblox sent a threat lookup reply Bloxsmith could not read"
	m, ok := body.(map[string]any)
	if !ok {
		return nil, unreadable
	}
	records, ok := m["threat"].([]any)
	if !ok {
		return nil, unreadable
	}
	asked := map[string]bool{}
	for _, d := range b {
		asked[d] = true
	}
	out := map[string]*SiteThreat{}
	for _, t := range records {
		r, ok := t.(map[string]any)
		host, okHost := r["host"].(string)
		level, err := strconv.ParseFloat(fmt.Sprint(r["threat_level"]), 64)
		if !ok || !okHost || err != nil {
			return nil, unreadable
		}
		host = canonDomain(host)
		if !asked[host] || level <= 0 {
			continue
		}
		if cur := out[host]; cur == nil || int(level) > cur.Level {
			out[host] = &SiteThreat{Domain: host, Class: getStr(r["class"]), Property: getStr(r["property"]), Level: int(level)}
		}
	}
	return out, ""
}
