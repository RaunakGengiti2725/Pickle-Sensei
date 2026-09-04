// Stress `POST /v1/me/delete-confirm` — lens `failure-load`, part 4: the
// route's DATABASE sequence on a real postgres:16 with shim_auth.sql + every
// migration applied (./xc_pg_up.sh). The in-process matrix models PostgREST;
// this file drives the same statements the route issues, as the same roles:
//
//   authenticated (bearer client)  select challenge, created_at, expires_at
//                                    from account_deletion_requests where user_id = uid
//   service_role (adminDb)         select … from account_external_credentials where user_id = uid
//                                  update account_external_credentials set apple_revoked_at … (Apple checkpoint)
//                                  insert … on conflict (user_id) do update  (RevenueCat checkpoint, merge-duplicates)
//   auth admin (deleteUser)        delete from auth.users where id = uid       (cascade)
//
// Scenarios (seeded; every id derives from STRESS_SEED; replay printed):
//   PGD1 role/RLS surface of the route's statements + cascade + delete-twice idempotency
//   PGD2 duplicate delivery: N lanes run the sequence concurrently from a barrier
//   PGD3 free-rating ledger survives the route's cascade; re-created identity
//        cannot double-spend (N concurrent reserves → all paywalled); late-linked
//        identity inherits; a different provider subject is a fresh identity
//   PGD4 stale-challenge sweep statement (the pg_cron job body) is selective
//
//   ./xc_pg_up.sh   # prints XC_PG_URL (never a hosted project)
//   XC_PG_URL=postgres://postgres:pg@127.0.0.1:55433/postgres STRESS_OUT=/tmp/x/ \
//     deno test -A --no-check --config deno.json stress_delete_confirm_pg.test.ts
//
// Without XC_PG_URL every test is `ignore`d — an ignored run is NOT a pass.

import postgres from "postgres";
import { assert, assertEquals } from "@std/assert";
import { envInt, fnv1a, Prng, STRESS_SEED, writeJson } from "./stress_delete_confirm_harness.ts";

const PG_URL = Deno.env.get("XC_PG_URL") ?? Deno.env.get("PICKLE_AUDIT_PG_URL") ?? "";
const ignore = PG_URL === "";
const LANES = envInt("STRESS_PG_LANES", 8);
const ROUNDS = envInt("STRESS_PG_ROUNDS", 3);

type Sql = ReturnType<typeof postgres>;
type Tx = Parameters<Parameters<Sql["begin"]>[1]>[0];

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

function replay(filter: string): string {
  return `XC_PG_URL=<from ./xc_pg_up.sh> STRESS_SEED=${STRESS_SEED} STRESS_PG_LANES=${LANES} STRESS_PG_ROUNDS=${ROUNDS} deno test -A --no-check --config deno.json stress_delete_confirm_pg.test.ts --filter "${filter}"`;
}

async function asUser(tx: Tx, userId: string): Promise<void> {
  await tx.unsafe(`set local role authenticated`);
  await tx.unsafe(`set local request.jwt.claim.sub = '${userId}'`);
}

async function asService(tx: Tx): Promise<void> {
  await tx.unsafe(`set local role service_role`);
}

async function sqlState(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "ok";
  } catch (error) {
    const e = error as { code?: string; message?: string };
    return e.code ?? `error:${e.message}`;
  }
}

/** Seeded ids repeat across runs against the same disposable DB. */
async function createUser(
  sql: Sql,
  userId: string,
  identity: { provider: string; sub: string },
  opts: { keepLedger?: boolean } = {},
) {
  await sql.unsafe(`delete from auth.users where id = '${userId}'`);
  await sql.unsafe(
    `delete from auth.users u using auth.identities i
      where i.user_id = u.id and i.provider = '${identity.provider}' and i.provider_id = '${identity.sub}'`,
  );
  if (!opts.keepLedger) {
    await sql.unsafe(
      `delete from public.free_rating_ledger
        where identity_hash = public.free_rating_identity_hash('${identity.provider}', '${identity.sub}')`,
    );
  }
  await sql.unsafe(
    `insert into auth.users (id, email, raw_app_meta_data) values ('${userId}', '${userId}@example.com', '{"provider":"${identity.provider}"}')`,
  );
  await sql.unsafe(
    `insert into auth.identities (provider, provider_id, user_id, identity_data)
     values ('${identity.provider}', '${identity.sub}', '${userId}', '{"sub":"${identity.sub}"}')`,
  );
}

/** delete-request as PostgREST issues it: merge-duplicates upsert sets EVERY payload column. */
async function armChallenge(tx: Tx, userId: string, challenge: string, ageMs: number): Promise<void> {
  await tx.unsafe(
    `insert into public.account_deletion_requests (user_id, challenge, created_at, expires_at)
     values ('${userId}', '${challenge}', now() - make_interval(secs => ${ageMs / 1000}), now() + interval '15 minutes')
     on conflict (user_id) do update set
       user_id = excluded.user_id, challenge = excluded.challenge,
       created_at = excluded.created_at, expires_at = excluded.expires_at`,
  );
}

async function readChallenge(tx: Tx, userId: string) {
  return await tx.unsafe(
    `select challenge, created_at, expires_at from public.account_deletion_requests where user_id = '${userId}'`,
  );
}

async function rcCheckpoint(tx: Tx, userId: string): Promise<void> {
  await tx.unsafe(
    `insert into public.account_external_credentials (user_id, revenuecat_deleted_at, updated_at)
     values ('${userId}', now(), now())
     on conflict (user_id) do update set
       user_id = excluded.user_id, revenuecat_deleted_at = excluded.revenuecat_deleted_at, updated_at = excluded.updated_at`,
  );
}

async function deleteAuthUser(tx: Sql | Tx, userId: string): Promise<number> {
  const r = await tx.unsafe(`delete from auth.users where id = '${userId}'`);
  return r.count ?? 0;
}

async function rowsLeft(sql: Sql, userId: string) {
  const r = await sql.unsafe(
    `select
       (select count(*) from auth.users where id = '${userId}')::int as users,
       (select count(*) from auth.identities where user_id = '${userId}')::int as identities,
       (select count(*) from public.profiles where id = '${userId}')::int as profiles,
       (select count(*) from public.account_deletion_requests where user_id = '${userId}')::int as deletion_requests,
       (select count(*) from public.account_external_credentials where user_id = '${userId}')::int as external_credentials,
       (select count(*) from public.shots where user_id = '${userId}')::int as shots,
       (select count(*) from public.analysis_permits where user_id = '${userId}')::int as permits`,
  );
  return Object.fromEntries(Object.entries(r[0]).map(([k, v]) => [k, Number(v)])) as Record<string, number>;
}

async function ledgerCount(sql: Sql, provider: string, sub: string): Promise<number[]> {
  const r = await sql.unsafe(
    `select scored_count from public.free_rating_ledger
      where identity_hash = public.free_rating_identity_hash('${provider}', '${sub}')`,
  );
  return r.map((x) => Number(x.scored_count));
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

function shotPayload(id: string, analysisPermitId: string): Record<string, unknown> {
  return {
    id,
    analysisPermitId,
    sessionId: null,
    shotType: "dink",
    cameraView: "side",
    capturedAt: "2026-09-01T10:00:00.000Z",
    startMs: 0,
    contactMs: 100,
    endMs: 200,
    overallScore: 7,
    confidence: 0.9,
    resultKind: "scored",
    phases: [],
    checkpoints: [],
    versionVector: VERSION_VECTOR,
  };
}

/** Spend `n` free ratings through the real RPCs (permit + scored shot). */
async function spend(sql: Sql, userId: string, prng: Prng, n: number): Promise<string[]> {
  const results: string[] = [];
  await sql.begin(async (tx) => {
    const t = tx as unknown as Tx;
    await asUser(t, userId);
    for (let i = 0; i < n; i++) {
      const p = await t.unsafe(
        `select x.result, x.permit_id::text as permit_id from public.reserve_analysis_permit('${prng.uuid()}') x`,
      );
      results.push(String(p[0].result));
      if (p[0].result !== "accepted") continue;
      const a = await t.unsafe(`select public.apply_synced_shot($1::text::jsonb) as result`, [
        JSON.stringify(shotPayload(prng.uuid(), String(p[0].permit_id))),
      ]);
      results.push(String(a[0].result));
    }
  });
  return results;
}

async function accessState(sql: Sql, userId: string) {
  let out = { premium: false, scored_count: -1, reserved_count: -1 };
  await sql.begin(async (tx) => {
    const t = tx as unknown as Tx;
    await asUser(t, userId);
    const r = await t.unsafe(`select premium, scored_count, reserved_count from public.access_state()`);
    out = {
      premium: Boolean(r[0].premium),
      scored_count: Number(r[0].scored_count),
      reserved_count: Number(r[0].reserved_count),
    };
  });
  return out;
}

function barrier() {
  let open!: () => void;
  const gate = new Promise<void>((r) => (open = r));
  return { gate, open };
}

/** N independent connections/transactions released together. Each lane owns
 * a reserved connection with an explicit BEGIN/COMMIT so a statement error
 * (e.g. FK 23503 — the route's 503 class) is an outcome the lane records,
 * not a rejection of the whole burst; COMMIT on an aborted tx rolls back. */
async function burst<T>(sql: Sql, lanes: number, fn: (tx: Tx, lane: number) => Promise<T>): Promise<T[]> {
  const b = barrier();
  let ready = 0;
  const out: T[] = new Array(lanes);
  const all = Promise.all(
    Array.from({ length: lanes }, async (_, lane) => {
      const conn = await sql.reserve();
      try {
        await conn.unsafe("begin");
        ready += 1;
        await b.gate;
        out[lane] = await fn(conn as unknown as Tx, lane);
        await conn.unsafe("commit");
      } finally {
        conn.release();
      }
    }),
  );
  while (ready < lanes) await new Promise((r) => setTimeout(r, 1));
  b.open();
  await all;
  return out;
}

async function scenario(
  name: string,
  run: (sql: Sql, prng: Prng, checks: Check[], observations: Record<string, unknown>) => Promise<void>,
) {
  const sql = postgres(PG_URL, { max: LANES + 2 });
  const seed = (STRESS_SEED ^ fnv1a(name)) >>> 0;
  const prng = new Prng(seed);
  const checks: Check[] = [];
  const observations: Record<string, unknown> = {};
  const t0 = performance.now();
  try {
    await run(sql, prng, checks, observations);
  } finally {
    await sql.end();
  }
  const broken = checks.filter((c) => !c.ok);
  const report = {
    scenario: name,
    seed,
    scale: { lanes: LANES, rounds: ROUNDS },
    checks,
    verdict: broken.length === 0 ? "HELD" : "BROKEN",
    observations,
    durationMs: Math.round(performance.now() - t0),
    replay: replay(name),
  };
  const path = await writeJson(`pg_${name}.json`, report);
  console.log(`[stress-pg] ${name}: ${checks.length} checks, ${broken.length} BROKEN (${report.durationMs}ms) → ${path}`);
  for (const c of broken) console.log(`[stress-pg]   BROKEN ${c.name} — ${c.detail}`);
  for (const c of checks) assert(c.ok, `${name}/${c.name}: ${c.detail} (replay: ${report.replay})`);
}

const check = (checks: Check[], name: string, ok: boolean, detail = "") => {
  checks.push({ name, ok, detail });
};

// ─── PGD1 ────────────────────────────────────────────────────────────────────

Deno.test({
  name: "stress PGD1: delete-confirm statements as authenticated/service_role — RLS scoping, checkpoint idempotency, cascade, delete-twice",
  ignore,
  async fn() {
    await scenario("pgd1_roles_cascade", async (sql, prng, checks, obs) => {
      for (let r = 0; r < ROUNDS; r++) {
        const a = prng.uuid();
        const b = prng.uuid();
        await createUser(sql, a, { provider: "google", sub: `g-${prng.hex(16)}` });
        await createUser(sql, b, { provider: "google", sub: `g-${prng.hex(16)}` });
        const c1 = prng.uuid();
        const c2 = prng.uuid();

        // delete-request twice (re-arm) as the user → the OLD challenge no longer matches.
        await sql.begin(async (tx) => {
          const t = tx as unknown as Tx;
          await asUser(t, a);
          await armChallenge(t, a, c1, 5_000);
          await armChallenge(t, a, c2, 5_000);
        });
        await sql.begin(async (tx) => {
          const t = tx as unknown as Tx;
          await asUser(t, a);
          const rows = await readChallenge(t, a);
          check(checks, `r${r} owner reads exactly one row with the re-armed challenge`, rows.length === 1 && rows[0].challenge === c2, JSON.stringify(rows));
          const age = await t.unsafe(`select extract(epoch from now() - created_at) as age from public.account_deletion_requests where user_id = '${a}'`);
          check(checks, `r${r} created_at carries the request age (route's 3s min-age check reads it)`, Number(age[0].age) >= 4.5, `age=${age[0].age}`);
        });

        // Another user: the route's lookup by A's id returns nothing (→ 403), and
        // an upsert claiming A's user_id is refused by RLS WITH CHECK.
        await sql.begin(async (tx) => {
          const t = tx as unknown as Tx;
          await asUser(t, b);
          const rows = await readChallenge(t, a);
          check(checks, `r${r} other user sees 0 deletion rows for A (RLS)`, rows.length === 0, `${rows.length}`);
        });
        const forged = await sqlState(sql.begin(async (tx) => {
          const t = tx as unknown as Tx;
          await asUser(t, b);
          await armChallenge(t, a, prng.uuid(), 5_000);
        }));
        check(checks, `r${r} other user cannot upsert A's deletion row`, forged === "42501", forged);

        // authenticated has no path to the service-only checkpoint table.
        const clientRead = await sqlState(sql.begin(async (tx) => {
          const t = tx as unknown as Tx;
          await asUser(t, a);
          await t.unsafe(`select * from public.account_external_credentials where user_id = '${a}'`);
        }));
        const clientWrite = await sqlState(sql.begin(async (tx) => {
          const t = tx as unknown as Tx;
          await asUser(t, a);
          await rcCheckpoint(t, a);
        }));
        check(checks, `r${r} authenticated cannot read/write account_external_credentials`, clientRead === "42501" && clientWrite === "42501", `read=${clientRead} write=${clientWrite}`);

        // service_role: the Apple checkpoint UPDATE on a user with no row touches nothing
        // (the route only issues it when a token row exists); the RevenueCat upsert is idempotent.
        await sql.begin(async (tx) => {
          const t = tx as unknown as Tx;
          await asService(t);
          const ext0 = await t.unsafe(`select apple_refresh_token_encrypted, apple_revoked_at, revenuecat_deleted_at from public.account_external_credentials where user_id = '${a}'`);
          check(checks, `r${r} service reads 0 external rows before cleanup`, ext0.length === 0, `${ext0.length}`);
          await rcCheckpoint(t, a);
          await rcCheckpoint(t, a);
          const ext1 = await t.unsafe(`select revenuecat_deleted_at from public.account_external_credentials where user_id = '${a}'`);
          check(checks, `r${r} RevenueCat checkpoint upsert ×2 → exactly one row, marked`, ext1.length === 1 && ext1[0].revenuecat_deleted_at !== null, JSON.stringify(ext1));
          const upd = await t.unsafe(`update public.account_external_credentials set apple_revoked_at = now(), updated_at = now() where user_id = '${b}'`);
          check(checks, `r${r} Apple checkpoint update for a user without a row affects 0 rows (no error)`, (upd.count ?? 0) === 0, `${upd.count}`);
        });

        // deleteUser → cascade; a second delete (duplicate confirm after commit) is a no-op.
        const before = await rowsLeft(sql, a);
        const del1 = await deleteAuthUser(sql, a);
        const after = await rowsLeft(sql, a);
        const del2 = await deleteAuthUser(sql, a);
        check(checks, `r${r} first delete removes 1 auth user, second removes 0`, del1 === 1 && del2 === 0, `${del1},${del2}`);
        check(
          checks,
          `r${r} cascade empties profile, deletion request, external credentials`,
          before.profiles === 1 && before.deletion_requests === 1 && before.external_credentials === 1 &&
            Object.values(after).every((v) => v === 0),
          `before=${JSON.stringify(before)} after=${JSON.stringify(after)}`,
        );
        // After the cascade the ORIGINAL challenge lookup (a duplicate confirm) finds nothing →
        // the route answers 403 "not requested", not an idempotent 200.
        await sql.begin(async (tx) => {
          const t = tx as unknown as Tx;
          await asUser(t, a);
          const rows = await readChallenge(t, a);
          obs[`r${r}_duplicateAfterCommitRows`] = rows.length;
          check(checks, `r${r} duplicate confirm after commit: lookup finds 0 rows (route → 403 challenge_invalid; pinned)`, rows.length === 0, `${rows.length}`);
        });
        await sql.unsafe(`delete from auth.users where id = '${b}'`);
      }
    });
  },
});

// ─── PGD2 ────────────────────────────────────────────────────────────────────

Deno.test({
  name: "stress PGD2: duplicate delivery — N concurrent lanes run the confirm sequence for ONE user; exactly one lane deletes, no lane corrupts",
  ignore,
  async fn() {
    await scenario("pgd2_duplicate_delivery", async (sql, prng, checks, obs) => {
      const lanesOutcome: Record<string, number> = {};
      for (let r = 0; r < ROUNDS; r++) {
        const uid = prng.uuid();
        const sub = `apple-${prng.hex(16)}`;
        await createUser(sql, uid, { provider: "apple", sub });
        const spent = await spend(sql, uid, prng, 1);
        const challenge = prng.uuid();
        await sql.begin(async (tx) => {
          const t = tx as unknown as Tx;
          await asUser(t, uid);
          await armChallenge(t, uid, challenge, 5_000);
        });
        const outcomes = await burst(sql, LANES, async (tx, lane) => {
          // Each lane = one delete-confirm request: lookup (as user) → checkpoint
          // (service) → deleteUser. Lanes are separate connections, so the role
          // switch happens per statement group inside the lane's tx.
          await asUser(tx, uid);
          const rows = await readChallenge(tx, uid);
          if (rows.length === 0 || rows[0].challenge !== challenge) return { lane, outcome: "403_challenge_invalid" };
          await tx.unsafe(`reset role`);
          await asService(tx);
          const cp = await sqlState(rcCheckpoint(tx, uid));
          if (cp !== "ok") return { lane, outcome: `503_checkpoint_${cp}` };
          await tx.unsafe(`reset role`);
          const n = await deleteAuthUser(tx, uid);
          return { lane, outcome: n === 1 ? "200_deleted" : "200_already_deleted" };
        });
        const h: Record<string, number> = {};
        for (const o of outcomes) {
          h[o.outcome] = (h[o.outcome] ?? 0) + 1;
          lanesOutcome[o.outcome] = (lanesOutcome[o.outcome] ?? 0) + 1;
        }
        obs[`r${r}`] = { spent, outcomes: h };
        const left = await rowsLeft(sql, uid);
        const ledger = await ledgerCount(sql, "apple", sub);
        check(checks, `r${r} exactly one lane performed the delete`, h["200_deleted"] === 1, JSON.stringify(h));
        check(
          checks,
          `r${r} every other lane ends in a user-visible class the route maps (200 idempotent / 403 / 503)`,
          Object.keys(h).every((k) => /^(200_|403_|503_checkpoint_23503)/.test(k)),
          JSON.stringify(h),
        );
        check(checks, `r${r} nothing of the user survives; identity ledger row survives exactly once with count 1`, Object.values(left).every((v) => v === 0) && ledger.join() === "1", `left=${JSON.stringify(left)} ledger=${ledger}`);
      }
      obs.allLanes = lanesOutcome;
      // Lens observation, not an assertion: a lane whose checkpoint upsert
      // lands AFTER another lane's cascade committed hits FK 23503 (profiles
      // gone) → the route's serviceUnavailable → the user sees a retryable
      // 503 for an account that IS deleted. Recorded for the report.
      obs.fkRaceLanes = lanesOutcome["503_checkpoint_23503"] ?? 0;
    });
  },
});

// ─── PGD3 ────────────────────────────────────────────────────────────────────

Deno.test({
  name: "stress PGD3: free-rating ledger survives delete-confirm's cascade; re-created identity is paywalled under N concurrent reserves; late-linked identity inherits",
  ignore,
  async fn() {
    await scenario("pgd3_ledger_survival", async (sql, prng, checks, obs) => {
      for (let r = 0; r < ROUNDS; r++) {
        const sub = `apple-${prng.hex(16)}`;
        const oldUid = prng.uuid();
        await createUser(sql, oldUid, { provider: "apple", sub });
        const spent = await spend(sql, oldUid, prng, 3);
        const beforeAccess = await accessState(sql, oldUid);
        const ledgerBefore = await ledgerCount(sql, "apple", sub);
        check(checks, `r${r} old account: 2 accepted spends, third paywalled, ledger=2`, spent.filter((s) => s === "accepted").length === 4 && spent.includes("access.paywall_required") && ledgerBefore.join() === "2" && beforeAccess.scored_count === 2, `spent=${spent} ledger=${ledgerBefore} access=${JSON.stringify(beforeAccess)}`);

        // The route's sequence: arm, lookup, checkpoint, deleteUser.
        const challenge = prng.uuid();
        await sql.begin(async (tx) => {
          const t = tx as unknown as Tx;
          await asUser(t, oldUid);
          await armChallenge(t, oldUid, challenge, 5_000);
          const rows = await readChallenge(t, oldUid);
          assertEquals(rows[0].challenge, challenge);
          await t.unsafe(`reset role`);
          await asService(t);
          await rcCheckpoint(t, oldUid);
          await t.unsafe(`reset role`);
          assertEquals(await deleteAuthUser(t, oldUid), 1);
        });
        const left = await rowsLeft(sql, oldUid);
        const ledgerAfterDelete = await ledgerCount(sql, "apple", sub);
        check(checks, `r${r} cascade removed every account row but the identity ledger row stays at 2`, Object.values(left).every((v) => v === 0) && ledgerAfterDelete.join() === "2", `left=${JSON.stringify(left)} ledger=${ledgerAfterDelete}`);

        // Re-create with the SAME Apple subject → N concurrent reserves must all paywall.
        const newUid = prng.uuid();
        await createUser(sql, newUid, { provider: "apple", sub }, { keepLedger: true });
        const results = await burst(sql, LANES, async (tx, lane) => {
          await asUser(tx, newUid);
          const p = await tx.unsafe(`select x.result from public.reserve_analysis_permit('re-${r}-${lane}-${prng.hex(8)}') x`);
          return String(p[0].result);
        });
        const h: Record<string, number> = {};
        for (const x of results) h[x] = (h[x] ?? 0) + 1;
        const access = await accessState(sql, newUid);
        const leftNew = await rowsLeft(sql, newUid);
        obs[`r${r}_recreated`] = { reserves: h, access };
        check(checks, `r${r} re-created identity: all ${LANES} concurrent reserves paywalled, 0 permits, scored_count=2`, h["access.paywall_required"] === LANES && leftNew.permits === 0 && access.scored_count === 2, `${JSON.stringify(h)} permits=${leftNew.permits} access=${JSON.stringify(access)}`);

        // Late-linked identity (20260905000100): a brand-new Google identity linked
        // to this account inherits the account's lifetime count.
        const gsub = `g-${prng.hex(16)}`;
        await sql.unsafe(`delete from public.free_rating_ledger where identity_hash = public.free_rating_identity_hash('google', '${gsub}')`);
        await sql.unsafe(`insert into auth.identities (provider, provider_id, user_id, identity_data) values ('google', '${gsub}', '${newUid}', '{"sub":"${gsub}"}')`);
        const linked = await ledgerCount(sql, "google", gsub);
        check(checks, `r${r} late-linked Google identity inherits lifetime count 2`, linked.join() === "2", `${linked}`);

        // Known limit (AGENTS.md): a DIFFERENT provider subject on a fresh account is a fresh identity.
        const freshUid = prng.uuid();
        const freshSub = `apple-${prng.hex(16)}`;
        await createUser(sql, freshUid, { provider: "apple", sub: freshSub });
        const freshAccess = await accessState(sql, freshUid);
        obs[`r${r}_differentSubjectScoredCount`] = freshAccess.scored_count;
        check(checks, `r${r} different subject is a fresh identity (documented limit) scored_count=0`, freshAccess.scored_count === 0, `${freshAccess.scored_count}`);
        await sql.unsafe(`delete from auth.users where id in ('${newUid}', '${freshUid}')`);
      }
    });
  },
});

// ─── PGD4 ────────────────────────────────────────────────────────────────────

Deno.test({
  name: "stress PGD4: stale deletion-request sweep (pg_cron body) removes only requests expired >1 day; live challenges stay",
  ignore,
  async fn() {
    await scenario("pgd4_sweep", async (sql, prng, checks, obs) => {
      const users: Array<{ id: string; kind: string }> = [];
      for (let i = 0; i < LANES; i++) {
        const id = prng.uuid();
        const kind = prng.pick(["live", "expired_recent", "expired_old"] as const);
        await createUser(sql, id, { provider: "google", sub: `g-${prng.hex(16)}` });
        const expires = kind === "live"
          ? "now() + interval '10 minutes'"
          : kind === "expired_recent"
          ? "now() - interval '2 hours'"
          : "now() - interval '2 days'";
        await sql.unsafe(`insert into public.account_deletion_requests (user_id, challenge, created_at, expires_at) values ('${id}', gen_random_uuid(), now() - interval '20 minutes', ${expires})`);
        users.push({ id, kind });
      }
      const swept = await sql.unsafe(`delete from public.account_deletion_requests where expires_at < now() - interval '1 day'`);
      const remaining = await sql.unsafe(`select user_id from public.account_deletion_requests where user_id in (${users.map((u) => `'${u.id}'`).join(",")})`);
      const remainingIds = new Set(remaining.map((r) => String(r.user_id)));
      const expectedGone = users.filter((u) => u.kind === "expired_old");
      obs.kinds = users.map((u) => u.kind);
      check(checks, "sweep removed exactly the >1-day-expired rows", (swept.count ?? 0) === expectedGone.length && expectedGone.every((u) => !remainingIds.has(u.id)), `swept=${swept.count} expectedGone=${expectedGone.length}`);
      check(checks, "live and recently-expired rows remain (route still answers 403 expired for the latter)", users.filter((u) => u.kind !== "expired_old").every((u) => remainingIds.has(u.id)), `remaining=${remaining.length}`);
      await sql.unsafe(`delete from auth.users where id in (${users.map((u) => `'${u.id}'`).join(",")})`);
    });
  },
});
