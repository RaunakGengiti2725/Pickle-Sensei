#!/usr/bin/env bash
# Replays the campaign's BROKEN classes through a real PostgREST (the same
# gateway hosted Supabase puts in front of the database) so the HTTP status
# each SQLSTATE maps to is measured, not inferred. LOCAL ONLY: expects the
# database from pg_up.sh on 127.0.0.1:5499 and starts PostgREST v11 on
# 127.0.0.1:3499 with a throwaway HS256 secret. PostgREST >= 11 publishes the
# JWT only as request.jwt.claims, so auth.uid() in the THROWAWAY database is
# redefined to the hosted Supabase shape (legacy GUC, then claims ->> 'sub')
# before the probes run.
#
#   ./supabase/tests/stress/postgrest_probe.sh [out_dir]
#
# Output: <out_dir>/postgrest_probe.json — one object per probe
# {name, method, path, role, sqlstate_expected, http_status, body}.
set -euo pipefail

OUT_DIR="${1:-/tmp/stress-postgrest}"
PG_URL="${STRESS_PG_URL:-postgres://postgres:pg@127.0.0.1:5499/postgres}"
PG_CONTAINER="${STRESS_PG_CONTAINER:-pickle-stress-pg}"
PGRST_CONTAINER="${STRESS_PGRST_CONTAINER:-pickle-stress-postgrest}"
PGRST_PORT="${STRESS_PGRST_PORT:-3499}"
JWT_SECRET="stress-local-only-jwt-secret-0123456789abcdef"
ALICE="00000000-0000-4000-8000-00000000000a"
BOB="00000000-0000-4000-8000-00000000000b"

case "$PG_URL" in
*supabase.co* | *ucqnaiwqwjtgvlduiuib*)
  echo "refusing to probe a hosted Supabase URL" >&2
  exit 2
  ;;
esac

mkdir -p "$OUT_DIR"

psql_in() {
  docker exec -i "$PG_CONTAINER" psql -v ON_ERROR_STOP=1 -U postgres -d postgres -qtA "$@"
}

# ---- fixtures: two users, bob owns a session + a shot ----------------------
psql_in <<SQL
delete from auth.users where id in ('$ALICE', '$BOB');
insert into auth.users (id, email, raw_app_meta_data)
values ('$ALICE', 'alice-probe@example.test', '{"provider":"google","providers":["google"]}'),
       ('$BOB',   'bob-probe@example.test',   '{"provider":"google","providers":["google"]}');
insert into auth.identities (provider_id, user_id, identity_data, provider)
values ('probe-alice', '$ALICE', '{"sub":"probe-alice"}', 'google'),
       ('probe-bob',   '$BOB',   '{"sub":"probe-bob"}',   'google');
create or replace function auth.uid() returns uuid
language sql stable as \$\$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
  )::uuid
\$\$;
create or replace function public.stress_whoami() returns jsonb
language sql stable as \$\$ select jsonb_build_object('uid', auth.uid(), 'role', current_user) \$\$;
grant execute on function public.stress_whoami() to anon, authenticated;
insert into public.sessions (id, user_id, kind, started_at)
values ('10000000-0000-4000-8000-00000000000b', '$BOB', 'practice', '2026-05-01T09:00:00Z');
insert into public.shots (id, user_id, session_id, shot_type, camera_view, captured_at, start_ms, contact_ms, end_ms,
  overall_score, analysis_confidence, result_kind, app_version, model_bundle_version, pose_model_version,
  paddle_model_version, stroke_detector_version, phase_model_version, scoring_model_version, shot_config_version)
values ('20000000-0000-4000-8000-00000000000b', '$BOB', '10000000-0000-4000-8000-00000000000b', 'dink', 'side',
  '2026-05-01T09:05:00Z', 0, 300, 900, 7.25, 0.9, 'scored', '1.0.0', 'b', 'p', 'pd', 's', 'ph', 'sc', 'c');
SQL

# ---- PostgREST ------------------------------------------------------------
docker rm -f "$PGRST_CONTAINER" >/dev/null 2>&1 || :
docker run -d --name "$PGRST_CONTAINER" --network host \
  -e PGRST_DB_URI="$PG_URL" \
  -e PGRST_DB_SCHEMAS=public \
  -e PGRST_DB_ANON_ROLE=anon \
  -e PGRST_JWT_SECRET="$JWT_SECRET" \
  -e PGRST_SERVER_PORT="$PGRST_PORT" \
  -e PGRST_DB_USE_LEGACY_GUCS=true \
  postgrest/postgrest:v11.2.2 >/dev/null
for _ in $(seq 1 30); do
  if curl -fs -o /dev/null "http://127.0.0.1:$PGRST_PORT/"; then break; fi
  sleep 1
done
curl -fs -o /dev/null "http://127.0.0.1:$PGRST_PORT/"

b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }
jwt_for() {
  local header payload sig
  header=$(printf '{"alg":"HS256","typ":"JWT"}' | b64url)
  payload=$(printf '{"role":"authenticated","sub":"%s","exp":4102444800}' "$1" | b64url)
  sig=$(printf '%s.%s' "$header" "$payload" | openssl dgst -sha256 -hmac "$JWT_SECRET" -binary | b64url)
  printf '%s.%s.%s' "$header" "$payload" "$sig"
}
ALICE_JWT=$(jwt_for "$ALICE")

BASE="http://127.0.0.1:$PGRST_PORT"
RESULTS="$OUT_DIR/postgrest_probe.json"
: >"$RESULTS.tmp"

probe() { # name method path role sqlstate_expected [body-file]
  local name="$1" method="$2" path="$3" role="$4" expect="$5" body="${6:-}"
  local -a args=(-s -o "$OUT_DIR/body.tmp" -w '%{http_code}' -X "$method" -H 'Content-Type: application/json' -H 'Prefer: return=representation')
  if [ "$role" = "alice" ]; then args+=(-H "Authorization: Bearer $ALICE_JWT"); fi
  if [ -n "$body" ]; then args+=(--data-binary "@$body"); fi
  local status
  status=$(curl "${args[@]}" "$BASE$path")
  python3 - "$name" "$method" "$path" "$role" "$expect" "$status" "$OUT_DIR/body.tmp" >>"$RESULTS.tmp" <<'PY'
import json, sys
name, method, path, role, expect, status, bodyf = sys.argv[1:]
body = open(bodyf, "rb").read(600).decode("utf-8", "replace")
print(json.dumps({"name": name, "method": method, "path": path, "role": role, "sqlstate_expected": expect, "http_status": int(status), "body": body}))
PY
  echo "$status  $name"
}

# identity check: the bearer must resolve to alice inside the database
printf '{}' >"$OUT_DIR/empty.json"
probe "whoami alice" POST "/rpc/stress_whoami" alice "-" "$OUT_DIR/empty.json"
probe "whoami anon" POST "/rpc/stress_whoami" anon "-" "$OUT_DIR/empty.json"

# class B: DML against aggregate views (SQLSTATE 55000)
probe "anon delete practice_days" DELETE "/practice_days?user_id=eq.$ALICE" anon 55000
probe "alice delete practice_days" DELETE "/practice_days?user_id=eq.$ALICE" alice 55000
printf '{"user_id":"%s","day":"2026-05-01","shots":1}' "$ALICE" >"$OUT_DIR/pd.json"
probe "alice insert practice_days" POST "/practice_days" alice 55000 "$OUT_DIR/pd.json"
probe "anon insert practice_days" POST "/practice_days" anon 55000 "$OUT_DIR/pd.json"
printf '{"user_id":"%s"}' "$ALICE" >"$OUT_DIR/ptr.json"
probe "alice insert player_technique_rating" POST "/player_technique_rating" alice 55000 "$OUT_DIR/ptr.json"
probe "alice delete progress_daily" DELETE "/progress_daily?user_id=eq.$ALICE" alice 55000

# class A: deeply nested JSON (SQLSTATE 54001 in SQL; the gateway parses first)
python3 - "$OUT_DIR" "$ALICE" <<'PY'
import json, sys
out, alice = sys.argv[1:]
for depth in (32768, 131072):
    nested = "[" * depth + "]" * depth
    row = '{"user_id":"%s","shot_id":%s,"metric_key":"m","value":1,"unit":"degrees","confidence":0.5}' % (alice, nested)
    open(f"{out}/deep_row_{depth}.json", "w").write(row)
    shot = {
        "id": "30000000-0000-4000-8000-0000000000aa", "analysisPermitId": None,
        "sessionId": None, "shotType": "dink", "cameraView": "side",
        "capturedAt": "2026-05-01T09:05:00Z", "startMs": 0, "contactMs": 300, "endMs": 900,
        "overallScore": None, "confidence": 0.2, "resultKind": "low_confidence",
        "versionVector": {"appVersion": "__DEEP__", "modelBundleVersion": "b", "poseModelVersion": "p",
                          "paddleModelVersion": "pd", "strokeDetectorVersion": "s", "phaseModelVersion": "ph",
                          "scoringModelVersion": "sc", "shotConfigVersion": "c"},
        "phases": [], "checkpoints": [],
    }
    text = json.dumps({"shot": shot}).replace('"__DEEP__"', nested)
    open(f"{out}/deep_rpc_{depth}.json", "w").write(text)
PY
probe "alice insert shot_measurements shot_id nested 32768" POST "/shot_measurements" alice 54001 "$OUT_DIR/deep_row_32768.json"
probe "alice insert shot_measurements shot_id nested 131072" POST "/shot_measurements" alice 54001 "$OUT_DIR/deep_row_131072.json"
probe "alice rpc apply_synced_shot appVersion nested 32768" POST "/rpc/apply_synced_shot" alice 54001 "$OUT_DIR/deep_rpc_32768.json"
probe "alice rpc apply_synced_shot appVersion nested 131072" POST "/rpc/apply_synced_shot" alice 54001 "$OUT_DIR/deep_rpc_131072.json"

# class C: FK to another user's row (RLS-invisible) is accepted
printf '{"user_id":"%s","shot_id":"20000000-0000-4000-8000-00000000000b","phase_key":"backswing","start_ms":0,"representative_ms":10,"end_ms":20,"confidence":0.5}' "$ALICE" >"$OUT_DIR/xphase.json"
probe "alice insert shot_phases shot_id=BOB shot" POST "/shot_phases" alice "none (201 = stored)" "$OUT_DIR/xphase.json"
printf '{"id":"50000000-0000-4000-8000-0000000000aa","user_id":"%s","session_id":"10000000-0000-4000-8000-00000000000b","shot_type":"dink","camera_view":"side","captured_at":"2026-05-01T09:06:00Z","start_ms":0,"contact_ms":300,"end_ms":900,"overall_score":null,"analysis_confidence":0.2,"result_kind":"low_confidence","app_version":"1.0.0","model_bundle_version":"b","pose_model_version":"p","paddle_model_version":"pd","stroke_detector_version":"s","phase_model_version":"ph","scoring_model_version":"sc","shot_config_version":"c"}' "$ALICE" >"$OUT_DIR/xshot.json"
probe "alice insert shots session_id=BOB session" POST "/shots" alice "none (201 = stored)" "$OUT_DIR/xshot.json"
probe "alice select shots in BOB session" GET "/shots?session_id=eq.10000000-0000-4000-8000-00000000000b&select=id,user_id" alice "-"
# control: a random uuid that exists in NO shot → 23503 (FK oracle: existence of another user's shot id is observable)
printf '{"user_id":"%s","shot_id":"20000000-0000-4000-8000-0000000000ff","phase_key":"backswing","start_ms":0,"representative_ms":10,"end_ms":20,"confidence":0.5}' "$ALICE" >"$OUT_DIR/xphase_missing.json"
probe "alice insert shot_phases shot_id=nonexistent" POST "/shot_phases" alice 23503 "$OUT_DIR/xphase_missing.json"

# class D: non-finite / out-of-range numerics in detail tables
printf '{"user_id":"%s","shot_id":"50000000-0000-4000-8000-0000000000aa","metric_key":"m1","value":"NaN","unit":"degrees","confidence":-1}' "$ALICE" >"$OUT_DIR/nan.json"
probe "alice insert shot_measurements value=NaN confidence=-1" POST "/shot_measurements" alice "none (201 = stored)" "$OUT_DIR/nan.json"
printf '{"user_id":"%s","shot_id":"50000000-0000-4000-8000-0000000000aa","metric_key":"m2","value":"-Infinity","unit":"degrees","confidence":1.00005}' "$ALICE" >"$OUT_DIR/inf.json"
probe "alice insert shot_measurements value=-Infinity confidence=1.00005" POST "/shot_measurements" alice "none (201 = stored)" "$OUT_DIR/inf.json"

python3 - "$RESULTS.tmp" "$RESULTS" <<'PY'
import json, sys
rows = [json.loads(l) for l in open(sys.argv[1]) if l.strip()]
json.dump(rows, open(sys.argv[2], "w"), indent=2)
PY
rm -f "$RESULTS.tmp" "$OUT_DIR/body.tmp"

# what was actually stored
psql_in -c "select 'phases_on_bob_shot', count(*) from public.shot_phases where user_id = '$ALICE' and shot_id = '20000000-0000-4000-8000-00000000000b'" \
  -c "select 'alice_shots_in_bob_session', count(*) from public.shots where user_id = '$ALICE' and session_id = '10000000-0000-4000-8000-00000000000b'" \
  -c "select 'measurements', metric_key, value, confidence from public.shot_measurements where user_id = '$ALICE' order by metric_key" | tee "$OUT_DIR/stored.txt"

# cleanup
psql_in <<SQL
delete from auth.users where id in ('$ALICE', '$BOB');
drop function public.stress_whoami();
-- restore shim_auth.sql's auth.uid()
create or replace function auth.uid() returns uuid
language sql stable as \$\$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
\$\$;
SQL
docker rm -f "$PGRST_CONTAINER" >/dev/null
echo "wrote $RESULTS"
