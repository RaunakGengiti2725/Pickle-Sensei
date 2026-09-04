/**
 * Stress · externalAccounts.ts · lens = concurrency (unit level).
 *
 * Drives the exported provider primitives directly — no edge handler, no
 * Supabase — against the stateful Apple / RevenueCat fakes from
 * stress_external_accounts_harness.ts with seeded latency, so every
 * interleaving is replayable from its seed:
 *
 *   U1 duplicate delivery of ONE Apple authorization code ×burst: Apple honours
 *      exactly one exchange; every loser is a PERMANENT invalid_grant.
 *   U2 two actors: distinct codes for the same Apple subject ×burst, each
 *      encrypted under its own account id — distinct ciphertexts, each
 *      decrypts only under its own AAD (cross-account move is permanent).
 *   U3 revoke the same refresh token ×burst (+ a never-issued token lane):
 *      idempotent at Apple (one revoked transition), unknown token is
 *      permanent invalid_grant, everything settles.
 *   U4 RevenueCat delete of the same subscriber ×burst: one 200, the rest 404
 *      — all treated as success; 5xx / 429 / network drop are retryable.
 *   U5 fault matrix on exchange + revoke (429, 500, 502, 503, network drop,
 *      empty body, invalid_grant, invalid_client, clock skew): only
 *      invalid_grant is permanent; skew beyond Apple's tolerance is
 *      RETRYABLE (never drops the credential).
 *   U6 cancel-during-call: a provider that returns headers, then never ends
 *      the body. providerRequest() bounds the fetch (15 s) but not the body
 *      read, so the exchange never settles (EA-3).
 *
 * Scale: STRESS_ITER rounds × STRESS_BURST lanes per scenario (see harness).
 */
import { assert, assertEquals } from "@std/assert";
import type { Invariant } from "./xc_concurrency_harness.ts";
import { Prng, sleep } from "./xc_concurrency_harness.ts";
import {
  type AppleServerConfiguration,
  decryptAppleRefreshToken,
  deleteRevenueCatCustomer,
  encryptAppleRefreshToken,
  exchangeAppleAuthorizationCode,
  ExternalAccountError,
  isPermanentExternalAccountError,
  revokeAppleRefreshToken,
} from "../externalAccounts.ts";
import {
  APPLE_CLIENT_ID,
  APPLE_KEY_ID,
  APPLE_REVOKE_URL,
  APPLE_TEAM_ID,
  APPLE_TOKEN_URL,
  type AppleFault,
  type AppleKeyMaterial,
  AppleWorld,
  assertCampaign,
  campaign,
  envInt,
  generateAppleKeyMaterial,
  type KnownBroken,
  randomEncryptionKey,
  RC_URL,
  RevenueCatWorld,
  STRESS_BURST,
  STRESS_ITER,
  STRESS_LATENCY_MS,
} from "./stress_external_accounts_harness.ts";

const FILE = "stress_external_accounts_unit.test.ts";
const RC_KEY = "sk_stress_revenuecat";
/** How long U6 waits for a hung body before calling it. providerRequest's own
 * bound is 15 s; run with STRESS_HANG_MS=16000 to show the hang outlives it. */
const STRESS_HANG_MS = envInt("STRESS_HANG_MS", 700);

/** EA-3: a provider response whose body never ends is never abandoned —
 * providerRequest clears its 15 s timeout as soon as headers arrive and
 * response.json() has no bound. */
const EA3: KnownBroken = { hung_body_settles_within_cap: "EA-3" };

const inv = (name: string, holds: boolean, detail: string): Invariant => ({ name, holds, detail });
const key: AppleKeyMaterial = await generateAppleKeyMaterial();

function config(
  tokenEncryptionKey: string,
  overrides: Partial<AppleServerConfiguration> = {},
): AppleServerConfiguration {
  return {
    clientId: APPLE_CLIENT_ID,
    teamId: APPLE_TEAM_ID,
    keyId: APPLE_KEY_ID,
    privateKeyPem: key.privateKeyPem,
    tokenEncryptionKey,
    ...overrides,
  };
}

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** A fetch that routes to the stateful fakes with seeded per-call latency
 * (the scheduler): the order provider calls land in is a function of the seed. */
function providerFetch(
  apple: AppleWorld,
  rc: RevenueCatWorld,
  prng: Prng,
  calls: string[],
): FetchLike {
  return async (input, init) => {
    const request = new Request(input, init);
    const rawBody = request.method === "POST" ? await request.text() : "";
    calls.push(`${request.method} ${request.url}`);
    if (STRESS_LATENCY_MS > 0) await sleep(prng.int(0, STRESS_LATENCY_MS));
    if (request.url === APPLE_TOKEN_URL || request.url === APPLE_REVOKE_URL)
      return apple.handle(request, rawBody);
    if (request.url.startsWith(RC_URL)) return rc.handle(request);
    throw new TypeError(`stress: unexpected upstream ${request.url}`);
  };
}

type Settled<T> = { ok: true; value: T; ms: number } | { ok: false; error: unknown; ms: number };

async function settle<T>(p: Promise<T>): Promise<Settled<T>> {
  const t0 = performance.now();
  try {
    const value = await p;
    return { ok: true, value, ms: performance.now() - t0 };
  } catch (error) {
    return { ok: false, error, ms: performance.now() - t0 };
  }
}

const kindOf = (s: Settled<unknown>): string =>
  s.ok
    ? "ok"
    : s.error instanceof ExternalAccountError
      ? `${s.error.provider}:${s.error.kind}`
      : `throw:${String(s.error)}`;

const BOUND_MS = 5_000;

// ── U1 duplicate delivery of one authorization code ─────────────────────────
Deno.test(
  `stress-U1 exchangeAppleAuthorizationCode ×${STRESS_BURST} same one-use code — one grant, losers permanent invalid_grant`,
  async () => {
    const report = await campaign(
      "stress-U1-exchange-duplicate-code",
      "duplicate delivery",
      FILE,
      { burst: STRESS_BURST },
      STRESS_ITER,
      async (seed) => {
        const prng = new Prng(seed);
        const apple = new AppleWorld(key, prng);
        const rc = new RevenueCatWorld();
        const calls: string[] = [];
        const fetchFn = providerFetch(apple, rc, prng, calls);
        const subject = prng.uuid();
        const code = apple.issueCode(subject);
        const cfg = config(randomEncryptionKey(prng));
        const results = await Promise.all(
          Array.from({ length: STRESS_BURST }, () =>
            settle(exchangeAppleAuthorizationCode(code, cfg, fetchFn)),
          ),
        );
        const winners = results.filter((r) => r.ok);
        const losers = results.filter((r) => !r.ok);
        const invs: Invariant[] = [
          inv(
            "exactly_one_grant",
            winners.length === 1 && apple.liveGrantsFor(subject).length === 1,
            `winners=${winners.length} grants=${apple.grants.size}`,
          ),
          inv(
            "winner_subject_bound",
            winners.every((w) => w.ok && w.value.subject === subject),
            "",
          ),
          inv(
            "losers_permanent_invalid_grant",
            losers.every(
              (l) =>
                !l.ok &&
                l.error instanceof ExternalAccountError &&
                l.error.kind === "invalid_grant" &&
                isPermanentExternalAccountError(l.error),
            ),
            `kinds=${losers.map(kindOf).join(",")}`,
          ),
          inv(
            "apple_called_once_per_lane",
            apple.tokenCalls === STRESS_BURST,
            `tokenCalls=${apple.tokenCalls}`,
          ),
          inv(
            "bounded_wall_time",
            results.every((r) => r.ms < BOUND_MS),
            `max=${Math.max(...results.map((r) => r.ms)).toFixed(1)}ms`,
          ),
          inv(
            "client_secret_accepted",
            apple.secretRejections.length === 0,
            apple.secretRejections.join(","),
          ),
        ];
        return { invariants: invs, statuses: results.map((r) => (r.ok ? 200 : 400)) };
      },
    );
    assertCampaign(report);
  },
);

// ── U2 two actors, distinct codes, per-account AAD ──────────────────────────
Deno.test(
  `stress-U2 ${STRESS_BURST} distinct codes for one Apple subject, encrypted per account — distinct ciphertexts, AAD binds each to its account`,
  async () => {
    const report = await campaign(
      "stress-U2-two-actors-encrypt",
      "two actors on one identity",
      FILE,
      { burst: STRESS_BURST },
      STRESS_ITER,
      async (seed) => {
        const prng = new Prng(seed);
        const apple = new AppleWorld(key, prng);
        const rc = new RevenueCatWorld();
        const calls: string[] = [];
        const fetchFn = providerFetch(apple, rc, prng, calls);
        const subject = prng.uuid();
        const encKey = randomEncryptionKey(prng);
        const cfg = config(encKey);
        const accounts = Array.from({ length: STRESS_BURST }, () => prng.uuid());
        const lanes = accounts.map(async (userId) => {
          const grant = await exchangeAppleAuthorizationCode(
            apple.issueCode(subject),
            cfg,
            fetchFn,
          );
          const ciphertext = await encryptAppleRefreshToken(grant.refreshToken, userId, encKey);
          return { userId, grant, ciphertext };
        });
        const results = await Promise.all(lanes.map((l) => settle(l)));
        const ok = results.flatMap((r) => (r.ok ? [r.value] : []));
        const tokens = new Set(ok.map((o) => o.grant.refreshToken));
        const ciphertexts = new Set(ok.map((o) => o.ciphertext));
        // Same-account round trip + cross-account rejection, all concurrently.
        const checks = await Promise.all(
          ok.flatMap((o, i) => [
            settle(decryptAppleRefreshToken(o.ciphertext, o.userId, encKey)),
            settle(decryptAppleRefreshToken(o.ciphertext, ok[(i + 1) % ok.length].userId, encKey)),
          ]),
        );
        const own = checks.filter((_, i) => i % 2 === 0);
        const cross = checks.filter((_, i) => i % 2 === 1);
        const invs: Invariant[] = [
          inv(
            "every_lane_granted",
            ok.length === STRESS_BURST,
            `ok=${ok.length} kinds=${results.map(kindOf).join(",")}`,
          ),
          inv("tokens_distinct", tokens.size === ok.length, `tokens=${tokens.size}`),
          inv(
            "ciphertexts_distinct",
            ciphertexts.size === ok.length,
            `ciphertexts=${ciphertexts.size}`,
          ),
          inv(
            "own_aad_round_trips",
            own.every((c, i) => c.ok && c.value === ok[i].grant.refreshToken),
            own.map(kindOf).join(","),
          ),
          inv(
            "cross_aad_rejected_permanently",
            ok.length < 2 ||
              cross.every(
                (c) =>
                  !c.ok &&
                  c.error instanceof ExternalAccountError &&
                  c.error.kind === "invalid_response" &&
                  isPermanentExternalAccountError(c.error),
              ),
            cross.map(kindOf).join(","),
          ),
          inv(
            "apple_sees_all_grants_live",
            apple.liveGrantsFor(subject).length === ok.length,
            `live=${apple.liveGrantsFor(subject).length}`,
          ),
          inv(
            "bounded_wall_time",
            results.every((r) => r.ms < BOUND_MS),
            `max=${Math.max(...results.map((r) => r.ms)).toFixed(1)}ms`,
          ),
        ];
        return { invariants: invs, statuses: results.map((r) => (r.ok ? 200 : 500)) };
      },
    );
    assertCampaign(report);
  },
);

// ── U3 revoke the same token ×burst ─────────────────────────────────────────
Deno.test(
  `stress-U3 revokeAppleRefreshToken ×${STRESS_BURST} same token (+1 never-issued lane) — idempotent, one transition, unknown token permanent`,
  async () => {
    const report = await campaign(
      "stress-U3-revoke-duplicate",
      "duplicate delivery / idempotency",
      FILE,
      { burst: STRESS_BURST + 1 },
      STRESS_ITER,
      async (seed) => {
        const prng = new Prng(seed);
        const apple = new AppleWorld(key, prng);
        const rc = new RevenueCatWorld();
        const calls: string[] = [];
        const fetchFn = providerFetch(apple, rc, prng, calls);
        const subject = prng.uuid();
        const cfg = config(randomEncryptionKey(prng));
        const grant = await exchangeAppleAuthorizationCode(apple.issueCode(subject), cfg, fetchFn);
        const unknownLane = prng.int(0, STRESS_BURST);
        const results = await Promise.all(
          Array.from({ length: STRESS_BURST + 1 }, (_, lane) =>
            settle(
              revokeAppleRefreshToken(
                lane === unknownLane ? `rt.never.${seed}` : grant.refreshToken,
                cfg,
                fetchFn,
              ),
            ),
          ),
        );
        const known = results.filter((_, i) => i !== unknownLane);
        const unknown = results[unknownLane];
        const g = apple.grants.get(grant.refreshToken);
        const invs: Invariant[] = [
          inv(
            "all_known_lanes_succeed",
            known.every((r) => r.ok),
            known.map(kindOf).join(","),
          ),
          inv(
            "grant_revoked_once",
            g !== undefined && g.revoked && g.revokedAtCall !== null,
            `revoked=${g?.revoked} at=${g?.revokedAtCall}`,
          ),
          inv(
            "unknown_token_permanent_invalid_grant",
            !unknown.ok &&
              unknown.error instanceof ExternalAccountError &&
              unknown.error.kind === "invalid_grant" &&
              isPermanentExternalAccountError(unknown.error),
            kindOf(unknown),
          ),
          inv(
            "no_live_grant",
            apple.liveGrantsFor(subject).length === 0,
            `live=${apple.liveGrantsFor(subject).length}`,
          ),
          inv(
            "revoke_called_per_lane",
            apple.revokeCalls === STRESS_BURST + 1,
            `revokeCalls=${apple.revokeCalls}`,
          ),
          inv(
            "bounded_wall_time",
            results.every((r) => r.ms < BOUND_MS),
            `max=${Math.max(...results.map((r) => r.ms)).toFixed(1)}ms`,
          ),
        ];
        return { invariants: invs, statuses: results.map((r) => (r.ok ? 200 : 400)) };
      },
    );
    assertCampaign(report);
  },
);

// ── U4 RevenueCat delete ×burst ─────────────────────────────────────────────
Deno.test(
  `stress-U4 deleteRevenueCatCustomer ×${STRESS_BURST} same subscriber (+ faulted lanes) — 200/404 both succeed, 5xx/429/drop retryable`,
  async () => {
    const report = await campaign(
      "stress-U4-revenuecat-delete-duplicate",
      "duplicate delivery / idempotency",
      FILE,
      { burst: STRESS_BURST },
      STRESS_ITER,
      async (seed) => {
        const prng = new Prng(seed);
        const faults: Array<AppleFault | null> = [
          null,
          null,
          { kind: "status", status: 500 },
          { kind: "status", status: 429 },
          { kind: "throw" },
          { kind: "status", status: 502 },
        ];
        const faultByCall = new Map<number, AppleFault | null>();
        const rc = new RevenueCatWorld({
          deleteFault: ({ call }) => {
            // First two Apple-calls are always clean so a 200 and a 404 both occur.
            const f = call <= 2 ? null : faults[prng.int(0, faults.length - 1)];
            faultByCall.set(call, f);
            return f;
          },
        });
        const apple = new AppleWorld(key, prng);
        const calls: string[] = [];
        const fetchFn = providerFetch(apple, rc, prng, calls);
        const appUserId = prng.uuid();
        rc.subscribers.add(appUserId);
        const results = await Promise.all(
          Array.from({ length: STRESS_BURST }, () =>
            settle(deleteRevenueCatCustomer(appUserId, RC_KEY, fetchFn)),
          ),
        );
        const faulted = [...faultByCall.values()].filter((f) => f !== null).length;
        const failed = results.filter((r) => !r.ok);
        const invs: Invariant[] = [
          inv("subscriber_deleted", !rc.subscribers.has(appUserId), ""),
          inv(
            "clean_lanes_succeed",
            results.filter((r) => r.ok).length === STRESS_BURST - faulted,
            `ok=${results.filter((r) => r.ok).length} faulted=${faulted}`,
          ),
          inv(
            "faulted_lanes_retryable",
            failed.every(
              (r) =>
                !r.ok &&
                r.error instanceof ExternalAccountError &&
                r.error.kind === "unavailable" &&
                !isPermanentExternalAccountError(r.error),
            ),
            failed.map(kindOf).join(","),
          ),
          inv(
            "bounded_wall_time",
            results.every((r) => r.ms < BOUND_MS),
            `max=${Math.max(...results.map((r) => r.ms)).toFixed(1)}ms`,
          ),
        ];
        return {
          invariants: invs,
          statuses: results.map((r) => (r.ok ? 200 : 503)),
          detail: {
            faults: [...faultByCall.values()].map((f) =>
              f ? (f.kind === "status" ? f.status : f.kind) : "ok",
            ),
          },
        };
      },
    );
    assertCampaign(report);
  },
);

// ── U5 fault matrix incl. clock skew ────────────────────────────────────────
type Case = { name: string; fault: AppleFault | null; skewMs?: number; expect: string };
const CASES: Case[] = [
  { name: "429", fault: { kind: "status", status: 429 }, expect: "apple:unavailable" },
  { name: "500", fault: { kind: "status", status: 500 }, expect: "apple:unavailable" },
  {
    name: "502-empty",
    fault: { kind: "status", status: 502, body: undefined },
    expect: "apple:unavailable",
  },
  {
    name: "503",
    fault: { kind: "status", status: 503, body: { error: "temporarily_unavailable" } },
    expect: "apple:unavailable",
  },
  { name: "network-drop", fault: { kind: "throw" }, expect: "apple:unavailable" },
  {
    name: "invalid_grant",
    fault: { kind: "status", status: 400, body: { error: "invalid_grant" } },
    expect: "apple:invalid_grant",
  },
  {
    name: "invalid_client",
    fault: { kind: "status", status: 400, body: { error: "invalid_client" } },
    expect: "apple:unavailable",
  },
  {
    name: "invalid_request",
    fault: { kind: "status", status: 400, body: { error: "invalid_request" } },
    expect: "apple:unavailable",
  },
  { name: "skew+30s", fault: null, skewMs: 30_000, expect: "ok" },
  { name: "skew-300s", fault: null, skewMs: -300_000, expect: "ok" },
  { name: "skew+120s", fault: null, skewMs: 120_000, expect: "apple:unavailable" },
  { name: "skew+1h", fault: null, skewMs: 3_600_000, expect: "apple:unavailable" },
  { name: "skew-1h", fault: null, skewMs: -3_600_000, expect: "apple:unavailable" },
];

Deno.test(
  `stress-U5 fault matrix ×${CASES.length} on exchange + revoke, ${STRESS_BURST} lanes each — only invalid_grant is permanent; skew is retryable`,
  async () => {
    const realNow = Date.now;
    try {
      const report = await campaign(
        "stress-U5-fault-matrix",
        "transient vs permanent classification, clock skew",
        FILE,
        { burst: STRESS_BURST, cases: CASES.length },
        STRESS_ITER,
        async (seed, round) => {
          const c = CASES[round % CASES.length];
          const prng = new Prng(seed);
          const appleNow = realNow;
          const apple = new AppleWorld(key, prng, {
            now: () => appleNow(),
            tokenFault: () => c.fault,
            revokeFault: () => c.fault,
          });
          const rc = new RevenueCatWorld();
          const calls: string[] = [];
          const fetchFn = providerFetch(apple, rc, prng, calls);
          const subject = prng.uuid();
          const cfg = config(randomEncryptionKey(prng));
          const skew = c.skewMs ?? 0;
          Date.now = () => realNow() + skew;
          try {
            const exchanges = await Promise.all(
              Array.from({ length: STRESS_BURST }, () =>
                settle(exchangeAppleAuthorizationCode(apple.issueCode(subject), cfg, fetchFn)),
              ),
            );
            const revokes = await Promise.all(
              Array.from({ length: STRESS_BURST }, () =>
                settle(revokeAppleRefreshToken(`rt.${seed}.${prng.int(0, 1e9)}`, cfg, fetchFn)),
              ),
            );
            const exKinds = exchanges.map(kindOf);
            // A revoke of a never-issued token is invalid_grant when Apple is
            // reachable and accepts our client secret; faults / skew take precedence.
            const expectRevoke = c.expect === "ok" ? "apple:invalid_grant" : c.expect;
            const rvKinds = revokes.map(kindOf);
            const invs: Invariant[] = [
              inv(
                "exchange_classified",
                exKinds.every((k) => k === c.expect),
                `case=${c.name} kinds=${exKinds.join(",")} expected=${c.expect} secret=${apple.secretRejections.slice(0, 2).join("|")}`,
              ),
              inv(
                "revoke_classified",
                rvKinds.every((k) => k === expectRevoke),
                `case=${c.name} kinds=${rvKinds.join(",")} expected=${expectRevoke}`,
              ),
              inv(
                "permanence_matches_kind",
                [...exchanges, ...revokes].every(
                  (r) =>
                    r.ok ||
                    isPermanentExternalAccountError(r.error) ===
                      (r.error instanceof ExternalAccountError && r.error.kind === "invalid_grant"),
                ),
                "",
              ),
              inv(
                "bounded_wall_time",
                [...exchanges, ...revokes].every((r) => r.ms < BOUND_MS),
                `max=${Math.max(...exchanges.map((r) => r.ms), ...revokes.map((r) => r.ms)).toFixed(1)}ms`,
              ),
            ];
            return {
              invariants: invs,
              statuses: [...exchanges, ...revokes].map((r) => (r.ok ? 200 : 400)),
              detail: { case: c.name, skewMs: skew },
            };
          } finally {
            Date.now = realNow;
          }
        },
      );
      assertCampaign(report);
    } finally {
      Date.now = realNow;
    }
  },
);

// ── U6 cancel-during-call: hung body ────────────────────────────────────────
Deno.test(
  `stress-U6 provider returns headers then never ends the body — exchange must settle within providerRequest's bound (cap ${STRESS_HANG_MS}ms)`,
  async () => {
    const report = await campaign(
      "stress-U6-hung-body",
      "cancel-during-call / bounded wall time",
      FILE,
      { burst: 2, capMs: STRESS_HANG_MS },
      Math.min(STRESS_ITER, 4),
      async (seed) => {
        const prng = new Prng(seed);
        const cfg = config(randomEncryptionKey(prng));
        const controllers: ReadableStreamDefaultController<Uint8Array>[] = [];
        // Lane 0: body hangs on a 200 (success path reads response.json()).
        // Lane 1: body hangs on a 400 (error path reads appleErrorCode()).
        let call = 0;
        const fetchFn: FetchLike = () => {
          const status = call++ % 2 === 0 ? 200 : 400;
          return Promise.resolve(
            new Response(
              new ReadableStream<Uint8Array>({ start: (c) => void controllers.push(c) }),
              {
                status,
                headers: { "Content-Type": "application/json" },
              },
            ),
          );
        };
        const t0 = performance.now();
        const lanes = [
          exchangeAppleAuthorizationCode(`code.${seed}.a`, cfg, fetchFn),
          exchangeAppleAuthorizationCode(`code.${seed}.b`, cfg, fetchFn),
        ].map((p) => settle(p));
        const cap = sleep(STRESS_HANG_MS).then(() => "cap" as const);
        const first = await Promise.race([Promise.all(lanes).then(() => "settled" as const), cap]);
        const waitedMs = performance.now() - t0;
        // Release the hung bodies so the promises settle and nothing leaks.
        for (const c of controllers) c.error(new Error("stress: body released"));
        const results = await Promise.all(lanes);
        const invs: Invariant[] = [
          inv(
            "hung_body_settles_within_cap",
            first === "settled",
            `still pending after ${waitedMs.toFixed(0)}ms (providerRequest bound is 15000ms); kinds after release=${results.map(kindOf).join(",")}`,
          ),
          inv(
            "released_body_is_classified",
            results.every((r) => !r.ok && r.error instanceof ExternalAccountError),
            results.map(kindOf).join(","),
          ),
        ];
        return {
          invariants: invs,
          statuses: results.map(() => 0),
          detail: { waitedMs: Math.round(waitedMs), capMs: STRESS_HANG_MS },
        };
      },
      { knownBroken: EA3 },
    );
    assertCampaign(report, EA3);
  },
);

// ── sanity: the fakes behave like the contract they stand in for ────────────
Deno.test(
  "stress unit sanity: bad client secret → invalid_client; good secret → grant; revoke twice → 200 twice",
  async () => {
    const prng = new Prng(7);
    const apple = new AppleWorld(key, prng);
    const rc = new RevenueCatWorld();
    const fetchFn = providerFetch(apple, rc, prng, []);
    const badKey = await generateAppleKeyMaterial();
    const bad = await settle(
      exchangeAppleAuthorizationCode(
        apple.issueCode("s"),
        config(randomEncryptionKey(prng), { privateKeyPem: badKey.privateKeyPem }),
        fetchFn,
      ),
    );
    assertEquals(kindOf(bad), "apple:unavailable");
    assertEquals(apple.secretRejections, ["signature"]);
    const grant = await exchangeAppleAuthorizationCode(
      apple.issueCode("s"),
      config(randomEncryptionKey(prng)),
      fetchFn,
    );
    await revokeAppleRefreshToken(grant.refreshToken, config(randomEncryptionKey(prng)), fetchFn);
    await revokeAppleRefreshToken(grant.refreshToken, config(randomEncryptionKey(prng)), fetchFn);
    assert(apple.grants.get(grant.refreshToken)?.revoked);
  },
);
