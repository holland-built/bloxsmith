//go:build windows

// This file exists solely to host the go:generate directive that produces the
// Windows version-info resource (resource_windows_amd64.syso) from
// versioninfo.json via goversioninfo (github.com/josephspurrier/goversioninfo).
// `go build` auto-links any *_windows_*.syso file found next to main() — no
// import needed — so this file has no other content, and the `windows` build
// tag keeps it (and the generate directive) out of non-Windows builds entirely.
//
// SignPath requires signed Windows binaries to carry file-metadata attributes
// (ProductName, FileVersion, CompanyName, etc.) — this is how Go embeds them.
//
// Run manually (after `go install github.com/josephspurrier/goversioninfo/cmd/goversioninfo@latest`):
//	go generate ./...
//
// Wired into the release build: go/.goreleaser.yaml before.hooks runs both
// steps ahead of `go build` for the windows/amd64 target.
//
//go:generate goversioninfo -o=resource_windows_amd64.syso -64

package main
