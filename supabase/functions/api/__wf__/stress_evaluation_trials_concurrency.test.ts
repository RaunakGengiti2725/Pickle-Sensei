// stress — POST /v1/me/evaluation/trials, lens CONCURRENCY.
//
// A seeded CAMPAIGN of cases against the REAL edge handler (in-process, see
// stress_evaluation_trials_harness.ts). Each case draws its scenario kind and
// shape from its own seed, fires the shape as a Promise.all burst (plus side
// actions at seeded moments) and checks the route's contract:
//
//   idempotency      the same trialId uploaded N× (same or rebuilt payload,
//                    same or overlapping batches) is stored ONCE and accepted
//                    every time
//   ownership        two accounts racing on one trialId → exactly one row,
//                    the owner is accepted, the other gets
//                    evaluation.trial_id_conflict, never a foreign row
//   no ghost rows    a row exists ⇔ some 200 response from its owner accepted
//                    it (429 / 401 / 400 / aborted uploads write nothing)
//   consent gate     403 consent_inactive ⇒ nothing of that request stored
//   auth races       logout / refresh mid-burst: {200, 401} only, the revoked
//                    bearer is refused afterwards, rotation loses no trial
//   rate limit       a burst wider than the 12/min trials budget yields
//                    EXACTLY 12 × 200 in one window, 429s write nothing
//   clock skew       an expired-by-skew bearer is refused before any write
//   bounded time     every case finishes under STRESS_DEADLINE_MS (no deadlock)
//
// Scale: STRESS_ITER cases (default 40 — fast enough for `deno task test`;
// the campaign run recorded for the stress report used STRESS_ITER=600),
// STRESS_LATENCY_MS max seeded upstream latency (default 8), STRESS_SEED base.
// Replay one case: STRESS_REPLAY=<seed> (as printed in the table). Force a
// kind: STRESS_KIND=<kind>. Output: STRESS_OUT_DIR (default
// artifacts/stress-evaluation-trials/latest/) — campaign.json is the
// seed → outcome table; broken cases also get <seed>.json with their timeline.

import { assert, assertEquals } from "@std/assert";
import {
  abortedTrialsRequest,
  bootstrap,
  type CaseOutcome,
  caseSeed,
  consentRequest,
  histogram,
  type Invariant,
  loadTrialsHarness,
  outDir,
  oversizedTrial,
  Prng,
  replayCommand,
  type Row,
  skewedBearer,
  sleep,
  STRESS_DEADLINE_MS,
  STRESS_ITER,
  STRESS_KIND,
  STRESS_LATENCY_MS,
  STRESS_REPLAY,
  STRESS_SEED,
  timed,
  trialPayload,
  TRIALS_ROUTE_LIMIT,
  type TrialsHarness,
  trialsRequest,
  withDeadline,
  writeJson,
} from "./stress_evaluation_trials_harness.ts";

const FILE = "stress_evaluation_trials_concurrency.test.ts";

export const KINDS = [
  "dup_delivery",
  "overlap",
  "two_actors",
  "consent_race",
  "logout_race",
  "rotation_race",
  "rate_limit",
  "cancel_during_call",
  "clock_skew",
  "mixed_validation",
] as const;
type Kind = (typeof KINDS)[number];

interface Actor {
  tag: string;
  userId: string;
  accessToken: string;
  refreshToken: string;
}

interface Ctx {
  h: TrialsHarness;
  prng: Prng;
  seed: number;
  ip: string;
  rows: Row[];
  /** which account each request row was sent as */
  owner: Map<Row, string>;
  /** trialIds each request carried (UUID-valid ones only) */
  carried: Map<Row, string[]>;
  invariants: Invariant[];
  params: Record<string, unknown>;
  observations: Record<string, unknown>;
  actors: Actor[];
}

let runCounter = 0;

function inv(ctx: Ctx, name: string, holds: boolean, detail: string): void {
  ctx.invariants.push({ name, holds, detail });
}

/** A user id that is deterministic for (seed, position) yet distinct across
 * runs inside one process — the edge fn's per-isolate rate-limit windows are
 * keyed by user id and outlive fake.reset(). */
function freshSub(ctx: Ctx): string {
  const base = ctx.prng.uuid();
  return `${base.slice(0, 24)}${runCounter.toString(16).padStart(12, "0")}`;
}

async function newActor(ctx: Ctx, tag: string, grant = true): Promise<Actor> {
  const sub = freshSub(ctx);
  const boot = await bootstrap(ctx.h, sub, ctx.ip);
  inv(ctx, `bootstrap ${tag} → 200`, boot.status === 200, `status=${boot.status}`);
  const actor: Actor = {
    tag,
    userId: sub,
    accessToken: boot.accessToken,
    refreshToken: boot.refreshToken,
  };
  ctx.actors.push(actor);
  if (grant) {
    const granted = await timed(ctx.rows, -1, `consent.grant:${tag}`, () =>
      ctx.h.handler(consentRequest(actor.accessToken, ctx.ip, "grant")),
    );
    inv(ctx, `consent grant ${tag} → 200`, granted.status === 200, `status=${granted.status}`);
  }
  return actor;
}

function uuids(ctx: Ctx, n: number): string[] {
  return Array.from({ length: n }, () => ctx.prng.uuid());
}

const isUuid = (v: unknown): v is string =>
  typeof v === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

async function upload(
  ctx: Ctx,
  actor: Actor,
  lane: number,
  op: string,
  trials: unknown[],
  options: { token?: string; request?: Request; startAfterMs?: number } = {},
) {
  const token = options.token ?? actor.accessToken;
  if (options.startAfterMs) await sleep(options.startAfterMs);
  const res = await timed(ctx.rows, lane, op, () =>
    ctx.h.handler(options.request ?? trialsRequest(token, ctx.ip, trials)),
  );
  ctx.owner.set(res.row, actor.userId);
  ctx.carried.set(
    res.row,
    trials
      .map((t) => (t && typeof t === "object" ? (t as Record<string, unknown>).trialId : undefined))
      .filter(isUuid),
  );
  return res;
}

const trialsOf = (ctx: Ctx, ids: string[], marker: string) =>
  ids.map((id) => trialPayload(ctx.prng, id, marker));

/** Seeded start offsets for a burst: roughly half the lanes fire together at
 * t=0, the rest start while earlier lanes are mid-flight (call-during-call). */
function offsets(ctx: Ctx, lanes: number): number[] {
  const spread = Math.max(1, 4 * STRESS_LATENCY_MS);
  const out = Array.from({ length: lanes }, () =>
    ctx.prng.next() < 0.5 ? 0 : ctx.prng.int(0, spread),
  );
  ctx.params.startOffsetsMs = out;
  return out;
}

// ── Contract checks shared by every kind ─────────────────────────────────────

function storedRows(ctx: Ctx) {
  return ctx.h.fake.trialRows() as Array<{
    id: string;
    user_id: string;
    payload: { marker?: string };
  }>;
}

function commonInvariants(ctx: Ctx): void {
  const rows = storedRows(ctx);
  const uploads = ctx.rows.filter((r) => r.op.startsWith("upload"));
  const fiveXx = ctx.rows.filter((r) => r.status >= 500);
  inv(ctx, "no 5xx", fiveXx.length === 0, `${fiveXx.length} responses ≥ 500`);

  const byId = new Map<string, typeof rows>();
  for (const row of rows) byId.set(row.id, [...(byId.get(row.id) ?? []), row]);
  const dupes = [...byId.entries()].filter(([, v]) => v.length > 1);
  inv(
    ctx,
    "no duplicate evaluation_trials rows",
    dupes.length === 0,
    `${dupes.length} trialIds with >1 row (${rows.length} rows)`,
  );
  const users = new Set(ctx.actors.map((a) => a.userId));
  const foreign = rows.filter((r) => !users.has(r.user_id));
  inv(ctx, "every row belongs to an actor of this case", foreign.length === 0, `${foreign.length}`);

  // accepted ⇒ stored under the caller; rejected conflict ⇒ stored under someone else;
  // rejected invalid ⇒ not stored; accepted ⊆ carried and unique
  let acceptedNotStored = 0;
  let acceptedForeign = 0;
  let conflictWrong = 0;
  let invalidStored = 0;
  let acceptedOutside = 0;
  let acceptedDup = 0;
  const acceptedByOwner = new Map<string, Set<string>>();
  for (const r of uploads) {
    const owner = ctx.owner.get(r) ?? "";
    const carried = new Set(ctx.carried.get(r) ?? []);
    if (r.status === 200) {
      const acc = r.accepted ?? [];
      if (new Set(acc).size !== acc.length) acceptedDup += 1;
      for (const id of acc) {
        if (!carried.has(id)) acceptedOutside += 1;
        const stored = byId.get(id) ?? [];
        if (stored.length === 0) acceptedNotStored += 1;
        else if (stored.some((s) => s.user_id !== owner)) acceptedForeign += 1;
        acceptedByOwner.set(owner, new Set([...(acceptedByOwner.get(owner) ?? []), id]));
      }
      for (const rej of r.rejected ?? []) {
        const stored = byId.get(rej.trialId) ?? [];
        if (rej.code === "evaluation.trial_id_conflict") {
          if (stored.length !== 1 || stored[0].user_id === owner) {
            conflictWrong += 1;
          }
        } else if (rej.code === "evaluation.trial_invalid") {
          if (stored.some((s) => s.user_id === owner)) invalidStored += 1;
        }
      }
    }
  }
  inv(
    ctx,
    "accepted ⇒ stored",
    acceptedNotStored === 0,
    `${acceptedNotStored} accepted ids without a row`,
  );
  inv(ctx, "accepted ⇒ stored under the caller", acceptedForeign === 0, `${acceptedForeign}`);
  inv(
    ctx,
    "accepted ids ⊆ request, no duplicates",
    acceptedOutside === 0 && acceptedDup === 0,
    `outside=${acceptedOutside} dup=${acceptedDup}`,
  );
  inv(
    ctx,
    "trial_id_conflict ⇒ exactly one row, owned by another account",
    conflictWrong === 0,
    `${conflictWrong} inconsistent conflict verdicts`,
  );
  inv(ctx, "trial_invalid ⇒ not stored for the caller", invalidStored === 0, `${invalidStored}`);

  // stored ⇒ accepted by its owner in some 200 (no ghost rows from 4xx paths)
  let ghosts = 0;
  for (const row of rows) {
    if (!acceptedByOwner.get(row.user_id)?.has(row.id)) ghosts += 1;
  }
  inv(
    ctx,
    "stored ⇒ accepted in a 200 of its owner (no ghost rows)",
    ghosts === 0,
    `${ghosts} ghost rows`,
  );

  // non-200 uploads never write: none of their carried ids is stored under the
  // caller unless the caller ALSO had it accepted elsewhere
  let leaked = 0;
  for (const r of uploads) {
    if (r.status === 200) continue;
    const owner = ctx.owner.get(r) ?? "";
    for (const id of ctx.carried.get(r) ?? []) {
      const stored = (byId.get(id) ?? []).some((s) => s.user_id === owner);
      if (stored && !acceptedByOwner.get(owner)?.has(id)) leaked += 1;
    }
  }
  inv(
    ctx,
    "a non-200 upload writes nothing",
    leaked === 0,
    `${leaked} ids written by 4xx/5xx uploads`,
  );
}

// ── Kinds ────────────────────────────────────────────────────────────────────

async function dupDelivery(ctx: Ctx): Promise<void> {
  const a = await newActor(ctx, "A");
  const k = ctx.prng.int(1, 8);
  const b = ctx.prng.int(2, TRIALS_ROUTE_LIMIT);
  const rebuilt = ctx.prng.next() < 0.5;
  const ids = uuids(ctx, k);
  Object.assign(ctx.params, {
    trials: k,
    burst: b,
    payload: rebuilt ? "rebuilt-per-lane" : "identical",
  });
  const shared = trialsOf(ctx, ids, "m0");
  const at = offsets(ctx, b);
  const results = await Promise.all(
    Array.from({ length: b }, (_, lane) =>
      upload(ctx, a, lane, "upload", rebuilt ? trialsOf(ctx, ids, `m${lane}`) : shared, {
        startAfterMs: at[lane],
      }),
    ),
  );
  inv(
    ctx,
    "every duplicate delivery → 200",
    results.every((r) => r.status === 200),
    JSON.stringify(histogram(results.map((r) => r.status))),
  );
  inv(
    ctx,
    "every delivery accepts every trialId (idempotent)",
    results.every(
      (r) =>
        r.status === 200 &&
        (r.row.accepted ?? []).length === k &&
        (r.row.rejected ?? []).length === 0,
    ),
    results.map((r) => `${(r.row.accepted ?? []).length}/${k}`).join(","),
  );
  const rows = storedRows(ctx);
  inv(
    ctx,
    "exactly one row per trialId",
    rows.length === k && new Set(rows.map((r) => r.id)).size === k,
    `${rows.length} rows / ${k} ids`,
  );
  const markers = new Set(rows.map((r) => String(r.payload.marker)));
  inv(
    ctx,
    rebuilt
      ? "stored payload is ONE of the delivered variants (first writer wins, never a merge)"
      : "stored payload is the delivered payload",
    rebuilt ? [...markers].every((m) => /^m\d+$/.test(m)) : markers.size === 1 && markers.has("m0"),
    [...markers].join(","),
  );
  inv(
    ctx,
    "one upsert + one ownership read per trial per delivery (no fan-out, no retry storm)",
    ctx.h.fake.counters["rest.post.evaluation_trials"] === b * k &&
      ctx.h.fake.counters["rest.get.evaluation_trials"] === b * k,
    `upserts=${ctx.h.fake.counters["rest.post.evaluation_trials"]} reads=${
      ctx.h.fake.counters["rest.get.evaluation_trials"]
    } expected ${b * k}`,
  );
  ctx.observations.duplicateUpsertsIgnored =
    ctx.h.fake.counters["evaluation_trials.conflict.same_owner"] ?? 0;
}

async function overlap(ctx: Ctx): Promise<void> {
  const a = await newActor(ctx, "A");
  const pool = uuids(ctx, ctx.prng.int(2, 10));
  const b = ctx.prng.int(2, 8);
  const batches = Array.from({ length: b }, () => {
    const n = ctx.prng.int(1, Math.min(pool.length, 6));
    return ctx.prng.shuffle(pool).slice(0, n);
  });
  const union = new Set(batches.flat());
  Object.assign(ctx.params, {
    pool: pool.length,
    burst: b,
    batchSizes: batches.map((x) => x.length),
    union: union.size,
  });
  const at = offsets(ctx, b);
  const results = await Promise.all(
    batches.map((ids, lane) =>
      upload(ctx, a, lane, "upload", trialsOf(ctx, ids, `m${lane}`), { startAfterMs: at[lane] }),
    ),
  );
  inv(
    ctx,
    "every overlapping batch → 200 accepting its whole batch",
    results.every(
      (r, i) => r.status === 200 && (r.row.accepted ?? []).length === batches[i].length,
    ),
    results.map((r, i) => `${(r.row.accepted ?? []).length}/${batches[i].length}`).join(","),
  );
  const rows = storedRows(ctx);
  inv(
    ctx,
    "rows == union of batches (no lost trial, no duplicate)",
    rows.length === union.size && [...union].every((id) => rows.some((r) => r.id === id)),
    `${rows.length} rows / union ${union.size}`,
  );
}

async function twoActors(ctx: Ctx): Promise<void> {
  const a = await newActor(ctx, "A");
  const b = await newActor(ctx, "B");
  const shared = uuids(ctx, ctx.prng.int(1, 4));
  const privA = uuids(ctx, ctx.prng.int(0, 3));
  const privB = uuids(ctx, ctx.prng.int(0, 3));
  const reqA = ctx.prng.int(1, 4);
  const reqB = ctx.prng.int(1, 4);
  Object.assign(ctx.params, {
    shared: shared.length,
    privateA: privA.length,
    privateB: privB.length,
    requestsA: reqA,
    requestsB: reqB,
  });
  const lanes = ctx.prng.shuffle([
    ...Array.from({ length: reqA }, (_, i) => ({
      actor: a,
      ids: ctx.prng.shuffle([...shared, ...privA]),
      lane: i,
    })),
    ...Array.from({ length: reqB }, (_, i) => ({
      actor: b,
      ids: ctx.prng.shuffle([...shared, ...privB]),
      lane: reqA + i,
    })),
  ]);
  const at = offsets(ctx, lanes.length);
  const results = await Promise.all(
    lanes.map((l, i) =>
      upload(ctx, l.actor, l.lane, `upload:${l.actor.tag}`, trialsOf(ctx, l.ids, l.actor.tag), {
        startAfterMs: at[i],
      }),
    ),
  );
  inv(
    ctx,
    "every request → 200",
    results.every((r) => r.status === 200),
    JSON.stringify(histogram(results.map((r) => r.status))),
  );
  const rows = storedRows(ctx);
  let ok = true;
  const detail: string[] = [];
  for (const id of shared) {
    const stored = rows.filter((r) => r.id === id);
    const owner = stored[0]?.user_id;
    const winner = owner === a.userId ? a : owner === b.userId ? b : null;
    const loser = winner === a ? b : a;
    const winnerAccepted = results
      .filter((r) => ctx.owner.get(r.row) === winner?.userId)
      .every((r) => (r.row.accepted ?? []).includes(id));
    const loserConflict = results
      .filter((r) => ctx.owner.get(r.row) === loser.userId)
      .every((r) =>
        (r.row.rejected ?? []).some(
          (x) => x.trialId === id && x.code === "evaluation.trial_id_conflict",
        ),
      );
    const payloadOk = stored.length === 1 && String(stored[0].payload.marker) === winner?.tag;
    const good =
      stored.length === 1 && winner !== null && winnerAccepted && loserConflict && payloadOk;
    ok &&= good;
    detail.push(
      `${id.slice(0, 8)}:rows=${stored.length},winner=${
        winner?.tag ?? "-"
      },winAcc=${winnerAccepted},loseConflict=${loserConflict},payload=${payloadOk}`,
    );
  }
  inv(
    ctx,
    "each shared trialId: one row, the owner accepted everywhere, the other actor gets trial_id_conflict everywhere, payload is the owner's",
    ok,
    detail.join(" | "),
  );
  inv(
    ctx,
    "private trialIds stored once under their owner",
    privA.every(
      (id) =>
        rows.filter((r) => r.id === id).length === 1 &&
        rows.find((r) => r.id === id)!.user_id === a.userId,
    ) &&
      privB.every(
        (id) =>
          rows.filter((r) => r.id === id).length === 1 &&
          rows.find((r) => r.id === id)!.user_id === b.userId,
      ),
    `${privA.length + privB.length} private ids`,
  );
  ctx.observations.crossOwnerConflicts =
    ctx.h.fake.counters["evaluation_trials.conflict.other_owner"] ?? 0;
}

async function consentRace(ctx: Ctx): Promise<void> {
  const a = await newActor(ctx, "A");
  const b = ctx.prng.int(2, 6);
  const withdrawAfterMs = ctx.prng.int(0, 3 * STRESS_LATENCY_MS + 1);
  const regrant = ctx.prng.next() < 0.4;
  const batches = Array.from({ length: b }, () => uuids(ctx, ctx.prng.int(1, 4)));
  Object.assign(ctx.params, {
    burst: b,
    batchSizes: batches.map((x) => x.length),
    withdrawAfterMs,
    regrant,
  });
  const at = offsets(ctx, b);
  const uploads = batches.map((ids, lane) =>
    upload(ctx, a, lane, "upload", trialsOf(ctx, ids, `m${lane}`), { startAfterMs: at[lane] }),
  );
  const side = (async () => {
    await sleep(withdrawAfterMs);
    const w = await timed(ctx.rows, -1, "consent.withdraw", () =>
      ctx.h.handler(consentRequest(a.accessToken, ctx.ip, "withdraw")),
    );
    ctx.observations.withdrawEndedAt = w.row.endedAt;
    let g: Awaited<ReturnType<typeof timed>> | undefined;
    if (regrant) {
      await sleep(ctx.prng.int(0, STRESS_LATENCY_MS));
      g = await timed(ctx.rows, -1, "consent.regrant", () =>
        ctx.h.handler(consentRequest(a.accessToken, ctx.ip, "grant")),
      );
      ctx.observations.regrantEndedAt = g.row.endedAt;
    }
    return { w, g };
  })();
  const [results, { w, g }] = await Promise.all([Promise.all(uploads), side]);
  inv(ctx, "withdraw → 200", w.status === 200, `status=${w.status}`);
  if (g) inv(ctx, "re-grant → 200", g.status === 200, `status=${g.status}`);
  inv(
    ctx,
    "uploads racing a withdraw are 200 or 403 consent_inactive",
    results.every(
      (r) => r.status === 200 || (r.status === 403 && r.row.code === "evaluation.consent_inactive"),
    ),
    JSON.stringify(
      histogram(results.map((r) => `${r.status}${r.row.code ? `:${r.row.code}` : ""}`)),
    ),
  );
  const rows = storedRows(ctx);
  inv(
    ctx,
    "403 consent_inactive ⇒ none of that batch stored; 200 ⇒ whole batch stored",
    results.every((r, i) =>
      r.status === 200
        ? batches[i].every((id) => rows.some((x) => x.id === id))
        : batches[i].every((id) => !rows.some((x) => x.id === id)),
    ),
    `${rows.length} rows`,
  );
  // An upload that STARTED after the withdraw completed must be refused —
  // unless consent was re-granted, in which case one that started after the
  // re-grant completed must be accepted (in between, either verdict is legal).
  if (g) {
    const late = results.filter((r) => r.row.startedAt > g.row.endedAt);
    inv(
      ctx,
      "an upload started after the re-grant completed → 200",
      late.every((r) => r.status === 200),
      `${late.length} late uploads: ${JSON.stringify(histogram(late.map((r) => r.status)))}`,
    );
  } else {
    const late = results.filter((r) => r.row.startedAt > w.row.endedAt);
    inv(
      ctx,
      "an upload started after the withdraw completed → 403 consent_inactive",
      late.every((r) => r.status === 403),
      `${late.length} late uploads: ${JSON.stringify(histogram(late.map((r) => r.status)))}`,
    );
  }
  // Recorded, not asserted (see the stress report): the route checks consent,
  // then upserts, without a transaction — a withdraw committed in between
  // still lets that request's trials land.
  ctx.observations.trialsStoredWhileLedgerInactive =
    ctx.h.fake.counters["evaluation_trials.stored_without_active_consent"] ?? 0;
  ctx.observations.accepted200 = results.filter((r) => r.status === 200).length;
  ctx.observations.refused403 = results.filter((r) => r.status === 403).length;
}

async function logoutRace(ctx: Ctx): Promise<void> {
  const a = await newActor(ctx, "A");
  const b = ctx.prng.int(2, 8);
  const logoutAfterMs = ctx.prng.int(0, 3 * STRESS_LATENCY_MS + 1);
  const probes = ctx.prng.int(1, 3);
  // Variant "slow_verify": the uploads bear a NOT-yet-cached token (rotated
  // after the consent grant primed the cache) whose first GoTrue verification
  // is delayed past the logout — the classic cache write-after-revoke race.
  const slowVerify = ctx.prng.next() < 0.5;
  const batches = Array.from({ length: b }, () => uuids(ctx, ctx.prng.int(1, 3)));
  Object.assign(ctx.params, { burst: b, logoutAfterMs, probes, slowVerify });
  if (slowVerify) {
    const r = await timed(ctx.rows, -1, "refresh", () =>
      ctx.h.handler(edgeRefresh(a.refreshToken, ctx.ip)),
    );
    const session = (r.body.session ?? {}) as Record<string, unknown>;
    inv(ctx, "refresh → 200 (fresh uncached bearer)", r.status === 200, `status=${r.status}`);
    a.accessToken = String(session.accessToken ?? a.accessToken);
    a.refreshToken = String(session.refreshToken ?? a.refreshToken);
    const slowMs = logoutAfterMs + 4 * STRESS_LATENCY_MS + ctx.prng.int(5, 40);
    let slowed = 0;
    const bearer = a.accessToken;
    ctx.h.fake.overrides.getUserDelayMs = (b) => (b === bearer && slowed++ === 0 ? slowMs : 0);
    ctx.params.slowVerifyMs = slowMs;
  }
  const at = offsets(ctx, b);
  const uploads = batches.map((ids, lane) =>
    upload(ctx, a, lane, "upload", trialsOf(ctx, ids, `m${lane}`), { startAfterMs: at[lane] }),
  );
  const side = (async () => {
    await sleep(logoutAfterMs);
    const out = await timed(ctx.rows, -1, "logout", () =>
      ctx.h.handler(edgeLogout(a.accessToken, ctx.ip)),
    );
    const after = await Promise.all(
      Array.from({ length: probes }, (_, i) =>
        upload(ctx, a, 100 + i, "upload:after_logout", trialsOf(ctx, uuids(ctx, 1), "late")),
      ),
    );
    return { out, after };
  })();
  const [results, { out, after }] = await Promise.all([Promise.all(uploads), side]);
  ctx.h.fake.overrides.getUserDelayMs = undefined;
  inv(ctx, "logout → 204", out.status === 204, `status=${out.status}`);
  inv(
    ctx,
    "an upload that STARTED after the logout completed → 401",
    results.every((r) => r.row.startedAt < out.row.endedAt || r.status === 401),
    `${results.filter((r) => r.row.startedAt >= out.row.endedAt).length} started after logout`,
  );
  ctx.observations.getUserCalls = ctx.h.fake.counters["gotrue.get_user"] ?? 0;
  inv(
    ctx,
    "uploads racing a logout are 200 or 401",
    results.every((r) => r.status === 200 || r.status === 401),
    JSON.stringify(histogram(results.map((r) => r.status))),
  );
  inv(
    ctx,
    "every upload with the revoked bearer after logout → 401 (no cache write-after-revoke)",
    after.every((r) => r.status === 401),
    JSON.stringify(histogram(after.map((r) => r.status))),
  );
  const rows = storedRows(ctx);
  inv(
    ctx,
    "200 ⇒ whole batch stored; 401 ⇒ nothing stored",
    results.every((r, i) =>
      r.status === 200
        ? batches[i].every((id) => rows.some((x) => x.id === id))
        : batches[i].every((id) => !rows.some((x) => x.id === id)),
    ),
    `${rows.length} rows`,
  );
  ctx.observations.accepted200 = results.filter((r) => r.status === 200).length;
  ctx.observations.refused401 = results.filter((r) => r.status === 401).length;
}

function edgeLogout(token: string, ip: string): Request {
  return new Request("http://edge.xc.test/functions/v1/api/v1/auth/logout", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "x-forwarded-for": ip },
  });
}

function edgeRefresh(refreshToken: string, ip: string): Request {
  return new Request("http://edge.xc.test/functions/v1/api/v1/auth/refresh", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify({ refreshToken }),
  });
}

async function rotationRace(ctx: Ctx): Promise<void> {
  const a = await newActor(ctx, "A");
  const b = ctx.prng.int(2, 5);
  const refreshAfterMs = ctx.prng.int(0, 3 * STRESS_LATENCY_MS + 1);
  const withNew = ctx.prng.int(1, 3);
  const withOld = ctx.prng.int(1, 3);
  const batches = Array.from({ length: b + withNew + withOld }, () =>
    uuids(ctx, ctx.prng.int(1, 3)),
  );
  Object.assign(ctx.params, {
    burst: b,
    refreshAfterMs,
    afterWithNewBearer: withNew,
    afterWithOldBearer: withOld,
  });
  const at = offsets(ctx, b);
  const uploads = batches
    .slice(0, b)
    .map((ids, lane) =>
      upload(ctx, a, lane, "upload", trialsOf(ctx, ids, `m${lane}`), { startAfterMs: at[lane] }),
    );
  const side = (async () => {
    await sleep(refreshAfterMs);
    const r = await timed(ctx.rows, -1, "refresh", () =>
      ctx.h.handler(edgeRefresh(a.refreshToken, ctx.ip)),
    );
    const session = (r.body.session ?? {}) as Record<string, unknown>;
    const fresh = String(session.accessToken ?? "");
    const late = await Promise.all([
      ...batches
        .slice(b, b + withNew)
        .map((ids, i) =>
          upload(ctx, a, 100 + i, "upload:new_bearer", trialsOf(ctx, ids, "new"), { token: fresh }),
        ),
      ...batches
        .slice(b + withNew)
        .map((ids, i) =>
          upload(ctx, a, 200 + i, "upload:old_bearer_after_rotation", trialsOf(ctx, ids, "old")),
        ),
    ]);
    return { r, fresh, late };
  })();
  const [results, { r, fresh, late }] = await Promise.all([Promise.all(uploads), side]);
  inv(
    ctx,
    "refresh → 200 with a NEW access token",
    r.status === 200 && fresh !== "" && fresh !== a.accessToken,
    `status=${r.status}`,
  );
  inv(
    ctx,
    "uploads in flight during rotation → 200",
    results.every((x) => x.status === 200),
    JSON.stringify(histogram(results.map((x) => x.status))),
  );
  inv(
    ctx,
    "after rotation: new bearer → 200 AND old bearer (still before exp) → 200",
    late.every((x) => x.status === 200),
    JSON.stringify(histogram(late.map((x) => `${x.row.op}:${x.status}`))),
  );
  const rows = storedRows(ctx);
  const all = batches.flat();
  inv(
    ctx,
    "rotation loses no trial (rows == every id, once)",
    rows.length === all.length && all.every((id) => rows.filter((x) => x.id === id).length === 1),
    `${rows.length} rows / ${all.length} ids`,
  );
}

async function rateLimit(ctx: Ctx): Promise<{ inconclusive: boolean }> {
  const a = await newActor(ctx, "A");
  const b = ctx.prng.int(TRIALS_ROUTE_LIMIT + 1, TRIALS_ROUTE_LIMIT + 6);
  const ids = uuids(ctx, b);
  Object.assign(ctx.params, { burst: b, limit: TRIALS_ROUTE_LIMIT });
  const bucketStart = Math.floor(Date.now() / 60_000);
  const results = await Promise.all(
    ids.map((id, lane) => upload(ctx, a, lane, "upload", trialsOf(ctx, [id], `m${lane}`))),
  );
  const probe = await upload(
    ctx,
    a,
    999,
    "upload:after_budget",
    trialsOf(ctx, uuids(ctx, 1), "probe"),
  );
  const bucketEnd = Math.floor(Date.now() / 60_000);
  if (bucketStart !== bucketEnd) {
    ctx.observations.inconclusive = "rate-limit window rolled over during the burst";
    return { inconclusive: true };
  }
  const ok = results.filter((r) => r.status === 200).length;
  const limited = results.filter((r) => r.status === 429);
  inv(
    ctx,
    `exactly ${TRIALS_ROUTE_LIMIT} × 200 and ${b - TRIALS_ROUTE_LIMIT} × 429 (atomic counter)`,
    ok === TRIALS_ROUTE_LIMIT && limited.length === b - TRIALS_ROUTE_LIMIT,
    JSON.stringify(histogram(results.map((r) => r.status))),
  );
  inv(
    ctx,
    "429 carries Retry-After and code rate_limited",
    limited.every(
      (r) => r.row.code === "rate_limited" && Number(r.headers.get("Retry-After")) >= 1,
    ),
    `${limited.length} limited`,
  );
  inv(
    ctx,
    "a further upload in the same window → 429",
    probe.status === 429,
    `status=${probe.status}`,
  );
  const rows = storedRows(ctx);
  inv(
    ctx,
    `rows == ${TRIALS_ROUTE_LIMIT} (only the admitted requests wrote)`,
    rows.length === TRIALS_ROUTE_LIMIT,
    `${rows.length}`,
  );
  return { inconclusive: false };
}

async function cancelDuringCall(ctx: Ctx): Promise<void> {
  const a = await newActor(ctx, "A");
  const aborted = ctx.prng.int(1, 4);
  const normal = ctx.prng.int(1, 4);
  const abortedBatches = Array.from({ length: aborted }, () => uuids(ctx, ctx.prng.int(1, 3)));
  const normalBatches = Array.from({ length: normal }, () => uuids(ctx, ctx.prng.int(1, 3)));
  const cuts = abortedBatches.map(() => ctx.prng.int(5, 95) / 100);
  Object.assign(ctx.params, {
    abortedUploads: aborted,
    normalUploads: normal,
    cutFractions: cuts,
  });
  const abortedTrials = abortedBatches.map((ids, i) => trialsOf(ctx, ids, `aborted${i}`));
  const at = offsets(ctx, aborted + normal);
  const results = await Promise.all([
    ...abortedTrials.map((trials, i) =>
      upload(ctx, a, i, "upload:aborted", trials, {
        request: abortedTrialsRequest(a.accessToken, ctx.ip, trials, cuts[i]),
        startAfterMs: at[i],
      }),
    ),
    ...normalBatches.map((ids, i) =>
      upload(ctx, a, 100 + i, "upload", trialsOf(ctx, ids, `n${i}`), {
        startAfterMs: at[aborted + i],
      }),
    ),
  ]);
  const ab = results.slice(0, aborted);
  const nm = results.slice(aborted);
  inv(
    ctx,
    "an upload whose body stream aborts → 400 validation.evaluation_trials (never 5xx, never partial)",
    ab.every((r) => r.status === 400 && r.row.code === "validation.evaluation_trials"),
    JSON.stringify(histogram(ab.map((r) => `${r.status}:${r.row.code}`))),
  );
  inv(
    ctx,
    "concurrent intact uploads are unaffected → 200",
    nm.every((r) => r.status === 200),
    JSON.stringify(histogram(nm.map((r) => r.status))),
  );
  let rows = storedRows(ctx);
  inv(
    ctx,
    "nothing of an aborted upload is stored",
    abortedBatches.flat().every((id) => !rows.some((r) => r.id === id)),
    `${rows.length} rows before retry`,
  );
  // the client's retry (the mobile outbox keeps the row) lands exactly once
  const retries = await Promise.all(
    abortedTrials.map((trials, i) => upload(ctx, a, 300 + i, "upload:retry", trials)),
  );
  rows = storedRows(ctx);
  inv(
    ctx,
    "retry after abort → 200, every id stored once",
    retries.every((r) => r.status === 200) &&
      abortedBatches.flat().every((id) => rows.filter((r) => r.id === id).length === 1),
    `${rows.length} rows after retry`,
  );
}

async function clockSkew(ctx: Ctx): Promise<void> {
  const a = await newActor(ctx, "A");
  const skewed = ctx.prng.int(1, 4);
  const valid = ctx.prng.int(1, 4);
  const skews = Array.from(
    { length: skewed },
    () => [0, 1, 30, 300, 3600, 86_400][ctx.prng.int(0, 5)],
  );
  Object.assign(ctx.params, { skewedBearers: skews, validUploads: valid });
  const skewedBatches = skews.map(() => uuids(ctx, ctx.prng.int(1, 2)));
  const validBatches = Array.from({ length: valid }, () => uuids(ctx, ctx.prng.int(1, 2)));
  const at = offsets(ctx, skewed);
  const results = await Promise.all([
    ...skewedBatches.map((ids, i) =>
      upload(ctx, a, i, "upload:skewed_bearer", trialsOf(ctx, ids, "skew"), {
        token: skewedBearer(a.userId, skews[i], ctx.prng),
        startAfterMs: at[i],
      }),
    ),
    ...validBatches.map((ids, i) =>
      upload(
        ctx,
        a,
        100 + i,
        "upload",
        ids.map((id) =>
          trialPayload(ctx.prng, id, "valid", {
            capturedAtIso: new Date(
              Date.now() + (ctx.prng.next() < 0.5 ? 1 : -1) * ctx.prng.int(1, 86_400_000),
            ).toISOString(),
          }),
        ),
      ),
    ),
  ]);
  const sk = results.slice(0, skewed);
  const va = results.slice(skewed);
  inv(
    ctx,
    "a bearer expired by clock skew → 401 before any write (skew 0 s included)",
    sk.every((r) => r.status === 401),
    JSON.stringify(histogram(sk.map((r) => `${r.status}:${r.row.code}`))),
  );
  inv(
    ctx,
    "valid uploads with skewed CLIENT timestamps in the payload → 200 (stored verbatim)",
    va.every((r) => r.status === 200),
    JSON.stringify(histogram(va.map((r) => r.status))),
  );
  const rows = storedRows(ctx);
  inv(
    ctx,
    "skewed bearers wrote nothing; valid batches all stored",
    skewedBatches.flat().every((id) => !rows.some((r) => r.id === id)) &&
      validBatches.flat().every((id) => rows.some((r) => r.id === id)),
    `${rows.length} rows`,
  );
  inv(
    ctx,
    "no upstream auth call for an expired bearer",
    (ctx.h.fake.counters["gotrue.get_user"] ?? 0) <= 1,
    `gotrue.get_user=${
      ctx.h.fake.counters["gotrue.get_user"] ?? 0
    } (≤1: the consent grant's verify, then cached)`,
  );
}

async function mixedValidation(ctx: Ctx): Promise<void> {
  const a = await newActor(ctx, "A");
  const validIds = uuids(ctx, ctx.prng.int(1, 4));
  const invalidCount = ctx.prng.int(1, 3);
  const oversizedIds = uuids(ctx, ctx.prng.int(0, 2));
  const b = ctx.prng.int(2, 5);
  Object.assign(ctx.params, {
    valid: validIds.length,
    invalid: invalidCount,
    oversized: oversizedIds.length,
    burst: b,
  });
  const invalids = Array.from(
    { length: invalidCount },
    () =>
      [
        { trialId: "not-a-uuid", marker: "bad" },
        { trialId: 42, marker: "bad" },
        { trialId: null, marker: "bad" },
        { marker: "bad" },
        "just-a-string",
        null,
      ][ctx.prng.int(0, 5)],
  );
  const oversized = oversizedIds.map((id) => oversizedTrial(ctx.prng, id));
  const batch = ctx.prng.shuffle<unknown>([
    ...trialsOf(ctx, validIds, "ok"),
    ...invalids,
    ...oversized,
  ]);
  const results = await Promise.all([
    ...Array.from({ length: b }, (_, lane) => upload(ctx, a, lane, "upload", batch)),
    upload(ctx, a, 900, "upload:empty", []),
    upload(ctx, a, 901, "upload:too_many", trialsOf(ctx, uuids(ctx, 201), "many")),
  ]);
  const dup = results.slice(0, b);
  const empty = results[b];
  const many = results[b + 1];
  inv(
    ctx,
    "mixed batch → 200 on every duplicate delivery",
    dup.every((r) => r.status === 200),
    JSON.stringify(histogram(dup.map((r) => r.status))),
  );
  inv(
    ctx,
    "accepted == the valid ids, rejected == invalid + oversized (trial_invalid), identical across deliveries",
    dup.every(
      (r) =>
        sameSet(r.row.accepted ?? [], validIds) &&
        (r.row.rejected ?? []).length === invalidCount + oversizedIds.length &&
        (r.row.rejected ?? []).every((x) => x.code === "evaluation.trial_invalid"),
    ),
    dup
      .map((r) => `acc=${(r.row.accepted ?? []).length} rej=${(r.row.rejected ?? []).length}`)
      .join(","),
  );
  inv(
    ctx,
    "trials=[] and trials[201] → 400 validation.evaluation_trials",
    empty.status === 400 &&
      empty.row.code === "validation.evaluation_trials" &&
      many.status === 400 &&
      many.row.code === "validation.evaluation_trials",
    `empty=${empty.status} many=${many.status}`,
  );
  const rows = storedRows(ctx);
  inv(
    ctx,
    "rows == valid ids exactly (oversized / >200-batch ids never stored)",
    rows.length === validIds.length && validIds.every((id) => rows.some((r) => r.id === id)),
    `${rows.length} rows / ${validIds.length} valid`,
  );
}

function sameSet(a: string[], b: string[]): boolean {
  const sa = new Set(a);
  return sa.size === a.length && sa.size === b.length && b.every((x) => sa.has(x));
}

// ── Case runner ──────────────────────────────────────────────────────────────

function ipFor(index: number): string {
  return `10.${128 + ((index >> 16) & 127)}.${(index >> 8) & 255}.${index & 255}`;
}

async function runCase(h: TrialsHarness, index: number, seed: number): Promise<CaseOutcome> {
  for (let attempt = 0; ; attempt++) {
    runCounter += 1;
    const prng = new Prng(seed);
    const drawn = KINDS[prng.int(0, KINDS.length - 1)];
    const kind: Kind = forcedKind ?? (STRESS_KIND ? (STRESS_KIND as Kind) : drawn);
    h.fake.reset(seed, STRESS_LATENCY_MS);
    h.upstreamCalls.length = 0;
    const ctx: Ctx = {
      h,
      prng,
      seed,
      ip: ipFor(index * 4 + attempt),
      rows: [],
      owner: new Map(),
      carried: new Map(),
      invariants: [],
      params: {},
      observations: {},
      actors: [],
    };
    const t0 = performance.now();
    let inconclusive = false;
    const { timedOut } = await withDeadline(STRESS_DEADLINE_MS, async () => {
      switch (kind) {
        case "dup_delivery":
          return await dupDelivery(ctx);
        case "overlap":
          return await overlap(ctx);
        case "two_actors":
          return await twoActors(ctx);
        case "consent_race":
          return await consentRace(ctx);
        case "logout_race":
          return await logoutRace(ctx);
        case "rotation_race":
          return await rotationRace(ctx);
        case "rate_limit":
          inconclusive = (await rateLimit(ctx)).inconclusive;
          return;
        case "cancel_during_call":
          return await cancelDuringCall(ctx);
        case "clock_skew":
          return await clockSkew(ctx);
        case "mixed_validation":
          return await mixedValidation(ctx);
      }
    });
    const durationMs = Math.round(performance.now() - t0);
    if (inconclusive && attempt < 2) continue;
    inv(
      ctx,
      `bounded wall time (< ${STRESS_DEADLINE_MS} ms, no deadlock)`,
      !timedOut,
      `${durationMs} ms`,
    );
    if (!timedOut) commonInvariants(ctx);
    const outcome: CaseOutcome = {
      index,
      seed,
      kind,
      params: ctx.params,
      requests: ctx.rows.length,
      statusHistogram: histogram(
        ctx.rows.map((r) => `${r.op}:${r.status}${r.code ? `:${r.code}` : ""}`),
      ),
      counters: { ...h.fake.counters },
      invariants: ctx.invariants,
      holds: ctx.invariants.every((i) => i.holds),
      timedOut,
      durationMs,
      observations: ctx.observations,
      replay: replayCommand(seed, FILE, "stress trials: campaign"),
    };
    if (!outcome.holds || Deno.env.get("STRESS_VERBOSE")) {
      await writeJson(outDir("cases"), `${seed}.json`, {
        ...outcome,
        requests: ctx.rows,
        timeline: h.fake.timeline,
        upstreamCalls: h.upstreamCalls,
      });
    }
    return outcome;
  }
}

Deno.test(
  "stress trials: campaign — seeded concurrency cases against the real handler",
  async () => {
    const h = await loadTrialsHarness();
    const seeds = STRESS_REPLAY
      ? [Number(STRESS_REPLAY) >>> 0]
      : Array.from({ length: STRESS_ITER }, (_, i) => caseSeed(STRESS_SEED, i));
    const outcomes: CaseOutcome[] = [];
    const before = Deno.memoryUsage();
    const t0 = performance.now();
    for (let i = 0; i < seeds.length; i++) {
      const outcome = await runCase(h, i, seeds[i]);
      outcomes.push(outcome);
      if (!outcome.holds) {
        console.log(`[stress] seed=${outcome.seed} kind=${outcome.kind} BROKEN:`);
        for (const inv of outcome.invariants.filter((x) => !x.holds)) {
          console.log(`[stress]   ${inv.name} — ${inv.detail}`);
        }
      }
    }
    const after = Deno.memoryUsage();
    const table = outcomes.map((o) => ({
      seed: o.seed,
      kind: o.kind,
      outcome: o.holds ? "HELD" : o.timedOut ? "TIMEOUT" : "BROKEN",
      requests: o.requests,
      durationMs: o.durationMs,
      broken: o.invariants.filter((i) => !i.holds).map((i) => `${i.name}: ${i.detail}`),
      observations: o.observations,
      params: o.params,
      replay: o.replay,
    }));
    const summary = {
      file: FILE,
      baseSeed: STRESS_SEED,
      cases: outcomes.length,
      held: outcomes.filter((o) => o.holds).length,
      broken: outcomes.filter((o) => !o.holds).length,
      requests: outcomes.reduce((n, o) => n + o.requests, 0),
      invariantsChecked: outcomes.reduce((n, o) => n + o.invariants.length, 0),
      byKind: histogram(outcomes.map((o) => o.kind)),
      trialsStoredWhileLedgerInactive: outcomes.reduce(
        (n, o) => n + Number(o.observations.trialsStoredWhileLedgerInactive ?? 0),
        0,
      ),
      latencyMaxMs: STRESS_LATENCY_MS,
      deadlineMs: STRESS_DEADLINE_MS,
      durationMs: Math.round(performance.now() - t0),
      heap: { before, after },
      brokenSeeds: outcomes.filter((o) => !o.holds).map((o) => o.seed),
    };
    const dir = outDir("campaign");
    const tablePath = await writeJson(dir, "campaign.json", { summary, table });
    console.log(
      `[stress] ${summary.cases} cases, ${summary.held} HELD, ${summary.broken} BROKEN, ${summary.requests} requests, ${summary.invariantsChecked} invariants, ${summary.durationMs} ms → ${tablePath}`,
    );
    console.log(`[stress] by kind: ${JSON.stringify(summary.byKind)}`);
    assertEquals(
      summary.brokenSeeds,
      [],
      `broken seeds: ${summary.brokenSeeds.join(", ")} (details under ${outDir("cases")})`,
    );
    assert(summary.cases > 0);
  },
);

Deno.test("stress trials: every scenario kind runs at least once from a fixed seed", async () => {
  // Guards the campaign against a kind silently never being drawn.
  const h = await loadTrialsHarness();
  const base = STRESS_SEED ^ 0x5eed;
  const outcomes: CaseOutcome[] = [];
  for (let i = 0; i < KINDS.length; i++) {
    outcomes.push(await runCaseForced(h, 10_000 + i, caseSeed(base, i), KINDS[i]));
  }
  const broken = outcomes.filter((o) => !o.holds);
  for (const o of broken) {
    console.log(
      `[stress] kind=${o.kind} seed=${o.seed} BROKEN: ${o.invariants
        .filter((i) => !i.holds)
        .map((i) => `${i.name} — ${i.detail}`)
        .join(" | ")}`,
    );
  }
  assertEquals(
    broken.map((o) => `${o.kind}@${o.seed}`),
    [],
  );
});

let forcedKind: Kind | null = null;

async function runCaseForced(
  h: TrialsHarness,
  index: number,
  seed: number,
  kind: Kind,
): Promise<CaseOutcome> {
  forcedKind = kind;
  try {
    return await runCase(h, index, seed);
  } finally {
    forcedKind = null;
  }
}
