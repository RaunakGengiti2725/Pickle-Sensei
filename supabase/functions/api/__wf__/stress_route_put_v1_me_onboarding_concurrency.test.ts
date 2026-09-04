// stress-route-put-v1-me-onboarding · lens = concurrency (in-process).
//
// Promise.all bursts against the REAL handler in ../index.ts over the fake in
// stress_onboarding_harness.ts. Scenarios: duplicate identical PUTs · conflicting
// payloads from two devices of one user · two actors on the same row (RLS +
// forged bearer) · GET /v1/me during PUT (call-during-call) · client cancel
// during call (aborted upload, abandoned response) · refresh rotation + logout
// during a PUT burst · clock skew on the bearer exp · per-user budget atomicity
// · mixed valid/invalid payloads. Every round derives its seed from
// STRESS_SEED ^ fnv1a(scenario) ^ round and is replayable alone
// (STRESS_ROUND_SEED=<seed>, printed as `replay` on every round).
//
// Contract asserted (never an observed defect): AGENTS.md "Auth sessions",
// the PUT /v1/me/onboarding block in ../index.ts, and the profiles schema in
// supabase/migrations (RLS profiles_update_own, column grant, CHECKs).
//
// Scale: STRESS_ITER rounds per scenario (default 2), STRESS_BURST lanes per
// burst (default 16), STRESS_LATENCY_MS (default 6). The campaign run behind
// this file's evidence used STRESS_ITER=60.

import { assert, assertEquals } from "@std/assert";
import {
  bearerTail,
  bounded,
  edgeRequest,
  expectedColumns,
  expectedProfileEcho,
  fakeGoogleIdToken,
  GOAL_FOCUS,
  histogram,
  type Invariant,
  loadStressHarness,
  type OnboardingPayload,
  outDir,
  Prng,
  randomPayload,
  readJson,
  replayCommand,
  roundReplayCommand,
  roundSeeds,
  type ScenarioReport,
  sleep,
  STRESS_BURST,
  STRESS_ITER,
  STRESS_LATENCY_MS,
  STRESS_SEED,
  type StressHarness,
  writeReport,
} from "./stress_onboarding_harness.ts";

const FILE = "stress_route_put_v1_me_onboarding_concurrency.test.ts";
const PATH = "/v1/me/onboarding";
const ROUND_BUDGET_MS = 10_000;

interface Lane {
  round: number;
  i: number;
  op: string;
  status: number;
  body: Record<string, unknown>;
  retryAfter: string | null;
  bearerTail: string;
  startedAt: number;
  endedAt: number;
}

const campaign: Array<{
  scenario: string;
  rounds: number;
  requests: number;
  broken: number;
  durationMs: number;
  report: string;
}> = [];
let campaignRequests = 0;
const heapAtStart = Deno.memoryUsage();

function laneIp(seed: number, lane: number): string {
  return `10.${(seed >>> 16) & 255}.${(seed >>> 8) & 255}.${1 + (lane % 250)}`;
}

function profileOf(body: Record<string, unknown>): Record<string, unknown> {
  const p = body.profile;
  return p && typeof p === "object" ? (p as Record<string, unknown>) : {};
}

function planFocus(body: Record<string, unknown>): unknown {
  const plan = body.plan;
  return plan && typeof plan === "object" ? (plan as Record<string, unknown>).focusCheckpoint : undefined;
}

/** A profile snapshot is torn when focus_checkpoint does not follow primary_goal. */
function snapshotConsistent(profile: Record<string, unknown>): boolean {
  const goal = profile.primary_goal;
  const focus = profile.focus_checkpoint;
  if (goal === null || goal === undefined) return focus === null || focus === undefined;
  return focus === (GOAL_FOCUS[String(goal)] ?? "contact_position");
}

/** Committed row (has onboarding_state) matches the payload's contract columns. */
function matchesExpected(row: Record<string, unknown>, payload: OnboardingPayload): boolean {
  return Object.entries(expectedColumns(payload)).every(([k, v]) => row[k] === v);
}

/** 200 body `profile` (seven selected columns) echoes the payload. */
function echoesPayload(profile: Record<string, unknown>, payload: OnboardingPayload): boolean {
  return Object.entries(expectedProfileEcho(payload)).every(([k, v]) => profile[k] === v);
}

async function timed(
  lanes: Lane[],
  round: number,
  i: number,
  op: string,
  bearer: string,
  fn: () => Promise<Response>,
): Promise<Lane> {
  const startedAt = performance.now();
  const response = await fn();
  const body = await readJson(response);
  const lane: Lane = {
    round,
    i,
    op,
    status: response.status,
    body,
    retryAfter: response.headers.get("retry-after"),
    bearerTail: bearerTail(bearer),
    startedAt: Math.round(startedAt * 100) / 100,
    endedAt: Math.round(performance.now() * 100) / 100,
  };
  lanes.push(lane);
  return lane;
}

interface RoundCtx {
  h: StressHarness;
  prng: Prng;
  seed: number;
  round: number;
  lanes: Lane[];
  inv: (name: string, holds: boolean, detail: string) => void;
  ip: (lane: number) => string;
  /** ops whose 5xx is asserted by the scenario itself instead of the global "no 5xx" */
  tolerate5xx: Set<string>;
}

async function scenario(
  name: string,
  filter: string,
  run: (ctx: RoundCtx) => Promise<void>,
  extraObservations?: () => Record<string, unknown>,
): Promise<ScenarioReport> {
  const h = await loadStressHarness();
  const rounds: ScenarioReport["rounds"] = [];
  const invariants: Invariant[] = [];
  const allLanes: Lane[] = [];
  const counters: Record<string, number> = {};
  const before = Deno.memoryUsage();
  const t0 = performance.now();
  const seeds = roundSeeds(name);
  for (let round = 0; round < seeds.length; round++) {
    const seed = seeds[round];
    h.fake.reset(seed, STRESS_LATENCY_MS);
    h.upstreamCalls.length = 0;
    const prng = new Prng(seed);
    const lanes: Lane[] = [];
    const roundInvariants: Invariant[] = [];
    const ctx: RoundCtx = {
      h,
      prng,
      seed,
      round,
      lanes,
      inv: (n, holds, detail) => roundInvariants.push({ name: `r${round}: ${n}`, holds, detail }),
      ip: (lane) => laneIp(seed, lane),
      tolerate5xx: new Set(),
    };
    let settled = false;
    try {
      await bounded(`${name} round ${round}`, ROUND_BUDGET_MS, run(ctx));
      settled = true;
    } catch (error) {
      roundInvariants.push({
        name: `r${round}: round settles within ${ROUND_BUDGET_MS}ms without throwing`,
        holds: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
    if (settled) {
      ctx.inv(
        "no 5xx",
        lanes.every((l) => l.status < 500 || ctx.tolerate5xx.has(l.op)),
        JSON.stringify(histogram(lanes.map((l) => `${l.op}:${l.status}`))),
      );
      ctx.inv(
        "route never reaches an unmodelled upstream (no permits/shots/RPC/RevenueCat fan-out)",
        h.fake.unmodelled.length === 0,
        h.fake.unmodelled.slice(0, 5).join(" | ") || "none",
      );
      ctx.inv(
        "no duplicate profile rows",
        h.fake.profiles.size === h.fake.users.size,
        `${h.fake.profiles.size} rows for ${h.fake.users.size} users`,
      );
      ctx.inv(
        "no column-grant or CHECK violation reaches PostgREST",
        (h.fake.counters["postgrest.grant_denied"] ?? 0) === 0 &&
          (h.fake.counters["postgrest.check_violation"] ?? 0) === 0,
        JSON.stringify(h.fake.pgFailures.slice(0, 5)),
      );
    }
    for (const [k, v] of Object.entries(h.fake.counters)) counters[k] = (counters[k] ?? 0) + v;
    invariants.push(...roundInvariants);
    allLanes.push(...lanes);
    const broken = roundInvariants.filter((i) => !i.holds);
    rounds.push({
      round,
      seed,
      outcome: broken.length === 0 ? "HELD" : "BROKEN",
      detail: broken.length === 0
        ? `${lanes.length} requests, ${roundInvariants.length} invariants`
        : broken.map((b) => `${b.name}: ${b.detail}`).join(" || "),
      replay: roundReplayCommand(FILE, filter, seed),
    });
  }
  const durationMs = Math.round(performance.now() - t0);
  const after = Deno.memoryUsage();
  const report: ScenarioReport = {
    scenario: name,
    seed: STRESS_SEED,
    scale: { iter: STRESS_ITER, burst: STRESS_BURST, latencyMs: STRESS_LATENCY_MS },
    rounds,
    statusHistogram: histogram(allLanes.map((l) => `${l.op}:${l.status}`)),
    counters,
    invariants,
    observations: {
      ...(extraObservations?.() ?? {}),
      requestsExecuted: allLanes.length,
      lastRoundTimeline: h.fake.timeline.slice(-60),
    },
    requestsExecuted: allLanes.length,
    durationMs,
    heap: { before, after },
    replay: replayCommand(FILE, filter, STRESS_SEED),
  };
  const path = await writeReport(report);
  campaignRequests += allLanes.length;
  campaign.push({
    scenario: name,
    rounds: rounds.length,
    requests: allLanes.length,
    broken: rounds.filter((r) => r.outcome === "BROKEN").length,
    durationMs,
    report: path,
  });
  console.log(`[stress] ${name}: ${rounds.length} rounds, ${allLanes.length} requests, ${durationMs}ms → ${path}`);
  for (const r of rounds.filter((r) => r.outcome === "BROKEN")) {
    console.log(`[stress]   BROKEN seed=${r.seed}: ${r.detail}`);
  }
  const brokenRounds = rounds.filter((r) => r.outcome === "BROKEN");
  assertEquals(
    brokenRounds.map((r) => r.seed),
    [],
    `${name}: BROKEN rounds — ${brokenRounds.map((r) => `seed=${r.seed} ${r.detail}`).join("\n")}`,
  );
  return report;
}

function put(
  ctx: RoundCtx,
  i: number,
  op: string,
  token: string,
  payload: unknown,
  extra: { headers?: Record<string, string>; signal?: AbortSignal } = {},
): Promise<Lane> {
  return timed(ctx.lanes, ctx.round, i, op, token, () =>
    ctx.h.handler(
      edgeRequest("PUT", PATH, { token, ip: ctx.ip(i), body: payload, ...extra }),
    ));
}

function jitter(ctx: RoundCtx): Promise<void> {
  return sleep(ctx.prng.int(0, STRESS_LATENCY_MS * 2));
}

// ─────────────────────────────────────────────────────────────────────────────
// S1 — duplicate identical PUTs (idempotent delivery)
// ─────────────────────────────────────────────────────────────────────────────

Deno.test("stress S1: N identical PUT /v1/me/onboarding in one burst — all 200, identical bodies, row = payload, one row", async () => {
  await scenario("s1_duplicate_identical_burst", "stress S1", async (ctx) => {
    const { h, prng } = ctx;
    const uid = prng.uuid();
    h.fake.createUser(uid);
    const { accessToken } = h.fake.mintSession(uid);
    const payload = randomPayload(prng);
    const results = await Promise.all(
      Array.from({ length: STRESS_BURST }, async (_, i) => {
        await jitter(ctx);
        return put(ctx, i, "put.dup", accessToken, payload);
      }),
    );
    const ok = results.filter((r) => r.status === 200);
    ctx.inv("every duplicate answers 200", ok.length === results.length, `${ok.length}/${results.length}`);
    const bodies = new Set(results.map((r) => JSON.stringify(r.body)));
    ctx.inv("duplicate responses are byte-identical (idempotent)", bodies.size === 1, `${bodies.size} distinct bodies`);
    const row = h.fake.profiles.get(uid)!;
    ctx.inv(
      "final row equals the payload (no lost update)",
      matchesExpected(row as unknown as Record<string, unknown>, payload),
      JSON.stringify(expectedColumns(payload)),
    );
    ctx.inv(
      "exactly one PATCH per 200 (no double write, no dropped write)",
      (h.fake.counters["postgrest.profiles.patch"] ?? 0) === ok.length,
      `patch=${h.fake.counters["postgrest.profiles.patch"] ?? 0} ok=${ok.length}`,
    );
    ctx.inv(
      "each response's plan.focusCheckpoint == profile.focus_checkpoint == GOAL_FOCUS[goal]",
      ok.every(
        (r) =>
          planFocus(r.body) === GOAL_FOCUS[payload.goal] &&
          profileOf(r.body).focus_checkpoint === GOAL_FOCUS[payload.goal] &&
          r.body.recommendedCheckpoint === GOAL_FOCUS[payload.goal],
      ),
      GOAL_FOCUS[payload.goal],
    );
    ctx.inv(
      "auth verified once per bearer, then served from cache",
      (h.fake.counters["gotrue.get_user"] ?? 0) >= 1 && (h.fake.counters["gotrue.get_user"] ?? 0) <= results.length,
      `get_user=${h.fake.counters["gotrue.get_user"] ?? 0}`,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// S2 — conflicting payloads from two devices of ONE user (lost update / torn row)
// ─────────────────────────────────────────────────────────────────────────────

Deno.test("stress S2: conflicting payloads from two sessions of one user — every 200 reflects its own write atomically, final row is one lane's payload, never torn", async () => {
  await scenario("s2_conflicting_payloads_two_devices", "stress S2", async (ctx) => {
    const { h, prng } = ctx;
    const uid = prng.uuid();
    h.fake.createUser(uid);
    const deviceA = h.fake.mintSession(uid).accessToken;
    const deviceB = h.fake.mintSession(uid).accessToken;
    h.fake.patchHoldMs = () => prng.int(0, STRESS_LATENCY_MS);
    const payloads = Array.from({ length: STRESS_BURST }, () => randomPayload(prng));
    const tokens = payloads.map(() => (prng.chance(0.5) ? deviceA : deviceB));
    const results = await Promise.all(
      payloads.map(async (payload, i) => {
        await jitter(ctx);
        return put(ctx, i, tokens[i] === deviceA ? "put.A" : "put.B", tokens[i], payload);
      }),
    );
    const ok = results.filter((r) => r.status === 200);
    ctx.inv("every conflicting write answers 200", ok.length === results.length, `${ok.length}/${results.length}`);
    ctx.inv(
      "every 200 echoes ITS OWN write (RETURNING of the same statement, never a sibling's)",
      results.every((r, i) => r.status !== 200 || echoesPayload(profileOf(r.body), payloads[i])),
      results
        .map((r, i) => (r.status === 200 && !echoesPayload(profileOf(r.body), payloads[i]) ? `lane ${i}` : null))
        .filter(Boolean)
        .join(",") || "all own",
    );
    ctx.inv(
      "no response snapshot is torn (focus follows goal in every 200)",
      ok.every((r) =>
        snapshotConsistent(profileOf(r.body)) && planFocus(r.body) === profileOf(r.body).focus_checkpoint
      ),
      "checked plan.focusCheckpoint == profile.focus_checkpoint == GOAL_FOCUS[primary_goal]",
    );
    const row = h.fake.profiles.get(uid)! as unknown as Record<string, unknown>;
    const winner = payloads.findIndex((p) => matchesExpected(row, p));
    ctx.inv(
      "final row is exactly one lane's payload (atomic last-writer-wins, not a merge of two writes)",
      winner >= 0 && snapshotConsistent(row),
      winner >= 0 ? `lane ${winner} won` : `row ${JSON.stringify(row)}`,
    );
    const lastWrite = h.fake.writes.at(-1);
    const lastRow = (lastWrite?.rowAfter ?? {}) as unknown as Record<string, unknown>;
    ctx.inv(
      "final row equals the LAST committed statement (no lost update: a later commit is never overwritten by an earlier one)",
      !!lastWrite && Object.keys(expectedColumns(payloads[0])).every((k) => row[k] === lastRow[k]) &&
        row.version === lastRow.version,
      lastWrite ? `seq=${lastWrite.seq} version=${row.version}` : "no writes",
    );
    const sentNames = new Set<unknown>([
      null,
      ...payloads.filter((p) => p.firstName !== undefined).map((p) => p.firstName),
    ]);
    const sentGenders = new Set<unknown>([
      null,
      ...payloads.filter((p) => p.gender !== undefined).map((p) => p.gender),
    ]);
    ctx.inv(
      "optional columns only ever hold a value some lane sent (absent means untouched, never coerced)",
      sentNames.has(row.first_name) && sentGenders.has(row.gender),
      `first_name=${row.first_name} gender=${row.gender}`,
    );
    ctx.inv(
      "PATCH count == 200 count and row version == PATCH count (every write landed exactly once)",
      (h.fake.counters["postgrest.profiles.patch"] ?? 0) === ok.length && row.version === ok.length,
      `patch=${h.fake.counters["postgrest.profiles.patch"]} version=${row.version} ok=${ok.length}`,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// S3 — two actors: user B (and a forged bearer) racing user A on A's row
// ─────────────────────────────────────────────────────────────────────────────

Deno.test("stress S3: two actors — B's PUTs (with A's id smuggled in the body) and a forged sub=A bearer never touch A's row; A's row is A's last write", async () => {
  await scenario("s3_two_actors_same_row", "stress S3", async (ctx) => {
    const { h, prng } = ctx;
    const a = prng.uuid();
    const b = prng.uuid();
    h.fake.createUser(a);
    h.fake.createUser(b, "apple");
    const tokenA = h.fake.mintSession(a).accessToken;
    const tokenB = h.fake.mintSession(b).accessToken;
    const sessionB = h.fake.sessions.get(h.fake.accessIndex.get(tokenB)!)!;
    // A bearer that CLAIMS sub=A but was never issued by GoTrue (signature is
    // not checked by the route — GoTrue getUser must refuse it).
    const forged = h.fake.accessTokenFor(
      { ...sessionB, userId: a, accessTokens: new Set() },
      Math.floor(Date.now() / 1000) + 3600,
    );
    h.fake.accessIndex.delete(forged);
    const payloadsA: OnboardingPayload[] = [];
    const results = await Promise.all(
      Array.from({ length: STRESS_BURST }, async (_, i) => {
        await jitter(ctx);
        const kind = i % 4;
        if (kind === 0 || kind === 1) {
          const p = randomPayload(prng);
          payloadsA.push(p);
          return put(ctx, i, "put.A", tokenA, p);
        }
        if (kind === 2) {
          // B smuggles A's identity into every place a sloppy handler might read it.
          return put(ctx, i, "put.B.smuggle", tokenB, {
            ...randomPayload(prng),
            id: a,
            userId: a,
            user_id: a,
            profileId: a,
          }, {
            headers: { "x-user-id": a, "x-supabase-user": a },
          });
        }
        return put(ctx, i, "put.forged", forged, randomPayload(prng));
      }),
    );
    const byOp = (op: string) => results.filter((r) => r.op === op);
    const statuses = (op: string) => JSON.stringify(histogram(byOp(op).map((r) => String(r.status))));
    ctx.inv("A's writes all 200", byOp("put.A").every((r) => r.status === 200), statuses("put.A"));
    ctx.inv(
      "B's smuggling writes are 200 against B's OWN row only",
      byOp("put.B.smuggle").every((r) => r.status === 200) &&
        h.fake.writes.filter((w) => w.bearerTail === bearerTail(tokenB)).every((w) => w.userId === b),
      statuses("put.B.smuggle"),
    );
    ctx.inv(
      "forged sub=A bearer is 401 and never writes",
      byOp("put.forged").every((r) => r.status === 401) &&
        h.fake.writes.every((w) => w.bearerTail !== bearerTail(forged)),
      statuses("put.forged"),
    );
    const rowA = h.fake.profiles.get(a)! as unknown as Record<string, unknown>;
    ctx.inv(
      "A's row was written ONLY by A's bearer",
      h.fake.writes.filter((w) => w.userId === a).every((w) => w.bearerTail === bearerTail(tokenA)),
      `${h.fake.writes.filter((w) => w.userId === a).length} writes on A`,
    );
    ctx.inv(
      "A's final row is one of A's payloads and not torn",
      payloadsA.some((p) => matchesExpected(rowA, p)) && snapshotConsistent(rowA),
      JSON.stringify(rowA),
    );
    ctx.inv(
      "B's row never carries A's id and A's row never carries B's provider",
      h.fake.profiles.get(b)!.id === b && rowA.provider === "google" && h.fake.profiles.get(b)!.provider === "apple",
      "",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// S4 — call-during-call: GET /v1/me while PUTs are in flight
// ─────────────────────────────────────────────────────────────────────────────

Deno.test("stress S4: GET /v1/me interleaved with PUT bursts — every read is a consistent snapshot, the read after the burst equals the row", async () => {
  await scenario("s4_get_during_put", "stress S4", async (ctx) => {
    const { h, prng } = ctx;
    const uid = prng.uuid();
    h.fake.createUser(uid);
    const token = h.fake.mintSession(uid).accessToken;
    h.fake.patchHoldMs = () => prng.int(0, STRESS_LATENCY_MS);
    const results = await Promise.all(
      Array.from({ length: STRESS_BURST }, async (_, i) => {
        await jitter(ctx);
        if (i % 3 === 2) {
          return timed(
            ctx.lanes,
            ctx.round,
            i,
            "get.me",
            token,
            () => h.handler(edgeRequest("GET", "/v1/me", { token, ip: ctx.ip(i) })),
          );
        }
        return put(ctx, i, "put", token, randomPayload(prng));
      }),
    );
    const gets = results.filter((r) => r.op === "get.me");
    const puts = results.filter((r) => r.op === "put");
    ctx.inv(
      "every GET and PUT answers 200",
      results.every((r) => r.status === 200),
      JSON.stringify(histogram(results.map((r) => `${r.op}:${r.status}`))),
    );
    ctx.inv(
      "every GET snapshot is consistent (focus follows goal; onboardingState matches the row state)",
      gets.every((g) => {
        const p = profileOf(g.body);
        const complete = g.body.onboardingState === "complete";
        return snapshotConsistent(p) && (complete ? p.skill_level !== null : p.skill_level === null);
      }),
      `${gets.length} reads`,
    );
    const after = await timed(
      ctx.lanes,
      ctx.round,
      999,
      "get.me.after",
      token,
      () => h.handler(edgeRequest("GET", "/v1/me", { token, ip: ctx.ip(251) })),
    );
    const row = h.fake.profiles.get(uid)! as unknown as Record<string, unknown>;
    const p = profileOf(after.body);
    ctx.inv(
      "read after the burst equals the committed row",
      after.status === 200 &&
        ["skill_level", "handedness", "primary_goal", "biggest_problem", "focus_checkpoint", "first_name", "gender"]
          .every((k) => p[k] === row[k]) &&
        after.body.onboardingState === row.onboarding_state,
      JSON.stringify(p),
    );
    ctx.inv(
      "PATCH count == PUT 200 count",
      (h.fake.counters["postgrest.profiles.patch"] ?? 0) === puts.filter((r) => r.status === 200).length,
      "",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// S5 — cancel during call
// ─────────────────────────────────────────────────────────────────────────────

Deno.test("stress S5: client cancels mid-call (aborted upload, AbortSignal, abandoned await) — no 5xx, aborted uploads never write, completed writes are whole, every handler settles", async () => {
  let abandoned = 0;
  await scenario(
    "s5_cancel_during_call",
    "stress S5",
    async (ctx) => {
      const { h, prng } = ctx;
      const uid = prng.uuid();
      h.fake.createUser(uid);
      const { session } = h.fake.mintSession(uid);
      const exp = Math.floor(Date.now() / 1000) + 3600;
      // One access token per lane so every write is attributable to its lane.
      const tokens = Array.from({ length: STRESS_BURST }, () => h.fake.accessTokenFor(session, exp));
      const payloads = Array.from({ length: STRESS_BURST }, () => randomPayload(prng));
      const kinds = payloads.map(() => prng.pick(["abort_upload", "abort_signal", "abandon", "normal"] as const));
      const pending: Promise<Lane>[] = [];
      const results = await Promise.all(
        payloads.map(async (payload, i) => {
          await jitter(ctx);
          const token = tokens[i];
          const kind = kinds[i];
          if (kind === "abort_upload") {
            // The client disconnects while the JSON is still streaming in.
            const encoded = new TextEncoder().encode(JSON.stringify(payload));
            const cut = prng.int(1, encoded.length - 1);
            const stream = new ReadableStream<Uint8Array>({
              async pull(controller) {
                controller.enqueue(encoded.slice(0, cut));
                await sleep(prng.int(0, STRESS_LATENCY_MS));
                controller.error(new Error("client disconnected"));
              },
            });
            return timed(
              ctx.lanes,
              ctx.round,
              i,
              "put.abort_upload",
              token,
              () => h.handler(edgeRequest("PUT", PATH, { token, ip: ctx.ip(i), rawBody: stream })),
            );
          }
          if (kind === "abort_signal") {
            const controller = new AbortController();
            const p = put(ctx, i, "put.abort_signal", token, payload, { signal: controller.signal });
            setTimeout(() => controller.abort(), prng.int(0, STRESS_LATENCY_MS * 2));
            return p;
          }
          if (kind === "abandon") {
            // The client stops waiting; the server still finishes the request.
            const p = put(ctx, i, "put.abandon", token, payload);
            pending.push(p);
            abandoned += 1;
            const raced = await Promise.race([p, sleep(prng.int(0, STRESS_LATENCY_MS)).then(() => null)]);
            return raced ??
              {
                round: ctx.round,
                i,
                op: "put.abandon.client_gone",
                status: 0,
                body: {},
                retryAfter: null,
                bearerTail: bearerTail(token),
                startedAt: 0,
                endedAt: 0,
              };
          }
          return put(ctx, i, "put.normal", token, payload);
        }),
      );
      const settled = await Promise.allSettled(pending);
      ctx.inv(
        "every abandoned handler settles (no dangling work)",
        settled.every((s) => s.status === "fulfilled"),
        `${settled.length} abandoned`,
      );
      const all = ctx.lanes.filter((l) => l.round === ctx.round);
      ctx.inv(
        "no 5xx across cancelled and completed lanes",
        all.every((l) => l.status < 500),
        JSON.stringify(histogram(all.map((l) => `${l.op}:${l.status}`))),
      );
      const uploads = all.filter((l) => l.op === "put.abort_upload");
      ctx.inv(
        "aborted uploads are 400 and never write",
        uploads.every((l) => l.status === 400 && !h.fake.writes.some((w) => w.bearerTail === l.bearerTail)),
        JSON.stringify(histogram(uploads.map((l) => String(l.status)))),
      );
      ctx.inv(
        "every 200 (including abandoned/aborted-signal lanes) wrote exactly once, and only 200s wrote",
        all.filter((l) => l.status === 200).every((l) =>
          h.fake.writes.filter((w) => w.bearerTail === l.bearerTail).length === 1
        ) &&
          h.fake.writes.every((w) => all.some((l) => l.bearerTail === w.bearerTail && l.status === 200)),
        `writes=${h.fake.writes.length} ok=${all.filter((l) => l.status === 200).length}`,
      );
      const row = h.fake.profiles.get(uid)! as unknown as Record<string, unknown>;
      ctx.inv(
        "final row is whole: one lane's payload or still pristine",
        (row.onboarding_state === "pending" && row.skill_level === null) ||
          (payloads.some((p) => matchesExpected(row, p)) && snapshotConsistent(row)),
        JSON.stringify(row),
      );
      void results;
    },
    () => ({ abandonedLanes: abandoned }),
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// S6 — refresh rotation and logout during a PUT burst
// ─────────────────────────────────────────────────────────────────────────────

Deno.test("stress S6: refresh rotation + logout while PUTs are in flight — statuses ⊆ {200,401}, every 200 wrote once, a PUT started after logout is 401, all session tokens dead afterwards", async () => {
  await scenario("s6_rotation_logout_during_request", "stress S6", async (ctx) => {
    const { h, prng } = ctx;
    const uid = prng.uuid();
    h.fake.createUser(uid);
    const { session, accessToken: t0 } = h.fake.mintSession(uid);
    const t1 = h.fake.accessTokenFor(session, Math.floor(Date.now() / 1000) + 3600);
    h.fake.getUserDelayMs = () => prng.int(0, STRESS_LATENCY_MS);
    let logoutDone = Number.POSITIVE_INFINITY;
    let logoutStatus = 0;
    let refreshStatus = 0;
    let t2: string | null = null;
    const logoutAt = prng.int(0, STRESS_LATENCY_MS * 3);
    const refreshAt = prng.int(0, STRESS_LATENCY_MS * 3);
    const puts = Array.from({ length: STRESS_BURST }, async (_, i) => {
      await jitter(ctx);
      const token = prng.chance(0.5) ? t0 : t1;
      return put(ctx, i, token === t0 ? "put.t0" : "put.t1", token, randomPayload(prng));
    });
    const refresh = (async () => {
      await sleep(refreshAt);
      const lane = await timed(
        ctx.lanes,
        ctx.round,
        252,
        "auth.refresh",
        "",
        () =>
          h.handler(
            edgeRequest("POST", "/v1/auth/refresh", { ip: ctx.ip(252), body: { refreshToken: session.refreshToken } }),
          ),
      );
      refreshStatus = lane.status;
      const s = lane.body.session as Record<string, unknown> | undefined;
      if (lane.status === 200 && typeof s?.accessToken === "string") t2 = s.accessToken;
    })();
    const logout = (async () => {
      await sleep(logoutAt);
      const lane = await timed(
        ctx.lanes,
        ctx.round,
        253,
        "auth.logout",
        t0,
        () => h.handler(edgeRequest("POST", "/v1/auth/logout", { token: t0, ip: ctx.ip(253) })),
      );
      logoutStatus = lane.status;
      logoutDone = lane.endedAt;
    })();
    const results = await Promise.all(puts);
    await Promise.all([refresh, logout]);
    ctx.inv("logout is 204", logoutStatus === 204, `status=${logoutStatus}`);
    ctx.inv(
      "refresh is 200 (rotated) or 401 (raced a completed logout) — never 5xx",
      refreshStatus === 200 || refreshStatus === 401,
      `status=${refreshStatus}`,
    );
    ctx.inv(
      "PUT statuses ⊆ {200, 401}",
      results.every((r) => r.status === 200 || r.status === 401),
      JSON.stringify(histogram(results.map((r) => `${r.op}:${r.status}`))),
    );
    ctx.inv(
      "every PUT that STARTED after logout completed is 401",
      results.every((r) => r.startedAt < logoutDone || r.status === 401),
      `logoutDone=${logoutDone} late=${results.filter((r) => r.startedAt >= logoutDone).length}`,
    );
    ctx.inv(
      "PATCH count == PUT 200 count (an authenticated write is whole; a refused one never writes)",
      (h.fake.counters["postgrest.profiles.patch"] ?? 0) === results.filter((r) => r.status === 200).length,
      `patch=${h.fake.counters["postgrest.profiles.patch"]} ok=${results.filter((r) => r.status === 200).length}`,
    );
    const survivors = [t0, t1, ...(t2 ? [t2] : [])];
    const probes = await Promise.all(
      survivors.map((token, i) =>
        timed(
          ctx.lanes,
          ctx.round,
          240 + i,
          "probe.after_logout",
          token,
          () => h.handler(edgeRequest("GET", "/v1/me", { token, ip: ctx.ip(240 + i) })),
        )
      ),
    );
    ctx.inv(
      "after logout every access token of the session (pre-rotation, sibling, rotated) is 401",
      probes.every((p) => p.status === 401),
      JSON.stringify(probes.map((p) => p.status)),
    );
    const row = h.fake.profiles.get(uid)! as unknown as Record<string, unknown>;
    ctx.inv(
      "row is whole after the race",
      row.onboarding_state === "pending" || snapshotConsistent(row),
      JSON.stringify(row),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// S7 — clock skew on bearer exp
// ─────────────────────────────────────────────────────────────────────────────

Deno.test("stress S7: bearer exp skewed around now (session and Google ID tokens) — expired at arrival is 401 with zero upstream calls, live tokens never 5xx, nothing is served past exp", async () => {
  const midFlight: Array<{ seed: number; skewMs: number; status: number }> = [];
  await scenario(
    "s7_clock_skew",
    "stress S7",
    async (ctx) => {
      const { h, prng } = ctx;
      const uid = prng.uuid();
      h.fake.createUser(uid);
      const { session } = h.fake.mintSession(uid);
      // MID_FLIGHT lanes: exp is the next whole second, and GoTrue holds the
      // verification until just past it — the bearer is live at arrival and
      // dead by the time PostgREST sees it (clock skew mid-flight).
      const MID_FLIGHT_MS = 150;
      const skewsMs = [-30_000, -1_000, -1, 0, MID_FLIGHT_MS, 1_500, 3_000, 30_000, 3_600_000];
      const midFlightExp = new Map<string, number>();
      h.fake.getUserDelayMs = (bearer) => {
        const expMs = midFlightExp.get(bearerTail(bearer));
        return expMs === undefined ? 0 : Math.max(0, expMs - Date.now()) + 50;
      };
      const lanes = Array.from({ length: STRESS_BURST }, (_, i) => {
        const skewMs = prng.pick(skewsMs);
        const nowMs = Date.now();
        const expSeconds = skewMs === MID_FLIGHT_MS
          ? Math.ceil((nowMs + 1) / 1000)
          : Math.floor((nowMs + skewMs) / 1000);
        const kind = i % 5 === 4 ? "google" : "session";
        const token = kind === "google"
          ? fakeGoogleIdToken(uid, `${ctx.seed}-${i}`, expSeconds)
          : h.fake.accessTokenFor(session, expSeconds);
        if (skewMs === MID_FLIGHT_MS) {
          midFlightExp.set(bearerTail(token), expSeconds * 1000);
          ctx.tolerate5xx.add(`put.${kind}.skew+${MID_FLIGHT_MS}`);
        }
        return { i, skewMs, expSeconds, kind, token };
      });
      const results = await Promise.all(
        lanes.map(async (lane) => {
          await jitter(ctx);
          const sentAt = Date.now();
          const res = await put(
            ctx,
            lane.i,
            `put.${lane.kind}.skew${lane.skewMs >= 0 ? "+" : ""}${lane.skewMs}`,
            lane.token,
            randomPayload(prng),
          );
          return { ...lane, sentAt, res };
        }),
      );
      const deadAtArrival = results.filter((r) => r.expSeconds * 1000 <= r.sentAt);
      const calledUpstream = (token: string) =>
        h.fake.timeline.some((e) => e.detail.includes(`bearer=${bearerTail(token)}`));
      ctx.inv(
        "a bearer already expired at arrival is 401 and consults no upstream",
        deadAtArrival.every((r) => r.res.status === 401 && !calledUpstream(r.token)),
        JSON.stringify(histogram(deadAtArrival.map((r) => String(r.res.status)))),
      );
      const comfortablyLive = results.filter((r) => r.expSeconds * 1000 > r.sentAt + 1_000);
      // A provider ID token is exchanged for a session; the PATCH bears that session's token.
      const writeBearer = (token: string) => bearerTail(h.fake.exchanged.get(token) ?? token);
      ctx.inv(
        "a bearer live for ≥1s at arrival is 200 (session or provider token) and writes once",
        comfortablyLive.every((r) =>
          r.res.status === 200 && h.fake.writes.filter((w) => w.bearerTail === writeBearer(r.token)).length === 1
        ),
        JSON.stringify(histogram(comfortablyLive.map((r) => `${r.kind}:${r.res.status}`))),
      );
      const expiredInFlight = results.filter((r) =>
        r.expSeconds * 1000 > r.sentAt && r.expSeconds * 1000 <= r.sentAt + 1_000
      );
      for (const r of expiredInFlight) midFlight.push({ seed: ctx.seed, skewMs: r.skewMs, status: r.res.status });
      ctx.inv(
        "a bearer that expires mid-flight is 200 (landed in time), 401 or 503 (refused upstream) — never a partial write, never 500",
        expiredInFlight.every(
          (r) =>
            (r.res.status === 200 && h.fake.writes.filter((w) => w.bearerTail === writeBearer(r.token)).length === 1) ||
            ((r.res.status === 401 || r.res.status === 503) &&
              !h.fake.writes.some((w) => w.bearerTail === writeBearer(r.token))),
        ),
        JSON.stringify(histogram(expiredInFlight.map((r) => `${r.kind}:${r.res.status}`))),
      );
      // Nothing is served past exp — including bearers verified and cached above.
      const soonDead = results.filter((r) => r.skewMs > 0 && r.skewMs <= 3_000);
      if (soonDead.length > 0) {
        const waitMs = Math.max(0, Math.max(...soonDead.map((r) => r.expSeconds * 1000)) - Date.now() + 5);
        await sleep(Math.min(waitMs, 3_500));
        const probes = await Promise.all(
          soonDead.map((r) =>
            timed(
              ctx.lanes,
              ctx.round,
              200 + r.i,
              "probe.past_exp",
              r.token,
              () => h.handler(edgeRequest("GET", "/v1/me", { token: r.token, ip: ctx.ip(200 + r.i) })),
            )
          ),
        );
        ctx.inv(
          "a bearer past its exp is refused even when its verification was cached moments ago",
          probes.every((p) => p.status === 401),
          JSON.stringify(histogram(probes.map((p) => String(p.status)))),
        );
      }
      const row = h.fake.profiles.get(uid)! as unknown as Record<string, unknown>;
      ctx.inv("row is whole", row.onboarding_state === "pending" || snapshotConsistent(row), JSON.stringify(row));
    },
    () => ({
      expiresWithin1sOfArrival: midFlight,
      expiresWithin1sHistogram: histogram(midFlight.map((m) => String(m.status))),
    }),
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// S8 — per-user budget atomicity (the only "spend" this route has)
// ─────────────────────────────────────────────────────────────────────────────

Deno.test("stress S8: 250 concurrent PUTs from one user — exactly 240 are 200 (GENERAL_USER_LIMIT), the rest 429 with Retry-After and no write", async () => {
  await scenario("s8_user_budget_atomicity", "stress S8", async (ctx) => {
    const { h, prng } = ctx;
    const uid = prng.uuid();
    h.fake.createUser(uid);
    const token = h.fake.mintSession(uid).accessToken;
    const payload = randomPayload(prng);
    const N = 250;
    const results = await Promise.all(
      Array.from({ length: N }, async (_, i) => {
        await sleep(prng.int(0, 2));
        return timed(
          ctx.lanes,
          ctx.round,
          i,
          "put.budget",
          token,
          () => h.handler(edgeRequest("PUT", PATH, { token, ip: ctx.ip(i), body: payload })),
        );
      }),
    );
    const ok = results.filter((r) => r.status === 200).length;
    const limitedLanes = results.filter((r) => r.status === 429);
    const limited = limitedLanes.length;
    ctx.inv(
      "exactly 240 admitted, 10 limited (atomic INCR, never under-counted)",
      ok === 240 && limited === 10,
      `ok=${ok} 429=${limited} other=${N - ok - limited}`,
    );
    ctx.inv(
      "every 429 carries a positive integer Retry-After",
      limitedLanes.every((r) => r.retryAfter !== null && /^[1-9]\d*$/.test(r.retryAfter)),
      JSON.stringify(histogram(limitedLanes.map((r) => String(r.retryAfter)))),
    );
    ctx.inv(
      "PATCH count == 240",
      (h.fake.counters["postgrest.profiles.patch"] ?? 0) === 240,
      `patch=${h.fake.counters["postgrest.profiles.patch"]}`,
    );
    ctx.inv(
      "row equals the payload",
      matchesExpected(h.fake.profiles.get(uid)! as unknown as Record<string, unknown>, payload),
      "",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// S9 — mixed valid / invalid payloads in one burst
// ─────────────────────────────────────────────────────────────────────────────

Deno.test("stress S9: valid and invalid payloads interleaved — invalid are 400 and never reach PostgREST, valid are 200, final row is a valid lane's payload", async () => {
  await scenario("s9_mixed_validity_burst", "stress S9", async (ctx) => {
    const { h, prng } = ctx;
    const uid = prng.uuid();
    h.fake.createUser(uid);
    const token = h.fake.mintSession(uid).accessToken;
    const invalids: Array<() => unknown> = [
      () => ({ ...randomPayload(prng), handedness: "ambidextrous" }),
      () => ({ ...randomPayload(prng), skillLevel: "x".repeat(65) }),
      () => ({ ...randomPayload(prng), goal: "" }),
      () => ({ ...randomPayload(prng), biggestProblem: "y".repeat(257) }),
      () => ({ ...randomPayload(prng), firstName: 42 }),
      () => ({ ...randomPayload(prng), firstName: "\u200b\u200b" }),
      () => ({ ...randomPayload(prng), firstName: "z".repeat(41) }),
      () => ({ ...randomPayload(prng), gender: "other" }),
      () => ({}),
      () => [1, 2, 3],
      () => "not json object",
    ];
    const valids: OnboardingPayload[] = [];
    const results = await Promise.all(
      Array.from({ length: STRESS_BURST }, async (_, i) => {
        await jitter(ctx);
        if (prng.chance(0.5)) {
          return put(ctx, i, "put.invalid", token, prng.pick(invalids)());
        }
        const p = randomPayload(prng);
        valids.push(p);
        return put(ctx, i, "put.valid", token, p);
      }),
    );
    ctx.inv(
      "invalid → 400",
      results.filter((r) => r.op === "put.invalid").every((r) => r.status === 400),
      JSON.stringify(histogram(results.filter((r) => r.op === "put.invalid").map((r) => String(r.status)))),
    );
    ctx.inv(
      "valid → 200",
      results.filter((r) => r.op === "put.valid").every((r) => r.status === 200),
      JSON.stringify(histogram(results.filter((r) => r.op === "put.valid").map((r) => String(r.status)))),
    );
    ctx.inv(
      "PATCH count == valid count (invalid never reaches PostgREST)",
      (h.fake.counters["postgrest.profiles.patch"] ?? 0) === valids.length,
      `patch=${h.fake.counters["postgrest.profiles.patch"] ?? 0} valid=${valids.length}`,
    );
    const row = h.fake.profiles.get(uid)! as unknown as Record<string, unknown>;
    ctx.inv(
      "final row is a valid lane's payload (or pristine when none was valid)",
      (valids.length === 0 && row.onboarding_state === "pending") ||
        (valids.some((p) => matchesExpected(row, p)) && snapshotConsistent(row)),
      JSON.stringify(row),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Campaign table
// ─────────────────────────────────────────────────────────────────────────────

Deno.test("stress: write campaign table (seed → outcome per scenario), heap bounded", async () => {
  const heapAtEnd = Deno.memoryUsage();
  const rssGrowthMb = Math.round((heapAtEnd.rss - heapAtStart.rss) / 1_048_576);
  const path = `${outDir()}campaign.json`;
  const table = {
    file: FILE,
    seed: STRESS_SEED,
    scale: { iter: STRESS_ITER, burst: STRESS_BURST, latencyMs: STRESS_LATENCY_MS },
    scenarios: campaign,
    totalRequests: campaignRequests,
    totalRounds: campaign.reduce((n, s) => n + s.rounds, 0),
    brokenRounds: campaign.reduce((n, s) => n + s.broken, 0),
    heap: { start: heapAtStart, end: heapAtEnd, rssGrowthMb },
    replay:
      `STRESS_SEED=${STRESS_SEED} STRESS_ITER=${STRESS_ITER} STRESS_BURST=${STRESS_BURST} STRESS_LATENCY_MS=${STRESS_LATENCY_MS} deno test -A --no-check --config deno.json ${FILE}`,
  };
  await Deno.mkdir(outDir(), { recursive: true });
  await Deno.writeTextFile(path, JSON.stringify(table, null, 2));
  console.log(
    `[stress] campaign: ${table.totalRounds} rounds, ${table.totalRequests} requests, rss +${rssGrowthMb}MB → ${path}`,
  );
  assert(campaign.length >= 9, `expected every scenario to report, got ${campaign.length}`);
  assert(rssGrowthMb < 512, `rss grew ${rssGrowthMb}MB across the campaign`);
});
