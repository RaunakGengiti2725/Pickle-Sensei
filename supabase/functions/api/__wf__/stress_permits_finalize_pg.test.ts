/**
 * stress — POST /v1/analysis-permits/:id/finalize over a REAL Postgres.
 *
 * stress_permits_finalize_fuzz.test.ts proves the handler over a modelled
 * PostgREST. This file runs the SAME real handler (index.ts, in-process) but
 * forwards its supabase-js traffic to a real PostgREST in front of a disposable
 * postgres:16 with supabase/tests/shim_auth.sql + every migration applied
 * (./stress_permits_finalize_pg_up.sh), so the route's SELECT / guarded PATCH /
 * rpc/access_state meet real RLS, the real `grant update (status, outcome)`,
 * the real reserve_analysis_permit / apply_synced_shot RPCs and the
 * free_rating_ledger trigger. Auth is still the in-memory fake GoTrue (the
 * bearer is HS256-signed with the local PostgREST secret so PostgREST accepts
 * it as role `authenticated` with the user's `sub`).
 *
 *   ./stress_permits_finalize_pg_up.sh            # prints the three env vars
 *   STRESS_PG_URL=… STRESS_POSTGREST_URL=… STRESS_JWT_SECRET=… \
 *   STRESS_OUT_DIR=/tmp/stress/ deno test -A --no-check --config deno.json stress_permits_finalize_pg.test.ts
 *
 * Without the env vars every test is `ignore`d — an ignored run is NOT a pass.
 *
 * Scenarios (each seeded; every user id / key / outcome derives from STRESS_SEED):
 *   PG1  lifecycle on a permit minted by the real reserve RPC: release → 200 and
 *        the row is finalized; same-outcome replay → 200 with updated_at
 *        UNCHANGED (no second write); other outcome → 409, row unchanged;
 *        access_state() reserved_count drops; a released permit frees the slot
 *        (a new reserve succeeds) and spends no free rating.
 *   PG2  free-rating double-spend: scored consumption via apply_synced_shot,
 *        then a release attempt on the consumed permit → 409 and the ledger,
 *        shots and access.freeRatings.used are untouched; a released permit
 *        never decrements the count; at 2 lifetime scored the RPC refuses.
 *   PG3  cross-user: user B's bearer on user A's permit → 404, row untouched
 *        (user filter + RLS both hold on the real table).
 *   PG4  N concurrent identical releases of ONE permit → every lane 200, exactly
 *        one PATCH mutated (the rest see a zero-row guarded update — 200 `[]`
 *        on PostgREST >= 10, 404 `[]` on <= 9; STRESS_PGRST_IMAGE picks).
 *   PG5  N concurrent CONFLICTING releases → lanes matching the DB winner 200,
 *        the rest 409, exactly one mutation, row == winner.
 *   PG6  release lanes racing apply_synced_shot(scored) lanes on ONE permit →
 *        never both a shot and a released outcome; at most one shot; every
 *        release lane 200-or-409 with the DB row as the single source of truth.
 *   PG7  STRESS_PG_ITER seeded boundary requests (bad ids, unknown ids, other
 *        user's ids, bad bodies, oversize, scored/ratingId, replay, conflict;
 *        a fresh user fixture every 200 requests keeps the campaign under the
 *        route's own 240/60 s per-user budget)
 *        → only the documented statuses, generic 5xx (none expected), request
 *        id present, and the analysis_permits table byte-identical after every
 *        rejected request.
 */
import postgres from "postgres";
import { assertEquals } from "@std/assert";
import {
  auditResponse,
  buildRequest,
  envInt,
  histogram,
  iterationSeed,
  Prng,
  RELEASABLE_OUTCOMES,
  REQUEST_ID_RE,
  type ResponseAudit,
  type StressHarness,
  withStressHarness,
  writeJson,
} from "./stress_permits_finalize_harness.ts";
import { captureAccessLog } from "../http.ts";

const PG_URL = Deno.env.get("STRESS_PG_URL") ?? Deno.env.get("XC_PG_URL") ?? "";
const PGRST_URL = Deno.env.get("STRESS_POSTGREST_URL") ?? "";
const JWT_SECRET = Deno.env.get("STRESS_JWT_SECRET") ?? "";
const ignore = !(PG_URL && PGRST_URL && JWT_SECRET);

const STRESS_SEED = envInt("STRESS_SEED", 20260905);
const PG_LANES = envInt("STRESS_PG_LANES", 12);
const PG_ITER = envInt("STRESS_PG_ITER", 60);
/** PG7 requests per user fixture — kept under the route's per-user budget
 * (240/60 s); each fixture also gets its own source IP so the per-IP budget
 * (1200/60 s) never trips either. A long campaign then measures the route,
 * not its rate limiter (which C6 in the fuzz file covers on purpose). */
const PG7_PER_USER = 200;
const chunkIp = (chunk: number): string => `203.0.113.${(chunk % 250) + 1}`;

type Sql = ReturnType<typeof postgres>;
type Tx = Parameters<Parameters<Sql["begin"]>[1]>[0];

interface PermitRow {
  id: string;
  user_id: string;
  status: string;
  outcome: string | null;
  updated_at: string;
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

function shotPayload(
  id: string,
  analysisPermitId: string,
): Record<string, unknown> {
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

async function asUser(tx: Tx, userId: string): Promise<void> {
  await tx.unsafe(`set local role authenticated`);
  await tx.unsafe(`set local request.jwt.claim.sub = '${userId}'`);
}

/** Owner-role fixture: an auth.users row (handle_new_user mints the profile)
 * plus its sign-in identity. Seeded ids repeat across runs against the same
 * disposable DB, so leftovers from an earlier run with this seed are removed
 * first — including the identity's ledger row, which survives the cascade by
 * design. */
async function createUser(
  sql: Sql,
  userId: string,
  provider: "google" | "apple",
  sub: string,
) {
  await sql.unsafe(`delete from auth.users where id = '${userId}'`);
  await sql.unsafe(
    `delete from auth.users u using auth.identities i
      where i.user_id = u.id and i.provider = '${provider}' and i.provider_id = '${sub}'`,
  );
  await sql.unsafe(
    `delete from public.free_rating_ledger
      where identity_hash = public.free_rating_identity_hash('${provider}', '${sub}')`,
  );
  await sql.unsafe(
    `insert into auth.users (id, email, raw_app_meta_data)
      values ('${userId}', '${userId}@example.com', '{"provider":"${provider}"}')`,
  );
  await sql.unsafe(
    `insert into auth.identities (provider, provider_id, user_id, identity_data)
      values ('${provider}', '${sub}', '${userId}', '{"sub":"${sub}"}')`,
  );
}

async function reserve(
  sql: Sql,
  userId: string,
  key: string,
): Promise<{ result: string; permitId: string | null }> {
  return await sql.begin(async (tx) => {
    await asUser(tx as unknown as Tx, userId);
    const r = await tx.unsafe(
      `select x.result, x.permit_id::text as permit_id from public.reserve_analysis_permit('${key}') x`,
    );
    return {
      result: String(r[0].result),
      permitId: r[0].permit_id ? String(r[0].permit_id) : null,
    };
  });
}

async function applyScored(
  sql: Sql,
  userId: string,
  shotId: string,
  permitId: string,
): Promise<string> {
  return await sql.begin(async (tx) => {
    await asUser(tx as unknown as Tx, userId);
    const r = await tx.unsafe(
      `select public.apply_synced_shot($1::text::jsonb) as result`,
      [
        JSON.stringify(shotPayload(shotId, permitId)),
      ],
    );
    return String(r[0].result);
  });
}

async function permitRow(
  sql: Sql,
  permitId: string,
): Promise<PermitRow | null> {
  const r = await sql.unsafe(
    `select id::text, user_id::text, status, outcome, updated_at::text from public.analysis_permits where id = '${permitId}'`,
  );
  return r.length ? (r[0] as unknown as PermitRow) : null;
}

async function accessState(
  sql: Sql,
  userId: string,
): Promise<{ premium: boolean; scored: number; reserved: number }> {
  return await sql.begin(async (tx) => {
    await asUser(tx as unknown as Tx, userId);
    const r = await tx.unsafe(
      `select premium, scored_count, reserved_count from public.access_state()`,
    );
    return {
      premium: Boolean(r[0].premium),
      scored: Number(r[0].scored_count),
      reserved: Number(r[0].reserved_count),
    };
  });
}

async function ledgerCount(
  sql: Sql,
  provider: string,
  sub: string,
): Promise<number> {
  const r = await sql.unsafe(
    `select coalesce((select scored_count from public.free_rating_ledger
       where identity_hash = public.free_rating_identity_hash('${provider}', '${sub}')), 0)::int as n`,
  );
  return Number(r[0].n);
}

async function shotCount(sql: Sql, userId: string): Promise<number> {
  const r = await sql.unsafe(
    `select count(*)::int as n from public.shots where user_id = '${userId}'`,
  );
  return Number(r[0].n);
}

/** Whole-table fingerprint for the users under test: proves "no write on rejection". */
async function fingerprint(sql: Sql, userIds: string[]): Promise<string> {
  const list = userIds.map((u) => `'${u}'`).join(",");
  const r = await sql.unsafe(
    `select coalesce(string_agg(id::text || ':' || status || ':' || coalesce(outcome,'∅') || ':' || updated_at::text, '|' order by id), '') as fp
       from public.analysis_permits where user_id in (${list})`,
  );
  return String(r[0].fp);
}

interface Ctx {
  sql: Sql;
  /** `Server` header of the real PostgREST (e.g. `postgrest/12.2.12`) — recorded in every artifact. */
  postgrestVersion: string;
  send: (
    bearer: string,
    permitId: string,
    body: string | Uint8Array | undefined,
    extra?: Record<string, string>,
    pathOverride?: string,
  ) => Promise<ResponseAudit>;
  bearerFor: (userId: string, provider?: "google" | "apple") => Promise<string>;
  patchStats: () => { total: number; mutated: number; noRow: number };
  /** Every forwarded PostgREST call since the last reset (method, path, status, body head). */
  restCalls: () => Array<Record<string, unknown>>;
  resetCalls: () => void;
  /** `[api] …` console lines the handler emitted since the last reset (its
   * unhandled-error line carries the request id, so 5xx lanes can be matched). */
  serverLog: () => string[];
}

function withCtx(fn: (ctx: Ctx) => Promise<void>): Promise<void> {
  return withStressHarness((h) => withCtxOn(h, fn));
}

async function withCtxOn(
  h: StressHarness,
  fn: (ctx: Ctx) => Promise<void>,
): Promise<void> {
  const sql = postgres(PG_URL, {
    max: Math.max(PG_LANES + 4, 8),
    onnotice: () => undefined,
  });
  h.fake.reset(STRESS_SEED, 0);
  await h.fake.useJwtSecret(JWT_SECRET);
  h.fake.postgrestUrl = PGRST_URL;
  const restore = captureAccessLog(() => undefined);
  const probe = await h.realFetch(`${PGRST_URL}/`);
  const postgrestVersion = probe.headers.get("server") ?? "unknown";
  await probe.body?.cancel();
  const serverLines: string[] = [];
  const original = {
    log: console.log,
    error: console.error,
    warn: console.warn,
  };
  const sink = (...args: unknown[]) => {
    serverLines.push(
      args.map((
        a,
      ) => (typeof a === "string"
        ? a
        : a instanceof Error
        ? `${a.name}: ${a.message}`
        : JSON.stringify(a))
      ).join(" "),
    );
  };
  let inFlight = 0;
  const ctx: Ctx = {
    sql,
    postgrestVersion,
    bearerFor: async (userId, provider = "google") =>
      (await h.fake.mintSession(userId, provider)).accessToken,
    send: async (bearer, permitId, body, extra = {}, pathOverride) => {
      const headers: Record<string, string> = {
        authorization: `Bearer ${bearer}`,
        "content-type": "application/json",
        "x-forwarded-for": "203.0.113.7",
        ...extra,
      };
      if (inFlight++ === 0) {
        console.error = sink;
        console.warn = sink;
        console.log = sink;
      }
      try {
        return await auditResponse(
          await h.handler(
            buildRequest({
              method: "POST",
              pathname: pathOverride ??
                `/functions/v1/api/v1/analysis-permits/${permitId}/finalize`,
              headers,
              body,
            }),
          ),
        );
      } finally {
        if (--inFlight === 0) Object.assign(console, original);
      }
    },
    patchStats: () => {
      const patches = h.fake.calls.filter((c) => c.method === "PATCH");
      return {
        total: patches.length,
        mutated: patches.filter((c) => c.mutated === 1).length,
        noRow: patches.filter((c) => c.mutated === 0).length,
      };
    },
    restCalls: () =>
      h.fake.calls.map((c) => ({
        method: c.method,
        path: new URL(c.url).pathname.replace(/^\/rest\/v1/, "") +
          new URL(c.url).search,
        status: c.status,
        mutated: c.mutated,
        body: c.upstreamBody,
      })),
    resetCalls: () => {
      h.fake.calls = [];
      serverLines.length = 0;
    },
    serverLog: () => serverLines.filter((l) => l.startsWith("[api]")),
  };
  try {
    await fn(ctx);
  } finally {
    restore();
    h.fake.postgrestUrl = null;
    await sql.end({ timeout: 5 });
  }
}

const REPLAY_HINT =
  `STRESS_SEED=${STRESS_SEED} STRESS_PG_URL=… STRESS_POSTGREST_URL=… STRESS_JWT_SECRET=… deno test -A --no-check --config deno.json stress_permits_finalize_pg.test.ts`;

function pick<T>(rng: Prng, items: readonly T[]): T {
  return items[rng.int(0, items.length - 1)];
}

Deno.test({
  name:
    `stress pg PG1–PG3: real-DB lifecycle, free-rating double-spend, cross-user (seed ${STRESS_SEED})`,
  ignore,
  async fn() {
    await withCtx(async (ctx) => {
      const { sql } = ctx;
      const problems: string[] = [];
      const report: Array<Record<string, unknown>> = [];
      const seed = iterationSeed(STRESS_SEED ^ 0x9600, 1);
      const rng = new Prng(seed);
      const userA = rng.uuid();
      const userB = rng.uuid();
      const subA = `apple-sub-${rng.uuid()}`;
      const subB = `google-sub-${rng.uuid()}`;
      await createUser(sql, userA, "apple", subA);
      await createUser(sql, userB, "google", subB);
      const bearerA = await ctx.bearerFor(userA, "apple");
      const bearerB = await ctx.bearerFor(userB, "google");

      // ── PG1 lifecycle ──
      const r1 = await reserve(sql, userA, `k1-${seed}`);
      if (r1.result !== "accepted" || !r1.permitId) {
        problems.push(`PG1 reserve → ${r1.result}`);
      }
      const p1 = r1.permitId!;
      const outcome1 = pick(rng, RELEASABLE_OUTCOMES);
      const other1 = pick(
        rng,
        RELEASABLE_OUTCOMES.filter((o) => o !== outcome1),
      );
      const before1 = await permitRow(sql, p1);
      const stateBefore = await accessState(sql, userA);
      ctx.resetCalls();
      const a1 = await ctx.send(
        bearerA,
        p1,
        JSON.stringify({ outcome: outcome1 }),
      );
      const row1 = await permitRow(sql, p1);
      const stateAfter = await accessState(sql, userA);
      const permitBody = (a1.body?.permit ?? null) as
        | Record<string, unknown>
        | null;
      const accessBody = (a1.body?.access ?? null) as
        | Record<string, unknown>
        | null;
      const free = (accessBody?.freeRatings ?? null) as
        | Record<string, unknown>
        | null;
      const ok1 = a1.status === 200 &&
        REQUEST_ID_RE.test(a1.requestId ?? "") &&
        a1.leaks.length === 0 &&
        row1?.status === "finalized" &&
        row1?.outcome === outcome1 &&
        row1.updated_at !== before1?.updated_at &&
        permitBody?.status === "finalized" &&
        permitBody?.outcome === outcome1 &&
        stateBefore.reserved === 1 &&
        stateAfter.reserved === 0 &&
        stateAfter.scored === 0 &&
        free?.used === 0 &&
        free?.reserved === 0 &&
        free?.availableToReserve === 2 &&
        ctx.patchStats().mutated === 1;
      if (!ok1) {
        problems.push(
          `PG1 release: status=${a1.status} row=${JSON.stringify(row1)} state=${
            JSON.stringify(stateAfter)
          } free=${JSON.stringify(free)} patch=${
            JSON.stringify(ctx.patchStats())
          } leaks=${a1.leaks.join(";")}`,
        );
      }
      report.push({
        scenario: "PG1 release",
        seed,
        permit: p1,
        outcome: outcome1,
        status: a1.status,
        row: row1,
        access: stateAfter,
        patches: ctx.patchStats(),
      });

      // same-outcome replay: 200, NO write (updated_at frozen), no PATCH at all
      ctx.resetCalls();
      const a1r = await ctx.send(
        bearerA,
        p1,
        JSON.stringify({ outcome: outcome1 }),
      );
      const row1r = await permitRow(sql, p1);
      const ok1r = a1r.status === 200 &&
        row1r?.updated_at === row1?.updated_at &&
        ctx.patchStats().total === 0 && a1r.leaks.length === 0;
      if (!ok1r) {
        problems.push(
          `PG1 replay: status=${a1r.status} updated_at ${row1?.updated_at} → ${row1r?.updated_at} patches=${ctx.patchStats().total}`,
        );
      }
      report.push({
        scenario: "PG1 same-outcome replay",
        status: a1r.status,
        updatedAtFrozen: row1r?.updated_at === row1?.updated_at,
        patches: ctx.patchStats(),
      });

      // conflicting replay: 409, row untouched
      ctx.resetCalls();
      const a1c = await ctx.send(
        bearerA,
        p1,
        JSON.stringify({ outcome: other1 }),
      );
      const row1c = await permitRow(sql, p1);
      const ok1c = a1c.status === 409 &&
        a1c.errorCode === "access.permit_already_finalized" &&
        row1c?.outcome === outcome1 && row1c?.updated_at === row1?.updated_at &&
        ctx.patchStats().total === 0;
      if (!ok1c) {
        problems.push(
          `PG1 conflict: status=${a1c.status} code=${a1c.errorCode} row=${
            JSON.stringify(row1c)
          } patches=${ctx.patchStats().total}`,
        );
      }
      report.push({
        scenario: "PG1 conflicting replay",
        status: a1c.status,
        code: a1c.errorCode,
        rowUnchanged: row1c?.updated_at === row1?.updated_at,
      });

      // a released permit frees the slot and spends nothing: a fresh reserve succeeds
      const r1b = await reserve(sql, userA, `k1b-${seed}`);
      const state1b = await accessState(sql, userA);
      if (
        r1b.result !== "accepted" || state1b.reserved !== 1 ||
        state1b.scored !== 0
      ) {
        problems.push(
          `PG1 re-reserve after release → ${r1b.result} state=${
            JSON.stringify(state1b)
          }`,
        );
      }
      report.push({
        scenario: "PG1 reserve after release",
        result: r1b.result,
        access: state1b,
      });

      // ── PG2 double-spend ──
      // p1b is reserved; consume it as SCORED through the real RPC.
      const p2a = r1b.permitId!;
      const shotA = rng.uuid();
      const apply2a = await applyScored(sql, userA, shotA, p2a);
      const ledger2a = await ledgerCount(sql, "apple", subA);
      const shots2a = await shotCount(sql, userA);
      if (apply2a !== "accepted" || ledger2a !== 1 || shots2a !== 1) {
        problems.push(
          `PG2 scored consume → ${apply2a} ledger=${ledger2a} shots=${shots2a}`,
        );
      }
      // release attempt on a consumed (scored) permit → 409, nothing moves
      ctx.resetCalls();
      const fpBefore2 = await fingerprint(sql, [userA]);
      const a2 = await ctx.send(
        bearerA,
        p2a,
        JSON.stringify({ outcome: pick(rng, RELEASABLE_OUTCOMES) }),
      );
      const fpAfter2 = await fingerprint(sql, [userA]);
      const row2 = await permitRow(sql, p2a);
      const ok2 = a2.status === 409 &&
        a2.errorCode === "access.permit_already_finalized" &&
        /scored/.test(a2.errorMessage ?? "") &&
        fpBefore2 === fpAfter2 &&
        row2?.status === "finalized" &&
        row2?.outcome === "scored" &&
        ctx.patchStats().total === 0 &&
        (await ledgerCount(sql, "apple", subA)) === 1 &&
        (await shotCount(sql, userA)) === 1;
      if (!ok2) {
        problems.push(
          `PG2 release-after-scored: status=${a2.status} code=${a2.errorCode} row=${
            JSON.stringify(row2)
          } fpSame=${fpBefore2 === fpAfter2} patches=${ctx.patchStats().total}`,
        );
      }
      report.push({
        scenario: "PG2 release attempt on scored permit",
        status: a2.status,
        code: a2.errorCode,
        row: row2,
        tableUnchanged: fpBefore2 === fpAfter2,
        ledger: await ledgerCount(sql, "apple", subA),
      });

      // second free rating: reserve → release (route) → reserve again → scored; then the RPC refuses a 3rd
      const r2b = await reserve(sql, userA, `k2b-${seed}`);
      const a2b = await ctx.send(
        bearerA,
        r2b.permitId!,
        JSON.stringify({ outcome: "cancelled" }),
      );
      const free2b = ((a2b.body?.access as Record<string, unknown> | undefined)
        ?.freeRatings ?? null) as Record<string, unknown> | null;
      if (
        a2b.status !== 200 || free2b?.used !== 1 ||
        free2b?.availableToReserve !== 1
      ) {
        problems.push(
          `PG2 release 2nd permit: status=${a2b.status} free=${
            JSON.stringify(free2b)
          }`,
        );
      }
      report.push({
        scenario: "PG2 release second permit (rating not spent)",
        status: a2b.status,
        free: free2b,
      });
      const r2c = await reserve(sql, userA, `k2c-${seed}`);
      const apply2c = await applyScored(sql, userA, rng.uuid(), r2c.permitId!);
      const r2d = await reserve(sql, userA, `k2d-${seed}`);
      const state2d = await accessState(sql, userA);
      const ledger2d = await ledgerCount(sql, "apple", subA);
      if (
        r2c.result !== "accepted" || apply2c !== "accepted" ||
        r2d.result !== "access.paywall_required" || state2d.scored !== 2 ||
        ledger2d !== 2
      ) {
        problems.push(
          `PG2 limit: reserve3=${r2c.result} apply3=${apply2c} reserve4=${r2d.result} state=${
            JSON.stringify(state2d)
          } ledger=${ledger2d}`,
        );
      }
      // releasing the (already scored) permit p2c must not hand a rating back
      const a2d = await ctx.send(
        bearerA,
        r2c.permitId!,
        JSON.stringify({ outcome: "failed" }),
      );
      const r2e = await reserve(sql, userA, `k2e-${seed}`);
      const state2e = await accessState(sql, userA);
      if (
        a2d.status !== 409 || r2e.result !== "access.paywall_required" ||
        state2e.scored !== 2 || (await ledgerCount(sql, "apple", subA)) !== 2
      ) {
        problems.push(
          `PG2 no refund: release=${a2d.status} reserve5=${r2e.result} state=${
            JSON.stringify(state2e)
          }`,
        );
      }
      report.push({
        scenario: "PG2 lifetime limit + no refund via release",
        reserve3: r2c.result,
        apply3: apply2c,
        reserve4: r2d.result,
        releaseScored: a2d.status,
        reserve5: r2e.result,
        access: state2e,
        ledger: await ledgerCount(sql, "apple", subA),
      });

      // ── PG3 cross-user ──
      const r3 = await reserve(sql, userB, `k3-${seed}`);
      const p3 = r3.permitId!;
      const fp3 = await fingerprint(sql, [userA, userB]);
      ctx.resetCalls();
      const a3 = await ctx.send(
        bearerA,
        p3,
        JSON.stringify({ outcome: "cancelled" }),
      );
      const fp3b = await fingerprint(sql, [userA, userB]);
      const row3 = await permitRow(sql, p3);
      const ok3 = a3.status === 404 &&
        a3.errorCode === "access.permit_not_found" && fp3 === fp3b &&
        row3?.status === "reserved" && ctx.patchStats().total === 0;
      if (!ok3) {
        problems.push(
          `PG3 cross-user: status=${a3.status} code=${a3.errorCode} row=${
            JSON.stringify(row3)
          } tableSame=${fp3 === fp3b}`,
        );
      }
      // and B can still release it
      const a3b = await ctx.send(
        bearerB,
        p3,
        JSON.stringify({ outcome: "cancelled" }),
      );
      if (a3b.status !== 200) {
        problems.push(`PG3 owner release after foreign attempt: ${a3b.status}`);
      }
      report.push({
        scenario: "PG3 cross-user",
        foreign: a3.status,
        foreignCode: a3.errorCode,
        tableUnchanged: fp3 === fp3b,
        ownerAfter: a3b.status,
      });

      const path = await writeJson("pg_lifecycle_results.json", {
        seed: STRESS_SEED,
        scenarioSeed: seed,
        postgrest: ctx.postgrestVersion,
        replay: REPLAY_HINT,
        problems,
        report,
      });
      console.log(
        `[stress pg PG1–PG3] ${report.length} checks, ${problems.length} problem(s) → ${path}`,
      );
      assertEquals(problems, []);
    });
  },
});

Deno.test({
  name:
    `stress pg PG4–PG6: ${PG_LANES} concurrent lanes on ONE real permit — duplicates, conflicts, release-vs-scored race (seed ${STRESS_SEED})`,
  ignore,
  async fn() {
    await withCtx(async (ctx) => {
      const { sql } = ctx;
      const problems: string[] = [];
      const report: Array<Record<string, unknown>> = [];

      for (const scenario of ["PG4", "PG5", "PG6"] as const) {
        const seed = iterationSeed(
          STRESS_SEED ^ 0x9600,
          scenario === "PG4" ? 4 : scenario === "PG5" ? 5 : 6,
        );
        const rng = new Prng(seed);
        const userId = rng.uuid();
        const sub = `sub-${rng.uuid()}`;
        await createUser(sql, userId, "google", sub);
        const bearer = await ctx.bearerFor(userId);
        const r = await reserve(sql, userId, `k-${scenario}-${seed}`);
        if (r.result !== "accepted" || !r.permitId) {
          problems.push(`${scenario} reserve → ${r.result}`);
          continue;
        }
        const permitId = r.permitId;
        ctx.resetCalls();

        if (scenario === "PG6") {
          const releaseLanes = Math.ceil(PG_LANES / 2);
          const applyLanes = PG_LANES - releaseLanes;
          const outcome = pick(rng, RELEASABLE_OUTCOMES);
          const shotIds = Array.from({ length: applyLanes }, () => rng.uuid());
          const results = await Promise.all([
            ...Array.from({ length: releaseLanes }, async (_, lane) => ({
              lane,
              kind: "release",
              result: String(
                (await ctx.send(bearer, permitId, JSON.stringify({ outcome }), {
                  "x-forwarded-for": `198.51.100.${lane + 1}`,
                })).status,
              ),
            })),
            ...shotIds.map(async (shotId, i) => ({
              lane: releaseLanes + i,
              kind: "apply_synced_shot",
              result: await applyScored(sql, userId, shotId, permitId),
            })),
          ]);
          const row = await permitRow(sql, permitId);
          const shots = await shotCount(sql, userId);
          const ledger = await ledgerCount(sql, "google", sub);
          const releases = results.filter((x) => x.kind === "release").map((
            x,
          ) => x.result);
          const applies = results.filter((x) => x.kind === "apply_synced_shot")
            .map((x) => x.result);
          const accepted = applies.filter((x) => x === "accepted").length;
          const scoredWon = row?.outcome === "scored";
          const ok = row?.status === "finalized" &&
            shots <= 1 &&
            ledger === shots &&
            accepted === shots &&
            (scoredWon
              ? shots === 1 && releases.every((s) => s === "409")
              : shots === 0 && row?.outcome === outcome && releases.every((s) =>
                s === "200" || s === "409"
              ) && releases.includes("200")) &&
            applies.every((x) =>
              x === "accepted" || x === "access.permit_not_reserved"
            ) &&
            ctx.patchStats().mutated === (scoredWon ? 0 : 1);
          if (!ok) {
            problems.push(
              `PG6 seed=${seed}: row=${
                JSON.stringify(row)
              } shots=${shots} ledger=${ledger} releases=${
                JSON.stringify(histogram(releases))
              } applies=${JSON.stringify(histogram(applies))} patches=${
                JSON.stringify(ctx.patchStats())
              } serverLog=${JSON.stringify(ctx.serverLog())}`,
            );
          }
          report.push({
            scenario: "PG6 release vs scored race",
            seed,
            permit: permitId,
            winner: row?.outcome,
            shots,
            ledger,
            releases: histogram(releases),
            applies: histogram(applies),
            patches: ctx.patchStats(),
            postgrest: ctx.restCalls(),
            serverLog: ctx.serverLog(),
          });
          continue;
        }

        const outcomes = scenario === "PG4"
          ? Array.from({ length: PG_LANES }, () => "cancelled")
          : Array.from(
            { length: PG_LANES },
            () => pick(rng, RELEASABLE_OUTCOMES),
          );
        const audits = await Promise.all(
          outcomes.map((outcome, lane) =>
            ctx.send(bearer, permitId, JSON.stringify({ outcome }), {
              "x-forwarded-for": `198.51.100.${lane + 1}`,
            })
          ),
        );
        const row = await permitRow(sql, permitId);
        const statuses = audits.map((a) => a.status);
        const patches = ctx.patchStats();
        const winners = outcomes.filter((o) => o === row?.outcome).length;
        const ok = row?.status === "finalized" &&
          patches.mutated === 1 &&
          patches.noRow === patches.total - 1 &&
          audits.every((
            a,
            i,
          ) => (outcomes[i] === row?.outcome
            ? a.status === 200
            : a.status === 409 &&
              a.errorCode === "access.permit_already_finalized")
          ) &&
          audits.every((a) =>
            a.leaks.length === 0 && REQUEST_ID_RE.test(a.requestId ?? "")
          ) &&
          statuses.filter((s) => s === 200).length === winners &&
          (await accessState(sql, userId)).reserved === 0;
        if (!ok) {
          problems.push(
            `${scenario} seed=${seed}: row=${JSON.stringify(row)} statuses=${
              JSON.stringify(histogram(statuses))
            } winners=${winners} patches=${JSON.stringify(patches)} lanes=${
              JSON.stringify(
                audits.map((a, i) => ({
                  outcome: outcomes[i],
                  status: a.status,
                  code: a.errorCode,
                  message: a.errorMessage,
                  requestId: a.requestId,
                })),
              )
            } serverLog=${JSON.stringify(ctx.serverLog())}`,
          );
        }
        report.push({
          scenario: scenario === "PG4"
            ? "PG4 identical duplicates"
            : "PG5 conflicting outcomes",
          seed,
          permit: permitId,
          lanes: PG_LANES,
          winner: row?.outcome,
          statuses: histogram(statuses),
          patches,
          laneResults: audits.map((a, i) => ({
            outcome: outcomes[i],
            status: a.status,
            code: a.errorCode,
            message: a.errorMessage,
            requestId: a.requestId,
            generic5xx: a.generic5xx,
            leaks: a.leaks,
          })),
          postgrest: ctx.restCalls(),
          serverLog: ctx.serverLog(),
        });
      }

      const path = await writeJson("pg_concurrency_results.json", {
        seed: STRESS_SEED,
        lanes: PG_LANES,
        postgrest: ctx.postgrestVersion,
        replay: REPLAY_HINT,
        problems,
        report,
      });
      console.log(
        `[stress pg PG4–PG6] ${report.length} scenarios, ${problems.length} problem(s) → ${path}`,
      );
      assertEquals(problems, []);
    });
  },
});

Deno.test({
  name:
    `stress pg PG7: ${PG_ITER} seeded boundary requests over the real PostgREST (seed ${STRESS_SEED})`,
  ignore,
  async fn() {
    await withCtx(async (ctx) => {
      const { sql } = ctx;
      const problems: string[] = [];
      const rows: Array<Record<string, unknown>> = [];

      interface Fixture {
        chunk: number;
        userA: string;
        userB: string;
        bearerA: string;
        pa1: string;
        pa2: string;
        pb1: string;
      }
      // A reserves 2 permits (the free allowance); B one. A's first is released
      // up-front so replay/conflict kinds have a settled row to hit.
      const mint = async (chunk: number): Promise<Fixture> => {
        const seed0 = iterationSeed(STRESS_SEED ^ 0x9600, 7 + chunk);
        const rng0 = new Prng(seed0);
        const userA = rng0.uuid();
        const userB = rng0.uuid();
        await createUser(sql, userA, "google", `sub-${rng0.uuid()}`);
        await createUser(sql, userB, "apple", `sub-${rng0.uuid()}`);
        const bearerA = await ctx.bearerFor(userA);
        const pa1 = (await reserve(sql, userA, `pa1-${seed0}`)).permitId!;
        const pa2 = (await reserve(sql, userA, `pa2-${seed0}`)).permitId!;
        const pb1 = (await reserve(sql, userB, `pb1-${seed0}`)).permitId!;
        const settled = await ctx.send(
          bearerA,
          pa1,
          JSON.stringify({ outcome: "cancelled" }),
          { "x-forwarded-for": chunkIp(chunk) },
        );
        if (settled.status !== 200) {
          problems.push(`PG7 chunk ${chunk} setup release → ${settled.status}`);
        }
        return { chunk, userA, userB, bearerA, pa1, pa2, pb1 };
      };
      // pa2 must still be reserved after every rejection in the chunk — prove
      // it, then release it (a real 200 closes the fixture).
      const settle = async (fx: Fixture): Promise<void> => {
        const pa2Row = await permitRow(sql, fx.pa2);
        if (pa2Row?.status !== "reserved") {
          problems.push(
            `PG7 chunk ${fx.chunk} pa2 not reserved after campaign: ${
              JSON.stringify(pa2Row)
            }`,
          );
        }
        const final = await ctx.send(
          fx.bearerA,
          fx.pa2,
          JSON.stringify({ outcome: "failed" }),
          { "x-forwarded-for": chunkIp(fx.chunk) },
        );
        if (final.status !== 200) {
          problems.push(
            `PG7 chunk ${fx.chunk} final release → ${final.status}`,
          );
        }
      };
      let fx = await mint(0);

      const kinds = [
        "bad_uuid",
        "unknown_uuid",
        "foreign_permit",
        "scored_outcome",
        "bad_outcome",
        "rating_id",
        "malformed_json",
        "oversize",
        "replay_same",
        "replay_conflict",
        "uppercase_id",
        "urlencoded_id",
      ] as const;

      for (let i = 0; i < PG_ITER; i++) {
        if (i > 0 && i % PG7_PER_USER === 0) {
          await settle(fx);
          fx = await mint(i / PG7_PER_USER);
        }
        const { userA, userB, bearerA, pa1, pa2, pb1 } = fx;
        const seed = iterationSeed(STRESS_SEED ^ 0x9607, i);
        const rng = new Prng(seed);
        const kind = pick(rng, kinds);
        let permitId = pa2;
        let body: string | Uint8Array | undefined = JSON.stringify({
          outcome: pick(rng, RELEASABLE_OUTCOMES),
        });
        let expected: number[] = [];
        let expectCode: string | null = null;
        switch (kind) {
          case "bad_uuid":
            permitId = pick(rng, [
              "not-a-uuid",
              "00000000-0000-0000-0000-00000000000",
              "'; drop table analysis_permits;--",
              "%00",
              rng.uuid().slice(0, 35) + "g",
            ]);
            expected = [400];
            expectCode = "validation.analysis_permit_finalize";
            break;
          case "unknown_uuid":
            permitId = rng.uuid();
            expected = [404];
            expectCode = "access.permit_not_found";
            break;
          case "foreign_permit":
            permitId = pb1;
            expected = [404];
            expectCode = "access.permit_not_found";
            break;
          case "scored_outcome":
            body = JSON.stringify({ outcome: "scored", ratingId: rng.uuid() });
            expected = [400];
            expectCode = "validation.analysis_permit_finalize";
            break;
          case "bad_outcome":
            body = JSON.stringify({
              outcome: pick(rng, [
                "",
                "Cancelled",
                "expired",
                "free_limit_exceeded",
                7,
                null,
                ["cancelled"],
              ]),
            });
            expected = [400];
            expectCode = "validation.analysis_permit_finalize";
            break;
          case "rating_id":
            body = JSON.stringify({
              outcome: "cancelled",
              ratingId: pick(rng, ["", rng.uuid(), 0, false]),
            });
            expected = [400];
            expectCode = "validation.analysis_permit_finalize";
            break;
          case "malformed_json":
            body = pick(rng, [
              "{",
              "outcome=cancelled",
              "[]",
              "null",
              '"cancelled"',
              "\u0000",
            ]);
            expected = [400];
            expectCode = "validation.analysis_permit_finalize";
            break;
          case "oversize":
            body = new Uint8Array(5_000_001).fill(0x20);
            expected = [413];
            break;
          case "replay_same":
            permitId = pa1;
            body = JSON.stringify({ outcome: "cancelled" });
            expected = [200];
            break;
          case "replay_conflict":
            permitId = pa1;
            body = JSON.stringify({
              outcome: pick(
                rng,
                RELEASABLE_OUTCOMES.filter((o) => o !== "cancelled"),
              ),
            });
            expected = [409];
            expectCode = "access.permit_already_finalized";
            break;
          case "uppercase_id":
            permitId = pa1.toUpperCase();
            body = JSON.stringify({ outcome: "cancelled" });
            expected = [200];
            break;
          case "urlencoded_id":
            permitId = pa1.replace(/-/g, "%2D");
            body = JSON.stringify({ outcome: "cancelled" });
            expected = [200];
            break;
        }
        const fpBefore = await fingerprint(sql, [userA, userB]);
        ctx.resetCalls();
        const audit = await ctx.send(bearerA, permitId, body, {
          "x-forwarded-for": chunkIp(fx.chunk),
        });
        const fpAfter = await fingerprint(sql, [userA, userB]);
        const patches = ctx.patchStats();
        const iterProblems: string[] = [];
        if (!expected.includes(audit.status)) {
          iterProblems.push(
            `status ${audit.status} not in ${JSON.stringify(expected)}`,
          );
        }
        if (expectCode && audit.errorCode !== expectCode) {
          iterProblems.push(`code ${audit.errorCode} ≠ ${expectCode}`);
        }
        if (audit.status >= 500 && audit.generic5xx !== true) {
          iterProblems.push("non-generic 5xx body");
        }
        if (!REQUEST_ID_RE.test(audit.requestId ?? "")) {
          iterProblems.push("x-request-id missing");
        }
        if (audit.leaks.length) {
          iterProblems.push(`leak: ${audit.leaks.join("; ")}`);
        }
        if (fpBefore !== fpAfter) iterProblems.push("analysis_permits changed");
        if (patches.mutated !== 0) {
          iterProblems.push(`PATCH mutated ${patches.mutated}`);
        }
        rows.push({
          i,
          seed,
          chunk: fx.chunk,
          kind,
          permitId: permitId.slice(0, 48),
          status: audit.status,
          code: audit.errorCode,
          requestId: audit.requestId,
          tableUnchanged: fpBefore === fpAfter,
          verdict: iterProblems.length ? "BROKEN" : "HELD",
          problems: iterProblems,
        });
        for (const p of iterProblems) {
          problems.push(`seed ${seed} [${kind}] ${p}`);
        }
      }
      await settle(fx);

      const path = await writeJson("pg_fuzz_results.json", {
        seed: STRESS_SEED,
        iterations: rows.length,
        postgrest: ctx.postgrestVersion,
        replay: REPLAY_HINT,
        verdicts: histogram(rows.map((r) => String(r.verdict))),
        statuses: histogram(rows.map((r) => Number(r.status))),
        kinds: histogram(rows.map((r) => String(r.kind))),
        problems,
        results: rows,
      });
      console.log(
        `[stress pg PG7] ${rows.length} requests → ${
          JSON.stringify(histogram(rows.map((r) => String(r.verdict))))
        } statuses=${
          JSON.stringify(histogram(rows.map((r) => Number(r.status))))
        } → ${path}`,
      );
      assertEquals(problems, []);
    });
  },
});
