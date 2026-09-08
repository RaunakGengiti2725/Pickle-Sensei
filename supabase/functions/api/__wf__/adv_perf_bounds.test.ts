/**
 * ADVERSARY (performance-bounds): resource bounds of the real edge function
 * booted on loopback against the fake Supabase (edgeHarness).
 *
 *   deno test -A --no-check --config supabase/functions/api/__wf__/deno.json \
 *     supabase/functions/api/__wf__/adv_perf_bounds.test.ts
 *
 * Probed boundaries:
 *  1. cold start — wall time from `import("../index.ts")` to a served
 *     /healthz, plus the module graph the deploy bundles (`deno info`);
 *  2. a slow-loris body (one byte, then silence) on an authenticated route
 *     must be cut at BODY_READ_TIMEOUT_MS (30 s) with a 408 while other
 *     requests keep being served — never an indefinitely pinned request;
 *  3. 32 concurrent streamed 1 MiB bodies aimed at a 64 KiB route are all
 *     refused with 413 and the isolate's heap does not grow by the bytes
 *     that were streamed at it;
 *  4. the largest accepted shots:sync batch (200 shots × 32 phases × 64
 *     checkpoints, ≈ 4.5 MB under the 5 MB cap) is validated and written
 *     with exactly one replay SELECT + 200 RPCs inside a bounded wall time,
 *     and the fully malformed 200-entry batch costs zero queries.
 */
import { assert, assertEquals } from "@std/assert";
import {
  API_BASE,
  authedInit,
  bootEdgeFunction,
  recorded,
  resetRest,
  restJson,
  setRestResponder,
  streamedJsonBody,
} from "./edgeHarness.ts";

const BODY_READ_TIMEOUT_MS = 30_000;
const SMALL_ROUTE_BODY_CAP = 65_536;
const LARGE_BODY_CAP = 5_000_000;
/** Supabase-documented per-function bundle ceiling (INFERRED from the
 * platform limits page; the assertion below is against the local module
 * graph the deploy bundles, not the hosted artifact). */
const BUNDLE_CEILING_BYTES = 20 * 1024 * 1024;
const COLD_START_BUDGET_MS = 5_000;
const MAX_BATCH_WALL_MS = 5_000;
const STREAMED_BODIES = 32;
const STREAMED_BODY_BYTES = 1_048_576;
/** Bytes streamed at the function that must NOT end up resident. */
const HEAP_GROWTH_CEILING_BYTES = (STREAMED_BODIES * STREAMED_BODY_BYTES) / 2;

const VERSION_VECTOR = {
  appVersion: "1.0.0",
  modelBundleVersion: "bundle-1",
  poseModelVersion: "pose-1",
  paddleModelVersion: "paddle-1",
  strokeDetectorVersion: "stroke-1",
  phaseModelVersion: "phase-1",
  scoringModelVersion: "scoring-1",
  shotConfigVersion: "dink@1",
};

function maximalShot(index: number) {
  const suffix = String(index).padStart(12, "0");
  return {
    id: `aaaaaaaa-bbbb-4ccc-8ddd-${suffix}`,
    source: "real",
    analysisPermitId: `bbbbbbbb-bbbb-4ccc-8ddd-${suffix}`,
    sessionId: null,
    shotType: "dink",
    cameraView: "side",
    capturedAt: "2026-09-01T10:00:00.000Z",
    timestamps: { startMs: 0, contactMs: 500, endMs: 1000 },
    resultKind: "low_confidence",
    overallScore: null,
    confidence: 0.4,
    phases: Array.from({ length: 32 }, (_, i) => ({
      key: `phase_${String(i).padStart(2, "0")}_${"p".repeat(55)}`,
      startMs: i * 10,
      representativeMs: i * 10 + 5,
      endMs: i * 10 + 10,
      confidence: 0.5,
    })),
    checkpoints: Array.from({ length: 64 }, (_, i) => ({
      key: `checkpoint_${String(i).padStart(2, "0")}_${"c".repeat(50)}`,
      score: null,
      confidence: 0.5,
      band: "unscored",
      direction: "d".repeat(64),
      severity: 0.5,
      applicable: true,
    })),
    versionVector: VERSION_VECTOR,
  };
}

function shotsResponder() {
  setRestResponder((req) => {
    if (req.path === "shots" && req.method === "GET") return restJson(200, []);
    if (req.path === "rpc/apply_synced_shot") return restJson(200, "accepted");
    return null;
  });
}

Deno.test({
  name: "ADV perf: cold start to a served /healthz and the bundled module graph stay bounded",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const start = performance.now();
    await bootEdgeFunction();
    const coldStartMs = performance.now() - start;

    const info = new Deno.Command(Deno.execPath(), {
      args: ["info", "--json", "--node-modules-dir=none", "--config", "deno.json", "index.ts"],
      cwd: new URL("..", import.meta.url).pathname,
      stdout: "piped",
      stderr: "piped",
    });
    const output = await info.output();
    assertEquals(output.code, 0, new TextDecoder().decode(output.stderr));
    const graph = JSON.parse(new TextDecoder().decode(output.stdout)) as {
      modules: Array<{ size?: number; specifier: string }>;
    };
    const bundleBytes = graph.modules.reduce((sum, m) => sum + (m.size ?? 0), 0);
    const local = graph.modules.filter((m) => m.specifier.startsWith("file:"));
    const localBytes = local.reduce((sum, m) => sum + (m.size ?? 0), 0);
    console.warn(
      `[adv] cold start (import index.ts → 200 /healthz): ${coldStartMs.toFixed(0)} ms; ` +
        `module graph ${graph.modules.length} modules / ${bundleBytes} B (local ${local.length} files / ${localBytes} B)`,
    );
    assert(coldStartMs < COLD_START_BUDGET_MS, `cold start ${coldStartMs} ms`);
    assert(bundleBytes < BUNDLE_CEILING_BYTES, `module graph ${bundleBytes} B`);
  },
});

Deno.test({
  name:
    "ADV perf: a slow-loris body is cut at BODY_READ_TIMEOUT_MS with 408 while /healthz keeps answering",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await bootEdgeFunction();
    resetRest();
    let cancelled = false;
    const trickle = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("{"));
      },
      cancel() {
        cancelled = true;
      },
    });
    const started = performance.now();
    const pending = fetch(
      `${API_BASE}/v1/sessions`,
      authedInit({ method: "POST", body: trickle }),
    );
    // The stalled upload must not pin the isolate: unrelated traffic is served.
    await new Promise((r) => setTimeout(r, 1_000));
    const healthStart = performance.now();
    const health = await fetch(`${API_BASE}/healthz`);
    await health.body?.cancel();
    const healthMs = performance.now() - healthStart;
    assertEquals(health.status, 200);

    const res = await pending;
    const elapsed = performance.now() - started;
    const payload = (await res.json()) as { error?: { message?: string } };
    console.warn(
      `[adv] slow-loris: ${res.status} after ${
        elapsed.toFixed(0)
      } ms (${payload.error?.message}); ` +
        `/healthz during stall ${healthMs.toFixed(0)} ms; upstream cancelled=${cancelled}`,
    );
    assertEquals(res.status, 408);
    assert(elapsed >= BODY_READ_TIMEOUT_MS - 500, `cut early at ${elapsed} ms`);
    assert(elapsed < BODY_READ_TIMEOUT_MS + 5_000, `cut late at ${elapsed} ms`);
    assert(healthMs < 2_000, `/healthz took ${healthMs} ms during the stall`);
    assert(!recorded.some((r) => r.path === "sessions"));
  },
});

Deno.test({
  name:
    "ADV perf: 32 concurrent streamed 1 MiB bodies on a 64 KiB route are all 413 and leave no resident heap",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await bootEdgeFunction();
    resetRest();
    const before = Deno.memoryUsage();
    const statuses = await Promise.all(
      Array.from({ length: STREAMED_BODIES }, async () => {
        const res = await fetch(
          `${API_BASE}/v1/sessions`,
          authedInit({
            method: "POST",
            body: streamedJsonBody('{"idempotencyKey":"k","pad":"', '"}', STREAMED_BODY_BYTES),
          }),
        );
        await res.body?.cancel();
        return res.status;
      }),
    );
    // Let the cancelled readers and their buffers be reclaimed.
    await new Promise((r) => setTimeout(r, 500));
    const after = Deno.memoryUsage();
    const heapGrowth = after.heapUsed - before.heapUsed;
    console.warn(
      `[adv] ${STREAMED_BODIES}× ${STREAMED_BODY_BYTES} B streamed at a ${SMALL_ROUTE_BODY_CAP} B route: ` +
        `statuses ${
          [...new Set(statuses)].join(",")
        }; heapUsed ${before.heapUsed} → ${after.heapUsed} (${heapGrowth} B), ` +
        `rss ${before.rss} → ${after.rss}`,
    );
    assertEquals(statuses, Array.from({ length: STREAMED_BODIES }, () => 413));
    assert(!recorded.some((r) => r.path === "sessions"));
    assert(heapGrowth < HEAP_GROWTH_CEILING_BYTES, `heap grew ${heapGrowth} B`);
  },
});

Deno.test({
  name:
    "ADV perf: the maximal 200-shot sync batch (≈4.5 MB) costs one SELECT + 200 RPCs inside the wall budget; a fully malformed batch costs no query",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await bootEdgeFunction();
    resetRest();
    shotsResponder();
    const body = JSON.stringify({
      shots: Array.from({ length: 200 }, (_, i) => maximalShot(i)),
    });
    assert(body.length < LARGE_BODY_CAP, `fixture ${body.length} B exceeds the route cap`);
    assert(body.length > LARGE_BODY_CAP * 0.8, `fixture ${body.length} B is not near the cap`);

    const start = performance.now();
    const res = await fetch(
      `${API_BASE}/v1/shots:sync`,
      authedInit({
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      }),
    );
    const wallMs = performance.now() - start;
    const payload = (await res.json()) as {
      acceptedIds?: string[];
      rejected?: Array<{ id: string; code: string }>;
    };
    const selects = recorded.filter((r) => r.path === "shots" && r.method === "GET").length;
    const rpcs = recorded.filter((r) => r.path === "rpc/apply_synced_shot").length;
    console.warn(
      `[adv] 200-shot maximal batch ${body.length} B: ${res.status} in ${wallMs.toFixed(0)} ms; ` +
        `accepted ${payload.acceptedIds?.length ?? 0}, rejected ${
          payload.rejected?.length ?? 0
        }, ` +
        `${selects} replay SELECT, ${rpcs} RPCs`,
    );
    assertEquals(res.status, 200);
    assertEquals(payload.acceptedIds?.length, 200);
    assertEquals(payload.rejected?.length, 0);
    assertEquals(selects, 1);
    assertEquals(rpcs, 200);
    assert(wallMs < MAX_BATCH_WALL_MS, `batch took ${wallMs} ms`);

    resetRest();
    shotsResponder();
    const malformed = JSON.stringify({
      shots: Array.from({ length: 200 }, (_, i) => ({ ...maximalShot(i), cameraView: "front" })),
    });
    const malformedStart = performance.now();
    const bad = await fetch(
      `${API_BASE}/v1/shots:sync`,
      authedInit({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: malformed,
      }),
    );
    const malformedMs = performance.now() - malformedStart;
    const badPayload = (await bad.json()) as {
      acceptedIds?: string[];
      rejected?: Array<{ id: string; code: string }>;
    };
    console.warn(
      `[adv] 200-shot malformed batch ${malformed.length} B: ${bad.status} in ${
        malformedMs.toFixed(0)
      } ms; ` +
        `rejected ${badPayload.rejected?.length ?? 0}, ${
          recorded.filter((r) => r.path === "shots" || r.path.startsWith("rpc/apply")).length
        } shot queries`,
    );
    assertEquals(bad.status, 200);
    assertEquals(badPayload.acceptedIds?.length, 0);
    assertEquals(badPayload.rejected?.length, 200);
    assert(badPayload.rejected?.every((r) => r.code === "shot.invalid_payload"));
    assertEquals(
      recorded.filter((r) => r.path === "shots" || r.path.startsWith("rpc/apply")).length,
      0,
    );
  },
});
