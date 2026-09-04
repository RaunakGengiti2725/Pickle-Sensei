\echo === repro A: apply_synced_shot with non-uuid id (seed 8 path_traversal) as an authenticated pool user
begin;
select set_config('request.jwt.claim.sub', (select user_id::text from stress_bm.pool where not premium order by idx limit 1), true);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;
select public.apply_synced_shot('{"id":"..;/","analysisPermitId":"00000000-0000-4000-8000-000000000000","resultKind":"low_confidence"}'::jsonb);
rollback;
\echo === repro B: reserve_analysis_permit(null) (seed 367) / 129-char key (seed 203)
begin;
select set_config('request.jwt.claim.sub', (select user_id::text from stress_bm.pool where premium order by idx limit 1), true);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;
select * from public.reserve_analysis_permit(null);
rollback;
begin;
select set_config('request.jwt.claim.sub', (select user_id::text from stress_bm.pool where premium order by idx limit 1), true);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;
select * from public.reserve_analysis_permit(repeat('k', 129));
rollback;
\echo === contrast: a cast failure inside the guarded block returns a categorical status
begin;
select set_config('request.jwt.claim.sub', (select user_id::text from stress_bm.pool where not premium order by idx limit 1), true);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;
select public.apply_synced_shot(jsonb_build_object('id', gen_random_uuid(), 'analysisPermitId', gen_random_uuid(), 'resultKind', 'scored', 'capturedAt', 'not-a-date'));
rollback;
\echo === no write check
select count(*) as bad_permit_rows from public.analysis_permits where idempotency_key is null or length(idempotency_key) > 128;
