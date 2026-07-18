package ai

import (
	"reflect"
	"testing"
)

// TestParseAIResponse is the deterministic parity gate (LLM output is
// non-deterministic; the parser is not). Each sample's expected output was
// produced by running the SAME string through Python's _parse_ai_response +
// _clean_suggestions (server.py:4088-4134). Go must extract byte-identical
// {answer, suggestions}.
func TestParseAIResponse(t *testing.T) {
	cases := []struct {
		name    string
		raw     string
		answer  string
		suggest []string
	}{
		{
			name:    "direct_json_drops_tool_name_suggestions",
			raw:     `{"answer":"hello world","suggestions":["show me DNS zones for x","get_dns","search_entity with query=h1"]}`,
			answer:  "hello world",
			suggest: []string{"show me DNS zones for x"},
		},
		{
			name:    "prose_wrapped_embedded_json",
			raw:     "Sure! Here is the result.\n{\"answer\":\"embedded answer\",\"suggestions\":[\"q1\",\"q2\"]}\nHope that helps.",
			answer:  "embedded answer",
			suggest: []string{"q1", "q2"},
		},
		{
			name:    "strips_qwen_think_block",
			raw:     `<think>let me reason about this</think>{"answer":"post-think","suggestions":[]}`,
			answer:  "post-think",
			suggest: []string{},
		},
		{
			name:    "strips_markdown_code_fence",
			raw:     "```json\n{\"answer\":\"fenced answer\",\"suggestions\":[\"list threat feeds\"]}\n```",
			answer:  "fenced answer",
			suggest: []string{"list threat feeds"},
		},
		{
			name:    "keeps_last_object_with_answer",
			raw:     `{"answer":"first obj"} then some noise {"answer":"last obj","suggestions":["ok question"]}`,
			answer:  "last obj",
			suggest: []string{"ok question"},
		},
		{
			name:    "no_json_falls_back_to_raw",
			raw:     "just some prose with no json at all",
			answer:  "just some prose with no json at all",
			suggest: []string{},
		},
		{
			name:    "nested_braces_in_string_and_object",
			raw:     `{"answer":"has nested","suggestions":["ask about {braces}"],"meta":{"k":[1,2,3]}}`,
			answer:  "has nested",
			suggest: []string{"ask about {braces}"},
		},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := parseAIResponse(c.raw)
			if got["answer"] != c.answer {
				t.Errorf("answer = %q, want %q", got["answer"], c.answer)
			}
			gotSug, _ := got["suggestions"].([]string)
			if !reflect.DeepEqual(gotSug, c.suggest) {
				t.Errorf("suggestions = %#v, want %#v", gotSug, c.suggest)
			}
		})
	}
}

// TestCleanSuggestions covers the tool-name rejection rules directly.
func TestCleanSuggestions(t *testing.T) {
	in := []string{
		"  ",                       // blank
		"get_dns",                  // bare tool name
		"get_dns?",                 // bare tool name w/ trailing ?
		"search_entity with x",     // "tool with ..." pattern
		"show me the DNS zones",    // keep
		"how many hosts are down?", // keep
	}
	got := cleanSuggestions(in)
	want := []string{"show me the DNS zones", "how many hosts are down?"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("cleanSuggestions = %#v, want %#v", got, want)
	}
}

// TestChatURL confirms the groq-SDK URL join (default host + absolute path).
func TestChatURL(t *testing.T) {
	if got := chatURL(""); got != "https://api.groq.com/openai/v1/chat/completions" {
		t.Errorf("default base = %q", got)
	}
	if got := chatURL("https://llm.internal.example"); got != "https://llm.internal.example/openai/v1/chat/completions" {
		t.Errorf("custom base = %q", got)
	}
}
