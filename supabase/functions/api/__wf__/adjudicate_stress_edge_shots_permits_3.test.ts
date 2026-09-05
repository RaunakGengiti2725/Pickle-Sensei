// Adjudication of stress area `edge-shots-permits-3` at 1fb0efd7 — reproduction
// tests for the CONFIRMED findings. Each test asserts the CONTRACT the stress
// testers claimed is violated (AGENTS.md "Auth sessions" / "Scale & security";
// REVIEW.md upstream-failure rules), so at 1fb0efd7 every test in this file
// FAILS. They are the executable acceptance criteria for the fixes: once a
// finding is fixed its test passes and stays as the regression pin.
//
//   cd supabase/functions/api/__wf__ && \
//     deno test -A --no-check --config deno.json adjudicate_stress_edge_shots_permits_3.test.ts
//
// Findings (ids used in the adjudication report):
//   EDGE-AUTH-PROVIDER-OUTAGE-401  GoTrue socket fault / HTTP 500 during the
//                                  provider-token exchange (signInWithIdToken)
//                                  answers 401 "could not be verified" on
//                                  GET /v1/rank (transitional bearer) and on
//                                  POST /v1/account/bootstrap (live sign-in),
//                                  and every such 401 burns the per-IP
//                                  auth-failure budget (30 / 5 min) — a NAT'd
//                                  address is then 429'd after Auth recovers.
//                                  Expected: generic 503 + Retry-After (as the
//                                  session-bearer path already does), no
//                                  auth-failure debit.
//   EDGE-RANK-MALFORMED-BODY-CACHED  GET /v1/rank turns a PostgREST answer that
//                                  postgrest-js maps to data=null (200 `null`,
//                                  200 empty body, 404 empty body) into a 200
//                                  `{rank:null}` that is cached for 60 s.
//                                  Expected: generic 503, nothing cached.
//   EDGE-RANK-NO-UPSTREAM-DEADLINE  GET /v1/rank has no deadline on its
//                                  PostgREST reads: a hung player_technique_rating
//                                  / player_rank_state read never answers.
//                                  Expected: bounded generic 503.
//
// Stress seeds these minimize (replay with the tester harnesses on the
// adjudication branch): rank fuzz 2952505258 / 3659640609 (auth), rank faults
// STRESS_SEED=20260905 rest-techniques-200-null / -200-empty / -404-empty /
// rest-techniques-hang / rest-state-hang; feedback faults A19 3081037616.

import { assert, assertEquals } from "@std/assert";
import { fakeGoogleIdToken, loadHarness, userRequest } from "./routesHarness.ts";

const h = await loadHarness();

type FetchFn = typeof fetch;

async function withFetchIntercept<T>(
  intercept: (request: Request) => Promise<Response | null>,
  run: () => Promise<T>,
): Promise<T> {
  const inner = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const owned = await intercept(request.clone());
    if (owned) return owned;
    return inner(input, init);
  }) as FetchFn;
  try {
    return await run();
  } finally {
    globalThis.fetch = inner;
  }
}

function rankUser(userId: string) {
  h.reset();
  h.tables.profiles = [{ id: userId, email: "u@example.com", provider: "google" }];
  h.tables.player_technique_rating = [
    {
      shot_type: "dink",
      score: 7.5,
      captured_at: new Date().toISOString(),
      sampled_count: 3,
      confidence_weight: 3,
    },
  ];
  h.tables.player_rank_state = [];
  return { token: fakeGoogleIdToken(userId) };
}

const isTokenExchange = (request: Request) =>
  request.url.includes("/auth/v1/token") && request.url.includes("grant_type=id_token");

const isTechniquesRead = (request: Request) =>
  request.method === "GET" && request.url.includes("/rest/v1/player_technique_rating");

async function expectGeneric503(response: Response, ctx: string) {
  assertEquals(response.status, 503, `${ctx}: expected 503, got ${response.status}`);
  assert(response.headers.get("Retry-After"), `${ctx}: 503 must carry Retry-After`);
  const body = (await response.json()) as { error?: { message?: string } };
  assert(body.error?.message, `${ctx}: generic error.message expected`);
  assert(
    !/verified|socket|ECONN|stack|postgrest|gotrue/i.test(body.error.message),
    `${ctx}: body must stay generic (got ${body.error.message})`,
  );
}

// ─── EDGE-AUTH-PROVIDER-OUTAGE-401 ───────────────────────────────────────────

Deno.test({
  name:
    "EDGE-AUTH-PROVIDER-OUTAGE-401 GET /v1/rank: GoTrue socket fault / 500 during the provider-token exchange answers 503, not 401",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const faults: Array<[string, () => Response | Promise<Response>]> = [
      ["socket fault", () => Promise.reject(new TypeError("error sending request: connection reset"))],
      ["HTTP 500", () => new Response("upstream error", { status: 500 })],
    ];
    let n = 0;
    for (const [label, fault] of faults) {
      n += 1;
      const auth = rankUser(`aaaaaaaa-00${n}0-4aaa-8aaa-aaaaaaaaaaaa`);
      const response = await withFetchIntercept(
        async (request) => (isTokenExchange(request) ? await fault() : null),
        () => h.handler(userRequest("GET", "/v1/rank", { ...auth, ip: "203.0.113.71" })),
      );
      await expectGeneric503(response, `GoTrue ${label} on GET /v1/rank`);
    }
  },
});

Deno.test({
  name:
    "EDGE-AUTH-PROVIDER-OUTAGE-401 POST /v1/account/bootstrap: sign-in during a GoTrue socket fault / 500 answers 503, not 401",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const faults: Array<[string, () => Response | Promise<Response>]> = [
      ["socket fault", () => Promise.reject(new TypeError("error sending request: connection reset"))],
      ["HTTP 500", () => new Response("upstream error", { status: 500 })],
    ];
    let n = 0;
    for (const [label, fault] of faults) {
      n += 1;
      const auth = rankUser(`bbbbbbbb-00${n}0-4bbb-8bbb-bbbbbbbbbbbb`);
      const response = await withFetchIntercept(
        async (request) => (isTokenExchange(request) ? await fault() : null),
        () =>
          h.handler(
            userRequest("POST", "/v1/account/bootstrap", {
              ...auth,
              ip: "203.0.113.72",
              body: {},
            }),
          ),
      );
      await expectGeneric503(response, `GoTrue ${label} on bootstrap`);
    }
  },
});

Deno.test({
  name:
    "EDGE-AUTH-PROVIDER-OUTAGE-401 second-order: 30 outage answers from one IP must not 429 a valid bearer from that IP once Auth is back",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const ip = "203.0.113.73";
    const statuses: number[] = [];
    await withFetchIntercept(
      async (request) =>
        isTokenExchange(request)
          ? await Promise.reject(new TypeError("error sending request: connection reset"))
          : null,
      async () => {
        for (let i = 0; i < 30; i += 1) {
          const auth = rankUser(`cccccccc-${String(1000 + i)}-4ccc-8ccc-cccccccccccc`);
          const response = await h.handler(userRequest("GET", "/v1/rank", { ...auth, ip }));
          statuses.push(response.status);
          await response.body?.cancel();
        }
      },
    );
    // Outage answers must be 503 (asserted above); here only the budget matters.
    const recovered = rankUser("cccccccc-9999-4ccc-8ccc-cccccccccccc");
    const after = await h.handler(userRequest("GET", "/v1/rank", { ...recovered, ip }));
    assertEquals(
      after.status,
      200,
      `valid bearer from an address that only saw the GoTrue outage was answered ${after.status} (outage statuses: ${[...new Set(statuses)].join(",")})`,
    );
  },
});

// ─── EDGE-RANK-MALFORMED-BODY-CACHED ─────────────────────────────────────────

Deno.test({
  name:
    "EDGE-RANK-MALFORMED-BODY-CACHED GET /v1/rank: PostgREST 200 `null` / 200 empty / 404 empty for player_technique_rating is a 503 and is NOT cached as unranked",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const malformed: Array<[string, () => Response]> = [
      ["200 null", () => new Response("null", { status: 200, headers: { "Content-Type": "application/json" } })],
      ["200 empty", () => new Response("", { status: 200 })],
      ["404 empty", () => new Response("", { status: 404 })],
    ];
    let n = 0;
    for (const [label, fault] of malformed) {
      n += 1;
      const auth = rankUser(`dddddddd-00${n}0-4ddd-8ddd-dddddddddddd`);
      const ip = "203.0.113.74";
      const faulted = await withFetchIntercept(
        async (request) => (isTechniquesRead(request) ? fault() : null),
        () => h.handler(userRequest("GET", "/v1/rank", { ...auth, ip })),
      );
      const faultedBody = await faulted.text();
      assertEquals(
        faulted.status,
        503,
        `${label}: malformed PostgREST body must be a generic 503 (got ${faulted.status} ${faultedBody})`,
      );
      // Recovery: the very next request (upstream healthy) must rebuild from
      // the database and return the real rank — never the cached unranked body.
      const readsBefore = h.callsTo("/rest/v1/player_technique_rating").length;
      const recovered = await h.handler(userRequest("GET", "/v1/rank", { ...auth, ip }));
      const body = (await recovered.json()) as { rank: { rating?: number } | null };
      assertEquals(recovered.status, 200, `${label}: recovery status`);
      assert(
        h.callsTo("/rest/v1/player_technique_rating").length > readsBefore,
        `${label}: recovery was served from the cached unranked body`,
      );
      assertEquals(body.rank?.rating, 7.5, `${label}: recovery must return the real rank`);
    }
  },
});

// ─── EDGE-RANK-NO-UPSTREAM-DEADLINE ──────────────────────────────────────────

const HANG_BUDGET_MS = 15_000;

Deno.test({
  name:
    "EDGE-RANK-NO-UPSTREAM-DEADLINE GET /v1/rank: a hung player_technique_rating read answers a bounded generic 503",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const auth = rankUser("eeeeeeee-0010-4eee-8eee-eeeeeeeeeeee");
    const never = new Promise<Response>(() => {});
    const outcome = await withFetchIntercept(
      (request) => (isTechniquesRead(request) ? never : Promise.resolve(null)),
      () =>
        Promise.race([
          h.handler(userRequest("GET", "/v1/rank", { ...auth, ip: "203.0.113.75" })),
          new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), HANG_BUDGET_MS)),
        ]),
    );
    assert(
      outcome !== "hung",
      `GET /v1/rank gave no answer after ${HANG_BUDGET_MS}ms while player_technique_rating never answered`,
    );
    await expectGeneric503(outcome, "hung PostgREST read");
  },
});
