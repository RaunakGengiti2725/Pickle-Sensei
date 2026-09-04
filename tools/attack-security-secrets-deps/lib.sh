#!/usr/bin/env bash
# Shared helpers for the security-secrets-deps attack harnesses.
#
# Every scenario script sources this file, writes its logs under $OUT, and
# finishes with `verdict`. A scenario exits 0 only when EVERY protection it
# probes HELD; any BROKEN check makes it exit 1 so the scripts double as
# regression tests once the gaps are fixed.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCENARIO="${SCENARIO:-$(basename "$0" .sh)}"
OUT="${ATTACK_ARTIFACTS:-$REPO_ROOT/artifacts/attack-security-secrets-deps}/$SCENARIO"
mkdir -p "$OUT"
export REPO_ROOT SCENARIO OUT

BROKEN=0
HELD=0
RESULTS=()

log() { printf '[%s] %s\n' "$SCENARIO" "$*" >&2; }

# record <HELD|BROKEN> <check-id> <exit-code> <artifact> <one-line summary>
record() {
  local status="$1" id="$2" code="$3" artifact="$4" summary="$5"
  RESULTS+=("$status|$id|exit=$code|$artifact|$summary")
  if [ "$status" = HELD ]; then HELD=$((HELD + 1)); else BROKEN=$((BROKEN + 1)); fi
  log "$status  $id  exit=$code  $artifact  — $summary"
}

# run_capture <logfile> <cmd...> — runs cmd, tees to logfile, echoes exit code.
run_capture() {
  local logfile="$1"
  shift
  local rc=0
  "$@" >"$logfile" 2>&1 || rc=$?
  printf 'exit=%s\n' "$rc" >>"$logfile"
  printf '%s' "$rc"
}

# seeded_token <seed> <alphabet> <length> — deterministic pseudo-random string
# (records the seed so a run can be reproduced exactly).
seeded_token() {
  local seed="$1" alphabet="$2" len="$3"
  node -e '
const [seed, alphabet, len] = process.argv.slice(1);
let s = Number(seed) >>> 0;
const next = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s; };
let out = "";
for (let i = 0; i < Number(len); i++) out += alphabet[next() % alphabet.length];
process.stdout.write(out);
' "$seed" "$alphabet" "$len"
}

# temp_export <dest> <paths...> — `git archive HEAD` of the given paths into dest
# (a hermetic "temp clone" of exactly the commit under test, no node_modules).
temp_export() {
  local dest="$1"
  shift
  mkdir -p "$dest"
  (cd "$REPO_ROOT" && git archive HEAD "$@" | tar -x -C "$dest")
}

verdict() {
  {
    printf 'scenario: %s\ncommit: %s\n' "$SCENARIO" "$(git -C "$REPO_ROOT" rev-parse HEAD)"
    printf 'held: %s\nbroken: %s\n' "$HELD" "$BROKEN"
    printf '%s\n' "${RESULTS[@]}"
  } | tee "$OUT/verdict.txt" >&2
  if [ "$BROKEN" -gt 0 ]; then
    log "VERDICT: BROKEN ($BROKEN check(s) failed, $HELD held)"
    exit 1
  fi
  log "VERDICT: HELD ($HELD check(s))"
  exit 0
}
