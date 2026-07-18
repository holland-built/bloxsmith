package ai

import "encoding/json"

// aiSystem is _AI_SYSTEM (server.py:3851), copied verbatim. The \n inside the
// JSON example is a literal backslash-n, exactly as the Python string value is.
const aiSystem = `You are a network analyst for the Bloxsmith dashboard. Call tools to fetch live data, then answer.

RULES:
1. Always call the right tool(s) before answering. Never fabricate data.
2. Your FINAL response must be ONLY this JSON (no other text before or after):
   {"answer": "text with \n and • bullets", "suggestions": ["q1","q2","q3"]}
3. suggestions must be PLAIN ENGLISH QUESTIONS a human would type — never tool names like get_dns or search_entity.
   GOOD: "show me DNS zones for example.com"
   BAD:  "get_dns" or "search_entity with query=host1"
4. Always include 3-5 suggestions.
5. Ambiguous term? Try multiple search_entity calls, get_subnets, get_dns, get_audit_logs.
6. No data found? Suggest alternatives as plain English questions.
7. For "is X malicious", "lookalikes of my brand", or "what assets", use dossier_lookup / lookalike_domains / asset_insights respectively.

Output the JSON object and nothing else.`

// toolsJSON is _TOOLS (server.py:3867), copied verbatim as the OpenAI
// tool-schema array sent on every chat/completions request.
const toolsJSON = `[
  {"type": "function", "function": {
    "name": "search_entity",
    "description": "Search for any network entity by name, IP address, hostname, or subnet CIDR",
    "parameters": {"type": "object", "required": ["query"],
      "properties": {"query": {"type": "string", "description": "Name, IP, hostname, or subnet to find"}}}
  }},
  {"type": "function", "function": {
    "name": "get_subnets",
    "description": "Get IPAM subnets with utilization. Use address param for a specific subnet.",
    "parameters": {"type": "object",
      "properties": {
        "address": {"type": "string", "description": "Filter by subnet address, e.g. '192.168.100.0'"},
        "cidr":    {"type": "integer", "description": "CIDR prefix length, e.g. 24"}
      }}
  }},
  {"type": "function", "function": {
    "name": "get_hosts",
    "description": "Get infrastructure hosts with status (online/offline/error/degraded)",
    "parameters": {"type": "object",
      "properties": {"status": {"type": "string", "description": "Filter: online, offline, error, or degraded"}}}
  }},
  {"type": "function", "function": {
    "name": "get_dns",
    "description": "Get DNS views and authoritative zones",
    "parameters": {"type": "object", "properties": {}}
  }},
  {"type": "function", "function": {
    "name": "get_dhcp_leases",
    "description": "Get DHCP leases. Optionally filter by subnet address.",
    "parameters": {"type": "object",
      "properties": {"subnet": {"type": "string", "description": "Subnet prefix to filter, e.g. '192.168.100'"}}}
  }},
  {"type": "function", "function": {
    "name": "get_threat_feeds",
    "description": "Get security threat feed names and entry counts",
    "parameters": {"type": "object", "properties": {}}
  }},
  {"type": "function", "function": {
    "name": "get_audit_logs",
    "description": "Get recent audit log events",
    "parameters": {"type": "object",
      "properties": {"limit": {"type": "integer", "description": "Number of log entries, default 20"}}}
  }},
  {"type": "function", "function": {
    "name": "get_dns_analytics",
    "description": "Get top DNS clients by query count over a time range",
    "parameters": {"type": "object",
      "properties": {
        "days":  {"type": "integer", "description": "Time range in days, default 7"},
        "limit": {"type": "integer", "description": "Number of top clients, default 10"}
      }}
  }},
  {"type": "function", "function": {
    "name": "dossier_lookup",
    "description": "Threat-intel Dossier lookup for one indicator (domain or IP): returns maliciousness verdict, threat level, geo, whois, actor.",
    "parameters": {"type": "object", "required": ["indicator"],
      "properties": {"indicator": {"type": "string", "description": "A domain or IP address to look up, e.g. 'eicar.co' or '1.2.3.4'"}}}
  }},
  {"type": "function", "function": {
    "name": "lookalike_domains",
    "description": "List detected lookalike/typosquat domains targeting the protected brand.",
    "parameters": {"type": "object", "properties": {}}
  }},
  {"type": "function", "function": {
    "name": "asset_insights",
    "description": "Security-action asset inventory (devices seen in security actions in the last 30 days).",
    "parameters": {"type": "object", "properties": {}}
  }}
]`

// aiTools is the parsed tool schema, sent on every request. toolNames is the set
// of tool names used by cleanSuggestions to reject tool-name "suggestions"
// (_TOOL_NAMES, server.py:4086).
var (
	aiTools   []any
	toolNames map[string]bool
)

func init() {
	if err := json.Unmarshal([]byte(toolsJSON), &aiTools); err != nil {
		panic("ai: bad tool schema: " + err.Error())
	}
	toolNames = map[string]bool{}
	for _, t := range aiTools {
		m, _ := t.(map[string]any)
		fn, _ := m["function"].(map[string]any)
		if name, ok := fn["name"].(string); ok {
			toolNames[name] = true
		}
	}
}
