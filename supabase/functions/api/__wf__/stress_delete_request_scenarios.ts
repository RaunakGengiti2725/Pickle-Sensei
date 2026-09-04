/**
 * stress — POST /v1/me/delete-request, concurrency lens: the scenarios.
 *
 * Each scenario is one seeded iteration: fresh user(s) and IP, a Promise.all
 * burst against the REAL handler, then the invariants below are checked
 * against the modelled tables. Iteration i of a campaign uses seed
 * STRESS_SEED + i, so `STRESS_SEED=<seed> STRESS_ITER=1` replays exactly one.
 *
 * Invariants (the concurrency lens):
 *   no duplicate rows   — exactly one account_deletion_requests row per user
 *   no lost update      — the stored challenge is the LAST applied write and
 *                         was returned to some caller with the same expiresAt
 *                         (no torn row from interleaved DO UPDATEs)
 *   idempotency         — 429 / 503 / 401 lanes leave NO writes; a stored
 *                         challenge always belongs to a 200
 *   no double spend     — the exit survey is recorded once per accepted
 *                         request and never for a refused one
 *   no deadlock         — every lane settles inside STRESS_DEADLINE_MS
 *   session semantics   — logout/deletion during the burst never leaves a
 *                         bearer that still works, nor a row for a deleted
 *                         account (profiles FK)
 */
import {
  bootstrap,
  burst,
  CHALLENGE_TTL_MS,
  CONFIRM_MIN_AGE_MS,
  DELETE_REQUEST_LIMIT,
  deleteConfirm,
  deleteRequest,
  histogram,
  type Invariant,
  ipFor,
  isRecord,
  type IterationRow,
  type LaneResult,
  logoutRequest,
  Prng,
  randomSurvey,
  readJson,
  refreshRequest,
  replayCommand,
  salt,
  STRESS_DEADLINE_MS,
  STRESS_JITTER_MS,
  STRESS_LATENCY_MS,
  type StressHarness,
  withClockSkew,
} from "./stress_delete_request_harness.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface Ctx {
  h: StressHarness;
  prng: Prng;
  seed: number;
  iteration: number;
  ip: string;
  inv: Invariant[];
  obs: Record<string, unknown>;
  inputs: Record<string, unknown>;
}

function check(ctx: Ctx, name: string, holds: boolean, detail: string): void {
  ctx.inv.push({ name, holds, detail });
}

function hourBucket(ms: number): number {
  return Math.floor(ms / (DELETE_REQUEST_LIMIT.windowSeconds * 1_000));
}

function okLanes(lanes: LaneResult[], op = "delete-request"): LaneResult[] {
  return lanes.filter((l) => l.op === op && l.status === 200);
}

function challengeOf(lane: LaneResult): string {
  return typeof lane.body.challenge === "string" ? lane.body.challenge : "";
}

async function newUser(
  ctx: Ctx,
  devices = 1,
): Promise<{ userId: string; tokens: string[]; refresh: string[] }> {
  const userId = ctx.prng.uuid();
  const tokens: string[] = [];
  const refresh: string[] = [];
  for (let d = 0; d < devices; d++) {
    const boot = await bootstrap(ctx.h, userId, ctx.ip);
    if (boot.status !== 200 || !boot.accessToken) {
      throw new Error(`bootstrap failed: ${boot.status} ${JSON.stringify(boot.body)}`);
    }
    tokens.push(boot.accessToken);
    refresh.push(boot.refreshToken);
  }
  return { userId, tokens, refresh };
}

/** The write-side invariants shared by every scenario that leaves the user alive. */
function checkRowInvariants(
  ctx: Ctx,
  userId: string,
  lanes: LaneResult[],
  startMs: number,
  endMs: number,
  fromWrite = 0,
): void {
  const fake = ctx.h.fake;
  const rows = fake.deletionRows(userId);
  const ok = okLanes(lanes);
  const okChallenges = new Map(ok.map((l) => [challengeOf(l), l]));
  const writes = fake.applied
    .slice(fromWrite)
    .filter((w) => w.table === "account_deletion_requests" && w.userId === userId);

  check(
    ctx,
    "settled",
    lanes.every((l) => l.status !== "hung"),
    `hung=${lanes.filter((l) => l.status === "hung").length}`,
  );
  check(
    ctx,
    "no_duplicate_rows",
    rows.length <= 1 && (ok.length === 0 || rows.length === 1),
    `rows=${rows.length} accepted=${ok.length}`,
  );
  check(
    ctx,
    "accepted_lanes_wrote_once",
    writes.length === ok.length &&
      writes.every((w) => w.challenge !== null && okChallenges.has(w.challenge)),
    `writes=${writes.length} accepted=${ok.length}`,
  );
  for (const lane of ok) {
    const c = challengeOf(lane);
    const exp = typeof lane.body.expiresAt === "string" ? Date.parse(lane.body.expiresAt) : NaN;
    const lower = startMs + CHALLENGE_TTL_MS - 1_000;
    const upper = endMs + CHALLENGE_TTL_MS + 1_000;
    check(
      ctx,
      "response_shape",
      UUID_RE.test(c) && exp >= lower && exp <= upper,
      `lane=${lane.lane} challenge=${c} expiresAt=${String(lane.body.expiresAt)}`,
    );
  }
  if (rows.length === 1) {
    const row = rows[0];
    const winner = okChallenges.get(String(row.challenge));
    check(
      ctx,
      "stored_challenge_was_returned",
      winner !== undefined,
      `stored=${String(row.challenge)}`,
    );
    // The row must be one lane's payload, never a mix of two: the stored
    // expires_at is exactly what that lane returned, and the stored TTL is
    // its own created_at + 15min (the handler stamps created_at a beat after
    // it computes expires_at, so the gap is ≤ TTL and within a few ms of it).
    const ttl = Date.parse(String(row.expires_at)) - Date.parse(String(row.created_at));
    check(
      ctx,
      "no_torn_row",
      winner !== undefined &&
        row.expires_at === winner.body.expiresAt &&
        ttl <= CHALLENGE_TTL_MS &&
        ttl > CHALLENGE_TTL_MS - 1_000,
      `row.expires_at=${String(row.expires_at)} winner.expiresAt=${String(winner?.body.expiresAt)} created_at=${String(row.created_at)} ttl=${ttl}ms`,
    );
    const last = writes[writes.length - 1];
    check(
      ctx,
      "no_lost_update",
      last !== undefined && last.challenge === row.challenge,
      `lastApplied=${last?.challenge} stored=${String(row.challenge)}`,
    );
  }
}

/** True when `text` still carries a C0 control, a zero-width space or a bidi
 * override — the classes `sanitizeUserText` strips before the row is written. */
function hasUnsafeChars(text: string): boolean {
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp <= 0x1f || cp === 0x200b || cp === 0x202e) return true;
  }
  return false;
}

function checkSurvey(
  ctx: Ctx,
  userId: string,
  lanes: LaneResult[],
  surveyValidLanes: Set<number>,
): void {
  const fake = ctx.h.fake;
  const feedback = fake.feedbackRows(userId);
  const expected = okLanes(lanes).filter((l) => surveyValidLanes.has(l.lane)).length;
  const refusedWrote =
    fake.applied.filter((w) => w.table === "account_deletion_feedback" && w.userId === userId)
      .length !== expected;
  check(
    ctx,
    "survey_once_per_accepted_never_for_refused",
    feedback.length === expected && !refusedWrote,
    `feedback=${feedback.length} acceptedWithSurvey=${expected}`,
  );
  for (const row of feedback) {
    const details = row.details;
    check(
      ctx,
      "survey_row_sanitized",
      (details === null ||
        (typeof details === "string" && details.length <= 500 && !hasUnsafeChars(details))) &&
        row.provider === "google" &&
        row.platform === "ios",
      `details=${JSON.stringify(details).slice(0, 60)}`,
    );
  }
  ctx.obs.feedbackRowsForUser = feedback.length;
  ctx.obs.acceptedWithSurvey = expected;
}

function rateLimitDetail(
  ctx: Ctx,
  lanes: LaneResult[],
  startMs: number,
  endMs: number,
  requestsForUser: number,
): void {
  const ok = okLanes(lanes).length;
  const refused = lanes.filter((l) => l.op === "delete-request" && l.status === 429).length;
  const straddle = hourBucket(startMs) !== hourBucket(endMs);
  ctx.obs.hourWindowStraddled = straddle;
  const expected = Math.min(requestsForUser, DELETE_REQUEST_LIMIT.limit);
  const holds = straddle
    ? ok >= expected && ok <= Math.min(requestsForUser, 2 * DELETE_REQUEST_LIMIT.limit)
    : ok === expected && refused === requestsForUser - expected;
  check(
    ctx,
    "rate_limit_exact",
    holds,
    `accepted=${ok} refused=${refused} requests=${requestsForUser} limit=${DELETE_REQUEST_LIMIT.limit}/h straddle=${straddle}`,
  );
}

// ── Scenarios ────────────────────────────────────────────────────────────────

type Scenario = (ctx: Ctx) => Promise<LaneResult[]>;

/** S1 — duplicate delivery: N identical requests from one device at once. */
const dupBurst: Scenario = async (ctx) => {
  const { userId, tokens } = await newUser(ctx);
  const n = ctx.prng.int(2, 8);
  const withSurvey = ctx.prng.int(0, 1) === 1;
  const survey = withSurvey ? randomSurvey(ctx.prng) : null;
  ctx.inputs = {
    n,
    withSurvey,
    surveyValid: survey?.valid ?? null,
    survey: survey?.survey ?? null,
  };
  const startMs = Date.now();
  const lanes = await burst(
    ctx.prng,
    Array.from({ length: n }, () => ({
      op: "delete-request",
      run: (signal: AbortSignal) =>
        ctx.h.handler(
          deleteRequest(tokens[0], ctx.ip, survey ? { survey: survey.survey } : undefined, signal),
        ),
    })),
    { jitterMs: STRESS_JITTER_MS, deadlineMs: STRESS_DEADLINE_MS },
  );
  const endMs = Date.now();
  checkRowInvariants(ctx, userId, lanes, startMs, endMs);
  rateLimitDetail(ctx, lanes, startMs, endMs, n);
  checkSurvey(ctx, userId, lanes, new Set(survey?.valid ? lanes.map((l) => l.lane) : []));
  check(
    ctx,
    "status_set",
    lanes.every((l) => l.status === 200 || l.status === 429),
    JSON.stringify(histogram(lanes.map((l) => l.status))),
  );
  return lanes;
};

/** S2 — two actors on the same row: the same account signed in on two devices
 * (two sessions) both request deletion, while an unrelated account does the
 * same. One row per account; the loser device's challenge must be refused. */
const twoActors: Scenario = async (ctx) => {
  const a = await newUser(ctx, 2);
  const b = await newUser(ctx, 1);
  const nA1 = ctx.prng.int(1, 3);
  const nA2 = ctx.prng.int(1, 3);
  const nB = ctx.prng.int(1, 3);
  ctx.inputs = { nA1, nA2, nB };
  const lane = (token: string, op: string) => ({
    op,
    run: (signal: AbortSignal) => ctx.h.handler(deleteRequest(token, ctx.ip, undefined, signal)),
  });
  const startMs = Date.now();
  const lanes = await burst(
    ctx.prng,
    [
      ...Array.from({ length: nA1 }, () => lane(a.tokens[0], "delete-request")),
      ...Array.from({ length: nA2 }, () => lane(a.tokens[1], "delete-request")),
      ...Array.from({ length: nB }, () => lane(b.tokens[0], "delete-request:b")),
    ],
    { jitterMs: STRESS_JITTER_MS, deadlineMs: STRESS_DEADLINE_MS },
  );
  const endMs = Date.now();
  const lanesA = lanes.filter((l) => l.op === "delete-request");
  const lanesB = lanes
    .filter((l) => l.op === "delete-request:b")
    .map((l) => ({ ...l, op: "delete-request" }));
  checkRowInvariants(ctx, a.userId, lanesA, startMs, endMs);
  checkRowInvariants(ctx, b.userId, lanesB, startMs, endMs);
  rateLimitDetail(ctx, lanesA, startMs, endMs, nA1 + nA2);
  const rowA = ctx.h.fake.deletionRows(a.userId)[0];
  const rowB = ctx.h.fake.deletionRows(b.userId)[0];
  const bChallenges = new Set(okLanes(lanesB).map(challengeOf));
  const aChallenges = new Set(okLanes(lanesA).map(challengeOf));
  check(
    ctx,
    "rows_isolated_per_account",
    ctx.h.fake.deletionRows().length === 2 &&
      rowA !== undefined &&
      rowB !== undefined &&
      !bChallenges.has(String(rowA.challenge)) &&
      !aChallenges.has(String(rowB.challenge)),
    `rows=${ctx.h.fake.deletionRows().length}`,
  );
  // Every accepted challenge that is NOT the stored one must be refused by
  // confirm (the other device holds a stale challenge, not a second live one).
  const losers = okLanes(lanesA).filter((l) => challengeOf(l) !== String(rowA?.challenge));
  let refused = 0;
  for (const loser of losers) {
    const response = await ctx.h.handler(deleteConfirm(a.tokens[0], ctx.ip, challengeOf(loser)));
    const body = await readJson(response);
    const code = isRecord(body.error) ? body.error.code : undefined;
    if (response.status === 403 && code === "account.deletion_challenge_invalid") refused += 1;
  }
  check(
    ctx,
    "stale_device_challenge_refused",
    refused === losers.length,
    `losers=${losers.length} refused=${refused}`,
  );
  check(
    ctx,
    "account_b_untouched_by_a",
    ctx.h.fake.adminDeletes.length === 0,
    `adminDeletes=${ctx.h.fake.adminDeletes.length}`,
  );
  ctx.obs.loserChallenges = losers.length;
  return lanes;
};

/** S3 — call during call: re-requests race delete-confirm(c1) for a challenge
 * that is old enough to confirm. Either the account is deleted exactly once
 * and nothing survives for it, or it is alive with exactly one live row. */
const requestVsConfirm: Scenario = async (ctx) => {
  const { userId, tokens } = await newUser(ctx);
  const first = await ctx.h.handler(deleteRequest(tokens[0], ctx.ip, undefined));
  const firstBody = await readJson(first);
  if (first.status !== 200) throw new Error(`setup delete-request failed: ${first.status}`);
  const c1 = String(firstBody.challenge);
  // The app arms the final confirm 5s later; model that passage of time.
  const row = ctx.h.fake.deletionRows(userId)[0];
  row.created_at = new Date(Date.now() - CONFIRM_MIN_AGE_MS - 2_000).toISOString();
  const reRequests = ctx.prng.int(1, 2); // budget: 1 already spent of 3
  const confirms = ctx.prng.int(1, 3);
  const bogus = ctx.prng.int(0, 1);
  const writesBefore = ctx.h.fake.applied.length;
  ctx.inputs = { c1, reRequests, confirms, bogusConfirms: bogus };
  const startMs = Date.now();
  const lanes = await burst(
    ctx.prng,
    [
      ...Array.from({ length: reRequests }, () => ({
        op: "delete-request",
        run: (signal: AbortSignal) =>
          ctx.h.handler(deleteRequest(tokens[0], ctx.ip, undefined, signal)),
      })),
      ...Array.from({ length: confirms }, () => ({
        op: "delete-confirm",
        run: () => ctx.h.handler(deleteConfirm(tokens[0], ctx.ip, c1)),
      })),
      ...Array.from({ length: bogus }, () => ({
        op: "delete-confirm:bogus",
        run: () => ctx.h.handler(deleteConfirm(tokens[0], ctx.ip, ctx.prng.uuid())),
      })),
    ],
    { jitterMs: STRESS_JITTER_MS, deadlineMs: STRESS_DEADLINE_MS },
  );
  const endMs = Date.now();
  const fake = ctx.h.fake;
  const deleted = fake.adminDeletes.filter((u) => u === userId).length;
  const confirmOk = lanes.filter((l) => l.op === "delete-confirm" && l.status === 200).length;
  const reqLanes = lanes.filter((l) => l.op === "delete-request");
  check(
    ctx,
    "settled",
    lanes.every((l) => l.status !== "hung"),
    `hung=${lanes.filter((l) => l.status === "hung").length}`,
  );
  check(
    ctx,
    "confirm_status_set",
    lanes
      .filter((l) => l.op.startsWith("delete-confirm"))
      .every((l) => l.status === 200 || l.status === 403 || l.status === 401) &&
      lanes.filter((l) => l.op === "delete-confirm:bogus").every((l) => l.status !== 200),
    JSON.stringify(
      histogram(lanes.filter((l) => l.op.startsWith("delete-confirm")).map((l) => l.status)),
    ),
  );
  check(
    ctx,
    "request_status_set",
    reqLanes.every(
      (l) => l.status === 200 || l.status === 401 || l.status === 429 || l.status === 503,
    ),
    JSON.stringify(histogram(reqLanes.map((l) => l.status))),
  );
  check(
    ctx,
    "deleted_at_most_once",
    deleted <= 1 && (confirmOk === 0) === (deleted === 0),
    `adminDeletes=${deleted} confirm200=${confirmOk}`,
  );
  const rows = fake.deletionRows(userId);
  if (deleted === 1) {
    check(
      ctx,
      "no_row_for_deleted_account",
      rows.length === 0 && !fake.tables.profiles.some((p) => p.id === userId),
      `rows=${rows.length}`,
    );
    // A re-request that was still in flight must not have resurrected anything
    // and the bearer must be dead now.
    const after = await ctx.h.handler(deleteRequest(tokens[0], ctx.ip, undefined));
    await after.text();
    check(
      ctx,
      "bearer_dead_after_deletion",
      after.status === 401,
      `follow-up delete-request → ${after.status}`,
    );
    check(
      ctx,
      "no_write_after_cascade",
      fake.deletionRows(userId).length === 0,
      `rows=${fake.deletionRows(userId).length}`,
    );
    // Every re-request that returned 200 must have been APPLIED before the cascade.
    const cascadeIdx = fake.timeline.findIndex(
      (e) => e.op === "gotrue.admin.delete_user" && e.detail.includes("200"),
    );
    const lateWrite = fake.timeline.findIndex(
      (e, i) =>
        i > cascadeIdx &&
        e.op.startsWith("rest.") &&
        e.op.endsWith("account_deletion_requests") &&
        e.detail.includes(userId),
    );
    check(
      ctx,
      "no_accepted_write_after_cascade",
      cascadeIdx >= 0 && lateWrite === -1,
      `cascadeIdx=${cascadeIdx} lateWrite=${lateWrite}`,
    );
  } else {
    if (okLanes(reqLanes).length > 0) {
      checkRowInvariants(ctx, userId, [...reqLanes], startMs, endMs, writesBefore);
    } else {
      check(
        ctx,
        "c1_still_stored",
        rows.length === 1 && rows[0].challenge === c1,
        `stored=${String(rows[0]?.challenge)}`,
      );
    }
    check(ctx, "alive_has_one_row", rows.length === 1, `rows=${rows.length}`);
    check(
      ctx,
      "no_503_while_alive",
      reqLanes.every((l) => l.status !== 503),
      JSON.stringify(histogram(reqLanes.map((l) => l.status))),
    );
  }
  ctx.obs.deleted = deleted === 1;
  ctx.obs.confirmOk = confirmOk;
  ctx.obs.reRequestStatuses = histogram(reqLanes.map((l) => l.status));
  return lanes;
};

/** S4 — logout / rotation during the request. */
const logoutDuringRequest: Scenario = async (ctx) => {
  const { userId, tokens, refresh } = await newUser(ctx);
  const n = ctx.prng.int(1, 4);
  const rotate = ctx.prng.int(0, 1) === 1;
  ctx.inputs = { n, rotate };
  let rotatedToken = "";
  const startMs = Date.now();
  const lanes = await burst(
    ctx.prng,
    [
      ...Array.from({ length: n }, () => ({
        op: "delete-request",
        run: (signal: AbortSignal) =>
          ctx.h.handler(deleteRequest(tokens[0], ctx.ip, undefined, signal)),
      })),
      { op: "logout", run: () => ctx.h.handler(logoutRequest(tokens[0], ctx.ip)) },
      ...(rotate
        ? [
            {
              op: "refresh+request",
              run: async () => {
                const refreshed = await ctx.h.handler(refreshRequest(refresh[0], ctx.ip));
                const body = await readJson(refreshed);
                const session = isRecord(body.session) ? body.session : {};
                rotatedToken = typeof session.accessToken === "string" ? session.accessToken : "";
                if (!rotatedToken)
                  return new Response(JSON.stringify({ refreshStatus: refreshed.status }), {
                    status: 401,
                  });
                return ctx.h.handler(deleteRequest(rotatedToken, ctx.ip, undefined));
              },
            },
          ]
        : []),
    ],
    { jitterMs: STRESS_JITTER_MS, deadlineMs: STRESS_DEADLINE_MS },
  );
  const endMs = Date.now();
  const fake = ctx.h.fake;
  const reqLanes = lanes.filter((l) => l.op === "delete-request" || l.op === "refresh+request");
  check(
    ctx,
    "settled",
    lanes.every((l) => l.status !== "hung"),
    `hung=${lanes.filter((l) => l.status === "hung").length}`,
  );
  check(
    ctx,
    "logout_ok",
    lanes.find((l) => l.op === "logout")?.status === 204 ||
      lanes.find((l) => l.op === "logout")?.status === 200,
    `logout → ${String(lanes.find((l) => l.op === "logout")?.status)}`,
  );
  check(
    ctx,
    "request_status_set",
    reqLanes.every((l) => l.status === 200 || l.status === 401 || l.status === 429),
    JSON.stringify(histogram(reqLanes.map((l) => l.status))),
  );
  checkRowInvariants(
    ctx,
    userId,
    reqLanes.map((l) => ({ ...l, op: "delete-request" })),
    startMs,
    endMs,
  );
  // After the burst the session is revoked at GoTrue and fenced at the edge:
  // no bearer of it may work, neither the original nor a rotated one.
  const again = await ctx.h.handler(deleteRequest(tokens[0], ctx.ip, undefined));
  await again.text();
  check(ctx, "original_bearer_dead_after_logout", again.status === 401, `→ ${again.status}`);
  if (rotatedToken) {
    const viaRotated = await ctx.h.handler(deleteRequest(rotatedToken, ctx.ip, undefined));
    await viaRotated.text();
    check(
      ctx,
      "rotated_bearer_dead_after_logout",
      viaRotated.status === 401,
      `→ ${viaRotated.status}`,
    );
  }
  check(
    ctx,
    "no_write_after_revocation_followups",
    fake.deletionRows(userId).length <= 1,
    `rows=${fake.deletionRows(userId).length}`,
  );
  ctx.obs.requestStatuses = histogram(reqLanes.map((l) => l.status));
  ctx.obs.rotated = Boolean(rotatedToken);
  return lanes;
};

/** S5 — clock skew: the isolate that mints the challenge runs `skewMs` off the
 * clock that minted the session, and the confirm runs on an isolate with a
 * second skew. Row/response stay consistent; the min-age arithmetic is
 * characterized against the two clocks. */
const clockSkew: Scenario = async (ctx) => {
  const { userId, tokens } = await newUser(ctx);
  const skewRequestMs = ctx.prng.int(-300, 300) * 1_000;
  const skewConfirmMs = ctx.prng.int(-300, 300) * 1_000;
  const n = ctx.prng.int(2, 3);
  ctx.inputs = { n, skewRequestMs, skewConfirmMs };
  const lanes = await withClockSkew(skewRequestMs, async () => {
    const startMs = Date.now();
    const out = await burst(
      ctx.prng,
      Array.from({ length: n }, () => ({
        op: "delete-request",
        run: (signal: AbortSignal) =>
          ctx.h.handler(deleteRequest(tokens[0], ctx.ip, undefined, signal)),
      })),
      { jitterMs: STRESS_JITTER_MS, deadlineMs: STRESS_DEADLINE_MS },
    );
    const endMs = Date.now();
    checkRowInvariants(ctx, userId, out, startMs, endMs);
    rateLimitDetail(ctx, out, startMs, endMs, n);
    return out;
  });
  const row = ctx.h.fake.deletionRows(userId)[0];
  await withClockSkew(skewConfirmMs, async () => {
    const confirm = await ctx.h.handler(
      deleteConfirm(tokens[0], ctx.ip, String(row?.challenge ?? "")),
    );
    const body = await readJson(confirm);
    const code = isRecord(body.error) ? body.error.code : undefined;
    const ageSeenByConfirm = Date.now() - Date.parse(String(row?.created_at));
    const expiredSeenByConfirm = Date.parse(String(row?.expires_at)) <= Date.now();
    const expected = expiredSeenByConfirm
      ? { status: 403, code: "account.deletion_challenge_expired" }
      : ageSeenByConfirm < CONFIRM_MIN_AGE_MS
        ? { status: 429, code: "account.deletion_too_fast" }
        : { status: 200, code: undefined };
    check(
      ctx,
      "confirm_matches_two_clock_arithmetic",
      confirm.status === expected.status && code === expected.code,
      `confirm → ${confirm.status} ${String(code)} expected ${expected.status} ${String(expected.code)} age=${ageSeenByConfirm}ms skewReq=${skewRequestMs} skewConfirm=${skewConfirmMs}`,
    );
    // A backward-skewed confirming isolate can see a challenge minted by a
    // forward-skewed one as not-yet-old-enough or already expired; either way
    // it must never delete the account outside the [min age, TTL] window.
    check(
      ctx,
      "no_deletion_outside_window",
      confirm.status === 200
        ? ageSeenByConfirm >= CONFIRM_MIN_AGE_MS && !expiredSeenByConfirm
        : ctx.h.fake.adminDeletes.length === 0,
      `confirm=${confirm.status} age=${ageSeenByConfirm} expired=${expiredSeenByConfirm} adminDeletes=${ctx.h.fake.adminDeletes.length}`,
    );
    ctx.obs.minAgeBypassedBySkew = expected.status === 200;
    ctx.obs.confirmStatus = confirm.status;
    ctx.obs.skewObservedAgeMs = ageSeenByConfirm;
  });
  return lanes;
};

/** S6 — cancel during call: the client aborts its request mid-flight (the
 * server still finishes), other lanes race it, then the client retries. */
const cancelThenRetry: Scenario = async (ctx) => {
  const { userId, tokens } = await newUser(ctx);
  const others = ctx.prng.int(0, 2);
  const survey = randomSurvey(ctx.prng);
  const abortAtMs = ctx.prng.int(0, STRESS_LATENCY_MS * 3);
  ctx.inputs = { others, abortAtMs, surveyValid: survey.valid };
  const startMs = Date.now();
  const lanes = await burst(
    ctx.prng,
    [
      {
        op: "delete-request",
        run: (signal: AbortSignal) =>
          ctx.h.handler(deleteRequest(tokens[0], ctx.ip, { survey: survey.survey }, signal)),
      },
      ...Array.from({ length: others }, () => ({
        op: "delete-request",
        run: (signal: AbortSignal) =>
          ctx.h.handler(deleteRequest(tokens[0], ctx.ip, { survey: survey.survey }, signal)),
      })),
    ],
    {
      jitterMs: STRESS_JITTER_MS,
      deadlineMs: STRESS_DEADLINE_MS,
      abortLane: (lane) => (lane === 0 ? abortAtMs : null),
    },
  );
  const retry = await ctx.h.handler(deleteRequest(tokens[0], ctx.ip, { survey: survey.survey }));
  const retryBody = await readJson(retry);
  const endMs = Date.now();
  const fake = ctx.h.fake;
  const aborted = lanes.filter((l) => l.status === "aborted").length;
  // What the server did for the aborted lane is in the applied log, not the
  // lane result; count server-side accepted writes instead.
  const writes = fake.applied.filter(
    (w) => w.table === "account_deletion_requests" && w.userId === userId,
  );
  const rows = fake.deletionRows(userId);
  const visibleOk = okLanes(lanes).length + (retry.status === 200 ? 1 : 0);
  check(
    ctx,
    "settled",
    lanes.every((l) => l.status !== "hung"),
    `hung=${lanes.filter((l) => l.status === "hung").length}`,
  );
  check(ctx, "no_duplicate_rows", rows.length === 1, `rows=${rows.length}`);
  check(
    ctx,
    "server_side_writes_bounded_by_budget",
    writes.length <= DELETE_REQUEST_LIMIT.limit && writes.length >= visibleOk,
    `writes=${writes.length} visibleOk=${visibleOk} aborted=${aborted}`,
  );
  const last = writes[writes.length - 1];
  check(
    ctx,
    "no_lost_update",
    last !== undefined && rows[0]?.challenge === last.challenge,
    `stored=${String(rows[0]?.challenge)} last=${last?.challenge}`,
  );
  if (retry.status === 200) {
    check(
      ctx,
      "retry_challenge_is_live",
      rows[0]?.challenge === retryBody.challenge,
      `stored=${String(rows[0]?.challenge)} retry=${String(retryBody.challenge)}`,
    );
  } else {
    check(
      ctx,
      "retry_refused_only_by_budget",
      retry.status === 429 && writes.length === DELETE_REQUEST_LIMIT.limit,
      `retry → ${retry.status} writes=${writes.length}`,
    );
  }
  const feedback = fake.feedbackRows(userId).length;
  check(
    ctx,
    "survey_once_per_server_accepted",
    feedback === (survey.valid ? writes.length : 0),
    `feedback=${feedback} serverAccepted=${writes.length} valid=${survey.valid}`,
  );
  ctx.obs.retryStatus = retry.status;
  ctx.obs.serverAccepted = writes.length;
  ctx.obs.clientVisibleAccepted = visibleOk;
  ctx.obs.feedbackRowsForUser = feedback;
  ctx.obs.staleChallengeHeldByAbortedClient = aborted > 0;
  void startMs;
  void endMs;
  return lanes;
};

/** S7 — the upsert fails for some lanes (Postgres 5xx / lock timeout): those
 * lanes must answer 503 and leave NOTHING behind — no row, no survey. */
const upsertFailureRetry: Scenario = async (ctx) => {
  const { userId, tokens } = await newUser(ctx);
  const n = ctx.prng.int(2, 3);
  const failFirst = ctx.prng.int(1, n);
  const survey = randomSurvey(ctx.prng);
  let seen = 0;
  ctx.h.fake.failUpsert = (u) => {
    if (u !== userId) return null;
    seen += 1;
    return seen <= failFirst ? { status: 500, code: ctx.prng.int(0, 1) ? "57014" : "40P01" } : null;
  };
  ctx.inputs = { n, failFirst, surveyValid: survey.valid };
  const startMs = Date.now();
  const lanes = await burst(
    ctx.prng,
    Array.from({ length: n }, () => ({
      op: "delete-request",
      run: (signal: AbortSignal) =>
        ctx.h.handler(deleteRequest(tokens[0], ctx.ip, { survey: survey.survey }, signal)),
    })),
    { jitterMs: STRESS_JITTER_MS, deadlineMs: STRESS_DEADLINE_MS },
  );
  const endMs = Date.now();
  ctx.h.fake.failUpsert = null;
  const fake = ctx.h.fake;
  const failed = lanes.filter((l) => l.status === 503);
  check(
    ctx,
    "settled",
    lanes.every((l) => l.status !== "hung"),
    `hung=${lanes.filter((l) => l.status === "hung").length}`,
  );
  check(
    ctx,
    "failed_upserts_are_503",
    failed.length === failFirst && lanes.every((l) => l.status === 200 || l.status === 503),
    JSON.stringify(histogram(lanes.map((l) => l.status))),
  );
  for (const lane of failed) {
    const body = lane.body;
    check(
      ctx,
      "503_body_generic",
      !JSON.stringify(body).includes("forced") && !JSON.stringify(body).includes("57014"),
      JSON.stringify(body).slice(0, 120),
    );
  }
  checkRowInvariants(ctx, userId, lanes, startMs, endMs);
  checkSurvey(ctx, userId, lanes, new Set(survey.valid ? lanes.map((l) => l.lane) : []));
  // Retry after the failure: the client gets a live challenge.
  const retry = await ctx.h.handler(deleteRequest(tokens[0], ctx.ip, { survey: survey.survey }));
  const retryBody = await readJson(retry);
  const rows = fake.deletionRows(userId);
  // The route budget is charged BEFORE the handler runs, so a 503 spends it too.
  const budgetLeft = n < DELETE_REQUEST_LIMIT.limit;
  check(
    ctx,
    "retry_after_503",
    budgetLeft
      ? retry.status === 200 && rows.length === 1 && rows[0].challenge === retryBody.challenge
      : retry.status === 429,
    `retry → ${retry.status} budgetLeft=${budgetLeft}`,
  );
  ctx.obs.retryStatus = retry.status;
  ctx.obs.feedbackRowsForUser = fake.feedbackRows(userId).length;
  return lanes;
};

export const SCENARIOS: Record<string, Scenario> = {
  "dup-burst": dupBurst,
  "two-actors": twoActors,
  "request-vs-confirm": requestVsConfirm,
  "logout-during-request": logoutDuringRequest,
  "clock-skew": clockSkew,
  "cancel-then-retry": cancelThenRetry,
  "upsert-failure-retry": upsertFailureRetry,
};

export async function runIteration(
  h: StressHarness,
  file: string,
  scenario: string,
  seed: number,
  iteration: number,
): Promise<IterationRow> {
  const fn = SCENARIOS[scenario];
  if (!fn) throw new Error(`unknown scenario ${scenario}`);
  h.fake.reset(seed, STRESS_LATENCY_MS);
  h.redis?.store.clear();
  const ctx: Ctx = {
    h,
    prng: new Prng((salt(scenario) ^ ((seed * 31 + 7) >>> 0)) >>> 0),
    seed,
    iteration,
    ip: ipFor(scenario, seed, iteration),
    inv: [],
    obs: {},
    inputs: {},
  };
  const t0 = performance.now();
  let lanes: LaneResult[] = [];
  try {
    lanes = await fn(ctx);
  } catch (error) {
    ctx.inv.push({
      name: "scenario_threw",
      holds: false,
      detail: error instanceof Error ? (error.stack ?? error.message) : String(error),
    });
  }
  const durationMs = Math.round((performance.now() - t0) * 100) / 100;
  ctx.inv.push({
    name: "bounded_wall_time",
    holds: durationMs < STRESS_DEADLINE_MS,
    detail: `${durationMs}ms < ${STRESS_DEADLINE_MS}ms`,
  });
  return {
    scenario,
    seed,
    iteration,
    inputs: ctx.inputs,
    statusHistogram: histogram(lanes.map((l) => l.status)),
    invariants: ctx.inv,
    held: ctx.inv.every((i) => i.holds),
    observations: { ...ctx.obs, counters: h.fake.counters },
    lanes,
    applied: h.fake.applied,
    durationMs,
    replay: replayCommand(file, scenario, seed),
  };
}
