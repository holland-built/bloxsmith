package main

import (
	"os"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

// WHAT THE DEPLOYMENT DOCS SAY ABOUT THE COMPOSE FILE, CHECKED AGAINST THE
// COMPOSE FILE.
//
// docs/DEPLOYMENT.md stated "docker-compose.yml defines no healthcheck" as the
// premise of its rollback section while the compose file had defined one for
// some time, and docs/SHIP.md said the opposite in the same docs tree (#100). An
// operator reading the file named DEPLOYMENT got the wrong answer, and the
// symptom was silence: nobody re-reads a paragraph they already believe.
//
// This asserts only the claims that can be settled by reading the compose file.
// It is not a review of DEPLOYMENT.md, and passing it says nothing about the
// rest of that document.

const deploymentDocPath = "../docs/DEPLOYMENT.md"

// composeHealthchecks is the compose surface this test needs: which services
// define a healthcheck at all.
type composeHealthchecks struct {
	Services map[string]struct {
		Healthcheck *struct {
			Test any `yaml:"test"`
		} `yaml:"healthcheck"`
	} `yaml:"services"`
}

func TestDeploymentDocAgreesWithComposeOnTheHealthcheck(t *testing.T) {
	cfb, err := os.ReadFile(composePath)
	if err != nil {
		t.Fatalf("read %s: %v", composePath, err)
	}
	var cf composeHealthchecks
	if err := yaml.Unmarshal(cfb, &cf); err != nil {
		t.Fatalf("parse %s: %v", composePath, err)
	}
	defined := false
	for _, s := range cf.Services {
		if s.Healthcheck != nil {
			defined = true
			break
		}
	}

	docb, err := os.ReadFile(deploymentDocPath)
	if err != nil {
		t.Fatalf("read %s: %v", deploymentDocPath, err)
	}
	// Flattened before matching, and BOTH halves of that were forced by a
	// mutation the first draft survived: the doc writes
	// "`docker-compose.yml` **does** define a healthcheck", so a plain search is
	// defeated by the emphasis markers — and the sentence is hard-wrapped, so
	// "does define a healthcheck" straddles a newline. A prose assertion that
	// depends on where a paragraph happens to wrap is not an assertion.
	doc := strings.Join(strings.Fields(
		strings.NewReplacer("*", "", "`", "", "_", "").Replace(strings.ToLower(string(docb)))), " ")

	// The denial, in the wordings a rewrite would plausibly reach for. Matched
	// only when the compose file contradicts it — if the healthcheck is ever
	// deliberately removed, saying so becomes correct and this must not block it.
	denials := []string{
		"defines no healthcheck",
		"does not define a healthcheck",
		"no healthcheck",
		"without a healthcheck",
	}
	if defined {
		for _, d := range denials {
			if strings.Contains(doc, d) {
				t.Fatalf("%s says %q, but %s defines one. That sentence was the premise of the "+
					"rollback section for several releases while docs/SHIP.md said the opposite (#100).",
					deploymentDocPath, d, composePath)
			}
		}
		return
	}
	// The other direction: no probe, but the doc describes one. Same failure,
	// pointing the other way.
	if strings.Contains(doc, "does define a healthcheck") {
		t.Fatalf("%s describes a healthcheck that %s no longer defines", deploymentDocPath, composePath)
	}
}
