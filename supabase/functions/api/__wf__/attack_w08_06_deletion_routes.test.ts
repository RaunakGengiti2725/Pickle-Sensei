// W08-06 ADVERSARY (route plane): attacks against candidate b5519d14 at the
// boundaries the implementer summary claims are closed — residue after Auth
// deletion, the status-capability read-back, concurrent confirms, cross-owner
// isolation of the service-role inventory reads, and Apple/RevenueCat/Auth
// network failures that must never let a namespace read run early or a
// receipt be fabricated. Every case is a REAL request against the Edge
// handler through the shared routes harness; no candidate file is touched.
//
//   cd supabase/functions/api/__wf__ && deno test -A --no-check --config deno.json \
//     attack_w08_06_deletion_routes.test.ts
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { encryptAppleRefreshToken } from "../externalAccounts.ts";
import {
  captureConsole,
  fakeSupabaseAccessToken,
  loadHarness,
  RC_URL,
  userRequest,
} from "./routesHarness.ts";

const h = await loadHarness();

const OWNER_TABLES: ReadonlyArray<[table: string, owner: string, key: string[]]> = [
  ["profiles", "id", ["id"]],
  ["sessions", "user_id", ["id"]],
  ["shots", "user_id", ["id"]],
  ["shot_phases", "user_id", ["shot_id", "phase_key"]],
  ["shot_measurements", "user_id", ["shot_id", "metric_key"]],
  ["shot_checkpoints", "user_id", ["shot_id", "checkpoint_key"]],
  ["captures", "user_id", ["id"]],
  ["analysis_permits", "user_id", ["id"]],
  ["analysis_permit_tombstones", "user_id", ["permit_id"]],
  ["consent_records", "user_id", ["id"]],
  ["evaluation_trials", "user_id", ["id"]],
  ["analysis_feedback", "user_id", ["id"]],
  ["user_saved_drills", "user_id", ["user_id", "slug"]],
  ["player_rank_state", "user_id", ["user_id"]],
  ["billing_entitlements", "user_id", ["user_id"]],
  ["account_deletion_feedback", "user_id", ["id"]],
];

const uuid = (n: number) => `0a080600-0000-4000-8000-${String(n).padStart(12, "0")}`;

interface RequestedDeletion {
  challenge: string;
  operationId: string;
  statusCapability: string;
}

async function requestedDeletion(ownerId: string): Promise<RequestedDeletion> {
  const response = await h.handler(
    userRequest("POST", "/v1/me/delete-request", {
      token: fakeSupabaseAccessToken(ownerId),
      body: {},
    }),
  );
  assertEquals(response.status, 200);
  return await response.json();
}

function confirmDeletion(ownerId: string, operation: RequestedDeletion): Promise<Response> {
  return h.handler(
    userRequest("POST", "/v1/me/delete-confirm", {
      token: fakeSupabaseAccessToken(ownerId),
      body: { challenge: operation.challenge, operationId: operation.operationId },
    }),
  );
}

function deletionStatus(operation: RequestedDeletion, ip = "198.51.100.181"): Promise<Response> {
  return h.handler(
    userRequest("POST", "/v1/me/delete-status", {
      token: operation.statusCapability,
      body: { operationId: operation.operationId },
      ip,
    }),
  );
}

const authDeletes = () =>
  h.calls.filter((call) => call.method === "DELETE" && call.url.includes("/auth/v1/admin/users/"));
const appleRevokes = () => h.callsTo("https://appleid.apple.com/auth/revoke");
const revenueCatDeletes = () =>
  h.calls.filter((call) => call.method === "DELETE" && call.url.startsWith(RC_URL));
const namespaceReads = (owner: string) =>
  h.calls.filter(
    (call) =>
      call.method === "GET" &&
      call.url.includes("/rest/v1/") &&
      !call.url.includes("/rest/v1/rpc/") &&
      call.url.includes(`=eq.${owner}`),
  );

/** Residue responder: one surviving `table` row for `owner` on the first
 * page, an empty page once a keyset cursor is present. */
function residueIn(table: string, owner: string, row: Record<string, unknown>) {
  return (call: { method: string; url: string }) => {
    if (call.method !== "GET" || !new URL(call.url).pathname.endsWith(`/rest/v1/${table}`)) {
      return null;
    }
    const params = new URL(call.url).searchParams;
    const ownerColumn = table === "profiles" ? "id" : "user_id";
    if (params.get(ownerColumn) !== `eq.${owner}`) return null;
    return Response.json(params.has("or") ? [] : [row]);
  };
}

// ---------------------------------------------------------------------------
// ATTACK 1 — completion_unverified is not durable: the status capability the
// app polls after a 503 / restart reports `completed` with a receipt while the
// owner's rows are still present. (P1 if it reproduces.)
// ---------------------------------------------------------------------------
Deno.test(
  "ATTACK W08-06 #1: after a residue 503, delete-status must NOT hand the app a completed receipt",
  async () => {
    h.reset();
    const owner = crypto.randomUUID();
    const operation = await requestedDeletion(owner);
    h.deletion.age(operation.operationId);
    h.respond = residueIn("shots", owner, { id: uuid(1) });
    const { result: confirm } = await captureConsole(() => confirmDeletion(owner, operation));
    assertEquals(confirm.status, 503, "residue → retryable 503 (candidate claim)");

    // Residue is still there; the client (deletionOperation.ts) now polls
    // delete-status with the capability it persisted before confirming.
    const status = await deletionStatus(operation);
    assertEquals(status.status, 200);
    const body = await status.json();
    assert(
      body.state !== "completed" || body.completionReceipt === null,
      `status capability leaked a completed receipt while shots residue is unverified: ${
        JSON.stringify(body)
      }`,
    );
  },
);

// ---------------------------------------------------------------------------
// ATTACK 2 — the "retryable" path is unreachable once Auth is gone: the
// deleting session no longer exists (auth.sessions cascades from auth.users),
// so the retry the candidate relies on is a 401, and the only surface left
// (delete-status) says completed. Models the cascade by flipping the live
// session verdict after the first confirm exactly as production Postgres
// does (see attack_w08_06_xc_pg.test.ts for the live-SQL proof).
// ---------------------------------------------------------------------------
Deno.test(
  "ATTACK W08-06 #2: residue retry after Auth deletion — the deleting session is dead, retry is refused, status says completed",
  async () => {
    h.reset();
    const owner = crypto.randomUUID();
    const operation = await requestedDeletion(owner);
    h.deletion.age(operation.operationId);
    h.respond = residueIn("player_rank_state", owner, { user_id: owner });
    const { result: first } = await captureConsole(() => confirmDeletion(owner, operation));
    assertEquals(first.status, 503);
    assertEquals(authDeletes().length, 1, "Auth user is gone after the first attempt");

    // auth.users → auth.sessions cascade: is_api_session_active() is false.
    h.rpcs.is_api_session_active = false;
    h.respond = () => null; // residue is gone on the retry
    const retry = await confirmDeletion(owner, operation);
    const retryBody = await retry.json();
    const status = await (await deletionStatus(operation, "198.51.100.182")).json();
    assert(
      retry.status === 200 && retryBody.deleted === true,
      `the candidate's retry path is unreachable: confirm retry → HTTP ${retry.status} ${
        JSON.stringify(retryBody)
      }; ` +
        `delete-status meanwhile reports ${JSON.stringify(status)}`,
    );
  },
);

// ---------------------------------------------------------------------------
// ATTACK 3 — double submit: two concurrent confirms for the same operation.
// Exactly one Apple revoke, one RevenueCat delete, one Auth delete; the
// second caller gets 202 (busy) or the verified 200, never a second external
// call and never a 5xx that hides a completed deletion.
// ---------------------------------------------------------------------------
Deno.test(
  "ATTACK W08-06 #3: two concurrent delete-confirm requests never double-call Apple/RevenueCat/Auth",
  async () => {
    h.reset();
    const owner = crypto.randomUUID();
    h.tables.profiles = [{ id: owner, provider: "apple" }];
    h.tables.account_external_credentials = [
      { user_id: owner, apple_refresh_token_encrypted: await encryptedAppleToken(owner) },
    ];
    const operation = await requestedDeletion(owner);
    h.deletion.age(operation.operationId);
    const [a, b] = await Promise.all([
      confirmDeletion(owner, operation),
      confirmDeletion(owner, operation),
    ]);
    const statuses = [a.status, b.status].sort();
    const bodies = await Promise.all([a.json(), b.json()]);
    assert(
      statuses.every((s) => s === 200 || s === 202),
      `concurrent confirms answered ${JSON.stringify(statuses)} ${JSON.stringify(bodies)}`,
    );
    assertEquals(appleRevokes().length, 1, "Apple revoked exactly once");
    assertEquals(revenueCatDeletes().length, 1, "RevenueCat deleted exactly once");
    assertEquals(authDeletes().length, 1, "Auth deleted exactly once");
    // Whoever got 200 carries the receipt; the 202 side must NOT claim deleted.
    for (const [i, status] of [a.status, b.status].entries()) {
      if (status === 202) assert(bodies[i].deleted !== true);
      if (status === 200) assertEquals(bodies[i].deleted, true);
    }
  },
);

// ---------------------------------------------------------------------------
// ATTACK 4 — cross-owner isolation of the service-role sweep: another user's
// rows in EVERY namespace must not block this owner's completion, must not
// be read (the owner filter is on every request), and must not leak into logs.
// ---------------------------------------------------------------------------
Deno.test(
  "ATTACK W08-06 #4: another account's rows in every namespace neither block completion nor leak",
  async () => {
    h.reset();
    const owner = crypto.randomUUID();
    const bystander = crypto.randomUUID();
    const bystanderMarker = "BYSTANDER-PRIVATE-SLUG";
    for (const [table, ownerColumn, keyColumns] of OWNER_TABLES) {
      const row: Record<string, unknown> = { [ownerColumn]: bystander };
      for (const column of keyColumns) {
        if (column !== ownerColumn) row[column] = column === "slug" ? bystanderMarker : uuid(99);
      }
      h.tables[table] = [row];
    }
    const operation = await requestedDeletion(owner);
    h.deletion.age(operation.operationId);
    const { result: response, logs } = await captureConsole(() =>
      confirmDeletion(owner, operation)
    );
    assertEquals(response.status, 200);
    assertEquals((await response.json()).deleted, true);
    for (const call of namespaceReads(owner)) {
      assertEquals(call.headers.authorization, "Bearer service-role-test-key");
      assert(!call.url.includes(bystander), "no read is ever scoped to the bystander");
    }
    assert(!JSON.stringify(logs).includes(bystander));
    assert(!JSON.stringify(logs).includes(bystanderMarker));
    for (const [table] of OWNER_TABLES) {
      assertEquals(h.tables[table].length, 1, `${table}: bystander row untouched`);
    }
  },
);

// ---------------------------------------------------------------------------
// ATTACK 5 — network failure at each external step: a namespace read must
// never run before Auth deletion succeeded, and the response must never be a
// receipt. Apple 429+Retry-After, Apple 503, RevenueCat 503, Auth 502.
// ---------------------------------------------------------------------------
Deno.test(
  "ATTACK W08-06 #5: Apple 429/5xx, RevenueCat 5xx and Auth 5xx fail closed with no early namespace read and no receipt",
  async () => {
    const cases: Array<[string, (call: { method: string; url: string }) => Response | null]> = [
      [
        "apple 429",
        (call) =>
          call.url === "https://appleid.apple.com/auth/revoke"
            ? new Response(JSON.stringify({ error: "slow_down" }), {
              status: 429,
              headers: { "Retry-After": "7", "Content-Type": "application/json" },
            })
            : null,
      ],
      [
        "apple 503",
        (call) =>
          call.url === "https://appleid.apple.com/auth/revoke"
            ? new Response("FAKE-apple-outage", { status: 503 })
            : null,
      ],
      [
        "revenuecat 503",
        (call) =>
          call.method === "DELETE" && call.url.startsWith(RC_URL)
            ? new Response("FAKE-rc-outage", { status: 503 })
            : null,
      ],
      [
        "auth 502",
        (call) =>
          call.method === "DELETE" && call.url.includes("/auth/v1/admin/users/")
            ? new Response(JSON.stringify({ msg: "FAKE-gotrue-outage" }), {
              status: 502,
              headers: { "Content-Type": "application/json" },
            })
            : null,
      ],
    ];
    for (const [label, responder] of cases) {
      h.reset();
      const owner = crypto.randomUUID();
      h.tables.profiles = [{ id: owner, provider: "apple" }];
      h.tables.account_external_credentials = [
        { user_id: owner, apple_refresh_token_encrypted: await encryptedAppleToken(owner) },
      ];
      const operation = await requestedDeletion(owner);
      h.deletion.age(operation.operationId);
      h.respond = responder;
      const { result: response } = await captureConsole(() => confirmDeletion(owner, operation));
      const text = await response.text();
      assert(response.status >= 500 && response.status < 600, `${label}: HTTP ${response.status}`);
      assert(!text.includes("deleted"), `${label}: no receipt in ${text}`);
      assert(!text.includes("FAKE-"), `${label}: provider detail leaked: ${text}`);
      assertEquals(namespaceReads(owner), [], `${label}: no namespace read before Auth deletion`);
      if (label.startsWith("apple")) {
        assertEquals(revenueCatDeletes(), [], `${label}: RevenueCat not reached`);
        assertEquals(authDeletes(), [], `${label}: Auth not reached`);
      }
      if (label.startsWith("revenuecat")) {
        assertEquals(authDeletes(), [], `${label}: Auth not reached`);
      }
      // Retry with the provider healthy: one more call to the failed step only,
      // no second Apple revoke once it succeeded.
      h.respond = () => null;
      const retried = await confirmDeletion(owner, operation);
      assertEquals(retried.status, 200, `${label}: retry completes`);
      assertEquals((await retried.json()).deleted, true);
      assertEquals(
        appleRevokes().length,
        label.startsWith("apple") ? 2 : 1,
        `${label}: Apple revoke count`,
      );
      assertEquals(
        authDeletes().length,
        label.startsWith("auth") ? 2 : 1,
        `${label}: Auth delete attempted once per failed/successful step, never after success`,
      );
      assertEquals(
        namespaceReads(owner).map((c) => new URL(c.url).pathname.slice("/rest/v1/".length)).sort(),
        OWNER_TABLES.map(([t]) => t).sort(),
        `${label}: every namespace read once after the retry`,
      );
    }
  },
);

// ---------------------------------------------------------------------------
// ATTACK 6 — interleaved account switch: the bearer that confirms belongs to
// a different account than the operation owner. The other account must get a
// non-2xx, the real owner's Auth/Apple/RC must be untouched, and no owner
// namespace may be read on behalf of the wrong account.
// ---------------------------------------------------------------------------
Deno.test(
  "ATTACK W08-06 #6: a different signed-in account cannot confirm (or read the inventory of) another owner's operation",
  async () => {
    h.reset();
    const owner = crypto.randomUUID();
    const intruder = crypto.randomUUID();
    h.tables.shots = [{ id: uuid(5), user_id: owner }];
    const operation = await requestedDeletion(owner);
    h.deletion.age(operation.operationId);
    const response = await confirmDeletion(intruder, operation);
    assert(response.status >= 400 && response.status < 500, `HTTP ${response.status}`);
    assert(!(await response.text()).includes("deleted"));
    assertEquals(authDeletes(), []);
    assertEquals(appleRevokes(), []);
    assertEquals(revenueCatDeletes(), []);
    assertEquals(namespaceReads(owner), [], "no service-role read of the owner's rows");
    assertEquals(namespaceReads(intruder), [], "no service-role read of the intruder's rows");
    assertEquals(h.tables.shots.length, 1);
    // Status capability is bound to the operation, not the bearer: the owner's
    // capability still reports pending (nothing was confirmed).
    assertEquals((await (await deletionStatus(operation)).json()).state, "pending");
  },
);

// ---------------------------------------------------------------------------
// ATTACK 7 — keyset boundary at the route: a surviving composite-key row whose
// key contains a double quote, a backslash, a comma and a parenthesis must
// still produce a parseable PostgREST `or=` cursor (the stand-in throws on
// unparseable grammar) and be counted exactly once — never `repeated_row`,
// never an unread namespace, never 200.
// ---------------------------------------------------------------------------
Deno.test(
  "ATTACK W08-06 #7: composite residue keys with quote/backslash/comma/paren are paged exactly once and reported as residue",
  async () => {
    h.reset();
    const owner = crypto.randomUUID();
    const nasty = ['a"b', "c\\d", "e,f", "g)h", "(i", "j.lt.k", ""].map((slug, i) => ({
      user_id: owner,
      slug: `${slug}-${i}`,
    }));
    // survives Auth deletion: keep the rows out of the harness cascade by
    // re-inserting them on every read of user_saved_drills.
    h.respond = (call) => {
      if (
        call.method !== "GET" ||
        !new URL(call.url).pathname.endsWith("/rest/v1/user_saved_drills")
      ) {
        return null;
      }
      h.tables.user_saved_drills = [...nasty];
      return null;
    };
    const operation = await requestedDeletion(owner);
    h.deletion.age(operation.operationId);
    const { result: response, logs } = await captureConsole(() =>
      confirmDeletion(owner, operation)
    );
    assertEquals(response.status, 503);
    const failure = logs.find(
      (log) => log.level === "error" && String(log.args[0]).includes("Account deletion"),
    );
    assert(failure, "operator log present");
    assertEquals(failure.args[1], {
      code: "completion_unverified",
      status: null,
      namespaces: [
        { table: "user_saved_drills", outcome: "residue", rows: nasty.length, pages: 2 },
      ],
    });
    const drillReads = h.calls.filter(
      (call) =>
        call.method === "GET" &&
        new URL(call.url).pathname.endsWith("/rest/v1/user_saved_drills") &&
        call.url.includes(`=eq.${owner}`),
    );
    assertEquals(drillReads.length, 2);
    assertStringIncludes(decodeURIComponent(new URL(drillReads[1].url).search), "or=(");
  },
);

async function encryptedAppleToken(owner: string): Promise<string> {
  return await encryptAppleRefreshToken(
    `apple-refresh-${owner}`,
    owner,
    h.appleTokenEncryptionKey,
  );
}
