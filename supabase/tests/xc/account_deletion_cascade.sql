-- ============================================================================
-- Pickle Sensei — XC journey `settings-account-deletion`: server-side sweep.
--
-- Runs against a throwaway Postgres with shim_auth.sql + every migration in
-- supabase/migrations applied (see run_account_deletion_cascade.sh). It is
-- deliberately EXHAUSTIVE where security_regression.sql is targeted: it seeds
-- ONE row in EVERY base table that can reference an account (discovered from
-- the catalog, not a hand list), deletes the auth.users row exactly as
-- `auth.admin.deleteUser` does in the edge function, then:
--
--   1. counts the deleted user's rows in every table/column that can carry an
--      account identifier (uuid FK columns, text columns holding the id) and
--      emits the survival matrix as JSON;
--   2. asserts that the ONLY survivors are the ones legal.ts §7/§8 disclose:
--        - free_rating_ledger      (sha256 provider identity, scored count)
--        - account_deletion_feedback (user_id → NULL, categories kept)
--        - webhook_events.app_user_id (RevenueCat audit, 90-day pg_cron sweep)
--      and that nothing else — no FK column, no text/jsonb column — still
--      contains the user's uuid or e-mail;
--   3. asserts the second (untouched) user's rows are all still there;
--   4. asserts the FK graph itself: every FK path from a public table to
--      auth.users is ON DELETE CASCADE except account_deletion_feedback
--      (SET NULL), and that no base table carries a `user_id` column WITHOUT
--      such a path (an orphan risk the cascade could never reach).
--
-- Output: one JSON document per `\echo` marker on stdout; the runner captures
-- it to xc-artifacts/. Any violation raises → psql ON_ERROR_STOP → non-zero.
-- ============================================================================

\set ON_ERROR_STOP on
\set QUIET on

begin;

reset role;

-- ─────────────────────────────── seed ────────────────────────────────────

-- The victim (Apple identity, at the free-rating limit) and a bystander.
insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data)
values
  ('00000000-0000-4000-9000-0000000000d1', 'victim@example.test',
   '{"full_name":"Victim"}', '{"provider":"apple"}'),
  ('00000000-0000-4000-9000-0000000000d2', 'bystander@example.test',
   '{"full_name":"Bystander"}', '{"provider":"google"}');
insert into auth.identities (provider, provider_id, user_id, identity_data)
values
  ('apple', 'apple-sub-victim', '00000000-0000-4000-9000-0000000000d1',
   '{"sub":"apple-sub-victim","email":"victim@example.test"}'),
  ('google', 'google-sub-bystander', '00000000-0000-4000-9000-0000000000d2',
   '{"sub":"google-sub-bystander","email":"bystander@example.test"}');

do $$
begin
  if (select count(*) from public.profiles
      where id in ('00000000-0000-4000-9000-0000000000d1',
                   '00000000-0000-4000-9000-0000000000d2')) <> 2 then
    raise exception 'SETUP: handle_new_user trigger did not provision profiles';
  end if;
end $$;

-- Every account-referencing base table gets a row for BOTH users (service
-- role / superuser path — this is what the edge fn's admin client and the
-- sync RPC do; RLS is covered by security_regression.sql).
create temp table xc_seed_users (uid uuid, tag text, provider text, sub text);
insert into xc_seed_users values
  ('00000000-0000-4000-9000-0000000000d1', 'victim',    'apple',  'apple-sub-victim'),
  ('00000000-0000-4000-9000-0000000000d2', 'bystander', 'google', 'google-sub-bystander');

do $$
declare u record; sid uuid; shot uuid; cap uuid;
begin
  for u in select * from xc_seed_users loop
    update public.profiles
      set display_name = u.tag, first_name = u.tag, onboarding_state = 'complete'
      where id = u.uid;

    sid := gen_random_uuid();
    insert into public.sessions (id, user_id, kind, started_at, notes)
      values (sid, u.uid, 'practice', now(), 'xc-' || u.tag);

    -- Two SCORED shots: puts the identity ledger at 2 through the definer
    -- trigger `shots_record_free_rating_ledger`.
    for i in 1..2 loop
      shot := gen_random_uuid();
      insert into public.shots
        (id, user_id, session_id, shot_type, captured_at, start_ms, contact_ms, end_ms,
         overall_score, analysis_confidence, result_kind, guidance, app_version,
         model_bundle_version, pose_model_version, paddle_model_version,
         stroke_detector_version, phase_model_version, scoring_model_version,
         shot_config_version, source)
      values
        (shot, u.uid, sid, 'dink', now(), 0, 500, 1000,
         7 + (i::numeric / 10), 0.9, 'scored', 'xc-' || u.tag, '1.0',
         'b1', 'p1', 'pd1', 's1', 'ph1', 'sc1', 'cfg1', 'real');
      insert into public.shot_phases (shot_id, user_id, phase_key, start_ms, representative_ms, end_ms, confidence)
        values (shot, u.uid, 'backswing', 0, 250, 500, 0.9);
      insert into public.shot_measurements (shot_id, user_id, metric_key, value, confidence, unit)
        values (shot, u.uid, 'paddle_angle', 12.5, 0.9, 'degrees');
      insert into public.shot_checkpoints (shot_id, user_id, checkpoint_key, score, confidence, band, direction, severity, applicable)
        values (shot, u.uid, 'contact_position', 70, 0.9, 'green', 'none', 0, true);
      cap := gen_random_uuid();
      insert into public.captures
        (id, user_id, session_id, shot_id, captured_at, duration_ms, fps, capture_mode, evidence_status, status)
        values (cap, u.uid, sid, shot, now(), 4000, 30, 'automatic_pose_trigger', 'valid', 'analyzed');
    end loop;

    insert into public.analysis_permits (user_id, idempotency_key, status, outcome)
      values (u.uid, 'xc-permit-' || u.tag, 'finalized', 'scored');
    insert into public.consent_records (user_id, scope, action, consent_version, source)
      values (u.uid, 'model_training', 'grant', 'v1', 'mobile_settings');
    insert into public.evaluation_trials (id, user_id, payload)
      values (gen_random_uuid(), u.uid, jsonb_build_object('tag', 'xc-' || u.tag));
    insert into public.analysis_feedback (user_id, analysis_id, rating)
      values (u.uid, gen_random_uuid(), 'accurate');
    insert into public.user_saved_drills (user_id, slug)
      values (u.uid, 'soft-hands');
    insert into public.billing_entitlements (user_id, premium, product_key, verified_at)
      values (u.uid, false, null, now());
    insert into public.account_deletion_requests (user_id, challenge, created_at, expires_at)
      values (u.uid, gen_random_uuid(), now(), now() + interval '15 minutes');
    insert into public.account_deletion_feedback
      (user_id, reason, wanted, details, provider, platform, app_version,
       account_age_days, was_premium, scored_count)
      values (u.uid, 'privacy', 'nothing', 'xc-' || u.tag || ' details',
              u.provider, 'ios', '1.0', 3, false, 2);
    insert into public.account_external_credentials (user_id, apple_refresh_token_encrypted, apple_token_captured_at)
      values (u.uid, 'enc:xc-apple-refresh-token-' || u.tag, now());
    insert into public.webhook_events (id, provider, event_type, app_user_id, payload)
      values ('evt-' || u.tag, 'revenuecat', 'INITIAL_PURCHASE', u.uid::text,
              jsonb_build_object('app_user_id', u.uid::text, 'tag', u.tag));
  end loop;
end $$;

-- player_rank_state is trigger-maintained from scored shots; make sure the
-- seed reached it so the cascade check is not vacuous.
do $$
begin
  if (select count(*) from public.player_rank_state
      where user_id in (select uid from xc_seed_users)) <> 2 then
    raise exception 'SETUP: rank trigger did not create player_rank_state rows';
  end if;
  if not exists (select 1 from public.free_rating_ledger
                 where identity_hash = public.free_rating_identity_hash('apple', 'apple-sub-victim')
                   and scored_count = 2) then
    raise exception 'SETUP: identity ledger must read 2 for the victim';
  end if;
end $$;

-- ───────────────────── discovery: every account column ───────────────────

-- (table, column) pairs that can carry an account identifier: uuid columns
-- whose FK graph reaches auth.users, plus any uuid/text column literally
-- named like an account id (catches FK-less audit columns such as
-- webhook_events.app_user_id).
create temp table xc_account_columns as
with fk as (
  select c.conrelid as rel, a.attname as col, c.confrelid as target
  from pg_constraint c
  join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
  where c.contype = 'f' and c.connamespace = 'public'::regnamespace
),
-- Columns that literally hold the account uuid: FKs to auth.users or to
-- profiles (whose PK is the auth uid). Deeper FKs (shot_id, session_id) hold
-- other ids and are covered by the full-text identifier sweep instead.
reach as (
  select rel, col, target from fk
  where target in ('auth.users'::regclass, 'public.profiles'::regclass)
),
named as (
  select c.oid as rel, a.attname as col
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
  where n.nspname = 'public' and c.relkind = 'r'
    and (a.attname in ('user_id', 'app_user_id') or (c.relname = 'profiles' and a.attname = 'id'))
)
select distinct rel::regclass::text as table_name, col as column_name,
       exists (select 1 from reach r where r.rel = named.rel and r.col = named.col) as fk_reaches_auth_users
from named
union
select distinct rel::regclass::text, col, true from reach;

-- ───────────────────── before: victim + bystander counts ──────────────────

create temp table xc_counts (phase text, table_name text, column_name text, who text, rows bigint);

create or replace function pg_temp.xc_count_all(p_phase text) returns void
language plpgsql as $$
declare c record; u record; n bigint;
begin
  for c in select * from xc_account_columns loop
    for u in select * from xc_seed_users loop
      execute format('select count(*) from %s where %I::text = %L',
                     c.table_name, c.column_name, u.uid::text) into n;
      insert into xc_counts values (p_phase, c.table_name, c.column_name, u.tag, n);
    end loop;
  end loop;
end $$;

select pg_temp.xc_count_all('before');

do $$
declare zero record;
begin
  -- Every discovered account column must hold at least one victim row before
  -- deletion; otherwise the "after" zero proves nothing for that column.
  for zero in
    select table_name, column_name from xc_counts
    where phase = 'before' and who = 'victim' and rows = 0
  loop
    raise exception 'SETUP: no victim row seeded in %.% — matrix would be vacuous',
      zero.table_name, zero.column_name;
  end loop;
end $$;

-- ────────────────────────────── delete ────────────────────────────────────

-- Exactly what `auth.admin.deleteUser(userId)` does to the database.
delete from auth.users where id = '00000000-0000-4000-9000-0000000000d1';

select pg_temp.xc_count_all('after');

-- ─────────────────────────── assertions ───────────────────────────────────

-- Disclosed survivors (legal.ts §7): the RevenueCat audit row keeps the
-- account identifier for ≤ 90 days; everything else keyed by the account
-- must be gone. account_deletion_feedback keeps the row but nulls user_id,
-- so its victim count by user_id is 0 — asserted separately below.
create temp table xc_disclosed_survivors (table_name text, column_name text, basis text);
insert into xc_disclosed_survivors values
  ('webhook_events', 'app_user_id',
   'legal.ts §7 "RevenueCat webhook audit records are scheduled for deletion after 90 days" (pg_cron purge-old-webhook-events)');

do $$
declare bad record; n int;
begin
  for bad in
    select c.table_name, c.column_name, c.rows
    from xc_counts c
    left join xc_disclosed_survivors d using (table_name, column_name)
    where c.phase = 'after' and c.who = 'victim' and c.rows > 0 and d.table_name is null
  loop
    raise exception 'CASCADE: %.% still holds % row(s) for the deleted account',
      bad.table_name, bad.column_name, bad.rows;
  end loop;

  -- The disclosed survivor must be covered by the 90-day sweep. pg_cron is
  -- absent from a stock postgres:16 image (the migration skips scheduling
  -- then), so this is asserted live only when the extension exists; the
  -- runner script pins the migration text otherwise.
  if to_regclass('cron.job') is not null then
    select count(*) into n from cron.job
      where jobname = 'purge-old-webhook-events'
        and command ilike '%webhook_events%' and command ilike '%90 days%';
    if n <> 1 then
      raise exception 'RETENTION: purge-old-webhook-events pg_cron job missing or not 90 days';
    end if;
  end if;

  -- Bystander: identical before/after.
  if exists (
    select 1 from xc_counts b join xc_counts a
      on a.table_name = b.table_name and a.column_name = b.column_name and a.who = b.who
    where b.phase = 'before' and a.phase = 'after' and b.who = 'bystander' and a.rows <> b.rows
  ) then
    raise exception 'ISOLATION: bystander rows changed by the victim''s deletion';
  end if;

  -- Ledger survives at 2 for the victim identity (§7 hashed record).
  if not exists (select 1 from public.free_rating_ledger
                 where identity_hash = public.free_rating_identity_hash('apple', 'apple-sub-victim')
                   and scored_count = 2) then
    raise exception 'LEDGER: identity ledger must survive account deletion at 2 scored';
  end if;

  -- Exit survey: row kept, identifier removed, categories intact, free text kept.
  if (select count(*) from public.account_deletion_feedback where details = 'xc-victim details') <> 1 then
    raise exception 'SURVEY: the de-identified survey row must survive';
  end if;
  if exists (select 1 from public.account_deletion_feedback
             where details = 'xc-victim details' and user_id is not null) then
    raise exception 'SURVEY: user_id must be NULL on the surviving survey row';
  end if;
  if not exists (select 1 from public.account_deletion_feedback
                 where details = 'xc-victim details' and reason = 'privacy' and wanted = 'nothing'
                   and provider = 'apple' and platform = 'ios' and scored_count = 2) then
    raise exception 'SURVEY: coarse context columns must survive de-identification';
  end if;
end $$;

-- Full-text sweep: the victim's uuid / e-mail must not appear in ANY column
-- of ANY public base table except the disclosed webhook audit row.
create temp table xc_identifier_hits (table_name text, matched text);
do $$
declare t record; n bigint;
begin
  for t in
    select c.oid::regclass::text as table_name
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
  loop
    execute format(
      'select count(*) from %s t where t::text ilike %L or t::text ilike %L',
      t.table_name, '%00000000-0000-4000-9000-0000000000d1%', '%victim@example.test%')
      into n;
    if n > 0 then
      insert into xc_identifier_hits values (t.table_name, format('%s row(s)', n));
    end if;
  end loop;
  if exists (select 1 from xc_identifier_hits where table_name <> 'webhook_events') then
    raise exception 'IDENTIFIER SWEEP: deleted account identifier still present in %',
      (select string_agg(table_name || ' (' || matched || ')', ', ') from xc_identifier_hits);
  end if;
end $$;

-- FK graph: every path to auth.users cascades, except the survey (SET NULL).
do $$
declare bad record;
begin
  for bad in
    select c.conrelid::regclass::text as tbl, a.attname as col, c.confdeltype
    from pg_constraint c
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
    where c.contype = 'f' and c.connamespace = 'public'::regnamespace
      and c.confrelid in ('auth.users'::regclass, 'public.profiles'::regclass)
      and not (c.confdeltype = 'c'
               or (c.conrelid = 'public.account_deletion_feedback'::regclass and c.confdeltype = 'n'))
  loop
    raise exception 'FK: %.% → account has ON DELETE %, expected CASCADE (or SET NULL for the survey)',
      bad.tbl, bad.col, bad.confdeltype;
  end loop;

  -- No account column WITHOUT an FK path other than the disclosed audit column.
  for bad in
    select table_name, column_name from xc_account_columns
    where not fk_reaches_auth_users
      and (table_name, column_name) not in (select table_name, column_name from xc_disclosed_survivors)
  loop
    raise exception 'FK: %.% carries an account id with no cascade path and no disclosed retention',
      bad.table_name, bad.column_name;
  end loop;
end $$;

-- ───────────────────────────── artifacts ──────────────────────────────────

\set QUIET off
\pset format unaligned
\pset tuples_only on

\echo XC_JSON_BEGIN survival_matrix
select jsonb_pretty(jsonb_build_object(
  'deletedUser', '00000000-0000-4000-9000-0000000000d1',
  'bystander', '00000000-0000-4000-9000-0000000000d2',
  'accountColumns', (select jsonb_agg(to_jsonb(c) order by c.table_name, c.column_name) from xc_account_columns c),
  'matrix', (
    select jsonb_agg(jsonb_build_object(
      'table', b.table_name, 'column', b.column_name,
      'victimBefore', b.rows, 'victimAfter', a.rows,
      'bystanderBefore', bb.rows, 'bystanderAfter', ab.rows,
      'disclosedRetention', (select basis from xc_disclosed_survivors d
                              where d.table_name = b.table_name and d.column_name = b.column_name))
      order by b.table_name, b.column_name)
    from xc_counts b
    join xc_counts a  on a.table_name = b.table_name and a.column_name = b.column_name and a.phase = 'after'  and a.who = 'victim'
    join xc_counts bb on bb.table_name = b.table_name and bb.column_name = b.column_name and bb.phase = 'before' and bb.who = 'bystander'
    join xc_counts ab on ab.table_name = b.table_name and ab.column_name = b.column_name and ab.phase = 'after'  and ab.who = 'bystander'
    where b.phase = 'before' and b.who = 'victim'),
  'identifierSweepHits', (select coalesce(jsonb_agg(to_jsonb(h)), '[]'::jsonb) from xc_identifier_hits h),
  'ledger', (select jsonb_agg(to_jsonb(l)) from public.free_rating_ledger l),
  'survivingSurveyRows', (select jsonb_agg(to_jsonb(f)) from public.account_deletion_feedback f where f.user_id is null),
  'pgCronAvailable', to_regclass('cron.job') is not null
));
\echo XC_JSON_END

rollback;
