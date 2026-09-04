#!/usr/bin/env bash
# S5 — kill the postgres_test container midway through the `test` stage.
#
# Runs `scripts/verify-cloud.sh --only test` in the background, waits until the
# stage log shows the DB-backed package (@pickle/database or @pickle/api) has
# started, then `docker compose kill postgres_test`. Expect: the stage is
# recorded `failed` (never `unavailable` or `passed`), the script exits 1, and
# summary.json parses.
#
# Two kill points are exercised (S5_KILL_AT=database|api, default both):
#   database  first DB integration suite (packages/database)
#   api       later DB consumer (services/api) — the DB was alive for the
#             pg_ready pre-flight AND for earlier suites, so a "flaky infra"
#             classification is the tempting wrong answer.
#
# postgres_test is restarted afterwards (trap). Exit 0 = HELD, 1 = BROKEN.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
OUT="${S5_OUT:-/tmp/attack-s5-$(date -u +%Y%m%dT%H%M%SZ)}"
mkdir -p "$OUT"
cd "$REPO_ROOT" || exit 2
: >"$OUT/results.jsonl"
BROKEN=0
trap 'docker compose up -d postgres_test >/dev/null 2>&1' EXIT

case_run() { # label marker-regex
  local label="$1" marker="$2" art="$OUT/$1-artifacts" pid rc status note parse
  docker compose up -d postgres_test >"$OUT/$label.docker.log" 2>&1
  for _ in $(seq 1 30); do docker compose exec -T postgres_test pg_isready -q >/dev/null 2>&1 && break; sleep 1; done
  rm -rf "$art"
  VERIFY_ARTIFACTS="$art" timeout 1200 scripts/verify-cloud.sh --only test >"$OUT/$label.out" 2>&1 &
  pid=$!
  local waited=0 killed=0
  while kill -0 "$pid" 2>/dev/null; do
    if grep -aqE "$marker" "$art/test.log" 2>/dev/null; then
      docker compose kill postgres_test >>"$OUT/$label.docker.log" 2>&1
      echo "killed postgres_test at +${waited}s after marker '$marker'" | tee -a "$OUT/$label.kill.log"
      killed=1; break
    fi
    sleep 0.5; waited=$((waited + 1))
  done
  wait "$pid"; rc=$?
  if [ $killed = 0 ]; then
    printf '{"case":"%s","verdict":"INVALID","detail":"stage finished before marker appeared (exit %d)"}\n' "$label" "$rc" | tee -a "$OUT/results.jsonl"
    BROKEN=1; return
  fi
  status="$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); s=d["stages"][0]; print(s["status"]+"|"+s["note"])' "$art/summary.json" 2>"$OUT/$label.parse.err")" && parse=ok || { parse=fail; status="?|?"; }
  note="${status#*|}"; status="${status%%|*}"
  local verdict=HELD
  [ "$status" = failed ] && [ "$rc" -eq 1 ] && [ "$parse" = ok ] || verdict=BROKEN
  [ $verdict = BROKEN ] && BROKEN=1
  printf '{"case":"%s","stage_status":"%s","note":"%s","verify_exit":%d,"summary_parses":"%s","verdict":"%s","summary":"%s","stage_log":"%s"}\n' \
    "$label" "$status" "$note" "$rc" "$parse" "$verdict" "$art/summary.json" "$art/test.log" | tee -a "$OUT/results.jsonl"
}

KILL_AT="${S5_KILL_AT:-database api}"
for k in $KILL_AT; do
  case "$k" in
    # pnpm's per-package header: "> @pickle/database@0.1.0 test /…/packages/database" (no ANSI)
    database) case_run database '^> @pickle/database@' ;;
    api)      case_run api '^> @pickle/api@' ;;
    *) echo "unknown kill point $k" >&2; exit 2 ;;
  esac
done

echo "== results: $OUT/results.jsonl"; cat "$OUT/results.jsonl"
exit $BROKEN
