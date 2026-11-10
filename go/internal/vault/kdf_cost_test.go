package vault

import (
	"os"
	"testing"
)

// realKDF is the production scrypt table, captured before TestMain swaps it.
var realKDF = kdfByVersion

// cheapKDF is what every vault test derives with unless it opts back into the
// real table. At N=2^17 under -race one derive took about 2.7s, and nearly every
// test here derives at least once, which made this package the slowest step of
// CI (audit/tests.md #1). The two rows keep different costs so that a file
// sealed under one version still cannot be opened with the other's key.
//
// This is set only from a _test.go file, so no build and no environment
// variable can make a real vault use it.
var cheapKDF = map[int]kdfParams{
	1: {N: 1 << 4, R: 8, P: 1, KeyLen: 32},
	2: {N: 1 << 5, R: 8, P: 1, KeyLen: 32},
}

func TestMain(m *testing.M) {
	kdfByVersion = cheapKDF
	os.Exit(m.Run())
}

// useRealKDF puts the production scrypt table back for one test. Every test
// that reads a legacy file, migrates one, or checks the parameters themselves
// calls it, because those are the tests whose meaning depends on the real
// numbers. None of the vault tests run in parallel, so the swap is safe.
func useRealKDF(t *testing.T) {
	t.Helper()
	kdfByVersion = realKDF
	t.Cleanup(func() { kdfByVersion = cheapKDF })
}
