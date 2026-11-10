package dashboard

import (
	"encoding/json"
	"strings"
	"testing"
)

// fakeTSIG stands in for the live TSIG key every DNS sample carried. It is
// made up; the real ones never go in the repo.
const fakeTSIG = "test-only-not-a-real-tsig"

// hostConfigReply builds a tool reply shaped like the live samples
// (hostcfg_*.json, 2026-11-10): metadata plus a files map of file name to text.
func hostConfigReply(t *testing.T, files map[string]string) string {
	t.Helper()
	b, err := json.Marshal(map[string]any{
		"ophid": "96d9195bd3a4a56368520a0091a72623", "platform": "nios-x",
		"config_type": "dns", "variant": "default", "version": "v4.5",
		"source": "config-cache", "selection_reason": "s3://internal/path",
		"retrieved_at": "2026-11-10T09:48:09Z", "files": files,
	})
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestHostConfigHidesTSIGSecret(t *testing.T) {
	named := "key \"bind-key\" {\n    algorithm hmac-sha256;\n    secret \"" + fakeTSIG + "\";\n};\n\n" +
		"options {\n    session-keyfile \"/var/run/named/session.key\";\n};\n" +
		"trust-anchors {\n    \".\" initial-key 257 3 8 \"AwEAAagAIKlVZrpC\";\n};\n"
	got := parseHostConfig(hostConfigReply(t, map[string]string{"named.conf": named}))
	out, _ := json.Marshal(got)
	if strings.Contains(string(out), fakeTSIG) {
		t.Fatalf("TSIG secret reached the reply: %s", out)
	}
	if strings.Contains(string(out), "s3://") {
		t.Fatalf("internal storage path reached the reply: %s", out)
	}
	if got["status"] != "ok" || got["hidden"] != 1 {
		t.Fatalf("status=%v hidden=%v, want ok and 1", got["status"], got["hidden"])
	}
	text := got["files"].([]any)[0].(map[string]any)["text"].(string)
	for _, keep := range []string{`secret "(hidden)";`, "algorithm hmac-sha256;", "/var/run/named/session.key", "AwEAAagAIKlVZrpC"} {
		if !strings.Contains(text, keep) {
			t.Errorf("redacted text lost %q:\n%s", keep, text)
		}
	}
}

func TestRedactConfigKinds(t *testing.T) {
	cases := []struct{ name, in, secret, keep string }{
		{"bind unquoted", "key k { secret abc123def; };", "abc123def", "secret \"(hidden)\""},
		{"bind password", "password \"hunter2\";", "hunter2", "password \"(hidden)\""},
		{"kea tsig", `"tsig-keys": [{"name": "k", "algorithm": "HMAC-SHA256", "secret": "c2VjcmV0"}]`, "c2VjcmV0", `"secret": "(hidden)"`},
		{"kea login", `"clients": [{"user": "admin", "password": "p@ss\"word"}]`, "p@ss", `"password": "(hidden)"`},
		{"kea secret file stays", `"secret-file": "/etc/kea/tsig.key"`, "", "/etc/kea/tsig.key"},
	}
	for _, c := range cases {
		out, _ := RedactConfig(c.in)
		if c.secret != "" && strings.Contains(out, c.secret) {
			t.Errorf("%s: secret survived: %s", c.name, out)
		}
		if !strings.Contains(out, c.keep) {
			t.Errorf("%s: want %q in %s", c.name, c.keep, out)
		}
	}
}

func TestHostConfigNoConfigIsEmptyNotError(t *testing.T) {
	// The tool's reply for a NIOS grid member, seen live 2026-11-10.
	got := parseHostConfig("none of [named.conf] present under s3://bucket/path/")
	if got["status"] != "empty" {
		t.Fatalf("status = %v, want empty", got["status"])
	}
	if out, _ := json.Marshal(got); strings.Contains(string(out), "s3://") {
		t.Fatalf("storage path leaked: %s", out)
	}
	if bad := parseHostConfig("permission denied"); bad["status"] != "error" || strings.Contains(bad["reason"].(string), "denied") {
		t.Fatalf("unexpected reply should be a plain error, got %v", bad)
	}
}

func TestValidOphid(t *testing.T) {
	for _, ok := range []string{"96d9195bd3a4a56368520a0091a72623", "96D9195BD3A4A56368520A0091A72623"} {
		if !ValidOphid(ok) {
			t.Errorf("ValidOphid(%q) = false", ok)
		}
	}
	for _, bad := range []string{"", "96d9195bd3a4a56368520a0091a7262", "96d9195bd3a4a56368520a0091a726233",
		"96d9195bd3a4a56368520a0091a7262g", "96d9195bd3a4a56368520a0091a7262\n", "../../etc/passwd"} {
		if ValidOphid(bad) {
			t.Errorf("ValidOphid(%q) = true", bad)
		}
	}
}

func TestWithHostConfigKeys(t *testing.T) {
	raw := []any{map[string]any{"display_name": "g", "ophid": "4cddc25663851bf076b51609af0e5d2b", "host_type": "6"}}
	rows := withHostConfigKeys(normHosts(raw), raw)
	if rows[0]["ophid"] != "4cddc25663851bf076b51609af0e5d2b" || rows[0]["host_type"] != "6" {
		t.Fatalf("row = %v", rows[0])
	}
}
