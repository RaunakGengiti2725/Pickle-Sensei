/**
 * Live probes the EXISTING suites do not run. They execute against the
 * per-mutant database after security_regression.sql, through the same
 * `authenticated` role + JWT-claim path the edge function uses. Every probe
 * reports pass/fail plus the exact seed it used so a failure is replayable
 * (MUT_SEED=<n> replays the same UUIDs / keys).
 *
 * Probes are additive evidence: a mutant is classified KILLED only if a
 * pre-existing suite fails; a probe-only kill is reported separately as a
 * coverage gap in the existing matrix.
 */
import postgres from "postgres";

export type Sql = ReturnType<typeof postgres>;

export interface ProbeResult {
  id: string;
  passed: boolean;
  detail: string;
  seed: Record<string, unknown>;
  error?: string;
}

/** Deterministic UUID v4-shaped ids from a seed (replayable). */
export function seededUuid(seed: number, n: number): string {
  const hex = (v: number, len: number) => v.toString(16).padStart(len, "0").slice(-len);
  const s = (seed * 2654435761 + n * 40503) >>> 0;
  const t = (seed * 97 + n * 1000003) >>> 0;
  return `${hex(s, 8)}-${hex(t & 0xffff, 4)}-4${hex((t >>> 16) & 0xfff, 3)}-8${hex(n & 0xfff, 3)}-${hex(seed & 0xffffff, 6)}${hex(n, 6)}`;
}

const VERSION_VECTOR = {
  appVersion: "1.0.0",
  modelBundleVersion: "bundle-1",
  poseModelVersion: "pose-1",
  paddleModelVersion: "paddle-1",
  strokeDetectorVersion: "stroke-1",
  phaseModelVersion: "phase-1",
  scoringModelVersion: "scoring-1",
  shotConfigVersion: "config-1",
};

export function shotJson(id: string, permitId: string, resultKind = "scored"): string {
  return JSON.stringify({
    id,
    sessionId: null,
    analysisPermitId: permitId,
    shotType: "dink",
    cameraView: "side",
    capturedAt: "2026-09-01T10:00:00.000Z",
    startMs: 0,
    contactMs: 100,
    endMs: 200,
    overallScore: resultKind === "scored" ? 7 : null,
    confidence: 0.9,
    resultKind,
    phases: [],
    checkpoints: [],
    versionVector: VERSION_VECTOR,
  });
}

export async function provisionUser(
  sql: Sql,
  uid: string,
  provider: string,
  providerId: string,
): Promise<void> {
  await sql.unsafe(
    `insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data)
     values ($1, $2, '{"full_name":"Probe"}', $3) on conflict do nothing`,
    [uid, `${uid}@probe.example.com`, JSON.stringify({ provider })],
  );
  await sql.unsafe(
    `insert into auth.identities (provider, provider_id, user_id, identity_data)
     values ($1, $2, $3, $4) on conflict do nothing`,
    [provider, providerId, uid, JSON.stringify({ sub: providerId })],
  );
}

/** Runs `fn` in ONE committed transaction as the authenticated user `uid`. */
export async function asUser<T>(sql: Sql, uid: string, fn: (tx: Sql) => Promise<T>): Promise<T> {
  return (await sql.begin(async (tx) => {
    const t = tx as unknown as Sql;
    await t.unsafe(`set local role authenticated`);
    await t.unsafe(`select set_config('request.jwt.claim.sub', $1, true)`, [uid]);
    return await fn(t);
  })) as T;
}

async function reserve(
  tx: Sql,
  key: string,
): Promise<{ result: string; permit_id: string | null }> {
  const rows = await tx.unsafe(`select result, permit_id from public.reserve_analysis_permit($1)`, [
    key,
  ]);
  return {
    result: String(rows[0].result),
    permit_id: rows[0].permit_id ? String(rows[0].permit_id) : null,
  };
}

async function apply(tx: Sql, shot: string): Promise<string> {
  const rows = await tx.unsafe(`select public.apply_synced_shot($1::text::jsonb) as status`, [
    shot,
  ]);
  return String(rows[0].status);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Two connections, two idempotency keys, one remaining rating: the second
 * reserve must wait on the per-user advisory lock and then be refused. */
async function probeReserveRace(url: string, seed: number): Promise<ProbeResult> {
  const uid = seededUuid(seed, 101);
  const sub = `probe-race-reserve-${seed}`;
  const keys = [`race-a-${seed}`, `race-b-${seed}`];
  const seedInfo = { uid, provider: "google", provider_id: sub, keys };
  const a = postgres(url, { max: 1 });
  const b = postgres(url, { max: 1 });
  try {
    await provisionUser(a, uid, "google", sub);
    // One scored rating already consumed → exactly one left.
    await asUser(a, uid, async (tx) => {
      const p = await reserve(tx, `seed-${seed}`);
      if (p.result !== "accepted" || !p.permit_id) throw new Error(`seed reserve: ${p.result}`);
      const s = await apply(tx, shotJson(seededUuid(seed, 102), p.permit_id));
      if (s !== "accepted") throw new Error(`seed apply: ${s}`);
    });

    let bResolvedBeforeCommit = false;
    let bResult = "";
    let aResult = "";
    await a.begin(async (txa) => {
      const ta = txa as unknown as Sql;
      await ta.unsafe(`set local role authenticated`);
      await ta.unsafe(`select set_config('request.jwt.claim.sub', $1, true)`, [uid]);
      aResult = (await reserve(ta, keys[0])).result;
      // B starts while A's insert is uncommitted.
      const bPromise = asUser(b, uid, async (tb) => (await reserve(tb, keys[1])).result);
      const winner = await Promise.race([
        bPromise.then(() => "b"),
        sleep(1500).then(() => "timeout"),
      ]);
      bResolvedBeforeCommit = winner === "b";
      // Commit A (leaving the begin callback), then collect B.
      bPromise.then((r) => (bResult = r)).catch((e) => (bResult = `error:${String(e)}`));
    });
    for (let i = 0; i < 100 && bResult === ""; i++) await sleep(50);

    const rows = await a.unsafe(
      `select count(*)::int as n from public.analysis_permits where user_id = $1 and status = 'reserved'`,
      [uid],
    );
    const reservedNow = Number(rows[0].n);
    const passed =
      aResult === "accepted" &&
      bResult === "access.paywall_required" &&
      reservedNow === 1 &&
      !bResolvedBeforeCommit;
    return {
      id: "P1_reserve_race_two_keys",
      passed,
      detail: `A=${aResult} B=${bResult} reserved_after=${reservedNow} b_returned_before_A_commit=${bResolvedBeforeCommit} (expected A=accepted, B=access.paywall_required, reserved=1, B waited)`,
      seed: seedInfo,
    };
  } catch (error) {
    return {
      id: "P1_reserve_race_two_keys",
      passed: false,
      detail: "probe error",
      seed: seedInfo,
      error: String(error),
    };
  } finally {
    await a.end({ timeout: 5 });
    await b.end({ timeout: 5 });
  }
}

/** Two concurrent syncs holding DIFFERENT permits (the second one over-issued
 * directly in the table) against one remaining rating: the sync backstop must
 * serialize on the advisory lock and refuse the second scored shot. */
async function probeSyncRace(url: string, seed: number): Promise<ProbeResult> {
  const uid = seededUuid(seed, 201);
  const sub = `probe-race-sync-${seed}`;
  const shotIds = [seededUuid(seed, 202), seededUuid(seed, 203), seededUuid(seed, 204)];
  const seedInfo = { uid, provider: "apple", provider_id: sub, shot_ids: shotIds };
  const a = postgres(url, { max: 1 });
  const b = postgres(url, { max: 1 });
  try {
    await provisionUser(a, uid, "apple", sub);
    await asUser(a, uid, async (tx) => {
      const p = await reserve(tx, `seed-sync-${seed}`);
      if (p.result !== "accepted" || !p.permit_id) throw new Error(`seed reserve: ${p.result}`);
      const s = await apply(tx, shotJson(shotIds[0], p.permit_id));
      if (s !== "accepted") throw new Error(`seed apply: ${s}`);
    });
    const p1 = await asUser(a, uid, async (tx) => {
      const r = await reserve(tx, `race-sync-1-${seed}`);
      if (r.result !== "accepted" || !r.permit_id) throw new Error(`p1 reserve: ${r.result}`);
      return r.permit_id;
    });
    // Over-issued permit written directly (what a pre-RPC build could do).
    const forged = await a.unsafe(
      `insert into public.analysis_permits (user_id, idempotency_key) values ($1, $2) returning id`,
      [uid, `forged-${seed}`],
    );
    const p2 = String(forged[0].id);

    let bResult = "";
    let aResult = "";
    let bResolvedBeforeCommit = false;
    await a.begin(async (txa) => {
      const ta = txa as unknown as Sql;
      await ta.unsafe(`set local role authenticated`);
      await ta.unsafe(`select set_config('request.jwt.claim.sub', $1, true)`, [uid]);
      aResult = await apply(ta, shotJson(shotIds[1], p1));
      const bPromise = asUser(b, uid, (tb) => apply(tb, shotJson(shotIds[2], p2)));
      const winner = await Promise.race([
        bPromise.then(() => "b"),
        sleep(1500).then(() => "timeout"),
      ]);
      bResolvedBeforeCommit = winner === "b";
      bPromise.then((r) => (bResult = r)).catch((e) => (bResult = `error:${String(e)}`));
    });
    for (let i = 0; i < 100 && bResult === ""; i++) await sleep(50);

    const shots = await a.unsafe(
      `select count(*)::int as n from public.shots where user_id = $1 and result_kind = 'scored'`,
      [uid],
    );
    const permit = await a.unsafe(
      `select status, outcome from public.analysis_permits where id = $1`,
      [p2],
    );
    const scored = Number(shots[0].n);
    const passed =
      aResult === "accepted" &&
      bResult === "access.paywall_required" &&
      scored === 2 &&
      permit[0].status === "released" &&
      permit[0].outcome === "free_limit_exceeded";
    return {
      id: "P2_sync_race_two_permits",
      passed,
      detail: `A=${aResult} B=${bResult} scored_after=${scored} forged_permit=${permit[0].status}/${permit[0].outcome} b_returned_before_A_commit=${bResolvedBeforeCommit} (expected accepted / access.paywall_required / 2 / released/free_limit_exceeded)`,
      seed: { ...seedInfo, permits: [p1, p2] },
    };
  } catch (error) {
    return {
      id: "P2_sync_race_two_permits",
      passed: false,
      detail: "probe error",
      seed: seedInfo,
      error: String(error),
    };
  } finally {
    await a.end({ timeout: 5 });
    await b.end({ timeout: 5 });
  }
}

/** anon must not be able to execute the ledger readers; authenticated must not
 * execute the hash / writer helpers; the ledger has RLS on and no policies. */
async function probeGrantsAndRls(url: string): Promise<ProbeResult> {
  const sql = postgres(url, { max: 1 });
  const failures: string[] = [];
  const denied = async (role: string, stmt: string, label: string) => {
    try {
      await sql.begin(async (tx) => {
        const t = tx as unknown as Sql;
        await t.unsafe(`set local role ${role}`);
        await t.unsafe(stmt);
      });
      failures.push(`${label}: ${role} was ALLOWED to run ${stmt}`);
    } catch (error) {
      const msg = String(error);
      if (!/permission denied|must be owner/i.test(msg))
        failures.push(`${label}: unexpected error ${msg}`);
    }
  };
  try {
    await denied("anon", "select public.identity_scored_count()", "anon identity_scored_count");
    await denied("anon", "select public.lifetime_scored_count()", "anon lifetime_scored_count");
    await denied("anon", "select * from public.access_state()", "anon access_state");
    await denied(
      "authenticated",
      "select public.free_rating_identity_hash('google','x')",
      "authenticated hash fn",
    );
    await denied(
      "authenticated",
      "select public.record_scored_shot_in_ledger()",
      "authenticated writer fn",
    );
    await denied(
      "authenticated",
      "select * from public.free_rating_ledger",
      "authenticated ledger select",
    );
    await denied("anon", "select * from public.free_rating_ledger", "anon ledger select");
    const rls = await sql.unsafe(
      `select c.relrowsecurity as rls,
              (select count(*)::int from pg_policies p where p.schemaname = 'public' and p.tablename = 'free_rating_ledger') as policies
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relname = 'free_rating_ledger'`,
    );
    if (rls.length !== 1) failures.push("ledger table missing");
    else {
      if (rls[0].rls !== true) failures.push("RLS not enabled on free_rating_ledger");
      if (Number(rls[0].policies) !== 0)
        failures.push(`free_rating_ledger has ${rls[0].policies} policies (expected 0)`);
    }
    const grants = await sql.unsafe(
      `select grantee, privilege_type from information_schema.role_table_grants
       where table_schema = 'public' and table_name = 'free_rating_ledger' and grantee in ('anon','authenticated','public')`,
    );
    if (grants.length > 0) {
      failures.push(
        `client grants on ledger: ${grants.map((g) => `${g.grantee}:${g.privilege_type}`).join(",")}`,
      );
    }
    // Grant-level checks (a definer/invoker helper may still fail for anon on
    // an inner table grant, which hides an over-broad EXECUTE grant).
    const fnGrants: Array<[string, string]> = [
      ["anon", "public.identity_scored_count()"],
      ["anon", "public.lifetime_scored_count()"],
      ["anon", "public.access_state()"],
      ["anon", "public.free_rating_identity_hash(text, text)"],
      ["authenticated", "public.free_rating_identity_hash(text, text)"],
      ["anon", "public.record_scored_shot_in_ledger()"],
      ["authenticated", "public.record_scored_shot_in_ledger()"],
    ];
    for (const [role, fn] of fnGrants) {
      const r = await sql.unsafe(`select has_function_privilege($1, $2, 'execute') as ok`, [
        role,
        fn,
      ]);
      if (r[0].ok === true) failures.push(`${role} holds EXECUTE on ${fn}`);
    }
    return {
      id: "P3_grants_and_rls",
      passed: failures.length === 0,
      detail:
        failures.length === 0
          ? "all denials held; RLS on, 0 policies, 0 client grants"
          : failures.join(" | "),
      seed: {},
    };
  } catch (error) {
    return {
      id: "P3_grants_and_rls",
      passed: false,
      detail: "probe error",
      seed: {},
      error: String(error),
    };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/** An identity whose ledger says 5 (history beyond the cap) is refused at all
 * three decision points and access_state reports the raw ledger value. */
async function probeInheritedAboveCap(url: string, seed: number): Promise<ProbeResult> {
  const uid = seededUuid(seed, 301);
  const sub = `probe-cap-${seed}`;
  const seedInfo = { uid, provider: "google", provider_id: sub, ledger_count: 5 };
  const sql = postgres(url, { max: 1 });
  try {
    await provisionUser(sql, uid, "google", sub);
    await sql.unsafe(
      `insert into public.free_rating_ledger (identity_hash, scored_count)
       values (public.free_rating_identity_hash('google', $1), 5)
       on conflict (identity_hash) do update set scored_count = 5`,
      [sub],
    );
    const out = await asUser(sql, uid, async (tx) => {
      const st = await tx.unsafe(`select * from public.access_state()`);
      const r = await reserve(tx, `cap-${seed}`);
      const forged = await tx.unsafe(
        `select count(*)::int as n from public.analysis_permits where user_id = $1`,
        [uid],
      );
      return {
        scored: Number(st[0].scored_count),
        premium: st[0].premium,
        reserve: r.result,
        permits: Number(forged[0].n),
      };
    });
    // Forged permit → sync backstop must still refuse.
    const forged = await sql.unsafe(
      `insert into public.analysis_permits (user_id, idempotency_key) values ($1, $2) returning id`,
      [uid, `cap-forged-${seed}`],
    );
    const sync = await asUser(sql, uid, (tx) =>
      apply(tx, shotJson(seededUuid(seed, 302), String(forged[0].id))),
    );
    const passed =
      out.scored === 5 &&
      out.premium === false &&
      out.reserve === "access.paywall_required" &&
      out.permits === 0 &&
      sync === "access.paywall_required";
    return {
      id: "P4_inherited_ledger_above_cap",
      passed,
      detail: `access_state.scored_count=${out.scored} reserve=${out.reserve} permits_created=${out.permits} forged_sync=${sync} (expected 5 / access.paywall_required / 0 / access.paywall_required)`,
      seed: seedInfo,
    };
  } catch (error) {
    return {
      id: "P4_inherited_ledger_above_cap",
      passed: false,
      detail: "probe error",
      seed: seedInfo,
      error: String(error),
    };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/** A lapsed premium entitlement (expires_at in the past) is NOT premium at any
 * decision point: exhausted identity → refused. */
async function probeLapsedPremium(url: string, seed: number): Promise<ProbeResult> {
  const uid = seededUuid(seed, 401);
  const sub = `probe-lapsed-${seed}`;
  const seedInfo = {
    uid,
    provider: "apple",
    provider_id: sub,
    expires_at: "now() - 1 day",
    ledger_count: 2,
  };
  const sql = postgres(url, { max: 1 });
  try {
    await provisionUser(sql, uid, "apple", sub);
    await sql.unsafe(
      `insert into public.free_rating_ledger (identity_hash, scored_count)
       values (public.free_rating_identity_hash('apple', $1), 2) on conflict (identity_hash) do update set scored_count = 2`,
      [sub],
    );
    await sql.unsafe(
      `insert into public.billing_entitlements (user_id, premium, expires_at) values ($1, true, now() - interval '1 day')`,
      [uid],
    );
    const st = await asUser(sql, uid, async (tx) => {
      const s = await tx.unsafe(`select * from public.access_state()`);
      const r = await reserve(tx, `lapsed-${seed}`);
      return { premium: s[0].premium, scored: Number(s[0].scored_count), reserve: r.result };
    });
    const forged = await sql.unsafe(
      `insert into public.analysis_permits (user_id, idempotency_key) values ($1, $2) returning id`,
      [uid, `lapsed-forged-${seed}`],
    );
    const sync = await asUser(sql, uid, (tx) =>
      apply(tx, shotJson(seededUuid(seed, 402), String(forged[0].id))),
    );
    const passed =
      st.premium === false &&
      st.scored === 2 &&
      st.reserve === "access.paywall_required" &&
      sync === "access.paywall_required";
    return {
      id: "P5_lapsed_premium_not_premium",
      passed,
      detail: `access_state.premium=${st.premium} scored=${st.scored} reserve=${st.reserve} forged_sync=${sync} (expected false / 2 / access.paywall_required / access.paywall_required)`,
      seed: seedInfo,
    };
  } catch (error) {
    return {
      id: "P5_lapsed_premium_not_premium",
      passed: false,
      detail: "probe error",
      seed: seedInfo,
      error: String(error),
    };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/** A shot row that is UPDATED from an abstention to scored (never expected,
 * but the trigger claims to cover it) must increment the ledger once. */
async function probeUpdateToScored(url: string, seed: number): Promise<ProbeResult> {
  const uid = seededUuid(seed, 501);
  const sub = `probe-update-${seed}`;
  const seedInfo = { uid, provider: "google", provider_id: sub, shot_id: seededUuid(seed, 502) };
  const sql = postgres(url, { max: 1 });
  try {
    await provisionUser(sql, uid, "google", sub);
    await asUser(sql, uid, async (tx) => {
      const p = await reserve(tx, `upd-${seed}`);
      if (p.result !== "accepted" || !p.permit_id) throw new Error(`reserve: ${p.result}`);
      const s = await apply(tx, shotJson(seedInfo.shot_id, p.permit_id, "low_confidence"));
      if (s !== "accepted") throw new Error(`apply: ${s}`);
    });
    const before = await asUser(sql, uid, async (tx) =>
      Number((await tx.unsafe(`select public.identity_scored_count() as n`))[0].n),
    );
    // Service-side correction (superuser): abstention becomes scored.
    await sql.unsafe(
      `update public.shots set result_kind = 'scored', overall_score = 7 where id = $1`,
      [seedInfo.shot_id],
    );
    const after = await asUser(sql, uid, async (tx) =>
      Number((await tx.unsafe(`select public.identity_scored_count() as n`))[0].n),
    );
    const passed = before === 0 && after === 1;
    return {
      id: "P6_update_to_scored_increments_once",
      passed,
      detail: `identity_scored_count before=${before} after=${after} (expected 0 → 1)`,
      seed: seedInfo,
    };
  } catch (error) {
    return {
      id: "P6_update_to_scored_increments_once",
      passed: false,
      detail: "probe error",
      seed: seedInfo,
      error: String(error),
    };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/** An ACTIVE premium entitlement bypasses the free limit at every decision
 * point even when the identity ledger is far past the cap: reserve accepted,
 * scored sync accepted, and the ledger still records the scored shot. */
async function probeActivePremiumBypass(url: string, seed: number): Promise<ProbeResult> {
  const uid = seededUuid(seed, 701);
  const sub = `probe-premium-${seed}`;
  const seedInfo = {
    uid,
    provider: "apple",
    provider_id: sub,
    expires_at: "now() + 30 days",
    ledger_count: 5,
    shot_id: seededUuid(seed, 702),
  };
  const sql = postgres(url, { max: 1 });
  try {
    await provisionUser(sql, uid, "apple", sub);
    await sql.unsafe(
      `insert into public.free_rating_ledger (identity_hash, scored_count)
       values (public.free_rating_identity_hash('apple', $1), 5) on conflict (identity_hash) do update set scored_count = 5`,
      [sub],
    );
    await sql.unsafe(
      `insert into public.billing_entitlements (user_id, premium, expires_at) values ($1, true, now() + interval '30 days')`,
      [uid],
    );
    const out = await asUser(sql, uid, async (tx) => {
      const s = await tx.unsafe(`select * from public.access_state()`);
      const r = await reserve(tx, `premium-${seed}`);
      const sync = r.permit_id
        ? await apply(tx, shotJson(seedInfo.shot_id, r.permit_id))
        : "no-permit";
      const n = Number((await tx.unsafe(`select public.identity_scored_count() as n`))[0].n);
      return {
        premium: s[0].premium,
        scored: Number(s[0].scored_count),
        reserve: r.result,
        sync,
        ledger_after: n,
      };
    });
    const passed =
      out.premium === true &&
      out.scored === 5 &&
      out.reserve === "accepted" &&
      out.sync === "accepted" &&
      out.ledger_after === 6;
    return {
      id: "P8_active_premium_bypasses_backstop",
      passed,
      detail: `access_state.premium=${out.premium} scored=${out.scored} reserve=${out.reserve} sync=${out.sync} ledger_after=${out.ledger_after} (expected true / 5 / accepted / accepted / 6)`,
      seed: seedInfo,
    };
  } catch (error) {
    return {
      id: "P8_active_premium_bypasses_backstop",
      passed: false,
      detail: "probe error",
      seed: seedInfo,
      error: String(error),
    };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/** A user with TWO identities (Apple + Google) whose ledgers disagree must be
 * counted by the MAX identity; a scored shot then lifts both to max + 1. */
async function probeMultiIdentityMax(url: string, seed: number): Promise<ProbeResult> {
  const uid = seededUuid(seed, 801);
  const subA = `probe-multi-apple-${seed}`;
  const subG = `probe-multi-google-${seed}`;
  const seedInfo = {
    uid,
    identities: { apple: subA, google: subG },
    ledger: { apple: 1, google: 0 },
    shot_id: seededUuid(seed, 802),
  };
  const sql = postgres(url, { max: 1 });
  try {
    await provisionUser(sql, uid, "apple", subA);
    await provisionUser(sql, uid, "google", subG);
    await sql.unsafe(
      `insert into public.free_rating_ledger (identity_hash, scored_count)
       values (public.free_rating_identity_hash('apple', $1), 1), (public.free_rating_identity_hash('google', $2), 0)
       on conflict (identity_hash) do update set scored_count = excluded.scored_count`,
      [subA, subG],
    );
    const before = await asUser(sql, uid, async (tx) =>
      Number((await tx.unsafe(`select public.identity_scored_count() as n`))[0].n),
    );
    const sync = await asUser(sql, uid, async (tx) => {
      const r = await reserve(tx, `multi-${seed}`);
      if (r.result !== "accepted" || !r.permit_id) return r.result;
      return await apply(tx, shotJson(seedInfo.shot_id, r.permit_id));
    });
    const after = await asUser(sql, uid, async (tx) =>
      Number((await tx.unsafe(`select public.identity_scored_count() as n`))[0].n),
    );
    const rows = await sql.unsafe(
      `select scored_count from public.free_rating_ledger
       where identity_hash in (public.free_rating_identity_hash('apple', $1), public.free_rating_identity_hash('google', $2))
       order by scored_count`,
      [subA, subG],
    );
    const counts = rows.map((r) => Number(r.scored_count));
    const passed =
      before === 1 &&
      sync === "accepted" &&
      after === 2 &&
      counts.length === 2 &&
      counts[0] === 2 &&
      counts[1] === 2;
    return {
      id: "P9_multi_identity_counts_by_max",
      passed,
      detail: `identity_scored_count before=${before} sync=${sync} after=${after} ledger_rows=[${counts.join(",")}] (expected 1 / accepted / 2 / [2,2])`,
      seed: seedInfo,
    };
  } catch (error) {
    return {
      id: "P9_multi_identity_counts_by_max",
      passed: false,
      detail: "probe error",
      seed: seedInfo,
      error: String(error),
    };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/** A reserved permit older than the 24h window (a client that never synced)
 * must not occupy the last free slot: reserve at 1 scored still succeeds. */
async function probeStaleReservedPermitIgnored(url: string, seed: number): Promise<ProbeResult> {
  const uid = seededUuid(seed, 901);
  const sub = `probe-stale-${seed}`;
  const seedInfo = {
    uid,
    provider: "google",
    provider_id: sub,
    ledger_count: 1,
    stale_permit_age: "30 hours",
  };
  const sql = postgres(url, { max: 1 });
  try {
    await provisionUser(sql, uid, "google", sub);
    await sql.unsafe(
      `insert into public.free_rating_ledger (identity_hash, scored_count)
       values (public.free_rating_identity_hash('google', $1), 1) on conflict (identity_hash) do update set scored_count = 1`,
      [sub],
    );
    await sql.unsafe(
      `insert into public.analysis_permits (user_id, idempotency_key, created_at) values ($1, $2, now() - interval '30 hours')`,
      [uid, `stale-${seed}`],
    );
    const out = await asUser(sql, uid, async (tx) => {
      const s = await tx.unsafe(`select * from public.access_state()`);
      const r = await reserve(tx, `fresh-${seed}`);
      return { reserved: Number(s[0].reserved_count), reserve: r.result };
    });
    const passed = out.reserved === 0 && out.reserve === "accepted";
    return {
      id: "P10_stale_reserved_permit_ignored",
      passed,
      detail: `access_state.reserved_count=${out.reserved} reserve=${out.reserve} (expected 0 / accepted)`,
      seed: seedInfo,
    };
  } catch (error) {
    return {
      id: "P10_stale_reserved_permit_ignored",
      passed: false,
      detail: "probe error",
      seed: seedInfo,
      error: String(error),
    };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

export async function runLiveProbes(url: string, seed: number): Promise<ProbeResult[]> {
  const results: ProbeResult[] = [];
  results.push(await probeReserveRace(url, seed));
  results.push(await probeSyncRace(url, seed));
  results.push(await probeGrantsAndRls(url));
  results.push(await probeInheritedAboveCap(url, seed));
  results.push(await probeLapsedPremium(url, seed));
  results.push(await probeUpdateToScored(url, seed));
  results.push(await probeActivePremiumBypass(url, seed));
  results.push(await probeMultiIdentityMax(url, seed));
  results.push(await probeStaleReservedPermitIgnored(url, seed));
  return results;
}

/** Backfill probe: runs on a database where every migration BEFORE the ledger
 * migration has been applied and scored shots already exist. `applyRest`
 * applies the (possibly mutated) ledger migration and everything after it. */
export async function runBackfillProbe(
  url: string,
  seed: number,
  applyRest: () => Promise<void>,
): Promise<ProbeResult> {
  const uid = seededUuid(seed, 601);
  const sub = `probe-backfill-${seed}`;
  const seedInfo = {
    uid,
    provider: "google",
    provider_id: sub,
    scored_before_migration: 2,
    abstentions_before_migration: 1,
  };
  const sql = postgres(url, { max: 1 });
  try {
    await provisionUser(sql, uid, "google", sub);
    // Pre-ledger history: one abstention (a low_confidence shot row, which the
    // backfill must ignore) followed by two scored shots.
    await asUser(sql, uid, async (tx) => {
      const p0 = await reserve(tx, `bf-${seed}-abstain`);
      if (p0.result !== "accepted" || !p0.permit_id)
        throw new Error(`reserve abstain: ${p0.result}`);
      const s0 = await apply(tx, shotJson(seededUuid(seed, 620), p0.permit_id, "low_confidence"));
      if (s0 !== "accepted") throw new Error(`apply abstain: ${s0}`);
      for (let i = 0; i < 2; i++) {
        const p = await reserve(tx, `bf-${seed}-${i}`);
        if (p.result !== "accepted" || !p.permit_id) throw new Error(`reserve ${i}: ${p.result}`);
        const s = await apply(tx, shotJson(seededUuid(seed, 610 + i), p.permit_id));
        if (s !== "accepted") throw new Error(`apply ${i}: ${s}`);
      }
    });
    await applyRest();
    const led = await sql.unsafe(
      `select scored_count from public.free_rating_ledger where identity_hash = public.free_rating_identity_hash('google', $1)`,
      [sub],
    );
    const ledger = led.length ? Number(led[0].scored_count) : null;
    const st = await asUser(sql, uid, async (tx) =>
      Number((await tx.unsafe(`select * from public.access_state()`))[0].scored_count),
    );
    // Delete the account; the identity ledger must keep the backfilled 2.
    await sql.unsafe(`delete from auth.users where id = $1`, [uid]);
    const led2 = await sql.unsafe(
      `select scored_count from public.free_rating_ledger where identity_hash = public.free_rating_identity_hash('google', $1)`,
      [sub],
    );
    const afterDelete = led2.length ? Number(led2[0].scored_count) : null;
    const passed = ledger === 2 && st === 2 && afterDelete === 2;
    return {
      id: "P7_backfill_pre_existing_scored_shots",
      passed,
      detail: `ledger_after_migration=${ledger} access_state.scored_count=${st} ledger_after_account_delete=${afterDelete} (expected 2 / 2 / 2)`,
      seed: seedInfo,
    };
  } catch (error) {
    return {
      id: "P7_backfill_pre_existing_scored_shots",
      passed: false,
      detail: "probe error",
      seed: seedInfo,
      error: String(error),
    };
  } finally {
    await sql.end({ timeout: 5 });
  }
}
