#!/usr/bin/env bash
# Exact two-session SQL reproduction of stress finding F5d:
# an identity linked while a scored-shot sync is in flight ends up BELOW the
# account's lifetime count in public.free_rating_ledger, so after account
# deletion a sign-in holding only that identity gets a free rating back.
#
#   STRESS_PG_URL=postgres://postgres:pg@127.0.0.1:5499/postgres \
#     ./supabase/tests/stress/repro_link_during_scored_sync.sh
#
# Session A (authenticated, user U): apply_synced_shot(scored) — holds the
#   per-user advisory lock and its uncommitted ledger write for 2s.
# Session B (owner, like GoTrue): insert into auth.identities for U while A
#   is open → inherit_free_rating_ledger() reads the pre-sync snapshot.
# Then: ledger apple=2 google=1; delete U; create U2 holding only google;
#   U2.access_state().scored_count = 1 and reserve_analysis_permit → accepted.
# Exit 1 when the anomaly reproduces (the expected result today), 0 when the
# ledger stays in step (i.e. the hole is closed).
set -euo pipefail

# psql from the host when present, otherwise the one inside the db_up.sh container.
if command -v psql >/dev/null 2>&1; then
  URL=${STRESS_PG_URL:?set STRESS_PG_URL (see supabase/tests/stress/db_up.sh)}
  PSQL=(psql "$URL" -v ON_ERROR_STOP=1 -X -q -At)
else
  PSQL=(docker exec -i "${STRESS_PG_CONTAINER:-pickle-stress-pg}" psql -U postgres -v ON_ERROR_STOP=1 -X -q -At)
fi

U=$(uuidgen | tr 'A-Z' 'a-z')
U2=$(uuidgen | tr 'A-Z' 'a-z')
APPLE="repro-apple-$U"
GOOGLE="repro-google-$U"
SHOT1=$(uuidgen | tr 'A-Z' 'a-z')
SHOT2=$(uuidgen | tr 'A-Z' 'a-z')

payload() {
  cat <<JSON
{"id":"$1","analysisPermitId":"$2","sessionId":null,"shotType":"dink","cameraView":"side","capturedAt":"2026-09-01T10:00:00.000Z","startMs":0,"contactMs":100,"endMs":200,"overallScore":7,"confidence":0.9,"resultKind":"scored","phases":[],"checkpoints":[],"versionVector":{"appVersion":"1.0.0","modelBundleVersion":"bundle-1","poseModelVersion":"pose-1","paddleModelVersion":"paddle-1","strokeDetectorVersion":"stroke-1","phaseModelVersion":"phase-1","scoringModelVersion":"scoring-1","shotConfigVersion":"config-1"}}
JSON
}

echo "== setup: user $U with ONE identity (apple), first free rating spent"
"${PSQL[@]}" <<SQL
delete from public.free_rating_ledger
  where identity_hash in (public.free_rating_identity_hash('apple', '$APPLE'),
                          public.free_rating_identity_hash('google', '$GOOGLE'));
insert into auth.users (id, email, raw_app_meta_data)
  values ('$U', '$U@example.com', '{"provider":"apple"}'::jsonb);
insert into auth.identities (provider, provider_id, user_id, identity_data)
  values ('apple', '$APPLE', '$U', '{"sub":"$APPLE"}'::jsonb);
SQL

reserve() {
  "${PSQL[@]}" <<SQL | tail -1
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '$U', true) as jwt_sub \gset
select permit_id from public.reserve_analysis_permit('$1');
commit;
SQL
}

P1=$(reserve repro-1)
"${PSQL[@]}" <<SQL | sed 's/^/   first scored sync → /'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '$U', true) as jwt_sub \gset
select public.apply_synced_shot('$(payload "$SHOT1" "$P1")'::jsonb);
commit;
SQL

P2=$(reserve repro-2)
echo "   second permit reserved: $P2"

echo "== session A: second scored sync, transaction held open 2s"
"${PSQL[@]}" <<SQL &
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '$U', true) as jwt_sub \gset
select 'A apply → ' || public.apply_synced_shot('$(payload "$SHOT2" "$P2")'::jsonb);
select pg_sleep(2);
commit;
SQL
A_PID=$!
sleep 0.5

echo "== session B (GoTrue): link google identity while A is uncommitted"
"${PSQL[@]}" <<SQL
insert into auth.identities (provider, provider_id, user_id, identity_data)
  values ('google', '$GOOGLE', '$U', '{"sub":"$GOOGLE"}'::jsonb);
select 'B linked google';
SQL
wait "$A_PID"

echo "== ledger after both committed (expected: every identity = 2)"
LEDGER=$("${PSQL[@]}" <<SQL
select i.provider || '=' || coalesce(l.scored_count::text, 'none')
  from auth.identities i
  left join public.free_rating_ledger l
    on l.identity_hash = public.free_rating_identity_hash(i.provider, i.provider_id)
 where i.user_id = '$U' order by i.provider;
SQL
)
echo "$LEDGER" | sed 's/^/   /'

echo "== delete the account, sign in again holding ONLY the google identity"
"${PSQL[@]}" <<SQL
delete from auth.users where id = '$U';
insert into auth.users (id, email, raw_app_meta_data)
  values ('$U2', '$U2@example.com', '{"provider":"google"}'::jsonb);
insert into auth.identities (provider, provider_id, user_id, identity_data)
  values ('google', '$GOOGLE', '$U2', '{"sub":"$GOOGLE"}'::jsonb);
SQL
AFTER=$("${PSQL[@]}" <<SQL
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '$U2', true) as jwt_sub \gset
select 'scored_count=' || scored_count from public.access_state();
select 'reserve → ' || result from public.reserve_analysis_permit('repro-again');
commit;
SQL
)
echo "$AFTER" | sed 's/^/   /'
"${PSQL[@]}" -c "delete from auth.users where id = '$U2'" >/dev/null

if echo "$AFTER" | grep -q 'reserve → accepted'; then
  echo "ANOMALY REPRODUCED: 2 ratings spent, re-created account got a third (ledger: $(echo "$LEDGER" | tr '\n' ' '))"
  exit 1
fi
echo "HELD: recreated account paywalled"
