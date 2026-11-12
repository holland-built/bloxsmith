package dashboard

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"testing"
)

// TestMCPToolsDoc_NamesEveryTool keeps the "Infoblox AI connection (MCP)"
// section of docs/TABS.md in step with Infoblox's list of MCP actions, as saved
// in scripts/out_tools.json. That file is refreshed from the live list (the
// mcp-drift workflow), so when Infoblox adds or removes an action the refresh
// fails here until the section names it and states the new total. Whether an
// action sits under "used" or "not used" is not checked: that is a reading of
// the code, done by hand when the section is edited.
func TestMCPToolsDoc_NamesEveryTool(t *testing.T) {
	raw, err := os.ReadFile("../../../scripts/out_tools.json")
	if err != nil {
		t.Fatal(err)
	}
	var tools []struct {
		Name string `json:"name"`
	}
	if err := json.Unmarshal(raw, &tools); err != nil {
		t.Fatal(err)
	}
	if len(tools) == 0 {
		t.Fatal("scripts/out_tools.json lists no tools")
	}
	doc, err := os.ReadFile("../../../docs/TABS.md")
	if err != nil {
		t.Fatal(err)
	}
	const heading = "### Infoblox AI connection (MCP)"
	_, section, found := strings.Cut(string(doc), heading)
	if !found {
		t.Fatalf("docs/TABS.md has no %q section", heading)
	}
	if end := strings.Index(section, "\n## "); end >= 0 {
		section = section[:end]
	}
	if want := fmt.Sprintf("Infoblox offers %d actions", len(tools)); !strings.Contains(section, want) {
		t.Errorf("the section should say %q, matching scripts/out_tools.json", want)
	}
	for _, tool := range tools {
		if !strings.Contains(section, "`"+tool.Name+"`") {
			t.Errorf("Infoblox action %s is not in docs/TABS.md's %q section; add it to the used table or the not-used list", tool.Name, heading)
		}
	}
}
