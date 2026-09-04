// stress · GET /v1/me/access · lens fuzz-boundary
//
// Seeded fuzz campaign against the REAL edge handler (in-process, stubbed
// GoTrue/PostgREST — see stress_me_access_harness.ts). Every iteration builds
// one request from Prng(iterSeed(STRESS_SEED, i)) mutating method / path /
// query / headers / body / auth / upstream faults, sends it through the
// captured Deno.serve handler and judges the response against the lens:
//
//   * bad input answers only 400/401/403/404/405/413/415/429 (JSON error shape)
//   * 5xx only when an upstream fault was injected, and then 503 with the
//     generic body (never 500, never upstream detail / stack / source names)
//   * x-request-id on every response (well-formed client ids echoed, others
//     replaced by a UUID) and exactly one access-log line correlated to it
//   * no upstream WRITE on any request (this route is read-only)
//   * a well-formed authorized request answers 200 with a payload satisfying
//     the mobile parseAccess() invariants and matching the stub's state
//
// Default: STRESS_ITER=300 (suite-speed). Campaign: STRESS_ITER=3000.
// Replay:  STRESS_REPLAY=<iterSeed>[,<iterSeed>...]
// Output:  STRESS_OUT_DIR (default artifacts/stress-route-me-access/latest/)
//          fuzz_results.json (one row per iteration) + fuzz_summary.json

import { assert, assertEquals } from "@std/assert";
import { histogram } from "./xc_concurrency_harness.ts";
import {
  accessLogFacts,
  accessPayloadViolations,
  buildRequest,
  CANONICAL_PATH,
  CATEGORIES,
  EDGE_ORIGIN,
  facts,
  generate,
  type Generated,
  type GeneratorContext,
  isRecord,
  type IterationRow,
  iterSeed,
  judge,
  LEAK_PATTERNS,
  loadStressHarness,
  poolUsers,
  replaySeeds,
  REQUEST_ID_RE,
  sampleHeaders,
  sampleUrl,
  STRESS_ITER,
  STRESS_SEED,
  writeJson,
} from "./stress_me_access_harness.ts";

const POOL_SIZE = 64;

function replayCommand(seed: number): string {
  return `cd supabase/functions/api/__wf__ && STRESS_REPLAY=${seed} deno test -A --no-check --config deno.json stress_route_me_access_fuzz.test.ts`;
}

async function runOne(
  i: number,
  seed: number,
  ctx: GeneratorContext,
  harness: Awaited<ReturnType<typeof loadStressHarness>>,
): Promise<IterationRow> {
  const { handler, upstream, accessLog } = harness;
  upstream.reset();
  accessLog.length = 0;

  const g: Generated = generate(seed, ctx);
  const base: IterationRow = {
    i,
    seed,
    category: g.category,
    notes: g.notes,
    method: g.spec.method,
    url: sampleUrl(g.spec.url),
    headers: sampleHeaders(g.spec.headers),
    bodyKind: g.spec.bodyKind,
    bodyBytes: g.spec.bodyBytes,
    tokenKind: g.tokenKind,
    fault: g.fault ? `${g.fault.target}:${g.fault.fault.kind}` : null,
    expectOk: g.expectOk,
    status: null,
    requestId: null,
    clientRequestId: g.clientRequestId,
    bodyBytesOut: 0,
    bodySample: "",
    upstream: [],
    reachedRoute: false,
    writes: 0,
    durationMs: 0,
    verdict: "HELD",
    violations: [],
    observations: [],
  };

  let request: Request;
  try {
    request = buildRequest(g.spec);
  } catch (error) {
    return {
      ...base,
      verdict: "UNCONSTRUCTIBLE",
      violations: [`construct:${String(error).slice(0, 120)}`],
    };
  }

  if (g.fault) {
    if (g.fault.target === "rpc") upstream.rpcFault = g.fault.fault;
    else if (g.fault.target === "auth.user") {
      upstream.authUserFault = g.fault.fault;
    } else upstream.tokenFault = g.fault.fault;
  }

  const t0 = performance.now();
  let response: Response;
  try {
    response = await handler(request);
  } catch (error) {
    return {
      ...base,
      durationMs: Math.round((performance.now() - t0) * 100) / 100,
      upstream: upstream.calls.map((c) => `${c.kind}:${c.status}`),
      verdict: "HANDLER_THREW",
      violations: [`handler-threw:${String(error).slice(0, 200)}`],
    };
  }
  const calls = [...upstream.calls];
  const faultReached = !upstream.pendingFault();
  const f = await facts(response);
  const durationMs = Math.round((performance.now() - t0) * 100) / 100;
  const log = accessLogFacts([...accessLog]);

  // A fault that was never reached (warm cache answered first) cannot explain
  // a 5xx — judge the request as unfaulted.
  const judged: Generated = faultReached
    ? g
    : { ...g, fault: null, notes: [...g.notes, "fault:not-reached"] };
  const expectedUser = g.userId ? upstream.users.get(g.userId) : undefined;
  const verdict = judge(
    judged,
    f,
    log,
    calls,
    upstream.leakMarker,
    expectedUser,
  );
  return {
    ...base,
    notes: judged.notes,
    fault: g.fault
      ? (faultReached ? base.fault : `${base.fault} (not reached)`)
      : null,
    status: f.status,
    requestId: f.requestId,
    bodyBytesOut: f.bodyBytes,
    bodySample: f.bodyText.slice(0, 160),
    upstream: calls.map((c) => `${c.kind}:${c.status}`),
    reachedRoute: verdict.reachedRoute,
    writes: verdict.writes,
    durationMs,
    verdict: verdict.violations.length ? "BROKEN" : "HELD",
    violations: verdict.violations,
    observations: verdict.observations,
  };
}

Deno.test("stress · GET /v1/me/access · seeded fuzz/boundary campaign", async () => {
  const harness = await loadStressHarness();
  const { upstream } = harness;
  const pool = poolUsers(upstream, POOL_SIZE);
  const sessionTokens = new Map<string, string>();
  for (const u of pool) {
    sessionTokens.set(u.userId, upstream.mintSession(u.userId));
  }
  const ctx: GeneratorContext = { upstream, pool, sessionTokens };

  const replay = replaySeeds();
  const seeds = replay ??
    Array.from({ length: STRESS_ITER }, (_, i) => iterSeed(STRESS_SEED, i));

  const heapBefore = Deno.memoryUsage();
  const t0 = performance.now();
  const rows: IterationRow[] = [];
  for (let i = 0; i < seeds.length; i++) {
    rows.push(await runOne(i, seeds[i], ctx, harness));
  }
  const durationMs = Math.round(performance.now() - t0);
  const heapAfter = Deno.memoryUsage();

  const executed = rows.filter((r) => r.verdict !== "UNCONSTRUCTIBLE");
  const broken = rows.filter((r) =>
    r.verdict === "BROKEN" || r.verdict === "HANDLER_THREW"
  );
  const fiveXx = executed.filter((r) => (r.status ?? 0) >= 500);
  const summary = {
    unit: "route-get-v1-me-access",
    lens: "fuzz-boundary",
    seed: STRESS_SEED,
    replay: replay ?? null,
    iterations: rows.length,
    executed: executed.length,
    unconstructible: rows.length - executed.length,
    durationMs,
    avgMsPerRequest: executed.length
      ? Math.round((durationMs / executed.length) * 100) / 100
      : null,
    heap: { before: heapBefore, after: heapAfter },
    verdicts: histogram(rows.map((r) => r.verdict)),
    statusHistogram: histogram(executed.map((r) => String(r.status))),
    statusByCategory: Object.fromEntries(
      CATEGORIES.map((
        c,
      ) => [
        c,
        histogram(
          executed.filter((r) => r.category === c).map((r) => String(r.status)),
        ),
      ]),
    ),
    tokenKinds: histogram(executed.map((r) => r.tokenKind)),
    reachedRoute: executed.filter((r) => r.reachedRoute).length,
    ok200: executed.filter((r) => r.status === 200).length,
    expectOkCount: executed.filter((r) => r.expectOk).length,
    writes: executed.reduce((n, r) => n + r.writes, 0),
    fiveXx: fiveXx.map((r) => ({
      seed: r.seed,
      status: r.status,
      fault: r.fault,
      notes: r.notes,
      verdict: r.verdict,
      bodySample: r.bodySample,
    })),
    fiveXxWithoutFault: fiveXx.filter((r) => !r.fault).map((r) => r.seed),
    violationHistogram: histogram(
      broken.flatMap((r) => r.violations.map((v) => v.replace(/\(.*$/, ""))),
    ),
    observationHistogram: histogram(executed.flatMap((r) => r.observations)),
    observations: executed
      .filter((r) => r.observations.length)
      .map((r) => ({
        seed: r.seed,
        notes: r.notes,
        status: r.status,
        observations: r.observations,
        bodySample: r.bodySample,
      })),
    broken: broken.map((r) => ({
      seed: r.seed,
      i: r.i,
      category: r.category,
      notes: r.notes,
      method: r.method,
      url: r.url,
      status: r.status,
      violations: r.violations,
      bodySample: r.bodySample,
      replay: replayCommand(r.seed),
    })),
    seedsFailed: broken.map((r) => r.seed),
    notesCoverage: histogram(
      executed.flatMap((r) =>
        r.notes.filter((n) =>
          !n.startsWith("rid-expect:") && !n.startsWith("dup:")
        )
      ),
    ),
    replayAny: replayCommand(seeds[0] ?? 0),
    campaign:
      `cd supabase/functions/api/__wf__ && STRESS_ITER=${STRESS_ITER} STRESS_SEED=${STRESS_SEED} deno test -A --no-check --config deno.json stress_route_me_access_fuzz.test.ts`,
  };
  const resultsPath = await writeJson("fuzz_results.json", rows);
  const summaryPath = await writeJson("fuzz_summary.json", summary);
  console.log(
    `[stress] fuzz: ${executed.length}/${rows.length} executed, ${broken.length} broken, ${durationMs}ms → ${summaryPath}`,
  );
  console.log(
    `[stress] status histogram: ${JSON.stringify(summary.statusHistogram)}`,
  );
  console.log(`[stress] results table: ${resultsPath}`);

  // Coverage floor: the campaign must actually exercise the route, not just
  // bounce off authentication.
  assert(
    executed.length >= Math.floor(seeds.length * 0.95),
    `only ${executed.length}/${seeds.length} requests were constructible`,
  );
  if (!replay) {
    assert(
      summary.reachedRoute >= executed.length * 0.25,
      `route reached on only ${summary.reachedRoute}/${executed.length} requests`,
    );
    for (const status of ["200", "401", "404"]) {
      assert(
        (summary.statusHistogram[status] ?? 0) > 0,
        `no ${status} observed — generator lost coverage`,
      );
    }
  }
  assertEquals(
    summary.writes,
    0,
    "GET /v1/me/access must never write upstream",
  );
  assertEquals(
    broken.length,
    0,
    `${broken.length} broken iteration(s); seeds ${
      broken.slice(0, 20).map((r) => r.seed).join(",")
    } — ${summaryPath}`,
  );
});

/** 429 boundaries the random campaign cannot reach (its IPs and users are
 * spread too thin): the per-IP auth-failure budget (30 / 300 s) and the
 * per-user general budget (240 / 60 s), both crossed exactly at the edge. */
Deno.test("stress · GET /v1/me/access · rate-limit boundaries answer 429 with the generic body", async () => {
  const harness = await loadStressHarness();
  const { handler, upstream, accessLog } = harness;
  const rows: Array<
    {
      phase: string;
      n: number;
      status: number;
      requestId: string | null;
      retryAfter: string | null;
      upstream: string[];
      body: string;
    }
  > = [];
  const send = async (
    phase: string,
    n: number,
    headers: Record<string, string>,
  ) => {
    upstream.reset();
    accessLog.length = 0;
    const response = await handler(
      new Request(`${EDGE_ORIGIN}${CANONICAL_PATH}`, {
        method: "GET",
        headers,
      }),
    );
    const f = await facts(response);
    const log = accessLogFacts([...accessLog]);
    const calls = [...upstream.calls];
    rows.push({
      phase,
      n,
      status: f.status,
      requestId: f.requestId,
      retryAfter: f.retryAfter,
      upstream: calls.map((c) => `${c.kind}:${c.status}`),
      body: f.bodyText.slice(0, 160),
    });
    assert(
      f.requestId && REQUEST_ID_RE.test(f.requestId),
      `${phase}#${n}: request id missing/malformed`,
    );
    assertEquals(
      log.requestId,
      f.requestId,
      `${phase}#${n}: access log not correlated`,
    );
    assertEquals(
      calls.filter((c) => c.kind === "write").length,
      0,
      `${phase}#${n}: upstream write`,
    );
    for (const [name, re] of LEAK_PATTERNS) {
      assert(!re.test(f.bodyText), `${phase}#${n}: leak:${name}`);
    }
    return { f, calls };
  };
  const expect429 = (
    phase: string,
    n: number,
    f: Awaited<ReturnType<typeof facts>>,
    calls: Array<{ kind: string }>,
  ) => {
    assertEquals(
      f.status,
      429,
      `${phase}#${n}: expected 429, got ${f.status} ${
        f.bodyText.slice(0, 120)
      }`,
    );
    assert(
      f.retryAfter && /^\d+$/.test(f.retryAfter) && Number(f.retryAfter) > 0,
      `${phase}#${n}: Retry-After missing`,
    );
    assert(
      f.nosniff && f.cacheControl === "no-store",
      `${phase}#${n}: 429 missing nosniff/no-store`,
    );
    const b = f.bodyJson;
    assert(
      isRecord(b) && isRecord(b.error) && typeof b.error.message === "string",
      `${phase}#${n}: 429 body not error shape`,
    );
    assertEquals(
      Object.keys(b).join(","),
      "error",
      `${phase}#${n}: 429 body carries extra keys`,
    );
    assertEquals(
      calls.filter((c) => c.kind === "rpc.access_state").length,
      0,
      `${phase}#${n}: 429 still reached the RPC`,
    );
  };

  // Phase A — 30 bad bearers from one IP are 401s; the 31st request from that
  // IP is refused pre-auth (429) even with a VALID token, and never reaches
  // GoTrue or the RPC.
  const ipA = "203.0.113.31";
  const userA = {
    userId: upstream.userIdFor("google", "ratelimit-a"),
    provider: "google" as const,
    sub: "ratelimit-a",
    premium: false,
    scored: 0,
    reserved: 0,
  };
  upstream.setUser(userA);
  const tokenA = upstream.mintSession(userA.userId);
  for (let n = 1; n <= 30; n++) {
    const { f } = await send("authfail", n, {
      Authorization: `Bearer not-a-jwt-${n}`,
      "x-forwarded-for": ipA,
    });
    assertEquals(f.status, 401, `authfail#${n}: expected 401, got ${f.status}`);
  }
  {
    const { f, calls } = await send("authfail", 31, {
      Authorization: `Bearer ${tokenA}`,
      "x-forwarded-for": ipA,
    });
    expect429("authfail", 31, f, calls);
    assertEquals(
      calls.length,
      0,
      "authfail#31: pre-auth 429 must not consult any upstream",
    );
  }
  {
    // A different IP with the same valid token is unaffected.
    const { f } = await send("authfail-other-ip", 32, {
      Authorization: `Bearer ${tokenA}`,
      "x-forwarded-for": "203.0.113.32",
    });
    assertEquals(
      f.status,
      200,
      `authfail-other-ip: expected 200, got ${f.status}`,
    );
  }

  // Phase B — the 240-request general user budget: 240 × 200, then 429 (with
  // the cached session, so the 429 costs neither GoTrue nor the RPC).
  const userB = {
    userId: upstream.userIdFor("apple", "ratelimit-b"),
    provider: "apple" as const,
    sub: "ratelimit-b",
    premium: true,
    scored: 5,
    reserved: 0,
  };
  upstream.setUser(userB);
  const tokenB = upstream.mintSession(userB.userId);
  for (let n = 1; n <= 240; n++) {
    const { f, calls } = await send("user-budget", n, {
      Authorization: `Bearer ${tokenB}`,
      "x-forwarded-for": `203.0.113.${100 + (n % 50)}`,
    });
    assertEquals(
      f.status,
      200,
      `user-budget#${n}: expected 200, got ${f.status} ${
        f.bodyText.slice(0, 120)
      }`,
    );
    assertEquals(
      calls.filter((c) => c.kind === "rpc.access_state").length,
      1,
      `user-budget#${n}: expected exactly one RPC`,
    );
    assertEquals(
      accessPayloadViolations(f.bodyJson, userB),
      [],
      `user-budget#${n}: payload drift`,
    );
  }
  for (let n = 241; n <= 245; n++) {
    const { f, calls } = await send("user-budget", n, {
      Authorization: `Bearer ${tokenB}`,
      "x-forwarded-for": `203.0.113.${100 + (n % 50)}`,
    });
    expect429("user-budget", n, f, calls);
  }

  const path = await writeJson("ratelimit_boundary.json", {
    unit: "route-get-v1-me-access",
    lens: "fuzz-boundary/rate-limit",
    requests: rows.length,
    statusHistogram: histogram(rows.map((r) => String(r.status))),
    rows,
  });
  console.log(
    `[stress] rate-limit boundary: ${rows.length} requests → ${path}`,
  );
});

/** The oracle must bite: a synthetic bad answer to a valid request is flagged
 * on every axis the lens cares about (otherwise a green campaign proves nothing). */
Deno.test("stress · GET /v1/me/access · oracle flags leaky 500 / bad 4xx / drifted 200", async () => {
  const harness = await loadStressHarness();
  const pool = poolUsers(harness.upstream, 4);
  const sessionTokens = new Map<string, string>();
  for (const u of pool) {
    sessionTokens.set(u.userId, harness.upstream.mintSession(u.userId));
  }
  const ctx: GeneratorContext = {
    upstream: harness.upstream,
    pool,
    sessionTokens,
  };
  const g = generate(iterSeed(STRESS_SEED, 0), ctx, "valid");
  assert(g.expectOk, "forced valid generation must expect 200");
  const user = harness.upstream.users.get(g.userId!)!;
  const okLog = (rid: string, status: number) => ({
    lines: 1,
    requestId: rid,
    status,
    route: "GET /v1/me/access",
  });
  const rid = "11111111-1111-4111-8111-111111111111";

  const leaky = await facts(
    new Response(
      `{"error":{"message":"TypeError: boom ${harness.upstream.leakMarker}\\n    at accessPayload (index.ts:2048:7)"}}`,
      {
        status: 500,
        headers: { "content-type": "application/json", "x-request-id": rid },
      },
    ),
  );
  const v1 = judge(
    g,
    leaky,
    okLog(rid, 500),
    [{ method: "POST", url: "x", kind: "write", status: 200 }],
    harness.upstream.leakMarker,
    user,
  ).violations;
  for (
    const expected of [
      "status:5xx-without-injected-fault(500)",
      "status:500-unhandled",
      "leak:upstream-detail-marker",
      "leak:stack-frame",
      "leak:source-file",
      "leak:js-error-name",
      "body:5xx-not-generic",
      "write:1-upstream-writes",
    ]
  ) {
    assert(
      v1.some((v) => v.startsWith(expected)),
      `oracle missed ${expected}: ${v1.join(" | ")}`,
    );
  }

  const bad4xx = await facts(
    new Response(`{"error":{"message":"nope","stack":"x"},"debug":1}`, {
      status: 418,
      headers: { "content-type": "application/json" },
    }),
  );
  const v2 = judge(
    g,
    bad4xx,
    { lines: 0, requestId: null, status: null, route: null },
    [],
    harness.upstream.leakMarker,
    user,
  ).violations;
  for (
    const expected of [
      "rid:missing",
      "log:lines=0",
      "status:4xx-not-allowed(418)",
      "status:false-reject(418)",
      "body:4xx-extra-keys",
      "body:4xx-extra-top-level",
      "hdr:4xx-no-nosniff",
    ]
  ) {
    assert(
      v2.some((v) => v.startsWith(expected)),
      `oracle missed ${expected}: ${v2.join(" | ")}`,
    );
  }

  const drifted = await facts(
    new Response(
      JSON.stringify({
        premium: !user.premium,
        entitlements: [],
        freeRatings: {
          limit: 2,
          used: 3,
          reserved: 0,
          remaining: -1,
          availableToReserve: -1,
        },
        canStartRating: true,
        paywallRequired: true,
      }),
      {
        status: 200,
        headers: {
          "content-type": "application/json",
          "x-request-id": "not a valid id!",
          "x-content-type-options": "nosniff",
          "cache-control": "no-store",
        },
      },
    ),
  );
  const v3 = judge(
    g,
    drifted,
    okLog("not a valid id!", 200),
    [{ method: "POST", url: "x", kind: "rpc.access_state", status: 200 }],
    harness.upstream.leakMarker,
    user,
  ).violations;
  for (const expected of ["rid:malformed-on-response", "payload:"]) {
    assert(
      v3.some((v) => v.startsWith(expected)),
      `oracle missed ${expected}: ${v3.join(" | ")}`,
    );
  }
  assert(
    v3.filter((v) => v.startsWith("payload:")).length >= 3,
    `payload drift under-reported: ${v3.join(" | ")}`,
  );
});

Deno.test("stress · GET /v1/me/access · generator is deterministic per seed", async () => {
  const harness = await loadStressHarness();
  const pool = poolUsers(harness.upstream, POOL_SIZE);
  const sessionTokens = new Map<string, string>();
  for (const u of pool) {
    sessionTokens.set(u.userId, harness.upstream.mintSession(u.userId));
  }
  const ctx: GeneratorContext = {
    upstream: harness.upstream,
    pool,
    sessionTokens,
  };
  const shape = (g: Generated) =>
    JSON.stringify({
      c: g.category,
      m: g.spec.method,
      u: g.spec.url,
      h: g.spec.headers.map((
        [k, v],
      ) => [k, k.toLowerCase() === "authorization" ? v.length : v]),
      b: g.spec.bodyKind,
      n: g.notes,
      f: g.fault,
      ok: g.expectOk,
    });
  for (let i = 0; i < 200; i++) {
    const seed = iterSeed(STRESS_SEED, i);
    assertEquals(
      shape(generate(seed, ctx)),
      shape(generate(seed, ctx)),
      `seed ${seed} not deterministic`,
    );
  }
});
