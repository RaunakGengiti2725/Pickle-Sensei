-- ============================================================================
-- Pickle Sensei — storage-surface audit for the Supabase schema.
--
-- Runs after shim_auth.sql + every migration in supabase/migrations (see
-- run_storage_audit.sh) on a throwaway Postgres. Answers, with evidence:
--
--   S1. Do the migrations declare ANY Supabase Storage surface (storage
--       schema, storage.buckets/objects rows, storage policies)? Expected: no —
--       the shipping product keeps video on-device (docs/APP_STORE_SUBMISSION.md
--       §"Court video … never leave the device"), so a bucket appearing here
--       would be an undocumented data path.
--   S2. Every public table has RLS enabled and the anon role holds no table,
--       sequence or function privilege (the "no anonymous storage" boundary).
--   S3. Every text/jsonb column the authenticated role can INSERT or UPDATE is
--       bounded by a CHECK constraint (anti blob-smuggling / storage abuse).
--   S4. The only URL-bearing column (profiles.avatar_url) is length-capped for
--       the owner's own row.
--
-- Each numbered case records failures into a temp table so ONE run reports
-- every regression; the final SELECT emits a JSON inventory (including the
-- failure list) the runner captures as an artifact, then the script raises if
-- anything failed (ON_ERROR_STOP → non-zero exit).
-- ============================================================================

\set ON_ERROR_STOP on
\set QUIET on

create temp table audit_failures (case_id text not null, detail text not null);

-- ───────────────────────── S1: no Supabase Storage surface ──────────────────
do $$
declare
  n int;
begin
  select count(*) into n from pg_namespace where nspname = 'storage';
  if n <> 0 then
    insert into audit_failures values ('S1', format('migrations created a storage schema (%s namespace rows)', n));
  end if;
  select count(*) into n from pg_class c join pg_namespace s on s.oid = c.relnamespace
    where s.nspname = 'storage';
  if n <> 0 then
    insert into audit_failures values ('S1', format('storage relations exist (%s)', n));
  end if;
  select count(*) into n from pg_policy p join pg_class c on c.oid = p.polrelid
    join pg_namespace s on s.oid = c.relnamespace where s.nspname = 'storage';
  if n <> 0 then
    insert into audit_failures values ('S1', format('storage policies exist (%s)', n));
  end if;
  -- No public column advertises an object path/bucket either.
  select count(*) into n from information_schema.columns
    where table_schema = 'public'
      and (column_name ~* '(bucket|object_key|object_path|storage_path|signed_url|video_url|media_url)');
  if n <> 0 then
    insert into audit_failures values ('S1', format('public columns reference object storage (%s)', n));
  end if;
end $$;

-- ───────────── S2: RLS on every table, anon holds no privilege anywhere ─────
do $$
declare
  r record;
  offenders text := '';
begin
  for r in
    select c.relname
    from pg_class c join pg_namespace s on s.oid = c.relnamespace
    where s.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity
  loop
    offenders := offenders || ' ' || r.relname;
  end loop;
  if offenders <> '' then
    insert into audit_failures values ('S2', 'tables without RLS:' || offenders);
    offenders := '';
  end if;

  for r in
    select c.relname, priv
    from pg_class c join pg_namespace s on s.oid = c.relnamespace,
         unnest(array['SELECT','INSERT','UPDATE','DELETE']) as priv
    where s.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm')
      and has_table_privilege('anon', c.oid, priv)
  loop
    offenders := offenders || ' ' || r.relname || ':' || r.priv;
  end loop;
  if offenders <> '' then
    insert into audit_failures values ('S2', 'anon table privileges:' || offenders);
    offenders := '';
  end if;

  for r in
    select c.relname
    from pg_class c join pg_namespace s on s.oid = c.relnamespace
    where s.nspname = 'public' and c.relkind = 'S'
      and (has_sequence_privilege('anon', c.oid, 'USAGE')
           or has_sequence_privilege('anon', c.oid, 'SELECT')
           or has_sequence_privilege('anon', c.oid, 'UPDATE'))
  loop
    offenders := offenders || ' ' || r.relname;
  end loop;
  if offenders <> '' then
    insert into audit_failures values ('S2', 'anon sequence privileges:' || offenders);
    offenders := '';
  end if;

  for r in
    select p.proname
    from pg_proc p join pg_namespace s on s.oid = p.pronamespace
    where s.nspname = 'public' and has_function_privilege('anon', p.oid, 'EXECUTE')
  loop
    offenders := offenders || ' ' || r.proname;
  end loop;
  if offenders <> '' then
    insert into audit_failures values ('S2', 'anon EXECUTE on public functions:' || offenders);
  end if;
end $$;

-- ───────── S3: client-writable text/jsonb columns carry a size bound ────────
-- A column counts as bounded when a CHECK constraint on its table mentions it
-- (length()/pg_column_size()/enum-style IN list), or its type carries a
-- varchar(n) limit.
create temp table client_writable_unbounded as
select c.table_name, c.column_name, c.data_type, priv
from information_schema.columns c,
     unnest(array['INSERT','UPDATE']) as priv
where c.table_schema = 'public'
  and c.data_type in ('text', 'character varying', 'jsonb', 'json', 'bytea')
  and c.character_maximum_length is null
  and exists (
    select 1 from pg_class t join pg_namespace s on s.oid = t.relnamespace
    where s.nspname = 'public' and t.relname = c.table_name and t.relkind in ('r', 'p')
  )
  and has_column_privilege('authenticated', format('public.%I', c.table_name), c.column_name, priv)
  and not exists (
    select 1
    from pg_constraint k join pg_class t on t.oid = k.conrelid
    where k.contype = 'c' and t.relname = c.table_name
      and pg_get_constraintdef(k.oid) ~ ('\m' || c.column_name || '\M')
  );

do $$
declare
  n int;
  listing text;
begin
  select count(*), string_agg(table_name || '.' || column_name || '(' || priv || ')', ', ' order by table_name, column_name, priv)
    into n, listing from client_writable_unbounded;
  if n <> 0 then
    insert into audit_failures values ('S3', format('%s client-writable text/json columns without a size bound: %s', n, listing));
  end if;
end $$;

-- ───────── S4: the URL column is capped for the owner's own row ─────────────
-- Only S4 writes. The probe runs as the owner inside a sub-block whose
-- outcome is undone either by the constraint (check_violation), by the missing
-- grant (insufficient_privilege), or — if the write went through — by the
-- deliberate raise that records the failure. The seeded user is removed after.
insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data)
values
  ('00000000-0000-4000-8000-0000000000a1', 'alice-storage@example.com',
   '{"full_name":"Alice"}', '{"provider":"google"}');
insert into auth.identities (provider, provider_id, user_id, identity_data)
values
  ('google', 'google-sub-alice-storage', '00000000-0000-4000-8000-0000000000a1',
   '{"sub":"google-sub-alice-storage","email":"alice-storage@example.com"}');

do $$
begin
  begin
    execute 'set local role authenticated';
    perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000000a1', true);
    update public.profiles set avatar_url = 'https://example.invalid/' || repeat('a', 2048)
      where id = '00000000-0000-4000-8000-0000000000a1';
    raise exception using errcode = 'P0001', message = 'S4_ACCEPTED';
  exception
    when check_violation then null;
    when insufficient_privilege then null; -- avatar_url not client-writable at all: also acceptable
    when raise_exception then
      if sqlerrm <> 'S4_ACCEPTED' then raise; end if;
      execute 'reset role';
      insert into audit_failures values ('S4', 'oversized avatar_url was accepted for the owner row');
  end;
  execute 'reset role';
end $$;

delete from auth.users where id = '00000000-0000-4000-8000-0000000000a1';

-- ───────────────────────── Inventories (artifacts) ──────────────────────────
\set QUIET off
\t on
\a
\echo STORAGE_AUDIT_JSON_BEGIN
select json_build_object(
  'storage_schema_present', exists (select 1 from pg_namespace where nspname = 'storage'),
  'storage_relations', (select count(*) from pg_class c join pg_namespace s on s.oid = c.relnamespace where s.nspname = 'storage'),
  'tables', (
    select json_agg(json_build_object(
      'table', c.relname,
      'rls', c.relrowsecurity,
      'rls_forced', c.relforcerowsecurity,
      'policies', (select count(*) from pg_policy p where p.polrelid = c.oid),
      'anon', json_build_object(
        'select', has_table_privilege('anon', c.oid, 'SELECT'),
        'insert', has_table_privilege('anon', c.oid, 'INSERT'),
        'update', has_table_privilege('anon', c.oid, 'UPDATE'),
        'delete', has_table_privilege('anon', c.oid, 'DELETE')),
      'authenticated', json_build_object(
        'select', has_table_privilege('authenticated', c.oid, 'SELECT'),
        'insert', has_table_privilege('authenticated', c.oid, 'INSERT'),
        'update', has_table_privilege('authenticated', c.oid, 'UPDATE'),
        'delete', has_table_privilege('authenticated', c.oid, 'DELETE'))
    ) order by c.relname)
    from pg_class c join pg_namespace s on s.oid = c.relnamespace
    where s.nspname = 'public' and c.relkind in ('r', 'p')
  ),
  'client_writable_text_columns', (
    select json_agg(json_build_object(
      'table', c.table_name, 'column', c.column_name, 'type', c.data_type,
      'bound', (
        select string_agg(pg_get_constraintdef(k.oid), ' ; ')
        from pg_constraint k join pg_class t on t.oid = k.conrelid
        where k.contype = 'c' and t.relname = c.table_name
          and pg_get_constraintdef(k.oid) ~ ('\m' || c.column_name || '\M'))
    ) order by c.table_name, c.column_name)
    from information_schema.columns c
    where c.table_schema = 'public'
      and c.data_type in ('text', 'character varying', 'jsonb', 'json', 'bytea')
      and exists (
        select 1 from pg_class t join pg_namespace s on s.oid = t.relnamespace
        where s.nspname = 'public' and t.relname = c.table_name and t.relkind in ('r', 'p'))
      and (has_column_privilege('authenticated', format('public.%I', c.table_name), c.column_name, 'INSERT')
           or has_column_privilege('authenticated', format('public.%I', c.table_name), c.column_name, 'UPDATE'))
  ),
  'failures', (select coalesce(json_agg(json_build_object('case', case_id, 'detail', detail) order by case_id), '[]'::json) from audit_failures),
  'anon_executable_functions', (
    select coalesce(json_agg(p.proname order by p.proname), '[]'::json)
    from pg_proc p join pg_namespace s on s.oid = p.pronamespace
    where s.nspname = 'public' and has_function_privilege('anon', p.oid, 'EXECUTE')
  )
);
\echo STORAGE_AUDIT_JSON_END

\set QUIET on
do $$
declare
  n int;
  listing text;
begin
  select count(*), string_agg(case_id || ': ' || detail, E'\n' order by case_id)
    into n, listing from audit_failures;
  if n <> 0 then
    raise exception E'storage audit: % failure(s)\n%', n, listing;
  end if;
end $$;
\echo storage audit: all cases passed
