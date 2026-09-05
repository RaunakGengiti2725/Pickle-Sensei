#!/usr/bin/env bash
# Regression test: .gitleaks.toml must not exempt whole files from the scan.
#   1. An [[allowlists]] entry that names both `paths` and `regexes` must set
#      condition = "AND"; gitleaks evaluates the two with OR by default, so the
#      `paths` half alone silences every finding in those files.
#   2. A `paths` pattern that covers an entire directory (ends in `/`) is only
#      acceptable when git ignores that directory repo-wide — otherwise a
#      committed secret under it is never scanned.
#   scripts/tests/gitleaks-allowlist-policy.sh
# Exit 0 = policy holds; 1 = violation; 2 = setup failure.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CONFIG="$REPO_ROOT/.gitleaks.toml"

log() { printf '[gitleaks-allowlist-policy] %s\n' "$*" >&2; }
die() {
  log "SETUP ERROR: $*"
  exit 2
}

[ -f "$CONFIG" ] || die "missing $CONFIG"
command -v python3 >/dev/null 2>&1 || die "python3 is required"
python3 -c 'import tomllib' 2>/dev/null || die "python3 >= 3.11 (tomllib) is required"

cd "$REPO_ROOT"
python3 - "$CONFIG" <<'EOF'
import re
import subprocess
import sys
import tomllib

config_path = sys.argv[1]
with open(config_path, "rb") as fh:
    config = tomllib.load(fh)

violations = []
for index, entry in enumerate(config.get("allowlists", [])):
    label = f'allowlists[{index}] "{entry.get("description", "?")}"'
    paths = entry.get("paths", [])
    if paths and entry.get("regexes") and entry.get("condition") != "AND":
        violations.append(f'{label}: combines paths+regexes without condition = "AND" (OR silences the whole file)')
    for pattern in paths:
        if not pattern.endswith("/"):
            continue
        sample = re.sub(r"^\(\?:\^\|/\)", "", pattern)
        sample = re.sub(r"\[\^/\][*+?]?", "", sample)
        sample = re.sub(r"\\(.)", r"\1", sample)
        if re.search(r"[\[\](){}|*+?]", sample):
            violations.append(f"{label}: directory pattern {pattern!r} is too complex to map to a gitignore check")
            continue
        probe = f"{sample}x"
        ignored = subprocess.run(["git", "check-ignore", "-q", probe], check=False).returncode == 0
        if not ignored:
            violations.append(f"{label}: directory pattern {pattern!r} is allowlisted but {probe!r} is not gitignored repo-wide")

for violation in violations:
    print(f"[gitleaks-allowlist-policy] VIOLATION: {violation}", file=sys.stderr)
if violations:
    print(f"[gitleaks-allowlist-policy] FAIL: {len(violations)} violation(s)", file=sys.stderr)
    sys.exit(1)
print("[gitleaks-allowlist-policy] PASS: no whole-file allowlists", file=sys.stderr)
EOF
