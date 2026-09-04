/**
 * Adversarial pins for the free-rating neighbourhood that
 * free_rating_access_payload.test.ts leaves open (mutation survivors on
 * 0ecdbcdc: A08 reserved clamped to the LIMIT instead of to remaining, A01
 * every reserve refusal answered 402, A02 only the paywall sync status
 * mapped, A10 sync write-failed detail echoed to the client).
 *
 * Every test here passes against the shipped index.ts (4d812e1a / 0ecdbcdc);
 * each one fails when the corresponding mutant is applied. Black-box through
 * the real handler (routesHarness.ts), no Postgres.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { fakeGoogleIdToken, loadHarness, userRequest } from "./routesHarness.ts";

interface FreeRatings {
  limit: number;
  used: number;
  reserved: number;
  remaining: number;
  availableToReserve: number;
}

interface AccessBody {
  premium: boolean;
  entitlements: string[];
  freeRatings: FreeRatings;
  canStartRating: boolean;
  paywallRequired: boolean;
}

interface SyncBody {
  acceptedIds: string[];
  rejected: Array<{ id: string; code: string; message: string }>;
}

/** Own identity so per-user route budgets never bleed across suites. */
const ATTACK_USER_ID = "44444444-4444-4444-8444-444444444444";
const TOKEN = fakeGoogleIdToken(ATTACK_USER_ID);

let ipCounter = 10;
const nextIp = () => `203.0.113.${ipCounter++}`;

function request(method: string, path: string, body?: unknown): Request {
  return userRequest(method, path, { token: TOKEN, ip: nextIp(), body });
}

/** The invariants apps/mobile/src/billing/accessApi.ts parseAccess enforces;
 * a snapshot violating them is dropped by the client as malformed. */
function assertInvariants(body: AccessBody): void {
  const f = body.freeRatings;
  assertEquals(f.limit, 2);
  assert(f.used >= 0 && f.used <= f.limit, `used ${f.used} within 0..limit`);
  assertEquals(f.remaining, f.limit - f.used);
  assert(f.reserved >= 0 && f.reserved <= f.remaining, `reserved ${f.reserved} <= remaining`);
  assertEquals(f.availableToReserve, f.remaining - f.reserved);
  assertEquals(body.paywallRequired, !body.canStartRating);
  assertEquals(body.premium, body.entitlements.includes("premium"));
}

function syncShot(): Record<string, unknown> {
  return {
    id: crypto.randomUUID(),
    source: "real",
    analysisPermitId: crypto.randomUUID(),
    sessionId: null,
    shotType: "dink",
    cameraView: "side",
    capturedAt: "2026-09-01T10:00:00.000Z",
    timestamps: { startMs: 0, contactMs: 100, endMs: 200 },
    resultKind: "scored",
    overallScore: 7.2,
    confidence: 0.9,
    phases: [],
    checkpoints: [],
    versionVector: {
      appVersion: "1.0.0",
      modelBundleVersion: "bundle-1",
      poseModelVersion: "pose-1",
      paddleModelVersion: "paddle-1",
      strokeDetectorVersion: "stroke-1",
      phaseModelVersion: "phase-1",
      scoringModelVersion: "scoring-1",
      shotConfigVersion: "config-1",
    },
  };
}

// ── GET /v1/me/access: reserved is clamped to REMAINING, not to the limit ────
//
// The existing "stale reservations are clamped" case uses scored_count 0, where
// remaining == limit, so `Math.min(reserved_count, 2)` is indistinguishable
// from `Math.min(reserved_count, remaining)`. A reservation that outlives its
// scored shot (permit still `reserved` while the shot is already counted, or
// a stale permit the cron has not swept yet) is the realistic case, and there
// the wrong clamp yields reserved > remaining and a NEGATIVE availableToReserve
// — which parseAccess rejects, leaving the app without an access snapshot.

Deno.test(
  "access: a reservation outliving its scored shot is clamped to remaining (1 scored + 2 reserved → reserved 1, nothing negative)",
  async () => {
    const h = await loadHarness();
    h.rpcs["access_state"] = [{ premium: false, scored_count: 1, reserved_count: 2 }];
    const res = await h.handler(request("GET", "/v1/me/access"));
    assertEquals(res.status, 200);
    const body = (await res.json()) as AccessBody;
    assertInvariants(body);
    assertEquals(body.freeRatings, {
      limit: 2,
      used: 1,
      reserved: 1,
      remaining: 1,
      availableToReserve: 0,
    });
    assertEquals(body.canStartRating, false);
    assertEquals(body.paywallRequired, true);
  },
);

Deno.test(
  "access: exhausted ledger with a live reservation reports reserved 0 (2 scored + 1 reserved → remaining 0, availableToReserve 0)",
  async () => {
    const h = await loadHarness();
    h.rpcs["access_state"] = [{ premium: false, scored_count: 2, reserved_count: 1 }];
    const res = await h.handler(request("GET", "/v1/me/access"));
    assertEquals(res.status, 200);
    const body = (await res.json()) as AccessBody;
    assertInvariants(body);
    assertEquals(body.freeRatings, {
      limit: 2,
      used: 2,
      reserved: 0,
      remaining: 0,
      availableToReserve: 0,
    });
    assertEquals(body.canStartRating, false);
    assertEquals(body.paywallRequired, true);
  },
);

Deno.test(
  "access: inherited identity history beyond the limit plus stale reservations never goes negative (7 scored + 3 reserved)",
  async () => {
    const h = await loadHarness();
    h.rpcs["access_state"] = [{ premium: false, scored_count: 7, reserved_count: 3 }];
    const res = await h.handler(request("GET", "/v1/me/access"));
    assertEquals(res.status, 200);
    const body = (await res.json()) as AccessBody;
    assertInvariants(body);
    assertEquals(body.freeRatings.used, 2);
    assertEquals(body.freeRatings.reserved, 0);
    assertEquals(body.freeRatings.remaining, 0);
    assertEquals(body.freeRatings.availableToReserve, 0);
    assertEquals(body.canStartRating, false);
  },
);

// ── POST /v1/analysis-permits: ONLY the paywall refusal is a 402 ─────────────

Deno.test(
  "reserve: a non-paywall refusal (auth.required / unknown result) is a generic 503, never a 402 paywall and never a permit",
  async () => {
    for (const result of ["auth.required", "something.unexpected"]) {
      const h = await loadHarness();
      h.rpcs["reserve_analysis_permit"] = [
        {
          result,
          permit_id: null,
          permit_status: null,
          permit_outcome: null,
          permit_created_at: null,
        },
      ];
      const res = await h.handler(
        request("POST", "/v1/analysis-permits", { idempotencyKey: `attack-${result}` }),
      );
      assertEquals(res.status, 503, `result=${result}`);
      const body = (await res.json()) as { error: { code?: string; message: string } };
      assert(body.error.code !== "access.paywall_required", `result=${result} mapped to paywall`);
      assert(!("permit" in body), `result=${result} returned a permit`);
      assert(!body.error.message.includes(result), "raw RPC result must not reach the client");
      assertEquals(
        h.callsTo("/rest/v1/rpc/access_state").length,
        0,
        "no access snapshot on refusal",
      );
    }
  },
);

// ── POST /v1/shots:sync: every permit status maps verbatim, detail never leaks ─

Deno.test(
  "sync: every non-paywall apply_synced_shot status is rejected under ITS OWN code (never accepted, never shot.write_failed)",
  async () => {
    const statuses = [
      "auth.required",
      "access.permit_not_found",
      "access.permit_not_reserved",
      "access.permit_expired",
      "shot.session_not_found",
      "shot.id_conflict",
    ];
    for (const status of statuses) {
      const h = await loadHarness();
      h.tables["shots"] = [];
      h.rpcs["apply_synced_shot"] = status;
      const shot = syncShot();
      const res = await h.handler(request("POST", "/v1/shots:sync", { shots: [shot] }));
      assertEquals(res.status, 200, status);
      const body = (await res.json()) as SyncBody;
      assertEquals(body.acceptedIds, [], status);
      assertEquals(
        body.rejected.map((r) => [r.id, r.code]),
        [[shot.id, status]],
        `status ${status} must be reported verbatim`,
      );
      assert(body.rejected[0].message.length > 0, `${status} carries user copy`);
      assertEquals(h.callsTo("/rest/v1/rpc/apply_synced_shot").length, 1, status);
    }
  },
);

Deno.test(
  "sync: shot.write_failed:<detail> from the RPC is reported with the stable code and generic copy — DB detail never reaches the client",
  async () => {
    const detail = 'duplicate key value violates unique constraint "shots_pkey"';
    const h = await loadHarness();
    h.tables["shots"] = [];
    h.rpcs["apply_synced_shot"] = `shot.write_failed:${detail}`;
    const shot = syncShot();
    const res = await h.handler(request("POST", "/v1/shots:sync", { shots: [shot] }));
    assertEquals(res.status, 200);
    const body = (await res.json()) as SyncBody;
    assertEquals(body.acceptedIds, []);
    assertEquals(body.rejected.length, 1);
    assertEquals(body.rejected[0].id, shot.id);
    assertEquals(body.rejected[0].code, "shot.write_failed");
    assertStringIncludes(body.rejected[0].message, "retry");
    assert(!body.rejected[0].message.includes("shots_pkey"), "DB detail leaked to the client");
    assert(!body.rejected[0].message.includes("shot.write_failed"), "raw status leaked");
    const raw = JSON.stringify(body);
    assert(!raw.includes(detail), "DB detail leaked somewhere in the response");
  },
);
