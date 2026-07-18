package ai

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
)

// thinkRE strips Qwen3 <think>...</think> reasoning blocks (server.py:4104).
var thinkRE = regexp.MustCompile(`(?s)<think>.*?</think>`)

// fenceRE strips a leading markdown code fence line (server.py:4107):
// ^```[a-z]*\n?  (non-multiline: anchored at string start).
var fenceRE = regexp.MustCompile("^```[a-z]*\n?")

// parseAIResponse is _parse_ai_response (server.py:4101): the JSON-in-prose
// extractor. This is the deterministic parity gate — given identical raw model
// text it must produce byte-identical {answer, suggestions} to the Python.
func parseAIResponse(raw string) map[string]any {
	raw = strings.TrimSpace(raw)
	raw = thinkRE.ReplaceAllString(raw, "")
	raw = strings.TrimSpace(raw)
	if strings.HasPrefix(raw, "```") {
		raw = fenceRE.ReplaceAllString(raw, "")
		raw = strings.TrimRight(raw, "`")
		raw = strings.TrimSpace(raw)
	}

	// Attempt 1: direct parse.
	if obj, ok := decodeObj(raw); ok {
		if _, has := obj["answer"]; has {
			return finalize(obj)
		}
	}

	// Attempt 2: scan every '{' and keep the LAST object that decodes with an
	// "answer" key (Python's raw_decode loop; json.Decoder reads one value and
	// ignores trailing content, matching JSONDecoder.raw_decode).
	var last map[string]any
	for i := 0; i < len(raw); i++ {
		if raw[i] != '{' {
			continue
		}
		dec := json.NewDecoder(strings.NewReader(raw[i:]))
		var v any
		if err := dec.Decode(&v); err != nil {
			continue
		}
		if m, ok := v.(map[string]any); ok {
			if _, has := m["answer"]; has {
				last = m
			}
		}
	}
	if last != nil {
		return finalize(last)
	}
	return map[string]any{"answer": raw, "suggestions": []string{}}
}

// decodeObj attempts a strict whole-string object parse.
func decodeObj(raw string) (map[string]any, bool) {
	var obj map[string]any
	if err := json.Unmarshal([]byte(raw), &obj); err != nil {
		return nil, false
	}
	return obj, true
}

// finalize builds the {answer, suggestions} result, keeping only string
// suggestions and running them through cleanSuggestions (server.py:4112).
func finalize(obj map[string]any) map[string]any {
	var strs []string
	if arr, ok := obj["suggestions"].([]any); ok {
		for _, s := range arr {
			if str, ok := s.(string); ok {
				strs = append(strs, str)
			}
		}
	}
	return map[string]any{
		"answer":      answerStr(obj["answer"]),
		"suggestions": cleanSuggestions(strs),
	}
}

// answerStr is str(obj["answer"]): a string stays as-is; anything else is
// stringified.
func answerStr(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	return fmt.Sprint(v)
}

// cleanSuggestions is _clean_suggestions (server.py:4088): drop blanks and any
// suggestion that is a bare tool name or "tool_name with ..." pattern; cap at 5.
// Always returns a non-nil slice so it serializes as [] not null.
func cleanSuggestions(sugs []string) []string {
	out := []string{}
	for _, s := range sugs {
		s = strings.TrimSpace(s)
		if s == "" {
			continue
		}
		fields := strings.Fields(s)
		firstWord := ""
		if len(fields) > 0 {
			firstWord = strings.ToLower(strings.TrimRight(fields[0], "?"))
		}
		if toolNames[firstWord] {
			continue
		}
		lower := strings.ToLower(s)
		skip := false
		for n := range toolNames {
			if strings.HasPrefix(lower, n+" ") {
				skip = true
				break
			}
		}
		if skip {
			continue
		}
		out = append(out, s)
	}
	if len(out) > 5 {
		out = out[:5]
	}
	return out
}
