// Adversarial pass #4 (pass 3 of 3) — edge domain routes, black-box through
// the REAL Edge handler (routesHarness.ts). Every scenario below is an attack
// against supabase/functions/api/index.ts at 4d812e1a: stale bearer vs the
// auth cache, and the shots:sync route (parser boundaries, duplicate ids,
// RPC status sanitisation, replay SELECT failure, rank/progress cache
// invalidation).
//
// Run:  cd supabase/functions/api/__wf__ && deno test -A --no-check --config deno.json attack_edge_domain_routes_4.test.ts
//
// Conventions:
//   * the harness never opens a port and never touches a real Supabase
//     project — PostgREST / Auth are the harness's fake fetch;
//   * `harness.rpcs["apply_synced_shot"]` is the RPC stub; per-call responses
//     (e.g. accepted for one id, id_conflict for another) go through
//     `withFetchOverride`, which still records the call in `harness.calls`;
//   * rank/progress cache invalidation is observed by EFFECT: prime GET
//     /v1/rank + /v1/progress (they hit PostgREST once, then serve from the
//     in-process cache), sync, and count whether the next GET hits PostgREST
//     again. cache.ts has no Redis in the harness, so cacheDel is memory-only.
//   * Tests that document a defect (not merely a hardening wish) are named
//     "BROKEN: …" and assert the OBSERVED behaviour so the branch stays green
//     and the assertion flips when the defect is fixed.

import { assert, assertEquals, assertNotEquals, assertStringIncludes } from "@std/assert";
import {
  fakeGoogleIdToken,
  type Harness,
  loadHarness,
  SUPABASE_URL,
  TEST_USER_ID,
  userRequest,
} from "./routesHarness.ts";
import { cacheDel, cacheGet, cacheSet, sha256Hex } from "../cache.ts";
import { peekRateLimit } from "../rateLimit.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Seeded randomness (recorded in the artifact log)
// ─────────────────────────────────────────────────────────────────────────────

const SEED = Number(Deno.env.get("ATTACK4_SEED") ?? "20260904");
let rngState = SEED >>> 0;
function rand(): number {
  // mulberry32
  rngState = (rngState + 0x6d2b79f5) >>> 0;
  let t = rngState;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
function hex(n: number): string {
  let out = "";
  for (let i = 0; i < n; i++) out += Math.floor(rand() * 16).toString(16);
  return out;
}
/** RFC-4122 v4 shaped uuid from the seeded generator. */
function uuid(): string {
  return `${hex(8)}-${hex(4)}-4${hex(3)}-${"89ab"[Math.floor(rand() * 4)]}${hex(3)}-${hex(12)}`;
}
console.log(`[attack4] seed=${SEED}`);

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

// shots:sync has a 30/min PER-USER budget, so every test mints its own user
// (the harness derives the Supabase user id from the id token's `sub`).
interface User {
  id: string;
  token: string;
}
function newUser(): User {
  const id = uuid();
  return { id, token: fakeGoogleIdToken(id) };
}
const SYNC_PATH = "/v1/shots:sync";
const MAX_MS = 2_147_483_647;

type Json = Record<string, unknown>;

function validShot(overrides: Json = {}): Json {
  return {
    id: uuid(),
    analysisPermitId: uuid(),
    sessionId: null,
    shotType: "dink",
    cameraView: "side",
    capturedAt: "2026-09-04T12:00:00.000Z",
    timestamps: { startMs: 100, contactMs: 400, endMs: 900 },
    overallScore: 7.25,
    confidence: 0.9,
    resultKind: "scored",
    source: "real",
    phases: [
      { key: "preparation", startMs: 100, endMs: 400, representativeMs: 250, confidence: 0.9 },
      { key: "contact", startMs: 400, endMs: 600, representativeMs: 500, confidence: 0.9 },
    ],
    checkpoints: [
      {
        key: "athletic_base",
        score: 0.8,
        confidence: 0.9,
        band: "green",
        direction: "hold",
        severity: 0.1,
        applicable: true,
      },
    ],
    versionVector: {
      appVersion: "1.0.0",
      modelBundleVersion: "b1",
      poseModelVersion: "p1",
      paddleModelVersion: "pd1",
      strokeDetectorVersion: "sd1",
      phaseModelVersion: "ph1",
      scoringModelVersion: "s1",
      shotConfigVersion: "sc1",
    },
    ...overrides,
  };
}

interface SyncResponse {
  status: number;
  body: {
    acceptedIds?: string[];
    rejected?: Array<{ id: string; code: string; message: string }>;
    error?: { code?: string; message: string };
  };
  text: string;
}

async function sync(
  h: Harness,
  shots: unknown,
  user: User,
  ip = `10.4.${Math.floor(rand() * 250)}.${Math.floor(rand() * 250)}`,
): Promise<SyncResponse> {
  const res = await h.handler(
    userRequest("POST", SYNC_PATH, { token: user.token, ip, body: { shots } }),
  );
  const text = await res.text();
  let body: SyncResponse["body"] = {};
  try {
    body = JSON.parse(text);
  } catch {
    body = { error: { message: text } };
  }
  return { status: res.status, body, text };
}

const rpcCalls = (h: Harness) => h.callsTo("/rest/v1/rpc/apply_synced_shot");
const rpcShotId = (c: { body: unknown }): string => String(((c.body as Json).shot as Json).id);
const replaySelects = (h: Harness) =>
  h.calls.filter((c) => c.method === "GET" && c.url.includes("/rest/v1/shots?"));

/** Wrap the harness fetch for one test. `override` returns a Response to
 * short-circuit (the call is still recorded in `h.calls`) or null to defer
 * to the harness's fake Supabase. */
async function withFetchOverride<T>(
  h: Harness,
  override: (req: Request, body: string) => Response | null | Promise<Response | null>,
  run: () => Promise<T>,
): Promise<T> {
  const inner = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const body = await req.clone().text();
    const short = await override(req.clone(), body);
    if (short) {
      h.calls.push({
        url: req.url,
        method: req.method,
        headers: Object.fromEntries(req.headers.entries()),
        body,
      });
      return short;
    }
    return inner(req);
  }) as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = inner;
  }
}

const pgError = (status: number, message: string, code = "XX000") =>
  new Response(JSON.stringify({ code, message, details: null, hint: null }), {
    status,
    headers: { "content-type": "application/json" },
  });

const rpcOk = (status: string) =>
  new Response(JSON.stringify(status), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

/** Prime rank + progress caches for TEST_USER_ID and prove they serve from
 * memory. Returns a probe that reports how many PostgREST reads the next
 * GET /v1/rank + GET /v1/progress trigger (0 = cache warm, >0 = invalidated). */
async function primeRankProgressCache(h: Harness, user: User): Promise<() => Promise<number>> {
  await cacheDel(`rank:${user.id}`, `progress:${user.id}`);
  h.tables["player_technique_rating"] = [];
  h.tables["player_rank_state"] = [];
  h.tables["progress_daily"] = [];
  h.tables["practice_days"] = [];
  const probe = async (): Promise<number> => {
    const before = h.calls.length;
    const rank = await h.handler(userRequest("GET", "/v1/rank", { token: user.token }));
    const progress = await h.handler(userRequest("GET", "/v1/progress", { token: user.token }));
    assertEquals(rank.status, 200);
    assertEquals(progress.status, 200);
    await rank.text();
    await progress.text();
    return h.calls
      .slice(before)
      .filter(
        (c) =>
          c.method === "GET" &&
          /\/rest\/v1\/(player_technique_rating|player_rank_state|progress_daily|practice_days)/.test(
            c.url,
          ),
      ).length;
  };
  const cold = await probe();
  assert(cold >= 4, `expected cold reads for rank+progress, saw ${cold}`);
  const warm = await probe();
  assertEquals(warm, 0, "rank/progress must be served from cache after priming");
  return probe;
}

function freshHarness(h: Harness): void {
  h.reset();
  h.rpcs["apply_synced_shot"] = "accepted";
  h.tables["shots"] = [];
}

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 1 — stale session: expired bearer with a live auth:<hash> cache row
// ─────────────────────────────────────────────────────────────────────────────

function b64url(input: string): string {
  return btoa(input).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fakeJwt(payload: Json): string {
  return `${b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }))}.${b64url(JSON.stringify(payload))}.sig`;
}
async function primeAuthCache(token: string, accessToken: string): Promise<string> {
  const key = `auth:${await sha256Hex(token)}`;
  await cacheSet(
    key,
    JSON.stringify({
      id: TEST_USER_ID,
      email: "stale@example.test",
      provider: "google",
      accessToken,
      expiresAtMs: Date.now() + 300_000,
    }),
    300,
  );
  return key;
}

Deno.test(
  "S1 control: unexpired Supabase-issued bearer with a warm auth cache row is served from cache (no Auth round trip)",
  async () => {
    const h = await loadHarness();
    h.reset();
    const now = Math.floor(Date.now() / 1000);
    const token = fakeJwt({ iss: `${SUPABASE_URL}/auth/v1`, sub: TEST_USER_ID, exp: now + 600 });
    await primeAuthCache(token, "cached-access-token-control");
    h.tables["consent_records"] = [];
    const res = await h.handler(
      userRequest("GET", "/v1/me/consent/status", { token, ip: "10.1.0.1" }),
    );
    assertEquals(res.status, 200, await res.clone().text());
    await res.text();
    assertEquals(h.callsTo("/auth/v1/").length, 0, "cache hit must not call Supabase Auth");
    const rest = h.callsTo("/rest/v1/");
    assert(rest.length >= 1);
    for (const c of rest) {
      assertEquals(c.headers["authorization"], "Bearer cached-access-token-control");
    }
  },
);

Deno.test(
  "S1 HELD: expired Supabase-issued bearer is refused (401) even though auth:<hash> is within TTL, no upstream call, and it charges the authfail budget",
  async () => {
    const h = await loadHarness();
    h.reset();
    const ip = "10.1.0.2";
    const now = Math.floor(Date.now() / 1000);
    const token = fakeJwt({ iss: `${SUPABASE_URL}/auth/v1`, sub: TEST_USER_ID, exp: now - 60 });
    const key = await primeAuthCache(token, "cached-access-token-stale");
    assert(await cacheGet(key), "precondition: cache row present");
    h.tables["consent_records"] = [];

    const before = await peekRateLimit("authfail", ip, 30, 300);
    assertEquals(before.remaining, 30);

    const res = await h.handler(userRequest("GET", "/v1/me/consent/status", { token, ip }));
    const body = await res.json();
    assertEquals(res.status, 401);
    assertEquals(body.error.message, "The session token has expired.");
    assertEquals(h.calls.length, 0, "expired bearer must not reach Auth or PostgREST");
    // The cache row is intact (nothing read/wrote it) yet was NOT honoured.
    assert(await cacheGet(key));

    const after = await peekRateLimit("authfail", ip, 30, 300);
    assertEquals(after.remaining, 29, "the stale-bearer 401 must count toward authfail");
  },
);

Deno.test(
  "S1 HELD: expired Google/Apple id token with a warm cache row → 401 identity-token message, no signInWithIdToken, counted",
  async () => {
    const h = await loadHarness();
    h.reset();
    const ip = "10.1.0.3";
    const now = Math.floor(Date.now() / 1000);
    for (const iss of ["https://accounts.google.com", "https://appleid.apple.com"]) {
      const token = fakeJwt({ iss, sub: "provider-sub", exp: now - 1 });
      await primeAuthCache(token, "cached-access-token-idtoken");
      const res = await h.handler(userRequest("GET", "/v1/me", { token, ip }));
      const body = await res.json();
      assertEquals(res.status, 401);
      assertEquals(body.error.message, "The identity token has expired.");
    }
    assertEquals(h.calls.length, 0);
    const after = await peekRateLimit("authfail", ip, 30, 300);
    assertEquals(after.remaining, 28);
  },
);

Deno.test(
  "S1 HELD: exp boundary — exp == now is expired (<=), exp == now+1s is honoured via the cache",
  async () => {
    const h = await loadHarness();
    h.reset();
    h.tables["consent_records"] = [];
    const nowMs = Date.now();
    const nowSec = Math.floor(nowMs / 1000);
    const boundary = fakeJwt({ iss: `${SUPABASE_URL}/auth/v1`, sub: TEST_USER_ID, exp: nowSec });
    await primeAuthCache(boundary, "x");
    const r1 = await h.handler(
      userRequest("GET", "/v1/me/consent/status", { token: boundary, ip: "10.1.0.4" }),
    );
    assertEquals(r1.status, 401);
    await r1.text();
    const soon = fakeJwt({ iss: `${SUPABASE_URL}/auth/v1`, sub: TEST_USER_ID, exp: nowSec + 2 });
    await primeAuthCache(soon, "cached-soon");
    const r2 = await h.handler(
      userRequest("GET", "/v1/me/consent/status", { token: soon, ip: "10.1.0.4" }),
    );
    assertEquals(r2.status, 200, await r2.clone().text());
    await r2.text();
  },
);

Deno.test(
  "S1 HELD: 30 stale-bearer 401s from one IP exhaust the authfail budget — the 31st request is 429 before authentication even for a cache-warm valid token",
  async () => {
    const h = await loadHarness();
    h.reset();
    h.tables["consent_records"] = [];
    const ip = "10.1.0.5";
    const now = Math.floor(Date.now() / 1000);
    const stale = fakeJwt({
      iss: `${SUPABASE_URL}/auth/v1`,
      sub: TEST_USER_ID,
      exp: now - 5,
      jti: uuid(),
    });
    await primeAuthCache(stale, "stale");
    // Rapid repeats — fire all 30 concurrently.
    const results = await Promise.all(
      Array.from({ length: 30 }, () =>
        h
          .handler(userRequest("GET", "/v1/me/consent/status", { token: stale, ip }))
          .then(async (r) => {
            await r.text();
            return r.status;
          }),
      ),
    );
    assertEquals(
      results.every((s) => s === 401),
      true,
      JSON.stringify(results),
    );
    const valid = fakeJwt({
      iss: `${SUPABASE_URL}/auth/v1`,
      sub: TEST_USER_ID,
      exp: now + 600,
      jti: uuid(),
    });
    await primeAuthCache(valid, "valid-cached");
    const r = await h.handler(userRequest("GET", "/v1/me/consent/status", { token: valid, ip }));
    assertEquals(r.status, 429, await r.clone().text());
    await r.text();
    assertEquals(h.calls.length, 0, "no upstream traffic across the whole burst");
    // Same valid token from another IP is fine (budget is per-IP).
    const r2 = await h.handler(
      userRequest("GET", "/v1/me/consent/status", { token: valid, ip: "10.1.0.6" }),
    );
    assertEquals(r2.status, 200);
    await r2.text();
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 2 — same shot id twice in one batch
// ─────────────────────────────────────────────────────────────────────────────

Deno.test(
  "S2 BROKEN: duplicate shot id inside one batch triggers TWO apply_synced_shot RPCs and echoes the id twice in acceptedIds",
  async () => {
    const h = await loadHarness();
    freshHarness(h);
    const user = newUser();
    const shot = validShot();
    const res = await sync(h, [shot, shot], user);
    assertEquals(res.status, 200, res.text);
    assertEquals(replaySelects(h).length, 1, "one batched replay SELECT");
    assertEquals(res.body.rejected, []);
    // OBSERVED (defect): the second copy is not de-duplicated before the RPC loop.
    assertEquals(rpcCalls(h).length, 2, "observed: RPC issued per copy");
    assertEquals(res.body.acceptedIds, [shot.id, shot.id], "observed: id echoed twice");
  },
);

Deno.test(
  "S2 BROKEN(variant): duplicate id where copy #1 is malformed and copy #2 valid → same id in BOTH acceptedIds and rejected",
  async () => {
    const h = await loadHarness();
    freshHarness(h);
    const user = newUser();
    const good = validShot();
    const bad = { ...good, cameraView: "front" };
    const res = await sync(h, [bad, good], user);
    assertEquals(res.status, 200, res.text);
    assertEquals(res.body.acceptedIds, [good.id]);
    assertEquals(
      res.body.rejected?.map((r) => r.id),
      [good.id],
    );
    assertEquals(rpcCalls(h).length, 1);
  },
);

Deno.test(
  "S2 HELD: duplicate id that already exists server-side (replay) is acknowledged without ANY RPC — even twice in the batch",
  async () => {
    const h = await loadHarness();
    freshHarness(h);
    const user = newUser();
    const shot = validShot();
    h.tables["shots"] = [{ id: shot.id }];
    const res = await sync(h, [shot, shot], user);
    assertEquals(res.status, 200, res.text);
    assertEquals(rpcCalls(h).length, 0);
    assertEquals(res.body.acceptedIds, [shot.id, shot.id]);
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 3 — endMs boundary and timestamp ordering
// ─────────────────────────────────────────────────────────────────────────────

Deno.test(
  "S3 HELD: endMs=2147483647 passes; endMs=2147483648 is a per-shot rejection (no RPC) and the batch stays 200",
  async () => {
    const h = await loadHarness();
    freshHarness(h);
    const user = newUser();
    const ok = validShot({ timestamps: { startMs: 0, contactMs: 5, endMs: MAX_MS } });
    const over = validShot({ timestamps: { startMs: 0, contactMs: 5, endMs: MAX_MS + 1 } });
    const res = await sync(h, [over, ok], user);
    assertEquals(res.status, 200, res.text);
    assertEquals(res.body.acceptedIds, [ok.id]);
    assertEquals(res.body.rejected?.length, 1);
    assertEquals(res.body.rejected?.[0].id, over.id);
    assertEquals(res.body.rejected?.[0].code, "shot.invalid_payload");
    assertStringIncludes(res.body.rejected?.[0].message ?? "", "timestamps");
    assertEquals(rpcCalls(h).length, 1);
    assertEquals(rpcShotId(rpcCalls(h)[0]), ok.id);
    // Never a batch-level 400 for a per-shot bound.
    assertNotEquals(res.body.error?.code, "validation.shots_sync");
  },
);

Deno.test(
  "S3 HELD: other numeric shapes in timestamps (negative, float, string, 2^31 as float, NaN, missing) are per-shot rejections",
  async () => {
    const h = await loadHarness();
    freshHarness(h);
    const user = newUser();
    const bads = [
      validShot({ timestamps: { startMs: -1, contactMs: 5, endMs: 9 } }),
      validShot({ timestamps: { startMs: 0.5, contactMs: 5, endMs: 9 } }),
      validShot({ timestamps: { startMs: "0", contactMs: 5, endMs: 9 } }),
      validShot({ timestamps: { startMs: 0, contactMs: 5, endMs: 2147483648.0 } }),
      validShot({ timestamps: { startMs: 0, contactMs: 5 } }),
      validShot({ timestamps: { startMs: 0, contactMs: undefined, endMs: 9 } }),
      validShot({ timestamps: null }),
      validShot({ timestamps: [0, 5, 9] }),
    ];
    const res = await sync(h, bads, user);
    assertEquals(res.status, 200, res.text);
    assertEquals(res.body.acceptedIds, []);
    assertEquals(res.body.rejected?.length, bads.length);
    assertEquals(rpcCalls(h).length, 0);
    for (const r of res.body.rejected ?? []) assertEquals(r.code, "shot.invalid_payload");
  },
);

Deno.test(
  "S3 BROKEN: timestamp ordering violations (startMs>contactMs, contactMs>endMs, startMs>endMs) are ACCEPTED by the parser and forwarded to the RPC",
  async () => {
    const h = await loadHarness();
    freshHarness(h);
    const user = newUser();
    const startAfterContact = validShot({
      timestamps: { startMs: 500, contactMs: 100, endMs: 900 },
    });
    const contactAfterEnd = validShot({ timestamps: { startMs: 0, contactMs: 950, endMs: 900 } });
    const startAfterEnd = validShot({ timestamps: { startMs: 950, contactMs: null, endMs: 900 } });
    const phaseInverted = validShot({
      phases: [
        { key: "preparation", startMs: 900, endMs: 100, representativeMs: 5000, confidence: 0.9 },
      ],
    });
    const res = await sync(
      h,
      [startAfterContact, contactAfterEnd, startAfterEnd, phaseInverted],
      user,
    );
    assertEquals(res.status, 200, res.text);
    // Never a batch 400 — HELD part of the scenario.
    assertNotEquals(res.body.error?.code, "validation.shots_sync");
    // OBSERVED (defect): all four are accepted; expected per-shot shot.invalid_payload with no RPC.
    assertEquals(res.body.rejected, []);
    assertEquals(res.body.acceptedIds?.length, 4);
    assertEquals(rpcCalls(h).length, 4);
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 4 — phases / checkpoints cardinality and duplicate keys
// ─────────────────────────────────────────────────────────────────────────────

const phase = (i: number) => ({
  key: `phase_${i}`,
  startMs: i,
  endMs: i + 1,
  representativeMs: i,
  confidence: 0.5,
});
const checkpoint = (i: number) => ({
  key: `cp_${i}`,
  score: 0.5,
  confidence: 0.5,
  band: "yellow",
  direction: "hold",
  severity: 0.5,
  applicable: true,
});

Deno.test(
  "S4 HELD: 33 phases / 65 checkpoints / duplicate phase key / duplicate checkpoint key → per-shot shot.invalid_payload naming phases|checkpoints, zero RPC; 32/64 pass",
  async () => {
    const h = await loadHarness();
    freshHarness(h);
    const user = newUser();
    const p33 = validShot({ phases: Array.from({ length: 33 }, (_, i) => phase(i)) });
    const c65 = validShot({ checkpoints: Array.from({ length: 65 }, (_, i) => checkpoint(i)) });
    const dupPhase = validShot({ phases: [phase(1), { ...phase(2), key: "phase_1" }] });
    const dupCp = validShot({ checkpoints: [checkpoint(1), { ...checkpoint(2), key: "cp_1" }] });
    const p32 = validShot({ phases: Array.from({ length: 32 }, (_, i) => phase(i)) });
    const c64 = validShot({ checkpoints: Array.from({ length: 64 }, (_, i) => checkpoint(i)) });

    const res = await sync(h, [p33, c65, dupPhase, dupCp, p32, c64], user);
    assertEquals(res.status, 200, res.text);
    assertEquals(res.body.acceptedIds, [p32.id, c64.id]);
    const rejected = new Map((res.body.rejected ?? []).map((r) => [r.id, r]));
    assertEquals(rejected.size, 4);
    for (const r of rejected.values()) assertEquals(r.code, "shot.invalid_payload");
    assertStringIncludes(rejected.get(p33.id)!.message.toLowerCase(), "phases");
    assertStringIncludes(rejected.get(c65.id)!.message.toLowerCase(), "checkpoints");
    assertStringIncludes(rejected.get(dupPhase.id)!.message, "Duplicate phase key: phase_1");
    assertStringIncludes(rejected.get(dupCp.id)!.message, "Duplicate checkpoint key: cp_1");
    assertEquals(rpcCalls(h).length, 2);
    assertEquals(rpcCalls(h).map(rpcShotId).sort(), [p32.id, c64.id].sort());
  },
);

Deno.test(
  "S4 HELD: unicode / whitespace-only / oversize keys are per-shot rejections; a duplicate that differs only by case is NOT a duplicate",
  async () => {
    const h = await loadHarness();
    freshHarness(h);
    const user = newUser();
    const blankKey = validShot({ phases: [{ ...phase(1), key: "   " }] });
    const longKey = validShot({ phases: [{ ...phase(1), key: "k".repeat(65) }] });
    const emojiKey = validShot({ phases: [{ ...phase(1), key: "🥒".repeat(33) }] }); // 66 UTF-16 units
    const caseDup = validShot({
      phases: [
        { ...phase(1), key: "Prep" },
        { ...phase(2), key: "prep" },
      ],
    });
    const res = await sync(h, [blankKey, longKey, emojiKey, caseDup], user);
    assertEquals(res.status, 200, res.text);
    assertEquals(res.body.acceptedIds, [caseDup.id]);
    assertEquals(
      res.body.rejected?.map((r) => r.id).sort(),
      [blankKey.id, longKey.id, emojiKey.id].sort(),
    );
    assertEquals(rpcCalls(h).length, 1);
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 5 — batch of 200, #1 malformed
// ─────────────────────────────────────────────────────────────────────────────

Deno.test(
  "S5 HELD: 200-shot batch with #1 cameraView='front' → 199 RPCs, exactly one rejection (#1), rank+progress cache invalidated",
  async () => {
    const h = await loadHarness();
    freshHarness(h);
    const user = newUser();
    const probe = await primeRankProgressCache(h, user);
    const startCalls = h.calls.length;

    const shots = Array.from({ length: 200 }, () => validShot());
    shots[0] = { ...shots[0], cameraView: "front" };
    const res = await sync(h, shots, user);
    assertEquals(res.status, 200, res.text);
    assertEquals(res.body.rejected?.length, 1);
    assertEquals(res.body.rejected?.[0].id, shots[0].id);
    assertEquals(res.body.rejected?.[0].code, "shot.invalid_payload");
    assertEquals(res.body.acceptedIds?.length, 199);
    assertEquals(new Set(res.body.acceptedIds).size, 199);
    assert(!res.body.acceptedIds!.includes(shots[0].id as string));

    const rpcs = rpcCalls(h);
    assertEquals(rpcs.length, 199);
    const rpcIds = rpcs.map(rpcShotId);
    assertEquals(new Set(rpcIds).size, 199);
    assert(!rpcIds.includes(shots[0].id));
    assertEquals(replaySelects(h).slice(startCalls === 0 ? 0 : undefined).length >= 1, true);
    // Replay SELECT carries only the 199 parsed ids.
    const sel = replaySelects(h).at(-1)!;
    const inList =
      decodeURIComponent(sel.url)
        .match(/id=in\.\(([^)]*)\)/)?.[1]
        ?.split(",") ?? [];
    assertEquals(inList.length, 199);
    assert(!inList.includes(shots[0].id as string));

    // cacheDel(rank, progress) effect: next GETs rebuild from PostgREST.
    const after = await probe();
    assert(
      after >= 4,
      `rank/progress cache must be invalidated after an accepted sync (saw ${after} reads)`,
    );
  },
);

Deno.test(
  "S5 HELD: batch-level shape errors are the ONLY 400s — 0 shots, 201 shots, non-array, non-JSON body",
  async () => {
    const h = await loadHarness();
    freshHarness(h);
    const user = newUser();
    for (const shots of [[], Array.from({ length: 201 }, () => validShot()), "nope", null, 7]) {
      const res = await sync(h, shots, user);
      assertEquals(res.status, 400, res.text);
      assertEquals(res.body.error?.code, "validation.shots_sync");
    }
    const raw = await h.handler(
      new Request("http://edge.test/v1/shots:sync", {
        method: "POST",
        headers: {
          authorization: `Bearer ${user.token}`,
          "content-type": "application/json",
          "x-forwarded-for": "10.5.0.9",
        },
        body: "{ this is not json",
      }),
    );
    assertEquals(raw.status, 400);
    await raw.text();
    assertEquals(rpcCalls(h).length, 0);
  },
);

Deno.test(
  "S5 HELD: non-object entries and non-string ids are per-shot rejections with id 'unknown' — no crash, no RPC",
  async () => {
    const h = await loadHarness();
    freshHarness(h);
    const user = newUser();
    const res = await sync(
      h,
      [
        null,
        "x",
        1,
        [],
        { id: 42 },
        { id: "not-a-uuid" },
        validShot({ id: "11111111-1111-9111-8111-111111111111" }),
      ],
      user,
    );
    assertEquals(res.status, 200, res.text);
    assertEquals(res.body.acceptedIds, []);
    assertEquals(res.body.rejected?.length, 7);
    assertEquals(
      res.body.rejected?.slice(0, 5).map((r) => r.id),
      ["unknown", "unknown", "unknown", "unknown", "unknown"],
    );
    assertEquals(res.body.rejected?.[5].id, "not-a-uuid");
    assertEquals(rpcCalls(h).length, 0);
    assertEquals(replaySelects(h).length, 0, "nothing parsed → no replay SELECT");
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 6 — score / resultKind coupling
// ─────────────────────────────────────────────────────────────────────────────

Deno.test(
  "S6 HELD: scored overallScore=10.0000001 and low_confidence overallScore=0 are per-shot rejections; 10 / 0 / null-for-low_confidence pass",
  async () => {
    const h = await loadHarness();
    freshHarness(h);
    const user = newUser();
    const over = validShot({ resultKind: "scored", overallScore: 10.0000001 });
    const lowZero = validShot({ resultKind: "low_confidence", overallScore: 0 });
    const lowNull = validShot({ resultKind: "low_confidence", overallScore: null });
    const ten = validShot({ resultKind: "scored", overallScore: 10 });
    const zero = validShot({ resultKind: "scored", overallScore: 0 });
    const scoredNull = validShot({ resultKind: "scored", overallScore: null });
    const negZero = validShot({ resultKind: "scored", overallScore: -1e-9 });
    const nan = validShot({ resultKind: "scored", overallScore: Number.NaN });
    const str = validShot({ resultKind: "scored", overallScore: "7" });
    const res = await sync(
      h,
      [over, lowZero, lowNull, ten, zero, scoredNull, negZero, nan, str],
      user,
    );
    assertEquals(res.status, 200, res.text);
    assertEquals(res.body.acceptedIds, [lowNull.id, ten.id, zero.id]);
    const rejectedIds = (res.body.rejected ?? []).map((r) => r.id).sort();
    assertEquals(
      rejectedIds,
      [over.id, lowZero.id, scoredNull.id, negZero.id, nan.id, str.id].sort(),
    );
    for (const r of res.body.rejected ?? []) assertEquals(r.code, "shot.invalid_payload");
    assertEquals(rpcCalls(h).length, 3);
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 7 — shot.id_conflict surfaces verbatim; no cache invalidation
// ─────────────────────────────────────────────────────────────────────────────

Deno.test(
  "S7 HELD: apply_synced_shot='shot.id_conflict' → rejected {code:'shot.id_conflict', stable message}, 200, rank/progress cache untouched",
  async () => {
    const h = await loadHarness();
    freshHarness(h);
    const user = newUser();
    const probe = await primeRankProgressCache(h, user);
    h.rpcs["apply_synced_shot"] = "shot.id_conflict";
    const shot = validShot();
    const res = await sync(h, [shot], user);
    assertEquals(res.status, 200, res.text);
    assertEquals(res.body.acceptedIds, []);
    assertEquals(res.body.rejected, [
      {
        id: shot.id,
        code: "shot.id_conflict",
        message: "Shot id is already bound to a different user.",
      },
    ]);
    assertEquals(rpcCalls(h).length, 1);
    assertEquals(await probe(), 0, "no shot accepted → cacheDel must NOT run");
  },
);

Deno.test(
  "S7 HELD: every known non-accepted RPC status maps to its stable message and none invalidates the cache",
  async () => {
    const h = await loadHarness();
    freshHarness(h);
    const user = newUser();
    const probe = await primeRankProgressCache(h, user);
    const expected: Record<string, string> = {
      "auth.required": "Sign in again to sync analyses.",
      "access.permit_not_found": "Analysis permit not found.",
      "access.permit_not_reserved": "Analysis permit is no longer reserved.",
      "access.permit_expired": "Analysis permit expired.",
      "access.paywall_required":
        "Both lifetime free ratings have been used. Membership is required for another rating.",
      "shot.session_not_found": "Session not found or not yours.",
      "shot.id_conflict": "Shot id is already bound to a different user.",
    };
    for (const [status, message] of Object.entries(expected)) {
      h.rpcs["apply_synced_shot"] = status;
      const shot = validShot();
      const res = await sync(h, [shot], user);
      assertEquals(res.status, 200, res.text);
      assertEquals(res.body.rejected, [{ id: shot.id, code: status, message }]);
    }
    assertEquals(await probe(), 0);
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 8 — unknown / detail-bearing RPC status is sanitised
// ─────────────────────────────────────────────────────────────────────────────

const GENERIC_WRITE_FAILED =
  "The analysis could not be saved right now. It stays on this device and will retry.";

Deno.test(
  "S8 HELD: unknown status 'shot.write_failed:duplicate key value…' → client sees only shot.write_failed + generic message, 200",
  async () => {
    const h = await loadHarness();
    freshHarness(h);
    const user = newUser();
    h.rpcs["apply_synced_shot"] =
      'shot.write_failed:duplicate key value violates unique constraint "shots_pkey"';
    const shot = validShot();
    const res = await sync(h, [shot], user);
    assertEquals(res.status, 200, res.text);
    assertEquals(res.body.rejected, [
      { id: shot.id, code: "shot.write_failed", message: GENERIC_WRITE_FAILED },
    ]);
    assert(!res.text.includes("duplicate key"), res.text);
    assert(!res.text.includes("shots_pkey"), res.text);
    assert(!res.text.includes("write_failed:"), res.text);
  },
);

Deno.test(
  "S8 HELD: RPC transport failures (PostgREST 500 with SQL detail, 401, non-JSON, non-string JSON, null) all sanitise to shot.write_failed and keep the batch 200",
  async () => {
    const h = await loadHarness();
    freshHarness(h);
    const user = newUser();
    const probe = await primeRankProgressCache(h, user);
    const responses: Array<() => Response> = [
      () =>
        pgError(
          500,
          'null value in column "user_id" of relation "shots" violates not-null constraint',
          "23502",
        ),
      () => pgError(401, "JWT expired", "PGRST301"),
      () => new Response("<html>bad gateway</html>", { status: 502 }),
      () => rpcOk(""),
      () => new Response("null", { status: 200, headers: { "content-type": "application/json" } }),
      () =>
        new Response(JSON.stringify({ status: "accepted" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ];
    for (const make of responses) {
      const shot = validShot();
      const res = await withFetchOverride(
        h,
        (req) => (req.url.includes("/rest/v1/rpc/apply_synced_shot") ? make() : null),
        () => sync(h, [shot], user),
      );
      assertEquals(res.status, 200, res.text);
      assertEquals(res.body.acceptedIds, []);
      assertEquals(res.body.rejected, [
        { id: shot.id, code: "shot.write_failed", message: GENERIC_WRITE_FAILED },
      ]);
      for (const leak of ["not-null", "shots", "JWT", "PGRST", "html", "23502"]) {
        assert(!res.text.includes(leak), `leaked ${leak}: ${res.text}`);
      }
    }
    assertEquals(await probe(), 0, "no acceptance → no invalidation");
  },
);

Deno.test(
  "S8 HELD: mixed batch — accepted + id_conflict + write_failed in one request → partial success, one invalidation",
  async () => {
    const h = await loadHarness();
    freshHarness(h);
    const user = newUser();
    const probe = await primeRankProgressCache(h, user);
    const a = validShot();
    const b = validShot();
    const c = validShot();
    const plan: Record<string, string> = {
      [a.id as string]: "accepted",
      [b.id as string]: "shot.id_conflict",
      [c.id as string]: "shot.write_failed:boom",
    };
    const res = await withFetchOverride(
      h,
      (req, body) => {
        if (!req.url.includes("/rest/v1/rpc/apply_synced_shot")) return null;
        return rpcOk(plan[String((JSON.parse(body).shot as Json).id)]);
      },
      () => sync(h, [a, b, c], user),
    );
    assertEquals(res.status, 200, res.text);
    assertEquals(res.body.acceptedIds, [a.id]);
    assertEquals(
      res.body.rejected?.map((r) => [r.id, r.code]),
      [
        [b.id, "shot.id_conflict"],
        [c.id, "shot.write_failed"],
      ],
    );
    assert(!res.text.includes("boom"));
    assert((await probe()) >= 4, "one accepted shot → caches invalidated");
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 9 — replay SELECT fails
// ─────────────────────────────────────────────────────────────────────────────

Deno.test(
  "S9 HELD: replay SELECT (GET /rest/v1/shots) 500 → whole batch is a generic 503, zero RPC, no cache invalidation, no detail leak",
  async () => {
    const h = await loadHarness();
    freshHarness(h);
    const user = newUser();
    const probe = await primeRankProgressCache(h, user);
    const shots = [validShot(), validShot(), validShot()];
    const res = await withFetchOverride(
      h,
      (req) =>
        req.method === "GET" && req.url.includes("/rest/v1/shots?")
          ? pgError(500, 'relation "public.shots" does not exist SECRET_DETAIL', "42P01")
          : null,
      () => sync(h, shots, user),
    );
    assertEquals(res.status, 503, res.text);
    assertEquals(res.body, {
      error: { message: "Shot sync is temporarily unavailable. Please try again." },
    });
    assert(!res.text.includes("SECRET_DETAIL"));
    assert(!res.text.includes("42P01"));
    assertEquals(replaySelects(h).length, 1);
    assertEquals(rpcCalls(h).length, 0);
    assertEquals(await probe(), 0);
  },
);

Deno.test(
  "S9 HELD: replay SELECT rows without a usable id (missing / numeric / different-case uuid) never crash — the shot falls through to the idempotent RPC",
  async () => {
    const h = await loadHarness();
    freshHarness(h);
    const user = newUser();
    const shot = validShot();
    // (A literal `null` element in the row array is not a shape PostgREST can
    // emit for a table SELECT, so it is deliberately not part of this attack.)
    for (const rows of [[{ nope: 1 }], [{ id: 12 }], [{ id: shot.id.toString().toUpperCase() }]]) {
      h.reset();
      h.rpcs["apply_synced_shot"] = "accepted";
      h.tables["shots"] = rows as unknown[];
      const res = await sync(h, [shot], user);
      assertEquals(res.status, 200, res.text);
      assertEquals(res.body.acceptedIds, [shot.id]);
      assertEquals(rpcCalls(h).length, 1);
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// Extra — rapid repeats / interleavings / huge input
// ─────────────────────────────────────────────────────────────────────────────

Deno.test(
  "EXTRA HELD: 8 concurrent identical batches all complete 200; RPC count == 8×N (stubbed DB has no replay rows); ids never cross batches",
  async () => {
    const h = await loadHarness();
    freshHarness(h);
    const user = newUser();
    const shots = Array.from({ length: 25 }, () => validShot());
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => sync(h, shots, user, `10.9.0.${i}`)),
    );
    for (const r of results) {
      assertEquals(r.status, 200, r.text);
      assertEquals(r.body.acceptedIds?.length, 25);
      assertEquals(r.body.rejected, []);
    }
    assertEquals(rpcCalls(h).length, 200);
  },
);

Deno.test(
  "EXTRA HELD: 200 shots × 32 phases × 64 checkpoints (~3.6 MB) is accepted under the 5 MB ceiling; 5 MB+1 body is 413 before any upstream call",
  async () => {
    const h = await loadHarness();
    freshHarness(h);
    const user = newUser();
    const big = Array.from({ length: 200 }, () =>
      validShot({
        phases: Array.from({ length: 32 }, (_, i) => phase(i)),
        checkpoints: Array.from({ length: 64 }, (_, i) => checkpoint(i)),
      }),
    );
    const bytes = new TextEncoder().encode(JSON.stringify({ shots: big })).byteLength;
    console.log(`[attack4] max-shape batch bytes=${bytes}`);
    assert(bytes < 5_000_000);
    const res = await sync(h, big, user);
    assertEquals(res.status, 200, res.text.slice(0, 200));
    assertEquals(res.body.acceptedIds?.length, 200);
    assertEquals(rpcCalls(h).length, 200);

    h.reset();
    const pad = "x".repeat(5_000_001);
    const huge = await h.handler(
      new Request("http://edge.test/v1/shots:sync", {
        method: "POST",
        headers: {
          authorization: `Bearer ${user.token}`,
          "content-type": "application/json",
          "x-forwarded-for": "10.9.1.1",
        },
        body: JSON.stringify({ shots: [validShot({ shotType: pad })] }),
      }),
    );
    assertEquals(huge.status, 413);
    await huge.text();
    assertEquals(h.callsTo("/rest/v1/").length, 0);
  },
);

Deno.test(
  "EXTRA HELD: request aborted mid-flight (client cancels body) → 400 batch validation, no RPC, handler does not throw",
  async () => {
    const h = await loadHarness();
    freshHarness(h);
    const user = newUser();
    const controller = new AbortController();
    const stream = new ReadableStream<Uint8Array>({
      start(ctrl) {
        ctrl.enqueue(new TextEncoder().encode('{"shots":[{"id":"'));
        controller.signal.addEventListener("abort", () =>
          ctrl.error(new DOMException("aborted", "AbortError")),
        );
      },
    });
    const req = new Request("http://edge.test/v1/shots:sync", {
      method: "POST",
      headers: {
        authorization: `Bearer ${user.token}`,
        "content-type": "application/json",
        "x-forwarded-for": "10.9.2.1",
      },
      body: stream,
      ...({ duplex: "half" } as Record<string, unknown>),
    });
    const pending = h.handler(req);
    controller.abort();
    const res = await pending;
    assertEquals(res.status, 400);
    await res.text();
    assertEquals(rpcCalls(h).length, 0);
  },
);
