// ADVERSARIAL PASS 3 (mobile-billing-paywall #2) — shared probes for
// POST /v1/billing/sync run through the REAL edge handler (routesHarness).
//
// The probes return plain JSON so the SAME bytes can be (a) asserted here in
// Deno and (b) replayed into the mobile parser (apps/mobile/src/billing/
// accessApi.ts) from jest via fixtures/billing_sync_replay.json — the mobile
// suite never invents a server response shape.
//
// Run: deno test -A --no-check --config deno.json attack_billing_pass3/
//   (inside supabase/functions/api/__wf__/)

import {
  activeSubscriber,
  fakeGoogleIdToken,
  loadHarness,
  RC_URL,
  userRequest,
} from "../routesHarness.ts";

/** Distinct from TEST_USER_ID / OTHER_USER_ID so the per-user 10/min
 * billing_sync bucket (per-isolate memory) is not shared with
 * drills_billing_healthz.test.ts, which already spends OTHER_USER_ID's. */
export const RATE_USER_ID = "33333333-3333-4333-8333-333333333333";
/** One user per clock probe: the 10/min billing_sync budget is per user, so
 * a shared id would turn the 11th malformed-expiry probe into a 429. */
export function clockUserId(index: number): string {
  const tail = String(index).padStart(12, "0");
  return `44444444-4444-4444-8444-${tail}`;
}
export const ACCESS_ROW = [{ premium: false, scored_count: 0, reserved_count: 0 }];
/** Fixed far-future expiry so the recorded verdicts are byte-stable. */
export const RATE_EXPIRES_AT = "2099-01-01T00:00:00.000Z";

export interface RecordedResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

export interface SyncReplayFixture {
  /** Frozen `Date.now()` used for the exact-equality clock probes. */
  frozenNowMs: number;
  frozenNowIso: string;
  /** S2 — the 11th call within one minute for one user. */
  rateLimited: RecordedResponse;
  /** S2 — the first ten verdicts (verifiedAt stripped; must be identical). */
  firstTenVerdicts: unknown[];
  /** S3 — expires_date === Date.now() exactly. */
  expiresExactlyNow: RecordedResponse;
  /** S3 — expires_date 'not-a-date'. */
  expiresNotADate: RecordedResponse;
  /** boundary control — expires_date === Date.now() + 1 ms (must be premium). */
  expiresNowPlusOneMs: RecordedResponse;
}

async function record(response: Response): Promise<RecordedResponse> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => (headers[key.toLowerCase()] = value));
  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // keep raw text
  }
  return { status: response.status, headers, body };
}

function stripVerifiedAt(body: unknown): unknown {
  if (!body || typeof body !== "object") return body;
  const record = body as Record<string, unknown>;
  const billing = record.billing;
  if (!billing || typeof billing !== "object") return body;
  const { verifiedAt: _ignored, ...rest } = billing as Record<string, unknown>;
  return { ...record, billing: rest };
}

export async function probeRateLimit(): Promise<{
  firstTen: RecordedResponse[];
  eleventh: RecordedResponse;
  rcCalls: number;
  upserts: number;
}> {
  const h = await loadHarness();
  h.subscriber = activeSubscriber(RATE_EXPIRES_AT, "pickle_sensei_pro_annual");
  h.rpcs["access_state"] = ACCESS_ROW;
  const token = fakeGoogleIdToken(RATE_USER_ID);
  const firstTen: RecordedResponse[] = [];
  let eleventh: RecordedResponse | null = null;
  for (let i = 0; i < 11; i += 1) {
    const res = await h.handler(
      userRequest("POST", "/v1/billing/sync", { ip: "198.51.100.42", token }),
    );
    const recorded = await record(res);
    if (i < 10) firstTen.push(recorded);
    else eleventh = recorded;
  }
  return {
    firstTen,
    eleventh: eleventh!,
    rcCalls: h.callsTo(RC_URL).length,
    upserts: h.callsTo("/rest/v1/billing_entitlements").length,
  };
}

/** Runs ONE sync with `Date.now` frozen at `frozenNowMs` and the given
 * RevenueCat expires_date. Restores the clock afterwards. */
export async function probeClock(
  frozenNowMs: number,
  expiresDate: unknown,
  ip: string,
  userId: string,
): Promise<{ response: RecordedResponse; persisted: Record<string, unknown> | null }> {
  const h = await loadHarness();
  h.subscriber = {
    entitlements: {
      pickle_sensei_pro: {
        expires_date: expiresDate,
        product_identifier: "pickle_sensei_pro_monthly",
      },
    },
  };
  h.rpcs["access_state"] = ACCESS_ROW;
  const token = fakeGoogleIdToken(userId);
  const realNow = Date.now;
  Date.now = () => frozenNowMs;
  try {
    const res = await h.handler(userRequest("POST", "/v1/billing/sync", { ip, token }));
    const response = await record(res);
    const upsert = h.callsTo("/rest/v1/billing_entitlements")[0];
    const persisted =
      upsert && upsert.body && typeof upsert.body === "object"
        ? (upsert.body as Record<string, unknown>)
        : null;
    return { response, persisted };
  } finally {
    Date.now = realNow;
  }
}

export async function buildFixture(): Promise<SyncReplayFixture> {
  const rate = await probeRateLimit();
  // A fixed instant (ms precision survives toISOString → Date.parse exactly).
  const frozenNowMs = Date.UTC(2026, 8, 4, 12, 0, 0, 123);
  const frozenNowIso = new Date(frozenNowMs).toISOString();
  const exact = await probeClock(frozenNowMs, frozenNowIso, "198.51.100.43", clockUserId(1));
  const notADate = await probeClock(frozenNowMs, "not-a-date", "198.51.100.44", clockUserId(2));
  const plusOne = await probeClock(
    frozenNowMs,
    new Date(frozenNowMs + 1).toISOString(),
    "198.51.100.45",
    clockUserId(3),
  );
  return {
    frozenNowMs,
    frozenNowIso,
    rateLimited: rate.eleventh,
    firstTenVerdicts: rate.firstTen.map((r) => stripVerifiedAt(r.body)),
    expiresExactlyNow: exact.response,
    expiresNotADate: notADate.response,
    expiresNowPlusOneMs: plusOne.response,
  };
}
