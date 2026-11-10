#!/usr/bin/env bash
# Prints the tag of the newest release that has FINISHED publishing: not a
# draft or prerelease, published at least MIN_AGE_MIN minutes ago (default 15),
# and carrying checksums.txt with both signature files fully uploaded.
#
# Why: the install-sh and install-ps1 jobs used to install `latest`, and a
# release is cut on every merge. A job that ran while one was still uploading
# fetched checksums.txt from one release and its signature from another, and
# failed with "RELEASE SIGNATURE DOES NOT VERIFY" (job 129793242367, v3.134.0
# published inside the job's 30 seconds). A release that is 15 minutes old is
# still a real published release, just not one that is half uploaded.
#
# Needs GITHUB_TOKEN (the API is rate limited without it), curl and jq.
set -euo pipefail

MIN_AGE_MIN="${MIN_AGE_MIN:-15}"
cutoff=$(( $(date -u +%s) - MIN_AGE_MIN * 60 ))

json="$(curl -fsSL --retry 3 --retry-all-errors --retry-delay 5 \
  -H "Authorization: Bearer ${GITHUB_TOKEN}" \
  -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/holland-built/bloxsmith/releases?per_page=30")"

tag="$(jq -r --argjson cutoff "$cutoff" '
  def has_asset($n): any(.assets[]; .name == $n and .state == "uploaded");
  [ .[]
    | select(.draft == false and .prerelease == false and .published_at != null)
    | select((.published_at | fromdateiso8601) <= $cutoff)
    | select(has_asset("checksums.txt") and has_asset("checksums.txt.sshsig")
             and has_asset("checksums.txt.ed25519"))
  ] | sort_by(.published_at) | last | .tag_name // empty' <<<"$json")"

if [ -z "$tag" ]; then
  echo "settled-release: no release is at least ${MIN_AGE_MIN} minutes old with its signatures" >&2
  exit 1
fi
echo "$tag"
