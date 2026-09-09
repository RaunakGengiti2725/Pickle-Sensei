-- ADV-02 — service-only / append-only tables must not carry service_role DML
-- that the migrations never revoked.
--
-- Hosted Supabase's default privileges grant ALL on every new public table to
-- service_role (see shim_hosted_service_role.sql). The migrations revoke
-- service_role from the billing, offline, webhook and external-credential
-- tables but NOT from public.free_rating_ledger, public.settlement_receipts
-- or public.analysis_permit_tombstones. The canonical shim models
-- service_role's defaults as truncate/references/trigger only, so the
-- canonical matrix cannot see this. On every history this attack asserts the
-- catalog (has_table_privilege) AND exercises the privilege: a service_role
-- UPDATE / DELETE on free_rating_ledger (which has NO append-only trigger)
-- and on analysis_permit_tombstones (no trigger either) would silently
-- rewrite a lifetime free-rating count or drop a tombstone.
--
-- Expected: service_role holds no INSERT/UPDATE/DELETE/TRUNCATE on the three
-- tables and cannot rewrite or remove a ledger row.
\set ON_ERROR_STOP on
begin;

insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data) values
 ('00000000-0000-4000-8000-0000000002a1','adv02@example.com','{"full_name":"Adv"}','{"provider":"apple"}');
insert into auth.identities (provider, provider_id, user_id, identity_data) values
 ('apple','adv02-apple','00000000-0000-4000-8000-0000000002a1','{"sub":"adv02-apple"}');
create temporary table adv02_key as
  select public.free_rating_identity_hash('apple', 'adv02-apple') as identity_hash;
grant select on adv02_key to service_role;
insert into public.free_rating_ledger (identity_hash, scored_count)
select identity_hash, 2 from adv02_key;
insert into public.analysis_permit_tombstones (permit_id, user_id, idempotency_key, status, outcome, created_at)
 values ('00000000-0000-4000-8000-0000000002b1', '00000000-0000-4000-8000-0000000002a1', 'adv02-tomb', 'finalized', 'scored', now());

create temp table adv02_bad (item text);
grant insert on adv02_bad to service_role;

do $$
declare t text; p text;
begin
  foreach t in array array['public.free_rating_ledger', 'public.settlement_receipts', 'public.analysis_permit_tombstones'] loop
    foreach p in array array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'] loop
      if has_table_privilege('service_role', t::regclass, p) then
        insert into adv02_bad values ('grant:' || t || ':' || p);
      end if;
    end loop;
  end loop;
end $$;

set local role service_role;
do $$
declare r text;
begin
  begin
    update public.free_rating_ledger set scored_count = 0
      where identity_hash = (select identity_hash from adv02_key);
    r := 'ACCEPTED';
  exception when others then
    r := sqlstate;
  end;
  raise notice 'ADV-02 service_role UPDATE free_rating_ledger -> %', r;
  if r <> '42501' then insert into adv02_bad values ('live:update_free_rating_ledger=' || r); end if;
end $$;
do $$
declare r text;
begin
  begin
    delete from public.free_rating_ledger where identity_hash = (select identity_hash from adv02_key);
    r := 'ACCEPTED';
  exception when others then
    r := sqlstate;
  end;
  raise notice 'ADV-02 service_role DELETE free_rating_ledger -> %', r;
  if r <> '42501' then insert into adv02_bad values ('live:delete_free_rating_ledger=' || r); end if;
end $$;
do $$
declare r text;
begin
  begin
    delete from public.analysis_permit_tombstones where permit_id = '00000000-0000-4000-8000-0000000002b1';
    r := 'ACCEPTED';
  exception when others then
    r := sqlstate;
  end;
  raise notice 'ADV-02 service_role DELETE analysis_permit_tombstones -> %', r;
  if r <> '42501' then insert into adv02_bad values ('live:delete_permit_tombstone=' || r); end if;
end $$;
reset role;

do $$
declare bad text[];
begin
  if (select scored_count from public.free_rating_ledger
      where identity_hash = (select identity_hash from adv02_key)) is distinct from 2 then
    insert into adv02_bad values ('ledger_row_rewritten_or_gone');
  end if;
  if not exists (select 1 from public.analysis_permit_tombstones where permit_id = '00000000-0000-4000-8000-0000000002b1') then
    insert into adv02_bad values ('tombstone_gone');
  end if;
  select coalesce(array_agg(item order by item), '{}') into bad from adv02_bad;
  raise notice 'ADV-02 findings: %', bad;
  if cardinality(bad) > 0 then
    raise exception 'ADV-02 BREAK: %', bad;
  end if;
  raise notice 'ADV-02: PASS';
end $$;
rollback;
