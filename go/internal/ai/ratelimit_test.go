package ai

import (
	"errors"
	"strings"
	"testing"
)

// A 429 SPLIT BY WHICH LIMIT WAS HIT.
//
// The bodies below are VERBATIM captures from real Groq 429s (with the org id
// replaced). That matters: this whole change exists because the previous message
// said "Wait a moment and ask again" for a DAILY token cap, where waiting a moment
// is the one thing that cannot work — and an invented or paraphrased fixture would
// prove only that the parser agrees with whoever wrote the fixture.
//
// The rule being asserted throughout: a limit that will clear in seconds and a
// budget that is gone until tomorrow must never render the same way, and nothing
// that could not be read out of the provider's reply may be filled in.

// The exact body captured at 08:51:04 on 2026-07-30.
const realTPD = `chat/completions: http 429: {"error":{"message":"Rate limit reached for model ` +
	"`llama-3.3-70b-versatile`" + ` in organization ` + "`org_REDACTED`" + ` service tier ` +
	"`on_demand`" + ` on tokens per day (TPD): Limit 100000, Used 98902, Requested 1779. ` +
	`Please try again in 9m48.384s. Need more tokens? Upgrade to Dev Tier today at https`

func TestRateLimitDailyTokenCapSaysRetryingWillNotWork(t *testing.T) {
	got := rateLimitDetail(realTPD)

	// The three facts an operator needs and previously had none of.
	if !strings.Contains(got, "daily token") {
		t.Fatalf("does not name WHICH limit: %q", got)
	}
	if !strings.Contains(got, "9m48.384s") {
		t.Fatalf("does not carry the provider's own wait figure: %q", got)
	}
	if !strings.Contains(got, "will not work") {
		t.Fatalf("does not say that asking again will not work: %q", got)
	}

	// The regression that matters: the old advice must be gone. "Wait a moment and
	// ask again" against an exhausted daily budget sent the operator to do the one
	// thing that cannot succeed.
	if strings.Contains(got, "Wait a moment and ask again") {
		t.Fatalf("still gives the old wait-a-moment advice on a DAILY cap: %q", got)
	}
}

// A per-minute throttle needs the OPPOSITE advice, so it must not share wording
// with the daily case.
func TestRateLimitPerMinuteStillSaysToRetry(t *testing.T) {
	tpm := `chat/completions: http 429: {"error":{"message":"Rate limit reached for model x ` +
		`on tokens per minute (TPM): Limit 6000, Used 5900, Requested 500. Please try again in 3.5s."}}`
	got := rateLimitDetail(tpm)

	if !strings.Contains(got, "per-minute token") {
		t.Fatalf("does not name the per-minute limit: %q", got)
	}
	if !strings.Contains(got, "3.5s") {
		t.Fatalf("does not carry the wait: %q", got)
	}
	// It must NOT tell the operator that retrying is futile — here it is not.
	if strings.Contains(got, "will not work") {
		t.Fatalf("tells the operator retrying is futile on a PER-MINUTE limit: %q", got)
	}
	// And it must not claim this is the daily budget.
	if strings.Contains(got, "daily budget") {
		t.Fatalf("describes a per-minute throttle as the daily budget: %q", got)
	}
}

func TestRateLimitRequestCapsAreNamedToo(t *testing.T) {
	for _, tc := range []struct{ body, want string }{
		{`http 429: on requests per day (RPD): Limit 1000. Please try again in 2h1m0s.`, "daily request"},
		{`http 429: on requests per minute (RPM): Limit 30. Please try again in 20s.`, "per-minute request"},
	} {
		got := rateLimitDetail(tc.body)
		if !strings.Contains(got, tc.want) {
			t.Fatalf("body %q -> %q, want it to name %q", tc.body, got, tc.want)
		}
	}
}

// NOTHING INVENTED. An unreadable body must say so, not fill in a plausible wait.
// A fabricated "try again in 5 minutes" is worse than no figure: it is a number the
// operator would plan around.
func TestRateLimitUnparseableBodyInventsNothing(t *testing.T) {
	for _, body := range []string{
		"chat/completions: http 429",
		`chat/completions: http 429: {"error":{"message":"Too Many Requests"}}`,
		"chat/completions: http 429: <html>502 from a proxy</html>",
	} {
		got := rateLimitDetail(body)
		if !strings.Contains(got, "could not be read") {
			t.Fatalf("body %q -> %q, want it to admit the details were unreadable", body, got)
		}
		// No limit type and no duration may appear from nowhere.
		for _, invented := range []string{"daily", "per-minute", "try again in "} {
			if strings.Contains(got, invented) {
				t.Fatalf("body %q produced an invented %q: %q", body, invented, got)
			}
		}
	}
}

// A daily cap with no stated wait must still say retrying is futile — the missing
// figure is not a reason to fall back to "wait a moment".
func TestRateLimitDailyWithNoWaitStillWarnsRetryingIsFutile(t *testing.T) {
	got := rateLimitDetail(`http 429: on tokens per day (TPD): Limit 100000, Used 100000.`)
	if !strings.Contains(got, "will not work") {
		t.Fatalf("does not warn retrying is futile: %q", got)
	}
	if !strings.Contains(got, "did not say for how long") {
		t.Fatalf("does not admit the wait was absent: %q", got)
	}
	if strings.Contains(got, "try again in ") {
		t.Fatalf("invented a wait: %q", got)
	}
}

// A wait with no recognisable limit name: report the wait, name nothing.
func TestRateLimitWaitWithoutKnownLimitNamesNoLimit(t *testing.T) {
	got := rateLimitDetail(`http 429: slow down. Please try again in 45s.`)
	if !strings.Contains(got, "45s") {
		t.Fatalf("dropped the wait: %q", got)
	}
	for _, invented := range []string{"daily", "per-minute"} {
		if strings.Contains(got, invented) {
			t.Fatalf("invented a limit type %q: %q", invented, got)
		}
	}
}

// The awkward real durations observed in the live capture. A stricter pattern
// silently drops these and leaves the operator with no idea how long to wait —
// which is the failure this parser exists to remove.
func TestRateLimitParsesTheAwkwardRealDurations(t *testing.T) {
	for _, d := range []string{"9m48.384s", "18m34.56s", "7m11.135999999s", "4m20.928s", "2h1m0s", "45s", "3.5s"} {
		body := "http 429: on tokens per day (TPD): Limit 100000. Please try again in " + d + ". Upgrade"
		got := rateLimitDetail(body)
		if !strings.Contains(got, d) {
			t.Fatalf("duration %q was not carried through: %q", d, got)
		}
	}
}

// The 429 must still route through providerFailure — the switch above it decides
// which status this is, and a mis-route would send a rate limit to the generic
// "could not reach the provider" branch.
func TestProviderFailureRoutes429ToTheDetailedMessage(t *testing.T) {
	got := providerFailure(errors.New(realTPD))
	if !strings.Contains(got, "daily token") || !strings.Contains(got, "9m48.384s") {
		t.Fatalf("providerFailure did not use the detailed 429 message: %q", got)
	}
}

// The other statuses must be untouched by this change.
func TestProviderFailureOtherStatusesUnchanged(t *testing.T) {
	for _, tc := range []struct{ body, want string }{
		{"chat/completions: http 400: Failed to call a function", "tool-calling"},
		{"chat/completions: http 401: bad key", "refused the key"},
		{"chat/completions: http 404: no such model", "does not recognise the configured model"},
		{"chat/completions: http 503: upstream down", "server error"},
		{"dial tcp: connection refused", "could not reach the AI provider"},
	} {
		got := providerFailure(errors.New(tc.body))
		if !strings.Contains(got, tc.want) {
			t.Fatalf("body %q -> %q, want %q", tc.body, got, tc.want)
		}
	}
}
