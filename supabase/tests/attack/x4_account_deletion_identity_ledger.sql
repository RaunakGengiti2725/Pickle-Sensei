-- ============================================================================
-- X4 — account deletion vs. the identity-keyed free-rating ledger
--      (20260902150000_free_rating_identity_ledger.sql).
--
-- The product claim: deleting the account removes every account-owned row,
-- but the two lifetime free ratings follow the SIGN-IN IDENTITY, so signing
-- in again with the same Apple ID / Google account does NOT reset them.
--
--   A. Owner (apple identity) spends both ratings, then the account is
--      deleted the way the edge fn does it (Auth admin deleteUser →
--      DELETE FROM auth.users). Assert: zero rows remain for that uid in
--      EVERY public base table that has a user_id column (discovered from
--      information_schema, not a hand list), captures gone through the shot
--      cascade, account_deletion_feedback.user_id is NULLed not deleted,
--      and free_rating_ledger still says 2.
--   B. Same person re-creates the account (new uuid, same apple subject):
--      access_state().scored_count = 2 with zero shots on the new account,
--      reserve_analysis_permit → paywall_required, and a hand-inserted
--      reserved permit + scored sync → paywall_required. Ledger stays 2.
--   C. Deletion mid-flight: an account with a RESERVED permit and a pending
--      deletion request is deleted; the permit and request are gone; a sync
--      replayed under the dead uid gets access.permit_not_found, writes
--      nothing, and does not touch the ledger.
--   D. Two linked identities (apple + google) on one account: one scored
--      shot bumps BOTH ledgers to 1. Deleted, re-created with google only
--      → scored_count 1, one more rating allowed, google ledger → 2, apple
--      ledger stays 1 (documented known limit in AGENTS.md — recorded as
--      OBSERVED, not asserted).
--   E. Client access to the ledger: authenticated select/insert/update/
--      delete on free_rating_ledger and EXECUTE on
--      free_rating_identity_hash are all 42501.
--   F. Corrupt state: a shots row whose owner has NO auth.identities row
--      (identity removed) — the ledger trigger records nothing, so that
--      account's ratings would reset on deletion. Recorded as OBSERVED
--      (depends on GoTrue always keeping an identities row for ID-token
--      sign-in, which it does; no assertion).
-- ============================================================================

\set ON_ERROR_STOP on
\set QUIET on

begin;

\i /attack/_helpers.sql

create temporary table attack_failures (probe text, detail text);
create temporary table results (k text, v text);
grant all on attack_failures, results to authenticated;

-- helper: how many rows in every public base table with a user_id column
-- still point at a uid (dynamic, so a new table cannot silently escape).
create function attack.rows_for_user(p_uid uuid) returns text
language plpgsql as $fn$
declare r record; n bigint; agg text := '';
begin
  for r in
    select c.table_name
    from information_schema.columns c
    join information_schema.tables t
      on t.table_schema = c.table_schema and t.table_name = c.table_name
    where c.table_schema = 'public' and c.column_name = 'user_id' and t.table_type = 'BASE TABLE'
    order by 1
  loop
    execute format('select count(*) from public.%I where user_id = $1', r.table_name) into n using p_uid;
    if n > 0 then agg := agg || format('%s=%s ', r.table_name, n); end if;
  end loop;
  execute 'select count(*) from public.profiles where id = $1' into n using p_uid;
  if n > 0 then agg := agg || format('profiles=%s ', n); end if;
  return coalesce(nullif(trim(agg), ''), '(none)');
end $fn$;

-- ---------------------------------------------------------------- A: spend + delete
select attack.new_user('00000000-0000-4000-8000-0000000000c4'::uuid, 'x4-owner@attack.example', 'apple', 'apple-sub-x4');

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000c4';
insert into public.sessions (id, user_id, started_at) values ('00000000-0000-4000-8000-00000000c4a0', '00000000-0000-4000-8000-0000000000c4', now());
insert into public.analysis_permits (id, user_id, idempotency_key)
values ('00000000-0000-4000-8000-00000000c4a1', '00000000-0000-4000-8000-0000000000c4', 'x4-a1'),
       ('00000000-0000-4000-8000-00000000c4a2', '00000000-0000-4000-8000-0000000000c4', 'x4-a2');
insert into results select 'A sync 1', public.apply_synced_shot(
  attack.shot_payload('00000000-0000-4000-8000-00000000c4e1'::uuid, '00000000-0000-4000-8000-00000000c4a1'::uuid, 'scored', 7.0, 'dink', now(), 6)
  || jsonb_build_object('sessionId', '00000000-0000-4000-8000-00000000c4a0'));
insert into results select 'A sync 2', public.apply_synced_shot(
  attack.shot_payload('00000000-0000-4000-8000-00000000c4e2'::uuid, '00000000-0000-4000-8000-00000000c4a2'::uuid, 'scored', 8.0, 'drive', now(), 6));
insert into public.captures (id, user_id, shot_id, session_id, captured_at, duration_ms, fps, capture_mode, evidence_status, status)
values (gen_random_uuid(), '00000000-0000-4000-8000-0000000000c4', '00000000-0000-4000-8000-00000000c4e1', '00000000-0000-4000-8000-00000000c4a0', now(), 1200, 60.0, 'automatic_pose_trigger', 'valid', 'analyzed');
insert into public.account_deletion_feedback (user_id, reason, scored_count) values ('00000000-0000-4000-8000-0000000000c4', 'other', 2);
insert into public.consent_records (user_id, scope, action) values ('00000000-0000-4000-8000-0000000000c4', 'video_analysis', 'grant');
insert into results select 'A access before delete', format('scored=%s reserved=%s', scored_count, reserved_count) from public.access_state();
reset role;

insert into results select 'A rows before delete', attack.rows_for_user('00000000-0000-4000-8000-0000000000c4');
insert into results select 'A ledger before delete', scored_count::text from public.free_rating_ledger where identity_hash = public.free_rating_identity_hash('apple', 'apple-sub-x4');

delete from auth.users where id = '00000000-0000-4000-8000-0000000000c4';

insert into results select 'A rows after delete', attack.rows_for_user('00000000-0000-4000-8000-0000000000c4');
insert into results select 'A deletion feedback rows (user_id null)', format('%s/%s',
  (select count(*) from public.account_deletion_feedback where reason = 'other' and user_id is null),
  (select count(*) from public.account_deletion_feedback where reason = 'other'));
insert into results select 'A captures for deleted shots', count(*)::text from public.captures where shot_id in ('00000000-0000-4000-8000-00000000c4e1', '00000000-0000-4000-8000-00000000c4e2');
insert into results select 'A ledger after delete', coalesce((select scored_count::text from public.free_rating_ledger where identity_hash = public.free_rating_identity_hash('apple', 'apple-sub-x4')), '(none)');

-- ---------------------------------------------------------------- B: same identity, new account
select attack.new_user('00000000-0000-4000-8000-0000000000c5'::uuid, 'x4-owner@attack.example', 'apple', 'apple-sub-x4');
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000c5';
insert into results select 'B access on re-created account', format('scored=%s reserved=%s shots=%s', scored_count, reserved_count, (select count(*) from public.shots)) from public.access_state();
insert into results select 'B reserve', result from public.reserve_analysis_permit('x4-b1');
insert into public.analysis_permits (id, user_id, idempotency_key) values ('00000000-0000-4000-8000-00000000c5b1', '00000000-0000-4000-8000-0000000000c5', 'x4-b-hand');
insert into results select 'B sync via hand permit', public.apply_synced_shot(
  attack.shot_payload('00000000-0000-4000-8000-00000000c5e1'::uuid, '00000000-0000-4000-8000-00000000c5b1'::uuid, 'scored', 7.0));
-- the paywall path released the hand permit (free_limit_exceeded); abstentions
-- need a live reserved permit but no allowance
insert into public.analysis_permits (id, user_id, idempotency_key) values ('00000000-0000-4000-8000-00000000c5b2', '00000000-0000-4000-8000-0000000000c5', 'x4-b-hand-2');
insert into results select 'B low_confidence still syncs', public.apply_synced_shot(
  attack.shot_payload('00000000-0000-4000-8000-00000000c5e2'::uuid, '00000000-0000-4000-8000-00000000c5b2'::uuid, 'low_confidence', null));
reset role;
insert into results select 'B ledger', scored_count::text from public.free_rating_ledger where identity_hash = public.free_rating_identity_hash('apple', 'apple-sub-x4');

-- ---------------------------------------------------------------- C: deletion mid-flight
select attack.new_user('00000000-0000-4000-8000-0000000000c6'::uuid, 'x4-mid@attack.example', 'google', 'google-sub-x4-mid');
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000c6';
insert into results select 'C reserve', result from public.reserve_analysis_permit('x4-c1');
create temporary table c_permit as select permit_id from public.reserve_analysis_permit('x4-c1');
grant all on c_permit to authenticated;
insert into public.account_deletion_requests (user_id) values ('00000000-0000-4000-8000-0000000000c6');
reset role;
delete from auth.users where id = '00000000-0000-4000-8000-0000000000c6';
insert into results select 'C rows after delete', attack.rows_for_user('00000000-0000-4000-8000-0000000000c6');
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000c6';
insert into results select 'C sync under dead uid', public.apply_synced_shot(
  attack.shot_payload('00000000-0000-4000-8000-00000000c6e1'::uuid, (select permit_id from c_permit), 'scored', 7.0));
do $$
declare v_result text;
begin
  select result into v_result from public.reserve_analysis_permit('x4-c2');
  insert into results values ('C reserve under dead uid', 'RETURNED ' || v_result);
exception when others then
  insert into results values ('C reserve under dead uid', 'RAISED ' || sqlstate || ' ' || sqlerrm);
end $$;
reset role;
insert into results select 'C rows after dead-uid calls', attack.rows_for_user('00000000-0000-4000-8000-0000000000c6');
insert into results select 'C ledger for dead identity', coalesce((select scored_count::text from public.free_rating_ledger where identity_hash = public.free_rating_identity_hash('google', 'google-sub-x4-mid')), '(none)');

-- ---------------------------------------------------------------- D: two linked identities
select attack.new_user('00000000-0000-4000-8000-0000000000c7'::uuid, 'x4-linked@attack.example', 'apple', 'apple-sub-x4-linked');
insert into auth.identities (provider, provider_id, user_id, identity_data)
values ('google', 'google-sub-x4-linked', '00000000-0000-4000-8000-0000000000c7', '{"sub":"google-sub-x4-linked"}'::jsonb);
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000c7';
insert into public.analysis_permits (id, user_id, idempotency_key) values ('00000000-0000-4000-8000-00000000c7a1', '00000000-0000-4000-8000-0000000000c7', 'x4-d1');
insert into results select 'D sync 1 (linked)', public.apply_synced_shot(
  attack.shot_payload('00000000-0000-4000-8000-00000000c7e1'::uuid, '00000000-0000-4000-8000-00000000c7a1'::uuid, 'scored', 7.0));
reset role;
insert into results select 'D ledgers after 1 scored', format('apple=%s google=%s',
  (select scored_count from public.free_rating_ledger where identity_hash = public.free_rating_identity_hash('apple', 'apple-sub-x4-linked')),
  (select scored_count from public.free_rating_ledger where identity_hash = public.free_rating_identity_hash('google', 'google-sub-x4-linked')));
delete from auth.users where id = '00000000-0000-4000-8000-0000000000c7';
select attack.new_user('00000000-0000-4000-8000-0000000000c8'::uuid, 'x4-linked@attack.example', 'google', 'google-sub-x4-linked');
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000c8';
insert into results select 'D access google-only re-creation', format('scored=%s', scored_count) from public.access_state();
insert into public.analysis_permits (id, user_id, idempotency_key) values ('00000000-0000-4000-8000-00000000c8a1', '00000000-0000-4000-8000-0000000000c8', 'x4-d2'),
  ('00000000-0000-4000-8000-00000000c8a2', '00000000-0000-4000-8000-0000000000c8', 'x4-d3');
insert into results select 'D sync 2 (google-only)', public.apply_synced_shot(
  attack.shot_payload('00000000-0000-4000-8000-00000000c8e1'::uuid, '00000000-0000-4000-8000-00000000c8a1'::uuid, 'scored', 7.0));
insert into results select 'D sync 3 (google-only)', public.apply_synced_shot(
  attack.shot_payload('00000000-0000-4000-8000-00000000c8e2'::uuid, '00000000-0000-4000-8000-00000000c8a2'::uuid, 'scored', 7.0));
reset role;
insert into results select 'D ledgers after google-only', format('apple=%s google=%s',
  (select scored_count from public.free_rating_ledger where identity_hash = public.free_rating_identity_hash('apple', 'apple-sub-x4-linked')),
  (select scored_count from public.free_rating_ledger where identity_hash = public.free_rating_identity_hash('google', 'google-sub-x4-linked')));
delete from auth.users where id = '00000000-0000-4000-8000-0000000000c8';
select attack.new_user('00000000-0000-4000-8000-0000000000c9'::uuid, 'x4-linked@attack.example', 'apple', 'apple-sub-x4-linked');
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000c9';
insert into results select 'D access apple-only re-creation (known limit)', format('scored=%s reserve=%s', (select scored_count from public.access_state()), (select result from public.reserve_analysis_permit('x4-d4')));
reset role;

-- ---------------------------------------------------------------- E: client access to the ledger
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000c5';
do $$
declare probe record;
begin
  for probe in select * from (values
    ('select',  'select count(*) from public.free_rating_ledger'),
    ('insert',  'insert into public.free_rating_ledger (identity_hash, scored_count) values (repeat(''0'', 64), 0)'),
    ('update',  'update public.free_rating_ledger set scored_count = 0'),
    ('delete',  'delete from public.free_rating_ledger'),
    ('hash fn', 'select public.free_rating_identity_hash(''apple'', ''apple-sub-x4'')')
  ) as t(label, sql) loop
    begin
      execute probe.sql;
      insert into results values ('E authenticated ' || probe.label, 'EXECUTED');
      insert into attack_failures values ('X4-E', 'authenticated could ' || probe.label || ' on the ledger');
    exception when insufficient_privilege then
      insert into results values ('E authenticated ' || probe.label, sqlstate);
    end;
  end loop;
end $$;
reset role;

-- ---------------------------------------------------------------- F: no identities row
select attack.new_user('00000000-0000-4000-8000-0000000000ca'::uuid, 'x4-noident@attack.example', 'apple', 'apple-sub-x4-noident');
delete from auth.identities where user_id = '00000000-0000-4000-8000-0000000000ca';
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000ca';
insert into public.analysis_permits (id, user_id, idempotency_key) values ('00000000-0000-4000-8000-00000000caf1', '00000000-0000-4000-8000-0000000000ca', 'x4-f1');
insert into results select 'F sync with no identities row', public.apply_synced_shot(
  attack.shot_payload('00000000-0000-4000-8000-00000000cae1'::uuid, '00000000-0000-4000-8000-00000000caf1'::uuid, 'scored', 7.0));
insert into results select 'F access', format('scored=%s', scored_count) from public.access_state();
reset role;
insert into results select 'F ledger rows for that identity', count(*)::text from public.free_rating_ledger where identity_hash = public.free_rating_identity_hash('apple', 'apple-sub-x4-noident');

do $$
declare r record;
begin
  for r in select * from results loop
    raise notice 'OBSERVED % = %', r.k, r.v;
  end loop;

  if (select v from results where k = 'A access before delete') <> 'scored=2 reserved=0'
     or (select v from results where k = 'A ledger before delete') <> '2' then
    insert into attack_failures values ('X4-A', 'fixture did not reach 2 scored / ledger 2');
  end if;
  if (select v from results where k = 'A rows after delete') <> '(none)' then
    insert into attack_failures values ('X4-A', 'rows survived account deletion: ' || (select v from results where k = 'A rows after delete'));
  end if;
  if (select v from results where k = 'A deletion feedback rows (user_id null)') <> '1/1' then
    insert into attack_failures values ('X4-A', 'account_deletion_feedback was not detached (SET NULL): ' || (select v from results where k = 'A deletion feedback rows (user_id null)'));
  end if;
  if (select v from results where k = 'A captures for deleted shots') <> '0' then
    insert into attack_failures values ('X4-A', 'captures survived the shot cascade');
  end if;
  if (select v from results where k = 'A ledger after delete') <> '2' then
    insert into attack_failures values ('X4-A', 'free_rating_ledger did not survive deletion: ' || (select v from results where k = 'A ledger after delete'));
  end if;
  if (select v from results where k = 'B access on re-created account') <> 'scored=2 reserved=0 shots=0'
     or (select v from results where k = 'B reserve') <> 'access.paywall_required'
     or (select v from results where k = 'B sync via hand permit') <> 'access.paywall_required'
     or (select v from results where k = 'B ledger') <> '2' then
    insert into attack_failures values ('X4-B', 'same identity got fresh free ratings after deletion');
  end if;
  if (select v from results where k = 'B low_confidence still syncs') <> 'accepted' then
    insert into attack_failures values ('X4-B', 'abstention sync refused on a spent identity (should still be accepted)');
  end if;
  if (select v from results where k = 'C rows after delete') <> '(none)'
     or (select v from results where k = 'C sync under dead uid') <> 'access.permit_not_found'
     or (select v from results where k = 'C rows after dead-uid calls') <> '(none)'
     or (select v from results where k = 'C ledger for dead identity') <> '(none)' then
    insert into attack_failures values ('X4-C', 'deleted account still had an effect: ' || (select v from results where k = 'C sync under dead uid'));
  end if;
  if (select v from results where k = 'D ledgers after 1 scored') <> 'apple=1 google=1' then
    insert into attack_failures values ('X4-D', 'linked identities were not both bumped: ' || (select v from results where k = 'D ledgers after 1 scored'));
  end if;
  if (select v from results where k = 'D access google-only re-creation') <> 'scored=1'
     or (select v from results where k = 'D sync 2 (google-only)') <> 'accepted'
     or (select v from results where k = 'D sync 3 (google-only)') <> 'access.paywall_required' then
    insert into attack_failures values ('X4-D', 'google-only re-creation did not resume at 1 spent rating');
  end if;
end $$;

do $$
declare v_report text;
begin
  select string_agg(format(E'\n[%s] %s', probe, detail), '') into v_report from attack_failures;
  if v_report is not null then
    raise exception 'X4 BROKEN:%', v_report;
  end if;
end $$;

rollback;

\echo X4: HELD
