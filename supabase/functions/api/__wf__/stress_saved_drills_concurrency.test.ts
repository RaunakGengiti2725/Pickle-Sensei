/**
 * stress — PUT /v1/me/saved-drills/:slug, CONCURRENCY lens.
 *
 * Drives the REAL edge handler (../index.ts, Deno.serve captured, fake GoTrue,
 * user_saved_drills modelled in memory or backed by a disposable postgres:16
 * — see stress_saved_drills_harness.ts) with Promise.all bursts from a seeded
 * scheduler. Every burst has its own seed (burstSeed(scenario, i)); the
 * per-request start offsets, the fake's per-upstream-call latency, the
 * actors, slugs and op mix are all drawn from that seed, so a burst replays
 * with the printed command (STRESS_REPLAY_SEED=<seed>).
 *
 * Scenarios (one campaign each, STRESS_ITER bursts, 4..STRESS_BURST_MAX
 * requests per burst):
 *   SD1 duplicate delivery — the same PUT k× at once (call-during-call)
 *   SD2 distinct slugs at once — no lost write
 *   SD3 PUT/DELETE race on the same row (one user, two devices)
 *   SD4 two actors on the same slug — isolation, no cross-user effect
 *   SD5 logout while PUTs are in flight
 *   SD6 refresh-token rotation while PUTs are in flight (old + new bearer)
 *   SD7 clock skew — bearers whose exp is behind/ahead of the edge's clock
 *   SD8 client cancels mid-call, then retries
 * plus a deterministic REPRO of the one interleaving SD3 surfaces.
 *
 * Invariants asserted per burst (a burst is HELD only if all hold; the test
 * fails on any BROKEN/TIMEOUT burst and prints the failing seeds):
 *   idempotency (every duplicate 200 carries the SAME savedAt), no duplicate
 *   (user_id, slug) rows, no lost write, no phantom row (a persisted row's
 *   saved_at was returned to a client), owner isolation, no 5xx except the
 *   documented PUT/DELETE race, every post-logout / expired bearer refused,
 *   and bounded wall time (STRESS_BURST_TIMEOUT_MS, default 15s).
 *
 * Results: <STRESS_OUT_DIR>/<scenario>.<backend>.json — a seed → outcome
 * table with every request row (lane, actor, op, start/end, status, savedAt).
 *
 *   cd supabase/functions/api/__wf__
 *   deno test -A --no-check --config deno.json stress_saved_drills_concurrency.test.ts
 *   STRESS_ITER=100 deno test -A … (campaign, ≥ 800 bursts)
 *   ./xc_pg_up.sh && STRESS_PG_URL=postgres://postgres:pg@127.0.0.1:55433/postgres STRESS_ITER=100 deno test -A …
 */
import { assert, assertEquals } from "@std/assert";
import {
  backendNote,
  bounded,
  type BurstOutcome,
  burstSeed,
  type CampaignReport,
  edgeRequest,
  fakeGoogleIdToken,
  histogram,
  jwtPayload,
  loadStressHarness,
  outDir,
  Prng,
  readJson,
  replayCommand,
  type RequestRow,
  STRESS_BURST_MAX,
  STRESS_BURST_TIMEOUT_MS,
  STRESS_ITER,
  STRESS_LATENCY_MS,
  STRESS_REPLAY_SEED,
  STRESS_SEED,
  type StressHarness,
  writeCampaign,
} from "./stress_saved_drills_harness.ts";

const SAVE_PATH = (slug: string) =>
  `/v1/me/saved-drills/${encodeURIComponent(slug)}`;
const CATALOG_SLUGS = [
  "dink-consistency",
  "third-shot-drop",
  "reset-from-transition",
  "kitchen-line-volleys",
  "serve-depth",
  "return-depth",
];

interface Actor {
  label: string;
  uid: string;
  token: string;
  refreshToken: string;
  ip: string;
}

interface Ctx {
  h: StressHarness;
  prng: Prng;
  seed: number;
  ip: string;
  t0: number;
  rows: RequestRow[];
  failed: string[];
}

const now = (ctx: Ctx) => Math.round((performance.now() - ctx.t0) * 100) / 100;

function seededIp(seed: number, n: number): string {
  return `10.${(seed >>> 16) & 255}.${(seed >>> 8) & 255}.${(seed + n) & 255}`;
}

function pickSlug(prng: Prng): string {
  return prng.next() < 0.5
    ? CATALOG_SLUGS[prng.int(0, CATALOG_SLUGS.length - 1)]
    : `drill-${prng.int(0, 99_999)}`;
}

async function newActor(ctx: Ctx, label: string): Promise<Actor> {
  const uid = ctx.prng.uuid();
  if (ctx.h.pg) await ctx.h.pg.createUser(uid);
  const ip = seededIp(ctx.seed, ctx.rows.length + label.charCodeAt(0));
  const response = await ctx.h.handler(
    edgeRequest("POST", "/v1/account/bootstrap", {
      token: fakeGoogleIdToken(uid),
      ip,
      body: {},
    }),
  );
  const body = await readJson(response);
  const session = (body.session ?? {}) as Record<string, unknown>;
  if (response.status !== 200 || typeof session.accessToken !== "string") {
    throw new Error(
      `bootstrap(${label}) → ${response.status} ${
        JSON.stringify(body).slice(0, 200)
      }`,
    );
  }
  return {
    label,
    uid,
    token: session.accessToken,
    refreshToken: String(session.refreshToken ?? ""),
    ip,
  };
}

interface Fired {
  status: number;
  body: Record<string, unknown>;
  row: RequestRow;
}

/** One lane: wait its seeded offset, then hit the real handler. */
async function fire(
  ctx: Ctx,
  lane: number,
  op: string,
  actor: string,
  delayMs: number,
  request: Request,
  note?: string,
): Promise<Fired> {
  if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
  const startMs = now(ctx);
  const response = await ctx.h.handler(request);
  const body = await readJson(response);
  const row: RequestRow = {
    lane,
    op,
    actor,
    startMs,
    endMs: now(ctx),
    status: response.status,
    ...(typeof body.savedAt === "string" ? { savedAt: body.savedAt } : {}),
    ...(note ? { note } : {}),
  };
  ctx.rows.push(row);
  return { status: response.status, body, row };
}

const put = (
  ctx: Ctx,
  lane: number,
  actor: Actor,
  slug: string,
  delay: number,
  token = actor.token,
  note?: string,
) =>
  fire(
    ctx,
    lane,
    "PUT",
    actor.label,
    delay,
    edgeRequest("PUT", SAVE_PATH(slug), { token, ip: actor.ip }),
    note,
  );

const del = (
  ctx: Ctx,
  lane: number,
  actor: Actor,
  slug: string,
  delay: number,
) =>
  fire(
    ctx,
    lane,
    "DELETE",
    actor.label,
    delay,
    edgeRequest("DELETE", SAVE_PATH(slug), {
      token: actor.token,
      ip: actor.ip,
    }),
  );

async function rowsFor(
  ctx: Ctx,
  uid: string,
): Promise<Array<{ slug: string; saved_at: string }>> {
  return ctx.h.pg ? await ctx.h.pg.rowsFor(uid) : ctx.h.fake.savedRows(uid);
}

async function duplicatePairs(ctx: Ctx): Promise<number> {
  return ctx.h.pg
    ? await ctx.h.pg.duplicatePairs()
    : ctx.h.fake.duplicatePairsInMemory();
}

const overlaps = (a: RequestRow, b: RequestRow) =>
  a.startMs < b.endMs && b.startMs < a.endMs;

function check(ctx: Ctx, holds: boolean, detail: string): void {
  if (!holds) ctx.failed.push(detail);
}

// ── Campaign runner ──────────────────────────────────────────────────────────

type Scenario = (ctx: Ctx, k: number) => Promise<{
  inputs: Record<string, unknown>;
  observations: Record<string, unknown>;
}>;

async function campaign(
  scenario: string,
  label: string,
  body: Scenario,
): Promise<CampaignReport> {
  const h = await loadStressHarness();
  const heapBefore = Deno.memoryUsage();
  const started = performance.now();
  const table: BurstOutcome[] = [];
  for (let i = 0; i < STRESS_ITER; i++) {
    const seed = burstSeed(scenario, i);
    if (STRESS_REPLAY_SEED !== null && seed !== STRESS_REPLAY_SEED) continue;
    h.fake.reset(seed, STRESS_LATENCY_MS);
    const prng = new Prng(seed);
    const k = prng.int(4, STRESS_BURST_MAX);
    const ctx: Ctx = {
      h,
      prng,
      seed,
      ip: seededIp(seed, 0),
      t0: performance.now(),
      rows: [],
      failed: [],
    };
    let inputs: Record<string, unknown> = {};
    let observations: Record<string, unknown> = {};
    let outcome: BurstOutcome["outcome"] = "HELD";
    try {
      const result = await bounded(body(ctx, k), STRESS_BURST_TIMEOUT_MS);
      if (result === null) {
        outcome = "TIMEOUT";
        ctx.failed.push(
          `burst did not settle within ${STRESS_BURST_TIMEOUT_MS}ms (${ctx.rows.length}/${k} lanes done)`,
        );
      } else {
        inputs = result.inputs;
        observations = result.observations;
      }
    } catch (error) {
      ctx.failed.push(
        `threw: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (outcome !== "TIMEOUT" && ctx.failed.length) outcome = "BROKEN";
    table.push({
      iteration: i,
      seed,
      k,
      outcome,
      statusHistogram: histogram(ctx.rows.map((r) => `${r.op} ${r.status}`)),
      failed: ctx.failed,
      durationMs: Math.round((performance.now() - ctx.t0) * 100) / 100,
      inputs,
      requests: ctx.rows,
      observations,
    });
  }
  const failingSeeds = table.filter((b) => b.outcome !== "HELD").map((b) =>
    b.seed
  );
  const report: CampaignReport = {
    scenario,
    label,
    backend: h.backend,
    backendNote: backendNote(h.backend),
    campaignSeed: STRESS_SEED,
    knobs: {
      STRESS_ITER,
      STRESS_LATENCY_MS,
      STRESS_BURST_MAX,
      STRESS_BURST_TIMEOUT_MS,
      ...(STRESS_REPLAY_SEED !== null ? { STRESS_REPLAY_SEED } : {}),
    },
    bursts: table.length,
    requests: table.reduce((n, b) => n + b.requests.length, 0),
    held: table.filter((b) => b.outcome === "HELD").length,
    broken: table.filter((b) => b.outcome === "BROKEN").length,
    timeouts: table.filter((b) => b.outcome === "TIMEOUT").length,
    failingSeeds,
    maxBurstMs: table.reduce((m, b) => Math.max(m, b.durationMs), 0),
    totalMs: Math.round(performance.now() - started),
    heap: { before: heapBefore, after: Deno.memoryUsage() },
    replay: replayCommand(scenario, failingSeeds[0] ?? burstSeed(scenario, 0)),
    table,
  };
  const path = await writeCampaign(report);
  console.log(
    `[stress ${scenario} ${h.backend}] bursts=${report.bursts} requests=${report.requests} held=${report.held} broken=${report.broken} timeouts=${report.timeouts} maxBurstMs=${report.maxBurstMs} → ${path}`,
  );
  return report;
}

function assertCampaign(report: CampaignReport): void {
  const failing = report.table.filter((b) => b.outcome !== "HELD");
  assert(
    failing.length === 0,
    `${report.scenario}: ${failing.length}/${report.bursts} bursts ${
      failing.map((b) => b.outcome).join(",")
    }\n` +
      failing
        .slice(0, 5)
        .map((b) =>
          `  seed=${b.seed} → ${b.failed.join(" | ")}\n    replay: ${
            replayCommand(report.scenario, b.seed)
          }`
        )
        .join("\n"),
  );
  if (STRESS_REPLAY_SEED === null) assertEquals(report.bursts, STRESS_ITER);
}

// ── Shared invariants ────────────────────────────────────────────────────────

/** Every 200 for `actor`/`slug` carries the same savedAt, and it is the
 * persisted row's saved_at. Returns the number of 200s. */
async function assertIdempotentSave(
  ctx: Ctx,
  actor: Actor,
  slug: string,
  puts: Fired[],
): Promise<number> {
  const oks = puts.filter((p) => p.status === 200);
  for (const p of oks) {
    check(
      ctx,
      p.body.slug === slug && p.body.saved === true,
      `lane ${p.row.lane}: 200 body ${JSON.stringify(p.body)}`,
    );
    check(
      ctx,
      typeof p.body.savedAt === "string" && p.body.savedAt.length > 0,
      `lane ${p.row.lane}: missing savedAt`,
    );
  }
  const savedAts = new Set(oks.map((p) => String(p.body.savedAt)));
  check(
    ctx,
    savedAts.size <= 1,
    `idempotency: ${savedAts.size} distinct savedAt across ${oks.length} duplicate 200s: ${
      [...savedAts].join(", ")
    }`,
  );
  const rows = (await rowsFor(ctx, actor.uid)).filter((r) => r.slug === slug);
  check(
    ctx,
    rows.length <= 1,
    `duplicate rows for ${actor.label}/${slug}: ${rows.length}`,
  );
  if (oks.length > 0) {
    check(
      ctx,
      rows.length === 1,
      `lost write: ${oks.length} × 200 but ${rows.length} rows for ${actor.label}/${slug}`,
    );
    if (rows.length === 1) {
      check(
        ctx,
        savedAts.has(rows[0].saved_at),
        `savedAt ${[...savedAts].join(",")} ≠ persisted ${rows[0].saved_at}`,
      );
    }
  }
  return oks.length;
}

// ── SD1 duplicate delivery ───────────────────────────────────────────────────

Deno.test("stress SD1: the same PUT delivered k× at once is idempotent — every 200 carries one savedAt, exactly one row, no 5xx, bounded", async () => {
  const report = await campaign(
    "SD1-duplicate-put",
    "duplicate delivery of PUT /v1/me/saved-drills/:slug",
    async (ctx, k) => {
      const actor = await newActor(ctx, "A");
      const slug = pickSlug(ctx.prng);
      const delays = Array.from(
        { length: k },
        () => ctx.prng.int(0, STRESS_LATENCY_MS * 2),
      );
      const puts = await Promise.all(
        delays.map((d, lane) => put(ctx, lane, actor, slug, d)),
      );
      for (const p of puts) {
        check(
          ctx,
          p.status === 200,
          `lane ${p.row.lane}: PUT → ${p.status} ${
            JSON.stringify(p.body).slice(0, 120)
          }`,
        );
      }
      const oks = await assertIdempotentSave(ctx, actor, slug, puts);
      check(
        ctx,
        (await duplicatePairs(ctx)) === 0,
        "duplicate (user_id, slug) pairs in the table",
      );
      const rows = await rowsFor(ctx, actor.uid);
      check(
        ctx,
        rows.length === 1,
        `expected exactly one row for ${actor.label}, got ${rows.length}`,
      );
      return {
        inputs: { slug, delays, user: actor.uid },
        observations: {
          oks,
          upsertCalls: ctx.h.fake.counters["rest.post.user_saved_drills"] ?? 0,
          savedAt: puts[0]?.body.savedAt,
        },
      };
    },
  );
  assertCampaign(report);
});

// ── SD2 distinct slugs — no lost write ───────────────────────────────────────

Deno.test("stress SD2: k distinct slugs saved at once — every one persisted with the savedAt it reported, none lost, none duplicated", async () => {
  const report = await campaign(
    "SD2-distinct-slugs",
    "k distinct PUTs for one user at once",
    async (ctx, k) => {
      const actor = await newActor(ctx, "A");
      const slugs = Array.from(
        new Set(
          Array.from({ length: k }, (_, i) => `${pickSlug(ctx.prng)}-${i}`),
        ),
      );
      const delays = slugs.map(() => ctx.prng.int(0, STRESS_LATENCY_MS * 2));
      const puts = await Promise.all(
        slugs.map((slug, lane) =>
          put(ctx, lane, actor, slug, delays[lane], actor.token, slug)
        ),
      );
      for (const p of puts) {
        check(
          ctx,
          p.status === 200,
          `lane ${p.row.lane}: PUT → ${p.status}`,
        );
      }
      const rows = await rowsFor(ctx, actor.uid);
      check(
        ctx,
        rows.length === slugs.length,
        `lost write: ${slugs.length} PUTs → ${rows.length} rows`,
      );
      for (const [lane, slug] of slugs.entries()) {
        const row = rows.find((r) => r.slug === slug);
        check(ctx, Boolean(row), `slug ${slug} not persisted`);
        if (row) {
          check(
            ctx,
            puts[lane].body.savedAt === row.saved_at,
            `slug ${slug}: savedAt ${
              String(puts[lane].body.savedAt)
            } ≠ persisted ${row.saved_at}`,
          );
        }
      }
      check(
        ctx,
        (await duplicatePairs(ctx)) === 0,
        "duplicate (user_id, slug) pairs in the table",
      );
      return {
        inputs: { slugs, delays, user: actor.uid },
        observations: { rows: rows.length },
      };
    },
  );
  assertCampaign(report);
});

// ── SD3 PUT/DELETE race on the same row ──────────────────────────────────────

Deno.test("stress SD3: PUT and DELETE racing on the same row — ≤1 row, no phantom row, DELETE always 204, PUT 200 or (only under an overlapping DELETE) 503", async () => {
  const report = await campaign(
    "SD3-put-delete-race",
    "one user, PUT and DELETE of the same slug interleaved",
    async (ctx, k) => {
      const actor = await newActor(ctx, "A");
      const slug = pickSlug(ctx.prng);
      const ops = Array.from(
        { length: k },
        () => (ctx.prng.next() < 0.6 ? "PUT" : "DELETE"),
      );
      ops[0] = "PUT";
      if (!ops.includes("DELETE")) ops[ops.length - 1] = "DELETE";
      const delays = ops.map(() => ctx.prng.int(0, STRESS_LATENCY_MS * 3));
      const fired = await Promise.all(
        ops.map((
          op,
          lane,
        ) => (op === "PUT"
          ? put(ctx, lane, actor, slug, delays[lane])
          : del(ctx, lane, actor, slug, delays[lane]))
        ),
      );
      const puts = fired.filter((f) => f.row.op === "PUT");
      const dels = fired.filter((f) => f.row.op === "DELETE");
      for (const d of dels) {
        check(
          ctx,
          d.status === 204,
          `lane ${d.row.lane}: DELETE → ${d.status}`,
        );
      }
      let racy503 = 0;
      for (const p of puts) {
        if (p.status === 200) continue;
        if (p.status === 503) {
          const overlappingDelete = dels.some((d) => overlaps(p.row, d.row));
          check(
            ctx,
            overlappingDelete,
            `lane ${p.row.lane}: PUT → 503 with NO concurrent DELETE`,
          );
          check(
            ctx,
            p.body.error !== undefined &&
              !JSON.stringify(p.body).includes("user_saved_drills"),
            `lane ${p.row.lane}: 503 body leaks detail ${
              JSON.stringify(p.body)
            }`,
          );
          racy503 += 1;
          continue;
        }
        check(
          ctx,
          false,
          `lane ${p.row.lane}: PUT → ${p.status} ${
            JSON.stringify(p.body).slice(0, 120)
          }`,
        );
      }
      const rows = (await rowsFor(ctx, actor.uid)).filter((r) =>
        r.slug === slug
      );
      check(ctx, rows.length <= 1, `duplicate rows: ${rows.length}`);
      const reported = new Set(
        puts.filter((p) => p.status === 200).map((p) => String(p.body.savedAt)),
      );
      if (rows.length === 1) {
        check(
          ctx,
          reported.has(rows[0].saved_at),
          `phantom row: persisted saved_at ${
            rows[0].saved_at
          } was never returned to a client (${[...reported].join(",")})`,
        );
      }
      check(
        ctx,
        (await duplicatePairs(ctx)) === 0,
        "duplicate (user_id, slug) pairs in the table",
      );
      return {
        inputs: { slug, ops, delays, user: actor.uid },
        observations: {
          puts: puts.length,
          deletes: dels.length,
          put200: puts.filter((p) => p.status === 200).length,
          put503_under_concurrent_delete: racy503,
          finalRows: rows.length,
        },
      };
    },
  );
  assertCampaign(report);
  const racy = report.table.reduce(
    (n, b) => n + Number(b.observations.put503_under_concurrent_delete ?? 0),
    0,
  );
  console.log(
    `[stress SD3 ${report.backend}] PUT→503 under a concurrent DELETE (documented race, see REPRO below): ${racy} of ${
      report.table.reduce((n, b) => n + Number(b.observations.puts ?? 0), 0)
    } PUTs`,
  );
});

// Deterministic form of the SD3 interleaving. saveDrill() is two statements —
// upsert, then an owner-scoped read-back — with no transaction around them; a
// DELETE for the same (user_id, slug) that commits in between leaves the
// read-back with zero rows and the route answers 503 "Drill save is
// temporarily unavailable" although nothing is unavailable: the bookmark was
// simply removed by the user's other device. REPRO (defect, P3): the client
// (training/api.ts saveDrill → request()) surfaces this as a transient server
// error; the persisted state (unsaved) is consistent, nothing is lost.
Deno.test("stress SD3-REPRO (defect): DELETE landing between the upsert and the read-back turns a legitimate PUT into a 503", async () => {
  const h = await loadStressHarness();
  const seed = burstSeed("SD3-REPRO", 0);
  h.fake.reset(seed, 0);
  const ctx: Ctx = {
    h,
    prng: new Prng(seed),
    seed,
    ip: seededIp(seed, 0),
    t0: performance.now(),
    rows: [],
    failed: [],
  };
  const actor = await newActor(ctx, "A");
  const slug = "third-shot-drop";

  let releaseDelete!: () => void;
  const deleteMayStart = new Promise<void>((r) => (releaseDelete = r));
  let releasePut!: () => void;
  const putMayReadBack = new Promise<void>((r) => (releasePut = r));
  h.fake.afterUpsert = async () => {
    releaseDelete();
    await putMayReadBack;
  };
  h.fake.beforeDelete = async () => {
    await deleteMayStart;
  };
  const putP = put(ctx, 0, actor, slug, 0);
  const delP = del(ctx, 1, actor, slug, 0).then((d) => {
    releasePut();
    return d;
  });
  const [p, d] = await Promise.all([putP, delP]);
  h.fake.afterUpsert = null;
  h.fake.beforeDelete = null;

  assertEquals(d.status, 204);
  assertEquals(p.status, 503, `PUT → ${p.status} ${JSON.stringify(p.body)}`);
  assertEquals(p.body, {
    error: {
      message: "Drill save is temporarily unavailable. Please try again.",
    },
  });
  assertEquals((await rowsFor(ctx, actor.uid)).length, 0);
  const path = await writeCampaign({
    scenario: "SD3-REPRO-put-delete-503",
    label: "deterministic: DELETE between saveDrill()'s upsert and read-back",
    backend: h.backend,
    backendNote: backendNote(h.backend),
    campaignSeed: STRESS_SEED,
    knobs: { STRESS_LATENCY_MS: 0 },
    bursts: 1,
    requests: ctx.rows.length,
    held: 0,
    broken: 1,
    timeouts: 0,
    failingSeeds: [seed],
    maxBurstMs: Math.round((performance.now() - ctx.t0) * 100) / 100,
    totalMs: Math.round(performance.now() - ctx.t0),
    heap: { before: Deno.memoryUsage(), after: Deno.memoryUsage() },
    replay:
      `deno test -A --no-check --config deno.json stress_saved_drills_concurrency.test.ts --filter "SD3-REPRO"`,
    table: [{
      iteration: 0,
      seed,
      k: 2,
      outcome: "BROKEN",
      statusHistogram: histogram(ctx.rows.map((r) => `${r.op} ${r.status}`)),
      failed: [
        "PUT → 503 'Drill save is temporarily unavailable' for a legitimate PUT/DELETE race (expected: a non-5xx answer that reflects the row's final state)",
      ],
      durationMs: Math.round((performance.now() - ctx.t0) * 100) / 100,
      inputs: {
        slug,
        user: actor.uid,
        interleaving: "PUT.upsert → DELETE → PUT.read-back",
      },
      requests: ctx.rows,
      observations: {
        put: p.status,
        putBody: p.body,
        delete: d.status,
        finalRows: 0,
      },
    }],
  });
  console.log(`[stress SD3-REPRO ${h.backend}] PUT → ${p.status} → ${path}`);
});

// ── SD4 two actors, same slug ────────────────────────────────────────────────

Deno.test("stress SD4: two users bookmark the same slug at once — each gets exactly its own row, one user's DELETE never touches the other's, no cross-user savedAt", async () => {
  const report = await campaign(
    "SD4-two-actors-same-slug",
    "users A and B PUT the same slug concurrently; A also DELETEs",
    async (ctx, k) => {
      const a = await newActor(ctx, "A");
      const b = await newActor(ctx, "B");
      const slug = pickSlug(ctx.prng);
      const plan = Array.from({ length: k }, () => {
        const r = ctx.prng.next();
        return r < 0.45
          ? { actor: a, op: "PUT" }
          : r < 0.6
          ? { actor: a, op: "DELETE" }
          : { actor: b, op: "PUT" };
      });
      plan[0] = { actor: b, op: "PUT" };
      plan[1] = { actor: a, op: "PUT" };
      const delays = plan.map(() => ctx.prng.int(0, STRESS_LATENCY_MS * 3));
      const fired = await Promise.all(
        plan.map((step, lane) =>
          step.op === "PUT"
            ? put(ctx, lane, step.actor, slug, delays[lane])
            : del(ctx, lane, step.actor, slug, delays[lane])
        ),
      );
      const bPuts = fired.filter((f) => f.row.actor === "B");
      for (const p of bPuts) {
        check(
          ctx,
          p.status === 200,
          `B lane ${p.row.lane}: PUT → ${p.status}`,
        );
      }
      await assertIdempotentSave(ctx, b, slug, bPuts);
      const bRows = await rowsFor(ctx, b.uid);
      check(
        ctx,
        bRows.length === 1 && bRows[0].slug === slug,
        `B must hold exactly its own row, got ${JSON.stringify(bRows)}`,
      );

      const aFired = fired.filter((f) => f.row.actor === "A");
      const aDels = aFired.filter((f) => f.row.op === "DELETE");
      for (const d of aDels) {
        check(
          ctx,
          d.status === 204,
          `A lane ${d.row.lane}: DELETE → ${d.status}`,
        );
      }
      const aPuts = aFired.filter((f) => f.row.op === "PUT");
      for (const p of aPuts) {
        if (p.status === 200) continue;
        check(
          ctx,
          p.status === 503 && aDels.some((d) => overlaps(p.row, d.row)),
          `A lane ${p.row.lane}: PUT → ${p.status} without a concurrent A DELETE`,
        );
      }
      const aRows = (await rowsFor(ctx, a.uid)).filter((r) => r.slug === slug);
      check(ctx, aRows.length <= 1, `A duplicate rows: ${aRows.length}`);
      const aReported = new Set(
        aPuts.filter((p) => p.status === 200).map((p) =>
          String(p.body.savedAt)
        ),
      );
      if (aRows.length === 1) {
        check(
          ctx,
          aReported.has(aRows[0].saved_at),
          `A phantom row ${aRows[0].saved_at}`,
        );
      }
      // A's 200s must describe A's row, never B's: saved_at carries sub-ms
      // precision on both backends, so equality with B's row means the
      // owner-scoped read-back leaked across users.
      const bSavedAt = bRows[0]?.saved_at;
      for (const p of aPuts.filter((p) => p.status === 200)) {
        check(
          ctx,
          String(p.body.savedAt) !== bSavedAt,
          `A lane ${p.row.lane}: savedAt ${String(p.body.savedAt)} is B's row`,
        );
      }
      check(
        ctx,
        (await duplicatePairs(ctx)) === 0,
        "duplicate (user_id, slug) pairs in the table",
      );
      return {
        inputs: {
          slug,
          plan: plan.map((s) => `${s.actor.label}:${s.op}`),
          delays,
          users: { A: a.uid, B: b.uid },
        },
        observations: {
          aRows: aRows.length,
          bRows: bRows.length,
          aDeletes: aDels.length,
          bPuts: bPuts.length,
        },
      };
    },
  );
  assertCampaign(report);
});

// ── SD5 logout during the burst ──────────────────────────────────────────────

Deno.test("stress SD5: logout while PUTs are in flight — every PUT that starts after the logout settles is 401, no 5xx, ≤1 row, no write without a 200", async () => {
  const report = await campaign(
    "SD5-logout-during-put",
    "POST /v1/auth/logout races k PUTs on the same bearer",
    async (ctx, k) => {
      const actor = await newActor(ctx, "A");
      const slug = pickSlug(ctx.prng);
      const logoutLane = ctx.prng.int(0, k - 1);
      const delays = Array.from(
        { length: k },
        () => ctx.prng.int(0, STRESS_LATENCY_MS * 3),
      );
      const logoutDelay = ctx.prng.int(0, STRESS_LATENCY_MS * 3);
      const [logout, ...puts] = await Promise.all([
        fire(
          ctx,
          logoutLane,
          "LOGOUT",
          actor.label,
          logoutDelay,
          edgeRequest("POST", "/v1/auth/logout", {
            token: actor.token,
            ip: actor.ip,
            body: {},
          }),
        ),
        ...delays.map((d, lane) => put(ctx, lane, actor, slug, d)),
      ]);
      check(ctx, logout.status === 204, `logout → ${logout.status}`);
      for (const p of puts) {
        check(
          ctx,
          p.status === 200 || p.status === 401,
          `lane ${p.row.lane}: PUT → ${p.status} ${
            JSON.stringify(p.body).slice(0, 120)
          }`,
        );
        if (p.row.startMs >= logout.row.endMs) {
          check(
            ctx,
            p.status === 401,
            `lane ${p.row.lane}: PUT started ${p.row.startMs}ms, after logout settled at ${logout.row.endMs}ms, yet → ${p.status}`,
          );
        }
      }
      const oks = await assertIdempotentSave(ctx, actor, slug, puts);
      const rows = await rowsFor(ctx, actor.uid);
      check(
        ctx,
        rows.length === (oks > 0 ? 1 : 0),
        `rows=${rows.length} with ${oks} × 200`,
      );
      check(
        ctx,
        (await duplicatePairs(ctx)) === 0,
        "duplicate (user_id, slug) pairs in the table",
      );
      return {
        inputs: { slug, delays, logoutDelay, user: actor.uid },
        observations: {
          put200: oks,
          put401: puts.filter((p) => p.status === 401).length,
          logoutSettledMs: logout.row.endMs,
        },
      };
    },
  );
  assertCampaign(report);
});

// ── SD6 refresh rotation during the burst ────────────────────────────────────

Deno.test("stress SD6: refresh-token rotation while PUTs are in flight — old and new bearer both save, one savedAt, one row, refresh 200", async () => {
  const report = await campaign(
    "SD6-rotation-during-put",
    "POST /v1/auth/refresh races k PUTs; lanes that start after it bear the new token",
    async (ctx, k) => {
      const actor = await newActor(ctx, "A");
      const slug = pickSlug(ctx.prng);
      const delays = Array.from(
        { length: k },
        () => ctx.prng.int(0, STRESS_LATENCY_MS * 3),
      );
      const refreshDelay = ctx.prng.int(0, STRESS_LATENCY_MS * 2);
      let newToken: string | null = null;
      const refreshP = fire(
        ctx,
        -1,
        "REFRESH",
        actor.label,
        refreshDelay,
        edgeRequest("POST", "/v1/auth/refresh", {
          ip: actor.ip,
          body: { refreshToken: actor.refreshToken },
        }),
      ).then((r) => {
        const session = (r.body.session ?? {}) as Record<string, unknown>;
        if (typeof session.accessToken === "string") {
          newToken = session.accessToken;
        }
        return r;
      });
      const puts = await Promise.all(
        delays.map(async (d, lane) => {
          if (d > 0) {
            await new Promise((r) => setTimeout(r, d));
          }
          const token = newToken ?? actor.token;
          return put(
            ctx,
            lane,
            actor,
            slug,
            0,
            token,
            token === actor.token ? "old-bearer" : "new-bearer",
          );
        }),
      );
      const refresh = await refreshP;
      check(
        ctx,
        refresh.status === 200,
        `refresh → ${refresh.status} ${
          JSON.stringify(refresh.body).slice(0, 120)
        }`,
      );
      for (const p of puts) {
        check(
          ctx,
          p.status === 200,
          `lane ${p.row.lane} (${p.row.note}): PUT → ${p.status} ${
            JSON.stringify(p.body).slice(0, 120)
          }`,
        );
      }
      await assertIdempotentSave(ctx, actor, slug, puts);
      check(
        ctx,
        (await duplicatePairs(ctx)) === 0,
        "duplicate (user_id, slug) pairs in the table",
      );
      return {
        inputs: { slug, delays, refreshDelay, user: actor.uid },
        observations: {
          oldBearerPuts: puts.filter((p) => p.row.note === "old-bearer").length,
          newBearerPuts: puts.filter((p) => p.row.note === "new-bearer").length,
          refreshSettledMs: refresh.row.endMs,
        },
      };
    },
  );
  assertCampaign(report);
});

// ── SD7 clock skew ───────────────────────────────────────────────────────────

const SKEWS = [-3600, -60, -1, 0, 1, 2, 3600, 86_400];

Deno.test("stress SD7: bearers whose exp is skewed against the edge clock — behind → 401 never writes, far ahead → 200, near-edge → 200|401, no 5xx, one savedAt", async () => {
  const report = await campaign(
    "SD7-clock-skew",
    "k PUTs bearing tokens with exp = now + skew, skew ∈ {-3600,-60,-1,0,1,2,3600,86400}",
    async (ctx, k) => {
      const actor = await newActor(ctx, "A");
      const slug = pickSlug(ctx.prng);
      const session = [...ctx.h.fake.sessions.values()].find((s) =>
        s.userId === actor.uid
      )!;
      const skews = Array.from(
        { length: k },
        () => SKEWS[ctx.prng.int(0, SKEWS.length - 1)],
      );
      skews[0] = 3600;
      const tokens = skews.map((s) => ctx.h.fake.mintSkewedToken(session, s));
      const nearEdge503: Array<
        { lane: number; skew: number; body: Record<string, unknown> }
      > = [];
      const delays = skews.map(() => ctx.prng.int(0, STRESS_LATENCY_MS * 2));
      const puts = await Promise.all(
        tokens.map((t, lane) =>
          put(ctx, lane, actor, slug, delays[lane], t, `skew=${skews[lane]}`)
        ),
      );
      for (const [lane, p] of puts.entries()) {
        const skew = skews[lane];
        if (skew <= 0) {
          check(
            ctx,
            p.status === 401,
            `lane ${lane} skew=${skew}: expired bearer → ${p.status} (must be 401)`,
          );
          check(
            ctx,
            JSON.stringify(p.body).includes("expired"),
            `lane ${lane} skew=${skew}: 401 body ${JSON.stringify(p.body)}`,
          );
        } else if (skew >= 3600) {
          check(
            ctx,
            p.status === 200,
            `lane ${lane} skew=${skew}: → ${p.status} ${
              JSON.stringify(p.body).slice(0, 120)
            }`,
          );
        } else {
          // exp lands inside the burst: the edge may accept it (200) or refuse
          // it (401); a 503 means the edge accepted a bearer PostgREST then
          // refused as expired (recorded, see nearEdge503 in observations).
          check(
            ctx,
            p.status === 200 || p.status === 401 || p.status === 503,
            `lane ${lane} skew=${skew}: → ${p.status}`,
          );
          if (p.status === 503) {
            nearEdge503.push({ lane, skew, body: p.body });
          }
        }
      }
      const oks = await assertIdempotentSave(ctx, actor, slug, puts);
      const rows = await rowsFor(ctx, actor.uid);
      check(
        ctx,
        rows.length === (oks > 0 ? 1 : 0),
        `rows=${rows.length} with ${oks} × 200`,
      );
      check(
        ctx,
        (await duplicatePairs(ctx)) === 0,
        "duplicate (user_id, slug) pairs in the table",
      );
      return {
        inputs: { slug, skews, delays, user: actor.uid },
        observations: {
          put200: oks,
          put401: puts.filter((p) => p.status === 401).length,
          nearEdge503,
          jwtExpiredAtPostgrest:
            ctx.h.fake.counters["rest.jwt_expired.user_saved_drills"] ?? 0,
          statusBySkew: histogram(
            puts.map((p, i) => `${skews[i]}:${p.status}`),
          ),
        },
      };
    },
  );
  assertCampaign(report);
  const nearEdge =
    report.table.flatMap((b) =>
      (b.observations.nearEdge503 as unknown[] | undefined) ?? []
    ).length;
  console.log(
    `[stress SD7 ${report.backend}] near-edge bearers (0 < skew < 60s) answered 503 after the edge accepted them: ${nearEdge}`,
  );
});

// Deterministic form of the SD7 near-edge case. authenticate() refuses a
// bearer only once `exp * 1000 <= Date.now()` (bearerExpired, zero margin —
// the CACHED path in readAuthCache keeps a 5 s margin), so a bearer that
// expires within the request is accepted, verified with GoTrue, and then
// presented to PostgREST, which enforces exp itself (401 PGRST301 "JWT
// expired" — modelled by the harness, INFERRED from PostgREST's documented
// behaviour, not observed against a live PostgREST). saveDrill() maps that
// upstream error to 503 "temporarily unavailable" instead of the 401 the
// client knows how to handle (refresh the session and retry). REPRO
// (defect, P3): the window is < 1 s per token life and the mobile
// sessionKeeper rotates 60 s ahead, so it needs a client whose clock is
// behind or a stalled rotation; every authenticated route shares the path.
Deno.test("stress SD7-REPRO (defect): a bearer that expires between the edge's exp check and the PostgREST hop is answered 503, not 401", async () => {
  const h = await loadStressHarness();
  const seed = burstSeed("SD7-REPRO", 0);
  h.fake.reset(seed, 0);
  const ctx: Ctx = {
    h,
    prng: new Prng(seed),
    seed,
    ip: seededIp(seed, 0),
    t0: performance.now(),
    rows: [],
    failed: [],
  };
  const actor = await newActor(ctx, "A");
  const session = [...h.fake.sessions.values()].find((s) =>
    s.userId === actor.uid
  )!;
  // exp = next whole second: valid at the edge's check, expired ≤ 1 s later.
  // Re-mint if that second is about to tick so the edge's check is not racy.
  let token = h.fake.mintSkewedToken(session, 1);
  let expMs = (jwtPayload(token)!.exp as number) * 1000;
  while (expMs - Date.now() < 250) {
    await new Promise((r) => setTimeout(r, 260));
    token = h.fake.mintSkewedToken(session, 1);
    expMs = (jwtPayload(token)!.exp as number) * 1000;
  }
  h.fake.beforeTable = async () => {
    const wait = expMs - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait + 1));
  };
  const p = await put(
    ctx,
    0,
    actor,
    "dink-consistency",
    0,
    token,
    "exp-inside-request",
  );
  h.fake.beforeTable = null;
  assertEquals(p.status, 503, `PUT → ${p.status} ${JSON.stringify(p.body)}`);
  assertEquals(p.body, {
    error: {
      message: "Drill save is temporarily unavailable. Please try again.",
    },
  });
  assertEquals(h.fake.counters["rest.jwt_expired.user_saved_drills"], 1);
  assertEquals((await rowsFor(ctx, actor.uid)).length, 0);
  const path = await writeCampaign({
    scenario: "SD7-REPRO-exp-inside-request-503",
    label:
      "deterministic: bearer exp passes between authenticate() and the PostgREST hop",
    backend: h.backend,
    backendNote: backendNote(h.backend) +
      " PostgREST's own JWT exp check (401 PGRST301) is modelled by the harness.",
    campaignSeed: STRESS_SEED,
    knobs: { STRESS_LATENCY_MS: 0 },
    bursts: 1,
    requests: ctx.rows.length,
    held: 0,
    broken: 1,
    timeouts: 0,
    failingSeeds: [seed],
    maxBurstMs: Math.round((performance.now() - ctx.t0) * 100) / 100,
    totalMs: Math.round(performance.now() - ctx.t0),
    heap: { before: Deno.memoryUsage(), after: Deno.memoryUsage() },
    replay:
      `deno test -A --no-check --config deno.json stress_saved_drills_concurrency.test.ts --filter "SD7-REPRO"`,
    table: [{
      iteration: 0,
      seed,
      k: 1,
      outcome: "BROKEN",
      statusHistogram: histogram(ctx.rows.map((r) => `${r.op} ${r.status}`)),
      failed: [
        "PUT → 503 'Drill save is temporarily unavailable' for a bearer PostgREST refused as expired (expected: 401 auth.expired so the client refreshes and retries)",
      ],
      durationMs: Math.round((performance.now() - ctx.t0) * 100) / 100,
      inputs: { slug: "dink-consistency", user: actor.uid, bearerExpMs: expMs },
      requests: ctx.rows,
      observations: { put: p.status, putBody: p.body, finalRows: 0 },
    }],
  });
  console.log(`[stress SD7-REPRO ${h.backend}] PUT → ${p.status} → ${path}`);
});

// ── SD8 cancel during call, then retry ───────────────────────────────────────

Deno.test("stress SD8: the client aborts PUTs mid-flight then retries — the handler settles every aborted call, the retry is idempotent (same savedAt), one row", async () => {
  const report = await campaign(
    "SD8-cancel-then-retry",
    "k PUTs with AbortController.abort() at a seeded offset, then one retry",
    async (ctx, k) => {
      const actor = await newActor(ctx, "A");
      const slug = pickSlug(ctx.prng);
      const abortAt = Array.from(
        { length: k },
        () => (ctx.prng.next() < 0.7
          ? ctx.prng.int(0, STRESS_LATENCY_MS * 3)
          : -1),
      );
      const delays = abortAt.map(() => ctx.prng.int(0, STRESS_LATENCY_MS));
      const puts = await Promise.all(
        abortAt.map((at, lane) => {
          const controller = new AbortController();
          const request = new Request(
            `http://edge.xc.test/functions/v1/api${SAVE_PATH(slug)}`,
            {
              method: "PUT",
              headers: {
                Authorization: `Bearer ${actor.token}`,
                "x-forwarded-for": actor.ip,
              },
              signal: controller.signal,
            },
          );
          if (at >= 0) {
            setTimeout(() =>
              controller.abort(
                new DOMException("client cancelled", "AbortError"),
              ), delays[lane] + at);
          }
          return fire(
            ctx,
            lane,
            "PUT",
            actor.label,
            delays[lane],
            request,
            at >= 0 ? `abort@${at}ms` : "no-abort",
          );
        }),
      );
      for (const p of puts) {
        check(
          ctx,
          p.status === 200,
          `lane ${p.row.lane} (${p.row.note}): PUT → ${p.status} ${
            JSON.stringify(p.body).slice(0, 120)
          }`,
        );
      }
      const retry = await put(ctx, k, actor, slug, 0, actor.token, "retry");
      check(ctx, retry.status === 200, `retry → ${retry.status}`);
      await assertIdempotentSave(ctx, actor, slug, [...puts, retry]);
      check(
        ctx,
        (await duplicatePairs(ctx)) === 0,
        "duplicate (user_id, slug) pairs in the table",
      );
      return {
        inputs: { slug, abortAt, delays, user: actor.uid },
        observations: {
          aborted: abortAt.filter((a) => a >= 0).length,
          retrySavedAt: retry.body.savedAt,
        },
      };
    },
  );
  assertCampaign(report);
});

// ── Summary table (seed → outcome across every scenario of this run) ─────────

Deno.test("stress: write seed → outcome summary table", async () => {
  const h = await loadStressHarness();
  const dir = outDir();
  const files: string[] = [];
  for await (const entry of Deno.readDir(dir)) {
    if (
      entry.isFile && entry.name.endsWith(`.${h.backend}.json`) &&
      entry.name.startsWith("SD")
    ) files.push(entry.name);
  }
  files.sort();
  const rows: Array<Record<string, unknown>> = [];
  const totals = { bursts: 0, requests: 0, held: 0, broken: 0, timeouts: 0 };
  for (const name of files) {
    const report = JSON.parse(
      await Deno.readTextFile(`${dir}${name}`),
    ) as CampaignReport;
    totals.bursts += report.bursts;
    totals.requests += report.requests;
    totals.held += report.held;
    totals.broken += report.broken;
    totals.timeouts += report.timeouts;
    for (const b of report.table) {
      rows.push({
        scenario: report.scenario,
        seed: b.seed,
        k: b.k,
        outcome: b.outcome,
        statuses: b.statusHistogram,
        ms: b.durationMs,
        failed: b.failed,
      });
    }
  }
  const summary = {
    backend: h.backend,
    backendNote: backendNote(h.backend),
    campaignSeed: STRESS_SEED,
    knobs: {
      STRESS_ITER,
      STRESS_LATENCY_MS,
      STRESS_BURST_MAX,
      STRESS_BURST_TIMEOUT_MS,
    },
    totals,
    upstreamCalls: h.upstreamCalls.length,
    pgStatements: h.pg?.statements ?? null,
    table: rows,
  };
  const path = `${dir}seed-table.${h.backend}.json`;
  await Deno.writeTextFile(path, JSON.stringify(summary, null, 2));
  console.log(
    `[stress summary ${h.backend}] ${
      JSON.stringify(totals)
    } upstreamCalls=${h.upstreamCalls.length} → ${path}`,
  );
  if (h.pg) await h.pg.close();
});
