package demo

import (
	"regexp"
	"testing"
)

// The step list is shown on the Demo server page, so it uses plain words
// (GUI audit E8): no "VM", no "join token".
func TestStepsSayItInPlainWords(t *testing.T) {
	jargon := regexp.MustCompile(`\bVM\b|join token`)
	for _, s := range Steps {
		if jargon.MatchString(s.Says) {
			t.Errorf("step %q says %q", s.ID, s.Says)
		}
	}
}
