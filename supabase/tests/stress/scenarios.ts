/**
 * Scenario catalogue for the apply_synced_shot concurrency stress campaign.
 *
 * A scenario builds, from the iteration's PRNG, the users, fixtures and lane
 * specs of one interleaving, then checks scenario-specific expectations on
 * top of the generic invariants in `genericChecks`. Every randomised knob
 * (lane count, arrival delay, hold, commit/rollback, cancel, isolation) is
 * drawn from the same PRNG so the whole iteration replays from its seed.
 */
import {
  applyAsUser,
  asUser,
  createUser,
  crossOwnerDetailRows,
  inv,
  type Invariant,
  type LaneResult,
  type LaneSpec,
  makePayload,
  ownerPermit,
  type Payload,
  PERMANENT_CODES,
  type Prng,
  reserveAsUser,
  setPermitAge,
  snapshotUser,
  type Sql,
  type User,
  type UserSnapshot,
  visibleShots,
} from "./harness.ts";

export interface Knobs {
  lanesMax: number;
  holdMaxMs: number;
  preDelayMaxMs: number;
  /** probability that a lane's client aborts (ROLLBACK) after the server answered */
  rollbackP: number;
  /** probability that a lane gets cancelled (pg_cancel_backend) mid-call */
  cancelP: number;
  /** probability that a lane runs SERIALIZABLE (PostgREST uses READ COMMITTED) */
  serializableP: number;
}

export interface Built {
  params: Record<string, unknown>;
  users: User[];
  lanes: LaneSpec[];
  /** ids whose committed-accepted lanes must replay as accepted afterwards */
  check: (ctx: CheckCtx) => Promise<void> | void;
  /** extra SQLSTATEs this scenario legitimately provokes (beyond cancel/serializable) */
  allowedSqlstates?: Set<string>;
  /** scenario deliberately writes scored rows outside the RPC (finalized == scored not required) */
  directWrites?: boolean;
  /** scenario deletes a user mid-burst */
  deletesUser?: boolean;
}

export interface CheckCtx {
  sql: Sql;
  results: LaneResult[];
  snaps: Map<string, UserSnapshot>;
  invariants: Invariant[];
  observations: Record<string, unknown>;
}

export type Scenario = (sql: Sql, prng: Prng, k: Knobs) => Promise<Built>;

function newUser(prng: Prng, premium: boolean): User {
  const id = prng.uuid();
  return { id, provider: "google", sub: `stress-${id}`, premium };
}

function laneDefaults(
  prng: Prng,
  k: Knobs,
  lane: number,
): Pick<LaneSpec, "lane" | "preDelayMs" | "holdMs" | "finish" | "isolation" | "cancelAtMs"> {
  const d: Pick<
    LaneSpec,
    "lane" | "preDelayMs" | "holdMs" | "finish" | "isolation" | "cancelAtMs"
  > = {
    lane,
    preDelayMs: prng.chance(0.6) ? prng.int(0, k.preDelayMaxMs) : 0,
    holdMs: prng.chance(0.4) ? prng.int(1, k.holdMaxMs) : 0,
    finish: prng.chance(k.rollbackP) ? "rollback" : "commit",
    isolation: prng.chance(k.serializableP) ? "serializable" : "read committed",
  };
  if (prng.chance(k.cancelP)) {
    d.cancelAtMs = prng.int(0, k.holdMaxMs + k.preDelayMaxMs);
  }
  return d;
}

function applyLane(
  prng: Prng,
  k: Knobs,
  lane: number,
  user: string,
  payload: Payload,
  over: Partial<LaneSpec> = {},
): LaneSpec {
  return {
    ...laneDefaults(prng, k, lane),
    user,
    role: "authenticated",
    op: "apply",
    payload,
    ...over,
  };
}

function committedAccepted(results: LaneResult[], filter: (r: LaneResult) => boolean = () => true) {
  return results.filter((r) => r.committed && r.result === "accepted" && filter(r));
}

function committed(results: LaneResult[]) {
  return results.filter((r) => r.committed);
}

/** A SERIALIZABLE lane whose 40001 the RPC's exception handler turned into the
 * transient `shot.write_failed` code the client retries. The hosted RPC path
 * runs READ COMMITTED, so this only appears in explicitly serializable lanes. */
function serializationRetry(r: LaneResult): boolean {
  return r.isolation === "serializable" && r.result === "shot.write_failed:40001";
}

// ────────────────────────────────────────────────────────────────────────────
// A. Duplicate calls: same shot, same permit (the sync retry / double-tap)
// ────────────────────────────────────────────────────────────────────────────
export const dupSameShotSamePermit: Scenario = async (sql, prng, k) => {
  const u = newUser(prng, prng.chance(0.3));
  const users = [u];
  await createUser(sql, u);
  const permit = await reserveAsUser(sql, u.id, `k-${prng.uuid()}`);
  const shotId = prng.uuid();
  const payload = makePayload(prng, shotId, permit);
  const n = prng.int(2, k.lanesMax);
  const lanes = Array.from({ length: n }, (_, i) => applyLane(prng, k, i, u.id, payload));
  return {
    params: {
      user: u.id,
      premium: u.premium,
      permit,
      shotId,
      lanes: n,
      phases: payload.phases.length,
      checkpoints: payload.checkpoints.length,
    },
    users,
    lanes,
    check: async ({ results, snaps, invariants, observations }) => {
      const s = snaps.get(u.id)!;
      const acc = committedAccepted(results);
      const com = committed(results);
      inv(
        invariants,
        "A: every committed lane is accepted (no permanent code for a dup of an accepted sync)",
        com.every((r) => r.result === "accepted" || serializationRetry(r)),
        com.map((r) => r.result),
      );
      inv(
        invariants,
        "A: exactly one shot row iff any lane committed",
        s.shots.length === (acc.length > 0 ? 1 : 0),
        { shots: s.shots.length, committedAccepted: acc.length },
      );
      if (s.shots.length === 1) {
        const row = s.shots[0];
        inv(
          invariants,
          "A: phase/checkpoint rows equal the payload (no partial, no duplicate detail rows)",
          row.phases === payload.phases.length &&
            row.checkpoints === payload.checkpoints.length &&
            row.measurements === 0,
          row,
        );
        inv(
          invariants,
          "A: permit finalized exactly once with outcome scored",
          s.permits.length === 1 &&
            s.permits[0].status === "finalized" &&
            s.permits[0].outcome === "scored",
          s.permits,
        );
        inv(
          invariants,
          "A: one rating spent — scored=1, ledger=1, lifetime=1",
          s.scored === 1 && s.ledger === 1 && s.lifetime === 1,
          { scored: s.scored, ledger: s.ledger, lifetime: s.lifetime },
        );
      } else {
        inv(
          invariants,
          "A: nothing committed → permit still reserved, nothing spent",
          s.permits.length === 1 &&
            s.permits[0].status === "reserved" &&
            s.ledger === null &&
            s.scored === 0,
          s.permits,
        );
      }
      const replay = await applyAsUser(sql, u.id, payload);
      inv(
        invariants,
        "A: post-burst replay is accepted (idempotent)",
        replay === "accepted",
        replay,
      );
      const replayOtherPermit = await applyAsUser(sql, u.id, {
        ...payload,
        analysisPermitId: prng.uuid(),
      });
      inv(
        invariants,
        "A: replay with an unknown permit id is still accepted (ownership decides before permit checks)",
        replayOtherPermit === "accepted",
        replayOtherPermit,
      );
      const after = await snapshotUser(sql, u);
      inv(
        invariants,
        "A: replays wrote nothing new",
        after.shots.length === 1 && after.scored === 1 && after.ledger === 1,
        { shots: after.shots.length },
      );
      observations.finalPermits = after.permits;
    },
  };
};

// ────────────────────────────────────────────────────────────────────────────
// B. Same shot id, distinct permits (client re-reserved and retried)
// ────────────────────────────────────────────────────────────────────────────
export const sameShotDistinctPermits: Scenario = async (sql, prng, k) => {
  const premium = prng.chance(0.5);
  const u = newUser(prng, premium);
  await createUser(sql, u);
  const n = premium ? prng.int(2, Math.min(6, k.lanesMax)) : 2;
  const permits: string[] = [];
  for (let i = 0; i < n; i++) {
    permits.push(await reserveAsUser(sql, u.id, `k-${prng.uuid()}`));
  }
  const shotId = prng.uuid();
  const base = makePayload(prng, shotId, permits[0]);
  const lanes = permits.map((p, i) =>
    applyLane(prng, k, i, u.id, { ...base, analysisPermitId: p }),
  );
  return {
    params: { user: u.id, premium, permits, shotId, lanes: n },
    users: [u],
    lanes,
    check: ({ results, snaps, invariants, observations }) => {
      const s = snaps.get(u.id)!;
      const com = committed(results);
      const acc = committedAccepted(results);
      inv(
        invariants,
        "B: every committed lane accepted (or a SERIALIZABLE serialization retry)",
        com.every((r) => r.result === "accepted" || serializationRetry(r)),
        com.map((r) => r.result),
      );
      inv(
        invariants,
        "B: one row iff any lane committed",
        s.shots.length === (acc.length > 0 ? 1 : 0),
        s.shots.length,
      );
      const finalized = s.permits.filter((p) => p.status === "finalized");
      inv(
        invariants,
        "B: exactly one permit finalized when the row exists; the rest stay reserved (never double-spent)",
        finalized.length === (acc.length > 0 ? 1 : 0) &&
          s.permits.filter((p) => p.status === "reserved").length === n - finalized.length,
        s.permits,
      );
      inv(
        invariants,
        "B: scored == ledger == lifetime == rows",
        s.scored === s.shots.length && (s.ledger ?? 0) === s.scored && s.lifetime === s.scored,
        { scored: s.scored, ledger: s.ledger, lifetime: s.lifetime },
      );
      observations.permitsAfter = s.permits;
    },
  };
};

// ────────────────────────────────────────────────────────────────────────────
// C. Distinct shots racing for ONE permit (permit reuse attempt)
// ────────────────────────────────────────────────────────────────────────────
export const distinctShotsSamePermit: Scenario = async (sql, prng, k) => {
  const u = newUser(prng, prng.chance(0.3));
  await createUser(sql, u);
  const permit = await reserveAsUser(sql, u.id, `k-${prng.uuid()}`);
  const n = prng.int(2, k.lanesMax);
  const lanes = Array.from({ length: n }, (_, i) =>
    applyLane(prng, k, i, u.id, makePayload(prng, prng.uuid(), permit)),
  );
  return {
    params: {
      user: u.id,
      permit,
      lanes: n,
      shotIds: lanes.map((l) => l.payload!.id),
    },
    users: [u],
    lanes,
    check: async ({ results, snaps, invariants }) => {
      const s = snaps.get(u.id)!;
      const acc = committedAccepted(results);
      const com = committed(results);
      inv(
        invariants,
        "C: at most one committed lane accepted — the permit is consumed once",
        acc.length <= 1,
        acc.map((r) => r.shotId),
      );
      inv(
        invariants,
        "C: rows == committed accepted",
        s.shots.length === acc.length,
        s.shots.map((x) => x.id),
      );
      inv(
        invariants,
        "C: committed losers see permit_not_reserved (permit already finalized), never write_failed",
        com
          .filter((r) => r.result !== "accepted")
          .every((r) => r.result === "access.permit_not_reserved"),
        com.map((r) => r.result),
      );
      inv(
        invariants,
        "C: permit finalized iff a row exists",
        (s.permits[0].status === "finalized") === (s.shots.length === 1),
        s.permits,
      );
      inv(
        invariants,
        "C: scored == ledger == lifetime ≤ 1",
        s.scored <= 1 && (s.ledger ?? 0) === s.scored && s.lifetime === s.scored,
        { scored: s.scored, ledger: s.ledger },
      );
      // A loser replayed later must still be refused (its shot never landed).
      const loser = com.find((r) => r.result === "access.permit_not_reserved");
      if (loser) {
        const spec = lanes.find((l) => l.lane === loser.lane)!;
        const replay = await applyAsUser(sql, u.id, spec.payload!);
        inv(
          invariants,
          "C: loser replay stays permit_not_reserved (no late double spend)",
          replay === "access.permit_not_reserved",
          replay,
        );
      }
    },
  };
};

// ────────────────────────────────────────────────────────────────────────────
// D. Over-issued permits vs the lifetime free limit (backstop under the lock)
// ────────────────────────────────────────────────────────────────────────────
export const overIssuedFreeLimit: Scenario = async (sql, prng, k) => {
  const u = newUser(prng, false);
  await createUser(sql, u);
  const preScored = prng.int(0, 1);
  for (let i = 0; i < preScored; i++) {
    const p = await reserveAsUser(sql, u.id, `pre-${prng.uuid()}`);
    const r = await applyAsUser(sql, u.id, makePayload(prng, prng.uuid(), p));
    if (r !== "accepted") {
      throw new Error(`D pre-seed expected accepted, got ${r}`);
    }
  }
  const n = prng.int(3, k.lanesMax);
  const permits: string[] = [];
  for (let i = 0; i < n; i++) {
    permits.push(await ownerPermit(sql, u.id, `legacy-${i}-${prng.uuid()}`));
  }
  const lanes = permits.map((p, i) =>
    applyLane(prng, k, i, u.id, makePayload(prng, prng.uuid(), p)),
  );
  return {
    params: { user: u.id, preScored, overIssued: n },
    users: [u],
    lanes,
    check: ({ results, snaps, invariants }) => {
      const s = snaps.get(u.id)!;
      const acc = committedAccepted(results);
      const com = committed(results);
      inv(
        invariants,
        "D: lifetime scored never exceeds 2",
        s.scored <= 2 && (s.lifetime ?? 0) <= 2 && (s.ledger ?? 0) <= 2,
        { scored: s.scored, lifetime: s.lifetime, ledger: s.ledger },
      );
      inv(
        invariants,
        "D: scored == preScored + committed accepted",
        s.scored === preScored + acc.length,
        { scored: s.scored, preScored, acc: acc.length },
      );
      inv(
        invariants,
        "D: committed non-accepted lanes are paywall_required (or a SERIALIZABLE retry)",
        com
          .filter((r) => r.result !== "accepted")
          .every((r) => r.result === "access.paywall_required" || serializationRetry(r)),
        com.map((r) => r.result),
      );
      const released = s.permits.filter(
        (p) => p.status === "released" && p.outcome === "free_limit_exceeded",
      ).length;
      inv(
        invariants,
        "D: every committed paywall lane released its permit as free_limit_exceeded",
        released === com.filter((r) => r.result === "access.paywall_required").length,
        s.permits,
      );
      inv(
        invariants,
        "D: finalized permits == scored rows",
        s.permits.filter((p) => p.status === "finalized").length === s.scored,
        s.permits,
      );
      inv(
        invariants,
        "D: ledger == lifetime == scored",
        s.ledger === (s.scored === 0 ? null : s.scored) && s.lifetime === s.scored,
        { ledger: s.ledger, lifetime: s.lifetime },
      );
    },
  };
};

// ────────────────────────────────────────────────────────────────────────────
// E. reserve_analysis_permit racing apply on the LAST free slot
// ────────────────────────────────────────────────────────────────────────────
export const reserveVsApplyLastSlot: Scenario = async (sql, prng, k) => {
  const u = newUser(prng, false);
  await createUser(sql, u);
  const p0 = await reserveAsUser(sql, u.id, `pre-${prng.uuid()}`);
  const r0 = await applyAsUser(sql, u.id, makePayload(prng, prng.uuid(), p0));
  if (r0 !== "accepted") {
    throw new Error(`E pre-seed expected accepted, got ${r0}`);
  }
  const p1 = await reserveAsUser(sql, u.id, `last-${prng.uuid()}`);
  const shotId = prng.uuid();
  const payload = makePayload(prng, shotId, p1);
  const nApply = prng.int(1, 3);
  const nReserve = prng.int(2, Math.max(2, k.lanesMax - nApply));
  const lanes: LaneSpec[] = [];
  for (let i = 0; i < nApply; i++) {
    lanes.push(applyLane(prng, k, lanes.length, u.id, payload));
  }
  for (let i = 0; i < nReserve; i++) {
    lanes.push({
      ...laneDefaults(prng, k, lanes.length),
      user: u.id,
      role: "authenticated",
      op: "reserve",
      key: `race-${i}-${prng.uuid()}`,
    });
  }
  prng.shuffle(lanes).forEach((l, i) => (l.lane = i));
  return {
    params: { user: u.id, nApply, nReserve, permit: p1, shotId },
    users: [u],
    lanes,
    check: ({ results, snaps, invariants, observations }) => {
      const s = snaps.get(u.id)!;
      const live = s.permits.filter((p) => p.status === "reserved").length;
      inv(
        invariants,
        "E: scored + live reserved never exceeds 2 (no over-reservation while the last slot is being spent)",
        s.scored + live <= 2,
        { scored: s.scored, live, permits: s.permits },
      );
      inv(
        invariants,
        "E: scored ≤ 2 and ledger == scored",
        s.scored <= 2 && s.ledger === s.scored,
        { scored: s.scored, ledger: s.ledger },
      );
      const reserveOk = results.filter(
        (r) => r.op === "reserve" && r.committed && r.result === "accepted",
      );
      inv(
        invariants,
        "E: no reserve lane was granted a permit (the slot was already held)",
        reserveOk.length === 0,
        results.filter((r) => r.op === "reserve").map((r) => r.result),
      );
      observations.access = s.access;
    },
  };
};

// ────────────────────────────────────────────────────────────────────────────
// F. Two actors, same shot id (cross-user id collision)
// ────────────────────────────────────────────────────────────────────────────
export const crossUserSameShotId: Scenario = async (sql, prng, k) => {
  const a = newUser(prng, prng.chance(0.3));
  const b = newUser(prng, prng.chance(0.3));
  await createUser(sql, a);
  await createUser(sql, b);
  const pa = await reserveAsUser(sql, a.id, `ka-${prng.uuid()}`);
  const pb = await reserveAsUser(sql, b.id, `kb-${prng.uuid()}`);
  const shotId = prng.uuid();
  const payA = makePayload(prng, shotId, pa);
  const payB = makePayload(prng, shotId, pb);
  const n = prng.int(2, k.lanesMax);
  const lanes: LaneSpec[] = [];
  for (let i = 0; i < n; i++) {
    const isA = i === 0 ? true : i === 1 ? false : prng.chance(0.5);
    lanes.push(applyLane(prng, k, i, isA ? a.id : b.id, isA ? payA : payB));
  }
  return {
    params: { a: a.id, b: b.id, shotId, lanes: n },
    users: [a, b],
    lanes,
    check: async ({ results, snaps, invariants, observations }) => {
      const sa = snaps.get(a.id)!;
      const sb = snaps.get(b.id)!;
      const owners = [...sa.shots, ...sb.shots].map((s) => s.userId);
      inv(
        invariants,
        "F: the id lands at most once, for exactly one user",
        owners.length <= 1,
        owners,
      );
      const winner = owners[0];
      const com = committed(results);
      const transientSer = serializationRetry;
      inv(
        invariants,
        "F: committed winner-user lanes accepted; committed other-user lanes id_conflict (SERIALIZABLE lanes may surface the conflict as transient write_failed:40001)",
        com.every(
          (r) =>
            transientSer(r) ||
            (winner === undefined
              ? PERMANENT_CODES.has(r.result) || r.result === "accepted"
              : r.user === winner
                ? r.result === "accepted"
                : r.result === "shot.id_conflict"),
        ),
        com.map((r) => `${r.user === a.id ? "A" : "B"}:${r.result}`),
      );
      const loser = winner === a.id ? sb : winner === b.id ? sa : undefined;
      if (loser) {
        inv(
          invariants,
          "F: loser's permit is untouched (still reserved) and nothing was spent",
          loser.permits[0].status === "reserved" && loser.scored === 0 && loser.ledger === null,
          loser.permits,
        );
      }
      inv(
        invariants,
        "F: RLS — user B sees none of A's rows and vice versa",
        (await visibleShots(
          sql,
          b.id,
          sa.shots.map((s) => s.id),
        )) === 0 &&
          (await visibleShots(
            sql,
            a.id,
            sb.shots.map((s) => s.id),
          )) === 0,
        "visible=0",
      );
      // Loser replays are permanently id_conflict; winner replays accepted.
      if (winner) {
        const loserUser = winner === a.id ? b : a;
        const rep = await applyAsUser(sql, loserUser.id, winner === a.id ? payB : payA);
        inv(
          invariants,
          "F: loser replay is shot.id_conflict (permanent, correct)",
          rep === "shot.id_conflict",
          rep,
        );
        const repW = await applyAsUser(sql, winner, winner === a.id ? payA : payB);
        inv(invariants, "F: winner replay accepted", repW === "accepted", repW);
      }
      observations.winner = winner ?? null;
    },
  };
};

// ────────────────────────────────────────────────────────────────────────────
// G. Two users, independent bursts of distinct shots (throughput / no cross-talk)
// ────────────────────────────────────────────────────────────────────────────
export const twoUsersIndependent: Scenario = async (sql, prng, k) => {
  const a = newUser(prng, true);
  const b = newUser(prng, true);
  await createUser(sql, a);
  await createUser(sql, b);
  const per = prng.int(2, Math.max(2, Math.floor(k.lanesMax / 2)));
  const lanes: LaneSpec[] = [];
  for (const u of [a, b]) {
    for (let i = 0; i < per; i++) {
      const p = await reserveAsUser(sql, u.id, `k-${prng.uuid()}`);
      lanes.push(applyLane(prng, k, lanes.length, u.id, makePayload(prng, prng.uuid(), p)));
    }
  }
  prng.shuffle(lanes).forEach((l, i) => (l.lane = i));
  return {
    params: { a: a.id, b: b.id, perUser: per },
    users: [a, b],
    lanes,
    check: async ({ results, snaps, invariants }) => {
      for (const u of [a, b]) {
        const s = snaps.get(u.id)!;
        const acc = committedAccepted(results, (r) => r.user === u.id);
        const com = committed(results).filter((r) => r.user === u.id);
        inv(
          invariants,
          `G: ${u === a ? "A" : "B"} every committed lane accepted (or a SERIALIZABLE retry)`,
          com.every((r) => r.result === "accepted" || serializationRetry(r)),
          com.map((r) => r.result),
        );
        inv(
          invariants,
          `G: ${u === a ? "A" : "B"} rows == committed accepted, finalized == rows`,
          s.shots.length === acc.length &&
            s.permits.filter((p) => p.status === "finalized").length === acc.length,
          { rows: s.shots.length, acc: acc.length },
        );
        inv(
          invariants,
          `G: ${
            u === a ? "A" : "B"
          } premium: ledger untouched-by-limit == scored, rank scored_shot_count == scored`,
          s.ledger === (s.scored === 0 ? null : s.scored) && (s.rankScoredCount ?? 0) === s.scored,
          { ledger: s.ledger, rank: s.rankScoredCount, scored: s.scored },
        );
      }
      const sa = snaps.get(a.id)!;
      const sb = snaps.get(b.id)!;
      inv(
        invariants,
        "G: RLS — no cross visibility",
        (await visibleShots(
          sql,
          b.id,
          sa.shots.map((s) => s.id),
        )) === 0 &&
          (await visibleShots(
            sql,
            a.id,
            sb.shots.map((s) => s.id),
          )) === 0,
        "visible=0",
      );
    },
  };
};

// ────────────────────────────────────────────────────────────────────────────
// H. Abstention vs scored racing for the same permit
// ────────────────────────────────────────────────────────────────────────────
export const abstentionVsScored: Scenario = async (sql, prng, k) => {
  const u = newUser(prng, prng.chance(0.3));
  await createUser(sql, u);
  const permit = await reserveAsUser(sql, u.id, `k-${prng.uuid()}`);
  const scored = makePayload(prng, prng.uuid(), permit, {
    resultKind: "scored",
  });
  const abst = makePayload(prng, prng.uuid(), permit, {
    resultKind: "low_confidence",
  });
  const n = prng.int(2, k.lanesMax);
  const lanes = Array.from({ length: n }, (_, i) =>
    applyLane(prng, k, i, u.id, i % 2 === 0 ? scored : abst),
  );
  return {
    params: {
      user: u.id,
      permit,
      scoredId: scored.id,
      abstentionId: abst.id,
      lanes: n,
    },
    users: [u],
    lanes,
    check: ({ results, snaps, invariants, observations }) => {
      const s = snaps.get(u.id)!;
      const acc = committedAccepted(results);
      const accShots = new Set(acc.map((r) => r.shotId));
      inv(
        invariants,
        "H: one permit → at most one accepted shot (dup lanes of the same payload replay as accepted)",
        accShots.size <= 1 && s.shots.length === accShots.size,
        { acceptedShots: [...accShots], rows: s.shots.length },
      );
      if (s.shots.length === 1) {
        const row = s.shots[0];
        const p = s.permits[0];
        inv(
          invariants,
          "H: permit outcome matches the row kind (finalized/scored or released/low_confidence)",
          (row.resultKind === "scored" && p.status === "finalized" && p.outcome === "scored") ||
            (row.resultKind === "low_confidence" &&
              p.status === "released" &&
              p.outcome === "low_confidence"),
          { row: row.resultKind, permit: p },
        );
        inv(
          invariants,
          "H: abstention has null score, spends nothing; scored spends one",
          row.resultKind === "scored"
            ? row.overallScore !== null && s.ledger === 1 && s.lifetime === 1
            : row.overallScore === null && s.ledger === null && s.lifetime === 0,
          { row, ledger: s.ledger, lifetime: s.lifetime },
        );
      }
      observations.rowKind = s.shots[0]?.resultKind ?? null;
    },
  };
};

// ────────────────────────────────────────────────────────────────────────────
// I. Call-during-call + cancel-during-call behind an explicit lock holder
// ────────────────────────────────────────────────────────────────────────────
export const cancelWhileBlocked: Scenario = async (sql, prng, k) => {
  const u = newUser(prng, prng.chance(0.3));
  await createUser(sql, u);
  const permit = await reserveAsUser(sql, u.id, `k-${prng.uuid()}`);
  const payload = makePayload(prng, prng.uuid(), permit);
  const n = prng.int(3, k.lanesMax);
  const blockerHold = prng.int(20, 80);
  const lanes: LaneSpec[] = [
    {
      lane: 0,
      user: u.id,
      role: "authenticated",
      op: "blocker",
      preDelayMs: 0,
      holdMs: blockerHold,
      finish: prng.chance(0.5) ? "commit" : "rollback",
      isolation: "read committed",
    },
  ];
  const nCancel = prng.int(1, Math.max(1, n - 2));
  for (let i = 1; i < n; i++) {
    const l = applyLane(prng, k, i, u.id, payload, {
      preDelayMs: prng.int(2, 8),
      holdMs: 0,
      finish: "commit",
      cancelAtMs: undefined,
    });
    if (i <= nCancel) l.cancelAtMs = prng.int(10, blockerHold - 5);
    lanes.push(l);
  }
  return {
    params: {
      user: u.id,
      permit,
      shotId: payload.id,
      lanes: n,
      blockerHoldMs: blockerHold,
      cancelled: nCancel,
    },
    users: [u],
    lanes,
    check: async ({ results, snaps, invariants, observations }) => {
      const s = snaps.get(u.id)!;
      const cancelled = results.filter((r) => r.cancelled);
      const survivors = results.filter((r) => r.op === "apply" && r.committed);
      inv(
        invariants,
        "I: cancelled lanes rolled back (err:57014, not committed)",
        cancelled.every((r) => !r.committed),
        cancelled.map((r) => r.result),
      );
      inv(
        invariants,
        "I: every surviving lane accepted",
        survivors.every((r) => r.result === "accepted"),
        survivors.map((r) => r.result),
      );
      inv(
        invariants,
        "I: one row iff a survivor exists; permit finalized iff row exists",
        s.shots.length === (survivors.length > 0 ? 1 : 0) &&
          (s.permits[0].status === "finalized") === (s.shots.length === 1),
        {
          rows: s.shots.length,
          survivors: survivors.length,
          permit: s.permits[0],
        },
      );
      inv(
        invariants,
        "I: no partial write — detail rows match payload",
        s.shots.every(
          (r) => r.phases === payload.phases.length && r.checkpoints === payload.checkpoints.length,
        ),
        s.shots,
      );
      const replay = await applyAsUser(sql, u.id, payload);
      inv(invariants, "I: replay after cancel/blocking is accepted", replay === "accepted", replay);
      observations.cancelledLanes = cancelled.length;
      observations.blockerFinish = lanes[0].finish;
    },
  };
};

// ────────────────────────────────────────────────────────────────────────────
// J. Account deleted mid-request (logout/deletion racing an in-flight sync)
// ────────────────────────────────────────────────────────────────────────────
export const accountDeletedMidRequest: Scenario = async (sql, prng, k) => {
  const u = newUser(prng, prng.chance(0.5));
  await createUser(sql, u);
  const n = u.premium ? prng.int(2, Math.min(4, k.lanesMax - 1)) : 2;
  const lanes: LaneSpec[] = [];
  for (let i = 0; i < n; i++) {
    const p = await reserveAsUser(sql, u.id, `k-${prng.uuid()}`);
    lanes.push(
      applyLane(prng, k, i, u.id, makePayload(prng, prng.uuid(), p), {
        finish: "commit",
        cancelAtMs: undefined,
        isolation: "read committed",
      }),
    );
  }
  lanes.push({
    lane: n,
    user: u.id,
    role: "owner",
    op: "delete_user",
    preDelayMs: prng.int(0, 12),
    holdMs: prng.int(0, 10),
    finish: "commit",
    isolation: "read committed",
  });
  return {
    params: { user: u.id, premium: u.premium, lanes: n + 1 },
    users: [u],
    lanes,
    deletesUser: true,
    allowedSqlstates: new Set(["23503"]),
    check: async ({ results, snaps, invariants, observations }) => {
      const s = snaps.get(u.id)!;
      inv(
        invariants,
        "J: user gone → no shots, permits, rank rows remain (cascade complete, no orphans)",
        !s.exists && s.shots.length === 0 && s.permits.length === 0 && s.rankScoredCount === null,
        { exists: s.exists, shots: s.shots.length, permits: s.permits.length },
      );
      const orphanDetails = await sql.unsafe(
        `select (select count(*) from public.shot_phases where user_id = '${u.id}') + (select count(*) from public.shot_checkpoints where user_id = '${u.id}') + (select count(*) from public.shot_measurements where user_id = '${u.id}') as n`,
      );
      inv(
        invariants,
        "J: no orphan detail rows for the deleted user",
        Number(orphanDetails[0].n) === 0,
        orphanDetails[0].n,
      );
      const applyRes = results.filter((r) => r.op === "apply");
      inv(
        invariants,
        "J: apply lanes are accepted (then cascaded), transient (shot.write_failed:23503) or permit_not_found once the account is gone — never id_conflict/paywall",
        applyRes.every(
          (r) =>
            r.result === "accepted" ||
            r.result === "shot.write_failed:23503" ||
            r.result.startsWith("err:23503") ||
            r.result === "access.permit_not_found",
        ),
        applyRes.map((r) => r.result),
      );
      inv(
        invariants,
        "J: identity ledger survives deletion and counts only committed scored rows (≤ lanes, ≤ 2 for free)",
        (s.ledger ?? 0) <= applyRes.filter((r) => r.result === "accepted" && r.committed).length &&
          (u.premium || (s.ledger ?? 0) <= 2),
        {
          ledger: s.ledger,
          accepted: applyRes.filter((r) => r.result === "accepted").length,
        },
      );
      observations.ledgerAfterDeletion = s.ledger;
      observations.applyResults = applyRes.map((r) => r.result);
    },
  };
};

// ────────────────────────────────────────────────────────────────────────────
// K. Clock skew: permit age at the 24h boundary racing apply and the sweep
// ────────────────────────────────────────────────────────────────────────────
export const clockSkewPermitAge: Scenario = async (sql, prng, k) => {
  const u = newUser(prng, prng.chance(0.3));
  await createUser(sql, u);
  const permit = await reserveAsUser(sql, u.id, `k-${prng.uuid()}`);
  const H24 = 24 * 3600 * 1000;
  const variant = prng.pick(["expired", "boundary", "future_capture", "past_capture"] as const);
  const deltaMs =
    variant === "expired"
      ? prng.int(1, 5000)
      : variant === "boundary"
        ? -prng.int(20, 400)
        : -prng.int(3600_000, 7200_000);
  await setPermitAge(sql, permit, H24 + deltaMs);
  const capturedAt =
    variant === "future_capture"
      ? "2100-01-01T00:00:00.000Z"
      : variant === "past_capture"
        ? "1999-12-31T23:59:59.000Z"
        : undefined;
  const payload = makePayload(prng, prng.uuid(), permit, { capturedAt });
  const n = prng.int(2, k.lanesMax - 1);
  const lanes: LaneSpec[] = Array.from({ length: n }, (_, i) =>
    applyLane(prng, k, i, u.id, payload, { cancelAtMs: undefined }),
  );
  if (prng.chance(0.6)) {
    lanes.push({
      lane: n,
      user: u.id,
      role: "owner",
      op: "sweep_permits",
      preDelayMs: prng.int(0, 8),
      holdMs: prng.int(0, 10),
      finish: "commit",
      isolation: "read committed",
    });
  }
  return {
    params: {
      user: u.id,
      permit,
      variant,
      permitAgeMinus24hMs: deltaMs,
      capturedAt: capturedAt ?? "valid",
      lanes: lanes.length,
      sweepLane: lanes.length > n,
    },
    users: [u],
    lanes,
    allowedSqlstates: new Set(["23514"]),
    check: ({ results, snaps, invariants, observations }) => {
      const s = snaps.get(u.id)!;
      const p = s.permits[0];
      const com = committed(results).filter((r) => r.op === "apply");
      const swept = results.some(
        (r) => r.op === "sweep_permits" && r.committed && r.result !== "swept:0",
      );
      // Once one committed lane (or the sweep) released the permit as expired,
      // later lanes see status<>'reserved' and report permit_not_reserved.
      const releasedByLane = com.some((r) => r.result === "access.permit_expired");
      const okAfterRelease = (r: LaneResult) =>
        (swept || releasedByLane) && r.result === "access.permit_not_reserved";
      inv(
        invariants,
        "K: row exists ⇔ permit finalized; never a row with an expired/released permit",
        (s.shots.length === 1) === (p.status === "finalized"),
        { rows: s.shots.length, permit: p },
      );
      if (variant === "expired") {
        inv(
          invariants,
          "K: expired permit → committed applies are permit_expired (permit_not_reserved once released), no row, permit released/expired",
          com.every((r) => r.result === "access.permit_expired" || okAfterRelease(r)) &&
            s.shots.length === 0 &&
            p.status === "released" &&
            p.outcome === "expired",
          { results: com.map((r) => r.result), permit: p, swept },
        );
      } else if (variant === "boundary") {
        inv(
          invariants,
          "K: near-boundary permit → committed lanes are accepted / permit_expired (permit_not_reserved once released) only, consistent with the final permit state",
          com.every(
            (r) =>
              r.result === "accepted" || r.result === "access.permit_expired" || okAfterRelease(r),
          ) && (s.shots.length === 1 ? com.some((r) => r.result === "accepted") : true),
          { results: com.map((r) => r.result), permit: p, swept },
        );
      } else {
        inv(
          invariants,
          "K: out-of-range captured_at → shot.write_failed:23514, no row, permit untouched (still reserved) for a clean retry",
          com.every((r) => r.result === "shot.write_failed:23514") &&
            s.shots.length === 0 &&
            p.status === "reserved",
          { results: com.map((r) => r.result), permit: p },
        );
      }
      inv(
        invariants,
        "K: nothing spent unless a row exists",
        (s.ledger ?? 0) === s.scored && s.lifetime === s.scored,
        { ledger: s.ledger, scored: s.scored },
      );
      observations.variant = variant;
    },
  };
};

// ────────────────────────────────────────────────────────────────────────────
// L. Permit status tampering (authenticated may UPDATE status/outcome)
// ────────────────────────────────────────────────────────────────────────────
export const permitStatusTamper: Scenario = async (sql, prng, k) => {
  const u = newUser(prng, false);
  await createUser(sql, u);
  const spent: string[] = [];
  for (let i = 0; i < 2; i++) {
    const p = await reserveAsUser(sql, u.id, `pre-${prng.uuid()}`);
    const r = await applyAsUser(sql, u.id, makePayload(prng, prng.uuid(), p));
    if (r !== "accepted") {
      throw new Error(`L pre-seed expected accepted, got ${r}`);
    }
    spent.push(p);
  }
  const n = prng.int(2, k.lanesMax);
  const lanes: LaneSpec[] = Array.from({ length: n }, (_, i) => {
    const permit = spent[i % 2];
    return {
      ...laneDefaults(prng, k, i),
      user: u.id,
      role: "authenticated",
      op: "tamper_then_apply",
      permitId: permit,
      payload: makePayload(prng, prng.uuid(), permit),
    };
  });
  return {
    params: { user: u.id, spentPermits: spent, lanes: n },
    users: [u],
    lanes,
    directWrites: true,
    check: ({ results, snaps, invariants, observations }) => {
      const s = snaps.get(u.id)!;
      inv(
        invariants,
        "L: scored stays exactly 2 — flipping a finalized permit back to reserved buys no third rating",
        s.scored === 2 && s.lifetime === 2 && s.ledger === 2,
        { scored: s.scored, lifetime: s.lifetime, ledger: s.ledger },
      );
      const com = committed(results);
      inv(
        invariants,
        "L: every committed tamper+apply ends in paywall_required",
        com.every((r) => r.result.endsWith("/access.paywall_required")),
        com.map((r) => r.result),
      );
      inv(
        invariants,
        "L: no permit is left reserved after a committed tamper (released as free_limit_exceeded)",
        com.length === 0 || s.permits.every((p) => p.status !== "reserved"),
        s.permits,
      );
      observations.permits = s.permits;
    },
  };
};

// ────────────────────────────────────────────────────────────────────────────
// M. Session created / deleted while the shot that references it syncs
// ────────────────────────────────────────────────────────────────────────────
export const sessionRace: Scenario = async (sql, prng, k) => {
  const u = newUser(prng, prng.chance(0.3));
  await createUser(sql, u);
  const permit = await reserveAsUser(sql, u.id, `k-${prng.uuid()}`);
  const sessionId = prng.uuid();
  const variant = prng.pick(["insert", "delete"] as const);
  if (variant === "delete") {
    await sql.unsafe(
      `insert into public.sessions (id, user_id, started_at) values ('${sessionId}', '${u.id}', now())`,
    );
  }
  const payload = makePayload(prng, prng.uuid(), permit, { sessionId });
  const n = prng.int(2, k.lanesMax - 1);
  const lanes: LaneSpec[] = Array.from({ length: n }, (_, i) =>
    applyLane(prng, k, i, u.id, payload, { cancelAtMs: undefined }),
  );
  lanes.push({
    ...laneDefaults(prng, k, n),
    cancelAtMs: undefined,
    user: u.id,
    role: "authenticated",
    op: variant === "insert" ? "session_insert" : "session_delete",
    sessionId,
  });
  return {
    params: { user: u.id, permit, sessionId, variant, lanes: n + 1 },
    users: [u],
    lanes,
    allowedSqlstates: new Set(["23503"]),
    check: async ({ results, snaps, invariants, observations }) => {
      const s = snaps.get(u.id)!;
      const com = committed(results).filter((r) => r.op === "apply");
      inv(
        invariants,
        "M: committed apply results ∈ {accepted, shot.session_not_found, shot.write_failed:23503} (all replayable, no permanent code)",
        com.every(
          (r) =>
            ["accepted", "shot.session_not_found", "shot.write_failed:23503"].includes(r.result) ||
            serializationRetry(r),
        ),
        com.map((r) => r.result),
      );
      inv(
        invariants,
        "M: row exists ⇔ permit finalized; row's session_id is the session or null (FK on delete set null)",
        (s.shots.length === 1) === (s.permits[0].status === "finalized") &&
          s.shots.every((r) => r.sessionId === sessionId || r.sessionId === null),
        { rows: s.shots, permit: s.permits[0] },
      );
      if (s.shots.length === 0) {
        const replay = await applyAsUser(sql, u.id, payload);
        const sess = await sql.unsafe(`select 1 from public.sessions where id = '${sessionId}'`);
        inv(
          invariants,
          "M: replay after a transient outcome is accepted when the session exists, session_not_found otherwise",
          sess.length > 0 ? replay === "accepted" : replay === "shot.session_not_found",
          { replay, sessionExists: sess.length > 0 },
        );
      }
      observations.variant = variant;
    },
  };
};

// ────────────────────────────────────────────────────────────────────────────
// N. Direct INSERT through the trigger gate racing the RPC (one permit)
// ────────────────────────────────────────────────────────────────────────────
export const directInsertVsRpc: Scenario = async (sql, prng, k) => {
  const u = newUser(prng, false);
  await createUser(sql, u);
  const preScored = prng.int(0, 1);
  for (let i = 0; i < preScored; i++) {
    const p = await reserveAsUser(sql, u.id, `pre-${prng.uuid()}`);
    const r = await applyAsUser(sql, u.id, makePayload(prng, prng.uuid(), p));
    if (r !== "accepted") {
      throw new Error(`N pre-seed expected accepted, got ${r}`);
    }
  }
  const permit = await reserveAsUser(sql, u.id, `k-${prng.uuid()}`);
  const n = prng.int(3, k.lanesMax);
  const lanes: LaneSpec[] = [];
  const nRpc = prng.int(1, 2);
  for (let i = 0; i < nRpc; i++) {
    lanes.push(applyLane(prng, k, lanes.length, u.id, makePayload(prng, prng.uuid(), permit)));
  }
  while (lanes.length < n) {
    lanes.push({
      ...laneDefaults(prng, k, lanes.length),
      user: u.id,
      role: "authenticated",
      op: "direct_insert",
      shotId: prng.uuid(),
    });
  }
  prng.shuffle(lanes).forEach((l, i) => (l.lane = i));
  return {
    params: { user: u.id, preScored, permit, nRpc, nDirect: n - nRpc },
    users: [u],
    lanes,
    directWrites: true,
    allowedSqlstates: new Set(["42501"]),
    check: ({ results, snaps, invariants, observations }) => {
      const s = snaps.get(u.id)!;
      inv(
        invariants,
        "N: lifetime scored never exceeds 2 across RPC + direct writers",
        s.scored <= 2 && (s.lifetime ?? 0) <= 2 && (s.ledger ?? 0) <= 2,
        { scored: s.scored, lifetime: s.lifetime, ledger: s.ledger },
      );
      inv(
        invariants,
        "N: ledger == lifetime == scored (derived state not lost)",
        s.ledger === (s.scored === 0 ? null : s.scored) &&
          s.lifetime === s.scored &&
          (s.rankScoredCount ?? 0) === s.scored,
        {
          ledger: s.ledger,
          lifetime: s.lifetime,
          rank: s.rankScoredCount,
          scored: s.scored,
        },
      );
      const directOk = results.filter(
        (r) => r.op === "direct_insert" && r.committed && r.result === "inserted",
      );
      const rpcOk = committedAccepted(results, (r) => r.op === "apply");
      inv(
        invariants,
        "N: rows == preScored + committed RPC accepted + committed direct inserts",
        s.shots.length === preScored + directOk.length + rpcOk.length,
        {
          rows: s.shots.length,
          preScored,
          rpcOk: rpcOk.length,
          directOk: directOk.length,
        },
      );
      inv(
        invariants,
        "N: rejected direct inserts fail with 42501 only",
        results
          .filter((r) => r.op === "direct_insert" && r.result !== "inserted")
          .every((r) => r.sqlstate === "42501" || r.cancelled || r.sqlstate === "40001"),
        results.filter((r) => r.op === "direct_insert").map((r) => r.result),
      );
      inv(
        invariants,
        "N: the permit is finalized at most once",
        s.permits.filter((p) => p.status === "finalized").length <= 1 + preScored,
        s.permits,
      );
      observations.directInserted = directOk.length;
    },
  };
};

// ────────────────────────────────────────────────────────────────────────────
// O. Detail rows written directly: duplicates and cross-user attach attempts
// ────────────────────────────────────────────────────────────────────────────
export const detailRowsDirect: Scenario = async (sql, prng, k) => {
  const a = newUser(prng, true);
  const b = newUser(prng, true);
  await createUser(sql, a);
  await createUser(sql, b);
  const pa = await reserveAsUser(sql, a.id, `ka-${prng.uuid()}`);
  const payA = makePayload(prng, prng.uuid(), pa);
  payA.phases = [];
  const r = await applyAsUser(sql, a.id, payA);
  if (r !== "accepted") {
    throw new Error(`O pre-seed expected accepted, got ${r}`);
  }
  const n = prng.int(3, k.lanesMax);
  const lanes: LaneSpec[] = [];
  const dupKey = "contact";
  for (let i = 0; i < n; i++) {
    const kind =
      i < 2
        ? "own_dup"
        : prng.pick(["own_dup", "own_measure_dup", "cross_phase", "cross_measure"] as const);
    if (kind === "own_dup") {
      lanes.push({
        ...laneDefaults(prng, k, i),
        user: a.id,
        role: "authenticated",
        op: "detail_insert",
        shotId: payA.id,
        detailKey: dupKey,
      });
    } else if (kind === "own_measure_dup") {
      lanes.push({
        ...laneDefaults(prng, k, i),
        user: a.id,
        role: "authenticated",
        op: "measurement_insert",
        shotId: payA.id,
        detailKey: "paddle_speed",
      });
    } else if (kind === "cross_phase") {
      lanes.push({
        ...laneDefaults(prng, k, i),
        user: b.id,
        role: "authenticated",
        op: "detail_insert",
        shotId: payA.id,
        detailKey: `b-${i}`,
      });
    } else {
      lanes.push({
        ...laneDefaults(prng, k, i),
        user: b.id,
        role: "authenticated",
        op: "measurement_insert",
        shotId: payA.id,
        detailKey: `b-${i}`,
      });
    }
  }
  return {
    params: { a: a.id, b: b.id, shotId: payA.id, lanes: n },
    users: [a, b],
    lanes,
    directWrites: true,
    allowedSqlstates: new Set(["23505", "42501", "23503"]),
    check: async ({ results, snaps, invariants, observations }) => {
      const sa = snaps.get(a.id)!;
      const row = sa.shots[0];
      const ownDup = results.filter(
        (r) =>
          r.user === a.id && r.op === "detail_insert" && r.committed && r.result === "inserted",
      );
      const ownMeasure = results.filter(
        (r) =>
          r.user === a.id &&
          r.op === "measurement_insert" &&
          r.committed &&
          r.result === "inserted",
      );
      inv(
        invariants,
        "O: the same (shot, phase_key) lands once — every other own duplicate fails 23505",
        ownDup.length <= 1 &&
          results
            .filter((r) => r.user === a.id && r.op === "detail_insert" && r.result !== "inserted")
            .every((r) => r.sqlstate === "23505" || r.cancelled || r.sqlstate === "40001"),
        results.filter((r) => r.op === "detail_insert" && r.user === a.id).map((r) => r.result),
      );
      inv(
        invariants,
        "O: the same (shot, metric_key) lands once",
        ownMeasure.length <= 1,
        results
          .filter((r) => r.op === "measurement_insert" && r.user === a.id)
          .map((r) => r.result),
      );
      const cross = results.filter((r) => r.user === b.id);
      const crossLanded = cross.filter((r) => r.committed && r.result === "inserted");
      const crossRows = await crossOwnerDetailRows(sql, [a.id, b.id]);
      inv(
        invariants,
        "O: another user cannot attach detail rows to A's shot (RLS/FK 'closes the loop' per 20260829120000)",
        crossLanded.length === 0 && crossRows === 0,
        { crossResults: cross.map((r) => r.result), crossOwnerRows: crossRows },
      );
      inv(
        invariants,
        "O: A's own rows: phases == own landed dup, measurements == own landed",
        row.phases === ownDup.length + crossLanded.filter((r) => r.op === "detail_insert").length &&
          row.measurements ===
            ownMeasure.length + crossLanded.filter((r) => r.op === "measurement_insert").length,
        row,
      );
      inv(
        invariants,
        "O: RLS — B sees none of A's detail rows",
        (await (async () => {
          let n = 0;
          await sql.begin(async (tx) => {
            await asUser(tx, b.id);
            const r = await tx.unsafe(
              `select (select count(*) from public.shot_phases where shot_id = $1 and user_id <> $2) + (select count(*) from public.shot_measurements where shot_id = $1 and user_id <> $2) as n`,
              [payA.id, b.id],
            );
            n = Number(r[0].n);
          });
          return n;
        })()) === 0,
        "visible=0",
      );
      observations.crossAttachResults = cross.map((r) => r.result);
    },
  };
};

// ────────────────────────────────────────────────────────────────────────────
// P. Mixed storm: three users, random ops incl. stale-identity / no-sub calls
// ────────────────────────────────────────────────────────────────────────────
export const mixedStorm: Scenario = async (sql, prng, k) => {
  const users = [newUser(prng, false), newUser(prng, false), newUser(prng, true)];
  for (const u of users) await createUser(sql, u);
  const n = prng.int(6, Math.max(6, k.lanesMax + 2));
  const lanes: LaneSpec[] = [];
  const perUserPermit = new Map<string, string>();
  for (const u of users) {
    perUserPermit.set(u.id, await reserveAsUser(sql, u.id, `k-${prng.uuid()}`));
  }
  const sharedShot = new Map<string, Payload>();
  for (const u of users) {
    sharedShot.set(u.id, makePayload(prng, prng.uuid(), perUserPermit.get(u.id)!));
  }
  for (let i = 0; i < n; i++) {
    const u = prng.pick(users);
    const kind = prng.pick([
      "dup",
      "dup",
      "fresh",
      "reserve",
      "stale_identity",
      "no_sub",
      "access",
    ] as const);
    if (kind === "dup") {
      lanes.push(applyLane(prng, k, i, u.id, sharedShot.get(u.id)!));
    } else if (kind === "fresh") {
      const p = u.premium
        ? await reserveAsUser(sql, u.id, `f-${prng.uuid()}`)
        : perUserPermit.get(u.id)!;
      lanes.push(applyLane(prng, k, i, u.id, makePayload(prng, prng.uuid(), p)));
    } else if (kind === "reserve") {
      lanes.push({
        ...laneDefaults(prng, k, i),
        user: u.id,
        role: "authenticated",
        op: "reserve",
        key: `r-${prng.uuid()}`,
      });
    } else if (kind === "stale_identity") {
      // Token rotated to ANOTHER account mid-flight: the request carries user
      // u's permit but user w's sub → must be permit_not_found, nothing written.
      const w = prng.pick(users.filter((x) => x.id !== u.id));
      lanes.push(
        applyLane(prng, k, i, w.id, sharedShot.get(u.id)!, {
          tag: "stale_identity",
        }),
      );
    } else if (kind === "no_sub") {
      lanes.push(applyLane(prng, k, i, "", sharedShot.get(u.id)!, { tag: "no_sub" }));
    } else {
      lanes.push({
        ...laneDefaults(prng, k, i),
        user: u.id,
        role: "authenticated",
        op: "access_state",
      });
    }
  }
  return {
    params: {
      users: users.map((u) => `${u.id}${u.premium ? ":premium" : ""}`),
      lanes: n,
    },
    users,
    lanes,
    check: async ({ results, snaps, invariants, observations }) => {
      for (const u of users) {
        const s = snaps.get(u.id)!;
        if (!u.premium) {
          inv(
            invariants,
            `P: free user ${u.id.slice(0, 8)} scored ≤ 2, scored + live reserved ≤ 2`,
            s.scored <= 2 &&
              s.scored + s.permits.filter((p) => p.status === "reserved").length <= 2,
            { scored: s.scored, permits: s.permits },
          );
        }
        inv(
          invariants,
          `P: ${u.id.slice(0, 8)} ledger == lifetime == scored, rank == scored`,
          s.ledger === (s.scored === 0 ? null : s.scored) &&
            s.lifetime === s.scored &&
            (s.rankScoredCount ?? 0) === s.scored,
          {
            ledger: s.ledger,
            lifetime: s.lifetime,
            rank: s.rankScoredCount,
            scored: s.scored,
          },
        );
        inv(
          invariants,
          `P: ${u.id.slice(0, 8)} finalized permits == scored rows`,
          s.permits.filter((p) => p.status === "finalized").length === s.scored,
          s.permits,
        );
        for (const other of users.filter((x) => x.id !== u.id)) {
          inv(
            invariants,
            `P: RLS — ${other.id.slice(0, 8)} sees none of ${u.id.slice(0, 8)}'s rows`,
            (await visibleShots(
              sql,
              other.id,
              s.shots.map((x) => x.id),
            )) === 0,
            "visible=0",
          );
        }
      }
      const noSub = results.filter((r) => r.tag === "no_sub");
      inv(
        invariants,
        "P: no-sub calls are auth.required",
        noSub.every((r) => r.result === "auth.required" || r.cancelled),
        noSub.map((r) => r.result),
      );
      const stale = results.filter((r) => r.tag === "stale_identity");
      inv(
        invariants,
        "P: rotated-identity calls (another user's permit + shot id) are permit_not_found, never accepted",
        stale.every(
          (r) => r.result === "access.permit_not_found" || r.cancelled || r.sqlstate === "40001",
        ),
        stale.map((r) => r.result),
      );
      const staleOwned = stale.filter((r) =>
        users.some((u) => u.id === r.user && snaps.get(u.id)!.shots.some((x) => x.id === r.shotId)),
      );
      inv(
        invariants,
        "P: a rotated identity never obtains a row for the other user's shot id",
        staleOwned.length === 0,
        staleOwned.map((r) => r.shotId),
      );
      observations.histogram = results.map((r) => `${r.op}:${r.result}`);
    },
  };
};

export const SCENARIOS: Array<{ name: string; weight: number; run: Scenario }> = [
  {
    name: "A_dup_same_shot_same_permit",
    weight: 16,
    run: dupSameShotSamePermit,
  },
  {
    name: "B_same_shot_distinct_permits",
    weight: 7,
    run: sameShotDistinctPermits,
  },
  {
    name: "C_distinct_shots_same_permit",
    weight: 9,
    run: distinctShotsSamePermit,
  },
  { name: "D_over_issued_free_limit", weight: 9, run: overIssuedFreeLimit },
  {
    name: "E_reserve_vs_apply_last_slot",
    weight: 7,
    run: reserveVsApplyLastSlot,
  },
  { name: "F_cross_user_same_shot_id", weight: 9, run: crossUserSameShotId },
  { name: "G_two_users_independent", weight: 6, run: twoUsersIndependent },
  { name: "H_abstention_vs_scored", weight: 6, run: abstentionVsScored },
  { name: "I_cancel_while_blocked", weight: 8, run: cancelWhileBlocked },
  {
    name: "J_account_deleted_mid_request",
    weight: 5,
    run: accountDeletedMidRequest,
  },
  { name: "K_clock_skew_permit_age", weight: 6, run: clockSkewPermitAge },
  { name: "L_permit_status_tamper", weight: 4, run: permitStatusTamper },
  { name: "M_session_race", weight: 5, run: sessionRace },
  { name: "N_direct_insert_vs_rpc", weight: 6, run: directInsertVsRpc },
  { name: "O_detail_rows_direct", weight: 4, run: detailRowsDirect },
  { name: "P_mixed_storm", weight: 5, run: mixedStorm },
];

export function pickScenario(prng: Prng, only?: string) {
  const pool = only
    ? SCENARIOS.filter(
        (s) => s.name === only || s.name.startsWith(only + "_") || s.name.startsWith(only),
      )
    : SCENARIOS;
  if (pool.length === 0) {
    throw new Error(`no scenario matches STRESS_ONLY=${only}`);
  }
  const total = pool.reduce((a, s) => a + s.weight, 0);
  let x = prng.next() * total;
  for (const s of pool) {
    x -= s.weight;
    if (x < 0) return s;
  }
  return pool[pool.length - 1];
}

/** Invariants every scenario must satisfy, evaluated from the owner role and
 * from each user's RLS context. */
export async function genericChecks(
  sql: Sql,
  built: Built,
  results: LaneResult[],
  snaps: Map<string, UserSnapshot>,
  wallMs: number,
  timedOut: boolean,
  timeoutMs: number,
  invariants: Invariant[],
): Promise<void> {
  inv(
    invariants,
    "G0: bounded wall time — the burst finished before the deadline (no deadlock / hang)",
    !timedOut && wallMs < timeoutMs,
    { wallMs, timeoutMs, timedOut },
  );
  const deadlocks = results.filter(
    (r) => r.sqlstate === "40P01" || r.sqlstate === "55P03" || r.sqlstate === "57P01",
  );
  inv(
    invariants,
    "G1: no deadlock (40P01), lock timeout (55P03) or terminated backend (57P01)",
    deadlocks.length === 0,
    deadlocks.map((r) => `${r.lane}:${r.result}`),
  );
  const unexpected = results.filter((r) => {
    if (!r.sqlstate) return false;
    if (r.cancelled) {
      return built.lanes.find((l) => l.lane === r.lane)?.cancelAtMs === undefined;
    }
    if (r.sqlstate === "40001" && r.isolation === "serializable") return false;
    if (built.allowedSqlstates?.has(r.sqlstate)) return false;
    return true;
  });
  inv(
    invariants,
    "G2: no unexpected SQLSTATE (only scenario-provoked errors, cancels on cancelled lanes, 40001 under SERIALIZABLE)",
    unexpected.length === 0,
    unexpected.map((r) => `${r.lane}:${r.op}:${r.result}`),
  );
  const wf = results.filter(
    (r) =>
      r.committed &&
      r.result.startsWith("shot.write_failed:") &&
      !built.allowedSqlstates?.has(r.result.slice("shot.write_failed:".length)) &&
      !(r.result === "shot.write_failed:40001" && r.isolation === "serializable"),
  );
  inv(
    invariants,
    "G3: no committed shot.write_failed for a well-formed payload",
    wf.length === 0,
    wf.map((r) => `${r.lane}:${r.result}`),
  );

  for (const u of built.users) {
    const s = snaps.get(u.id)!;
    if (!s.exists) continue;
    if (!u.premium) {
      inv(
        invariants,
        `G4: ${u.id.slice(
          0,
          8,
        )} non-premium lifetime_scored_count() ≤ 2 (no double spend of free ratings)`,
        (s.lifetime ?? 0) <= 2 && s.scored <= 2 && (s.ledger ?? 0) <= 2,
        { lifetime: s.lifetime, scored: s.scored, ledger: s.ledger },
      );
    }
    inv(
      invariants,
      `G5: ${u.id.slice(0, 8)} identity ledger == scored rows (trigger never lost an update)`,
      (s.ledger ?? 0) === s.scored,
      { ledger: s.ledger, scored: s.scored },
    );
    const withScore = s.shots.filter(
      (x) => x.resultKind === "scored" && x.overallScore !== null,
    ).length;
    inv(
      invariants,
      `G6: ${u.id.slice(
        0,
        8,
      )} player_rank_state.scored_shot_count == scored rows (derived state consistent)`,
      (s.rankScoredCount ?? 0) === withScore,
      { rank: s.rankScoredCount, scored: withScore },
    );
    inv(
      invariants,
      `G7: ${u.id.slice(0, 8)} access_state().scored_count == lifetime_scored_count()`,
      s.access !== null && s.access.scored === s.lifetime,
      s.access,
    );
    if (!built.directWrites) {
      inv(
        invariants,
        `G8: ${u.id.slice(
          0,
          8,
        )} finalized(scored) permits == scored rows (each rating consumed exactly one permit)`,
        s.permits.filter((p) => p.status === "finalized" && p.outcome === "scored").length ===
          s.scored,
        { permits: s.permits, scored: s.scored },
      );
    }
    inv(
      invariants,
      `G9: ${u.id.slice(0, 8)} scored rows carry a score, abstentions never do`,
      s.shots.every((x) => (x.resultKind === "scored") === (x.overallScore !== null)),
      s.shots.map((x) => `${x.resultKind}:${x.overallScore}`),
    );
  }
  // Committed 'accepted' apply lanes must have a durable row for their user;
  // committed permanent codes must never coexist with a row the user owns.
  const owned = new Set<string>();
  for (const s of snaps.values()) {
    for (const x of s.shots) owned.add(`${x.userId}:${x.id}`);
  }
  const acceptedNoRow = results.filter(
    (r) =>
      (r.op === "apply" || r.op === "tamper_then_apply") &&
      r.committed &&
      r.result.endsWith("accepted") &&
      r.shotId &&
      !owned.has(`${r.user}:${r.shotId}`) &&
      !built.deletesUser,
  );
  inv(
    invariants,
    "G10: every committed accepted apply has a durable row owned by its caller",
    acceptedNoRow.length === 0,
    acceptedNoRow.map((r) => `${r.lane}:${r.shotId}`),
  );
  const permanentWithRow = results.filter(
    (r) =>
      r.op === "apply" &&
      PERMANENT_CODES.has(r.result) &&
      r.shotId &&
      owned.has(`${r.user}:${r.shotId}`),
  );
  inv(
    invariants,
    "G11: no lane received a permanent rejection for a shot the server holds for that user (the 20260906 regression)",
    permanentWithRow.length === 0,
    permanentWithRow.map((r) => `${r.lane}:${r.result}`),
  );
  const cross = await crossOwnerDetailRows(
    sql,
    built.users.map((u) => u.id),
  );
  inv(
    invariants,
    "G12: no detail row is attached to a shot owned by a different user",
    cross === 0,
    cross,
  );
}
