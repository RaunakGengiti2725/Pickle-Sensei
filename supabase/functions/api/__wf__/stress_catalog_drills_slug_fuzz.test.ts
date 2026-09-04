// stress-route-get-v1-catalog-drills-slug / fuzz-boundary
//
// Seeded fuzz + boundary campaign against the REAL edge handler for
// `GET /v1/catalog/drills/:slug` (Supabase Auth / PostgREST / RevenueCat
// stubbed by routesHarness.ts). See stress_catalog_drills_slug_lib.ts for the
// generator, the oracle and the invariants.
//
//   deno task test                                   # default STRESS_ITER=150 (fast)
//   STRESS_ITER=3000 STRESS_SEED=20260904 deno test -A --no-check --config deno.json \
//       stress_catalog_drills_slug_fuzz.test.ts      # full campaign
//   STRESS_SEED=20260904 STRESS_REPLAY=17,2931 …     # replay individual iterations
//
// Results: STRESS_OUT_DIR (default artifacts/stress/route-get-v1-catalog-drills-slug/)
//   campaign-<seed>-<iter>.json   — seed → outcome table (every iteration)
//   flake-<seed>.json             — 10× re-runs of every failing seed
//
// Rules honoured: no production code or existing test is modified; the slow
// campaign is behind STRESS_ITER; every iteration is replayable from its seed.

import { assert, assertEquals } from "@std/assert";
import { captureAccessLog } from "../http.ts";
import { fakeGoogleIdToken, userRequest } from "./routesHarness.ts";
import {
  FAULT_KINDS,
  generateSpec,
  iterationSeed,
  replayCommand,
  runCampaign,
  runIteration,
  SECRET_MARKER,
  stressContext,
  writeReport,
} from "./stress_catalog_drills_slug_lib.ts";

const envInt = (name: string, fallback: number): number => {
  const raw = Deno.env.get(name);
  const value = Number(raw);
  return raw && Number.isInteger(value) && value >= 0 ? value : fallback;
};

const STRESS_ITER = envInt("STRESS_ITER", 150);
const STRESS_SEED = envInt("STRESS_SEED", 20260904);
const STRESS_REPLAY = (Deno.env.get("STRESS_REPLAY") ?? "")
  .split(",")
  .map((part) => part.trim())
  .filter(Boolean)
  .map(Number)
  .filter((n) => Number.isInteger(n) && n >= 0);
const FLAKE_RERUNS = 10;
const FLAKE_MAX_SEEDS = 25;

// ── The campaign ──────────────────────────────────────────────────────────

Deno.test(
  `[stress] fuzz-boundary campaign: ${STRESS_REPLAY.length ? `replay ${STRESS_REPLAY.join(",")}` : `${STRESS_ITER} seeded requests`} (seed ${STRESS_SEED}) hold every contract invariant`,
  async () => {
    const ctx = await stressContext();
    const report = await runCampaign(ctx, STRESS_SEED, STRESS_ITER, {
      only: STRESS_REPLAY.length ? STRESS_REPLAY : undefined,
      onProgress: (done) => console.log(`[stress] ${done} iterations…`),
    });

    // Flakiness: every failing seed is re-run 10× so the report states a rate.
    const flake: {
      iter: number;
      seed: number;
      replay: string;
      reruns: number;
      failures: number;
      rate: number;
      violationsByRun: string[][];
    }[] = [];
    for (const failing of report.failingSeeds.slice(0, FLAKE_MAX_SEEDS)) {
      const violationsByRun: string[][] = [];
      for (let i = 0; i < FLAKE_RERUNS; i++) {
        const spec = generateSpec(STRESS_SEED, failing.iter, ctx.catalog);
        violationsByRun.push((await runIteration(ctx, spec)).violations);
      }
      const failures = violationsByRun.filter((v) => v.length > 0).length;
      flake.push({
        iter: failing.iter,
        seed: failing.seed,
        replay: failing.replay,
        reruns: FLAKE_RERUNS,
        failures,
        rate: failures / FLAKE_RERUNS,
        violationsByRun,
      });
    }

    const runLabel = `${STRESS_SEED}-${STRESS_REPLAY.length ? `replay` : STRESS_ITER}`;
    const reportPath = await writeReport(`campaign-${runLabel}.json`, report);
    // Compact seed → outcome table (the full report keeps every header/URL/upstream call).
    await writeReport(
      `table-${runLabel}.json`,
      report.rows.map((row) => ({
        iter: row.iter,
        seed: row.seed,
        replay: replayCommand(STRESS_SEED, row.iter),
        category: row.category,
        method: row.method,
        url: row.url.length > 160 ? `${row.url.slice(0, 160)}…(${row.url.length} chars)` : row.url,
        tokenKind: row.tokenKind,
        requestIdKind: row.requestIdKind,
        ipKind: row.ipKind,
        fault: row.fault,
        expected: row.expected,
        status: row.status,
        durationMs: Math.round(row.durationMs * 100) / 100,
        upstreamCalls: row.upstream.length,
        violations: row.violations,
        observations: row.observations,
      })),
    );
    const flakePath = flake.length ? await writeReport(`flake-${STRESS_SEED}.json`, flake) : null;

    const summary = {
      seed: STRESS_SEED,
      requested: report.iterationsRequested,
      executed: report.iterationsExecuted,
      notConstructible: report.notConstructible,
      durationMs: report.durationMs,
      status: report.statusHistogram,
      violations: report.violationHistogram,
      observations: report.observationHistogram,
      fiveXx: report.fiveXx.length,
      deliberate5xx: report.fiveXx.filter((f) => f.deliberate).length,
      latencyMs: report.latencyMs,
      heapUsedStart: report.heap[0]?.heapUsed,
      heapUsedEnd: report.heap[report.heap.length - 1]?.heapUsed,
      report: reportPath,
      flake: flakePath,
    };
    console.log(`[stress] ${JSON.stringify(summary)}`);
    for (const row of STRESS_REPLAY.length ? report.rows : []) {
      console.log(
        `[stress] replay iter=${row.iter} seed=${row.seed} ${row.method} ${row.url.slice(0, 200)} token=${row.tokenKind} → ${row.status} (expected ${row.expected}: ${row.reason}) violations=${JSON.stringify(row.violations)} body=${row.bodySnippet ?? ""}`,
      );
    }

    // Every 5xx that was not a deliberate PostgREST fault is a finding.
    const accidental5xx = report.fiveXx.filter((f) => !f.deliberate);
    assertEquals(
      accidental5xx,
      [],
      `unexpected 5xx: ${accidental5xx.map((f) => replayCommand(STRESS_SEED, f.iter)).join("; ")}`,
    );
    assertEquals(
      report.failingSeeds.map((f) => `${f.replay} → ${f.violations.join(",")}`),
      [],
      `contract violations (see ${reportPath}${flakePath ? ` and ${flakePath}` : ""})`,
    );
    assertEquals(
      report.notConstructible,
      0,
      "every generated request must be constructible by the client",
    );
    assertEquals(report.iterationsExecuted, report.iterationsRequested);
  },
);

// ── Deterministic boundary probes (always run; each is a minimised case) ───

/** Deterministic probes call the handler directly; keep its access lines out of the test output. */
const quietAccessLog = <T>(fn: () => Promise<T>): Promise<T> => {
  const restore = captureAccessLog(() => {});
  return fn().finally(restore);
};

Deno.test(
  "[stress] request-id boundary: 8 and 64 chars are echoed, 7 and 65 are replaced by a UUID",
  () =>
    quietAccessLog(async () => {
      const ctx = await stressContext();
      const cases: [string, boolean][] = [
        ["a".repeat(7), false],
        ["a".repeat(8), true],
        ["A-z.9_".repeat(10) + "abcd", true], // 64
        ["a".repeat(65), false],
        ["   " + "b".repeat(8) + "   ", true], // trimmed before the check
        ["req id 123", false],
        ["", false],
      ];
      for (const [value, echoed] of cases) {
        const request = userRequest("GET", "/v1/catalog/drills/wall-dink-rally", {
          ip: `10.9.${cases.findIndex(([v]) => v === value)}.1`,
          headers: { "x-request-id": value },
        });
        const response = await ctx.harness.handler(request);
        await response.text();
        const id = response.headers.get("x-request-id");
        assert(id, `request id missing for ${JSON.stringify(value)}`);
        if (echoed) assertEquals(id, value.trim(), `should echo ${JSON.stringify(value)}`);
        else {
          assert(
            /^[0-9a-f-]{36}$/.test(id),
            `should mint a UUID for ${JSON.stringify(value)}, got ${id}`,
          );
          assert(id !== value, "must not echo an invalid client id");
        }
      }
    }),
);

Deno.test(
  "[stress] malformed percent-encodings in the slug are 400 with the generic message and never reach PostgREST",
  () =>
    quietAccessLog(async () => {
      const ctx = await stressContext();
      const segments = [
        "%",
        "%2",
        "%zz",
        "%G0",
        "wall-dink-rally%",
        "wall-dink-rally%2",
        "%E0%A4%A",
        "%C3%28",
        "%ED%A0%80",
        "%FF",
        "%80",
        "abc%gh",
      ];
      for (const [i, segment] of segments.entries()) {
        ctx.harness.reset();
        ctx.upstream.length = 0;
        const response = await ctx.harness.handler(
          userRequest("GET", `/v1/catalog/drills/${segment}`, { ip: `10.8.0.${i}` }),
        );
        const body = await response.json();
        assertEquals(response.status, 400, segment);
        assertEquals(body.error.message, "Malformed path segment.", segment);
        assertEquals(
          ctx.upstream.filter((c) => c.url.includes("/rest/v1/")).length,
          0,
          `${segment} must not hit PostgREST`,
        );
        assert(response.headers.get("x-request-id"), "request id present");
      }
    }),
);

Deno.test(
  "[stress] every PostgREST failure mode on the saved-drill read is a generic 503 without upstream detail",
  async () => {
    const ctx = await stressContext();
    for (const [i, fault] of FAULT_KINDS.entries()) {
      const spec = generateSpec(STRESS_SEED, 0, ctx.catalog);
      const row = await runIteration(ctx, {
        ...spec,
        method: "GET",
        url: "http://edge.test/functions/v1/api/v1/catalog/drills/wall-dink-rally",
        slug: { kind: "catalog", segment: "wall-dink-rally" },
        shape: "canonical",
        token: { kind: "google", sub: `33333333-3333-4333-8333-33333333333${i}` },
        requestId: { kind: "absent", value: null },
        ip: { kind: "xff-single", headers: { "x-forwarded-for": `10.7.0.${i}` } },
        extraHeaders: {},
        body: null,
        fault,
      });
      assertEquals(row.status, 503, `${fault}: ${row.bodySnippet}`);
      assertEquals(row.violations, [], `${fault}: ${row.bodySnippet}`);
      assert(!(row.bodySnippet ?? "").includes(SECRET_MARKER), `${fault} leaked upstream detail`);
      assert(
        ctx.consoleLines.some((line) => line.includes("[api] Drill detail:")),
        `${fault}: operators still get the detail in the function log`,
      );
    }
  },
);

Deno.test(
  "[stress] per-user budget on the detail route: request 241 within a minute is 429 with Retry-After and does no work",
  () =>
    quietAccessLog(async () => {
      const ctx = await stressContext();
      // Fixed windows are aligned to the wall clock; make sure the burst fits in one.
      const msLeftInWindow = 60_000 - (Date.now() % 60_000);
      if (msLeftInWindow < 8_000)
        await new Promise((resolve) => setTimeout(resolve, msLeftInWindow + 50));
      const token = fakeGoogleIdToken("44444444-4444-4444-8444-444444444444");
      let firstLimited = -1;
      let dbCallsAfterLimit = 0;
      for (let i = 0; i < 245; i++) {
        ctx.upstream.length = 0;
        const response = await ctx.harness.handler(
          userRequest("GET", "/v1/catalog/drills/wall-dink-rally", {
            token,
            ip: `10.6.${i >> 8}.${i & 255}`,
          }),
        );
        await response.text();
        if (response.status === 429) {
          if (firstLimited < 0) {
            firstLimited = i;
            assert(/^\d+$/.test(response.headers.get("retry-after") ?? ""), "Retry-After integer");
            assertEquals(response.headers.get("ratelimit-limit"), "240");
            assertEquals(response.headers.get("ratelimit-remaining"), "0");
            assert(response.headers.get("x-request-id"), "request id present on 429");
          }
          dbCallsAfterLimit += ctx.upstream.filter((c) => c.url.includes("/rest/v1/")).length;
        } else {
          assertEquals(response.status, 200, `request ${i} before the limit`);
        }
      }
      assertEquals(firstLimited, 240, "the 241st request in the window is the first 429");
      assertEquals(dbCallsAfterLimit, 0, "a rate-limited request performs no PostgREST read");
    }),
);

Deno.test("[stress] a distinct per-iteration seed is stable and replayable", () => {
  assertEquals(iterationSeed(20260904, 17), iterationSeed(20260904, 17));
  assert(iterationSeed(20260904, 17) !== iterationSeed(20260904, 18));
  assert(iterationSeed(20260904, 17) !== iterationSeed(20260905, 17));
});
