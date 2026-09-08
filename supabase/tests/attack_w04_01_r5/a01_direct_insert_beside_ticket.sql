-- A01 — free-rating conservation: a direct client INSERT of a scored shot
-- under a live permit does not settle the permit, so the permit stays a
-- syncable reservation AND the allowance already spent one unit. With an
-- offline ticket outstanding beside it the candidate's own conservation
-- reading (outstanding + scored + syncable permits ≤ 2) must still hold.
--
-- Sequence (one free account, every step a client-reachable path):
--   reserve P1 → issue 1 ticket T1 (allocator counts P1 as a reservation)
--   → direct scored INSERT S1 (gate: live permit P1 < 24h, allowance 0 < 2)
--   → apply_synced_shot S2 under P1 (backstop: scored 1 < 2 → accepted)
-- Expected: at most 2 units for the identity. Observed is asserted below.
begin;
\ir _prelude.sql

select pg_temp.mk_user('00000000-0000-4000-8000-00000000a101', 'google', 'google-sub-a01', '00000000-0000-4000-8000-0000000a0101');
do $$ begin perform set_config('request.headers', pg_temp.api_header(), true); end $$;

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000a101';
set local request.jwt.claims = '{"session_id":"00000000-0000-4000-8000-0000000a0101"}';

do $$
declare uid uuid := (select auth.uid()); r record; p record; g record; v text;
begin
  select * into r from public.register_offline_device('a01-key', 'production', true);
  if r.result <> 'accepted' then raise exception 'A01 precondition: registration (got %)', r.result; end if;

  select * into p from public.reserve_analysis_permit('a01-online-1');
  if p.result <> 'accepted' then raise exception 'A01 precondition: first online reservation (got %)', p.result; end if;

  select * into g from public.issue_offline_grant('a01-key', 2);
  if g.result <> 'accepted' or coalesce(array_length(g.ticket_ids, 1), 0) <> 1 then
    raise exception 'A01 precondition: one reservation leaves exactly one ticket (got %, %)', g.result, g.ticket_ids;
  end if;

  -- Direct write of a scored row beside the live permit: the gate accepts it
  -- (live reserved permit, allowance unspent) and leaves analysis_permit_id NULL.
  perform pg_temp.direct_scored_insert('00000000-0000-4000-8000-00000000a1f1');
  if pg_temp.scored(uid) <> 1 then raise exception 'A01 precondition: the direct scored row was written'; end if;
  if (select analysis_permit_id from public.shots where id = '00000000-0000-4000-8000-00000000a1f1') is not null then
    raise exception 'A01 precondition: a direct write carries no permit link';
  end if;
  if pg_temp.syncable_permits(uid) <> 1 then
    raise exception 'A01 precondition: P1 is still a syncable reservation after the direct write';
  end if;

  -- The same permit still backs a sync: second rating, permit finalized.
  v := public.apply_synced_shot(pg_temp.n_shot('00000000-0000-4000-8000-00000000a1f2', p.permit_id, 'scored'));
  if v <> 'accepted' then raise exception 'A01 precondition: the late sync under P1 (got %)', v; end if;

  raise notice 'A01 state: scored=% outstanding=% syncable=% events=%',
    pg_temp.scored(uid), pg_temp.outstanding(uid), pg_temp.syncable_permits(uid), pg_temp.events(uid);

  if not pg_temp.conserved(uid) then
    raise exception 'A01 BREAK: outstanding % + scored % + syncable % > 2 — a free identity holds a third rating unit (the outstanding ticket) beside two scored ratings',
      pg_temp.outstanding(uid), pg_temp.scored(uid), pg_temp.syncable_permits(uid);
  end if;
end $$;

rollback;
\echo A01 PASSED
