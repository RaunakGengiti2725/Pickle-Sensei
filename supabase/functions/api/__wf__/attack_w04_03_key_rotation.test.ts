// W04-03 adversarial tests — attack branch devin/pp/w04-03/attack-8f0f4c46.
//
// Each Deno.test below is one attack on candidate 8f0f4c46 (offline signing-key
// rotation with a bounded overlap). Expectations are written from the
// contract (offlineSignature.ts doc comments, docs/runbooks/offline-key-rotation.md,
// the W04-03 objective) — never from observed behaviour — so a failing test
// here is a reproducible break, and a passing one is an attack that held.
//
// Attacks:
//   A1  runbook procedure end to end: step-0 key script, step-1 public half,
//       step-3 dry import through `deno eval --lock=deno.lock` in the api dir.
//   A2  runbook step 4 rollback signal: a ring that fails to import must be
//       visible in the function log as `name: "SigningKeyUnavailable"`.
//   A3  log/response hygiene on the 200 and the 503 path (no key material).
//   A4  list path: a key object whose `kid` accessor answers differently on
//       one read detaches the retirement window from the verification key.
//   A5  list path with two retired keys and distinct windows.
//   A6  route cache transitions (valid → malformed → restored → legacy → ring)
//       and a cold-cache concurrent burst.
//   A7  compromise rotation: zero overlap at the secret-set instant.
//   A8  boundary encodings of the retirement instants.
//   A9  unauthorised callers of POST /v1/offline/grants with a ring configured.
//   A10 verifier clock rollback / far-future clock.
//   A11 a grace-issued max-lease grant at the documented maximum overlap.

import { assert, assertEquals, assertRejects } from "@std/assert";
import { exportJWK, generateKeyPair } from "jose";
import {
  OFFLINE_AUTHORIZATION_PROTOCOL_VERSION,
  OFFLINE_EXECUTION_GRANT_SCHEMA_VERSION,
  OFFLINE_GRANT_AUDIENCE,
  OFFLINE_PRO_LEASE_MAX_SECONDS,
  OFFLINE_PRO_LEASE_SCHEMA_VERSION,
  type OfflineExecutionGrantClaims,
  type OfflineReleasedArtifacts,
} from "../../../../packages/shared-types/src/offlineAuthorization.ts";
import {
  importOfflineGrantKeyRing,
  OFFLINE_KEY_ROTATION_MAX_OVERLAP_SECONDS,
  OFFLINE_KEY_ROTATION_PROPAGATION_GRACE_SECONDS,
  OfflineGrantCryptoError,
  type OfflineGrantKey,
  type OfflineGrantRetiredKey,
  type OfflineGrantVerificationContext,
  signOfflineExecutionGrant,
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

const GRANTS_PATH = "/v1/offline/grants";
const GRANT_RPC = "/rest/v1/rpc/issue_offline_grant";
const ISSUER = `${SUPABASE_URL}/functions/v1/api`;
const SIGNING_ENV = "OFFLINE_GRANT_SIGNING_JWK";
const OLDEST_KID = "atk-w04-03-key-2026-07";
const PREVIOUS_KID = "atk-w04-03-key-2026-08";
const ACTIVE_KID = "atk-w04-03-key-2026-09";
const INSTALLATION_KEY = "ios-installation-atk-w04-03";
const GRANT_ID = "44444444-0403-4444-8444-444444444403";
const DAY = 86_400;
const NOW = 1_788_000_000;
const GRACE = OFFLINE_KEY_ROTATION_PROPAGATION_GRACE_SECONDS;
const MAX_OVERLAP = OFFLINE_KEY_ROTATION_MAX_OVERLAP_SECONDS;
const MAX_UNIX_SECONDS = 253_402_300_799;

const oldestPair = await generateKeyPair("ES256", { extractable: true });
const previousPair = await generateKeyPair("ES256", { extractable: true });
const activePair = await generateKeyPair("ES256", { extractable: true });
const oldestPublicJwk = { ...(await exportJWK(oldestPair.publicKey)), kid: OLDEST_KID };
const previousPrivateJwk = { ...(await exportJWK(previousPair.privateKey)), kid: PREVIOUS_KID };
const previousPublicJwk = { ...(await exportJWK(previousPair.publicKey)), kid: PREVIOUS_KID };
const activePrivateJwk = { ...(await exportJWK(activePair.privateKey)), kid: ACTIVE_KID };

const oldestSigningKey: OfflineGrantKey = {
  purpose: "offline_execution_grant",
  kid: OLDEST_KID,
  key: oldestPair.privateKey,
};
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
  policy: { version: "atk-w04-03-policy", sha256: "a".repeat(64) },
  mechanicsModel: { version: "atk-w04-03-mechanics", sha256: "b".repeat(64) },
  benchmarkModel: { version: "atk-w04-03-benchmark", sha256: "c".repeat(64) },
};

const nowSeconds = (): number => Math.floor(Date.now() / 1000);
const iso = (epochSeconds: number): string => new Date(epochSeconds * 1000).toISOString();

interface RetiredKeyDocument {
  jwk: unknown;
  retiredAtEpochSeconds: unknown;
  overlapEndsAtEpochSeconds: unknown;
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
    previous: options.previous === undefined
      ? {
        jwk: previousPublicJwk,
        retiredAtEpochSeconds: retiredAt,
        overlapEndsAtEpochSeconds: options.overlapEndsAt ?? retiredAt + DAY,
      }
      : options.previous,
  };
}

function moduleContext(
  allowedKeyIds: readonly string[],
  nowEpochSeconds: number,
): OfflineGrantVerificationContext {
  return {
    binding: {
      issuer: "https://attack-w04-03.invalid/grants",
      allowedKeyIds,
      ownerId: "12345678-1234-4234-8234-123456789abc",
      installationKeyId: INSTALLATION_KEY,
    },
    release: structuredClone(TEST_RELEASE),
    nowEpochSeconds,
  };
}

function moduleClaims(
  iat: number,
  leaseSeconds = OFFLINE_PRO_LEASE_MAX_SECONDS,
): OfflineExecutionGrantClaims {
  const expected = moduleContext([PREVIOUS_KID], iat);
  return {
    schemaVersion: OFFLINE_EXECUTION_GRANT_SCHEMA_VERSION,
    protocolVersion: OFFLINE_AUTHORIZATION_PROTOCOL_VERSION,
    iss: expected.binding.issuer,
    aud: OFFLINE_GRANT_AUDIENCE,
    sub: expected.binding.ownerId,
    jti: "atk-w04-03-grant",
    installationKeyId: INSTALLATION_KEY,
    iat,
    exp: iat + leaseSeconds,
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

async function mint(
  signingKey: OfflineGrantKey,
  iat: number,
  leaseSeconds = OFFLINE_PRO_LEASE_MAX_SECONDS,
) {
  return await signOfflineExecutionGrant(
    moduleClaims(iat, leaseSeconds),
    signingKey,
    moduleContext([signingKey.kid], iat),
  );
}

async function rejectWith(
  code: OfflineGrantCryptoError["code"] | "retired_key",
  run: () => Promise<unknown>,
  message?: string,
): Promise<void> {
  const error = await assertRejects(run, OfflineGrantCryptoError, undefined, message);
  assertEquals((error as { code: string }).code, code, message);
}

// ---------------------------------------------------------------------------
// Route helpers (real edge handler through routesHarness)
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
/** A fresh account per attack so the per-user route budget never leaks across tests. */
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
    userRequest("POST", GRANTS_PATH, {
      token,
      ip,
      body: { installationKeyId: INSTALLATION_KEY },
    }),
  );
}

function routeContext(
  ownerId: string,
  allowedKeyIds: readonly string[],
  nowEpochSeconds = nowSeconds(),
): OfflineGrantVerificationContext {
  return {
    binding: { issuer: ISSUER, allowedKeyIds, ownerId, installationKeyId: INSTALLATION_KEY },
    release: RELEASE,
    nowEpochSeconds,
  };
}

/** Every string value the secret holds that must never reach a log or a body. */
function secretMaterial(): string[] {
  const values: string[] = [];
  for (const jwk of [activePrivateJwk, previousPublicJwk, previousPrivateJwk, oldestPublicJwk]) {
    for (const member of ["d", "x", "y"] as const) {
      const value = jwk[member];
      if (typeof value === "string") values.push(value);
    }
  }
  return values;
}

// ---------------------------------------------------------------------------
// A1 — the runbook procedure, literally
// ---------------------------------------------------------------------------

Deno.test(
  "A1 runbook: the step-0 key script, the step-1 public half and the step-3 dry import (deno eval --lock=deno.lock in supabase/functions/api) produce a ring the production importer accepts",
  async () => {
    // Step 0 — exactly the runbook's generation script, run in-process.
    const pair = await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"],
    );
    const kid = "offline-" + new Date().toISOString().slice(0, 10).replaceAll("-", "");
    const priv: Record<string, unknown> = {
      ...(await crypto.subtle.exportKey("jwk", pair.privateKey)),
      kid,
      key_ops: ["sign"],
    };
    const pub: Record<string, unknown> = {
      ...(await crypto.subtle.exportKey("jwk", pair.publicKey)),
      kid,
      key_ops: ["verify"],
    };
    delete priv.ext;
    delete pub.ext;
    delete priv.alg;
    delete pub.alg;
    assertEquals(Object.keys(priv).sort(), ["crv", "d", "key_ops", "kid", "kty", "x", "y"]);

    // Step 1 — the current secret is a bare private JWK (the legacy shape):
    // its {kty, crv, kid, x, y} with key_ops ["verify"] is the previous public JWK.
    const previous = {
      kty: previousPrivateJwk.kty,
      crv: previousPrivateJwk.crv,
      kid: previousPrivateJwk.kid,
      x: previousPrivateJwk.x,
      y: previousPrivateJwk.y,
      key_ops: ["verify"],
    };

    // Step 2/3 — retiredAt is the secret-set instant, 7-day overlap.
    const retiredAt = nowSeconds();
    const ring = {
      schemaVersion: 1,
      active: priv,
      previous: {
        jwk: previous,
        retiredAtEpochSeconds: retiredAt,
        overlapEndsAtEpochSeconds: retiredAt + MAX_OVERLAP,
      },
    };
    const imported = await importOfflineGrantKeyRing(ring, nowSeconds());
    assertEquals(imported.signingKey.kid, kid);
    assertEquals(imported.allowedKeyIds, [kid, PREVIOUS_KID]);

    // Step 3 — the documented dry-import command, run as a subprocess from the
    // directory the runbook prescribes (ring.json path substituted with a temp
    // file so nothing lands in the checkout).
    const apiDir = new URL("..", import.meta.url);
    const tempDir = await Deno.makeTempDir({ prefix: "atk-w04-03-" });
    const ringPath = `${tempDir}/ring.json`;
    try {
      await Deno.writeTextFile(ringPath, JSON.stringify(ring));
      const script = [
        'import { importOfflineGrantKeyRing } from "./offlineSignature.ts";',
        `const ring = await importOfflineGrantKeyRing(JSON.parse(await Deno.readTextFile(${
          JSON.stringify(ringPath)
        })), Math.floor(Date.now() / 1000));`,
        "console.log(JSON.stringify({ signingKid: ring.signingKey.kid, allowedKeyIds: ring.allowedKeyIds, previous: ring.previousKey && { kid: ring.previousKey.kid, retiredAt: ring.previousKey.retiredAtEpochSeconds, overlapEndsAt: ring.previousKey.overlapEndsAtEpochSeconds } }));",
      ].join("\n");
      const command = new Deno.Command(Deno.execPath(), {
        args: ["eval", "--lock=deno.lock", script],
        cwd: apiDir,
        stdout: "piped",
        stderr: "piped",
      });
      const output = await command.output();
      const stdout = new TextDecoder().decode(output.stdout);
      const stderr = new TextDecoder().decode(output.stderr);
      assertEquals(output.code, 0, `dry import failed:\n${stderr}`);
      const lastLine = stdout.trim().split("\n").at(-1) ?? "";
      const summary = JSON.parse(lastLine) as {
        signingKid: string;
        allowedKeyIds: string[];
        previous: { kid: string; retiredAt: number; overlapEndsAt: number } | null;
      };
      assertEquals(summary.signingKid, kid);
      assertEquals(summary.allowedKeyIds, [kid, PREVIOUS_KID]);
      assertEquals(summary.previous, {
        kid: PREVIOUS_KID,
        retiredAt,
        overlapEndsAt: retiredAt + MAX_OVERLAP,
      });
      // The dry import prints no key material.
      for (const value of [priv.d, priv.x, priv.y, previous.x, previous.y]) {
        assert(typeof value === "string" && !stdout.includes(value) && !stderr.includes(value));
      }
    } finally {
      await Deno.remove(tempDir, { recursive: true });
    }
  },
);

// ---------------------------------------------------------------------------
// A2 — runbook step 4: the rollback signal
// ---------------------------------------------------------------------------

Deno.test(
  "A2 runbook step 4: when the ring fails to import the function log carries `[api] Offline grant issuance:` with name SigningKeyUnavailable (the documented roll-back trigger) and no grant is spent",
  async () => {
    const user = freshUser();
    // A ring the importer refuses: private material in the previous entry.
    reset(ringDocument({
      previous: {
        jwk: previousPrivateJwk,
        retiredAtEpochSeconds: nowSeconds() - 60,
        overlapEndsAtEpochSeconds: nowSeconds() + DAY,
      },
    }));
    const captured = await captureConsole(() => issue(user.token));
    assertEquals(captured.result.status, 503);
    assertEquals(h.callsTo(GRANT_RPC).length, 0, "a ring that does not import spends nothing");

    const issuanceErrors = captured.logs.filter(
      (entry) =>
        entry.level === "error" &&
        entry.args[0] === "[api] Offline grant issuance:",
    );
    assertEquals(issuanceErrors.length, 1, captured.output);
    const detail = issuanceErrors[0].args[1] as { name?: unknown };
    assertEquals(
      detail.name,
      "SigningKeyUnavailable",
      `docs/runbooks/offline-key-rotation.md step 4 tells the operator to watch for name: "SigningKeyUnavailable"; logged detail was ${
        JSON.stringify(detail)
      }`,
    );
  },
);

// ---------------------------------------------------------------------------
// A3 — hygiene: no key material in logs or bodies, 200 and 503 paths
// ---------------------------------------------------------------------------

Deno.test(
  "A3 hygiene: neither the issued response nor the 503 refusal nor any log line carries the ring's coordinates, scalar or raw secret",
  async () => {
    const user = freshUser();
    const material = secretMaterial();
    const valid = ringDocument({ retiredAt: nowSeconds() - 60 });
    reset(valid);
    const issued = await captureConsole(() => issue(user.token));
    assertEquals(issued.result.status, 200);
    const okBody = await issued.result.text();
    for (const value of material) {
      assert(!okBody.includes(value), "200 body leaks key material");
      assert(!issued.output.includes(value), "200 path logs key material");
    }
    assert(!issued.output.includes(JSON.stringify(valid)), "200 path logs the raw secret");

    for (
      const document of [
        ringDocument({
          previous: {
            jwk: previousPrivateJwk,
            retiredAtEpochSeconds: NOW,
            overlapEndsAtEpochSeconds: NOW,
          },
        }),
        ringDocument({ retiredAt: nowSeconds() + GRACE + 5 }),
        { ...activePrivateJwk, d: "AA" },
        "{not json",
      ]
    ) {
      reset(document);
      const refused = await captureConsole(() => issue(user.token));
      assertEquals(refused.result.status, 503, JSON.stringify(document));
      const body = await refused.result.text();
      for (const value of material) {
        assert(!body.includes(value), "503 body leaks key material");
        assert(!refused.output.includes(value), "503 path logs key material");
      }
      assert(!refused.output.includes(Deno.env.get(SIGNING_ENV) ?? "\u0000"));
    }
    assertEquals(h.callsTo(GRANT_RPC).length, 0);
  },
);

// ---------------------------------------------------------------------------
// A4 — list path: a kid accessor detaches the window from the key
// ---------------------------------------------------------------------------

Deno.test(
  "A4 list path: a retired-key object whose kid accessor answers a different id on one read must not verify a previous-key receipt after the overlap (the window must stay bound to the key)",
  async () => {
    const ring = await importOfflineGrantKeyRing(
      ringDocument({ retiredAt: NOW, overlapEndsAt: NOW + DAY }),
      NOW,
    );
    const retired = ring.previousKey;
    assert(retired !== null);
    const receipt = await mint(previousSigningKey, NOW);

    // Control: the honest retired-key object is refused after the overlap.
    await rejectWith("retired_key", () =>
      verifyOfflineExecutionGrant(
        receipt,
        [ring.activeKey, retired],
        moduleContext([ACTIVE_KID, PREVIOUS_KID], NOW + DAY),
      ));

    let reads = 0;
    const shifty = {
      purpose: retired.purpose,
      key: retired.key,
      retiredAtEpochSeconds: retired.retiredAtEpochSeconds,
      overlapEndsAtEpochSeconds: retired.overlapEndsAtEpochSeconds,
      get kid(): string {
        reads += 1;
        return reads === 2 ? "atk-shadow-kid" : PREVIOUS_KID;
      },
    };
    await rejectWith(
      "retired_key",
      () =>
        verifyOfflineExecutionGrant(
          receipt,
          [ring.activeKey, shifty as unknown as OfflineGrantRetiredKey],
          moduleContext([ACTIVE_KID, PREVIOUS_KID], NOW + DAY),
        ),
      "a previous-key receipt verified after overlapEndsAt through a list entry whose window was recorded under another kid",
    );
  },
);

// ---------------------------------------------------------------------------
// A5 — list path: two retired keys with distinct windows
// ---------------------------------------------------------------------------

Deno.test(
  "A5 list path: two retired keys carry independent windows — the closed one is retired_key, the open one verifies, and a window on a kid the allowlist excludes changes nothing",
  async () => {
    const ring = await importOfflineGrantKeyRing(
      ringDocument({ retiredAt: NOW, overlapEndsAt: NOW + DAY }),
      NOW,
    );
    const previous = ring.previousKey;
    assert(previous !== null);
    const oldestRing = await importOfflineGrantKeyRing(
      ringDocument({
        previous: {
          jwk: oldestPublicJwk,
          retiredAtEpochSeconds: NOW - 3 * DAY,
          overlapEndsAtEpochSeconds: NOW - DAY,
        },
      }),
      NOW,
    );
    const oldest = oldestRing.previousKey;
    assert(oldest !== null);
    const list: readonly OfflineGrantKey[] = [ring.activeKey, previous, oldest];
    const allowed = [ACTIVE_KID, PREVIOUS_KID, OLDEST_KID];

    const underOldest = await mint(oldestSigningKey, NOW - 3 * DAY);
    const underPrevious = await mint(previousSigningKey, NOW);

    await rejectWith(
      "retired_key",
      () => verifyOfflineExecutionGrant(underOldest, list, moduleContext(allowed, NOW + 1)),
    );
    const verified = await verifyOfflineExecutionGrant(
      underPrevious,
      list,
      moduleContext(allowed, NOW + 1),
    );
    assertEquals(verified.protectedHeader.kid, PREVIOUS_KID);
    await rejectWith(
      "retired_key",
      () => verifyOfflineExecutionGrant(underPrevious, list, moduleContext(allowed, NOW + DAY)),
    );

    // The allowlist narrows: a receipt under a kid the binding excludes is
    // refused before any window is consulted (invalid_metadata), whether or
    // not the list still carries that key.
    await rejectWith("invalid_metadata", () =>
      verifyOfflineExecutionGrant(
        underOldest,
        [ring.activeKey, previous],
        moduleContext([ACTIVE_KID, PREVIOUS_KID], NOW + 1),
      ));
    await rejectWith("invalid_metadata", () =>
      verifyOfflineExecutionGrant(
        underOldest,
        list,
        moduleContext([ACTIVE_KID, PREVIOUS_KID], NOW + 1),
      ));
    // A window can never be attached to the active key by the ring itself.
    assertEquals("retiredAtEpochSeconds" in ring.activeKey, false);
    assertEquals("retiredAtEpochSeconds" in ring.signingKey, false);
  },
);

// ---------------------------------------------------------------------------
// A6 — route cache transitions and a cold-cache burst
// ---------------------------------------------------------------------------

Deno.test(
  "A6 route cache: valid ring → malformed → restored → legacy bare JWK → ring follow the secret exactly; a malformed value spends nothing and a cold-cache concurrent burst all signs with the active key",
  async () => {
    const user = freshUser();
    const now = nowSeconds();
    const ring = ringDocument({ retiredAt: now - 60, overlapEndsAt: now + DAY });

    reset(ring);
    const first = await issue(user.token);
    assertEquals(first.status, 200);
    assertEquals(((await first.json()) as { keyId: string }).keyId, ACTIVE_KID);
    assertEquals(h.callsTo(GRANT_RPC).length, 1);

    // The operator sets a broken ring: refused, nothing spent.
    reset(ringDocument({ retiredAt: now + GRACE + 30 }));
    const broken = await issue(user.token);
    assertEquals(broken.status, 503);
    assertEquals(h.callsTo(GRANT_RPC).length, 0);

    // Roll back to the exact previous value: issuance resumes with the active key.
    reset(ring);
    const restored = await issue(user.token);
    assertEquals(restored.status, 200);
    assertEquals(((await restored.json()) as { keyId: string }).keyId, ACTIVE_KID);

    // Roll back further to the legacy bare private JWK of the previous key.
    reset(previousPrivateJwk);
    const legacy = await issue(user.token);
    assertEquals(legacy.status, 200);
    assertEquals(((await legacy.json()) as { keyId: string }).keyId, PREVIOUS_KID);

    // The same ring pretty-printed is a distinct secret value and still imports.
    h.reset();
    Deno.env.set(SIGNING_ENV, JSON.stringify(ring, null, 2));
    h.rpcs.issue_offline_grant = [proRow(now - 1, 3 * DAY)];
    const pretty = await issue(user.token);
    assertEquals(pretty.status, 200);
    assertEquals(((await pretty.json()) as { keyId: string }).keyId, ACTIVE_KID);

    // Cold cache (a value this isolate has never imported) hit by 6 requests at once.
    const burstRing = ringDocument({ retiredAt: now - 61, overlapEndsAt: now + DAY });
    reset(burstRing);
    const burstUsers = Array.from({ length: 6 }, () => freshUser());
    const responses = await Promise.all(burstUsers.map((each) => issue(each.token)));
    const imported = await importOfflineGrantKeyRing(burstRing, nowSeconds());
    for (const [index, response] of responses.entries()) {
      assertEquals(response.status, 200);
      const body = (await response.json()) as { keyId: string; grant: unknown };
      assertEquals(body.keyId, ACTIVE_KID);
      const verified = await verifyOfflineExecutionGrant(
        body.grant,
        imported,
        routeContext(burstUsers[index].sub, imported.allowedKeyIds),
      );
      assertEquals(verified.protectedHeader.kid, ACTIVE_KID);
    }
    assertEquals(h.callsTo(GRANT_RPC).length, 6);
  },
);

// ---------------------------------------------------------------------------
// A7 — compromise rotation
// ---------------------------------------------------------------------------

Deno.test(
  "A7 compromise: a zero-overlap ring set at the secret-set instant refuses every receipt of the compromised key at once — before, during and after the grace — while the new key verifies",
  async () => {
    const ring = await importOfflineGrantKeyRing(
      ringDocument({ retiredAt: NOW, overlapEndsAt: NOW }),
      NOW,
    );
    const fresh = await signOfflineExecutionGrant(
      moduleClaims(NOW),
      ring.signingKey,
      moduleContext([ACTIVE_KID], NOW),
    );
    // Every receipt below still has a live lease at every instant it is checked.
    const receipts = [
      await mint(previousSigningKey, NOW - 6 * DAY),
      await mint(previousSigningKey, NOW - 1),
      await mint(previousSigningKey, NOW),
    ];
    for (const receipt of receipts) {
      for (const now of [NOW, NOW + 1, NOW + GRACE, NOW + DAY - 1]) {
        await rejectWith(
          "retired_key",
          () => verifyOfflineExecutionGrant(receipt, ring, moduleContext(ring.allowedKeyIds, now)),
        );
      }
    }
    // A grant the attacker mints with the stolen key inside the grace is refused too.
    const stolen = await mint(previousSigningKey, NOW + GRACE);
    await rejectWith(
      "retired_key",
      () =>
        verifyOfflineExecutionGrant(stolen, ring, moduleContext(ring.allowedKeyIds, NOW + GRACE)),
    );
    const verified = await verifyOfflineExecutionGrant(
      fresh,
      ring,
      moduleContext(ring.allowedKeyIds, NOW + GRACE),
    );
    assertEquals(verified.protectedHeader.kid, ACTIVE_KID);

    // Dropping the previous key altogether turns its receipts into invalid_key.
    const dropped = await importOfflineGrantKeyRing(ringDocument({ previous: null }), NOW);
    assertEquals(dropped.allowedKeyIds, [ACTIVE_KID]);
    await rejectWith(
      "invalid_metadata",
      () =>
        verifyOfflineExecutionGrant(
          receipts[1],
          dropped,
          moduleContext(dropped.allowedKeyIds, NOW),
        ),
    );
    await rejectWith("invalid_key", () =>
      verifyOfflineExecutionGrant(
        receipts[1],
        dropped,
        moduleContext([ACTIVE_KID, PREVIOUS_KID], NOW),
      ));
  },
);

// ---------------------------------------------------------------------------
// A8 — boundary encodings of the instants
// ---------------------------------------------------------------------------

Deno.test(
  "A8 boundaries: integer-valued float literals are the same instant, -0 / fractions / numeric strings / MAX+1 are refused, epoch 0 and the contract's last instant import",
  async () => {
    const parsed = JSON.parse(
      `{"schemaVersion":1,"active":${JSON.stringify(activePrivateJwk)},"previous":{"jwk":${
        JSON.stringify(previousPublicJwk)
      },"retiredAtEpochSeconds":1.788e9,"overlapEndsAtEpochSeconds":1788000000.0}}`,
    ) as unknown;
    const exponent = await importOfflineGrantKeyRing(parsed, NOW);
    assertEquals(exponent.previousKey?.retiredAtEpochSeconds, NOW);
    assertEquals(exponent.previousKey?.overlapEndsAtEpochSeconds, NOW);

    for (
      const [retiredAt, overlapEndsAt] of [
        [-0, 0],
        [NOW, NOW + 0.5],
        [NOW + 0.5, NOW + 1],
        [String(NOW), NOW],
        [NOW, String(NOW)],
        [MAX_UNIX_SECONDS + 1, MAX_UNIX_SECONDS + 1],
        [NOW, NOW - 1],
        [NOW, NOW + MAX_OVERLAP + 1],
        [Number.NaN, NOW],
        [NOW, Number.POSITIVE_INFINITY],
      ] as const
    ) {
      await rejectWith(
        "invalid_key",
        () =>
          importOfflineGrantKeyRing(
            ringDocument({
              previous: {
                jwk: previousPublicJwk,
                retiredAtEpochSeconds: retiredAt,
                overlapEndsAtEpochSeconds: overlapEndsAt,
              },
            }),
            MAX_UNIX_SECONDS,
          ),
        `retiredAt=${String(retiredAt)} overlapEndsAt=${String(overlapEndsAt)}`,
      );
    }

    const epochZero = await importOfflineGrantKeyRing(
      ringDocument({ retiredAt: 0, overlapEndsAt: 0 }),
      0,
    );
    assertEquals(epochZero.previousKey?.retiredAtEpochSeconds, 0);
    const lastInstant = await importOfflineGrantKeyRing(
      ringDocument({ retiredAt: MAX_UNIX_SECONDS, overlapEndsAt: MAX_UNIX_SECONDS }),
      MAX_UNIX_SECONDS,
    );
    assertEquals(lastInstant.previousKey?.overlapEndsAtEpochSeconds, MAX_UNIX_SECONDS);
    // The epoch-0 zero-length window refuses a previous-key receipt minted at 0.
    const receipt = await mint(previousSigningKey, 0);
    await rejectWith(
      "retired_key",
      () =>
        verifyOfflineExecutionGrant(receipt, epochZero, moduleContext(epochZero.allowedKeyIds, 1)),
    );
    // The exponent-notation ring is the same window as the literal one.
    const literal = await importOfflineGrantKeyRing(
      ringDocument({ retiredAt: NOW, overlapEndsAt: NOW }),
      NOW,
    );
    const atNow = await mint(previousSigningKey, NOW);
    for (const candidate of [exponent, literal]) {
      await rejectWith(
        "retired_key",
        () =>
          verifyOfflineExecutionGrant(
            atNow,
            candidate,
            moduleContext(candidate.allowedKeyIds, NOW),
          ),
      );
    }
  },
);

// ---------------------------------------------------------------------------
// A9 — unauthorised callers with a ring configured
// ---------------------------------------------------------------------------

Deno.test(
  "A9 unauthorised: no bearer, a garbage bearer and a service-role-looking bearer are refused before the signing key is touched — 401, no grant spent, no key id or grant in the body",
  async () => {
    reset(ringDocument({ retiredAt: nowSeconds() - 60 }));
    const requests: Array<[string, Request]> = [
      [
        "no bearer",
        new Request(`http://edge.test/functions/v1/api${GRANTS_PATH}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-forwarded-for": "203.0.113.101",
          },
          body: JSON.stringify({ installationKeyId: INSTALLATION_KEY }),
        }),
      ],
      [
        "garbage bearer",
        userRequest("POST", GRANTS_PATH, {
          token: "not-a-token",
          ip: "203.0.113.102",
          body: { installationKeyId: INSTALLATION_KEY },
        }),
      ],
      [
        "service-role-looking bearer",
        userRequest("POST", GRANTS_PATH, {
          token: "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.invalid",
          ip: "203.0.113.103",
          body: { installationKeyId: INSTALLATION_KEY },
        }),
      ],
    ];
    for (const [name, request] of requests) {
      const captured = await captureConsole(() => h.handler(request));
      assertEquals(captured.result.status, 401, name);
      const body = await captured.result.text();
      assert(!body.includes("keyId") && !body.includes('grant"'), name);
      assert(!body.includes(ACTIVE_KID) && !body.includes(PREVIOUS_KID), name);
      for (const value of secretMaterial()) {
        assert(!captured.output.includes(value) && !body.includes(value), name);
      }
    }
    assertEquals(h.callsTo(GRANT_RPC).length, 0);
  },
);

// ---------------------------------------------------------------------------
// A10 — verifier clock rollback / far-future clock
// ---------------------------------------------------------------------------

Deno.test(
  "A10 clock: a verifier rolled back before a receipt's iat refuses it as invalid_time for both keys; rolled back more than one grace before retiredAt it refuses the ring; a far-future clock refuses both receipts as expired, never accepts",
  async () => {
    const ring = await importOfflineGrantKeyRing(
      ringDocument({ retiredAt: NOW, overlapEndsAt: NOW + DAY }),
      NOW,
    );
    const underPrevious = await mint(previousSigningKey, NOW - 1);
    const underActive = await signOfflineExecutionGrant(
      moduleClaims(NOW),
      ring.signingKey,
      moduleContext([ACTIVE_KID], NOW),
    );

    // Device clock rolled back below iat: neither key's receipt is honoured.
    await rejectWith(
      "invalid_time",
      () =>
        verifyOfflineExecutionGrant(
          underPrevious,
          ring,
          moduleContext(ring.allowedKeyIds, NOW - 2),
        ),
    );
    await rejectWith(
      "invalid_time",
      () =>
        verifyOfflineExecutionGrant(underActive, ring, moduleContext(ring.allowedKeyIds, NOW - 1)),
    );

    // Rolled back more than one grace before retiredAt: the ring describes a
    // retirement the clock cannot corroborate → refused, even for the active key
    // and for a previous receipt whose iat the rolled-back clock still admits.
    const early = await mint(previousSigningKey, NOW - 2 * DAY);
    await rejectWith("invalid_key", () =>
      verifyOfflineExecutionGrant(
        early,
        ring,
        moduleContext(ring.allowedKeyIds, NOW - GRACE - 1),
      ));
    const earlyActive = await signOfflineExecutionGrant(
      moduleClaims(NOW - 2 * DAY),
      ring.signingKey,
      moduleContext([ACTIVE_KID], NOW - 2 * DAY),
    );
    await rejectWith("invalid_key", () =>
      verifyOfflineExecutionGrant(
        earlyActive,
        ring,
        moduleContext(ring.allowedKeyIds, NOW - GRACE - 1),
      ));
    // Exactly one grace before retiredAt is still corroborated.
    const atBound = await verifyOfflineExecutionGrant(
      early,
      ring,
      moduleContext(ring.allowedKeyIds, NOW - GRACE),
    );
    assertEquals(atBound.protectedHeader.kid, PREVIOUS_KID);

    // Far-future clock (the contract's last instant): both receipts are simply
    // expired — a refusal, not a crash or an overflow into acceptance.
    await rejectWith("invalid_time", () =>
      verifyOfflineExecutionGrant(
        underPrevious,
        ring,
        moduleContext(ring.allowedKeyIds, MAX_UNIX_SECONDS),
      ));
    await rejectWith("invalid_time", () =>
      verifyOfflineExecutionGrant(
        underActive,
        ring,
        moduleContext(ring.allowedKeyIds, MAX_UNIX_SECONDS),
      ));
    const stillValid = await verifyOfflineExecutionGrant(
      underActive,
      ring,
      moduleContext(ring.allowedKeyIds, NOW + OFFLINE_PRO_LEASE_MAX_SECONDS - 1),
    );
    assertEquals(stillValid.protectedHeader.kid, ACTIVE_KID);
  },
);

// ---------------------------------------------------------------------------
// A11 — the grace-issued max-lease grant at the maximum overlap
// ---------------------------------------------------------------------------

Deno.test(
  "A11 overlap ceiling: a grant the server issued under the old key inside the propagation grace with the full 7-day lease stays verifiable for its whole lease at the documented maximum overlap",
  async () => {
    // Runbook step 2: overlap = "the longest lease the previous key may have
    // issued (7 days for Pro leases)". The old key may issue until
    // retiredAt + grace, so that grant's lease ends at retiredAt + grace + 7 days.
    const ring = await importOfflineGrantKeyRing(
      ringDocument({ retiredAt: NOW, overlapEndsAt: NOW + MAX_OVERLAP }),
      NOW,
    );
    const graceIssued = await mint(previousSigningKey, NOW + GRACE, OFFLINE_PRO_LEASE_MAX_SECONDS);
    const leaseEnd = NOW + GRACE + OFFLINE_PRO_LEASE_MAX_SECONDS;

    const inside = await verifyOfflineExecutionGrant(
      graceIssued,
      ring,
      moduleContext(ring.allowedKeyIds, NOW + MAX_OVERLAP - 1),
    );
    assertEquals(inside.protectedHeader.kid, PREVIOUS_KID);
    // One second before its lease ends the grant is still a live, server-issued
    // Pro lease; the objective's bounded overlap must be able to cover it.
    const lastLeaseSecond = await verifyOfflineExecutionGrant(
      graceIssued,
      ring,
      moduleContext(ring.allowedKeyIds, leaseEnd - 1),
    );
    assertEquals(lastLeaseSecond.protectedHeader.kid, PREVIOUS_KID);
  },
);
