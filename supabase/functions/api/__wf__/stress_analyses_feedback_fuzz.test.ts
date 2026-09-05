/**
 * STRESS / FUZZ-BOUNDARY — POST /v1/analyses/:id/feedback (submitAnalysisFeedback,
 * ../index.ts). The REAL handler runs in-process (routesHarness.loadHarness):
 * auth → rate limits → routing → validation → PostgREST calls, with Supabase
 * Auth, PostgREST and RevenueCat stubbed at the fetch layer
 * (stress_feedback_support.ts models the three table calls the route makes).
 *
 * Contract asserted for EVERY generated request:
 *   - bad input answers only 400/401/403/404/405/413/415/429; a fresh valid
 *     submission is 201, a re-delivery of the same (analysis, user) is 409;
 *   - every 5xx body is generic (no DB detail, no stack, no file paths);
 *   - every JSON response carries nosniff + no-store + application/json;
 *   - nothing is persisted unless the answer is 201, and no PostgREST write
 *     is even attempted for requests rejected before the insert;
 *   - 429 carries Retry-After.
 *
 * Deterministic: STRESS_SEED (campaign seed, default 20260904) → per-iteration
 * seeds via iterSeed(); STRESS_ITER iterations (default 300 so the suite stays
 * fast; the certification run uses ≥ 3000); STRESS_REPLAY=<seed> re-runs one
 * iteration; STRESS_OUT=<dir> writes the seed → outcome JSON table.
 *
 *   STRESS_ITER=3200 STRESS_OUT=/tmp/stress deno task test -- --filter stress
 */
import { assert, assertEquals, assertExists } from "@std/assert";
import { captureAccessLog } from "../http.ts";
import {
  buildWorld,
  createStressEnv,
  describeFailures,
  envInt,
  generateScenario,
  iterSeed,
  MemoryBackend,
  pathFor,
  resetCounters,
  runCampaign,
  writeArtifact,
} from "./stress_feedback_support.ts";
import type { CampaignSummary, StressEnv } from "./stress_feedback_support.ts";

const CAMPAIGN_SEED = envInt("STRESS_SEED", 20260904);
const ITERATIONS = envInt("STRESS_ITER", 300);
const REPLAY = Deno.env.get("STRESS_REPLAY");

async function memoryEnv(
  seed = CAMPAIGN_SEED,
  ips?: number,
): Promise<{ env: StressEnv; backend: MemoryBackend }> {
  const world = buildWorld(seed, 64, 8, ips ?? Math.max(512, Math.ceil(ITERATIONS / 4)));
  const backend = new MemoryBackend(world);
  // Half the users consented to model_training so reviewEligible varies.
  world.users.forEach((u, i) => {
    if (i % 2 === 0) backend.grantConsent(u.id, "model_training");
  });
  const env = await createStressEnv(world, backend);
  env.install();
  return { env, backend };
}

Deno.test("stress fuzz: generator is a pure function of the iteration seed", () => {
  const world = buildWorld(CAMPAIGN_SEED);
  for (let i = 0; i < 200; i++) {
    const seed = iterSeed(CAMPAIGN_SEED, i);
    const a = generateScenario(world, seed);
    const b = generateScenario(world, seed);
    assertEquals(
      JSON.stringify({ ...a, body: typeof a.body === "string" ? a.body.length : "bin" }),
      JSON.stringify({ ...b, body: typeof b.body === "string" ? b.body.length : "bin" }),
    );
  }
});

Deno.test(
  `stress fuzz: ${REPLAY ? `replay seed ${REPLAY}` : `${ITERATIONS} seeded requests (seed ${CAMPAIGN_SEED})`} hold the boundary contract`,
  async () => {
    const { env } = await memoryEnv();
    // Access-log lines are captured (not printed) and audited below: exactly
    // one per request, categorical only (no raw analysis id, bearer or IP).
    const accessLines: string[] = [];
    const restoreLog = captureAccessLog((line) => accessLines.push(line));
    let summary: CampaignSummary;
    try {
      summary = await runCampaign(env, {
        campaignSeed: CAMPAIGN_SEED,
        iterations: ITERATIONS,
        replaySeed: REPLAY ? Number(REPLAY) : undefined,
      });
    } finally {
      restoreLog();
      env.uninstall();
    }
    const logProblems: string[] = [];
    // Documented contract (http.ts routeTemplate): a path segment that IS a UUID
    // collapses to `:id`. A segment that merely CONTAINS one (`<uuid>%00`,
    // `{<uuid>}`, `urn:uuid:<uuid>`) is logged verbatim — recorded here as
    // `accessLogNearUuidRoutes` evidence, not asserted (see findings).
    const nearUuidRoutes: string[] = [];
    const responseIds = new Set(summary.rows.map((r) => r.requestId));
    for (const line of accessLines) {
      const entry = JSON.parse(line) as {
        evt: string;
        requestId: string;
        route: string;
        status: number;
      };
      if (entry.evt !== "api_request") logProblems.push(`evt:${entry.evt}`);
      if (!responseIds.has(entry.requestId))
        logProblems.push(`orphan requestId ${entry.requestId}`);
      for (const segment of entry.route.split("/")) {
        if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment)) {
          logProblems.push(`exact uuid segment logged ${entry.route}`);
        }
      }
      if (/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(entry.route)) {
        nearUuidRoutes.push(entry.route);
      }
      if (/Bearer |eyJ|session-for-|10\.77\./.test(line))
        logProblems.push(`credential-like in log ${line.slice(0, 120)}`);
    }
    if (accessLines.length !== summary.executed) {
      logProblems.push(`access lines ${accessLines.length} != executed ${summary.executed}`);
    }
    const artifactName = REPLAY
      ? `fuzz_memory_replay${REPLAY}.json`
      : `fuzz_memory_seed${CAMPAIGN_SEED}_iter${ITERATIONS}.json`;
    const artifact = await writeArtifact(artifactName, {
      ...summary,
      accessLogLines: accessLines.length,
      accessLogNearUuidRoutes: nearUuidRoutes,
    });
    if (nearUuidRoutes.length > 0) {
      console.log(
        `[stress fuzz] access-log routes carrying a near-UUID segment: ${nearUuidRoutes.length}`,
      );
    }
    console.log(
      `[stress fuzz] executed=${summary.executed} failed=${summary.failed} 5xx=${summary.fiveXx.length} ` +
        `request-id present=${summary.requestIdPresent}/${summary.executed} ${summary.durationMs}ms ` +
        `byStatus=${JSON.stringify(summary.byStatus)} byKind=${JSON.stringify(summary.byKind)}` +
        (artifact ? ` artifact=${artifact}` : ""),
    );
    assert(summary.executed >= (REPLAY ? 1 : ITERATIONS), "every iteration must execute");
    assertEquals(summary.failed, 0, `boundary contract violated:\n${describeFailures(summary)}`);
    assertEquals(
      logProblems.slice(0, 20),
      [],
      `access-log contract violated (${logProblems.length})`,
    );
  },
);

// ---------------------------------------------------------------------------
// Targeted boundary probes (deterministic, not sampled).
// ---------------------------------------------------------------------------

Deno.test(
  "stress fuzz: per-user budget → 429 with Retry-After and no write afterwards",
  async () => {
    const { env, backend } = await memoryEnv(CAMPAIGN_SEED ^ 0x1111, 8);
    try {
      const user = env.world.users[3];
      const ip = "10.78.0.1";
      const headers = (extra: Record<string, string> = {}) => ({
        authorization: `Bearer ${user.sessionToken}`,
        "x-forwarded-for": ip,
        "content-type": "application/json",
        ...extra,
      });
      // 240 cheap rejected requests (bad id → 400) consume the general per-user
      // window; they must never reach PostgREST.
      for (let i = 0; i < 240; i++) {
        resetCounters(backend);
        const res = await env.harness.handler(
          new Request(`http://edge.test${pathFor("not-a-uuid", 0)}`, {
            method: "POST",
            headers: headers(),
            body: JSON.stringify({ rating: "accurate" }),
          }),
        );
        const text = await res.text();
        assertEquals(res.status, 400, `warm-up ${i}: ${text}`);
        assertEquals(backend.counters.writeAttempts, 0);
      }
      resetCounters(backend);
      const limited = await env.harness.handler(
        new Request(`http://edge.test${pathFor(user.shots[0], 0)}`, {
          method: "POST",
          headers: headers(),
          body: JSON.stringify({ rating: "accurate" }),
        }),
      );
      assertEquals(limited.status, 429);
      assertExists(limited.headers.get("retry-after"));
      assertExists(limited.headers.get("ratelimit-limit"));
      assertEquals(limited.headers.get("x-content-type-options"), "nosniff");
      const body = (await limited.json()) as { error: { code: string; message: string } };
      assertEquals(body.error.code, "rate_limited");
      assertEquals(
        backend.counters.writeAttempts,
        0,
        "rate-limited request must not touch PostgREST",
      );
      assertEquals(backend.counters.reads, 0);
      assertEquals(await backend.hasFeedback(user.shots[0], user.id), false);
    } finally {
      env.uninstall();
    }
  },
);

Deno.test(
  "stress fuzz: declared Content-Length > 5MB is refused (413) before auth and before any upstream call",
  async () => {
    const { env, backend } = await memoryEnv(CAMPAIGN_SEED ^ 0x2222, 8);
    try {
      const user = env.world.users[0];
      const before = env.harness.calls.length;
      resetCounters(backend);
      const res = await env.harness.handler(
        new Request(`http://edge.test${pathFor(user.shots[0], 0)}`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${user.providerToken}`,
            "x-forwarded-for": "10.78.0.2",
            "content-type": "application/json",
            "content-length": "5000001",
          },
          body: JSON.stringify({ rating: "accurate" }),
        }),
      );
      assertEquals(res.status, 413);
      const body = (await res.json()) as { error: { message: string } };
      assertEquals(body.error.message, "Request body is too large.");
      assertEquals(
        env.harness.calls.length,
        before,
        "no Supabase Auth / RevenueCat call for a refused body",
      );
      assertEquals(backend.counters.reads + backend.counters.writeAttempts, 0);
    } finally {
      env.uninstall();
    }
  },
);

Deno.test(
  "stress fuzz: streamed body > 5MB without Content-Length is cut at the cap (413), nothing written",
  async () => {
    const { env, backend } = await memoryEnv(CAMPAIGN_SEED ^ 0x3333, 8);
    try {
      const user = env.world.users[1];
      const scenario = generateScenario(env.world, 1, "oversize");
      // Force the streamed variant regardless of what seed 1 picked.
      const bytes = new TextEncoder().encode(
        JSON.stringify({ rating: "not_quite", category: "other", pad: "y".repeat(5_100_000) }),
      );
      let offset = 0;
      const res = await env.harness.handler(
        new Request(`http://edge.test${pathFor(user.shots[0], 0)}`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${user.sessionToken}`,
            "x-forwarded-for": "10.78.0.3",
            "content-type": "application/json",
          },
          body: new ReadableStream<Uint8Array>({
            pull(controller) {
              if (offset >= bytes.byteLength) return controller.close();
              controller.enqueue(
                bytes.subarray(offset, Math.min(offset + 65536, bytes.byteLength)),
              );
              offset += 65536;
            },
          }),
        }),
      );
      assertEquals(res.status, 413, await res.clone().text());
      // In-process Deno buffers the Request stream ahead of the reader, so how
      // far `offset` advanced is informational only (network backpressure is not
      // observable here); the contract under test is the 413 + no write.
      console.log(`[stress fuzz] streamed ${offset}/${bytes.byteLength} bytes before the 413`);
      assertEquals(backend.counters.writeAttempts, 0);
      assertEquals(await backend.hasFeedback(user.shots[0], user.id), false);
      assertEquals(scenario.kind, "oversize");
    } finally {
      env.uninstall();
    }
  },
);

Deno.test(
  "stress fuzz: injected PostgREST failures never leak detail (503 generic) and never persist",
  async () => {
    const { env, backend } = await memoryEnv(CAMPAIGN_SEED ^ 0x4444, 8);
    try {
      const user = env.world.users[2];
      for (const stage of ["shots", "consent", "insert"] as const) {
        resetCounters(backend);
        backend.fault = stage;
        const res = await env.harness.handler(
          new Request(`http://edge.test${pathFor(user.shots[1], 1)}`, {
            method: "POST",
            headers: {
              authorization: `Bearer ${user.providerToken}`,
              "x-forwarded-for": "10.78.0.4",
              "content-type": "application/json",
            },
            body: JSON.stringify({ rating: "not_quite", category: "wrong_stroke" }),
          }),
        );
        backend.fault = null;
        const text = await res.text();
        assertEquals(res.status, 503, `${stage}: ${text}`);
        assert(!text.includes("STRESS_SECRET_MARKER"), `${stage} leaked DB detail: ${text}`);
        assert(!/\n\s+at\s|file:\/\/|\.ts:\d+/.test(text), `${stage} leaked a stack: ${text}`);
        assertEquals(backend.counters.mutations, 0);
        assertEquals(await backend.hasFeedback(user.shots[1], user.id), false);
      }
      // After the fault clears the same pair is accepted exactly once.
      resetCounters(backend);
      const ok = await env.harness.handler(
        new Request(`http://edge.test${pathFor(user.shots[1], 1)}`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${user.providerToken}`,
            "x-forwarded-for": "10.78.0.4",
            "content-type": "application/json",
          },
          body: JSON.stringify({ rating: "not_quite", category: "wrong_stroke" }),
        }),
      );
      assertEquals(ok.status, 201, await ok.clone().text());
      assertEquals(backend.counters.mutations, 1);
    } finally {
      env.uninstall();
    }
  },
);

Deno.test(
  "stress fuzz: 32 concurrent identical deliveries → exactly one 201, the rest 409, one row",
  async () => {
    const { env, backend } = await memoryEnv(CAMPAIGN_SEED ^ 0x5555, 8);
    try {
      const user = env.world.users[4];
      const make = () =>
        new Request(`http://edge.test${pathFor(user.shots[2], 0)}`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${user.sessionToken}`,
            "x-forwarded-for": "10.78.0.5",
            "content-type": "application/json",
          },
          body: JSON.stringify({ rating: "accurate" }),
        });
      resetCounters(backend);
      const responses = await Promise.all(
        Array.from({ length: 32 }, () => env.harness.handler(make())),
      );
      const statuses = responses.map((r) => r.status).sort();
      await Promise.all(responses.map((r) => r.text()));
      assertEquals(statuses.filter((s) => s === 201).length, 1, `statuses=${statuses.join(",")}`);
      assertEquals(statuses.filter((s) => s === 409).length, 31, `statuses=${statuses.join(",")}`);
      assertEquals(backend.counters.mutations, 1);
      assertEquals(await backend.countFeedback(user.shots[2], user.id), 1);
    } finally {
      env.uninstall();
    }
  },
);

Deno.test(
  "stress fuzz: session revoked after cache warm-up is still honoured on the next uncached bearer",
  async () => {
    const { env, backend } = await memoryEnv(CAMPAIGN_SEED ^ 0x6666, 8);
    try {
      const user = env.world.users[5];
      // A brand-new session token (not in the auth cache) for a revoked user → 401.
      env.revokedSessions.add(user.id);
      const freshToken = `${user.sessionToken.split(".").slice(0, 2).join(".")}.revoked-${Date.now()}`;
      resetCounters(backend);
      const res = await env.harness.handler(
        new Request(`http://edge.test${pathFor(user.shots[0], 0)}`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${freshToken}`,
            "x-forwarded-for": "10.78.0.6",
            "content-type": "application/json",
          },
          body: JSON.stringify({ rating: "accurate" }),
        }),
      );
      assertEquals(res.status, 401, await res.clone().text());
      assertEquals(backend.counters.reads + backend.counters.writeAttempts, 0);
      env.revokedSessions.delete(user.id);
    } finally {
      env.uninstall();
    }
  },
);

Deno.test(
  "stress fuzz: x-request-id — minted UUID by default, well-formed client id honoured, junk never echoed",
  async () => {
    const { env } = await memoryEnv(CAMPAIGN_SEED ^ 0x7777, 64);
    const restoreLog = captureAccessLog(() => undefined);
    try {
      const user = env.world.users[0];
      const send = (extra: Record<string, string>) =>
        env.harness.handler(
          new Request(`http://edge.test${pathFor(user.shots[0], 0)}`, {
            method: "POST",
            headers: {
              authorization: `Bearer ${user.sessionToken}`,
              "content-type": "application/json",
              "x-forwarded-for": env.world.ips[3],
              ...extra,
            },
            body: JSON.stringify({ rating: "accurate" }),
          }),
        );
      const minted = await send({});
      await minted.body?.cancel();
      const mintedId = minted.headers.get("x-request-id") ?? "";
      assert(/^[0-9a-f-]{36}$/i.test(mintedId), `minted id should be a UUID, got ${mintedId}`);

      const honoured = await send({ "x-request-id": "ios-9f3a2c1b.retry-2" });
      await honoured.body?.cancel();
      assertEquals(honoured.headers.get("x-request-id"), "ios-9f3a2c1b.retry-2");

      for (const junk of [
        "short",
        "z".repeat(65),
        "has space 12345",
        "<script>alert(1)</script>",
        "a;b=c,d/e",
      ]) {
        const res = await send({ "x-request-id": junk });
        await res.body?.cancel();
        const got = res.headers.get("x-request-id") ?? "";
        assert(
          got !== junk && /^[0-9a-f-]{36}$/i.test(got),
          `junk ${JSON.stringify(junk)} → ${got}`,
        );
      }

      const summary = await runCampaign(env, {
        campaignSeed: CAMPAIGN_SEED ^ 0x7777,
        iterations: 64,
      });
      const missing = summary.rows.filter((r) => !r.requestId);
      assertEquals(
        missing.length,
        0,
        `${missing.length}/${summary.executed} responses have no x-request-id`,
      );
    } finally {
      restoreLog();
      env.uninstall();
    }
  },
);
