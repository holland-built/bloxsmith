terraform {
  required_providers {
    bloxone = { source = "infobloxopen/bloxone", version = "1.6.0" }
  }
}
# Key and URL come from the environment (BLOXONE_API_KEY, BLOXONE_CSP_URL), never from a file here.
provider "bloxone" {}
