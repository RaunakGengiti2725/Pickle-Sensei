-- ADV-01 — service_role may not TRUNCATE the append-only / retention ledgers.
--
-- The append-only triggers refuse UPDATE/DELETE row by row, but TRUNCATE is a
-- separate privilege that fires no row triggers. W07-03 recognised this and
-- added explicit TRUNCATE guards + `revoke all ... from service_role` for the
-- billing transfer tables, and W09 revoked everything from service_role on the
-- offline ledgers. The older ledgers never got the same treatment: under the
-- canonical shim's default privileges (truncate/references/trigger to
-- service_role) the compromised-or-buggy service key can erase, in one
-- statement, the free-rating identity ledger (re-earning every free rating in
-- the fleet), every settlement receipt, every permit tombstone (re-opening
-- resurrection), and the consent / evaluation / feedback ledgers whose
-- retention is promised in legal.ts.
--
-- Expected: every TRUNCATE below is refused (42501 insufficient_privilege).
\set ON_ERROR_STOP on
begin;

create function pg_temp.try_truncate(p_table regclass) returns text
language plpgsql as $$
begin
  execute format('truncate %s', p_table);
  return 'ACCEPTED';
exception when others then
  return sqlstate;
end $$;
grant execute on function pg_temp.try_truncate(regclass) to service_role;

set local role service_role;
do $$
declare
  t text;
  r text;
  bad text[] := '{}';
begin
  foreach t in array array[
    'public.free_rating_ledger',
    'public.settlement_receipts',
    'public.analysis_permit_tombstones',
    'public.consent_records',
    'public.evaluation_trials',
    'public.analysis_feedback',
    'public.account_deletion_feedback',
    'public.analysis_permits',
    'public.shots'
  ] loop
    -- each attempt in its own subtransaction so one refusal does not abort the rest
    begin
      r := pg_temp.try_truncate(t::regclass);
    exception when others then
      r := sqlstate;
    end;
    raise notice 'ADV-01 service_role TRUNCATE % -> %', t, r;
    if r <> '42501' then
      bad := bad || (t || '=' || r);
    end if;
  end loop;
  if cardinality(bad) > 0 then
    raise exception 'ADV-01 BREAK: service_role can TRUNCATE %', bad;
  end if;
end $$;
reset role;
do $$ begin raise notice 'ADV-01: PASS'; end $$;
rollback;
