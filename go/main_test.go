package main

import (
	"errors"
	"testing"
)

func TestParsePortFlag(t *testing.T) {
	cases := []struct {
		name    string
		args    []string
		want    string
		wantErr bool
	}{
		{"absent", []string{}, "", false},
		{"space form", []string{"--port", "9090"}, "9090", false},
		{"equals form", []string{"--port=9090"}, "9090", false},
		{"short space form", []string{"-p", "9090"}, "9090", false},
		{"short equals form", []string{"-p=9090"}, "9090", false},
		{"invalid non-numeric", []string{"--port", "abc"}, "", true},
		{"invalid zero", []string{"--port", "0"}, "", true},
		{"invalid too large", []string{"--port", "70000"}, "", true},
		{"missing value", []string{"--port"}, "", true},
		{"unrelated args ignored", []string{"--foo", "bar"}, "", false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, err := parsePortFlag(c.args)
			if c.wantErr != (err != nil) {
				t.Fatalf("parsePortFlag(%v) err = %v, wantErr = %v", c.args, err, c.wantErr)
			}
			if got != c.want {
				t.Fatalf("parsePortFlag(%v) = %q, want %q", c.args, got, c.want)
			}
		})
	}
}

func TestIsAddrInUse(t *testing.T) {
	if isAddrInUse(nil) {
		t.Fatal("nil error should not be addr-in-use")
	}
	if !isAddrInUse(errors.New("listen tcp :8080: bind: address already in use")) {
		t.Fatal("expected unix-style message to match")
	}
	if !isAddrInUse(errors.New("Only one usage of each socket address (protocol/network address/port) is normally permitted.")) {
		t.Fatal("expected windows-style message to match")
	}
	if isAddrInUse(errors.New("some unrelated error")) {
		t.Fatal("unrelated error should not match")
	}
}
