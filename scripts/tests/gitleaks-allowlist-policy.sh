#!/usr/bin/env bash
# Regression test: .gitleaks.toml must not exempt whole files from the scan.
#   1. An [[allowlists]] entry that names both `paths` and `regexes` must set
#      condition = "AND"; gitleaks evaluates the two with OR by default, so the
#      `paths` half alone silences every finding in those files.
#   2. Such an entry must also name `targetRules`: gitleaks `dir` mode (the
#      --tree scan) skips a file matched by a GLOBAL path allowlist before any
#      rule runs, whatever `condition` says, so only rule-scoped entries are
#      evaluated per finding in both scan modes.
#   3. An entry with `paths` but no `regexes` exempts whole files. That is only
#      acceptable for a directory pattern (ends in `/`) that git ignores
#      repo-wide — anything else (a file name, an extension, a directory that
#      can be committed) hides a committed secret from both scan modes.
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


def gitignored_dir(pattern):
    """True when the directory pattern maps to a path git ignores repo-wide."""
    sample = re.sub(r"^\(\?:\^\|/\)", "", pattern)
    sample = re.sub(r"\[\^/\][*+?]?", "", sample)
    sample = re.sub(r"\\(.)", r"\1", sample)
    if re.search(r"[\[\](){}|*+?^$]", sample):
        return False, f"pattern {pattern!r} is too complex to map to a gitignore check"
    probe = f"{sample}x"
    ignored = subprocess.run(["git", "check-ignore", "-q", probe], check=False).returncode == 0
    if not ignored:
        return False, f"{probe!r} is not gitignored repo-wide"
    return True, ""


violations = []
for index, entry in enumerate(config.get("allowlists", [])):
    label = f'allowlists[{index}] "{entry.get("description", "?")}"'
    paths = entry.get("paths", [])
    regexes = entry.get("regexes", [])
    if not paths:
        continue
    if regexes:
        if entry.get("condition") != "AND":
            violations.append(f'{label}: combines paths+regexes without condition = "AND" (OR silences the whole file)')
        if not entry.get("targetRules"):
            violations.append(f"{label}: path-scoped allowlist without targetRules (global path allowlists skip the whole file in dir mode)")
        continue
    for pattern in paths:
        if not pattern.endswith("/"):
            violations.append(f"{label}: paths-only pattern {pattern!r} exempts whole files from the scan")
            continue
        ok, why = gitignored_dir(pattern)
        if not ok:
            violations.append(f"{label}: paths-only directory pattern {pattern!r} is allowlisted but {why}")

for violation in violations:
    print(f"[gitleaks-allowlist-policy] VIOLATION: {violation}", file=sys.stderr)
if violations:
    print(f"[gitleaks-allowlist-policy] FAIL: {len(violations)} violation(s)", file=sys.stderr)
    sys.exit(1)
print("[gitleaks-allowlist-policy] PASS: no whole-file allowlists", file=sys.stderr)
EOF
