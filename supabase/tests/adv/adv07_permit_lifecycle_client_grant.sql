-- ADV-07 — the client's column grant on analysis_permits (status, outcome)
-- used as a lifecycle weapon: reopen a settled permit, re-label a refused one
-- into acceptable backing, upgrade a partial, invent a finalized/partial,
-- bump a terminal state sideways, edit the immutable columns, delete, and
-- resurrect a tombstoned permit in a different shape. Also the moves the
-- edge finalize route legitimately makes must still work (owner path), and
-- a consumed permit re-labelled by the client must never back a second shot.
\set ON_ERROR_STOP on
begin;

insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data) values
 ('00000000-0000-4000-8000-0000000007a1','oli@example.com','{"full_name":"Oli"}','{"provider":"apple"}');
insert into auth.identities (provider, provider_id, user_id, identity_data) values
 ('apple','adv07-oli','00000000-0000-4000-8000-0000000007a1','{"sub":"adv07-oli"}');
insert into auth.sessions (id, user_id) values
 ('00000000-0000-4000-8000-0000000007a2','00000000-0000-4000-8000-0000000007a1');

create function pg_temp.shot(p_id uuid, p_permit uuid, p_kind text) returns jsonb language sql as $$
  select jsonb_build_object('id', p_id, 'analysisPermitId', p_permit, 'resultKind', p_kind,
    'shotType', 'drive', 'capturedAt', '2026-09-08T10:00:00Z', 'startMs', 0, 'endMs', 1000,
    'confidence', case when p_kind = 'scored' then 0.9 else 0.2 end,
    'overallScore', case when p_kind = 'scored' then 7.2 else null end,
    'versionVector', jsonb_build_object('appVersion', '1.0.0', 'modelBundleVersion', 'b', 'poseModelVersion', 'p',
      'paddleModelVersion', 'p', 'strokeDetectorVersion', 's', 'phaseModelVersion', 'p', 'scoringModelVersion', 's',
      'shotConfigVersion', 'c'))
$$;
grant execute on function pg_temp.shot(uuid, uuid, text) to authenticated;

-- try one UPDATE; returns 'ok' when a row changed, 'norow' when RLS hid it, else the sqlstate
create function pg_temp.move(p_id uuid, p_status text, p_outcome text) returns text language plpgsql as $$
begin
  update public.analysis_permits set status = p_status, outcome = p_outcome where id = p_id;
  if not found then return 'norow'; end if;
  return 'ok';
exception when others then
  return sqlstate;
end $$;
grant execute on function pg_temp.move(uuid, text, text) to authenticated;

do $$ begin perform set_config('request.headers',
  jsonb_build_object('x-pickle-api-key', public.get_api_request_key())::text, true); end $$;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000007a1';
set local request.jwt.claims = '{"session_id":"00000000-0000-4000-8000-0000000007a2"}';

do $$
declare
  oli uuid := '00000000-0000-4000-8000-0000000007a1';
  r record; v text; bad text[] := '{}';
  p_scored uuid; p_low uuid; p_refused uuid; p_expired uuid; p_partial uuid; p_cancel uuid;
begin
  -- owner path: the finalize-route moves a client legitimately makes
  select permit_id into p_cancel from public.reserve_analysis_permit('adv07-cancel');
  if pg_temp.move(p_cancel, 'released', 'cancelled') <> 'ok' then bad := array_append(bad, 'owner_cannot_cancel'); end if;
  select permit_id into p_partial from public.reserve_analysis_permit('adv07-partial');
  if pg_temp.move(p_partial, 'released', 'partial') <> 'ok' then bad := array_append(bad, 'owner_cannot_release_partial'); end if;
  select permit_id into p_expired from public.reserve_analysis_permit('adv07-expired');
  if pg_temp.move(p_expired, 'released', 'expired') <> 'ok' then bad := array_append(bad, 'owner_cannot_expire'); end if;

  -- a real scored rating on a real permit
  select permit_id into p_scored from public.reserve_analysis_permit('adv07-scored');
  v := public.apply_synced_shot(pg_temp.shot('00000000-0000-4000-8000-0000000007c1', p_scored, 'scored'));
  if v <> 'accepted' then raise exception 'ADV-07 precondition: scored sync refused (%)', v; end if;
  select permit_id into p_low from public.reserve_analysis_permit('adv07-low');
  v := public.apply_synced_shot(pg_temp.shot('00000000-0000-4000-8000-0000000007c2', p_low, 'low_confidence'));
  if v <> 'accepted' then raise exception 'ADV-07 precondition: low_confidence sync refused (%)', v; end if;

  -- illegal shapes
  if pg_temp.move(p_cancel, 'finalized', 'partial') <> '23514' then bad := array_append(bad, 'finalized_partial_' || pg_temp.move(p_cancel, 'finalized', 'partial')); end if;
  if pg_temp.move(p_cancel, 'released', null) <> '23514' then bad := array_append(bad, 'released_null'); end if;
  if pg_temp.move(p_cancel, 'reserved', 'scored') <> '23514' then bad := array_append(bad, 'reserved_with_outcome'); end if;
  if pg_temp.move(p_cancel, 'finalized', 'bogus') <> '23514' then bad := array_append(bad, 'unknown_outcome'); end if;
  -- reopen / re-label terminal states
  if pg_temp.move(p_scored, 'reserved', null) <> '23514' then bad := array_append(bad, 'reopen_scored'); end if;
  if pg_temp.move(p_scored, 'released', 'expired') <> '23514' then bad := array_append(bad, 'scored_to_expired'); end if;
  if pg_temp.move(p_low, 'finalized', 'scored') <> '23514' then bad := array_append(bad, 'low_to_scored'); end if;
  if pg_temp.move(p_low, 'reserved', null) <> '23514' then bad := array_append(bad, 'reopen_low'); end if;
  if pg_temp.move(p_partial, 'finalized', 'scored') <> '23514' then bad := array_append(bad, 'partial_to_scored'); end if;
  if pg_temp.move(p_partial, 'released', 'expired') <> '23514' then bad := array_append(bad, 'partial_to_expired'); end if;
  if pg_temp.move(p_cancel, 'reserved', null) <> '23514' then bad := array_append(bad, 'reopen_cancelled'); end if;
  if pg_temp.move(p_cancel, 'released', 'expired') <> '23514' then bad := array_append(bad, 'cancelled_to_expired'); end if;
  -- the one late door: released/expired -> finalized/scored is allowed by the guard, but must not back a shot
  if pg_temp.move(p_expired, 'finalized', 'scored') <> 'ok' then bad := array_append(bad, 'expired_late_scored_refused'); end if;
  v := public.apply_synced_shot(pg_temp.shot('00000000-0000-4000-8000-0000000007c3', p_expired, 'scored'));
  if v = 'accepted' then bad := array_append(bad, 'client_labelled_finalized_backs_shot'); end if;
  -- a refused permit re-labelled into backing
  select permit_id into p_refused from public.reserve_analysis_permit('adv07-refused');
  if pg_temp.move(p_refused, 'released', 'free_limit_exceeded') <> 'ok' then bad := array_append(bad, 'owner_cannot_refuse'); end if;
  if pg_temp.move(p_refused, 'reserved', null) <> '23514' then bad := array_append(bad, 'refused_reopened'); end if;
  if pg_temp.move(p_refused, 'released', 'expired') <> '23514' then bad := array_append(bad, 'refused_to_expired'); end if;

  -- immutable columns: no grant at all
  begin
    update public.analysis_permits set idempotency_key = 'adv07-stolen' where id = p_scored;
    bad := array_append(bad, 'idempotency_key_updatable');
  exception when insufficient_privilege then null;
  end;
  begin
    update public.analysis_permits set user_id = gen_random_uuid() where id = p_scored;
    bad := array_append(bad, 'user_id_updatable');
  exception when insufficient_privilege then null;
  end;
  begin
    update public.analysis_permits set created_at = now() - interval '30 days' where id = p_scored;
    bad := array_append(bad, 'created_at_updatable');
  exception when insufficient_privilege then null;
  end;
  begin
    delete from public.analysis_permits where id = p_scored;
    bad := array_append(bad, 'permit_deletable');
  exception when insufficient_privilege then null;
  end;

  -- the consumed permit is still exactly finalized/scored and backs nothing further
  if (select status || '/' || outcome from public.analysis_permits where id = p_scored) <> 'finalized/scored' then
    bad := array_append(bad, 'scored_permit_mutated');
  end if;
  v := public.apply_synced_shot(pg_temp.shot('00000000-0000-4000-8000-0000000007c4', p_scored, 'scored'));
  if v <> 'access.permit_not_reserved' then bad := array_append(bad, 'consumed_permit_backs_again=' || v); end if;
  if (select count(*) from public.shots where user_id = oli) <> 2 then bad := array_append(bad, 'shot_count_drift'); end if;

  perform set_config('adv07.p_scored', p_scored::text, true);
  perform set_config('adv07.bad', bad::text, true);
end $$;

-- owner-role deletion of the consumed permit leaves a tombstone; the client may not resurrect it in another shape
reset role;
delete from public.analysis_permits where id = current_setting('adv07.p_scored')::uuid;
set local role authenticated;
do $$
declare bad text[] := current_setting('adv07.bad')::text[]; v text; p uuid := current_setting('adv07.p_scored')::uuid;
begin
  if not public.permit_tombstoned(p) then bad := array_append(bad, 'no_tombstone_after_owner_delete'); end if;
  begin
    insert into public.analysis_permits (id, user_id, idempotency_key) values (p, '00000000-0000-4000-8000-0000000007a1', 'adv07-scored');
    bad := array_append(bad, 'tombstoned_permit_resurrected_as_reserved');
  exception when check_violation or insufficient_privilege then null; -- no column grant on id, or the tombstone guard

  end;
  begin
    insert into public.analysis_permits (id, user_id, idempotency_key, status, outcome)
      values (p, '00000000-0000-4000-8000-0000000007a1', 'adv07-scored-2', 'finalized', 'scored');
    bad := array_append(bad, 'tombstoned_permit_resurrected_with_new_key');
  exception when check_violation or insufficient_privilege then null;
  end;
  -- reserving under the consumed key after the owner removed the row is a NEW reservation (the key is
  -- free again and the lifetime allowance still has one rating left); it must never revive the
  -- tombstoned id and the allowance gate must still count the shot the deleted permit backed
  select result into v from public.reserve_analysis_permit('adv07-scored');
  if v = 'accepted' and exists (select 1 from public.analysis_permits where id = p) then
    bad := array_append(bad, 'consumed_key_revived_tombstoned_id');
  end if;
  if not public.permit_tombstoned(p) then bad := array_append(bad, 'tombstone_lost_on_key_reuse'); end if;
  if public.access_state()::text <> '(f,1,1)' then
    bad := array_append(bad, 'access_state_after_key_reuse=' || public.access_state()::text);
  end if;
  -- the shot that the deleted permit backed is still there and still counts
  if (select count(*) from public.shots where result_kind = 'scored') <> 1 or public.lifetime_scored_count() <> 1 then
    bad := array_append(bad, 'lifetime_count_lost_with_permit');
  end if;
  raise notice 'ADV-07 findings: %', bad;
  if cardinality(bad) > 0 then raise exception 'ADV-07 BREAK: %', bad; end if;
  raise notice 'ADV-07: PASS';
end $$;
rollback;
