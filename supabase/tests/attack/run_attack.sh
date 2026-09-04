#!/usr/bin/env bash
# Run one (or every) adversarial SQL scenario against a throwaway postgres:16
# that already has supabase/tests/shim_auth.sql + every migration applied
# (see supabase/tests/run_rls_tests.sh for how that container is built).
#
#   ./supabase/tests/attack/run_attack.sh                 # all sN_*.sql, xN_*.sql, xN_*.sh
#   ./supabase/tests/attack/run_attack.sh s1 s4 x1        # a subset
#
# Env:
#   ATTACK_CONTAINER  docker container name (default pickle-attack-db)
#   ATTACK_OUT        directory for logs (default artifacts/attack-db)
#
# Exit status is the number of scenarios that did NOT hold. Each scenario's
# psql exit code and log path are printed; nothing here swallows a failure.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
container="${ATTACK_CONTAINER:-pickle-attack-db}"
out="${ATTACK_OUT:-$repo/artifacts/attack-db}"
mkdir -p "$out"

shopt -s nullglob
if [ "$#" -gt 0 ]; then
  files=()
  for prefix in "$@"; do
    files+=("$here"/"$prefix"_*.sql "$here"/"$prefix"_*.sh)
  done
else
  files=("$here"/s[0-9]*_*.sql "$here"/x[0-9]*_*.sql "$here"/x[0-9]*_*.sh)
fi
shopt -u nullglob
if [ "${#files[@]}" -eq 0 ]; then
  echo "no scenarios matched: $*" >&2
  exit 64
fi

docker exec "$container" rm -rf /attack
docker cp "$here" "$container":/attack

failed=0
for f in "${files[@]}"; do
  name="$(basename "${f%.*}")"
  log="$out/$name.log"
  set +e
  case "$f" in
    *.sql)
      docker exec "$container" psql -U postgres -v ON_ERROR_STOP=1 \
        -f "/attack/$(basename "$f")" >"$log" 2>&1
      ;;
    *.sh)
      ATTACK_CONTAINER="$container" bash "$f" >"$log" 2>&1
      ;;
  esac
  code=$?
  set -e
  if [ "$code" -eq 0 ]; then
    echo "HELD    $name  exit=$code  log=$log"
  else
    echo "BROKEN  $name  exit=$code  log=$log"
    failed=$((failed + 1))
  fi
done
exit "$failed"
