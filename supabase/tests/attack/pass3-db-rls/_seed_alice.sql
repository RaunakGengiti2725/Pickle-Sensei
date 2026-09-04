-- Shared seed for the pass-3 attack scripts: Alice (google) and Bob (apple),
-- provisioned through the auth trigger path exactly like security_regression.sql.
-- Idempotent so concurrency scripts can include it once per database.
insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data)
values
  ('00000000-0000-4000-8000-00000000000a', 'alice@example.com',
   '{"full_name":"Alice"}', '{"provider":"google"}'),
  ('00000000-0000-4000-8000-00000000000b', 'bob@example.com',
   '{"full_name":"Bob"}', '{"provider":"apple"}')
on conflict (id) do nothing;

insert into auth.identities (provider, provider_id, user_id, identity_data)
values
  ('google', 'google-sub-alice', '00000000-0000-4000-8000-00000000000a',
   '{"sub":"google-sub-alice","email":"alice@example.com"}'),
  ('apple', 'apple-sub-bob', '00000000-0000-4000-8000-00000000000b',
   '{"sub":"apple-sub-bob","email":"bob@example.com"}')
on conflict (provider_id, provider) do nothing;

do $$
begin
  if (select count(*) from public.profiles
      where id in ('00000000-0000-4000-8000-00000000000a',
                   '00000000-0000-4000-8000-00000000000b')) <> 2 then
    raise exception 'SEED: handle_new_user trigger did not provision profiles';
  end if;
end $$;
