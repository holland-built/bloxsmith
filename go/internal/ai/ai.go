// Package ai ports server.py's natural-language assistant (the "NL query
// handler", server.py:3849-4145): the Groq/OpenAI-compatible chat-completions
// tool loop behind POST /api/query. The LLM contract lives here — the system
// prompt (_AI_SYSTEM), the tool schema (_TOOLS), the 6-iteration tool loop
// (_handle_query_async), and the JSON-in-prose response parser
// (_parse_ai_response / _clean_suggestions, the deterministic gate). The tool
// DISPATCH (_run_tool) lives in package dashboard, next to the norm_* shapers
// it needs, and is reached through the ToolRunner interface.
package ai

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// ToolRunner executes one AI tool call and returns its JSON/sentinel string.
// *dashboard.Service satisfies it (RunAITool); the interface keeps this package
// free of a concrete dependency on the data layer.
type ToolRunner interface {
	RunAITool(ctx context.Context, name string, args map[string]any) string
}

// Creds is resolved live per query so a vault unlock (which can override the
// env-derived defaults, server.py:2790-2792) is always honored.
type Creds interface {
	// LLM returns (apiKey, baseURL, model) with the vault-over-env precedence
	// server.py applies.
	LLM() (key, base, model string)
}

// Service is the /api/query handler dependency graph.
type Service struct {
	creds Creds
	tools ToolRunner
	http  *http.Client
}

// New builds the AI service. The 60s HTTP client is comfortably inside the 55s
// per-query deadline handle_query enforces.
func New(creds Creds, tools ToolRunner) *Service {
	return &Service{creds: creds, tools: tools, http: &http.Client{Timeout: 60 * time.Second}}
}

const maxToolChars = 3000 // _MAX_TOOL_CHARS (server.py:3938)

// HandleQuery is handle_query (server.py:4136): run the tool loop under a 55s
// deadline, parse the raw model output, and attach the tool trace when present.
func (s *Service) HandleQuery(question, contextStr string) map[string]any {
	trace := []map[string]any{}
	raw := s.runLoop(question, contextStr, &trace)
	out := parseAIResponse(raw)
	if len(trace) > 0 {
		out["trace"] = trace
	}
	return out
}

const timeoutJSON = `{"answer": "AI query timed out — the request took too long. Try a narrower question.", "suggestions": ["show network summary", "show offline hosts", "list threat feeds", "show audit logs"]}`
const errJSON = `{"answer": "AI error: request failed", "suggestions": ["try again in a moment", "show network summary", "show offline hosts", "list threat feeds", "show audit logs"]}`
const noKeyMsg = "AI query requires LLM_API_KEY (or GROQ_API_KEY) in .env — add it and restart the server."

// runLoop is _handle_query_async (server.py:4044): the bounded tool-calling
// loop. Returns the model's final raw text (or a canned JSON string on the
// no-key / timeout / error paths), which the caller feeds to parseAIResponse.
func (s *Service) runLoop(question, contextStr string, trace *[]map[string]any) string {
	key, base, model := s.creds.LLM()
	if key == "" {
		return noKeyMsg
	}

	ctx, cancel := context.WithTimeout(context.Background(), 55*time.Second)
	defer cancel()

	if len(contextStr) > 8000 {
		contextStr = contextStr[:8000]
	}
	userMsg := question
	if strings.TrimSpace(contextStr) != "" {
		userMsg = strings.TrimSpace(contextStr) + "\n\n" + question
	}
	messages := []any{
		map[string]any{"role": "system", "content": aiSystem},
		map[string]any{"role": "user", "content": userMsg},
	}

	lastContent := ""
	sawChoice := false
	for i := 0; i < 6; i++ {
		resp, err := s.chat(ctx, key, base, model, messages)
		if err != nil {
			if ctx.Err() == context.DeadlineExceeded {
				return timeoutJSON
			}
			log.Printf("_generate_ai_answer: %v", err)
			return errJSON
		}
		if len(resp.Choices) == 0 {
			break
		}
		ch := resp.Choices[0]
		sawChoice = true
		lastContent = ch.content
		if ch.FinishReason != "tool_calls" {
			if ch.content == "" {
				return `{"answer": "No content.", "suggestions": []}`
			}
			return ch.content
		}
		// Append the assistant message verbatim, then each tool result.
		messages = append(messages, ch.Message)
		for _, tc := range ch.toolCalls {
			var argMap map[string]any
			_ = json.Unmarshal([]byte(orDefault(tc.Function.Arguments, "{}")), &argMap)
			*trace = append(*trace, map[string]any{
				"tool": tc.Function.Name,
				"args": traceArgs(argMap),
			})
			result := s.tools.RunAITool(ctx, tc.Function.Name, argMap)
			if len(result) > maxToolChars {
				result = result[:maxToolChars] + "…[truncated]"
			}
			messages = append(messages, map[string]any{
				"role": "tool", "tool_call_id": tc.ID, "content": result,
			})
		}
	}
	if sawChoice && lastContent != "" {
		return lastContent
	}
	return `{"answer": "No response.", "suggestions": []}`
}

// chatURL mirrors the groq SDK URL join: base_url (default https://api.groq.com)
// joined with the absolute path "/openai/v1/chat/completions" — an absolute path
// replaces any path already on base_url, exactly as httpx.URL.join does.
func chatURL(base string) string {
	if base == "" {
		base = "https://api.groq.com"
	}
	if u, err := url.Parse(base); err == nil && u.Host != "" {
		return u.Scheme + "://" + u.Host + "/openai/v1/chat/completions"
	}
	return strings.TrimRight(base, "/") + "/openai/v1/chat/completions"
}

// chatResp is the subset of the chat-completions response the loop reads.
type chatResp struct {
	Choices []struct {
		FinishReason string          `json:"finish_reason"`
		Message      json.RawMessage `json:"message"`
		// decoded lazily below
		content   string
		toolCalls []toolCall
	} `json:"choices"`
}

type toolCall struct {
	ID       string `json:"id"`
	Function struct {
		Name      string `json:"name"`
		Arguments string `json:"arguments"`
	} `json:"function"`
}

// chat is client.chat.completions.create (server.py:4061): one POST to the
// OpenAI-compatible endpoint with the tool schema and tool_choice=auto.
func (s *Service) chat(ctx context.Context, key, base, model string, messages []any) (*chatResp, error) {
	reqBody := map[string]any{
		"model":       model,
		"max_tokens":  1024,
		"messages":    messages,
		"tools":       aiTools,
		"tool_choice": "auto",
	}
	raw, err := json.Marshal(reqBody)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, "POST", chatURL(base), bytes.NewReader(raw))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+key)
	resp, err := s.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		// Include the provider's error body (truncated) — "http 400" alone cost a
		// debugging session when Groq decommissioned the default model.
		b := make([]byte, 300)
		n, _ := resp.Body.Read(b)
		return nil, fmt.Errorf("chat/completions: http %d: %s", resp.StatusCode, strings.TrimSpace(string(b[:n])))
	}
	var out chatResp
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, err
	}
	for i := range out.Choices {
		var m struct {
			Content   string     `json:"content"`
			ToolCalls []toolCall `json:"tool_calls"`
		}
		_ = json.Unmarshal(out.Choices[i].Message, &m)
		out.Choices[i].content = m.Content
		out.Choices[i].toolCalls = m.ToolCalls
	}
	return &out, nil
}

// traceArgs is {k: str(v)[:80]} (server.py:4076): a compact, size-bounded copy
// of the tool arguments for the client-side transparency trace.
func traceArgs(args map[string]any) map[string]any {
	out := map[string]any{}
	for k, v := range args {
		s := fmt.Sprint(v)
		if len(s) > 80 {
			s = s[:80]
		}
		out[k] = s
	}
	return out
}

func orDefault(s, def string) string {
	if s == "" {
		return def
	}
	return s
}
