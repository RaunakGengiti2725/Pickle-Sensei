-- ============================================================================
-- X3 — malformed / unicode / oversized payloads, rapid replays, and role
--      denial against the hot-path RPCs (apply_synced_shot,
--      reserve_analysis_permit, access_state).
--
-- Every probe runs as the owner (authenticated + JWT claim) unless stated,
-- inside one transaction that is rolled back. Sub-probes:
--
--   A. Role denial: anon has no EXECUTE on any RPC (42501); an authenticated
--      session WITHOUT a JWT sub claim gets 'auth.required' and writes
--      nothing.
--   B. Atomicity of a failing write: a 'scored' shot with overallScore null
--      (violates scored_shots_have_scores) → 'shot.write_failed:…', no shots
--      row, no phases, permit STILL reserved (clean retry). Then a shot whose
--      21st phase key is 65 chars (shot_detail_key_bounds) → same shape:
--      nothing partial survives.
--   C. Unicode: a 64-codepoint 4-byte-emoji shot_type (256 bytes) passes the
--      length() cap; a 65-codepoint one is refused; a 128-emoji idempotency
--      key reserves; a 129-char key is refused by analysis_permits_key_bounds
--      (NOT VALID applies to new rows).
--   D. Cross-user session: sessionId that belongs to another user →
--      'shot.session_not_found' and no write.
--   E. Rapid replays: 200 replays of one accepted shot id → every call
--      'accepted', exactly one row, ledger unchanged; 200 replays of one
--      idempotency key → one permit.
--   F. Clock skew on the shot itself: capturedAt in 2100 and in 1970 are
--      stored as given (the RPC does not validate them; the edge fn does) —
--      recorded, and player rank must still recompute without error.
--   G. Detail-row amplification: the RPC has no cap on phases/checkpoints
--      (the edge fn caps at 32/64). Recorded as OBSERVED only — the same
--      client role also holds direct INSERT on the detail tables under RLS,
--      so the RPC is not the boundary — but a low_confidence shot with 5,000
--      phases must at least not error out or count as a rating.
-- ============================================================================

\set ON_ERROR_STOP on
\set QUIET on

begin;

\i /attack/_helpers.sql

create temporary table attack_failures (probe text, detail text);
create temporary table results (k text, v text);
grant all on attack_failures, results to authenticated, anon;

select attack.new_user('00000000-0000-4000-8000-0000000000c3'::uuid, 'x3-owner@attack.example', 'apple', 'apple-sub-x3');
select attack.new_user('00000000-0000-4000-8000-0000000000d3'::uuid, 'x3-other@attack.example', 'google', 'google-sub-x3');
insert into public.sessions (id, user_id, started_at)
values ('00000000-0000-4000-8000-00000000d3a1', '00000000-0000-4000-8000-0000000000d3', now());

-- ---------------------------------------------------------------- A: denial
set local role anon;
do $$
declare probe record;
begin
  for probe in select * from (values
    ('access_state()',                     'select * from public.access_state()'),
    ('reserve_analysis_permit(text)',      'select * from public.reserve_analysis_permit(''x3-anon'')'),
    ('apply_synced_shot(jsonb)',           'select public.apply_synced_shot(''{}''::jsonb)'),
    ('lifetime_scored_count()',            'select public.lifetime_scored_count()'),
    ('identity_scored_count()',            'select public.identity_scored_count()')
  ) as t(label, sql) loop
    begin
      execute probe.sql;
      insert into attack_failures values ('X3-A', 'anon executed ' || probe.label);
      insert into results values ('A anon ' || probe.label, 'EXECUTED');
    exception when insufficient_privilege then
      insert into results values ('A anon ' || probe.label, sqlstate);
    end;
  end loop;
end $$;
reset role;

set local role authenticated;
-- no request.jwt.claim.sub → auth.uid() is null
insert into results select 'A authenticated/no-claim apply_synced_shot', public.apply_synced_shot(
  attack.shot_payload('00000000-0000-4000-8000-00000000c3a0'::uuid, '00000000-0000-4000-8000-00000000c3a0'::uuid));
insert into results select 'A authenticated/no-claim reserve', result from public.reserve_analysis_permit('x3-noclaim');
insert into results select 'A authenticated/no-claim access_state', coalesce((select premium::text from public.access_state()), '(no row)');
reset role;
insert into results select 'A permits written without a claim', count(*)::text from public.analysis_permits where idempotency_key = 'x3-noclaim';

-- ------------------------------------------------------------- owner session
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000c3';

-- ------------------------------------------------------------- B: atomicity
insert into results select 'B reserve', result from public.reserve_analysis_permit('x3-b');
create temporary table b_permit as select permit_id from public.reserve_analysis_permit('x3-b');
grant all on b_permit to authenticated;

insert into results select 'B scored/no-score sync',
  public.apply_synced_shot(
    attack.shot_payload('00000000-0000-4000-8000-00000000c3b1'::uuid, (select permit_id from b_permit), 'scored', 7.0, 'dink', now(), 6)
    || jsonb_build_object('overallScore', null));
insert into results select 'B rows after failed write',
  format('shots=%s phases=%s permit=%s',
    (select count(*) from public.shots where id = '00000000-0000-4000-8000-00000000c3b1'),
    (select count(*) from public.shot_phases where shot_id = '00000000-0000-4000-8000-00000000c3b1'),
    (select status || '/' || coalesce(outcome, 'null') from public.analysis_permits where id = (select permit_id from b_permit)));

insert into results select 'B 65-char phase key sync',
  public.apply_synced_shot(
    attack.shot_payload('00000000-0000-4000-8000-00000000c3b2'::uuid, (select permit_id from b_permit), 'scored', 7.0, 'dink', now(), 20)
    || jsonb_build_object('phases',
         (select (attack.shot_payload('00000000-0000-4000-8000-00000000c3b2'::uuid, (select permit_id from b_permit), 'scored', 7.0, 'dink', now(), 20) -> 'phases')
                 || jsonb_build_array(jsonb_build_object('key', repeat('k', 65), 'startMs', 1, 'representativeMs', 2, 'endMs', 3, 'confidence', 0.5)))));
insert into results select 'B rows after 65-char phase',
  format('shots=%s phases=%s permit=%s',
    (select count(*) from public.shots where id = '00000000-0000-4000-8000-00000000c3b2'),
    (select count(*) from public.shot_phases where shot_id = '00000000-0000-4000-8000-00000000c3b2'),
    (select status || '/' || coalesce(outcome, 'null') from public.analysis_permits where id = (select permit_id from b_permit)));

-- retry on the still-reserved permit must now succeed
insert into results select 'B clean retry', public.apply_synced_shot(
  attack.shot_payload('00000000-0000-4000-8000-00000000c3b3'::uuid, (select permit_id from b_permit), 'scored', 7.0, 'dink', now(), 6));

-- --------------------------------------------------------------- C: unicode
-- at scored=1, reserved=0 the insert is reached (a later probe would hit the paywall first)
do $$
declare v_result text;
begin
  select result into v_result from public.reserve_analysis_permit(repeat('k', 129));
  insert into results values ('C reserve 129-char key', 'RETURNED ' || v_result);
  insert into attack_failures values ('X3-C', '129-char idempotency key was not refused by analysis_permits_key_bounds: ' || v_result);
exception when check_violation then
  insert into results values ('C reserve 129-char key', sqlstate || ' ' || sqlerrm);
end $$;
insert into results select 'C reserve 128-emoji key', result from public.reserve_analysis_permit(repeat('🥒', 128));
create temporary table c_permit as select permit_id from public.reserve_analysis_permit(repeat('🥒', 128));
grant all on c_permit to authenticated;
insert into results select 'C sync shot_type 64 emoji', public.apply_synced_shot(
  attack.shot_payload('00000000-0000-4000-8000-00000000c3c1'::uuid, (select permit_id from c_permit), 'low_confidence', null, repeat('🏓', 64), now(), 0));
insert into results select 'C stored shot_type octets/chars',
  format('%s/%s', octet_length(shot_type), length(shot_type)) from public.shots where id = '00000000-0000-4000-8000-00000000c3c1';
insert into public.analysis_permits (id, user_id, idempotency_key) values ('00000000-0000-4000-8000-00000000c3c2', '00000000-0000-4000-8000-0000000000c3', 'x3-c2');
insert into results select 'C sync shot_type 65 emoji', public.apply_synced_shot(
  attack.shot_payload('00000000-0000-4000-8000-00000000c3c2'::uuid, '00000000-0000-4000-8000-00000000c3c2'::uuid, 'low_confidence', null, repeat('🏓', 65), now(), 0));
insert into results select 'C rows after 65 emoji', count(*)::text from public.shots where id = '00000000-0000-4000-8000-00000000c3c2';
-- NUL and RTL-override in a phase key: stored verbatim or refused, never crash
insert into results select 'C sync RTL-override phase key', public.apply_synced_shot(
  attack.shot_payload('00000000-0000-4000-8000-00000000c3c3'::uuid, '00000000-0000-4000-8000-00000000c3c2'::uuid, 'low_confidence', null, 'dink', now(), 0)
  || jsonb_build_object('phases', jsonb_build_array(jsonb_build_object('key', E'\u202Eesahp', 'startMs', 1, 'representativeMs', 2, 'endMs', 3, 'confidence', 0.5))));

-- ------------------------------------------------------ D: cross-user session
insert into public.analysis_permits (id, user_id, idempotency_key) values ('00000000-0000-4000-8000-00000000c3d1', '00000000-0000-4000-8000-0000000000c3', 'x3-d1');
insert into results select 'D sync into other user session', public.apply_synced_shot(
  attack.shot_payload('00000000-0000-4000-8000-00000000c3d1'::uuid, '00000000-0000-4000-8000-00000000c3d1'::uuid, 'low_confidence', null, 'dink', now(), 0)
  || jsonb_build_object('sessionId', '00000000-0000-4000-8000-00000000d3a1'));
insert into results select 'D rows after cross-user session', count(*)::text from public.shots where id = '00000000-0000-4000-8000-00000000c3d1';

-- ------------------------------------------------------------- E: replays
do $$
declare i int; r text; agg text := '';
begin
  for i in 1..200 loop
    r := public.apply_synced_shot(attack.shot_payload('00000000-0000-4000-8000-00000000c3b3'::uuid, (select permit_id from b_permit), 'scored', 7.0));
    if r <> 'accepted' then agg := agg || r || ','; end if;
  end loop;
  insert into results values ('E 200 shot replays non-accepted', coalesce(nullif(agg, ''), '(none)'));
  agg := '';
  for i in 1..200 loop
    select result into r from public.reserve_analysis_permit('x3-b');
    if r <> 'accepted' then agg := agg || r || ','; end if;
  end loop;
  insert into results values ('E 200 reserve replays non-accepted', coalesce(nullif(agg, ''), '(none)'));
end $$;
insert into results select 'E rows after replays',
  format('shots(b3)=%s permits(x3-b)=%s scored=%s reserved=%s',
    (select count(*) from public.shots where id = '00000000-0000-4000-8000-00000000c3b3'),
    (select count(*) from public.analysis_permits where idempotency_key = 'x3-b'),
    (select scored_count from public.access_state()),
    (select reserved_count from public.access_state()));

-- ------------------------------------------------------------ F: clock skew
insert into public.analysis_permits (id, user_id, idempotency_key) values ('00000000-0000-4000-8000-00000000c3f1', '00000000-0000-4000-8000-0000000000c3', 'x3-f1');
insert into results select 'F sync capturedAt=2100 (2nd scored)', public.apply_synced_shot(
  attack.shot_payload('00000000-0000-4000-8000-00000000c3f1'::uuid, '00000000-0000-4000-8000-00000000c3f1'::uuid, 'scored', 9.9, 'dink', '2100-01-01T00:00:00Z'::timestamptz, 6));
insert into public.analysis_permits (id, user_id, idempotency_key) values ('00000000-0000-4000-8000-00000000c3f2', '00000000-0000-4000-8000-0000000000c3', 'x3-f2');
insert into results select 'F sync capturedAt=1970 (low_confidence)', public.apply_synced_shot(
  attack.shot_payload('00000000-0000-4000-8000-00000000c3f2'::uuid, '00000000-0000-4000-8000-00000000c3f2'::uuid, 'low_confidence', null, 'dink', '1970-01-01T00:00:00Z'::timestamptz, 0));
insert into results select 'F stored captured_at', string_agg(captured_at::text, ' | ' order by captured_at)
  from public.shots where id in ('00000000-0000-4000-8000-00000000c3f1', '00000000-0000-4000-8000-00000000c3f2');
insert into results select 'F player_rank_state', coalesce((select tier || ' rating=' || rating::text || ' scored=' || scored_shot_count::text from public.player_rank_state where user_id = '00000000-0000-4000-8000-0000000000c3'), '(no row)');

-- ------------------------------------------------- G: detail amplification
insert into public.analysis_permits (id, user_id, idempotency_key) values ('00000000-0000-4000-8000-00000000c3e1', '00000000-0000-4000-8000-0000000000c3', 'x3-g1');
insert into results select 'G low_confidence shot with 5000 phases', public.apply_synced_shot(
  attack.shot_payload('00000000-0000-4000-8000-00000000c3e1'::uuid, '00000000-0000-4000-8000-00000000c3e1'::uuid, 'low_confidence', null, 'dink', now(), 5000));
insert into results select 'G phases stored / access', format('%s / scored=%s',
  (select count(*) from public.shot_phases where shot_id = '00000000-0000-4000-8000-00000000c3e1'),
  (select scored_count from public.access_state()));

reset role;
insert into results select 'final ledger(apple-sub-x3)', coalesce((select scored_count::text from public.free_rating_ledger
  where identity_hash = public.free_rating_identity_hash('apple', 'apple-sub-x3')), '(none)');

do $$
declare r record;
begin
  for r in select * from results loop
    raise notice 'OBSERVED % = %', r.k, r.v;
  end loop;

  if (select v from results where k = 'A authenticated/no-claim apply_synced_shot') <> 'auth.required'
     or (select v from results where k = 'A authenticated/no-claim reserve') <> 'auth.required'
     or (select v from results where k = 'A permits written without a claim') <> '0' then
    insert into attack_failures values ('X3-A', 'RPC acted for a session with no auth.uid()');
  end if;
  if (select v from results where k = 'B scored/no-score sync') not like 'shot.write_failed:%'
     or (select v from results where k = 'B rows after failed write') <> 'shots=0 phases=0 permit=reserved/null' then
    insert into attack_failures values ('X3-B', 'failed scored write was not atomic / permit not left reserved: ' || (select v from results where k = 'B rows after failed write'));
  end if;
  if (select v from results where k = 'B 65-char phase key sync') not like 'shot.write_failed:%'
     or (select v from results where k = 'B rows after 65-char phase') <> 'shots=0 phases=0 permit=reserved/null' then
    insert into attack_failures values ('X3-B', 'oversized phase key left partial rows: ' || (select v from results where k = 'B rows after 65-char phase'));
  end if;
  if (select v from results where k = 'B clean retry') <> 'accepted' then
    insert into attack_failures values ('X3-B', 'retry after a failed write was refused');
  end if;
  if (select v from results where k = 'C reserve 128-emoji key') <> 'accepted'
     or (select v from results where k = 'C sync shot_type 64 emoji') <> 'accepted'
     or (select v from results where k = 'C stored shot_type octets/chars') <> '256/64' then
    insert into attack_failures values ('X3-C', 'valid 64-codepoint unicode input was mishandled');
  end if;
  if (select v from results where k = 'C sync shot_type 65 emoji') not like 'shot.write_failed:%'
     or (select v from results where k = 'C rows after 65 emoji') <> '0' then
    insert into attack_failures values ('X3-C', '65-codepoint shot_type was stored');
  end if;
  if (select v from results where k = 'D sync into other user session') <> 'shot.session_not_found'
     or (select v from results where k = 'D rows after cross-user session') <> '0' then
    insert into attack_failures values ('X3-D', 'shot attached to another user''s session');
  end if;
  if (select v from results where k = 'E 200 shot replays non-accepted') <> '(none)'
     or (select v from results where k = 'E 200 reserve replays non-accepted') <> '(none)'
     or (select v from results where k = 'E rows after replays') <> 'shots(b3)=1 permits(x3-b)=1 scored=1 reserved=1' then
    insert into attack_failures values ('X3-E', 'replays were not idempotent: ' || (select v from results where k = 'E rows after replays'));
  end if;
  if (select v from results where k = 'F sync capturedAt=2100 (2nd scored)') <> 'accepted'
     or (select v from results where k = 'F sync capturedAt=1970 (low_confidence)') <> 'accepted'
     or (select v from results where k = 'F player_rank_state') = '(no row)' then
    insert into attack_failures values ('X3-F', 'time-skewed shots broke sync or rank recompute: ' || (select v from results where k = 'F player_rank_state'));
  end if;
  if (select v from results where k = 'G low_confidence shot with 5000 phases') <> 'accepted'
     or (select v from results where k = 'G phases stored / access') <> '5000 / scored=2' then
    insert into attack_failures values ('X3-G', 'oversized low_confidence sync misbehaved: ' || (select v from results where k = 'G phases stored / access'));
  end if;
  if (select v from results where k = 'final ledger(apple-sub-x3)') <> '2' then
    insert into attack_failures values ('X3', 'ledger should read exactly 2 after two scored shots, got ' || (select v from results where k = 'final ledger(apple-sub-x3)'));
  end if;
end $$;

do $$
declare v_report text;
begin
  select string_agg(format(E'\n[%s] %s', probe, detail), '') into v_report from attack_failures;
  if v_report is not null then
    raise exception 'X3 BROKEN:%', v_report;
  end if;
end $$;

rollback;

\echo X3: HELD
