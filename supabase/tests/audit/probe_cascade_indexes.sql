-- ============================================================================
-- Pickle Sensei — db-schema-migrations execution audit: cascades and indexes.
--
-- Runs against a throwaway Postgres with shim_auth.sql + every migration
-- applied (see run_audit_probes.sh). Seeds a populated tenant next to noisy
-- neighbours, deletes the auth.users row exactly like /v1/me/delete-confirm
-- does, and asserts what the cascade leaves behind. EXPLAIN ANALYZE of the
-- delete is printed so the per-FK trigger cost is on the record, and the FK
-- columns that have no covering index are listed (a SET NULL / CASCADE
-- trigger without one scans the referencing table once per deleted parent).
-- ============================================================================

\set ON_ERROR_STOP on
\set QUIET on

begin;

-- ───────────────────────────── fixtures ─────────────────────────────────────
-- victim: 3 sessions, 200 shots (each with 2 phases, 1 measurement, 3
-- checkpoints), 4 permits, 2 consents, 1 rank row, 1 exit-survey row,
-- 1 deletion request, 1 entitlement row, 1 external-credential row.
-- neighbours: 500 profiles with 20 shots each, 100k exit-survey rows
-- (anonymized long ago), 100k captures rows.
insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data) values
  ('00000000-0000-4000-a000-000000000001', 'victim@example.com', '{"full_name":"V"}', '{"provider":"apple"}');
insert into auth.identities (provider, provider_id, user_id, identity_data) values
  ('apple', 'a-victim', '00000000-0000-4000-a000-000000000001', '{"sub":"a-victim"}');

insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data)
select ('00000000-0000-4000-a001-' || lpad(to_hex(g), 12, '0'))::uuid,
       'n' || g || '@example.com', '{"full_name":"N"}', '{"provider":"google"}'
from generate_series(1, 500) g;

create function pg_temp.seed_shots(p_uid uuid, p_n int) returns void language plpgsql as $$
declare i int; sid uuid; sess uuid;
begin
  insert into public.sessions (id, user_id, started_at) values (gen_random_uuid(), p_uid, now()) returning id into sess;
  for i in 1..p_n loop
    sid := gen_random_uuid();
    insert into public.shots (id, user_id, session_id, shot_type, camera_view, captured_at, start_ms, contact_ms, end_ms,
      overall_score, analysis_confidence, result_kind, app_version, model_bundle_version, pose_model_version,
      paddle_model_version, stroke_detector_version, phase_model_version, scoring_model_version, shot_config_version, source)
    values (sid, p_uid, sess, (array['dink','drive','serve'])[1 + i % 3], 'side', now() - (i || ' hours')::interval,
      0, 400, 900, 5 + (i % 5), 0.9, 'scored', '1','1','1','1','1','1','1','1', 'real');
    insert into public.shot_phases (shot_id, user_id, phase_key, start_ms, representative_ms, end_ms, confidence)
    values (sid, p_uid, 'setup', 0, 100, 300, 0.9), (sid, p_uid, 'contact', 300, 400, 600, 0.9);
    insert into public.shot_measurements (shot_id, user_id, metric_key, value, unit, confidence)
    values (sid, p_uid, 'paddle_height', 1.1, 'ratio', 0.8);
    insert into public.shot_checkpoints (shot_id, user_id, checkpoint_key, score, confidence, band, direction, severity, applicable)
    values (sid, p_uid, 'a', 7, 0.8, 'green', 'none', 0.1, true),
           (sid, p_uid, 'b', 6, 0.8, 'yellow', 'none', 0.3, true),
           (sid, p_uid, 'c', 5, 0.8, 'red', 'none', 0.6, true);
  end loop;
end $$;

do $$
begin
  perform pg_temp.seed_shots('00000000-0000-4000-a000-000000000001', 200);
  perform pg_temp.seed_shots('00000000-0000-4000-a000-000000000001', 0);   -- two more sessions
  perform pg_temp.seed_shots('00000000-0000-4000-a000-000000000001', 0);
  perform pg_temp.seed_shots(id, 20) from public.profiles where id <> '00000000-0000-4000-a000-000000000001';
end $$;

insert into public.analysis_permits (user_id, idempotency_key, status, outcome)
values ('00000000-0000-4000-a000-000000000001', 'v1', 'finalized', 'scored'),
       ('00000000-0000-4000-a000-000000000001', 'v2', 'finalized', 'scored'),
       ('00000000-0000-4000-a000-000000000001', 'v3', 'released', 'cancelled'),
       ('00000000-0000-4000-a000-000000000001', 'v4', 'reserved', null);
insert into public.consent_records (user_id, scope, consent_version, action, source)
values ('00000000-0000-4000-a000-000000000001', 'evaluation_trials', '1', 'grant', 'settings'),
       ('00000000-0000-4000-a000-000000000001', 'evaluation_trials', '1', 'withdraw', 'settings');
insert into public.billing_entitlements (user_id, premium, product_key, expires_at)
values ('00000000-0000-4000-a000-000000000001', true, 'pickle_sensei_pro_monthly', now() + interval '10 days');
insert into public.account_external_credentials (user_id, apple_refresh_token_encrypted, apple_token_captured_at)
values ('00000000-0000-4000-a000-000000000001', repeat('Y2lwaGVy', 4), now());
insert into public.account_deletion_requests (user_id) values ('00000000-0000-4000-a000-000000000001');
insert into public.account_deletion_feedback (user_id, reason, details, provider, platform, app_version, scored_count, was_premium)
values ('00000000-0000-4000-a000-000000000001', 'not_useful', 'bye', 'apple', 'ios', '1.0.0', 200, true);

-- noisy neighbours: 100k long-anonymized exit surveys, 100k captures, 3000 permits
insert into public.analysis_permits (user_id, idempotency_key, status, outcome, created_at)
select p.id, 'n-' || g,
       case when g <= 4 then 'finalized' when g = 5 then 'released' else 'reserved' end,
       case when g <= 4 then 'scored' when g = 5 then 'cancelled' else null end,
       case when g = 6 and p.id::text like '%1' then now() - interval '30 hours' else now() end
from public.profiles p, generate_series(1, 6) g
where p.id <> '00000000-0000-4000-a000-000000000001';
insert into public.account_deletion_feedback (user_id, reason, provider, platform, app_version, scored_count, was_premium)
select null, 'other', 'google', 'ios', '1.0.0', 0, false from generate_series(1, 100000);
insert into public.captures (id, user_id, session_id, shot_id, captured_at, duration_ms, fps, capture_mode, evidence_status, status)
select gen_random_uuid(), p.id, null, null, now(), 3000, 30, 'automatic_pose_trigger', 'valid', 'analyzed'
from public.profiles p, generate_series(1, 200) g
where p.id <> '00000000-0000-4000-a000-000000000001';

analyze;

do $$
declare c int;
begin
  select count(*) into c from public.shots where user_id = '00000000-0000-4000-a000-000000000001';
  if c <> 200 then raise exception 'SETUP: victim must own 200 shots (got %)', c; end if;
  if not exists (select 1 from public.player_rank_state where user_id = '00000000-0000-4000-a000-000000000001') then
    raise exception 'SETUP: the rank trigger must have produced a rank row';
  end if;
  if (select scored_count from public.free_rating_ledger
      where identity_hash = public.free_rating_identity_hash('apple', 'a-victim')) <> 200 then
    raise exception 'SETUP: the ledger trigger must have counted 200 scored inserts';
  end if;
  if (select count(*) from public.account_deletion_feedback) <> 100001
     or (select count(*) from public.captures) <> 100000 then
    raise exception 'SETUP: neighbour volume missing';
  end if;
end $$;

-- ─────────── C1: FK columns without a covering index (informational) ─────────
\echo === C1: FK columns with no index whose leading columns match ===
\set QUIET off
select c.conrelid::regclass::text || '(' || string_agg(a.attname, ',' order by a.attnum) || ')' as fk_columns,
       c.confdeltype as on_delete,
       exists (select 1 from pg_index i
               where i.indrelid = c.conrelid
                 and (i.indkey::int2[])[0:cardinality(c.conkey)-1] = c.conkey) as indexed
from pg_constraint c
join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
where c.contype = 'f' and c.connamespace = 'public'::regnamespace
group by c.oid, c.conrelid, c.conkey, c.confdeltype
having not exists (select 1 from pg_index i
                   where i.indrelid = c.conrelid
                     and (i.indkey::int2[])[0:cardinality(c.conkey)-1] = c.conkey)
order by 1;
\set QUIET on

-- ─────────── C2: the deletion cascade, timed per FK trigger ─────────────────
\echo === C2: explain analyze delete from auth.users (victim) — as shipped ===
\set QUIET off
explain (analyze, costs off, summary on)
delete from auth.users where id = '00000000-0000-4000-a000-000000000001';
\set QUIET on

do $$
declare t text;
begin
  for t in select unnest(array['sessions','shots','shot_phases','shot_measurements','shot_checkpoints',
                                'captures','analysis_permits','consent_records','billing_entitlements',
                                'account_external_credentials','account_deletion_requests','player_rank_state',
                                'profiles']) loop
    if t = 'profiles' then
      if exists (select 1 from public.profiles where id = '00000000-0000-4000-a000-000000000001') then
        raise exception 'C2: profiles row must cascade';
      end if;
    else
      execute format('select exists (select 1 from public.%I where user_id = %L)', t, '00000000-0000-4000-a000-000000000001')
        into strict t;
      if t::boolean then raise exception 'C2: % must cascade with the account', t; end if;
    end if;
  end loop;
  if exists (select 1 from auth.identities where provider_id = 'a-victim') then
    raise exception 'C2: auth.identities must cascade';
  end if;
  -- exit survey: kept, anonymized
  if (select count(*) from public.account_deletion_feedback where reason = 'not_useful') <> 1
     or exists (select 1 from public.account_deletion_feedback where user_id = '00000000-0000-4000-a000-000000000001') then
    raise exception 'C2: the exit survey must survive anonymized (user_id null)';
  end if;
  -- identity ledger: kept at 200
  if (select scored_count from public.free_rating_ledger
      where identity_hash = public.free_rating_identity_hash('apple', 'a-victim')) <> 200 then
    raise exception 'C2: the identity ledger must survive account deletion';
  end if;
  -- neighbours untouched
  if (select count(*) from public.shots) <> 500 * 20 then
    raise exception 'C2: neighbour shots must be untouched (got %)', (select count(*) from public.shots);
  end if;
end $$;

-- ─────────── C3: the same delete with the three missing FK indexes ──────────
-- Not a schema change (rolled back below): quantifies what C1's gaps cost so
-- the number, not a guess, decides whether a follow-up migration is worth it.
\echo === C3: explain analyze delete (neighbour) — WITH indexes on the C1 columns ===
create index audit_tmp_adf_user on public.account_deletion_feedback (user_id);
create index audit_tmp_cap_shot on public.captures (shot_id);
create index audit_tmp_cap_session on public.captures (session_id);
analyze public.account_deletion_feedback; analyze public.captures;

-- give one neighbour the victim's footprint so the two plans compare like for like
do $$ begin perform pg_temp.seed_shots('00000000-0000-4000-a001-000000000001', 180); end $$;
insert into public.account_deletion_feedback (user_id, reason, provider, platform, app_version, scored_count, was_premium)
values ('00000000-0000-4000-a001-000000000001', 'other', 'google', 'ios', '1.0.0', 200, false);
\set QUIET off
explain (analyze, costs off, summary on)
delete from auth.users where id = '00000000-0000-4000-a001-000000000001';
\set QUIET on
drop index public.audit_tmp_adf_user; drop index public.audit_tmp_cap_shot; drop index public.audit_tmp_cap_session;

-- ─────────── C4: rank + ledger triggers under bulk paths ────────────────────
do $$
declare uid uuid := '00000000-0000-4000-a001-000000000002'; before_n int; after_n int;
begin
  select scored_shot_count into before_n from public.player_rank_state where user_id = uid;
  -- a session delete (client-allowed) SET NULLs shots.session_id: rank untouched
  delete from public.sessions where user_id = uid;
  if (select count(*) from public.shots where user_id = uid and session_id is not null) <> 0 then
    raise exception 'C4: deleting a session must null its shots'' session_id';
  end if;
  select scored_shot_count into after_n from public.player_rank_state where user_id = uid;
  if before_n <> after_n then raise exception 'C4: session deletion must not move rank state'; end if;
  -- service-side shot delete recomputes rank; ledger stays (never decrements)
  delete from public.shots where user_id = uid;
  if exists (select 1 from public.player_rank_state where user_id = uid) then
    raise exception 'C4: rank state must disappear when the last scored shot goes';
  end if;
end $$;

-- ─────────── C5: hot-path plans against the populated tables ────────────────
create function pg_temp.plan(q text) returns text language plpgsql as $$
declare line text; acc text := '';
begin
  for line in execute 'explain (costs off) ' || q loop acc := acc || line || E'\n'; end loop;
  return acc;
end $$;
do $$
declare p text;
begin
  p := pg_temp.plan($q$ select count(*) from public.shots where user_id = '00000000-0000-4000-a001-000000000003' and result_kind = 'scored' $q$);
  if p not like '%shots_user_scored_idx%' then raise exception 'C5a: scored count must use shots_user_scored_idx: %', p; end if;
  p := pg_temp.plan($q$ select count(*) from public.analysis_permits where user_id = '00000000-0000-4000-a001-000000000003' and status = 'reserved' and created_at > now() - interval '24 hours' $q$);
  if p not like '%analysis_permits_user_status_idx%' then raise exception 'C5b: reserved count must use analysis_permits_user_status_idx: %', p; end if;
  p := pg_temp.plan($q$ update public.analysis_permits set status = 'released', outcome = 'expired' where status = 'reserved' and created_at < now() - interval '24 hours' $q$);
  if p not like '%analysis_permits_reserved_created_idx%' then raise exception 'C5c: the sweep must use the partial index: %', p; end if;
  p := pg_temp.plan($q$ delete from public.webhook_events where received_at < now() - interval '90 days' $q$);
  raise notice 'C5d webhook purge plan (no index on received_at — table is small by design): %', p;
  p := pg_temp.plan($q$ delete from public.account_deletion_requests where expires_at < now() - interval '1 day' $q$);
  raise notice 'C5e deletion-request purge plan: %', p;
end $$;

rollback;
\echo CASCADE / INDEX PROBES: ALL CASES PASSED
