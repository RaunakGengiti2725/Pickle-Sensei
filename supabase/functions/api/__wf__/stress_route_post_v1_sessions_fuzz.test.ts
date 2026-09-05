// Fuzz/boundary campaign for `POST /v1/sessions` against the real handler
// in-process (stubbed Supabase Auth / PostgREST / RevenueCat). See
// stress_route_post_v1_sessions_lib.ts for the generator and the invariants.
//
//   deno task test --filter "stress POST /v1/sessions"          # STRESS_ITER default (fast)
//   STRESS_ITER=3000 deno task test --filter "stress POST"      # full campaign
//   STRESS_REPLAY_SEEDS=123456789 deno task test --filter ...   # replay one seed
//   STRESS_OUT=/tmp/x  → JSON result table (seed → outcome) goes there
//     (default: <repo>/artifacts/stress/route-post-v1-sessions/latest, git-ignored)
//   STRESS_FINDING_PINS=1 → also run the "FINDING F*" tests. They are RED on
//     the revision that surfaced them and stay `ignored` (never passed) in a
//     plain `deno task test` so the suite reports the unchanged production
//     behaviour honestly without going red on a known P3.

import { assert, assertEquals, assertLess } from "@std/assert";
import { routeTemplate } from "../http.ts";
import {
  BAD_INPUT_STATUSES,
  buildRequest,
  caseSeed,
  defaultOutDir,
  envInt,
  envSeeds,
  FINDING_LOG_ROUTE_CLIENT_TEXT,
  generateCase,
  googleIdToken,
  MemorySessionStore,
  poolIp,
  poolUser,
  Prng,
  routeCarriesClientText,
  runCampaign,
  runCase,
  setupContext,
  supabaseAccessToken,
  writeReport,
  type GeneratorConfig,
} from "./stress_route_post_v1_sessions_lib.ts";

const ITER = envInt("STRESS_ITER", 150);
const BASE_SEED = envInt("STRESS_SEED", 20260904);
const OUT_DIR = Deno.env.get("STRESS_OUT") || defaultOutDir();

Deno.test(
  "stress POST /v1/sessions — seeded fuzz campaign (in-memory sessions model)",
  async () => {
    const replay = envSeeds("STRESS_REPLAY_SEEDS");
    const report = await runCampaign({
      baseSeed: BASE_SEED,
      iterations: ITER,
      replaySeeds: replay,
      store: new MemorySessionStore(),
      onProgress: (done, total) => {
        if (total >= 500 && done % 500 === 0) console.log(`[stress] ${done}/${total}`);
      },
    });
    const path = await writeReport(report, OUT_DIR, "fuzz_memory.json");
    console.log(
      `[stress] ${report.meta.requestsExecuted} requests / ${report.meta.casesExecuted} cases in ${report.meta.durationMs}ms → ${path}\n` +
        `[stress] statuses ${JSON.stringify(report.summary.statuses)}\n` +
        `[stress] failed seeds ${JSON.stringify(report.summary.failedSeeds)} 5xx seeds ${JSON.stringify(report.summary.fiveHundredSeeds)}\n` +
        `[stress] finding seeds ${JSON.stringify(Object.fromEntries(Object.entries(report.summary.findingSeeds).map(([k, v]) => [k, `${v.length} seeds, first ${v.slice(0, 5).join(",")}`])))}`,
    );
    if (report.summary.failedSeeds.length > 0) {
      const first = report.cases.find((c) => !c.ok)!;
      console.log(
        `[stress] first failure seed=${first.seed} kind=${first.kind} strategy=${first.strategy}`,
      );
      for (const step of first.steps)
        if (step.violations.length)
          console.log(
            `  ${step.method} ${step.url.slice(0, 120)} → ${step.status}: ${step.violations.join(" | ")}`,
          );
      if (first.finalRowViolations.length)
        console.log(`  final row: ${first.finalRowViolations.join(" | ")}`);
    }
    assertEquals(report.meta.casesExecuted, replay?.length ?? ITER);
    assert(report.meta.requestsExecuted >= report.meta.casesExecuted);
    // Every kind of the generator must actually have been exercised at scale.
    if (!replay && ITER >= 150) {
      for (const kind of [
        "valid",
        "replay-same-user",
        "replay-other-user",
        "bad-body",
        "malformed-json",
        "oversize",
        "bad-auth",
        "wrong-route",
        "fault",
      ]) {
        assert((report.summary.byKind[kind]?.cases ?? 0) > 0, `kind ${kind} never generated`);
      }
    }
    assertEquals(
      report.summary.failedSeeds,
      [],
      `failing seeds — replay with STRESS_REPLAY_SEEDS=${report.summary.failedSeeds.join(",")} (table: ${path})`,
    );
    // Only injected faults may produce a 5xx.
    for (const c of report.cases) {
      for (const s of c.steps) {
        if ((s.status ?? 0) >= 500)
          assertEquals(c.kind, "fault", `seed ${c.seed}: ${s.status} without an injected fault`);
      }
    }
  },
);

// ── Findings pinned as focused tests. They FAIL on the revision under test
// until the defect is fixed (the campaign above records them per seed, not
// as violations). Opt in with STRESS_FINDING_PINS=1; otherwise they show up
// in the summary as `ignored`, never as passed.

const SKIP_FINDING_PINS = Deno.env.get("STRESS_FINDING_PINS") !== "1";

Deno.test(
  "FINDING F1 (P3) — access-log route never carries client-supplied path text (http.ts routeTemplate)",
  { ignore: SKIP_FINDING_PINS },
  () => {
    // Seeds 3591400525, 850812823, 3204501427, 397698683, 1224092982 of the
    // 3000-case campaign: `/v1/sessions/<uuid>%00/finalize` → 400, but the
    // structured access line's `route` carries `<uuid>%00` verbatim; a
    // 100 000-char segment yields a 100 KB log line.
    const uuid = "d6106c4d-b4d6-4f80-9ad3-16e810cdd13a";
    for (const segment of [
      `${uuid}%00`,
      `${uuid}x`,
      "a".repeat(100_000),
      "%27%20OR%201%3D1",
      "%F0%9F%8F%93",
    ]) {
      const route = routeTemplate(`/functions/v1/api/v1/sessions/${segment}/finalize`);
      const leaked = routeCarriesClientText(route);
      assertEquals(
        leaked,
        null,
        `${FINDING_LOG_ROUTE_CLIENT_TEXT}: route ${route.slice(0, 120)} carries client text ${leaked}`,
      );
    }
  },
);

Deno.test(
  "FINDING F2 (P3) — owner-lookup network fault answers 503 promptly (postgrest-js retries idempotent GETs 1s+2s+4s)",
  { ignore: SKIP_FINDING_PINS },
  async () => {
    // Campaign fault `select-throw` (e.g. seeds 3503416562, 1755556179): the
    // upsert lands, then the SELECT's fetch rejects; postgrest-js 2.112.4
    // retries GET on network errors/503/520 with 1 s, 2 s, 4 s backoff before
    // surfacing the error, so the handler holds the request ~7 s. The upsert
    // path (POST) is not retried and answers in milliseconds. The row IS
    // written; only the acknowledgement is delayed and then negative.
    const store = new MemorySessionStore();
    const user = poolUser(0x7f2);
    const { ctx, teardown } = await setupContext(store, [user]);
    try {
      ctx.model.fault = "select-throw";
      const t0 = performance.now();
      const response = await ctx.h.handler(
        buildRequest({
          method: "POST",
          url: "http://edge.test/functions/v1/api/v1/sessions",
          headers: [
            ["authorization", `Bearer ${supabaseAccessToken(user, { stress_nonce: 0x7f2 })}`],
            ["x-forwarded-for", poolIp(0x0a7f0002)],
            ["content-type", "application/json"],
          ],
          body: {
            kind: "text",
            text: JSON.stringify({
              id: "7f2f7f2f-0000-4000-8000-7f2f7f2f7f2f",
              startedAt: "2026-09-01T10:00:00.000Z",
            }),
          },
          bodyText: "",
          fault: "select-throw",
          user,
          requestIdSent: null,
          requestIdWellFormed: false,
          expect: {
            statuses: [503],
            code: null,
            writeAllowed: true,
            noRestCalls: false,
            noUpstreamCalls: false,
          },
        }),
      );
      const elapsed = performance.now() - t0;
      ctx.model.fault = "none";
      const body = await response.json();
      assertEquals(response.status, 503);
      assertEquals(
        body.error.message,
        "Session sync is temporarily unavailable. Please try again.",
      );
      assertEquals(store.rowsCreated(), 1, "the upsert landed before the lookup failed");
      const selects = ctx.model.restCalls.filter((c) => c.method === "GET").length;
      console.log(`[stress] select-throw: ${Math.round(elapsed)}ms, ${selects} GET attempts`);
      assertLess(
        elapsed,
        2000,
        `owner lookup fault took ${Math.round(elapsed)}ms (${selects} GET attempts) — the app waits through postgrest-js' retry backoff`,
      );
    } finally {
      ctx.model.fault = "none";
      teardown();
    }
  },
);

Deno.test(
  "stress POST /v1/sessions — per-user budget: request 241 is 429 with Retry-After and no write",
  async () => {
    const store = new MemorySessionStore();
    const user = poolUser(0x7b1);
    const { ctx, teardown } = await setupContext(store, [user]);
    try {
      const token = googleIdToken(user);
      const ip = poolIp(0x0a7b0001);
      const send = (id: string) =>
        ctx.h.handler(
          buildRequest({
            method: "POST",
            url: "http://edge.test/functions/v1/api/v1/sessions",
            headers: [
              ["authorization", `Bearer ${token}`],
              ["x-forwarded-for", ip],
              ["content-type", "application/json"],
            ],
            body: {
              kind: "text",
              text: JSON.stringify({ id, startedAt: "2026-09-01T10:00:00.000Z" }),
            },
            bodyText: "",
            fault: "none",
            user,
            requestIdSent: null,
            requestIdWellFormed: false,
            expect: {
              statuses: [200],
              code: null,
              writeAllowed: true,
              noRestCalls: false,
              noUpstreamCalls: false,
            },
          }),
        );
      const rng = new Prng(0x7b1);
      let okCount = 0;
      for (let i = 0; i < 240; i += 1) {
        const response = await send(rng.uuid());
        await response.body?.cancel();
        if (response.status === 200) okCount += 1;
      }
      assertEquals(okCount, 240, "first 240 requests of the minute succeed");
      assertEquals(store.rowsCreated(), 240);
      const attemptsBefore = store.insertAttempts();
      const limited = await send(rng.uuid());
      const body = await limited.json();
      assertEquals(limited.status, 429);
      assertEquals(body.error.code, "rate_limited");
      assert(Number(limited.headers.get("retry-after")) > 0, "Retry-After present");
      assert(limited.headers.get("x-request-id"), "request id on 429");
      assertEquals(store.insertAttempts(), attemptsBefore, "429 performed no write");
      assertEquals(store.rowsCreated(), 240);
    } finally {
      teardown();
    }
  },
);

Deno.test(
  "stress POST /v1/sessions — auth-failure budget: bad bearer 31 from one IP is 429 before Supabase Auth",
  async () => {
    const store = new MemorySessionStore();
    const { ctx, teardown } = await setupContext(store, []);
    try {
      const ip = poolIp(0x0a7b0002);
      const send = (bearer: string) =>
        ctx.h.handler(
          buildRequest({
            method: "POST",
            url: "http://edge.test/functions/v1/api/v1/sessions",
            headers: [
              ["authorization", `Bearer ${bearer}`],
              ["x-forwarded-for", ip],
              ["content-type", "application/json"],
            ],
            body: {
              kind: "text",
              text: JSON.stringify({
                id: crypto.randomUUID(),
                startedAt: "2026-09-01T10:00:00.000Z",
              }),
            },
            bodyText: "",
            fault: "none",
            user: null,
            requestIdSent: null,
            requestIdWellFormed: false,
            expect: {
              statuses: [401],
              code: null,
              writeAllowed: false,
              noRestCalls: true,
              noUpstreamCalls: false,
            },
          }),
        );
      for (let i = 0; i < 30; i += 1) {
        const response = await send(`garbage-${i}`);
        await response.body?.cancel();
        assertEquals(response.status, 401, `bad bearer ${i + 1} is refused`);
      }
      const callsBefore = ctx.h.calls.length + ctx.model.authUserCalls;
      const limited = await send(googleIdToken(poolUser(1)));
      const body = await limited.json();
      assertEquals(
        limited.status,
        429,
        "31st request from the IP is throttled even with a good bearer",
      );
      assertEquals(body.error.code, "rate_limited");
      assertEquals(
        ctx.h.calls.length + ctx.model.authUserCalls,
        callsBefore,
        "no upstream call once tripped",
      );
      assertEquals(
        ctx.model.restCalls.length,
        0,
        "no PostgREST call from an unauthenticated request",
      );
      assertEquals(store.insertAttempts(), 0);
    } finally {
      teardown();
    }
  },
);

Deno.test(
  "stress POST /v1/sessions — 32 concurrent duplicate deliveries of one id land exactly one row",
  async () => {
    const store = new MemorySessionStore(new Prng(0xc0c0));
    const user = poolUser(0x7b2);
    const { ctx, teardown } = await setupContext(store, [user]);
    try {
      const id = "c0c0c0c0-0000-4000-8000-c0c0c0c0c0c0";
      const startedAt = "2026-09-02T08:00:00.000Z";
      const responses = await Promise.all(
        Array.from({ length: 32 }, (_, i) =>
          ctx.h.handler(
            buildRequest({
              method: "POST",
              url: "http://edge.test/functions/v1/api/v1/sessions",
              headers: [
                ["authorization", `Bearer ${googleIdToken(user)}`],
                ["x-forwarded-for", poolIp(0x0a7b0100 + (i % 4))],
                ["content-type", "application/json"],
              ],
              body: { kind: "text", text: JSON.stringify({ id, startedAt, mode: `attempt-${i}` }) },
              bodyText: "",
              fault: "none",
              user,
              requestIdSent: null,
              requestIdWellFormed: false,
              expect: {
                statuses: [200],
                code: null,
                writeAllowed: true,
                noRestCalls: false,
                noUpstreamCalls: false,
              },
            }),
          ),
        ),
      );
      const statuses = await Promise.all(
        responses.map(async (r) => {
          const text = await r.text();
          return `${r.status} ${text}`;
        }),
      );
      assertEquals(
        new Set(statuses),
        new Set(["200 {}"]),
        `all 32 deliveries acknowledged: ${JSON.stringify(statuses)}`,
      );
      assertEquals(store.rowsCreated(), 1);
      const row = await store.rowById(id);
      assertEquals(row?.user_id, user);
      assertEquals(row?.started_at, startedAt);
      // A different user replaying the same id afterwards is refused and changes nothing.
      const other = poolUser(0x7b3);
      ctx.model.knownUsers.add(other);
      await store.provisionUsers([other]);
      const conflict = await ctx.h.handler(
        buildRequest({
          method: "POST",
          url: "http://edge.test/functions/v1/api/v1/sessions",
          headers: [
            ["authorization", `Bearer ${googleIdToken(other)}`],
            ["x-forwarded-for", poolIp(0x0a7b0200)],
            ["content-type", "application/json"],
          ],
          body: {
            kind: "text",
            text: JSON.stringify({ id, startedAt: "2026-09-03T08:00:00.000Z" }),
          },
          bodyText: "",
          fault: "none",
          user: other,
          requestIdSent: null,
          requestIdWellFormed: false,
          expect: {
            statuses: [409],
            code: "session.id_conflict",
            writeAllowed: true,
            noRestCalls: false,
            noUpstreamCalls: false,
          },
        }),
      );
      const conflictBody = await conflict.json();
      assertEquals(conflict.status, 409);
      assertEquals(conflictBody.error.code, "session.id_conflict");
      assertEquals(store.rowsCreated(), 1);
      assertEquals((await store.rowById(id))?.user_id, user);
    } finally {
      teardown();
    }
  },
);

Deno.test("stress POST /v1/sessions — generator is deterministic per seed", () => {
  const config: GeneratorConfig = {
    users: Array.from({ length: 8 }, (_, i) => poolUser(i)),
    ips: Array.from({ length: 8 }, (_, i) => poolIp(i)),
    oversizeShare: 0.02,
  };
  for (let i = 0; i < 200; i += 1) {
    const seed = caseSeed(BASE_SEED, i);
    const a = generateCase(seed, config);
    const b = generateCase(seed, config);
    assertEquals(
      JSON.stringify(a, replacer),
      JSON.stringify(b, replacer),
      `seed ${seed} regenerates identically`,
    );
  }
});

Deno.test(
  "stress POST /v1/sessions — every rejection status is in the bad-input set (sample)",
  async () => {
    const store = new MemorySessionStore();
    const config: GeneratorConfig = {
      users: Array.from({ length: 8 }, (_, i) => poolUser(0x9000 + i)),
      ips: Array.from({ length: 8 }, (_, i) => poolIp(0x0a900000 + i)),
      oversizeShare: 0,
    };
    const { ctx, teardown } = await setupContext(store, config.users);
    try {
      let rejected = 0;
      for (let i = 0; i < 40; i += 1) {
        const fuzz = generateCase(caseSeed(0xbad, i), config);
        if (!["bad-body", "malformed-json", "bad-auth", "wrong-route"].includes(fuzz.kind))
          continue;
        const result = await runCase(ctx, fuzz);
        for (const step of result.steps) {
          if (step.status !== null && step.status >= 400 && step.status !== 409) {
            rejected += 1;
            assert(BAD_INPUT_STATUSES.has(step.status), `seed ${fuzz.seed}: ${step.status}`);
          }
        }
      }
      assert(rejected > 0);
    } finally {
      teardown();
    }
  },
);

function replacer(_key: string, value: unknown): unknown {
  return value instanceof Uint8Array ? Array.from(value.subarray(0, 64)) : value;
}
