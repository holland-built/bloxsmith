module bloxsmith

// Raised from 1.26.3 to 1.26.6 on 2026-08-14. Not housekeeping: govulncheck
// went red on master with four REACHABLE standard-library advisories —
// GO-2026-6218 (net/url), GO-2026-6090 (crypto/tls), GO-2026-6089 (net/http)
// and GO-2026-5972 — every one of them "Fixed in ...@go1.26.6". `go-version:
// '1.26.x'` in both workflows resolves to the newest patch, but the jobs run
// with GOTOOLCHAIN=local, so the version named HERE is the one that decides.
// Leaving this at 1.26.3 meant the toolchain fix could never arrive.
go 1.26.6

require (
	github.com/fernet/fernet-go v0.0.0-20240119011108-303da6aec611
	github.com/kardianos/service v1.3.0
	github.com/minio/selfupdate v0.6.0
	golang.org/x/crypto v0.54.0
	golang.org/x/term v0.45.0
	gopkg.in/yaml.v3 v3.0.1
)

require (
	aead.dev/minisign v0.3.0 // indirect
	golang.org/x/sys v0.47.0 // indirect
)
