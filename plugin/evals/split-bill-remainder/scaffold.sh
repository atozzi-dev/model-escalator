#!/usr/bin/env bash
# Creates the run's working folder from this case's project/ and hidden/ (see ../_harness/setup.mjs).
set -euo pipefail
script="${BASH_SOURCE[0]}"
case "$script" in
  */* | *\\*) dir="${script%[/\\]*}" ;;
  *) dir=. ;;
esac
here="$(cd "$dir" && pwd)"
if command -v cygpath >/dev/null 2>&1; then here="$(cygpath -m "$here")"; fi
exec node "$here/../_harness/setup.mjs" "$here"
