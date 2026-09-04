// xc-matrix-concurrency-edge — Promise.all bursts against the REAL edge handler
// (../index.ts) over the stateful fake in xc_concurrency_harness.ts.
//
// Scenarios: duplicate bootstrap · refresh during in-flight requests (+ duplicate
// refresh, GoTrue transient failures) · logout during sync (+ deterministic
// cache write-after-revoke race) · double permit reservation · concurrent
// apply_synced_shot for the same shot id · duplicate webhook delivery ·
// rate-limit counter atomicity.
//
// Scale (override by env): XC_BURST=24 concurrent requests per round (sized
// under the per-user shots_sync/permits budgets of 30/min so the rate limiter
// never masks the invariant under test), XC_ROUNDS=6 fresh users per scenario,
// XC_LATENCY_MS=12 max seeded upstream latency, XC_SEED=20260904.
// Replay any scenario: see `replay` in its JSON report under XC_OUT_DIR.
//
// Every scenario asserts the CONTRACT (AGENTS.md + the route/RPC comments in
// ../index.ts and supabase/migrations), never an observed defect. A scenario
// that fails here is a reproduction of a live defect on the tree under test:
// the contract it violates is spelled out in the test body and its JSON report
// records the observed verdicts (see S5b: apply_synced_shot loser verdict).

import { assert, assertEquals } from "@std/assert";
import {
  bootstrap,
  edgeRequest,
  fakeGoogleIdToken,
  histogram,
  type Invariant,
  loadXcHarness,
  outDir,
  Prng,
  readJson,
  replayCommand,
  type ScenarioReport,
  sleep,
  syncShotPayload,
  webhookRequest,
  writeReport,
  XC_BURST,
  XC_LATENCY_MS,
  XC_ROUNDS,
  XC_SEED,
  type XcHarness,
} from "./xc_concurrency_harness.ts";

interface Row {
  round: number;
  i: number;
  op: string;
  status: number;
  code?: string;
  detail?: string;
  startedAt: number;
  endedAt: number;
}

// Every scenario derives its users and its /16 from a hash of its NAME (not
// its position), so a `--filter`ed replay of one scenario sees exactly the
// users/IPs of the full run and per-IP / per-user budgets never bleed across
// scenarios (the edge fn's in-memory rate-limit windows outlive fake.reset()).
function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
let scenarioHash = 0;
const usedPrefixes = new Map<number, string>();
const ip = (round: number, lane: number) =>
  `10.${scenarioHash & 255}.${(((scenarioHash >> 8) & 15) << 4) | (round & 15)}.${lane & 255}`;

async function scenario(
  name: string,
  label: string,
  scale: Record<string, number>,
  run: (
    h: XcHarness,
    prng: Prng,
    rows: Row[],
    invariants: Invariant[],
    inputs: Record<string, unknown>,
    observations: Record<string, unknown>,
  ) => Promise<void>,
): Promise<ScenarioReport> {
  const h = await loadXcHarness();
  scenarioHash = fnv1a(name);
  const prefix = scenarioHash & 0xfff;
  const clash = usedPrefixes.get(prefix);
  if (clash && clash !== name) {
    throw new Error(`xc: IP prefix clash between scenarios ${clash} and ${name} — rename one`);
  }
  usedPrefixes.set(prefix, name);
  const seed = XC_SEED;
  h.fake.reset(seed, XC_LATENCY_MS);
  h.upstreamCalls.length = 0;
  const prng = new Prng((seed ^ scenarioHash) >>> 0);
  const rows: Row[] = [];
  const invariants: Invariant[] = [];
  const inputs: Record<string, unknown> = {};
  const observations: Record<string, unknown> = {};
  const before = Deno.memoryUsage();
  const t0 = performance.now();
  await run(h, prng, rows, invariants, inputs, observations);
  const durationMs = Math.round(performance.now() - t0);
  const after = Deno.memoryUsage();
  const report: ScenarioReport = {
    scenario: name,
    label,
    seed,
    scale,
    inputs,
    statusHistogram: histogram(rows.map((r) => `${r.op}:${r.status}${r.code ? `:${r.code}` : ""}`)),
    counters: { ...h.fake.counters },
    invariants,
    observations,
    timeline: h.fake.timeline,
    requests: rows as unknown as Array<Record<string, unknown>>,
    durationMs,
    heap: { before, after },
    replay: replayCommand(label, seed),
  };
  const path = await writeReport(report);
  console.log(
    `[xc] ${name}: ${durationMs}ms rss=${after.rss} heapUsed=${after.heapUsed} → ${path}`,
  );
  for (const inv of invariants) {
    console.log(`[xc]   ${inv.holds ? "HOLDS " : "BROKEN"} ${inv.name} — ${inv.detail}`);
  }
  return report;
}

function inv(invariants: Invariant[], name: string, holds: boolean, detail: string): void {
  invariants.push({ name, holds, detail });
}

async function timed(
  rows: Row[],
  round: number,
  i: number,
  op: string,
  fn: () => Promise<Response>,
): Promise<{
  status: number;
  body: Record<string, unknown>;
  row: Row;
  retryAfter: string | null;
}> {
  const startedAt = performance.now();
  const response = await fn();
  const body = await readJson(response);
  // codedError() shapes bodies as { error: { code, message } }; a few routes
  // put `code` at the top level.
  const err = body.error;
  const nested = err && typeof err === "object" ? (err as Record<string, unknown>).code : undefined;
  const code =
    typeof nested === "string" ? nested : typeof body.code === "string" ? body.code : undefined;
  const row: Row = {
    round,
    i,
    op,
    status: response.status,
    code,
    startedAt: Math.round(startedAt * 100) / 100,
    endedAt: Math.round(performance.now() * 100) / 100,
  };
  rows.push(row);
  return { status: response.status, body, row, retryAfter: response.headers.get("Retry-After") };
}

const no5xx = (rows: Row[]) => rows.filter((r) => r.status >= 500);

// ─────────────────────────────────────────────────────────────────────────────
// S1 — duplicate bootstrap
// ─────────────────────────────────────────────────────────────────────────────

Deno.test(
  "xc S1: duplicate bootstrap burst — one session per call, no cross-user leak, no 5xx",
  async () => {
    const report = await scenario(
      "s1_duplicate_bootstrap",
      "xc S1",
      { burst: XC_BURST, rounds: XC_ROUNDS },
      async (h, prng, rows, invariants, inputs, observations) => {
        const users: string[] = [];
        let sessionsMinted = 0;
        let crossUser = 0;
        const distinctAccess = new Set<string>();
        const distinctRefresh = new Set<string>();
        for (let r = 0; r < XC_ROUNDS; r++) {
          const subA = prng.uuid();
          const subB = prng.uuid();
          users.push(subA, subB);
          const lanes = prng.shuffle(
            Array.from({ length: XC_BURST }, (_, i) => (i % 3 === 0 ? subB : subA)),
          );
          const results = await Promise.all(
            lanes.map((sub, i) =>
              timed(rows, r, i, `bootstrap:${sub === subA ? "A" : "B"}`, () =>
                h.handler(
                  edgeRequest("POST", "/v1/account/bootstrap", {
                    token: fakeGoogleIdToken(sub, `${r}-${i}`),
                    ip: ip(r, i),
                    body: {},
                  }),
                ),
              ),
            ),
          );
          results.forEach((res, i) => {
            const user = res.body.user as Record<string, unknown> | undefined;
            const session = res.body.session as Record<string, unknown> | undefined;
            if (res.status === 200) {
              sessionsMinted += 1;
              if (user?.id !== lanes[i]) crossUser += 1;
              distinctAccess.add(String(session?.accessToken));
              distinctRefresh.add(String(session?.refreshToken));
            }
          });
          // every minted session must be independently usable, and logging one
          // out (scope=local) must not touch its siblings
          const tokens = results
            .filter((res) => res.status === 200)
            .map((res) => String((res.body.session as Record<string, unknown>).accessToken));
          const probe = await Promise.all(
            tokens.map((token, i) =>
              timed(rows, r, i, "me.access", () =>
                h.handler(
                  edgeRequest("GET", "/v1/me/access", {
                    token,
                    ip: ip(r, i),
                  }),
                ),
              ),
            ),
          );
          const probeOk = probe.filter((p) => p.status === 200).length;
          inv(
            invariants,
            `round ${r}: every minted session authenticates`,
            probeOk === tokens.length,
            `${probeOk}/${tokens.length} GET /v1/me/access → 200`,
          );
          const victim = tokens[0];
          const logout = await timed(rows, r, 0, "logout", () =>
            h.handler(
              edgeRequest("POST", "/v1/auth/logout", {
                token: victim,
                ip: ip(r, 250),
              }),
            ),
          );
          const siblings = await Promise.all(
            tokens.slice(1).map((token, i) =>
              timed(rows, r, i, "me.access.after_sibling_logout", () =>
                h.handler(
                  edgeRequest("GET", "/v1/me/access", {
                    token,
                    ip: ip(r, 251),
                  }),
                ),
              ),
            ),
          );
          const revoked = await timed(rows, r, 0, "me.access.revoked", () =>
            h.handler(
              edgeRequest("GET", "/v1/me/access", {
                token: victim,
                ip: ip(r, 252),
              }),
            ),
          );
          inv(
            invariants,
            `round ${r}: logout scope=local leaves sibling sessions signed in`,
            logout.status === 204 && siblings.every((s) => s.status === 200),
            `logout=${logout.status}; siblings 200: ${
              siblings.filter((s) => s.status === 200).length
            }/${siblings.length}`,
          );
          inv(
            invariants,
            `round ${r}: the logged-out bearer is refused`,
            revoked.status === 401,
            `GET /v1/me/access with revoked bearer → ${revoked.status}`,
          );
        }
        const bootRows = rows.filter((r) => r.op.startsWith("bootstrap"));
        inputs.users = users;
        observations.sessionsMinted = sessionsMinted;
        observations.distinctAccessTokens = distinctAccess.size;
        observations.distinctRefreshTokens = distinctRefresh.size;
        observations.gotrueIdTokenExchanges = h.fake.counters["gotrue.token.id_token"] ?? 0;
        observations.profileRows = h.fake.tables.profiles.length;
        inv(
          invariants,
          "every bootstrap in the burst returns 200",
          bootRows.every((r) => r.status === 200),
          JSON.stringify(histogram(bootRows.map((r) => r.status))),
        );
        inv(
          invariants,
          "no response carries another user's account",
          crossUser === 0,
          `${crossUser} cross-user responses`,
        );
        inv(
          invariants,
          "one fresh session per bootstrap (distinct access+refresh tokens)",
          distinctAccess.size === sessionsMinted && distinctRefresh.size === sessionsMinted,
          `${distinctAccess.size} access / ${distinctRefresh.size} refresh for ${sessionsMinted} bootstraps`,
        );
        inv(
          invariants,
          "exactly one signInWithIdToken exchange per bootstrap (cache bypassed by design)",
          (h.fake.counters["gotrue.token.id_token"] ?? 0) === bootRows.length,
          `${h.fake.counters["gotrue.token.id_token"]} exchanges / ${bootRows.length} bootstraps`,
        );
        inv(
          invariants,
          "one profile row per user",
          h.fake.tables.profiles.length === users.length,
          `${h.fake.tables.profiles.length} rows / ${users.length} users`,
        );
        inv(invariants, "no 5xx", no5xx(rows).length === 0, `${no5xx(rows).length} 5xx`);
      },
    );
    for (const i of report.invariants) {
      assert(i.holds, `${i.name}: ${i.detail}`);
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// S2 — refresh during in-flight requests
// ─────────────────────────────────────────────────────────────────────────────

Deno.test(
  "xc S2a: refresh while a burst is in flight — old bearer keeps working until exp, new bearer works, no 5xx",
  async () => {
    const report = await scenario(
      "s2a_refresh_during_requests",
      "xc S2a",
      { burst: XC_BURST, rounds: XC_ROUNDS },
      async (h, prng, rows, invariants, inputs, observations) => {
        const users: string[] = [];
        for (let r = 0; r < XC_ROUNDS; r++) {
          const sub = prng.uuid();
          users.push(sub);
          const boot = await bootstrap(h, sub, ip(r, 0));
          assertEquals(boot.status, 200);
          const refreshAt = prng.int(0, XC_BURST - 1);
          const lanes = Array.from({ length: XC_BURST }, (_, i) =>
            i === refreshAt
              ? timed(rows, r, i, "refresh", () =>
                  h.handler(
                    edgeRequest("POST", "/v1/auth/refresh", {
                      ip: ip(r, 1),
                      body: { refreshToken: boot.refreshToken },
                    }),
                  ),
                )
              : timed(rows, r, i, "me.access.oldBearer", () =>
                  h.handler(
                    edgeRequest("GET", "/v1/me/access", {
                      token: boot.accessToken,
                      ip: ip(r, 2),
                    }),
                  ),
                ),
          );
          const results = await Promise.all(lanes);
          const refreshed = results[refreshAt];
          const session = refreshed.body.session as Record<string, unknown> | undefined;
          const newToken = String(session?.accessToken ?? "");
          const afterOld = await timed(rows, r, 0, "me.access.oldBearer.afterRefresh", () =>
            h.handler(
              edgeRequest("GET", "/v1/me/access", {
                token: boot.accessToken,
                ip: ip(r, 3),
              }),
            ),
          );
          const afterNew = await timed(rows, r, 0, "me.access.newBearer", () =>
            h.handler(
              edgeRequest("GET", "/v1/me/access", {
                token: newToken,
                ip: ip(r, 4),
              }),
            ),
          );
          const inflight = results.filter((_, i) => i !== refreshAt);
          inv(
            invariants,
            `round ${r}: refresh → 200 with a rotated pair`,
            refreshed.status === 200 &&
              newToken !== "" &&
              newToken !== boot.accessToken &&
              String(session?.refreshToken) !== boot.refreshToken,
            `refresh=${refreshed.status}`,
          );
          inv(
            invariants,
            `round ${r}: in-flight requests on the old bearer all 200`,
            inflight.every((x) => x.status === 200),
            JSON.stringify(histogram(inflight.map((x) => x.status))),
          );
          inv(
            invariants,
            `round ${r}: old bearer still valid after rotation (session alive until exp)`,
            afterOld.status === 200,
            `→ ${afterOld.status}`,
          );
          inv(
            invariants,
            `round ${r}: new bearer authenticates`,
            afterNew.status === 200,
            `→ ${afterNew.status}`,
          );
        }
        inputs.users = users;
        observations.getUserCalls = h.fake.counters["gotrue.get_user"] ?? 0;
        observations.requestsAuthenticated = rows.filter((r) =>
          r.op.startsWith("me.access"),
        ).length;
        inv(invariants, "no 5xx", no5xx(rows).length === 0, `${no5xx(rows).length} 5xx`);
      },
    );
    for (const i of report.invariants) {
      assert(i.holds, `${i.name}: ${i.detail}`);
    }
  },
);

Deno.test(
  "xc S2b: duplicate refresh with the SAME refresh token — exactly one rotation wins; losers are 401 (GoTrue rejects reuse) or share the pair (reuse window)",
  async () => {
    const report = await scenario(
      "s2b_duplicate_refresh",
      "xc S2b",
      { burst: Math.min(XC_BURST, 10), rounds: XC_ROUNDS },
      async (h, prng, rows, invariants, inputs, observations) => {
        const M = Math.min(XC_BURST, 10); // AUTH_REFRESH_LIMIT is 30/min per IP
        const matrix: Array<Record<string, unknown>> = [];
        for (const policy of ["rotate-reject-reuse", "rotate-reuse-window"] as const) {
          for (let r = 0; r < XC_ROUNDS; r++) {
            const round = policy === "rotate-reject-reuse" ? r : 100 + r;
            h.fake.refreshPolicy = policy;
            const sub = prng.uuid();
            const boot = await bootstrap(h, sub, ip(round, 0));
            assertEquals(boot.status, 200);
            const results = await Promise.all(
              Array.from({ length: M }, (_, i) =>
                timed(rows, round, i, `refresh.dup.${policy}`, () =>
                  h.handler(
                    edgeRequest("POST", "/v1/auth/refresh", {
                      ip: ip(round, 9),
                      body: { refreshToken: boot.refreshToken },
                    }),
                  ),
                ),
              ),
            );
            const ok = results.filter((x) => x.status === 200);
            const tokens = new Set(
              ok.map((x) => String((x.body.session as Record<string, unknown>).accessToken)),
            );
            const winnerToken = [...tokens][0] ?? "";
            const probe = winnerToken
              ? await timed(rows, round, 0, "me.access.rotated", () =>
                  h.handler(
                    edgeRequest("GET", "/v1/me/access", {
                      token: winnerToken,
                      ip: ip(round, 8),
                    }),
                  ),
                )
              : null;
            matrix.push({
              policy,
              round: r,
              user: sub,
              statuses: histogram(results.map((x) => x.status)),
              distinctRotatedTokens: tokens.size,
              rotatedTokenAuthenticates: probe?.status,
            });
            if (policy === "rotate-reject-reuse") {
              inv(
                invariants,
                `${policy} round ${r}: exactly one 200, rest 401 (reuse refused upstream → sign-in again)`,
                ok.length === 1 && results.every((x) => x.status === 200 || x.status === 401),
                JSON.stringify(histogram(results.map((x) => x.status))),
              );
            } else {
              inv(
                invariants,
                `${policy} round ${r}: all 200 and every response carries the SAME rotated pair`,
                ok.length === M && tokens.size === 1,
                `${ok.length}/${M} ok, ${tokens.size} distinct tokens`,
              );
            }
            inv(
              invariants,
              `${policy} round ${r}: the rotated bearer authenticates`,
              probe?.status === 200,
              `→ ${probe?.status}`,
            );
          }
        }
        inputs.matrixRows = matrix.length;
        observations.matrix = matrix;
        inv(invariants, "no 5xx", no5xx(rows).length === 0, `${no5xx(rows).length} 5xx`);
      },
    );
    for (const i of report.invariants) {
      assert(i.holds, `${i.name}: ${i.detail}`);
    }
  },
);

Deno.test(
  "xc S2c: a TRANSIENT GoTrue refresh failure (429 / network error / 502) is answered 503, never 401 — the refresh token stays valid and the next retry succeeds",
  async () => {
    // Contract (AGENTS.md "Auth sessions"): "The ONE implicit sign-out is the
    // server refusing the refresh token (401/403)"; sessionLifecycle.ts throws
    // a NON-retryable SessionRefreshError on 401/403 and sessionKeeper.ts then
    // calls onRevoked() (sign-out). refreshSessionRoute → authRequest classifies
    // GoTrue 429, status 0 (network failure inside supabase-js) and 5xx as
    // `unavailable` → 503 + Retry-After, so the app retries with backoff and
    // stays signed in; only a genuine refusal (400/401/403 from GoTrue) is 401.
    const report = await scenario(
      "s2c_refresh_transient_upstream_failure",
      "xc S2c",
      { burst: 4, rounds: 1 },
      async (h, prng, rows, invariants, inputs, observations) => {
        const sub = prng.uuid();
        const boot = await bootstrap(h, sub, ip(0, 0));
        assertEquals(boot.status, 200);
        const cases: Array<{ name: string; force: () => Response | "throw" }> = [
          {
            name: "gotrue_429",
            force: () =>
              new Response(
                JSON.stringify({
                  code: 429,
                  error_code: "over_request_rate_limit",
                  msg: "Request rate limit reached",
                }),
                {
                  status: 429,
                  headers: {
                    "Content-Type": "application/json",
                    "Retry-After": "5",
                  },
                },
              ),
          },
          {
            name: "gotrue_network_failure",
            force: () => "throw",
          },
          {
            name: "gotrue_502",
            force: () =>
              new Response(JSON.stringify({ code: 502, msg: "bad gateway" }), {
                status: 502,
                headers: { "Content-Type": "application/json" },
              }),
          },
        ];
        const observed: Record<string, number> = {};
        for (const [k, c] of cases.entries()) {
          h.fake.overrides.refresh = c.force;
          const res = await timed(rows, 0, k, `refresh.${c.name}`, () =>
            h.handler(
              edgeRequest("POST", "/v1/auth/refresh", {
                ip: ip(0, 10 + k),
                body: { refreshToken: boot.refreshToken },
              }),
            ),
          );
          observed[c.name] = res.status;
        }
        h.fake.overrides.refresh = undefined;
        // the refresh token is still perfectly valid upstream:
        const real = await timed(rows, 0, 9, "refresh.after_transients", () =>
          h.handler(
            edgeRequest("POST", "/v1/auth/refresh", {
              ip: ip(0, 20),
              body: { refreshToken: boot.refreshToken },
            }),
          ),
        );
        inputs.user = sub;
        observations.statusByUpstreamFailure = observed;
        observations.refreshStillValidUpstream = real.status;
        inv(
          invariants,
          "GoTrue 429 → edge 503 (retryable, never 401)",
          observed.gotrue_429 === 503,
          `→ ${observed.gotrue_429}`,
        );
        inv(
          invariants,
          "GoTrue network failure → edge 503 (retryable, never 401)",
          observed.gotrue_network_failure === 503,
          `→ ${observed.gotrue_network_failure}`,
        );
        inv(
          invariants,
          "GoTrue 502 → edge 503 (retryable, never 401)",
          observed.gotrue_502 === 503,
          `→ ${observed.gotrue_502}`,
        );
        inv(
          invariants,
          "the refresh token was never revoked upstream — the retry after the transients succeeds",
          real.status === 200,
          `→ ${real.status}`,
        );
      },
    );
    for (const i of report.invariants) {
      assert(i.holds, `${i.name}: ${i.detail}`);
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// S3 — logout during sync
// ─────────────────────────────────────────────────────────────────────────────

Deno.test(
  "xc S3a: logout while a sync burst is in flight — every sync is 200 or 401, persisted shots == accepted ids, bearer refused afterwards, no 5xx",
  async () => {
    const report = await scenario(
      "s3a_logout_during_sync",
      "xc S3a",
      { burst: XC_BURST, rounds: XC_ROUNDS },
      async (h, prng, rows, invariants, inputs, observations) => {
        const users: string[] = [];
        let resurrected = 0;
        for (let r = 0; r < XC_ROUNDS; r++) {
          const sub = prng.uuid();
          users.push(sub);
          const boot = await bootstrap(h, sub, ip(r, 0));
          assertEquals(boot.status, 200);
          // premium so the burst is not capped at two reserved permits
          h.fake.tables.billing_entitlements.push({
            user_id: sub,
            premium: true,
            product_key: "pickle_sensei_pro_monthly",
            expires_at: null,
            verified_at: new Date().toISOString(),
          });
          const permits: string[] = [];
          for (let i = 0; i < XC_BURST; i++) {
            const res = await timed(rows, r, i, "permit.reserve", () =>
              h.handler(
                edgeRequest("POST", "/v1/analysis-permits", {
                  token: boot.accessToken,
                  ip: ip(r, 1),
                  body: { idempotencyKey: `s3-${r}-${i}` },
                }),
              ),
            );
            assertEquals(res.status, 200);
            permits.push(String((res.body.permit as Record<string, unknown>).id));
          }
          const shotIds = permits.map(() => prng.uuid());
          const logoutAfterMs = prng.int(0, XC_LATENCY_MS * 2);
          let logoutDoneAt = Infinity;
          const lanes: Array<Promise<unknown>> = shotIds.map((shotId, i) =>
            timed(rows, r, i, "shots.sync", () =>
              h.handler(
                edgeRequest("POST", "/v1/shots:sync", {
                  token: boot.accessToken,
                  ip: ip(r, 2),
                  body: { shots: [syncShotPayload(shotId, permits[i])] },
                }),
              ),
            ),
          );
          lanes.push(
            (async () => {
              await sleep(logoutAfterMs);
              const res = await timed(rows, r, 0, "logout", () =>
                h.handler(
                  edgeRequest("POST", "/v1/auth/logout", {
                    token: boot.accessToken,
                    ip: ip(r, 3),
                  }),
                ),
              );
              logoutDoneAt = res.row.endedAt;
              return res;
            })(),
          );
          await Promise.all(lanes);
          const syncRows = rows.filter((x) => x.round === r && x.op === "shots.sync");
          const persisted = new Set<string>(
            h.fake.tables.shots.filter((s) => s.user_id === sub).map((s) => String(s.id)),
          );
          // a 401'd sync must not have written; a 200 must have written exactly its shot
          const accepted = new Set<string>();
          for (const [i, shotId] of shotIds.entries()) {
            const row = syncRows[i];
            if (row.status === 200) accepted.add(shotId);
          }
          const mismatch =
            [...persisted].filter((id) => !accepted.has(id)).length +
            [...accepted].filter((id) => !persisted.has(id)).length;
          const startedAfterLogout = syncRows.filter((x) => x.startedAt > logoutDoneAt);
          const after200 = startedAfterLogout.filter((x) => x.status === 200).length;
          resurrected += after200;
          const post = await timed(rows, r, 0, "me.access.after_logout", () =>
            h.handler(
              edgeRequest("GET", "/v1/me/access", {
                token: boot.accessToken,
                ip: ip(r, 4),
              }),
            ),
          );
          inv(
            invariants,
            `round ${r}: every sync is 200 or 401`,
            syncRows.every((x) => x.status === 200 || x.status === 401),
            JSON.stringify(histogram(syncRows.map((x) => x.status))),
          );
          inv(
            invariants,
            `round ${r}: persisted shots == accepted ids`,
            mismatch === 0,
            `${persisted.size} persisted / ${accepted.size} accepted / ${mismatch} mismatches`,
          );
          inv(
            invariants,
            `round ${r}: fresh request after logout is refused`,
            post.status === 401,
            `→ ${post.status} (${startedAfterLogout.length} syncs started after logout completed, ${after200} of them 200)`,
          );
        }
        inputs.users = users;
        observations.syncsAcceptedAfterLogoutCompleted = resurrected;
        inv(invariants, "no 5xx", no5xx(rows).length === 0, `${no5xx(rows).length} 5xx`);
      },
    );
    for (const i of report.invariants) {
      assert(i.holds, `${i.name}: ${i.detail}`);
    }
  },
);

Deno.test(
  "xc S3b: logout landing while a verification of the same bearer is in flight — the revoked bearer is refused from the next request on and is never re-cached (GoTrue consulted ≤ 1 time)",
  async () => {
    // Contract (AGENTS.md "Auth sessions"): logout "revokes THIS device's
    // session … and drops the bearer from the auth cache"; authenticate()
    // comment: getUser "also fails once the session behind it was logged out".
    // Race: request R has a cache miss and calls getUser; GoTrue answers 200
    // (session still alive) but the reply is slow on the wire. Meanwhile the
    // logout request authenticates the same bearer (its own getUser, fast),
    // revokes upstream, then fenceRevokedSession() writes auth:revoked:<sid>
    // and deletes the bearer cache, and returns 204. THEN R's getUser reply
    // lands: authenticate() re-checks the session fence AFTER verification and
    // before writeAuthCache, so R is refused (401) instead of repopulating the
    // cache entry for the now-revoked bearer; every later request is a fence
    // hit (401, no GoTrue call) for AUTH_REVOCATION_TTL_SECONDS. Only the FIRST
    // getUser for the bearer (R's) is slowed; ordering is otherwise the
    // handler's own.
    const report = await scenario(
      "s3b_logout_cache_resurrection",
      "xc S3b",
      { burst: 2, rounds: XC_ROUNDS },
      async (h, prng, rows, invariants, inputs, observations) => {
        const users: string[] = [];
        let resurrections = 0;
        let inflightRefused = 0;
        for (let r = 0; r < XC_ROUNDS; r++) {
          const sub = prng.uuid();
          users.push(sub);
          const boot = await bootstrap(h, sub, ip(r, 0));
          assertEquals(boot.status, 200);
          const slowMs = 60 + prng.int(0, 40);
          let slowed = 0;
          h.fake.overrides.getUserDelayMs = (bearer) =>
            bearer === boot.accessToken && slowed++ === 0 ? slowMs : 0;
          const [inflight, logout] = await Promise.all([
            timed(rows, r, 0, "me.access.inflight", () =>
              h.handler(
                edgeRequest("GET", "/v1/me/access", {
                  token: boot.accessToken,
                  ip: ip(r, 1),
                }),
              ),
            ),
            (async () => {
              await sleep(15);
              return timed(rows, r, 1, "logout", () =>
                h.handler(
                  edgeRequest("POST", "/v1/auth/logout", {
                    token: boot.accessToken,
                    ip: ip(r, 2),
                  }),
                ),
              );
            })(),
          ]);
          h.fake.overrides.getUserDelayMs = undefined;
          const session = [...h.fake.sessions.values()].find(
            (s) => s.accessToken === boot.accessToken,
          );
          const getUserCallsBefore = h.fake.counters["gotrue.get_user"] ?? 0;
          const after = await timed(rows, r, 2, "me.access.after_logout", () =>
            h.handler(
              edgeRequest("GET", "/v1/me/access", {
                token: boot.accessToken,
                ip: ip(r, 3),
              }),
            ),
          );
          const again = await timed(rows, r, 3, "me.access.after_logout.again", () =>
            h.handler(
              edgeRequest("GET", "/v1/me/access", {
                token: boot.accessToken,
                ip: ip(r, 4),
              }),
            ),
          );
          const getUserCallsAfter = h.fake.counters["gotrue.get_user"] ?? 0;
          if (after.status === 200 || again.status === 200) resurrections += 1;
          if (inflight.status === 401) inflightRefused += 1;
          inv(
            invariants,
            `round ${r}: precondition — logout 204, session revoked upstream, in-flight verification answered 200 or 401 (never 5xx)`,
            logout.status === 204 &&
              session?.revoked === true &&
              (inflight.status === 200 || inflight.status === 401),
            `inflight=${inflight.status} logout=${logout.status} revoked=${session?.revoked}`,
          );
          inv(
            invariants,
            `round ${r}: revoked bearer is refused on the next request AND the one after (never re-cached)`,
            after.status === 401 && again.status === 401,
            `after=${after.status} again=${again.status}`,
          );
          inv(
            invariants,
            `round ${r}: GoTrue consulted ≤ 1 time across the two post-logout requests (fence hit, no re-verify loop)`,
            getUserCallsAfter - getUserCallsBefore <= 1,
            `getUser calls during the two post-logout requests: ${
              getUserCallsAfter - getUserCallsBefore
            }`,
          );
        }
        inputs.users = users;
        observations.resurrections = resurrections;
        observations.inflightRefused = inflightRefused;
        observations.rounds = XC_ROUNDS;
      },
    );
    for (const i of report.invariants) {
      assert(i.holds, `${i.name}: ${i.detail}`);
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// S4 — double permit reservation
// ─────────────────────────────────────────────────────────────────────────────

Deno.test(
  "xc S4: concurrent permit reservation — same key idempotent, different keys never exceed two free reservations, premium unlimited",
  async () => {
    const report = await scenario(
      "s4_double_permit_reservation",
      "xc S4",
      { burst: XC_BURST, rounds: XC_ROUNDS },
      async (h, prng, rows, invariants, inputs, observations) => {
        const users: Array<Record<string, unknown>> = [];
        for (let r = 0; r < XC_ROUNDS; r++) {
          // (a) same key
          const subA = prng.uuid();
          const bootA = await bootstrap(h, subA, ip(r, 0));
          const keyA = `same-${r}-${prng.uuid()}`;
          const same = await Promise.all(
            Array.from({ length: XC_BURST }, (_, i) =>
              timed(rows, r, i, "permit.sameKey", () =>
                h.handler(
                  edgeRequest("POST", "/v1/analysis-permits", {
                    token: bootA.accessToken,
                    ip: ip(r, 1),
                    body: { idempotencyKey: keyA },
                  }),
                ),
              ),
            ),
          );
          const sameIds = new Set(
            same
              .filter((x) => x.status === 200)
              .map((x) => String((x.body.permit as Record<string, unknown>).id)),
          );
          const permitsA = h.fake.tables.analysis_permits.filter((p) => p.user_id === subA);
          inv(
            invariants,
            `round ${r}: same key ×${XC_BURST} → all 200, ONE permit id, ONE row`,
            same.every((x) => x.status === 200) && sameIds.size === 1 && permitsA.length === 1,
            `${JSON.stringify(
              histogram(same.map((x) => x.status)),
            )} ids=${sameIds.size} rows=${permitsA.length}`,
          );
          const accessA = same.find((x) => x.status === 200)?.body.access as
            Record<string, unknown> | undefined;
          // (b) different keys, free user
          const subB = prng.uuid();
          const bootB = await bootstrap(h, subB, ip(r, 2));
          const keys = Array.from({ length: XC_BURST }, (_, i) => `diff-${r}-${i}-${prng.uuid()}`);
          const diff = await Promise.all(
            keys.map((key, i) =>
              timed(rows, r, i, "permit.diffKey", () =>
                h.handler(
                  edgeRequest("POST", "/v1/analysis-permits", {
                    token: bootB.accessToken,
                    ip: ip(r, 3),
                    body: { idempotencyKey: key },
                  }),
                ),
              ),
            ),
          );
          const okB = diff.filter((x) => x.status === 200);
          const paywall = diff.filter(
            (x) => x.status === 402 && x.row.code === "access.paywall_required",
          );
          const permitsB = h.fake.tables.analysis_permits.filter(
            (p) => p.user_id === subB && p.status === "reserved",
          );
          const accessRow = await timed(rows, r, 0, "me.access.B", () =>
            h.handler(
              edgeRequest("GET", "/v1/me/access", {
                token: bootB.accessToken,
                ip: ip(r, 4),
              }),
            ),
          );
          const fr = (accessRow.body.freeRatings ?? {}) as Record<string, number>;
          inv(
            invariants,
            `round ${r}: different keys ×${XC_BURST} → exactly 2×200 + ${
              XC_BURST - 2
            }×402 access.paywall_required`,
            okB.length === 2 && paywall.length === XC_BURST - 2,
            `${okB.length} ok, ${paywall.length} paywall, other=${
              diff.length - okB.length - paywall.length
            }`,
          );
          inv(
            invariants,
            `round ${r}: exactly two reserved permit rows; access reports reserved=2 availableToReserve=0 canStartRating=false`,
            permitsB.length === 2 &&
              fr.reserved === 2 &&
              fr.availableToReserve === 0 &&
              accessRow.body.canStartRating === false,
            `rows=${permitsB.length} access=${JSON.stringify(
              fr,
            )} canStart=${accessRow.body.canStartRating}`,
          );
          // (c) premium user, different keys
          const subC = prng.uuid();
          const bootC = await bootstrap(h, subC, ip(r, 5));
          h.fake.tables.billing_entitlements.push({
            user_id: subC,
            premium: true,
            product_key: "pickle_sensei_pro_annual",
            expires_at: null,
            verified_at: new Date().toISOString(),
          });
          const prem = await Promise.all(
            Array.from({ length: XC_BURST }, (_, i) =>
              timed(rows, r, i, "permit.premium", () =>
                h.handler(
                  edgeRequest("POST", "/v1/analysis-permits", {
                    token: bootC.accessToken,
                    ip: ip(r, 6),
                    body: { idempotencyKey: `prem-${r}-${i}` },
                  }),
                ),
              ),
            ),
          );
          inv(
            invariants,
            `round ${r}: premium ×${XC_BURST} → all 200, ${XC_BURST} rows`,
            prem.every((x) => x.status === 200) &&
              h.fake.tables.analysis_permits.filter((p) => p.user_id === subC).length === XC_BURST,
            JSON.stringify(histogram(prem.map((x) => x.status))),
          );
          users.push({
            round: r,
            sameKeyUser: subA,
            sameKey: keyA,
            diffKeyUser: subB,
            diffKeys: keys,
            premiumUser: subC,
            sameKeyAccess: accessA,
          });
        }
        inputs.users = users;
        observations.reserveRpcCalls = h.fake.counters["rpc.reserve_analysis_permit"];
        inv(invariants, "no 5xx", no5xx(rows).length === 0, `${no5xx(rows).length} 5xx`);
      },
    );
    for (const i of report.invariants) {
      assert(i.holds, `${i.name}: ${i.detail}`);
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// S5 — concurrent apply_synced_shot for the same shot id
// ─────────────────────────────────────────────────────────────────────────────

Deno.test(
  "xc S5a: same shot id synced concurrently — exactly one row, never a double spend; the losers' verdict is recorded",
  async () => {
    const report = await scenario(
      "s5a_same_shot_concurrent_sync",
      "xc S5a",
      { burst: XC_BURST, rounds: XC_ROUNDS },
      async (h, prng, rows, invariants, inputs, observations) => {
        const users: Array<Record<string, unknown>> = [];
        const loserCodes: string[] = [];
        let replayAccepted = 0;
        for (let r = 0; r < XC_ROUNDS; r++) {
          const sub = prng.uuid();
          const boot = await bootstrap(h, sub, ip(r, 0));
          const reserved = await timed(rows, r, 0, "permit.reserve", () =>
            h.handler(
              edgeRequest("POST", "/v1/analysis-permits", {
                token: boot.accessToken,
                ip: ip(r, 1),
                body: { idempotencyKey: `s5-${r}` },
              }),
            ),
          );
          const permitId = String((reserved.body.permit as Record<string, unknown>).id);
          const shotId = prng.uuid();
          const results = await Promise.all(
            Array.from({ length: XC_BURST }, (_, i) =>
              timed(rows, r, i, "shots.sync.sameShot", () =>
                h.handler(
                  edgeRequest("POST", "/v1/shots:sync", {
                    token: boot.accessToken,
                    ip: ip(r, 2),
                    body: { shots: [syncShotPayload(shotId, permitId)] },
                  }),
                ),
              ),
            ),
          );
          let accepted = 0;
          const codes: string[] = [];
          for (const res of results) {
            const acc = (res.body.acceptedIds ?? []) as string[];
            const rej = (res.body.rejected ?? []) as Array<{ id: string; code: string }>;
            if (acc.includes(shotId)) accepted += 1;
            for (const x of rej) codes.push(x.code);
          }
          loserCodes.push(...codes);
          const shotRows = h.fake.tables.shots.filter((s) => s.id === shotId);
          const scored = h.fake.tables.shots.filter(
            (s) => s.user_id === sub && s.result_kind === "scored",
          ).length;
          const permit = h.fake.tables.analysis_permits.find((p) => p.id === permitId);
          const replay = await timed(rows, r, 0, "shots.sync.replay", () =>
            h.handler(
              edgeRequest("POST", "/v1/shots:sync", {
                token: boot.accessToken,
                ip: ip(r, 3),
                body: { shots: [syncShotPayload(shotId, permitId)] },
              }),
            ),
          );
          const replayOk = ((replay.body.acceptedIds ?? []) as string[]).includes(shotId);
          if (replayOk) {
            replayAccepted += 1;
          }
          users.push({
            round: r,
            user: sub,
            permitId,
            shotId,
            accepted,
            rejectedCodes: histogram(codes),
          });
          inv(
            invariants,
            `round ${r}: exactly one shot row, one scored rating, permit finalized`,
            shotRows.length === 1 && scored === 1 && permit?.status === "finalized",
            `rows=${shotRows.length} scored=${scored} permit=${permit?.status}`,
          );
          inv(
            invariants,
            `round ${r}: all ${XC_BURST} syncs are HTTP 200`,
            results.every((x) => x.status === 200),
            JSON.stringify(histogram(results.map((x) => x.status))),
          );
          inv(
            invariants,
            `round ${r}: a later replay of the same shot is accepted (self-heals)`,
            replay.status === 200 && replayOk,
            `replay=${replay.status} accepted=${replayOk}`,
          );
        }
        inputs.rounds = users;
        observations.loserRejectionCodes = histogram(loserCodes);
        observations.acceptedPerRound = users.map((u) => u.accepted);
        observations.replayAccepted = replayAccepted;
        inv(invariants, "no 5xx", no5xx(rows).length === 0, `${no5xx(rows).length} 5xx`);
      },
    );
    for (const i of report.invariants) {
      assert(i.holds, `${i.name}: ${i.detail}`);
    }
    // Losers' verdict — pinned separately in S5b.
  },
);

Deno.test(
  "xc S5b: concurrent duplicate syncs of ONE shot — every copy is accepted (idempotent replay) or told a retryable verdict; a loser is never handed a permanent rejection",
  async () => {
    // Contract: apply_synced_shot is documented idempotent ("Client-generated
    // UUIDs keep re-syncs idempotent", syncShots in index.ts; migration comment
    // "Ours → replay-accept"), and apps/mobile/src/data/sync.ts treats only
    // TRANSIENT_SYNC_REJECTION_CODES as retryable — "every other rejection code
    // is a contract verdict that will not change on replay" and burns one of
    // the outbox row's OUTBOX_MAX_ATTEMPTS. So a copy that lost the race for a
    // row that DOES exist for this user must come back either `accepted` or
    // with a code in that set; anything else is a permanent verdict for a shot
    // the server actually holds.
    //
    // Defect fixed by 20260906000000_apply_synced_shot_replay_after_lock.sql
    // (also reproduced on real Postgres, PG3 in xc_pg_rpc_concurrency.test.ts):
    // with N in-flight copies of the SAME shot (same permit) the winner
    // commits and finalizes the permit; every other copy that serialized
    // behind it on the per-user advisory lock then hit
    // `if v_permit.status <> 'reserved' then return 'access.permit_not_reserved'`
    // BEFORE the unique_violation replay-accept branch could fire, and the
    // edge forwarded that code under `rejected`. The edge's batched pre-RPC
    // replay lookup catches copies that arrive after the winner committed,
    // not the ones already queued on the lock — the RPC now re-checks
    // ownership once it holds the lock (mirrored in the harness model).
    const RETRYABLE_REJECTIONS = new Set([
      "shot.write_failed",
      "evaluation.trial_write_failed",
      "auth.required",
      "shot.session_not_found",
    ]);
    const report = await scenario(
      "s5b_same_shot_loser_verdict",
      "xc S5b",
      { burst: XC_BURST, rounds: XC_ROUNDS },
      async (h, prng, rows, invariants, inputs, observations) => {
        const codes: string[] = [];
        let roundsWithLosers = 0;
        for (let r = 0; r < XC_ROUNDS; r++) {
          const sub = prng.uuid();
          const boot = await bootstrap(h, sub, ip(r, 0));
          const reserved = await timed(rows, r, 0, "permit.reserve", () =>
            h.handler(
              edgeRequest("POST", "/v1/analysis-permits", {
                token: boot.accessToken,
                ip: ip(r, 1),
                body: { idempotencyKey: `s5b-${r}` },
              }),
            ),
          );
          const permitId = String((reserved.body.permit as Record<string, unknown>).id);
          const shotId = prng.uuid();
          const results = await Promise.all(
            Array.from({ length: XC_BURST }, (_, i) =>
              timed(rows, r, i, "shots.sync.sameShot", () =>
                h.handler(
                  edgeRequest("POST", "/v1/shots:sync", {
                    token: boot.accessToken,
                    ip: ip(r, 2),
                    body: { shots: [syncShotPayload(shotId, permitId)] },
                  }),
                ),
              ),
            ),
          );
          const roundCodes: string[] = [];
          for (const res of results) {
            for (const x of (res.body.rejected ?? []) as Array<{ code: string }>) {
              roundCodes.push(x.code);
            }
          }
          codes.push(...roundCodes);
          if (roundCodes.length > 0) roundsWithLosers += 1;
          inv(
            invariants,
            `round ${r}: exactly one row for the shot, every copy answered 200, no write error`,
            h.fake.tables.shots.filter((s) => s.id === shotId).length === 1 &&
              results.every((res) => res.status === 200) &&
              !roundCodes.some((c) => c.startsWith("shot.")),
            `rows=${h.fake.tables.shots.filter((s) => s.id === shotId).length} ${JSON.stringify(
              histogram(roundCodes),
            )}`,
          );
          inv(
            invariants,
            `round ${r}: no copy of a shot the server holds is handed a permanent rejection`,
            roundCodes.every((c) => RETRYABLE_REJECTIONS.has(c)),
            JSON.stringify(histogram(roundCodes)),
          );
        }
        inputs.burst = XC_BURST;
        observations.rejectionCodes = histogram(codes);
        observations.roundsWithLosers = roundsWithLosers;
        observations.permanentRejections = codes.filter((c) => !RETRYABLE_REJECTIONS.has(c)).length;
        inv(
          invariants,
          "losers get a retryable/idempotent verdict across all rounds (accepted or a TRANSIENT_SYNC_REJECTION_CODES member)",
          codes.every((c) => RETRYABLE_REJECTIONS.has(c)),
          `${codes.length} rejections over ${XC_ROUNDS} rounds: ${JSON.stringify(
            histogram(codes),
          )}`,
        );
      },
    );
    for (const i of report.invariants) {
      assert(i.holds, `${i.name}: ${i.detail}`);
    }
  },
);

Deno.test(
  "xc S5c: free-limit backstop under concurrency — three reserved permits, three concurrent scored shots → exactly two ratings spent",
  async () => {
    const report = await scenario(
      "s5c_free_limit_backstop_concurrent",
      "xc S5c",
      { burst: 3, rounds: XC_ROUNDS },
      async (h, prng, rows, invariants, inputs, _observations) => {
        const users: Array<Record<string, unknown>> = [];
        for (let r = 0; r < XC_ROUNDS; r++) {
          const sub = prng.uuid();
          const boot = await bootstrap(h, sub, ip(r, 0));
          const permits: string[] = [];
          for (let i = 0; i < 2; i++) {
            const res = await timed(rows, r, i, "permit.reserve", () =>
              h.handler(
                edgeRequest("POST", "/v1/analysis-permits", {
                  token: boot.accessToken,
                  ip: ip(r, 1),
                  body: { idempotencyKey: `s5c-${r}-${i}` },
                }),
              ),
            );
            permits.push(String((res.body.permit as Record<string, unknown>).id));
          }
          // an over-issued third permit (as any pre-RPC build could have produced)
          const forged = prng.uuid();
          h.fake.tables.analysis_permits.push({
            id: forged,
            user_id: sub,
            idempotency_key: `forged-${r}`,
            status: "reserved",
            outcome: null,
            created_at: new Date().toISOString(),
          });
          permits.push(forged);
          const shotIds = permits.map(() => prng.uuid());
          const results = await Promise.all(
            prng.shuffle(permits.map((p, i) => [p, shotIds[i]] as const)).map(([p, s], i) =>
              timed(rows, r, i, "shots.sync.scored", () =>
                h.handler(
                  edgeRequest("POST", "/v1/shots:sync", {
                    token: boot.accessToken,
                    ip: ip(r, 2),
                    body: { shots: [syncShotPayload(s, p)] },
                  }),
                ),
              ),
            ),
          );
          const acceptedTotal = results.reduce(
            (n, x) => n + ((x.body.acceptedIds ?? []) as string[]).length,
            0,
          );
          const codes = results.flatMap((x) =>
            ((x.body.rejected ?? []) as Array<{ code: string }>).map((y) => y.code),
          );
          const scored = h.fake.tables.shots.filter(
            (s) => s.user_id === sub && s.result_kind === "scored",
          ).length;
          const released = h.fake.tables.analysis_permits.filter(
            (p) => p.user_id === sub && p.outcome === "free_limit_exceeded",
          ).length;
          const access = await timed(rows, r, 0, "me.access", () =>
            h.handler(
              edgeRequest("GET", "/v1/me/access", {
                token: boot.accessToken,
                ip: ip(r, 3),
              }),
            ),
          );
          const fr = (access.body.freeRatings ?? {}) as Record<string, number>;
          users.push({
            round: r,
            user: sub,
            permits,
            shotIds,
            acceptedTotal,
            codes: histogram(codes),
            freeRatings: fr,
          });
          inv(
            invariants,
            `round ${r}: exactly 2 accepted, 1 access.paywall_required, 2 scored rows, forged permit released free_limit_exceeded`,
            acceptedTotal === 2 &&
              codes.length === 1 &&
              codes[0] === "access.paywall_required" &&
              scored === 2 &&
              released === 1,
            `accepted=${acceptedTotal} codes=${JSON.stringify(
              histogram(codes),
            )} scored=${scored} released=${released}`,
          );
          inv(
            invariants,
            `round ${r}: access after the burst: used=2 remaining=0 canStartRating=false`,
            fr.used === 2 && fr.remaining === 0 && access.body.canStartRating === false,
            JSON.stringify(fr),
          );
        }
        inputs.rounds = users;
        inv(invariants, "no 5xx", no5xx(rows).length === 0, `${no5xx(rows).length} 5xx`);
      },
    );
    for (const i of report.invariants) {
      assert(i.holds, `${i.name}: ${i.detail}`);
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// S6 — duplicate webhook delivery
// ─────────────────────────────────────────────────────────────────────────────

Deno.test(
  "xc S6: duplicate RevenueCat deliveries — the reservation winner is the ONLY verifier; every losing copy waits for it and is acked 200 duplicate:true (no 5xx), one audit row; a later replay short-circuits without re-verifying",
  async () => {
    const report = await scenario(
      "s6_duplicate_webhook_delivery",
      "xc S6",
      { burst: XC_BURST, rounds: XC_ROUNDS },
      async (h, prng, rows, invariants, inputs, observations) => {
        const users: Array<Record<string, unknown>> = [];
        let concurrentVerifications = 0;
        for (let r = 0; r < XC_ROUNDS; r++) {
          const sub = prng.uuid();
          const boot = await bootstrap(h, sub, ip(r, 0));
          assertEquals(boot.status, 200);
          const truthPremium = r % 2 === 0;
          h.fake.overrides.subscriber = () =>
            truthPremium
              ? {
                  entitlements: {
                    pickle_sensei_pro: {
                      expires_date: new Date(Date.now() + 86_400_000).toISOString(),
                      product_identifier: "pickle_sensei_pro_monthly",
                    },
                  },
                }
              : { entitlements: {} };
          h.fake.overrides.rcDelayMs = () => 20 + prng.int(0, XC_LATENCY_MS);
          const eventId = `evt-${r}-${prng.uuid()}`;
          // the body LIES about the state (INITIAL_PURCHASE for a non-premium
          // truth, EXPIRATION for a premium truth) — must never be trusted
          const type = truthPremium ? "EXPIRATION" : "INITIAL_PURCHASE";
          const rcBefore = h.fake.counters["rc.get_subscriber"] ?? 0;
          const burst = await Promise.all(
            Array.from({ length: XC_BURST }, (_, i) =>
              timed(rows, r, i, "webhook.dup", () =>
                h.handler(
                  webhookRequest(
                    {
                      id: eventId,
                      type,
                      app_user_id: sub,
                      product_id: "pickle_sensei_pro_monthly",
                    },
                    { ip: ip(r, 9) },
                  ),
                ),
              ),
            ),
          );
          const rcDuring = (h.fake.counters["rc.get_subscriber"] ?? 0) - rcBefore;
          concurrentVerifications += rcDuring;
          const billing = h.fake.tables.billing_entitlements.filter((b) => b.user_id === sub);
          const audit = h.fake.tables.webhook_events.filter((e) => e.id === eventId);
          const replay = await timed(rows, r, 0, "webhook.replay", () =>
            h.handler(
              webhookRequest(
                { id: eventId, type, app_user_id: sub },
                {
                  ip: ip(r, 10),
                },
              ),
            ),
          );
          const rcAfterReplay = (h.fake.counters["rc.get_subscriber"] ?? 0) - rcBefore;
          const access = await timed(rows, r, 0, "me.access", () =>
            h.handler(
              edgeRequest("GET", "/v1/me/access", {
                token: boot.accessToken,
                ip: ip(r, 11),
              }),
            ),
          );
          users.push({
            round: r,
            user: sub,
            eventId,
            truthPremium,
            bodyType: type,
            rcCallsDuringBurst: rcDuring,
            statuses: histogram(
              burst.map((x) => `${x.status}:${x.body.duplicate ? "dup" : x.body.verified}`),
            ),
          });
          inv(
            invariants,
            `round ${r}: every concurrent copy is acknowledged 200 — exactly one verified:true, the rest duplicate:true`,
            burst.every((x) => x.status === 200) &&
              burst.filter((x) => x.body.verified === true).length === 1 &&
              burst.filter((x) => x.body.duplicate === true).length === XC_BURST - 1,
            JSON.stringify(
              histogram(
                burst.map((x) => `${x.status}:${x.body.duplicate ? "dup" : x.body.verified}`),
              ),
            ),
          );
          inv(
            invariants,
            `round ${r}: exactly ONE RevenueCat verification for ${XC_BURST} in-flight copies`,
            rcDuring === 1,
            `rc calls during burst=${rcDuring}`,
          );
          inv(
            invariants,
            `round ${r}: ONE billing row equal to RevenueCat's truth (premium=${truthPremium}), body ignored`,
            billing.length === 1 &&
              Boolean(billing[0].premium) === truthPremium &&
              access.body.premium === truthPremium,
            `rows=${billing.length} premium=${
              billing[0]?.premium
            } access.premium=${access.body.premium}`,
          );
          inv(
            invariants,
            `round ${r}: ONE audit row for the event id`,
            audit.length === 1,
            `rows=${audit.length}`,
          );
          inv(
            invariants,
            `round ${r}: sequential replay → duplicate:true with NO RevenueCat call`,
            replay.status === 200 && replay.body.duplicate === true && rcAfterReplay === rcDuring,
            `replay=${replay.status} dup=${replay.body.duplicate} rc during burst=${rcDuring} after replay=${rcAfterReplay}`,
          );
        }
        h.fake.overrides.subscriber = undefined;
        h.fake.overrides.rcDelayMs = undefined;
        inputs.rounds = users;
        observations.revenuecatVerificationsDuringConcurrentBursts = concurrentVerifications;
        observations.copiesDelivered = XC_BURST * XC_ROUNDS;
        observations.note =
          "The event id is reserved in webhook_events BEFORE RevenueCat is consulted (INSERT … ON CONFLICT DO NOTHING); the single winner verifies + persists, every loser polls the reservation row and acks duplicate:true only once processed_at is set. One verification per event id, no 5xx while the winner completes within the wait bound.";
        inv(invariants, "no 5xx", no5xx(rows).length === 0, `${no5xx(rows).length} 5xx`);
      },
    );
    for (const i of report.invariants) {
      assert(i.holds, `${i.name}: ${i.detail}`);
    }
  },
);

Deno.test(
  "xc S6b: duplicate deliveries whose winner stalls past the wait bound — losers answer 503 + Retry-After (never a false duplicate, never a second verifier); the winner still finalizes and a redelivery after completion is duplicate:true",
  async () => {
    // The bound is injected small so the winner's RevenueCat round trip
    // (rcDelayMs) outlasts it — the isolate-stall / lease-lapse shape.
    const WAIT_MS = 120;
    const STALL_MS = 450;
    Deno.env.set("WEBHOOK_DUPLICATE_WAIT_MS", String(WAIT_MS));
    Deno.env.set("WEBHOOK_DUPLICATE_POLL_MS", "20");
    try {
      const report = await scenario(
        "s6b_duplicate_webhook_winner_stalls",
        "xc S6b",
        { burst: XC_BURST, rounds: XC_ROUNDS, waitMs: WAIT_MS, stallMs: STALL_MS },
        async (h, prng, rows, invariants, inputs, observations) => {
          const users: Array<Record<string, unknown>> = [];
          let verifications = 0;
          for (let r = 0; r < XC_ROUNDS; r++) {
            const sub = prng.uuid();
            const boot = await bootstrap(h, sub, ip(r, 0));
            assertEquals(boot.status, 200);
            const truthPremium = r % 2 === 1;
            h.fake.overrides.subscriber = () =>
              truthPremium
                ? {
                    entitlements: {
                      pickle_sensei_pro: {
                        expires_date: new Date(Date.now() + 86_400_000).toISOString(),
                        product_identifier: "pickle_sensei_pro_monthly",
                      },
                    },
                  }
                : { entitlements: {} };
            h.fake.overrides.rcDelayMs = () => STALL_MS;
            const eventId = `evt-stall-${r}-${prng.uuid()}`;
            const type = truthPremium ? "EXPIRATION" : "INITIAL_PURCHASE";
            const rcBefore = h.fake.counters["rc.get_subscriber"] ?? 0;
            const burst = await Promise.all(
              Array.from({ length: XC_BURST }, (_, i) =>
                timed(rows, r, i, "webhook.dup.stall", () =>
                  h.handler(
                    webhookRequest(
                      {
                        id: eventId,
                        type,
                        app_user_id: sub,
                        product_id: "pickle_sensei_pro_monthly",
                      },
                      { ip: ip(r, 9) },
                    ),
                  ),
                ),
              ),
            );
            const rcDuring = (h.fake.counters["rc.get_subscriber"] ?? 0) - rcBefore;
            verifications += rcDuring;
            const winners = burst.filter((x) => x.status === 200);
            const losers = burst.filter((x) => x.status === 503);
            const billing = h.fake.tables.billing_entitlements.filter((b) => b.user_id === sub);
            const audit = h.fake.tables.webhook_events.filter((e) => e.id === eventId);
            h.fake.overrides.rcDelayMs = undefined;
            const replay = await timed(rows, r, 0, "webhook.replay", () =>
              h.handler(webhookRequest({ id: eventId, type, app_user_id: sub }, { ip: ip(r, 10) })),
            );
            const rcAfterReplay = (h.fake.counters["rc.get_subscriber"] ?? 0) - rcBefore;
            users.push({
              round: r,
              user: sub,
              eventId,
              truthPremium,
              rcCallsDuringBurst: rcDuring,
              statuses: histogram(
                burst.map((x) => `${x.status}:${x.body.duplicate ? "dup" : x.body.verified}`),
              ),
              loserWallMs: losers.map((x) => Math.round(x.row.endedAt - x.row.startedAt)),
            });
            inv(
              invariants,
              `round ${r}: exactly ONE copy is acknowledged (the winner, verified:true); every other copy is 503 + Retry-After`,
              winners.length === 1 &&
                winners[0].body.verified === true &&
                losers.length === XC_BURST - 1 &&
                losers.every((x) => x.retryAfter !== null) &&
                burst.every((x) => x.body.duplicate !== true),
              JSON.stringify(
                histogram(
                  burst.map((x) => `${x.status}:${x.body.duplicate ? "dup" : x.body.verified}`),
                ),
              ),
            );
            inv(
              invariants,
              `round ${r}: losers waited out the bound (≥ ${WAIT_MS} ms) but not the stall (< ${STALL_MS} ms) before refusing`,
              losers.every((x) => {
                const wall = x.row.endedAt - x.row.startedAt;
                return wall >= WAIT_MS && wall < STALL_MS;
              }),
              `loser wall ms=${JSON.stringify(losers.map((x) => Math.round(x.row.endedAt - x.row.startedAt)))}`,
            );
            inv(
              invariants,
              `round ${r}: the winner is the ONLY verifier and its verdict is durable (premium=${truthPremium}, one audit row processed)`,
              rcDuring === 1 &&
                billing.length === 1 &&
                Boolean(billing[0].premium) === truthPremium &&
                audit.length === 1 &&
                typeof audit[0].processed_at === "string",
              `rc=${rcDuring} billing rows=${billing.length} premium=${billing[0]?.premium} audit rows=${audit.length} processed_at=${audit[0]?.processed_at}`,
            );
            inv(
              invariants,
              `round ${r}: RevenueCat's redelivery after completion → duplicate:true with NO RevenueCat call`,
              replay.status === 200 && replay.body.duplicate === true && rcAfterReplay === rcDuring,
              `replay=${replay.status} dup=${replay.body.duplicate} rc during burst=${rcDuring} after replay=${rcAfterReplay}`,
            );
          }
          h.fake.overrides.subscriber = undefined;
          h.fake.overrides.rcDelayMs = undefined;
          inputs.rounds = users;
          observations.revenuecatVerificationsDuringConcurrentBursts = verifications;
          observations.copiesDelivered = XC_BURST * XC_ROUNDS;
          observations.note =
            "A loser never acks what is not durable: when the winner has not set processed_at within WEBHOOK_DUPLICATE_WAIT_MS it answers 503 + Retry-After so RevenueCat redelivers; the redelivery finds the processed row and is a duplicate. The 503s here are the contract, not a defect.";
          inv(
            invariants,
            "the only 5xx are the bounded-wait refusals",
            no5xx(rows).every((x) => x.op === "webhook.dup.stall" && x.status === 503),
            JSON.stringify(histogram(no5xx(rows).map((x) => `${x.op}:${x.status}`))),
          );
        },
      );
      for (const i of report.invariants) {
        assert(i.holds, `${i.name}: ${i.detail}`);
      }
    } finally {
      Deno.env.delete("WEBHOOK_DUPLICATE_WAIT_MS");
      Deno.env.delete("WEBHOOK_DUPLICATE_POLL_MS");
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// S7 — rate-limit counter atomicity under a burst (memory path)
// ─────────────────────────────────────────────────────────────────────────────

Deno.test(
  "xc S7: rate limiter under a same-IP burst admits exactly the budget (PUBLIC_PAGE_LIMIT=60 on /healthz)",
  async () => {
    const report = await scenario(
      "s7_rate_limit_burst",
      "xc S7",
      { burst: 100, rounds: 1 },
      async (h, _prng, rows, invariants, inputs) => {
        const results = await Promise.all(
          Array.from({ length: 100 }, (_, i) =>
            timed(rows, 0, i, "healthz", () =>
              h.handler(edgeRequest("GET", "/healthz", { ip: "192.0.2.42" })),
            ),
          ),
        );
        const ok = results.filter((x) => x.status === 200).length;
        const limited = results.filter((x) => x.status === 429).length;
        inputs.limit = 60;
        inv(
          invariants,
          "exactly 60 admitted, 40 refused with 429",
          ok === 60 && limited === 40,
          `ok=${ok} 429=${limited}`,
        );
      },
    );
    for (const i of report.invariants) {
      assert(i.holds, `${i.name}: ${i.detail}`);
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// Matrix summary (runs last: Deno executes tests in file order)
// ─────────────────────────────────────────────────────────────────────────────

Deno.test("xc: write matrix.json", async () => {
  const dir = outDir();
  const files: string[] = [];
  for await (const entry of Deno.readDir(dir)) {
    if (entry.isFile && entry.name.startsWith("s") && entry.name.endsWith(".json")) {
      files.push(entry.name);
    }
  }
  files.sort();
  const matrix = [];
  for (const file of files) {
    const report = JSON.parse(await Deno.readTextFile(`${dir}${file}`)) as ScenarioReport;
    matrix.push({
      scenario: report.scenario,
      seed: report.seed,
      scale: report.scale,
      requests: report.requests.length,
      statusHistogram: report.statusHistogram,
      invariantsHold: report.invariants.filter((i) => i.holds).length,
      invariantsTotal: report.invariants.length,
      broken: report.invariants.filter((i) => !i.holds).map((i) => i.name),
      durationMs: report.durationMs,
      heapUsedAfter: report.heap.after.heapUsed,
      rssAfter: report.heap.after.rss,
      replay: report.replay,
    });
  }
  const summary = {
    generatedAt: new Date().toISOString(),
    deno: Deno.version,
    env: { XC_SEED, XC_BURST, XC_ROUNDS, XC_LATENCY_MS },
    scenarios: matrix,
  };
  await Deno.writeTextFile(`${dir}matrix.json`, JSON.stringify(summary, null, 2));
  console.log(`[xc] matrix → ${dir}matrix.json`);
  assert(matrix.length >= 10, `expected ≥10 scenario reports, found ${matrix.length}`);
});
