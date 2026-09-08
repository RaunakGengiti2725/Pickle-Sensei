/**
 * P0-03 adversarial tests — POST /v1/shots:sync at its failure boundaries.
 *
 * Candidate: d8e5db3eb346b651e4ce04cc997178abcbed56fe. Nothing here modifies
 * production code or the candidate's own tests; every test below is an
 * attack that either holds (passes) or reproduces a break (fails with the
 * observed behaviour in the assertion message).
 *
 * Two layers are exercised together: the REAL edge handler (routesHarness,
 * PostgREST stubbed) decides what the parser forwards to the RPC, and the
 * REAL `apply_synced_shot` on a disposable postgres:16 (XC_PG_URL, see
 * ./xc_pg_up.sh) decides what the schema does with exactly that argument.
 * A payload the parser forwards but the schema refuses is reported by the
 * edge as `shot.write_failed`, which apps/mobile/src/data/sync.ts
 * (TRANSIENT_SYNC_REJECTION_CODES) retries without ever spending the row's
 * attempt budget — a permanent retry loop for that rating.
 *
 *   ATK-1  boundary payloads the parser accepts settle in the schema
 *   ATK-2  capturedAt boundary agreement (parser vs shots_captured_at_bounds)
 *   ATK-3  NUL (U+0000) in a text field the parser forwards
 *   ATK-4  partial outcome conservation (identity ledger, permit, replay)
 *   ATK-5  double submit with divergent result kinds, concurrent connections
 *   ATK-6  unauthorised roles / other user / other user's session
 *   ATK-7  duplicate shot ids inside one batch
 *   ATK-8  network failure at each server-side step of one batch
 *
 * DB-backed tests (ATK-1..6) are ignored without XC_PG_URL; ATK-7/8 always run.
 *
 *   cd supabase/functions/api/__wf__ && XC_PG_URL=$(./xc_pg_up.sh | tail -1 | sed 's/^.*=//') \
 *     deno test -A --no-check --config deno.json attack_p0_03_sync_boundaries.test.ts
 */
import postgres, { type TransactionSql } from "postgres";
import { assert, assertEquals, assertNotEquals, assertStringIncludes } from "@std/assert";
import { fakeGoogleIdToken, loadHarness, userRequest } from "./routesHarness.ts";

const PG_URL = Deno.env.get("XC_PG_URL") ?? Deno.env.get("PICKLE_AUDIT_PG_URL") ?? "";
const ignore = PG_URL === "";

type Sql = ReturnType<typeof postgres>;

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

const MAX_MS = 2_147_483_647;

// ── PG helpers (same shape as be-edge-routes-shots-rank.test.ts) ─────────────

async function withRollback(sql: Sql, fn: (tx: Sql) => Promise<void>): Promise<void> {
  try {
    await sql.begin(async (tx) => {
      await fn(tx as unknown as Sql);
      throw new Error("__rollback__");
    });
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "__rollback__") {
      throw error;
    }
  }
}

async function seedUser(tx: Sql, userId: string, identity?: { provider: string; sub: string }) {
  await tx.unsafe(
    `insert into auth.users (id, email, raw_app_meta_data) values ('${userId}', '${userId}@example.com', '{"provider":"google"}') on conflict do nothing`,
  );
  if (identity) {
    await tx.unsafe(
      `insert into auth.identities (provider, provider_id, user_id, identity_data)
       values ('${identity.provider}', '${identity.sub}', '${userId}', '{"sub":"${identity.sub}"}')`,
    );
  }
}

async function asUser(tx: Sql, userId: string): Promise<void> {
  await tx.unsafe(`select set_config('request.headers', jsonb_build_object(
    'x-pickle-api-key', public.get_api_request_key())::text, true)`);
  await tx.unsafe(`set local role authenticated`);
  await tx.unsafe(`set local request.jwt.claim.sub = '${userId}'`);
}

async function withUserTx(sql: Sql, userId: string, fn: (tx: Sql) => Promise<void>): Promise<void> {
  await withRollback(sql, async (tx) => {
    await seedUser(tx, userId);
    await asUser(tx, userId);
    await fn(tx);
  });
}

/** The argument shape the edge forwards to apply_synced_shot (index.ts
 * syncShots): flat timestamps, no `source`. */
function rpcShot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: crypto.randomUUID(),
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
    ...overrides,
  };
}

/** The wire shape the mobile client posts to POST /v1/shots:sync. */
function wireShot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: crypto.randomUUID(),
    source: "real",
    analysisPermitId: crypto.randomUUID(),
    sessionId: null,
    shotType: "dink",
    cameraView: "side",
    capturedAt: "2026-09-01T10:00:00.000Z",
    timestamps: { startMs: 0, contactMs: 100, endMs: 200 },
    resultKind: "scored",
    overallScore: 7,
    confidence: 0.9,
    phases: [],
    checkpoints: [],
    versionVector: VERSION_VECTOR,
    ...overrides,
  };
}

async function reserve(tx: Sql, key: string): Promise<string> {
  const rows = await tx.unsafe(
    `select result, permit_id from public.reserve_analysis_permit('${key}')`,
  );
  assertEquals(rows[0].result, "accepted", `reserve(${key})`);
  return String(rows[0].permit_id);
}

async function reserveResult(tx: Sql, key: string): Promise<string> {
  const rows = await tx.unsafe(`select result from public.reserve_analysis_permit('${key}')`);
  return String(rows[0].result);
}

async function apply(tx: Sql, shot: Record<string, unknown>): Promise<string> {
  const rows = await tx.unsafe(`select public.apply_synced_shot($1::text::jsonb) as status`, [
    JSON.stringify(shot),
  ]);
  return String(rows[0].status);
}

async function permitState(tx: Sql, permitId: string): Promise<string> {
  const rows = await tx.unsafe(
    `select status || '/' || coalesce(outcome, 'NULL') as s from public.analysis_permits where id = '${permitId}'`,
  );
  return rows.length === 0 ? "MISSING" : String(rows[0].s);
}

async function accessState(tx: Sql) {
  const r = await tx.unsafe(
    `select premium, scored_count, reserved_count from public.access_state()`,
  );
  return {
    premium: Boolean(r[0].premium),
    scored_count: Number(r[0].scored_count),
    reserved_count: Number(r[0].reserved_count),
  };
}

async function lifetimeScored(tx: Sql): Promise<number> {
  const r = await tx.unsafe(`select public.lifetime_scored_count() as n`);
  return Number(r[0].n);
}

/** Runs `run` inside a savepoint of `tx` and returns "OK" or the SQLSTATE
 * it raised (the savepoint keeps the enclosing transaction usable). */
async function sqlState(tx: Sql, run: (s: Sql) => Promise<unknown>): Promise<string> {
  try {
    await (tx as unknown as TransactionSql).savepoint(async (s) => {
      await run(s as unknown as Sql);
    });
    return "OK";
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" ? code : `ERR:${String(error)}`;
  }
}

// ── Edge harness helpers ─────────────────────────────────────────────────────

const h = await loadHarness();
let subject = 0;

function signIn() {
  subject += 1;
  const userId = `7b030300-0000-4000-8000-${String(subject).padStart(12, "0")}`;
  h.reset();
  h.tables.profiles = [{ id: userId, email: "u@example.com", provider: "google" }];
  h.tables.shots = [];
  h.rpcs.apply_synced_shot = "accepted";
  return { token: fakeGoogleIdToken(userId), ip: `203.0.113.${(subject % 200) + 1}`, userId };
}

interface SyncResult {
  status: number;
  body: {
    acceptedIds?: string[];
    rejected?: Array<{ id: string; code: string; message: string }>;
    error?: { code: string; message: string };
  };
}

async function syncViaEdge(auth: { token: string; ip: string }, shots: unknown[]) {
  const response = await h.handler(
    userRequest("POST", "/v1/shots:sync", { token: auth.token, ip: auth.ip, body: { shots } }),
  );
  return { status: response.status, body: await response.json() } as SyncResult;
}

/** Drives the real parser and returns the exact `shot` argument the edge
 * forwarded to the RPC for `id`, or null when the parser rejected it. */
async function forwardedRpcShot(
  wire: Record<string, unknown>,
): Promise<{ forwarded: Record<string, unknown> | null; result: SyncResult }> {
  const auth = signIn();
  const result = await syncViaEdge(auth, [wire]);
  const call = h
    .callsTo("rpc/apply_synced_shot")
    .find((c) => (c.body as { shot?: { id?: string } })?.shot?.id === wire.id);
  const forwarded = call ? ((call.body as { shot: Record<string, unknown> }).shot ?? null) : null;
  return { forwarded, result };
}

// ─────────────────────────────────────────────────────────────────────────────
// ATK-1 — boundary payloads the parser accepts must settle in the schema
// ─────────────────────────────────────────────────────────────────────────────

const ASTRAL_32 = "😀".repeat(32); // JS length 64, 32 code points
const ASCII_64 = "k".repeat(64);

function phaseAt(i: number, ms: number) {
  return { key: `p${i}`, startMs: ms, representativeMs: ms, endMs: ms, confidence: 1 };
}
function checkpointAt(i: number, score: number | null) {
  return {
    key: `c${i}`,
    score,
    confidence: 1,
    band: score === null ? "unscored" : "green",
    direction: ASCII_64,
    severity: 1,
    applicable: score !== null,
  };
}

const BOUNDARY_CASES: Array<{ name: string; wire: Record<string, unknown> }> = [
  {
    name: "int4 max on every ms field, including phases",
    wire: wireShot({
      timestamps: { startMs: MAX_MS, contactMs: MAX_MS, endMs: MAX_MS },
      phases: [phaseAt(0, MAX_MS)],
    }),
  },
  {
    name: "score/confidence/severity at their upper bounds",
    wire: wireShot({
      overallScore: 10,
      confidence: 1,
      checkpoints: [checkpointAt(0, 100)],
    }),
  },
  {
    name: "score/confidence at their lower bounds, unscored checkpoint",
    wire: wireShot({
      overallScore: 0,
      confidence: 0,
      checkpoints: [checkpointAt(0, 0), checkpointAt(1, null)],
    }),
  },
  {
    name: "values that round UP to the bound in numeric(p,s) columns",
    wire: wireShot({
      overallScore: 9.999,
      confidence: 0.99999,
      checkpoints: [{ ...checkpointAt(0, 99.9999), confidence: 0.99999, severity: 0.99999 }],
    }),
  },
  {
    name: "64-char ASCII text everywhere the parser allows 64",
    wire: wireShot({
      shotType: ASCII_64,
      phases: [{ ...phaseAt(0, 5), key: ASCII_64 }],
      checkpoints: [{ ...checkpointAt(0, 50), key: ASCII_64 }],
      versionVector: Object.fromEntries(Object.keys(VERSION_VECTOR).map((k) => [k, ASCII_64])),
    }),
  },
  {
    name: "32 astral code points (JS length 64) as shotType",
    wire: wireShot({ shotType: ASTRAL_32 }),
  },
  {
    name: "32 phases + 64 checkpoints (parser caps)",
    wire: wireShot({
      phases: Array.from({ length: 32 }, (_, i) => phaseAt(i, i)),
      checkpoints: Array.from({ length: 64 }, (_, i) => checkpointAt(i, i)),
    }),
  },
  {
    name: "capturedAt lower bound, no fraction",
    wire: wireShot({ capturedAt: "2000-01-01T00:00:00Z" }),
  },
  {
    name: "capturedAt last millisecond before the upper bound",
    wire: wireShot({ capturedAt: "2099-12-31T23:59:59.999Z" }),
  },
  {
    name: "capturedAt with 6 fractional digits (PG microsecond precision)",
    wire: wireShot({ capturedAt: "2026-01-01T00:00:00.999999Z" }),
  },
  {
    name: "contactMs null (no contact detected)",
    wire: wireShot({ timestamps: { startMs: 0, contactMs: null, endMs: 10 } }),
  },
  {
    name: "low_confidence abstention",
    wire: wireShot({ resultKind: "low_confidence", overallScore: null, confidence: 0.1 }),
  },
  {
    name: "partial (mechanics only)",
    wire: wireShot({ resultKind: "partial", overallScore: null }),
  },
];

Deno.test({
  // Every boundary payload the parser forwards must be settled by the schema
  // (never shot.write_failed).
  name: "ATK-1: parser-forwarded boundary payloads settle in apply_synced_shot",
  ignore,
  async fn() {
    const sql = postgres(PG_URL);
    const failures: string[] = [];
    try {
      for (const [i, c] of BOUNDARY_CASES.entries()) {
        const { forwarded, result } = await forwardedRpcShot(c.wire);
        assert(
          forwarded,
          `${c.name}: parser rejected — ${JSON.stringify(result.body.rejected ?? result.body)}`,
        );
        await withUserTx(
          sql,
          `7b030301-0000-4000-8000-${String(i).padStart(12, "0")}`,
          async (tx) => {
            const permitId = await reserve(tx, `atk1-${i}`);
            const status = await apply(tx, { ...forwarded, analysisPermitId: permitId });
            if (status !== "accepted") {
              failures.push(`${c.name}: ${status}`);
              return;
            }
            const stored = await tx.unsafe(
              `select result_kind from public.shots where id = '${forwarded.id}'`,
            );
            assertEquals(stored.length, 1, c.name);
            assertEquals(stored[0].result_kind, c.wire.resultKind, c.name);
            assertEquals(
              await permitState(tx, permitId),
              c.wire.resultKind === "scored" ? "finalized/scored" : `released/${c.wire.resultKind}`,
              c.name,
            );
          },
        );
      }
    } finally {
      await sql.end();
    }
    assertEquals(
      failures,
      [],
      `parser-accepted payloads the schema refused:\n${failures.join("\n")}`,
    );
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// ATK-2 — capturedAt: parser bounds vs shots_captured_at_bounds
// ─────────────────────────────────────────────────────────────────────────────

Deno.test({
  name: "ATK-2a: capturedAt — parser and shots_captured_at_bounds agree at the ms bounds",
  ignore,
  async fn() {
    const sql = postgres(PG_URL);
    try {
      const probes: Array<{ at: string; accepted: boolean }> = [
        { at: "1999-12-31T23:59:59.999Z", accepted: false },
        { at: "2000-01-01T00:00:00.000Z", accepted: true },
        { at: "2099-12-31T23:59:59.999Z", accepted: true },
        { at: "2100-01-01T00:00:00.000Z", accepted: false },
      ];
      for (const [i, p] of probes.entries()) {
        const { forwarded, result } = await forwardedRpcShot(wireShot({ capturedAt: p.at }));
        assertEquals(
          forwarded !== null,
          p.accepted,
          `parser @ ${p.at}: ${JSON.stringify(result.body)}`,
        );
        await withUserTx(
          sql,
          `7b030302-0000-4000-8000-${String(i).padStart(12, "0")}`,
          async (tx) => {
            const permitId = await reserve(tx, `atk2a-${i}`);
            const status = await apply(
              tx,
              rpcShot({ analysisPermitId: permitId, capturedAt: p.at }),
            );
            assertEquals(
              status,
              p.accepted ? "accepted" : "shot.write_failed:23514",
              `schema @ ${p.at}`,
            );
          },
        );
      }
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  // 7..9 fractional digits just below the upper bound: the parser truncates to
  // ms and forwards; timestamptz rounds to microseconds and crosses 2100-01-01.
  name: "ATK-2b: capturedAt 2099-12-31T23:59:59.9999999Z — forwarded, refused by the schema",
  ignore,
  async fn() {
    const sql = postgres(PG_URL);
    try {
      const at = "2099-12-31T23:59:59.9999999Z"; // ISO_UTC_INSTANT_RE allows (?:\.\d{1,9})?
      const { forwarded, result } = await forwardedRpcShot(wireShot({ capturedAt: at }));
      assert(forwarded, `parser rejected: ${JSON.stringify(result.body)}`);
      assertEquals(result.body.acceptedIds, [forwarded.id]);
      await withUserTx(sql, "7b030302-0000-4000-8000-00000000ffff", async (tx) => {
        const permitId = await reserve(tx, "atk2b");
        const rounded = await tx.unsafe(`select ('${at}'::timestamptz)::text as t`);
        const status = await apply(tx, { ...forwarded, analysisPermitId: permitId });
        assertEquals(
          status,
          "accepted",
          `edge forwarded capturedAt=${at} (acceptedIds echoed the id) but the schema stored it as ${
            rounded[0].t
          } and answered ${status}; the client retries this row forever (shot.write_failed is transient in sync.ts)`,
        );
      });
    } finally {
      await sql.end();
    }
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// ATK-3 — U+0000 in a text field
// ─────────────────────────────────────────────────────────────────────────────

Deno.test({
  // A NUL inside shotType passes the parser; the forwarded argument is not a
  // valid jsonb value, so the RPC call itself fails (22P05) → write_failed loop.
  name: "ATK-3: NUL (U+0000) in shotType — forwarded, not a valid jsonb argument",
  ignore,
  async fn() {
    const sql = postgres(PG_URL);
    try {
      const { forwarded, result } = await forwardedRpcShot(wireShot({ shotType: "dink\u0000" }));
      assert(forwarded, `parser rejected: ${JSON.stringify(result.body)}`);
      assertEquals(forwarded.shotType, "dink\u0000");
      await withUserTx(sql, "7b030303-0000-4000-8000-000000000001", async (tx) => {
        const permitId = await reserve(tx, "atk3");
        // What PostgREST hands the function: the request body parsed as json,
        // the `shot` member cast to the jsonb parameter type.
        const wire = JSON.stringify({ shot: { ...forwarded, analysisPermitId: permitId } });
        let status = "";
        const state = await sqlState(tx, async (s) => {
          const rows = await s.unsafe(
            `select public.apply_synced_shot(($1::text::json -> 'shot')::jsonb) as status`,
            [wire],
          );
          status = String(rows[0].status);
        });
        assertEquals(
          state,
          "OK",
          `the exact payload the edge forwarded is not a valid RPC argument (SQLSTATE ${state}); the edge maps this to shot.write_failed and the outbox retries the rating forever`,
        );
        assertEquals(status, "accepted");
      });
    } finally {
      await sql.end();
    }
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// ATK-4 — partial outcome conservation
// ─────────────────────────────────────────────────────────────────────────────

Deno.test({
  // Identity ledger, lifetime_scored_count, access_state and rank state stay
  // untouched; released/partial is terminal; replay is idempotent; both free
  // ratings remain available afterwards.
  name: "ATK-4: partial never charges and never becomes a rating",
  ignore,
  async fn() {
    const sql = postgres(PG_URL);
    const userId = "7b030304-0000-4000-8000-000000000001";
    const sub = `atk4-${crypto.randomUUID()}`;
    try {
      await withRollback(sql, async (tx) => {
        await seedUser(tx, userId, { provider: "google", sub });
        await asUser(tx, userId);

        const p1 = await reserve(tx, "atk4-p1");
        assertEquals(await accessState(tx), { premium: false, scored_count: 0, reserved_count: 1 });

        const partial = rpcShot({
          analysisPermitId: p1,
          resultKind: "partial",
          overallScore: null,
          phases: [phaseAt(0, 10)],
          checkpoints: [checkpointAt(0, 42)],
        });
        assertEquals(await apply(tx, partial), "accepted");
        assertEquals(await permitState(tx, p1), "released/partial");
        assertEquals(await lifetimeScored(tx), 0);
        assertEquals(await accessState(tx), { premium: false, scored_count: 0, reserved_count: 0 });
        const ident = await tx.unsafe(`select public.identity_scored_count() as n`);
        assertEquals(Number(ident[0].n), 0, "identity ledger must not count a partial");
        const rank = await tx.unsafe(
          `select count(*)::int as n from public.player_rank_state where user_id = '${userId}' and scored_shot_count > 0`,
        );
        assertEquals(Number(rank[0].n), 0, "rank state must not count a partial");
        const progress = await tx.unsafe(
          `select count(*)::int as n from public.progress_daily where user_id = '${userId}'`,
        );
        assertEquals(Number(progress[0].n), 0, "progress must not include a partial");

        // Replay: same id, same permit → accepted, still one row, permit unchanged.
        assertEquals(await apply(tx, partial), "accepted");
        assertEquals(
          await apply(tx, { ...partial, resultKind: "scored", overallScore: 9 }),
          "accepted",
        );
        const rows = await tx.unsafe(
          `select count(*)::int as n, min(result_kind) as k from public.shots where user_id = '${userId}'`,
        );
        assertEquals([Number(rows[0].n), rows[0].k], [1, "partial"]);
        assertEquals(await permitState(tx, p1), "released/partial");
        assertEquals(
          await lifetimeScored(tx),
          0,
          "a replay must not upgrade a partial into a rating",
        );

        // A NEW shot on the released/partial permit is refused (terminal).
        assertEquals(
          await apply(tx, rpcShot({ analysisPermitId: p1 })),
          "access.permit_not_reserved",
        );
        assertEquals(
          await apply(
            tx,
            rpcShot({ analysisPermitId: p1, resultKind: "partial", overallScore: null }),
          ),
          "access.permit_not_reserved",
        );

        // Bypassing the parser: a partial carrying a score is a table invariant
        // violation (shots_low_confidence_unscored), the permit stays usable.
        const p2 = await reserve(tx, "atk4-p2");
        assertEquals(
          await apply(
            tx,
            rpcShot({ analysisPermitId: p2, resultKind: "partial", overallScore: 5 }),
          ),
          "shot.write_failed:23514",
        );
        assertEquals(await permitState(tx, p2), "reserved/NULL");

        // Client cannot re-label released/partial into acceptable backing.
        const relabel = await sqlState(tx, async (s) => {
          await s.unsafe(
            `update public.analysis_permits set status = 'reserved', outcome = null where id = '${p1}'`,
          );
        });
        assertEquals(relabel, "23514");

        // The two free ratings are still available: p2 + p3 scored, p4 paywalled.
        assertEquals(await apply(tx, rpcShot({ analysisPermitId: p2 })), "accepted");
        const p3 = await reserve(tx, "atk4-p3");
        assertEquals(await apply(tx, rpcShot({ analysisPermitId: p3 })), "accepted");
        assertEquals(await lifetimeScored(tx), 2);
        assertEquals(
          Number((await tx.unsafe(`select public.identity_scored_count() as n`))[0].n),
          2,
        );
        assertEquals(await reserveResult(tx, "atk4-p4"), "access.paywall_required");
      });
    } finally {
      await sql.end();
    }
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// ATK-5 — double submit with divergent result kinds, real concurrency
// ─────────────────────────────────────────────────────────────────────────────

function barrier(): { gate: Promise<void>; open: () => void } {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  return { gate, open };
}

Deno.test({
  // Lane A scored and lane B partial from two connections: both accepted,
  // exactly one row, permit outcome matches the row, rating spent iff scored.
  name: "ATK-5: concurrent double submit of one shot id with divergent result kinds",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 4 });
    const users: string[] = [];
    try {
      for (let round = 0; round < 6; round++) {
        const userId = crypto.randomUUID();
        users.push(userId);
        await sql.unsafe(
          `insert into auth.users (id, email) values ('${userId}', '${userId}@example.com')`,
        );
        let permitId = "";
        await sql.begin(async (tx) => {
          await asUser(tx as unknown as Sql, userId);
          permitId = await reserve(tx as unknown as Sql, `atk5-${round}`);
        });
        const shotId = crypto.randomUUID();
        const lanes = [
          rpcShot({ id: shotId, analysisPermitId: permitId }),
          rpcShot({
            id: shotId,
            analysisPermitId: permitId,
            resultKind: "partial",
            overallScore: null,
          }),
        ];
        if (round % 2 === 1) lanes.reverse();
        const b = barrier();
        let ready = 0;
        const results: string[] = [];
        const lane = (shot: Record<string, unknown>, index: number) =>
          sql.begin(async (tx) => {
            await asUser(tx as unknown as Sql, userId);
            ready += 1;
            await b.gate;
            results[index] = await apply(tx as unknown as Sql, shot);
          });
        const all = Promise.all(lanes.map(lane));
        while (ready < lanes.length) await new Promise((r) => setTimeout(r, 1));
        b.open();
        await all;

        assertEquals(results, ["accepted", "accepted"], `round ${round}`);
        const rows = await sql.unsafe(
          `select result_kind, overall_score::text as score from public.shots where id = '${shotId}'`,
        );
        assertEquals(rows.length, 1, `round ${round}: exactly one row`);
        const kind = String(rows[0].result_kind);
        const permit = await sql.unsafe(
          `select status, outcome from public.analysis_permits where id = '${permitId}'`,
        );
        assertEquals(
          `${permit[0].status}/${permit[0].outcome}`,
          kind === "scored" ? "finalized/scored" : "released/partial",
          `round ${round}: permit follows the winning row`,
        );
        if (kind === "partial") assertEquals(rows[0].score, null, `round ${round}`);
        let state = { premium: false, scored_count: -1, reserved_count: -1 };
        await sql.begin(async (tx) => {
          await asUser(tx as unknown as Sql, userId);
          state = await accessState(tx as unknown as Sql);
        });
        assertEquals(state, {
          premium: false,
          scored_count: kind === "scored" ? 1 : 0,
          reserved_count: 0,
        });
      }
    } finally {
      for (const u of users) await sql.unsafe(`delete from auth.users where id = '${u}'`);
      await sql.end();
    }
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// ATK-6 — unauthorised roles, other user, other user's session
// ─────────────────────────────────────────────────────────────────────────────

Deno.test({
  // anon has no EXECUTE on the sync surfaces; owner/service without a JWT sub
  // is auth.required; another user cannot use, see or replay Alice's permit /
  // shot / session and Alice's state is untouched.
  name: "ATK-6: unauthorised roles and cross-user paths on the sync surfaces",
  ignore,
  async fn() {
    const sql = postgres(PG_URL);
    const ALICE = "7b030306-0000-4000-8000-00000000000a";
    const BOB = "7b030306-0000-4000-8000-00000000000b";
    try {
      // anon: every surface the edge's per-user client calls is denied.
      await withRollback(sql, async (tx) => {
        await tx.unsafe(`set local role anon`);
        const anonCalls = [
          `select public.apply_synced_shot('{}'::jsonb)`,
          `select public.reserve_analysis_permit('k')`,
          `select public.permit_tombstoned('${crypto.randomUUID()}')`,
          `select public.permit_backs_sync('reserved', null)`,
          `select public.lifetime_scored_count()`,
          `select * from public.access_state()`,
          `select count(*) from public.analysis_permits`,
          `select count(*) from public.shots`,
        ];
        for (const call of anonCalls) {
          const state = await sqlState(tx, async (s) => {
            await s.unsafe(call);
          });
          assertEquals(state, "42501", call);
        }
      });
      // owner/service role without a JWT sub: typed auth.required, nothing written.
      await withRollback(sql, async (tx) => {
        assertEquals(
          await apply(tx, rpcShot({ analysisPermitId: crypto.randomUUID() })),
          "auth.required",
        );
        assertEquals(await reserveResult(tx, "atk6-owner"), "auth.required");
      });
      // Cross-user matrix inside one rolled-back transaction.
      await withRollback(sql, async (tx) => {
        await seedUser(tx, ALICE);
        await seedUser(tx, BOB);
        const aliceSession = crypto.randomUUID();
        await tx.unsafe(
          `insert into public.sessions (id, user_id, started_at) values ('${aliceSession}', '${ALICE}', now())`,
        );
        await asUser(tx, ALICE);
        const aliceReserved = await reserve(tx, "atk6-alice-reserved");
        const aliceConsumed = await reserve(tx, "atk6-alice-consumed");
        const aliceShot = rpcShot({ analysisPermitId: aliceConsumed, sessionId: aliceSession });
        assertEquals(await apply(tx, aliceShot), "accepted");
        assertEquals(await lifetimeScored(tx), 1);

        await tx.unsafe(`set local request.jwt.claim.sub = '${BOB}'`);
        const bobPermit = await reserve(tx, "atk6-bob");
        // Bob names Alice's live permit: not found (no existence leak), no row.
        assertEquals(
          await apply(tx, rpcShot({ analysisPermitId: aliceReserved })),
          "access.permit_not_found",
        );
        // Bob names Alice's consumed permit: same answer (no consumed/live oracle).
        assertEquals(
          await apply(tx, rpcShot({ analysisPermitId: aliceConsumed })),
          "access.permit_not_found",
        );
        assertEquals(
          Number(
            (await tx.unsafe(`select public.permit_tombstoned('${aliceConsumed}')::int as t`))[0].t,
          ),
          0,
        );
        // Bob replays Alice's shot id under his own permit: permanent conflict,
        // his permit stays reserved (retry with a fresh id still works).
        assertEquals(
          await apply(tx, { ...aliceShot, analysisPermitId: bobPermit, sessionId: null }),
          "shot.id_conflict",
        );
        assertEquals(await permitState(tx, bobPermit), "reserved/NULL");
        // Bob names Alice's session: not found, permit untouched.
        assertEquals(
          await apply(tx, rpcShot({ analysisPermitId: bobPermit, sessionId: aliceSession })),
          "shot.session_not_found",
        );
        assertEquals(await permitState(tx, bobPermit), "reserved/NULL");
        // Bob cannot see or move Alice's permits/shots through the grants.
        const visible = await tx.unsafe(
          `select count(*)::int as n from public.analysis_permits where user_id = '${ALICE}'`,
        );
        assertEquals(Number(visible[0].n), 0);
        const moved = await tx.unsafe(
          `update public.analysis_permits set status = 'released', outcome = 'cancelled' where id = '${aliceReserved}'`,
        );
        assertEquals(moved.count, 0);
        assertEquals(await lifetimeScored(tx), 0, "Bob's count is his own");

        // Alice's state is byte-for-byte untouched.
        await tx.unsafe(`set local request.jwt.claim.sub = '${ALICE}'`);
        assertEquals(await permitState(tx, aliceReserved), "reserved/NULL");
        assertEquals(await permitState(tx, aliceConsumed), "finalized/scored");
        assertEquals(await accessState(tx), { premium: false, scored_count: 1, reserved_count: 1 });
        const own = await tx.unsafe(
          `select count(*)::int as n from public.shots where id = '${aliceShot.id}' and user_id = '${ALICE}'`,
        );
        assertEquals(Number(own[0].n), 1);
      });
      // authenticated WITHOUT the API request key (a direct PostgREST caller
      // that is not the edge function): nothing is reserved or written.
      await withRollback(sql, async (tx) => {
        await seedUser(tx, ALICE);
        await tx.unsafe(`set local role authenticated`);
        await tx.unsafe(`set local request.jwt.claim.sub = '${ALICE}'`);
        const reserved = await sqlState(tx, async (s) => {
          assertNotEquals(await reserveResult(s, "atk6-nokey"), "accepted");
        });
        assert(reserved === "OK" || reserved === "42501", `reserve without api key: ${reserved}`);
        const applied = await sqlState(tx, async (s) => {
          assertNotEquals(
            await apply(s, rpcShot({ analysisPermitId: crypto.randomUUID() })),
            "accepted",
          );
        });
        assert(applied === "OK" || applied === "42501", `apply without api key: ${applied}`);
        await tx.unsafe(`reset role`);
        const rows = await tx.unsafe(
          `select (select count(*) from public.analysis_permits where user_id = '${ALICE}')::int as permits,
                  (select count(*) from public.shots where user_id = '${ALICE}')::int as shots`,
        );
        assertEquals([Number(rows[0].permits), Number(rows[0].shots)], [0, 0]);
      });
    } finally {
      await sql.end();
    }
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// ATK-7 — duplicate shot ids inside one batch (edge only)
// ─────────────────────────────────────────────────────────────────────────────

// One batch carrying the same shot id twice (different permits / kinds):
// acceptedIds must stay a set of settled ids.
Deno.test({
  name: "ATK-7: duplicate shot id inside one batch",
  async fn() {
    const auth = signIn();
    const id = crypto.randomUUID();
    const p1 = crypto.randomUUID();
    const p2 = crypto.randomUUID();
    const result = await syncViaEdge(auth, [
      wireShot({ id, analysisPermitId: p1 }),
      wireShot({ id, analysisPermitId: p2, resultKind: "partial", overallScore: null }),
    ]);
    assertEquals(result.status, 200, JSON.stringify(result.body));
    const rpcCalls = h.callsTo("rpc/apply_synced_shot");
    const accepted = result.body.acceptedIds ?? [];
    const forwardedPermits = rpcCalls
      .map((c) => (c.body as { shot: { analysisPermitId: string } }).shot.analysisPermitId)
      .join(", ");
    const observed = [
      `${rpcCalls.length} RPC calls for permits [${forwardedPermits}]`,
      `acceptedIds=${JSON.stringify(accepted)}`,
    ].join(", ");
    // Contract: acceptedIds is a set of settled ids and nothing is rejected.
    // (On a live DB the second RPC is an ownership replay → 'accepted' with
    // its permit untouched, so no rating can be double-spent here.)
    assertEquals(result.body.rejected, []);
    assertEquals([...new Set(accepted)], [id], `duplicate id inside one batch: ${observed}`);
    assertEquals(accepted.length, 1, `acceptedIds echoes the duplicate: ${observed}`);
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// ATK-8 — network failure at each server-side step of one batch (edge only)
// ─────────────────────────────────────────────────────────────────────────────

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

// Whole batch 503 (retryable), zero RPC calls, no DB detail in the body.
Deno.test({
  name: "ATK-8a: replay lookup 5xx",
  async fn() {
    const auth = signIn();
    h.respond = (call) => {
      if (call.method !== "GET" || !call.url.includes("/rest/v1/shots")) return null;
      return jsonResponse(503, { code: "XX000", message: "injected shots lookup failure" });
    };
    const result = await syncViaEdge(auth, [
      wireShot(),
      wireShot({ resultKind: "partial", overallScore: null }),
    ]);
    assertEquals(result.status, 503, JSON.stringify(result.body));
    assertEquals(h.callsTo("rpc/apply_synced_shot").length, 0);
    assertEquals(JSON.stringify(result.body).includes("injected"), false);
  },
});

// Whole batch 503, zero RPC calls; without a scored shot the authority is
// never consulted and the partial settles.
Deno.test({
  name: "ATK-8b: release authority unreadable",
  async fn() {
    const auth = signIn();
    h.rpcErrors.read_analysis_release_policy = 500;
    const mixed = await syncViaEdge(auth, [
      wireShot(),
      wireShot({ resultKind: "partial", overallScore: null }),
    ]);
    assertEquals(mixed.status, 503, JSON.stringify(mixed.body));
    assertEquals(h.callsTo("rpc/apply_synced_shot").length, 0);
    assertEquals(JSON.stringify(mixed.body).includes("injected"), false);

    const auth2 = signIn();
    h.rpcErrors.read_analysis_release_policy = 500;
    const partial = wireShot({ resultKind: "partial", overallScore: null });
    const abstention = await syncViaEdge(auth2, [partial]);
    assertEquals(abstention.status, 200, JSON.stringify(abstention.body));
    assertEquals(abstention.body.acceptedIds, [partial.id]);
    assertEquals(h.callsTo("rpc/read_analysis_release_policy").length, 0);
  },
});

// 200 with shot.write_failed per failed shot, the other shots still settle,
// no DB detail or raw status string leaks into the body.
Deno.test({
  name: "ATK-8c: per-shot RPC failures (5xx, 429 + Retry-After, unknown status string)",
  async fn() {
    const auth = signIn();
    const ok = wireShot();
    const broken5xx = wireShot();
    const broken429 = wireShot();
    const weird = wireShot();
    const rpcFor = (call: { body: unknown }) => (call.body as { shot: { id: string } }).shot.id;
    h.respond = (call) => {
      if (!call.url.includes("rpc/apply_synced_shot")) return null;
      const id = rpcFor(call);
      if (id === broken5xx.id) {
        return jsonResponse(500, { code: "XX000", message: "injected 5xx detail" });
      }
      if (id === broken429.id) {
        return jsonResponse(429, { message: "injected 429 detail" }, { "Retry-After": "7" });
      }
      if (id === weird.id) {
        return jsonResponse(200, "shot.write_failed:<script>alert(1)</script>");
      }
      return null;
    };
    const result = await syncViaEdge(auth, [ok, broken5xx, broken429, weird]);
    assertEquals(result.status, 200, JSON.stringify(result.body));
    assertEquals(result.body.acceptedIds, [ok.id]);
    const rejected = (result.body.rejected ?? []).map((r) => `${r.id}:${r.code}`).sort();
    assertEquals(
      rejected,
      [broken5xx.id, broken429.id, weird.id].map((id) => `${id}:shot.write_failed`).sort(),
    );
    const text = JSON.stringify(result.body);
    for (const leak of ["injected", "<script>", "XX000"]) {
      assertEquals(text.includes(leak), false, `leaked ${leak}`);
    }
    assertStringIncludes(text, "stays on this device");
  },
});
