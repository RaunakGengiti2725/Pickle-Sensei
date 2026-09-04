// ADVERSARIAL PASS 3 (mobile-billing-paywall #2) — edge side of S2 and S3,
// run through the REAL handler via routesHarness.
//
//   S2  POST /v1/billing/sync 11× in one minute for ONE user: calls 1–10 must
//       return identical verdicts (200, premium:true, same product/expiry,
//       same access), call 11 must be 429 rate_limited with Retry-After, and
//       RevenueCat / billing_entitlements must be touched exactly 10 times.
//   S3  RevenueCat expires_date === Date.now() EXACTLY (clock frozen so the
//       comparison is a true tie, not "a few ms later") and 'not-a-date' must
//       both yield premium:false in `billing` AND `access`, and the persisted
//       billing_entitlements row must say premium:false too. Boundary control:
//       expires_date === Date.now() + 1 ms must be premium:true.
//
// The recorded responses are pinned against fixtures/billing_sync_replay.json,
// which apps/mobile/__tests__/attack/s2s3EdgeReplay.attack.test.ts replays
// through the mobile parser — so both planes see the same bytes.
//
// Run: deno test -A --no-check --config deno.json attack_billing_pass3/
//   (inside supabase/functions/api/__wf__/)

import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { buildFixture, clockUserId, probeClock, type SyncReplayFixture } from "./syncProbes.ts";

const FIXTURE_PATH = new URL("./fixtures/billing_sync_replay.json", import.meta.url);

let fixturePromise: Promise<SyncReplayFixture> | null = null;
/** One run per process — the 10/min bucket for RATE_USER_ID is per-isolate. */
function live(): Promise<SyncReplayFixture> {
  fixturePromise ??= buildFixture();
  return fixturePromise;
}

async function committedFixture(): Promise<SyncReplayFixture> {
  return JSON.parse(await Deno.readTextFile(FIXTURE_PATH)) as SyncReplayFixture;
}

function stripVolatile(body: unknown): unknown {
  if (!body || typeof body !== "object") return body;
  const record = body as Record<string, unknown>;
  if (!record.billing || typeof record.billing !== "object") return body;
  const { verifiedAt: _v, ...billing } = record.billing as Record<string, unknown>;
  return { ...record, billing };
}

Deno.test(
  "S2 edge: calls 1–10 return one consistent premium verdict; RC + upsert exactly 10×",
  async () => {
    const f = await live();
    assertEquals(f.firstTenVerdicts.length, 10);
    const first = f.firstTenVerdicts[0] as Record<string, Record<string, unknown>>;
    assertEquals(first.billing.premium, true);
    assertEquals(first.billing.productKey, "pickle_sensei_pro_annual");
    assertEquals(first.access.premium, true);
    assertEquals(first.access.canStartRating, true);
    assertEquals(first.access.paywallRequired, false);
    for (const [index, verdict] of f.firstTenVerdicts.entries()) {
      assertEquals(verdict, first, `verdict ${index + 1} drifted from verdict 1`);
    }
  },
);

Deno.test(
  "S2 edge: the 11th call in the minute is 429 rate_limited with a bounded Retry-After",
  async () => {
    const f = await live();
    const r = f.rateLimited;
    assertEquals(r.status, 429);
    const retryAfter = Number(r.headers["retry-after"]);
    assert(
      Number.isInteger(retryAfter) && retryAfter >= 1 && retryAfter <= 60,
      `Retry-After=${r.headers["retry-after"]}`,
    );
    assertEquals(r.headers["ratelimit-limit"], "10");
    assertEquals(r.headers["ratelimit-remaining"], "0");
    assertEquals(r.headers["cache-control"], "no-store");
    const body = r.body as { error: { code: string; message: string } };
    assertEquals(body.error.code, "rate_limited");
    // Copy is user-safe (no internals) and does not claim anything about membership.
    assert(!/premium|entitlement|stack|Error:/i.test(body.error.message), body.error.message);
    // The 429 must NOT carry a billing/access verdict the client could mistake for one.
    assertEquals((r.body as Record<string, unknown>).billing, undefined);
    assertEquals((r.body as Record<string, unknown>).access, undefined);
  },
);

Deno.test(
  "S3 edge: expires_date === Date.now() exactly → premium:false in billing, access AND the persisted row",
  async () => {
    const f = await live();
    const r = f.expiresExactlyNow;
    assertEquals(r.status, 200);
    const body = r.body as { billing: Record<string, unknown>; access: Record<string, unknown> };
    assertEquals(body.billing.premium, false);
    assertEquals(body.billing.productKey, null);
    assertEquals(body.billing.expiresAt, null);
    assertEquals(body.access.premium, false);
    assertEquals(body.access.entitlements, []);
    assertEquals(body.access.paywallRequired, false, "free allowance untouched (0 used)");
    // Re-run live to inspect the persisted verdict (fresh IP, same frozen clock).
    const again = await probeClock(f.frozenNowMs, f.frozenNowIso, "198.51.100.46", clockUserId(10));
    assertEquals(again.persisted?.premium, false);
    assertEquals(again.persisted?.expires_at, null);
  },
);

Deno.test(
  "S3 edge: expires_date 'not-a-date' → premium:false everywhere, 200 (not a 5xx)",
  async () => {
    const f = await live();
    const r = f.expiresNotADate;
    assertEquals(r.status, 200);
    const body = r.body as { billing: Record<string, unknown>; access: Record<string, unknown> };
    assertEquals(body.billing.premium, false);
    assertEquals(body.billing.expiresAt, null, "garbage expiry must not leak to the client");
    assertEquals(body.access.premium, false);
    assertEquals(body.access.entitlements, []);
  },
);

Deno.test(
  "S3 boundary control: expires_date === Date.now() + 1 ms → premium:true (strict > is the rule)",
  async () => {
    const f = await live();
    const r = f.expiresNowPlusOneMs;
    assertEquals(r.status, 200);
    const body = r.body as { billing: Record<string, unknown>; access: Record<string, unknown> };
    assertEquals(body.billing.premium, true);
    assertEquals(body.billing.expiresAt, new Date(f.frozenNowMs + 1).toISOString());
    assertEquals(body.access.premium, true);
    assertNotEquals(body.access.entitlements, []);
  },
);

Deno.test(
  "S3 extras: malformed expires_date shapes never grant membership and never 5xx",
  async () => {
    const f = await live();
    const shapes: Array<[string, unknown]> = [
      ["empty string", ""],
      ["whitespace", "   "],
      ["numeric epoch (not a string)", f.frozenNowMs + 86_400_000],
      ["boolean true", true],
      ["object", { seconds: f.frozenNowMs / 1000 }],
      ["array", [new Date(f.frozenNowMs + 86_400_000).toISOString()]],
      ["fullwidth digits", "２０９９-01-01T00:00:00.000Z"],
      ["'Infinity'", "Infinity"],
      ["ISO with trailing garbage", `${new Date(f.frozenNowMs + 86_400_000).toISOString()}💥`],
      ["1 MiB string", "9".repeat(1 << 20)],
      ["key missing (undefined)", undefined],
    ];
    let n = 50;
    for (const [label, expiresDate] of shapes) {
      const probe = await probeClock(f.frozenNowMs, expiresDate, `198.51.100.${n}`, clockUserId(n));
      n += 1;
      assertEquals(probe.response.status, 200, `${label}: status`);
      const body = probe.response.body as {
        billing: Record<string, unknown>;
        access: Record<string, unknown>;
      };
      assertEquals(body.billing.premium, false, `${label}: billing.premium`);
      assertEquals(body.access.premium, false, `${label}: access.premium`);
      assertEquals(body.billing.expiresAt, null, `${label}: expiresAt leaked`);
      assertEquals(probe.persisted?.premium, false, `${label}: persisted premium`);
    }
  },
);

Deno.test(
  "fixture pin: committed fixtures/billing_sync_replay.json matches the live handler",
  async () => {
    const [liveFixture, committed] = await Promise.all([live(), committedFixture()]);
    assertEquals(committed.frozenNowMs, liveFixture.frozenNowMs);
    assertEquals(committed.rateLimited.status, liveFixture.rateLimited.status);
    assertEquals(committed.rateLimited.body, liveFixture.rateLimited.body);
    assertEquals(
      Object.keys(committed.rateLimited.headers).sort(),
      Object.keys(liveFixture.rateLimited.headers).sort(),
    );
    assertEquals(committed.firstTenVerdicts, liveFixture.firstTenVerdicts);
    assertEquals(
      stripVolatile(committed.expiresExactlyNow.body),
      stripVolatile(liveFixture.expiresExactlyNow.body),
    );
    assertEquals(
      stripVolatile(committed.expiresNotADate.body),
      stripVolatile(liveFixture.expiresNotADate.body),
    );
    assertEquals(
      stripVolatile(committed.expiresNowPlusOneMs.body),
      stripVolatile(liveFixture.expiresNowPlusOneMs.body),
    );
  },
);
