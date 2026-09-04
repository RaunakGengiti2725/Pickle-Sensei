// Edge-side free-rating arithmetic and refusal mapping, pinned end to end
// through the REAL handler with access_state / reserve_analysis_permit /
// apply_synced_shot stubbed at the PostgREST layer (routesHarness).
//
// Added by the free-rating-ledger mutation campaign
// (tools/mutation/free-rating-ledger): before this file the only edge test
// touching accessPayload() asserted `canStartRating === true` for a premium
// subscriber, so mutants of the clamp / remaining / reserved / paywall
// arithmetic and of the 402 mapping all survived the edge suite. Every case
// below is a killed mutant from that run.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { activeSubscriber, loadHarness, TEST_USER_ID, userRequest } from "./routesHarness.ts";

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

let ipCounter = 40;
const nextIp = () => `198.51.100.${ipCounter++}`;

async function access(state: {
  premium: boolean;
  scored_count: number;
  reserved_count: number;
}): Promise<AccessBody> {
  const h = await loadHarness();
  h.reset();
  h.subscriber = {};
  h.rpcs["access_state"] = [state];
  const res = await h.handler(userRequest("GET", "/v1/me/access", { ip: nextIp() }));
  assertEquals(res.status, 200);
  return (await res.json()) as AccessBody;
}

/** Invariants apps/mobile/src/billing/accessApi.ts parseAccess enforces. */
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

Deno.test("GET /v1/me/access: fresh account → 2 of 2 free ratings available", async () => {
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

Deno.test("GET /v1/me/access: one scored rating → exactly one left", async () => {
  const body = await access({ premium: false, scored_count: 1, reserved_count: 0 });
  assertInvariants(body);
  assertEquals(body.freeRatings.used, 1);
  assertEquals(body.freeRatings.remaining, 1);
  assertEquals(body.freeRatings.availableToReserve, 1);
  assertEquals(body.canStartRating, true);
});

Deno.test("GET /v1/me/access: two scored ratings → paywall, nothing to reserve", async () => {
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
  "GET /v1/me/access: identity ledger above the limit (inherited history) clamps used to 2",
  async () => {
    const body = await access({ premium: false, scored_count: 7, reserved_count: 0 });
    assertInvariants(body);
    assertEquals(body.freeRatings.used, 2);
    assertEquals(body.freeRatings.remaining, 0);
    assertEquals(body.canStartRating, false);
    assertEquals(body.paywallRequired, true);
  },
);

Deno.test(
  "GET /v1/me/access: a live reservation consumes the last slot (1 scored + 1 reserved)",
  async () => {
    const body = await access({ premium: false, scored_count: 1, reserved_count: 1 });
    assertInvariants(body);
    assertEquals(body.freeRatings.used, 1);
    assertEquals(body.freeRatings.reserved, 1);
    assertEquals(body.freeRatings.remaining, 1);
    assertEquals(body.freeRatings.availableToReserve, 0);
    assertEquals(body.canStartRating, false);
    assertEquals(body.paywallRequired, true);
  },
);

Deno.test("GET /v1/me/access: stale reservations are clamped to remaining", async () => {
  const body = await access({ premium: false, scored_count: 0, reserved_count: 5 });
  assertInvariants(body);
  assertEquals(body.freeRatings.reserved, 2);
  assertEquals(body.freeRatings.availableToReserve, 0);
  assertEquals(body.canStartRating, false);
});

Deno.test("GET /v1/me/access: null counters are treated as zero", async () => {
  const body = await access({
    premium: false,
    scored_count: null,
    reserved_count: null,
  } as unknown as {
    premium: boolean;
    scored_count: number;
    reserved_count: number;
  });
  assertInvariants(body);
  assertEquals(body.freeRatings.used, 0);
  assertEquals(body.freeRatings.reserved, 0);
  assertEquals(body.canStartRating, true);
});

Deno.test(
  "GET /v1/me/access: verified premium bypasses an exhausted ledger and lists 'premium'",
  async () => {
    const body = await access({ premium: true, scored_count: 2, reserved_count: 0 });
    assertInvariants(body);
    assertEquals(body.premium, true);
    assertEquals(body.entitlements[0], "premium");
    assertEquals(body.freeRatings.used, 2);
    assertEquals(body.canStartRating, true);
    assertEquals(body.paywallRequired, false);
  },
);

Deno.test(
  "POST /v1/analysis-permits: reserve_analysis_permit → access.paywall_required is a 402 with that code",
  async () => {
    const h = await loadHarness();
    h.reset();
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
      userRequest("POST", "/v1/analysis-permits", {
        ip: nextIp(),
        body: { idempotencyKey: "mutation-paywall-1" },
      }),
    );
    assertEquals(res.status, 402);
    const body = (await res.json()) as { error: { code: string; message: string } };
    assertEquals(body.error.code, "access.paywall_required");
    assertStringIncludes(body.error.message, "Membership");
    assertEquals(h.callsTo("/rest/v1/analysis_permits").length, 0, "no direct permit write");
  },
);

Deno.test(
  "POST /v1/analysis-permits: accepted reservation returns the permit plus the access snapshot",
  async () => {
    const h = await loadHarness();
    h.reset();
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
      userRequest("POST", "/v1/analysis-permits", {
        ip: nextIp(),
        body: { idempotencyKey: "mutation-accept-1" },
      }),
    );
    assertEquals(res.status, 200);
    const body = (await res.json()) as {
      permit: { id: string; status: string };
      access: AccessBody;
    };
    assertEquals(body.permit.id, permitId);
    assertEquals(body.permit.status, "reserved");
    assertInvariants(body.access);
    assertEquals(body.access.freeRatings.reserved, 1);
    assertEquals(body.access.canStartRating, false);
  },
);

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

Deno.test(
  "POST /v1/shots:sync: apply_synced_shot → access.paywall_required rejects the shot with that code (not write_failed)",
  async () => {
    const h = await loadHarness();
    h.reset();
    h.tables["shots"] = [];
    h.rpcs["apply_synced_shot"] = "access.paywall_required";
    const shot = syncShot("scored");
    const res = await h.handler(
      userRequest("POST", "/v1/shots:sync", { ip: nextIp(), body: { shots: [shot] } }),
    );
    assertEquals(res.status, 200);
    const body = (await res.json()) as {
      acceptedIds: string[];
      rejected: Array<{ id: string; code: string; message: string }>;
    };
    assertEquals(body.acceptedIds, []);
    assertEquals(body.rejected.length, 1);
    assertEquals(body.rejected[0].id, shot.id);
    assertEquals(body.rejected[0].code, "access.paywall_required");
    assertStringIncludes(body.rejected[0].message, "Membership");
    const rpc = h.callsTo("/rest/v1/rpc/apply_synced_shot");
    assertEquals(rpc.length, 1);
    const sent = (rpc[0].body as { shot: Record<string, unknown> }).shot;
    assertEquals(sent.resultKind, "scored");
    assertEquals(sent.id, shot.id);
  },
);

Deno.test("POST /v1/shots:sync: accepted scored shot is acknowledged by id", async () => {
  const h = await loadHarness();
  h.reset();
  h.tables["shots"] = [];
  h.rpcs["apply_synced_shot"] = "accepted";
  const shot = syncShot("scored");
  const res = await h.handler(
    userRequest("POST", "/v1/shots:sync", { ip: nextIp(), body: { shots: [shot] } }),
  );
  assertEquals(res.status, 200);
  const body = (await res.json()) as { acceptedIds: string[]; rejected: unknown[] };
  assertEquals(body.acceptedIds, [shot.id]);
  assertEquals(body.rejected, []);
});

Deno.test(
  "POST /v1/billing/sync: verified-premium access keeps the ledger counters (used=2) while unlocking rating",
  async () => {
    const h = await loadHarness();
    h.reset();
    h.subscriber = activeSubscriber();
    h.rpcs["access_state"] = [{ premium: false, scored_count: 2, reserved_count: 0 }];
    const res = await h.handler(userRequest("POST", "/v1/billing/sync", { ip: nextIp() }));
    assertEquals(res.status, 200);
    const body = (await res.json()) as { access: AccessBody };
    assertInvariants(body.access);
    assertEquals(body.access.freeRatings.used, 2);
    assertEquals(body.access.freeRatings.availableToReserve, 0);
    assertEquals(body.access.premium, true);
    assertEquals(body.access.canStartRating, true);
    assertEquals(body.access.paywallRequired, false);
    const rc = h.callsTo("https://api.revenuecat.com/v1/subscribers/");
    assertEquals(rc.length, 1);
    assert(rc[0].url.endsWith(encodeURIComponent(TEST_USER_ID)));
  },
);
