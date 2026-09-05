/**
 * stress-route-post-v1-account-bootstrap — CONCURRENCY lens, modelled upstream.
 *
 * The REAL handler (../index.ts) is driven in-process through the stateful
 * FakeSupabase of xc_concurrency_harness.ts (GoTrue sessions + rotation +
 * logout, PostgREST with RLS, RPCs, RevenueCat), plus a fake
 * appleid.apple.com token endpoint layered on top, with a seeded latency per
 * upstream call so Promise.all bursts genuinely interleave.
 *
 * Scenarios (each STRESS_ITER rounds × STRESS_LANES concurrent requests,
 * every round replayable from the seed in its JSON row):
 *   B1 dup-signup-burst        same NEW identity ×N at t0
 *   B2 call-during-call        same user, jittered starts, Google/Apple flip
 *   B3 cancel-during-call      client aborts mid-flight, then retries
 *   B4 two-actors-same-row     two users × two devices, provider flips
 *   B5 rotation-logout-during  bootstrap while an older session rotates/logs out
 *   B6 clock-skew              expired / future-iat / no-exp tokens mixed in
 *   B7 user-rate-limit         > GENERAL_USER_LIMIT bootstraps for one user
 *   B8 signup-trigger-lag      profile row appears late (readProfile's retry)
 *
 * Invariants asserted per round: every lane settles inside the deadline (no
 * deadlock), no 5xx other than the designed 503 in B8, exactly one profile
 * row per user, one fresh session per accepted call (never shared, never
 * cross-user), no lost update on profiles.provider, exactly one
 * account_external_credentials row per user whose ciphertext decrypts to a
 * grant issued for THAT user, and the free-rating counters untouched
 * (bootstrap must never spend or reserve).
 *
 *   deno test -A --no-check --config deno.json stress_bootstrap_concurrency.test.ts
 *   STRESS_ITER=40 STRESS_LANES=24 ...   # campaign scale
 */
import { assertEquals } from "@std/assert";
import { decryptAppleRefreshToken } from "../externalAccounts.ts";
import { loadXcHarness } from "./xc_concurrency_harness.ts";
import {
  appleCode,
  type AppleEndpointStats,
  appleTokenResponse,
  bootstrapRequest,
  edgeGet,
  edgePost,
  fnv1a,
  installAppleServerEnv,
  inv,
  type Invariant,
  isRecord,
  jittered,
  type LaneRow,
  printRound,
  Prng,
  providerIdToken,
  readJson,
  resetFake,
  type RoundReport,
  roundSeed,
  roundsToRun,
  sessionOf,
  sleep,
  STRESS_LANES,
  STRESS_LATENCY,
  STRESS_SEED,
  summarize,
  timed,
  withDeadline,
  writeRounds,
  type XcHarness,
} from "./stress_bootstrap_harness.ts";

const FILE = "stress_bootstrap_concurrency.test.ts";

// ── Upstream layering: Apple token endpoint + optional profile-trigger lag ──

interface Layer {
  apple: AppleEndpointStats;
  /** When set, a profile created by the id_token grant is hidden for this
   * many ms (models trigger/replica lag between GoTrue and PostgREST). */
  profileLagMs: number | null;
  /** profiles PATCHes in the order the store APPLIED them (the fake applies
   * a PATCH right before answering it), so the last entry is the last write. */
  providerPatches: Array<{ userId: string; provider: string }>;
}

let layered: { h: XcHarness; layer: Layer } | null = null;

async function harness(): Promise<{ h: XcHarness; layer: Layer }> {
  if (layered) return layered;
  await installAppleServerEnv();
  const h = await loadXcHarness();
  const layer: Layer = { apple: { calls: 0, grants: [] }, profileLagMs: null, providerPatches: [] };
  const original = h.fake.handleFetch.bind(h.fake);
  h.fake.handleFetch = async (request: Request, rawBody: string): Promise<Response> => {
    const url = new URL(request.url);
    if (url.origin === "https://appleid.apple.com" && url.pathname === "/auth/token") {
      h.fake.count("apple.token");
      if (STRESS_LATENCY > 0) await sleep(h.fake.prng.int(0, STRESS_LATENCY));
      return appleTokenResponse(rawBody, layer.apple);
    }
    if (request.method === "PATCH" && url.pathname === "/rest/v1/profiles") {
      const response = await original(request, rawBody);
      let provider = "";
      try {
        const parsed = JSON.parse(rawBody) as Record<string, unknown>;
        provider = typeof parsed.provider === "string" ? parsed.provider : "";
      } catch {
        provider = "";
      }
      const id = (url.searchParams.get("id") ?? "").replace(/^eq\./, "");
      if (provider) layer.providerPatches.push({ userId: id, provider });
      return response;
    }
    if (
      url.pathname === "/auth/v1/token" &&
      url.searchParams.get("grant_type") === "id_token" &&
      layer.profileLagMs !== null
    ) {
      const before = new Set(h.fake.tables.profiles.map((p) => String(p.id)));
      const response = await original(request, rawBody);
      const created = h.fake.tables.profiles.filter((p) => !before.has(String(p.id)));
      if (created.length > 0 && layer.profileLagMs > 0) {
        h.fake.tables.profiles = h.fake.tables.profiles.filter((p) => !created.includes(p));
        const lag = layer.profileLagMs;
        setTimeout(() => {
          for (const row of created) {
            if (!h.fake.tables.profiles.some((p) => p.id === row.id)) {
              h.fake.tables.profiles.push(row);
            }
          }
          h.fake.log(
            "trigger.lag",
            `profile ${String(created[0].id).slice(0, 8)} visible after ${lag}ms`,
          );
        }, lag);
      }
      return response;
    }
    return original(request, rawBody);
  };
  layered = { h, layer };
  return layered;
}

// ── Per-scenario driver ──────────────────────────────────────────────────────

type RoundFn = (ctx: {
  h: XcHarness;
  layer: Layer;
  prng: Prng;
  round: number;
  seed: number;
  rows: LaneRow[];
  invariants: Invariant[];
  observations: Record<string, unknown>;
  ip: (lane: number) => string;
}) => Promise<void>;

async function scenario(name: string, lanesLabel: number, run: RoundFn): Promise<RoundReport[]> {
  const { h, layer } = await harness();
  const hash = fnv1a(name);
  const reports: RoundReport[] = [];
  for (const round of roundsToRun()) {
    const seed = roundSeed(STRESS_SEED, name, round);
    resetFake(h.fake, seed);
    layer.apple = { calls: 0, grants: [] };
    layer.profileLagMs = null;
    layer.providerPatches = [];
    h.upstreamCalls.length = 0;
    const prng = new Prng(seed);
    const rows: LaneRow[] = [];
    const invariants: Invariant[] = [];
    const observations: Record<string, unknown> = {};
    // /16 per scenario, /24 per round, host per lane: IP budgets never cross.
    const ip = (lane: number) =>
      `10.${hash & 255}.${(((hash >> 8) & 15) << 4) | (round & 15)}.${1 + (lane % 250)}`;
    const { timedOut, wallMs } = await withDeadline(
      `${name}#${round}`,
      run({ h, layer, prng, round, seed, rows, invariants, observations, ip }),
    );
    const report = summarize(
      FILE,
      name,
      round,
      seed,
      lanesLabel,
      rows,
      invariants,
      observations,
      { ...h.fake.counters },
      wallMs,
      timedOut,
    );
    printRound(report);
    reports.push(report);
  }
  const path = await writeRounds(FILE, name, reports);
  console.log(`[stress] ${name}: ${reports.length} rounds → ${path}`);
  return reports;
}

function assertAllHeld(reports: RoundReport[]): void {
  const broken = reports
    .filter((r) => r.outcome === "BROKEN")
    .map((r) => `round=${r.round} seed=${r.seed} failed=${r.failed.join(",")} replay: ${r.replay}`);
  assertEquals(broken, []);
}

const no5xx = (rows: LaneRow[], allow: number[] = []) =>
  rows.filter((r) => (r.status >= 500 || r.status < 0) && !allow.includes(r.status));

function profileRows(h: XcHarness, userId: string) {
  return h.fake.tables.profiles.filter((p) => p.id === userId);
}

/** No lost update: exactly one profile row, and its provider equals the
 * LAST PATCH the store applied for that user (last-writer-wins); when no
 * lane patched, it must still be the seeded initial provider. */
function providerConsistent(
  layer: Layer,
  h: XcHarness,
  userId: string,
  initial: string,
): Invariant {
  const rows = profileRows(h, userId);
  const final = rows.length === 1 ? String(rows[0].provider) : `rows=${rows.length}`;
  const patches = layer.providerPatches.filter((p) => p.userId === userId);
  const expected = patches.at(-1)?.provider ?? initial;
  return {
    name: `no-lost-update:${userId.slice(0, 8)}`,
    holds: rows.length === 1 && final === expected,
    detail: `profiles.provider=${final} lastAppliedPatch=${expected} patches=${patches.length}`,
  };
}

async function decryptsToOwnGrant(
  h: XcHarness,
  userId: string,
  grants: string[],
): Promise<Invariant> {
  const creds = h.fake.tables.account_external_credentials.filter((r) => r.user_id === userId);
  if (creds.length !== 1) {
    return {
      name: `one-credential-row:${userId.slice(0, 8)}`,
      holds: false,
      detail: `account_external_credentials rows for user = ${creds.length}`,
    };
  }
  const key = Deno.env.get("APPLE_TOKEN_ENCRYPTION_KEY") ?? "";
  try {
    const plain = await decryptAppleRefreshToken(
      String(creds[0].apple_refresh_token_encrypted),
      userId,
      key,
    );
    const own = plain.includes(`-${userId}-`) && grants.includes(plain);
    return {
      name: `one-credential-row:${userId.slice(0, 8)}`,
      holds: own && creds[0].apple_revoked_at === null,
      detail: `decrypts to ${plain} (issued=${grants.includes(plain)}, own=${plain.includes(`-${userId}-`)}, revoked_at=${String(creds[0].apple_revoked_at)})`,
    };
  } catch (error) {
    return {
      name: `one-credential-row:${userId.slice(0, 8)}`,
      holds: false,
      detail: `ciphertext does not decrypt under the user's AAD: ${String(error)}`,
    };
  }
}

async function accessOk(
  h: XcHarness,
  token: string,
  ip: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await h.handler(edgeGet("/v1/me/access", token, ip));
  return { status: response.status, body: await readJson(response) };
}

/** Bootstrap-scoped free-rating invariants: nothing reserved, nothing spent. */
function noSpend(h: XcHarness, userId: string, invariants: Invariant[]): void {
  const permits = h.fake.tables.analysis_permits.filter((p) => p.user_id === userId);
  const shots = h.fake.tables.shots.filter((s) => s.user_id === userId);
  const ledger = [...h.fake.identityLedger.entries()].filter(([k]) => k.endsWith(`:${userId}`));
  inv(
    invariants,
    `no-double-spend:${userId.slice(0, 8)}`,
    permits.length === 0 && shots.length === 0 && ledger.every(([, n]) => n === 0),
    `permits=${permits.length} shots=${shots.length} ledger=${JSON.stringify(ledger)}`,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// B1 — duplicate signup burst: the same brand-new identity, N at once.
// ─────────────────────────────────────────────────────────────────────────────
Deno.test(
  "stress B1 dup-signup-burst — same new identity ×N: one profile, N fresh sessions, all usable, no spend",
  async () => {
    const reports = await scenario("B1-dup-signup-burst", STRESS_LANES, async (c) => {
      const sub = c.prng.uuid();
      const results = await jittered(c.prng, STRESS_LANES, 0, (lane) =>
        timed(c.rows, c.round, lane, "bootstrap", () =>
          c.h.handler(
            bootstrapRequest({
              token: providerIdToken("google", sub, { nonce: `${c.seed}-${lane}` }),
              ip: c.ip(lane),
            }),
          ),
        ),
      );
      const ok = results.filter((r) => r.status === 200);
      inv(c.invariants, "all-200", ok.length === STRESS_LANES, `200s=${ok.length}/${STRESS_LANES}`);
      inv(
        c.invariants,
        "no-5xx",
        no5xx(c.rows).length === 0,
        JSON.stringify(no5xx(c.rows).map((r) => r.status)),
      );
      const sessionIds = ok.map((r) => sessionOf(r.body).sessionId);
      inv(
        c.invariants,
        "one-fresh-session-per-call",
        new Set(sessionIds).size === ok.length && sessionIds.every((s) => s.length > 0),
        `distinct=${new Set(sessionIds).size} of ${ok.length}`,
      );
      inv(
        c.invariants,
        "no-cross-user",
        ok.every((r) => r.row.userId === sub),
        `users=${JSON.stringify([...new Set(ok.map((r) => r.row.userId))])}`,
      );
      inv(
        c.invariants,
        "one-profile-row",
        profileRows(c.h, sub).length === 1,
        `rows=${profileRows(c.h, sub).length}`,
      );
      inv(
        c.invariants,
        "one-auth-user",
        c.h.fake.users.size === 1,
        `auth.users=${c.h.fake.users.size}`,
      );
      inv(
        c.invariants,
        "one-id-token-exchange-per-call",
        (c.h.fake.counters["gotrue.token.id_token"] ?? 0) === STRESS_LANES,
        `gotrue.token.id_token=${c.h.fake.counters["gotrue.token.id_token"] ?? 0}`,
      );
      // Every minted session must be usable on a protected route (verifies the
      // session, then access_state()) — proving none was revoked or clobbered
      // by a sibling.
      const probes = await Promise.all(
        ok.map((r, i) => accessOk(c.h, sessionOf(r.body).accessToken, c.ip(i))),
      );
      inv(
        c.invariants,
        "all-sessions-usable",
        probes.every((p) => p.status === 200),
        JSON.stringify(probes.map((p) => p.status)),
      );
      const free = probes.map((p) => (isRecord(p.body.freeRatings) ? p.body.freeRatings : p.body));
      c.observations.accessSample = free[0] ?? null;
      noSpend(c.h, sub, c.invariants);
      c.observations.sessionsMinted = c.h.fake.sessions.size;
    });
    assertAllHeld(reports);
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// B2 — call-during-call: jittered starts so late lanes begin while early ones
// are mid-flight; alternate Google/Apple so profiles.provider is written by
// racing PATCHes and the Apple credential row is upserted concurrently.
// ─────────────────────────────────────────────────────────────────────────────
Deno.test(
  "stress B2 call-during-call — same user, jittered Google/Apple flips: no lost update, one credential row, N sessions",
  async () => {
    const reports = await scenario("B2-call-during-call", STRESS_LANES, async (c) => {
      const sub = c.prng.uuid();
      // Pre-existing account so the provider flip is a real UPDATE race.
      c.h.fake.ensureUser(sub, "google");
      const providers = Array.from({ length: STRESS_LANES }, (_, i) =>
        c.prng.next() < 0.5 || i === 0 ? "google" : "apple",
      ) as Array<"google" | "apple">;
      const order: Array<{ lane: number; provider: string; t: number }> = [];
      const results = await jittered(
        c.prng,
        STRESS_LANES,
        4 * STRESS_LATENCY + 40,
        async (lane, d) => {
          const provider = providers[lane];
          const nonce = `${c.seed}-${lane}`;
          const r = await timed(
            c.rows,
            c.round,
            lane,
            `bootstrap:${provider}`,
            () =>
              c.h.handler(
                bootstrapRequest({
                  token: providerIdToken(provider, sub, { nonce }),
                  ip: c.ip(lane),
                  body:
                    provider === "apple"
                      ? { appleAuthorizationCode: appleCode("ok", sub, nonce) }
                      : {},
                  headers: provider === "apple" ? { "X-Apple-Revocation-Protocol": "1" } : {},
                }),
              ),
            d,
          );
          order.push({ lane, provider, t: r.row.endedAt });
          return r;
        },
      );
      const ok = results.filter((r) => r.status === 200);
      inv(
        c.invariants,
        "all-200",
        ok.length === STRESS_LANES,
        `200s=${ok.length}/${STRESS_LANES} codes=${JSON.stringify(results.filter((r) => r.status !== 200).map((r) => `${r.status}:${r.row.code}`))}`,
      );
      inv(
        c.invariants,
        "no-5xx",
        no5xx(c.rows).length === 0,
        JSON.stringify(no5xx(c.rows).map((r) => r.status)),
      );
      const sessionIds = ok.map((r) => sessionOf(r.body).sessionId);
      inv(
        c.invariants,
        "one-fresh-session-per-call",
        new Set(sessionIds).size === ok.length,
        `distinct=${new Set(sessionIds).size}`,
      );
      inv(
        c.invariants,
        "no-cross-user",
        ok.every((r) => r.row.userId === sub),
        "",
      );
      const rows = profileRows(c.h, sub);
      const finalProvider = rows.length === 1 ? String(rows[0].provider) : null;
      const lastFinished = [...order].sort((a, b) => a.t - b.t).at(-1);
      inv(c.invariants, "one-profile-row", rows.length === 1, `rows=${rows.length}`);
      c.invariants.push(providerConsistent(c.layer, c.h, sub, "google"));
      c.observations.providerPatches = c.layer.providerPatches.length;
      c.observations.finalProvider = finalProvider;
      c.observations.lastFinishedLaneProvider = lastFinished?.provider ?? null;
      const appleLanes = providers.filter((p) => p === "apple").length;
      inv(
        c.invariants,
        "apple-exchange-per-apple-lane",
        c.layer.apple.calls === appleLanes,
        `apple.calls=${c.layer.apple.calls} appleLanes=${appleLanes}`,
      );
      if (appleLanes > 0) {
        c.invariants.push(await decryptsToOwnGrant(c.h, sub, c.layer.apple.grants));
      }
      const probes = await Promise.all(
        ok.map((r, i) => accessOk(c.h, sessionOf(r.body).accessToken, c.ip(i))),
      );
      inv(
        c.invariants,
        "all-sessions-usable",
        probes.every((p) => p.status === 200),
        JSON.stringify(probes.map((p) => p.status)),
      );
      noSpend(c.h, sub, c.invariants);
    });
    assertAllHeld(reports);
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// B3 — cancel-during-call: the client aborts at a seeded moment (the server
// keeps going — that is what Deno.serve does), then retries. The retry must
// succeed and the store must be consistent; nothing may hang or throw.
// ─────────────────────────────────────────────────────────────────────────────
Deno.test(
  "stress B3 cancel-during-call — abort mid-flight then retry: every lane settles, retries 200, one profile row",
  async () => {
    const reports = await scenario("B3-cancel-during-call", STRESS_LANES, async (c) => {
      const sub = c.prng.uuid();
      const results = await jittered(c.prng, STRESS_LANES, 0, async (lane) => {
        const apple = c.prng.next() < 0.5;
        const nonce = `${c.seed}-${lane}`;
        const controller = new AbortController();
        const abortAt = c.prng.int(0, 3 * STRESS_LATENCY + 10);
        const provider = apple ? "apple" : "google";
        const first = timed(c.rows, c.round, lane, `bootstrap:${provider}:aborted@${abortAt}`, () =>
          c.h.handler(
            bootstrapRequest({
              token: providerIdToken(provider, sub, { nonce }),
              ip: c.ip(lane),
              body: apple ? { appleAuthorizationCode: appleCode("ok", sub, nonce) } : {},
              headers: apple ? { "X-Apple-Revocation-Protocol": "1" } : {},
              signal: controller.signal,
            }),
          ),
        );
        await sleep(abortAt);
        controller.abort(new DOMException("client went away", "AbortError"));
        const aborted = await first;
        const retry = await timed(c.rows, c.round, lane, `retry:${provider}`, () =>
          c.h.handler(
            bootstrapRequest({
              token: providerIdToken(provider, sub, { nonce: `${nonce}-retry` }),
              ip: c.ip(lane),
              body: apple ? { appleAuthorizationCode: appleCode("ok", sub, `${nonce}-retry`) } : {},
              headers: apple ? { "X-Apple-Revocation-Protocol": "1" } : {},
            }),
          ),
        );
        return { aborted, retry, apple };
      });
      const retries = results.map((r) => r.retry);
      inv(
        c.invariants,
        "every-lane-settled",
        c.rows.every((r) => r.status !== -1),
        JSON.stringify(c.rows.filter((r) => r.status === -1).map((r) => r.note)),
      );
      inv(
        c.invariants,
        "retries-all-200",
        retries.every((r) => r.status === 200),
        JSON.stringify(retries.map((r) => `${r.status}:${r.row.code ?? ""}`)),
      );
      inv(
        c.invariants,
        "no-5xx",
        no5xx(c.rows).length === 0,
        JSON.stringify(no5xx(c.rows).map((r) => `${r.op}:${r.status}`)),
      );
      const abortedStatuses = results.map((r) => r.aborted.status);
      c.observations.abortedStatusHistogram = abortedStatuses.reduce<Record<string, number>>(
        (acc, s) => {
          acc[String(s)] = (acc[String(s)] ?? 0) + 1;
          return acc;
        },
        {},
      );
      inv(
        c.invariants,
        "one-profile-row",
        profileRows(c.h, sub).length === 1,
        `rows=${profileRows(c.h, sub).length}`,
      );
      const okAll = [...results.map((r) => r.aborted), ...retries].filter((r) => r.status === 200);
      const sids = okAll.map((r) => sessionOf(r.body).sessionId);
      inv(
        c.invariants,
        "one-fresh-session-per-200",
        new Set(sids).size === okAll.length,
        `distinct=${new Set(sids).size} of ${okAll.length}`,
      );
      inv(
        c.invariants,
        "no-cross-user",
        okAll.every((r) => r.row.userId === sub),
        "",
      );
      if (results.some((r) => r.apple)) {
        c.invariants.push(await decryptsToOwnGrant(c.h, sub, c.layer.apple.grants));
      }
      const probes = await Promise.all(
        retries.map((r, i) => accessOk(c.h, sessionOf(r.body).accessToken, c.ip(i))),
      );
      inv(
        c.invariants,
        "retry-sessions-usable",
        probes.every((p) => p.status === 200),
        JSON.stringify(probes.map((p) => p.status)),
      );
      c.observations.sessionsMinted = c.h.fake.sessions.size;
      c.observations.sessionsReturnedToClient = okAll.length;
      noSpend(c.h, sub, c.invariants);
    });
    assertAllHeld(reports);
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// B4 — two actors on the same rows: users A and B, each from two "devices",
// interleaved, with provider flips. RLS must keep every write on its own row.
// ─────────────────────────────────────────────────────────────────────────────
Deno.test(
  "stress B4 two-actors-same-row — users A/B × devices interleaved: no cross-user rows/sessions, per-user credential binding",
  async () => {
    const reports = await scenario("B4-two-actors-same-row", STRESS_LANES, async (c) => {
      const subA = c.prng.uuid();
      const subB = c.prng.uuid();
      c.h.fake.ensureUser(subA, "google");
      c.h.fake.ensureUser(subB, "apple");
      const plan = Array.from({ length: STRESS_LANES }, (_, lane) => ({
        lane,
        sub: lane % 2 === 0 ? subA : subB,
        provider: (c.prng.next() < 0.5 ? "google" : "apple") as "google" | "apple",
      }));
      const results = await jittered(c.prng, STRESS_LANES, 2 * STRESS_LATENCY + 10, (lane, d) => {
        const p = plan[lane];
        const nonce = `${c.seed}-${lane}`;
        return timed(
          c.rows,
          c.round,
          lane,
          `bootstrap:${p.sub === subA ? "A" : "B"}:${p.provider}`,
          () =>
            c.h.handler(
              bootstrapRequest({
                token: providerIdToken(p.provider, p.sub, { nonce }),
                ip: c.ip(lane),
                body:
                  p.provider === "apple"
                    ? { appleAuthorizationCode: appleCode("ok", p.sub, nonce) }
                    : {},
                headers: p.provider === "apple" ? { "X-Apple-Revocation-Protocol": "1" } : {},
              }),
            ),
          d,
        ).then((r) => ({ ...r, plan: p }));
      });
      const ok = results.filter((r) => r.status === 200);
      inv(
        c.invariants,
        "all-200",
        ok.length === STRESS_LANES,
        `200s=${ok.length}/${STRESS_LANES} ${JSON.stringify(results.filter((r) => r.status !== 200).map((r) => `${r.status}:${r.row.code}`))}`,
      );
      inv(c.invariants, "no-5xx", no5xx(c.rows).length === 0, "");
      inv(
        c.invariants,
        "no-cross-user",
        ok.every((r) => r.row.userId === r.plan.sub),
        JSON.stringify(
          ok
            .filter((r) => r.row.userId !== r.plan.sub)
            .map((r) => `${r.plan.sub.slice(0, 8)}→${r.row.userId?.slice(0, 8)}`),
        ),
      );
      inv(
        c.invariants,
        "two-profile-rows",
        c.h.fake.tables.profiles.length === 2 &&
          profileRows(c.h, subA).length === 1 &&
          profileRows(c.h, subB).length === 1,
        `profiles=${c.h.fake.tables.profiles.length}`,
      );
      const sids = ok.map((r) => sessionOf(r.body).sessionId);
      inv(
        c.invariants,
        "one-fresh-session-per-call",
        new Set(sids).size === ok.length,
        `distinct=${new Set(sids).size}`,
      );
      // Each session must resolve to ITS user on a protected route.
      const probes = await Promise.all(
        ok.map(async (r, i) => {
          const response = await c.h.handler(
            edgeGet("/v1/me", sessionOf(r.body).accessToken, c.ip(i)),
          );
          const body = await readJson(response);
          const user = isRecord(body.user) ? body.user : {};
          return { status: response.status, id: user.id, expected: r.plan.sub };
        }),
      );
      inv(
        c.invariants,
        "sessions-bound-to-own-user",
        probes.every((p) => p.status === 200 && p.id === p.expected),
        JSON.stringify(probes.filter((p) => !(p.status === 200 && p.id === p.expected))),
      );
      for (const sub of [subA, subB]) {
        c.invariants.push(providerConsistent(c.layer, c.h, sub, sub === subA ? "google" : "apple"));
        if (plan.some((p) => p.sub === sub && p.provider === "apple")) {
          c.invariants.push(await decryptsToOwnGrant(c.h, sub, c.layer.apple.grants));
        }
        noSpend(c.h, sub, c.invariants);
      }
      inv(
        c.invariants,
        "credential-rows-lte-users",
        c.h.fake.tables.account_external_credentials.length <= 2,
        `rows=${c.h.fake.tables.account_external_credentials.length}`,
      );
    });
    assertAllHeld(reports);
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// B5 — rotation / logout during request: an older session S0 of the same user
// is refreshed and logged out WHILE N bootstraps are in flight.
// ─────────────────────────────────────────────────────────────────────────────
Deno.test(
  "stress B5 rotation-logout-during-request — older session rotates+logs out mid-burst: new sessions unaffected, S0 family dead, no 5xx",
  async () => {
    const reports = await scenario("B5-rotation-logout-during-request", STRESS_LANES, async (c) => {
      const sub = c.prng.uuid();
      const s0Response = await c.h.handler(
        bootstrapRequest({
          token: providerIdToken("google", sub, { nonce: `${c.seed}-s0` }),
          ip: c.ip(250),
        }),
      );
      const s0 = sessionOf(await readJson(s0Response));
      inv(
        c.invariants,
        "s0-minted",
        s0Response.status === 200 && s0.sessionId.length > 0,
        `status=${s0Response.status}`,
      );
      const refreshLanes = Math.max(1, Math.floor(STRESS_LANES / 4));
      const spread = 3 * STRESS_LATENCY + 20;
      const bootstraps = jittered(c.prng, STRESS_LANES, spread, (lane, d) =>
        timed(
          c.rows,
          c.round,
          lane,
          "bootstrap",
          () =>
            c.h.handler(
              bootstrapRequest({
                token: providerIdToken("google", sub, { nonce: `${c.seed}-${lane}` }),
                ip: c.ip(lane),
              }),
            ),
          d,
        ),
      );
      const refreshes = jittered(c.prng, refreshLanes, spread, (lane, d) =>
        timed(
          c.rows,
          c.round,
          100 + lane,
          "refresh:s0",
          () =>
            c.h.handler(
              edgePost("/v1/auth/refresh", null, c.ip(200 + lane), {
                refreshToken: s0.refreshToken,
              }),
            ),
          d,
        ),
      );
      const logoutAt = c.prng.int(0, spread);
      const logout = (async () => {
        await sleep(logoutAt);
        return timed(c.rows, c.round, 199, `logout:s0@${logoutAt}`, () =>
          c.h.handler(edgePost("/v1/auth/logout", s0.accessToken, c.ip(199), {})),
        );
      })();
      const [b, r, l] = await Promise.all([bootstraps, refreshes, logout]);
      const ok = b.filter((x) => x.status === 200);
      inv(
        c.invariants,
        "bootstraps-all-200",
        ok.length === STRESS_LANES,
        `200s=${ok.length}/${STRESS_LANES}`,
      );
      inv(
        c.invariants,
        "no-5xx",
        no5xx(c.rows).length === 0,
        JSON.stringify(no5xx(c.rows).map((x) => `${x.op}:${x.status}`)),
      );
      const sids = ok.map((x) => sessionOf(x.body).sessionId);
      inv(
        c.invariants,
        "new-sessions-distinct-and-not-s0",
        new Set(sids).size === ok.length && !sids.includes(s0.sessionId),
        `distinct=${new Set(sids).size}`,
      );
      inv(
        c.invariants,
        "refresh-never-5xx-only-200-or-401",
        r.every((x) => x.status === 200 || x.status === 401),
        JSON.stringify(r.map((x) => x.status)),
      );
      inv(c.invariants, "logout-204", l.status === 204, `status=${l.status}`);
      // Refresh rotation is single-use: at most ONE refresh of the same token
      // may succeed (the fake rejects reuse like GoTrue's default).
      inv(
        c.invariants,
        "refresh-token-single-use",
        r.filter((x) => x.status === 200).length <= 1,
        `refresh200=${r.filter((x) => x.status === 200).length}`,
      );
      // After the burst: every new session works, the S0 family is dead.
      const probes = await Promise.all(
        ok.map((x, i) => accessOk(c.h, sessionOf(x.body).accessToken, c.ip(i))),
      );
      inv(
        c.invariants,
        "new-sessions-usable-after-s0-logout",
        probes.every((p) => p.status === 200),
        JSON.stringify(probes.map((p) => p.status)),
      );
      const s0Probe = await accessOk(c.h, s0.accessToken, c.ip(250));
      const rotated = r.find((x) => x.status === 200);
      const rotatedProbe = rotated
        ? await accessOk(c.h, sessionOf(rotated.body).accessToken, c.ip(251))
        : null;
      inv(
        c.invariants,
        "s0-family-revoked",
        s0Probe.status === 401 && (rotatedProbe === null || rotatedProbe.status === 401),
        `s0=${s0Probe.status} rotated=${rotatedProbe?.status ?? "n/a"}`,
      );
      inv(c.invariants, "one-profile-row", profileRows(c.h, sub).length === 1, "");
      c.observations.logoutAtMs = logoutAt;
      c.observations.refreshStatuses = r.map((x) => x.status);
      noSpend(c.h, sub, c.invariants);
    });
    assertAllHeld(reports);
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// B6 — clock skew: expired / no-exp / future-iat tokens mixed into a burst
// of valid ones, then a same-IP flood of expired tokens against the
// auth-failure budget.
// ─────────────────────────────────────────────────────────────────────────────
Deno.test(
  "stress B6 clock-skew — expired tokens 401 and never mint, valid ones 200; auth-failure budget trips per IP only",
  async () => {
    const reports = await scenario("B6-clock-skew", STRESS_LANES, async (c) => {
      type Kind = "valid" | "expired" | "expired-1s" | "future-iat" | "no-exp" | "exp-in-2s";
      const kinds: Kind[] = ["valid", "expired", "expired-1s", "future-iat", "no-exp", "exp-in-2s"];
      const plan = Array.from({ length: STRESS_LANES }, (_, lane) => ({
        lane,
        sub: c.prng.uuid(),
        kind: kinds[c.prng.int(0, kinds.length - 1)],
      }));
      const tokenFor = (p: { sub: string; kind: Kind }, nonce: string) => {
        switch (p.kind) {
          case "valid":
            return providerIdToken("google", p.sub, { nonce });
          case "expired":
            return providerIdToken("google", p.sub, { nonce, expOffsetSec: -c.prng.int(1, 3600) });
          case "expired-1s":
            return providerIdToken("google", p.sub, { nonce, expOffsetSec: -1 });
          case "future-iat":
            return providerIdToken("google", p.sub, { nonce, iatOffsetSec: 900 });
          case "no-exp":
            return providerIdToken("google", p.sub, { nonce, noExp: true });
          case "exp-in-2s":
            return providerIdToken("google", p.sub, { nonce, expOffsetSec: 2 });
        }
      };
      const results = await jittered(c.prng, STRESS_LANES, 0, (lane) =>
        timed(c.rows, c.round, lane, `bootstrap:${plan[lane].kind}`, () =>
          c.h.handler(
            bootstrapRequest({ token: tokenFor(plan[lane], `${c.seed}-${lane}`), ip: c.ip(lane) }),
          ),
        ).then((r) => ({ ...r, plan: plan[lane] })),
      );
      const expired = results.filter(
        (r) => r.plan.kind === "expired" || r.plan.kind === "expired-1s",
      );
      const live = results.filter(
        (r) => !(r.plan.kind === "expired" || r.plan.kind === "expired-1s"),
      );
      inv(
        c.invariants,
        "expired-always-401",
        expired.every((r) => r.status === 401),
        JSON.stringify(expired.map((r) => r.status)),
      );
      inv(
        c.invariants,
        "live-always-200",
        live.every((r) => r.status === 200),
        JSON.stringify(live.map((r) => `${r.plan.kind}:${r.status}`)),
      );
      inv(
        c.invariants,
        "expired-never-reach-gotrue",
        (c.h.fake.counters["gotrue.token.id_token"] ?? 0) === live.length,
        `id_token exchanges=${c.h.fake.counters["gotrue.token.id_token"] ?? 0} live=${live.length} expired=${expired.length}`,
      );
      inv(c.invariants, "no-5xx", no5xx(c.rows).length === 0, "");
      inv(
        c.invariants,
        "expired-mint-nothing",
        c.h.fake.sessions.size === live.length,
        `sessions=${c.h.fake.sessions.size}`,
      );
      inv(
        c.invariants,
        "profiles-only-for-live",
        c.h.fake.tables.profiles.length === live.length,
        `profiles=${c.h.fake.tables.profiles.length}`,
      );
      c.observations.kinds = plan.reduce<Record<string, number>>((acc, p) => {
        acc[p.kind] = (acc[p.kind] ?? 0) + 1;
        return acc;
      }, {});
      // Same-IP flood: AUTH_FAILURE_LIMIT is 30/300s per IP, peeked before the
      // atomic INCR, so a concurrent flood can overshoot the peek — but the
      // NEXT request from that IP must be 429, and other IPs stay unaffected.
      const floodIp = c.ip(240);
      const floodN = 40;
      const flood = await jittered(c.prng, floodN, 0, (lane) =>
        timed(c.rows, c.round, 300 + lane, "flood:expired", () =>
          c.h.handler(
            bootstrapRequest({
              token: providerIdToken("google", c.prng.uuid(), { expOffsetSec: -60 }),
              ip: floodIp,
            }),
          ),
        ),
      );
      const flood401 = flood.filter((r) => r.status === 401).length;
      const flood429 = flood.filter((r) => r.status === 429).length;
      inv(
        c.invariants,
        "flood-only-401-or-429",
        flood401 + flood429 === floodN,
        JSON.stringify(flood.map((r) => r.status)),
      );
      const afterSameIp = await timed(c.rows, c.round, 398, "post-flood:valid-same-ip", () =>
        c.h.handler(
          bootstrapRequest({ token: providerIdToken("google", c.prng.uuid()), ip: floodIp }),
        ),
      );
      const afterOtherIp = await timed(c.rows, c.round, 399, "post-flood:valid-other-ip", () =>
        c.h.handler(
          bootstrapRequest({ token: providerIdToken("google", c.prng.uuid()), ip: c.ip(241) }),
        ),
      );
      inv(
        c.invariants,
        "budget-tripped-same-ip",
        afterSameIp.status === 429,
        `status=${afterSameIp.status}`,
      );
      inv(
        c.invariants,
        "other-ip-unaffected",
        afterOtherIp.status === 200,
        `status=${afterOtherIp.status}`,
      );
      c.observations.flood = { flood401, flood429, peekOvershoot: Math.max(0, flood401 - 30) };
    });
    assertAllHeld(reports);
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// B7 — per-user budget under a burst: GENERAL_USER_LIMIT (240/min) is checked
// AFTER signInWithIdToken minted the session. The excess gets 429 — but the
// sessions minted for those 429s are never revoked (orphaned upstream).
// ─────────────────────────────────────────────────────────────────────────────
Deno.test(
  "stress B7 user-rate-limit — 260 bootstraps for one user: exactly 240×200 + 20×429, no 5xx; orphaned sessions recorded",
  async () => {
    const LANES = 260;
    const reports = await scenario("B7-user-rate-limit", LANES, async (c) => {
      const sub = c.prng.uuid();
      const results = await jittered(c.prng, LANES, 0, (lane) =>
        timed(c.rows, c.round, lane, "bootstrap", () =>
          c.h.handler(
            bootstrapRequest({
              token: providerIdToken("google", sub, { nonce: `${c.seed}-${lane}` }),
              ip: c.ip(lane),
            }),
          ),
        ),
      );
      const ok = results.filter((r) => r.status === 200);
      const limited = results.filter((r) => r.status === 429);
      inv(c.invariants, "exactly-240-accepted", ok.length === 240, `200s=${ok.length}`);
      inv(c.invariants, "excess-429", limited.length === LANES - 240, `429s=${limited.length}`);
      inv(c.invariants, "no-5xx", no5xx(c.rows).length === 0, "");
      inv(c.invariants, "one-profile-row", profileRows(c.h, sub).length === 1, "");
      const sids = ok.map((r) => sessionOf(r.body).sessionId);
      inv(c.invariants, "one-fresh-session-per-200", new Set(sids).size === ok.length, "");
      const minted = c.h.fake.sessions.size;
      const orphaned = [...c.h.fake.sessions.values()].filter((s) => !sids.includes(s.sessionId));
      c.observations.sessionsMinted = minted;
      c.observations.sessionsReturned = ok.length;
      c.observations.orphanedSessions = orphaned.length;
      c.observations.orphanedRevoked = orphaned.filter((s) => s.revoked).length;
      // Recorded, not asserted: the route's ordering (mint → user limit) is
      // what it is; the seed table + this observation are the evidence.
      inv(
        c.invariants,
        "429-never-returns-a-session",
        limited.every((r) => !isRecord(r.body.session)),
        `bodies with session among 429s=${limited.filter((r) => isRecord(r.body.session)).length}`,
      );
      noSpend(c.h, sub, c.invariants);
    });
    assertAllHeld(reports);
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// B8 — signup-trigger lag: the profile row becomes visible `lag` ms after the
// id_token grant. readProfile() retries ONCE after 400 ms, so lag ≤ 350 must
// be 200 for every lane and lag ≥ 450 must be a generic 503 (never a 500,
// never a body with internal detail).
// ─────────────────────────────────────────────────────────────────────────────
Deno.test(
  "stress B8 signup-trigger-lag — late profile row: ≤350ms all 200, ≥450ms all generic 503, never 500",
  async () => {
    const reports = await scenario("B8-signup-trigger-lag", STRESS_LANES, async (c) => {
      const sub = c.prng.uuid();
      const lag = c.prng.next() < 0.5 ? c.prng.int(0, 350) : c.prng.int(450, 700);
      c.layer.profileLagMs = lag;
      c.observations.lagMs = lag;
      const results = await jittered(c.prng, STRESS_LANES, 0, (lane) =>
        timed(c.rows, c.round, lane, `bootstrap:lag${lag}`, () =>
          c.h.handler(
            bootstrapRequest({
              token: providerIdToken("google", sub, { nonce: `${c.seed}-${lane}` }),
              ip: c.ip(lane),
            }),
          ),
        ),
      );
      const statuses = results.map((r) => r.status);
      if (lag <= 350) {
        inv(
          c.invariants,
          "short-lag-all-200",
          statuses.every((s) => s === 200),
          JSON.stringify(statuses),
        );
      } else {
        inv(
          c.invariants,
          "long-lag-all-503",
          statuses.every((s) => s === 503),
          JSON.stringify(statuses),
        );
        const leaky = results.filter((r) => {
          const msg = JSON.stringify(r.body);
          return /profiles|PGRST|postgres|rest\/v1/i.test(msg);
        });
        inv(
          c.invariants,
          "503-body-generic",
          leaky.length === 0,
          JSON.stringify(leaky.map((r) => r.body)),
        );
      }
      inv(
        c.invariants,
        "never-500",
        statuses.every((s) => s !== 500 && s !== -1),
        JSON.stringify(statuses),
      );
      // Wait for the delayed row so the store is settled before the next round.
      await sleep(lag + 20);
      inv(
        c.invariants,
        "one-profile-row",
        profileRows(c.h, sub).length === 1,
        `rows=${profileRows(c.h, sub).length}`,
      );
      c.observations.sessionsMinted = c.h.fake.sessions.size;
      c.observations.sessionsReturned = results.filter((r) => r.status === 200).length;
      noSpend(c.h, sub, c.invariants);
    });
    assertAllHeld(reports);
  },
);
