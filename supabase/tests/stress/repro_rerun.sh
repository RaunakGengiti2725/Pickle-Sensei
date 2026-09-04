#!/usr/bin/env bash
# Re-runs every minimized reproduction in supabase/tests/stress/repro/*.sql
# N times (default 10) against the disposable database from pg_up.sh and
# reports the reproduction rate per file, so a flaky finding is reported as a
# rate rather than as a fact. Each repro is a self-contained psql script that
# rolls back its own writes and prints `OBSERVED …` lines; a run "reproduces"
# when its OBSERVED lines are byte-identical to the first run's.
#
#   ./supabase/tests/stress/repro_rerun.sh [out_dir] [runs]
#
# Output: <out_dir>/repro_rerun.json + <out_dir>/<file>.run<N>.txt
set -euo pipefail

OUT_DIR="${1:-/tmp/stress-repro}"
RUNS="${2:-10}"
PG_URL="${STRESS_PG_URL:-postgres://postgres:pg@127.0.0.1:5499/postgres}"
PG_CONTAINER="${STRESS_PG_CONTAINER:-pickle-stress-pg}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ALICE="00000000-0000-4000-8000-00000000000a"
BOB="00000000-0000-4000-8000-00000000000b"

case "$PG_URL" in
*supabase.co* | *ucqnaiwqwjtgvlduiuib*)
  echo "refusing to run against a hosted Supabase URL" >&2
  exit 2
  ;;
esac
mkdir -p "$OUT_DIR"

psql_in() {
  docker exec -i "$PG_CONTAINER" psql -U postgres -d postgres "$@"
}

fixtures() {
  psql_in -v ON_ERROR_STOP=1 -q <<SQL
delete from auth.users where id in ('$ALICE', '$BOB');
insert into auth.users (id, email, raw_app_meta_data)
values ('$ALICE', 'alice-repro@example.test', '{"provider":"google","providers":["google"]}'),
       ('$BOB',   'bob-repro@example.test',   '{"provider":"google","providers":["google"]}');
insert into auth.identities (provider_id, user_id, identity_data, provider)
values ('repro-alice', '$ALICE', '{"sub":"repro-alice"}', 'google'),
       ('repro-bob',   '$BOB',   '{"sub":"repro-bob"}',   'google');
insert into public.sessions (id, user_id, kind, started_at)
values ('10000000-0000-4000-8000-00000000000a', '$ALICE', 'practice', '2026-05-01T09:00:00Z'),
       ('10000000-0000-4000-8000-00000000000b', '$BOB',   'practice', '2026-05-01T09:00:00Z');
insert into public.shots (id, user_id, session_id, shot_type, camera_view, captured_at, start_ms, contact_ms, end_ms,
  overall_score, analysis_confidence, result_kind, app_version, model_bundle_version, pose_model_version,
  paddle_model_version, stroke_detector_version, phase_model_version, scoring_model_version, shot_config_version)
values ('20000000-0000-4000-8000-00000000000a', '$ALICE', '10000000-0000-4000-8000-00000000000a', 'dink', 'side',
        '2026-05-01T09:05:00Z', 0, 300, 900, 7.25, 0.9, 'scored', '1.0.0', 'b', 'p', 'pd', 's', 'ph', 'sc', 'c'),
       ('20000000-0000-4000-8000-00000000000b', '$BOB', '10000000-0000-4000-8000-00000000000b', 'dink', 'side',
        '2026-05-01T09:05:00Z', 0, 300, 900, 7.25, 0.9, 'scored', '1.0.0', 'b', 'p', 'pd', 's', 'ph', 'sc', 'c');
insert into public.analysis_permits (id, user_id, idempotency_key, status)
values ('30000000-0000-4000-8000-00000000000a', '$ALICE', 'repro-live', 'reserved');
SQL
}

cleanup() {
  psql_in -v ON_ERROR_STOP=1 -q -c "delete from auth.users where id in ('$ALICE', '$BOB')"
}

fixtures
trap cleanup EXIT

: >"$OUT_DIR/repro_rerun.jsonl"
status=0
for f in "$HERE"/repro/*.sql; do
  name="$(basename "$f" .sql)"
  first=""
  reproduced=0
  for i in $(seq 1 "$RUNS"); do
    out="$OUT_DIR/$name.run$i.txt"
    # ON_ERROR_STOP is off inside the scripts on purpose (the errors ARE the observation)
    psql_in -q <"$f" >"$out" 2>&1
    obs="$(grep -E '^(OBSERVED|GRANTS) ' "$out" || :)"
    if [ "$i" -eq 1 ]; then first="$obs"; fi
    if [ "$obs" = "$first" ] && [ -n "$obs" ]; then reproduced=$((reproduced + 1)); fi
  done
  python3 - "$name" "$RUNS" "$reproduced" "$OUT_DIR/$name.run1.txt" >>"$OUT_DIR/repro_rerun.jsonl" <<'PY'
import json, sys
name, runs, reproduced, first = sys.argv[1:]
lines = [l.rstrip("\n") for l in open(first) if l.startswith(("OBSERVED ", "GRANTS "))]
print(json.dumps({"repro": name, "runs": int(runs), "reproduced": int(reproduced),
                  "rate": f"{reproduced}/{runs}", "observed": lines}))
PY
  echo "$name: reproduced $reproduced/$RUNS"
  if [ "$reproduced" -ne "$RUNS" ]; then status=1; fi
done

python3 - "$OUT_DIR/repro_rerun.jsonl" "$OUT_DIR/repro_rerun.json" <<'PY'
import json, sys
rows = [json.loads(l) for l in open(sys.argv[1]) if l.strip()]
json.dump(rows, open(sys.argv[2], "w"), indent=2)
PY
rm -f "$OUT_DIR/repro_rerun.jsonl"
echo "wrote $OUT_DIR/repro_rerun.json"
exit "$status"
