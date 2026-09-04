#!/usr/bin/env bash
# Shared helpers for the ci-workflows-scripts structural audit tests.
#
# Every test in this directory asserts the DESIRED behaviour of a script or
# workflow; a failing test therefore demonstrates a defect (see README.md).
# Tests never modify production code, never touch the real remote, and never
# start the Mac runner: the verify-cloud sandbox copies scripts/verify-cloud.sh
# into a throwaway git repository whose PATH is fronted by recording stubs.

set -uo pipefail

AUDIT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$AUDIT_DIR/../../.." && pwd)"
export AUDIT_DIR REPO_ROOT

AUDIT_OUT="${AUDIT_OUT:-$REPO_ROOT/artifacts/audit-structural2}"
mkdir -p "$AUDIT_OUT"
export AUDIT_OUT

_assert_failures=0

log() { printf '[%s] %s\n' "$(basename "$0" .sh)" "$*"; }

assert_eq() { # assert_eq <label> <expected> <actual>
  if [ "$2" = "$3" ]; then
    log "ok   $1 (=$2)"
  else
    log "FAIL $1: expected '$2' got '$3'"
    _assert_failures=$((_assert_failures + 1))
  fi
}

assert_ne() { # assert_ne <label> <unexpected> <actual>
  if [ "$2" != "$3" ]; then
    log "ok   $1 (!=$2)"
  else
    log "FAIL $1: expected != '$2' got '$3'"
    _assert_failures=$((_assert_failures + 1))
  fi
}

assert_true() { # assert_true <label> <command...>
  local label=$1
  shift
  if "$@"; then
    log "ok   $label"
  else
    log "FAIL $label ($*)"
    _assert_failures=$((_assert_failures + 1))
  fi
}

assert_false() { # assert_false <label> <command...>
  local label=$1
  shift
  if "$@"; then
    log "FAIL $label (unexpectedly true: $*)"
    _assert_failures=$((_assert_failures + 1))
  else
    log "ok   $label"
  fi
}

finish() {
  if [ "$_assert_failures" -eq 0 ]; then
    log "RESULT PASS"
    exit 0
  fi
  log "RESULT FAIL ($_assert_failures assertion(s))"
  exit 1
}

# make_stub <bindir> <name> [body]
# Creates an executable that appends "<name> <args>" to $STUB_LOG and then runs
# <body> (default: exit 0). Stubs must never touch the network or the real repo.
make_stub() {
  local dir=$1 name=$2 body=${3:-'exit 0'}
  cat >"$dir/$name" <<EOF
#!/usr/bin/env bash
printf '%s %s\n' "$name" "\$*" >>"\${STUB_LOG:?}"
$body
EOF
  chmod +x "$dir/$name"
}

# new_verify_cloud_sandbox <dir>
# Builds a throwaway repository containing an unmodified copy of
# scripts/verify-cloud.sh plus the minimum tree it expects (apps/mobile,
# packages/database, supabase/tests/run_rls_tests.sh, scripts/security-scan.sh)
# and a bin/ directory of recording stubs for every external tool.
# Exposes SANDBOX, SANDBOX_BIN, STUB_LOG.
new_verify_cloud_sandbox() {
  local dir=$1
  SANDBOX=$dir
  SANDBOX_BIN=$dir/bin
  STUB_LOG=$dir/stub.log
  export SANDBOX SANDBOX_BIN STUB_LOG
  mkdir -p "$dir/scripts" "$dir/bin" "$dir/apps/mobile" "$dir/packages/database/node_modules/pg" \
    "$dir/supabase/tests" "$dir/ml/scripts" "$dir/supabase/functions/api/__wf__" "$dir/apps/e2e"
  cp "$REPO_ROOT/scripts/verify-cloud.sh" "$dir/scripts/verify-cloud.sh"
  echo '{"name":"mobile","lockfileVersion":3}' >"$dir/apps/mobile/package-lock.json"
  : >"$STUB_LOG"
  git -C "$dir" init -q
  git -C "$dir" -c user.email=a@b -c user.name=audit add -A
  git -C "$dir" -c user.email=a@b -c user.name=audit commit -qm init
  # stubs: every tool verify-cloud.sh reaches for
  local t
  for t in pnpm npm npx node python3 deno docker; do make_stub "$dir/bin" "$t"; done
  # curl is only used for the ElasticMQ probe: report "down" so the SQS suites self-skip
  make_stub "$dir/bin" curl 'exit 7'
  make_stub "$dir/scripts" security-scan.sh
  make_stub "$dir/supabase/tests" run_rls_tests.sh
}

# run_verify_cloud <args...>  — runs the sandbox copy with stubs on PATH and
# records exit code in RC and combined output in OUT.
run_verify_cloud() {
  # HOME is pointed at the sandbox so the script's own `$HOME/.deno/bin` PATH
  # prepend cannot shadow the stubs with a real deno.
  # PATH is reduced to the stubs plus the system directories (git, jq, coreutils)
  # so no real toolchain (deno, pnpm, node) can leak into a sandbox run.
  OUT="$(cd "$SANDBOX" && HOME="$SANDBOX" PATH="$SANDBOX_BIN:/usr/bin:/bin" scripts/verify-cloud.sh "$@" 2>&1)"
  RC=$?
  export OUT RC
}
