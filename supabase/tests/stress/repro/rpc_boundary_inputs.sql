-- Repro (boundary-malformed campaign) for three RPC boundary behaviours when
-- apply_synced_shot / reserve_analysis_permit are called directly (PostgREST
-- /rest/v1/rpc with a user JWT — the edge function's parseSyncShot and the
-- idempotencyKey length check normally stop these before the RPC):
--   A. seed 392606550   — a phase confidence of "NaN" is stored: shot_phases.confidence
--                          is numeric(5,4) with no range CHECK, the RPC returns 'accepted'.
--   B. seeds 2556047652 / 775385697 — malformed scalar types throw out of the RPC
--                          as SQLSTATE 22P02 (PostgREST 400) with the client input echoed,
--                          instead of a typed status; no row is written.
--   C. seeds 207880440 / 3617911837 — a 129-char / NULL idempotency key throws
--                          23514 / 23502 out of reserve_analysis_permit; no row is written.
-- Run against the throwaway stress database only.
\set ON_ERROR_STOP off
begin;
insert into auth.users (id, email) values ('00000000-0000-4000-8000-0000000000aa', 'stress-a@example.test') on conflict (id) do nothing;
insert into public.profiles (id, email) values ('00000000-0000-4000-8000-0000000000aa', 'stress-a@example.test') on conflict (id) do nothing;
-- make the user premium so the free-rating gate is not what rejects the shot
insert into public.billing_entitlements (user_id, premium, product_key, verified_at, expires_at)
values ('00000000-0000-4000-8000-0000000000aa', true, 'pickle_sensei_pro_monthly', now(), now() + interval '1 year')
on conflict (user_id) do update set premium = true, expires_at = excluded.expires_at, verified_at = now();

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000aa';
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-0000000000aa","role":"authenticated"}';

select result from public.reserve_analysis_permit('repro-nan-permit') \gset
select id as permit_id from public.analysis_permits
where user_id = '00000000-0000-4000-8000-0000000000aa' and idempotency_key = 'repro-nan-permit' \gset

-- A. NaN phase confidence accepted
select public.apply_synced_shot(format($j$
{"id":"11111111-1111-4111-8111-111111111111","analysisPermitId":"%s","sessionId":null,
 "shotType":"drive","cameraView":"side","capturedAt":"2026-07-15T16:00:00.000Z",
 "startMs":0,"contactMs":500,"endMs":1000,"overallScore":null,"confidence":0.5,"resultKind":"low_confidence",
 "phases":[{"key":"backswing","startMs":0,"representativeMs":200,"endMs":400,"confidence":"NaN"}],
 "checkpoints":[{"key":"paddle_prep","direction":"up","score":null,"confidence":0.7,"band":"green","severity":0.1,"applicable":true}],
 "versionVector":{"appVersion":"1","modelBundleVersion":"1","poseModelVersion":"1","paddleModelVersion":"1",
                  "strokeDetectorVersion":"1","phaseModelVersion":"1","scoringModelVersion":"1","shotConfigVersion":"1"}}
$j$, :'permit_id')::jsonb) as nan_phase_status;
select phase_key, confidence, confidence = 'NaN'::numeric as is_nan
from public.shot_phases where shot_id = '11111111-1111-4111-8111-111111111111';

-- B. wrong scalar type for id → raw 22P02 exception (no typed status)
savepoint b1;
select public.apply_synced_shot('{"id":1.5,"analysisPermitId":"00000000-0000-4000-8000-000000000001"}'::jsonb);
rollback to savepoint b1;
select public.apply_synced_shot('{"id":"../etc/passwd","analysisPermitId":"00000000-0000-4000-8000-000000000001"}'::jsonb);
rollback to savepoint b1;

-- C. idempotency key over the 128-char cap / NULL → 23514 / 23502 exceptions
select public.reserve_analysis_permit(repeat('k', 129));
rollback to savepoint b1;
select public.reserve_analysis_permit(null);
rollback to savepoint b1;
select count(*) as permits_written_by_b_and_c from public.analysis_permits
where user_id = '00000000-0000-4000-8000-0000000000aa' and idempotency_key <> 'repro-nan-permit';
rollback;
