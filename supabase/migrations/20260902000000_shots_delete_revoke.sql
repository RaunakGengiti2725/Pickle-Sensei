-- ============================================================================
-- Pickle Sensei — shots are immutable from a client session, deletes included.
--
-- The lifetime free-rating limit is derived from the count of a user's scored
-- shots (access_state(), reserve_analysis_permit(), apply_synced_shot()), so
-- the shots table must be append-only for the authenticated role: no client
-- route deletes shots, and the only legitimate removal is the account-deletion
-- cascade (auth.admin.deleteUser → profiles → shots), which runs as table
-- owner and is unaffected by client grants or policies.
--
-- Closes the last client write path on public.shots: the hosted default DELETE
-- grant plus the shots_delete_own policy from 20260829120000. UPDATE was
-- already revoked in 20260831160000. Idempotent-safe.
-- ============================================================================

revoke delete on public.shots from authenticated;
drop policy if exists "shots_delete_own" on public.shots;
