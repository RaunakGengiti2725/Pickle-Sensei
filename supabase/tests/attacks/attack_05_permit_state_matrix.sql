-- ATTACK 05 — exhaustive permit state machine with the NEW 'partial' word
-- (20260908100000_permit_partial_terminal_outcome), corrupt/partial state
-- included.
--
-- The migration's contract (its guard comment): reserved ⇔ outcome IS NULL;
-- settled rows carry a known outcome; partial is only ever released; the only
-- lifecycle moves are reserved → any settled state and released/expired →
-- finalized/scored | released/low_confidence | released/partial |
-- released/free_limit_exceeded; everything else is 23514 with hint
-- access.permit_transition_rejected — for EVERY role.
--
--   M1  INSERT of every shape (owner) — allowed iff the shape is legal.
--   M2  UPDATE from every reachable state to every shape, as the OWNER —
--       verdict must equal the contract for all 18 x 24 pairs.
--   M3  the same 18 x 24 matrix as the CLIENT role on its own rows — the
--       verdict must be identical to the owner's (no role-dependent hole).
--   M4  the exact pg_cron sweep statement over a table holding every state
--       aged 25h: only reserved rows move, to released/expired, no error.
--   M5  corrupt state: a settled row whose outcome is an unknown word cannot
--       be created, and a legacy released/NULL row (pre-guard, seeded with
--       triggers disabled as a table owner could) can only be settled the
--       way the contract says — never back to reserved.
begin;
\ir _helpers.sql

create table pg_temp.states (status text, outcome text, legal boolean);
insert into pg_temp.states
select s, o,
  ((s = 'reserved') = (o is null))
  and (s = 'reserved' or o in ('scored','low_confidence','partial','cancelled','failed','unsupported','incorrect_recognition','expired','free_limit_exceeded'))
  and not (coalesce(o, '') = 'partial' and s <> 'released')
from unnest(array['reserved','finalized','released']) s,
     unnest(array[null,'scored','low_confidence','partial','cancelled','failed','unsupported','incorrect_recognition','expired','free_limit_exceeded','bogus']) o;

create function pg_temp.expected(p_from_s text, p_from_o text, p_to_s text, p_to_o text) returns text
language sql as $$
  select case
    when not coalesce((select legal from pg_temp.states where status = p_to_s and outcome is not distinct from p_to_o), false) then '23514:access.permit_transition_rejected'
    when p_from_s = p_to_s and p_from_o is not distinct from p_to_o then 'allowed 1'
    when p_from_s = 'reserved' then 'allowed 1'
    when p_from_s = 'released' and p_from_o = 'expired'
         and (p_to_s, p_to_o) in (('finalized','scored'),('released','low_confidence'),('released','partial'),('released','free_limit_exceeded')) then 'allowed 1'
    else '23514:access.permit_transition_rejected'
  end
$$;
grant execute on function pg_temp.expected(text, text, text, text) to authenticated;
grant select on pg_temp.states to authenticated;

insert into auth.users (id, email, raw_app_meta_data) values
  ('00000000-0000-4000-8000-00000000a501', 'a05-matrix@example.test', '{"provider":"google"}');

-- --------------------------------------------------------------------------
-- M1: INSERT of every shape as the owner.
-- --------------------------------------------------------------------------
do $$
declare st record; r text; n_legal integer := 0; n_illegal integer := 0;
begin
  for st in select * from pg_temp.states loop
    r := pg_temp.q_try(format(
      $q$insert into public.analysis_permits (user_id, idempotency_key, status, outcome)
         values ('00000000-0000-4000-8000-00000000a501', %L, %L, %L)$q$,
      'm1-' || st.status || '-' || coalesce(st.outcome, 'NULL'), st.status, st.outcome));
    if st.legal then
      perform pg_temp.check_eq(r, 'allowed 1', format('M1: INSERT %s/%s must be allowed', st.status, coalesce(st.outcome, 'NULL')));
      n_legal := n_legal + 1;
    else
      perform pg_temp.check_eq(r, '23514:access.permit_transition_rejected', format('M1: INSERT %s/%s must be refused', st.status, coalesce(st.outcome, 'NULL')));
      n_illegal := n_illegal + 1;
    end if;
  end loop;
  perform pg_temp.check_eq(n_legal::text || '/' || n_illegal::text, '18/15', 'M1: 18 legal shapes, 15 illegal shapes probed');
  delete from public.analysis_permits where user_id = '00000000-0000-4000-8000-00000000a501';
end $$;

-- --------------------------------------------------------------------------
-- M2 / M3: the full transition matrix as owner and as the client.
-- --------------------------------------------------------------------------
create function pg_temp.seed_matrix(p_tag text) returns void
language plpgsql as $$
declare f record; t record; i integer := 0;
begin
  for f in select * from pg_temp.states where legal loop
    for t in select * from pg_temp.states loop
      i := i + 1;
      insert into public.analysis_permits (id, user_id, idempotency_key, status, outcome)
      values (('00000000-0000-4000-8000-00' || p_tag || lpad(to_hex(i), 6, '0'))::uuid,
              '00000000-0000-4000-8000-00000000a501',
              format('%s-%s/%s->%s/%s', p_tag, f.status, coalesce(f.outcome,'NULL'), t.status, coalesce(t.outcome,'NULL')),
              f.status, f.outcome);
    end loop;
  end loop;
end $$;

create function pg_temp.run_matrix(p_tag text, p_role text) returns void
language plpgsql as $$
declare f record; t record; i integer := 0; r text; want text; id uuid; after text; n integer := 0;
begin
  for f in select * from pg_temp.states where legal loop
    for t in select * from pg_temp.states loop
      i := i + 1;
      id := ('00000000-0000-4000-8000-00' || p_tag || lpad(to_hex(i), 6, '0'))::uuid;
      want := pg_temp.expected(f.status, f.outcome, t.status, t.outcome);
      r := pg_temp.p_move(id, t.status, t.outcome);
      perform pg_temp.check_eq(r, want, format('%s %s/%s -> %s/%s', p_role, f.status, coalesce(f.outcome,'NULL'), t.status, coalesce(t.outcome,'NULL')));
      after := pg_temp.r_permit(id);
      if want = 'allowed 1' then
        perform pg_temp.check_eq(after, t.status || '/' || coalesce(t.outcome, 'NULL'), format('%s state after allowed move', p_role));
      else
        perform pg_temp.check_eq(after, f.status || '/' || coalesce(f.outcome, 'NULL'), format('%s state after refused move', p_role));
      end if;
      n := n + 1;
    end loop;
  end loop;
  perform pg_temp.check_eq(n::text, '594', p_role || ': 18 from-states x 33 to-shapes probed');
  perform pg_temp.check_eq((select count(*) from pg_temp.states where legal)::text, '18', p_role || ': exactly 18 legal shapes');
end $$;
grant execute on function pg_temp.run_matrix(text, text) to authenticated;

select pg_temp.seed_matrix('0a51');
select pg_temp.run_matrix('0a51', 'M2 owner');

select pg_temp.seed_matrix('0a52');
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000a501';
select pg_temp.run_matrix('0a52', 'M3 client');
reset role;
set local request.jwt.claim.sub = '';

-- --------------------------------------------------------------------------
-- M4: the exact pg_cron sweep over every legal state aged 25h.
-- --------------------------------------------------------------------------
do $$
declare st record; r text; moved integer;
begin
  delete from public.analysis_permits where user_id = '00000000-0000-4000-8000-00000000a501';
  for st in select * from pg_temp.states where legal loop
    insert into public.analysis_permits (user_id, idempotency_key, status, outcome, created_at)
    values ('00000000-0000-4000-8000-00000000a501', 'm4-' || st.status || '-' || coalesce(st.outcome,'NULL'), st.status, st.outcome, now() - interval '25 hours');
  end loop;
  r := pg_temp.q_try($q$update public.analysis_permits set status = 'released', outcome = 'expired'
                        where status = 'reserved' and created_at < now() - interval '24 hours'$q$);
  perform pg_temp.check_eq(r, 'allowed 1', 'M4: the sweep moves exactly the one reserved row');
  select count(*) into moved from public.analysis_permits
  where user_id = '00000000-0000-4000-8000-00000000a501' and status = 'released' and outcome = 'expired';
  perform pg_temp.check_eq(moved::text, '2', 'M4: the swept row joins the pre-existing released/expired row');
  for st in select * from pg_temp.states where legal and status <> 'reserved' and not (status = 'released' and outcome = 'expired') loop
    perform pg_temp.check_eq(
      (select status || '/' || coalesce(outcome,'NULL') from public.analysis_permits
       where idempotency_key = 'm4-' || st.status || '-' || coalesce(st.outcome,'NULL')),
      st.status || '/' || coalesce(st.outcome,'NULL'), 'M4: settled rows untouched by the sweep');
  end loop;
end $$;

-- --------------------------------------------------------------------------
-- M5: corrupt persisted state.
-- --------------------------------------------------------------------------
do $$
declare r text; legacy uuid := '00000000-0000-4000-8000-00000000a5f1';
begin
  -- a legacy released/NULL row, written before the guards existed
  alter table public.analysis_permits disable trigger user;
  insert into public.analysis_permits (id, user_id, idempotency_key, status, outcome)
  values (legacy, '00000000-0000-4000-8000-00000000a501', 'm5-legacy', 'released', null);
  alter table public.analysis_permits enable trigger user;
  perform pg_temp.check_eq(pg_temp.r_permit(legacy), 'released/NULL', 'M5: legacy row exists');
  perform pg_temp.check_eq(pg_temp.p_move(legacy, 'reserved', null), '23514:access.permit_transition_rejected', 'M5: released/NULL cannot be reopened');
  perform pg_temp.check_eq(pg_temp.p_move(legacy, 'finalized', 'scored'), '23514:access.permit_transition_rejected', 'M5: released/NULL cannot become a rating');
  perform pg_temp.check_eq(pg_temp.p_move(legacy, 'released', 'partial'), '23514:access.permit_transition_rejected', 'M5: released/NULL cannot be relabelled partial');
  perform pg_temp.check_eq(pg_temp.p_move(legacy, 'released', 'expired'), '23514:access.permit_transition_rejected', 'M5: released/NULL cannot be relabelled expired (which would reopen late settlement)');
  perform pg_temp.check_eq(pg_temp.p_move(legacy, 'released', null), '23514:access.permit_transition_rejected', 'M5: even a no-op write of the illegal shape is refused');
  perform pg_temp.check_eq(pg_temp.r_permit(legacy), 'released/NULL', 'M5: legacy row unchanged');
  perform pg_temp.check_eq(public.permit_backs_sync('released', null)::text, 'false', 'M5: released/NULL never backs a sync');
  perform pg_temp.check_eq(public.permit_backs_sync(null, null)::text, 'false', 'M5: NULL/NULL never backs a sync');
  perform pg_temp.check_eq(public.permit_backs_sync('released', 'partial')::text, 'false', 'M5: released/partial never backs a sync');
  perform pg_temp.check_eq(public.permit_backs_sync('finalized', 'partial')::text, 'false', 'M5: finalized/partial never backs a sync');
  perform pg_temp.check_eq(public.permit_backs_sync('reserved', 'partial')::text, 'true', 'M5: permit_backs_sync trusts status=reserved regardless of outcome (shape is the guard''s job)');
end $$;

select format('ATTACK 05 permit state matrix: %s assertions passed', pg_temp.assertions());
rollback;
