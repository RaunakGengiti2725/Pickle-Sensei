#!/usr/bin/env bash
# S5: superuser deletes Alice's auth.users row while a concurrent authenticated
# session is inside apply_synced_shot() holding her permit FOR UPDATE (and the
# per-user advisory lock) in an open transaction. The cascade must WAIT for the
# sync transaction, then remove every owned row — no orphan shot_phases /
# shot_checkpoints / shots / analysis_permits may survive the account.
#
#   order A : sync first (holds locks 3 s), delete arrives 1 s later.
#   order B : delete first (held open 3 s), sync arrives 1 s later.
# Requires PGHOST/PGPORT/PGUSER/PGPASSWORD (superuser) and $TEMPLATE_DB.
# Exit 0 = HELD, 1 = BROKEN.
set -uo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
ART=${ATTACK_ARTIFACTS:-"$HERE/artifacts"}
mkdir -p "$ART"
TEMPLATE_DB=${TEMPLATE_DB:-attack_base}

ALICE=00000000-0000-4000-8000-00000000000a
PERMIT=00000000-0000-4000-8000-0000000000a1
SHOT=00000000-0000-4000-8000-0000000000e1

orphans_sql="select
  (select count(*) from public.shots where user_id='$ALICE') as shots,
  (select count(*) from public.shot_phases where user_id='$ALICE' or shot_id='$SHOT') as phases,
  (select count(*) from public.shot_checkpoints where user_id='$ALICE' or shot_id='$SHOT') as checkpoints,
  (select count(*) from public.shot_measurements where user_id='$ALICE') as measurements,
  (select count(*) from public.analysis_permits where user_id='$ALICE') as permits,
  (select count(*) from public.profiles where id='$ALICE') as profiles,
  (select count(*) from auth.users where id='$ALICE') as users,
  (select count(*) from auth.identities where user_id='$ALICE') as identities,
  (select coalesce(max(scored_count),0) from public.free_rating_ledger) as ledger_max"

broken=0
for order in a b; do
  DB="s5_order_${order}"
  psql -d postgres -qc "drop database if exists $DB" -c "create database $DB template $TEMPLATE_DB" >/dev/null 2>&1
  psql -d "$DB" -q -v ON_ERROR_STOP=1 -f "$HERE/_seed_alice.sql" >/dev/null
  psql -d "$DB" -q -v ON_ERROR_STOP=1 -c \
    "insert into public.analysis_permits (id, user_id, idempotency_key) values ('$PERMIT', '$ALICE', 'p1')"

  if [ "$order" = a ]; then
    sync_pre=0; sync_post=3; del_pre=1; del_post=0
  else
    sync_pre=1; sync_post=0; del_pre=0; del_post=3
  fi
  echo "S5 order $order: sync(pre=$sync_pre hold=$sync_post) delete(pre=$del_pre hold=$del_post)"

  t0=$(date +%s.%N)
  psql -d "$DB" -qtA -v permit="$PERMIT" -v shot="$SHOT" -v presleep="$sync_pre" -v postsleep="$sync_post" -f "$HERE/_sync_one.sql" >"$ART/s5_${order}_sync.out" 2>&1 &
  ps_sync=$!
  psql -d "$DB" -qtA -v ON_ERROR_STOP=1 -c "select pg_sleep($del_pre)" -c "begin" \
    -c "delete from auth.users where id = '$ALICE'" \
    -c "select 'DELETE_DONE_AT ' || extract(epoch from clock_timestamp())" \
    -c "select pg_sleep($del_post)" -c "commit" >"$ART/s5_${order}_delete.out" 2>&1 &
  ps_del=$!
  wait $ps_sync; rc_sync=$?
  wait $ps_del; rc_del=$?
  t1=$(date +%s.%N)
  sync_line=$(grep '^SYNC' "$ART/s5_${order}_sync.out" | awk '{print $3}')
  del_done=$(grep '^DELETE_DONE_AT' "$ART/s5_${order}_delete.out" | awk '{print $2}')
  echo "S5 order $order: sync exit=$rc_sync result=${sync_line:-<none>} | delete exit=$rc_del | wall=$(awk -v a=$t0 -v b=$t1 'BEGIN{printf "%.2f", b-a}')s"
  if [ "$order" = a ]; then
    # The delete must have been blocked until the sync committed (~3 s after start).
    waited=$(awk -v d="$del_done" -v t=$t0 'BEGIN{printf "%.2f", d-t}')
    echo "S5 order a: delete statement finished ${waited}s after start (sync held locks 3 s)"
  fi
  grep -i 'error' "$ART/s5_${order}_sync.out" "$ART/s5_${order}_delete.out" | sed 's/^/S5 /' || true

  state=$(psql -d "$DB" -qtA -F' ' -c "$orphans_sql")
  echo "S5 order $order: shots phases checkpoints measurements permits profiles users identities ledger_max = $state"
  read -r shots phases checkpoints measurements permits profiles users identities ledger <<<"$state"

  ok=1
  [ "$rc_del" -eq 0 ] || ok=0
  [ "$shots" = 0 ] && [ "$phases" = 0 ] && [ "$checkpoints" = 0 ] && [ "$measurements" = 0 ] \
    && [ "$permits" = 0 ] && [ "$profiles" = 0 ] && [ "$users" = 0 ] && [ "$identities" = 0 ] || ok=0
  if [ "$order" = a ]; then
    # Sync won the race: it must have been accepted and the ledger must remember it.
    [ "$sync_line" = accepted ] && [ "$ledger" = 1 ] || ok=0
    awk -v w="$waited" 'BEGIN{exit !(w >= 2.5)}' || { echo "S5 order a: BROKEN delete did not wait for the FOR UPDATE holder"; ok=0; }
  else
    # Delete won: the sync must fail closed (permit gone) and write nothing.
    case "$sync_line" in
      access.permit_not_found|access.permit_not_reserved) ;;
      *) [ "$rc_sync" -ne 0 ] || ok=0 ;;
    esac
    [ "$ledger" = 0 ] || ok=0
  fi
  if [ "$ok" -eq 1 ]; then
    echo "RESULT S5 order $order: HELD cascade serialized against the sync; no orphans"
  else
    echo "RESULT S5 order $order: BROKEN (see $ART/s5_${order}_*.out)"
    broken=1
  fi
  psql -d postgres -qc "drop database $DB" >/dev/null
done

if [ "$broken" -ne 0 ]; then echo "RESULT S5: BROKEN"; exit 1; fi
echo "RESULT S5: HELD"
