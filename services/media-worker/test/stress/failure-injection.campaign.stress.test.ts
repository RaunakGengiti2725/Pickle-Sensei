import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import pg from "pg";
import { runMigrations, seed } from "@pickle/database";
import { InMemoryJobQueue } from "@pickle/queue";
import { QueueSloMonitor } from "@pickle/slo";
import { findPrivacyViolations } from "@pickle/analytics";
import { processDeletionTasks, runOnce, type WorkerDeps } from "../../src/worker.js";
import {
  FAULT_TARGETS,
  FaultInjector,
  InventoryStore,
  RecordingAnalytics,
  SeededRng,
  TARGET_MODES,
  bounded,
  envInt,
  inventoryTranscoder,
  wrapLog,
  wrapPool,
  wrapQueue,
  wrapStore,
  wrapTranscoder,
  writeTable,
  type CampaignTable,
  type FaultPlan,
  type FaultTarget,
  type ScenarioResult,
} from "./faultKit.js";

/**
 * Seeded failure-injection campaign for the media worker against a REAL
 * PostgreSQL schema (transcode, purge, deletion workflow, retention, sweep).
 *
 * Each iteration: build a fresh fixture for one scenario, arm ONE fault
 * (target × mode × n-th call × variant, all derived from the seed), run a
 * worker cycle under a hard wall-clock bound, then clear the fault and run
 * recovery cycles. The oracle checks the durable end state:
 *   - no fake success (a task/job is only "done" when its effect happened)
 *   - no silent loss (objects purged, dataset items removed, tasks converge)
 *   - no collateral damage (bystander users/assets/objects untouched)
 *   - no corrupted persisted state (enum statuses, attempt caps)
 *   - the faulted cycle either settles or is a recorded hang (never a suite hang)
 *
 *   STRESS_ITER=<n>   iterations (default 60; campaign runs used 1200)
 *   STRESS_SEED=<n>   base seed (default 20260904); iteration i uses seed base+i
 *   STRESS_OUT=<path> where to write the JSON seed→outcome table
 *   STRESS_EXPECT_HELD=1 fail the test on ANY BROKEN row (default: only
 *                     unknown defect classes fail; known classes are pinned
 *                     in failure-injection.targeted.stress.test.ts)
 */

const testUrl = process.env["DATABASE_URL_TEST"];
const ITER = envInt("STRESS_ITER", 60);
const BASE_SEED = envInt("STRESS_SEED", 20260904);
const OUT =
  process.env["STRESS_OUT"] ??
  join(process.cwd(), "artifacts", "stress", "failure-injection-campaign.json");
const RECOVERY_CYCLES = 6;
const CYCLE_BOUND_MS = 1500;

function gitHead(): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

const schemaName = `worker_stress_${process.pid}_${randomUUID().replaceAll("-", "")}`;
const migrationsDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
  "packages",
  "database",
  "migrations",
);

function schemaUrl(base: string, schema: string): string {
  const url = new URL(base);
  url.searchParams.set("options", `-c search_path=${schema}`);
  return url.toString();
}

/** Defect classes the oracle can name; anything else is "unknown" and fails loudly. */
export const KNOWN_DEFECTS = [
  "collateral_object_deleted",
  "retention_audit_gap",
  "dataset_items_left_eligible",
  "derived_orphaned_by_listing",
] as const;

interface Fixture {
  name: string;
  userIds: string[];
  assetIds: string[];
  itemIds: string[];
  /** Object-key prefixes that must be gone at the end. */
  mustPurge: string[];
  /** Exact keys that must still exist at the end (bystanders / live masters). */
  mustKeep: string[];
  /** Assets whose deleted_at must be set (retention). */
  mustExpire: string[];
  /** Assets that must still be live. */
  mustStayLive: string[];
  /** Dataset items whose removed_at must be set. */
  itemsMustRemove: string[];
  /** Deletion-task user whose workflow must fully complete (user row gone). */
  deletionUser: string | null;
  bystanderUser: string | null;
  /** Live assets that must end ready|failed with master kept. */
  processed: string[];
  /** Jobs that are expected to stay on the queue (poison). */
  poisonJobs: number;
  run: (deps: WorkerDeps) => Promise<unknown>;
}

describe.skipIf(!testUrl)("media worker failure-injection campaign (seeded)", () => {
  let pool: pg.Pool;
  let adminPool: pg.Pool;
  const results: ScenarioResult[] = [];

  beforeAll(async () => {
    adminPool = new pg.Pool({ connectionString: testUrl });
    await adminPool.query(`CREATE SCHEMA ${schemaName}`);
    pool = new pg.Pool({ connectionString: schemaUrl(testUrl!, schemaName), max: 4 });
    await runMigrations(pool, migrationsDir);
    await seed(pool);
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    if (adminPool) {
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
      await adminPool.end();
    }
  });

  // ---------------------------------------------------------------- fixtures
  async function newUser(tag: string, retentionDays: number | null = null): Promise<string> {
    const r = await pool.query("INSERT INTO app_user (auth_subject) VALUES ($1) RETURNING id", [
      `auth0|stress-${tag}-${randomUUID()}`,
    ]);
    const id = r.rows[0].id as string;
    await pool.query(
      "INSERT INTO user_setting (user_id, local_video_retention_days) VALUES ($1, $2)",
      [id, retentionDays],
    );
    return id;
  }

  async function newAsset(
    store: InventoryStore,
    fields: {
      owner: string;
      kind?: string;
      status: string;
      deleted?: boolean;
      withKey?: boolean;
      derived?: boolean;
      createdDaysAgo?: number;
      expiresDaysAgo?: number | null;
    },
  ): Promise<{ id: string; key: string | null }> {
    const key =
      fields.withKey === false ? null : `media/${fields.owner}/${randomUUID()}/master.mp4`;
    const r = await pool.query(
      `INSERT INTO media_asset (owner_user_id, kind, bucket, object_key, status, deleted_at, created_at, expires_at)
       VALUES ($1, $2, 'b', $3, $4, $5,
               now() - make_interval(days => $6::int),
               CASE WHEN $7::int IS NULL THEN NULL ELSE now() - make_interval(days => $7::int) END)
       RETURNING id`,
      [
        fields.owner,
        fields.kind ?? "raw_video",
        key,
        fields.status,
        fields.deleted ? new Date() : null,
        fields.createdDaysAgo ?? 0,
        fields.expiresDaysAgo ?? null,
      ],
    );
    if (key) {
      store.keys.add(key);
      if (fields.derived !== false) {
        store.keys.add(`${key}/normalized.mp4`);
        store.keys.add(`${key}/thumb.jpg`);
      }
    }
    return { id: r.rows[0].id as string, key };
  }

  async function newItem(fields: {
    sourceUser: string | null;
    mediaAsset?: string;
    featureAsset?: string;
  }): Promise<string> {
    const r = await pool.query(
      `INSERT INTO ml_dataset_item (source_user_id, media_asset_id, feature_asset_id, consent_version)
       VALUES ($1, $2, $3, 'v1') RETURNING id`,
      [fields.sourceUser, fields.mediaAsset ?? null, fields.featureAsset ?? null],
    );
    return r.rows[0].id as string;
  }

  async function newTasks(userId: string): Promise<void> {
    for (const kind of [
      "media_purge",
      "ml_dataset_review",
      "social_cleanup",
      "idp_revoke",
      "final_hard_delete",
    ]) {
      await pool.query("INSERT INTO deletion_task (user_id, kind) VALUES ($1, $2)", [userId, kind]);
    }
  }

  function emptyFixture(name: string, run: Fixture["run"]): Fixture {
    return {
      name,
      userIds: [],
      assetIds: [],
      itemIds: [],
      mustPurge: [],
      mustKeep: [],
      mustExpire: [],
      mustStayLive: [],
      itemsMustRemove: [],
      deletionUser: null,
      bystanderUser: null,
      processed: [],
      poisonJobs: 0,
      run,
    };
  }

  const SCENARIOS = [
    "purge_job",
    "process_job",
    "deletion_workflow",
    "sweep_lost_dispatch",
    "retention",
    "mixed_cycle",
  ] as const;
  type ScenarioName = (typeof SCENARIOS)[number];

  async function addPurgeJob(f: Fixture, store: InventoryStore, queue: InMemoryJobQueue) {
    const owner = await newUser("purge");
    f.userIds.push(owner);
    const victim = await newAsset(store, { owner, status: "deleted", deleted: true });
    const bystander = await newAsset(store, { owner, status: "ready" });
    f.assetIds.push(victim.id, bystander.id);
    f.itemIds.push(
      await newItem({ sourceUser: owner, mediaAsset: victim.id }),
      await newItem({ sourceUser: null, featureAsset: victim.id }),
    );
    f.itemsMustRemove.push(...f.itemIds.slice(-2));
    f.mustPurge.push(victim.key!);
    f.mustKeep.push(bystander.key!, `${bystander.key!}/normalized.mp4`);
    f.mustStayLive.push(bystander.id);
    await queue.enqueue("media.purge", { mediaAssetId: victim.id });
  }

  async function addProcessJob(f: Fixture, store: InventoryStore, queue: InMemoryJobQueue) {
    const owner = await newUser("process");
    f.userIds.push(owner);
    const live = await newAsset(store, { owner, status: "processing", derived: false });
    const bystander = await newAsset(store, { owner, status: "ready" });
    f.assetIds.push(live.id, bystander.id);
    f.processed.push(live.id);
    f.mustKeep.push(live.key!, bystander.key!, `${bystander.key!}/normalized.mp4`);
    f.mustStayLive.push(live.id, bystander.id);
    await queue.enqueue("media.process", { mediaAssetId: live.id });
    return bystander.key!;
  }

  async function addDeletionWorkflow(f: Fixture, store: InventoryStore) {
    const victim = await newUser("victim");
    const bystander = await newUser("bystander");
    f.userIds.push(victim, bystander);
    const a1 = await newAsset(store, { owner: victim, status: "ready" });
    const a2 = await newAsset(store, { owner: victim, status: "deleted", deleted: true });
    const b1 = await newAsset(store, { owner: bystander, status: "ready" });
    f.assetIds.push(a1.id, a2.id, b1.id);
    const i1 = await newItem({ sourceUser: victim, mediaAsset: a1.id });
    const i3 = await newItem({ sourceUser: victim, featureAsset: a2.id });
    f.itemIds.push(i1, i3);
    f.itemsMustRemove.push(i1, i3);
    f.mustPurge.push(a1.key!, a2.key!);
    f.mustKeep.push(b1.key!, `${b1.key!}/normalized.mp4`, `${b1.key!}/thumb.jpg`);
    f.mustStayLive.push(b1.id);
    f.deletionUser = victim;
    f.bystanderUser = bystander;
    await newTasks(victim);
  }

  async function addLostDispatch(f: Fixture, store: InventoryStore) {
    const owner = await newUser("sweep");
    f.userIds.push(owner);
    const lost = await newAsset(store, { owner, status: "deleted", deleted: true });
    const bystander = await newAsset(store, { owner, status: "ready" });
    f.assetIds.push(lost.id, bystander.id);
    const item = await newItem({ sourceUser: owner, mediaAsset: lost.id });
    f.itemIds.push(item);
    f.itemsMustRemove.push(item);
    f.mustPurge.push(lost.key!);
    f.mustKeep.push(bystander.key!);
    f.mustStayLive.push(bystander.id);
  }

  async function addRetention(f: Fixture, store: InventoryStore) {
    const owner = await newUser("retention", 7);
    f.userIds.push(owner);
    const userControlled = await newAsset(store, { owner, status: "ready", createdDaysAgo: 10 });
    const fixedWindow = await newAsset(store, {
      owner,
      kind: "share_video",
      status: "ready",
      createdDaysAgo: 40,
    });
    const explicit = await newAsset(store, {
      owner,
      kind: "drill_video",
      status: "ready",
      expiresDaysAgo: 1,
    });
    const fresh = await newAsset(store, { owner, status: "ready", createdDaysAgo: 1 });
    const untilDeleted = await newAsset(store, {
      owner,
      kind: "model_bundle",
      status: "ready",
      createdDaysAgo: 400,
    });
    f.assetIds.push(userControlled.id, fixedWindow.id, explicit.id, fresh.id, untilDeleted.id);
    f.mustExpire.push(userControlled.id, fixedWindow.id, explicit.id);
    f.mustPurge.push(userControlled.key!, fixedWindow.key!, explicit.key!);
    f.mustKeep.push(fresh.key!, untilDeleted.key!);
    f.mustStayLive.push(fresh.id, untilDeleted.id);
  }

  async function buildFixture(
    name: ScenarioName,
    store: InventoryStore,
    queue: InMemoryJobQueue,
  ): Promise<Fixture> {
    const f = emptyFixture(name, (deps) => runOnce(deps));
    switch (name) {
      case "purge_job":
        await addPurgeJob(f, store, queue);
        break;
      case "process_job":
        await addProcessJob(f, store, queue);
        break;
      case "deletion_workflow":
        await addDeletionWorkflow(f, store);
        f.run = (deps) => processDeletionTasks(deps);
        break;
      case "sweep_lost_dispatch":
        await addLostDispatch(f, store);
        break;
      case "retention":
        await addRetention(f, store);
        break;
      case "mixed_cycle":
        await addPurgeJob(f, store, queue);
        await addProcessJob(f, store, queue);
        await addDeletionWorkflow(f, store);
        await addRetention(f, store);
        await queue.enqueue("share.render", { shotId: randomUUID() });
        f.poisonJobs = 1;
        break;
    }
    return f;
  }

  async function cleanupFixture(f: Fixture): Promise<void> {
    if (f.itemIds.length) {
      await pool.query("DELETE FROM ml_dataset_item WHERE id = ANY($1::uuid[])", [f.itemIds]);
    }
    if (f.userIds.length) {
      await pool.query("DELETE FROM deletion_task WHERE user_id = ANY($1::uuid[])", [f.userIds]);
    }
    if (f.assetIds.length) {
      await pool.query("DELETE FROM media_asset WHERE id = ANY($1::uuid[])", [f.assetIds]);
    }
    if (f.userIds.length) {
      await pool.query("DELETE FROM app_user WHERE id = ANY($1::uuid[])", [f.userIds]);
    }
  }

  // ------------------------------------------------------------------ oracle
  interface OracleResult {
    violations: string[];
    defects: Set<string>;
  }

  async function oracle(
    f: Fixture,
    store: InventoryStore,
    queue: InMemoryJobQueue,
    analytics: RecordingAnalytics,
  ): Promise<OracleResult> {
    const violations: string[] = [];
    const defects = new Set<string>();
    const fail = (msg: string, defect?: string) => {
      violations.push(msg);
      if (defect) defects.add(defect);
    };

    for (const prefix of f.mustPurge) {
      const left = [...store.keys].filter((k) => k === prefix || k.startsWith(`${prefix}/`));
      if (left.length === 0) continue;
      // Master gone but derived objects remain: nothing in the DB points at
      // them any more, so no later sweep can find them.
      const orphanedDerived = !store.keys.has(prefix);
      fail(
        `objects not purged under ${prefix}: ${left.length}${orphanedDerived ? " (derived only; master gone)" : ""}`,
        orphanedDerived ? "derived_orphaned_by_listing" : undefined,
      );
    }
    for (const key of f.mustKeep) {
      if (!store.keys.has(key))
        fail(`collateral: object ${key} was deleted`, "collateral_object_deleted");
    }

    if (f.assetIds.length) {
      const rows = await pool.query(
        "SELECT id, status, object_key, deleted_at FROM media_asset WHERE id = ANY($1::uuid[])",
        [f.assetIds],
      );
      const byId = new Map(
        (
          rows.rows as Array<{
            id: string;
            status: string;
            object_key: string | null;
            deleted_at: Date | null;
          }>
        ).map((r) => [r.id, r]),
      );
      for (const [id, r] of byId) {
        if (
          !["pending", "uploading", "ready", "processing", "failed", "deleted"].includes(r.status)
        )
          fail(`asset ${id} has non-enum status ${r.status}`);
        if (r.deleted_at && r.status !== "deleted" && !f.mustExpire.includes(id))
          fail(`asset ${id} deleted_at set but status ${r.status}`);
      }
      for (const id of f.mustStayLive) {
        const r = byId.get(id);
        if (!r) {
          // Cascaded away only if its owner was the deletion victim (never for bystanders).
          if (!f.deletionUser) fail(`live asset ${id} vanished`);
          continue;
        }
        if (r.deleted_at || r.status === "deleted") fail(`live asset ${id} was deleted`);
        if (!r.object_key) fail(`live asset ${id} lost its object_key`);
      }
      for (const id of f.mustExpire) {
        const r = byId.get(id);
        if (!r) continue;
        if (!r.deleted_at || r.status !== "deleted") fail(`expired asset ${id} not marked deleted`);
        if (r.object_key) fail(`expired asset ${id} still has object_key`);
      }
      for (const id of f.processed) {
        const r = byId.get(id);
        if (!r) {
          fail(`processed asset ${id} vanished`);
          continue;
        }
        if (!["ready", "failed"].includes(r.status))
          fail(`processed asset ${id} stuck in ${r.status}`);
        if (r.status === "ready") {
          for (const derived of ["normalized.mp4", "thumb.jpg"]) {
            if (!store.keys.has(`${r.object_key}/${derived}`))
              fail(`asset ${id} ready but ${derived} missing`);
          }
        }
      }
      // Purged assets: object_key must be NULL once objects are gone.
      const purgedKeys = f.mustPurge;
      for (const r of byId.values()) {
        if (r.object_key && purgedKeys.includes(r.object_key) && r.deleted_at)
          fail(`asset ${r.id} deleted with objects gone but object_key still set`);
      }
    }

    if (f.mustExpire.length) {
      const audit = await pool.query(
        `SELECT target_id FROM audit_log WHERE action = 'media.retention_expired' AND target_id = ANY($1::text[])`,
        [f.mustExpire],
      );
      const audited = new Set((audit.rows as Array<{ target_id: string }>).map((r) => r.target_id));
      for (const id of f.mustExpire) {
        if (!audited.has(id))
          fail(`no audit_log row for expired asset ${id}`, "retention_audit_gap");
      }
    }

    if (f.itemsMustRemove.length) {
      const rows = await pool.query(
        "SELECT id, removed_at FROM ml_dataset_item WHERE id = ANY($1::uuid[])",
        [f.itemsMustRemove],
      );
      for (const r of rows.rows as Array<{ id: string; removed_at: Date | null }>) {
        if (!r.removed_at)
          fail(`dataset item ${r.id} still training-eligible`, "dataset_items_left_eligible");
      }
    }

    if (f.deletionUser) {
      const tasks = await pool.query(
        "SELECT kind, status, attempts, detail FROM deletion_task WHERE user_id = $1",
        [f.deletionUser],
      );
      const rows = tasks.rows as Array<{
        kind: string;
        status: string;
        attempts: number;
        detail: unknown;
      }>;
      if (rows.length !== 5) fail(`deletion tasks for victim: expected 5 rows, got ${rows.length}`);
      for (const t of rows) {
        if (!["queued", "processing", "done", "failed"].includes(t.status))
          fail(`deletion task ${t.kind} has non-enum status ${t.status}`);
        if (t.attempts > 5) fail(`deletion task ${t.kind} exceeded attempt cap: ${t.attempts}`);
        if (t.status !== "done")
          fail(`deletion task ${t.kind} not done (${t.status}, attempts=${t.attempts})`);
      }
      const user = await pool.query("SELECT 1 FROM app_user WHERE id = $1", [f.deletionUser]);
      if (user.rowCount !== 0) fail("victim app_user row still exists");
      // Never a hard delete while objects remain (checked against store inventory).
      const purgeDone = rows.find((t) => t.kind === "media_purge")?.status === "done";
      const remaining = [...store.keys].filter((k) =>
        f.mustPurge.some((p) => k === p || k.startsWith(`${p}/`)),
      );
      if (user.rowCount === 0 && remaining.length)
        fail(`user hard-deleted while ${remaining.length} object(s) remain`);
      if (purgeDone && remaining.length) fail("media_purge done while objects remain");
    }
    if (f.bystanderUser) {
      const user = await pool.query("SELECT 1 FROM app_user WHERE id = $1", [f.bystanderUser]);
      if (user.rowCount !== 1) fail("bystander app_user row was deleted");
    }

    // Queue must drain to exactly the poison jobs.
    queue.expireInFlight();
    const depth = await queue.size();
    if (depth !== f.poisonJobs) fail(`queue depth ${depth}, expected ${f.poisonJobs}`);

    for (const event of analytics.events) {
      const pv = findPrivacyViolations(event);
      if (pv.length) fail(`analytics event ${event.name} leaks: ${JSON.stringify(pv)}`);
    }
    return { violations, defects };
  }

  // -------------------------------------------------------------- deps build
  interface Harness {
    store: InventoryStore;
    queue: InMemoryJobQueue;
    analytics: RecordingAnalytics;
    log: string[];
    slo: QueueSloMonitor;
  }

  function buildDeps(h: Harness, inj: FaultInjector, foreignKey: () => string): WorkerDeps {
    const slo = h.slo;
    const observe = slo.observe.bind(slo);
    const sloProxy = new Proxy(slo, {
      get(target, prop, receiver) {
        if (prop === "observe") {
          return (obs: Parameters<QueueSloMonitor["observe"]>[0]) => {
            const fault = inj.hit("slo.observe");
            if (fault?.mode === "throw") throw new Error("injected: slo monitor threw");
            if (fault?.mode === "malformed") return { kind: "queue_stalled" };
            return observe(obs);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const analytics = new RecordingAnalytics(inj);
    // Share the event list so recovery cycles append to the same record.
    analytics.events = h.analytics.events;
    return {
      pool: wrapPool(pool, inj),
      queue: wrapQueue(h.queue, inj),
      objectStore: wrapStore(h.store, inj),
      transcoder: wrapTranscoder(inventoryTranscoder(h.store), inj, foreignKey),
      log: wrapLog(h.log, inj),
      analytics,
      sloMonitor: sloProxy,
    };
  }

  /** Dry-run call counts per scenario so the n-th call is always reachable. */
  const callCounts = new Map<ScenarioName, Record<FaultTarget, number>>();

  async function dryRun(name: ScenarioName): Promise<Record<FaultTarget, number>> {
    const cached = callCounts.get(name);
    if (cached) return cached;
    const h: Harness = {
      store: new InventoryStore(),
      queue: new InMemoryJobQueue(),
      analytics: new RecordingAnalytics(new FaultInjector(null)),
      log: [],
      slo: new QueueSloMonitor(),
    };
    const f = await buildFixture(name, h.store, h.queue);
    const inj = new FaultInjector(null);
    const deps = buildDeps(h, inj, () => "");
    await f.run(deps);
    const counts = { ...inj.calls, clock: 1 };
    await cleanupFixture(f);
    callCounts.set(name, counts);
    return counts;
  }

  function planFault(rng: SeededRng, counts: Record<FaultTarget, number>): FaultPlan {
    const reachable = FAULT_TARGETS.filter((t) => counts[t] > 0);
    const target = rng.pick(reachable);
    const mode = rng.pick(TARGET_MODES[target]);
    return { target, mode, nth: rng.int(counts[target]), variant: rng.int(9) };
  }

  async function runIteration(seed: number): Promise<ScenarioResult> {
    const rng = new SeededRng(seed);
    const name = rng.pick(SCENARIOS);
    const counts = await dryRun(name);
    const plan = planFault(rng, counts);
    const h: Harness = {
      store: new InventoryStore(),
      queue: new InMemoryJobQueue(),
      analytics: new RecordingAnalytics(new FaultInjector(null)),
      log: [],
      slo: new QueueSloMonitor(),
    };
    const f = await buildFixture(name, h.store, h.queue);
    const foreignKey = () => f.mustKeep[0] ?? `media/foreign/${randomUUID()}/master.mp4`;
    const inj = new FaultInjector(plan);

    let clockFault: "backwards" | "forwards" | null = null;
    if (plan.target === "clock") {
      inj.hit("clock");
      clockFault = plan.variant % 2 === 0 ? "backwards" : "forwards";
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(Date.now() + (clockFault === "backwards" ? -1 : 1) * 3_600_000);
    }
    const faulted = await bounded(() => f.run(buildDeps(h, inj, foreignKey)), CYCLE_BOUND_MS);
    if (clockFault) vi.useRealTimers();

    const clean = new FaultInjector(null);
    let recoveryCycles = 0;
    let verdict = await oracle(f, h.store, h.queue, h.analytics);
    while (verdict.violations.length > 0 && recoveryCycles < RECOVERY_CYCLES) {
      recoveryCycles++;
      const cycle = await bounded(() => f.run(buildDeps(h, clean, foreignKey)), CYCLE_BOUND_MS);
      if (cycle.kind === "hung") {
        verdict.violations.push(`recovery cycle ${recoveryCycles} hung with no fault armed`);
        break;
      }
      verdict = await oracle(f, h.store, h.queue, h.analytics);
    }
    await cleanupFixture(f);

    const outcome = verdict.violations.length === 0 ? "HELD" : "BROKEN";
    const defect =
      outcome === "HELD"
        ? null
        : verdict.defects.size > 0
          ? [...verdict.defects].sort().join("+")
          : "unknown";
    return {
      seed,
      scenario: name,
      fault: clockFault ? { ...plan, variant: clockFault === "backwards" ? 0 : 1 } : plan,
      faultFired: inj.armed?.fired ?? false,
      faulted: faulted.kind,
      faultedMs: faulted.ms,
      recoveryCycles,
      outcome,
      defect,
      violations: verdict.violations,
      log: outcome === "HELD" ? [] : h.log.slice(-8),
    };
  }

  it(
    `runs ${ITER} seeded fault iterations from seed ${BASE_SEED} and converges or names the defect`,
    async () => {
      for (let i = 0; i < ITER; i++) {
        results.push(await runIteration(BASE_SEED + i));
      }
      const defects: Record<string, number[]> = {};
      for (const r of results) {
        if (r.outcome === "BROKEN") (defects[r.defect ?? "unknown"] ??= []).push(r.seed);
      }
      const table: CampaignTable = {
        unit: "svc-media-worker",
        lens: "failure-injection",
        commit: process.env["GITHUB_SHA"] ?? gitHead(),
        generatedAt: new Date().toISOString(),
        iterations: results.length,
        fired: results.filter((r) => r.faultFired).length,
        held: results.filter((r) => r.outcome === "HELD").length,
        broken: results.filter((r) => r.outcome === "BROKEN").length,
        defects,
        results,
      };
      writeTable(OUT, table);

      // The faulted cycle must never hang the suite, and only a `never`
      // fault may leave the cycle unsettled.
      for (const r of results) {
        if (r.faulted === "hung")
          expect(r.fault?.mode, `seed ${r.seed} hung without a never-fault`).toBe("never");
      }
      // A clean recovery cycle must never hang.
      expect(
        results.filter((r) => r.violations.some((v) => v.includes("hung with no fault"))),
      ).toEqual([]);

      const unknown = results.filter((r) => r.outcome === "BROKEN" && r.defect === "unknown");
      expect(unknown, `unclassified BROKEN seeds: ${unknown.map((r) => r.seed).join(",")}`).toEqual(
        [],
      );
      if (process.env["STRESS_EXPECT_HELD"] === "1") {
        expect(table.broken, `BROKEN seeds: ${JSON.stringify(defects)}`).toBe(0);
      }
      expect(results.length).toBe(ITER);
    },
    Math.max(120_000, ITER * 1500),
  );
});
