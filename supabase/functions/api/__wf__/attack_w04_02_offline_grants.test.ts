// ADVERSARIAL TESTS for W04-02 (candidate 90bf7e3d) — POST /v1/devices/register
// and POST /v1/offline/grants through the REAL edge handler (routesHarness,
// Supabase stubbed at the fetch layer). Additive only: the candidate's own
// suite (offline_grants_routes.test.ts) is untouched.
//
// Each Deno.test is one attack. A test that FAILS on the candidate is a
// confirmed break (the assertion states the EXPECTED behaviour); a test that
// passes documents an attack that did not break anything.
//
// Attack categories covered here: boundary values / clock skew, corrupt and
// partial persisted state (RPC rows), network failure at every RPC step
// (5xx, 429, redirect, thrown fetch, non-JSON), concurrency (burst against the
// per-user budget), replay / rotation of the signing key, redaction of 5xx
// bodies and the audit line, malformed request bodies.

import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { exportJWK, generateKeyPair } from "jose";
import {
  type OfflineExecutionGrantClaims,
  type OfflineReleasedArtifacts,
} from "../../../../packages/shared-types/src/offlineAuthorization.ts";
import {
  importOfflineGrantVerificationKey,
  type OfflineGrantKey,
  type OfflineGrantVerificationContext,
  verifyOfflineExecutionGrant,
} from "../offlineSignature.ts";
import { activeReleasePolicyRow, HARNESS_RELEASE_POLICY } from "./releasePolicyFixture.ts";
import {
  captureConsole,
  fakeGoogleIdToken,
  loadHarness,
  SUPABASE_URL,
  userRequest,
} from "./routesHarness.ts";

const h = await loadHarness();

const REGISTER_PATH = "/v1/devices/register";
const GRANTS_PATH = "/v1/offline/grants";
const REGISTER_RPC = "/rest/v1/rpc/register_offline_device";
const GRANT_RPC = "/rest/v1/rpc/issue_offline_grant";
const POLICY_RPC = "/rest/v1/rpc/read_analysis_release_policy";
const ISSUER = `${SUPABASE_URL}/functions/v1/api`;
const SIGNING_ENV = "OFFLINE_GRANT_SIGNING_JWK";
const INSTALLATION_KEY = "ios-installation-attack-w04-02";
const DEVICE_ID = "33333333-3333-4333-8333-333333333333";
const GRANT_ID = "44444444-4444-4444-8444-444444444444";
const TICKET_A = "55555555-5555-4555-8555-555555555551";
const TICKET_B = "55555555-5555-4555-8555-555555555552";
const DAY = 86_400;

const KID_A = "attack-key-a";
const KID_B = "attack-key-b";
const pairA = await generateKeyPair("ES256", { extractable: true });
const pairB = await generateKeyPair("ES256", { extractable: true });
const privateJwkA = { ...(await exportJWK(pairA.privateKey)), kid: KID_A };
const privateJwkB = { ...(await exportJWK(pairB.privateKey)), kid: KID_B };
const verifyA: OfflineGrantKey = await importOfflineGrantVerificationKey(
  KID_A,
  await exportJWK(pairA.publicKey),
);
const verifyB: OfflineGrantKey = await importOfflineGrantVerificationKey(
  KID_B,
  await exportJWK(pairB.publicKey),
);

const releasePolicyRow = await activeReleasePolicyRow();
const approval = releasePolicyRow.approval as { policy: { version: string; sha256: string } };
const RELEASE: OfflineReleasedArtifacts = {
  policy: approval.policy,
  mechanicsModel: HARNESS_RELEASE_POLICY.mechanics.lineage.model,
  benchmarkModel: HARNESS_RELEASE_POLICY.benchmark.lineage.model,
};

const nowSeconds = (): number => Math.floor(Date.now() / 1000);
const iso = (epochSeconds: number): string => new Date(epochSeconds * 1000).toISOString();
/** A timestamptz exactly as PostgREST serializes it (microseconds, +00:00). */
const pgInstant = (epochSeconds: number, micros: number): string =>
  `${iso(epochSeconds).slice(0, 19)}.${String(micros).padStart(6, "0")}+00:00`;

interface GrantRow {
  result: string;
  grant_id: string | null;
  generation: number | null;
  entitlement_source: string | null;
  issued_at: string | null;
  expires_at: string | null;
  entitlement_expires_at: string | null;
  ticket_ids: string[] | null;
}

function proRow(options: {
  issuedAt?: string;
  expiresAt?: string;
  entitlementExpiresAt?: string | null;
  generation?: number;
}): GrantRow {
  const issued = nowSeconds() - 5;
  return {
    result: "accepted",
    grant_id: GRANT_ID,
    generation: options.generation ?? 1,
    entitlement_source: "verified_store",
    issued_at: options.issuedAt ?? iso(issued),
    expires_at: options.expiresAt ?? iso(issued + 3 * DAY),
    entitlement_expires_at: options.entitlementExpiresAt === undefined
      ? iso(issued + 30 * DAY)
      : options.entitlementExpiresAt,
    ticket_ids: [],
  };
}

function freeRow(options: { issuedAt?: number; tickets?: string[] } = {}): GrantRow {
  const issuedAt = options.issuedAt ?? nowSeconds() - 5;
  return {
    result: "accepted",
    grant_id: GRANT_ID,
    generation: 3,
    entitlement_source: "identity_lifetime_free",
    issued_at: iso(issuedAt),
    expires_at: iso(issuedAt + 7 * DAY),
    entitlement_expires_at: null,
    ticket_ids: options.tickets ?? [TICKET_A, TICKET_B],
  };
}

let userSeq = 0;
/** A fresh account per attack so the per-user route budget never leaks across tests. */
function freshUser(): { sub: string; token: string } {
  userSeq += 1;
  const sub = `aaaaaaaa-0402-4000-8000-a77ac${String(userSeq).padStart(7, "0")}`;
  return { sub, token: fakeGoogleIdToken(sub) };
}

function reset(): void {
  h.reset();
  Deno.env.set(SIGNING_ENV, JSON.stringify(privateJwkA));
  h.rpcs.register_offline_device = [
    { result: "accepted", device_id: DEVICE_ID, attestation_state: "unattested" },
  ];
  h.rpcs.issue_offline_grant = [proRow({})];
}

async function post(path: string, body: unknown, token: string): Promise<Response> {
  return await h.handler(userRequest("POST", path, { token, body }));
}

async function postRaw(path: string, rawBody: string, token: string): Promise<Response> {
  return await h.handler(
    new Request(`http://edge.test/functions/v1/api${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "x-forwarded-for": "203.0.113.77",
        "Content-Type": "application/json",
      },
      body: rawBody,
    }),
  );
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

function errorCode(body: Record<string, unknown>): string | undefined {
  const error = body.error;
  return error && typeof error === "object" ? (error as { code?: string }).code : undefined;
}

function context(
  ownerId: string,
  kid: string,
  installationKeyId = INSTALLATION_KEY,
): OfflineGrantVerificationContext {
  return {
    binding: { issuer: ISSUER, allowedKeyIds: [kid], ownerId, installationKeyId },
    release: RELEASE,
    nowEpochSeconds: nowSeconds(),
  };
}

async function verifyWith(
  raw: unknown,
  key: OfflineGrantKey,
  ownerId: string,
): Promise<OfflineExecutionGrantClaims> {
  const envelope = await verifyOfflineExecutionGrant(raw, [key], context(ownerId, key.kid));
  return envelope.claims;
}

function auditEntries(logs: Array<{ level: string; args: unknown[] }>): Record<string, unknown>[] {
  return logs
    .filter((entry) => entry.level === "warn" && entry.args[0] === "[api] offline grant")
    .map((entry) => entry.args[1] as Record<string, unknown>);
}

function grantRpcBody(): Record<string, unknown> {
  const calls = h.callsTo(GRANT_RPC);
  assertEquals(calls.length, 1);
  return calls[0].body as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// ATTACK 1 — clock skew between the database and the edge isolate.
//
// issue_offline_grant() stamps issued_at with the DATABASE clock; the edge fn
// then signs with `nowEpochSeconds = floor(Date.now()/1000)` from the ISOLATE
// clock and signOfflineExecutionGrant() refuses `now < iat` with zero
// tolerance. A database whose clock is ≥ 1 s ahead of the isolate (two
// different hosts in every hosted deployment) therefore produces a row the RPC
// has ALREADY committed (generation spent, free tickets allocated) that the
// edge fn cannot sign. Allowed path first (same second), then the skewed one.
// ---------------------------------------------------------------------------

Deno.test(
  "ATTACK clock: an accepted row issued in the CURRENT second signs (allowed path)",
  async () => {
    reset();
    const user = freshUser();
    const issued = nowSeconds();
    h.rpcs.issue_offline_grant = [
      proRow({
        issuedAt: pgInstant(issued, 0),
        expiresAt: pgInstant(issued + 3 * DAY, 0),
        entitlementExpiresAt: pgInstant(issued + 30 * DAY, 0),
      }),
    ];
    const response = await post(GRANTS_PATH, { installationKeyId: INSTALLATION_KEY }, user.token);
    assertEquals(response.status, 200);
    const body = await readJson(response);
    const claims = await verifyWith(body.grant, verifyA, user.sub);
    assertEquals(claims.iat, issued);
  },
);

Deno.test(
  "ATTACK clock: a row the database ALREADY committed with issued_at 2 s ahead of the isolate clock must still be signed (the generation is spent either way)",
  async () => {
    reset();
    const user = freshUser();
    const issued = nowSeconds() + 2;
    h.rpcs.issue_offline_grant = [
      proRow({
        issuedAt: pgInstant(issued, 0),
        expiresAt: pgInstant(issued + 3 * DAY, 0),
        entitlementExpiresAt: pgInstant(issued + 30 * DAY, 0),
      }),
    ];
    const { result: response, logs } = await captureConsole(() =>
      post(GRANTS_PATH, { installationKeyId: INSTALLATION_KEY }, user.token)
    );
    // The grant-spending RPC was called (the generation is gone on the DB).
    assertEquals(h.callsTo(GRANT_RPC).length, 1);
    const text = await response.text();
    assertEquals(
      response.status,
      200,
      `expected a signed grant for a DB-accepted row with ≤ 2 s clock skew; got ${response.status} ${text}; audit=${
        JSON.stringify(auditEntries(logs))
      }`,
    );
  },
);

Deno.test(
  "ATTACK audit: a refusal that never reached the signer must not be audited as signing_failed",
  async () => {
    reset();
    const user = freshUser();
    const issued = nowSeconds() + 60;
    h.rpcs.issue_offline_grant = [
      proRow({
        issuedAt: pgInstant(issued, 0),
        expiresAt: pgInstant(issued + 3 * DAY, 0),
        entitlementExpiresAt: pgInstant(issued + 30 * DAY, 0),
      }),
    ];
    const { result: response, logs } = await captureConsole(() =>
      post(GRANTS_PATH, { installationKeyId: INSTALLATION_KEY }, user.token)
    );
    await response.text();
    const audits = auditEntries(logs);
    assertEquals(audits.length, 1);
    assertEquals(audits[0].outcome, "refused");
    // The signer was never reached — the claims failed the time binding
    // (`invalid_time`). Auditing that as "signing_failed" points operators
    // at the key material instead of at the clock.
    assertNotEquals(audits[0].reason, "signing_failed", JSON.stringify(audits[0]));
  },
);

// ---------------------------------------------------------------------------
// ATTACK 2 — sub-second lease the table accepts (expires_at > issued_at) but
// the whole-second floor collapses. Documents the observed refusal.
// ---------------------------------------------------------------------------

Deno.test(
  "ATTACK boundary: a DB-valid lease that starts and ends inside the same second is refused without a signature (documented)",
  async () => {
    reset();
    const user = freshUser();
    const issued = nowSeconds() - 1;
    h.rpcs.issue_offline_grant = [
      proRow({
        issuedAt: pgInstant(issued, 200_000),
        expiresAt: pgInstant(issued, 700_000),
        entitlementExpiresAt: pgInstant(issued, 700_000),
      }),
    ];
    const { result: response, logs } = await captureConsole(() =>
      post(GRANTS_PATH, { installationKeyId: INSTALLATION_KEY }, user.token)
    );
    assertEquals(response.status, 503);
    assert(!(await response.text()).includes("compactJws"));
    assertEquals(auditEntries(logs)[0]?.reason, "expiry_not_after_issuance");
  },
);

// ---------------------------------------------------------------------------
// ATTACK 3 — PostgREST timestamp shapes and 7-day boundary with microseconds.
// ---------------------------------------------------------------------------

Deno.test(
  "ATTACK boundary: PostgREST microsecond timestamps at exactly 7 days sign; 7 days + 1 µs beyond the floor is refused",
  async () => {
    reset();
    const issued = nowSeconds() - 10;
    // issued .999999, expires exactly +7d .999999 → floored diff = 7d → allowed.
    let user = freshUser();
    h.rpcs.issue_offline_grant = [
      proRow({
        issuedAt: pgInstant(issued, 999_999),
        expiresAt: pgInstant(issued + 7 * DAY, 999_999),
        entitlementExpiresAt: pgInstant(issued + 30 * DAY, 0),
      }),
    ];
    let response = await post(GRANTS_PATH, { installationKeyId: INSTALLATION_KEY }, user.token);
    assertEquals(response.status, 200);
    let body = await readJson(response);
    let claims = await verifyWith(body.grant, verifyA, user.sub);
    assertEquals(claims.exp - claims.iat, 7 * DAY);
    // The signed exp never exceeds what the row allows (floor, not round).
    assert(claims.exp * 1000 <= Date.parse(pgInstant(issued + 7 * DAY, 999_999)));

    // expires one second past 7d (in whole seconds) → refused, no signature.
    user = freshUser();
    h.rpcs.issue_offline_grant = [
      proRow({
        issuedAt: pgInstant(issued, 999_999),
        expiresAt: pgInstant(issued + 7 * DAY + 1, 0),
        entitlementExpiresAt: pgInstant(issued + 30 * DAY, 0),
      }),
    ];
    response = await post(GRANTS_PATH, { installationKeyId: INSTALLATION_KEY }, user.token);
    assertEquals(response.status, 503);
    assert(!(await response.text()).includes("compactJws"));

    // Entitlement expiry with a non-UTC offset (session timezone) still binds.
    user = freshUser();
    const ent = issued + 2 * DAY;
    const offsetIso = new Date((ent + 2 * 3600) * 1000).toISOString().slice(0, 19) + "+02:00";
    h.rpcs.issue_offline_grant = [
      proRow({
        issuedAt: pgInstant(issued, 0),
        expiresAt: pgInstant(ent, 0),
        entitlementExpiresAt: offsetIso,
      }),
    ];
    response = await post(GRANTS_PATH, { installationKeyId: INSTALLATION_KEY }, user.token);
    assertEquals(response.status, 200);
    body = await readJson(response);
    claims = await verifyWith(body.grant, verifyA, user.sub);
    assert(claims.lease?.kind === "subscription");
    assertEquals(claims.lease.verifiedEntitlementExpiresAt, ent);
    assertEquals(claims.exp, ent);
  },
);

// ---------------------------------------------------------------------------
// ATTACK 4 — malformed and hostile request bodies (never a 500, never an RPC).
// ---------------------------------------------------------------------------

Deno.test(
  "ATTACK input: non-object / invalid JSON bodies answer 400 (never 500) and spend nothing on either route",
  async () => {
    reset();
    const user = freshUser();
    for (const raw of ["[]", '"string"', "null", "123", "true", "{", '{"a":', "\u0000"]) {
      for (const path of [GRANTS_PATH, REGISTER_PATH]) {
        const response = await postRaw(path, raw, user.token);
        assertEquals(response.status, 400, `${path} ${JSON.stringify(raw)} → ${response.status}`);
        await response.text();
      }
    }
    // Empty body → {} → invalid input (400), not a crash.
    for (const path of [GRANTS_PATH, REGISTER_PATH]) {
      const response = await postRaw(path, "", user.token);
      assertEquals(response.status, 400);
      assertEquals(errorCode(await readJson(response)), "offline.invalid_input");
    }
    assertEquals(h.callsTo(GRANT_RPC).length, 0);
    assertEquals(h.callsTo(REGISTER_RPC).length, 0);
  },
);

Deno.test(
  "ATTACK boundary: installationKeyId and requestedTickets edges — accepted values reach the RPC unchanged, rejected ones never do",
  async () => {
    reset();
    const key128 = "k" + "x".repeat(127);
    const key129 = "k" + "x".repeat(128);
    const rejectedKeys: unknown[] = [
      key129,
      "-leading-dash",
      ".dot",
      "",
      "é-unicode",
      "a b",
      "a/b",
      "a\u0000b",
      ["k"],
      { k: 1 },
      1,
      null,
      true,
    ];
    for (const installationKeyId of rejectedKeys) {
      const user = freshUser();
      const response = await post(GRANTS_PATH, { installationKeyId }, user.token);
      assertEquals(response.status, 400, JSON.stringify(installationKeyId));
      assertEquals(errorCode(await readJson(response)), "offline.invalid_input");
      const reg = await post(
        REGISTER_PATH,
        { installationKeyId, attestationEnvironment: "production" },
        user.token,
      );
      assertEquals(reg.status, 400, JSON.stringify(installationKeyId));
      await reg.text();
    }
    const rejectedTickets: unknown[] = [3, -1, 1.5, "2", true, [], {}, 2.5, 1e21, -0.5];
    for (const requestedTickets of rejectedTickets) {
      const response = await post(
        GRANTS_PATH,
        { installationKeyId: INSTALLATION_KEY, requestedTickets },
        freshUser().token,
      );
      assertEquals(response.status, 400, JSON.stringify(requestedTickets));
      await response.text();
    }
    for (const environment of ["Production", "development ", "prod", "", null, 1, ["production"]]) {
      const response = await post(
        REGISTER_PATH,
        { installationKeyId: INSTALLATION_KEY, attestationEnvironment: environment },
        freshUser().token,
      );
      assertEquals(response.status, 400, JSON.stringify(environment));
      await response.text();
    }
    assertEquals(h.callsTo(GRANT_RPC).length, 0);
    assertEquals(h.callsTo(REGISTER_RPC).length, 0);

    // Accepted edges: 128-char key, 1-char key, tickets 0 / 1 / 2 / 2.0 / -0.
    for (
      const [installationKeyId, requestedTickets, expectedTickets] of [
        [key128, 2, 2],
        ["a", 0, 0],
        ["A.b_c:d-e", 1, 1],
        [INSTALLATION_KEY, 2.0, 2],
        [INSTALLATION_KEY, -0, 0],
        [INSTALLATION_KEY, undefined, 2],
        [INSTALLATION_KEY, null, 2],
      ] as const
    ) {
      h.reset();
      Deno.env.set(SIGNING_ENV, JSON.stringify(privateJwkA));
      const user = freshUser();
      h.rpcs.issue_offline_grant = [proRow({})];
      const body: Record<string, unknown> = { installationKeyId };
      if (requestedTickets !== undefined) body.requestedTickets = requestedTickets;
      const response = await post(GRANTS_PATH, body, user.token);
      assertEquals(response.status, 200, JSON.stringify(body));
      const json = await readJson(response);
      const rpc = grantRpcBody();
      assertEquals(rpc.p_installation_key_id, installationKeyId);
      assertEquals(rpc.p_requested_tickets, expectedTickets);
      // The grant is bound to the exact key the RPC saw.
      const envelope = await verifyOfflineExecutionGrant(
        json.grant,
        [verifyA],
        context(user.sub, KID_A, installationKeyId),
      );
      assertEquals(envelope.claims.installationKeyId, installationKeyId);
    }
  },
);

// ---------------------------------------------------------------------------
// ATTACK 5 — concurrency: a burst of parallel requests against the per-user
// budget must admit EXACTLY the budget (no read-then-write under-count) and
// spend exactly that many grant generations.
// ---------------------------------------------------------------------------

Deno.test(
  "ATTACK concurrency: 30 parallel grant requests from one account admit exactly 10 and call the RPC exactly 10 times",
  async () => {
    reset();
    const user = freshUser();
    const responses = await Promise.all(
      Array.from(
        { length: 30 },
        () => post(GRANTS_PATH, { installationKeyId: INSTALLATION_KEY }, user.token),
      ),
    );
    const statuses = responses.map((r) => r.status);
    await Promise.all(responses.map((r) => r.text()));
    assertEquals(statuses.filter((s) => s === 200).length, 10, JSON.stringify(statuses));
    assertEquals(statuses.filter((s) => s === 429).length, 20, JSON.stringify(statuses));
    assertEquals(h.callsTo(GRANT_RPC).length, 10);
    for (const r of responses.filter((r) => r.status === 429)) {
      assert(/^\d+$/.test(r.headers.get("Retry-After") ?? ""));
    }
    // The burst never bled into another account's budget.
    const other = freshUser();
    const fresh = await post(GRANTS_PATH, { installationKeyId: INSTALLATION_KEY }, other.token);
    assertEquals(fresh.status, 200);
    await fresh.text();
  },
);

Deno.test(
  "ATTACK concurrency: parallel registration + grant requests keep their budgets independent and each grant is bound to its own caller",
  async () => {
    reset();
    const a = freshUser();
    const b = freshUser();
    const mixed = await Promise.all([
      ...Array.from(
        { length: 10 },
        () => post(GRANTS_PATH, { installationKeyId: INSTALLATION_KEY }, a.token),
      ),
      ...Array.from({ length: 10 }, () =>
        post(
          REGISTER_PATH,
          { installationKeyId: INSTALLATION_KEY, attestationEnvironment: "production" },
          a.token,
        )),
      ...Array.from(
        { length: 10 },
        () => post(GRANTS_PATH, { installationKeyId: INSTALLATION_KEY }, b.token),
      ),
    ]);
    const statuses = mixed.map((r) => r.status);
    assertEquals(statuses.filter((s) => s !== 200), [], JSON.stringify(statuses));
    const bodies = await Promise.all(mixed.map((r) => readJson(r)));
    for (let i = 0; i < 10; i += 1) await verifyWith(bodies[i].grant, verifyA, a.sub);
    for (let i = 20; i < 30; i += 1) {
      await verifyWith(bodies[i].grant, verifyA, b.sub);
      let crossed = false;
      try {
        await verifyWith(bodies[i].grant, verifyA, a.sub);
        crossed = true;
      } catch {
        // expected: the grant is bound to b
      }
      assert(!crossed, "a grant issued to b must never verify for a");
    }
    // Every grant RPC ran as its own caller.
    const calls = h.callsTo(GRANT_RPC);
    assertEquals(calls.length, 20);
    assertEquals(
      calls.filter((c) => c.headers.authorization === `Bearer session-for-${a.sub}`).length,
      10,
    );
    assertEquals(
      calls.filter((c) => c.headers.authorization === `Bearer session-for-${b.sub}`).length,
      10,
    );
  },
);

// ---------------------------------------------------------------------------
// ATTACK 6 — network failure at each step: session check, release authority,
// grant RPC (5xx, 429, redirect, thrown fetch, non-JSON, wrong cardinality).
// Every failure must be a generic 503 (never 500, never a signed grant, never
// a leaked detail) and a failure BEFORE the grant RPC must spend nothing.
// ---------------------------------------------------------------------------

Deno.test(
  "ATTACK network: failures before the grant RPC (session check, release authority) answer 503 and never spend",
  async () => {
    reset();
    const user = freshUser();
    const scenarios: Array<[string, () => void]> = [
      ["session rpc 500", () => {
        h.rpcErrors.is_api_session_active = 500;
      }],
      ["session rpc 429", () => {
        h.rpcErrors.is_api_session_active = 429;
      }],
      ["session rpc non-boolean", () => {
        h.rpcs.is_api_session_active = "true";
      }],
      ["policy rpc 503", () => {
        h.rpcErrors.read_analysis_release_policy = 503;
      }],
      ["policy rpc redirect", () => {
        h.respond = (call) =>
          call.url.includes(POLICY_RPC)
            ? new Response(null, { status: 302, headers: { Location: "https://evil.example/" } })
            : null;
      }],
      ["policy rpc network throw", () => {
        h.respond = (call) => {
          if (call.url.includes(POLICY_RPC)) throw new TypeError("network down");
          return null;
        };
      }],
      ["policy rpc non-json", () => {
        h.respond = (call) =>
          call.url.includes(POLICY_RPC)
            ? new Response("<html>gateway</html>", {
              status: 200,
              headers: { "Content-Type": "text/html" },
            })
            : null;
      }],
    ];
    for (const [name, arm] of scenarios) {
      reset();
      arm();
      const response = await post(GRANTS_PATH, { installationKeyId: INSTALLATION_KEY }, user.token);
      assertEquals(response.status, 503, name);
      const text = await response.text();
      assert(!text.includes("compactJws"), name);
      assert(!text.includes(INSTALLATION_KEY) && !text.includes(user.sub), name);
      assertEquals(h.callsTo(GRANT_RPC).length, 0, name);
    }
  },
);

Deno.test(
  "ATTACK network: grant RPC 5xx / 429 / redirect / thrown fetch / non-JSON / wrong cardinality → generic 503, nothing signed, nothing leaked",
  async () => {
    const scenarios: Array<[string, () => void]> = [
      ["rpc 500", () => {
        h.rpcErrors.issue_offline_grant = 500;
      }],
      ["rpc 502", () => {
        h.rpcErrors.issue_offline_grant = 502;
      }],
      ["rpc 429", () => {
        h.rpcErrors.issue_offline_grant = 429;
      }],
      ["rpc 401 (session revoked between check and rpc)", () => {
        h.rpcErrors.issue_offline_grant = 401;
      }],
      ["rpc 403 42501", () => {
        h.respond = (call) =>
          call.url.includes(GRANT_RPC)
            ? new Response(JSON.stringify({ code: "42501", message: "permission denied" }), {
              status: 403,
              headers: { "Content-Type": "application/json" },
            })
            : null;
      }],
      ["rpc redirect", () => {
        h.respond = (call) =>
          call.url.includes(GRANT_RPC)
            ? new Response(null, { status: 307, headers: { Location: "https://evil.example/" } })
            : null;
      }],
      ["rpc network throw", () => {
        h.respond = (call) => {
          if (call.url.includes(GRANT_RPC)) throw new TypeError("connection reset");
          return null;
        };
      }],
      ["rpc non-json 200", () => {
        h.respond = (call) =>
          call.url.includes(GRANT_RPC)
            ? new Response("not json", { status: 200, headers: { "Content-Type": "text/plain" } })
            : null;
      }],
      ["rpc empty 200", () => {
        h.respond = (call) =>
          call.url.includes(GRANT_RPC) ? new Response(null, { status: 200 }) : null;
      }],
      ["rpc null row", () => {
        h.rpcs.issue_offline_grant = null;
      }],
      ["rpc string row", () => {
        h.rpcs.issue_offline_grant = "accepted";
      }],
      ["rpc two rows", () => {
        h.rpcs.issue_offline_grant = [proRow({}), proRow({ generation: 2 })];
      }],
      ["rpc row without result", () => {
        h.rpcs.issue_offline_grant = [{ ...proRow({}), result: undefined }];
      }],
      ["rpc numeric result", () => {
        h.rpcs.issue_offline_grant = [{ ...proRow({}), result: 200 }];
      }],
      ["rpc unknown refusal string", () => {
        h.rpcs.issue_offline_grant = [{ ...proRow({}), result: "offline.something_new" }];
      }],
      ["rpc accepted row with attacker-shaped grant_id", () => {
        h.rpcs.issue_offline_grant = [{
          ...proRow({}),
          grant_id: `${GRANT_ID}\n[api] injected`,
        }];
      }],
    ];
    for (const [name, arm] of scenarios) {
      reset();
      arm();
      // A fresh account per scenario: the failure, not the route budget, must answer.
      const user = freshUser();
      const { result: response, logs } = await captureConsole(() =>
        post(GRANTS_PATH, { installationKeyId: INSTALLATION_KEY }, user.token)
      );
      assertEquals(response.status, 503, name);
      const text = await response.text();
      assert(!text.includes("compactJws"), name);
      assert(!text.includes(INSTALLATION_KEY) && !text.includes(user.sub), name);
      assert(!text.includes("injected") && !text.includes("42501"), name);
      // Nothing in the audit/console output carries the owner or installation.
      const output = JSON.stringify(logs.map((l) => l.args));
      assert(!output.includes(user.sub), `${name}: owner leaked to logs`);
      assert(!output.includes(INSTALLATION_KEY), `${name}: installation key leaked to logs`);
    }
  },
);

Deno.test(
  "ATTACK network: registration RPC failures (5xx, redirect, thrown fetch, wrong shape) → generic 503, never 500",
  async () => {
    const user = freshUser();
    const scenarios: Array<[string, () => void]> = [
      ["rpc 500", () => {
        h.rpcErrors.register_offline_device = 500;
      }],
      ["rpc redirect", () => {
        h.respond = (call) =>
          call.url.includes(REGISTER_RPC)
            ? new Response(null, { status: 302, headers: { Location: "https://evil.example/" } })
            : null;
      }],
      ["rpc throw", () => {
        h.respond = (call) => {
          if (call.url.includes(REGISTER_RPC)) throw new TypeError("connection reset");
          return null;
        };
      }],
      ["rpc empty array", () => {
        h.rpcs.register_offline_device = [];
      }],
      ["rpc accepted without device_id", () => {
        h.rpcs.register_offline_device = [{ result: "accepted", attestation_state: "unattested" }];
      }],
      ["rpc accepted with unknown state", () => {
        h.rpcs.register_offline_device = [{
          result: "accepted",
          device_id: DEVICE_ID,
          attestation_state: "trusted",
        }];
      }],
      ["rpc unknown result", () => {
        h.rpcs.register_offline_device = [{ result: "offline.brand_new_refusal" }];
      }],
    ];
    for (const [name, arm] of scenarios) {
      reset();
      arm();
      const response = await post(
        REGISTER_PATH,
        { installationKeyId: INSTALLATION_KEY, attestationEnvironment: "production" },
        user.token,
      );
      assertEquals(response.status, 503, name);
      const text = await response.text();
      assert(!text.includes(INSTALLATION_KEY) && !text.includes(user.sub), name);
    }
  },
);

// ---------------------------------------------------------------------------
// ATTACK 7 — signing-key rotation / corrupt secret between requests (the
// per-isolate cache must never serve a stale key once the secret changed, and
// a corrupt secret must not fall back to the previous key).
// ---------------------------------------------------------------------------

Deno.test(
  "ATTACK rotation: a rotated signing secret is used immediately, a corrupt secret never falls back to the cached key, and rotating back re-imports",
  async () => {
    reset();
    const user = freshUser();
    const first = await post(GRANTS_PATH, { installationKeyId: INSTALLATION_KEY }, user.token);
    assertEquals(first.status, 200);
    const firstBody = await readJson(first);
    assertEquals(firstBody.keyId, KID_A);
    await verifyWith(firstBody.grant, verifyA, user.sub);

    Deno.env.set(SIGNING_ENV, JSON.stringify(privateJwkB));
    const second = await post(GRANTS_PATH, { installationKeyId: INSTALLATION_KEY }, user.token);
    assertEquals(second.status, 200);
    const secondBody = await readJson(second);
    assertEquals(secondBody.keyId, KID_B);
    await verifyWith(secondBody.grant, verifyB, user.sub);
    let staleVerified = false;
    try {
      await verifyWith(secondBody.grant, verifyA, user.sub);
      staleVerified = true;
    } catch {
      // expected
    }
    assert(!staleVerified, "a grant signed after rotation must not verify with the old key");

    // Corrupt secret: 503, no RPC (nothing spent), no fallback to A or B.
    const rpcBefore = h.callsTo(GRANT_RPC).length;
    for (
      const corrupt of [
        "{",
        JSON.stringify({ ...privateJwkB, d: undefined }),
        JSON.stringify({ ...privateJwkB, kid: "has space" }),
        JSON.stringify({ ...privateJwkB, key_ops: ["sign", "verify"] }),
        JSON.stringify({ ...privateJwkB, alg: "ES384" }),
        JSON.stringify([privateJwkB]),
        "   ",
      ]
    ) {
      Deno.env.set(SIGNING_ENV, corrupt);
      const response = await post(GRANTS_PATH, { installationKeyId: INSTALLATION_KEY }, user.token);
      assertEquals(response.status, 503, corrupt);
      assert(!(await response.text()).includes("compactJws"));
    }
    assertEquals(h.callsTo(GRANT_RPC).length, rpcBefore);

    Deno.env.set(SIGNING_ENV, JSON.stringify(privateJwkA));
    const back = await post(GRANTS_PATH, { installationKeyId: INSTALLATION_KEY }, user.token);
    assertEquals(back.status, 200);
    const backBody = await readJson(back);
    assertEquals(backBody.keyId, KID_A);
    await verifyWith(backBody.grant, verifyA, user.sub);
  },
);

// ---------------------------------------------------------------------------
// ATTACK 8 — replay: the same accepted row served to two different owners
// must yield two grants each bound to ITS caller only; a free row replayed
// with the same tickets is signed as-is (the DB, not the edge, owns dedupe).
// ---------------------------------------------------------------------------

Deno.test(
  "ATTACK replay: an identical RPC row served to two callers yields owner-bound grants that never cross-verify",
  async () => {
    reset();
    const a = freshUser();
    const b = freshUser();
    h.rpcs.issue_offline_grant = [freeRow()];
    const ra = await post(GRANTS_PATH, { installationKeyId: INSTALLATION_KEY }, a.token);
    const rb = await post(GRANTS_PATH, { installationKeyId: INSTALLATION_KEY }, b.token);
    assertEquals(ra.status, 200);
    assertEquals(rb.status, 200);
    const ba = await readJson(ra);
    const bb = await readJson(rb);
    const ca = await verifyWith(ba.grant, verifyA, a.sub);
    const cb = await verifyWith(bb.grant, verifyA, b.sub);
    assertEquals(ca.jti, cb.jti);
    assertEquals(ca.allocation?.ticketIds, [TICKET_A, TICKET_B]);
    assertEquals(cb.allocation?.ticketIds, [TICKET_A, TICKET_B]);
    for (const [grant, wrongOwner] of [[ba.grant, b.sub], [bb.grant, a.sub]] as const) {
      let crossed = false;
      try {
        await verifyWith(grant, verifyA, wrongOwner);
        crossed = true;
      } catch {
        // expected
      }
      assert(!crossed);
    }
    // And the response echoes exactly the claims that were signed.
    assertEquals(ba.ticketIds, [TICKET_A, TICKET_B]);
    assertEquals(ba.expiresAt, ca.exp);
    assertEquals(ba.issuedAt, ca.iat);
    assertEquals(ba.entitlementExpiresAt, null);
  },
);

// ---------------------------------------------------------------------------
// ATTACK 9 — corrupt persisted state the DB constraints would never produce
// but a partial/corrupt row could: Pro row with a lifetime lease AND tickets,
// Pro row with an expired entitlement, free row with a Pro-shaped lease.
// ---------------------------------------------------------------------------

Deno.test(
  "ATTACK corrupt state: Pro rows past entitlement / with tickets / expired entitlement, and free rows with entitlement expiry, are refused unsigned and audited with a categorical reason",
  async () => {
    reset();
    const issued = nowSeconds() - 5;
    const cases: Array<[Partial<GrantRow>, string]> = [
      [
        {
          issued_at: iso(issued),
          expires_at: iso(issued + 3 * DAY),
          entitlement_expires_at: iso(issued + 2 * DAY),
        },
        "expiry_exceeds_entitlement",
      ],
      [
        {
          issued_at: iso(issued),
          expires_at: iso(issued + DAY),
          entitlement_expires_at: iso(issued - 1),
        },
        "entitlement_expired",
      ],
      [
        {
          issued_at: iso(issued),
          expires_at: iso(issued + DAY),
          entitlement_expires_at: iso(issued),
        },
        "entitlement_expired",
      ],
      [{ entitlement_expires_at: null, ticket_ids: [TICKET_A] }, "tickets_invalid"],
      [{ entitlement_expires_at: "infinity" }, "row_malformed"],
      [{ entitlement_expires_at: 1_800_000_000 as unknown as string }, "row_malformed"],
      [{ issued_at: "2026-09-09T04:25:00" }, "row_malformed"],
      [{ issued_at: "2026-09-09 04:25:00+00" }, "row_malformed"],
      [{ generation: Number.MAX_SAFE_INTEGER + 1 }, "row_malformed"],
      [{ generation: -1 }, "row_malformed"],
      [{ grant_id: `${GRANT_ID} ` }, "row_malformed"],
    ];
    for (const [patch, reason] of cases) {
      const user = freshUser();
      h.rpcs.issue_offline_grant = [{ ...proRow({}), ...patch }];
      const { result: response, logs } = await captureConsole(() =>
        post(GRANTS_PATH, { installationKeyId: INSTALLATION_KEY }, user.token)
      );
      assertEquals(response.status, 503, JSON.stringify(patch));
      assert(!(await response.text()).includes("compactJws"));
      const audits = auditEntries(logs);
      assertEquals(audits.length, 1, JSON.stringify(patch));
      assertEquals(audits[0].reason, reason, JSON.stringify(patch));
      assertEquals(audits[0].outcome, "refused");
      assert(!JSON.stringify(audits[0]).includes(user.sub));
      assert(!JSON.stringify(audits[0]).includes(INSTALLATION_KEY));
    }
    // Free row carrying a Pro lease shape.
    const user = freshUser();
    h.rpcs.issue_offline_grant = [{ ...freeRow(), entitlement_expires_at: iso(issued + 30 * DAY) }];
    const response = await post(GRANTS_PATH, { installationKeyId: INSTALLATION_KEY }, user.token);
    assertEquals(response.status, 503);
    assert(!(await response.text()).includes("compactJws"));
  },
);

// ---------------------------------------------------------------------------
// ATTACK 10 — the response must not claim more than the signed grant: the
// unsigned metadata echoed beside `grant` must equal the verified claims.
// ---------------------------------------------------------------------------

Deno.test(
  "ATTACK integrity: every unsigned field echoed in the 200 body equals the verified claim it mirrors (Pro subscription, lifetime, free)",
  async () => {
    reset();
    const issued = nowSeconds() - 3;
    const rows: GrantRow[] = [
      proRow({
        issuedAt: pgInstant(issued, 123_456),
        expiresAt: pgInstant(issued + 5 * DAY, 123_456),
        entitlementExpiresAt: pgInstant(issued + 5 * DAY, 123_456),
        generation: 7,
      }),
      proRow({
        issuedAt: pgInstant(issued, 0),
        expiresAt: pgInstant(issued + 7 * DAY, 0),
        entitlementExpiresAt: null,
        generation: 8,
      }),
      freeRow({ issuedAt: issued, tickets: [TICKET_B] }),
    ];
    for (const row of rows) {
      const user = freshUser();
      h.rpcs.issue_offline_grant = [row];
      const response = await post(GRANTS_PATH, { installationKeyId: INSTALLATION_KEY }, user.token);
      assertEquals(response.status, 200, JSON.stringify(row));
      const body = await readJson(response);
      const claims = await verifyWith(body.grant, verifyA, user.sub);
      assertEquals(body.grantId, claims.jti);
      assertEquals(body.generation, row.generation);
      assertEquals(body.entitlementSource, claims.entitlementSource);
      assertEquals(body.issuedAt, claims.iat);
      assertEquals(body.expiresAt, claims.exp);
      assertEquals(body.keyId, KID_A);
      if (claims.entitlementSource === "verified_store") {
        assertEquals(body.entitlementExpiresAt, claims.lease?.verifiedEntitlementExpiresAt ?? null);
        assertEquals(body.ticketIds, []);
        assert(claims.exp * 1000 <= Date.parse(row.expires_at as string));
        if (row.entitlement_expires_at) {
          assert(claims.exp * 1000 <= Date.parse(row.entitlement_expires_at));
        }
      } else {
        assertEquals(body.entitlementExpiresAt, null);
        assertEquals(body.ticketIds, claims.allocation?.ticketIds);
        assertEquals(claims.allocation?.generation, row.generation);
      }
    }
  },
);
