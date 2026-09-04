-- Repro (boundary-malformed, seeds 3594306699 / 83728150 / 161480378):
-- public.webhook_events.id is an unbounded text primary key. An event id of
-- ~2700+ bytes that does not compress (btree keys are pglz-compressed first,
-- so repeat('a', 3000) still fits) cannot be indexed: PostgreSQL raises SQLSTATE 54000
-- ("index row size ... exceeds btree version 4 maximum 2704"), which PostgREST
-- maps to HTTP 500. In handleRevenueCatWebhook (supabase/functions/api/index.ts,
-- logEvent) the upsert error is only console.error'd, so the webhook is
-- acknowledged with 200 but no audit row exists and the event can never be
-- de-duplicated. Only the service role can reach the table (RLS on, no client
-- grants) and the route is secret-gated, hence P3.
-- Run against the throwaway stress database only.
\set ON_ERROR_STOP off
begin;
set local role service_role;
insert into public.webhook_events (id, provider, event_type, app_user_id, payload)
values ((select string_agg(md5(i::text), '') from generate_series(1, 100) i), 'revenuecat', 'RENEWAL', null, '{}'::jsonb)
on conflict (id) do nothing;
-- expected: ERROR:  index row size 3216 exceeds btree version 4 maximum 2704 for index "webhook_events_pkey"  (SQLSTATE 54000)
rollback;

begin;
set local role service_role;
-- a 2592-byte incompressible id fits (boundary check)
insert into public.webhook_events (id, provider, event_type, app_user_id, payload)
values ((select string_agg(md5(i::text), '') from generate_series(1, 81) i), 'revenuecat', 'RENEWAL', null, '{}'::jsonb)
on conflict (id) do nothing returning length(id) as stored_id_length;
rollback;
