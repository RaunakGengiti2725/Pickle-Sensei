#!/usr/bin/env bash
# REPRO (deterministic, two concurrent sessions) — F2: linking a second sign-in
# identity CONCURRENTLY with the scored-shot insert leaves that identity with a
# free-rating ledger row of 0, so signing in with it after deleting the account
# hands out the two lifetime free ratings again.
#
# Both triggers only see COMMITTED state:
#   * shots_record_free_rating_ledger (20260902150000, definer, AFTER INSERT on
#     shots) stamps identity-max+1 onto the identities it can see;
#   * auth_identity_inherit_free_ratings (20260905000100, definer, AFTER INSERT
#     on auth.identities) inherits public.lifetime_scored_count() at link time.
# Interleaved (link starts before the shot commits and commits after it), the
# shot trigger does not see the new identity and the link trigger does not see
# the shot: neither path stamps the row, and it stays at 0.
#
#   ./supabase/tests/stress/repro_identity_link_ledger_race.sh          # uses/starts pg_up.sh
#   STRESS_PG_URL=postgres://postgres:pg@127.0.0.1:5499/postgres ./…     # reuse a DB
#
# Expected (exit 0): both identities of the account carry lifetime count 1.
# Observed (exit 1): the late-linked identity carries 0.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"

CONTAINER="${STRESS_PG_CONTAINER:-pickle-stress-pg}"
if [ -z "${STRESS_PG_URL:-}" ]; then
  url_line="$("$HERE/pg_up.sh" | tail -n1)"
  STRESS_PG_URL="${url_line#STRESS_PG_URL=}"
fi
# Prefer a host psql; fall back to the one inside the throwaway container.
if command -v psql >/dev/null 2>&1; then
  psql() { command psql "$STRESS_PG_URL" -v ON_ERROR_STOP=1 -qtAX "$@"; }
else
  psql() { docker exec -i "$CONTAINER" psql -U postgres -v ON_ERROR_STOP=1 -qtAX "$@"; }
fi

A=aaaaaaaa-0000-4000-8000-00000000000a
PERMIT=aaaaaaaa-0000-4000-8000-0000000000b0
SHOT=aaaaaaaa-0000-4000-8000-0000000000c0
SUB1=ledger-race-apple
SUB2=ledger-race-google

psql <<SQL
delete from auth.users where id = '$A';
delete from public.free_rating_ledger
 where identity_hash in (public.free_rating_identity_hash('apple', '$SUB1'),
                         public.free_rating_identity_hash('google', '$SUB2'));
insert into auth.users (id, email, raw_app_meta_data)
values ('$A', 'ledger-race@stress.local', jsonb_build_object('provider', 'apple'));
insert into auth.identities (provider_id, user_id, identity_data, provider)
values ('$SUB1', '$A', jsonb_build_object('sub', '$SUB1'), 'apple');
insert into public.analysis_permits (id, user_id, idempotency_key, status)
values ('$PERMIT', '$A', 'ledger-race', 'reserved');
SQL

# Session 1: insert the scored shot, hold the transaction open, then commit.
# Session 2: link the second identity while session 1 is still open.
psql -f - <<SQL >/tmp/ledger_race_s1.log 2>&1 &
begin;
set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', '$A', 'role', 'authenticated')::text, true);
select public.apply_synced_shot(json_build_object(
  'id', '$SHOT', 'analysisPermitId', '$PERMIT',
  'shotType', 'forehand_drive', 'cameraView', 'side', 'capturedAt', now(),
  'startMs', 0, 'contactMs', 400, 'endMs', 900,
  'overallScore', 7.25, 'confidence', 0.91, 'resultKind', 'scored',
  'versionVector', json_build_object('appVersion','1','modelBundleVersion','b',
    'poseModelVersion','p','paddleModelVersion','pa','strokeDetectorVersion','s',
    'phaseModelVersion','ph','scoringModelVersion','sc','shotConfigVersion','c'),
  'phases', '[]'::json, 'checkpoints', '[]'::json)::jsonb);
select pg_sleep(1.5);
commit;
SQL
s1=$!
sleep 0.5
psql -c "insert into auth.identities (provider_id, user_id, identity_data, provider)
         values ('$SUB2', '$A', jsonb_build_object('sub', '$SUB2'), 'google');"
wait "$s1"

echo "--- lifetime count per identity of the account"
psql -c "select i.provider, coalesce(l.scored_count, 0) as lifetime
         from auth.identities i
         left join public.free_rating_ledger l
           on l.identity_hash = public.free_rating_identity_hash(i.provider, i.provider_id)
         where i.user_id = '$A' order by i.provider;"

echo "--- scored shots on the account"
psql -c "select count(*) from public.shots where user_id = '$A' and result_kind = 'scored';"

bad="$(psql -c "select count(*) from auth.identities i
                left join public.free_rating_ledger l
                  on l.identity_hash = public.free_rating_identity_hash(i.provider, i.provider_id)
                where i.user_id = '$A' and coalesce(l.scored_count, 0) = 0;")"
if [ "$bad" != "0" ]; then
  echo "REPRO CONFIRMED: $bad identity/identities of the account carry lifetime 0"
  echo "  → deleting the account and signing in with that provider restores 2 free ratings"
  exit 1
fi
echo "no anomaly (ledger in step)"
