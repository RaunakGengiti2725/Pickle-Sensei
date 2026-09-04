#!/usr/bin/env bash
# Deterministic two-session repro (no timing luck) of the harness finding
#   link_during_apply: an identity linked WHILE a scored shot is being
#   applied gets no free_rating_ledger row (or one behind the account).
#
#   S1  begin; apply_synced_shot(scored)   record_scored_shot_in_ledger()
#                                          upserts the identities visible to
#                                          S1 (google only)
#   S2  insert auth.identities (apple)     inherit_free_rating_ledger() reads
#       (autocommit)                       lifetime_scored_count() = 0 because
#                                          S1 is uncommitted → `if v_count > 0`
#                                          is false → NO row for apple
#   S1  commit                             google = 1, apple = <no row>
#
# Consequence: delete the account, sign in again with the Apple identity →
# identity_scored_count() = 0 → the two free ratings are available again.
#
# Usage: ./pg_up.sh && ./repro_link_during_apply.sh
#   exit 0 = anomaly reproduced, 1 = ledger consistent, 2 = setup error
set -euo pipefail
cd "$(dirname "$0")"
. ./repro_lib.sh

UID_=$(lower_uuid); TAG=${UID_:0:8}
SHOT=$(lower_uuid)
make_user "$UID_" "$TAG"
PERMIT=$(make_permit "$UID_" "k-$TAG")

open_session S1
send S1 "begin;" "set local role authenticated;" \
  "select set_config('request.jwt.claim.sub', '$UID_', true);" \
  "$(apply_sql "$SHOT" "$PERMIT")" '\echo S1_APPLIED'
wait_marker S1 S1_APPLIED

psql1 -c "insert into auth.identities (provider, provider_id, user_id, identity_data)
  values ('apple', 'apple-$TAG', '$UID_', jsonb_build_object('sub', 'apple-$TAG'));"
echo "S2> linked apple-$TAG (autocommit) while S1 is still open"

send S1 "commit;" '\echo S1_COMMITTED'
wait_marker S1 S1_COMMITTED
close_session S1

psql1 -F' ' <<SQL
select 'ledger', i.provider, coalesce(l.scored_count::text, '<no row>')
  from auth.identities i
  left join public.free_rating_ledger l
    on l.identity_hash = public.free_rating_identity_hash(i.provider, i.provider_id)
 where i.user_id = '$UID_' order by i.provider;
SQL

MISMATCH=$(psql1 -c "select count(*) from auth.identities i
  left join public.free_rating_ledger l on l.identity_hash = public.free_rating_identity_hash(i.provider, i.provider_id)
  where i.user_id = '$UID_'
    and coalesce(l.scored_count, 0) <> (select count(*) from public.shots where user_id = '$UID_' and result_kind = 'scored')")
if [[ "$MISMATCH" != "0" ]]; then
  echo "REPRODUCED: $MISMATCH identity of $UID_ disagrees with the account's scored count"
  # Consequence: delete the account, sign in again with the Apple identity only.
  NEW=$(lower_uuid)
  psql1 <<SQL
delete from auth.users where id = '$UID_';
insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data)
  values ('$NEW', '$TAG-again@stress.example.com', '{"full_name":"Repro"}', '{"provider":"apple"}');
insert into auth.identities (provider, provider_id, user_id, identity_data)
  values ('apple', 'apple-$TAG', '$NEW', jsonb_build_object('sub', 'apple-$TAG'));
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '$NEW', true);
select 'recreated-with-apple: lifetime_scored_count=' || public.lifetime_scored_count()
    || ' access_state.scored_count=' || (select scored_count from public.access_state())
    || ' reserved_count=' || (select reserved_count from public.access_state());
rollback;
select 'google identity ledger (what the same person would get signing in with Google): '
    || scored_count from public.free_rating_ledger
 where identity_hash = public.free_rating_identity_hash('google', 'google-$TAG');
SQL
  exit 0
fi
echo "NOT REPRODUCED: ledger consistent"
exit 1
