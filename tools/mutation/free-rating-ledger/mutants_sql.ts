/**
 * SQL mutants for the free-rating identity ledger migration
 * (supabase/migrations/20260902150000_free_rating_identity_ledger.sql).
 *
 * Every mutant is a list of exact-text substitutions applied to a SCRATCH copy
 * of the migration (the production file is never touched). Each `find` must
 * occur exactly once in the source; the runner refuses to build a mutant
 * otherwise, so a drift in the production file surfaces as a harness error,
 * never as a silently unmutated "survivor".
 *
 * `expect` documents what the author believed BEFORE running (equivalent
 * mutants are flagged so a survival is not mis-read as a test gap). The
 * runner records the ACTUAL verdict; expectations are never used to decide.
 */

export interface Edit {
  find: string;
  replace: string;
}

export interface SqlMutant {
  id: string;
  target:
    | "lifetime_scored_count"
    | "identity_scored_count"
    | "ledger_trigger"
    | "access_state"
    | "reserve_analysis_permit"
    | "apply_synced_shot"
    | "grants"
    | "backfill"
    | "concurrency";
  description: string;
  edits: Edit[];
  /** Author's prior. "equivalent" = behaviour-preserving under every path the
   * schema can reach; a survival is expected and is NOT a test gap. */
  expect: "killed" | "survive_gap" | "equivalent";
}

export const LEDGER_MIGRATION = "20260902150000_free_rating_identity_ledger.sql";

const LIFETIME_BODY = `  select greatest(
    (
      select count(*)::int from public.shots s
      where s.user_id = (select auth.uid()) and s.result_kind = 'scored'
    ),
    public.identity_scored_count()
  )`;

const IDENTITY_FN_HEAD = `create or replace function public.identity_scored_count()
returns integer
language sql
stable
security definer`;

const TRIGGER_FN_HEAD = `create or replace function public.record_scored_shot_in_ledger()
returns trigger
language plpgsql
security definer`;

const TRIGGER_CREATE = `create trigger shots_record_free_rating_ledger
  after insert or update of result_kind on public.shots
  for each row execute function public.record_scored_shot_in_ledger();`;

const BACKFILL = `insert into public.free_rating_ledger as led (identity_hash, scored_count)
select public.free_rating_identity_hash(i.provider, i.provider_id), c.scored
from (
  select s.user_id, count(*)::int as scored
  from public.shots s
  where s.result_kind = 'scored'
  group by s.user_id
) c
join auth.identities i on i.user_id = c.user_id
on conflict (identity_hash) do update
  set scored_count = greatest(led.scored_count, excluded.scored_count),
      updated_at = now();`;

const RESERVE_COUNTS = `    public.lifetime_scored_count(),
    (
      select count(*)::int from public.analysis_permits p
      where p.user_id = v_uid`;

const APPLY_BACKSTOP = `    if not v_premium and public.lifetime_scored_count() >= 2 then
      update public.analysis_permits
         set status = 'released', outcome = 'free_limit_exceeded'
       where id = v_permit_id and user_id = v_uid and status = 'reserved';
      return 'access.paywall_required';
    end if;`;

const APPLY_LOCK = `  perform pg_catalog.pg_advisory_xact_lock(public.access_lock_key(v_uid));

  -- Lock the permit so a concurrent retry of the same sync serializes here.`;

const RESERVE_LOCK = `  perform pg_catalog.pg_advisory_xact_lock(public.access_lock_key(v_uid));

  -- Re-check under the lock:`;

const LEDGER_REVOKE = `revoke all on public.free_rating_ledger from public, anon, authenticated;`;

const HASH_REVOKE = `revoke execute on function public.free_rating_identity_hash(text, text)
  from public, anon, authenticated;`;

const WRITER_REVOKE = `revoke execute on function public.record_scored_shot_in_ledger()
  from public, anon, authenticated;`;

export const SQL_MUTANTS: SqlMutant[] = [
  // ── lifetime_scored_count() ────────────────────────────────────────────────
  {
    id: "S01_lifetime_greatest_to_least",
    target: "lifetime_scored_count",
    description:
      "lifetime_scored_count() takes least() of own shots and identity ledger (a re-created account sees 0 again)",
    edits: [
      { find: LIFETIME_BODY, replace: LIFETIME_BODY.replace("select greatest(", "select least(") },
    ],
    expect: "killed",
  },
  {
    id: "S02_lifetime_drops_identity",
    target: "lifetime_scored_count",
    description:
      "lifetime_scored_count() = own scored shots only (identity ledger ignored — the original hole)",
    edits: [
      {
        find: LIFETIME_BODY,
        replace: `  select count(*)::int from public.shots s
  where s.user_id = (select auth.uid()) and s.result_kind = 'scored'`,
      },
    ],
    expect: "killed",
  },
  {
    id: "S03_lifetime_drops_shots_floor",
    target: "lifetime_scored_count",
    description: "lifetime_scored_count() = identity ledger only (account-local floor removed)",
    edits: [{ find: LIFETIME_BODY, replace: `  select public.identity_scored_count()` }],
    expect: "survive_gap",
  },
  {
    id: "S04_lifetime_counts_non_scored",
    target: "lifetime_scored_count",
    description:
      "lifetime_scored_count() counts result_kind <> 'scored' rows (abstentions) instead of scored",
    edits: [
      {
        find: "where s.user_id = (select auth.uid()) and s.result_kind = 'scored'",
        replace: "where s.user_id = (select auth.uid()) and s.result_kind <> 'scored'",
      },
    ],
    expect: "killed",
  },
  {
    id: "S05_lifetime_plus_one",
    target: "lifetime_scored_count",
    description:
      "lifetime_scored_count() off by one (+1): every account looks one rating more used",
    edits: [{ find: LIFETIME_BODY, replace: LIFETIME_BODY + " + 1" }],
    expect: "killed",
  },
  {
    id: "S06_lifetime_minus_one",
    target: "lifetime_scored_count",
    description: "lifetime_scored_count() off by one (-1, floored at 0): a third free rating leaks",
    edits: [{ find: LIFETIME_BODY, replace: `  select greatest(0, (${LIFETIME_BODY}) - 1)` }],
    expect: "killed",
  },
  {
    id: "S07_lifetime_grant_anon",
    target: "grants",
    description: "lifetime_scored_count() EXECUTE granted to anon",
    edits: [
      {
        find: "grant execute on function public.lifetime_scored_count() to authenticated;",
        replace: "grant execute on function public.lifetime_scored_count() to authenticated, anon;",
      },
    ],
    expect: "survive_gap",
  },

  // ── identity_scored_count() ───────────────────────────────────────────────
  {
    id: "S08_identity_max_to_min",
    target: "identity_scored_count",
    description: "identity_scored_count() uses min() across identities instead of max()",
    edits: [
      {
        find: "  select coalesce(max(l.scored_count), 0)::int\n  from auth.identities i",
        replace: "  select coalesce(min(l.scored_count), 0)::int\n  from auth.identities i",
      },
    ],
    expect: "survive_gap",
  },
  {
    id: "S09_identity_no_coalesce",
    target: "identity_scored_count",
    description: "identity_scored_count() returns NULL (not 0) when the caller has no ledger row",
    edits: [
      {
        find: "  select coalesce(max(l.scored_count), 0)::int\n  from auth.identities i",
        replace: "  select max(l.scored_count)::int\n  from auth.identities i",
      },
    ],
    expect: "equivalent",
  },
  {
    id: "S10_identity_unscoped",
    target: "identity_scored_count",
    description:
      "identity_scored_count() drops the auth.uid() scope: every caller sees the global ledger max",
    edits: [
      {
        find: "    on l.identity_hash = public.free_rating_identity_hash(i.provider, i.provider_id)\n  where i.user_id = (select auth.uid())\n$$;",
        replace:
          "    on l.identity_hash = public.free_rating_identity_hash(i.provider, i.provider_id)\n$$;",
      },
    ],
    expect: "killed",
  },
  {
    id: "S11_identity_security_invoker",
    target: "identity_scored_count",
    description:
      "identity_scored_count() is SECURITY INVOKER (clients cannot read auth.identities / the ledger)",
    edits: [
      {
        find: IDENTITY_FN_HEAD,
        replace: IDENTITY_FN_HEAD.replace("security definer", "security invoker"),
      },
    ],
    expect: "killed",
  },
  {
    id: "S12_identity_grant_anon",
    target: "grants",
    description: "identity_scored_count() EXECUTE granted to anon",
    edits: [
      {
        find: "grant execute on function public.identity_scored_count() to authenticated;",
        replace: "grant execute on function public.identity_scored_count() to authenticated, anon;",
      },
    ],
    expect: "survive_gap",
  },
  {
    id: "S13_identity_always_zero",
    target: "identity_scored_count",
    description: "identity_scored_count() always returns 0 (ledger never read)",
    edits: [
      {
        find: "  select coalesce(max(l.scored_count), 0)::int\n  from auth.identities i\n  join public.free_rating_ledger l\n    on l.identity_hash = public.free_rating_identity_hash(i.provider, i.provider_id)\n  where i.user_id = (select auth.uid())\n$$;",
        replace: "  select 0::int\n$$;",
      },
    ],
    expect: "killed",
  },

  // ── ledger writer trigger ─────────────────────────────────────────────────
  {
    id: "S14_trigger_scored_check_inverted",
    target: "ledger_trigger",
    description: "trigger records abstentions and skips scored shots",
    edits: [
      {
        find: "  if new.result_kind <> 'scored'\n     or (tg_op = 'UPDATE' and old.result_kind = 'scored') then",
        replace:
          "  if new.result_kind = 'scored'\n     or (tg_op = 'UPDATE' and old.result_kind = 'scored') then",
      },
    ],
    expect: "killed",
  },
  {
    id: "S15_trigger_no_increment",
    target: "ledger_trigger",
    description: "trigger writes identity max + 0 (ledger stuck at 0 for new identities)",
    edits: [
      {
        find: "  select coalesce(max(l.scored_count), 0) + 1 into v_next",
        replace: "  select coalesce(max(l.scored_count), 0) + 0 into v_next",
      },
      {
        find: "    set scored_count = greatest(led.scored_count + 1, excluded.scored_count),",
        replace: "    set scored_count = greatest(led.scored_count, excluded.scored_count),",
      },
    ],
    expect: "killed",
  },
  {
    id: "S16_trigger_conflict_no_plus_one",
    target: "ledger_trigger",
    description:
      "on-conflict branch uses greatest(led.scored_count, excluded) — drops the +1 floor",
    edits: [
      {
        find: "    set scored_count = greatest(led.scored_count + 1, excluded.scored_count),",
        replace: "    set scored_count = greatest(led.scored_count, excluded.scored_count),",
      },
    ],
    expect: "equivalent",
  },
  {
    id: "S17_trigger_insert_only",
    target: "ledger_trigger",
    description: "trigger fires on INSERT only (an UPDATE that turns a row scored is missed)",
    edits: [
      {
        find: TRIGGER_CREATE,
        replace: TRIGGER_CREATE.replace(
          "after insert or update of result_kind on public.shots",
          "after insert on public.shots",
        ),
      },
    ],
    expect: "survive_gap",
  },
  {
    id: "S18_trigger_missing",
    target: "ledger_trigger",
    description: "trigger shots_record_free_rating_ledger is never created (ledger never written)",
    edits: [{ find: TRIGGER_CREATE, replace: "" }],
    expect: "killed",
  },
  {
    id: "S19_trigger_security_invoker",
    target: "ledger_trigger",
    description:
      "ledger writer is SECURITY INVOKER: the authenticated caller cannot read auth.identities so every scored sync fails",
    edits: [
      {
        find: TRIGGER_FN_HEAD,
        replace: TRIGGER_FN_HEAD.replace("security definer", "security invoker"),
      },
    ],
    expect: "killed",
  },
  {
    id: "S20_trigger_next_unscoped",
    target: "ledger_trigger",
    description:
      "v_next computed from the GLOBAL ledger max (another user's history leaks into this identity)",
    edits: [
      {
        find: "  where i.user_id = new.user_id;\n\n  insert into public.free_rating_ledger as led",
        replace: "  ;\n\n  insert into public.free_rating_ledger as led",
      },
    ],
    expect: "killed",
  },
  {
    id: "S21_trigger_writes_all_identities",
    target: "ledger_trigger",
    description:
      "trigger writes v_next to EVERY identity in auth.identities, not only the shot owner's",
    edits: [
      {
        find: "  from auth.identities i\n  where i.user_id = new.user_id\n  on conflict (identity_hash) do update",
        replace: "  from auth.identities i\n  on conflict (identity_hash) do update",
      },
    ],
    expect: "killed",
  },
  {
    id: "S22_ledger_deleted_with_identity",
    target: "ledger_trigger",
    description:
      "a cleanup trigger deletes the ledger row when the auth.identities row is deleted (account deletion resets the count)",
    edits: [
      {
        find: WRITER_REVOKE,
        replace:
          WRITER_REVOKE +
          `

create or replace function public.mutant_drop_ledger_on_identity_delete()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.free_rating_ledger
   where identity_hash = public.free_rating_identity_hash(old.provider, old.provider_id);
  return old;
end;
$$;
create trigger mutant_drop_ledger_on_identity_delete
  after delete on auth.identities
  for each row execute function public.mutant_drop_ledger_on_identity_delete();`,
      },
    ],
    expect: "killed",
  },
  {
    id: "S23_trigger_decrements_on_shot_delete",
    target: "ledger_trigger",
    description:
      "trigger also listens to DELETE and decrements the ledger (deletion cascade resets the count)",
    edits: [
      {
        find: "  if new.result_kind <> 'scored'\n     or (tg_op = 'UPDATE' and old.result_kind = 'scored') then\n    return new;\n  end if;",
        replace: `  if tg_op = 'DELETE' then
    if old.result_kind = 'scored' then
      update public.free_rating_ledger led
         set scored_count = greatest(0, led.scored_count - 1), updated_at = now()
       where led.identity_hash in (
         select public.free_rating_identity_hash(i.provider, i.provider_id)
         from auth.identities i where i.user_id = old.user_id
       );
    end if;
    return old;
  end if;
  if new.result_kind <> 'scored'
     or (tg_op = 'UPDATE' and old.result_kind = 'scored') then
    return new;
  end if;`,
      },
      {
        find: TRIGGER_CREATE,
        replace: TRIGGER_CREATE.replace(
          "after insert or update of result_kind on public.shots",
          "after insert or delete or update of result_kind on public.shots",
        ),
      },
    ],
    expect: "killed",
  },

  // ── backfill ──────────────────────────────────────────────────────────────
  {
    id: "S24_backfill_removed",
    target: "backfill",
    description: "one-time backfill of pre-existing scored shots into the ledger removed",
    edits: [{ find: BACKFILL, replace: "" }],
    expect: "survive_gap",
  },
  {
    id: "S25_backfill_counts_all_kinds",
    target: "backfill",
    description: "backfill counts every shot (abstentions included), inflating inherited counts",
    edits: [
      {
        find: "  from public.shots s\n  where s.result_kind = 'scored'\n  group by s.user_id",
        replace: "  from public.shots s\n  group by s.user_id",
      },
    ],
    expect: "survive_gap",
  },

  // ── access_state() ────────────────────────────────────────────────────────
  {
    id: "S26_access_state_raw_count",
    target: "access_state",
    description: "access_state().scored_count reverts to the raw per-account shots count",
    edits: [
      {
        find: "    public.lifetime_scored_count() as scored_count,",
        replace:
          "    (select count(*)::int from public.shots s where s.user_id = (select auth.uid()) and s.result_kind = 'scored') as scored_count,",
      },
    ],
    expect: "killed",
  },
  {
    id: "S27_access_state_zero",
    target: "access_state",
    description: "access_state().scored_count is always 0",
    edits: [
      {
        find: "    public.lifetime_scored_count() as scored_count,",
        replace: "    0 as scored_count,",
      },
    ],
    expect: "killed",
  },
  {
    id: "S28_access_state_premium_default_true",
    target: "access_state",
    description: "access_state().premium defaults to TRUE when no billing row exists",
    edits: [
      {
        find: "      where b.user_id = (select auth.uid())\n    ), false) as premium,",
        replace: "      where b.user_id = (select auth.uid())\n    ), true) as premium,",
      },
    ],
    expect: "killed",
  },
  {
    id: "S29_access_state_ignores_expiry",
    target: "access_state",
    description: "access_state().premium ignores expires_at (lapsed entitlement still premium)",
    edits: [
      {
        find: "      select b.premium and (b.expires_at is null or b.expires_at > now())\n      from public.billing_entitlements b\n      where b.user_id = (select auth.uid())",
        replace:
          "      select b.premium\n      from public.billing_entitlements b\n      where b.user_id = (select auth.uid())",
      },
    ],
    expect: "survive_gap",
  },

  // ── reserve_analysis_permit() ─────────────────────────────────────────────
  {
    id: "S30_reserve_raw_count",
    target: "reserve_analysis_permit",
    description:
      "reserve_analysis_permit() counts raw per-account scored shots (identity ledger bypassed)",
    edits: [
      {
        find: RESERVE_COUNTS,
        replace: RESERVE_COUNTS.replace(
          "    public.lifetime_scored_count(),",
          "    (select count(*)::int from public.shots s where s.user_id = v_uid and s.result_kind = 'scored'),",
        ),
      },
    ],
    expect: "killed",
  },
  {
    id: "S31_reserve_limit_three",
    target: "reserve_analysis_permit",
    description: "reserve_analysis_permit() allows three lifetime free ratings",
    edits: [
      {
        find: "  v_remaining := 2 - least(v_scored, 2);",
        replace: "  v_remaining := 3 - least(v_scored, 3);",
      },
    ],
    expect: "killed",
  },
  {
    id: "S32_reserve_strict_lt",
    target: "reserve_analysis_permit",
    description:
      "reserve refuses only when remaining < reserved (one extra reservation slips through)",
    edits: [
      {
        find: "  if not v_premium and v_remaining <= v_reserved then",
        replace: "  if not v_premium and v_remaining < v_reserved then",
      },
    ],
    expect: "killed",
  },
  {
    id: "S33_reserve_ignores_premium",
    target: "reserve_analysis_permit",
    description: "reserve_analysis_permit() applies the free limit to premium accounts too",
    edits: [
      {
        find: "  if not v_premium and v_remaining <= v_reserved then",
        replace: "  if v_remaining <= v_reserved then",
      },
    ],
    expect: "killed",
  },
  {
    id: "S34_reserve_premium_default_true",
    target: "reserve_analysis_permit",
    description: "reserve_analysis_permit() treats accounts with no billing row as premium",
    edits: [
      {
        find: "      where b.user_id = v_uid\n    ), false),\n    public.lifetime_scored_count(),",
        replace:
          "      where b.user_id = v_uid\n    ), true),\n    public.lifetime_scored_count(),",
      },
    ],
    expect: "killed",
  },
  {
    id: "S35_reserve_ignores_reserved_permits",
    target: "reserve_analysis_permit",
    description: "reserve_analysis_permit() ignores currently reserved permits (v_reserved := 0)",
    edits: [
      {
        find: "  v_remaining := 2 - least(v_scored, 2);",
        replace: "  v_reserved := 0;\n  v_remaining := 2 - least(v_scored, 2);",
      },
    ],
    expect: "killed",
  },
  {
    id: "S36_reserve_no_advisory_lock",
    target: "concurrency",
    description:
      "reserve_analysis_permit() drops the per-user advisory lock (concurrent different-key reserves both pass)",
    edits: [{ find: RESERVE_LOCK, replace: "  -- Re-check under the lock:" }],
    expect: "survive_gap",
  },
  {
    id: "S37_reserve_stale_window_48h",
    target: "reserve_analysis_permit",
    description:
      "reserve counts reserved permits over 48h instead of 24h (permit sweep/limit window mismatch)",
    edits: [
      {
        find: "      where p.user_id = v_uid\n        and p.status = 'reserved'\n        and p.created_at > now() - interval '24 hours'\n    )\n  into v_premium, v_scored, v_reserved;",
        replace:
          "      where p.user_id = v_uid\n        and p.status = 'reserved'\n        and p.created_at > now() - interval '48 hours'\n    )\n  into v_premium, v_scored, v_reserved;",
      },
    ],
    expect: "survive_gap",
  },

  // ── apply_synced_shot() backstop ──────────────────────────────────────────
  {
    id: "S38_apply_backstop_gt",
    target: "apply_synced_shot",
    description: "sync backstop refuses only when lifetime count > 2 (third scored shot accepted)",
    edits: [
      {
        find: "    if not v_premium and public.lifetime_scored_count() >= 2 then",
        replace: "    if not v_premium and public.lifetime_scored_count() > 2 then",
      },
    ],
    expect: "killed",
  },
  {
    id: "S39_apply_backstop_raw_count",
    target: "apply_synced_shot",
    description: "sync backstop counts raw per-account scored shots (identity ledger bypassed)",
    edits: [
      {
        find: "    if not v_premium and public.lifetime_scored_count() >= 2 then",
        replace:
          "    if not v_premium and (select count(*) from public.shots s where s.user_id = v_uid and s.result_kind = 'scored') >= 2 then",
      },
    ],
    expect: "killed",
  },
  {
    id: "S40_apply_backstop_ignores_premium",
    target: "apply_synced_shot",
    description: "sync backstop applies to premium accounts too",
    edits: [
      {
        find: "    if not v_premium and public.lifetime_scored_count() >= 2 then",
        replace: "    if public.lifetime_scored_count() >= 2 then",
      },
    ],
    expect: "survive_gap",
  },
  {
    id: "S41_apply_backstop_outcome_expired",
    target: "apply_synced_shot",
    description: "refused permit released with outcome 'expired' instead of 'free_limit_exceeded'",
    edits: [
      {
        find: "         set status = 'released', outcome = 'free_limit_exceeded'",
        replace: "         set status = 'released', outcome = 'expired'",
      },
    ],
    expect: "killed",
  },
  {
    id: "S42_apply_backstop_permit_left_reserved",
    target: "apply_synced_shot",
    description: "refused permit is NOT released (stays reserved, occupying an allowance slot)",
    edits: [
      {
        find: APPLY_BACKSTOP,
        replace: `    if not v_premium and public.lifetime_scored_count() >= 2 then
      return 'access.paywall_required';
    end if;`,
      },
    ],
    expect: "killed",
  },
  {
    id: "S43_apply_backstop_removed",
    target: "apply_synced_shot",
    description:
      "sync backstop removed entirely (a forged/over-issued permit becomes a third free rating)",
    edits: [{ find: APPLY_BACKSTOP, replace: "" }],
    expect: "killed",
  },
  {
    id: "S44_apply_backstop_abstentions_too",
    target: "apply_synced_shot",
    description:
      "sync backstop also refuses abstentions (low_confidence sync of an exhausted account fails)",
    edits: [
      {
        find: "  if v_result_kind = 'scored' then\n    select coalesce((",
        replace: "  if true then\n    select coalesce((",
      },
    ],
    expect: "killed",
  },
  {
    id: "S45_apply_no_advisory_lock",
    target: "concurrency",
    description:
      "apply_synced_shot() drops the per-user advisory lock (two concurrent syncs with different permits both pass the backstop)",
    edits: [
      {
        find: APPLY_LOCK,
        replace: "  -- Lock the permit so a concurrent retry of the same sync serializes here.",
      },
    ],
    expect: "survive_gap",
  },
  {
    id: "S46_apply_premium_default_true",
    target: "apply_synced_shot",
    description: "sync backstop treats accounts with no billing row as premium",
    edits: [
      {
        find: "      where b.user_id = v_uid\n    ), false) into v_premium;",
        replace: "      where b.user_id = v_uid\n    ), true) into v_premium;",
      },
    ],
    expect: "killed",
  },

  // ── grants / isolation ────────────────────────────────────────────────────
  {
    id: "S47_ledger_no_revoke",
    target: "grants",
    description:
      "client grants on free_rating_ledger are not revoked (hosted default privileges leak the table)",
    edits: [{ find: LEDGER_REVOKE, replace: "" }],
    expect: "killed",
  },
  {
    id: "S48_ledger_grant_select",
    target: "grants",
    description: "authenticated gets SELECT on free_rating_ledger",
    edits: [
      {
        find: LEDGER_REVOKE,
        replace: LEDGER_REVOKE + "\ngrant select on public.free_rating_ledger to authenticated;",
      },
    ],
    expect: "killed",
  },
  {
    id: "S49_ledger_no_rls",
    target: "grants",
    description: "RLS not enabled on free_rating_ledger (revokes remain the only barrier)",
    edits: [
      { find: "alter table public.free_rating_ledger enable row level security;", replace: "" },
    ],
    expect: "survive_gap",
  },
  {
    id: "S50_ledger_permissive_policy",
    target: "grants",
    description: "a permissive SELECT policy AND a SELECT grant expose the ledger to authenticated",
    edits: [
      {
        find: LEDGER_REVOKE,
        replace:
          LEDGER_REVOKE +
          "\ngrant select on public.free_rating_ledger to authenticated;\ncreate policy mutant_ledger_read on public.free_rating_ledger for select to authenticated using (true);",
      },
    ],
    expect: "killed",
  },
  {
    id: "S51_hash_fn_grant_authenticated",
    target: "grants",
    description: "free_rating_identity_hash() EXECUTE granted to authenticated",
    edits: [
      {
        find: HASH_REVOKE,
        replace:
          HASH_REVOKE +
          "\ngrant execute on function public.free_rating_identity_hash(text, text) to authenticated;",
      },
    ],
    expect: "killed",
  },
  {
    id: "S52_writer_fn_grant_authenticated",
    target: "grants",
    description: "record_scored_shot_in_ledger() EXECUTE granted to authenticated",
    edits: [
      {
        find: WRITER_REVOKE,
        replace:
          WRITER_REVOKE +
          "\ngrant execute on function public.record_scored_shot_in_ledger() to authenticated;",
      },
    ],
    expect: "killed",
  },
  {
    id: "S53_ledger_grant_insert_update_delete",
    target: "grants",
    description: "authenticated gets INSERT/UPDATE/DELETE on free_rating_ledger (no SELECT)",
    edits: [
      {
        find: LEDGER_REVOKE,
        replace:
          LEDGER_REVOKE +
          "\ngrant insert, update, delete on public.free_rating_ledger to authenticated;",
      },
    ],
    expect: "killed",
  },
];
