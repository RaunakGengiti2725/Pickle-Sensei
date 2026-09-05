import type { InjectOptions } from "fastify";
import {
  accessLedger,
  assertLedgerInvariants,
  auth,
  bootstrapActor,
  bootstrapBody,
  burst,
  count,
  mintSkewedToken,
  reservePermit,
  shotPayload,
  Violations,
  type Actor,
  type Op,
  type OpResult,
  type Rng,
  type World,
} from "./concurrencyHarness.js";

/**
 * One scenario = one seeded interleaving family. Each returns the list of
 * invariant violations (empty = HELD) plus the raw request results so the
 * results table can show exactly which statuses the burst produced.
 */
export interface ScenarioRun {
  results: OpResult[];
  violations: string[];
  detail?: Record<string, unknown>;
}

export type Scenario = (world: World, rng: Rng) => Promise<ScenarioRun>;

const inject = (world: World, label: string, req: InjectOptions): Op => ({
  label,
  run: () => world.app.inject(req),
});

const reserveOp = (world: World, actor: Actor, key: string, label: string): Op =>
  inject(world, label, {
    method: "POST",
    url: "/v1/analysis-permits",
    headers: auth(actor.token),
    payload: { idempotencyKey: key },
  });

const syncOp = (world: World, actor: Actor, shots: Record<string, unknown>[], label: string): Op =>
  inject(world, label, {
    method: "POST",
    url: "/v1/shots:sync",
    headers: auth(actor.token),
    payload: { shots },
  });

const finalizeOp = (
  world: World,
  actor: Actor,
  permitId: string,
  outcome: string,
  ratingId: string | null,
  label: string,
): Op =>
  inject(world, label, {
    method: "POST",
    url: `/v1/analysis-permits/${permitId}/finalize`,
    headers: auth(actor.token),
    payload: { outcome, ratingId },
  });

const permitIdOf = (r: OpResult): string | null =>
  r.status === 200 ? ((r.body as { permit?: { id?: string } }).permit?.id ?? null) : null;

const syncAccepted = (r: OpResult, shotId: string): boolean =>
  r.status === 200 && ((r.body as { acceptedIds?: string[] }).acceptedIds ?? []).includes(shotId);

const syncRejectedCode = (r: OpResult, shotId: string): string | null =>
  r.status === 200
    ? (((r.body as { rejected?: { id: string; code: string }[] }).rejected ?? []).find(
        (x) => x.id === shotId,
      )?.code ?? null)
    : null;

// ---------------------------------------------------------------------------

/** Duplicate + overlapping permit reservations from one (or two) devices. */
export const permitReserveBurst: Scenario = async (world, rng) => {
  const actor = await bootstrapActor(world, rng);
  const premium = rng.bool(0.25);
  if (premium) {
    await world.pool.query(
      "INSERT INTO entitlement (user_id, feature_key, valid_from) VALUES ($1, 'premium', now() - interval '1 minute')",
      [actor.userId],
    );
  }
  // Token rotation: a second bearer for the same subject may join the burst.
  const rotated = rng.bool(0.4) ? await world.minter.mint(actor.subject) : null;
  const keys = Array.from({ length: rng.int(1, 4) }, () => rng.uuid());
  const n = rng.int(4, 12);
  const ops: Op[] = [];
  const keyOf: string[] = [];
  for (let i = 0; i < n; i++) {
    const key = rng.pick(keys);
    const token = rotated && rng.bool() ? rotated : actor.token;
    keyOf.push(key);
    ops.push(reserveOp(world, { ...actor, token }, key, `reserve[${key.slice(0, 8)}]#${i}`));
  }
  const results = await burst(rng, world, ops);
  const v = new Violations();
  v.noServerErrors(results);
  v.statusIn(results, premium ? [200] : [200, 402]);
  // Same idempotency key must always resolve to the same permit id.
  const byKey = new Map<string, Set<string>>();
  results.forEach((r, i) => {
    const key = keyOf[i]!;
    const id = permitIdOf(r);
    if (id) byKey.set(key, (byKey.get(key) ?? new Set()).add(id));
  });
  for (const [key, ids] of byKey) {
    v.check(ids.size === 1, `idempotency: key ${key} produced ${ids.size} distinct permits`);
  }
  const ledger = await assertLedgerInvariants(world.pool, actor.userId, v);
  const reservedFree = ledger.permits.filter(
    (p) => p.access_source === "free" && p.status === "reserved",
  ).length;
  const distinctKeys = new Set(keyOf).size;
  if (!premium) {
    const expectedReserved = Math.min(2, distinctKeys);
    v.check(
      reservedFree === expectedReserved,
      `reserve: ${reservedFree} free permits reserved for ${distinctKeys} distinct keys (expected ${expectedReserved})`,
    );
  } else {
    v.check(
      ledger.permits.length === distinctKeys &&
        ledger.permits.every((p) => p.access_source === "premium"),
      `reserve(premium): ${ledger.permits.length} permits for ${distinctKeys} keys`,
    );
  }
  return {
    results,
    violations: v.items,
    detail: { premium, keys: distinctKeys, n, rotated: !!rotated },
  };
};

/** The same shot payload replayed concurrently from several devices. */
export const shotSyncExactReplay: Scenario = async (world, rng) => {
  const actor = await bootstrapActor(world, rng);
  const permitId = await reservePermit(world, actor, rng.uuid());
  const shot = shotPayload(rng, permitId, rng.bool(0.3) ? { resultKind: "low_confidence" } : {});
  const shotId = shot["id"] as string;
  const n = rng.int(3, 10);
  const ops = Array.from({ length: n }, (_, i) =>
    // Some replays arrive as a batch that carries the same shot twice.
    syncOp(world, actor, rng.bool(0.2) ? [shot, shot] : [shot], `sync#${i}`),
  );
  const results = await burst(rng, world, ops);
  const v = new Violations();
  v.noServerErrors(results);
  v.statusIn(results, [200]);
  for (const r of results) {
    v.check(
      syncAccepted(r, shotId) && !syncRejectedCode(r, shotId),
      `replay: ${r.label} status=${r.status} body=${JSON.stringify(r.body)}`,
    );
  }
  const ledger = await assertLedgerInvariants(world.pool, actor.userId, v);
  const scored = shot["resultKind"] === "scored";
  v.check(ledger.shots.length === 1, `replay: ${ledger.shots.length} shot rows (expected 1)`);
  v.check(
    ledger.used === (scored ? 1 : 0),
    `replay: used=${ledger.used} (expected ${scored ? 1 : 0})`,
  );
  const permit = ledger.permits[0];
  v.check(
    permit?.status === (scored ? "consumed" : "released"),
    `replay: permit status ${permit?.status} (expected ${scored ? "consumed" : "released"})`,
  );
  const runs = await count(world.pool, "SELECT 1 FROM analysis_run WHERE shot_id = $1", [shotId]);
  v.check(runs === 1, `replay: ${runs} analysis_run rows (expected 1)`);
  const daily = await world.pool.query<{ shot_count: number }>(
    "SELECT shot_count FROM progress_daily WHERE user_id = $1",
    [actor.userId],
  );
  const dailyCount = daily.rows.reduce((acc, row) => acc + Number(row.shot_count), 0);
  v.check(
    dailyCount === (scored ? 1 : 0),
    `replay: progress_daily shot_count=${dailyCount} (expected ${scored ? 1 : 0})`,
  );
  return { results, violations: v.items, detail: { scored, n } };
};

/** Two different shots race for one permit; only one may consume it. */
export const shotSyncPermitReuse: Scenario = async (world, rng) => {
  const actor = await bootstrapActor(world, rng);
  const permitId = await reservePermit(world, actor, rng.uuid());
  const shots = Array.from({ length: rng.int(2, 4) }, () => shotPayload(rng, permitId));
  const ops = shots.map((s, i) =>
    syncOp(world, actor, [s], `sync[${(s["id"] as string).slice(0, 8)}]#${i}`),
  );
  const results = await burst(rng, world, ops);
  const v = new Violations();
  v.noServerErrors(results);
  v.statusIn(results, [200]);
  let accepted = 0;
  shots.forEach((s, i) => {
    const r = results[i]!;
    if (syncAccepted(r, s["id"] as string)) accepted++;
    else {
      const code = syncRejectedCode(r, s["id"] as string);
      v.check(
        code === "shot.permit_conflict" || code === "access.permit_not_reserved",
        `reuse: ${r.label} rejected with ${code ?? "nothing"} body=${JSON.stringify(r.body)}`,
      );
    }
  });
  v.check(accepted === 1, `reuse: ${accepted} shots accepted for one permit (expected 1)`);
  const ledger = await assertLedgerInvariants(world.pool, actor.userId, v);
  v.check(ledger.shots.length === 1, `reuse: ${ledger.shots.length} shot rows`);
  v.check(ledger.used === 1, `reuse: used=${ledger.used} (expected 1)`);
  return { results, violations: v.items, detail: { shots: shots.length } };
};

/** Both lifetime permits consumed while more reservations and a forged permit race in. */
export const freeRatingDoubleSpend: Scenario = async (world, rng) => {
  const actor = await bootstrapActor(world, rng);
  const p1 = await reservePermit(world, actor, rng.uuid());
  const p2 = await reservePermit(world, actor, rng.uuid());
  const s1 = shotPayload(rng, p1);
  const s2 = shotPayload(rng, p2);
  const forged = shotPayload(rng, rng.uuid());
  const ops: Op[] = [
    syncOp(world, actor, [s1], "sync[p1]"),
    syncOp(world, actor, [s2], "sync[p2]"),
    syncOp(world, actor, [forged], "sync[forged-permit]"),
  ];
  const extraKeys = rng.int(1, 4);
  for (let i = 0; i < extraKeys; i++)
    ops.push(reserveOp(world, actor, rng.uuid(), `reserve-extra#${i}`));
  if (rng.bool()) ops.push(syncOp(world, actor, [s1], "sync[p1-dup]"));
  if (rng.bool()) {
    ops.push(
      inject(world, "access", { method: "GET", url: "/v1/me/access", headers: auth(actor.token) }),
    );
  }
  const results = await burst(rng, world, ops);
  const v = new Violations();
  v.noServerErrors(results);
  v.statusIn(results, [200, 402]);
  const ledger = await assertLedgerInvariants(world.pool, actor.userId, v);
  v.check(ledger.used === 2, `double-spend: used=${ledger.used} (expected 2)`);
  v.check(ledger.shots.length === 2, `double-spend: ${ledger.shots.length} shot rows (expected 2)`);
  for (const r of results) {
    if (r.label.startsWith("reserve-extra")) {
      v.check(r.status === 402, `double-spend: ${r.label} got ${r.status} while 2 permits live`);
    }
    if (r.label === "sync[forged-permit]") {
      v.check(
        syncRejectedCode(r, forged["id"] as string) === "access.permit_not_found",
        `double-spend: forged permit → ${JSON.stringify(r.body)}`,
      );
    }
  }
  const afterwards = await world.app.inject({
    method: "POST",
    url: "/v1/analysis-permits",
    headers: auth(actor.token),
    payload: { idempotencyKey: rng.uuid() },
  });
  v.check(
    afterwards.statusCode === 402,
    `double-spend: third reservation after 2 used → ${afterwards.statusCode}`,
  );
  return { results, violations: v.items, detail: { extraKeys } };
};

/** Competing finalizations of the same permit; exactly one outcome may persist. */
export const permitFinalizeRace: Scenario = async (world, rng) => {
  const actor = await bootstrapActor(world, rng);
  const permitId = await reservePermit(world, actor, rng.uuid());
  const outcomes = [
    "cancelled",
    "failed",
    "low_confidence",
    "unsupported",
    "incorrect_recognition",
  ];
  const n = rng.int(3, 8);
  const ops = Array.from({ length: n }, (_, i) => {
    const outcome = rng.pick(outcomes);
    return finalizeOp(world, actor, permitId, outcome, null, `finalize[${outcome}]#${i}`);
  });
  // A scored finalize without an atomically persisted shot must always be refused.
  ops.push(finalizeOp(world, actor, permitId, "scored", rng.uuid(), "finalize[scored-unbound]"));
  const results = await burst(rng, world, ops);
  const v = new Violations();
  v.noServerErrors(results);
  const ledger = await assertLedgerInvariants(world.pool, actor.userId, v);
  const permit = ledger.permits[0]!;
  v.check(permit.status === "released", `finalize-race: permit status ${permit.status}`);
  v.check(ledger.used === 0, `finalize-race: used=${ledger.used}`);
  for (const r of results) {
    const requested = r.label.slice(9, r.label.indexOf("]"));
    if (requested === "scored-unbound") {
      v.check(
        r.status === 409 &&
          (r.code === "access.rating_not_bound" || r.code === "access.permit_already_finalized"),
        `finalize-race: scored-unbound → ${r.status} ${r.code}`,
      );
      continue;
    }
    if (requested === permit.outcome) {
      v.check(
        r.status === 200 &&
          (r.body as { permit: { outcome: string } }).permit.outcome === permit.outcome,
        `finalize-race: ${r.label} matches winner but got ${r.status} ${r.code}`,
      );
    } else {
      v.check(
        r.status === 409 && r.code === "access.permit_already_finalized",
        `finalize-race: ${r.label} lost to ${permit.outcome} but got ${r.status} ${r.code}`,
      );
    }
  }
  return { results, violations: v.items, detail: { winner: permit.outcome, n } };
};

/** Cancel-during-call: a scored sync races direct cancel/failed finalizations. */
export const shotSyncVersusCancel: Scenario = async (world, rng) => {
  const actor = await bootstrapActor(world, rng);
  const permitId = await reservePermit(world, actor, rng.uuid());
  const shot = shotPayload(rng, permitId);
  const shotId = shot["id"] as string;
  const cancels = rng.int(1, 4);
  const ops: Op[] = [syncOp(world, actor, [shot], "sync")];
  for (let i = 0; i < cancels; i++) {
    ops.push(
      finalizeOp(world, actor, permitId, rng.pick(["cancelled", "failed"]), null, `cancel#${i}`),
    );
  }
  if (rng.bool(0.4)) ops.push(syncOp(world, actor, [shot], "sync-dup"));
  const results = await burst(rng, world, ops);
  const v = new Violations();
  v.noServerErrors(results);
  const ledger = await assertLedgerInvariants(world.pool, actor.userId, v);
  const permit = ledger.permits[0]!;
  const shotRows = ledger.shots.length;
  if (permit.status === "consumed") {
    v.check(
      shotRows === 1 && ledger.used === 1,
      `sync-vs-cancel: consumed but shots=${shotRows} used=${ledger.used}`,
    );
    for (const r of results) {
      if (r.label.startsWith("cancel")) {
        v.check(
          r.status === 409,
          `sync-vs-cancel: ${r.label} → ${r.status} after shot consumed permit`,
        );
      } else {
        v.check(
          syncAccepted(r, shotId),
          `sync-vs-cancel: ${r.label} not accepted → ${JSON.stringify(r.body)}`,
        );
      }
    }
  } else {
    v.check(permit.status === "released", `sync-vs-cancel: permit status ${permit.status}`);
    v.check(
      shotRows === 0 && ledger.used === 0,
      `sync-vs-cancel: released but shots=${shotRows} used=${ledger.used}`,
    );
    for (const r of results) {
      if (r.label.startsWith("sync")) {
        v.check(
          syncRejectedCode(r, shotId) === "access.permit_not_reserved",
          `sync-vs-cancel: ${r.label} → ${JSON.stringify(r.body)}`,
        );
      }
    }
  }
  return { results, violations: v.items, detail: { winner: permit.status, cancels } };
};

/** Duplicate analysis-job creation for one permit must replay, not duplicate or fail. */
export const analysisCreateDuplicate: Scenario = async (world, rng) => {
  const actor = await bootstrapActor(world, rng);
  const permitId = await reservePermit(world, actor, rng.uuid());
  const n = rng.int(2, 6);
  const body = {
    mediaAssetId: null,
    localAnalysisId: rng.uuid(),
    expectedShotType: "forehand_drive",
    inferenceMode: "on_device",
    sessionId: null,
    permitId,
  };
  const ops = Array.from({ length: n }, (_, i) =>
    inject(world, `analyses#${i}`, {
      method: "POST",
      url: "/v1/analyses",
      headers: auth(actor.token),
      payload: body,
    }),
  );
  const results = await burst(rng, world, ops);
  const v = new Violations();
  v.noServerErrors(results);
  v.statusIn(results, [200]);
  const ids = new Set(
    results
      .filter((r) => r.status === 200)
      .map((r) => (r.body as { analysisId: string }).analysisId),
  );
  v.check(ids.size === 1, `analyses: ${ids.size} distinct analysisIds`);
  const jobs = await count(world.pool, "SELECT 1 FROM analysis_job WHERE analysis_permit_id = $1", [
    permitId,
  ]);
  v.check(jobs === 1, `analyses: ${jobs} analysis_job rows for one permit`);
  return { results, violations: v.items, detail: { n } };
};

/** First-launch bootstrap fired several times at once from one sign-in. */
export const bootstrapDuplicate: Scenario = async (world, rng) => {
  const subject = `auth0|stress-${rng.uuid()}`;
  const token = await world.minter.mint(subject);
  const rotated = rng.bool(0.5) ? await world.minter.mint(subject) : null;
  const n = rng.int(2, 6);
  const ops = Array.from({ length: n }, (_, i) =>
    inject(world, `bootstrap#${i}`, {
      method: "POST",
      url: "/v1/account/bootstrap",
      headers: auth(rotated && rng.bool() ? rotated : token),
      payload: bootstrapBody,
    }),
  );
  const results = await burst(rng, world, ops);
  const v = new Violations();
  v.noServerErrors(results);
  v.statusIn(results, [200]);
  const ids = new Set(
    results
      .filter((r) => r.status === 200)
      .map((r) => (r.body as { user: { id: string } }).user.id),
  );
  v.check(ids.size === 1, `bootstrap: ${ids.size} distinct user ids returned`);
  const users = await count(world.pool, "SELECT 1 FROM app_user WHERE auth_subject = $1", [
    subject,
  ]);
  v.check(users === 1, `bootstrap: ${users} app_user rows`);
  const profiles = await count(
    world.pool,
    "SELECT 1 FROM user_profile up JOIN app_user u ON u.id = up.user_id WHERE u.auth_subject = $1",
    [subject],
  );
  v.check(profiles === 1, `bootstrap: ${profiles} user_profile rows`);
  const me = await world.app.inject({ method: "GET", url: "/v1/me", headers: auth(token) });
  v.check(me.statusCode === 200, `bootstrap: /v1/me afterwards → ${me.statusCode}`);
  return { results, violations: v.items, detail: { n, rotated: !!rotated } };
};

/** Two users claim the same handle at the same time. */
export const handleClaimRace: Scenario = async (world, rng) => {
  const a = await bootstrapActor(world, rng);
  const b = await bootstrapActor(world, rng);
  const handle = `h${rng.uuid().replace(/-/g, "").slice(0, 12)}`;
  const ops: Op[] = [];
  const perActor = rng.int(1, 3);
  for (const [name, actor] of [
    ["a", a],
    ["b", b],
  ] as const) {
    for (let i = 0; i < perActor; i++) {
      ops.push(
        inject(world, `claim[${name}]#${i}`, {
          method: "PATCH",
          url: "/v1/me/profile",
          headers: auth(actor.token),
          payload: { handle },
        }),
      );
    }
  }
  const results = await burst(rng, world, ops);
  const v = new Violations();
  v.noServerErrors(results);
  v.statusIn(results, [200, 409]);
  const owners = await world.pool.query<{ user_id: string }>(
    "SELECT user_id FROM user_profile WHERE handle = $1",
    [handle],
  );
  v.check(owners.rows.length === 1, `handle: ${owners.rows.length} owners`);
  const owner = owners.rows[0]?.user_id;
  for (const r of results) {
    const actor = r.label.includes("[a]") ? a : b;
    if (r.status === 200) {
      v.check(actor.userId === owner, `handle: ${r.label} got 200 but does not own the handle`);
    }
  }
  const winnerSuccesses = results.filter(
    (r) => r.status === 200 && (r.label.includes("[a]") ? a : b).userId === owner,
  ).length;
  v.check(winnerSuccesses >= 1, "handle: nobody received 200 for a handle that is now owned");
  return { results, violations: v.items, detail: { perActor } };
};

/** Mutual friend requests sent simultaneously. */
export const friendRequestCross: Scenario = async (world, rng) => {
  const a = await bootstrapActor(world, rng);
  const b = await bootstrapActor(world, rng);
  const handles = {
    a: `a${rng.uuid().replace(/-/g, "").slice(0, 10)}`,
    b: `b${rng.uuid().replace(/-/g, "").slice(0, 10)}`,
  };
  for (const [actor, handle] of [
    [a, handles.a],
    [b, handles.b],
  ] as const) {
    const res = await world.app.inject({
      method: "PATCH",
      url: "/v1/me/profile",
      headers: auth(actor.token),
      payload: { handle },
    });
    if (res.statusCode !== 200) throw new Error(`handle setup failed ${res.statusCode}`);
  }
  const ops: Op[] = [];
  const dupA = rng.int(1, 3);
  const dupB = rng.int(1, 3);
  for (let i = 0; i < dupA; i++) {
    ops.push(
      inject(world, `a->b#${i}`, {
        method: "POST",
        url: "/v1/friends/requests",
        headers: auth(a.token),
        payload: { userHandle: handles.b },
      }),
    );
  }
  for (let i = 0; i < dupB; i++) {
    ops.push(
      inject(world, `b->a#${i}`, {
        method: "POST",
        url: "/v1/friends/requests",
        headers: auth(b.token),
        payload: { userHandle: handles.a },
      }),
    );
  }
  const results = await burst(rng, world, ops);
  const v = new Violations();
  v.noServerErrors(results);
  v.statusIn(results, [200, 409]);
  const rows = await count(
    world.pool,
    `SELECT 1 FROM friendship WHERE (requester_user_id = $1 AND addressee_user_id = $2)
        OR (requester_user_id = $2 AND addressee_user_id = $1)`,
    [a.userId, b.userId],
  );
  v.check(rows === 1, `friendship: ${rows} rows between the pair (expected 1)`);
  const successes = results.filter((r) => r.status === 200).length;
  v.check(successes === 1, `friendship: ${successes} requests returned 200 (expected 1)`);
  return { results, violations: v.items, detail: { dupA, dupB } };
};

/** Account deletion requested repeatedly at once (double-tap / retry storm). */
export const accountDeleteDuplicate: Scenario = async (world, rng) => {
  const actor = await bootstrapActor(world, rng);
  const n = rng.int(2, 5);
  const ops = Array.from({ length: n }, (_, i) =>
    inject(world, `delete#${i}`, {
      method: "DELETE",
      url: "/v1/me",
      headers: auth(actor.token),
      payload: { confirmation: "DELETE" },
    }),
  );
  const results = await burst(rng, world, ops);
  const v = new Violations();
  v.noServerErrors(results);
  v.statusIn(results, [200, 401, 410]);
  const tasks = await world.pool.query<{ kind: string; n: string }>(
    "SELECT kind, count(*)::text AS n FROM deletion_task WHERE user_id = $1 GROUP BY kind ORDER BY kind",
    [actor.userId],
  );
  const total = tasks.rows.reduce((acc, r) => acc + Number(r.n), 0);
  v.check(total === 4, `delete: ${total} deletion_task rows (expected exactly 4: one per kind)`);
  for (const row of tasks.rows) {
    v.check(Number(row.n) === 1, `delete: ${row.n} '${row.kind}' tasks queued`);
  }
  const status = await world.pool.query<{ status: string }>(
    "SELECT status FROM app_user WHERE id = $1",
    [actor.userId],
  );
  v.check(status.rows[0]?.status === "deleted", `delete: user status ${status.rows[0]?.status}`);
  return { results, violations: v.items, detail: { n, tasks: tasks.rows } };
};

/** Onboarding submitted concurrently (offline outbox flush + retry). */
export const onboardingDuplicate: Scenario = async (world, rng) => {
  const actor = await bootstrapActor(world, rng);
  const n = rng.int(2, 5);
  const goals = ["dinks", "drives", "drops", "serve"];
  const ops = Array.from({ length: n }, (_, i) =>
    inject(world, `onboarding#${i}`, {
      method: "PUT",
      url: "/v1/me/onboarding",
      headers: auth(actor.token),
      payload: {
        skillLevel: "3.0",
        handedness: "right",
        goal: rng.bool(0.7) ? goals[0] : rng.pick(goals),
        biggestProblem: "consistency",
      },
    }),
  );
  const results = await burst(rng, world, ops);
  const v = new Violations();
  v.noServerErrors(results);
  v.statusIn(results, [200]);
  const goalsActive = await count(
    world.pool,
    "SELECT 1 FROM user_goal WHERE user_id = $1 AND goal_type = 'onboarding_focus' AND status = 'active'",
    [actor.userId],
  );
  v.check(
    goalsActive === 1,
    `onboarding: ${goalsActive} active onboarding_focus goals (expected 1)`,
  );
  return { results, violations: v.items, detail: { n } };
};

/** Session created by client UUID from several devices, then finalized concurrently. */
export const sessionCreateAndFinalize: Scenario = async (world, rng) => {
  const actor = await bootstrapActor(world, rng);
  const stranger = await bootstrapActor(world, rng);
  const sessionId = rng.uuid();
  const body = {
    id: sessionId,
    mode: "single",
    shotType: "forehand_drive",
    focusCheckpoint: "contact_position",
    cameraView: "side",
    startedAt: new Date(Date.UTC(2026, 0, 2)).toISOString(),
  };
  const n = rng.int(2, 5);
  const ops: Op[] = Array.from({ length: n }, (_, i) =>
    inject(world, `create#${i}`, {
      method: "POST",
      url: "/v1/sessions",
      headers: auth(actor.token),
      payload: body,
    }),
  );
  ops.push(
    inject(world, "create[stranger]", {
      method: "POST",
      url: "/v1/sessions",
      headers: auth(stranger.token),
      payload: body,
    }),
  );
  const results = await burst(rng, world, ops);
  const v = new Violations();
  v.noServerErrors(results);
  const owner = await world.pool.query<{ user_id: string }>(
    "SELECT user_id FROM practice_session WHERE id = $1",
    [sessionId],
  );
  v.check(owner.rows.length === 1, `session: ${owner.rows.length} rows for id`);
  const ownerId = owner.rows[0]?.user_id;
  for (const r of results) {
    const isStranger = r.label === "create[stranger]";
    const mine = (isStranger ? stranger : actor).userId === ownerId;
    v.check(
      mine ? r.status === 200 : r.status === 409 && r.code === "session.id_conflict",
      `session: ${r.label} → ${r.status} ${r.code} (owner=${mine ? "self" : "other"})`,
    );
  }
  // Two shots into the session plus concurrent finalize/patch on the same row.
  const ownerActor = ownerId === actor.userId ? actor : stranger;
  const p1 = await reservePermit(world, ownerActor, rng.uuid());
  const p2 = await reservePermit(world, ownerActor, rng.uuid());
  const s1 = shotPayload(rng, p1, { sessionId });
  const s2 = shotPayload(rng, p2, { sessionId });
  const phase2: Op[] = [
    inject(world, "batch[s1]", {
      method: "POST",
      url: `/v1/sessions/${sessionId}/shots:batch`,
      headers: auth(ownerActor.token),
      payload: { shots: [s1] },
    }),
    syncOp(world, ownerActor, [s2], "sync[s2]"),
  ];
  const finalizes = rng.int(1, 3);
  for (let i = 0; i < finalizes; i++) {
    phase2.push(
      inject(world, `finalize#${i}`, {
        method: "POST",
        url: `/v1/sessions/${sessionId}/finalize`,
        headers: auth(ownerActor.token),
        payload: {},
      }),
    );
  }
  phase2.push(
    inject(world, "patch", {
      method: "PATCH",
      url: `/v1/sessions/${sessionId}`,
      headers: auth(ownerActor.token),
      payload: { completed: true },
    }),
  );
  const results2 = await burst(rng, world, phase2);
  v.noServerErrors(results2);
  v.statusIn(results2, [200]);
  await assertLedgerInvariants(world.pool, ownerActor.userId, v);
  const session = await world.pool.query<{ shot_count: number; completed: boolean }>(
    "SELECT shot_count, completed FROM practice_session WHERE id = $1",
    [sessionId],
  );
  const shotRows = await count(world.pool, "SELECT 1 FROM shot WHERE session_id = $1", [sessionId]);
  v.check(shotRows === 2, `session: ${shotRows} shots (expected 2)`);
  v.check(
    Number(session.rows[0]?.shot_count) === 2,
    `session: shot_count=${session.rows[0]?.shot_count} (expected 2)`,
  );
  v.check(session.rows[0]?.completed === true, "session: not completed after finalize");
  const summaries = await world.pool.query<{ valid_shot_count: number }>(
    "SELECT valid_shot_count FROM session_summary WHERE session_id = $1",
    [sessionId],
  );
  v.check(summaries.rows.length === 1, `session: ${summaries.rows.length} summaries`);
  // Every finalize saw a subset of the two shots; the persisted summary must
  // agree with the shots that exist now (refreshSummaryIfPresent recomputes).
  v.check(
    Number(summaries.rows[0]?.valid_shot_count) === 2,
    `session: summary valid_shot_count=${summaries.rows[0]?.valid_shot_count} disagrees with 2 persisted shots`,
  );
  return { results: [...results, ...results2], violations: v.items, detail: { n, finalizes } };
};

/** Account deleted while permit/shot requests are in flight (revocation mid-request). */
export const deleteDuringRequests: Scenario = async (world, rng) => {
  const actor = await bootstrapActor(world, rng);
  const permitId = await reservePermit(world, actor, rng.uuid());
  const shot = shotPayload(rng, permitId);
  const ops: Op[] = [
    inject(world, "delete", {
      method: "DELETE",
      url: "/v1/me",
      headers: auth(actor.token),
      payload: { confirmation: "DELETE" },
    }),
    syncOp(world, actor, [shot], "sync"),
  ];
  const reserves = rng.int(1, 3);
  for (let i = 0; i < reserves; i++) ops.push(reserveOp(world, actor, rng.uuid(), `reserve#${i}`));
  ops.push(inject(world, "me", { method: "GET", url: "/v1/me", headers: auth(actor.token) }));
  const results = await burst(rng, world, ops);
  const v = new Violations();
  v.noServerErrors(results);
  v.statusIn(results, [200, 401, 402, 410]);
  await assertLedgerInvariants(world.pool, actor.userId, v);
  const after = await burst(rng, world, [
    inject(world, "after:me", { method: "GET", url: "/v1/me", headers: auth(actor.token) }),
    reserveOp(world, actor, rng.uuid(), "after:reserve"),
    syncOp(world, actor, [shot], "after:sync"),
  ]);
  v.statusIn(after, [401, 410]);
  const status = await world.pool.query<{ status: string }>(
    "SELECT status FROM app_user WHERE id = $1",
    [actor.userId],
  );
  v.check(status.rows[0]?.status === "deleted", `delete-during: status ${status.rows[0]?.status}`);
  return { results: [...results, ...after], violations: v.items, detail: { reserves } };
};

/** Permit expiry (server clock ahead of reservation) racing a scored sync + new reservations. */
export const permitClockSkew: Scenario = async (world, rng) => {
  const actor = await bootstrapActor(world, rng);
  const stale = await reservePermit(world, actor, rng.uuid());
  const fresh = await reservePermit(world, actor, rng.uuid());
  // The device believes `stale` is valid; the server clock says it expired.
  await world.pool.query(
    `UPDATE analysis_permit
     SET reserved_at = now() - interval '25 hours', expires_at = now() - interval '1 second'
     WHERE id = $1`,
    [stale],
  );
  const staleShot = shotPayload(rng, stale);
  const freshShot = shotPayload(rng, fresh);
  const ops: Op[] = [syncOp(world, actor, [staleShot], "sync[stale]")];
  if (rng.bool(0.7)) ops.push(syncOp(world, actor, [freshShot], "sync[fresh]"));
  const newKeys = rng.int(1, 3);
  for (let i = 0; i < newKeys; i++)
    ops.push(reserveOp(world, actor, rng.uuid(), `reserve-new#${i}`));
  if (rng.bool()) ops.push(finalizeOp(world, actor, stale, "cancelled", null, "cancel[stale]"));
  ops.push(
    inject(world, "access", { method: "GET", url: "/v1/me/access", headers: auth(actor.token) }),
  );
  const results = await burst(rng, world, ops);
  const v = new Violations();
  v.noServerErrors(results);
  v.statusIn(results, [200, 402, 409]);
  const ledger = await assertLedgerInvariants(world.pool, actor.userId, v);
  const stalePermit = ledger.permits.find((p) => p.id === stale)!;
  v.check(stalePermit.status === "expired", `skew: stale permit status ${stalePermit.status}`);
  v.check(
    !ledger.shots.some((s) => s.analysis_permit_id === stale),
    "skew: a shot was persisted on an expired permit",
  );
  const staleSync = results.find((r) => r.label === "sync[stale]")!;
  // Either the sync itself notices the expiry, or a concurrent reservation's
  // stale-permit sweep expired it first; both refuse the write.
  const staleCode = syncRejectedCode(staleSync, staleShot["id"] as string);
  v.check(
    staleCode === "access.permit_expired" || staleCode === "access.permit_not_reserved",
    `skew: stale sync → ${JSON.stringify(staleSync.body)}`,
  );
  // Expiring `stale` frees a slot: exactly one new reservation may succeed
  // while `fresh` is still reserved or consumed.
  const newSuccesses = results.filter(
    (r) => r.label.startsWith("reserve-new") && r.status === 200,
  ).length;
  v.check(newSuccesses === 1, `skew: ${newSuccesses} new reservations succeeded (expected 1)`);
  return { results, violations: v.items, detail: { newKeys } };
};

/** Bearer tokens with skewed nbf/exp mixed into a valid burst. */
export const tokenClockSkew: Scenario = async (world, rng) => {
  const actor = await bootstrapActor(world, rng);
  const future = await mintSkewedToken(actor.subject, { notBeforeOffsetSec: rng.int(30, 600) });
  const expired = await mintSkewedToken(actor.subject, { expiresOffsetSec: -rng.int(1, 600) });
  const key = rng.uuid();
  const ops: Op[] = [];
  const n = rng.int(2, 4);
  for (let i = 0; i < n; i++) {
    ops.push(reserveOp(world, actor, key, `valid#${i}`));
    ops.push(reserveOp(world, { ...actor, token: future }, key, `nbf-future#${i}`));
    ops.push(reserveOp(world, { ...actor, token: expired }, key, `expired#${i}`));
  }
  const results = await burst(rng, world, ops);
  const v = new Violations();
  v.noServerErrors(results);
  for (const r of results) {
    if (r.label.startsWith("valid"))
      v.check(r.status === 200, `token-skew: ${r.label} → ${r.status} ${r.code}`);
    else v.check(r.status === 401, `token-skew: ${r.label} → ${r.status} ${r.code} (expected 401)`);
  }
  const ledger = await assertLedgerInvariants(world.pool, actor.userId, v);
  v.check(ledger.permits.length === 1, `token-skew: ${ledger.permits.length} permits for one key`);
  return { results, violations: v.items, detail: { n } };
};

/** Exact per-token budget enforcement under a simultaneous burst. */
export const rateLimitExact: Scenario = async (world, rng) => {
  const actor = await bootstrapActor(world, rng);
  const limit = 60;
  const over = rng.int(1, 8);
  const ops = Array.from({ length: limit + over }, (_, i) =>
    inject(world, `analyses#${i}`, {
      method: "POST",
      url: "/v1/analyses",
      headers: auth(actor.token),
      // Deliberately malformed: the route must still count against the
      // expensive budget before validation replies 400.
      payload: { nope: true },
    }),
  );
  const results = await burst(rng, world, ops, 2);
  const v = new Violations();
  v.noServerErrors(results);
  v.statusIn(results, [400, 429]);
  const limited = results.filter((r) => r.status === 429).length;
  v.check(
    limited === over,
    `rate-limit: ${limited} requests limited out of ${limit + over} (expected ${over})`,
  );
  return { results, violations: v.items, detail: { over } };
};

export const SCENARIOS: Record<string, Scenario> = {
  "permit.reserve.burst": permitReserveBurst,
  "shots.sync.exact_replay": shotSyncExactReplay,
  "shots.sync.permit_reuse": shotSyncPermitReuse,
  "free_rating.double_spend": freeRatingDoubleSpend,
  "permit.finalize.race": permitFinalizeRace,
  "shots.sync.vs_cancel": shotSyncVersusCancel,
  "analysis.create.duplicate": analysisCreateDuplicate,
  "bootstrap.duplicate": bootstrapDuplicate,
  "profile.handle.race": handleClaimRace,
  "friend.request.cross": friendRequestCross,
  "account.delete.duplicate": accountDeleteDuplicate,
  "onboarding.duplicate": onboardingDuplicate,
  "session.create_finalize": sessionCreateAndFinalize,
  "account.delete_during_requests": deleteDuringRequests,
  "permit.clock_skew": permitClockSkew,
  "token.clock_skew": tokenClockSkew,
  "rate_limit.exact": rateLimitExact,
};

export const SCENARIO_NAMES = Object.keys(SCENARIOS);

export { accessLedger };
