/**
 * stress — the concurrency scenarios for `GET /v1/catalog/drills/:slug`.
 *
 * Each scenario is one seeded iteration: it mints its actors through the
 * real bootstrap route, fires a Promise.all burst against the real handler
 * with seeded lane offsets (the fake's upstream latency is seeded too), and
 * records invariants. The route is a read: "idempotent" here means every
 * duplicate answers the same body, "no lost update" means a read racing a
 * save/unsave answers a state the row actually passed through, and "no
 * double spend" means the per-user budget admits exactly its limit.
 *
 * `dbBacked` marks the scenarios that reach `user_saved_drills`; the
 * postgres:16 file runs every scenario, and for those the table is real (RLS
 * enforced) rather than the in-memory model.
 */
import { edgeRequest, sleep } from "./xc_concurrency_harness.ts";
import { deterministicUuid } from "../drills.ts";
import { drillInstructionalMedia } from "../drillMedia.ts";
import {
  accessTokenWithExp,
  catalogFixture,
  detailRequest,
  GENERAL_USER_LIMIT,
  identicalBodies,
  inv,
  type IterationContext,
  newUser,
  no5xx,
  overlapCount,
  type RequestRow,
  sessionOf,
  settleInWindow,
  STRESS_BURST,
  STRESS_LATENCY_MS,
  type StressHarness,
  timed,
} from "./stress_catalog_drill_harness.ts";

export interface Scenario {
  name: string;
  label: string;
  dbBacked: boolean;
  run: (h: StressHarness, ctx: IterationContext) => Promise<void>;
}

const laneOffset = (ctx: IterationContext, spreadMs = STRESS_LATENCY_MS * 2): number =>
  ctx.prng.int(0, spreadMs);

function statusesOf(rows: RequestRow[], op: string): RequestRow[] {
  return rows.filter((r) => r.op === op);
}

function assertNo5xx(ctx: IterationContext): void {
  const bad = no5xx(ctx.rows);
  inv(
    ctx.invariants,
    "no 5xx",
    bad.length === 0,
    bad.length === 0 ? "none" : bad.map((r) => `${r.op}#${r.lane}→${r.status}`).join(", "),
  );
}

function assertInterleaved(ctx: IterationContext, rows: RequestRow[], what: string): void {
  const n = overlapCount(rows);
  ctx.observations[`${what}.overlapping`] = n;
  if (STRESS_LATENCY_MS > 0 && rows.length > 1) {
    inv(ctx.invariants, `${what}: lanes interleaved`, n >= 2, `${n}/${rows.length} overlapped`);
  }
}

function dbReadCount(h: StressHarness): number {
  return h.dbCalls.filter((c) => c.method === "GET").length;
}

// ── S1 duplicate calls, one user, cold then warm auth cache ─────────────────

const duplicateCalls: Scenario = {
  name: "s1_duplicate_calls_same_user",
  label: "stress S1",
  dbBacked: true,
  async run(h, ctx) {
    const fx = await catalogFixture();
    const slug = fx.withMedia;
    const user = await newUser(h, ctx.prng, ctx.ip(0));
    const expectedId = await deterministicUuid(`pickle-sensei.drill-catalog:${slug}`);
    const expectedMediaIds = (await drillInstructionalMedia(slug)).map((m) => m.id);

    const getUserBefore = h.fake.counters["gotrue.get_user"] ?? 0;
    await Promise.all(
      Array.from({ length: STRESS_BURST }, (_, lane) =>
        (async () => {
          await sleep(laneOffset(ctx));
          return timed(
            ctx.rows,
            lane,
            "detail.cold",
            "A",
            () => detailRequest(user.accessToken, slug, ctx.ip(1)),
            { slug },
          );
        })()),
    );
    const coldGetUser = (h.fake.counters["gotrue.get_user"] ?? 0) - getUserBefore;
    const warmBefore = h.fake.counters["gotrue.get_user"] ?? 0;
    await Promise.all(
      Array.from({ length: STRESS_BURST }, (_, lane) =>
        (async () => {
          await sleep(laneOffset(ctx));
          return timed(
            ctx.rows,
            lane,
            "detail.warm",
            "A",
            () => detailRequest(user.accessToken, slug, ctx.ip(1)),
            { slug },
          );
        })()),
    );
    const warmGetUser = (h.fake.counters["gotrue.get_user"] ?? 0) - warmBefore;
    ctx.observations.coldBurstGoTrueVerifications = coldGetUser;
    ctx.observations.warmBurstGoTrueVerifications = warmGetUser;

    const cold = statusesOf(ctx.rows, "detail.cold");
    const warm = statusesOf(ctx.rows, "detail.warm");
    inv(
      ctx.invariants,
      "every duplicate answers 200",
      ctx.rows.every((r) => r.status === 200),
      JSON.stringify(ctx.rows.map((r) => r.status)),
    );
    const same = identicalBodies(ctx.rows);
    inv(
      ctx.invariants,
      "idempotent: identical body across all duplicates",
      same.holds,
      same.detail,
    );
    inv(
      ctx.invariants,
      "saved=false for a user with no bookmark",
      ctx.rows.every((r) => r.saved === false),
      JSON.stringify(ctx.rows.map((r) => r.saved)),
    );
    const sample = ctx.rows.find((r) => r.bodyKey);
    inv(
      ctx.invariants,
      "deterministic ids (drill + media) in every body",
      sample !== undefined &&
        sample.bodyKey!.includes(`"id":${JSON.stringify(expectedId)}`) &&
        expectedMediaIds.every((id) => sample.bodyKey!.includes(JSON.stringify(id))),
      `drill=${expectedId} media=${expectedMediaIds.length}`,
    );
    inv(
      ctx.invariants,
      "exactly one saved-drill read per answered request (no duplicate or skipped reads)",
      dbReadCount(h) === ctx.rows.length,
      `${dbReadCount(h)} reads / ${ctx.rows.length} requests`,
    );
    inv(
      ctx.invariants,
      "warm burst is served from the auth cache (0 GoTrue verifications)",
      warmGetUser === 0,
      `${warmGetUser} verifications across ${warm.length} warm requests`,
    );
    inv(
      ctx.invariants,
      "cold burst verified with GoTrue at most once per lane",
      coldGetUser >= 1 && coldGetUser <= cold.length,
      `${coldGetUser} verifications across ${cold.length} cold requests`,
    );
    assertInterleaved(ctx, cold, "cold burst");
    assertNo5xx(ctx);
  },
};

// ── S2 two actors on the same slug ──────────────────────────────────────────

const twoActors: Scenario = {
  name: "s2_two_actors_same_slug",
  label: "stress S2",
  dbBacked: true,
  async run(h, ctx) {
    const fx = await catalogFixture();
    const slug = fx.withMedia;
    const other = fx.withoutMedia;
    const a = await newUser(h, ctx.prng, ctx.ip(0));
    const b = await newUser(h, ctx.prng, ctx.ip(1));
    await h.store.seed({ user_id: a.id, slug });
    await h.store.seed({ user_id: b.id, slug: other });

    await Promise.all(
      Array.from({ length: STRESS_BURST }, (_, lane) =>
        (async () => {
          await sleep(laneOffset(ctx));
          const pick = ctx.prng.int(0, 3);
          // A on the slug A saved; B on the same slug; A on the slug B saved; B on it
          const actor = pick % 2 === 0 ? a : b;
          const target = pick < 2 ? slug : other;
          return timed(
            ctx.rows,
            lane,
            `detail.${pick}`,
            actor === a ? "A" : "B",
            () => detailRequest(actor.accessToken, target, ctx.ip(2 + (actor === a ? 0 : 1))),
            { slug: target },
          );
        })()),
    );
    const expectSaved = (r: RequestRow): boolean =>
      (r.actor === "A" && r.slug === slug) || (r.actor === "B" && r.slug === other);
    const wrong = ctx.rows.filter((r) => r.status !== 200 || r.saved !== expectSaved(r));
    inv(
      ctx.invariants,
      "every lane 200 with its OWN saved flag (no cross-user leak, no missed bookmark)",
      wrong.length === 0,
      wrong.length === 0
        ? `${ctx.rows.length} lanes`
        : wrong.map((r) => `${r.actor}/${r.slug}#${r.lane}→${r.status} saved=${r.saved}`).join(
          ", ",
        ),
    );
    const same = identicalBodies(ctx.rows);
    inv(
      ctx.invariants,
      "same body per slug across both actors (saved aside)",
      same.holds,
      same.detail,
    );
    const reads = h.dbCalls.filter((c) => c.method === "GET");
    const crossScoped = reads.filter((c) => c.principal !== c.userId);
    inv(
      ctx.invariants,
      "every saved-drill read is scoped to the bearer's own user id",
      crossScoped.length === 0 && reads.length === ctx.rows.length,
      `${reads.length} reads, ${crossScoped.length} cross-scoped`,
    );
    const rowsLeaked = reads.filter(
      (c) =>
        (c.rows ?? 0) > 0 &&
        !((c.principal === a.id && c.slug === slug) || (c.principal === b.id && c.slug === other)),
    );
    inv(
      ctx.invariants,
      "the database never returns another user's bookmark",
      rowsLeaked.length === 0,
      `${rowsLeaked.length} leaked reads`,
    );
    assertInterleaved(ctx, ctx.rows, "burst");
    assertNo5xx(ctx);
  },
};

// ── S3 reads racing save/unsave of the same row ─────────────────────────────

interface Mutation {
  kind: "save" | "unsave";
  startedAt: number;
  endedAt: number;
  status: number;
}

/** Values `saved` may legitimately hold at instant `t` given the mutation
 * windows: unknown while any mutation is in flight; otherwise the outcome of
 * the last completed mutation (any mutation overlapping it is ambiguous too). */
function possibleAt(t: number, initial: boolean, mutations: Mutation[]): Set<boolean> {
  const inflight = mutations.some((m) => m.startedAt <= t && t < m.endedAt);
  if (inflight) return new Set([true, false]);
  const done = mutations.filter((m) => m.endedAt <= t);
  if (done.length === 0) return new Set([initial]);
  const last = done.reduce((x, y) => (y.endedAt > x.endedAt ? y : x));
  const candidates = done.filter(
    (m) => m === last || (m.startedAt < last.endedAt && last.startedAt < m.endedAt),
  );
  return new Set(candidates.map((m) => m.kind === "save"));
}

function linearizable(read: RequestRow, initial: boolean, mutations: Mutation[]): boolean {
  if (read.saved === undefined) return false;
  const instants = [read.startedAt, read.endedAt];
  for (const m of mutations) {
    for (const t of [m.startedAt, m.endedAt, m.endedAt + 0.001]) {
      if (t >= read.startedAt && t <= read.endedAt) instants.push(t);
    }
  }
  return instants.some((t) => possibleAt(t, initial, mutations).has(read.saved!));
}

const toggleDuringRead: Scenario = {
  name: "s3_save_unsave_during_reads",
  label: "stress S3",
  dbBacked: true,
  async run(h, ctx) {
    const fx = await catalogFixture();
    const slug = fx.withMedia;
    const user = await newUser(h, ctx.prng, ctx.ip(0));
    const initial = ctx.prng.int(0, 1) === 1;
    if (initial) await h.store.seed({ user_id: user.id, slug });
    const mutators = ctx.prng.int(2, Math.max(2, Math.min(6, STRESS_BURST / 2)));
    const mutations: Mutation[] = [];
    const spread = STRESS_LATENCY_MS * 4;

    const lanes: Array<Promise<unknown>> = Array.from(
      { length: STRESS_BURST },
      (_, lane) =>
        (async () => {
          await sleep(laneOffset(ctx, spread));
          return timed(
            ctx.rows,
            lane,
            "detail",
            "A",
            () => detailRequest(user.accessToken, slug, ctx.ip(1)),
            { slug },
          );
        })(),
    );
    for (let m = 0; m < mutators; m++) {
      const kind: Mutation["kind"] = ctx.prng.int(0, 1) === 0 ? "save" : "unsave";
      lanes.push(
        (async () => {
          await sleep(laneOffset(ctx, spread));
          const { row } = await timed(
            ctx.rows,
            STRESS_BURST + m,
            kind,
            "A",
            () =>
              edgeRequest(kind === "save" ? "PUT" : "DELETE", `/v1/me/saved-drills/${slug}`, {
                token: user.accessToken,
                ip: ctx.ip(2),
                body: kind === "save" ? { slug, saved: true } : undefined,
              }),
          );
          mutations.push({
            kind,
            startedAt: row.startedAt,
            endedAt: row.endedAt,
            status: row.status,
          });
        })(),
      );
    }
    await Promise.all(lanes);

    const reads = statusesOf(ctx.rows, "detail");
    const finalRows = (await h.store.all()).filter((r) => r.user_id === user.id && r.slug === slug);
    const { row: after } = await timed(
      ctx.rows,
      0,
      "detail.after",
      "A",
      () => detailRequest(user.accessToken, slug, ctx.ip(1)),
      { slug },
    );
    ctx.observations.initialSaved = initial;
    ctx.observations.mutations = mutations.map((m) => `${m.kind}:${m.status}`);
    ctx.observations.readsDuringMutation =
      reads.filter((r) => mutations.some((m) => m.startedAt < r.endedAt && r.startedAt < m.endedAt))
        .length;

    inv(
      ctx.invariants,
      "every read racing the writes answers 200",
      reads.every((r) => r.status === 200),
      JSON.stringify(reads.map((r) => r.status)),
    );
    inv(
      ctx.invariants,
      "concurrent save/unsave of the same row answer definitively (PUT 200, DELETE 204 — never 5xx)",
      mutations.every((m) => m.status === (m.kind === "save" ? 200 : 204)),
      mutations.map((m) => `${m.kind}→${m.status}`).join(", "),
    );
    const stale = reads.filter((r) => r.status === 200 && !linearizable(r, initial, mutations));
    inv(
      ctx.invariants,
      "every read answers a saved state the row actually held during the read (linearizable)",
      stale.length === 0,
      stale.length === 0
        ? `${reads.length} reads / ${mutations.length} mutations`
        : stale.map((r) => `#${r.lane} saved=${r.saved} [${r.startedAt},${r.endedAt}]`).join(", "),
    );
    inv(
      ctx.invariants,
      "no duplicate bookmark rows after concurrent saves",
      finalRows.length <= 1,
      `${finalRows.length} rows for (user, slug)`,
    );
    inv(
      ctx.invariants,
      "read after the burst reflects the final row state",
      after.status === 200 && after.saved === (finalRows.length === 1),
      `saved=${after.saved} rows=${finalRows.length}`,
    );
    const same = identicalBodies(ctx.rows);
    inv(ctx.invariants, "body identical across reads (saved aside)", same.holds, same.detail);
    assertInterleaved(ctx, ctx.rows, "burst");
    assertNo5xx(ctx);
  },
};

// ── S4 logout during the burst ──────────────────────────────────────────────

const logoutDuringBurst: Scenario = {
  name: "s4_logout_during_burst",
  label: "stress S4",
  dbBacked: false,
  async run(h, ctx) {
    const fx = await catalogFixture();
    const slug = fx.withoutMedia;
    const user = await newUser(h, ctx.prng, ctx.ip(0));
    // Warm the cache for some seeds so both the cached and the verifying path race the logout.
    if (ctx.prng.int(0, 1) === 1) {
      await timed(
        ctx.rows,
        0,
        "detail.warmup",
        "A",
        () => detailRequest(user.accessToken, slug, ctx.ip(1)),
      );
    }
    let logoutDoneAt = Infinity;
    let logoutStatus = 0;
    const lanes: Array<Promise<unknown>> = Array.from(
      { length: STRESS_BURST },
      (_, lane) =>
        (async () => {
          await sleep(laneOffset(ctx, STRESS_LATENCY_MS * 3));
          // one IP per lane: 401s charge the per-IP auth-failure budget
          return timed(
            ctx.rows,
            lane,
            "detail",
            "A",
            () => detailRequest(user.accessToken, slug, ctx.ip(10 + lane)),
            { slug },
          );
        })(),
    );
    lanes.push(
      (async () => {
        await sleep(laneOffset(ctx, STRESS_LATENCY_MS * 3));
        const { row } = await timed(
          ctx.rows,
          STRESS_BURST,
          "logout",
          "A",
          () => edgeRequest("POST", "/v1/auth/logout", { token: user.accessToken, ip: ctx.ip(2) }),
        );
        logoutDoneAt = row.endedAt;
        logoutStatus = row.status;
      })(),
    );
    await Promise.all(lanes);
    const reads = statusesOf(ctx.rows, "detail");
    const getUserBefore = h.fake.counters["gotrue.get_user"] ?? 0;
    const { row: after } = await timed(
      ctx.rows,
      0,
      "detail.after_logout",
      "A",
      () => detailRequest(user.accessToken, slug, ctx.ip(3)),
    );
    const { row: again } = await timed(
      ctx.rows,
      1,
      "detail.after_logout.again",
      "A",
      () => detailRequest(user.accessToken, slug, ctx.ip(4)),
    );
    const getUserAfter = (h.fake.counters["gotrue.get_user"] ?? 0) - getUserBefore;
    const startedAfter = reads.filter((r) => r.startedAt > logoutDoneAt);
    const resurrected = startedAfter.filter((r) => r.status === 200);
    ctx.observations.readsStartedAfterLogout = startedAfter.length;
    ctx.observations.reads401 = reads.filter((r) => r.status === 401).length;
    inv(ctx.invariants, "logout 204", logoutStatus === 204, `→ ${logoutStatus}`);
    inv(
      ctx.invariants,
      "every read racing the logout is 200 or 401",
      reads.every((r) => r.status === 200 || r.status === 401),
      JSON.stringify(reads.map((r) => r.status)),
    );
    inv(
      ctx.invariants,
      "no read that started after the logout completed is served",
      resurrected.length === 0,
      `${resurrected.length}/${startedAfter.length} served after logout`,
    );
    inv(
      ctx.invariants,
      "revoked bearer refused on the next two requests (never re-cached)",
      after.status === 401 && again.status === 401,
      `after=${after.status} again=${again.status}`,
    );
    inv(
      ctx.invariants,
      "GoTrue consulted ≤ 1 time for the two post-logout requests",
      getUserAfter <= 1,
      `${getUserAfter} verifications`,
    );
    inv(
      ctx.invariants,
      "200 reads carry the right body",
      reads.filter((r) => r.status === 200).every((r) => r.saved === false && r.bodyKey),
      "",
    );
    assertNo5xx(ctx);
  },
};

// ── S5 refresh rotation during the burst, then logout via the NEW bearer ────

const rotateDuringBurst: Scenario = {
  name: "s5_rotation_during_burst",
  label: "stress S5",
  dbBacked: false,
  async run(h, ctx) {
    const fx = await catalogFixture();
    const slug = fx.withMedia;
    const user = await newUser(h, ctx.prng, ctx.ip(0));
    let rotated: { accessToken: string; refreshToken: string } | null = null;
    let refreshStatus = 0;
    const lanes: Array<Promise<unknown>> = Array.from(
      { length: STRESS_BURST },
      (_, lane) =>
        (async () => {
          await sleep(laneOffset(ctx, STRESS_LATENCY_MS * 3));
          return timed(
            ctx.rows,
            lane,
            "detail.old",
            "A",
            () => detailRequest(user.accessToken, slug, ctx.ip(1)),
            { slug },
          );
        })(),
    );
    lanes.push(
      (async () => {
        await sleep(laneOffset(ctx, STRESS_LATENCY_MS * 3));
        const { row, body } = await timed(
          ctx.rows,
          STRESS_BURST,
          "refresh",
          "A",
          () =>
            edgeRequest("POST", "/v1/auth/refresh", {
              ip: ctx.ip(2),
              body: { refreshToken: user.refreshToken },
            }),
        );
        refreshStatus = row.status;
        const session = body.session as Record<string, unknown> | undefined;
        if (session) {
          rotated = {
            accessToken: String(session.accessToken),
            refreshToken: String(session.refreshToken),
          };
        }
      })(),
    );
    await Promise.all(lanes);
    inv(
      ctx.invariants,
      "refresh rotated (200)",
      refreshStatus === 200 && rotated !== null,
      `→ ${refreshStatus}`,
    );
    if (!rotated) return;
    const fresh: { accessToken: string; refreshToken: string } = rotated;
    // Both bearers of the same session are live until exp: mix them.
    await Promise.all(
      Array.from({ length: STRESS_BURST }, (_, lane) =>
        (async () => {
          await sleep(laneOffset(ctx));
          const useNew = ctx.prng.int(0, 1) === 1;
          return timed(
            ctx.rows,
            lane,
            useNew ? "detail.new" : "detail.old.after_rotation",
            "A",
            () => detailRequest(useNew ? fresh.accessToken : user.accessToken, slug, ctx.ip(3)),
            { slug },
          );
        })()),
    );
    const preLogout = ctx.rows.filter((r) => r.op.startsWith("detail."));
    inv(
      ctx.invariants,
      "old and new bearers of one session are both served until logout",
      preLogout.every((r) => r.status === 200),
      JSON.stringify(preLogout.map((r) => `${r.op}:${r.status}`)),
    );
    const same = identicalBodies(ctx.rows);
    inv(ctx.invariants, "identical body under either bearer", same.holds, same.detail);

    // Logout with the NEW bearer; the OLD one (same session_id) must die too.
    const { row: logout } = await timed(
      ctx.rows,
      0,
      "logout.new",
      "A",
      () => edgeRequest("POST", "/v1/auth/logout", { token: fresh.accessToken, ip: ctx.ip(4) }),
    );
    const post = await Promise.all(
      Array.from({ length: Math.min(STRESS_BURST, 8) }, (_, lane) =>
        (async () => {
          await sleep(laneOffset(ctx));
          const useNew = lane % 2 === 0;
          return timed(
            ctx.rows,
            lane,
            useNew ? "post_logout.new" : "post_logout.old",
            "A",
            () =>
              detailRequest(
                useNew ? fresh.accessToken : user.accessToken,
                slug,
                ctx.ip(20 + lane),
              ),
          );
        })()),
    );
    inv(ctx.invariants, "logout via new bearer 204", logout.status === 204, `→ ${logout.status}`);
    inv(
      ctx.invariants,
      "after logout BOTH the new and the pre-rotation bearer are refused (session fence)",
      post.every(({ row }) => row.status === 401),
      JSON.stringify(post.map(({ row }) => `${row.op}:${row.status}`)),
    );
    assertInterleaved(ctx, statusesOf(ctx.rows, "detail.old"), "pre-rotation burst");
    assertNo5xx(ctx);
  },
};

// ── S6 clock skew: bearers expiring mid-burst / already expired ─────────────

const clockSkew: Scenario = {
  name: "s6_clock_skew_expiring_bearers",
  label: "stress S6",
  dbBacked: false,
  async run(h, ctx) {
    const fx = await catalogFixture();
    const slug = fx.withoutMedia;
    const user = await newUser(h, ctx.prng, ctx.ip(0));
    const session = sessionOf(h, user.accessToken);
    const nowSec = Date.now() / 1000;
    const expiredExp = Math.floor(nowSec) - 1;
    // Expires within the next second: the burst straddles the boundary.
    const expiringExp = Math.ceil(nowSec) + (Date.now() % 1000 > 700 ? 1 : 0);
    const expired = accessTokenWithExp(h, session, expiredExp, "expired");
    const expiring = accessTokenWithExp(h, session, expiringExp, "expiring");
    const expiringMs = expiringExp * 1000;
    const spreadMs = Math.max(300, expiringMs - Date.now() + 400);
    ctx.observations.expiringInMs = expiringMs - Date.now();

    await Promise.all(
      Array.from({ length: STRESS_BURST }, (_, lane) =>
        (async () => {
          const kind = lane % 4 === 0 ? "expired" : lane % 4 === 1 ? "live" : "expiring";
          await sleep(kind === "expiring" ? ctx.prng.int(0, spreadMs) : laneOffset(ctx));
          const token = kind === "expired"
            ? expired
            : kind === "live"
            ? user.accessToken
            : expiring;
          return timed(
            ctx.rows,
            lane,
            `detail.${kind}`,
            "A",
            () => detailRequest(token, slug, ctx.ip(10 + lane)),
            { slug },
          );
        })()),
    );
    const expiredRows = statusesOf(ctx.rows, "detail.expired");
    const liveRows = statusesOf(ctx.rows, "detail.live");
    const expiringRows = statusesOf(ctx.rows, "detail.expiring");
    const expiredVerified = h.fake.timeline.filter(
      (e) => e.op === "gotrue.get_user" && e.detail.includes(`bearer=${expired.slice(-10)}`),
    ).length;
    inv(
      ctx.invariants,
      "already-expired bearer → 401 without consulting GoTrue",
      expiredRows.every((r) => r.status === 401) && expiredVerified === 0,
      `${JSON.stringify(expiredRows.map((r) => r.status))} verifications=${expiredVerified}`,
    );
    inv(
      ctx.invariants,
      "live bearer → 200 throughout",
      liveRows.every((r) => r.status === 200),
      JSON.stringify(liveRows.map((r) => r.status)),
    );
    const before = expiringRows.filter((r) => r.wallEnd < expiringMs);
    const afterExp = expiringRows.filter((r) => r.wallStart >= expiringMs);
    const served = expiringRows.filter((r) => r.status === 200);
    const refused = expiringRows.filter((r) => r.status === 401);
    ctx.observations.expiringBeforeExp = before.length;
    ctx.observations.expiringAfterExp = afterExp.length;
    ctx.observations.expiringServed = served.length;
    inv(
      ctx.invariants,
      "expiring bearer: 200 while wholly before exp, 401 once started at/after exp, never anything else",
      expiringRows.every((r) => r.status === 200 || r.status === 401) &&
        before.every((r) => r.status === 200) &&
        afterExp.every((r) => r.status === 401),
      `before=${before.map((r) => r.status).join(",")} after=${
        afterExp.map((r) => r.status).join(",")
      }`,
    );
    const nonMonotone = served.filter((s) => refused.some((f) => s.wallStart >= f.wallEnd));
    inv(
      ctx.invariants,
      "expiring bearer: no 200 begins after a 401 completed (expiry is monotone, cache never revives it)",
      nonMonotone.length === 0,
      `${nonMonotone.length} revived`,
    );
    assertNo5xx(ctx);
  },
};

// ── S7 client cancels / abandons mid-call ───────────────────────────────────

const cancelDuringCall: Scenario = {
  name: "s7_cancel_during_call",
  label: "stress S7",
  dbBacked: false,
  async run(h, ctx) {
    const fx = await catalogFixture();
    const slug = fx.withMedia;
    const user = await newUser(h, ctx.prng, ctx.ip(0));
    const controllers: AbortController[] = [];
    await Promise.all(
      Array.from({ length: STRESS_BURST }, (_, lane) =>
        (async () => {
          await sleep(laneOffset(ctx));
          const cancel = lane % 2 === 1;
          const controller = new AbortController();
          controllers.push(controller);
          if (cancel) {
            // abort while the handler is (probably) awaiting upstream
            sleep(ctx.prng.int(0, STRESS_LATENCY_MS)).then(() => controller.abort("client left"));
          }
          return timed(
            ctx.rows,
            lane,
            cancel ? "detail.cancelled" : "detail",
            "A",
            () =>
              new Request(detailRequest(user.accessToken, slug, ctx.ip(1)), {
                signal: controller.signal,
              }),
            { slug, abandon: cancel },
          );
        })()),
    );
    const firstWave = ctx.rows.length;
    // The survivors' next screenful must be unaffected.
    await Promise.all(
      Array.from({ length: STRESS_BURST }, (_, lane) =>
        (async () => {
          await sleep(laneOffset(ctx));
          return timed(
            ctx.rows,
            lane,
            "detail.after",
            "A",
            () => detailRequest(user.accessToken, slug, ctx.ip(1)),
            { slug },
          );
        })()),
    );
    ctx.observations.abortedLanes = controllers.filter((c) => c.signal.aborted).length;
    inv(
      ctx.invariants,
      "every lane settled with 200 (a cancelled client never poisons the handler)",
      ctx.rows.every((r) => r.status === 200),
      JSON.stringify(ctx.rows.map((r) => `${r.op}:${r.status}`)),
    );
    inv(
      ctx.invariants,
      "one saved-drill read per request, cancelled or not (no retries, no skips)",
      dbReadCount(h) === ctx.rows.length,
      `${dbReadCount(h)} reads / ${ctx.rows.length} requests (${firstWave} in the cancel wave)`,
    );
    const same = identicalBodies(ctx.rows);
    inv(ctx.invariants, "identical body for every completed read", same.holds, same.detail);
    assertNo5xx(ctx);
  },
};

// ── S8 mixed slugs: valid / unknown / malformed / oversized in one burst ────

const mixedSlugs: Scenario = {
  name: "s8_mixed_slugs_burst",
  label: "stress S8",
  dbBacked: true,
  async run(h, ctx) {
    const fx = await catalogFixture();
    const user = await newUser(h, ctx.prng, ctx.ip(0));
    const oversized = `${"z".repeat(121)}`;
    const kinds = [
      "valid_media",
      "valid_plain",
      "unknown",
      "malformed",
      "oversized",
      "case",
    ] as const;
    const target = (kind: (typeof kinds)[number]): { path: string; slug: string } => {
      switch (kind) {
        case "valid_media":
          return { path: fx.withMedia, slug: fx.withMedia };
        case "valid_plain":
          return { path: fx.withoutMedia, slug: fx.withoutMedia };
        case "unknown":
          return { path: `not-a-drill-${ctx.seed}`, slug: `not-a-drill-${ctx.seed}` };
        case "malformed":
          return { path: "%E0%A4%A", slug: "%E0%A4%A" };
        case "oversized":
          return { path: oversized, slug: oversized };
        case "case":
          return { path: fx.withMedia.toUpperCase(), slug: fx.withMedia.toUpperCase() };
      }
    };
    await Promise.all(
      Array.from({ length: STRESS_BURST }, (_, lane) =>
        (async () => {
          await sleep(laneOffset(ctx));
          const kind = kinds[ctx.prng.int(0, kinds.length - 1)];
          const t = target(kind);
          return timed(
            ctx.rows,
            lane,
            kind,
            "A",
            () => detailRequest(user.accessToken, t.path, ctx.ip(1)),
            { slug: t.slug },
          );
        })()),
    );
    const byKind = (k: (typeof kinds)[number]) => statusesOf(ctx.rows, k);
    const expectStatus: Record<(typeof kinds)[number], number> = {
      valid_media: 200,
      valid_plain: 200,
      unknown: 404,
      malformed: 400,
      oversized: 404,
      case: 404,
    };
    const wrong = ctx.rows.filter((r) => r.status !== expectStatus[r.op as (typeof kinds)[number]]);
    inv(
      ctx.invariants,
      "status per slug kind: valid 200 · unknown/oversized/wrong-case 404 · malformed %-encoding 400",
      wrong.length === 0,
      wrong.length === 0
        ? kinds.map((k) => `${k}=${byKind(k).length}`).join(" ")
        : wrong.map((r) => `${r.op}#${r.lane}→${r.status}`).join(", "),
    );
    inv(
      ctx.invariants,
      "404s are coded drill.not_found",
      ctx.rows.filter((r) => r.status === 404).every((r) => r.code === "drill.not_found"),
      JSON.stringify(ctx.rows.filter((r) => r.status === 404).map((r) => r.code)),
    );
    const valid = ctx.rows.filter((r) => r.status === 200);
    inv(
      ctx.invariants,
      "only catalog hits reach the database (one read each; 404/400 lanes never do)",
      dbReadCount(h) === valid.length,
      `${dbReadCount(h)} reads / ${valid.length} catalog hits / ${ctx.rows.length} lanes`,
    );
    inv(
      ctx.invariants,
      "200 bodies name their own slug",
      valid.every((r) => r.bodyKey?.includes(`"slug":${JSON.stringify(r.slug)}`)),
      "",
    );
    const same = identicalBodies(ctx.rows);
    inv(ctx.invariants, "identical body per valid slug", same.holds, same.detail);
    assertNo5xx(ctx);
  },
};

// ── S9 per-user budget under a burst (no double spend of the allowance) ─────

const userBudget: Scenario = {
  name: "s9_user_budget_burst",
  label: "stress S9",
  dbBacked: false,
  async run(h, ctx) {
    const fx = await catalogFixture();
    const slug = fx.withoutMedia;
    await settleInWindow(5_000);
    const user = await newUser(h, ctx.prng, ctx.ip(0));
    // bootstrap charged the user budget once
    const expectedServed = GENERAL_USER_LIMIT.limit - 1;
    const over = 10;
    const lanes = expectedServed + over;
    await Promise.all(
      Array.from({ length: lanes }, (_, lane) =>
        (async () => {
          await sleep(laneOffset(ctx));
          return timed(
            ctx.rows,
            lane,
            "detail",
            "A",
            () => detailRequest(user.accessToken, slug, ctx.ip(1)),
            { slug },
          );
        })()),
    );
    const served = ctx.rows.filter((r) => r.status === 200);
    const limited = ctx.rows.filter((r) => r.status === 429);
    inv(
      ctx.invariants,
      `per-user budget admits exactly ${expectedServed} of ${lanes} concurrent reads (${over} × 429)`,
      served.length === expectedServed && limited.length === over,
      `200=${served.length} 429=${limited.length} other=${
        ctx.rows.length - served.length - limited.length
      }`,
    );
    inv(
      ctx.invariants,
      "429s are coded rate_limited",
      limited.every((r) => r.code === "rate_limited"),
      JSON.stringify([...new Set(limited.map((r) => r.code))]),
    );
    inv(
      ctx.invariants,
      "a limited request does no database work",
      dbReadCount(h) === served.length,
      `${dbReadCount(h)} reads / ${served.length} served`,
    );
    const same = identicalBodies(ctx.rows);
    inv(ctx.invariants, "identical body across the served reads", same.holds, same.detail);
    assertInterleaved(ctx, ctx.rows, "burst");
    assertNo5xx(ctx);
  },
};

/**
 * S10 — the minimized, timing-free form of the S3 failure: one save (device
 * 1) with one unsave (device 2, same account) landing EXACTLY between the
 * save's upsert and its read-back, while detail reads observe both sides.
 * The interleaving is forced through the store (call-during-call), so the
 * outcome does not depend on wall-clock jitter.
 */
const unsaveBetweenUpsertAndReadback: Scenario = {
  name: "s10_unsave_between_save_upsert_and_readback",
  label: "stress S10",
  dbBacked: true,
  async run(h, ctx) {
    const fx = await catalogFixture();
    const slug = ctx.prng.int(0, 1) === 0 ? fx.withMedia : fx.withoutMedia;
    const user = await newUser(h, ctx.prng, ctx.ip(0));
    const store = h.store;
    const originalUpsert = store.upsertIgnore.bind(store);
    let unsaveStatus = 0;
    let readsDuringGap = 0;
    let armed = true;
    store.upsertIgnore = async (principal, row) => {
      const ok = await originalUpsert(principal, row);
      if (armed && row.user_id === user.id && row.slug === slug) {
        armed = false;
        const [{ row: unsave }, ...reads] = await Promise.all([
          timed(
            ctx.rows,
            1,
            "unsave",
            "A",
            () =>
              edgeRequest("DELETE", `/v1/me/saved-drills/${slug}`, {
                token: user.accessToken,
                ip: ctx.ip(2),
              }),
          ),
          ...Array.from(
            { length: 2 },
            (_, i) =>
              timed(
                ctx.rows,
                2 + i,
                "detail",
                "A",
                () => detailRequest(user.accessToken, slug, ctx.ip(1)),
                { slug },
              ),
          ),
        ]);
        unsaveStatus = unsave.status;
        readsDuringGap = reads.length;
      }
      return ok;
    };
    try {
      const { row: save } = await timed(
        ctx.rows,
        0,
        "save",
        "A",
        () =>
          edgeRequest("PUT", `/v1/me/saved-drills/${slug}`, {
            token: user.accessToken,
            ip: ctx.ip(2),
            body: { slug, saved: true },
          }),
      );
      const finalRows = (await h.store.all()).filter((r) =>
        r.user_id === user.id && r.slug === slug
      );
      const { row: after } = await timed(
        ctx.rows,
        4,
        "detail.after",
        "A",
        () => detailRequest(user.accessToken, slug, ctx.ip(1)),
        { slug },
      );
      ctx.observations.saveStatus = save.status;
      ctx.observations.unsaveStatus = unsaveStatus;
      ctx.observations.readsDuringGap = readsDuringGap;
      inv(
        ctx.invariants,
        "the unsave landed inside the save (call-during-call forced)",
        !armed && unsaveStatus === 204,
        `unsave=${unsaveStatus}`,
      );
      inv(
        ctx.invariants,
        "PUT whose row was unsaved by another device before its read-back answers definitively (200), not 503",
        save.status === 200,
        `save=${save.status} code=${save.code ?? "-"}`,
      );
      inv(
        ctx.invariants,
        "every detail read answers 200",
        statusesOf(ctx.rows, "detail").every((r) => r.status === 200),
        JSON.stringify(statusesOf(ctx.rows, "detail").map((r) => r.status)),
      );
      inv(
        ctx.invariants,
        "no duplicate bookmark rows",
        finalRows.length <= 1,
        `${finalRows.length} rows`,
      );
      inv(
        ctx.invariants,
        "read after the race reflects the final row state",
        after.status === 200 && after.saved === (finalRows.length === 1),
        `saved=${after.saved} rows=${finalRows.length}`,
      );
      assertNo5xx(ctx);
    } finally {
      store.upsertIgnore = originalUpsert;
    }
  },
};

export const SCENARIOS: Scenario[] = [
  duplicateCalls,
  twoActors,
  toggleDuringRead,
  logoutDuringBurst,
  rotateDuringBurst,
  clockSkew,
  cancelDuringCall,
  mixedSlugs,
  userBudget,
  unsaveBetweenUpsertAndReadback,
];
