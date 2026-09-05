// stress — UPSTASH (L2 cache + shared rate limits) FAILURE INJECTION for
// DELETE /v1/me/saved-drills/:slug, REAL handler, Redis CONFIGURED (this file
// sets UPSTASH_REDIS_REST_URL/TOKEN before ../index.ts loads — cache.ts reads
// them once, hence a separate file from stress_delete_saved_drill_failure).
//
// Contract (cache.ts header, rateLimit.ts): a Redis outage may slow a
// request, never break it — every pipeline is bounded by REDIS_TIMEOUT_MS
// (1.2 s) and the code degrades to per-isolate memory. Two degraded modes are
// distinguished: Redis UNREACHABLE (HTTP error/timeout/socket) serves the L1
// auth copy; Redis REACHED but not answering (per-command error, short reply)
// is "unknown" and the bearer is re-verified with Supabase Auth.
//
// Replay a row:
//   STRESS_SEED=<seed> STRESS_ITER=<n> deno test -A --no-check --config deno.json \
//     stress_delete_saved_drill_redis.test.ts --filter "<case id>"

import { assert, assertEquals } from "@std/assert";
import {
  deleteSavedDrillRequest,
  type Fault,
  fnv1a,
  loadStressHarness,
  Prng,
  readBody,
  STRESS_ITER,
  STRESS_SEED,
  withCap,
  writeJson,
} from "./stress_saved_drills_harness.ts";

const REDIS_TIMEOUT_MS = 1_200; // cache.ts REDIS_TIMEOUT_MS (private) — pinned here for the latency bound
const HANDLER_CAP_MS = 12_000;

interface RedisCase {
  id: string;
  fault: Fault | null;
  /** "warm": the bearer was verified once (healthy) before the fault; "cold": first sight. */
  cache: "warm" | "cold";
  /** Supabase (Auth + PostgREST) round trips the faulted request may cost. */
  maxSupabaseRoundTrips: number;
  /** Upper bound on handler latency for the faulted request. */
  maxLatencyMs: number;
  note?: string;
  /** Pinned OBSERVED contract violation on the tree under test (see file header). */
  defect?: { status: number; recovered: number; note: string };
}

const http = (status: number, body: string, headers?: Record<string, string>): Fault => ({
  target: "redis",
  mode: { kind: "http", status, body, headers },
});

// A healthy warm DELETE is 1 Supabase round trip (PostgREST). "Unknown" Redis
// answers force one re-verification (Auth) → 2. Cold is always 2.
const CASES: RedisCase[] = [
  {
    id: "redis_healthy_warm",
    fault: null,
    cache: "warm",
    maxSupabaseRoundTrips: 1,
    maxLatencyMs: 200,
  },
  {
    id: "redis_healthy_cold",
    fault: null,
    cache: "cold",
    maxSupabaseRoundTrips: 2,
    maxLatencyMs: 200,
  },
  {
    id: "redis_500_warm",
    fault: http(500, '{"error":"internal"}'),
    cache: "warm",
    maxSupabaseRoundTrips: 1,
    maxLatencyMs: 200,
  },
  {
    id: "redis_500_cold",
    fault: http(500, '{"error":"internal"}'),
    cache: "cold",
    maxSupabaseRoundTrips: 2,
    maxLatencyMs: 200,
  },
  {
    id: "redis_401_bad_token",
    fault: http(401, '{"error":"Unauthorized"}'),
    cache: "warm",
    maxSupabaseRoundTrips: 1,
    maxLatencyMs: 200,
  },
  {
    id: "redis_429_quota",
    fault: http(429, '{"error":"ERR max requests limit exceeded"}', { "Retry-After": "60" }),
    cache: "warm",
    maxSupabaseRoundTrips: 1,
    maxLatencyMs: 200,
  },
  {
    id: "redis_503_html",
    fault: http(503, "<html>Service Unavailable</html>"),
    cache: "warm",
    maxSupabaseRoundTrips: 1,
    maxLatencyMs: 200,
  },
  {
    id: "redis_network_throw",
    fault: { target: "redis", mode: { kind: "throw" } },
    cache: "warm",
    maxSupabaseRoundTrips: 1,
    maxLatencyMs: 200,
  },
  {
    id: "redis_stream_reset",
    fault: { target: "redis", mode: { kind: "stream_error", status: 200 } },
    cache: "warm",
    maxSupabaseRoundTrips: 1,
    maxLatencyMs: 200,
  },
  {
    id: "redis_200_invalid_json",
    fault: http(200, "{not json"),
    cache: "warm",
    maxSupabaseRoundTrips: 1,
    maxLatencyMs: 200,
  },
  {
    id: "redis_200_object_not_array",
    fault: http(200, '{"result":"OK"}'),
    cache: "warm",
    maxSupabaseRoundTrips: 1,
    maxLatencyMs: 200,
  },
  {
    id: "redis_200_empty_array_short_reply",
    fault: http(200, "[]"),
    cache: "warm",
    maxSupabaseRoundTrips: 2,
    maxLatencyMs: 200,
    note: "reached-but-unknown → auth re-verified",
  },
  {
    id: "redis_200_one_slot_short_reply",
    fault: http(200, '[{"result":null}]'),
    cache: "warm",
    maxSupabaseRoundTrips: 2,
    maxLatencyMs: 200,
    note: "reached-but-unknown → auth re-verified",
  },
  {
    id: "redis_200_every_slot_error",
    fault: http(200, '[{"error":"ERR"},{"error":"ERR"},{"error":"ERR"},{"error":"ERR"}]'),
    cache: "warm",
    maxSupabaseRoundTrips: 2,
    maxLatencyMs: 200,
    note: "reached-but-unknown → auth re-verified",
  },
  {
    id: "redis_200_garbage_slots",
    fault: http(200, '[1,"two",null,true]'),
    cache: "warm",
    maxSupabaseRoundTrips: 2,
    maxLatencyMs: 200,
    note: "reached-but-unknown → auth re-verified",
  },
  {
    id: "redis_200_string_in_every_slot",
    fault: http(200, '[{"result":"abc"},{"result":"abc"},{"result":"abc"},{"result":"abc"}]'),
    cache: "warm",
    maxSupabaseRoundTrips: 0,
    maxLatencyMs: 200,
    defect: {
      status: 401,
      recovered: 401,
      note: "cacheGetUnlessRevoked trusts ANY string in the revocation-marker slot as 'session revoked' (index.ts writes the marker as \"1\", cache.ts checks typeof === 'string'): a Redis endpoint answering a canned/wrong-typed string for every GET (misrouted REST proxy, wrong database, stub left in an environment) turns a healthy, verified bearer into 401 'The session is no longer valid' with ZERO Supabase calls, and the marker is copied into L1 for L1_READTHROUGH_TTL_SECONDS (60 s) so the refusal persists after Redis is healthy again.",
    },
  },
  {
    id: "redis_slow_under_timeout",
    fault: { target: "redis", mode: { kind: "slow", delayMs: 300 } },
    cache: "warm",
    maxSupabaseRoundTrips: 1,
    maxLatencyMs: 6 * 300 + 200,
  },
  {
    id: "redis_hang_timeout_per_pipeline",
    fault: { target: "redis", mode: { kind: "hang" } },
    cache: "warm",
    maxSupabaseRoundTrips: 1,
    maxLatencyMs: 6 * REDIS_TIMEOUT_MS + 300,
    note: "each pipeline waits REDIS_TIMEOUT_MS; request latency = pipelines × 1.2 s",
  },
];

interface Row {
  case: string;
  iteration: number;
  seed: number;
  user: string;
  slug: string;
  ip: string;
  status: number | "unsettled";
  durationMs: number;
  redisPipelines: number;
  supabaseRoundTrips: number;
  upstream: Record<string, number>;
  rowDeleted: boolean;
  recovered: number | "unsettled";
  recoveredRedisPipelines: number;
  verdict: "HELD" | "BROKEN";
  note?: string;
}

const rows: Row[] = [];
const caseSeed = (id: string, i: number) =>
  (STRESS_SEED ^ fnv1a(`redis:${id}`) ^ Math.imul(i + 1, 0x9e3779b1)) >>> 0;

for (const rc of CASES) {
  Deno.test({
    name: `stress redis ${rc.id}`,
    sanitizeOps: false,
    sanitizeResources: false,
    async fn() {
      const h = await loadStressHarness({ redis: true });
      const { fake } = h;
      for (let i = 0; i < STRESS_ITER; i++) {
        const seed = caseSeed(rc.id, i);
        const prng = new Prng(seed);
        const user = fake.newUser(prng);
        const token = fake.sessionToken(user, prng);
        const ip = prng.ip();
        const slug = prng.slug();
        fake.reset();
        if (rc.cache === "warm") {
          const warm = await h.handler(
            deleteSavedDrillRequest({ token, ip, rawSlug: `${slug}-warm` }),
          );
          assertEquals(warm.status, 204, `${rc.id}: warm-up must succeed`);
          await warm.text();
        }
        fake.seedSavedDrill(user.id, slug);
        fake.reset();
        fake.arm(rc.fault);
        const started = performance.now();
        const response = await withCap(
          h.handler(deleteSavedDrillRequest({ token, ip, rawSlug: slug })),
          HANDLER_CAP_MS,
        );
        const durationMs = Math.round((performance.now() - started) * 100) / 100;
        const upstream: Record<string, number> = {};
        for (const c of fake.calls) upstream[c.target] = (upstream[c.target] ?? 0) + 1;
        const body = response ? await readBody(response) : { text: "", json: null };
        const row: Row = {
          case: rc.id,
          iteration: i,
          seed,
          user: user.id,
          slug,
          ip,
          status: response ? response.status : "unsettled",
          durationMs,
          redisPipelines: fake.callsTo("redis").length,
          supabaseRoundTrips: fake.supabaseCalls().length,
          upstream,
          rowDeleted: !fake.hasSavedDrill(user.id, slug),
          recovered: 0,
          recoveredRedisPipelines: 0,
          verdict: "HELD",
          note: rc.note,
        };
        // Recovery: Redis back → same bearer works and Redis traffic resumes.
        fake.arm(null);
        fake.reset();
        fake.seedSavedDrill(user.id, `${slug}-after`);
        const again = await withCap(
          h.handler(deleteSavedDrillRequest({ token, ip, rawSlug: `${slug}-after` })),
          HANDLER_CAP_MS,
        );
        row.recovered = again ? again.status : "unsettled";
        row.recoveredRedisPipelines = fake.callsTo("redis").length;
        if (again) await again.text();
        if (rc.defect) {
          row.verdict = "BROKEN";
          row.note = rc.defect.note;
          rows.push(row);
          assertEquals(
            row.status,
            rc.defect.status,
            `${rc.id}: pinned defect changed shape — got ${row.status} ${body.text}; if cache.ts was fixed, drop \`defect\` from this case`,
          );
          assertEquals(
            row.recovered,
            rc.defect.recovered,
            `${rc.id}: pinned post-recovery status changed`,
          );
          assertEquals(
            row.rowDeleted,
            false,
            `${rc.id}: the refused DELETE must not have removed the row`,
          );
          assertEquals(
            row.supabaseRoundTrips,
            0,
            `${rc.id}: the refusal happens before any Supabase call`,
          );
          continue;
        }
        rows.push(row);

        assertEquals(
          row.status,
          204,
          `${rc.id}: Redis trouble must never fail the DELETE (got ${row.status} ${body.text})`,
        );
        assert(row.rowDeleted, `${rc.id}: row deleted`);
        assertEquals(upstream.rc ?? 0, 0, `${rc.id}: RevenueCat never consulted`);
        assertEquals(upstream.rest_delete, 1, `${rc.id}: exactly one PostgREST DELETE`);
        assert(
          row.supabaseRoundTrips <= rc.maxSupabaseRoundTrips,
          `${rc.id}: ${row.supabaseRoundTrips} Supabase round trips > ${rc.maxSupabaseRoundTrips} (${JSON.stringify(upstream)})`,
        );
        assert(row.supabaseRoundTrips <= 3, `${rc.id}: hot path >3 Supabase round trips`);
        assert(
          durationMs <= rc.maxLatencyMs,
          `${rc.id}: latency ${durationMs}ms > ${rc.maxLatencyMs}ms`,
        );
        assertEquals(row.recovered, 204, `${rc.id}: same bearer succeeds after Redis recovers`);
        assert(row.recoveredRedisPipelines >= 1, `${rc.id}: Redis traffic resumes after recovery`);
      }
    },
  });
}

Deno.test({
  name: "stress redis outage_user_budget_still_enforced_in_memory",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const h = await loadStressHarness({ redis: true });
    const { fake } = h;
    const seed = caseSeed("outage_user_budget", 0);
    const prng = new Prng(seed);
    const user = fake.newUser(prng);
    const token = fake.sessionToken(user, prng);
    const ip = prng.ip();
    fake.reset();
    fake.arm({ target: "redis", mode: { kind: "throw" } });
    const statuses: number[] = [];
    for (let i = 0; i < 241; i++) {
      const r = await h.handler(deleteSavedDrillRequest({ token, ip, rawSlug: prng.slug() }));
      statuses.push(r.status);
      await r.text();
    }
    fake.arm(null);
    const first429 = statuses.indexOf(429);
    rows.push({
      case: "outage_user_budget_still_enforced_in_memory",
      iteration: 0,
      seed,
      user: user.id,
      slug: "-",
      ip,
      status: statuses[240],
      durationMs: 0,
      redisPipelines: fake.callsTo("redis").length,
      supabaseRoundTrips: fake.supabaseCalls().length,
      upstream: {
        auth_user: fake.callsTo("auth_user").length,
        rest_delete: fake.callsTo("rest_delete").length,
      },
      rowDeleted: true,
      recovered: 0,
      recoveredRedisPipelines: 0,
      verdict: "HELD",
      note: `Redis unreachable for all 241 requests; first 429 at #${first429 + 1}; Auth verified ${fake.callsTo("auth_user").length}×`,
    });
    assertEquals(
      first429,
      240,
      `memory fallback: 241st request is the first 429 (got index ${first429})`,
    );
    assertEquals(fake.callsTo("rest_delete").length, 240);
    assertEquals(
      fake.callsTo("auth_user").length,
      1,
      "L1 auth copy served while Redis was unreachable",
    );
  },
});

Deno.test("stress redis: write JSON table (seed → outcome)", async () => {
  const path = await writeJson("redis_fault_injection", {
    unit: "route-delete-v1-me-saved-drills-slug",
    lens: "failure-load",
    seed: STRESS_SEED,
    iterationsPerCase: STRESS_ITER,
    faultCases: CASES.length,
    rows: rows.length,
    held: rows.filter((r) => r.verdict === "HELD").length,
    broken: rows.filter((r) => r.verdict === "BROKEN").length,
    replay: `STRESS_SEED=${STRESS_SEED} STRESS_ITER=${STRESS_ITER} deno test -A --no-check --config deno.json stress_delete_saved_drill_redis.test.ts --filter "<case id>"`,
    table: rows,
  });
  console.log(`[stress] redis fault injection: ${rows.length} rows → ${path}`);
});
