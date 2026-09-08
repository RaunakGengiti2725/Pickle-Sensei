-- W07-03 attack A7 — unauthorised roles on the new SQL surfaces, allowed AND
-- denied paths, including the ones the candidate suite does not pin:
--   * a signed-in user (authenticated + JWT sub) who IS a transfer party
--     reading their own recovery record / queue rows / audit / sequence;
--   * anon on the recovery helper and on the guard trigger function;
--   * service_role reading the private tables directly (must be denied — the
--     RPC is the only path) and via the RPC (must be allowed);
--   * service_role calling the private helpers (settle/apply/note) directly;
--   * the definer functions must not be callable by public through the
--     implicit PUBLIC execute grant.
-- A raise below is a confirmed break.
\set ON_ERROR_STOP on
begin;
insert into auth.users (id, email, raw_app_meta_data) values
  ('00000000-0000-4000-8000-00000000a701', 'w07a7-src@example.test', '{"provider":"google"}'),
  ('00000000-0000-4000-8000-00000000a702', 'w07a7-dst@example.test', '{"provider":"apple"}');

set local role service_role;
do $$
declare
  src uuid := '00000000-0000-4000-8000-00000000a701';
  dst uuid := '00000000-0000-4000-8000-00000000a702';
  payload jsonb := jsonb_build_object('event', jsonb_build_object(
    'id', 'w07a7-transfer', 'type', 'TRANSFER',
    'transferred_from', jsonb_build_array(src::text),
    'transferred_to', jsonb_build_array(dst::text)));
  lease uuid;
begin
  lease := (public.claim_billing_webhook_delivery('w07a7-transfer', payload)->>'lease_token')::uuid;
  perform public.begin_billing_verification(array[src, dst], 'w07a7-transfer', payload, lease);
  -- allowed path: service_role reads the queue through the RPC
  if jsonb_array_length(public.billing_transfer_recovery(dst)) <> 1 then
    raise exception 'W07-A7 setup: recovery must expose the pending transfer';
  end if;
end $$;
reset role;

create temp table w07a7_denied (label text, statement text, sqlstates text[]);
grant select on w07a7_denied to public;
insert into w07a7_denied values
  ('authenticated party reads billing_transfers', 'select count(*) from api_private.billing_transfers', '{42501}'),
  ('authenticated party reads billing_transfer_sides', 'select count(*) from api_private.billing_transfer_sides', '{42501}'),
  ('authenticated party reads billing_transfer_audit', 'select count(*) from api_private.billing_transfer_audit', '{42501}'),
  ('authenticated party reads the audit sequence', 'select nextval(pg_get_serial_sequence(''api_private.billing_transfer_audit'', ''id''))', '{42501}'),
  ('authenticated party calls billing_transfer_recovery(own id)', 'select public.billing_transfer_recovery(''00000000-0000-4000-8000-00000000a702''::uuid)', '{42501}'),
  ('authenticated party calls enqueue_billing_transfer', 'select public.enqueue_billing_transfer(''w07a7-transfer'', ''{}''::jsonb, gen_random_uuid())', '{42501}'),
  ('authenticated party calls settle_billing_transfer', 'select api_private.settle_billing_transfer(gen_random_uuid())', '{42501}'),
  ('authenticated party calls apply_billing_transfer_side', 'select api_private.apply_billing_transfer_side(null::api_private.billing_transfers, null::api_private.billing_transfer_sides)', '{42501}'),
  ('authenticated party calls note_billing_transfer', 'select api_private.note_billing_transfer(null::api_private.billing_transfers, null::uuid, ''held'')', '{42501}'),
  ('authenticated party calls billing_transfer_party_ids', 'select api_private.billing_transfer_party_ids(''{}''::jsonb, ''transferred_from'')', '{42501}'),
  ('authenticated party calls billing_transfer_summary', 'select api_private.billing_transfer_summary(null::api_private.billing_transfers)', '{42501}'),
  ('authenticated party calls billing_verdict_active', 'select api_private.billing_verdict_active(''{}''::jsonb, now())', '{42501}'),
  ('authenticated party calls guard_billing_transfer_history', 'select api_private.guard_billing_transfer_history()', '{42501,0A000}'),
  ('authenticated party inserts a transfer', 'insert into api_private.billing_transfers (event_id, payload_hash, source_user_ids, destination_user_ids) values (''x'', ''h'', ''{}'', ''{}'')', '{42501}'),
  ('authenticated party inserts audit', 'insert into api_private.billing_transfer_audit (transfer_id, event_id, action) values (gen_random_uuid(), ''x'', ''held'')', '{42501}'),
  ('authenticated party deletes audit', 'delete from api_private.billing_transfer_audit', '{42501}'),
  ('authenticated party updates a side', 'update api_private.billing_transfer_sides set verdict = null', '{42501}');

do $$
declare
  probe record;
  outcome text;
  broken text[] := '{}';
begin
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000a702', true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  set local role authenticated;
  for probe in select * from pg_temp.w07a7_denied loop
    begin
      execute probe.statement;
      outcome := 'ALLOWED';
    exception when others then
      outcome := sqlstate;
    end;
    if not (outcome = any (probe.sqlstates)) then
      broken := array_append(broken, format('%s => %s', probe.label, outcome));
    end if;
  end loop;
  reset role;
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claim.role', 'anon', true);
  set local role anon;
  for probe in select * from pg_temp.w07a7_denied loop
    begin
      execute probe.statement;
      outcome := 'ALLOWED';
    exception when others then
      outcome := sqlstate;
    end;
    if not (outcome = any (probe.sqlstates)) then
      broken := array_append(broken, format('anon: %s => %s', probe.label, outcome));
    end if;
  end loop;
  reset role;
  -- service_role: private tables/helpers denied, public RPCs allowed.
  set local role service_role;
  for probe in select * from pg_temp.w07a7_denied
      where label not like '%billing_transfer_recovery%' and label not like '%enqueue_billing_transfer%' loop
    begin
      execute probe.statement;
      outcome := 'ALLOWED';
    exception when others then
      outcome := sqlstate;
    end;
    if not (outcome = any (probe.sqlstates)) then
      broken := array_append(broken, format('service_role: %s => %s', probe.label, outcome));
    end if;
  end loop;
  begin
    perform public.enqueue_billing_transfer('w07a7-transfer', '{}'::jsonb, gen_random_uuid());
    broken := array_append(broken, 'service_role: enqueue with a foreign lease and wrong payload was accepted');
  exception when others then
    if sqlstate not in ('22023', '55000') then
      broken := array_append(broken, format('service_role: enqueue rejection used %s', sqlstate));
    end if;
  end;
  reset role;
  if cardinality(broken) > 0 then
    raise exception 'W07-A7: %', array_to_string(broken, ' | ');
  end if;
end $$;
rollback;
