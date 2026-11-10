package dashboard

import (
	"sync"
	"time"
)

// cubeGet runs one Cube.js query against endpoint.
//
// A query for the security service (cubeSecurityEndpoint) that it refuses or
// fails is asked again, unchanged, of the main service (cubeEndpoint). The
// main service serves the same threat cubes with the same numbers: checked
// live on 2026-11-10 for 1–7 Nov, PortunusAggThreat_ch gave Block 74,960 /
// Allow 18,309 from both. That day the security service answered every query
// with 400 "unable to process query", which left the Security charts empty.
//
// If the main service fails too, the security service's own answer is
// returned, so the caller reports that failure as before. Queries for any
// other endpoint are passed through untouched.
//
// Once the security service has failed where the main one answered, that is
// remembered for this tenant for cubeSecurityRetry, and queries go to the main
// service first: without it, every threat query made two calls for as long as
// the security service stayed down. Should the main service fail inside that
// window, the security service is still asked, and an answer from it ends the
// window early.
func (s *Service) cubeGet(endpoint string, qj []byte) (any, int, error) {
	params := map[string]string{"query": string(qj)}
	if endpoint != cubeSecurityEndpoint {
		return s.Rest.GetEx(endpoint, params)
	}
	tenant := s.Rest.TenantTag()
	if s.secCube.down(tenant) {
		b2, st2, err2 := s.Rest.GetEx(cubeEndpoint, params)
		if !errored(st2, err2) {
			return b2, st2, err2
		}
		body, st, err := s.Rest.GetEx(cubeSecurityEndpoint, params)
		if errored(st, err) {
			return body, st, err
		}
		s.secCube.clear(tenant)
		return body, st, err
	}
	body, st, err := s.Rest.GetEx(cubeSecurityEndpoint, params)
	if !errored(st, err) {
		return body, st, err
	}
	b2, st2, err2 := s.Rest.GetEx(cubeEndpoint, params)
	if errored(st2, err2) {
		return body, st, err
	}
	s.secCube.markDown(tenant)
	return b2, st2, err2
}

// cubeSecurityRetry is how long a failing security service is skipped before
// it is tried first again.
const cubeSecurityRetry = 10 * time.Minute

// cubeFallback is the per-tenant memory of a failing security service. Keyed
// by rest.Client.TenantTag, so one tenant's outage never reroutes another's
// queries. Nil-safe: a Service built as a bare literal has no memory.
type cubeFallback struct {
	mu    sync.Mutex
	until map[string]time.Time
}

func (c *cubeFallback) down(tenant string) bool {
	if c == nil {
		return false
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	return time.Now().Before(c.until[tenant])
}

func (c *cubeFallback) markDown(tenant string) {
	if c == nil {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.until == nil {
		c.until = map[string]time.Time{}
	}
	c.until[tenant] = time.Now().Add(cubeSecurityRetry)
}

func (c *cubeFallback) clear(tenant string) {
	if c == nil {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.until, tenant)
}
