-- W04-01 round-2 adversarial matrix — offline device registry / grants /
-- allocation ledger (20260908120000_offline_device_grants.sql) at candidate
-- 1da63a1e. Runs against the shim + every migration (the same harness as
-- run_rls_tests.sh / xc_pg_up.sh). Complements the r1 matrix
-- (w04_01_offline_attack.sql, A1–A9): every block here targets a boundary r1
-- did not — late-synced permits vs the allocator's 24 h reservation window,
-- the client delivery path of an offline result, support-review recovery,
-- moved sign-in identities, boundary inputs, the session gate, corrupt owner
-- writes, entitlement revocation under a live lease, replay storms.
--
-- Every block asserts the behaviour the work package REQUIRES (conservation
-- allocated + consumed + released ≤ entitlement, original-owner recovery,
-- API-only writes, append-only ledger, bounded leases). A block that raises
-- records BROKEN; a block whose expectations hold records HELD. The file exits
-- non-zero when any block is BROKEN, so on the candidate a confirmed break is
-- a failing run and a fix flips it green.
--
--   docker exec <c> psql -U postgres -v ON_ERROR_STOP=1 \
--     -f /tests/xc_adjudication/w04_01_r2_offline_attack.sql
--
-- Each attack is self-contained: it builds its own users/devices/tickets and
-- ends by raising ATTACK_OK, so its writes roll back and no attack depends on
-- another.
\set ON_ERROR_STOP on
begin;

create temporary table x_results (
  n serial primary key, attack text not null, verdict text not null, detail text not null
);
create temporary table x_sessions (user_id uuid primary key, session_id uuid not null);
grant select on x_sessions to authenticated;

create function pg_temp.x_record(p_attack text, p_verdict text, p_detail text) returns void
language sql as $$
  insert into x_results (attack, verdict, detail) values (p_attack, p_verdict, p_detail);
$$;

create function pg_temp.x_ok(p_detail text) returns void
language plpgsql as $$
begin
  raise exception using errcode = 'P0001', message = 'ATTACK_OK:' || p_detail;
end;
$$;

-- Owner-role fixture: a user with one sign-in identity and one live session.
create function pg_temp.x_user(p_n integer, p_provider text, p_sub text) returns uuid
language plpgsql as $$
declare
  v_uid uuid := format('a0000000-0000-4000-8000-%s', lpad(to_hex(p_n), 12, '0'))::uuid;
  v_sid uuid := format('b0000000-0000-4000-8000-%s', lpad(to_hex(p_n), 12, '0'))::uuid;
begin
  insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data)
  values (v_uid, format('x%s@example.com', p_n), '{"full_name":"X"}', jsonb_build_object('provider', p_provider));
  insert into auth.identities (provider, provider_id, user_id, identity_data)
  values (p_provider, p_sub, v_uid, jsonb_build_object('sub', p_sub));
  insert into auth.sessions (id, user_id) values (v_sid, v_uid);
  insert into x_sessions (user_id, session_id) values (v_uid, v_sid);
  return v_uid;
end;
$$;

-- Owner/service write of a durably delivered offline result (scored, no
-- online permit) — the shape consume_offline_ticket() is specified to bind.
create function pg_temp.x_shot(p_uid uuid, p_shot uuid) returns void
language plpgsql as $$
begin
  insert into public.shots (
    id, user_id, shot_type, captured_at, start_ms, end_ms, overall_score, analysis_confidence, result_kind,
    app_version, model_bundle_version, pose_model_version, paddle_model_version,
    stroke_detector_version, phase_model_version, scoring_model_version, shot_config_version
  ) values (p_shot, p_uid, 'drive', now(), 0, 1000, 7, 1, 'scored', 'v1', 'v1', 'v1', 'v1', 'v1', 'v1', 'v1', 'v1');
end;
$$;

-- The client's online sync payload for a scored shot backed by a permit —
-- exactly the object the edge fn hands to apply_synced_shot(jsonb).
create function pg_temp.x_sync_payload(p_shot uuid, p_permit uuid) returns jsonb
language sql as $$
  select jsonb_build_object(
    'id', p_shot, 'analysisPermitId', p_permit, 'sessionId', null,
    'shotType', 'dink', 'cameraView', 'side', 'capturedAt', '2026-09-01T10:00:00.000Z',
    'startMs', 0, 'contactMs', 100, 'endMs', 200, 'overallScore', 7, 'confidence', 0.9,
    'resultKind', 'scored', 'phases', '[]'::jsonb, 'checkpoints', '[]'::jsonb,
    'versionVector', jsonb_build_object(
      'appVersion', '1.0.0', 'modelBundleVersion', 'bundle-1', 'poseModelVersion', 'pose-1',
      'paddleModelVersion', 'paddle-1', 'strokeDetectorVersion', 'stroke-1',
      'phaseModelVersion', 'phase-1', 'scoringModelVersion', 'scoring-1', 'shotConfigVersion', 'config-1'));
$$;

-- Become the API-authenticated caller (role, JWT sub, live session claim, API
-- header) — exactly what the Edge Function's per-request connection carries.
create function pg_temp.x_as(p_uid uuid) returns void
language plpgsql as $$
begin
  perform set_config('role', 'none', true);
  perform set_config('request.headers',
    jsonb_build_object('x-pickle-api-key', public.get_api_request_key())::text, true);
  perform set_config('request.jwt.claim.sub', p_uid::text, true);
  perform set_config('request.jwt.claims',
    jsonb_build_object('session_id', (select session_id from x_sessions where user_id = p_uid))::text, true);
  perform set_config('role', 'authenticated', true);
end;
$$;

create function pg_temp.x_owner() returns void
language plpgsql as $$
begin
  perform set_config('role', 'none', true);
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', '', true);
  perform set_config('request.headers', '', true);
end;
$$;

create function pg_temp.x_events(p_uid uuid) returns text
language sql security definer as $$
  select coalesce(
    (select string_agg(e.event || ':' || e.n, ',' order by e.event)
     from (select event, count(*) n from public.offline_allocation_ledger
           where user_id = p_uid group by event) e), '');
$$;

-- Conservation as the work package states it, for one sign-in identity:
-- scored ratings (identity lifetime) + outstanding holds (allocated, not
-- consumed) + every permit that can still back a sync (reserved of ANY age,
-- or released/expired — public.permit_backs_sync) must never exceed 2.
create function pg_temp.x_budget_used(p_uid uuid) returns integer
language sql security definer as $$
  select
    coalesce((select max(l.scored_count) from public.free_rating_ledger l
              where l.identity_hash in (
                select public.free_rating_identity_hash(i.provider, i.provider_id)
                from auth.identities i where i.user_id = p_uid)), 0)
    + (select count(*)::int from public.offline_allocation_ledger a
       where a.user_id = p_uid and a.event = 'allocated'
         and not exists (select 1 from public.offline_allocation_ledger c
                         where c.ticket_id = a.ticket_id and c.event = 'consumed'))
    + (select count(*)::int from public.analysis_permits p
       where p.user_id = p_uid and public.permit_backs_sync(p.status, p.outcome)
         and not exists (select 1 from public.shots s where s.analysis_permit_id = p.id));
$$;

grant execute on function pg_temp.x_ok(text), pg_temp.x_as(uuid), pg_temp.x_owner(), pg_temp.x_events(uuid),
  pg_temp.x_budget_used(uuid), pg_temp.x_sync_payload(uuid, uuid)
  to anon, authenticated, service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- R1  Swept online permits are not reservations to the allocator but still
--     back a late sync. pg_cron's hourly sweep (20260831000000) flips a
--     reserved permit older than 24 h to released/expired; permit_backs_sync()
--     (20260906130000/140000, "late permit sync durability") deliberately
--     keeps such a permit acceptable for apply_synced_shot(). The allocator's
--     v_reserved counts only status='reserved' AND created_at > now()-24h, so
--     a free identity that reserved both ratings online, let them age past
--     the sweep, then goes offline is issued 2 tickets on top — and every
--     later sync of the swept permits is accepted: 4 ratings for a 2-rating
--     identity. The work package's invariant is allocated + consumed +
--     released ≤ entitlement.
-- ───────────────────────────────────────────────────────────────────────────
do $$
declare
  v_a uuid; g record; p1 record; p2 record; rec record; v_r text; bad text := '';
  s1 uuid := 'c0000000-0000-4000-8000-000000000101';
  s2 uuid := 'c0000000-0000-4000-8000-000000000102';
begin
  begin
    v_a := pg_temp.x_user(101, 'google', 'google-sub-r1');
    perform pg_temp.x_as(v_a);
    select * into p1 from public.reserve_analysis_permit('r1-online-1');
    select * into p2 from public.reserve_analysis_permit('r1-online-2');
    if p1.result <> 'accepted' or p2.result <> 'accepted' then
      raise exception 'R1 setup: online reservations → %, %', p1.result, p2.result;
    end if;
    select * into g from public.register_offline_device('r1-key', 'production', true);
    if g.result <> 'accepted' then raise exception 'R1 setup: register → %', g.result; end if;
    -- Precondition: both ratings reserved online → no offline capacity.
    select result into v_r from public.issue_offline_grant('r1-key', 2);
    if v_r <> 'access.paywall_required' then bad := bad || 'live-permits-not-counted:' || v_r || ' '; end if;
    perform pg_temp.x_owner();

    -- 24 h pass; the hourly sweep runs (its exact statement).
    update public.analysis_permits set status = 'released', outcome = 'expired'
    where status = 'reserved' and user_id = v_a;

    perform pg_temp.x_as(v_a);
    select * into g from public.issue_offline_grant('r1-key', 2);
    -- The late syncs the sweep promised to honour.
    v_r := public.apply_synced_shot(pg_temp.x_sync_payload(s1, p1.permit_id));
    if v_r <> 'accepted' then bad := bad || 'late-sync-1:' || v_r || ' '; end if;
    v_r := public.apply_synced_shot(pg_temp.x_sync_payload(s2, p2.permit_id));
    if v_r <> 'accepted' then bad := bad || 'late-sync-2:' || v_r || ' '; end if;
    select * into rec from public.access_state();
    perform pg_temp.x_owner();

    if g.result = 'accepted' and coalesce(array_length(g.ticket_ids, 1), 0) > 0 then
      bad := bad || format('allocated %s tickets on top of 2 sync-backing permits; access_state scored=%s reserved=%s; budget used=%s of 2 ',
        array_length(g.ticket_ids, 1), rec.scored_count, rec.reserved_count, pg_temp.x_budget_used(v_a));
    end if;
    if pg_temp.x_budget_used(v_a) > 2 then
      bad := bad || format('conservation: %s > 2 ', pg_temp.x_budget_used(v_a));
    end if;
    if bad <> '' then raise exception 'R1 BREAK: %', bad; end if;
    perform pg_temp.x_ok('swept permits still count as reservations; no over-allocation');
  exception when others then
    if sqlerrm like 'ATTACK_OK:%' then perform pg_temp.x_record('R1 swept-permit-overallocation', 'HELD', substr(sqlerrm, 11));
    else perform pg_temp.x_record('R1 swept-permit-overallocation', 'BROKEN', sqlerrm); end if;
  end;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- R2  Same hole without the sweep: a permit still status='reserved' but older
--     than 24 h (the sweep is hourly and best-effort; the API "lazily
--     releases" — 20260831000000) is ignored by the allocator, yet
--     permit_backs_sync('reserved', null) is true at any age. The owner row
--     stands in for the clock (created_at cannot be edited after the fact).
-- ───────────────────────────────────────────────────────────────────────────
do $$
declare
  v_a uuid; g record; rec record; v_r text; bad text := ''; v_permit uuid;
  s1 uuid := 'c0000000-0000-4000-8000-000000000201';
begin
  begin
    v_a := pg_temp.x_user(102, 'apple', 'apple-sub-r2');
    insert into public.analysis_permits (user_id, idempotency_key, created_at)
    values (v_a, 'r2-stale', now() - interval '25 hours') returning id into v_permit;
    perform pg_temp.x_as(v_a);
    select * into g from public.register_offline_device('r2-key', 'production', true);
    select * into g from public.issue_offline_grant('r2-key', 2);
    v_r := public.apply_synced_shot(pg_temp.x_sync_payload(s1, v_permit));
    if v_r <> 'accepted' then bad := bad || 'stale-reserved-sync:' || v_r || ' '; end if;
    select * into rec from public.access_state();
    perform pg_temp.x_owner();
    if g.result = 'accepted' and coalesce(array_length(g.ticket_ids, 1), 0) > 1 then
      bad := bad || format('allocated %s tickets beside a stale reserved permit that then synced; scored=%s reserved=%s budget used=%s ',
        array_length(g.ticket_ids, 1), rec.scored_count, rec.reserved_count, pg_temp.x_budget_used(v_a));
    end if;
    if pg_temp.x_budget_used(v_a) > 2 then bad := bad || format('conservation: %s > 2 ', pg_temp.x_budget_used(v_a)); end if;
    if bad <> '' then raise exception 'R2 BREAK: %', bad; end if;
    perform pg_temp.x_ok('stale reserved permit counted; allocation bounded');
  exception when others then
    if sqlerrm like 'ATTACK_OK:%' then perform pg_temp.x_record('R2 stale-reserved-overallocation', 'HELD', substr(sqlerrm, 11));
    else perform pg_temp.x_record('R2 stale-reserved-overallocation', 'BROKEN', sqlerrm); end if;
  end;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- R3  Client delivery of an offline result. consume_offline_ticket() binds a
--     ticket to "a durably delivered scored shot that no online permit paid
--     for". Every client write path for such a shot is checked: the sync RPC
--     without a permit, the sync RPC with a permit the holds now deny, and
--     the direct table insert (20260905000000 gate). If none exists, a device
--     that comes back online holding tickets can neither deliver its results
--     nor reserve online — its only exit is to return the tickets, which are
--     then charged anyway.
-- ───────────────────────────────────────────────────────────────────────────
do $$
declare
  v_a uuid; g record; p record; v_r text; paths text := ''; bad text := '';
  s1 uuid := 'c0000000-0000-4000-8000-000000000301';
  s2 uuid := 'c0000000-0000-4000-8000-000000000302';
begin
  begin
    v_a := pg_temp.x_user(103, 'google', 'google-sub-r3');
    perform pg_temp.x_as(v_a);
    select * into g from public.register_offline_device('r3-key', 'production', true);
    select * into g from public.issue_offline_grant('r3-key', 2);
    if g.result <> 'accepted' or array_length(g.ticket_ids, 1) <> 2 then raise exception 'R3 setup: issue → %', g.result; end if;

    -- path 1: the sync RPC, offline result, no permit
    v_r := public.apply_synced_shot(pg_temp.x_sync_payload(s1, null));
    paths := paths || 'sync-no-permit=' || v_r || ' ';
    if v_r = 'accepted' then perform pg_temp.x_ok('offline result deliverable via apply_synced_shot without permit'); end if;

    -- path 2: reserve an online permit to carry the offline result
    select * into p from public.reserve_analysis_permit('r3-online');
    paths := paths || 'reserve-online=' || p.result || ' ';
    if p.result = 'accepted' then
      bad := bad || 'online permit issued beside 2 holds ';
    end if;

    -- path 3: the client table write
    begin
      insert into public.shots (
        id, user_id, shot_type, captured_at, start_ms, end_ms, overall_score, analysis_confidence, result_kind,
        app_version, model_bundle_version, pose_model_version, paddle_model_version,
        stroke_detector_version, phase_model_version, scoring_model_version, shot_config_version
      ) values (s2, v_a, 'drive', now(), 0, 1000, 7, 1, 'scored', 'v1', 'v1', 'v1', 'v1', 'v1', 'v1', 'v1', 'v1');
      paths := paths || 'direct-insert=accepted ';
      perform pg_temp.x_ok('offline result deliverable via table insert');
    exception when others then
      if sqlerrm like 'ATTACK_OK:%' then raise; end if;
      paths := paths || 'direct-insert=' || sqlstate || ' ';
    end;

    -- consume needs a delivered shot: nothing above delivered one
    v_r := public.consume_offline_ticket(g.ticket_ids[1], s1);
    paths := paths || 'consume=' || v_r || ' ';
    perform pg_temp.x_owner();
    if bad <> '' then raise exception 'R3 BREAK: %', bad; end if;
    raise exception 'R3 BREAK: no client path delivers an offline result while tickets are held (%)', paths;
  exception when others then
    if sqlerrm like 'ATTACK_OK:%' then perform pg_temp.x_record('R3 client-delivery-path', 'HELD', substr(sqlerrm, 11));
    else perform pg_temp.x_record('R3 client-delivery-path', 'BROKEN', sqlerrm); end if;
  end;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- R4  Support-review recovery. OFFLINE_FREE_ALLOCATION_POLICY.recovery is
--     "original_installation_proof_or_explicit_support_review": an identity
--     whose phone (installation K1, 2 outstanding tickets) is lost signs in
--     on K2 and is paywalled (by contract). Support resolves the case by
--     writing released/support_review through the table (the only path the
--     candidate allows). That resolution must give the identity its
--     never-used ratings back on K2 — otherwise "support review" recovers
--     nothing and the tickets are charged without a result.
-- ───────────────────────────────────────────────────────────────────────────
do $$
declare
  v_a uuid; v_b uuid; g record; p record; rec record; v_r text; bad text := '';
begin
  begin
    v_a := pg_temp.x_user(104, 'apple', 'apple-sub-r4');
    perform pg_temp.x_as(v_a);
    select * into g from public.register_offline_device('r4-lost-phone', 'production', true);
    select * into g from public.issue_offline_grant('r4-lost-phone', 2);
    if g.result <> 'accepted' or array_length(g.ticket_ids, 1) <> 2 then raise exception 'R4 setup: issue → %', g.result; end if;
    perform pg_temp.x_owner();

    -- Phone lost; account deleted; same Apple ID signs in again on a new phone.
    delete from auth.users where id = v_a;
    v_b := pg_temp.x_user(105, 'apple', 'apple-sub-r4');
    perform pg_temp.x_as(v_b);
    select * into g from public.register_offline_device('r4-new-phone', 'production', true);
    select result into v_r from public.issue_offline_grant('r4-new-phone', 2);
    if v_r <> 'access.paywall_required' then bad := bad || 'new-phone-before-review:' || v_r || ' '; end if;
    perform pg_temp.x_owner();

    -- Explicit support review closes both tickets.
    insert into public.offline_allocation_ledger (user_id, device_id, grant_id, generation, ticket_id, event, reason, identity_hashes)
    select a.user_id, a.device_id, a.grant_id, a.generation, a.ticket_id, 'released', 'support_review', a.identity_hashes
    from public.offline_allocation_ledger a where a.user_id = v_a and a.event = 'allocated';
    if pg_temp.x_events(v_a) <> 'allocated:2,released:2' then raise exception 'R4 setup: ledger %', pg_temp.x_events(v_a); end if;

    perform pg_temp.x_as(v_b);
    select * into rec from public.access_state();
    select * into g from public.issue_offline_grant('r4-new-phone', 2);
    select * into p from public.reserve_analysis_permit('r4-online');
    perform pg_temp.x_owner();
    if g.result <> 'accepted' or p.result <> 'accepted' then
      bad := bad || format('after support_review release of both never-used tickets: offline=%s online=%s access_state scored=%s reserved=%s ',
        g.result, p.result, rec.scored_count, rec.reserved_count);
    end if;
    if bad <> '' then raise exception 'R4 BREAK: %', bad; end if;
    perform pg_temp.x_ok('support_review release restores the identity''s unused ratings');
  exception when others then
    if sqlerrm like 'ATTACK_OK:%' then perform pg_temp.x_record('R4 support-review-recovery', 'HELD', substr(sqlerrm, 11));
    else perform pg_temp.x_record('R4 support-review-recovery', 'BROKEN', sqlerrm); end if;
  end;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- R5  Moved sign-in identity. Account A {google, apple} allocates one ticket
--     (snapshotting BOTH identity hashes). The Apple identity later belongs
--     to account C (A's Apple sign-in is unlinked / Apple's revocation +
--     re-association, C signs in with that Apple ID). Cross-account
--     isolation: C never held the ticket, so C's budget must not carry A's
--     hold, and C must not be able to close A's ticket.
-- ───────────────────────────────────────────────────────────────────────────
do $$
declare
  v_a uuid; v_c uuid; g record; rec_a record; rec_c record; v_r text; bad text := '';
begin
  begin
    v_a := pg_temp.x_user(106, 'google', 'google-sub-r5');
    insert into auth.identities (provider, provider_id, user_id, identity_data)
    values ('apple', 'apple-sub-r5', v_a, '{"sub":"apple-sub-r5"}');
    perform pg_temp.x_as(v_a);
    select * into g from public.register_offline_device('r5-key', 'production', true);
    select * into g from public.issue_offline_grant('r5-key', 1);
    if g.result <> 'accepted' or array_length(g.ticket_ids, 1) <> 1 then raise exception 'R5 setup: issue → %', g.result; end if;
    perform pg_temp.x_owner();

    delete from auth.identities where user_id = v_a and provider = 'apple';
    v_c := pg_temp.x_user(107, 'apple', 'apple-sub-r5');

    perform pg_temp.x_as(v_a);
    select * into rec_a from public.access_state();
    perform pg_temp.x_as(v_c);
    select * into rec_c from public.access_state();
    v_r := public.release_offline_ticket(g.ticket_ids[1], 'unused_ticket_returned');
    perform pg_temp.x_owner();
    if rec_c.reserved_count <> 0 then
      bad := bad || format('C is charged for A''s hold (C reserved=%s, A reserved=%s) ', rec_c.reserved_count, rec_a.reserved_count);
    end if;
    if v_r <> 'offline.ticket_not_found' then
      bad := bad || format('C closed A''s ticket: release → %s (ledger of A: %s) ', v_r, pg_temp.x_events(v_a));
    end if;
    if bad <> '' then raise exception 'R5 BREAK: %', bad; end if;
    perform pg_temp.x_ok('a moved identity carries no foreign hold and cannot close foreign tickets');
  exception when others then
    if sqlerrm like 'ATTACK_OK:%' then perform pg_temp.x_record('R5 moved-identity-isolation', 'HELD', substr(sqlerrm, 11));
    else perform pg_temp.x_record('R5 moved-identity-isolation', 'BROKEN', sqlerrm); end if;
  end;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- R6  Boundary inputs on the new RPC surface: installation keys at/over the
--     128-char cap, leading punctuation, non-ASCII, empty, NULL; ticket counts
--     -1 / 0 / 3 / NULL; unknown environment; NULL attestation; and the Pro
--     lease against entitlements expiring in 1 minute, in 100 years, never,
--     already expired (premium=true), and premium=false with a future expiry.
-- ───────────────────────────────────────────────────────────────────────────
do $$
declare
  v_a uuid; v_pro uuid; g record; v_r text; bad text := ''; k128 text; k129 text;
begin
  begin
    v_a := pg_temp.x_user(108, 'google', 'google-sub-r6');
    k128 := 'k' || repeat('x', 127);
    k129 := 'k' || repeat('x', 128);
    perform pg_temp.x_as(v_a);
    select result into v_r from public.register_offline_device(k128, 'production', true);
    if v_r <> 'accepted' then bad := bad || 'key128:' || v_r || ' '; end if;
    select result into v_r from public.register_offline_device(k129, 'production', true);
    if v_r <> 'offline.invalid_input' then bad := bad || 'key129:' || v_r || ' '; end if;
    select result into v_r from public.register_offline_device('-lead', 'production', true);
    if v_r <> 'offline.invalid_input' then bad := bad || 'lead-dash:' || v_r || ' '; end if;
    select result into v_r from public.register_offline_device('ключ', 'production', true);
    if v_r <> 'offline.invalid_input' then bad := bad || 'non-ascii:' || v_r || ' '; end if;
    select result into v_r from public.register_offline_device('', 'production', true);
    if v_r <> 'offline.invalid_input' then bad := bad || 'empty:' || v_r || ' '; end if;
    select result into v_r from public.register_offline_device(null, 'production', true);
    if v_r <> 'offline.invalid_input' then bad := bad || 'null-key:' || v_r || ' '; end if;
    select result into v_r from public.register_offline_device('r6-key', 'staging', true);
    if v_r <> 'offline.invalid_input' then bad := bad || 'staging:' || v_r || ' '; end if;
    select result into v_r from public.register_offline_device('r6-key', 'production', null);
    if v_r <> 'offline.invalid_input' then bad := bad || 'null-attested:' || v_r || ' '; end if;
    select result into v_r from public.register_offline_device('r6-key', 'production', false);
    if v_r <> 'accepted' then bad := bad || 'unattested-register:' || v_r || ' '; end if;
    select result into v_r from public.issue_offline_grant('r6-key', 2);
    if v_r <> 'offline.device_not_attested' then bad := bad || 'unattested-issue:' || v_r || ' '; end if;
    select result into v_r from public.register_offline_device('r6-key', 'development', true);
    if v_r <> 'offline.device_environment_mismatch' then bad := bad || 'env-switch:' || v_r || ' '; end if;
    select result into v_r from public.register_offline_device('r6-key', 'production', true);
    if v_r <> 'accepted' then bad := bad || 'attest-later:' || v_r || ' '; end if;
    select result into v_r from public.issue_offline_grant('r6-key', -1);
    if v_r <> 'offline.invalid_input' then bad := bad || 'tickets-1:' || v_r || ' '; end if;
    select result into v_r from public.issue_offline_grant('r6-key', 3);
    if v_r <> 'offline.invalid_input' then bad := bad || 'tickets3:' || v_r || ' '; end if;
    select result into v_r from public.issue_offline_grant('r6-key', null);
    if v_r <> 'offline.invalid_input' then bad := bad || 'tickets-null:' || v_r || ' '; end if;
    select result into v_r from public.issue_offline_grant('r6-key', 0);
    if v_r <> 'offline.invalid_input' then bad := bad || 'tickets0-empty:' || v_r || ' '; end if;
    select result into v_r from public.issue_offline_grant('r6-unknown', 1);
    if v_r <> 'offline.device_not_registered' then bad := bad || 'unknown-device:' || v_r || ' '; end if;
    select * into g from public.issue_offline_grant('r6-key', 2);
    if g.result <> 'accepted' or array_length(g.ticket_ids, 1) <> 2 then bad := bad || 'tickets2:' || g.result || ' '; end if;
    if g.expires_at <> g.issued_at + interval '7 days' or g.entitlement_expires_at is not null then
      bad := bad || 'free-window:' || (g.expires_at - g.issued_at)::text || ' ';
    end if;
    select * into g from public.issue_offline_grant('r6-key', 0);
    if g.result <> 'accepted' or array_length(g.ticket_ids, 1) <> 2 then bad := bad || 'tickets0-outstanding:' || g.result || ' '; end if;
    v_r := public.consume_offline_ticket(null, gen_random_uuid());
    if v_r <> 'offline.invalid_input' then bad := bad || 'consume-null-ticket:' || v_r || ' '; end if;
    v_r := public.consume_offline_ticket(g.ticket_ids[1], null);
    if v_r <> 'offline.invalid_input' then bad := bad || 'consume-null-shot:' || v_r || ' '; end if;
    v_r := public.consume_offline_ticket(gen_random_uuid(), gen_random_uuid());
    if v_r <> 'offline.ticket_not_found' then bad := bad || 'consume-unknown:' || v_r || ' '; end if;
    v_r := public.release_offline_ticket(g.ticket_ids[1], 'support_review');
    if v_r <> 'offline.invalid_input' then bad := bad || 'self-support-review:' || v_r || ' '; end if;
    v_r := public.release_offline_ticket(g.ticket_ids[1], null);
    if v_r <> 'offline.invalid_input' then bad := bad || 'release-null-reason:' || v_r || ' '; end if;
    v_r := public.release_offline_ticket(g.ticket_ids[1], 'anything');
    if v_r <> 'offline.invalid_input' then bad := bad || 'release-bad-reason:' || v_r || ' '; end if;
    perform pg_temp.x_owner();

    -- Pro lease bounds.
    v_pro := pg_temp.x_user(109, 'apple', 'apple-sub-r6pro');
    insert into public.billing_entitlements (user_id, premium, expires_at) values (v_pro, true, now() + interval '1 minute');
    perform pg_temp.x_as(v_pro);
    select * into g from public.register_offline_device('r6-pro', 'production', true);
    select * into g from public.issue_offline_grant('r6-pro', 0);
    if g.result <> 'accepted' or g.entitlement_source <> 'verified_store' or g.expires_at <> g.entitlement_expires_at
       or g.expires_at > g.issued_at + interval '1 minute' or coalesce(array_length(g.ticket_ids, 1), 0) <> 0 then
      bad := bad || format('pro-1min: %s src=%s lease=%s ', g.result, g.entitlement_source, g.expires_at - g.issued_at);
    end if;
    perform pg_temp.x_owner();
    update public.billing_entitlements set expires_at = now() + interval '100 years' where user_id = v_pro;
    perform pg_temp.x_as(v_pro);
    select * into g from public.issue_offline_grant('r6-pro', 2);
    if g.result <> 'accepted' or g.expires_at <> g.issued_at + interval '7 days' or g.entitlement_expires_at <= g.expires_at
       or coalesce(array_length(g.ticket_ids, 1), 0) <> 0 then
      bad := bad || format('pro-100y: %s lease=%s tickets=%s ', g.result, g.expires_at - g.issued_at, coalesce(array_length(g.ticket_ids, 1), 0));
    end if;
    perform pg_temp.x_owner();
    update public.billing_entitlements set expires_at = null where user_id = v_pro;
    perform pg_temp.x_as(v_pro);
    select * into g from public.issue_offline_grant('r6-pro', 2);
    if g.result <> 'accepted' or g.expires_at <> g.issued_at + interval '7 days' or g.entitlement_expires_at is not null then
      bad := bad || format('pro-lifetime: %s lease=%s ', g.result, g.expires_at - g.issued_at);
    end if;
    perform pg_temp.x_owner();
    update public.billing_entitlements set premium = true, expires_at = now() - interval '1 second' where user_id = v_pro;
    perform pg_temp.x_as(v_pro);
    select * into g from public.issue_offline_grant('r6-pro', 2);
    if g.result <> 'accepted' or g.entitlement_source <> 'identity_lifetime_free' or array_length(g.ticket_ids, 1) <> 2 then
      bad := bad || format('expired-premium: %s src=%s ', g.result, g.entitlement_source);
    end if;
    perform pg_temp.x_owner();
    update public.billing_entitlements set premium = false, expires_at = now() + interval '30 days' where user_id = v_pro;
    perform pg_temp.x_as(v_pro);
    select * into g from public.issue_offline_grant('r6-pro', 2);
    if g.result <> 'accepted' or g.entitlement_source <> 'identity_lifetime_free' then
      bad := bad || format('premium-false-future-expiry: %s src=%s ', g.result, g.entitlement_source);
    end if;
    perform pg_temp.x_owner();
    -- Every grant row ever written obeys the lease bound.
    if exists (select 1 from public.offline_grants where expires_at > issued_at + interval '7 days'
               or (entitlement_expires_at is not null and expires_at > entitlement_expires_at)) then
      bad := bad || 'grant-row-out-of-bounds ';
    end if;
    if bad <> '' then raise exception 'R6 BREAK: %', bad; end if;
    perform pg_temp.x_ok('every boundary input refused or bounded; leases ≤ 7 d and ≤ entitlement expiry');
  exception when others then
    if sqlerrm like 'ATTACK_OK:%' then perform pg_temp.x_record('R6 boundary-inputs', 'HELD', substr(sqlerrm, 11));
    else perform pg_temp.x_record('R6 boundary-inputs', 'BROKEN', sqlerrm); end if;
  end;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- R7  Session gate on all four RPCs: authenticated without the API header;
--     with the header but no session claim; a revoked session (row gone —
--     /v1/auth/logout); an expired session (not_after past); a banned user;
--     anon. Every one must raise 42501 (no result row, no write). Then a
--     stranger's ticket is not_found, not an error, to the legitimate caller
--     of another account. (service_role: R7b.)
-- ───────────────────────────────────────────────────────────────────────────
do $$
declare
  v_a uuid; v_s uuid; g record; v_r text; bad text := ''; v_ticket uuid; v_shot uuid := 'c0000000-0000-4000-8000-000000000701';
  v_calls text[] := array[
    'select result from public.register_offline_device(''r7-key'', ''production'', true)',
    'select result from public.issue_offline_grant(''r7-key'', 1)',
    'select public.consume_offline_ticket(''00000000-0000-4000-8000-000000000001'', ''00000000-0000-4000-8000-000000000002'')',
    'select public.release_offline_ticket(''00000000-0000-4000-8000-000000000001'', ''unused_ticket_returned'')'
  ];
  v_call text;
  procedure_denied boolean;
begin
  begin
    v_a := pg_temp.x_user(110, 'google', 'google-sub-r7');
    v_s := pg_temp.x_user(111, 'apple', 'apple-sub-r7s');
    perform pg_temp.x_as(v_s);
    select * into g from public.register_offline_device('r7-stranger', 'production', true);
    select * into g from public.issue_offline_grant('r7-stranger', 1);
    v_ticket := g.ticket_ids[1];
    perform pg_temp.x_owner();
    perform pg_temp.x_shot(v_a, v_shot);

    foreach v_call in array v_calls loop
      -- no API header
      perform pg_temp.x_as(v_a);
      perform set_config('request.headers', '', true);
      begin execute v_call; procedure_denied := false; exception when others then procedure_denied := (sqlstate = '42501'); end;
      if not procedure_denied then bad := bad || 'no-header:' || split_part(v_call, '(', 1) || ' '; end if;
      -- no session claim
      perform pg_temp.x_as(v_a);
      perform set_config('request.jwt.claims', '', true);
      begin execute v_call; procedure_denied := false; exception when others then procedure_denied := (sqlstate = '42501'); end;
      if not procedure_denied then bad := bad || 'no-session-claim:' || split_part(v_call, '(', 1) || ' '; end if;
      -- anon
      perform pg_temp.x_as(v_a);
      perform set_config('role', 'anon', true);
      begin execute v_call; procedure_denied := false; exception when others then procedure_denied := (sqlstate = '42501'); end;
      if not procedure_denied then bad := bad || 'anon:' || split_part(v_call, '(', 1) || ' '; end if;
      perform pg_temp.x_owner();
    end loop;

    -- expired session
    update auth.sessions set not_after = now() - interval '1 second' where user_id = v_a;
    perform pg_temp.x_as(v_a);
    begin select result into v_r from public.issue_offline_grant('r7-key', 1); procedure_denied := false;
    exception when others then procedure_denied := (sqlstate = '42501'); end;
    if not procedure_denied then bad := bad || 'expired-session ' ; end if;
    perform pg_temp.x_owner();
    update auth.sessions set not_after = null where user_id = v_a;
    -- banned user
    update auth.users set banned_until = now() + interval '1 day' where id = v_a;
    perform pg_temp.x_as(v_a);
    begin select result into v_r from public.register_offline_device('r7-key', 'production', true); procedure_denied := false;
    exception when others then procedure_denied := (sqlstate = '42501'); end;
    if not procedure_denied then bad := bad || 'banned-user '; end if;
    perform pg_temp.x_owner();
    update auth.users set banned_until = null where id = v_a;
    -- revoked session (logout)
    delete from auth.sessions where user_id = v_a;
    perform pg_temp.x_as(v_a);
    begin select result into v_r from public.register_offline_device('r7-key', 'production', true); procedure_denied := false;
    exception when others then procedure_denied := (sqlstate = '42501'); end;
    if not procedure_denied then bad := bad || 'revoked-session '; end if;
    perform pg_temp.x_owner();
    insert into auth.sessions (id, user_id) select session_id, user_id from x_sessions where user_id = v_a;

    -- Legit caller, stranger's ticket, own delivered shot.
    perform pg_temp.x_as(v_a);
    v_r := public.consume_offline_ticket(v_ticket, v_shot);
    if v_r <> 'offline.ticket_not_found' then bad := bad || 'stranger-consume:' || v_r || ' '; end if;
    v_r := public.release_offline_ticket(v_ticket, 'unused_ticket_returned');
    if v_r <> 'offline.ticket_not_found' then bad := bad || 'stranger-release:' || v_r || ' '; end if;
    perform pg_temp.x_owner();
    if pg_temp.x_events(v_s) <> 'allocated:1' then bad := bad || 'stranger-ledger:' || pg_temp.x_events(v_s) || ' '; end if;
    if exists (select 1 from public.offline_devices where user_id = v_a) then bad := bad || 'device-row-written-through-denied-call '; end if;
    if bad <> '' then raise exception 'R7 BREAK: %', bad; end if;
    perform pg_temp.x_ok('every RPC denies non-live sessions and anon; strangers'' tickets are not_found');
  exception when others then
    if sqlerrm like 'ATTACK_OK:%' then perform pg_temp.x_record('R7 session-gate', 'HELD', substr(sqlerrm, 11));
    else perform pg_temp.x_record('R7 session-gate', 'BROKEN', sqlerrm); end if;
  end;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- R7b service_role on the four RPCs. api_private.is_active_session() is
--     revoked from service_role (20260905190106) so a service connection can
--     never pass as a user; the repo's other definer RPCs also revoke EXECUTE
--     from service_role. The four new RPCs are SECURITY DEFINER and keep the
--     hosted default EXECUTE for service_role, so the gate runs as the owner:
--     a service_role connection carrying a user sub + session claim must
--     still be refused (42501) and must write nothing.
-- ───────────────────────────────────────────────────────────────────────────
do $$
declare
  v_a uuid; bad text := ''; v_r text; g record;
begin
  begin
    v_a := pg_temp.x_user(119, 'google', 'google-sub-r7b');
    perform pg_temp.x_as(v_a);
    perform set_config('role', 'service_role', true);
    begin
      select * into g from public.register_offline_device('r7b-key', 'production', true);
      bad := bad || 'register:' || g.result || ' ';
    exception when others then if sqlstate <> '42501' then bad := bad || 'register-sqlstate:' || sqlstate || ' '; end if; end;
    begin
      select * into g from public.issue_offline_grant('r7b-key', 2);
      bad := bad || format('issue:%s tickets=%s ', g.result, coalesce(array_length(g.ticket_ids, 1), 0));
    exception when others then if sqlstate <> '42501' then bad := bad || 'issue-sqlstate:' || sqlstate || ' '; end if; end;
    begin
      v_r := public.release_offline_ticket(g.ticket_ids[1], 'unused_ticket_returned');
      bad := bad || 'release:' || v_r || ' ';
    exception when others then if sqlstate <> '42501' then bad := bad || 'release-sqlstate:' || sqlstate || ' '; end if; end;
    perform pg_temp.x_owner();
    if exists (select 1 from public.offline_devices where user_id = v_a) then bad := bad || 'device-row-written '; end if;
    if pg_temp.x_events(v_a) <> '' then bad := bad || 'ledger:' || pg_temp.x_events(v_a) || ' '; end if;
    if bad <> '' then raise exception 'R7b BREAK: %', bad; end if;
    perform pg_temp.x_ok('service_role cannot act as a user through the definer RPCs');
  exception when others then
    if sqlerrm like 'ATTACK_OK:%' then perform pg_temp.x_record('R7b service-role-definer-path', 'HELD', substr(sqlerrm, 11));
    else perform pg_temp.x_record('R7b service-role-definer-path', 'BROKEN', sqlerrm); end if;
  end;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- R8  Corrupt / partial owner-side ledger writes (a support tool or a
--     migration with a bug): consumed after released; released after
--     consumed; consumed with a permit-backed shot; consumed with another
--     account's shot; two tickets on one shot; allocation for a device of
--     another user; allocation naming a different installation than its
--     device; update/delete/truncate by owner and service_role. All refused.
-- ───────────────────────────────────────────────────────────────────────────
do $$
declare
  v_a uuid; v_o uuid; g record; p record; bad text := ''; t1 uuid; t2 uuid; v_dev uuid; v_grant uuid; v_r text;
  s_off uuid := 'c0000000-0000-4000-8000-000000000801';
  s_off2 uuid := 'c0000000-0000-4000-8000-000000000802';
  s_online uuid := 'c0000000-0000-4000-8000-000000000803';
  s_other uuid := 'c0000000-0000-4000-8000-000000000804';
  procedure_refused boolean;
begin
  begin
    v_a := pg_temp.x_user(112, 'google', 'google-sub-r8');
    v_o := pg_temp.x_user(113, 'apple', 'apple-sub-r8o');
    perform pg_temp.x_as(v_a);
    select * into g from public.register_offline_device('r8-key', 'production', true);
    v_dev := g.device_id;
    select * into g from public.issue_offline_grant('r8-key', 2);
    t1 := g.ticket_ids[1]; t2 := g.ticket_ids[2]; v_grant := g.grant_id;
    perform pg_temp.x_owner();
    perform pg_temp.x_shot(v_a, s_off);
    perform pg_temp.x_shot(v_a, s_off2);
    perform pg_temp.x_shot(v_o, s_other);
    -- an online, permit-backed shot of A (permit owned by owner path)
    insert into public.analysis_permits (user_id, idempotency_key) values (v_a, 'r8-online') returning id into v_r;
    insert into public.shots (
      id, user_id, shot_type, captured_at, start_ms, end_ms, overall_score, analysis_confidence, result_kind, analysis_permit_id,
      app_version, model_bundle_version, pose_model_version, paddle_model_version,
      stroke_detector_version, phase_model_version, scoring_model_version, shot_config_version
    ) values (s_online, v_a, 'drive', now(), 0, 1000, 7, 1, 'scored', v_r::uuid, 'v1', 'v1', 'v1', 'v1', 'v1', 'v1', 'v1', 'v1');

    -- t1: released, then a consumed row
    insert into public.offline_allocation_ledger (user_id, device_id, grant_id, generation, ticket_id, event, reason)
    values (v_a, v_dev, v_grant, 1, t1, 'released', 'support_review');
    begin
      insert into public.offline_allocation_ledger (user_id, device_id, grant_id, generation, ticket_id, event, shot_id)
      values (v_a, v_dev, v_grant, 1, t1, 'consumed', s_off);
      bad := bad || 'consumed-after-released ';
    exception when check_violation or unique_violation then null; end;
    -- t2: permit-backed shot
    begin
      insert into public.offline_allocation_ledger (user_id, device_id, grant_id, generation, ticket_id, event, shot_id)
      values (v_a, v_dev, v_grant, 1, t2, 'consumed', s_online);
      bad := bad || 'consumed-permit-backed ';
    exception when check_violation then null; end;
    -- t2: another account's shot
    begin
      insert into public.offline_allocation_ledger (user_id, device_id, grant_id, generation, ticket_id, event, shot_id)
      values (v_a, v_dev, v_grant, 1, t2, 'consumed', s_other);
      bad := bad || 'consumed-foreign-shot ';
    exception when check_violation then null; end;
    -- t2: owner-of-record is another account
    begin
      insert into public.offline_allocation_ledger (user_id, device_id, grant_id, generation, ticket_id, event, shot_id)
      values (v_o, v_dev, v_grant, 1, t2, 'consumed', s_other);
      bad := bad || 'consumed-by-other-owner ';
    exception when check_violation then null; end;
    -- t2 consumed legitimately, then released
    insert into public.offline_allocation_ledger (user_id, device_id, grant_id, generation, ticket_id, event, shot_id)
    values (v_a, v_dev, v_grant, 1, t2, 'consumed', s_off);
    begin
      insert into public.offline_allocation_ledger (user_id, device_id, grant_id, generation, ticket_id, event, reason)
      values (v_a, v_dev, v_grant, 1, t2, 'released', 'support_review');
      bad := bad || 'released-after-consumed ';
    exception when check_violation or unique_violation then null; end;
    -- a third allocation for the same shot: new ticket then consume with s_off again
    begin
      insert into public.offline_allocation_ledger (user_id, device_id, grant_id, generation, ticket_id, event)
      values (v_a, v_dev, v_grant, 1, 'd0000000-0000-4000-8000-000000000801', 'allocated');
      insert into public.offline_allocation_ledger (user_id, device_id, grant_id, generation, ticket_id, event, shot_id)
      values (v_a, v_dev, v_grant, 1, 'd0000000-0000-4000-8000-000000000801', 'consumed', s_off);
      bad := bad || 'two-tickets-one-shot ';
    exception when check_violation or unique_violation then null; end;
    -- allocation for a device row of another user
    begin
      insert into public.offline_allocation_ledger (user_id, device_id, grant_id, generation, ticket_id, event)
      values (v_o, v_dev, v_grant, 1, 'd0000000-0000-4000-8000-000000000802', 'allocated');
      bad := bad || 'allocated-foreign-device ';
    exception when check_violation then null; end;
    -- allocation naming another installation than its device
    begin
      insert into public.offline_allocation_ledger (user_id, device_id, grant_id, generation, ticket_id, event, installation_key_id)
      values (v_a, v_dev, v_grant, 1, 'd0000000-0000-4000-8000-000000000803', 'allocated', 'not-r8-key');
      bad := bad || 'allocated-wrong-installation ';
    exception when check_violation then null; end;
    -- terminal event on a never-allocated ticket
    begin
      insert into public.offline_allocation_ledger (user_id, device_id, grant_id, generation, ticket_id, event, reason)
      values (v_a, v_dev, v_grant, 1, 'd0000000-0000-4000-8000-000000000804', 'released', 'support_review');
      bad := bad || 'released-unallocated ';
    exception when check_violation then null; end;
    -- owner update / delete
    begin update public.offline_allocation_ledger set event = 'released' where ticket_id = t2 and event = 'consumed'; bad := bad || 'owner-update ';
    exception when others then null; end;
    begin delete from public.offline_allocation_ledger where ticket_id = t1; bad := bad || 'owner-delete ';
    exception when others then null; end;
    -- service_role delete / truncate / update
    perform set_config('role', 'service_role', true);
    begin delete from public.offline_allocation_ledger where ticket_id = t1; bad := bad || 'service-delete ';
    exception when others then null; end;
    begin execute 'truncate public.offline_allocation_ledger'; bad := bad || 'service-truncate ';
    exception when others then null; end;
    begin update public.offline_allocation_ledger set reason = 'unused_ticket_returned' where ticket_id = t1; bad := bad || 'service-update ';
    exception when others then null; end;
    begin insert into public.offline_allocation_ledger (user_id, device_id, grant_id, generation, ticket_id, event)
      values (v_a, v_dev, v_grant, 1, 'd0000000-0000-4000-8000-000000000805', 'allocated'); bad := bad || 'service-insert ';
    exception when others then null; end;
    perform pg_temp.x_owner();
    if pg_temp.x_events(v_a) <> 'allocated:2,consumed:1,released:1' then bad := bad || 'ledger:' || pg_temp.x_events(v_a) || ' '; end if;
    -- The caller's view after the corruption attempts: 1 consumed + 1 released
    -- → scored 1 (the delivered shot) + held 1 (released still counts).
    perform pg_temp.x_as(v_a);
    select * into p from public.reserve_analysis_permit('r8-online-2');
    perform pg_temp.x_owner();
    if p.result <> 'access.paywall_required' then bad := bad || 'reserve-after-release:' || p.result || ' '; end if;
    if bad <> '' then raise exception 'R8 BREAK: %', bad; end if;
    perform pg_temp.x_ok('every corrupt owner/service write refused; ledger state exact');
  exception when others then
    if sqlerrm like 'ATTACK_OK:%' then perform pg_temp.x_record('R8 corrupt-owner-writes', 'HELD', substr(sqlerrm, 11));
    else perform pg_temp.x_record('R8 corrupt-owner-writes', 'BROKEN', sqlerrm); end if;
  end;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- R9  Entitlement revoked under a live Pro lease (refund / chargeback via the
--     RevenueCat webhook sets premium=false or moves expires_at into the
--     past). The invariant "Pro lease ≤ verified entitlement expiry" is
--     asserted at issue time by a CHECK constraint; after revocation the
--     caller must not receive a NEW verified_store lease, and every lease row
--     must still satisfy the constraint (the DB re-checks nothing, so this
--     pins that at least re-issue falls back to the free path and the free
--     path does not exceed 2).
-- ───────────────────────────────────────────────────────────────────────────
do $$
declare
  v_a uuid; g record; g2 record; bad text := '';
begin
  begin
    v_a := pg_temp.x_user(114, 'google', 'google-sub-r9');
    insert into public.billing_entitlements (user_id, premium, expires_at) values (v_a, true, now() + interval '30 days');
    perform pg_temp.x_as(v_a);
    select * into g from public.register_offline_device('r9-key', 'production', true);
    select * into g from public.issue_offline_grant('r9-key', 0);
    if g.result <> 'accepted' or g.entitlement_source <> 'verified_store' then raise exception 'R9 setup: % %', g.result, g.entitlement_source; end if;
    perform pg_temp.x_owner();
    -- refund: entitlement ends now
    update public.billing_entitlements set expires_at = now() - interval '1 second' where user_id = v_a;
    perform pg_temp.x_as(v_a);
    select * into g2 from public.issue_offline_grant('r9-key', 2);
    perform pg_temp.x_owner();
    if g2.result <> 'accepted' or g2.entitlement_source <> 'identity_lifetime_free' or array_length(g2.ticket_ids, 1) <> 2 then
      bad := bad || format('post-refund reissue: %s src=%s ', g2.result, g2.entitlement_source);
    end if;
    if g2.generation <> g.generation + 1 then bad := bad || format('generation %s→%s ', g.generation, g2.generation); end if;
    if exists (select 1 from public.offline_grants where user_id = v_a and entitlement_source = 'verified_store'
               and issued_at > g.issued_at) then bad := bad || 'new-pro-lease-after-refund '; end if;
    if bad <> '' then raise exception 'R9 BREAK: %', bad; end if;
    perform pg_temp.x_ok(format('no new Pro lease after refund; free path bounded; the pre-refund lease keeps expires_at=%s (≤ 7 d, never revoked by the DB)', g.expires_at - g.issued_at));
  exception when others then
    if sqlerrm like 'ATTACK_OK:%' then perform pg_temp.x_record('R9 entitlement-revoked-under-lease', 'HELD', substr(sqlerrm, 11));
    else perform pg_temp.x_record('R9 entitlement-revoked-under-lease', 'BROKEN', sqlerrm); end if;
  end;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- R10 Replay storm: the same device re-requests its grant 40 times (retry
--     loop after network failures / 5xx / 429). The ticket set must be
--     identical every time, the ledger must hold exactly 2 allocations, and
--     the identity's budget must not move. Also records how many grant rows
--     the storm leaves (unbounded generations are a P3 storage concern, not
--     a conservation break).
-- ───────────────────────────────────────────────────────────────────────────
do $$
declare
  v_a uuid; g record; first_ids uuid[]; bad text := ''; i int; rec record; v_rows int;
begin
  begin
    v_a := pg_temp.x_user(115, 'apple', 'apple-sub-r10');
    perform pg_temp.x_as(v_a);
    select * into g from public.register_offline_device('r10-key', 'production', true);
    select * into g from public.issue_offline_grant('r10-key', 2);
    first_ids := g.ticket_ids;
    for i in 1..40 loop
      select * into g from public.register_offline_device('r10-key', 'production', true);
      select * into g from public.issue_offline_grant('r10-key', 2);
      if g.result <> 'accepted' or g.ticket_ids <> first_ids then bad := bad || format('replay %s: %s ', i, g.result); exit; end if;
    end loop;
    select * into rec from public.access_state();
    perform pg_temp.x_owner();
    select count(*) into v_rows from public.offline_grants where user_id = v_a;
    if pg_temp.x_events(v_a) <> 'allocated:2' then bad := bad || 'ledger:' || pg_temp.x_events(v_a) || ' '; end if;
    if rec.scored_count <> 0 or rec.reserved_count <> 2 then bad := bad || format('access scored=%s reserved=%s ', rec.scored_count, rec.reserved_count); end if;
    if (select count(*) from public.offline_devices where user_id = v_a) <> 1 then bad := bad || 'device-rows '; end if;
    if bad <> '' then raise exception 'R10 BREAK: %', bad; end if;
    perform pg_temp.x_ok(format('41 issues → same 2 tickets, ledger allocated:2, %s grant rows (one per call)', v_rows));
  exception when others then
    if sqlerrm like 'ATTACK_OK:%' then perform pg_temp.x_record('R10 replay-storm', 'HELD', substr(sqlerrm, 11));
    else perform pg_temp.x_record('R10 replay-storm', 'BROKEN', sqlerrm); end if;
  end;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- R11 Crash between delivery and binding. The offline result is durably
--     delivered (owner write, no permit) and the device dies before
--     consume_offline_ticket(). Until it retries, the identity is charged
--     twice (scored 1 + held 1). Pins the recovery: the retry binds, the
--     double charge disappears, a second offline result then has exactly one
--     rating left, and nothing was reclaimed automatically in between.
-- ───────────────────────────────────────────────────────────────────────────
do $$
declare
  v_a uuid; g record; p record; rec record; v_r text; bad text := '';
  s1 uuid := 'c0000000-0000-4000-8000-000000001101';
begin
  begin
    v_a := pg_temp.x_user(116, 'google', 'google-sub-r11');
    perform pg_temp.x_as(v_a);
    select * into g from public.register_offline_device('r11-key', 'production', true);
    select * into g from public.issue_offline_grant('r11-key', 1);
    perform pg_temp.x_owner();
    perform pg_temp.x_shot(v_a, s1);
    perform pg_temp.x_as(v_a);
    select * into rec from public.access_state();
    if rec.scored_count + rec.reserved_count <> 2 then bad := bad || format('pre-bind scored=%s reserved=%s ', rec.scored_count, rec.reserved_count); end if;
    select * into p from public.reserve_analysis_permit('r11-online-window');
    if p.result <> 'access.paywall_required' then bad := bad || 'window-online:' || p.result || ' '; end if;
    -- restart: the device re-issues (same ticket back) and binds
    select * into g from public.issue_offline_grant('r11-key', 1);
    if g.result <> 'accepted' or array_length(g.ticket_ids, 1) <> 1 then bad := bad || 'reissue:' || g.result || ' '; end if;
    v_r := public.consume_offline_ticket(g.ticket_ids[1], s1);
    if v_r <> 'accepted' then bad := bad || 'bind:' || v_r || ' '; end if;
    v_r := public.consume_offline_ticket(g.ticket_ids[1], s1);
    if v_r <> 'accepted' then bad := bad || 'bind-replay:' || v_r || ' '; end if;
    select * into rec from public.access_state();
    if rec.scored_count <> 1 or rec.reserved_count <> 0 then bad := bad || format('post-bind scored=%s reserved=%s ', rec.scored_count, rec.reserved_count); end if;
    select * into p from public.reserve_analysis_permit('r11-online-2');
    if p.result <> 'accepted' then bad := bad || 'second-rating-online:' || p.result || ' '; end if;
    select * into p from public.reserve_analysis_permit('r11-online-3');
    if p.result <> 'access.paywall_required' then bad := bad || 'third-rating:' || p.result || ' '; end if;
    perform pg_temp.x_owner();
    if pg_temp.x_events(v_a) <> 'allocated:1,consumed:1' then bad := bad || 'ledger:' || pg_temp.x_events(v_a) || ' '; end if;
    if bad <> '' then raise exception 'R11 BREAK: %', bad; end if;
    perform pg_temp.x_ok('delivered-then-crashed result binds on retry; exactly 2 ratings end to end');
  exception when others then
    if sqlerrm like 'ATTACK_OK:%' then perform pg_temp.x_record('R11 crash-between-delivery-and-bind', 'HELD', substr(sqlerrm, 11));
    else perform pg_temp.x_record('R11 crash-between-delivery-and-bind', 'BROKEN', sqlerrm); end if;
  end;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- R12 Client reads of the new tables. A live API caller may read only its
--     own rows; a re-created account (same identity, new uid) is charged for
--     the surviving allocation but cannot see it — asserted as the documented
--     limit (issue_offline_grant returns the ticket ids instead). Without the
--     API header nothing is readable. anon/service_role: no rows.
-- ───────────────────────────────────────────────────────────────────────────
do $$
declare
  v_a uuid; v_o uuid; g record; bad text := ''; n int;
begin
  begin
    v_a := pg_temp.x_user(117, 'google', 'google-sub-r12');
    v_o := pg_temp.x_user(118, 'apple', 'apple-sub-r12o');
    perform pg_temp.x_as(v_o);
    select * into g from public.register_offline_device('r12-o', 'production', true);
    select * into g from public.issue_offline_grant('r12-o', 2);
    perform pg_temp.x_as(v_a);
    select * into g from public.register_offline_device('r12-a', 'production', true);
    select * into g from public.issue_offline_grant('r12-a', 1);
    select count(*) into n from public.offline_devices; if n <> 1 then bad := bad || format('devices visible=%s ', n); end if;
    select count(*) into n from public.offline_grants; if n <> 1 then bad := bad || format('grants visible=%s ', n); end if;
    select count(*) into n from public.offline_allocation_ledger; if n <> 1 then bad := bad || format('ledger visible=%s ', n); end if;
    perform set_config('request.headers', '', true);
    select count(*) into n from public.offline_allocation_ledger; if n <> 0 then bad := bad || format('ledger-no-header=%s ', n); end if;
    select count(*) into n from public.offline_devices; if n <> 0 then bad := bad || format('devices-no-header=%s ', n); end if;
    perform pg_temp.x_as(v_a);
    perform set_config('role', 'anon', true);
    begin select count(*) into n from public.offline_allocation_ledger; if n <> 0 then bad := bad || format('anon-ledger=%s ', n); end if;
    exception when insufficient_privilege then null; end;
    perform pg_temp.x_as(v_a);
    perform set_config('role', 'service_role', true);
    begin select count(*) into n from public.offline_allocation_ledger; if n <> 0 then bad := bad || format('service-ledger=%s ', n); end if;
    exception when insufficient_privilege then null; end;
    begin select count(*) into n from public.offline_grants; if n <> 0 then bad := bad || format('service-grants=%s ', n); end if;
    exception when insufficient_privilege then null; end;
    perform pg_temp.x_owner();
    if bad <> '' then raise exception 'R12 BREAK: %', bad; end if;
    perform pg_temp.x_ok('own rows only, API header required, anon/service_role read nothing');
  exception when others then
    if sqlerrm like 'ATTACK_OK:%' then perform pg_temp.x_record('R12 client-reads', 'HELD', substr(sqlerrm, 11));
    else perform pg_temp.x_record('R12 client-reads', 'BROKEN', sqlerrm); end if;
  end;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- Verdict
-- ───────────────────────────────────────────────────────────────────────────
select attack, verdict, detail from x_results order by n;
select count(*) filter (where verdict = 'HELD') as held,
       count(*) filter (where verdict = 'BROKEN') as broken,
       count(*) as executed
from x_results;
do $$
declare v_broken int; v_total int;
begin
  select count(*) filter (where verdict = 'BROKEN'), count(*) into v_broken, v_total from x_results;
  if v_total < 13 then
    raise exception 'W04-01 r2 attack matrix: only % attacks executed', v_total;
  end if;
  if v_broken > 0 then
    raise exception 'W04-01 r2 attack matrix: % of % attacks BROKE the candidate', v_broken, v_total;
  end if;
end $$;
rollback;
