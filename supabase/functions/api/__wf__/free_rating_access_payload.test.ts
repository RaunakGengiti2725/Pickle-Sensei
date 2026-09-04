// Edge-side free-rating arithmetic and refusal mapping, pinned through the
// REAL handler with access_state / reserve_analysis_permit / apply_synced_shot
// stubbed at the PostgREST layer (routesHarness).
//
// Contract under test (index.ts accessPayload / reserveAnalysisPermit /
// syncShots; parsed by apps/mobile/src/billing/accessApi.ts parseAccess):
//   limit = 2 lifetime free ratings
//   used = min(2, scored_count)             identity-lifetime, clamped to the limit
//   remaining = 2 - used
//   reserved = min(reserved_count, remaining) live permits, clamped to remaining
//   availableToReserve = remaining - reserved
//   canStartRating = premium || availableToReserve > 0
//   paywallRequired = !canStartRating
//   reserve_analysis_permit → access.paywall_required ⇒ HTTP 402 with that code
//   apply_synced_shot → access.paywall_required ⇒ shot rejected with that code
//
// Run: deno test -A --no-check --config deno.json   (inside __wf__/)

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { activeSubscriber, fakeGoogleIdToken, loadHarness, userRequest } from "./routesHarness.ts";

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

interface AccessStateRow {
  premium: boolean;
  scored_count: number | null;
  reserved_count: number | null;
}

/** Dedicated identity so per-user route budgets shared with other suites
 * (billing_sync 10/min, permits 30/min, shots_sync 30/min) never bleed in. */
const FREE_RATING_USER_ID = "33333333-3333-4333-8333-333333333333";
const TOKEN = fakeGoogleIdToken(FREE_RATING_USER_ID);

let ipCounter = 100;
const nextIp = () => `198.51.100.${ipCounter++}`;

function request(method: string, path: string, body?: unknown): Request {
  return userRequest(method, path, { token: TOKEN, ip: nextIp(), body });
}

async function access(state: AccessStateRow): Promise<AccessBody> {
  const h = await loadHarness();
  h.rpcs["access_state"] = [state];
  const res = await h.handler(request("GET", "/v1/me/access"));
  assertEquals(res.status, 200);
  return (await res.json()) as AccessBody;
}

/** The invariants parseAccess enforces on every access snapshot. */
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

// ── GET /v1/me/access ────────────────────────────────────────────────────────

Deno.test("access: fresh account → 2 of 2 free ratings available, no paywall", async () => {
  const body = await access({ premium: false, scored_count: 0, reserved_count: 0 });
  assertInvariants(body);
  assertEquals(body.freeRatings, {
    limit: 2,
    used: 0,
    reserved: 0,
    remaining: 2,
    availableToReserve: 2,
  });
  assertEquals(body.canStartRating, true);
  assertEquals(body.paywallRequired, false);
  assertEquals(body.premium, false);
  assertEquals(body.entitlements, []);
});

Deno.test("access: one scored rating → exactly one left (used follows scored_count)", async () => {
  const body = await access({ premium: false, scored_count: 1, reserved_count: 0 });
  assertInvariants(body);
  assertEquals(body.freeRatings, {
    limit: 2,
    used: 1,
    reserved: 0,
    remaining: 1,
    availableToReserve: 1,
  });
  assertEquals(body.canStartRating, true);
  assertEquals(body.paywallRequired, false);
});

Deno.test("access: two scored ratings → paywall, nothing left to reserve", async () => {
  const body = await access({ premium: false, scored_count: 2, reserved_count: 0 });
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
});

Deno.test(
  "access: identity ledger above the limit (inherited history) clamps used to 2, remaining to 0",
  async () => {
    const body = await access({ premium: false, scored_count: 7, reserved_count: 0 });
    assertInvariants(body);
    assertEquals(body.freeRatings.used, 2);
    assertEquals(body.freeRatings.remaining, 0);
    assertEquals(body.freeRatings.availableToReserve, 0);
    assertEquals(body.canStartRating, false);
    assertEquals(body.paywallRequired, true);
  },
);

Deno.test(
  "access: a live reservation occupies the last slot (1 scored + 1 reserved → cannot start)",
  async () => {
    const body = await access({ premium: false, scored_count: 1, reserved_count: 1 });
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
  "access: a single live reservation on a fresh account leaves one to reserve",
  async () => {
    const body = await access({ premium: false, scored_count: 0, reserved_count: 1 });
    assertInvariants(body);
    assertEquals(body.freeRatings.reserved, 1);
    assertEquals(body.freeRatings.availableToReserve, 1);
    assertEquals(body.canStartRating, true);
  },
);

Deno.test("access: stale reservations are clamped to remaining", async () => {
  const body = await access({ premium: false, scored_count: 0, reserved_count: 5 });
  assertInvariants(body);
  assertEquals(body.freeRatings.reserved, 2);
  assertEquals(body.freeRatings.remaining, 2);
  assertEquals(body.freeRatings.availableToReserve, 0);
  assertEquals(body.canStartRating, false);
});

Deno.test("access: null counters are treated as zero", async () => {
  const body = await access({ premium: false, scored_count: null, reserved_count: null });
  assertInvariants(body);
  assertEquals(body.freeRatings.used, 0);
  assertEquals(body.freeRatings.reserved, 0);
  assertEquals(body.freeRatings.availableToReserve, 2);
  assertEquals(body.canStartRating, true);
});

Deno.test(
  "access: verified premium from access_state bypasses an exhausted ledger and lists 'premium'",
  async () => {
    const body = await access({ premium: true, scored_count: 2, reserved_count: 0 });
    assertInvariants(body);
    assertEquals(body.premium, true);
    assertEquals(body.entitlements, ["premium"]);
    assertEquals(body.freeRatings.used, 2);
    assertEquals(body.freeRatings.availableToReserve, 0);
    assertEquals(body.canStartRating, true);
    assertEquals(body.paywallRequired, false);
  },
);

// ── POST /v1/analysis-permits ────────────────────────────────────────────────

Deno.test(
  "reserve: reserve_analysis_permit → access.paywall_required is a 402 carrying that code",
  async () => {
    const h = await loadHarness();
    h.rpcs["reserve_analysis_permit"] = [
      {
        result: "access.paywall_required",
        permit_id: null,
        permit_status: null,
        permit_outcome: null,
        permit_created_at: null,
      },
    ];
    const res = await h.handler(
      request("POST", "/v1/analysis-permits", { idempotencyKey: "free-rating-paywall-1" }),
    );
    assertEquals(res.status, 402);
    const body = (await res.json()) as { error: { code: string; message: string } };
    assertEquals(body.error.code, "access.paywall_required");
    assertStringIncludes(body.error.message, "Membership");
    assertEquals(h.callsTo("/rest/v1/rpc/reserve_analysis_permit").length, 1);
    assertEquals(h.callsTo("/rest/v1/analysis_permits").length, 0, "no direct permit write");
    assertEquals(h.callsTo("/rest/v1/rpc/access_state").length, 0, "no access snapshot on refusal");
  },
);

Deno.test("reserve: accepted reservation returns the permit plus the access snapshot", async () => {
  const h = await loadHarness();
  const permitId = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  h.rpcs["reserve_analysis_permit"] = [
    {
      result: "accepted",
      permit_id: permitId,
      permit_status: "reserved",
      permit_outcome: null,
      permit_created_at: createdAt,
    },
  ];
  h.rpcs["access_state"] = [{ premium: false, scored_count: 1, reserved_count: 1 }];
  const res = await h.handler(
    request("POST", "/v1/analysis-permits", { idempotencyKey: "free-rating-accept-1" }),
  );
  assertEquals(res.status, 200);
  const body = (await res.json()) as {
    permit: { id: string; status: string; accessSource: string };
    access: AccessBody;
  };
  assertEquals(body.permit.id, permitId);
  assertEquals(body.permit.status, "reserved");
  assertEquals(body.permit.accessSource, "free");
  assertInvariants(body.access);
  assertEquals(body.access.freeRatings.used, 1);
  assertEquals(body.access.freeRatings.reserved, 1);
  assertEquals(body.access.freeRatings.availableToReserve, 0);
  assertEquals(body.access.canStartRating, false);
});

// ── POST /v1/shots:sync ──────────────────────────────────────────────────────

function syncShot(resultKind: "scored" | "low_confidence"): Record<string, unknown> {
  return {
    id: crypto.randomUUID(),
    source: "real",
    analysisPermitId: crypto.randomUUID(),
    sessionId: null,
    shotType: "dink",
    cameraView: "side",
    capturedAt: "2026-09-01T10:00:00.000Z",
    timestamps: { startMs: 0, contactMs: 100, endMs: 200 },
    resultKind,
    overallScore: resultKind === "scored" ? 7.2 : null,
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

interface SyncBody {
  acceptedIds: string[];
  rejected: Array<{ id: string; code: string; message: string }>;
}

Deno.test(
  "sync: apply_synced_shot → access.paywall_required rejects the shot with that code, never as accepted or write_failed",
  async () => {
    const h = await loadHarness();
    h.tables["shots"] = [];
    h.rpcs["apply_synced_shot"] = "access.paywall_required";
    const shot = syncShot("scored");
    const res = await h.handler(request("POST", "/v1/shots:sync", { shots: [shot] }));
    assertEquals(res.status, 200);
    const body = (await res.json()) as SyncBody;
    assertEquals(body.acceptedIds, []);
    assertEquals(body.rejected.length, 1);
    assertEquals(body.rejected[0].id, shot.id);
    assertEquals(body.rejected[0].code, "access.paywall_required");
    assertStringIncludes(body.rejected[0].message, "Membership");
    const rpc = h.callsTo("/rest/v1/rpc/apply_synced_shot");
    assertEquals(rpc.length, 1);
    const sent = (rpc[0].body as { shot: Record<string, unknown> }).shot;
    assertEquals(sent.id, shot.id);
    assertEquals(sent.resultKind, "scored");
  },
);

Deno.test("sync: accepted scored shot is acknowledged by id with nothing rejected", async () => {
  const h = await loadHarness();
  h.tables["shots"] = [];
  h.rpcs["apply_synced_shot"] = "accepted";
  const shot = syncShot("scored");
  const res = await h.handler(request("POST", "/v1/shots:sync", { shots: [shot] }));
  assertEquals(res.status, 200);
  const body = (await res.json()) as SyncBody;
  assertEquals(body.acceptedIds, [shot.id]);
  assertEquals(body.rejected, []);
});

Deno.test(
  "sync: a refused shot and an accepted shot are reported apart, one RPC each",
  async () => {
    const h = await loadHarness();
    h.tables["shots"] = [];
    const refused = syncShot("scored");
    const accepted = syncShot("low_confidence");
    // The stub answers every apply_synced_shot with one status, so the two
    // outcomes go through two requests.
    h.rpcs["apply_synced_shot"] = "access.paywall_required";
    const first = (await (
      await h.handler(request("POST", "/v1/shots:sync", { shots: [refused] }))
    ).json()) as SyncBody;
    h.rpcs["apply_synced_shot"] = "accepted";
    const second = (await (
      await h.handler(request("POST", "/v1/shots:sync", { shots: [accepted] }))
    ).json()) as SyncBody;
    assertEquals(first.acceptedIds, []);
    assertEquals(
      first.rejected.map((r) => [r.id, r.code]),
      [[refused.id, "access.paywall_required"]],
    );
    assertEquals(second.acceptedIds, [accepted.id]);
    assertEquals(second.rejected, []);
    assertEquals(h.callsTo("/rest/v1/rpc/apply_synced_shot").length, 2);
  },
);

// ── POST /v1/billing/sync ────────────────────────────────────────────────────

Deno.test(
  "billing sync: a verified entitlement unlocks rating while the ledger counters stay honest (used=2)",
  async () => {
    const h = await loadHarness();
    h.subscriber = activeSubscriber();
    h.rpcs["access_state"] = [{ premium: false, scored_count: 2, reserved_count: 0 }];
    const res = await h.handler(request("POST", "/v1/billing/sync"));
    assertEquals(res.status, 200);
    const body = (await res.json()) as { access: AccessBody };
    assertInvariants(body.access);
    assertEquals(body.access.premium, true);
    assertEquals(body.access.entitlements[0], "premium");
    assertEquals(body.access.freeRatings.used, 2);
    assertEquals(body.access.freeRatings.availableToReserve, 0);
    assertEquals(body.access.canStartRating, true);
    assertEquals(body.access.paywallRequired, false);
    const rc = h.callsTo("https://api.revenuecat.com/v1/subscribers/");
    assertEquals(rc.length, 1);
    assert(rc[0].url.endsWith(encodeURIComponent(FREE_RATING_USER_ID)));
  },
);
