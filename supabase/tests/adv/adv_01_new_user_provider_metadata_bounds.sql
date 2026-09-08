-- ADV-01 — sign-in of a brand-new account whose PROVIDER-SUPPLIED profile
-- metadata is longer than public.profiles' size caps.
--
-- Boundary: Supabase Auth creates auth.users on the first signInWithIdToken
-- and populates raw_user_meta_data from the provider claims (name / full_name
-- / avatar_url). public.handle_new_user() copies those values verbatim into
-- public.profiles, which since 20260831160000 enforces profiles_text_bounds
-- (display_name <= 200, avatar_url <= 2048, email <= 320, provider <= 50).
-- A trigger failure on auth.users INSERT aborts the whole sign-in — the user
-- can never create an account (Auth answers "Database error saving new
-- user"), and the caps are supposed to bind CLIENT-WRITABLE text, not the
-- server-owned bootstrap path. Expected: the account is created and the
-- profile holds a bounded display name / avatar_url (or NULL), never an
-- aborted auth.users INSERT.
\set ON_ERROR_STOP on
\set QUIET on
begin;

do $$
begin
  -- Precondition: the bound exists and the ordinary path works.
  insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data)
  values ('00000000-0000-4000-8000-00000000ad01', 'adv01-ok@example.com',
          jsonb_build_object('full_name', repeat('N', 200)), '{"provider":"google"}');
  if (select count(*) from public.profiles where id = '00000000-0000-4000-8000-00000000ad01') <> 1 then
    raise exception 'ADV-01 precondition: a 200-char provider name must provision a profile';
  end if;
end $$;

-- Attack 1: a 201-character provider display name.
do $$
begin
  begin
    insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data)
    values ('00000000-0000-4000-8000-00000000ad02', 'adv01-longname@example.com',
            jsonb_build_object('full_name', repeat('N', 201)), '{"provider":"google"}');
  exception when others then
    raise exception 'ADV-01 BREAK: first sign-in aborted by handle_new_user() for a 201-char provider name (sqlstate %, %)',
      sqlstate, sqlerrm;
  end;
  if (select count(*) from public.profiles where id = '00000000-0000-4000-8000-00000000ad02') <> 1 then
    raise exception 'ADV-01 BREAK: auth.users row created but no profile provisioned for a long provider name';
  end if;
end $$;

-- Attack 2: a 2049-character provider avatar URL.
do $$
begin
  begin
    insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data)
    values ('00000000-0000-4000-8000-00000000ad03', 'adv01-longpic@example.com',
            jsonb_build_object('full_name', 'Ok', 'avatar_url', 'https://lh3.example/' || repeat('a', 2030)),
            '{"provider":"google"}');
  exception when others then
    raise exception 'ADV-01 BREAK: first sign-in aborted by handle_new_user() for a 2049-char avatar_url (sqlstate %, %)',
      sqlstate, sqlerrm;
  end;
  if (select count(*) from public.profiles where id = '00000000-0000-4000-8000-00000000ad03') <> 1 then
    raise exception 'ADV-01 BREAK: auth.users row created but no profile provisioned for a long avatar_url';
  end if;
end $$;

rollback;
\echo 'ADV-01 new-user provider metadata bounds: PASS'
