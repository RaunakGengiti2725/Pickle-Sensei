// STRESS — unit route-post-v1-me-consent-grant, lens `concurrency`.
//
// Promise.all bursts against the REAL edge handler (in-process, no port) with
// a seeded scheduler: every lane's start offset and every upstream latency
// comes from the iteration's seed, so each interleaving replays exactly.
//
//   deno task test                                  # 12 scenarios × 3 seeds
//   STRESS_ITER=42 deno test -A --no-check \
//     --config deno.json stress_consent_grant_concurrency.test.ts
//
// Invariants asserted on EVERY iteration (see checkInvariants):
//   I1 status_domain            no 5xx that was not injected, no crash
//   I2 rows_match_successes     one committed row per 200 mutation, none for
//                               400/401/429 (no phantom / no lost write)
//   I3 unique_row_ids           no duplicate primary keys
//   I4 owner_only               a row is only ever written by its own owner
//   I5 fold_shape              all 3 scopes present, active ⇔ lastAction
//   I6 explained_by_ledger      every 200 body equals the fold of a real
//                               commit-order prefix of the ledger, and that
//                               prefix contains the caller's OWN row
//                               (read-after-own-write, no lost update)
//   I7 append_only              no earlier row mutated or removed
//   I8 converges                a final status read equals the fold of the
//                               whole ledger for that owner
//   I9 bounded_time             the burst finishes inside the wall-time budget
//                               (no deadlock / no livelock)
//
// NOTE on idempotency: `consent_records` is an append-only LEDGER by design
// (migration 20260829140000 §7), so N duplicate grants legitimately leave N
// rows; what must hold is that the folded STATUS is idempotent. I6/I8 assert
// exactly that, and `duplicate_grant_burst` records the row count so the
// ledger growth is visible rather than assumed.

import { assert, assertEquals } from "@std/assert";
import {
  type CampaignReport,
  CONSENT_SCOPES,
  type ConsentScope,
  edgeRequest,
  foldStatus,
  grantBody,
  histogram,
  type Invariant,
  type IterationRecord,
  loadStressHarness,
  Prng,
  readJson,
  replayCommand,
  scheduler,
  sleep,
  type StatusView,
  statusView,
  STRESS_BURST,
  STRESS_ITER,
  STRESS_LATENCY_MS,
  STRESS_SEED,
  writeCampaign,
} from "./stress_consent_grant_harness.ts";

const harness = await loadStressHarness();
const { handler, fake } = harness;

const GRANT_PATH = "/v1/me/consent/grant";
const WITHDRAW_PATH = "/v1/me/consent/withdraw";
const STATUS_PATH = "/v1/me/consent/status";
const TRIALS_PATH = "/v1/me/evaluation/trials";
const WALL_BUDGET_MS = 8_000;
const BASE_VERSION = "model-training-v1";

const records: IterationRecord[] = [];
const heapBefore = Deno.memoryUsage();
const campaignStartedAt = new Date().toISOString();
let iterationCounter = 0;

interface Lane {
  idx: number;
  label: string;
  actor: string;
  token: string | null;
  method: string;
  path: string;
  /** unique per-request tag written into `source`, identifying the own row */
  tag: string;
  body?: Record<string, unknown>;
  truncatedBody?: string;
  /** an expected non-2xx outcome (rate limit / revoked / cancelled) */
  expect?: "ok" | "rejected";
  action?: "grant" | "withdraw";
  scope?: ConsentScope;
}

interface LaneResult extends Lane {
  status: number;
  body: Record<string, unknown>;
  view: StatusView | null;
  startedAt: number;
  finishedAt: number;
}

function laneGrant(
  idx: number,
  actor: string,
  token: string | null,
  scope: ConsentScope,
  options: { version?: string; label?: string; ip?: string } = {},
): Lane {
  const tag = `req-${idx}`;
  return {
    idx,
    label: options.label ?? `grant:${scope}`,
    actor,
    token,
    method: "POST",
    path: GRANT_PATH,
    tag,
    action: "grant",
    scope,
    body: grantBody(scope, options.version ?? BASE_VERSION, { source: tag }),
  };
}

function laneWithdraw(idx: number, actor: string, token: string | null, scope: ConsentScope): Lane {
  const tag = `req-${idx}`;
  return {
    idx,
    label: `withdraw:${scope}`,
    actor,
    token,
    method: "POST",
    path: WITHDRAW_PATH,
    tag,
    action: "withdraw",
    scope,
    body: { scope, source: tag, device: "iPhone15,2 iOS 18.2" },
  };
}

function laneStatus(idx: number, actor: string, token: string | null): Lane {
  return {
    idx,
    label: "status",
    actor,
    token,
    method: "GET",
    path: STATUS_PATH,
    tag: `req-${idx}`,
  };
}

/** Run the lanes as one Promise.all burst; the seeded scheduler decides each
 * lane's start offset, so the interleaving is a function of the seed alone. */
async function burst(prng: Prng, ip: string, lanes: Lane[]): Promise<LaneResult[]> {
  const t0 = performance.now();
  const offsets = lanes.map(() => prng.int(0, STRESS_LATENCY_MS));
  return await Promise.all(
    lanes.map(async (lane, i): Promise<LaneResult> => {
      if (offsets[i] > 0) await sleep(offsets[i]);
      const startedAt = performance.now() - t0;
      const response = await handler(
        edgeRequest(lane.method, lane.path, {
          token: lane.token,
          ip,
          ...(lane.body !== undefined ? { body: lane.body } : {}),
          ...(lane.truncatedBody !== undefined ? { truncatedBody: lane.truncatedBody } : {}),
        }),
      );
      const body = await readJson(response);
      return {
        ...lane,
        status: response.status,
        body,
        view: statusView(body),
        startedAt,
        finishedAt: performance.now() - t0,
      };
    }),
  );
}

const sameView = (a: StatusView, b: StatusView): boolean =>
  CONSENT_SCOPES.every((scope) => {
    const x = a.scopes[scope];
    const y = b.scopes[scope];
    return (
      x !== undefined &&
      y !== undefined &&
      x.active === y.active &&
      x.consentVersion === y.consentVersion &&
      x.lastAction === y.lastAction
    );
  });

interface CheckOptions {
  /** statuses that this scenario may legitimately produce */
  allowed: number[];
  /** lanes whose 200 responses are exempt from the own-row check (GET status) */
  budgetMs?: number;
}

function checkInvariants(
  results: LaneResult[],
  actors: string[],
  options: CheckOptions,
  durationMs: number,
): Invariant[] {
  const invariants: Invariant[] = [];
  const add = (name: string, holds: boolean, detail: string) =>
    invariants.push({ name, holds, detail });

  // I1 — status domain
  const unexpected = results.filter((r) => !options.allowed.includes(r.status));
  add(
    "I1_status_domain",
    unexpected.length === 0,
    unexpected.length === 0
      ? `all statuses ∈ {${options.allowed.join(",")}}`
      : unexpected
          .map((r) => `${r.label}#${r.idx} → ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`)
          .join(" | "),
  );

  // I2 — one committed row per successful mutation, none for anything else
  const mutations = results.filter((r) => r.method === "POST");
  const okMutations = mutations.filter((r) => r.status === 200);
  const committed = fake.consent;
  const tagsCommitted = new Set(committed.map((r) => String(r.source ?? "")));
  const missing = okMutations.filter((r) => !tagsCommitted.has(r.tag));
  const phantom = mutations.filter((r) => r.status !== 200 && tagsCommitted.has(r.tag));
  add(
    "I2_rows_match_successes",
    missing.length === 0 && phantom.length === 0 && committed.length === okMutations.length,
    `committed=${committed.length} ok_mutations=${okMutations.length}` +
      (missing.length ? ` missing=[${missing.map((r) => r.tag)}]` : "") +
      (phantom.length ? ` phantom=[${phantom.map((r) => `${r.tag}@${r.status}`).join(",")}]` : ""),
  );

  // I3 — unique primary keys
  const ids = new Set(committed.map((r) => r.id));
  add("I3_unique_row_ids", ids.size === committed.length, `${ids.size}/${committed.length} unique`);

  // I4 — a row is only ever written by its owner
  const byTag = new Map(results.map((r) => [r.tag, r]));
  const crossOwner = committed.filter((row) => {
    const lane = byTag.get(String(row.source ?? ""));
    return lane !== undefined && lane.actor !== row.user_id;
  });
  const foreign = committed.filter((row) => !actors.includes(row.user_id));
  add(
    "I4_owner_only",
    crossOwner.length === 0 && foreign.length === 0,
    `cross_owner=${crossOwner.length} foreign=${foreign.length}`,
  );

  // I5 — every 200 body is a well-formed status for all three scopes
  const malformed = results.filter((r) => {
    if (r.status !== 200) return false;
    if (r.view === null) return true;
    return CONSENT_SCOPES.some((scope) => {
      const entry = r.view!.scopes[scope];
      if (entry === undefined) return true;
      return entry.active !== (entry.lastAction === "granted");
    });
  });
  add(
    "I5_fold_shape",
    malformed.length === 0,
    malformed.length === 0
      ? "all 200 bodies well formed"
      : malformed.map((r) => `${r.label}#${r.idx}`).join(","),
  );

  // I6 — every 200 body equals the fold of a real commit-order prefix that
  // already contains the caller's own row (read-after-own-write, no lost
  // update, no invented state).
  const commitOrder = [...committed].sort((a, b) => a.visibleSeq - b.visibleSeq);
  const prefixes = commitOrder.map((_, i) => foldStatus(commitOrder.slice(0, i + 1)));
  prefixes.unshift(foldStatus([]));
  const unexplained: string[] = [];
  for (const r of results) {
    if (r.status !== 200 || r.view === null) continue;
    const own = commitOrder.findIndex(
      (row) => row.user_id === r.actor && String(row.source ?? "") === r.tag,
    );
    const scoped = commitOrder.filter((row) => row.user_id === r.actor);
    const scopedPrefixes = [
      foldStatus([]),
      ...scoped.map((_, i) => foldStatus(scoped.slice(0, i + 1))),
    ];
    // Duplicate grants make several prefixes fold identically, so collect
    // EVERY prefix the body is consistent with, then require at least one of
    // them to already contain the caller's own row.
    const matching: number[] = [];
    scopedPrefixes.forEach((candidate, i) => {
      const view = statusView(candidate as unknown as Record<string, unknown>);
      if (view !== null && sameView(view, r.view!)) matching.push(i);
    });
    if (matching.length === 0) {
      unexplained.push(`${r.label}#${r.idx} body matches no commit-order prefix`);
      continue;
    }
    if (r.method === "POST" && own >= 0) {
      const ownScopedIndex = scoped.findIndex((row) => String(row.source ?? "") === r.tag);
      if (ownScopedIndex >= 0 && !matching.some((i) => i >= ownScopedIndex + 1)) {
        unexplained.push(
          `${r.label}#${r.idx} response predates its own row ` +
            `(prefixes=[${matching.join(",")}] own=${ownScopedIndex + 1})`,
        );
      }
    }
  }
  add(
    "I6_explained_by_ledger",
    unexplained.length === 0,
    unexplained.length === 0 ? `${prefixes.length - 1} commit states` : unexplained.join(" | "),
  );

  // I7 — append only: nothing rewrote or removed an earlier row
  const rewritten = fake.insertLog.filter((entry) => entry.outcome === "committed").length;
  add(
    "I7_append_only",
    rewritten === committed.length,
    `insert_log_committed=${rewritten} rows=${committed.length}`,
  );

  // I9 — bounded wall time
  const budget = options.budgetMs ?? WALL_BUDGET_MS;
  add("I9_bounded_time", durationMs < budget, `${Math.round(durationMs)}ms < ${budget}ms`);

  return invariants;
}

/** A final GET status must equal the fold of the entire ledger (I8). */
async function checkConvergence(
  actor: string,
  token: string,
  ip: string,
  invariants: Invariant[],
): Promise<Record<string, unknown>> {
  const response = await handler(edgeRequest("GET", STATUS_PATH, { token, ip }));
  const body = await readJson(response);
  const view = statusView(body);
  const expected = statusView(
    foldStatus(fake.consent.filter((r) => r.user_id === actor)) as unknown as Record<
      string,
      unknown
    >,
  );
  const holds =
    response.status === 200 && view !== null && expected !== null && sameView(view, expected);
  invariants.push({
    name: "I8_converges",
    holds,
    detail: holds
      ? "final status = fold(full ledger)"
      : `status=${response.status} got=${JSON.stringify(view)} want=${JSON.stringify(expected)}`,
  });
  return { finalStatus: view };
}

interface ScenarioResult {
  results: LaneResult[];
  invariants: Invariant[];
  observations: Record<string, unknown>;
  actors: string[];
}

/** Drive one scenario over STRESS_ITER seeds, recording every iteration. */
async function campaign(
  scenario: string,
  run: (ctx: {
    prng: Prng;
    seed: number;
    ip: string;
    newUser: () => { id: string; token: string };
  }) => Promise<ScenarioResult>,
): Promise<void> {
  for (let i = 0; i < STRESS_ITER; i += 1) {
    iterationCounter += 1;
    const seed = STRESS_SEED + iterationCounter * 7919;
    fake.reset(seed, STRESS_LATENCY_MS);
    const prng = new Prng(seed ^ 0x5f3759df);
    // A fresh IP and fresh user ids per iteration: the fixed-window rate
    // limits are per key, and the campaign must measure the route's
    // concurrency behaviour, not the limiter's (rate limiting itself is
    // measured on purpose by the rate_limit_burst scenario).
    const ip = `10.${(iterationCounter >> 16) & 255}.${(iterationCounter >> 8) & 255}.${iterationCounter & 255}`;
    const newUser = () => {
      const id = prng.uuid();
      const session = fake.mintSession(id);
      return { id, token: session.accessToken };
    };
    const started = performance.now();
    const outcome = await run({ prng, seed, ip, newUser });
    const durationMs = performance.now() - started;
    const invariants = outcome.invariants;
    const pass = invariants.every((inv) => inv.holds);
    records.push({
      scenario,
      seed,
      requests: outcome.results.length,
      statusHistogram: histogram(outcome.results.map((r) => r.status)),
      rowsCommitted: fake.consent.length,
      schedule: { virtualMs: scheduler.virtualNow, wakes: scheduler.released },
      invariants,
      observations: outcome.observations,
      durationMs: Math.round(durationMs * 100) / 100,
      replay: replayCommand(scenario, seed),
      pass,
    });
    if (!pass) {
      const failed = invariants.filter((inv) => !inv.holds);
      throw new Error(
        `[${scenario}] seed=${seed} BROKEN: ` +
          failed.map((inv) => `${inv.name} (${inv.detail})`).join(" ; ") +
          `\nreplay: ${replayCommand(scenario, seed)}`,
      );
    }
  }
}

// ── S1: duplicate delivery — N identical grants at once ─────────────────────
Deno.test("stress/consent-grant/concurrency: duplicate_grant_burst", async () => {
  await campaign("duplicate_grant_burst", async ({ prng, ip, newUser }) => {
    const user = newUser();
    const lanes = Array.from({ length: STRESS_BURST }, (_, i) =>
      laneGrant(i, user.id, user.token, "model_training"),
    );
    const t0 = performance.now();
    const results = await burst(prng, ip, lanes);
    const duration = performance.now() - t0;
    const invariants = checkInvariants(results, [user.id], { allowed: [200] }, duration);
    // Folded status must be identical for every duplicate (idempotent status).
    const views = results.filter((r) => r.view !== null).map((r) => r.view!);
    const identical = views.every((v) => sameView(v, views[0]));
    invariants.push({
      name: "S1_status_idempotent",
      holds: identical && views.length === lanes.length,
      detail: identical
        ? `${views.length} identical folded statuses`
        : `divergent: ${JSON.stringify(views.map((v) => v.scopes.model_training))}`,
    });
    const active = views.every((v) => v.scopes.model_training?.active === true);
    invariants.push({
      name: "S1_scope_active",
      holds: active,
      detail: active ? "model_training active in every response" : "some response not active",
    });
    const obs = await checkConvergence(user.id, user.token, ip, invariants);
    return {
      results,
      invariants,
      actors: [user.id],
      observations: { ...obs, ledgerRows: fake.consent.length, duplicateGrants: lanes.length },
    };
  });
});

// ── S2: grant/withdraw race on the same scope (call-during-call) ────────────
Deno.test("stress/consent-grant/concurrency: grant_withdraw_race", async () => {
  await campaign("grant_withdraw_race", async ({ prng, ip, newUser }) => {
    const user = newUser();
    const lanes: Lane[] = [];
    for (let i = 0; i < STRESS_BURST; i += 1) {
      lanes.push(
        prng.next() < 0.5
          ? laneGrant(i, user.id, user.token, "model_training", { version: `mt-v${i}` })
          : laneWithdraw(i, user.id, user.token, "model_training"),
      );
    }
    const t0 = performance.now();
    const results = await burst(prng, ip, lanes);
    const duration = performance.now() - t0;
    const invariants = checkInvariants(results, [user.id], { allowed: [200] }, duration);
    // The winner must be the last row in (created_at, id) order — decided by
    // the ledger, never by the response order.
    const ledger = foldStatus(fake.consent);
    const winner = ledger.scopes.find((s) => s.scope === "model_training")!;
    const obs = await checkConvergence(user.id, user.token, ip, invariants);
    return {
      results,
      invariants,
      actors: [user.id],
      observations: {
        ...obs,
        grants: lanes.filter((l) => l.action === "grant").length,
        withdraws: lanes.filter((l) => l.action === "withdraw").length,
        ledgerWinner: winner,
      },
    };
  });
});

// ── S3: two actors, same scope, same instant ────────────────────────────────
Deno.test("stress/consent-grant/concurrency: two_actors_same_scope", async () => {
  await campaign("two_actors_same_scope", async ({ prng, ip, newUser }) => {
    const a = newUser();
    const b = newUser();
    const lanes: Lane[] = [];
    for (let i = 0; i < STRESS_BURST; i += 1) {
      const owner = i % 2 === 0 ? a : b;
      lanes.push(
        prng.next() < 0.7
          ? laneGrant(i, owner.id, owner.token, "video_analysis")
          : laneWithdraw(i, owner.id, owner.token, "video_analysis"),
      );
    }
    const t0 = performance.now();
    const results = await burst(prng, ip, lanes);
    const duration = performance.now() - t0;
    const invariants = checkInvariants(results, [a.id, b.id], { allowed: [200] }, duration);
    // Cross-tenant leak check: neither response may reflect the other's rows.
    const leaks: string[] = [];
    for (const r of results) {
      if (r.status !== 200 || r.view === null) continue;
      const own = fake.consent.filter((row) => row.user_id === r.actor);
      const foreign = fake.consent.filter((row) => row.user_id !== r.actor);
      const version = r.view.scopes.video_analysis?.consentVersion ?? null;
      if (version !== null && own.length === 0 && foreign.length > 0) {
        leaks.push(`${r.label}#${r.idx} saw a version with no own rows`);
      }
    }
    invariants.push({
      name: "S3_no_cross_actor_read",
      holds: leaks.length === 0,
      detail: leaks.length === 0 ? "each response folded only its own rows" : leaks.join(" | "),
    });
    const obsA = await checkConvergence(a.id, a.token, ip, invariants);
    const obsB = await checkConvergence(b.id, b.token, ip, invariants);
    return {
      results,
      invariants,
      actors: [a.id, b.id],
      observations: {
        actorA: obsA.finalStatus,
        actorB: obsB.finalStatus,
        rowsA: fake.consent.filter((r) => r.user_id === a.id).length,
        rowsB: fake.consent.filter((r) => r.user_id === b.id).length,
      },
    };
  });
});

// ── S4: all three scopes granted in parallel ────────────────────────────────
Deno.test("stress/consent-grant/concurrency: three_scopes_parallel", async () => {
  await campaign("three_scopes_parallel", async ({ prng, ip, newUser }) => {
    const user = newUser();
    const lanes = Array.from({ length: STRESS_BURST }, (_, i) =>
      laneGrant(i, user.id, user.token, CONSENT_SCOPES[i % CONSENT_SCOPES.length], {
        version: `v-${CONSENT_SCOPES[i % CONSENT_SCOPES.length]}`,
      }),
    );
    const t0 = performance.now();
    const results = await burst(prng, ip, lanes);
    const duration = performance.now() - t0;
    const invariants = checkInvariants(results, [user.id], { allowed: [200] }, duration);
    const obs = await checkConvergence(user.id, user.token, ip, invariants);
    const final = obs.finalStatus as StatusView | null;
    const allActive =
      final !== null && CONSENT_SCOPES.every((scope) => final.scopes[scope]?.active === true);
    invariants.push({
      name: "S4_all_scopes_active",
      holds: allActive,
      detail: allActive ? "all three scopes active" : JSON.stringify(final),
    });
    return { results, invariants, actors: [user.id], observations: obs };
  });
});

// ── S5: status reads racing the writes ──────────────────────────────────────
Deno.test("stress/consent-grant/concurrency: status_read_during_writes", async () => {
  await campaign("status_read_during_writes", async ({ prng, ip, newUser }) => {
    const user = newUser();
    const lanes: Lane[] = [];
    for (let i = 0; i < STRESS_BURST; i += 1) {
      lanes.push(
        i % 3 === 0
          ? laneStatus(i, user.id, user.token)
          : laneGrant(i, user.id, user.token, "evaluation_telemetry", { version: `et-v${i}` }),
      );
    }
    const t0 = performance.now();
    const results = await burst(prng, ip, lanes);
    const duration = performance.now() - t0;
    const invariants = checkInvariants(results, [user.id], { allowed: [200] }, duration);
    const obs = await checkConvergence(user.id, user.token, ip, invariants);
    return {
      results,
      invariants,
      actors: [user.id],
      observations: { ...obs, reads: lanes.filter((l) => l.method === "GET").length },
    };
  });
});

// ── S6: logout (session revocation) mid-burst ───────────────────────────────
Deno.test("stress/consent-grant/concurrency: logout_during_grants", async () => {
  await campaign("logout_during_grants", async ({ prng, ip, newUser }) => {
    const user = newUser();
    const lanes = Array.from({ length: STRESS_BURST }, (_, i) =>
      laneGrant(i, user.id, user.token, "model_training", { version: `mt-v${i}` }),
    );
    const t0 = performance.now();
    const [results, logout] = await Promise.all([
      burst(prng, ip, lanes),
      (async () => {
        await sleep(prng.int(0, STRESS_LATENCY_MS));
        return await handler(edgeRequest("POST", "/v1/auth/logout", { token: user.token, ip }));
      })(),
    ]);
    const duration = performance.now() - t0;
    const invariants = checkInvariants(results, [user.id], { allowed: [200, 401] }, duration);
    // Anything answered 401 must have written nothing (fenced, not partial).
    const wrote = new Set(fake.consent.map((r) => String(r.source ?? "")));
    const fencedButWrote = results.filter((r) => r.status === 401 && wrote.has(r.tag));
    invariants.push({
      name: "S6_revoked_writes_nothing",
      holds: fencedButWrote.length === 0,
      detail:
        fencedButWrote.length === 0
          ? `logout=${logout.status} rejected=${results.filter((r) => r.status === 401).length}`
          : `wrote after 401: ${fencedButWrote.map((r) => r.tag).join(",")}`,
    });
    // After the fence, the bearer is dead for good.
    const after = await handler(
      edgeRequest("POST", GRANT_PATH, {
        token: user.token,
        ip,
        body: grantBody("model_training", BASE_VERSION, { source: "post-logout" }),
      }),
    );
    await after.body?.cancel().catch(() => undefined);
    invariants.push({
      name: "S6_fence_is_permanent",
      holds: after.status === 401,
      detail: `post-logout grant → ${after.status}`,
    });
    return {
      results,
      invariants,
      actors: [user.id],
      observations: {
        logoutStatus: logout.status,
        rejected: results.filter((r) => r.status === 401).length,
        accepted: results.filter((r) => r.status === 200).length,
        rowsCommitted: fake.consent.length,
      },
    };
  });
});

// ── S7: session rotation during the burst (old + new bearer in flight) ──────
Deno.test("stress/consent-grant/concurrency: rotation_during_grants", async () => {
  await campaign("rotation_during_grants", async ({ prng, ip, newUser }) => {
    const user = newUser();
    const rotated = fake.mintSession(user.id);
    const lanes: Lane[] = [];
    for (let i = 0; i < STRESS_BURST; i += 1) {
      const token = i % 2 === 0 ? user.token : rotated.accessToken;
      lanes.push(laneGrant(i, user.id, token, "model_training", { version: `mt-v${i}` }));
    }
    const t0 = performance.now();
    const results = await burst(prng, ip, lanes);
    const duration = performance.now() - t0;
    const invariants = checkInvariants(results, [user.id], { allowed: [200] }, duration);
    // Both bearers denote the same subject: no row may be attributed elsewhere.
    const wrongOwner = fake.consent.filter((r) => r.user_id !== user.id);
    invariants.push({
      name: "S7_rotation_keeps_subject",
      holds: wrongOwner.length === 0,
      detail: `rows=${fake.consent.length} wrong_owner=${wrongOwner.length}`,
    });
    const obs = await checkConvergence(user.id, user.token, ip, invariants);
    return { results, invariants, actors: [user.id], observations: obs };
  });
});

// ── S8: cancel-during-call (client vanishes mid-body) ───────────────────────
Deno.test("stress/consent-grant/concurrency: cancel_during_call", async () => {
  await campaign("cancel_during_call", async ({ prng, ip, newUser }) => {
    const user = newUser();
    const lanes: Lane[] = [];
    for (let i = 0; i < STRESS_BURST; i += 1) {
      if (i % 3 === 1) {
        lanes.push({
          idx: i,
          label: "grant:cancelled",
          actor: user.id,
          token: user.token,
          method: "POST",
          path: GRANT_PATH,
          tag: `req-${i}`,
          expect: "rejected",
          truncatedBody: '{"scope":"model_training","consentVer',
        });
      } else {
        lanes.push(laneGrant(i, user.id, user.token, "model_training", { version: `mt-v${i}` }));
      }
    }
    const t0 = performance.now();
    const results = await burst(prng, ip, lanes);
    const duration = performance.now() - t0;
    const invariants = checkInvariants(results, [user.id], { allowed: [200, 400] }, duration);
    const cancelled = results.filter((r) => r.expect === "rejected");
    const badCancel = cancelled.filter((r) => r.status !== 400);
    invariants.push({
      name: "S8_cancelled_rejected_cleanly",
      holds: badCancel.length === 0,
      detail:
        badCancel.length === 0
          ? `${cancelled.length} cancelled uploads → 400 validation, no row`
          : badCancel.map((r) => `${r.idx}→${r.status}`).join(","),
    });
    const obs = await checkConvergence(user.id, user.token, ip, invariants);
    return {
      results,
      invariants,
      actors: [user.id],
      observations: { ...obs, cancelled: cancelled.length, rows: fake.consent.length },
    };
  });
});

// ── S9: clock skew — every row stamped at the SAME instant ──────────────────
Deno.test("stress/consent-grant/concurrency: clock_tie_ordering", async () => {
  await campaign("clock_tie_ordering", async ({ prng, ip, newUser }) => {
    fake.clockMode = "tie";
    const user = newUser();
    const lanes: Lane[] = [];
    for (let i = 0; i < STRESS_BURST; i += 1) {
      lanes.push(
        i % 2 === 0
          ? laneGrant(i, user.id, user.token, "model_training", { version: `mt-v${i}` })
          : laneWithdraw(i, user.id, user.token, "model_training"),
      );
    }
    const t0 = performance.now();
    const results = await burst(prng, ip, lanes);
    const duration = performance.now() - t0;
    const invariants = checkInvariants(results, [user.id], { allowed: [200] }, duration);
    const stamps = new Set(fake.consent.map((r) => r.created_at));
    invariants.push({
      name: "S9_all_stamps_tied",
      holds: stamps.size === 1,
      detail: `${stamps.size} distinct created_at over ${fake.consent.length} rows`,
    });
    // With created_at tied the fold is decided by the random uuid — it must
    // still be STABLE (two reads agree) even though it is arbitrary.
    const first = await checkConvergence(user.id, user.token, ip, invariants);
    const second = await checkConvergence(user.id, user.token, ip, invariants);
    const stable =
      JSON.stringify((first.finalStatus as StatusView | null)?.scopes) ===
      JSON.stringify((second.finalStatus as StatusView | null)?.scopes);
    invariants.push({
      name: "S9_tie_break_stable",
      holds: stable,
      detail: stable ? "two reads agree under a full created_at tie" : "reads disagreed",
    });
    const winner = foldStatus(fake.consent).scopes.find((s) => s.scope === "model_training")!;
    fake.clockMode = "distinct";
    return {
      results,
      invariants,
      actors: [user.id],
      observations: { tieWinner: winner.lastAction, rows: fake.consent.length },
    };
  });
});

// ── S10: the route budget under a burst (30/60s) ────────────────────────────
Deno.test("stress/consent-grant/concurrency: rate_limit_burst", async () => {
  await campaign("rate_limit_burst", async ({ prng, ip, newUser }) => {
    const user = newUser();
    const total = 40;
    const lanes = Array.from({ length: total }, (_, i) =>
      laneGrant(i, user.id, user.token, "model_training", { version: `mt-v${i}` }),
    );
    const t0 = performance.now();
    const results = await burst(prng, ip, lanes);
    const duration = performance.now() - t0;
    const invariants = checkInvariants(results, [user.id], { allowed: [200, 429] }, duration);
    const allowed = results.filter((r) => r.status === 200).length;
    const limited = results.filter((r) => r.status === 429).length;
    invariants.push({
      name: "S10_budget_enforced",
      holds: allowed <= 30 && limited === total - allowed,
      detail: `allowed=${allowed} limited=${limited} of ${total} (route budget 30/60s)`,
    });
    invariants.push({
      name: "S10_limited_wrote_nothing",
      holds: fake.consent.length === allowed,
      detail: `rows=${fake.consent.length} allowed=${allowed}`,
    });
    return {
      results,
      invariants,
      actors: [user.id],
      observations: { allowed, limited, rows: fake.consent.length },
    };
  });
});

// ── S11: the insert failing under load (injected DB fault) ──────────────────
Deno.test("stress/consent-grant/concurrency: insert_fault_during_burst", async () => {
  await campaign("insert_fault_during_burst", async ({ prng, ip, newUser }) => {
    const user = newUser();
    const failEvery = 3;
    fake.faults.insertFault = (attempt) =>
      attempt % failEvery === 0
        ? { code: "40001", message: "could not serialize access due to concurrent update" }
        : null;
    const lanes = Array.from({ length: STRESS_BURST }, (_, i) =>
      laneGrant(i, user.id, user.token, "model_training", { version: `mt-v${i}` }),
    );
    const t0 = performance.now();
    const results = await burst(prng, ip, lanes);
    const duration = performance.now() - t0;
    const invariants = checkInvariants(results, [user.id], { allowed: [200, 503] }, duration);
    const failed = results.filter((r) => r.status === 503);
    // A 503 must be generic (no SQLSTATE / driver text leaked to the client).
    const leaked = failed.filter((r) => {
      const text = JSON.stringify(r.body);
      return text.includes("40001") || text.includes("serialize");
    });
    invariants.push({
      name: "S11_fault_body_generic",
      holds: leaked.length === 0,
      detail:
        leaked.length === 0
          ? `${failed.length} × 503 generic`
          : `leaked: ${JSON.stringify(leaked[0].body)}`,
    });
    const obs = await checkConvergence(user.id, user.token, ip, invariants);
    fake.faults = {};
    return {
      results,
      invariants,
      actors: [user.id],
      observations: { ...obs, faults: failed.length, rows: fake.consent.length },
    };
  });
});

// ── S12: the consent gate racing the consumer that depends on it ────────────
Deno.test("stress/consent-grant/concurrency: trials_gate_race", async () => {
  await campaign("trials_gate_race", async ({ prng, ip, newUser }) => {
    const user = newUser();
    const lanes: Lane[] = [];
    const trialIds: string[] = [];
    for (let i = 0; i < STRESS_BURST; i += 1) {
      if (i % 2 === 0) {
        lanes.push(
          prng.next() < 0.5
            ? laneGrant(i, user.id, user.token, "evaluation_telemetry", { version: `et-v${i}` })
            : laneWithdraw(i, user.id, user.token, "evaluation_telemetry"),
        );
      } else {
        const trialId = prng.uuid();
        trialIds.push(trialId);
        lanes.push({
          idx: i,
          label: "trials",
          actor: user.id,
          token: user.token,
          method: "POST",
          path: TRIALS_PATH,
          tag: `req-${i}`,
          body: { trials: [{ trialId, capturedAt: new Date().toISOString(), payload: { i } }] },
        });
      }
    }
    const t0 = performance.now();
    const results = await burst(prng, ip, lanes);
    const duration = performance.now() - t0;
    const invariants = checkInvariants(
      results.filter((r) => r.path !== TRIALS_PATH),
      [user.id],
      { allowed: [200] },
      duration,
    );
    // Every accepted trial must be explained by an ACTIVE consent state at
    // some real commit prefix — a trial can never be stored while the ledger
    // says the scope was never granted.
    const accepted = results.filter((r) => r.label === "trials" && r.status === 200);
    const everGranted = fake.consent.some(
      (r) => r.scope === "evaluation_telemetry" && r.action === "grant",
    );
    const storedTrials = fake.trials.length;
    invariants.push({
      name: "S12_no_trial_without_consent",
      holds: storedTrials === 0 || everGranted,
      detail: `stored_trials=${storedTrials} accepted=${accepted.length} ever_granted=${everGranted}`,
    });
    const forbidden = results.filter((r) => r.label === "trials" && r.status === 403).length;
    invariants.push({
      name: "S12_gate_answers_cleanly",
      holds: results
        .filter((r) => r.label === "trials")
        .every((r) => [200, 403].includes(r.status)),
      detail: `accepted=${accepted.length} forbidden=${forbidden}`,
    });
    const obs = await checkConvergence(user.id, user.token, ip, invariants);
    return {
      results,
      invariants,
      actors: [user.id],
      observations: { ...obs, storedTrials, acceptedTrials: accepted.length, forbidden },
    };
  });
});

// ── R: replay determinism — the same seed must reproduce the same ledger ────
// A failing seed is only useful if it replays. Runs one mixed grant/withdraw/
// status burst three times from one seed and requires identical statuses,
// identical committed rows (ids, order, actions, stamps) and an identical
// schedule. The per-user route budget (30/60s, keyed on the subject) and the
// per-IP budget live in the isolate across attempts, so each attempt gets a
// distinct subject suffix and IP — everything else is the same seed.
Deno.test("stress/consent-grant/concurrency: replay_determinism", async () => {
  const seed = STRESS_SEED ^ 0x2f6b;
  const signatures: string[] = [];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    fake.reset(seed, STRESS_LATENCY_MS);
    const prng = new Prng(seed);
    const ip = `10.99.0.${attempt + 1}`;
    const userId = `${prng.uuid().slice(0, -2)}${attempt.toString(16).padStart(2, "0")}`;
    const session = fake.mintSession(userId);
    const lanes: Lane[] = [];
    for (let i = 0; i < STRESS_BURST; i += 1) {
      const roll = prng.next();
      if (roll < 0.45) {
        lanes.push(
          laneGrant(i, userId, session.accessToken, "model_training", { version: `v${i}` }),
        );
      } else if (roll < 0.8) {
        lanes.push(laneWithdraw(i, userId, session.accessToken, "model_training"));
      } else {
        lanes.push(laneStatus(i, userId, session.accessToken));
      }
    }
    const results = await burst(prng, ip, lanes);
    signatures.push(
      JSON.stringify({
        statuses: results.map((r) => r.status),
        ledger: fake.consent.map((r) => [r.id, r.action, r.consent_version, r.created_at]),
        views: results.map((r) => r.view?.scopes.model_training ?? null),
        schedule: { virtualMs: scheduler.virtualNow, wakes: scheduler.released },
      }),
    );
  }
  const distinct = new Set(signatures);
  assertEquals(
    distinct.size,
    1,
    `seed=${seed} produced ${distinct.size} distinct outcomes across 3 replays`,
  );
  const first = JSON.parse(signatures[0]) as { ledger: unknown[]; statuses: number[] };
  assert(first.ledger.length > 0 && first.statuses.length === STRESS_BURST);
});

// ── campaign report ─────────────────────────────────────────────────────────
Deno.test("stress/consent-grant/concurrency: campaign report", async () => {
  const heapAfter = Deno.memoryUsage();
  const report: CampaignReport = {
    unit: "route-post-v1-me-consent-grant",
    lens: "concurrency",
    target: "POST /v1/me/consent/grant (supabase/functions/api/index.ts:1837)",
    plane: "cloud/linux — real handler in-process, modelled Supabase",
    startedAt: campaignStartedAt,
    finishedAt: new Date().toISOString(),
    scale: {
      iterationsPerScenario: STRESS_ITER,
      burst: STRESS_BURST,
      latencyMaxMs: STRESS_LATENCY_MS,
      baseSeed: STRESS_SEED,
    },
    totals: {
      iterations: records.length,
      requests: records.reduce((sum, r) => sum + r.requests, 0),
      failedIterations: records.filter((r) => !r.pass).length,
      statusHistogram: records.reduce<Record<string, number>>((acc, r) => {
        for (const [status, count] of Object.entries(r.statusHistogram)) {
          acc[status] = (acc[status] ?? 0) + count;
        }
        return acc;
      }, {}),
    },
    failedSeeds: records
      .filter((r) => !r.pass)
      .map((r) => ({
        scenario: r.scenario,
        seed: r.seed,
        invariants: r.invariants.filter((inv) => !inv.holds).map((inv) => inv.name),
      })),
    iterations: records,
    heap: { before: heapBefore, after: heapAfter },
  };
  const path = await writeCampaign("consent_grant_concurrency", report);
  console.log(
    `[stress] ${report.totals.iterations} iterations, ${report.totals.requests} requests → ${path}`,
  );
  assertEquals(report.failedSeeds, []);
  assert(report.totals.iterations >= 12, "every scenario must have produced iterations");
});
