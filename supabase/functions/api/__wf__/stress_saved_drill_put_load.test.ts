// stress — `PUT /v1/me/saved-drills/:slug` seeded LOAD campaign.
//
// Drives the REAL edge handler in-process (stress_saved_drill_put_harness.ts)
// against healthy fakes and measures, per request, wall latency and the
// number of upstream round trips it made (GoTrue, PostgREST, Redis). Two
// phases:
//
//   1. sequential — STRESS_ITER requests over a seeded mix of bearers
//      (session cold/warm, transitional provider token, bad bearer, bad
//      slug, idempotent repeat) so every request's round trips are
//      attributable; asserts the user-visible status per kind, response
//      shape, idempotency (same savedAt on repeat) and that no request does
//      more than 3 Supabase round trips;
//   2. concurrent bursts — STRESS_ITER requests in bursts of STRESS_BURST
//      in flight, plus one user hammering one slug concurrently (all must
//      answer 200 with one identical savedAt).
//
// Defaults are small (STRESS_ITER=120) so the suite stays fast; the campaign
// runs STRESS_ITER=1000+. STRESS_REDIS=0 runs the same campaign with no
// Upstash configured (per-isolate L1 + memory rate-limit windows only).
// Artifacts: STRESS_OUT_DIR (default artifacts/stress-saved-drill-put/latest/).
//
//   STRESS_SEED=20260904 STRESS_ITER=1000 STRESS_REDIS=1 \
//     deno test -A --no-check --config deno.json stress_saved_drill_put_load.test.ts

import { assert, assertEquals } from "@std/assert";
import {
  drive,
  envInt,
  fakeGoogleIdToken,
  FakeUpstreams,
  histogram,
  latencySummary,
  leaks,
  loadStressHarness,
  Prng,
  putSavedDrill,
  STRESS_ITER,
  STRESS_SEED,
  type UpstreamCall,
  writeArtifact,
} from "./stress_saved_drill_put_harness.ts";

const REDIS = Deno.env.get("STRESS_REDIS") !== "0";
const BURST = envInt("STRESS_BURST", 50);
const MODE = REDIS ? "redis" : "l1only";
const h = await loadStressHarness({ redis: REDIS });

/** Supabase round trips a correct hot path needs (cold: Auth + upsert +
 * read-back; warm: upsert + read-back). More than this is a finding. */
const MAX_SUPABASE_ROUND_TRIPS = 3;

type Kind =
  | "session_cold"
  | "session_warm"
  | "repeat_same_slug"
  | "provider_cold"
  | "provider_warm"
  | "bad_slug"
  | "bad_bearer"
  | "no_bearer";

const EXPECTED_STATUS: Record<Kind, number> = {
  session_cold: 200,
  session_warm: 200,
  repeat_same_slug: 200,
  provider_cold: 200,
  provider_warm: 200,
  bad_slug: 400,
  bad_bearer: 401,
  no_bearer: 401,
};

interface Actor {
  index: number;
  userId: string;
  ip: string;
  sessionToken: string;
  providerSub: string;
  providerToken: string;
  sessionVerified: boolean;
  providerVerified: boolean;
  /** slug → savedAt the route reported the first time. */
  saved: Map<string, string>;
}

interface Row {
  i: number;
  seed: number;
  kind: Kind;
  actor: number;
  slug: string;
  status: number | "pending";
  expected: number;
  ms: number;
  gotrue: number;
  postgrest: number;
  supabase: number;
  redis: number;
  redisOps: string[];
  ok: boolean;
  violation: string | null;
}

/** One request's PRNG is derived from the campaign seed and its index, so a
 * single iteration replays without re-running everything before it. */
const iterationSeed = (i: number): number =>
  (STRESS_SEED ^ Math.imul(i + 1, 0x9e3779b1)) >>> 0;

function makeActor(prng: Prng, index: number): Actor {
  const userId = prng.uuid();
  const session = h.fake.mintSession(
    userId,
    prng.pick(["google", "apple"] as const),
  );
  // The actor's provider identity resolves to the SAME Supabase user, as a
  // pre-contract app build bearing its Google ID token would.
  const providerSub = `google-${prng.uuid()}`;
  h.fake.identities.set(providerSub, userId);
  return {
    index,
    userId,
    ip: prng.ip(),
    sessionToken: session.accessToken,
    providerSub,
    providerToken: fakeGoogleIdToken(providerSub),
    sessionVerified: false,
    providerVerified: false,
    saved: new Map(),
  };
}

/** Bearer mix: mostly the production session bearer, a slice of the
 * transitional provider path, idempotent repeats, and a trickle of rejects. */
function pickKind(prng: Prng, actor: Actor): Kind {
  const r = prng.next();
  if (r < 0.62) return actor.sessionVerified ? "session_warm" : "session_cold";
  if (r < 0.74) {
    if (actor.saved.size > 0) return "repeat_same_slug";
    return actor.sessionVerified ? "session_warm" : "session_cold";
  }
  if (r < 0.86) {
    return actor.providerVerified ? "provider_warm" : "provider_cold";
  }
  if (r < 0.92) return "bad_slug";
  if (r < 0.97) return "bad_bearer";
  return "no_bearer";
}

// Slugs DRILL_SLUG_RE refuses (an empty segment never reaches the route: 404).
const BAD_SLUGS = [
  "-leading-dash",
  "_leading_underscore",
  "has space",
  "a".repeat(121),
  "emoji-🥒",
  "dot.slug",
  "%2F",
];

function requestFor(
  prng: Prng,
  actor: Actor,
  kind: Kind,
): { request: Request; slug: string } {
  let slug = prng.slug();
  let token: string | null = actor.sessionToken;
  if (kind === "provider_cold" || kind === "provider_warm") {
    token = actor.providerToken;
  }
  if (kind === "repeat_same_slug") slug = prng.pick([...actor.saved.keys()]);
  if (kind === "bad_slug") slug = prng.pick(BAD_SLUGS);
  // Well-formed, unexpired Supabase-issued JWT whose signature Auth refuses.
  if (kind === "bad_bearer") {
    token = `${actor.sessionToken.replace(/\.[^.]*$/, "")}.forged`;
  }
  if (kind === "no_bearer") token = null;
  // Rejected bearers ride on their own IP so the auth-failure budget (30 per
  // 5 min per IP) never masks the legitimate traffic on the actor's IP.
  const ip = kind === "bad_bearer" || kind === "no_bearer"
    ? `203.0.113.${1 + (actor.index % 250)}`
    : actor.ip;
  return { request: putSavedDrill(slug, { token, ip }), slug };
}

function redisOps(calls: UpstreamCall[]): string[] {
  return calls.filter((c) => c.kind === "redis").map((c) => c.detail ?? "?");
}

function checkAnswer(
  kind: Kind,
  actor: Actor,
  slug: string,
  answer: Awaited<ReturnType<typeof drive>>,
): string | null {
  const expected = EXPECTED_STATUS[kind];
  if (answer.status !== expected) {
    return `expected ${expected}, observed ${answer.status} ${
      JSON.stringify(answer.body)
    }`;
  }
  if (expected === 200) {
    if (
      answer.body.slug !== slug || answer.body.saved !== true ||
      typeof answer.body.savedAt !== "string"
    ) {
      return `success body off-contract: ${JSON.stringify(answer.body)}`;
    }
    if (Number.isNaN(Date.parse(answer.body.savedAt))) {
      return `savedAt not a timestamp: ${answer.body.savedAt}`;
    }
    const before = actor.saved.get(slug);
    if (before !== undefined && before !== answer.body.savedAt) {
      return `repeat save moved savedAt ${before} → ${answer.body.savedAt} (upsert not idempotent)`;
    }
    if (!h.fake.savedDrills.has(`${actor.userId}|${slug}`)) {
      const providerUser = h.fake.identities.get(actor.providerSub);
      if (!providerUser || !h.fake.savedDrills.has(`${providerUser}|${slug}`)) {
        return "200 but no row stored for the caller";
      }
    }
  } else {
    const leaked = leaks(answer.body);
    if (leaked.length) return `error body leaks ${leaked.join(",")}`;
    if (
      typeof answer.status === "number" && answer.status >= 500 &&
      answer.status !== 503
    ) {
      return `unexpected ${answer.status}`;
    }
  }
  const tally = FakeUpstreams.tally(answer.calls);
  if (tally.supabase > MAX_SUPABASE_ROUND_TRIPS) {
    return `${tally.supabase} Supabase round trips (> ${MAX_SUPABASE_ROUND_TRIPS})`;
  }
  return null;
}

function summarize(rows: Row[]) {
  const byKind: Record<string, unknown> = {};
  for (const kind of Object.keys(EXPECTED_STATUS) as Kind[]) {
    const subset = rows.filter((r) => r.kind === kind);
    if (subset.length === 0) continue;
    byKind[kind] = {
      n: subset.length,
      statuses: histogram(subset.map((r) => r.status)),
      latencyMs: latencySummary(subset.map((r) => r.ms)),
      supabaseRoundTrips: histogram(subset.map((r) => r.supabase)),
      gotrueRoundTrips: histogram(subset.map((r) => r.gotrue)),
      postgrestRoundTrips: histogram(subset.map((r) => r.postgrest)),
      redisRoundTrips: histogram(subset.map((r) => r.redis)),
      redisOps: histogram(subset.map((r) => r.redisOps.join(" → "))),
    };
  }
  return {
    n: rows.length,
    statuses: histogram(rows.map((r) => r.status)),
    latencyMs: latencySummary(rows.map((r) => r.ms)),
    supabaseRoundTrips: histogram(rows.map((r) => r.supabase)),
    maxSupabaseRoundTrips: Math.max(0, ...rows.map((r) => r.supabase)),
    redisRoundTrips: histogram(rows.map((r) => r.redis)),
    byKind,
  };
}

Deno.test({
  name:
    `stress/saved-drill PUT load (${MODE}): ${STRESS_ITER} sequential seeded requests — latency, round trips, idempotency`,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const fake = h.fake;
    fake.reset(STRESS_SEED);
    const prng = new Prng(STRESS_SEED);
    // ~40 requests per actor keeps everyone far inside the 240/min user budget.
    const actorCount = Math.max(8, Math.ceil(STRESS_ITER / 40));
    const actors = Array.from(
      { length: actorCount },
      (_, i) => makeActor(prng, i),
    );
    const rows: Row[] = [];
    const violations: string[] = [];

    for (let i = 0; i < STRESS_ITER; i++) {
      const seed = iterationSeed(i);
      const it = new Prng(seed);
      const actor = actors[it.int(0, actors.length - 1)];
      const kind = pickKind(it, actor);
      const { request, slug } = requestFor(it, actor, kind);
      fake.calls.length = 0;
      const answer = await drive(h, request, 5_000);
      const violation = checkAnswer(kind, actor, slug, answer);
      if (answer.status === 200 && typeof answer.body.savedAt === "string") {
        actor.saved.set(slug, answer.body.savedAt);
        if (
          kind === "session_cold" || kind === "session_warm" ||
          kind === "repeat_same_slug"
        ) {
          actor.sessionVerified = true;
        }
        if (kind === "provider_cold" || kind === "provider_warm") {
          actor.providerVerified = true;
        }
      }
      const tally = FakeUpstreams.tally(answer.calls);
      rows.push({
        i,
        seed,
        kind,
        actor: actor.index,
        slug,
        status: answer.status,
        expected: EXPECTED_STATUS[kind],
        ms: answer.ms,
        gotrue: tally.gotrue,
        postgrest: tally.postgrest,
        supabase: tally.supabase,
        redis: tally.redis,
        redisOps: redisOps(answer.calls),
        ok: violation === null,
        violation,
      });
      if (violation) {
        violations.push(
          `#${i} seed=${seed} ${kind} actor=${actor.index} slug=${
            JSON.stringify(slug)
          }: ${violation}`,
        );
      }
    }

    const summary = summarize(rows);
    const report = {
      mode: MODE,
      campaignSeed: STRESS_SEED,
      iterations: STRESS_ITER,
      actors: actorCount,
      redisConfigured: h.redisConfigured,
      maxSupabaseRoundTripsAllowed: MAX_SUPABASE_ROUND_TRIPS,
      summary,
      violations,
      replay:
        `STRESS_SEED=${STRESS_SEED} STRESS_ITER=${STRESS_ITER} STRESS_REDIS=${
          REDIS ? 1 : 0
        } deno test -A --no-check --config deno.json stress_saved_drill_put_load.test.ts`,
      rows,
    };
    const path = await writeArtifact(`load_sequential_${MODE}`, report);
    console.log(
      `[stress] load/${MODE} sequential: n=${rows.length} p50=${summary.latencyMs.p50}ms p95=${summary.latencyMs.p95}ms ` +
        `supabase-rt=${
          JSON.stringify(summary.supabaseRoundTrips)
        } violations=${violations.length} → ${path}`,
    );
    assertEquals(
      fake.counters["revenuecat"] ?? 0,
      0,
      "this route must never call RevenueCat",
    );
    if (violations.length) {
      throw new Error(
        `load violations (${violations.length}):\n${violations.join("\n")}`,
      );
    }
    assert(summary.maxSupabaseRoundTrips <= MAX_SUPABASE_ROUND_TRIPS);
  },
});

Deno.test({
  name:
    `stress/saved-drill PUT load (${MODE}): ${STRESS_ITER} requests in bursts of ${BURST} + one slug hammered concurrently`,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const fake = h.fake;
    fake.reset(STRESS_SEED + 1);
    const prng = new Prng(STRESS_SEED + 1);
    const actorCount = Math.max(8, Math.ceil(STRESS_ITER / 40));
    const actors = Array.from(
      { length: actorCount },
      (_, i) => makeActor(prng, i),
    );
    const bursts = Math.ceil(STRESS_ITER / BURST);
    const latencies: number[] = [];
    const statuses: Array<number | "pending"> = [];
    const perBurst: Array<Record<string, unknown>> = [];
    const violations: string[] = [];

    for (let b = 0; b < bursts; b++) {
      const plan = Array.from({
        length: Math.min(BURST, STRESS_ITER - b * BURST),
      }, (_, j) => {
        const seed = iterationSeed(100_000 + b * BURST + j);
        const it = new Prng(seed);
        const actor = actors[it.int(0, actors.length - 1)];
        const kind = pickKind(it, actor);
        return { seed, actor, kind, ...requestFor(it, actor, kind) };
      });
      fake.calls.length = 0;
      const started = performance.now();
      const answers = await Promise.all(
        plan.map((p) => drive(h, p.request, 10_000)),
      );
      const wall = performance.now() - started;
      const tally = FakeUpstreams.tally(fake.calls);
      answers.forEach((answer, j) => {
        const p = plan[j];
        latencies.push(answer.ms);
        statuses.push(answer.status);
        const expected = EXPECTED_STATUS[p.kind];
        // Under concurrency two "cold" requests for one actor both verify —
        // that is correct; only the status class and body contract are pinned.
        const acceptable = answer.status === expected ||
          ((p.kind === "session_warm" || p.kind === "provider_warm" ||
            p.kind === "repeat_same_slug") &&
            answer.status === 200);
        if (!acceptable) {
          violations.push(
            `burst ${b} #${j} seed=${p.seed} ${p.kind}: expected ${expected}, observed ${answer.status}`,
          );
        } else if (answer.status === 200) {
          if (
            answer.body.slug !== p.slug || answer.body.saved !== true ||
            typeof answer.body.savedAt !== "string"
          ) {
            violations.push(
              `burst ${b} #${j} seed=${p.seed}: off-contract body ${
                JSON.stringify(answer.body)
              }`,
            );
          } else {
            const before = p.actor.saved.get(p.slug);
            if (before !== undefined && before !== answer.body.savedAt) {
              violations.push(
                `burst ${b} #${j} seed=${p.seed}: savedAt moved on repeat`,
              );
            }
            p.actor.saved.set(p.slug, answer.body.savedAt);
          }
          if (p.kind.startsWith("session") || p.kind === "repeat_same_slug") {
            p.actor.sessionVerified = true;
          }
          if (p.kind.startsWith("provider")) p.actor.providerVerified = true;
        } else if (
          typeof answer.status === "number" && leaks(answer.body).length
        ) {
          violations.push(
            `burst ${b} #${j} seed=${p.seed}: error body leaks upstream detail`,
          );
        }
      });
      perBurst.push({
        burst: b,
        inFlight: plan.length,
        wallMs: Math.round(wall * 100) / 100,
        statuses: histogram(answers.map((a) => a.status)),
        latencyMs: latencySummary(answers.map((a) => a.ms)),
        upstreamRoundTripsPerRequest: {
          supabase: Math.round((tally.supabase / plan.length) * 100) / 100,
          gotrue: Math.round((tally.gotrue / plan.length) * 100) / 100,
          postgrest: Math.round((tally.postgrest / plan.length) * 100) / 100,
          redis: Math.round((tally.redis / plan.length) * 100) / 100,
        },
      });
    }

    // One user, one slug, BURST simultaneous saves: every answer 200, one
    // stored row, and one identical savedAt across all of them.
    const hammer = makeActor(prng, 9_999);
    const slug = prng.slug();
    fake.calls.length = 0;
    const hammered = await Promise.all(
      Array.from(
        { length: BURST },
        () =>
          drive(
            h,
            putSavedDrill(slug, { token: hammer.sessionToken, ip: hammer.ip }),
            10_000,
          ),
      ),
    );
    const hammerStatuses = histogram(hammered.map((a) => a.status));
    const savedAts = new Set(hammered.map((a) => String(a.body.savedAt)));
    const rowsForUser = [...fake.savedDrills.keys()].filter((k) =>
      k.startsWith(`${hammer.userId}|`)
    ).length;
    const hammerTally = FakeUpstreams.tally(fake.calls);
    if (
      hammered.some((a) =>
        a.status !== 200
      )
    ) violations.push(`hammer: statuses ${JSON.stringify(hammerStatuses)}`);
    if (savedAts.size !== 1) {
      violations.push(
        `hammer: ${savedAts.size} distinct savedAt values for one row`,
      );
    }
    if (rowsForUser !== 1) {
      violations.push(
        `hammer: ${rowsForUser} rows stored for one (user, slug)`,
      );
    }

    const report = {
      mode: MODE,
      campaignSeed: STRESS_SEED,
      iterations: latencies.length,
      burst: BURST,
      actors: actorCount,
      latencyMs: latencySummary(latencies),
      statuses: histogram(statuses),
      perBurst,
      hammer: {
        userId: hammer.userId,
        slug,
        inFlight: BURST,
        statuses: hammerStatuses,
        distinctSavedAt: savedAts.size,
        rowsStored: rowsForUser,
        latencyMs: latencySummary(hammered.map((a) => a.ms)),
        upstreamRoundTrips: hammerTally,
      },
      violations,
      replay:
        `STRESS_SEED=${STRESS_SEED} STRESS_ITER=${STRESS_ITER} STRESS_BURST=${BURST} STRESS_REDIS=${
          REDIS ? 1 : 0
        } deno test -A --no-check --config deno.json --filter "bursts" stress_saved_drill_put_load.test.ts`,
    };
    const path = await writeArtifact(`load_concurrent_${MODE}`, report);
    console.log(
      `[stress] load/${MODE} concurrent: n=${latencies.length} p50=${report.latencyMs.p50}ms p95=${report.latencyMs.p95}ms ` +
        `statuses=${JSON.stringify(report.statuses)} hammer=${
          JSON.stringify(hammerStatuses)
        } → ${path}`,
    );
    assertEquals(
      fake.counters["revenuecat"] ?? 0,
      0,
      "this route must never call RevenueCat",
    );
    if (violations.length) {
      throw new Error(
        `concurrent load violations (${violations.length}):\n${
          violations.join("\n")
        }`,
      );
    }
  },
});
