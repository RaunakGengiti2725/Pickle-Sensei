// W04-02 — POST /v1/devices/register and POST /v1/offline/grants: the edge fn
// registers the caller's installation and issues an ES256-signed offline
// execution grant bound to the authenticated owner, the installation key, the
// verified release lineage and the entitlement expiry (≤ 7 days, ≤ verified
// store expiry), with a per-user route budget and a categorical audit line.
//
// Two halves, both black-box:
//   * the REAL edge handler through routesHarness (Supabase stubbed at the
//     fetch layer): both routes call the W04-01 RPCs as the CALLER (never the
//     service role), the returned grant verifies against the public key with
//     the independently configured issuer / audience / kid allowlist, and an
//     accepted RPC row whose expiry exceeds 7 days or the verified entitlement
//     expiry is REFUSED without a signature (allowed AND denied paths);
//   * the REAL issue_offline_grant() on a disposable postgres:16 with every
//     migration applied (./xc_pg_up.sh, XC_PG_URL): its rows flow through the
//     same edge claim builder into a verifiable grant, a Pro lease is capped
//     at min(issued + 7d, entitlement expiry), and the table itself refuses a
//     row past 7 days.
// Without XC_PG_URL the postgres half is `ignore`d — an ignored run is NOT a
// pass (the W04-02-AC2 gate runs with XC_PG_URL set).
//
// Runs unchanged against BASE_SHA, where both routes answer 404 and the claim
// builder does not exist, so every harness test fails there.

import postgres from "postgres";
import { assert, assertEquals, assertMatch, assertStringIncludes } from "@std/assert";
import { exportJWK, generateKeyPair } from "jose";
import {
  OFFLINE_GRANT_AUDIENCE,
  OFFLINE_PRO_LEASE_MAX_SECONDS,
  type OfflineExecutionGrantClaims,
  type OfflineReleasedArtifacts,
} from "../../../../packages/shared-types/src/offlineAuthorization.ts";
import {
  importOfflineGrantVerificationKey,
  type OfflineGrantKey,
  type OfflineGrantVerificationContext,
} from "../offlineSignature.ts";
import { activeReleasePolicyRow, HARNESS_RELEASE_POLICY } from "./releasePolicyFixture.ts";
import { FREE_RATING_LIMIT } from "./freeRatingLimit.ts";
import {
  captureConsole,
  fakeGoogleIdToken,
  loadHarness,
  SUPABASE_URL,
  TEST_USER_ID,
  userRequest,
} from "./routesHarness.ts";

const h = await loadHarness();

const REGISTER_PATH = "/v1/devices/register";
const GRANTS_PATH = "/v1/offline/grants";
const REGISTER_RPC = "/rest/v1/rpc/register_offline_device";
const GRANT_RPC = "/rest/v1/rpc/issue_offline_grant";
const POLICY_RPC = "/rest/v1/rpc/read_analysis_release_policy";
const ISSUER = `${SUPABASE_URL}/functions/v1/api`;
const KID = "w04-02-test-key";
const SIGNING_ENV = "OFFLINE_GRANT_SIGNING_JWK";
const INSTALLATION_KEY = "ios-installation-w04-02";
const DEVICE_ID = "33333333-3333-4333-8333-333333333333";
const GRANT_ID = "44444444-4444-4444-8444-444444444444";
const TICKET_A = "55555555-5555-4555-8555-555555555551";
const TICKET_B = "55555555-5555-4555-8555-555555555552";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DAY = 86_400;

const keyPair = await generateKeyPair("ES256", { extractable: true });
const privateJwk = { ...(await exportJWK(keyPair.privateKey)), kid: KID };
const publicJwk = await exportJWK(keyPair.publicKey);
const verificationKey: OfflineGrantKey = await importOfflineGrantVerificationKey(KID, publicJwk);

const releasePolicyRow = await activeReleasePolicyRow();
const approval = releasePolicyRow.approval as { policy: { version: string; sha256: string } };
const RELEASE: OfflineReleasedArtifacts = {
  policy: approval.policy,
  mechanicsModel: HARNESS_RELEASE_POLICY.mechanics.lineage.model,
  benchmarkModel: HARNESS_RELEASE_POLICY.benchmark.lineage.model,
};

const nowSeconds = (): number => Math.floor(Date.now() / 1000);
const iso = (epochSeconds: number): string => new Date(epochSeconds * 1000).toISOString();

interface GrantRow {
  result: string;
  grant_id: string | null;
  generation: number | null;
  entitlement_source: string | null;
  issued_at: string | null;
  expires_at: string | null;
  entitlement_expires_at: string | null;
  ticket_ids: string[] | null;
  attestation_state: string | null;
}

function refusedRow(result: string): GrantRow {
  return {
    result,
    grant_id: null,
    generation: null,
    entitlement_source: null,
    issued_at: null,
    expires_at: null,
    entitlement_expires_at: null,
    ticket_ids: null,
    attestation_state: null,
  };
}

function proRow(options: {
  issuedAt?: number;
  leaseSeconds: number;
  entitlementExpiresAt: number | null;
  generation?: number;
  attestationState?: string;
}): GrantRow {
  const issuedAt = options.issuedAt ?? nowSeconds() - 1;
  return {
    result: "accepted",
    grant_id: GRANT_ID,
    generation: options.generation ?? 1,
    entitlement_source: "verified_store",
    issued_at: iso(issuedAt),
    expires_at: iso(issuedAt + options.leaseSeconds),
    entitlement_expires_at:
      options.entitlementExpiresAt === null ? null : iso(options.entitlementExpiresAt),
    ticket_ids: [],
    attestation_state: options.attestationState ?? "unattested",
  };
}

function freeRow(options: {
  issuedAt?: number;
  leaseSeconds?: number;
  tickets?: string[];
  attestationState?: string;
}): GrantRow {
  const issuedAt = options.issuedAt ?? nowSeconds() - 1;
  return {
    result: "accepted",
    grant_id: GRANT_ID,
    generation: 3,
    entitlement_source: "identity_lifetime_free",
    issued_at: iso(issuedAt),
    expires_at: iso(issuedAt + (options.leaseSeconds ?? 7 * DAY)),
    entitlement_expires_at: null,
    ticket_ids: options.tickets ?? [TICKET_A, TICKET_B],
    attestation_state: options.attestationState ?? "unattested",
  };
}

/** The signed payload as a plain object, for asserting what the server did NOT claim. */
function signedPayload(grant: unknown): Record<string, unknown> {
  const compact = (grant as { compactJws: string }).compactJws;
  const payload = compact.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(atob(payload)) as Record<string, unknown>;
}

function claimsAttestation(payload: Record<string, unknown>): string[] {
  const hits: string[] = [];
  const walk = (value: unknown, path: string): void => {
    if (Array.isArray(value)) {
      value.forEach((entry, index) => walk(entry, `${path}[${index}]`));
      return;
    }
    if (value && typeof value === "object") {
      for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        if (/attest/i.test(key)) hits.push(`${path}.${key}`);
        walk(entry, `${path}.${key}`);
      }
      return;
    }
    if (typeof value === "string" && /attest/i.test(value)) hits.push(`${path}=${value}`);
  };
  walk(payload, "claims");
  return hits;
}

let userSeq = 0;
/** A fresh account per test so the per-user route budget never leaks across tests. */
function freshUser(): { sub: string; token: string } {
  userSeq += 1;
  const sub = `aaaaaaaa-0402-4000-8000-${String(userSeq).padStart(12, "0")}`;
  return { sub, token: fakeGoogleIdToken(sub) };
}

function reset(options: { signingKey?: boolean } = {}): void {
  h.reset();
  if (options.signingKey === false) Deno.env.delete(SIGNING_ENV);
  else Deno.env.set(SIGNING_ENV, JSON.stringify(privateJwk));
  h.rpcs.register_offline_device = [
    { result: "accepted", device_id: DEVICE_ID, attestation_state: "unattested" },
  ];
  h.rpcs.issue_offline_grant = [
    proRow({ leaseSeconds: 3 * DAY, entitlementExpiresAt: nowSeconds() + 30 * DAY }),
  ];
}

async function post(path: string, body: unknown, token = fakeGoogleIdToken()): Promise<Response> {
  return await h.handler(userRequest("POST", path, { token, body }));
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

function errorCode(body: Record<string, unknown>): string | undefined {
  const error = body.error;
  return error && typeof error === "object" ? (error as { code?: string }).code : undefined;
}

function context(ownerId: string, installationKeyId: string): OfflineGrantVerificationContext {
  return {
    binding: { issuer: ISSUER, allowedKeyIds: [KID], ownerId, installationKeyId },
    release: RELEASE,
    nowEpochSeconds: nowSeconds(),
  };
}

async function verifyGrant(
  raw: unknown,
  ownerId: string,
  installationKeyId = INSTALLATION_KEY,
): Promise<OfflineExecutionGrantClaims> {
  const { verifyOfflineExecutionGrant } = await import("../offlineSignature.ts");
  const envelope = await verifyOfflineExecutionGrant(
    raw,
    [verificationKey],
    context(ownerId, installationKeyId),
  );
  return envelope.claims;
}

function callerBearer(sub: string): string {
  return `Bearer session-for-${sub}`;
}

// ---------------------------------------------------------------------------
// Device registration
// ---------------------------------------------------------------------------

Deno.test(
  "POST /v1/devices/register registers the caller's installation through register_offline_device() as the caller",
  async () => {
    reset();
    const user = freshUser();
    const response = await post(
      REGISTER_PATH,
      { installationKeyId: INSTALLATION_KEY, attestationEnvironment: "production" },
      user.token,
    );
    assertEquals(response.status, 200);
    const body = await readJson(response);
    assertEquals(body, {
      device: {
        deviceId: DEVICE_ID,
        installationKeyId: INSTALLATION_KEY,
        attestationEnvironment: "production",
        attestationState: "unattested",
      },
    });
    const calls = h.callsTo(REGISTER_RPC);
    assertEquals(calls.length, 1);
    assertEquals(calls[0].headers.authorization, callerBearer(user.sub));
    assertEquals(calls[0].body, {
      p_installation_key_id: INSTALLATION_KEY,
      p_attestation_environment: "production",
      p_attested: false,
    });
  },
);

Deno.test(
  "POST /v1/devices/register never records an attested device from an unverified registration",
  async () => {
    reset();
    const user = freshUser();
    const response = await post(
      REGISTER_PATH,
      {
        installationKeyId: INSTALLATION_KEY,
        attestationEnvironment: "development",
        attested: true,
        attestationState: "attested",
      },
      user.token,
    );
    assertEquals(response.status, 200);
    await response.text();
    const calls = h.callsTo(REGISTER_RPC);
    assertEquals(calls.length, 1);
    assertEquals((calls[0].body as { p_attested: unknown }).p_attested, false);
  },
);

Deno.test(
  "POST /v1/devices/register refuses malformed input before any RPC (400 offline.invalid_input)",
  async () => {
    reset();
    const user = freshUser();
    for (const body of [
      {},
      { installationKeyId: "", attestationEnvironment: "production" },
      { installationKeyId: "bad key with spaces", attestationEnvironment: "production" },
      { installationKeyId: "x".repeat(129), attestationEnvironment: "production" },
      { installationKeyId: INSTALLATION_KEY, attestationEnvironment: "staging" },
      { installationKeyId: INSTALLATION_KEY },
      { installationKeyId: 42, attestationEnvironment: "production" },
    ]) {
      const response = await post(REGISTER_PATH, body, user.token);
      assertEquals(response.status, 400, JSON.stringify(body));
      assertEquals(errorCode(await readJson(response)), "offline.invalid_input");
    }
    assertEquals(h.callsTo(REGISTER_RPC).length, 0);
  },
);

Deno.test("POST /v1/devices/register maps the RPC refusals to coded errors", async () => {
  reset();
  const user = freshUser();
  h.rpcs.register_offline_device = [
    {
      result: "offline.device_environment_mismatch",
      device_id: DEVICE_ID,
      attestation_state: "attested",
    },
  ];
  const mismatch = await post(
    REGISTER_PATH,
    { installationKeyId: INSTALLATION_KEY, attestationEnvironment: "production" },
    user.token,
  );
  assertEquals(mismatch.status, 409);
  assertEquals(errorCode(await readJson(mismatch)), "offline.device_environment_mismatch");

  h.rpcs.register_offline_device = [
    { result: "offline.invalid_input", device_id: null, attestation_state: null },
  ];
  const invalid = await post(
    REGISTER_PATH,
    { installationKeyId: INSTALLATION_KEY, attestationEnvironment: "production" },
    user.token,
  );
  assertEquals(invalid.status, 400);
  assertEquals(errorCode(await readJson(invalid)), "offline.invalid_input");

  h.rpcs.register_offline_device = [
    { result: "something_new", device_id: null, attestation_state: null },
  ];
  const unexpected = await post(
    REGISTER_PATH,
    { installationKeyId: INSTALLATION_KEY, attestationEnvironment: "production" },
    user.token,
  );
  assertEquals(unexpected.status, 503);
  const body = await readJson(unexpected);
  assertEquals(errorCode(body), undefined);
  assertEquals(Object.keys(body), ["error"]);
});

Deno.test(
  "POST /v1/devices/register answers a generic 503 when the RPC fails (no detail in the body)",
  async () => {
    reset();
    const user = freshUser();
    h.rpcErrors.register_offline_device = 500;
    const response = await post(
      REGISTER_PATH,
      { installationKeyId: INSTALLATION_KEY, attestationEnvironment: "production" },
      user.token,
    );
    assertEquals(response.status, 503);
    const text = await response.text();
    assert(!text.includes("register_offline_device"));
    assert(!text.includes(user.sub));
  },
);

// ---------------------------------------------------------------------------
// Grant issuance — allowed paths
// ---------------------------------------------------------------------------

Deno.test(
  "POST /v1/offline/grants issues a Pro lease signed for the caller, the installation and the verified release",
  async () => {
    reset();
    const user = freshUser();
    const issuedAt = nowSeconds() - 2;
    const entitlementExpiresAt = issuedAt + 30 * DAY;
    h.rpcs.issue_offline_grant = [
      proRow({ issuedAt, leaseSeconds: 7 * DAY, entitlementExpiresAt }),
    ];

    const { result: response, logs } = await captureConsole(() =>
      post(GRANTS_PATH, { installationKeyId: INSTALLATION_KEY }, user.token),
    );
    assertEquals(response.status, 200);
    const body = await readJson(response);
    assertEquals(body.grantId, GRANT_ID);
    assertEquals(body.generation, 1);
    assertEquals(body.entitlementSource, "verified_store");
    assertEquals(body.issuedAt, issuedAt);
    assertEquals(body.expiresAt, issuedAt + 7 * DAY);
    assertEquals(body.keyId, KID);

    const claims = await verifyGrant(body.grant, user.sub);
    assertEquals(claims.iss, ISSUER);
    assertEquals(claims.aud, OFFLINE_GRANT_AUDIENCE);
    assertEquals(claims.sub, user.sub);
    assertEquals(claims.jti, GRANT_ID);
    assertEquals(claims.installationKeyId, INSTALLATION_KEY);
    assertEquals(claims.iat, issuedAt);
    assertEquals(claims.exp, issuedAt + 7 * DAY);
    assertEquals(claims.capabilities, ["analyze_joint_output"]);
    assertEquals(claims.release, RELEASE);
    assertEquals(claims.entitlementSource, "verified_store");
    assertEquals(claims.lease, {
      schemaVersion: "offline-pro-lease-v1",
      kind: "subscription",
      verifiedEntitlementExpiresAt: entitlementExpiresAt,
    });
    assert(claims.exp - claims.iat <= OFFLINE_PRO_LEASE_MAX_SECONDS);
    assert(claims.exp <= entitlementExpiresAt);

    const calls = h.callsTo(GRANT_RPC);
    assertEquals(calls.length, 1);
    assertEquals(calls[0].headers.authorization, callerBearer(user.sub));
    assertEquals(calls[0].body, {
      p_installation_key_id: INSTALLATION_KEY,
      p_requested_tickets: 2,
    });

    // The audit line is categorical: grant id, generation, source and key id —
    // never the owner, the installation key or the signed grant.
    const audit = logs.filter((entry) =>
      entry.args.some(
        (arg) =>
          typeof arg === "object" &&
          arg !== null &&
          (arg as { evt?: unknown }).evt === "offline_grant_audit",
      ),
    );
    assertEquals(audit.length, 1);
    const line = Deno.inspect(audit[0].args, { depth: Infinity });
    assertStringIncludes(line, GRANT_ID);
    assertStringIncludes(line, KID);
    assertStringIncludes(line, "issued");
    assert(!line.includes(user.sub));
    assert(!line.includes(INSTALLATION_KEY));
    assert(!line.includes((body.grant as { compactJws: string }).compactJws));
  },
);

Deno.test(
  "POST /v1/offline/grants issues a lifetime Pro lease and a free-ticket allocation",
  async () => {
    reset();
    const user = freshUser();
    const issuedAt = nowSeconds() - 2;
    h.rpcs.issue_offline_grant = [
      proRow({ issuedAt, leaseSeconds: 7 * DAY, entitlementExpiresAt: null }),
    ];
    const lifetime = await post(GRANTS_PATH, { installationKeyId: INSTALLATION_KEY }, user.token);
    assertEquals(lifetime.status, 200);
    const lifetimeClaims = await verifyGrant((await readJson(lifetime)).grant, user.sub);
    assertEquals(lifetimeClaims.lease, {
      schemaVersion: "offline-pro-lease-v1",
      kind: "lifetime",
      verifiedEntitlementExpiresAt: null,
    });

    h.rpcs.issue_offline_grant = [freeRow({ issuedAt })];
    const free = await post(
      GRANTS_PATH,
      { installationKeyId: INSTALLATION_KEY, requestedTickets: 1 },
      user.token,
    );
    assertEquals(free.status, 200);
    const freeBody = await readJson(free);
    assertEquals(freeBody.entitlementSource, "identity_lifetime_free");
    assertEquals(freeBody.ticketIds, [TICKET_A, TICKET_B]);
    const freeClaims = await verifyGrant(freeBody.grant, user.sub);
    assertEquals(freeClaims.entitlementSource, "identity_lifetime_free");
    assertEquals(freeClaims.allocation, {
      schemaVersion: "offline-free-allocation-v1",
      allocationId: GRANT_ID,
      generation: 3,
      ticketIds: [TICKET_A, TICKET_B],
      budgetPolicy: "identity-lifetime-including-legacy-used-v1",
      financialExpiry: "reconciliation_only",
    });
    const calls = h.callsTo(GRANT_RPC);
    assertEquals(calls.length, 2);
    assertEquals(calls[1].body, {
      p_installation_key_id: INSTALLATION_KEY,
      p_requested_tickets: 1,
    });
  },
);

Deno.test(
  "a grant is bound to its owner: the same envelope does not verify for another owner or installation",
  async () => {
    reset();
    const user = freshUser();
    const response = await post(GRANTS_PATH, { installationKeyId: INSTALLATION_KEY }, user.token);
    assertEquals(response.status, 200);
    const grant = (await readJson(response)).grant;
    await verifyGrant(grant, user.sub);
    for (const [owner, installation] of [
      [TEST_USER_ID, INSTALLATION_KEY],
      [user.sub, "another-installation"],
    ] as const) {
      let rejected = false;
      try {
        await verifyGrant(grant, owner, installation);
      } catch {
        rejected = true;
      }
      assert(rejected, `${owner}/${installation} must not verify`);
    }
  },
);

// W04-06: the shipping app registers with p_attested=false and is issued a
// grant as that unattested installation. The route echoes the state the SQL
// recorded and signs NO attestation claim — the server verified none.
Deno.test(
  "POST /v1/devices/register then POST /v1/offline/grants issues a fresh unattested installation a grant recorded as unattested, with no attestation claim signed",
  async () => {
    reset();
    const user = freshUser();
    const issuedAt = nowSeconds() - 2;
    const registered = await post(
      REGISTER_PATH,
      { installationKeyId: INSTALLATION_KEY, attestationEnvironment: "production" },
      user.token,
    );
    assertEquals(registered.status, 200);
    assertEquals(
      ((await readJson(registered)).device as { attestationState: string }).attestationState,
      "unattested",
    );

    h.rpcs.issue_offline_grant = [freeRow({ issuedAt, attestationState: "unattested" })];
    const response = await post(
      GRANTS_PATH,
      { installationKeyId: INSTALLATION_KEY, requestedTickets: 2 },
      user.token,
    );
    assertEquals(response.status, 200);
    const body = await readJson(response);
    assertEquals(body.attestationState, "unattested");
    assertEquals(body.ticketIds, [TICKET_A, TICKET_B]);
    assertEquals(body.expiresAt, issuedAt + 7 * DAY);
    const claims = await verifyGrant(body.grant, user.sub);
    assertEquals(claims.sub, user.sub);
    assertEquals(claims.installationKeyId, INSTALLATION_KEY);
    assertEquals(claims.entitlementSource, "identity_lifetime_free");
    assertEquals(claimsAttestation(signedPayload(body.grant)), []);
    assertEquals(
      Object.keys(claims).filter((key) => /attest/i.test(key)),
      [],
    );

    // An attested installation's row is echoed as attested — and still not signed.
    h.rpcs.issue_offline_grant = [
      proRow({
        issuedAt,
        leaseSeconds: 3 * DAY,
        entitlementExpiresAt: issuedAt + 30 * DAY,
        attestationState: "attested",
      }),
    ];
    const attested = await post(GRANTS_PATH, { installationKeyId: INSTALLATION_KEY }, user.token);
    assertEquals(attested.status, 200);
    const attestedBody = await readJson(attested);
    assertEquals(attestedBody.attestationState, "attested");
    await verifyGrant(attestedBody.grant, user.sub);
    assertEquals(claimsAttestation(signedPayload(attestedBody.grant)), []);

    const calls = h.callsTo(GRANT_RPC);
    assertEquals(calls.length, 2);
    for (const call of calls) {
      assertEquals(call.headers.authorization, callerBearer(user.sub));
      assertEquals(Object.keys(call.body as Record<string, unknown>).sort(), [
        "p_installation_key_id",
        "p_requested_tickets",
      ]);
    }
  },
);

Deno.test(
  "POST /v1/offline/grants refuses an accepted row that does not record a known attestation state",
  async () => {
    reset();
    const issuedAt = nowSeconds() - 2;
    const base = proRow({ issuedAt, leaseSeconds: DAY, entitlementExpiresAt: issuedAt + 30 * DAY });
    const { attestation_state: _omitted, ...withoutState } = base;
    for (const row of [
      { ...base, attestation_state: null },
      { ...base, attestation_state: "verified" },
      { ...base, attestation_state: "ATTESTED" },
      { ...base, attestation_state: true },
      withoutState,
      { ...freeRow({ issuedAt }), attestation_state: "" },
    ]) {
      h.rpcs.issue_offline_grant = [row];
      const { result: response, logs } = await captureConsole(() =>
        post(GRANTS_PATH, { installationKeyId: INSTALLATION_KEY }, freshUser().token),
      );
      assertEquals(response.status, 503, JSON.stringify(row));
      const text = await response.text();
      assert(!text.includes("compactJws"));
      assert(!text.includes(GRANT_ID));
      assertStringIncludes(Deno.inspect(logs, { depth: Infinity }), "row_malformed");
    }
  },
);

// ---------------------------------------------------------------------------
// Grant issuance — denied paths
// ---------------------------------------------------------------------------

Deno.test(
  "POST /v1/offline/grants refuses to sign an accepted row whose expiry exceeds 7 days",
  async () => {
    reset();
    const user = freshUser();
    const issuedAt = nowSeconds() - 2;
    h.rpcs.issue_offline_grant = [
      proRow({ issuedAt, leaseSeconds: 7 * DAY + 1, entitlementExpiresAt: issuedAt + 30 * DAY }),
    ];
    const { result: response, logs } = await captureConsole(() =>
      post(GRANTS_PATH, { installationKeyId: INSTALLATION_KEY }, user.token),
    );
    assertEquals(response.status, 503);
    const text = await response.text();
    assert(!text.includes("compactJws"));
    assert(!text.includes(GRANT_ID));
    const line = Deno.inspect(logs, { depth: Infinity });
    assertStringIncludes(line, "offline_grant_audit");
    assertStringIncludes(line, "expiry_exceeds_maximum");

    h.rpcs.issue_offline_grant = [freeRow({ issuedAt, leaseSeconds: 8 * DAY })];
    const free = await post(GRANTS_PATH, { installationKeyId: INSTALLATION_KEY }, user.token);
    assertEquals(free.status, 503);
    assert(!(await free.text()).includes("compactJws"));
  },
);

Deno.test(
  "POST /v1/offline/grants refuses a Pro lease past the verified entitlement expiry, or for an expired entitlement",
  async () => {
    reset();
    const user = freshUser();
    const issuedAt = nowSeconds() - 2;
    h.rpcs.issue_offline_grant = [
      proRow({ issuedAt, leaseSeconds: 3 * DAY, entitlementExpiresAt: issuedAt + 3 * DAY - 1 }),
    ];
    const past = await post(GRANTS_PATH, { installationKeyId: INSTALLATION_KEY }, user.token);
    assertEquals(past.status, 503);
    assert(!(await past.text()).includes("compactJws"));

    h.rpcs.issue_offline_grant = [
      proRow({ issuedAt, leaseSeconds: 3 * DAY, entitlementExpiresAt: issuedAt }),
    ];
    const { result: expired, logs } = await captureConsole(() =>
      post(GRANTS_PATH, { installationKeyId: INSTALLATION_KEY }, user.token),
    );
    assertEquals(expired.status, 503);
    assert(!(await expired.text()).includes("compactJws"));
    assertStringIncludes(Deno.inspect(logs, { depth: Infinity }), "offline_grant_audit");
  },
);

Deno.test("POST /v1/offline/grants refuses malformed accepted rows without signing", async () => {
  reset();
  const issuedAt = nowSeconds() - 2;
  const base = proRow({ issuedAt, leaseSeconds: DAY, entitlementExpiresAt: issuedAt + 30 * DAY });
  for (const row of [
    { ...base, grant_id: "not-a-uuid" },
    { ...base, generation: 0 },
    { ...base, generation: 1.5 },
    { ...base, entitlement_source: "verified_store", ticket_ids: [TICKET_A] },
    { ...base, expires_at: base.issued_at },
    { ...base, issued_at: "yesterday" },
    { ...base, entitlement_source: "something_else" },
    { ...freeRow({ issuedAt }), ticket_ids: [] },
    { ...freeRow({ issuedAt }), ticket_ids: [TICKET_A, TICKET_A] },
    { ...freeRow({ issuedAt }), ticket_ids: [TICKET_A, TICKET_B, GRANT_ID] },
    { ...freeRow({ issuedAt }), entitlement_expires_at: iso(issuedAt + DAY) },
  ]) {
    // A fresh account per row: the refusal, not the route budget, must answer.
    h.rpcs.issue_offline_grant = [row];
    const response = await post(
      GRANTS_PATH,
      { installationKeyId: INSTALLATION_KEY },
      freshUser().token,
    );
    assertEquals(response.status, 503, JSON.stringify(row));
    assert(!(await response.text()).includes("compactJws"));
  }
  h.rpcs.issue_offline_grant = [];
  const empty = await post(GRANTS_PATH, { installationKeyId: INSTALLATION_KEY }, freshUser().token);
  assertEquals(empty.status, 503);
  await empty.text();
});

Deno.test(
  "POST /v1/offline/grants maps the RPC refusals to coded errors and signs nothing",
  async () => {
    reset();
    const user = freshUser();
    for (const [result, status] of [
      ["offline.device_not_registered", 409],
      ["offline.device_revoked", 403],
      ["access.paywall_required", 402],
      ["offline.invalid_input", 400],
    ] as const) {
      h.rpcs.issue_offline_grant = [refusedRow(result)];
      const response = await post(GRANTS_PATH, { installationKeyId: INSTALLATION_KEY }, user.token);
      assertEquals(response.status, status, result);
      const body = await readJson(response);
      assertEquals(errorCode(body), result);
      assertEquals(body.grant, undefined);
    }
    // The SQL no longer refuses an unattested installation; the route does not
    // advertise such a requirement either.
    h.rpcs.issue_offline_grant = [refusedRow("offline.device_not_attested")];
    const stale = await post(GRANTS_PATH, { installationKeyId: INSTALLATION_KEY }, user.token);
    assertEquals(stale.status, 503);
    assert(!(await stale.text()).includes("device_not_attested"));
  },
);

Deno.test(
  "POST /v1/offline/grants validates its input before spending a grant generation",
  async () => {
    reset();
    const user = freshUser();
    for (const body of [
      {},
      { installationKeyId: "has spaces" },
      { installationKeyId: INSTALLATION_KEY, requestedTickets: 3 },
      { installationKeyId: INSTALLATION_KEY, requestedTickets: -1 },
      { installationKeyId: INSTALLATION_KEY, requestedTickets: 1.5 },
      { installationKeyId: INSTALLATION_KEY, requestedTickets: "2" },
    ]) {
      const response = await post(GRANTS_PATH, body, user.token);
      assertEquals(response.status, 400, JSON.stringify(body));
      assertEquals(errorCode(await readJson(response)), "offline.invalid_input");
    }
    assertEquals(h.callsTo(GRANT_RPC).length, 0);
  },
);

Deno.test(
  "POST /v1/offline/grants answers 503 and spends no grant when the signing key is not configured or unusable",
  async () => {
    reset({ signingKey: false });
    const user = freshUser();
    const missing = await post(GRANTS_PATH, { installationKeyId: INSTALLATION_KEY }, user.token);
    assertEquals(missing.status, 503);
    const text = await missing.text();
    assert(!text.includes("OFFLINE_GRANT_SIGNING_JWK"));
    assertEquals(h.callsTo(GRANT_RPC).length, 0);

    // A PUBLIC key (no `d`) is not a signing key; a key without a kid cannot be allowlisted.
    for (const bad of [
      { ...publicJwk, kid: KID },
      { ...privateJwk, kid: undefined },
      { ...privateJwk, crv: "P-384" },
      "not json",
    ]) {
      Deno.env.set(SIGNING_ENV, typeof bad === "string" ? bad : JSON.stringify(bad));
      const response = await post(GRANTS_PATH, { installationKeyId: INSTALLATION_KEY }, user.token);
      assertEquals(response.status, 503, JSON.stringify(bad));
      await response.text();
    }
    assertEquals(h.callsTo(GRANT_RPC).length, 0);
    Deno.env.set(SIGNING_ENV, JSON.stringify(privateJwk));
  },
);

Deno.test(
  "POST /v1/offline/grants requires an active, non-withdrawn release authority before spending a grant",
  async () => {
    reset();
    const user = freshUser();
    const withdrawn = {
      ...releasePolicyRow,
      approval: {
        ...(releasePolicyRow.approval as Record<string, unknown>),
        withdrawnAt: nowSeconds() - 60,
      },
    };
    h.rpcs.read_analysis_release_policy = withdrawn;
    const refused = await post(GRANTS_PATH, { installationKeyId: INSTALLATION_KEY }, user.token);
    assertEquals(refused.status, 409);
    assertEquals(errorCode(await readJson(refused)), "access.release_not_authorized");

    // No policy installed at all (the migration's empty row): a typed, final
    // 409 — never a fabricated authorization.
    h.rpcs.read_analysis_release_policy = {
      document: null,
      canonicalDocument: null,
      denyNewAuthorizations: true,
      approval: null,
    };
    const missing = await post(GRANTS_PATH, { installationKeyId: INSTALLATION_KEY }, user.token);
    assertEquals(missing.status, 409);
    assertEquals(errorCode(await readJson(missing)), "access.release_not_authorized");

    // A corrupt authority (digest mismatch) is unverified, never authorization.
    h.rpcs.read_analysis_release_policy = {
      ...releasePolicyRow,
      canonicalDocument: `${releasePolicyRow.canonicalDocument as string} `,
    };
    const corrupt = await post(GRANTS_PATH, { installationKeyId: INSTALLATION_KEY }, user.token);
    assertEquals(corrupt.status, 409);
    await corrupt.text();

    // The authority cannot be read: retryable 503, still nothing spent.
    h.rpcErrors.read_analysis_release_policy = 500;
    const unavailable = await post(
      GRANTS_PATH,
      { installationKeyId: INSTALLATION_KEY },
      user.token,
    );
    assertEquals(unavailable.status, 503);
    await unavailable.text();

    assertEquals(h.callsTo(GRANT_RPC).length, 0);
    assertEquals(h.callsTo(POLICY_RPC).length, 4);
  },
);

Deno.test(
  "POST /v1/offline/grants refuses a caller whose session is no longer live (401) before any RPC",
  async () => {
    reset();
    const user = freshUser();
    h.rpcs.is_api_session_active = false;
    const response = await post(GRANTS_PATH, { installationKeyId: INSTALLATION_KEY }, user.token);
    assertEquals(response.status, 401);
    await response.text();
    assertEquals(h.callsTo(GRANT_RPC).length, 0);
  },
);

Deno.test("POST /v1/offline/grants refuses an unauthenticated request", async () => {
  reset();
  const response = await h.handler(
    new Request(`http://edge.test/functions/v1/api${GRANTS_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ installationKeyId: INSTALLATION_KEY }),
    }),
  );
  assertEquals(response.status, 401);
  await response.text();
  assertEquals(h.callsTo(GRANT_RPC).length, 0);
});

// ---------------------------------------------------------------------------
// Per-user route budgets and access logging
// ---------------------------------------------------------------------------

Deno.test(
  "both routes carry their own per-user budget (429 + Retry-After below the general 240/min)",
  async () => {
    reset();
    const user = freshUser();
    let grantsAllowed = 0;
    let limited: Response | null = null;
    for (let i = 0; i < 40 && !limited; i += 1) {
      const response = await post(GRANTS_PATH, { installationKeyId: INSTALLATION_KEY }, user.token);
      if (response.status === 429) limited = response;
      else {
        assertEquals(response.status, 200);
        grantsAllowed += 1;
      }
      await response.text();
    }
    assert(limited, "the grants route must be budgeted well below the general user budget");
    assert(grantsAllowed >= 1 && grantsAllowed <= 20, String(grantsAllowed));
    assertMatch(limited.headers.get("Retry-After") ?? "", /^\d+$/);

    // Registration has its own scope: the exhausted grants budget does not block it.
    const register = await post(
      REGISTER_PATH,
      { installationKeyId: INSTALLATION_KEY, attestationEnvironment: "production" },
      user.token,
    );
    assertEquals(register.status, 200);
    await register.text();
    let registerLimited = false;
    for (let i = 0; i < 40 && !registerLimited; i += 1) {
      const response = await post(
        REGISTER_PATH,
        { installationKeyId: INSTALLATION_KEY, attestationEnvironment: "production" },
        user.token,
      );
      registerLimited = response.status === 429;
      await response.text();
    }
    assert(
      registerLimited,
      "the register route must be budgeted well below the general user budget",
    );

    // Another account is unaffected.
    const other = freshUser();
    const fresh = await post(GRANTS_PATH, { installationKeyId: INSTALLATION_KEY }, other.token);
    assertEquals(fresh.status, 200);
    await fresh.text();
  },
);

Deno.test(
  "access logs name the route and status but never the owner, the installation key or the grant",
  async () => {
    reset();
    const user = freshUser();
    const { result: response, accessLogs } = await captureConsole(() =>
      post(GRANTS_PATH, { installationKeyId: INSTALLATION_KEY }, user.token),
    );
    assertEquals(response.status, 200);
    const body = await readJson(response);
    assertEquals(accessLogs.length, 1);
    const entry = JSON.parse(accessLogs[0]) as { route: string; status: number; method: string };
    assertEquals(entry.method, "POST");
    assertEquals(entry.status, 200);
    assertStringIncludes(entry.route, "/v1/offline/grants");
    assert(!accessLogs[0].includes(user.sub));
    assert(!accessLogs[0].includes(INSTALLATION_KEY));
    assert(!accessLogs[0].includes((body.grant as { compactJws: string }).compactJws));
  },
);

// ---------------------------------------------------------------------------
// Live postgres half — the REAL issue_offline_grant() rows through the edge
// claim builder (module loaded dynamically so this file loads on BASE_SHA).
// ---------------------------------------------------------------------------

const PG_URL = Deno.env.get("XC_PG_URL") ?? Deno.env.get("PICKLE_AUDIT_PG_URL") ?? "";
const ignore = PG_URL === "";

type Sql = ReturnType<typeof postgres>;
type Tx = Parameters<Parameters<Sql["begin"]>[1]>[0];

const RUN = crypto.randomUUID().slice(0, 8);
const U = (n: number): string => `0000000b-0402-4000-8000-${RUN}00${String(n).padStart(2, "0")}`;
const SESSION = (n: number): string =>
  `0000000b-0402-4000-8000-${RUN}0a${String(n).padStart(2, "0")}`;
const KEY = (name: string): string => `${name}-${RUN}`;

async function createUser(sql: Sql, n: number): Promise<void> {
  await sql.unsafe(`delete from auth.users where id = '${U(n)}'`);
  await sql.unsafe(
    `insert into auth.users (id, email, raw_app_meta_data)
     values ('${U(n)}', 'w04-02-${n}-${RUN}@example.com', '{"provider":"google"}')`,
  );
  await sql.unsafe(
    `insert into auth.identities (provider, provider_id, user_id, identity_data)
     values ('google', 'w04-02-${n}-${RUN}', '${U(n)}', '{"sub":"w04-02-${n}-${RUN}"}')`,
  );
  await sql.unsafe(`insert into auth.sessions (id, user_id) values ('${SESSION(n)}', '${U(n)}')`);
}

async function asUser(tx: Tx, n: number): Promise<void> {
  await tx.unsafe(`select set_config('request.headers', jsonb_build_object(
    'x-pickle-api-key', public.get_api_request_key())::text, true)`);
  await tx.unsafe(`set local role authenticated`);
  await tx.unsafe(`set local request.jwt.claim.sub = '${U(n)}'`);
  await tx.unsafe(`set local request.jwt.claims = '{"session_id":"${SESSION(n)}"}'`);
}

function inTx<T>(sql: Sql, n: number | null, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return sql.begin(async (tx) => {
    if (n !== null) await asUser(tx as unknown as Tx, n);
    return await fn(tx as unknown as Tx);
  }) as Promise<T>;
}

/** The RPC row exactly as PostgREST would serialize it (to_jsonb). */
async function issueRow(tx: Tx, key: string, requested = 2): Promise<unknown> {
  const rows = await tx.unsafe<{ row: unknown }[]>(
    `select to_jsonb(g) as row from public.issue_offline_grant('${key}', ${requested}) g`,
  );
  return rows[0].row;
}

type ClaimBuilder = (
  row: unknown,
  binding: {
    issuer: string;
    ownerId: string;
    installationKeyId: string;
    release: OfflineReleasedArtifacts;
  },
) => OfflineExecutionGrantClaims;

async function loadClaimBuilder(): Promise<ClaimBuilder> {
  const module: Record<string, unknown> = await import("../offlineSignature.ts");
  const builder = module.offlineGrantClaimsFromIssuance;
  assert(
    typeof builder === "function",
    "offlineSignature.ts must export offlineGrantClaimsFromIssuance",
  );
  return builder as ClaimBuilder;
}

async function signAndVerify(
  claims: OfflineExecutionGrantClaims,
  ownerId: string,
  installationKeyId: string,
): Promise<OfflineExecutionGrantClaims> {
  const { signOfflineExecutionGrant } = await import("../offlineSignature.ts");
  const signed = await signOfflineExecutionGrant(
    claims,
    { purpose: "offline_execution_grant", kid: KID, key: keyPair.privateKey },
    context(ownerId, installationKeyId),
  );
  return await verifyGrant(signed, ownerId, installationKeyId);
}

Deno.test({
  name: "live DB: a Pro lease from issue_offline_grant() is capped at min(issued + 7d, entitlement expiry) and signs into a verifiable grant",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 2 });
    try {
      const build = await loadClaimBuilder();
      // Account 1: subscription that ends in 3 days → lease ends at the entitlement.
      await createUser(sql, 1);
      await sql.unsafe(
        `insert into public.billing_entitlements (user_id, premium, product_key, expires_at)
         values ('${U(1)}', true, 'pickle_sensei_pro_monthly', now() + interval '3 days')`,
      );
      const key1 = KEY("pro-short");
      await inTx(sql, 1, async (tx) => {
        const rows = await tx.unsafe<{ result: string }[]>(
          `select r.result from public.register_offline_device('${key1}', 'production', true) r`,
        );
        assertEquals(rows[0].result, "accepted");
      });
      const row1 = await inTx(sql, 1, (tx) => issueRow(tx, key1));
      const claims1 = build(row1, {
        issuer: ISSUER,
        ownerId: U(1),
        installationKeyId: key1,
        release: RELEASE,
      });
      assertEquals(claims1.entitlementSource, "verified_store");
      assert(claims1.lease?.kind === "subscription");
      assertEquals(claims1.exp, claims1.lease.verifiedEntitlementExpiresAt);
      assert(claims1.exp - claims1.iat <= 3 * DAY);
      const verified1 = await signAndVerify(claims1, U(1), key1);
      assertEquals(verified1.sub, U(1));
      assertMatch(verified1.jti, UUID_RE);

      // Account 2: subscription that ends in 30 days → lease ends at issued + 7d.
      await createUser(sql, 2);
      await sql.unsafe(
        `insert into public.billing_entitlements (user_id, premium, product_key, expires_at)
         values ('${U(2)}', true, 'pickle_sensei_pro_annual', now() + interval '30 days')`,
      );
      const key2 = KEY("pro-long");
      await inTx(sql, 2, async (tx) => {
        await tx.unsafe(
          `select r.result from public.register_offline_device('${key2}', 'production', true) r`,
        );
      });
      const row2 = await inTx(sql, 2, (tx) => issueRow(tx, key2));
      const claims2 = build(row2, {
        issuer: ISSUER,
        ownerId: U(2),
        installationKeyId: key2,
        release: RELEASE,
      });
      assertEquals(claims2.exp - claims2.iat, OFFLINE_PRO_LEASE_MAX_SECONDS);
      assert(claims2.lease?.kind === "subscription");
      assert(claims2.exp < claims2.lease.verifiedEntitlementExpiresAt);
      await signAndVerify(claims2, U(2), key2);

      // The same row never signs for another owner.
      let rejected = false;
      try {
        build(row2, { issuer: ISSUER, ownerId: U(1), installationKeyId: key2, release: RELEASE });
        await signAndVerify(claims2, U(1), key2);
      } catch {
        rejected = true;
      }
      assert(rejected);
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name: "live DB: a free allocation from issue_offline_grant() carries the allowance's ticket(s) and signs into a verifiable grant",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 2 });
    try {
      const build = await loadClaimBuilder();
      await createUser(sql, 3);
      const key = KEY("free");
      await inTx(sql, 3, async (tx) => {
        await tx.unsafe(
          `select r.result from public.register_offline_device('${key}', 'production', true) r`,
        );
      });
      const row = await inTx(sql, 3, (tx) => issueRow(tx, key));
      const claims = build(row, {
        issuer: ISSUER,
        ownerId: U(3),
        installationKeyId: key,
        release: RELEASE,
      });
      assertEquals(claims.entitlementSource, "identity_lifetime_free");
      assertEquals(claims.allocation?.ticketIds.length, FREE_RATING_LIMIT);
      assertEquals(claims.allocation?.allocationId, claims.jti);
      assertEquals(claims.exp - claims.iat, OFFLINE_PRO_LEASE_MAX_SECONDS);
      const verified = await signAndVerify(claims, U(3), key);
      assertEquals(verified.allocation?.ticketIds, claims.allocation?.ticketIds);
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name: "live DB: the grants table itself refuses an expiry past 7 days or past the entitlement expiry",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 1 });
    try {
      // Owner-role inserts (bypassing the RPC) against the attested devices the
      // previous live tests registered: the table constraints are the last line.
      const devices = await sql.unsafe<{ id: string; user_id: string; pro: boolean }[]>(
        `select d.id, d.user_id, exists (
           select 1 from public.billing_entitlements b where b.user_id = d.user_id and b.premium
         ) as pro
         from public.offline_devices d
         where d.user_id in ('${U(1)}', '${U(3)}') and d.attestation_state = 'attested'`,
      );
      const free = devices.find((d) => !d.pro);
      const pro = devices.find((d) => d.pro);
      assert(free && pro, "the previous live tests must have registered a free and a Pro device");
      for (const insert of [
        `insert into public.offline_grants (user_id, device_id, entitlement_source, generation, expires_at)
         values ('${free.user_id}', '${free.id}', 'identity_lifetime_free', 99, now() + interval '7 days 1 second')`,
        `insert into public.offline_grants (user_id, device_id, entitlement_source, generation, expires_at, entitlement_expires_at)
         select '${pro.user_id}', '${pro.id}', 'verified_store', 99, now() + interval '4 days', b.expires_at
         from public.billing_entitlements b where b.user_id = '${pro.user_id}'`,
      ]) {
        let code = "";
        try {
          await sql.unsafe(insert);
        } catch (error) {
          code = (error as { code?: string }).code ?? "";
        }
        assertEquals(code, "23514", `${insert} → ${code || "accepted"}`);
      }
      const rows = await sql.unsafe<{ n: string }[]>(
        `select count(*)::text as n from public.offline_grants where generation = 99`,
      );
      assertEquals(rows[0].n, "0");
    } finally {
      await sql.end();
    }
  },
});

// ---------------------------------------------------------------------------
// W04-06 live half — the installation exactly as POST /v1/devices/register
// records it (p_attested = false → 'unattested') is issued a bounded grant
// whose row records 'unattested'; a revoked installation is refused and a
// deleted one is not registered; nothing is reclaimed by either.
// ---------------------------------------------------------------------------

function pgCode(error: unknown): string {
  return (error as { code?: string }).code ?? "";
}

Deno.test({
  name: "live DB: register(p_attested=false) → issue_offline_grant() issues the unattested installation a bounded free grant recorded as unattested; the signed grant carries no attestation claim",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 2 });
    try {
      const build = await loadClaimBuilder();
      await createUser(sql, 4);
      const key = KEY("unattested-free");
      await inTx(sql, 4, async (tx) => {
        const rows = await tx.unsafe<{ result: string; attestation_state: string }[]>(
          `select r.result, r.attestation_state from public.register_offline_device('${key}', 'production', false) r`,
        );
        assertEquals(rows[0].result, "accepted");
        assertEquals(rows[0].attestation_state, "unattested");
      });
      const row = await inTx(sql, 4, (tx) => issueRow(tx, key));
      const record = row as Record<string, unknown>;
      assertEquals(record.result, "accepted", JSON.stringify(row));
      assertEquals(record.attestation_state, "unattested");
      const claims = build(row, {
        issuer: ISSUER,
        ownerId: U(4),
        installationKeyId: key,
        release: RELEASE,
      });
      assertEquals(claims.entitlementSource, "identity_lifetime_free");
      assertEquals(claims.allocation?.ticketIds.length, FREE_RATING_LIMIT);
      assertEquals(claims.exp - claims.iat, OFFLINE_PRO_LEASE_MAX_SECONDS);
      assertEquals(
        Object.keys(claims).filter((k) => /attest/i.test(k)),
        [],
      );
      const verified = await signAndVerify(claims, U(4), key);
      assertEquals(verified.sub, U(4));
      assertEquals(verified.installationKeyId, key);

      const stored = await sql.unsafe<
        { attestation_state: string; user_id: string; installation_key_id: string; lease: string }[]
      >(
        `select g.attestation_state, g.user_id, d.installation_key_id,
                (g.expires_at - g.issued_at)::text as lease
         from public.offline_grants g join public.offline_devices d on d.id = g.device_id
         where g.id = '${claims.jti}'`,
      );
      assertEquals(stored.length, 1);
      assertEquals(stored[0].attestation_state, "unattested");
      assertEquals(stored[0].user_id, U(4));
      assertEquals(stored[0].installation_key_id, key);
      assertEquals(stored[0].lease, "7 days");

      // Conservation: the allowance is held as tickets, no rating past it online or offline.
      const held = await inTx(sql, 4, async (tx) => {
        const holds = await tx.unsafe<{ n: number }[]>(`select public.offline_hold_count() as n`);
        const online = await tx.unsafe<{ result: string }[]>(
          `select r.result from public.reserve_analysis_permit('${KEY("online")}') r`,
        );
        return { n: holds[0].n, online: online[0].result };
      });
      assertEquals(Number(held.n), FREE_RATING_LIMIT);
      assertEquals(held.online, "access.paywall_required");
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name: "live DB: an unattested Pro installation's lease is capped at the verified entitlement expiry and recorded as unattested; an attested installation's grant records attested",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 2 });
    try {
      const build = await loadClaimBuilder();
      await createUser(sql, 5);
      await sql.unsafe(
        `insert into public.billing_entitlements (user_id, premium, product_key, expires_at)
         values ('${U(5)}', true, 'pickle_sensei_pro_monthly', now() + interval '3 days')`,
      );
      const key = KEY("unattested-pro");
      const attestedKey = KEY("attested-pro");
      await inTx(sql, 5, async (tx) => {
        await tx.unsafe(
          `select r.result from public.register_offline_device('${key}', 'production', false) r`,
        );
        await tx.unsafe(
          `select r.result from public.register_offline_device('${attestedKey}', 'production', true) r`,
        );
      });
      const row = await inTx(sql, 5, (tx) => issueRow(tx, key, 0));
      assertEquals((row as Record<string, unknown>).attestation_state, "unattested");
      const claims = build(row, {
        issuer: ISSUER,
        ownerId: U(5),
        installationKeyId: key,
        release: RELEASE,
      });
      assertEquals(claims.entitlementSource, "verified_store");
      assert(claims.lease?.kind === "subscription");
      assertEquals(claims.exp, claims.lease.verifiedEntitlementExpiresAt);
      assert(claims.exp - claims.iat <= 3 * DAY);
      await signAndVerify(claims, U(5), key);

      const attestedRow = await inTx(sql, 5, (tx) => issueRow(tx, attestedKey, 0));
      assertEquals((attestedRow as Record<string, unknown>).attestation_state, "attested");
      const attestedClaims = build(attestedRow, {
        issuer: ISSUER,
        ownerId: U(5),
        installationKeyId: attestedKey,
        release: RELEASE,
      });
      const states = await sql.unsafe<{ id: string; attestation_state: string }[]>(
        `select id, attestation_state from public.offline_grants
         where id in ('${claims.jti}', '${attestedClaims.jti}') order by attestation_state`,
      );
      assertEquals(
        states.map((s) => [s.id, s.attestation_state]),
        [
          [attestedClaims.jti, "attested"],
          [claims.jti, "unattested"],
        ],
      );
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name: "live DB: a revoked installation is refused (offline.device_revoked, RPC and table), re-registration never clears the revocation, a deleted installation is not registered, and neither reclaims a held ticket",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 2 });
    try {
      const key = KEY("unattested-free");
      const device = await sql.unsafe<{ id: string }[]>(
        `select id from public.offline_devices where user_id = '${U(4)}' and installation_key_id = '${key}'`,
      );
      assertEquals(device.length, 1, "the unattested free test must have registered its device");
      await sql.unsafe(
        `update public.offline_devices set revoked_at = now() where id = '${device[0].id}'`,
      );
      const before = await sql.unsafe<{ n: string }[]>(
        `select count(*)::text as n from public.offline_grants where device_id = '${device[0].id}'`,
      );

      const refused = await inTx(sql, 4, (tx) => issueRow(tx, key));
      assertEquals((refused as Record<string, unknown>).result, "offline.device_revoked");
      assertEquals((refused as Record<string, unknown>).grant_id, null);

      const reregistered = await inTx(sql, 4, async (tx) => {
        const rows = await tx.unsafe<{ result: string; device_id: string }[]>(
          `select r.result, r.device_id from public.register_offline_device('${key}', 'production', false) r`,
        );
        return rows[0];
      });
      assertEquals(reregistered.result, "accepted");
      assertEquals(reregistered.device_id, device[0].id);
      const still = await sql.unsafe<{ revoked: boolean }[]>(
        `select revoked_at is not null as revoked from public.offline_devices where id = '${device[0].id}'`,
      );
      assertEquals(still[0].revoked, true);
      const again = await inTx(sql, 4, (tx) => issueRow(tx, key));
      assertEquals((again as Record<string, unknown>).result, "offline.device_revoked");

      // The table refuses a grant for the revoked device even from the owner role.
      let code = "";
      try {
        await sql.unsafe(
          `insert into public.offline_grants (user_id, device_id, entitlement_source, generation, expires_at, attestation_state)
           values ('${U(4)}', '${device[0].id}', 'identity_lifetime_free', 98, now() + interval '1 day', 'unattested')`,
        );
      } catch (error) {
        code = pgCode(error);
      }
      assertEquals(code, "23514");
      // ...and a grant that claims 'attested' for an unattested device.
      const proDevice = await sql.unsafe<{ id: string; expires_at: string }[]>(
        `select d.id, b.expires_at::text as expires_at from public.offline_devices d
         join public.billing_entitlements b on b.user_id = d.user_id
         where d.user_id = '${U(5)}' and d.installation_key_id = '${KEY("unattested-pro")}'`,
      );
      assertEquals(proDevice.length, 1);
      code = "";
      try {
        await sql.unsafe(
          `insert into public.offline_grants (user_id, device_id, entitlement_source, generation, expires_at, entitlement_expires_at, attestation_state)
           values ('${U(5)}', '${proDevice[0].id}', 'verified_store', 98, now() + interval '1 day', '${proDevice[0].expires_at}', 'attested')`,
        );
      } catch (error) {
        code = pgCode(error);
      }
      assertEquals(code, "23514");
      const after = await sql.unsafe<{ n: string }[]>(
        `select count(*)::text as n from public.offline_grants where device_id = '${device[0].id}'`,
      );
      assertEquals(after[0].n, before[0].n);

      // Revocation reclaims nothing: every issued ticket is still held.
      const heldAfterRevoke = await inTx(sql, 4, async (tx) => {
        const rows = await tx.unsafe<{ n: number }[]>(`select public.offline_hold_count() as n`);
        return rows[0].n;
      });
      assertEquals(Number(heldAfterRevoke), FREE_RATING_LIMIT);

      // Deletion (reinstall / key replacement): not registered, hold stays.
      await sql.unsafe(`delete from public.offline_devices where id = '${device[0].id}'`);
      const deleted = await inTx(sql, 4, (tx) => issueRow(tx, key));
      assertEquals((deleted as Record<string, unknown>).result, "offline.device_not_registered");
      const heldAfterDelete = await inTx(sql, 4, async (tx) => {
        const rows = await tx.unsafe<{ n: number }[]>(`select public.offline_hold_count() as n`);
        return rows[0].n;
      });
      assertEquals(Number(heldAfterDelete), FREE_RATING_LIMIT);
    } finally {
      await sql.end();
    }
  },
});
