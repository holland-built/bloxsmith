package dashboard

import (
	"bytes"
	"encoding/json"
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

// cubeOrder is a Cube.js "order" whose keys keep their order. A Go map would
// be marshalled with its keys sorted, which can put a tie-breaker first; the
// endpoint refuses the array form ("unable to process query", seen live on
// 2026-11-10), so this writes the object form in the order given.
type cubeOrder [][2]string

func (o cubeOrder) MarshalJSON() ([]byte, error) {
	var b bytes.Buffer
	b.WriteByte('{')
	for i, kv := range o {
		if i > 0 {
			b.WriteByte(',')
		}
		k, _ := json.Marshal(kv[0])
		v, _ := json.Marshal(kv[1])
		b.Write(k)
		b.WriteByte(':')
		b.Write(v)
	}
	b.WriteByte('}')
	return b.Bytes(), nil
}
