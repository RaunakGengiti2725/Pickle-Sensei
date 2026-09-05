import { randomUUID } from "node:crypto";
import pg from "pg";
import { InMemoryJobQueue, type JobEnvelope } from "@pickle/queue";
import {
  enforceMediaRetention,
  handleJob,
  processDeletionTasks,
  sweepDeletedMedia,
  type WorkerDeps,
} from "../../src/worker.js";
import {
  isDatasetItemTrainingEligible,
  latestEligibilityEntries,
  recordTrainingEligibility,
  selectTrainingEligibleItemsWithWatermark,
  verifyTrainingEligibility,
  type TrainingEligibleItem,
} from "../../src/trainingConsent.js";
import {
  DeadlockLog,
  Rng,
  Scheduler,
  StressStore,
  makeActor,
  scheduledPool,
  settleAll,
  type Actor,
  type IterationResult,
} from "./harness.js";

type JobOutcome = Awaited<ReturnType<typeof handleJob>>;

/**
 * Concurrency stress scenarios for services/media-worker. Each scenario is a
 * pure function of (pool, seed) and returns violations + metrics; the suite
 * decides how many seeds to run and where to write the seed → outcome table.
 *
 * Scenarios:
 *  purge_dup            duplicate / call-during-call media.purge on one asset,
 *                       plus concurrent deleted-media sweeps (two actors, one row)
 *  process_vs_delete    media.process racing an API-side delete + purge (+ crash
 *                       injection, at-least-once redelivery)
 *  deletion_workflow    N workers running processDeletionTasks concurrently over
 *                       1–3 accounts with duplicate/queued/processing/failed rows,
 *                       transient store failures and one crashing worker
 *  outage_attempts      store outage during a concurrent deletion cycle: does the
 *                       retry budget survive one outage?
 *  retention_burst      concurrent enforceMediaRetention over expired /
 *                       borderline / future assets (clock-skew tolerant)
 *  consent_race         training selection → verify → record racing a consent
 *                       withdrawal (duplicate trainers)
 */

export const SCENARIOS = [
  "purge_dup",
  "process_vs_delete",
  "deletion_workflow",
  "outage_attempts",
  "retention_burst",
  "consent_race",
] as const;
export type ScenarioName = (typeof SCENARIOS)[number];

export interface ScenarioContext {
  pool: pg.Pool;
  seed: number;
  index: number;
}

interface ScenarioOutput {
  violations: string[];
  params: Record<string, unknown>;
  metrics: Record<string, number | string | boolean | null>;
}

const noopLog = (): void => {};

async function createUser(pool: pg.Pool, tag: string): Promise<string> {
  const { rows } = await pool.query(
    "INSERT INTO app_user (auth_subject) VALUES ($1) RETURNING id",
    [`auth0|stress-${tag}-${randomUUID()}`],
  );
  return rows[0].id as string;
}

async function createAsset(
  pool: pg.Pool,
  ownerId: string,
  key: string,
  status: "ready" | "deleted" | "processing",
  extra: { kind?: string; expiresAt?: string | null; createdAt?: string | null } = {},
): Promise<string> {
  const kind = extra.kind ?? "raw_video";
  const { rows } = await pool.query(
    `INSERT INTO media_asset (owner_user_id, kind, bucket, object_key, status, deleted_at, expires_at, created_at)
     VALUES ($1, $2, 'b', $3, $4, CASE WHEN $4 = 'deleted' THEN now() END,
             $5::timestamptz, COALESCE($6::timestamptz, now()))
     RETURNING id`,
    [ownerId, kind, key, status, extra.expiresAt ?? null, extra.createdAt ?? null],
  );
  return rows[0].id as string;
}

/**
 * Housekeeping so the shared schema cannot starve a later iteration: stale
 * deletion tasks (window of 20) and stale deleted rows with keys (sweep
 * window of 50) from earlier seeds are cleared before each iteration.
 */
async function resetSharedWindows(pool: pg.Pool): Promise<void> {
  await pool.query("DELETE FROM deletion_task");
  await pool.query(
    "UPDATE media_asset SET object_key = NULL WHERE deleted_at IS NOT NULL AND object_key IS NOT NULL",
  );
}

function baseDeps(
  pool: pg.Pool,
  store: StressStore | null,
  queue: InMemoryJobQueue,
  transcoder: WorkerDeps["transcoder"] = null,
): WorkerDeps {
  return { pool, queue, objectStore: store, transcoder, log: noopLog };
}

function actorDeps(
  real: pg.Pool,
  sched: Scheduler,
  store: StressStore,
  actor: Actor,
  errors: DeadlockLog,
  queue: InMemoryJobQueue,
  extra: { transcoder?: WorkerDeps["transcoder"]; hook?: Parameters<typeof scheduledPool>[4] } = {},
): WorkerDeps {
  return {
    pool: scheduledPool(real, sched, actor, errors, extra.hook),
    queue,
    objectStore: store.forActor(actor),
    transcoder: extra.transcoder ?? null,
    log: noopLog,
  };
}

function purgeJob(mediaAssetId: string): JobEnvelope {
  return { id: randomUUID(), kind: "media.purge", payload: { mediaAssetId }, attempt: 1 };
}

function processJob(mediaAssetId: string): JobEnvelope {
  return { id: randomUUID(), kind: "media.process", payload: { mediaAssetId }, attempt: 1 };
}

// ---------------------------------------------------------------------------
// purge_dup
// ---------------------------------------------------------------------------

async function purgeDup(ctx: ScenarioContext): Promise<ScenarioOutput> {
  const { pool, seed } = ctx;
  const rng = new Rng(seed);
  const sched = new Scheduler(new Rng(seed ^ 0x9e3779b9));
  const store = new StressStore(sched);
  const errors = new DeadlockLog();
  const queue = new InMemoryJobQueue();

  const purgers = rng.int(2, 6);
  const sweepers = rng.int(0, 2);
  const derivedCount = rng.int(0, 3);
  const datasetItems = rng.int(0, 2);
  const crashOne = rng.chance(0.25);
  const crashAt = crashOne ? rng.int(1, 6) : null;

  await resetSharedWindows(pool);
  const userId = await createUser(pool, "purge");
  const key = `media/${userId}/${randomUUID()}`;
  const assetId = await createAsset(pool, userId, key, "deleted");
  store.keys.add(key);
  const expectedKeys = [key];
  for (let i = 0; i < derivedCount; i++) {
    const derived = `${key}/derived-${i}`;
    store.keys.add(derived);
    expectedKeys.push(derived);
  }
  const itemIds: string[] = [];
  for (let i = 0; i < datasetItems; i++) {
    const { rows } = await pool.query(
      `INSERT INTO ml_dataset_item (source_user_id, media_asset_id, consent_version)
       VALUES ($1, $2, 'v1') RETURNING id`,
      [userId, assetId],
    );
    itemIds.push(rows[0].id as string);
  }

  const runs: Array<Promise<JobOutcome | number>> = [];
  const actors: Actor[] = [];
  for (let i = 0; i < purgers; i++) {
    const actor = makeActor(`purge-${i}`, i === 0 ? crashAt : null);
    actors.push(actor);
    runs.push(handleJob(actorDeps(pool, sched, store, actor, errors, queue), purgeJob(assetId)));
  }
  for (let i = 0; i < sweepers; i++) {
    const actor = makeActor(`sweep-${i}`);
    actors.push(actor);
    runs.push(sweepDeletedMedia(actorDeps(pool, sched, store, actor, errors, queue)));
  }
  const settled = await settleAll(runs);

  // Convergence: redeliver once on a fresh worker (at-least-once queue).
  const redelivered = await handleJob(baseDeps(pool, store, queue), purgeJob(assetId));

  const violations: string[] = [];
  const asset = await pool.query(
    "SELECT object_key, status, deleted_at FROM media_asset WHERE id = $1",
    [assetId],
  );
  const row = asset.rows[0] as {
    object_key: string | null;
    status: string;
    deleted_at: Date | null;
  };
  if (row.object_key !== null) violations.push("object_key_not_nulled");
  if (row.status !== "deleted") violations.push(`status_changed:${row.status}`);
  const remaining = store.keysUnder(key);
  if (remaining.length > 0) violations.push(`orphan_objects:${remaining.length}`);
  const items = await pool.query(
    "SELECT count(*)::int AS n FROM ml_dataset_item WHERE media_asset_id = $1 AND removed_at IS NULL",
    [assetId],
  );
  if ((items.rows[0] as { n: number }).n > 0) violations.push("dataset_items_not_removed");
  const nonInjected = settled.filter((s) => !s.ok && !s.injected);
  if (nonInjected.length > 0)
    violations.push(`actor_error:${nonInjected[0]?.ok === false ? nonInjected[0].error : ""}`);
  if (!redelivered.handled) violations.push("redelivery_not_handled");
  if (errors.deadlocks.length > 0) violations.push(`deadlock:${errors.deadlocks.length}`);

  const uniqueDeleted = new Set(store.deleteCalls);
  return {
    violations,
    params: { purgers, sweepers, derivedCount, datasetItems, crashAt },
    metrics: {
      handled: settled.filter((s) => s.ok && typeof s.value === "object" && s.value.handled).length,
      deleteCalls: store.deleteCalls.length,
      redundantDeletes: store.deleteCalls.length - uniqueDeleted.size,
      expectedKeys: expectedKeys.length,
      crashed: actors.some((a) => a.crashed),
    },
  };
}

// ---------------------------------------------------------------------------
// process_vs_delete
// ---------------------------------------------------------------------------

async function processVsDelete(ctx: ScenarioContext): Promise<ScenarioOutput> {
  const { pool, seed } = ctx;
  const rng = new Rng(seed);
  const sched = new Scheduler(new Rng(seed ^ 0x9e3779b9));
  const store = new StressStore(sched);
  const errors = new DeadlockLog();
  const queue = new InMemoryJobQueue();

  const processors = rng.int(1, 2);
  const deleterRuns = rng.chance(0.75);
  const purgeDispatched = deleterRuns && rng.chance(0.8);
  const sweeperRuns = rng.chance(0.4);
  const processCrashAt = rng.chance(0.25) ? rng.int(1, 6) : null;
  const transcoderYields = rng.int(0, 6);
  const deleterYields = rng.int(0, 8);

  await resetSharedWindows(pool);
  const userId = await createUser(pool, "proc");
  const key = `media/${userId}/${randomUUID()}`;
  const assetId = await createAsset(pool, userId, key, "ready");
  store.keys.add(key);

  let transcodes = 0;
  const transcoder: WorkerDeps["transcoder"] = async ({ objectKey }) => {
    for (let i = 0; i < transcoderYields; i++) await sched.yield();
    transcodes++;
    const normalizedKey = `${objectKey}/normalized.mp4`;
    const thumbnailKey = `${objectKey}/thumb.jpg`;
    store.keys.add(normalizedKey);
    store.keys.add(thumbnailKey);
    return { normalizedKey, thumbnailKey };
  };

  const processActors: Actor[] = [];
  const runs: Array<Promise<unknown>> = [];
  const processResults: Array<Promise<JobOutcome>> = [];
  for (let i = 0; i < processors; i++) {
    const actor = makeActor(`process-${i}`, i === 0 ? processCrashAt : null);
    processActors.push(actor);
    const p = handleJob(
      actorDeps(pool, sched, store, actor, errors, queue, { transcoder }),
      processJob(assetId),
    );
    processResults.push(p);
    runs.push(p);
  }
  let purgeOutcome: JobOutcome | null = null;
  if (deleterRuns) {
    runs.push(
      (async () => {
        for (let i = 0; i < deleterYields; i++) await sched.yield();
        await pool.query(
          "UPDATE media_asset SET status = 'deleted', deleted_at = now() WHERE id = $1",
          [assetId],
        );
        if (purgeDispatched) {
          const actor = makeActor("purge-api");
          purgeOutcome = await handleJob(
            actorDeps(pool, sched, store, actor, errors, queue),
            purgeJob(assetId),
          );
        }
      })(),
    );
  }
  if (sweeperRuns) {
    const actor = makeActor("sweep");
    runs.push(sweepDeletedMedia(actorDeps(pool, sched, store, actor, errors, queue)));
  }
  await settleAll(runs);
  const firstPass = await settleAll(processResults);

  // Convergence: unhandled/crashed deliveries come back (at-least-once); the
  // deleted-media sweep is the reconciliation loop for lost purge dispatches.
  let redeliveries = 0;
  let processHandled = firstPass.some((s) => s.ok && s.value.handled);
  const clean = baseDeps(pool, store, queue, transcoder);
  while (!processHandled && redeliveries < 3) {
    redeliveries++;
    const outcome = await handleJob(clean, processJob(assetId));
    processHandled = outcome.handled;
  }
  if (deleterRuns) {
    await handleJob(clean, purgeJob(assetId));
    await sweepDeletedMedia(clean);
  }

  const violations: string[] = [];
  const asset = await pool.query(
    "SELECT object_key, status, deleted_at FROM media_asset WHERE id = $1",
    [assetId],
  );
  const row = asset.rows[0] as {
    object_key: string | null;
    status: string;
    deleted_at: Date | null;
  };
  const remaining = store.keysUnder(key);
  if (deleterRuns) {
    if (row.status !== "deleted") violations.push(`status_resurrected:${row.status}`);
    if (row.object_key !== null) violations.push("object_key_not_nulled");
    if (remaining.length > 0) violations.push(`orphan_objects:${remaining.join(",")}`);
  } else {
    if (!store.keys.has(key)) violations.push("master_lost");
    if (row.object_key !== key) violations.push("object_key_lost");
    if (row.status !== "ready" && row.status !== "failed")
      violations.push(`status_unexpected:${row.status}`);
    if (row.status === "ready" && !store.keys.has(`${key}/normalized.mp4`))
      violations.push("derived_lost");
  }
  if (!processHandled) {
    const exists = (await pool.query("SELECT 1 FROM media_asset WHERE id = $1", [assetId]))
      .rowCount;
    violations.push(
      `process_job_poison:${exists ? (row.object_key === null ? "row_exists_object_key_null" : "row_exists") : "row_missing"}`,
    );
  }
  if (errors.deadlocks.length > 0) violations.push(`deadlock:${errors.deadlocks.length}`);

  return {
    violations,
    params: {
      processors,
      deleterRuns,
      purgeDispatched,
      sweeperRuns,
      processCrashAt,
      transcoderYields,
      deleterYields,
    },
    metrics: {
      transcodes,
      redeliveries,
      finalStatus: row.status,
      purgeHandled: purgeOutcome === null ? null : (purgeOutcome as JobOutcome).handled,
      crashed: processActors.some((a) => a.crashed),
      remainingObjects: remaining.length,
    },
  };
}

// ---------------------------------------------------------------------------
// deletion_workflow
// ---------------------------------------------------------------------------

const TASK_KINDS = [
  "media_purge",
  "ml_dataset_review",
  "social_cleanup",
  "idp_revoke",
  "final_hard_delete",
] as const;

interface Victim {
  id: string;
  prefix: string;
  assetIds: string[];
  itemIds: string[];
  taskIds: string[];
}

async function converge(
  pool: pg.Pool,
  store: StressStore,
  maxCycles: number,
): Promise<{ cycles: number; pending: number }> {
  const deps = baseDeps(pool, store, new InMemoryJobQueue());
  let cycles = 0;
  let previous = -1;
  for (; cycles < maxCycles; cycles++) {
    await processDeletionTasks(deps);
    const { rows } = await pool.query(
      "SELECT count(*)::int AS n FROM deletion_task WHERE status <> 'done'",
    );
    const pending = (rows[0] as { n: number }).n;
    if (pending === 0) return { cycles: cycles + 1, pending: 0 };
    if (pending === previous) {
      // No progress: either exhausted retries or a blocked final step.
      const stuck = await pool.query(
        `SELECT count(*)::int AS n FROM deletion_task
         WHERE status <> 'done' AND NOT (status = 'failed' AND attempts >= 5)`,
      );
      if ((stuck.rows[0] as { n: number }).n === 0) return { cycles: cycles + 1, pending };
    }
    previous = pending;
  }
  const { rows } = await pool.query(
    "SELECT count(*)::int AS n FROM deletion_task WHERE status <> 'done'",
  );
  return { cycles, pending: (rows[0] as { n: number }).n };
}

async function seedVictim(
  pool: pg.Pool,
  store: StressStore,
  rng: Rng,
  opts: { assets: number; derived: number; items: number; friends: number; dupTasks: number },
): Promise<Victim> {
  const id = await createUser(pool, "victim");
  await pool.query("UPDATE app_user SET status = 'deleted' WHERE id = $1", [id]);
  const prefix = `media/${id}`;
  const assetIds: string[] = [];
  for (let i = 0; i < opts.assets; i++) {
    const key = `${prefix}/${randomUUID()}`;
    assetIds.push(await createAsset(pool, id, key, rng.chance(0.3) ? "deleted" : "ready"));
    store.keys.add(key);
    for (let d = 0; d < opts.derived; d++) store.keys.add(`${key}/derived-${d}`);
  }
  const itemIds: string[] = [];
  for (let i = 0; i < opts.items; i++) {
    const { rows } = await pool.query(
      `INSERT INTO ml_dataset_item (source_user_id, media_asset_id, consent_version)
       VALUES ($1, $2, 'v1') RETURNING id`,
      [id, assetIds.length > 0 ? rng.pick(assetIds) : null],
    );
    itemIds.push(rows[0].id as string);
  }
  for (let i = 0; i < opts.friends; i++) {
    const peer = await createUser(pool, "peer");
    await pool.query(
      "INSERT INTO friendship (requester_user_id, addressee_user_id, status) VALUES ($1, $2, 'accepted')",
      rng.chance(0.5) ? [id, peer] : [peer, id],
    );
  }
  const kinds: string[] = rng.shuffle(TASK_KINDS);
  for (let i = 0; i < opts.dupTasks; i++) kinds.push(rng.pick(TASK_KINDS));
  const taskIds: string[] = [];
  for (const kind of kinds) {
    const roll = rng.next();
    const status = roll < 0.7 ? "queued" : roll < 0.85 ? "processing" : "failed";
    const attempts = status === "failed" ? rng.int(1, 4) : 0;
    const { rows } = await pool.query(
      `INSERT INTO deletion_task (user_id, kind, status, attempts) VALUES ($1, $2, $3, $4) RETURNING id`,
      [id, kind, status, attempts],
    );
    taskIds.push(rows[0].id as string);
  }
  return { id, prefix, assetIds, itemIds, taskIds };
}

async function checkVictimGone(
  pool: pg.Pool,
  store: StressStore,
  v: Victim,
  violations: string[],
): Promise<void> {
  const user = await pool.query("SELECT 1 FROM app_user WHERE id = $1", [v.id]);
  if (user.rowCount !== 0) violations.push(`user_not_deleted:${v.id}`);
  const leftover = store.keysUnder(v.prefix);
  if (leftover.length > 0) violations.push(`orphan_objects:${leftover.length}`);
  const tasks = await pool.query(
    "SELECT kind, status, attempts FROM deletion_task WHERE user_id = $1 AND status <> 'done'",
    [v.id],
  );
  for (const t of tasks.rows as Array<{ kind: string; status: string; attempts: number }>) {
    violations.push(
      t.status === "failed" && t.attempts >= 5
        ? `retry_budget_exhausted:${t.kind}:${t.attempts}`
        : `task_not_done:${t.kind}:${t.status}`,
    );
  }
  if (v.itemIds.length > 0) {
    const items = await pool.query(
      "SELECT count(*)::int AS n FROM ml_dataset_item WHERE id = ANY($1::uuid[]) AND removed_at IS NULL",
      [v.itemIds],
    );
    if ((items.rows[0] as { n: number }).n > 0) violations.push("dataset_items_not_removed");
  }
}

async function deletionWorkflow(ctx: ScenarioContext): Promise<ScenarioOutput> {
  const { pool, seed } = ctx;
  const rng = new Rng(seed);
  const sched = new Scheduler(new Rng(seed ^ 0x9e3779b9));
  const store = new StressStore(sched);
  const errors = new DeadlockLog();
  const queue = new InMemoryJobQueue();

  const victims = rng.int(1, 3);
  const workers = rng.int(2, 5);
  const transientFailures = rng.int(0, 3);
  const crashAt = rng.chance(0.25) ? rng.int(1, 40) : null;
  const cyclesPerWorker = rng.int(1, 2);

  await resetSharedWindows(pool);
  const rows: Victim[] = [];
  for (let i = 0; i < victims; i++) {
    rows.push(
      await seedVictim(pool, store, rng, {
        assets: rng.int(0, 3),
        derived: rng.int(0, 2),
        items: rng.int(0, 2),
        friends: rng.int(0, 2),
        dupTasks: rng.int(0, 2),
      }),
    );
  }
  store.plan.transientFailures = transientFailures;

  const orderingViolations: string[] = [];
  let doneRowsReclaimed = 0;
  const hook = async (text: string, params: unknown[] | undefined): Promise<void> => {
    if (text.startsWith("UPDATE deletion_task SET status = 'processing'")) {
      // Claim of a row another worker already finished: terminal state lost.
      const current = await pool.query("SELECT status FROM deletion_task WHERE id = $1", [
        params?.[0],
      ]);
      if ((current.rows[0] as { status: string } | undefined)?.status === "done") {
        doneRowsReclaimed++;
        orderingViolations.push("done_task_reclaimed_as_processing");
      }
      return;
    }
    if (!text.startsWith("DELETE FROM app_user")) return;
    const uid = String(params?.[0]);
    const victim = rows.find((v) => v.id === uid);
    if (!victim) return;
    if (store.keysUnder(victim.prefix).length > 0) {
      orderingViolations.push("hard_delete_with_objects_remaining");
    }
    // A row that was done once and got re-claimed by a stale window is not
    // outstanding work; a row that has never completed is.
    const pending = await pool.query(
      `SELECT count(*)::int AS n FROM deletion_task
       WHERE user_id = $1 AND kind <> 'final_hard_delete' AND status <> 'done'
         AND processed_at IS NULL`,
      [uid],
    );
    if ((pending.rows[0] as { n: number }).n > 0) {
      orderingViolations.push("hard_delete_with_unfinished_tasks");
    }
  };

  const actors: Actor[] = [];
  const runs: Array<Promise<number>> = [];
  for (let w = 0; w < workers; w++) {
    const actor = makeActor(`worker-${w}`, w === 0 ? crashAt : null);
    actors.push(actor);
    const deps = actorDeps(pool, sched, store, actor, errors, queue, { hook });
    runs.push(
      (async () => {
        let n = 0;
        for (let c = 0; c < cyclesPerWorker; c++) n += await processDeletionTasks(deps);
        return n;
      })(),
    );
  }
  const settled = await settleAll(runs);

  const attemptsAfterBurst = await pool.query(
    "SELECT coalesce(max(attempts), 0)::int AS m FROM deletion_task",
  );
  const convergence = await converge(pool, store, 12);

  const violations: string[] = [...new Set(orderingViolations)];
  for (const v of rows) await checkVictimGone(pool, store, v, violations);
  const nonInjected = settled.filter((s) => !s.ok && !s.injected);
  if (nonInjected.length > 0)
    violations.push(`actor_error:${nonInjected[0]?.ok === false ? nonInjected[0].error : ""}`);
  if (errors.deadlocks.length > 0) violations.push(`deadlock:${errors.deadlocks.length}`);

  return {
    violations,
    params: { victims, workers, transientFailures, crashAt, cyclesPerWorker },
    metrics: {
      maxAttemptsAfterBurst: (attemptsAfterBurst.rows[0] as { m: number }).m,
      convergenceCycles: convergence.cycles,
      pendingAfterConvergence: convergence.pending,
      storeFailures: store.failedCalls,
      crashed: actors.some((a) => a.crashed),
      tasks: rows.reduce((n, v) => n + v.taskIds.length, 0),
      doneRowsReclaimed,
    },
  };
}

// ---------------------------------------------------------------------------
// outage_attempts
// ---------------------------------------------------------------------------

async function outageAttempts(ctx: ScenarioContext): Promise<ScenarioOutput> {
  const { pool, seed } = ctx;
  const rng = new Rng(seed);
  const sched = new Scheduler(new Rng(seed ^ 0x9e3779b9));
  const store = new StressStore(sched);
  const errors = new DeadlockLog();
  const queue = new InMemoryJobQueue();

  const workers = rng.int(2, 6);
  const outageCycles = rng.int(1, 3);

  await resetSharedWindows(pool);
  const victim = await seedVictim(pool, store, rng, {
    assets: 1,
    derived: 0,
    items: 0,
    friends: 0,
    dupTasks: 0,
  });
  // Only the purge + the final step: the purge is the one that touches the store.
  await pool.query(
    "DELETE FROM deletion_task WHERE user_id = $1 AND kind NOT IN ('media_purge','final_hard_delete')",
    [victim.id],
  );
  await pool.query("UPDATE deletion_task SET status = 'queued', attempts = 0 WHERE user_id = $1", [
    victim.id,
  ]);

  store.plan.down = true;
  const attemptsPerCycle: number[] = [];
  for (let c = 0; c < outageCycles; c++) {
    const runs: Array<Promise<number>> = [];
    for (let w = 0; w < workers; w++) {
      const actor = makeActor(`worker-${w}`);
      runs.push(processDeletionTasks(actorDeps(pool, sched, store, actor, errors, queue)));
    }
    await settleAll(runs);
    const a = await pool.query(
      "SELECT attempts FROM deletion_task WHERE user_id = $1 AND kind = 'media_purge'",
      [victim.id],
    );
    attemptsPerCycle.push((a.rows[0] as { attempts: number }).attempts);
  }
  store.plan.down = false;
  const convergence = await converge(pool, store, 12);

  const violations: string[] = [];
  await checkVictimGone(pool, store, victim, violations);
  if (errors.deadlocks.length > 0) violations.push(`deadlock:${errors.deadlocks.length}`);
  const attemptsAfterOutage = attemptsPerCycle[attemptsPerCycle.length - 1] ?? 0;

  return {
    violations,
    params: { workers, outageCycles },
    metrics: {
      attemptsAfterOutage,
      attemptsPerCycle: attemptsPerCycle.join(","),
      attemptsPerOutageCycle: outageCycles > 0 ? attemptsAfterOutage / outageCycles : 0,
      convergenceCycles: convergence.cycles,
      pendingAfterConvergence: convergence.pending,
    },
  };
}

// ---------------------------------------------------------------------------
// retention_burst
// ---------------------------------------------------------------------------

async function retentionBurst(ctx: ScenarioContext): Promise<ScenarioOutput> {
  const { pool, seed } = ctx;
  const rng = new Rng(seed);
  const sched = new Scheduler(new Rng(seed ^ 0x9e3779b9));
  const store = new StressStore(sched);
  const errors = new DeadlockLog();
  const queue = new InMemoryJobQueue();

  const workers = rng.int(2, 5);
  const sweepers = rng.int(0, 2);
  const assetCount = rng.int(2, 6);
  const offsets = [-3600, -1, 0.2, 1, 3600];

  await resetSharedWindows(pool);
  // Retention is table-wide: neutralise live rows from earlier seeds so only
  // this iteration's assets can expire during the burst.
  await pool.query(
    "UPDATE media_asset SET expires_at = NULL, created_at = now() WHERE deleted_at IS NULL",
  );
  const userId = await createUser(pool, "ret");
  const retentionDays = rng.chance(0.5) ? rng.int(1, 30) : null;
  await pool.query(
    `INSERT INTO user_setting (user_id, local_video_retention_days) VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET local_video_retention_days = EXCLUDED.local_video_retention_days`,
    [userId, retentionDays],
  );

  const assets: Array<{ id: string; mode: string }> = [];
  for (let i = 0; i < assetCount; i++) {
    const key = `media/${userId}/${randomUUID()}`;
    store.keys.add(key);
    const roll = rng.next();
    if (roll < 0.6) {
      const offset = rng.pick(offsets);
      const id = await createAsset(pool, userId, key, "ready", {
        expiresAt: new Date(Date.now() + offset * 1000).toISOString(),
      });
      assets.push({ id, mode: `explicit:${offset}` });
    } else if (roll < 0.8) {
      const ageDays = rng.pick([1, 29, 31, 400]);
      const id = await createAsset(pool, userId, key, "ready", {
        kind: "share_video",
        createdAt: new Date(Date.now() - ageDays * 86400_000).toISOString(),
      });
      assets.push({ id, mode: `fixed:${ageDays}` });
    } else {
      const ageDays = rng.pick([0, 5, 45]);
      const id = await createAsset(pool, userId, key, "ready", {
        createdAt: new Date(Date.now() - ageDays * 86400_000).toISOString(),
      });
      assets.push({ id, mode: `user:${ageDays}` });
    }
  }

  const t0 = (await pool.query("SELECT clock_timestamp() AS t")).rows[0].t as Date;
  const retentionRuns: Array<Promise<number>> = [];
  const sweepRuns: Array<Promise<number>> = [];
  for (let w = 0; w < workers; w++) {
    const actor = makeActor(`retention-${w}`);
    retentionRuns.push(enforceMediaRetention(actorDeps(pool, sched, store, actor, errors, queue)));
  }
  for (let s = 0; s < sweepers; s++) {
    const actor = makeActor(`sweep-${s}`);
    sweepRuns.push(sweepDeletedMedia(actorDeps(pool, sched, store, actor, errors, queue)));
  }
  const [settled, sweeps] = await Promise.all([settleAll(retentionRuns), settleAll(sweepRuns)]);
  const t1 = (await pool.query("SELECT clock_timestamp() AS t")).rows[0].t as Date;

  const violations: string[] = [];
  const reportedExpired = settled.reduce((n, s) => n + (s.ok ? s.value : 0), 0);
  const swept = sweeps.reduce((n, s) => n + (s.ok ? s.value : 0), 0);
  const nonInjected = [...settled, ...sweeps].filter((s) => !s.ok);
  if (nonInjected.length > 0)
    violations.push(`actor_error:${nonInjected[0]?.ok === false ? nonInjected[0].error : ""}`);

  // Drain the queue to count purge dispatches per asset.
  const purgeCounts = new Map<string, number>();
  const received = await queue.receive(1000);
  for (const { job, ack } of received) {
    const id = (job.payload as { mediaAssetId: string }).mediaAssetId;
    purgeCounts.set(id, (purgeCounts.get(id) ?? 0) + 1);
    await ack();
  }

  let actuallyExpired = 0;
  for (const a of assets) {
    const row = (
      await pool.query(
        `SELECT status, deleted_at, expires_at, kind, created_at,
                (SELECT count(*)::int FROM audit_log
                  WHERE action = 'media.retention_expired' AND target_id = $2) AS audits
         FROM media_asset WHERE id = $1::uuid`,
        [a.id, a.id],
      )
    ).rows[0] as {
      status: string;
      deleted_at: Date | null;
      expires_at: Date | null;
      kind: string;
      created_at: Date;
      audits: number;
    };
    const expiryAt = expectedExpiry(row, retentionDays);
    const mustExpire = expiryAt !== null && expiryAt.getTime() <= t0.getTime();
    const mayExpire = expiryAt !== null && expiryAt.getTime() <= t1.getTime();
    const expired = row.deleted_at !== null;
    if (expired) actuallyExpired++;
    const purges = purgeCounts.get(a.id) ?? 0;
    if (mustExpire && !expired) violations.push(`not_expired:${a.mode}`);
    if (!mayExpire && expired) violations.push(`expired_early:${a.mode}`);
    if (expired) {
      if (row.status !== "deleted") violations.push(`expired_status:${row.status}`);
      if (row.audits !== 1) violations.push(`audit_count:${row.audits}:${a.mode}`);
      if (purges !== 1) violations.push(`purge_dispatch_count:${purges}:${a.mode}`);
    } else if (row.audits !== 0 || purges !== 0) {
      violations.push(`side_effects_without_expiry:${a.mode}`);
    }
  }
  if (reportedExpired !== actuallyExpired) {
    violations.push(`expired_count_mismatch:reported=${reportedExpired},actual=${actuallyExpired}`);
  }
  if (errors.deadlocks.length > 0) violations.push(`deadlock:${errors.deadlocks.length}`);

  return {
    violations,
    params: {
      workers,
      sweepers,
      assetCount,
      retentionDays,
      modes: assets.map((a) => a.mode).join(" "),
    },
    metrics: { reportedExpired, actuallyExpired, swept, burstMs: t1.getTime() - t0.getTime() },
  };
}

function expectedExpiry(
  row: { expires_at: Date | null; kind: string; created_at: Date },
  retentionDays: number | null,
): Date | null {
  if (row.expires_at) return row.expires_at;
  if (row.kind === "share_video") return new Date(row.created_at.getTime() + 30 * 86400_000);
  if (row.kind === "raw_video" && retentionDays !== null && retentionDays > 0) {
    return new Date(row.created_at.getTime() + retentionDays * 86400_000);
  }
  return null;
}

// ---------------------------------------------------------------------------
// consent_race
// ---------------------------------------------------------------------------

async function consentRace(ctx: ScenarioContext): Promise<ScenarioOutput> {
  const { pool, seed } = ctx;
  const rng = new Rng(seed);
  const sched = new Scheduler(new Rng(seed ^ 0x9e3779b9));
  const errors = new DeadlockLog();

  const trainers = rng.int(1, 3);
  const items = rng.int(1, 4);
  const withdraws = rng.chance(0.8);
  const withdrawYields = rng.int(0, 10);
  // Forced interleaving (call-during-call): every trainer verifies BEFORE the
  // withdrawal commits and records AFTER it — the exact window the DB-side
  // withdrawal trigger cannot see.
  const forcedOrder = withdraws && rng.chance(0.3);
  const version = "model-training-v1";

  const userId = await createUser(pool, "consent");
  const subject = await pool.query(
    "INSERT INTO consent_subject (user_id) VALUES ($1) RETURNING pseudonym",
    [userId],
  );
  const pseudonym = subject.rows[0].pseudonym as string;
  await pool.query(
    `INSERT INTO consent_record (subject_pseudonym, scope, action, consent_version, source, capture_mode)
     VALUES ($1, 'model_training', 'granted', $2, 'mobile_settings', 'all_captures')`,
    [pseudonym, version],
  );
  const itemIds: string[] = [];
  for (let i = 0; i < items; i++) {
    const { rows } = await pool.query(
      "INSERT INTO ml_dataset_item (source_user_id, consent_version) VALUES ($1, $2) RETURNING id",
      [userId, version],
    );
    itemIds.push(rows[0].id as string);
  }

  // Event clock: a monotonically increasing counter shared by all actors.
  let clock = 0;
  let withdrawCommittedAt: number | null = null;
  let verifiedCount = 0;
  let releaseWithdrawer: () => void = () => {};
  const allVerified = new Promise<void>((resolve) => {
    releaseWithdrawer = resolve;
  });
  let releaseTrainers: () => void = () => {};
  const withdrawDone = new Promise<void>((resolve) => {
    releaseTrainers = resolve;
  });
  const trainerLog: Array<{
    selectAt: number;
    verifyAt: number;
    verified: number;
    recorded: number;
    recordAt: number;
  }> = [];

  const runs: Array<Promise<void>> = [];
  for (let t = 0; t < trainers; t++) {
    const actor = makeActor(`trainer-${t}`);
    const deps = scheduledPool(pool, sched, actor, errors);
    runs.push(
      (async () => {
        const selectAt = ++clock;
        const selection = await selectTrainingEligibleItemsWithWatermark(deps);
        const mine: TrainingEligibleItem[] = selection.items.filter((i) => itemIds.includes(i.id));
        await sched.yield();
        const verifyAt = ++clock;
        const verified = await verifyTrainingEligibility(deps, mine);
        if (forcedOrder) {
          if (++verifiedCount === trainers) releaseWithdrawer();
          await withdrawDone;
        }
        await sched.yield();
        const recordAt = ++clock;
        const recorded = await recordTrainingEligibility(deps, verified, { analysisId: null });
        trainerLog.push({ selectAt, verifyAt, verified: verified.length, recorded, recordAt });
      })(),
    );
  }
  if (withdraws) {
    runs.push(
      (async () => {
        if (forcedOrder) await allVerified;
        else for (let i = 0; i < withdrawYields; i++) await sched.yield();
        await pool.query(
          `INSERT INTO consent_record (subject_pseudonym, scope, action, consent_version, source)
           VALUES ($1, 'model_training', 'withdrawn', $2, 'privacy_center')`,
          [pseudonym, version],
        );
        withdrawCommittedAt = ++clock;
        releaseTrainers();
      })(),
    );
  }
  const settled = await settleAll(runs);

  const violations: string[] = [];
  const nonInjected = settled.filter((s) => !s.ok);
  if (nonInjected.length > 0)
    violations.push(`actor_error:${nonInjected[0]?.ok === false ? nonInjected[0].error : ""}`);

  const latest = await latestEligibilityEntries(pool, itemIds);
  let latestEligibleAfterWithdrawal = 0;
  for (const id of itemIds) {
    const eligible = await isDatasetItemTrainingEligible(pool, id);
    if (withdraws) {
      if (eligible) violations.push("eligible_after_withdrawal");
      const entry = latest.get(id);
      if (entry && entry.state === "eligible") latestEligibleAfterWithdrawal++;
    } else if (!eligible) {
      violations.push("ineligible_without_withdrawal");
    }
  }
  if (latestEligibleAfterWithdrawal > 0) {
    violations.push(`ledger_latest_eligible_after_withdrawal:${latestEligibleAfterWithdrawal}`);
  }
  for (const t of trainerLog) {
    if (withdrawCommittedAt !== null && t.verifyAt > withdrawCommittedAt && t.verified > 0) {
      violations.push("verify_missed_committed_withdrawal");
    }
    if (!withdraws && t.verified !== items)
      violations.push(`verified_short:${t.verified}/${items}`);
    if (t.recorded !== t.verified)
      violations.push(`record_count_mismatch:${t.recorded}/${t.verified}`);
  }
  const ledgerRows = await pool.query(
    "SELECT count(*)::int AS n FROM training_eligibility_ledger WHERE subject_pseudonym = $1",
    [pseudonym],
  );
  if (errors.deadlocks.length > 0) violations.push(`deadlock:${errors.deadlocks.length}`);

  return {
    violations: [...new Set(violations)],
    params: { trainers, items, withdraws, withdrawYields, forcedOrder },
    metrics: {
      withdrawCommittedAt,
      trainerEvents: trainerLog
        .map((t) => `${t.selectAt}/${t.verifyAt}/${t.recordAt}:${t.verified}`)
        .join(" "),
      ledgerEntries: (ledgerRows.rows[0] as { n: number }).n,
      latestEligibleAfterWithdrawal,
    },
  };
}

// ---------------------------------------------------------------------------

const RUNNERS: Record<ScenarioName, (ctx: ScenarioContext) => Promise<ScenarioOutput>> = {
  purge_dup: purgeDup,
  process_vs_delete: processVsDelete,
  deletion_workflow: deletionWorkflow,
  outage_attempts: outageAttempts,
  retention_burst: retentionBurst,
  consent_race: consentRace,
};

export async function runScenario(
  name: ScenarioName,
  ctx: ScenarioContext,
): Promise<Omit<IterationResult, "durationMs" | "ok">> {
  try {
    const out = await RUNNERS[name](ctx);
    return { scenario: name, seed: ctx.seed, index: ctx.index, ...out };
  } catch (error) {
    return {
      scenario: name,
      seed: ctx.seed,
      index: ctx.index,
      violations: [`harness_error:${String(error)}`],
      params: {},
      metrics: {},
    };
  }
}
