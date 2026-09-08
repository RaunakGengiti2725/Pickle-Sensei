-- ADV-04 — column-grant EXACTNESS for every client-writable table.
--
-- Boundary: AGENTS.md / REVIEW.md require client grants sized to EXACTLY the
-- writes supabase/functions/api/index.ts performs. A grant wider than the
-- edge fn's writes is dead privilege a stolen bearer can use against the
-- table directly (RLS restricts the ROW, the grant restricts the COLUMN);
-- narrower grants surface as 42501 -> 503. This attack pins the full
-- privilege surface of `authenticated` in public, derived from the edge
-- function's table writes (grep `.from("...")` + `.insert/.update/.upsert/
-- .delete` at HEAD 30a4065), and asserts anon / service_role hold nothing a
-- client should not. Any drift in either direction fails.
\set ON_ERROR_STOP on
\set QUIET on
begin;

create temp table adv04_expected (rel text, priv text, cols text) on commit drop;
insert into adv04_expected values
  -- INSERT surface: what the edge fn (or its RPCs on behalf of the client) inserts.
  ('account_deletion_feedback', 'INSERT', '*'),                               -- exit survey (deleteAccountRequest)
  ('analysis_feedback',        'INSERT', '*'),
  ('analysis_permits',         'INSERT', 'idempotency_key,user_id'),          -- reserve_analysis_permit() writes only these
  ('consent_records',          'INSERT', '*'),
  ('evaluation_trials',        'INSERT', '*'),
  ('sessions',                 'INSERT', '*'),
  ('shot_checkpoints',         'INSERT', '*'),                                -- apply_synced_shot (SECURITY INVOKER)
  ('shot_phases',              'INSERT', '*'),
  ('shots',                    'INSERT', '*'),
  ('user_saved_drills',        'INSERT', '*'),
  -- UPDATE surface: exactly the columns the edge fn moves.
  ('analysis_permits',         'UPDATE', 'outcome,status'),
  ('profiles',                 'UPDATE', 'biggest_problem,first_name,focus_checkpoint,gender,handedness,onboarding_state,primary_goal,provider,skill_level'),
  ('sessions',                 'UPDATE', 'ended_at'),
  -- DELETE surface.
  ('user_saved_drills',        'DELETE', '*');

-- Observed: table-level grants as '*', otherwise the sorted column list.
create temp table adv04_observed on commit drop as
with tbl as (
  select table_name as rel, privilege_type as priv
  from information_schema.role_table_grants
  where grantee = 'authenticated' and table_schema = 'public'
    and privilege_type in ('INSERT', 'UPDATE', 'DELETE')
),
cols as (
  select table_name as rel, privilege_type as priv,
         string_agg(column_name::text, ',' order by column_name::text) as cols
  from information_schema.column_privileges
  where grantee = 'authenticated' and table_schema = 'public'
    and privilege_type in ('INSERT', 'UPDATE', 'DELETE')
    and (table_name, privilege_type) not in (select rel, priv from tbl)
  group by 1, 2
)
select rel::text, priv::text, '*'::text as cols from tbl
union all
select rel::text, priv::text, cols from cols;

do $$
declare extra text; missing text;
begin
  select string_agg(format('%s %s(%s)', rel, priv, cols), '; ') into extra
  from (select * from adv04_observed except select * from adv04_expected) x;
  select string_agg(format('%s %s(%s)', rel, priv, cols), '; ') into missing
  from (select * from adv04_expected except select * from adv04_observed) x;
  if extra is not null or missing is not null then
    raise exception 'ADV-04 BREAK: authenticated write grants drift from the edge fn writes. WIDER than needed: [%]. NARROWER than needed: [%]',
      coalesce(extra, 'none'), coalesce(missing, 'none');
  end if;
end $$;

-- anon holds nothing in public; service_role holds no write on client tables.
do $$
declare bad text;
begin
  select string_agg(format('%s:%s', table_name, privilege_type), ',') into bad
  from information_schema.role_table_grants
  where grantee = 'anon' and table_schema in ('public', 'api_private');
  if bad is not null then
    raise exception 'ADV-04 BREAK: anon holds table privileges: %', bad;
  end if;
  select string_agg(format('%s:%s', table_name, column_name), ',') into bad
  from information_schema.column_privileges
  where grantee = 'anon' and table_schema in ('public', 'api_private');
  if bad is not null then
    raise exception 'ADV-04 BREAK: anon holds column privileges: %', bad;
  end if;
  select string_agg(format('%s:%s', table_name, privilege_type), ',') into bad
  from information_schema.role_table_grants
  where grantee = 'service_role' and table_schema = 'public'
    and privilege_type in ('INSERT', 'UPDATE', 'DELETE')
    and table_name not in ('billing_entitlements', 'webhook_events', 'account_deletion_requests',
                           'account_deletion_feedback', 'external_credentials', 'account_deletion_operations');
  if bad is not null then
    raise exception 'ADV-04 BREAK: service_role holds client-table write privileges: %', bad;
  end if;
end $$;

rollback;
\echo 'ADV-04 column grant exactness: PASS'
