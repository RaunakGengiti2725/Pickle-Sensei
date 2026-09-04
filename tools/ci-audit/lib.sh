# shellcheck shell=bash
# Shared helpers for the CI/CD audit harness (tools/ci-audit/*).
# Sourced, never executed. Every helper is side-effect free except where named.

# Lives inside .git so it is neither tracked nor swept by `git clean`.
CI_AUDIT_MARKER=".git/ci-audit-scratch"

ca_now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

ca_json_escape() {
  local s=$1
  s=${s//\\/\\\\}
  s=${s//\"/\\\"}
  s=${s//$'\n'/\\n}
  s=${s//$'\t'/\\t}
  printf '%s' "$s"
}

# ca_die <msg> — print to stderr and exit 2 (harness misuse, not a finding).
ca_die() { echo "ci-audit: $*" >&2; exit 2; }

# ca_assert_scratch <dir> — refuse to run destructive git operations anywhere
# but a directory this harness created (marker file present, not the source repo).
ca_assert_scratch() {
  local dir=$1
  [ -n "$dir" ] || ca_die "scratch dir is empty"
  [ -f "$dir/$CI_AUDIT_MARKER" ] || ca_die "refusing: $dir has no $CI_AUDIT_MARKER marker"
  [ "$(cd "$dir" && pwd -P)" != "$(cd "${CI_AUDIT_SOURCE_REPO:-/nonexistent}" 2>/dev/null && pwd -P)" ] \
    || ca_die "refusing: scratch dir is the source repo"
}

# ca_reset_scratch <dir> <sha> — return a scratch clone to a pristine checkout of <sha>.
# Untracked files created by a scenario are removed; ignored files (node_modules,
# artifacts) are kept so scenarios stay fast.
ca_reset_scratch() {
  local dir=$1 sha=$2
  ca_assert_scratch "$dir"
  git -C "$dir" reset -q --hard "$sha"
  git -C "$dir" clean -qfd
}

# ca_stage_status <summary.json> <stage> — prints the recorded status or "absent".
ca_stage_status() {
  local summary=$1 stage=$2
  [ -f "$summary" ] || { echo absent; return; }
  jq -r --arg s "$stage" '.stages[] | select(.name==$s) | .status' "$summary" 2>/dev/null | head -1 | grep . || echo absent
}

# ca_summary_ok <summary.json> — prints true/false/absent/invalid.
ca_summary_ok() {
  local summary=$1
  [ -f "$summary" ] || { echo absent; return; }
  jq -r '.ok' "$summary" 2>/dev/null || echo invalid
}

# ca_json_valid <file> — exit 0 iff the file parses as JSON.
ca_json_valid() { jq -e . "$1" >/dev/null 2>&1; }
