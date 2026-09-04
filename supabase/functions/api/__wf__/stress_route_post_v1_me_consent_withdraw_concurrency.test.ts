/**
 * stress-consent-withdraw — CONCURRENCY campaign against the REAL edge route
 * POST /v1/me/consent/withdraw (supabase/functions/api/index.ts:1864-1889,
 * loadConsentRows 1795-1805, foldConsentStatus 1815-1828).
 *
 * The handler is the shipped one (../index.ts, Deno.serve captured by
 * loadXcHarness); Supabase Auth/PostgREST/RevenueCat are the xc harness
 * models, `consent_records` is the Postgres-faithful append-only model in
 * ./stress_consent_withdraw_harness.ts (now() at transaction start,
 * gen_random_uuid ids, RLS by JWT sub, `order by created_at, id`).
 *
 * Every round is one interleaving: a fresh account, a seeded PRNG, N lanes
 * released together through Promise.all, seeded per-statement latency, and a
 * post-settle audit of the persisted ledger against the responses the callers
 * were given. Failures are collected per round (never thrown from inside a
 * lane) so one campaign reports every violating seed instead of the first.
 *
 *   deno task test                                   # default fast campaign
 *   STRESS_ITER=640 XC_OUT_DIR=/tmp/stress-consent/ \
 *     deno test -A --no-check --config deno.json \
 *     stress_route_post_v1_me_consent_withdraw_concurrency.test.ts
 *
 * Artifacts (XC_OUT_DIR, default artifacts/xc-matrix-concurrency-edge/latest/):
 *   stress_consent_withdraw_rounds.json   seed → per-round outcome table
 *   stress_consent_withdraw_<scenario>.json  one ScenarioReport per scenario
 */
import { assert, assertEquals } from "@std/assert";
import {
  bootstrap,
  edgeRequest,
  envInt,
  histogram,
  type Invariant,
  jwtPayload,
  Prng,
  readJson,
  type ScenarioReport,
  writeReport,
  XC_SEED,
  type XcHarness,
} from "./xc_concurrency_harness.ts";
import {
  CONSENT_SCOPES,
  type ConsentScope,
  type ConsentStressHarness,
  loadConsentStress,
  scopeStatus,
  type StoredConsentRow,
} from "./stress_consent_withdraw_harness.ts";

/** Total interleavings (rounds) for the whole campaign. Small by default so
 *  this file stays in `deno task test`; the graded campaign runs 640. */
const STRESS_ITER = envInt("STRESS_ITER", 24);
const LANES = envInt("STRESS_LANES", 8);
const SEED = envInt("STRESS_SEED", XC_SEED);
const LATENCY_MS = envInt("STRESS_LATENCY_MS", 8);
/** A round that cannot settle inside this budget is treated as a deadlock. */
const ROUND_BUDGET_MS = envInt("STRESS_ROUND_BUDGET_MS", 10_000);

const MODEL_TRAINING_VERSION = "model-training-v1";
const TELEMETRY_VERSION = "evaluation-telemetry-v1";

interface RoundRow {
  scenario: string;
  seed: number;
  round: number;
  lanes: number;
  statuses: Record<string, number>;
  ledger: { grant: number; withdraw: number; total: number };
  finalActive: Record<string, boolean>;
  wallMs: number;
  failures: string[];
  notes: Record<string, unknown>;
}

const ROUNDS: RoundRow[] = [];
let REQUESTS_EXECUTED = 0;
let USER_SEQ = 0;

function rounds(fraction: number): number {
  return Math.max(1, Math.round(STRESS_ITER * fraction));
}

function replay(scenario: string, seed: number): string {
  return `STRESS_SEED=${seed} STRESS_ITER=1 STRESS_LANES=${LANES} ` +
    `STRESS_LATENCY_MS=${LATENCY_MS} deno test -A --no-check --config deno.json ` +
    `stress_route_post_v1_me_consent_withdraw_concurrency.test.ts --filter "${scenario}"`;
}

async function call(h: XcHarness, request: Request): Promise<Response> {
  REQUESTS_EXECUTED += 1;
  return await h.handler(request);
}

interface Actor {
  sub: string;
  token: string;
  refreshToken: string;
  ip: string;
}

/** A brand-new account through the REAL bootstrap route. Fresh per round:
 *  the per-user consent budget is 30/60s (index.ts ROUTE_LIMITS) and the
 *  per-isolate rate-limit/auth-cache state outlives a scenario. */
async function freshActor(h: XcHarness, prng: Prng): Promise<Actor> {
  USER_SEQ += 1;
  const ip = `198.18.${(USER_SEQ >> 8) & 255}.${USER_SEQ & 255}`;
  REQUESTS_EXECUTED += 1;
  const sub = prng.uuid();
  const session = await bootstrap(h, sub, ip);
  assertEquals(
    session.status,
    200,
    "bootstrap must mint a session for a fresh account",
  );
  assertEquals(
    jwtPayload(session.accessToken)?.sub,
    sub,
    "the minted access token must belong to the bootstrapped subject",
  );
  return {
    sub,
    token: session.accessToken,
    refreshToken: session.refreshToken,
    ip,
  };
}

/** A second live session for the same account (a second device). */
async function secondSession(h: XcHarness, actor: Actor): Promise<string> {
  USER_SEQ += 1;
  const ip = `198.19.${(USER_SEQ >> 8) & 255}.${USER_SEQ & 255}`;
  REQUESTS_EXECUTED += 1;
  const again = await h.handler(
    edgeRequest("POST", "/v1/account/bootstrap", {
      token: fakeIdTokenFor(actor.sub),
      ip,
      body: {},
    }),
  );
  const body = await readJson(again);
  const session = body.session as Record<string, unknown> | undefined;
  assertEquals(again.status, 200, "second device bootstrap must succeed");
  return String(session?.accessToken ?? "");
}

function b64url(value: string): string {
  return btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fakeIdTokenFor(sub: string): string {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({
      iss: "https://accounts.google.com",
      sub,
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
  );
  return `${header}.${payload}.sig`;
}

function withdrawRequest(
  actor: { token: string; ip: string },
  scope: string,
  extra: Record<string, unknown> = {},
): Request {
  return edgeRequest("POST", "/v1/me/consent/withdraw", {
    token: actor.token,
    ip: actor.ip,
    body: {
      scope,
      source: "mobile_settings",
      device: "iPhone17,1 / 26.0",
      ...extra,
    },
  });
}

function grantRequest(
  actor: { token: string; ip: string },
  scope: string,
  version: string,
): Request {
  return edgeRequest("POST", "/v1/me/consent/grant", {
    token: actor.token,
    ip: actor.ip,
    body: {
      scope,
      consentVersion: version,
      source: "mobile_settings",
      device: "iPhone17,1 / 26.0",
      captureMode: "all_captures",
    },
  });
}

/** The contract the mobile parser enforces (consentApi.ts parseStatus 57-104):
 *  all three scopes present, active ⇔ lastAction === 'granted'. */
function checkStatusShape(
  body: Record<string, unknown>,
  where: string,
  failures: string[],
): void {
  const scopes = Array.isArray(body.scopes) ? body.scopes : null;
  if (!scopes || scopes.length !== CONSENT_SCOPES.length) {
    failures.push(
      `${where}: response does not carry all ${CONSENT_SCOPES.length} scopes`,
    );
    return;
  }
  if (!("subjectPseudonym" in body)) {
    failures.push(`${where}: subjectPseudonym missing`);
  }
  for (const scope of CONSENT_SCOPES) {
    const row = scopeStatus(body, scope);
    if (!row) {
      failures.push(`${where}: scope ${scope} missing`);
      continue;
    }
    if (
      row.lastAction !== null && row.lastAction !== "granted" &&
      row.lastAction !== "withdrawn"
    ) {
      failures.push(`${where}: scope ${scope} lastAction=${row.lastAction}`);
    }
    if (row.active !== (row.lastAction === "granted")) {
      failures.push(
        `${where}: scope ${scope} active=${row.active} but lastAction=${row.lastAction}`,
      );
    }
  }
}

/** Contract from the route's own docstring (index.ts:1864-1867): "The
 *  withdrawal row carries forward the version being withdrawn from (or null
 *  when the scope was never granted)". Checked against the ledger as the
 *  fold reads it: for every withdraw row, the newest grant row that PRECEDES
 *  it in `order by created_at, id` defines the version being withdrawn. */
function versionCarryForwardViolations(
  ledger: StoredConsentRow[],
  where: string,
): string[] {
  const out: string[] = [];
  for (const [index, row] of ledger.entries()) {
    if (row.action !== "withdraw") continue;
    const priorGrant = ledger
      .slice(0, index)
      .filter((r) => r.scope === row.scope && r.action === "grant")
      .at(-1) ?? null;
    const expected = priorGrant?.consent_version ?? null;
    if (row.consent_version !== expected) {
      out.push(
        `${where}: withdraw row ${row.id} (scope=${row.scope}) carries ` +
          `consent_version=${row.consent_version} but the grant it withdraws from is ` +
          `${expected} (${
            priorGrant ? `grant row ${priorGrant.id}` : "no prior grant"
          })`,
      );
    }
  }
  return out;
}

function checkVersionCarryForward(
  ledger: StoredConsentRow[],
  failures: string[],
  where: string,
): void {
  failures.push(...versionCarryForwardViolations(ledger, where));
}

/** Independent fold of the persisted ledger — must equal what the route says. */
function foldLedger(ledger: StoredConsentRow[]): Record<string, ScopeFold> {
  const out: Record<string, ScopeFold> = {};
  for (const scope of CONSENT_SCOPES) {
    const last = ledger.filter((r) => r.scope === scope).at(-1) ?? null;
    out[scope] = {
      active: last?.action === "grant",
      consentVersion: last?.consent_version ?? null,
      lastActionAt: last?.created_at ?? null,
    };
  }
  return out;
}

interface ScopeFold {
  active: boolean;
  consentVersion: string | null;
  lastActionAt: string | null;
}

async function statusOf(
  h: XcHarness,
  actor: Actor,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await call(
    h,
    edgeRequest("GET", "/v1/me/consent/status", {
      token: actor.token,
      ip: actor.ip,
    }),
  );
  return { status: response.status, body: await readJson(response) };
}

/** Compare the route's folded answer with an independent fold of the rows. */
function checkServerAgreesWithLedger(
  body: Record<string, unknown>,
  ledger: StoredConsentRow[],
  failures: string[],
  where: string,
): void {
  const fold = foldLedger(ledger);
  for (const scope of CONSENT_SCOPES) {
    const row = scopeStatus(body, scope);
    if (!row) continue;
    const expected = fold[scope];
    if (
      row.active !== expected.active ||
      row.consentVersion !== expected.consentVersion ||
      row.lastActionAt !== expected.lastActionAt
    ) {
      failures.push(
        `${where}: scope ${scope} response ${
          JSON.stringify(row)
        } disagrees with the ` +
          `persisted ledger ${JSON.stringify(expected)}`,
      );
    }
  }
}

function ledgerCounts(ledger: StoredConsentRow[]) {
  return {
    grant: ledger.filter((r) => r.action === "grant").length,
    withdraw: ledger.filter((r) => r.action === "withdraw").length,
    total: ledger.length,
  };
}

async function finishScenario(
  scenario: string,
  label: string,
  h: ConsentStressHarness,
  rows: RoundRow[],
  observations: Record<string, unknown>,
  invariants: Invariant[],
): Promise<void> {
  const report: ScenarioReport = {
    scenario: `stress_consent_withdraw_${scenario}`,
    label,
    seed: SEED,
    scale: { rounds: rows.length, lanes: LANES, latencyMaxMs: LATENCY_MS },
    inputs: { scopes: [...CONSENT_SCOPES], iter: STRESS_ITER },
    statusHistogram: histogram(
      rows.flatMap((r) =>
        Object.entries(r.statuses).flatMap(([status, n]) =>
          Array(n).fill(status)
        )
      ),
    ),
    counters: { ...h.store.counters },
    invariants,
    observations: {
      ...observations,
      roundsWithFailures: rows.filter((r) => r.failures.length > 0).length,
    },
    timeline: [],
    requests: rows as unknown as Array<Record<string, unknown>>,
    durationMs: rows.reduce((sum, r) => sum + r.wallMs, 0),
    heap: { before: Deno.memoryUsage(), after: Deno.memoryUsage() },
    replay: replay(scenario, SEED),
  };
  await writeReport(report);
  ROUNDS.push(...rows);
  const failing = rows.filter((r) => r.failures.length > 0);
  assertEquals(
    failing.map((r) =>
      `seed=${r.seed} round=${r.round}: ${r.failures.join(" | ")}`
    ),
    [],
    `${scenario}: invariant violations (replay: ${replay(scenario, SEED)})`,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// S1 — duplicate delivery: N identical withdraws released together.
// ─────────────────────────────────────────────────────────────────────────────
Deno.test("stress-consent-withdraw S1: duplicate delivery — N concurrent identical withdraws are idempotent in state, append-only in rows, no 5xx", async () => {
  const h = await loadConsentStress();
  const rows: RoundRow[] = [];
  const total = rounds(0.2);
  let duplicateRowTotal = 0;
  for (let round = 0; round < total; round++) {
    const seed = SEED + round * 7919;
    const prng = new Prng(seed);
    h.store.reset(seed, { latencyMaxMs: LATENCY_MS });
    const actor = await freshActor(h, prng);
    const scope: ConsentScope = "model_training";
    const failures: string[] = [];
    const granted = await call(
      h,
      grantRequest(actor, scope, MODEL_TRAINING_VERSION),
    );
    if (granted.status !== 200) {
      failures.push(`setup grant → ${granted.status}`);
    }
    await readJson(granted);

    const started = performance.now();
    const responses = await Promise.all(
      Array.from(
        { length: LANES },
        () => call(h, withdrawRequest(actor, scope)),
      ),
    );
    const wallMs = performance.now() - started;
    const bodies = await Promise.all(responses.map((r) => readJson(r)));
    const statuses = histogram(responses.map((r) => r.status));

    for (const [lane, response] of responses.entries()) {
      if (response.status !== 200) {
        failures.push(`lane ${lane} → ${response.status}`);
      }
      checkStatusShape(bodies[lane], `lane ${lane}`, failures);
      const row = scopeStatus(bodies[lane], scope);
      if (row && row.active) {
        failures.push(`lane ${lane}: withdraw answered active=true`);
      }
      if (row && row.lastAction !== "withdrawn") {
        failures.push(`lane ${lane}: lastAction=${row.lastAction}`);
      }
    }
    const ledger = h.store.ofUser(actor.sub);
    const counts = ledgerCounts(ledger);
    const ok200 = responses.filter((r) => r.status === 200).length;
    if (counts.withdraw !== ok200) {
      failures.push(
        `ledger has ${counts.withdraw} withdraw rows for ${ok200} accepted withdraws`,
      );
    }
    if (counts.grant !== 1) {
      failures.push(`grant row count ${counts.grant} != 1`);
    }
    if (ledger.some((r) => r.user_id !== actor.sub)) {
      failures.push("foreign user_id in ledger");
    }
    checkVersionCarryForward(ledger, failures, "S1");
    const status = await statusOf(h, actor);
    checkServerAgreesWithLedger(
      status.body,
      ledger,
      failures,
      "S1 final status",
    );
    const finalRow = scopeStatus(status.body, scope);
    if (finalRow?.active !== false) {
      failures.push("final status is not withdrawn");
    }
    if (wallMs > ROUND_BUDGET_MS) {
      failures.push(`round took ${wallMs}ms (deadlock budget)`);
    }
    duplicateRowTotal += counts.withdraw;

    rows.push({
      scenario: "S1",
      seed,
      round,
      lanes: LANES,
      statuses,
      ledger: counts,
      finalActive: Object.fromEntries(
        CONSENT_SCOPES.map((
          s,
        ) => [s, scopeStatus(status.body, s)?.active === true]),
      ),
      wallMs: Math.round(wallMs * 100) / 100,
      failures,
      notes: { withdrawRows: counts.withdraw, accepted: ok200 },
    });
  }
  await finishScenario(
    "s1_duplicate_delivery",
    "N concurrent identical withdraws — idempotent state, append-only rows",
    h,
    rows,
    { withdrawRowsTotal: duplicateRowTotal, lanesPerRound: LANES },
    [
      {
        name: "no 5xx / every lane 200",
        holds: rows.every((r) =>
          Object.keys(r.statuses).every((s) => s === "200")
        ),
        detail:
          "duplicate delivery of the same withdrawal never fails a caller",
      },
      {
        name: "final state withdrawn (idempotent)",
        holds: rows.every((r) => r.finalActive.model_training === false),
        detail:
          "the fold is action-idempotent even though rows are append-only",
      },
      {
        name:
          "rows appended == accepted withdraws (no double write, no lost write)",
        holds: rows.every((r) => r.notes.withdrawRows === r.notes.accepted),
        detail: "one accepted call ⇒ exactly one ledger row",
      },
    ],
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// S2 — call-during-call: grants and withdraws for one scope released together.
// ─────────────────────────────────────────────────────────────────────────────
Deno.test("stress-consent-withdraw S2: grant-during-withdraw — no 5xx, no lost write, response agrees with the ledger, withdrawal version carry-forward", async () => {
  const h = await loadConsentStress();
  const rows: RoundRow[] = [];
  const total = rounds(0.2);
  let staleVersionRounds = 0;
  for (let round = 0; round < total; round++) {
    const seed = SEED + 100_000 + round * 6151;
    const prng = new Prng(seed);
    h.store.reset(seed, { latencyMaxMs: LATENCY_MS });
    const actor = await freshActor(h, prng);
    const scope: ConsentScope = "model_training";
    const failures: string[] = [];

    // Seeded lane plan: a mix of grants and withdraws, order shuffled.
    const plan = prng.shuffle(
      Array.from(
        { length: LANES },
        (_, i) => (i % 2 === 0 ? "withdraw" : "grant"),
      ),
    );
    const started = performance.now();
    const responses = await Promise.all(
      plan.map((op) =>
        op === "grant"
          ? call(h, grantRequest(actor, scope, MODEL_TRAINING_VERSION))
          : call(h, withdrawRequest(actor, scope))
      ),
    );
    const wallMs = performance.now() - started;
    const bodies = await Promise.all(responses.map((r) => readJson(r)));
    const statuses = histogram(responses.map((r) => r.status));

    for (const [lane, response] of responses.entries()) {
      if (response.status >= 500) {
        failures.push(`lane ${lane} (${plan[lane]}) → ${response.status}`);
      }
      if (response.status !== 200) {
        failures.push(`lane ${lane} (${plan[lane]}) → ${response.status}`);
      }
      checkStatusShape(bodies[lane], `lane ${lane}`, failures);
    }
    const ledger = h.store.ofUser(actor.sub);
    const counts = ledgerCounts(ledger);
    const expectGrants = plan.filter((op, i) =>
      op === "grant" && responses[i].status === 200
    ).length;
    const expectWithdraws = plan.filter((op, i) =>
      op === "withdraw" && responses[i].status === 200
    ).length;
    if (counts.grant !== expectGrants) {
      failures.push(
        `ledger grant rows ${counts.grant} != accepted grants ${expectGrants}`,
      );
    }
    if (counts.withdraw !== expectWithdraws) {
      failures.push(
        `ledger withdraw rows ${counts.withdraw} != accepted withdraws ${expectWithdraws}`,
      );
    }
    // Concurrent grants are in this burst by construction, so the ledger's
    // version carry-forward is RECORDED here (see S9 for the minimized,
    // asserted repro) instead of failing every round of this scenario.
    const staleVersions = versionCarryForwardViolations(ledger, "S2");
    if (staleVersions.length > 0) staleVersionRounds += 1;
    const status = await statusOf(h, actor);
    checkServerAgreesWithLedger(
      status.body,
      ledger,
      failures,
      "S2 final status",
    );
    if (wallMs > ROUND_BUDGET_MS) {
      failures.push(`round took ${wallMs}ms (deadlock budget)`);
    }

    rows.push({
      scenario: "S2",
      seed,
      round,
      lanes: LANES,
      statuses,
      ledger: counts,
      finalActive: Object.fromEntries(
        CONSENT_SCOPES.map((
          s,
        ) => [s, scopeStatus(status.body, s)?.active === true]),
      ),
      wallMs: Math.round(wallMs * 100) / 100,
      failures,
      notes: {
        plan,
        withdrawVersions: ledger.filter((r) => r.action === "withdraw").map((
          r,
        ) => r.consent_version),
        staleVersions,
      },
    });
  }
  await finishScenario(
    "s2_grant_during_withdraw",
    "grants and withdraws for one scope released together",
    h,
    rows,
    { staleVersionRounds, lanesPerRound: LANES },
    [
      {
        name: "no 5xx under grant/withdraw contention",
        holds: rows.every((r) =>
          Object.keys(r.statuses).every((s) => Number(s) < 500)
        ),
        detail: "read-modify-append races never surface as a server error",
      },
      {
        name: "withdrawal carries the version it withdraws from",
        holds: staleVersionRounds === 0,
        detail:
          `${staleVersionRounds}/${rows.length} rounds recorded a withdrawal whose ` +
          "consent_version disagrees with the grant it supersedes in the ledger " +
          "(BROKEN — asserted with a minimized repro in S9)",
      },
      {
        name:
          "accepted calls == appended rows (no lost write, no double write)",
        holds: rows.every((r) =>
          !r.failures.some((f) =>
            f.includes("ledger grant rows") ||
            f.includes("ledger withdraw rows")
          )
        ),
        detail:
          "read-modify-append under contention neither drops nor duplicates a row",
      },
    ],
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// S3 — two actors: same account on two devices, and two accounts at once.
// ─────────────────────────────────────────────────────────────────────────────
Deno.test("stress-consent-withdraw S3: two actors — two sessions of one account and two accounts in one burst never cross ledgers", async () => {
  const h = await loadConsentStress();
  const rows: RoundRow[] = [];
  const total = rounds(0.14);
  for (let round = 0; round < total; round++) {
    const seed = SEED + 200_000 + round * 5279;
    const prng = new Prng(seed);
    h.store.reset(seed, { latencyMaxMs: LATENCY_MS });
    const actorA = await freshActor(h, prng);
    const actorB = await freshActor(h, prng);
    const tokenA2 = await secondSession(h, actorA);
    const scope: ConsentScope = "evaluation_telemetry";
    const failures: string[] = [];
    for (const actor of [actorA, actorB]) {
      const granted = await call(
        h,
        grantRequest(actor, scope, TELEMETRY_VERSION),
      );
      if (granted.status !== 200) {
        failures.push(`setup grant → ${granted.status}`);
      }
      await readJson(granted);
    }

    const lanes: Array<{ who: string; request: Request }> = [];
    for (let i = 0; i < LANES; i++) {
      const pick = prng.int(0, 2);
      if (pick === 0) {
        lanes.push({
          who: "A/device1",
          request: withdrawRequest(actorA, scope),
        });
      } else if (pick === 1) {
        lanes.push({
          who: "A/device2",
          request: withdrawRequest({ token: tokenA2, ip: actorA.ip }, scope),
        });
      } else lanes.push({ who: "B", request: withdrawRequest(actorB, scope) });
    }
    const started = performance.now();
    const responses = await Promise.all(
      lanes.map((lane) => call(h, lane.request)),
    );
    const wallMs = performance.now() - started;
    const bodies = await Promise.all(responses.map((r) => readJson(r)));
    const statuses = histogram(responses.map((r) => r.status));

    for (const [lane, response] of responses.entries()) {
      if (response.status !== 200) {
        failures.push(`lane ${lane} (${lanes[lane].who}) → ${response.status}`);
      }
      checkStatusShape(bodies[lane], `lane ${lane}`, failures);
      const row = scopeStatus(bodies[lane], scope);
      if (row?.active) {
        failures.push(`lane ${lane} (${lanes[lane].who}) answered active=true`);
      }
    }
    const ledgerA = h.store.ofUser(actorA.sub);
    const ledgerB = h.store.ofUser(actorB.sub);
    const acceptedA = lanes.filter((lane, i) =>
      lane.who.startsWith("A") && responses[i].status === 200
    ).length;
    const acceptedB = lanes.filter((lane, i) =>
      lane.who === "B" && responses[i].status === 200
    ).length;
    if (
      ledgerA.filter((r) =>
        r.action === "withdraw"
      ).length !== acceptedA
    ) {
      failures.push(
        `A withdraw rows ${ledgerA.length} vs accepted ${acceptedA}`,
      );
    }
    if (ledgerB.filter((r) => r.action === "withdraw").length !== acceptedB) {
      failures.push(
        `B withdraw rows ${ledgerB.length} vs accepted ${acceptedB}`,
      );
    }
    if (
      ledgerA.some((r) => r.user_id !== actorA.sub) ||
      ledgerB.some((r) => r.user_id !== actorB.sub)
    ) {
      failures.push("cross-user row in a per-user ledger read");
    }
    checkVersionCarryForward(ledgerA, failures, "S3/A");
    checkVersionCarryForward(ledgerB, failures, "S3/B");
    const statusA = await statusOf(h, actorA);
    const statusB = await statusOf(h, actorB);
    checkServerAgreesWithLedger(statusA.body, ledgerA, failures, "S3/A status");
    checkServerAgreesWithLedger(statusB.body, ledgerB, failures, "S3/B status");
    // Untouched scopes must be unaffected by this scope's traffic.
    for (const other of CONSENT_SCOPES.filter((s) => s !== scope)) {
      if (scopeStatus(statusA.body, other)?.lastAction !== null) {
        failures.push(`scope ${other} changed while only ${scope} was driven`);
      }
    }
    if (wallMs > ROUND_BUDGET_MS) {
      failures.push(
        `round took ${wallMs}ms (deadlock budget)`,
      );
    }

    rows.push({
      scenario: "S3",
      seed,
      round,
      lanes: LANES,
      statuses,
      ledger: ledgerCounts([...ledgerA, ...ledgerB]),
      finalActive: {
        A: scopeStatus(statusA.body, scope)?.active === true,
        B: scopeStatus(statusB.body, scope)?.active === true,
      },
      wallMs: Math.round(wallMs * 100) / 100,
      failures,
      notes: { plan: lanes.map((l) => l.who), acceptedA, acceptedB },
    });
  }
  await finishScenario(
    "s3_two_actors",
    "two devices of one account + a second account in the same burst",
    h,
    rows,
    { lanesPerRound: LANES },
    [
      {
        name: "no cross-user rows, no cross-user reads",
        holds: rows.every((r) =>
          !r.failures.some((f) => f.includes("cross-user"))
        ),
        detail:
          "RLS-scoped read + insert keeps both ledgers disjoint under contention",
      },
      {
        name: "scope isolation",
        holds: rows.every((r) =>
          !r.failures.some((f) => f.includes("changed while only"))
        ),
        detail: "withdrawing one scope never touches the other two",
      },
    ],
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// S4 — all three scopes driven at once on one account.
// ─────────────────────────────────────────────────────────────────────────────
Deno.test("stress-consent-withdraw S4: all scopes at once — per-scope folds stay independent under a mixed grant/withdraw burst", async () => {
  const h = await loadConsentStress();
  const rows: RoundRow[] = [];
  const total = rounds(0.12);
  for (let round = 0; round < total; round++) {
    const seed = SEED + 300_000 + round * 4231;
    const prng = new Prng(seed);
    h.store.reset(seed, { latencyMaxMs: LATENCY_MS });
    const actor = await freshActor(h, prng);
    const failures: string[] = [];
    const plan: Array<{ scope: ConsentScope; op: "grant" | "withdraw" }> = [];
    for (let i = 0; i < LANES; i++) {
      const scope = CONSENT_SCOPES[prng.int(0, CONSENT_SCOPES.length - 1)];
      plan.push({ scope, op: prng.next() < 0.6 ? "withdraw" : "grant" });
    }
    const started = performance.now();
    const responses = await Promise.all(
      plan.map((lane) =>
        lane.op === "grant"
          ? call(h, grantRequest(actor, lane.scope, `${lane.scope}-v1`))
          : call(h, withdrawRequest(actor, lane.scope))
      ),
    );
    const wallMs = performance.now() - started;
    const bodies = await Promise.all(responses.map((r) => readJson(r)));
    const statuses = histogram(responses.map((r) => r.status));
    for (const [lane, response] of responses.entries()) {
      if (response.status !== 200) {
        failures.push(`lane ${lane} → ${response.status}`);
      }
      checkStatusShape(bodies[lane], `lane ${lane}`, failures);
    }
    const ledger = h.store.ofUser(actor.sub);
    const counts = ledgerCounts(ledger);
    if (counts.total !== responses.filter((r) => r.status === 200).length) {
      failures.push(`ledger rows ${counts.total} != accepted lanes`);
    }
    for (const scope of CONSENT_SCOPES) {
      const wrote = plan.filter((lane, i) =>
        lane.scope === scope && responses[i].status === 200
      ).length;
      const stored = ledger.filter((r) =>
        r.scope === scope
      ).length;
      if (stored !== wrote) {
        failures.push(
          `scope ${scope}: ${stored} rows for ${wrote} accepted lanes`,
        );
      }
    }
    const staleVersions = versionCarryForwardViolations(ledger, "S4");
    const status = await statusOf(h, actor);
    checkServerAgreesWithLedger(
      status.body,
      ledger,
      failures,
      "S4 final status",
    );
    if (wallMs > ROUND_BUDGET_MS) {
      failures.push(`round took ${wallMs}ms (deadlock budget)`);
    }
    rows.push({
      scenario: "S4",
      seed,
      round,
      lanes: LANES,
      statuses,
      ledger: counts,
      finalActive: Object.fromEntries(
        CONSENT_SCOPES.map((
          s,
        ) => [s, scopeStatus(status.body, s)?.active === true]),
      ),
      wallMs: Math.round(wallMs * 100) / 100,
      failures,
      notes: { plan, staleVersions },
    });
  }
  await finishScenario(
    "s4_all_scopes",
    "mixed grant/withdraw burst across all three scopes",
    h,
    rows,
    { lanesPerRound: LANES },
    [
      {
        name: "per-scope row accounting exact",
        holds: rows.every((r) =>
          !r.failures.some((f) => f.includes("rows for"))
        ),
        detail: "every accepted lane appended exactly one row to its own scope",
      },
    ],
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// S5 — rotation / logout during the call.
// ─────────────────────────────────────────────────────────────────────────────
Deno.test("stress-consent-withdraw S5: logout/refresh during withdraw — every lane is 200 or 401, a 401 never writes, and a post-logout bearer is refused", async () => {
  const h = await loadConsentStress();
  const rows: RoundRow[] = [];
  const total = rounds(0.14);
  for (let round = 0; round < total; round++) {
    const seed = SEED + 400_000 + round * 3499;
    const prng = new Prng(seed);
    h.store.reset(seed, { latencyMaxMs: LATENCY_MS });
    const actor = await freshActor(h, prng);
    const scope: ConsentScope = "model_training";
    const failures: string[] = [];
    const granted = await call(
      h,
      grantRequest(actor, scope, MODEL_TRAINING_VERSION),
    );
    if (granted.status !== 200) {
      failures.push(`setup grant → ${granted.status}`);
    }
    await readJson(granted);

    const lanes: Array<Promise<Response>> = [];
    const kinds: string[] = [];
    for (let i = 0; i < LANES - 2; i++) {
      kinds.push("withdraw");
      lanes.push(call(h, withdrawRequest(actor, scope)));
    }
    kinds.push("refresh");
    lanes.push(
      call(
        h,
        edgeRequest("POST", "/v1/auth/refresh", {
          ip: actor.ip,
          body: { refreshToken: actor.refreshToken },
        }),
      ),
    );
    kinds.push("logout");
    lanes.push(
      call(
        h,
        edgeRequest("POST", "/v1/auth/logout", {
          token: actor.token,
          ip: actor.ip,
        }),
      ),
    );
    const started = performance.now();
    const responses = await Promise.all(lanes);
    const wallMs = performance.now() - started;
    const statuses = histogram(responses.map((r) => r.status));
    const bodies = await Promise.all(responses.map((r) => readJson(r)));

    let accepted = 0;
    for (const [lane, response] of responses.entries()) {
      if (kinds[lane] !== "withdraw") continue;
      if (response.status === 200) {
        accepted += 1;
        checkStatusShape(bodies[lane], `lane ${lane}`, failures);
      } else if (response.status !== 401) {
        failures.push(
          `withdraw lane ${lane} → ${response.status} (expected 200 or 401)`,
        );
      }
    }
    const ledger = h.store.ofUser(actor.sub);
    const withdrawRows = ledger.filter((r) => r.action === "withdraw").length;
    if (withdrawRows !== accepted) {
      failures.push(
        `${withdrawRows} withdraw rows for ${accepted} accepted withdraws`,
      );
    }
    checkVersionCarryForward(ledger, failures, "S5");
    // The logged-out bearer must be refused once logout has settled, and must
    // not write anything (session revocation fence + auth-cache eviction).
    const rowsBefore = h.store.rows.length;
    const after = await call(h, withdrawRequest(actor, scope));
    await readJson(after);
    if (after.status !== 401) {
      failures.push(`post-logout withdraw → ${after.status} (expected 401)`);
    }
    if (h.store.rows.length !== rowsBefore) {
      failures.push("post-logout withdraw wrote a row");
    }
    if (wallMs > ROUND_BUDGET_MS) {
      failures.push(`round took ${wallMs}ms (deadlock budget)`);
    }

    rows.push({
      scenario: "S5",
      seed,
      round,
      lanes: LANES,
      statuses,
      ledger: ledgerCounts(ledger),
      finalActive: {
        model_training:
          h.store.latestForScope(actor.sub, scope)?.action === "grant",
      },
      wallMs: Math.round(wallMs * 100) / 100,
      failures,
      notes: { kinds, accepted, postLogoutStatus: after.status },
    });
  }
  await finishScenario(
    "s5_rotation_logout",
    "refresh + logout racing withdraws on the same session",
    h,
    rows,
    { lanesPerRound: LANES },
    [
      {
        name: "no 5xx when the session dies mid-request",
        holds: rows.every((r) =>
          Object.keys(r.statuses).every((s) => Number(s) < 500)
        ),
        detail: "logout/refresh racing a write never becomes a server error",
      },
      {
        name: "a refused withdraw never writes",
        holds: rows.every((r) =>
          !r.failures.some((f) => f.includes("withdraw rows for"))
        ),
        detail: "row count matches the number of 200s exactly",
      },
      {
        name: "post-logout bearer refused (401) and inert",
        holds: rows.every((r) => r.notes.postLogoutStatus === 401),
        detail: "the auth cache is fenced by the revoked session",
      },
    ],
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// S6 — cancel during the call (client aborts, body never completes).
// ─────────────────────────────────────────────────────────────────────────────
Deno.test("stress-consent-withdraw S6: cancel during withdraw — an aborted request is a clean 4xx, writes nothing extra, and leaves the ledger consistent", async () => {
  const h = await loadConsentStress();
  const rows: RoundRow[] = [];
  const total = rounds(0.08);
  for (let round = 0; round < total; round++) {
    const seed = SEED + 500_000 + round * 2803;
    const prng = new Prng(seed);
    h.store.reset(seed, { latencyMaxMs: LATENCY_MS });
    const actor = await freshActor(h, prng);
    const scope: ConsentScope = "video_analysis";
    const failures: string[] = [];
    const granted = await call(
      h,
      grantRequest(actor, scope, "video-analysis-v1"),
    );
    if (granted.status !== 200) {
      failures.push(`setup grant → ${granted.status}`);
    }
    await readJson(granted);

    const kinds: string[] = [];
    const lanes: Array<Promise<Response>> = [];
    for (let i = 0; i < LANES; i++) {
      if (i % 2 === 0) {
        kinds.push("withdraw");
        lanes.push(call(h, withdrawRequest(actor, scope)));
        continue;
      }
      // A cancelled client: the body stream is aborted before the handler
      // finishes reading it (readBoundedText → readBody sees a broken stream).
      kinds.push("cancelled");
      const controller = new AbortController();
      const body = new ReadableStream<Uint8Array>({
        start(streamController) {
          streamController.enqueue(
            new TextEncoder().encode(
              `{"scope":"${scope}","source":"mobile_settings"`,
            ),
          );
          setTimeout(
            () => streamController.error(new Error("client cancelled")),
            prng.int(0, 3),
          );
        },
      });
      const request = new Request(
        `http://edge.xc.test/functions/v1/api/v1/me/consent/withdraw`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${actor.token}`,
            "Content-Type": "application/json",
            "x-forwarded-for": actor.ip,
          },
          body,
          signal: controller.signal,
        },
      );
      lanes.push(
        call(h, request).catch((error) =>
          new Response(JSON.stringify({ error: String(error) }), {
            status: 599,
          })
        ),
      );
    }
    const started = performance.now();
    const responses = await Promise.all(lanes);
    const wallMs = performance.now() - started;
    const bodies = await Promise.all(responses.map((r) => readJson(r)));
    const statuses = histogram(responses.map((r) => r.status));

    let accepted = 0;
    for (const [lane, response] of responses.entries()) {
      if (kinds[lane] === "withdraw") {
        if (response.status !== 200) {
          failures.push(`withdraw lane ${lane} → ${response.status}`);
        } else accepted += 1;
        continue;
      }
      if (response.status === 599) {
        failures.push(
          `cancelled lane ${lane}: handler threw ${
            JSON.stringify(bodies[lane])
          }`,
        );
      } else if (response.status === 200) {
        accepted += 1; // a fully-read body before the abort is a legitimate write
      } else if (response.status !== 400) {
        failures.push(
          `cancelled lane ${lane} → ${response.status} (expected 200 or 400)`,
        );
      }
    }
    const ledger = h.store.ofUser(actor.sub);
    const withdrawRows = ledger.filter((r) => r.action === "withdraw").length;
    if (withdrawRows !== accepted) {
      failures.push(
        `${withdrawRows} withdraw rows for ${accepted} accepted lanes`,
      );
    }
    if (ledger.some((r) => r.action !== "grant" && r.action !== "withdraw")) {
      failures.push("ledger holds a row with an invalid action");
    }
    checkVersionCarryForward(ledger, failures, "S6");
    const status = await statusOf(h, actor);
    checkServerAgreesWithLedger(
      status.body,
      ledger,
      failures,
      "S6 final status",
    );
    if (wallMs > ROUND_BUDGET_MS) {
      failures.push(`round took ${wallMs}ms (deadlock budget)`);
    }
    rows.push({
      scenario: "S6",
      seed,
      round,
      lanes: LANES,
      statuses,
      ledger: ledgerCounts(ledger),
      finalActive: Object.fromEntries(
        CONSENT_SCOPES.map((
          s,
        ) => [s, scopeStatus(status.body, s)?.active === true]),
      ),
      wallMs: Math.round(wallMs * 100) / 100,
      failures,
      notes: { kinds, accepted },
    });
  }
  await finishScenario(
    "s6_cancel_during_call",
    "aborted request bodies interleaved with healthy withdraws",
    h,
    rows,
    { lanesPerRound: LANES },
    [
      {
        name: "no thrown handler / no 5xx on a cancelled client",
        holds: rows.every((r) =>
          !r.failures.some((f) => f.includes("handler threw"))
        ),
        detail: "readBody swallows the broken stream and the route answers 400",
      },
      {
        name: "cancelled calls write nothing extra",
        holds: rows.every((r) =>
          !r.failures.some((f) => f.includes("withdraw rows for"))
        ),
        detail: "row count still matches the accepted lanes exactly",
      },
    ],
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// S7 — clock skew: transactions that share now() (and a host clock that steps
// backwards) make the fold's `order by created_at, id` tie-break observable.
// ─────────────────────────────────────────────────────────────────────────────
Deno.test("stress-consent-withdraw S7: clock ties/skew — the fold stays self-consistent and the tie-break rate is measured", async () => {
  const h = await loadConsentStress();
  const rows: RoundRow[] = [];
  const total = rounds(0.1);
  let tieRounds = 0;
  let foldDisagreesWithCommitOrder = 0;
  for (let round = 0; round < total; round++) {
    const seed = SEED + 600_000 + round * 1889;
    const prng = new Prng(seed);
    const coarse = round % 2 === 0;
    h.store.reset(seed, {
      latencyMaxMs: LATENCY_MS,
      clockMode: coarse ? "coarse" : "skew",
      coarseMs: 50,
    });
    const actor = await freshActor(h, prng);
    const scope: ConsentScope = "evaluation_telemetry";
    const failures: string[] = [];

    const plan = prng.shuffle(
      Array.from(
        { length: LANES },
        (_, i) => (i % 2 === 0 ? "withdraw" : "grant"),
      ),
    );
    const started = performance.now();
    const responses = await Promise.all(
      plan.map((op) =>
        op === "grant"
          ? call(h, grantRequest(actor, scope, TELEMETRY_VERSION))
          : call(h, withdrawRequest(actor, scope))
      ),
    );
    const wallMs = performance.now() - started;
    const bodies = await Promise.all(responses.map((r) => readJson(r)));
    const statuses = histogram(responses.map((r) => r.status));
    for (const [lane, response] of responses.entries()) {
      if (response.status !== 200) {
        failures.push(`lane ${lane} (${plan[lane]}) → ${response.status}`);
      }
      checkStatusShape(bodies[lane], `lane ${lane}`, failures);
    }
    const ledger = h.store.ofUser(actor.sub);
    const stamps = new Set(ledger.map((r) => r.created_at));
    const tied = stamps.size < ledger.length;
    if (tied) tieRounds += 1;
    const foldLast = h.store.latestForScope(actor.sub, scope);
    const commitLast = h.store.lastCommittedForScope(actor.sub, scope);
    if (foldLast && commitLast && foldLast.id !== commitLast.id) {
      foldDisagreesWithCommitOrder += 1;
    }
    // Whatever the tie-break picks, the route must report exactly that row —
    // a status read must never invent a state no row supports.
    const status = await statusOf(h, actor);
    checkServerAgreesWithLedger(
      status.body,
      ledger,
      failures,
      "S7 final status",
    );
    const again = await statusOf(h, actor);
    checkServerAgreesWithLedger(
      again.body,
      ledger,
      failures,
      "S7 repeated status",
    );
    if (JSON.stringify(status.body) !== JSON.stringify(again.body)) {
      failures.push(
        "two consecutive status reads of a settled ledger disagree",
      );
    }
    if (wallMs > ROUND_BUDGET_MS) {
      failures.push(`round took ${wallMs}ms (deadlock budget)`);
    }
    rows.push({
      scenario: "S7",
      seed,
      round,
      lanes: LANES,
      statuses,
      ledger: ledgerCounts(ledger),
      finalActive: Object.fromEntries(
        CONSENT_SCOPES.map((
          s,
        ) => [s, scopeStatus(status.body, s)?.active === true]),
      ),
      wallMs: Math.round(wallMs * 100) / 100,
      failures,
      notes: {
        clockMode: coarse ? "coarse" : "skew",
        createdAtTies: tied,
        foldLastAction: foldLast?.action ?? null,
        commitLastAction: commitLast?.action ?? null,
        foldDisagreesWithCommitOrder: Boolean(
          foldLast && commitLast && foldLast.id !== commitLast.id,
        ),
      },
    });
  }
  await finishScenario(
    "s7_clock_ties",
    "coarse/skewed host clock — created_at ties and backwards steps",
    h,
    rows,
    {
      tieRounds,
      foldDisagreesWithCommitOrder,
      note:
        "with equal created_at the fold tie-breaks on a random gen_random_uuid id, " +
        "so the last-committed action is not necessarily the one the fold reports",
    },
    [
      {
        name: "status reads are stable and row-backed under clock ties",
        holds: rows.every((r) => r.failures.length === 0),
        detail:
          "the response always equals an independent fold of the persisted rows",
      },
    ],
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// S8 — database refusing the insert mid-burst.
// ─────────────────────────────────────────────────────────────────────────────
Deno.test("stress-consent-withdraw S8: insert failures mid-burst — 503 with a coded body, no row, no leaked detail, survivors unaffected", async () => {
  const h = await loadConsentStress();
  const rows: RoundRow[] = [];
  const total = rounds(0.08);
  for (let round = 0; round < total; round++) {
    const seed = SEED + 700_000 + round * 1409;
    const prng = new Prng(seed);
    const failEvery = prng.int(2, 3);
    h.store.reset(seed, {
      latencyMaxMs: LATENCY_MS,
      // attempt 1 is the setup grant; fail a seeded subset of the burst.
      failInsert: (attempt) => attempt > 1 && attempt % failEvery === 0,
    });
    const actor = await freshActor(h, prng);
    const scope: ConsentScope = "model_training";
    const failures: string[] = [];
    const granted = await call(
      h,
      grantRequest(actor, scope, MODEL_TRAINING_VERSION),
    );
    if (granted.status !== 200) {
      failures.push(`setup grant → ${granted.status}`);
    }
    await readJson(granted);

    const started = performance.now();
    const responses = await Promise.all(
      Array.from(
        { length: LANES },
        () => call(h, withdrawRequest(actor, scope)),
      ),
    );
    const wallMs = performance.now() - started;
    const bodies = await Promise.all(responses.map((r) => readJson(r)));
    const statuses = histogram(responses.map((r) => r.status));

    let accepted = 0;
    for (const [lane, response] of responses.entries()) {
      if (response.status === 200) {
        accepted += 1;
        checkStatusShape(bodies[lane], `lane ${lane}`, failures);
        continue;
      }
      if (response.status !== 503) {
        failures.push(
          `lane ${lane} → ${response.status} (expected 200 or 503)`,
        );
        continue;
      }
      // 5xx bodies are deliberately generic (AGENTS.md: detail only in logs).
      const error = bodies[lane].error as Record<string, unknown> | undefined;
      const message = String(error?.message ?? "");
      if (!error || message.length === 0) {
        failures.push(
          `lane ${lane}: 503 body has no error message (${
            JSON.stringify(bodies[lane])
          })`,
        );
      }
      if (
        /terminating connection|administrator command|57P01|consent_records/i
          .test(message)
      ) {
        failures.push(
          `lane ${lane}: 503 body leaks upstream detail (${message})`,
        );
      }
      if (!response.headers.get("cache-control")?.includes("no-store")) {
        failures.push(`lane ${lane}: 503 lacks no-store`);
      }
    }
    const ledger = h.store.ofUser(actor.sub);
    const withdrawRows = ledger.filter((r) => r.action === "withdraw").length;
    if (withdrawRows !== accepted) {
      failures.push(
        `${withdrawRows} withdraw rows for ${accepted} accepted withdraws`,
      );
    }
    checkVersionCarryForward(ledger, failures, "S8");
    const status = await statusOf(h, actor);
    checkServerAgreesWithLedger(
      status.body,
      ledger,
      failures,
      "S8 final status",
    );
    if (accepted > 0 && scopeStatus(status.body, scope)?.active !== false) {
      failures.push("an accepted withdrawal did not stick");
    }
    if (wallMs > ROUND_BUDGET_MS) {
      failures.push(`round took ${wallMs}ms (deadlock budget)`);
    }
    rows.push({
      scenario: "S8",
      seed,
      round,
      lanes: LANES,
      statuses,
      ledger: ledgerCounts(ledger),
      finalActive: Object.fromEntries(
        CONSENT_SCOPES.map((
          s,
        ) => [s, scopeStatus(status.body, s)?.active === true]),
      ),
      wallMs: Math.round(wallMs * 100) / 100,
      failures,
      notes: {
        failEvery,
        accepted,
        injected: h.store.counters["rest.post.injected_failure"] ?? 0,
      },
    });
  }
  await finishScenario(
    "s8_insert_failure",
    "seeded PostgREST insert failures inside the burst",
    h,
    rows,
    { lanesPerRound: LANES },
    [
      {
        name: "failed insert ⇒ 503 coded error, no row, no upstream detail",
        holds: rows.every((r) => r.failures.length === 0),
        detail:
          "partial failure never corrupts the ledger nor leaks the PG message",
      },
    ],
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// S9 — MINIMIZED repro of the version carry-forward race observed in S2/S4:
// ONE grant and ONE withdraw for the same scope, released together. The route
// reads the ledger, then inserts `consent_version: latest?.consent_version ??
// null` (index.ts:1874-1882) — a read-modify-append with no re-read and no
// uniqueness/serialization, so a withdrawal that is ordered AFTER the grant in
// the ledger can still record the version it read BEFORE the grant committed.
// ─────────────────────────────────────────────────────────────────────────────
Deno.test("stress-consent-withdraw S9: minimized grant||withdraw — the persisted withdrawal must carry the version it supersedes", async () => {
  const h = await loadConsentStress();
  const rows: RoundRow[] = [];
  const repeats = envInt("STRESS_S9_REPEATS", Math.max(10, rounds(0.04)));
  let violating = 0;
  for (let round = 0; round < repeats; round++) {
    const seed = SEED + 800_000 + round * 977;
    const prng = new Prng(seed);
    h.store.reset(seed, { latencyMaxMs: LATENCY_MS });
    const actor = await freshActor(h, prng);
    const scope: ConsentScope = "model_training";
    const failures: string[] = [];
    const started = performance.now();
    const [withdrawResponse, grantResponse] = await Promise.all([
      call(h, withdrawRequest(actor, scope)),
      call(h, grantRequest(actor, scope, MODEL_TRAINING_VERSION)),
    ]);
    const wallMs = performance.now() - started;
    await Promise.all([readJson(withdrawResponse), readJson(grantResponse)]);
    const statuses = histogram([withdrawResponse.status, grantResponse.status]);
    if (withdrawResponse.status !== 200) {
      failures.push(`withdraw → ${withdrawResponse.status}`);
    }
    if (grantResponse.status !== 200) {
      failures.push(`grant → ${grantResponse.status}`);
    }
    const ledger = h.store.ofUser(actor.sub);
    const stale = versionCarryForwardViolations(ledger, "S9");
    if (stale.length > 0) violating += 1;
    failures.push(...stale);
    const status = await statusOf(h, actor);
    checkServerAgreesWithLedger(
      status.body,
      ledger,
      failures,
      "S9 final status",
    );
    rows.push({
      scenario: "S9",
      seed,
      round,
      lanes: 2,
      statuses,
      ledger: ledgerCounts(ledger),
      finalActive: {
        model_training: scopeStatus(status.body, scope)?.active === true,
      },
      wallMs: Math.round(wallMs * 100) / 100,
      failures,
      notes: {
        ledgerOrder: ledger.map((r) => ({
          action: r.action,
          consent_version: r.consent_version,
          created_at: r.created_at,
        })),
        stale,
      },
    });
  }
  await finishScenario(
    "s9_version_carry_forward_min",
    "minimized concurrent grant + withdraw on one scope",
    h,
    rows,
    {
      repeats,
      violatingRounds: violating,
      violationRate: `${violating}/${repeats}`,
    },
    [
      {
        name: "withdrawal row records the version it withdraws from",
        holds: violating === 0,
        detail:
          `${violating}/${repeats} minimized interleavings persisted a withdrawal with ` +
          "consent_version=null although a grant of a real version precedes it in the ledger",
      },
    ],
  );
});

// ─────────────────────────────────────────────────────────────────────────────
Deno.test("stress-consent-withdraw: campaign table (seed → outcome)", async () => {
  const path = await writeReport({
    scenario: "stress_consent_withdraw_rounds",
    label: "seed → outcome for every executed interleaving",
    seed: SEED,
    scale: {
      interleavings: ROUNDS.length,
      lanes: LANES,
      requestsExecuted: REQUESTS_EXECUTED,
      latencyMaxMs: LATENCY_MS,
    },
    inputs: {
      route: "POST /v1/me/consent/withdraw",
      iterEnv: STRESS_ITER,
      scopes: [...CONSENT_SCOPES],
    },
    statusHistogram: histogram(
      ROUNDS.flatMap((r) =>
        Object.entries(r.statuses).flatMap(([s, n]) => Array(n).fill(s))
      ),
    ),
    counters: {
      interleavings: ROUNDS.length,
      requestsExecuted: REQUESTS_EXECUTED,
      roundsWithFailures: ROUNDS.filter((r) => r.failures.length > 0).length,
    },
    invariants: [
      {
        name: "every round settled inside the deadlock budget",
        holds: ROUNDS.every((r) => r.wallMs <= ROUND_BUDGET_MS),
        detail: `max round ${
          Math.max(0, ...ROUNDS.map((r) => r.wallMs))
        }ms of ${ROUND_BUDGET_MS}ms`,
      },
    ],
    observations: {
      scenarios: histogram(ROUNDS.map((r) => r.scenario)),
      maxRoundMs: Math.max(0, ...ROUNDS.map((r) => r.wallMs)),
    },
    timeline: [],
    requests: ROUNDS as unknown as Array<Record<string, unknown>>,
    durationMs: ROUNDS.reduce((sum, r) => sum + r.wallMs, 0),
    heap: { before: Deno.memoryUsage(), after: Deno.memoryUsage() },
    replay: replay("stress-consent-withdraw", SEED),
  });
  console.log(
    `stress-consent-withdraw: ${ROUNDS.length} interleavings, ` +
      `${REQUESTS_EXECUTED} executed edge requests → ${path}`,
  );
  assert(
    ROUNDS.length > 0,
    "the campaign must execute at least one interleaving",
  );
});
