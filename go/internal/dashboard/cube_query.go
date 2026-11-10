package dashboard

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
func (s *Service) cubeGet(endpoint string, qj []byte) (any, int, error) {
	params := map[string]string{"query": string(qj)}
	body, st, err := s.Rest.GetEx(endpoint, params)
	if endpoint != cubeSecurityEndpoint || !errored(st, err) {
		return body, st, err
	}
	b2, st2, err2 := s.Rest.GetEx(cubeEndpoint, params)
	if errored(st2, err2) {
		return body, st, err
	}
	return b2, st2, err2
}
