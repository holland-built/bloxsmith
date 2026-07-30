package audit

import "fmt"

// THE THREE STATES, IN CODE RATHER THAN IN PROSE.
//
// Verify() returns a map, and every consumer used to re-derive the verdict from
// its fields: valid true, or valid false with broken_index set, or valid false
// with broken_index nil and verify_error set. That is three places (the log API,
// the export API, and now an offline verifier) each independently reading the
// same tri-state out of a bag of keys, which is how a fourth state gets invented
// by accident — the first consumer to write `if !valid { "tampered" }` collapses
// "could not check" into "forged", which is a fabricated accusation.
//
// So the classification lives here, once, and the type has exactly three values.
// Adding a fourth means adding a constant, in this file, deliberately.
type Verdict string

const (
	// Intact: the chain was read in full and everything checked out. An empty
	// readable log counts as intact.
	Intact Verdict = "intact"
	// Tampered: something in the chain does not match what it should. This is an
	// accusation and is only ever returned when the check actually ran.
	Tampered Verdict = "tampered"
	// CouldNotVerify: the chain could NOT be checked, so no verdict on tampering
	// can be made. A missing key, a rotated key, an unreadable log. This must
	// never collapse into either of the other two.
	CouldNotVerify Verdict = "could-not-verify"
)

// Classify reduces a Verify() result to exactly one of the three states, plus a
// one-line human reason.
//
// The order of the checks is the contract: verify_error is consulted BEFORE
// valid, because a result carrying a verify_error is by definition one where
// nothing was proven, and reading `valid: false` first would report it as
// tampering.
func Classify(res map[string]any) (Verdict, string) {
	if res == nil {
		return CouldNotVerify, "no verification result was produced at all"
	}
	if e, ok := res["verify_error"].(string); ok && e != "" {
		return CouldNotVerify, e
	}
	if ok, _ := res["valid"].(bool); ok {
		return Intact, ""
	}
	reason, _ := res["broken_reason"].(string)
	if reason == "" {
		reason = "the chain does not verify"
	}
	if idx, ok := res["broken_index"]; ok && idx != nil {
		return Tampered, fmt.Sprintf("%s (entry #%v)", reason, idx)
	}
	// valid:false, no broken_index and no verify_error. Nothing produces this
	// today; if something ever does, it is an unproven result, not an accusation.
	return CouldNotVerify, "the chain reported neither a verified result nor a specific fault: " + reason
}
