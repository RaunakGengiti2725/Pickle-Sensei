#!/usr/bin/env bash
# S2: run the canonical RLS harness with `docker` shadowed by a failing stub so
# the script must take its local initdb/pg_ctl fallback, and require the run
# to still end with the success marker and exit 0.
#
# Usage: s2_docker_stub_fallback.sh [PG_BIN_DIR]
#   PG_BIN_DIR defaults to the newest /usr/lib/postgresql/*/bin that has initdb.
# Exit codes: 0 = HELD, 1 = BROKEN (marker missing or non-zero exit),
#             2 = preconditions missing (no initdb/pg_ctl) — NOT a pass.
set -uo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../../../.." && pwd)
ART=${ATTACK_ARTIFACTS:-"$HERE/artifacts"}
mkdir -p "$ART"

PG_BIN=${1:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}
if [ -z "$PG_BIN" ] || [ ! -x "$PG_BIN/initdb" ] || [ ! -x "$PG_BIN/pg_ctl" ]; then
  echo "S2: PRECONDITION FAILED — no local initdb/pg_ctl (looked in '$PG_BIN')" >&2
  exit 2
fi

STUB=$(mktemp -d)
trap 'rm -rf "$STUB"' EXIT
cat > "$STUB/docker" <<'EOF'
#!/usr/bin/env bash
echo "stub docker: refusing ($*)" >&2
exit 1
EOF
chmod +x "$STUB/docker"

# Make sure the stub really shadows docker and fails as the harness probes it.
if PATH="$STUB:$PG_BIN:$PATH" docker info >/dev/null 2>&1; then
  echo "S2: stub did not shadow docker" >&2
  exit 2
fi
echo "S2: docker resolved to: $(PATH="$STUB:$PG_BIN:$PATH" command -v docker)"
echo "S2: initdb resolved to: $(PATH="$STUB:$PG_BIN:$PATH" command -v initdb)"

LOG="$ART/s2_run_rls_tests_initdb_fallback.log"
PATH="$STUB:$PG_BIN:$PATH" "$REPO/supabase/tests/run_rls_tests.sh" >"$LOG" 2>&1
rc=$?
echo "S2: run_rls_tests.sh exit=$rc log=$LOG"

marker_ok=0
grep -q '^SECURITY REGRESSION MATRIX: ALL CASES PASSED$' "$LOG" && marker_ok=1
grep -q 'pickle-rls-test\|docker run' "$LOG" && { echo "S2: BROKEN — docker path was used despite stub" >&2; exit 1; }
tail -3 "$LOG"

if [ "$rc" -eq 0 ] && [ "$marker_ok" -eq 1 ]; then
  echo "RESULT S2: HELD initdb fallback ended with success marker (exit 0)"
  exit 0
fi
echo "RESULT S2: BROKEN exit=$rc marker_present=$marker_ok"
exit 1
