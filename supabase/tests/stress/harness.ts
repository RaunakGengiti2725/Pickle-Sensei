/**
 * Seeded concurrency stress harness for the db-apply-synced-shot unit:
 * apply_synced_shot(jsonb) + enforce_scored_shot_permit + shots /
 * shot_phases / shot_measurements / shot_checkpoints, driven on a REAL
 * disposable postgres:16 (./stress_pg_up.sh) with N independent connections
 * released from a barrier.
 *
 * Every iteration is one interleaving: a seeded scheduler derives the
 * scenario, the lane count, each lane's arrival delay (server-side
 * pg_sleep), how long it holds its transaction open after the RPC (which
 * stretches the per-user advisory xact lock so later lanes genuinely block
 * behind an in-flight call), whether it commits or rolls back (client abort
 * after the server answered), whether a control connection cancels its
 * backend mid-call (pg_cancel_backend), and its isolation level. All of it
 * comes from one 32-bit seed per iteration, so any iteration replays with
 * STRESS_SEED=<base> STRESS_REPLAY=<iter>.
 *
 * Invariants are checked after every iteration from the owner role AND from
 * each user's authenticated RLS context: idempotency, no double spend of
 * free ratings / permits, no duplicate or partial rows, no lost update
 * (ledger + rank derived state), no deadlock / bounded wall time, no
 * cross-user leakage or permanent rejection of a row the server holds.
 */
import postgres from "postgres";

export type Sql = ReturnType<typeof postgres>;
/** Anything that can run `unsafe` SQL: the pool, a reserved connection or a transaction. */
export type Conn = Pick<Sql, "unsafe">;

// ────────────────────────────────────────────────────────────────────────────
// Seeded RNG
// ────────────────────────────────────────────────────────────────────────────

export function mix32(a: number, b: number): number {
  let h = (a ^ Math.imul(b + 0x9e3779b9, 0x85ebca6b)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

export class Prng {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0 || 0x1234567;
  }
  /** mulberry32 */
  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(lo: number, hi: number): number {
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  pick<T>(arr: readonly T[]): T {
    return arr[this.int(0, arr.length - 1)];
  }
  shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = this.int(0, i);
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }
  uuid(): string {
    const b: number[] = [];
    for (let i = 0; i < 16; i++) b.push(this.int(0, 255));
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = b.map((x) => x.toString(16).padStart(2, "0")).join("");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(
      16,
      20,
    )}-${h.slice(20)}`;
  }
}

const enc = new TextEncoder();
/** Line writer for CLI output (eslint forbids console.log outside *.test.ts). */
export function stdout(line: string): void {
  Deno.stdout.writeSync(enc.encode(line + "\n"));
}

export function envInt(name: string, dflt: number): number {
  const v = Deno.env.get(name);
  if (v === undefined || v === "") return dflt;
  const n = Number(v);
  if (!Number.isFinite(n)) {
    throw new Error(`${name} must be a number, got ${v}`);
  }
  return n;
}

// ────────────────────────────────────────────────────────────────────────────
// Payloads
// ────────────────────────────────────────────────────────────────────────────

export const VERSION_VECTOR = {
  appVersion: "1.0.0",
  modelBundleVersion: "bundle-1",
  poseModelVersion: "pose-1",
  paddleModelVersion: "paddle-1",
  strokeDetectorVersion: "stroke-1",
  phaseModelVersion: "phase-1",
  scoringModelVersion: "scoring-1",
  shotConfigVersion: "config-1",
};

const PHASE_KEYS = ["ready", "prepare", "accelerate", "contact", "follow_through", "recover"];
const CHECKPOINT_KEYS = ["paddle_height", "knee_bend", "contact_point", "follow_through_length"];
const SHOT_TYPES = ["dink", "drive", "third_shot_drop", "serve", "volley"];

export interface Payload extends Record<string, unknown> {
  id: string;
  analysisPermitId: string;
  sessionId: string | null;
  resultKind: "scored" | "low_confidence";
  phases: Array<Record<string, unknown>>;
  checkpoints: Array<Record<string, unknown>>;
}

export function makePayload(
  prng: Prng,
  id: string,
  permitId: string,
  opts: {
    resultKind?: "scored" | "low_confidence";
    sessionId?: string | null;
    capturedAt?: string;
  } = {},
): Payload {
  const resultKind = opts.resultKind ?? "scored";
  const nPhases = prng.int(0, 4);
  const nCps = prng.int(0, 4);
  const phases = prng
    .shuffle([...PHASE_KEYS])
    .slice(0, nPhases)
    .map((key, i) => ({
      key,
      startMs: i * 50,
      representativeMs: i * 50 + 20,
      endMs: i * 50 + 49,
      confidence: 0.8,
    }));
  const checkpoints = prng
    .shuffle([...CHECKPOINT_KEYS])
    .slice(0, nCps)
    .map((key) => ({
      key,
      score: prng.int(0, 100),
      confidence: 0.75,
      band: prng.pick(["green", "yellow", "red"]),
      direction: "up",
      severity: 0.25,
      applicable: true,
    }));
  return {
    id,
    analysisPermitId: permitId,
    sessionId: opts.sessionId ?? null,
    shotType: prng.pick(SHOT_TYPES),
    cameraView: prng.pick(["side", "rear_oblique"]),
    capturedAt: opts.capturedAt ?? "2026-09-01T10:00:00.000Z",
    startMs: 0,
    contactMs: resultKind === "scored" ? 100 : null,
    endMs: 200,
    overallScore: resultKind === "scored" ? prng.int(10, 100) / 10 : null,
    confidence: resultKind === "scored" ? 0.9 : 0.3,
    resultKind,
    phases,
    checkpoints,
    versionVector: VERSION_VECTOR,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Lanes
// ────────────────────────────────────────────────────────────────────────────

export type LaneOp =
  | "apply"
  | "reserve"
  | "direct_insert"
  | "detail_insert"
  | "measurement_insert"
  | "blocker"
  | "delete_user"
  | "tamper_then_apply"
  | "session_insert"
  | "session_delete"
  | "sweep_permits"
  | "access_state";

export interface LaneSpec {
  lane: number;
  /** JWT sub for role authenticated; "" → no sub (auth.required path); ignored for role owner */
  user: string;
  role: "authenticated" | "owner";
  op: LaneOp;
  payload?: Payload;
  shotId?: string;
  permitId?: string;
  key?: string;
  sessionId?: string;
  detailKey?: string;
  /** scenario-private label (e.g. stale_identity) carried into the result */
  tag?: string;
  preDelayMs: number;
  holdMs: number;
  finish: "commit" | "rollback";
  isolation: "read committed" | "serializable";
  cancelAtMs?: number;
}

export interface LaneResult {
  lane: number;
  op: LaneOp;
  user: string;
  shotId?: string;
  permitId?: string;
  tag?: string;
  /** RPC status text, op-specific text, or err:<SQLSTATE> */
  result: string;
  sqlstate?: string;
  committed: boolean;
  cancelled: boolean;
  isolation: string;
  finish: string;
  preDelayMs: number;
  holdMs: number;
  serverStartMs?: number;
  serverEndMs?: number;
  clientMs: number;
}

export const PERMANENT_CODES = new Set([
  "access.permit_not_found",
  "access.permit_not_reserved",
  "access.permit_expired",
  "access.paywall_required",
  "shot.id_conflict",
]);

const LOCK_TIMEOUT_MS = 10_000;

function q(s: string): string {
  return s.replaceAll("'", "''");
}

export async function asUser(c: Conn, userId: string): Promise<void> {
  await c.unsafe(`set local role authenticated`);
  // Hosted auth.uid() reads request.jwt.claims (JSON); the test shim reads
  // request.jwt.claim.sub. Set both so the same lane runs on either.
  await c.unsafe(
    `set local request.jwt.claims = '${q(JSON.stringify({ sub: userId, role: "authenticated" }))}'`,
  );
  await c.unsafe(`set local request.jwt.claim.sub = '${q(userId)}'`);
}

async function serverNowMs(c: Conn): Promise<number> {
  const r = await c.unsafe(`select (extract(epoch from clock_timestamp()) * 1000)::float8 as t`);
  return Number(r[0].t);
}

export async function applyRpc(c: Conn, payload: Record<string, unknown>): Promise<string> {
  const r = await c.unsafe(`select public.apply_synced_shot($1::text::jsonb) as result`, [
    JSON.stringify(payload),
  ]);
  return String(r[0].result);
}

const DIRECT_INSERT_SQL = `insert into public.shots (
  id, user_id, shot_type, camera_view, captured_at, start_ms, contact_ms, end_ms,
  overall_score, analysis_confidence, result_kind, app_version, model_bundle_version,
  pose_model_version, paddle_model_version, stroke_detector_version, phase_model_version,
  scoring_model_version, shot_config_version
) values ($1, $2, 'dink', 'side', '2026-09-01T10:00:00Z', 0, 100, 200, 7.5, 0.9, 'scored',
  '1.0.0', 'bundle-1', 'pose-1', 'paddle-1', 'stroke-1', 'phase-1', 'scoring-1', 'config-1')`;

function need(
  s: LaneSpec,
  field: "permitId" | "key" | "shotId" | "detailKey" | "sessionId",
): string {
  const v = s[field];
  if (v === undefined) {
    throw new Error(`lane ${s.lane} (${s.op}) is missing ${field}`);
  }
  return v;
}

async function runOp(c: Conn, s: LaneSpec): Promise<string> {
  switch (s.op) {
    case "apply":
      return await applyRpc(c, s.payload!);
    case "tamper_then_apply": {
      const u = await c.unsafe(
        `update public.analysis_permits set status = 'reserved', outcome = null where id = $1`,
        [need(s, "permitId")],
      );
      const n = u.count ?? 0;
      return `tampered:${n}/` + (await applyRpc(c, s.payload!));
    }
    case "reserve": {
      const r = await c.unsafe(
        `select x.result, x.permit_id::text as permit_id from public.reserve_analysis_permit($1) x`,
        [need(s, "key")],
      );
      return String(r[0].result);
    }
    case "direct_insert":
      await c.unsafe(DIRECT_INSERT_SQL, [need(s, "shotId"), s.user]);
      return "inserted";
    case "detail_insert":
      await c.unsafe(
        `insert into public.shot_phases (shot_id, user_id, phase_key, start_ms, representative_ms, end_ms, confidence)
         values ($1, $2, $3, 0, 10, 20, 0.5)`,
        [need(s, "shotId"), s.user, need(s, "detailKey")],
      );
      return "inserted";
    case "measurement_insert":
      await c.unsafe(
        `insert into public.shot_measurements (shot_id, user_id, metric_key, value, confidence, unit)
         values ($1, $2, $3, 1.5, 0.5, 'ratio')`,
        [need(s, "shotId"), s.user, need(s, "detailKey")],
      );
      return "inserted";
    case "blocker":
      await c.unsafe(`select pg_catalog.pg_advisory_xact_lock(public.access_lock_key($1::uuid))`, [
        s.user,
      ]);
      return "held";
    case "delete_user": {
      const r = await c.unsafe(`delete from auth.users where id = $1`, [s.user]);
      return `deleted:${r.count ?? 0}`;
    }
    case "session_insert":
      await c.unsafe(
        `insert into public.sessions (id, user_id, started_at) values ($1, $2, now()) on conflict (id) do nothing`,
        [need(s, "sessionId"), s.user],
      );
      return "inserted";
    case "session_delete": {
      const r = await c.unsafe(`delete from public.sessions where id = $1`, [need(s, "sessionId")]);
      return `deleted:${r.count ?? 0}`;
    }
    case "sweep_permits": {
      const r = await c.unsafe(
        `update public.analysis_permits set status = 'released', outcome = 'expired' where status = 'reserved' and created_at < now() - interval '24 hours'`,
      );
      return `swept:${r.count ?? 0}`;
    }
    case "access_state": {
      const r = await c.unsafe(
        `select premium, scored_count, reserved_count from public.access_state()`,
      );
      return `premium=${r[0].premium},scored=${r[0].scored_count},reserved=${r[0].reserved_count}`;
    }
  }
}

function barrier(): { gate: Promise<void>; open: () => void } {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  return { gate, open };
}

export interface BurstOutcome {
  results: LaneResult[];
  wallMs: number;
  timedOut: boolean;
}

/** Run every lane on its own reserved connection: BEGIN, set the caller,
 * wait at the barrier, arrive after preDelayMs (server-side), run the op,
 * hold holdMs, then COMMIT or ROLLBACK. Cancels are issued from the pool
 * at cancelAtMs after the gate opens. */
export async function burst(sql: Sql, specs: LaneSpec[], timeoutMs: number): Promise<BurstOutcome> {
  const b = barrier();
  const pids = new Map<number, number>();
  let ready = 0;
  const results: LaneResult[] = [];
  const t0 = performance.now();

  const laneRun = async (s: LaneSpec) => {
    const c = await sql.reserve();
    const out: LaneResult = {
      lane: s.lane,
      op: s.op,
      user: s.user,
      shotId: s.shotId ?? s.payload?.id,
      permitId: s.permitId ?? s.payload?.analysisPermitId,
      tag: s.tag,
      result: "",
      committed: false,
      cancelled: false,
      isolation: s.isolation,
      finish: s.finish,
      preDelayMs: s.preDelayMs,
      holdMs: s.holdMs,
      clientMs: 0,
    };
    let began = false;
    try {
      const pid = await c.unsafe(`select pg_backend_pid() as pid`);
      pids.set(s.lane, Number(pid[0].pid));
      await c.unsafe(
        s.isolation === "serializable" ? `begin isolation level serializable` : `begin`,
      );
      began = true;
      await c.unsafe(`set local lock_timeout = '${LOCK_TIMEOUT_MS}ms'`);
      await c.unsafe(`set local statement_timeout = '${LOCK_TIMEOUT_MS + 5000}ms'`);
      if (s.role === "authenticated") await asUser(c, s.user);
      ready += 1;
      await b.gate;
      const tc = performance.now();
      if (s.preDelayMs > 0) {
        await c.unsafe(`select pg_sleep(${s.preDelayMs / 1000})`);
      }
      out.serverStartMs = await serverNowMs(c);
      out.result = await runOp(c, s);
      out.serverEndMs = await serverNowMs(c);
      if (s.holdMs > 0) await c.unsafe(`select pg_sleep(${s.holdMs / 1000})`);
      if (s.finish === "commit") {
        await c.unsafe(`commit`);
        out.committed = true;
      } else {
        await c.unsafe(`rollback`);
      }
      out.clientMs = Math.round((performance.now() - tc) * 100) / 100;
    } catch (e) {
      const code = (e as { code?: string }).code ?? "";
      out.sqlstate = code;
      out.cancelled = code === "57014";
      if (!out.result) out.result = `err:${code || "?"}`;
      else out.result = `${out.result}→err:${code || "?"}`;
      out.committed = false;
      if (began) {
        try {
          await c.unsafe(`rollback`);
        } catch {
          // connection already gone — the reserve is released below
        }
      }
    } finally {
      results.push(out);
      c.release();
    }
  };

  const all = Promise.all(specs.map(laneRun));
  while (ready < specs.length) await new Promise((r) => setTimeout(r, 1));
  b.open();

  const cancels = specs
    .filter((s) => s.cancelAtMs !== undefined)
    .map(
      (s) =>
        new Promise<void>((resolve) => {
          setTimeout(async () => {
            const pid = pids.get(s.lane);
            if (pid !== undefined) {
              try {
                await sql.unsafe(`select pg_cancel_backend(${pid})`);
              } catch {
                // backend already finished
              }
            }
            resolve();
          }, s.cancelAtMs);
        }),
    );

  let timedOut = false;
  const timer = new Promise<void>((resolve) =>
    setTimeout(() => {
      timedOut = true;
      resolve();
    }, timeoutMs),
  );
  await Promise.race([all, timer]);
  if (timedOut) {
    for (const pid of pids.values()) {
      try {
        await sql.unsafe(`select pg_terminate_backend(${pid})`);
      } catch {
        // already gone
      }
    }
    await all;
  }
  await Promise.all(cancels);
  results.sort((a, b) => a.lane - b.lane);
  return { results, wallMs: Math.round(performance.now() - t0), timedOut };
}

// ────────────────────────────────────────────────────────────────────────────
// Owner-role fixtures and snapshots
// ────────────────────────────────────────────────────────────────────────────

export interface User {
  id: string;
  provider: string;
  sub: string;
  premium: boolean;
}

export async function createUser(sql: Sql, u: User): Promise<void> {
  await sql.unsafe(`delete from auth.users where id = '${u.id}'`);
  await sql.unsafe(
    `delete from auth.users x using auth.identities i
      where i.user_id = x.id and i.provider = '${u.provider}' and i.provider_id = '${u.sub}'`,
  );
  await sql.unsafe(
    `delete from public.free_rating_ledger
      where identity_hash = public.free_rating_identity_hash('${u.provider}', '${u.sub}')`,
  );
  await sql.unsafe(
    `insert into auth.users (id, email, raw_app_meta_data) values ('${u.id}', '${u.id}@example.com', '{"provider":"${u.provider}"}')`,
  );
  await sql.unsafe(
    `insert into auth.identities (provider, provider_id, user_id, identity_data)
     values ('${u.provider}', '${u.sub}', '${u.id}', '{"sub":"${u.sub}"}')`,
  );
  if (u.premium) {
    await sql.unsafe(
      `insert into public.billing_entitlements (user_id, premium) values ('${u.id}', true)
       on conflict (user_id) do update set premium = true, expires_at = null`,
    );
  }
}

/** Owner-issued permit (models a permit any pre-race build could over-issue). */
export async function ownerPermit(sql: Sql, userId: string, key: string): Promise<string> {
  const r = await sql.unsafe(
    `insert into public.analysis_permits (user_id, idempotency_key) values ('${userId}', '${q(
      key,
    )}') returning id::text as id`,
  );
  return String(r[0].id);
}

/** Permit reserved through the real RPC as the user (single, sequential). */
export async function reserveAsUser(sql: Sql, userId: string, key: string): Promise<string> {
  let out = "";
  await sql.begin(async (tx) => {
    await asUser(tx, userId);
    const r = await tx.unsafe(
      `select x.result, x.permit_id::text as permit_id from public.reserve_analysis_permit($1) x`,
      [key],
    );
    if (String(r[0].result) !== "accepted") {
      throw new Error(`reserveAsUser expected accepted, got ${r[0].result}`);
    }
    out = String(r[0].permit_id);
  });
  return out;
}

export async function applyAsUser(
  sql: Sql,
  userId: string,
  payload: Record<string, unknown>,
): Promise<string> {
  let out = "";
  await sql.begin(async (tx) => {
    await asUser(tx, userId);
    out = await applyRpc(tx, payload);
  });
  return out;
}

export async function setPermitAge(sql: Sql, permitId: string, ageMs: number): Promise<void> {
  await sql.unsafe(
    `update public.analysis_permits set created_at = now() - make_interval(secs => ${
      ageMs / 1000
    }) where id = '${permitId}'`,
  );
}

export interface PermitState {
  id: string;
  status: string;
  outcome: string | null;
}

export interface ShotState {
  id: string;
  userId: string;
  resultKind: string;
  overallScore: string | null;
  sessionId: string | null;
  phases: number;
  checkpoints: number;
  measurements: number;
}

export interface UserSnapshot {
  exists: boolean;
  shots: ShotState[];
  scored: number;
  permits: PermitState[];
  ledger: number | null;
  rankScoredCount: number | null;
  /** lifetime_scored_count() + access_state() as the user (RLS context) */
  lifetime: number | null;
  access: { premium: boolean; scored: number; reserved: number } | null;
}

export async function snapshotUser(sql: Sql, u: User): Promise<UserSnapshot> {
  const exists = await sql.unsafe(`select 1 from auth.users where id = '${u.id}'`);
  const shots = await sql.unsafe(
    `select s.id::text as id, s.user_id::text as user_id, s.result_kind, s.overall_score::text as overall_score,
            s.session_id::text as session_id,
            (select count(*) from public.shot_phases p where p.shot_id = s.id)::int as phases,
            (select count(*) from public.shot_checkpoints c where c.shot_id = s.id)::int as checkpoints,
            (select count(*) from public.shot_measurements m where m.shot_id = s.id)::int as measurements
       from public.shots s where s.user_id = '${u.id}' order by s.id`,
  );
  const permits = await sql.unsafe(
    `select id::text as id, status, outcome from public.analysis_permits where user_id = '${u.id}' order by created_at, id`,
  );
  const ledger = await sql.unsafe(
    `select scored_count from public.free_rating_ledger
      where identity_hash = public.free_rating_identity_hash('${u.provider}', '${u.sub}')`,
  );
  const rank = await sql.unsafe(
    `select scored_shot_count from public.player_rank_state where user_id = '${u.id}'`,
  );
  let lifetime: number | null = null;
  let access: UserSnapshot["access"] = null;
  if (exists.length > 0) {
    await sql.begin(async (tx) => {
      await asUser(tx, u.id);
      const l = await tx.unsafe(`select public.lifetime_scored_count()::int as n`);
      lifetime = Number(l[0].n);
      const a = await tx.unsafe(
        `select premium, scored_count, reserved_count from public.access_state()`,
      );
      access = {
        premium: Boolean(a[0].premium),
        scored: Number(a[0].scored_count),
        reserved: Number(a[0].reserved_count),
      };
    });
  }
  const shotStates: ShotState[] = shots.map((s: Record<string, unknown>) => ({
    id: String(s.id),
    userId: String(s.user_id),
    resultKind: String(s.result_kind),
    overallScore: s.overall_score === null ? null : String(s.overall_score),
    sessionId: s.session_id === null ? null : String(s.session_id),
    phases: Number(s.phases),
    checkpoints: Number(s.checkpoints),
    measurements: Number(s.measurements),
  }));
  return {
    exists: exists.length > 0,
    shots: shotStates,
    scored: shotStates.filter((s) => s.resultKind === "scored").length,
    permits: permits.map((p: Record<string, unknown>) => ({
      id: String(p.id),
      status: String(p.status),
      outcome: p.outcome === null ? null : String(p.outcome),
    })),
    ledger: ledger.length ? Number(ledger[0].scored_count) : null,
    rankScoredCount: rank.length ? Number(rank[0].scored_shot_count) : null,
    lifetime,
    access,
  };
}

/** Rows visible to `viewer` under RLS for the given shot ids (should be 0
 * for any id owned by someone else). */
export async function visibleShots(sql: Sql, viewer: string, ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  let n = 0;
  await sql.begin(async (tx) => {
    await asUser(tx, viewer);
    const r = await tx.unsafe(
      `select count(*)::int as n from public.shots where id = any($1::uuid[])`,
      [ids],
    );
    n = Number(r[0].n);
  });
  return n;
}

/** Detail rows attached to a shot whose owner differs from the row's user_id. */
export async function crossOwnerDetailRows(sql: Sql, userIds: string[]): Promise<number> {
  const r = await sql.unsafe(
    `select
       (select count(*) from public.shot_phases p join public.shots s on s.id = p.shot_id
         where p.user_id <> s.user_id and (p.user_id = any($1::uuid[]) or s.user_id = any($1::uuid[])))
     + (select count(*) from public.shot_checkpoints c join public.shots s on s.id = c.shot_id
         where c.user_id <> s.user_id and (c.user_id = any($1::uuid[]) or s.user_id = any($1::uuid[])))
     + (select count(*) from public.shot_measurements m join public.shots s on s.id = m.shot_id
         where m.user_id <> s.user_id and (m.user_id = any($1::uuid[]) or s.user_id = any($1::uuid[])))
       as n`,
    [userIds],
  );
  return Number(r[0].n);
}

export function histogram(values: string[]): Record<string, number> {
  const h: Record<string, number> = {};
  for (const v of values) h[v] = (h[v] ?? 0) + 1;
  return Object.fromEntries(Object.entries(h).sort(([a], [b]) => (a < b ? -1 : 1)));
}

export interface Invariant {
  name: string;
  holds: boolean;
  detail: string;
}

export function inv(list: Invariant[], name: string, holds: boolean, detail: unknown): void {
  list.push({
    name,
    holds,
    detail: typeof detail === "string" ? detail : JSON.stringify(detail),
  });
}
