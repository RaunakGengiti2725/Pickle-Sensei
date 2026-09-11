-- W01-03 (round 2): the settlement receipt lifecycle guard tolerates the
-- account cascade in WHICHEVER order PostgreSQL fires it.
--
-- public.settlement_receipts (20260908110000) has two cascade parents —
-- shot_id → public.shots and user_id → public.profiles — and public.shots
-- itself cascades from public.profiles. On an account deletion
-- (auth.users → profiles) PostgreSQL runs the profiles→settlement_receipts and
-- the profiles→shots cascades in trigger-NAME order (RI_ConstraintTrigger_a_<oid>,
-- compared as text). That order depends on the oids the two constraints were
-- allocated: in a fresh install the older shots constraint sorts first and the
-- shot cascade removes the receipt, but with a higher oid counter (a production
-- cluster, a dump/restore, a PITR) the receipts cascade can reach the row first
-- while its shot still exists. The 20260908110000 guard admitted a DELETE only
-- when the shot was already gone, so in that order account deletion of any
-- owner with a settled scored shot failed with 23514 and nothing was removed.
--
-- The guard now admits a DELETE whenever EITHER parent row is already gone
-- within the same statement — the owning profile (the account cascade, the same
-- detection guard_analysis_permit_delete uses) or the shot (the shot cascade) —
-- and still refuses it while both exist. UPDATE stays refused for every role.
-- No grant, policy or trigger definition changes; the function body is replaced
-- in place so the existing BEFORE UPDATE OR DELETE trigger keeps pointing at it.
create or replace function public.guard_settlement_receipt_lifecycle()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    raise exception using
      errcode = 'check_violation',
      message = 'settlement_receipts: receipts are append-only';
  end if;
  -- Account cascade: the profile row is already gone within this statement,
  -- whichever of the two profiles→(shots | settlement_receipts) cascades
  -- reached this row first.
  if not exists (select 1 from public.profiles p where p.id = old.user_id) then
    return old;
  end if;
  -- Shot cascade: the shot the receipt describes is already gone.
  if not exists (select 1 from public.shots s where s.id = old.shot_id) then
    return old;
  end if;
  raise exception using
    errcode = 'check_violation',
    message = 'settlement_receipts: a receipt outlives every path but the shot and account cascades';
end;
$$;

comment on function public.guard_settlement_receipt_lifecycle() is
  'BEFORE UPDATE OR DELETE guard on public.settlement_receipts: every UPDATE is refused (receipts are append-only evidence); a DELETE is admitted only when the shot the receipt describes or the owning profile is already gone within the same statement — the shot cascade or the account cascade (auth.users → profiles → shots | settlement_receipts), in whichever order PostgreSQL fires the two profiles cascades — and refused while both still exist. SECURITY DEFINER so the lookups are not narrowed by the caller''s RLS; revoked from clients (triggers do not need EXECUTE).';

revoke all on function public.guard_settlement_receipt_lifecycle()
  from public, anon, authenticated;
