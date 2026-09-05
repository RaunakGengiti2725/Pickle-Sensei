// stress-edge-http — LOAD against the REAL edge handler (in-process, fake
// Supabase/RevenueCat, no Redis → per-isolate L1 caches under test):
//
//  1. ≥1000 seeded requests across a user population and a weighted route
//     mix → p50/p95 handler latency per route and the upstream round trips
//     per request (auth / PostgREST / RevenueCat). Any hot path that needs
//     more than 3 Supabase (auth+PostgREST) round trips is reported.
//  2. L1 cache memory under N distinct users (default 2 000; STRESS_ITER=10
//     → 20 000): heap sampled per phase, then the fake model is dropped and
//     the residual heap (= the function's per-isolate caches) is recorded,
//     and the first user's bearer is replayed to observe L1 eviction.
//
// Replay: STRESS_SEED=<seed> STRESS_ITER=<n> deno test -A stress_load.test.ts

import { assert, assertEquals } from "@std/assert";
import { syncShotPayload } from "./xc_concurrency_harness.ts";
import {
  answer,
  edgeRequest,
  envInt,
  freshIp,
  heapNow,
  histogram,
  isRecord,
  latencyStats,
  loadStressHarness,
  restoreProcessEnv,
  Rng,
  roundTrips,
  signIn,
  STRESS_ITER,
  STRESS_SEED,
  type StressHarness,
  writeArtifact,
} from "./stress_harness.ts";

const h: StressHarness = await loadStressHarness({
  redis: false,
  seed: STRESS_SEED,
});

const USERS = envInt("STRESS_USERS", 120);
const REQUESTS = envInt("STRESS_REQUESTS", 1_200) * STRESS_ITER;
const MEMORY_USERS = envInt("STRESS_MEMORY_USERS", 2_000) * STRESS_ITER;
const HOT_PATH_MAX_SUPABASE_ROUND_TRIPS = 3;

type RouteKind =
  | "access"
  | "me"
  | "rank"
  | "progress"
  | "permit"
  | "sync"
  | "billing"
  | "session"
  | "consent"
  | "drills";
const MIX: Array<[RouteKind, number]> = [
  ["access", 24],
  ["me", 14],
  ["rank", 12],
  ["progress", 10],
  ["permit", 10],
  ["sync", 8],
  ["billing", 4],
  ["session", 6],
  ["consent", 6],
  ["drills", 6],
];
const MIX_TOTAL = MIX.reduce((acc, [, w]) => acc + w, 0);
function drawRoute(rng: Rng): RouteKind {
  let roll = rng.int(0, MIX_TOTAL - 1);
  for (const [kind, weight] of MIX) {
    if (roll < weight) return kind;
    roll -= weight;
  }
  return "access";
}

interface LoadUser {
  sub: string;
  ip: string;
  accessToken: string;
  permits: string[];
  counts: Record<string, number>;
}

/** Per-user route budgets (index.ts ROUTE_LIMITS) — the campaign stays under
 * every limit so a 429 is a finding, not a scheduling artefact. */
const BUDGET: Partial<Record<RouteKind, number>> = {
  billing: 9,
  sync: 28,
  permit: 28,
};

function buildRequest(
  rng: Rng,
  user: LoadUser,
  kind: RouteKind,
  i: number,
): Request {
  const base = { token: user.accessToken, ip: user.ip };
  switch (kind) {
    case "access":
      return edgeRequest("GET", "/v1/me/access", base);
    case "me":
      return edgeRequest("GET", "/v1/me", base);
    case "rank":
      return edgeRequest("GET", "/v1/rank", base);
    case "progress":
      return edgeRequest("GET", "/v1/progress", base);
    case "permit":
      return edgeRequest("POST", "/v1/analysis-permits", {
        ...base,
        body: { idempotencyKey: `load-${user.sub.slice(0, 8)}-${i}` },
      });
    case "sync": {
      // With a live permit: a scored shot. Without one: a low-confidence shot
      // against a permit that does not exist (the RPC, not the parser, refuses).
      const permitId = user.permits.pop();
      const shotId = `${(0x30000000 + i).toString(16)}-2222-4222-8222-${
        user.sub.slice(-12)
      }`;
      return edgeRequest("POST", "/v1/shots:sync", {
        ...base,
        body: {
          shots: [
            permitId
              ? syncShotPayload(shotId, permitId)
              : syncShotPayload(shotId, rng.uuid(), {
                resultKind: "low_confidence",
                overallScore: null,
              }),
          ],
        },
      });
    }
    case "billing":
      return edgeRequest("POST", "/v1/billing/sync", { ...base, body: {} });
    case "session":
      return edgeRequest("POST", "/v1/sessions", {
        ...base,
        body: {
          id: `${(0x40000000 + i).toString(16)}-3333-4333-8333-${
            user.sub.slice(-12)
          }`,
          startedAt: new Date(1_750_000_000_000 + i * 1000).toISOString(),
        },
      });
    case "consent":
      return edgeRequest("GET", "/v1/me/consent/status", base);
    case "drills":
      return rng.chance(0.5)
        ? edgeRequest("GET", "/v1/catalog/drills", base)
        : edgeRequest("GET", "/v1/me/saved-drills", base);
  }
}

Deno.test(`stress/load: ${REQUESTS} real-handler requests over ${USERS} users — p50/p95 + Supabase round trips per request`, async () => {
  const rng = new Rng(STRESS_SEED);
  h.clearFaults();
  const users: LoadUser[] = [];
  const bootstrapLatency: number[] = [];
  const bootstrapTrips: number[] = [];
  for (let u = 0; u < USERS; u++) {
    const sub = `${(0x50000000 + u).toString(16)}-4444-4444-8444-${
      String(u).padStart(12, "0")
    }`;
    const ip = freshIp();
    const mark = h.mark();
    const started = performance.now();
    const session = await signIn(h, sub, ip);
    bootstrapLatency.push(performance.now() - started);
    bootstrapTrips.push(
      roundTrips(h.since(mark)).auth + roundTrips(h.since(mark)).rest,
    );
    users.push({
      sub,
      ip,
      accessToken: session.accessToken,
      permits: [],
      counts: {},
    });
  }

  const rows: Array<
    {
      i: number;
      user: number;
      kind: RouteKind;
      status: number;
      code: string | null;
      ms: number;
      auth: number;
      rest: number;
      rc: number;
      ops: Record<string, number>;
      detail?: string;
    }
  > = [];
  const heapStart = heapNow();
  for (let i = 0; i < REQUESTS; i++) {
    const user = users[rng.int(0, users.length - 1)];
    let kind = drawRoute(rng);
    const budget = BUDGET[kind];
    if (budget !== undefined && (user.counts[kind] ?? 0) >= budget) {
      kind = "access";
    }
    user.counts[kind] = (user.counts[kind] ?? 0) + 1;
    const request = buildRequest(rng, user, kind, i);
    const mark = h.mark();
    const out = await answer(h, request);
    const rt = roundTrips(h.since(mark));
    if (
      kind === "permit" && out.status === 200 && isRecord(out.body) &&
      isRecord(out.body.permit)
    ) {
      user.permits.push(String(out.body.permit.id));
    }
    let detail: string | undefined;
    if (kind === "sync" && isRecord(out.body)) {
      const accepted = Array.isArray(out.body.acceptedIds)
        ? out.body.acceptedIds.length
        : 0;
      const rejected = Array.isArray(out.body.rejected)
        ? out.body.rejected as unknown[]
        : [];
      const codes = rejected.map((r) => (isRecord(r) ? String(r.code) : "?"))
        .sort().join(",");
      detail = `accepted=${accepted} rejected=${rejected.length}${
        codes ? ` (${codes})` : ""
      }`;
    }
    rows.push({
      i,
      user: users.indexOf(user),
      kind,
      status: out.status,
      code: out.code,
      ms: out.durationMs,
      auth: rt.auth,
      rest: rt.rest,
      rc: rt.rc,
      ops: rt.ops,
      detail,
    });
    if (out.requestId === null) {
      throw new Error(`request ${i} (${kind}) had no x-request-id`);
    }
  }
  const heapEnd = heapNow();

  const byRoute: Record<string, unknown> = {};
  const hotPaths: Array<Record<string, unknown>> = [];
  for (const kind of MIX.map(([k]) => k)) {
    const sub = rows.filter((r) => r.kind === kind);
    if (sub.length === 0) continue;
    const supabaseTrips = sub.map((r) => r.auth + r.rest);
    const worst = sub.reduce(
      (acc, r) => (r.auth + r.rest > acc.auth + acc.rest ? r : acc),
      sub[0],
    );
    byRoute[kind] = {
      n: sub.length,
      statuses: histogram(sub.map((r) => r.status)),
      codes: histogram(sub.map((r) => r.code ?? "-")),
      details: histogram(sub.map((r) => r.detail ?? "-")),
      latencyMs: latencyStats(sub.map((r) => r.ms)),
      supabaseRoundTrips: latencyStats(supabaseTrips),
      roundTripHistogram: histogram(supabaseTrips),
      revenueCatRoundTrips: latencyStats(sub.map((r) => r.rc)),
      worstRequest: {
        i: worst.i,
        status: worst.status,
        auth: worst.auth,
        rest: worst.rest,
        ops: worst.ops,
      },
    };
    const over = sub.filter((r) =>
      r.auth + r.rest > HOT_PATH_MAX_SUPABASE_ROUND_TRIPS
    );
    if (over.length > 0) {
      hotPaths.push({
        route: kind,
        requestsOverLimit: over.length,
        of: sub.length,
        maxRoundTrips: Math.max(...over.map((r) => r.auth + r.rest)),
        sample: over.slice(0, 3).map((r) => ({
          i: r.i,
          status: r.status,
          auth: r.auth,
          rest: r.rest,
          ops: r.ops,
        })),
      });
    }
  }

  const bad = rows.filter((r) =>
    r.status >= 500 || r.status === 429 || r.status === 401
  );
  const report = {
    campaign: "load",
    seed: STRESS_SEED,
    iter: STRESS_ITER,
    users: USERS,
    requests: rows.length,
    hotPathLimit: HOT_PATH_MAX_SUPABASE_ROUND_TRIPS,
    bootstrap: {
      latencyMs: latencyStats(bootstrapLatency),
      supabaseRoundTrips: latencyStats(bootstrapTrips),
    },
    overall: {
      latencyMs: latencyStats(rows.map((r) => r.ms)),
      statuses: histogram(rows.map((r) => r.status)),
      supabaseRoundTrips: latencyStats(rows.map((r) => r.auth + r.rest)),
      authRoundTrips: rows.reduce((acc, r) => acc + r.auth, 0),
      restRoundTrips: rows.reduce((acc, r) => acc + r.rest, 0),
      rcRoundTrips: rows.reduce((acc, r) => acc + r.rc, 0),
    },
    byRoute,
    hotPathsOverLimit: hotPaths,
    unexpected: bad.map((r) => ({
      i: r.i,
      kind: r.kind,
      status: r.status,
      code: r.code,
    })),
    heap: {
      start: heapStart,
      end: heapEnd,
      heapUsedDeltaBytes: heapEnd.heapUsed - heapStart.heapUsed,
    },
  };
  const path = await writeArtifact("load_latency.json", report);
  await writeArtifact(
    "load_requests.jsonl",
    rows.map((r) => JSON.stringify(r)).join("\n"),
  );
  console.log(
    `[stress/load] ${rows.length} requests; p50=${report.overall.latencyMs.p50} ms p95=${report.overall.latencyMs.p95} ms; hot paths >${HOT_PATH_MAX_SUPABASE_ROUND_TRIPS}: ${
      hotPaths.map((p) => `${p.route}(${p.maxRoundTrips})`).join(", ") || "none"
    } → ${path}`,
  );
  assert(rows.length >= 1_000, "campaign must execute ≥1000 requests");
  assertEquals(bad, [], "no 5xx / 429 / 401 under nominal load");
});

Deno.test(`stress/load: L1 caches under ${MEMORY_USERS} distinct users — heap per phase, residual after dropping the model, eviction`, async () => {
  h.clearFaults();
  const gc = (globalThis as { gc?: () => void }).gc;
  const sample = (label: string) => {
    gc?.();
    const m = heapNow();
    return {
      label,
      heapUsedMB: Math.round(m.heapUsed / 1024 / 1024 * 100) / 100,
      rssMB: Math.round(m.rss / 1024 / 1024 * 100) / 100,
      externalMB: Math.round(m.external / 1024 / 1024 * 100) / 100,
    };
  };
  const phases = [sample("before")];
  const ips = Array.from({ length: 50 }, () => freshIp());
  const tokens: string[] = [];
  const latency: number[] = [];
  const authTrips: number[] = [];
  const step = Math.max(1, Math.floor(MEMORY_USERS / 4));
  for (let u = 0; u < MEMORY_USERS; u++) {
    const sub = `${(0x60000000 + u).toString(16)}-5555-4555-8555-${
      String(u).padStart(12, "0")
    }`;
    h.fake.ensureUser(sub, "google");
    const session = h.fake.mintSession(sub, "google");
    if (u < 3) tokens.push(session.accessToken);
    const mark = h.mark();
    const out = await answer(
      h,
      edgeRequest("GET", "/v1/me/access", {
        token: session.accessToken,
        ip: ips[u % ips.length],
      }),
    );
    if (out.status !== 200) {
      throw new Error(`user ${u}: ${out.status} ${out.text.slice(0, 120)}`);
    }
    latency.push(out.durationMs);
    authTrips.push(roundTrips(h.since(mark)).auth);
    if ((u + 1) % step === 0) phases.push(sample(`after ${u + 1} users`));
  }
  assertEquals(
    authTrips.filter((n) => n !== 1).length,
    0,
    "every distinct bearer is verified with GoTrue exactly once",
  );

  // Replay the FIRST bearers: still in L1 (0 auth trips) or evicted (1)?
  const replays: Array<{ user: number; authTrips: number; status: number }> =
    [];
  for (const [i, token] of tokens.entries()) {
    const mark = h.mark();
    const out = await answer(
      h,
      edgeRequest("GET", "/v1/me/access", { token, ip: ips[0] }),
    );
    replays.push({
      user: i,
      authTrips: roundTrips(h.since(mark)).auth,
      status: out.status,
    });
  }

  // Drop the fake model (sessions, users, profiles, call log) so the residual
  // heap is the function's own per-isolate state.
  const modelSize = {
    sessions: h.fake.sessions.size,
    users: h.fake.users.size,
    profiles: h.fake.tables.profiles.length,
    calls: h.calls.length,
  };
  h.fake.reset(STRESS_SEED);
  h.calls.length = 0;
  phases.push(sample("after dropping fake model"));
  const residualMB = phases[phases.length - 1].heapUsedMB -
    phases[0].heapUsedMB;

  const report = {
    campaign: "l1_memory",
    seed: STRESS_SEED,
    iter: STRESS_ITER,
    users: MEMORY_USERS,
    gcExposed: typeof gc === "function",
    l1Caps: { cacheMemoryMaxEntries: 5_000, rateLimitMemoryWindowMax: 20_000 },
    phases,
    residualHeapMB: Math.round(residualMB * 100) / 100,
    residualBytesPerUser: Math.round((residualMB * 1024 * 1024) / MEMORY_USERS),
    latencyMs: latencyStats(latency),
    replays,
    modelSize,
  };
  const path = await writeArtifact("l1_memory.json", report);
  console.log(
    `[stress/load] ${MEMORY_USERS} users: ${
      phases.map((p) => `${p.label}=${p.heapUsedMB}MB`).join(" → ")
    }; residual ${report.residualHeapMB} MB (${report.residualBytesPerUser} B/user) → ${path}`,
  );
  assert(
    residualMB < 64,
    `per-isolate caches retained ${residualMB} MB after ${MEMORY_USERS} users`,
  );
});

Deno.test("stress: restore the process environment for the suites that run after this module", () => {
  restoreProcessEnv();
});
