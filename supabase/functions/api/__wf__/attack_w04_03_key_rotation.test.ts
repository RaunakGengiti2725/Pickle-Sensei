// W04-03 ADVERSARIAL TESTS — signing-key rotation with a bounded overlap.
//
// Attack-only file for candidate 274a7d2237e589b492049bb7ce295e8d31c42b8b
// (branch devin/pp/w04-03/impl-r3). It touches no production code and no
// candidate-owned test. Every `Deno.test` below is one attack; the test body
// asserts the behaviour the contract PROMISES, so a failing test here is a
// confirmed break and a passing test is an attack the candidate withstood.
//
// Attack categories (numbered A1.. in the test names):
//   A1  replay / duplicate identity — ECDSA signature malleability ((r, s) -> (r, n-s))
//   A2  clock skew on the issuing path — DB clock ahead of the isolate clock
//   A3  boundary clocks on verification (0, -1, 1.5, NaN, Infinity, max, rollback)
//   A4  boundary key-ring documents (max epoch, kid length/charset, curve/use/ops)
//   A5  corrupt / partial persisted secret (BOM, truncation, trailing bytes, duplicates)
//   A6  process restart / cache / rollback / cold-cache concurrency at the route
//   A7  unauthorised callers and cross-owner / cross-installation receipts
//   A8  kid confusion, kid reuse and a compromised previous key
//   A9  reentrancy — TOCTOU getters and binding mutation during verification
//   A10 double rotation inside an open overlap
//   A11 leakage — logs and 5xx bodies under rings that carry private material
//   A12 network failure of the grant RPC under a rotated ring (5xx / 429)
//
// Module-level cases load `../offlineSignature.ts` dynamically so BASE_SHA
// fails with an assertion rather than a module-load error.

import { assert, assertEquals, assertNotEquals, assertRejects } from "@std/assert";
import { base64url, exportJWK, generateKeyPair, SignJWT } from "jose";
import {
  OFFLINE_AUTHORIZATION_PROTOCOL_VERSION,
  OFFLINE_EXECUTION_GRANT_SCHEMA_VERSION,
  OFFLINE_GRANT_AUDIENCE,
  OFFLINE_GRANT_JWS_TYPE,
  OFFLINE_PRO_LEASE_MAX_SECONDS,
  OFFLINE_PRO_LEASE_SCHEMA_VERSION,
  OFFLINE_SIGNED_GRANT_SCHEMA_VERSION,
  type OfflineExecutionGrantClaims,
  type OfflineReleasedArtifacts,
} from "../../../../packages/shared-types/src/offlineAuthorization.ts";
import {
  OfflineGrantCryptoError,
  signOfflineExecutionGrant,
  type OfflineGrantKey,
  type OfflineGrantVerificationContext,
} from "../offlineSignature.ts";
import { activeReleasePolicyRow, HARNESS_RELEASE_POLICY } from "./releasePolicyFixture.ts";
import { fakeGoogleIdToken, loadHarness, SUPABASE_URL, userRequest } from "./routesHarness.ts";

const h = await loadHarness();

const GRANTS_PATH = "/v1/offline/grants";
const GRANT_RPC = "/rest/v1/rpc/issue_offline_grant";
const ISSUER = `${SUPABASE_URL}/functions/v1/api`;
const SIGNING_ENV = "OFFLINE_GRANT_SIGNING_JWK";
const PREVIOUS_KID = "attack-0403-key-2026-08";
const ACTIVE_KID = "attack-0403-key-2026-09";
const NEXT_KID = "attack-0403-key-2026-10";
const INSTALLATION_KEY = "ios-installation-attack-0403";
const OTHER_INSTALLATION_KEY = "ios-installation-attack-0403-other";
const GRANT_ID = "55555555-0403-4555-8555-555555555555";
const OWNER_ID = "12345678-1234-4234-8234-123456789abc";
const OTHER_OWNER_ID = "87654321-4321-4321-8321-cba987654321";
const DAY = 86_400;
const NOW = 1_788_000_000;
const MAX_EPOCH = 253_402_300_799;
const P256_N = BigInt("0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551");

const previousPair = await generateKeyPair("ES256", { extractable: true });
const activePair = await generateKeyPair("ES256", { extractable: true });
const nextPair = await generateKeyPair("ES256", { extractable: true });
const previousPrivateJwk = { ...(await exportJWK(previousPair.privateKey)), kid: PREVIOUS_KID };
const previousPublicJwk = { ...(await exportJWK(previousPair.publicKey)), kid: PREVIOUS_KID };
const activePrivateJwk = { ...(await exportJWK(activePair.privateKey)), kid: ACTIVE_KID };
const activePublicJwk = { ...(await exportJWK(activePair.publicKey)), kid: ACTIVE_KID };
const nextPrivateJwk = { ...(await exportJWK(nextPair.privateKey)), kid: NEXT_KID };

const previousSigningKey: OfflineGrantKey = {
  purpose: "offline_execution_grant",
  kid: PREVIOUS_KID,
  key: previousPair.privateKey,
};

const releasePolicyRow = await activeReleasePolicyRow();
const approval = releasePolicyRow.approval as { policy: { version: string; sha256: string } };
const RELEASE: OfflineReleasedArtifacts = {
  policy: approval.policy,
  mechanicsModel: HARNESS_RELEASE_POLICY.mechanics.lineage.model,
  benchmarkModel: HARNESS_RELEASE_POLICY.benchmark.lineage.model,
};
const TEST_RELEASE: OfflineReleasedArtifacts = {
  policy: { version: "attack-0403-policy", sha256: "a".repeat(64) },
  mechanicsModel: { version: "attack-0403-mechanics", sha256: "b".repeat(64) },
  benchmarkModel: { version: "attack-0403-benchmark", sha256: "c".repeat(64) },
};

const nowSeconds = (): number => Math.floor(Date.now() / 1000);
const iso = (epochSeconds: number): string => new Date(epochSeconds * 1000).toISOString();

// ---------------------------------------------------------------------------
// Module contract (loaded dynamically)
// ---------------------------------------------------------------------------

interface RetiredKeyDocument {
  jwk: unknown;
  retiredAtEpochSeconds: unknown;
  overlapEndsAtEpochSeconds: unknown;
}

interface KeyRing {
  readonly signingKey: OfflineGrantKey;
  readonly activeKey: OfflineGrantKey;
  readonly previousKey:
    | (OfflineGrantKey & {
        readonly retiredAtEpochSeconds: number;
        readonly overlapEndsAtEpochSeconds: number;
      })
    | null;
  readonly allowedKeyIds: readonly string[];
}

interface VerifiedEnvelope {
  claims: OfflineExecutionGrantClaims;
  protectedHeader: { kid: string };
  grantJwsSha256: string;
}

interface RotationModule {
  OFFLINE_KEY_ROTATION_MAX_OVERLAP_SECONDS: number;
  OFFLINE_KEY_ROTATION_MAX_EPOCH_SECONDS: number;
  OFFLINE_KEY_ROTATION_PROPAGATION_GRACE_SECONDS: number;
  importOfflineGrantKeyRing: (configured: unknown) => Promise<KeyRing>;
  verifyOfflineExecutionGrant: (
    raw: unknown,
    keys: KeyRing | readonly OfflineGrantKey[],
    expected: OfflineGrantVerificationContext,
  ) => Promise<VerifiedEnvelope>;
}

async function loadRotation(): Promise<RotationModule> {
  const module: Record<string, unknown> = await import("../offlineSignature.ts");
  assert(
    typeof module.importOfflineGrantKeyRing === "function" &&
      typeof module.OFFLINE_KEY_ROTATION_MAX_OVERLAP_SECONDS === "number" &&
      typeof module.OFFLINE_KEY_ROTATION_MAX_EPOCH_SECONDS === "number" &&
      typeof module.OFFLINE_KEY_ROTATION_PROPAGATION_GRACE_SECONDS === "number",
    "offlineSignature.ts must export the key ring importer and the rotation bounds",
  );
  return module as unknown as RotationModule;
}

function ringDocument(options: {
  retiredAt?: number;
  overlapEndsAt?: number;
  previous?: RetiredKeyDocument | null;
  active?: unknown;
}): { schemaVersion: number; active: unknown; previous: RetiredKeyDocument | null } {
  const retiredAt = options.retiredAt ?? NOW;
  return {
    schemaVersion: 1,
    active: options.active ?? activePrivateJwk,
    previous:
      options.previous === undefined
        ? {
            jwk: previousPublicJwk,
            retiredAtEpochSeconds: retiredAt,
            overlapEndsAtEpochSeconds: options.overlapEndsAt ?? retiredAt + 7 * DAY,
          }
        : options.previous,
  };
}

function moduleContext(
  allowedKeyIds: readonly string[],
  nowEpochSeconds: number,
  overrides: { ownerId?: string; installationKeyId?: string } = {},
): OfflineGrantVerificationContext {
  return {
    binding: {
      issuer: "https://attack-0403-test.invalid/grants",
      allowedKeyIds,
      ownerId: overrides.ownerId ?? OWNER_ID,
      installationKeyId: overrides.installationKeyId ?? INSTALLATION_KEY,
    },
    release: structuredClone(TEST_RELEASE),
    nowEpochSeconds,
  };
}

function moduleClaims(
  iat: number,
  exp = iat + OFFLINE_PRO_LEASE_MAX_SECONDS,
): OfflineExecutionGrantClaims {
  return {
    schemaVersion: OFFLINE_EXECUTION_GRANT_SCHEMA_VERSION,
    protocolVersion: OFFLINE_AUTHORIZATION_PROTOCOL_VERSION,
    iss: "https://attack-0403-test.invalid/grants",
    aud: OFFLINE_GRANT_AUDIENCE,
    sub: OWNER_ID,
    jti: "attack-0403-grant",
    installationKeyId: INSTALLATION_KEY,
    iat,
    exp,
    capabilities: ["analyze_joint_output"],
    release: structuredClone(TEST_RELEASE),
    entitlementSource: "verified_store",
    lease: {
      schemaVersion: OFFLINE_PRO_LEASE_SCHEMA_VERSION,
      kind: "lifetime",
      verifiedEntitlementExpiresAt: null,
    },
  };
}

/** Signs under an arbitrary private key and header kid (bypasses the module's signer). */
async function signAs(
  claims: OfflineExecutionGrantClaims,
  key: CryptoKey,
  kid: string,
): Promise<{ schemaVersion: string; compactJws: string }> {
  const compactJws = await new SignJWT({ ...claims })
    .setProtectedHeader({ alg: "ES256", typ: OFFLINE_GRANT_JWS_TYPE, kid })
    .sign(key);
  return { schemaVersion: OFFLINE_SIGNED_GRANT_SCHEMA_VERSION, compactJws };
}

async function rejectWith(
  code: OfflineGrantCryptoError["code"] | "retired_key",
  run: () => Promise<unknown>,
  message?: string,
): Promise<void> {
  const error = await assertRejects(run, OfflineGrantCryptoError, undefined, message);
  assertEquals((error as { code: string }).code, code, message);
}

async function rejectWithOneOf(
  codes: readonly string[],
  run: () => Promise<unknown>,
  message?: string,
): Promise<string> {
  const error = await assertRejects(run, OfflineGrantCryptoError, undefined, message);
  const code = (error as { code: string }).code;
  assert(codes.includes(code), `${message ?? ""}: got ${code}, expected one of ${codes.join(",")}`);
  return code;
}

// ---------------------------------------------------------------------------
// Route helpers
// ---------------------------------------------------------------------------

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

function proRow(issuedAt: number, leaseSeconds: number): GrantRow {
  return {
    result: "accepted",
    grant_id: GRANT_ID,
    generation: 1,
    entitlement_source: "verified_store",
    issued_at: iso(issuedAt),
    expires_at: iso(issuedAt + leaseSeconds),
    entitlement_expires_at: iso(issuedAt + 30 * DAY),
    ticket_ids: [],
  };
}

let userSeq = 0;
function freshUser(): { sub: string; token: string } {
  userSeq += 1;
  const sub = `bbbbbbbb-0403-4000-8000-${String(userSeq).padStart(12, "0")}`;
  return { sub, token: fakeGoogleIdToken(sub) };
}

function reset(secret: unknown, issuedAt = nowSeconds() - 1): void {
  h.reset();
  Deno.env.set(SIGNING_ENV, typeof secret === "string" ? secret : JSON.stringify(secret));
  h.rpcs.issue_offline_grant = [proRow(issuedAt, 3 * DAY)];
}

async function issue(token: string, ip?: string): Promise<Response> {
  return await h.handler(
    userRequest("POST", GRANTS_PATH, { token, ip, body: { installationKeyId: INSTALLATION_KEY } }),
  );
}

function routeContext(
  ownerId: string,
  allowedKeyIds: readonly string[],
  nowEpochSeconds = nowSeconds(),
  installationKeyId = INSTALLATION_KEY,
): OfflineGrantVerificationContext {
  return {
    binding: { issuer: ISSUER, allowedKeyIds, ownerId, installationKeyId },
    release: RELEASE,
    nowEpochSeconds,
  };
}

/** Captures everything the handler logs while `run` executes. */
async function capturingConsole<T>(run: () => Promise<T>): Promise<{ result: T; log: string }> {
  const lines: string[] = [];
  const original = {
    warn: console.warn,
    error: console.error,
    log: console.log,
    info: console.info,
  };
  const record = (...args: unknown[]): void => {
    lines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  };
  console.warn = record;
  console.error = record;
  console.log = record;
  console.info = record;
  try {
    const result = await run();
    return { result, log: lines.join("\n") };
  } finally {
    console.warn = original.warn;
    console.error = original.error;
    console.log = original.log;
    console.info = original.info;
  }
}

function assertGenericFailureBody(text: string, label: string): void {
  for (const forbidden of [
    "compactJws",
    SIGNING_ENV,
    PREVIOUS_KID,
    ACTIVE_KID,
    NEXT_KID,
    activePrivateJwk.d!,
    activePrivateJwk.x!,
    previousPrivateJwk.d!,
    previousPublicJwk.x!,
    "Android",
    "Google Play",
    "guest",
    "Live Court",
    "DUPR",
  ]) {
    assert(!text.includes(forbidden), `${label}: 5xx body leaks ${forbidden}`);
  }
}

// ===========================================================================
// A1 — replay / duplicate identity: ECDSA signature malleability
// ===========================================================================

Deno.test(
  "A1 a grant whose ECDSA signature is rewritten to (r, n - s) is either refused or yields the SAME grantJwsSha256 as the original (one grant, one identity)",
  async () => {
    const rotation = await loadRotation();
    const ring = await rotation.importOfflineGrantKeyRing(ringDocument({ previous: null }));
    const grant = await signOfflineExecutionGrant(
      moduleClaims(NOW),
      ring.signingKey,
      moduleContext(ring.allowedKeyIds, NOW),
    );
    const [header, payload, signature] = grant.compactJws.split(".");
    const bytes = base64url.decode(signature);
    assertEquals(bytes.length, 64);
    let s = 0n;
    for (const byte of bytes.slice(32)) s = (s << 8n) | BigInt(byte);
    let negated = P256_N - s;
    const negatedBytes = new Uint8Array(32);
    for (let i = 31; i >= 0; i -= 1) {
      negatedBytes[i] = Number(negated & 0xffn);
      negated >>= 8n;
    }
    const mutated = {
      ...grant,
      compactJws: `${header}.${payload}.${base64url.encode(
        new Uint8Array([...bytes.slice(0, 32), ...negatedBytes]),
      )}`,
    };
    assertNotEquals(mutated.compactJws, grant.compactJws);

    const original = await rotation.verifyOfflineExecutionGrant(
      grant,
      ring,
      moduleContext(ring.allowedKeyIds, NOW + 1),
    );
    let outcome: "rejected" | "same_digest" | "distinct_digest";
    try {
      const replayed = await rotation.verifyOfflineExecutionGrant(
        mutated,
        ring,
        moduleContext(ring.allowedKeyIds, NOW + 1),
      );
      assertEquals(replayed.claims.jti, original.claims.jti);
      outcome =
        replayed.grantJwsSha256 === original.grantJwsSha256 ? "same_digest" : "distinct_digest";
    } catch (error) {
      assert(error instanceof OfflineGrantCryptoError, String(error));
      outcome = "rejected";
    }
    assertNotEquals(
      outcome,
      "distinct_digest",
      "the mutated signature verifies AND is reported as a different grantJwsSha256: the same jti has two verified transport identities",
    );
  },
);

// ===========================================================================
// A2 — clock skew on the issuing path
// ===========================================================================

Deno.test(
  "A2 POST /v1/offline/grants never spends a grant it does not deliver when the database clock is ahead of the isolate clock",
  async () => {
    const user = freshUser();
    const document = ringDocument({ retiredAt: nowSeconds() - 60 });

    // Database 5 s BEHIND the isolate: delivered.
    reset(document, nowSeconds() - 5);
    const behind = await issue(user.token);
    assertEquals(behind.status, 200);
    assertEquals(h.callsTo(GRANT_RPC).length, 1);

    // Database 2 s AHEAD of the isolate: the RPC row is `accepted` (the
    // allocation / lease is durably recorded) — the route must either deliver
    // the grant or not have spent it.
    reset(document, nowSeconds() + 2);
    const { result: ahead, log } = await capturingConsole(() => issue(user.token));
    const spent = h.callsTo(GRANT_RPC).length;
    const body = await ahead.text();
    if (ahead.status !== 200) {
      assertGenericFailureBody(body, "db-ahead");
      assertEquals(
        spent,
        0,
        `db clock 2 s ahead: status ${ahead.status} after the RPC accepted the grant (spent=${spent}); log: ${log}`,
      );
    } else {
      assertEquals(spent, 1);
    }
  },
);

// ===========================================================================
// A3 — boundary clocks on verification
// ===========================================================================

Deno.test(
  "A3 verification refuses every non-instant `now` (0, -1, 1.5, NaN, Infinity, > max, string) and a rolled-back clock, and the overlap end wins over the lease end",
  async () => {
    const rotation = await loadRotation();
    const grace = rotation.OFFLINE_KEY_ROTATION_PROPAGATION_GRACE_SECONDS;
    const max = rotation.OFFLINE_KEY_ROTATION_MAX_OVERLAP_SECONDS;
    const retiredAt = NOW;
    const overlapEndsAt = retiredAt + max;
    const ring = await rotation.importOfflineGrantKeyRing(
      ringDocument({ retiredAt, overlapEndsAt }),
    );

    const underActive = await signOfflineExecutionGrant(
      moduleClaims(NOW),
      ring.signingKey,
      moduleContext(ring.allowedKeyIds, NOW),
    );
    for (const now of [
      0,
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
      "1788000001",
    ]) {
      await rejectWith(
        "invalid_time",
        () =>
          rotation.verifyOfflineExecutionGrant(
            underActive,
            ring,
            moduleContext(ring.allowedKeyIds, now as number),
          ),
        `now=${String(now)}`,
      );
    }
    // Clock rollback below iat: refused, not accepted on the strength of the signature.
    await rejectWith("invalid_time", () =>
      rotation.verifyOfflineExecutionGrant(
        underActive,
        ring,
        moduleContext(ring.allowedKeyIds, NOW - 1),
      ),
    );
    // Far-future clock past exp.
    await rejectWith("invalid_time", () =>
      rotation.verifyOfflineExecutionGrant(
        underActive,
        ring,
        moduleContext(ring.allowedKeyIds, MAX_EPOCH),
      ),
    );

    // The last grant the old key may legitimately have signed (iat = retiredAt
    // + grace) with the longest lease outlives the widest overlap by exactly
    // one grace: it verifies up to overlapEndsAt - 1 and is retired_key from
    // overlapEndsAt on, although exp = overlapEndsAt + grace.
    const lastLegitimate = await signOfflineExecutionGrant(
      moduleClaims(retiredAt + grace),
      previousSigningKey,
      moduleContext(ring.allowedKeyIds, retiredAt + grace),
    );
    assertEquals(
      (
        await rotation.verifyOfflineExecutionGrant(
          lastLegitimate,
          ring,
          moduleContext(ring.allowedKeyIds, overlapEndsAt - 1),
        )
      ).protectedHeader.kid,
      PREVIOUS_KID,
    );
    for (const now of [overlapEndsAt, overlapEndsAt + grace - 1]) {
      await rejectWith(
        "retired_key",
        () =>
          rotation.verifyOfflineExecutionGrant(
            lastLegitimate,
            ring,
            moduleContext(ring.allowedKeyIds, now),
          ),
        `now=${now}`,
      );
    }
    // Once its own exp is reached the verdict is invalid_time (the lease, not the key).
    await rejectWith("invalid_time", () =>
      rotation.verifyOfflineExecutionGrant(
        lastLegitimate,
        ring,
        moduleContext(ring.allowedKeyIds, overlapEndsAt + grace),
      ),
    );
  },
);

// ===========================================================================
// A4 — boundary key-ring documents
// ===========================================================================

Deno.test(
  "A4 key ring import: instants at the 9999-12-31 bound import, one past it does not; kid length/charset bounds; previous keys on other curves, with `use`/`key_ops`/`alg`, or with a case-variant kid",
  async () => {
    const rotation = await loadRotation();
    const max = rotation.OFFLINE_KEY_ROTATION_MAX_OVERLAP_SECONDS;

    // Accepted at the bound.
    for (const [retiredAt, overlapEndsAt] of [
      [MAX_EPOCH - max, MAX_EPOCH],
      [MAX_EPOCH, MAX_EPOCH],
      [0, 0],
      [0, max],
    ]) {
      const ring = await rotation.importOfflineGrantKeyRing(
        ringDocument({ retiredAt, overlapEndsAt }),
      );
      assertEquals(ring.previousKey?.overlapEndsAtEpochSeconds, overlapEndsAt);
    }
    // A ring whose window is entirely in the past verifies nothing under the previous key.
    const dead = await rotation.importOfflineGrantKeyRing(
      ringDocument({ retiredAt: 0, overlapEndsAt: 0 }),
    );
    const ancient = await signOfflineExecutionGrant(
      moduleClaims(NOW),
      previousSigningKey,
      moduleContext(dead.allowedKeyIds, NOW),
    );
    await rejectWith("retired_key", () =>
      rotation.verifyOfflineExecutionGrant(
        ancient,
        dead,
        moduleContext(dead.allowedKeyIds, NOW + 1),
      ),
    );

    // Refused one past the bound, and for non-integer / negative / -0 instants.
    for (const [retiredAt, overlapEndsAt] of [
      [MAX_EPOCH - max + 1, MAX_EPOCH + 1],
      [MAX_EPOCH + 1, MAX_EPOCH + 1],
      [NOW, NOW + 0.5],
      [NOW + 0.5, NOW + DAY],
      [-1, NOW],
      [-0, 0],
    ]) {
      await rejectWith(
        "invalid_key",
        () => rotation.importOfflineGrantKeyRing(ringDocument({ retiredAt, overlapEndsAt })),
        `${retiredAt}..${overlapEndsAt}`,
      );
    }

    // kid bounds on the previous entry.
    const kid128 = "k".repeat(128);
    const ring128 = await rotation.importOfflineGrantKeyRing(
      ringDocument({
        previous: {
          jwk: { ...previousPublicJwk, kid: kid128 },
          retiredAtEpochSeconds: NOW,
          overlapEndsAtEpochSeconds: NOW + DAY,
        },
      }),
    );
    assertEquals(ring128.allowedKeyIds, [ACTIVE_KID, kid128]);
    for (const kid of [
      "k".repeat(129),
      "",
      "has space",
      "tab\tkid",
      "ünïcode",
      ACTIVE_KID + "\u0000",
      "a/b+c=d.e:f-g_",
    ]) {
      const expected = kid === "a/b+c=d.e:f-g_" ? "accepted" : "invalid_key";
      const attempt = () =>
        rotation.importOfflineGrantKeyRing(
          ringDocument({
            previous: {
              jwk: { ...previousPublicJwk, kid },
              retiredAtEpochSeconds: NOW,
              overlapEndsAtEpochSeconds: NOW + DAY,
            },
          }),
        );
      if (expected === "accepted") {
        assertEquals((await attempt()).allowedKeyIds, [ACTIVE_KID, kid]);
      } else {
        await rejectWith("invalid_key", attempt, JSON.stringify(kid));
      }
    }
    // A case-variant of the active kid is a distinct identifier and imports
    // (different key material); it must not be mistaken for the active key.
    const caseVariant = await rotation.importOfflineGrantKeyRing(
      ringDocument({
        previous: {
          jwk: { ...previousPublicJwk, kid: ACTIVE_KID.toUpperCase() },
          retiredAtEpochSeconds: NOW,
          overlapEndsAtEpochSeconds: NOW + DAY,
        },
      }),
    );
    assertEquals(caseVariant.allowedKeyIds, [ACTIVE_KID, ACTIVE_KID.toUpperCase()]);

    // Previous JWK variants that must not import.
    const p384 = await generateKeyPair("ES384", { extractable: true });
    const p384Public = { ...(await exportJWK(p384.publicKey)), kid: PREVIOUS_KID };
    const ed = await generateKeyPair("EdDSA", { extractable: true, crv: "Ed25519" });
    const edPublic = { ...(await exportJWK(ed.publicKey)), kid: PREVIOUS_KID };
    for (const [name, jwk] of [
      ["P-384 previous", p384Public],
      ["Ed25519 previous", edPublic],
      ["use=enc", { ...previousPublicJwk, use: "enc" }],
      ["key_ops=sign", { ...previousPublicJwk, key_ops: ["sign"] }],
      ["alg=ES384", { ...previousPublicJwk, alg: "ES384" }],
      ["crv lowercase", { ...previousPublicJwk, crv: "p-256" }],
      ["kty lowercase", { ...previousPublicJwk, kty: "ec" }],
      ["x with padding", { ...previousPublicJwk, x: `${previousPublicJwk.x}=` }],
      ["x standard base64", { ...previousPublicJwk, x: `${previousPublicJwk.x!.slice(0, -1)}+` }],
      ["missing y", { kty: "EC", crv: "P-256", kid: PREVIOUS_KID, x: previousPublicJwk.x }],
      ["array jwk", [previousPublicJwk]],
      ["null jwk", null],
    ] as readonly (readonly [string, unknown])[]) {
      await rejectWith(
        "invalid_key",
        () =>
          rotation.importOfflineGrantKeyRing(
            ringDocument({
              previous: { jwk, retiredAtEpochSeconds: NOW, overlapEndsAtEpochSeconds: NOW + DAY },
            }),
          ),
        name,
      );
    }
  },
);

// ===========================================================================
// A5 — corrupt / partial persisted secret at the route
// ===========================================================================

Deno.test(
  "A5 POST /v1/offline/grants answers a generic 503 and spends nothing for a BOM-prefixed, truncated, trailing-garbage, array-wrapped, whitespace-only or NUL-kid secret; JSON duplicate keys resolve last-wins",
  async () => {
    const now = nowSeconds();
    const good = JSON.stringify(ringDocument({ retiredAt: now - 60 }));
    const malformedPrevious = JSON.stringify({
      jwk: previousPublicJwk,
      retiredAtEpochSeconds: (now - 60) * 1000,
      overlapEndsAtEpochSeconds: (now - 60) * 1000 + DAY,
    });
    const activeJson = JSON.stringify(activePrivateJwk);
    const refused: readonly (readonly [string, string])[] = [
      ["BOM prefix", `\uFEFF${good}`],
      ["truncated", good.slice(0, Math.floor(good.length / 2))],
      ["trailing brace", `${good}}`],
      ["array wrapped", `[${good}]`],
      ["whitespace only", "   \n\t "],
      ["NUL in active kid", JSON.stringify({ ...activePrivateJwk, kid: `${ACTIVE_KID}\u0000` })],
      [
        "duplicate previous, last malformed",
        `{"schemaVersion":1,"active":${activeJson},"previous":null,"previous":${malformedPrevious}}`,
      ],
      ["schemaVersion string", `{"schemaVersion":"1","active":${activeJson},"previous":null}`],
      ["previous undefined-ish (missing)", `{"schemaVersion":1,"active":${activeJson}}`],
      [
        "active is a JSON string of the JWK",
        JSON.stringify({ schemaVersion: 1, active: activeJson, previous: null }),
      ],
    ];
    for (const [name, raw] of refused) {
      reset(raw);
      const response = await issue(freshUser().token);
      assertEquals(response.status, 503, name);
      assertGenericFailureBody(await response.text(), name);
    }
    assertEquals(h.callsTo(GRANT_RPC).length, 0);

    // Duplicate `previous` where the LAST value is well-formed: JSON.parse
    // keeps the last one, the ring imports, the route signs with the active key.
    reset(
      `{"schemaVersion":1,"active":${activeJson},"previous":${malformedPrevious},"previous":null}`,
    );
    const lastWins = await issue(freshUser().token);
    assertEquals(lastWins.status, 200);
    assertEquals(((await lastWins.json()) as { keyId: string }).keyId, ACTIVE_KID);
    assertEquals(h.callsTo(GRANT_RPC).length, 1);

    // Whitespace around an otherwise valid document is tolerated (JSON).
    reset(`\n  ${good}  \n`);
    const padded = await issue(freshUser().token);
    assertEquals(padded.status, 200);
  },
);

// ===========================================================================
// A6 — process restart / cache / rollback / cold-cache concurrency
// ===========================================================================

Deno.test(
  "A6 the ring cache never serves a stale ring: valid -> malformed -> identical valid -> rollback to the old single JWK -> unset; and a cold cache under 8 concurrent requests signs every grant with the active kid",
  async () => {
    const user = freshUser();
    const now = nowSeconds();
    const document = ringDocument({ retiredAt: now - 60 });

    reset(document);
    const first = await issue(user.token);
    assertEquals(first.status, 200);
    assertEquals(((await first.json()) as { keyId: string }).keyId, ACTIVE_KID);

    // The secret value changes to something unusable: no fallback to the
    // ring imported a moment ago.
    reset(ringDocument({ retiredAt: now - 60, overlapEndsAt: now - 61 }));
    const broken = await issue(user.token);
    assertEquals(broken.status, 503);
    assertGenericFailureBody(await broken.text(), "broken after valid");
    assertEquals(h.callsTo(GRANT_RPC).length, 0);

    // The identical raw value again: served (cache hit or re-import — either
    // way the active kid signs).
    reset(document);
    const again = await issue(user.token);
    assertEquals(again.status, 200);
    assertEquals(((await again.json()) as { keyId: string }).keyId, ACTIVE_KID);

    // Roll back to the old single-JWK form: the old key signs again (the
    // runbook allows this only before any new-key grant was issued; the
    // route itself just follows the secret).
    reset(previousPrivateJwk);
    const rolledBack = await issue(user.token);
    assertEquals(rolledBack.status, 200);
    assertEquals(((await rolledBack.json()) as { keyId: string }).keyId, PREVIOUS_KID);

    // Secret removed entirely (a redeploy without the secret): 503, nothing spent.
    h.reset();
    Deno.env.delete(SIGNING_ENV);
    h.rpcs.issue_offline_grant = [proRow(now - 1, 3 * DAY)];
    const unset = await issue(user.token);
    assertEquals(unset.status, 503);
    assertGenericFailureBody(await unset.text(), "unset");
    assertEquals(h.callsTo(GRANT_RPC).length, 0);

    // Cold cache, 8 concurrent first requests from 8 accounts: every response
    // is 200 under the active kid and every one spent exactly one RPC call.
    reset(ringDocument({ retiredAt: now - 60 }));
    const users = Array.from({ length: 8 }, () => freshUser());
    const responses = await Promise.all(
      users.map((u, i) => issue(u.token, `203.0.113.${100 + i}`)),
    );
    for (const response of responses) {
      assertEquals(response.status, 200);
      assertEquals(((await response.json()) as { keyId: string }).keyId, ACTIVE_KID);
    }
    assertEquals(h.callsTo(GRANT_RPC).length, 8);
  },
);

// ===========================================================================
// A7 — unauthorised callers and cross-owner / cross-installation receipts
// ===========================================================================

Deno.test(
  "A7 under a rotated ring: no bearer / rejected bearer -> 401 and no spend; a grant issued to one owner+installation verifies for no other owner or installation under either key",
  async () => {
    const rotation = await loadRotation();
    const now = nowSeconds();
    const document = ringDocument({ retiredAt: now - 60 });

    reset(document);
    const anonymous = await h.handler(
      new Request(`http://edge.test/functions/v1/api${GRANTS_PATH}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-forwarded-for": "203.0.113.77" },
        body: JSON.stringify({ installationKeyId: INSTALLATION_KEY }),
      }),
    );
    assertEquals(anonymous.status, 401);
    assertGenericFailureBody(await anonymous.text(), "anonymous");
    assertEquals(h.callsTo(GRANT_RPC).length, 0);

    // A bearer that is neither a session token nor a provider ID token.
    reset(document);
    const garbage = await issue("garbage.garbage.garbage", "203.0.113.78");
    assertEquals(garbage.status, 401);
    assertEquals(h.callsTo(GRANT_RPC).length, 0);

    // The service-role key as a bearer is not a user.
    reset(document);
    const service = await h.handler(
      userRequest("POST", GRANTS_PATH, {
        token: "service-role-test-key",
        ip: "203.0.113.79",
        body: { installationKeyId: INSTALLATION_KEY },
      }),
    );
    assert(service.status === 401 || service.status === 403, String(service.status));
    assertEquals(h.callsTo(GRANT_RPC).length, 0);

    // Cross-owner / cross-installation: a real grant for user A.
    reset(document);
    const owner = freshUser();
    const issued = await issue(owner.token);
    assertEquals(issued.status, 200);
    const body = (await issued.json()) as { grant: unknown };
    const ring = await rotation.importOfflineGrantKeyRing(document);
    assertEquals(
      (
        await rotation.verifyOfflineExecutionGrant(
          body.grant,
          ring,
          routeContext(owner.sub, ring.allowedKeyIds),
        )
      ).claims.sub,
      owner.sub,
    );
    await rejectWith("invalid_metadata", () =>
      rotation.verifyOfflineExecutionGrant(
        body.grant,
        ring,
        routeContext(OTHER_OWNER_ID, ring.allowedKeyIds),
      ),
    );
    await rejectWith("invalid_metadata", () =>
      rotation.verifyOfflineExecutionGrant(
        body.grant,
        ring,
        routeContext(owner.sub, ring.allowedKeyIds, nowSeconds(), OTHER_INSTALLATION_KEY),
      ),
    );

    // The same under the PREVIOUS key inside the overlap (module-level).
    const underPrevious = await signOfflineExecutionGrant(
      moduleClaims(NOW),
      previousSigningKey,
      moduleContext([PREVIOUS_KID], NOW),
    );
    const moduleRing = await rotation.importOfflineGrantKeyRing(
      ringDocument({ retiredAt: NOW + DAY }),
    );
    assertEquals(
      (
        await rotation.verifyOfflineExecutionGrant(
          underPrevious,
          moduleRing,
          moduleContext(moduleRing.allowedKeyIds, NOW + DAY),
        )
      ).protectedHeader.kid,
      PREVIOUS_KID,
    );
    await rejectWith("invalid_metadata", () =>
      rotation.verifyOfflineExecutionGrant(
        underPrevious,
        moduleRing,
        moduleContext(moduleRing.allowedKeyIds, NOW + DAY, { ownerId: OTHER_OWNER_ID }),
      ),
    );
    await rejectWith("invalid_metadata", () =>
      rotation.verifyOfflineExecutionGrant(
        underPrevious,
        moduleRing,
        moduleContext(moduleRing.allowedKeyIds, NOW + DAY, {
          installationKeyId: OTHER_INSTALLATION_KEY,
        }),
      ),
    );
  },
);

// ===========================================================================
// A8 — kid confusion, kid reuse, compromised previous key
// ===========================================================================

Deno.test(
  "A8 a signature under one key with the other key's kid, a reused kid on fresh key material, and a previous key that was dropped for compromise are all refused",
  async () => {
    const rotation = await loadRotation();
    const retiredAt = NOW + DAY;
    const ring = await rotation.importOfflineGrantKeyRing(ringDocument({ retiredAt }));
    const inside = retiredAt + 1;

    // Old private key, header claims the ACTIVE kid.
    const oldKeyActiveKid = await signAs(moduleClaims(NOW), previousPair.privateKey, ACTIVE_KID);
    await rejectWith("invalid_signature", () =>
      rotation.verifyOfflineExecutionGrant(
        oldKeyActiveKid,
        ring,
        moduleContext(ring.allowedKeyIds, inside),
      ),
    );
    // Active private key, header claims the PREVIOUS kid (inside the overlap).
    const newKeyOldKid = await signAs(moduleClaims(NOW), activePair.privateKey, PREVIOUS_KID);
    await rejectWith("invalid_signature", () =>
      rotation.verifyOfflineExecutionGrant(
        newKeyOldKid,
        ring,
        moduleContext(ring.allowedKeyIds, inside),
      ),
    );
    // Header kid that is not a string / is an array.
    for (const kid of [["a"], 7, null, { kid: ACTIVE_KID }]) {
      const compactJws = await new SignJWT({ ...moduleClaims(NOW) })
        .setProtectedHeader({
          alg: "ES256",
          typ: OFFLINE_GRANT_JWS_TYPE,
          kid: kid as unknown as string,
        })
        .sign(activePair.privateKey);
      await rejectWithOneOf(
        ["invalid_metadata", "invalid_transport", "invalid_key"],
        () =>
          rotation.verifyOfflineExecutionGrant(
            { schemaVersion: OFFLINE_SIGNED_GRANT_SCHEMA_VERSION, compactJws },
            ring,
            moduleContext(ring.allowedKeyIds, inside),
          ),
        JSON.stringify(kid),
      );
    }

    // kid reuse: a later ring whose active key has NEW material under the OLD
    // active kid. Grants signed by the old material under that kid do not verify.
    const reused = await rotation.importOfflineGrantKeyRing(
      ringDocument({ active: { ...nextPrivateJwk, kid: ACTIVE_KID }, previous: null }),
    );
    const underOldMaterial = await signOfflineExecutionGrant(
      moduleClaims(NOW),
      ring.signingKey,
      moduleContext(ring.allowedKeyIds, NOW),
    );
    await rejectWith("invalid_signature", () =>
      rotation.verifyOfflineExecutionGrant(
        underOldMaterial,
        reused,
        moduleContext(reused.allowedKeyIds, inside),
      ),
    );

    // Compromise procedure: previous dropped. Old-key grants are refused
    // whatever allowlist the verifier is handed.
    const dropped = await rotation.importOfflineGrantKeyRing(ringDocument({ previous: null }));
    const underPrevious = await signOfflineExecutionGrant(
      moduleClaims(NOW),
      previousSigningKey,
      moduleContext([PREVIOUS_KID], NOW),
    );
    await rejectWith("invalid_metadata", () =>
      rotation.verifyOfflineExecutionGrant(
        underPrevious,
        dropped,
        moduleContext([ACTIVE_KID], inside),
      ),
    );
    await rejectWith("invalid_key", () =>
      rotation.verifyOfflineExecutionGrant(
        underPrevious,
        dropped,
        moduleContext([ACTIVE_KID, PREVIOUS_KID], inside),
      ),
    );
    await rejectWith("invalid_key", () =>
      rotation.verifyOfflineExecutionGrant(
        underPrevious,
        [dropped.activeKey],
        moduleContext([ACTIVE_KID, PREVIOUS_KID], inside),
      ),
    );
  },
);

// ===========================================================================
// A9 — reentrancy: TOCTOU getters and binding mutation mid-verification
// ===========================================================================

Deno.test(
  "A9 a retirement window served by a getter that widens on re-read, a previous kid pushed into the allowlist after verification started, and 24 interleaved verifications never widen acceptance",
  async () => {
    const rotation = await loadRotation();
    const grace = rotation.OFFLINE_KEY_ROTATION_PROPAGATION_GRACE_SECONDS;
    const retiredAt = NOW + DAY;
    const overlapEndsAt = retiredAt + DAY;
    const ring = await rotation.importOfflineGrantKeyRing(
      ringDocument({ retiredAt, overlapEndsAt }),
    );
    const underPrevious = await signOfflineExecutionGrant(
      moduleClaims(NOW),
      previousSigningKey,
      moduleContext(ring.allowedKeyIds, NOW),
    );
    const underActive = await signOfflineExecutionGrant(
      moduleClaims(NOW),
      ring.signingKey,
      moduleContext(ring.allowedKeyIds, NOW),
    );

    // List entry whose overlapEndsAt reads valid once, then far wider.
    let reads = 0;
    const shifty = Object.create(null) as Record<string, unknown>;
    shifty.purpose = ring.previousKey!.purpose;
    shifty.kid = PREVIOUS_KID;
    shifty.key = ring.previousKey!.key;
    shifty.retiredAtEpochSeconds = retiredAt;
    Object.defineProperty(shifty, "overlapEndsAtEpochSeconds", {
      enumerable: true,
      get() {
        reads += 1;
        return reads === 1 ? overlapEndsAt : MAX_EPOCH;
      },
    });
    const list = [ring.activeKey, shifty as unknown as OfflineGrantKey];
    await rejectWithOneOf(
      ["retired_key", "invalid_key"],
      () =>
        rotation.verifyOfflineExecutionGrant(
          underPrevious,
          list,
          moduleContext(ring.allowedKeyIds, overlapEndsAt),
        ),
      "getter-widened window at overlapEndsAt",
    );
    reads = 0;
    await rejectWithOneOf(
      ["retired_key", "invalid_key"],
      () =>
        rotation.verifyOfflineExecutionGrant(
          underPrevious,
          list,
          moduleContext(ring.allowedKeyIds, overlapEndsAt + 3600),
        ),
      "getter-widened window an hour later",
    );

    // Binding allowlist mutated after the call started.
    const allowed: string[] = [ACTIVE_KID];
    const pending = rotation.verifyOfflineExecutionGrant(
      underPrevious,
      ring,
      moduleContext(allowed, retiredAt),
    );
    allowed.push(PREVIOUS_KID);
    await rejectWith("invalid_metadata", () => pending, "allowlist widened mid-flight");

    // Interleaved verifications at different clocks share no state.
    const plan = Array.from({ length: 24 }, (_, i) => ({
      grant: i % 2 === 0 ? underPrevious : underActive,
      now: [retiredAt - grace - 1, retiredAt, overlapEndsAt - 1, overlapEndsAt][i % 4],
    }));
    const outcomes = await Promise.all(
      plan.map(async ({ grant, now }) => {
        try {
          return (
            await rotation.verifyOfflineExecutionGrant(
              grant,
              ring,
              moduleContext(ring.allowedKeyIds, now),
            )
          ).protectedHeader.kid;
        } catch (error) {
          return (error as { code: string }).code;
        }
      }),
    );
    plan.forEach(({ grant, now }, i) => {
      const expected =
        grant === underActive
          ? ACTIVE_KID
          : now >= overlapEndsAt || now < retiredAt - grace
            ? "retired_key"
            : PREVIOUS_KID;
      assertEquals(outcomes[i], expected, `#${i} now=${now}`);
    });
  },
);

// ===========================================================================
// A10 — double rotation inside an open overlap
// ===========================================================================

Deno.test(
  "A10 rotating a second time while the first overlap is still open refuses grants under the oldest key (two keys at most; nothing is silently kept)",
  async () => {
    const rotation = await loadRotation();
    const firstRetiredAt = NOW;
    const firstOverlapEnds = firstRetiredAt + 7 * DAY;
    const firstRing = await rotation.importOfflineGrantKeyRing(
      ringDocument({ retiredAt: firstRetiredAt, overlapEndsAt: firstOverlapEnds }),
    );
    const underOldest = await signOfflineExecutionGrant(
      moduleClaims(NOW - DAY),
      previousSigningKey,
      moduleContext(firstRing.allowedKeyIds, NOW - DAY),
    );
    const midOverlap = firstRetiredAt + DAY;
    assertEquals(
      (
        await rotation.verifyOfflineExecutionGrant(
          underOldest,
          firstRing,
          moduleContext(firstRing.allowedKeyIds, midOverlap),
        )
      ).protectedHeader.kid,
      PREVIOUS_KID,
    );

    // Second rotation one day in: active -> next, previous -> the (public) active key.
    const secondRing = await rotation.importOfflineGrantKeyRing({
      schemaVersion: 1,
      active: nextPrivateJwk,
      previous: {
        jwk: activePublicJwk,
        retiredAtEpochSeconds: midOverlap,
        overlapEndsAtEpochSeconds: midOverlap + 7 * DAY,
      },
    });
    assertEquals(secondRing.allowedKeyIds, [NEXT_KID, ACTIVE_KID]);
    await rejectWith("invalid_metadata", () =>
      rotation.verifyOfflineExecutionGrant(
        underOldest,
        secondRing,
        moduleContext(secondRing.allowedKeyIds, midOverlap + 1),
      ),
    );
    await rejectWith("invalid_key", () =>
      rotation.verifyOfflineExecutionGrant(
        underOldest,
        secondRing,
        moduleContext([...secondRing.allowedKeyIds, PREVIOUS_KID], midOverlap + 1),
      ),
    );
    // Grants under the now-previous key keep verifying inside their own overlap.
    const underMiddle = await signOfflineExecutionGrant(
      moduleClaims(midOverlap - 1),
      firstRing.signingKey,
      moduleContext(firstRing.allowedKeyIds, midOverlap - 1),
    );
    assertEquals(
      (
        await rotation.verifyOfflineExecutionGrant(
          underMiddle,
          secondRing,
          moduleContext(secondRing.allowedKeyIds, midOverlap + 1),
        )
      ).protectedHeader.kid,
      ACTIVE_KID,
    );
  },
);

// ===========================================================================
// A11 — leakage in logs and 5xx bodies
// ===========================================================================

Deno.test(
  "A11 neither the 503 body nor the function log carries key material, the raw secret, the bearer, the owner id, the installation key or the signed grant — for refused rings and for a successful issuance",
  async () => {
    const user = freshUser();
    const now = nowSeconds();
    const secrets = [
      activePrivateJwk.d!,
      previousPrivateJwk.d!,
      activePrivateJwk.x!,
      previousPublicJwk.x!,
      user.token,
      user.sub,
      INSTALLATION_KEY,
    ];

    for (const [name, document] of [
      [
        "previous carries d",
        ringDocument({
          previous: {
            jwk: previousPrivateJwk,
            retiredAtEpochSeconds: now - 60,
            overlapEndsAtEpochSeconds: now + DAY,
          },
        }),
      ],
      [
        "previous window in ms",
        ringDocument({ retiredAt: (now - 60) * 1000, overlapEndsAt: (now - 60) * 1000 + DAY }),
      ],
      ["active is public only", ringDocument({ active: activePublicJwk })],
    ] as readonly (readonly [string, unknown])[]) {
      reset(document);
      const raw = Deno.env.get(SIGNING_ENV)!;
      const { result: response, log } = await capturingConsole(() => issue(user.token));
      assertEquals(response.status, 503, name);
      const body = await response.text();
      assertGenericFailureBody(body, name);
      for (const secret of [...secrets, raw]) {
        assert(!body.includes(secret), `${name}: body leaks a secret`);
        assert(!log.includes(secret), `${name}: log leaks a secret`);
      }
      assert(!log.includes("compactJws"), name);
    }
    assertEquals(h.callsTo(GRANT_RPC).length, 0);

    reset(ringDocument({ retiredAt: now - 60 }));
    const { result: ok, log } = await capturingConsole(() => issue(user.token));
    assertEquals(ok.status, 200);
    const issued = (await ok.json()) as { grant: { compactJws: string }; keyId: string };
    assertEquals(issued.keyId, ACTIVE_KID);
    for (const secret of secrets) assert(!log.includes(secret), "issuance log leaks a secret");
    assert(!log.includes(issued.grant.compactJws), "issuance log carries the signed grant");
    assert(
      !log.includes(GRANT_ID.slice(0, 8)) || log.includes("offline_grant_audit"),
      "audit line shape",
    );
    assert(log.includes(ACTIVE_KID), "the audit line names the key id");
  },
);

// ===========================================================================
// A12 — network failure of the grant RPC under a rotated ring
// ===========================================================================

Deno.test(
  "A12 when the grant RPC fails (500 / 503 / 429) under a rotated ring the route answers a generic 5xx with no grant, no key id and no signed payload",
  async () => {
    const user = freshUser();
    const document = ringDocument({ retiredAt: nowSeconds() - 60 });
    for (const upstream of [500, 503, 429]) {
      reset(document);
      h.rpcErrors.issue_offline_grant = upstream;
      const response = await issue(user.token);
      assert(
        response.status >= 500 && response.status < 600,
        `upstream ${upstream} -> ${response.status}`,
      );
      const text = await response.text();
      assertGenericFailureBody(text, `upstream ${upstream}`);
      assert(
        !text.includes("keyId") && !text.includes("grantId"),
        `upstream ${upstream}: body carries grant fields`,
      );
      assertEquals(h.callsTo(GRANT_RPC).length, 1);
    }
    // Recovery on the very next request with the same ring.
    reset(document);
    const recovered = await issue(user.token);
    assertEquals(recovered.status, 200);
  },
);
