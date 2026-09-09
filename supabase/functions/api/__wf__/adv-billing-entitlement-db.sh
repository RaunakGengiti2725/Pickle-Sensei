#!/usr/bin/env bash
# INT-billing-entitlement adversary (attacked head 2994371e) — database runner.
#
#   ./supabase/functions/api/__wf__/adv-billing-entitlement-db.sh
#
# Spins up a throwaway postgres:16 (Docker), installs the Supabase shim,
# applies every migration in order, then:
#   1. runs supabase/tests/adv_billing_entitlement.sql (sequential attacks
#      ADV-SQL-1..5: verifiedAt clamp boundaries vs verification_order, a
#      destination's own premium row under a withheld transfer verdict,
#      chained transfers, destination re-sync storms, expired premium rows);
#   2. ADV-SQL-C1: issues 8 ordered tickets for ONE user and persists all 8
#      verdicts CONCURRENTLY in shuffled order — every call must succeed (no
#      deadlock, no error), every ticket must be consumed, and the row must end
#      at the highest-order verdict regardless of arrival order;
#   3. ADV-SQL-C2: queues 7 transfers A_k→B_k plus a chained B_7→C_7 and
#      persists all 16 sides CONCURRENTLY — every call must succeed, every
#      A_k→B_k transfer must confirm with its destination premium, the
#      chain must leave A→B confirmed / B→C held, and B's later loss must
#      confirm the chain.
# Exits non-zero on any violated invariant.
set -euo pipefail

cd "$(dirname "$0")/../../.."   # → supabase/

if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  echo "Docker is required for this check." >&2
  exit 1
fi

CONTAINER=pickle-adv-billing-db
cleanup() { docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup

docker run -d --name "$CONTAINER" -e POSTGRES_PASSWORD=pg postgres:16 >/dev/null
for _ in $(seq 1 30); do
  docker exec "$CONTAINER" pg_isready -U postgres >/dev/null 2>&1 && break
  sleep 1
done

docker cp tests "$CONTAINER":/tests
docker cp migrations "$CONTAINER":/migrations

docker exec "$CONTAINER" bash -c '
  set -euo pipefail
  psql -U postgres -v ON_ERROR_STOP=1 -q -f /tests/shim_auth.sql
  for f in /migrations/*.sql; do
    psql -U postgres -v ON_ERROR_STOP=1 -q -f "$f" >/dev/null 2>&1
  done

  echo "── ADV-SQL sequential attacks"
  psql -U postgres -v ON_ERROR_STOP=1 -f /tests/adv_billing_entitlement.sql

  count() { awk -v pat="$1" "\$0 ~ pat { n++ } END { print n + 0 }" "${@:2}"; }

  echo "── ADV-SQL-C1: 8 ordered verdicts for one user persisted concurrently"
  psql -U postgres -v ON_ERROR_STOP=1 -q <<SQL
create schema adv;
create table adv.tickets (label text primary key, user_id uuid not null, ticket_id uuid not null, verdict jsonb not null);
insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data)
values ('"'"'00000000-0000-4000-8000-00000000adc1'"'"', '"'"'adv-c1@example.com'"'"', '"'"'{}'"'"', '"'"'{"provider":"apple"}'"'"');
do \$\$
declare i integer; t uuid; u uuid := '"'"'00000000-0000-4000-8000-00000000adc1'"'"';
begin
  for i in 1..8 loop
    t := (public.begin_billing_verification(array[u])->0->>'"'"'ticket_id'"'"')::uuid;
    insert into adv.tickets values ('"'"'c1-'"'"' || i, u, t,
      case when i = 8 then '"'"'{"premium":true,"productKey":"pickle_sensei_pro_annual","expiresAt":"2999-01-01T00:00:00Z","activeEntitlements":["pickle_sensei_pro"]}'"'"'::jsonb
           when i % 2 = 1 then '"'"'{"premium":true,"productKey":"pickle_sensei_pro_monthly","expiresAt":"2998-01-01T00:00:00Z","activeEntitlements":["pickle_sensei_pro"]}'"'"'::jsonb
           else '"'"'{"premium":false,"productKey":null,"expiresAt":null,"activeEntitlements":[]}'"'"'::jsonb end);
  end loop;
end \$\$;
SQL
  rm -f /tmp/adv_c1_*.out
  for i in 5 2 8 1 7 3 6 4; do
    psql -U postgres -q -c "select pg_sleep(0.02); select (public.persist_billing_verdict(user_id, ticket_id, verdict))::text from adv.tickets where label = '"'"'c1-$i'"'"';" >/tmp/adv_c1_$i.out 2>&1 &
  done
  wait
  c1_persisted=$(count "\"outcome\": \"persisted\"" /tmp/adv_c1_*.out)
  c1_errors=$(count "ERROR" /tmp/adv_c1_*.out)
  c1_deadlocks=$(count "[Dd]eadlock" /tmp/adv_c1_*.out)
  c1_consumed=$(psql -U postgres -tA -c "select count(*) from api_private.billing_verification_tickets t join adv.tickets a on a.ticket_id = t.id where a.label like '"'"'c1-%'"'"' and t.verdict is not null")
  c1_row=$(psql -U postgres -tA -c "select premium::text || '"'"'|'"'"' || product_key || '"'"'|'"'"' || (verification_order = (select verification_order from api_private.billing_verification_tickets where id = (select ticket_id from adv.tickets where label = '"'"'c1-8'"'"')))::text from public.billing_entitlements where user_id = '"'"'00000000-0000-4000-8000-00000000adc1'"'"'")
  echo "persisted=$c1_persisted errors=$c1_errors deadlocks=$c1_deadlocks consumed=$c1_consumed row=$c1_row"
  if [ "$c1_persisted" != "8" ] || [ "$c1_errors" != "0" ] || [ "$c1_deadlocks" != "0" ] || [ "$c1_consumed" != "8" ] || [ "$c1_row" != "true|pickle_sensei_pro_annual|true" ]; then
    echo "ADV-SQL-C1: concurrent ordered persistence must succeed 8/8 and end at the highest-order verdict" >&2
    cat /tmp/adv_c1_*.out >&2
    exit 1
  fi
  echo "ADV-SQL-C1: PASSED"

  echo "── ADV-SQL-C2: 7 transfers + a chained pair, 16 sides persisted concurrently"
  psql -U postgres -v ON_ERROR_STOP=1 -q <<SQL
do \$\$
declare
  k integer; src uuid; dst uuid; mid uuid; payload jsonb; lease uuid; issued jsonb; item jsonb;
  active jsonb := '"'"'{"premium":true,"productKey":"pickle_sensei_pro_monthly","expiresAt":"2999-01-01T00:00:00Z","activeEntitlements":["pickle_sensei_pro"]}'"'"';
  inactive jsonb := '"'"'{"premium":false,"productKey":null,"expiresAt":null,"activeEntitlements":[]}'"'"';
begin
  for k in 1..7 loop
    src := ('"'"'00000000-0000-4000-8000-0000000c2a0'"'"' || k)::uuid;
    dst := ('"'"'00000000-0000-4000-8000-0000000c2b0'"'"' || k)::uuid;
    insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data) values
      (src, '"'"'adv-c2a'"'"' || k || '"'"'@example.com'"'"', '"'"'{}'"'"', '"'"'{"provider":"apple"}'"'"'),
      (dst, '"'"'adv-c2b'"'"' || k || '"'"'@example.com'"'"', '"'"'{}'"'"', '"'"'{"provider":"apple"}'"'"');
    payload := jsonb_build_object('"'"'event'"'"', jsonb_build_object('"'"'id'"'"', '"'"'adv-c2-'"'"' || k, '"'"'type'"'"', '"'"'TRANSFER'"'"',
      '"'"'transferred_from'"'"', jsonb_build_array(src), '"'"'transferred_to'"'"', jsonb_build_array(dst)));
    lease := (public.claim_billing_webhook_delivery('"'"'adv-c2-'"'"' || k, payload)->>'"'"'lease_token'"'"')::uuid;
    issued := public.begin_billing_verification(array[src, dst], '"'"'adv-c2-'"'"' || k, payload, lease);
    for item in select value from jsonb_array_elements(issued) loop
      insert into adv.tickets values (
        '"'"'c2-'"'"' || k || case when (item->>'"'"'user_id'"'"')::uuid = src then '"'"'-src'"'"' else '"'"'-dst'"'"' end,
        (item->>'"'"'user_id'"'"')::uuid, (item->>'"'"'ticket_id'"'"')::uuid,
        case when (item->>'"'"'user_id'"'"')::uuid = src then inactive else active end);
    end loop;
  end loop;
  -- chain: B7 -> C7 (B7 is transfer 7'"'"'s destination)
  mid := '"'"'00000000-0000-4000-8000-0000000c2b07'"'"';
  dst := '"'"'00000000-0000-4000-8000-0000000c2c07'"'"';
  insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data) values
    (dst, '"'"'adv-c2c7@example.com'"'"', '"'"'{}'"'"', '"'"'{"provider":"apple"}'"'"');
  payload := jsonb_build_object('"'"'event'"'"', jsonb_build_object('"'"'id'"'"', '"'"'adv-c2-chain'"'"', '"'"'type'"'"', '"'"'TRANSFER'"'"',
    '"'"'transferred_from'"'"', jsonb_build_array(mid), '"'"'transferred_to'"'"', jsonb_build_array(dst)));
  lease := (public.claim_billing_webhook_delivery('"'"'adv-c2-chain'"'"', payload)->>'"'"'lease_token'"'"')::uuid;
  issued := public.begin_billing_verification(array[mid, dst], '"'"'adv-c2-chain'"'"', payload, lease);
  for item in select value from jsonb_array_elements(issued) loop
    insert into adv.tickets values (
      case when (item->>'"'"'user_id'"'"')::uuid = mid then '"'"'c2-chain-src'"'"' else '"'"'c2-chain-dst'"'"' end,
      (item->>'"'"'user_id'"'"')::uuid, (item->>'"'"'ticket_id'"'"')::uuid, active);
  end loop;
end \$\$;
SQL
  rm -f /tmp/adv_c2_*.out
  labels=$(psql -U postgres -tA -c "select label from adv.tickets where label like '"'"'c2-%'"'"' order by md5(label)")
  n=0
  for label in $labels; do
    n=$((n + 1))
    psql -U postgres -q -c "select pg_sleep(0.02); select (public.persist_billing_verdict(user_id, ticket_id, verdict))::text from adv.tickets where label = '"'"'$label'"'"';" >/tmp/adv_c2_$n.out 2>&1 &
  done
  wait
  c2_persisted=$(count "\"outcome\": \"persisted\"" /tmp/adv_c2_*.out)
  c2_errors=$(count "ERROR" /tmp/adv_c2_*.out)
  c2_deadlocks=$(count "[Dd]eadlock" /tmp/adv_c2_*.out)
  c2_confirmed=$(psql -U postgres -tA -c "select count(*) from api_private.billing_transfers where event_id like '"'"'adv-c2-%'"'"' and event_id <> '"'"'adv-c2-chain'"'"' and state = '"'"'confirmed'"'"'")
  c2_dst_premium=$(psql -U postgres -tA -c "select count(*) from public.billing_entitlements where user_id::text like '"'"'00000000-0000-4000-8000-0000000c2b0%'"'"' and premium")
  c2_src_premium=$(psql -U postgres -tA -c "select count(*) from public.billing_entitlements where user_id::text like '"'"'00000000-0000-4000-8000-0000000c2a0%'"'"' and premium")
  c2_src_rows=$(psql -U postgres -tA -c "select count(*) from public.billing_entitlements where user_id::text like '"'"'00000000-0000-4000-8000-0000000c2a0%'"'"'")
  c2_chain=$(psql -U postgres -tA -c "select state from api_private.billing_transfers where event_id = '"'"'adv-c2-chain'"'"'")
  c2_c7=$(psql -U postgres -tA -c "select coalesce((select premium::text from public.billing_entitlements where user_id = '"'"'00000000-0000-4000-8000-0000000c2c07'"'"'), '"'"'absent'"'"')")
  echo "persisted=$c2_persisted/$n errors=$c2_errors deadlocks=$c2_deadlocks confirmed=$c2_confirmed dst_premium=$c2_dst_premium src_rows=$c2_src_rows src_premium=$c2_src_premium chain=$c2_chain c7=$c2_c7"
  if [ "$n" != "16" ] || [ "$c2_persisted" != "16" ] || [ "$c2_errors" != "0" ] || [ "$c2_deadlocks" != "0" ] \
     || [ "$c2_confirmed" != "7" ] || [ "$c2_dst_premium" != "7" ] || [ "$c2_src_rows" != "7" ] || [ "$c2_src_premium" != "0" ] \
     || [ "$c2_chain" != "held" ] || [ "$c2_c7" != "true" ]; then
    echo "ADV-SQL-C2: concurrent transfer persistence must settle every independent transfer and park the chain as held" >&2
    cat /tmp/adv_c2_*.out >&2
    exit 1
  fi
  psql -U postgres -v ON_ERROR_STOP=1 -q <<SQL
do \$\$
declare t uuid; r jsonb; b uuid := '"'"'00000000-0000-4000-8000-0000000c2b07'"'"';
begin
  t := (public.begin_billing_verification(array[b])->0->>'"'"'ticket_id'"'"')::uuid;
  r := public.persist_billing_verdict(b, t, '"'"'{"premium":false,"productKey":null,"expiresAt":null,"activeEntitlements":[]}'"'"');
  if (r->>'"'"'applied'"'"')::boolean is distinct from true then
    raise exception '"'"'ADV-SQL-C2: B7 loss must apply (got %)'"'"', r;
  end if;
  if (select state from api_private.billing_transfers where event_id = '"'"'adv-c2-chain'"'"') <> '"'"'confirmed'"'"' then
    raise exception '"'"'ADV-SQL-C2: the chain must confirm once B7 is confirmed lost'"'"';
  end if;
  if (select premium from public.billing_entitlements where user_id = b) then
    raise exception '"'"'ADV-SQL-C2: B7 must no longer be premium'"'"';
  end if;
  if not (select premium from public.billing_entitlements where user_id = '"'"'00000000-0000-4000-8000-0000000c2c07'"'"') then
    raise exception '"'"'ADV-SQL-C2: C7 must keep premium'"'"';
  end if;
  if exists (select 1 from api_private.billing_transfers where event_id like '"'"'adv-c2-%'"'"' and state <> '"'"'confirmed'"'"') then
    raise exception '"'"'ADV-SQL-C2: every transfer must be confirmed'"'"';
  end if;
end \$\$;
SQL
  echo "ADV-SQL-C2: PASSED"
'
echo "ADV BILLING ENTITLEMENT DB ATTACKS: ALL PASSED"
