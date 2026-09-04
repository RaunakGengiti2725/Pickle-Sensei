#!/usr/bin/env bash
# Linux replay of the Foundation-only part of native/vision-core:
# regenerate the shimmed contracts copy, then `swift test` (extra args pass
# through, e.g. `--filter Audit`). Exit code is swift test's.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
"$here/generate-contracts.sh"
cd "$here"
exec swift test "$@"
