#!/usr/bin/env bash
# Mutation-test the Supabase security matrix.
#
#   ./supabase/tests/mutation/run_mutation_tests.sh [--out-dir DIR] [extra mutate_rls.py run flags]
#
# Enumerates every single-control weakening of the final schema (policies,
# RLS, table/column/function grants, triggers, payload caps, view/function
# security modes) plus every deletable security statement in the migration
# sources, materialises each one in a scratch copy of supabase/, and runs the
# UNMODIFIED ./supabase/tests/run_rls_tests.sh against it. Exit 0 = every
# non-equivalent mutant was killed; exit 1 = at least one survivor (a control
# the matrix does not pin); other codes = harness/baseline failure.
#
# Artifacts: DIR/mutants.json, DIR/results.json, DIR/report.md, DIR/logs/*.log,
# DIR/baseline_snapshot.txt. Nothing under supabase/migrations or
# supabase/tests is modified; mutated migrations exist only under DIR/scratch.
set -euo pipefail

cd "$(dirname "$0")/../../.."

OUT_DIR=""
ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --out-dir) OUT_DIR="$2"; shift 2 ;;
    *) ARGS+=("$1"); shift ;;
  esac
done
if [ -z "$OUT_DIR" ]; then
  OUT_DIR="artifacts/rls-mutation/$(date +%Y%m%dT%H%M%SZ)"
fi

if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  echo "run_mutation_tests.sh: Docker is required (postgres:16), same as run_rls_tests.sh" >&2
  exit 2
fi

exec python3 supabase/tests/mutation/mutate_rls.py run --out-dir "$OUT_DIR" "${ARGS[@]+"${ARGS[@]}"}"
