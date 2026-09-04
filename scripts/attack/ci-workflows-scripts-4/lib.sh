#!/usr/bin/env bash
# Shared helpers for the ci-workflows-scripts adversarial pass 4.
#
# Every scenario script sources this file, runs its attack against the
# checked-out commit, and records one verdict line per assertion:
#   HELD    <scenario> <assertion>   the gate behaved as documented
#   BROKEN  <scenario> <assertion>   reproducible failure (finding)
# Verdicts are appended to $ATTACK_EVIDENCE/verdicts.tsv and echoed. A scenario
# exits non-zero when any assertion is BROKEN so `run.sh` can aggregate.
#
# Nothing here modifies production code: scratch edits happen in throwaway
# `git worktree`s or are reverted by an EXIT trap.
set -uo pipefail

ATTACK_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$ATTACK_ROOT/../../.." && pwd)"
ATTACK_EVIDENCE="${ATTACK_EVIDENCE:-$REPO_ROOT/artifacts/attack-ci-workflows-scripts-4}"
mkdir -p "$ATTACK_EVIDENCE"
VERDICTS="$ATTACK_EVIDENCE/verdicts.tsv"

SCENARIO="${SCENARIO:-$(basename "${BASH_SOURCE[1]:-unknown}" .sh)}"
BROKEN_COUNT=0

if [ -d "$HOME/.deno/bin" ]; then
  export PATH="$HOME/.deno/bin:$PATH"
fi

log() { printf '[%s] %s\n' "$SCENARIO" "$*" >&2; }

verdict() {
  # verdict <HELD|BROKEN> <assertion> [detail]
  local status="$1" assertion="$2" detail="${3:-}"
  printf '%s\t%s\t%s\t%s\n' "$status" "$SCENARIO" "$assertion" "$detail" >>"$VERDICTS"
  printf '%-6s %s — %s%s\n' "$status" "$SCENARIO" "$assertion" "${detail:+ ($detail)}"
  [ "$status" = BROKEN ] && BROKEN_COUNT=$((BROKEN_COUNT + 1))
  return 0
}

# assert_eq <assertion> <expected> <actual>
assert_eq() {
  if [ "$2" = "$3" ]; then
    verdict HELD "$1" "got '$3'"
  else
    verdict BROKEN "$1" "expected '$2', got '$3'"
  fi
}

# assert_ne <assertion> <unexpected> <actual>
assert_ne() {
  if [ "$2" != "$3" ]; then
    verdict HELD "$1" "got '$3'"
  else
    verdict BROKEN "$1" "unexpectedly got '$3'"
  fi
}

# assert_grep <assertion> <pattern> <file>
assert_grep() {
  if grep -Eq -- "$2" "$3"; then
    verdict HELD "$1" "'$2' present in $(basename "$3")"
  else
    verdict BROKEN "$1" "'$2' absent from $3"
  fi
}

# assert_not_grep <assertion> <pattern> <file>
assert_not_grep() {
  if grep -Eq -- "$2" "$3"; then
    verdict BROKEN "$1" "'$2' present in $3"
  else
    verdict HELD "$1" "'$2' absent from $(basename "$3")"
  fi
}

finish() {
  if [ "$BROKEN_COUNT" -gt 0 ]; then
    log "$BROKEN_COUNT BROKEN assertion(s)"
    exit 1
  fi
  log "all assertions HELD"
  exit 0
}

# scratch_worktree <name> -> prints a path to a fresh detached worktree of HEAD.
# Caller must `remove_worktree <path>` (usually from an EXIT trap).
scratch_worktree() {
  local dir
  dir="$(mktemp -d "${TMPDIR:-/tmp}/attack-$1-XXXXXX")"
  git -C "$REPO_ROOT" worktree add --detach -q "$dir" HEAD >/dev/null
  printf '%s' "$dir"
}

remove_worktree() {
  git -C "$REPO_ROOT" worktree remove --force "$1" >/dev/null 2>&1 || rm -rf "$1"
  git -C "$REPO_ROOT" worktree prune >/dev/null 2>&1 || true
}

# summary_field <summary.json> <jq filter>
summary_field() {
  node -e '
const fs = require("fs");
const s = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const path = process.argv[2].split(".").filter(Boolean);
let v = s;
for (const p of path) v = v?.[p];
process.stdout.write(typeof v === "object" ? JSON.stringify(v) : String(v));
' "$1" "$2"
}

# stage_status <summary.json> <stage>
stage_status() {
  node -e '
const fs = require("fs");
const s = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const st = s.stages.find((x) => x.name === process.argv[2]);
process.stdout.write(st ? st.status : "missing");
' "$1" "$2"
}
