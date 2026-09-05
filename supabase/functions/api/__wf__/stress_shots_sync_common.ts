/**
 * stress_shots_sync_common — seeded concurrency stress campaign for
 * POST /v1/shots:sync, shared by two backends:
 *
 *   stress_shots_sync_concurrency.test.ts     REAL edge handler (../index.ts)
 *                                             over the modelled Supabase in
 *                                             xc_concurrency_harness.ts
 *   stress_shots_sync_pg_concurrency.test.ts  REAL edge handler whose
 *                                             PostgREST calls for this route
 *                                             (shots replay lookup and the
 *                                             apply_synced_shot /
 *                                             reserve_analysis_permit /
 *                                             access_state RPCs) execute on a
 *                                             disposable postgres:16 with
 *                                             every migration applied
 *
 * Every iteration is one adversarial interleaving derived from ONE seed
 * (`mix(STRESS_SEED, index)`): the scenario kind comes from a fixed deck so a
 * short default campaign still touches every kind; every other parameter
 * (burst width, batch shapes, where the logout/refresh/cancel lands, the
 * clock-skew offset, malformed entries, …) is drawn from a Prng seeded with
 * that iteration seed, and the fake upstream's latency Prng is reset to it as
 * well, so `STRESS_REPLAY=<index>` re-runs exactly that interleaving (on the
 * fake backend bit-for-bit; on Postgres the database's own scheduling adds
 * nondeterminism, which is the point of running there).
 *
 * Invariants asserted after EVERY iteration (the CONTRACT — see audit()):
 *   - never a 5xx; never a 429 (a masked iteration is reported as MASKED, not
 *     as a pass)
 *   - one row per shot id across all users (no duplicate rows)
 *   - every id a 200 response listed under acceptedIds has a row (no lost
 *     update); every row belongs to a shot the iteration sent, with the
 *     result kind it sent
 *   - a copy that lost a race for a row this user already holds is answered
 *     `accepted` or a TRANSIENT_SYNC_REJECTION_CODES member — never a
 *     permanent verdict (apps/mobile/src/data/sync.ts burns one of
 *     OUTBOX_MAX_ATTEMPTS on those)
 *   - a permit is consumed at most once; finalized ⇔ exactly one scored row
 *     used it; released/low_confidence ⇔ one abstention used it; no row ⇒
 *     never finalized (a consumed permit without a row is a spent rating with
 *     nothing to show for it)
 *   - a non-premium account never holds more than two scored rows; the
 *     identity ledger equals the scored-row count
 *   - a burst that added rows bumped the rank/progress cache generation
 *   - the whole iteration settles within STRESS_ITER_TIMEOUT_MS (no deadlock)
 */
import {
  bootstrap,
  edgeRequest,
  histogram,
  type Invariant,
  isRecord,
  Prng,
  readJson,
  sleep,
  syncShotPayload,
  type XcHarness,
} from "./xc_concurrency_harness.ts";
import { cacheLocalGeneration } from "../cache.ts";

// ── Scale knobs ──────────────────────────────────────────────────────────────

function envInt(name: string, fallback: number): number {
  const raw = Deno.env.get(name);
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.floor(n) : fallback;
}

/** Iterations per campaign. Small by default so the suite stays fast; the
 * coordinator campaign runs STRESS_ITER=520. */
export const STRESS_ITER = envInt("STRESS_ITER", 40);
export const STRESS_SEED = envInt("STRESS_SEED", 20260905);
/** Max seeded latency per modelled upstream call. */
export const STRESS_LATENCY_MS = envInt("STRESS_LATENCY_MS", 6);
/** Wall-time bound per iteration — exceeding it is a deadlock finding. */
export const STRESS_ITER_TIMEOUT_MS = envInt("STRESS_ITER_TIMEOUT_MS", 20_000);
/** Replay: comma-separated iteration indexes (same STRESS_SEED). */
export const STRESS_REPLAY: number[] = (Deno.env.get("STRESS_REPLAY") ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter((s) => s !== "")
  .map(Number)
  .filter((n) => Number.isInteger(n) && n >= 0);
/** Restrict the deck to one scenario kind (e.g. STRESS_ONLY=logout_during_sync). */
export const STRESS_ONLY = Deno.env.get("STRESS_ONLY") ?? "";

export function stressOutDir(): string {
  const env = Deno.env.get("STRESS_OUT_DIR");
  if (env) return env.endsWith("/") ? env : `${env}/`;
  return new URL("../../../../artifacts/stress-shots-sync/latest/", import.meta.url).pathname;
}

/** splitmix-style mixer: one 32-bit seed per iteration index. */
export function mix(seed: number, index: number): number {
  let z = (seed ^ Math.imul(index + 1, 0x9e3779b9)) >>> 0;
  z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
  z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
  return (z ^ (z >>> 16)) >>> 0;
}

// ── Scenario kinds ───────────────────────────────────────────────────────────

export type Kind =
  | "dup_same_shot"
  | "dup_in_batch"
  | "permit_reuse"
  | "free_limit_backstop"
  | "two_actors_same_id"
  | "logout_during_sync"
  | "rotation_during_sync"
  | "cancel_and_retry"
  | "clock_skew"
  | "mixed_batch_storm";

/** Fixed deck: index → kind, so any STRESS_ITER ≥ 20 covers every kind and
 * the mix is stable across campaign sizes. */
export const DECK: Kind[] = [
  "dup_same_shot",
  "free_limit_backstop",
  "logout_during_sync",
  "mixed_batch_storm",
  "dup_same_shot",
  "two_actors_same_id",
  "permit_reuse",
  "clock_skew",
  "dup_in_batch",
  "free_limit_backstop",
  "dup_same_shot",
  "rotation_during_sync",
  "mixed_batch_storm",
  "two_actors_same_id",
  "cancel_and_retry",
  "free_limit_backstop",
  "dup_same_shot",
  "logout_during_sync",
  "permit_reuse",
  "dup_in_batch",
];

export function kindFor(index: number): Kind {
  if (STRESS_ONLY) return STRESS_ONLY as Kind;
  return DECK[index % DECK.length];
}

/** Mirrors apps/mobile/src/data/sync.ts TRANSIENT_SYNC_REJECTION_CODES —
 * the only rejection codes that do not burn an outbox attempt. */
export const TRANSIENT_SYNC_REJECTION_CODES = new Set([
  "shot.write_failed",
  "evaluation.trial_write_failed",
  "auth.required",
  "shot.session_not_found",
]);

// ── Backend abstraction ──────────────────────────────────────────────────────

export interface SnapshotShot {
  id: string;
  userId: string;
  resultKind: string;
}
export interface SnapshotPermit {
  id: string;
  userId: string;
  status: string;
  outcome: string;
}
export interface Snapshot {
  shots: SnapshotShot[];
  permits: SnapshotPermit[];
  /** identity-ledger lifetime scored count per user (0 when no row) */
  ledger: Record<string, number>;
}

/** What differs between the modelled database and real Postgres: how the
 * iteration seeds state the route cannot create itself, and how it reads
 * the truth back for the audit. All REQUESTS go through the real handler. */
export interface StressBackend {
  readonly name: "fake" | "pg";
  /** Before bootstrap: make the auth user exist where the RPCs will look. */
  prepareUser(sub: string): Promise<void>;
  /** A reserved permit the route never issued (any pre-RPC build could),
   * optionally aged by `createdAtOffsetMs` relative to now. */
  forgePermit(userId: string, key: string, createdAtOffsetMs?: number): Promise<string>;
  setPermitCreatedAt(permitId: string, createdAtOffsetMs: number): Promise<void>;
  setPremium(userId: string, expiresAt: string | null): Promise<void>;
  createSession(userId: string, sessionId: string): Promise<void>;
  snapshot(userIds: string[]): Promise<Snapshot>;
}

// ── Per-iteration bookkeeping ────────────────────────────────────────────────

export interface RequestRow {
  lane: number;
  op: string;
  user: string;
  status: number;
  code?: string;
  accepted: number;
  rejected: Record<string, number>;
  startedAt: number;
  endedAt: number;
}

interface TrackedShot {
  id: string;
  user: string;
  permit: string;
  resultKind: "scored" | "low_confidence";
  score: number | null;
  /** null → no session; a uuid → must exist for the row to be written */
  sessionId: string | null;
  sessionExists: boolean;
}

interface Verdict {
  user: string;
  shotId: string;
  verdict: string; // "accepted" | rejection code
  op: string;
}

interface Actor {
  sub: string;
  accessToken: string;
  refreshToken: string;
  premium: boolean;
}

interface CallResult {
  status: number;
  body: Record<string, unknown>;
  row: RequestRow;
}

export interface IterationRow {
  index: number;
  seed: number;
  kind: Kind;
  backend: string;
  params: Record<string, unknown>;
  requests: number;
  statusHistogram: Record<string, number>;
  codeHistogram: Record<string, number>;
  invariants: Invariant[];
  observations: Record<string, unknown>;
  outcome: "HELD" | "BROKEN" | "TIMEOUT" | "MASKED";
  durationMs: number;
  replay: string;
  /** upstream timeline + per-request rows — kept for non-HELD iterations */
  timeline?: Array<{ t: number; op: string; detail: string }>;
  requestRows?: RequestRow[];
}

export class Iteration {
  readonly prng: Prng;
  readonly rows: RequestRow[] = [];
  readonly invariants: Invariant[] = [];
  readonly params: Record<string, unknown> = {};
  readonly observations: Record<string, unknown> = {};
  readonly shots = new Map<string, TrackedShot>();
  readonly permits = new Map<string, string>(); // permit id → owner
  readonly verdicts: Verdict[] = [];
  readonly actors: Actor[] = [];
  readonly generationsAtBootstrap = new Map<string, string>();
  /** shot ids legitimately refused first and written by a LATER attempt with
   * a different permit (clock-skew recovery) — the accepted-or-transient
   * contract applies to copies racing one write, not across that boundary */
  readonly refusedThenRewritten = new Set<string>();
  /** fire-and-forget requests (client gave up) that must still settle */
  readonly orphans: Promise<unknown>[] = [];
  private lane = 0;

  constructor(
    readonly h: XcHarness,
    readonly backend: StressBackend,
    readonly index: number,
    readonly seed: number,
    readonly kind: Kind,
    readonly ipOctet: number,
  ) {
    this.prng = new Prng(seed);
  }

  ip(): string {
    return `10.${this.ipOctet}.${(this.index >> 8) & 255}.${this.index & 255}`;
  }

  inv(name: string, holds: boolean, detail: string): void {
    this.invariants.push({ name, holds, detail });
  }

  async actor(): Promise<Actor> {
    const sub = this.prng.uuid();
    await this.backend.prepareUser(sub);
    const boot = await bootstrap(this.h, sub, this.ip());
    if (boot.status !== 200 || !boot.accessToken) {
      throw new Error(`bootstrap failed: ${boot.status} ${JSON.stringify(boot.body)}`);
    }
    const a: Actor = {
      sub,
      accessToken: boot.accessToken,
      refreshToken: boot.refreshToken,
      premium: false,
    };
    this.actors.push(a);
    this.generationsAtBootstrap.set(sub, this.rankGeneration(sub));
    return a;
  }

  /** Reserve a permit through the real route (idempotent RPC). */
  async reserve(actor: Actor, key: string): Promise<string> {
    const res = await this.call("permit.reserve", actor.sub, () =>
      this.h.handler(
        edgeRequest("POST", "/v1/analysis-permits", {
          token: actor.accessToken,
          ip: this.ip(),
          body: { idempotencyKey: key },
        }),
      ));
    const permit = isRecord(res.body.permit) ? res.body.permit : null;
    if (res.status !== 200 || !permit || typeof permit.id !== "string") {
      throw new Error(`permit reserve failed: ${res.status} ${JSON.stringify(res.body)}`);
    }
    this.permits.set(permit.id, actor.sub);
    return permit.id;
  }

  async forge(actor: Actor, key: string, createdAtOffsetMs = 0): Promise<string> {
    const id = await this.backend.forgePermit(actor.sub, key, createdAtOffsetMs);
    this.permits.set(id, actor.sub);
    return id;
  }

  track(
    actor: Actor,
    permit: string,
    resultKind: "scored" | "low_confidence" = "scored",
    session: { id: string | null; exists: boolean } = { id: null, exists: true },
    id = this.prng.uuid(),
  ): TrackedShot {
    const shot: TrackedShot = {
      id,
      user: actor.sub,
      permit,
      resultKind,
      score: resultKind === "scored" ? this.prng.int(0, 100) / 10 : null,
      sessionId: session.id,
      sessionExists: session.exists,
    };
    this.shots.set(shot.id, shot);
    return shot;
  }

  payload(shot: TrackedShot, overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return syncShotPayload(shot.id, shot.permit, {
      sessionId: shot.sessionId,
      resultKind: shot.resultKind,
      overallScore: shot.score,
      ...overrides,
    });
  }

  syncRequest(actor: Actor, entries: unknown[], token = actor.accessToken): Request {
    return edgeRequest("POST", "/v1/shots:sync", {
      token,
      ip: this.ip(),
      body: { shots: entries },
    });
  }

  async call(op: string, user: string, fn: () => Promise<Response>): Promise<CallResult> {
    const lane = this.lane++;
    const startedAt = performance.now();
    const response = await fn();
    const body = await readJson(response);
    const err = body.error;
    const nested = isRecord(err) ? err.code : undefined;
    const code = typeof nested === "string"
      ? nested
      : typeof body.code === "string"
      ? body.code
      : undefined;
    const acceptedIds = Array.isArray(body.acceptedIds) ? (body.acceptedIds as string[]) : [];
    const rejected = Array.isArray(body.rejected)
      ? (body.rejected as Array<{ id: string; code: string }>)
      : [];
    const row: RequestRow = {
      lane,
      op,
      user,
      status: response.status,
      code,
      accepted: acceptedIds.length,
      rejected: histogram(rejected.map((r) => r.code)),
      startedAt: Math.round(startedAt * 100) / 100,
      endedAt: Math.round(performance.now() * 100) / 100,
    };
    this.rows.push(row);
    if (response.status === 200 && op.startsWith("sync")) {
      for (const id of acceptedIds) {
        this.verdicts.push({ user, shotId: id, verdict: "accepted", op });
      }
      for (const r of rejected) this.verdicts.push({ user, shotId: r.id, verdict: r.code, op });
    }
    return { status: response.status, body, row };
  }

  sync(op: string, actor: Actor, entries: unknown[], token?: string): Promise<CallResult> {
    return this.call(op, actor.sub, () => this.h.handler(this.syncRequest(actor, entries, token)));
  }

  /** Verdicts for one (user, shot), in response order. */
  verdictsFor(user: string, shotId: string): string[] {
    return this.verdicts
      .filter((v) => v.user === user && v.shotId === shotId)
      .map((v) => v.verdict);
  }

  rankGeneration(user: string): string {
    return `${cacheLocalGeneration(`rank:${user}`)}|${cacheLocalGeneration(`progress:${user}`)}`;
  }
}

// ── Generic audit ────────────────────────────────────────────────────────────

export async function audit(it: Iteration): Promise<Snapshot> {
  await Promise.allSettled(it.orphans);
  const users = it.actors.map((a) => a.sub);
  const after = await it.backend.snapshot(users);

  const statuses = it.rows.map((r) => r.status);
  it.inv("no 5xx", statuses.every((s) => s < 500), JSON.stringify(histogram(statuses)));
  it.inv(
    "no 429 (per-user/IP budgets never mask the invariant under test)",
    statuses.every((s) => s !== 429),
    JSON.stringify(histogram(statuses)),
  );

  const byId = histogram(after.shots.map((s) => s.id));
  const dupIds = Object.entries(byId).filter(([, n]) => n > 1);
  it.inv("no duplicate rows for any shot id", dupIds.length === 0, JSON.stringify(dupIds));

  const phantom = after.shots.filter((row) => {
    const t = it.shots.get(row.id);
    return !t || t.user !== row.userId || t.resultKind !== row.resultKind;
  });
  it.inv(
    "every row is a tracked shot with the sender's user and result kind",
    phantom.length === 0,
    JSON.stringify(phantom.slice(0, 5)),
  );

  const rowsByUser = new Map<string, Set<string>>();
  for (const s of after.shots) {
    if (!rowsByUser.has(s.userId)) rowsByUser.set(s.userId, new Set());
    rowsByUser.get(s.userId)!.add(s.id);
  }
  const lost = it.verdicts.filter(
    (v) => v.verdict === "accepted" && !rowsByUser.get(v.user)?.has(v.shotId),
  );
  it.inv(
    "every acceptedId has a row for that user (no lost update)",
    lost.length === 0,
    JSON.stringify(lost.slice(0, 5)),
  );
  const permanentOnHeld = it.verdicts.filter(
    (v) =>
      v.verdict !== "accepted" &&
      !it.refusedThenRewritten.has(v.shotId) &&
      rowsByUser.get(v.user)?.has(v.shotId) &&
      !TRANSIENT_SYNC_REJECTION_CODES.has(v.verdict),
  );
  it.inv(
    "a copy of a shot the server holds for this user is never handed a permanent rejection",
    permanentOnHeld.length === 0,
    JSON.stringify(histogram(permanentOnHeld.map((v) => v.verdict))),
  );

  const permitById = new Map(after.permits.map((p) => [p.id, p]));
  const usedBy = new Map<string, TrackedShot[]>();
  for (const row of after.shots) {
    const t = it.shots.get(row.id);
    if (!t) continue;
    if (!usedBy.has(t.permit)) usedBy.set(t.permit, []);
    usedBy.get(t.permit)!.push(t);
  }
  const permitProblems: string[] = [];
  for (const [permitId, owner] of it.permits) {
    const p = permitById.get(permitId);
    if (!p) {
      permitProblems.push(`${permitId}: missing from snapshot`);
      continue;
    }
    if (p.userId !== owner) permitProblems.push(`${permitId}: owner changed`);
    const rows = usedBy.get(permitId) ?? [];
    if (rows.length > 1) {
      permitProblems.push(`${permitId}: consumed by ${rows.length} rows (double spend)`);
      continue;
    }
    if (rows.length === 1) {
      const kind = rows[0].resultKind;
      const ok = kind === "scored"
        ? p.status === "finalized" && p.outcome === "scored"
        : p.status === "released" && p.outcome === "low_confidence";
      if (!ok) permitProblems.push(`${permitId}: row=${kind} but permit=${p.status}/${p.outcome}`);
    } else {
      const ok = p.status === "reserved" ||
        (p.status === "released" &&
          (p.outcome === "expired" || p.outcome === "free_limit_exceeded"));
      if (!ok) permitProblems.push(`${permitId}: no row but permit=${p.status}/${p.outcome}`);
    }
  }
  it.inv(
    "permit consumed at most once; finalized/released ⇔ exactly the row that used it",
    permitProblems.length === 0,
    JSON.stringify(permitProblems.slice(0, 6)),
  );

  const freeProblems: string[] = [];
  for (const a of it.actors) {
    const scored = after.shots.filter((s) => s.userId === a.sub && s.resultKind === "scored")
      .length;
    const ledger = after.ledger[a.sub] ?? 0;
    if (!a.premium && scored > 2) {
      freeProblems.push(`${a.sub}: ${scored} scored rows (non-premium)`);
    }
    if (ledger !== scored) freeProblems.push(`${a.sub}: ledger=${ledger} scored=${scored}`);
  }
  it.inv(
    "non-premium ≤ 2 scored rows; identity ledger == scored rows",
    freeProblems.length === 0,
    JSON.stringify(freeProblems),
  );

  const cacheProblems: string[] = [];
  for (const a of it.actors) {
    const n = after.shots.filter((s) => s.userId === a.sub).length;
    if (n > 0 && it.rankGeneration(a.sub) === it.generationsAtBootstrap.get(a.sub)) {
      cacheProblems.push(`${a.sub}: ${n} rows written, rank/progress generation unchanged`);
    }
  }
  it.inv(
    "a burst that added rows bumped the rank/progress cache generation",
    cacheProblems.length === 0,
    JSON.stringify(cacheProblems),
  );

  it.observations.rows = after.shots.length;
  it.observations.permits = histogram(after.permits.map((p) => `${p.status}/${p.outcome}`));
  return after;
}

// ── Scenario bodies ──────────────────────────────────────────────────────────

type Body = (it: Iteration) => Promise<void>;

/** N in-flight copies of ONE shot (same permit); some copies ride inside a
 * batch with an unrelated abstention so the batched replay lookup sees mixed
 * shapes. Then a replay. */
const dupSameShot: Body = async (it) => {
  const a = await it.actor();
  const permit = await it.reserve(a, `k-${it.seed}`);
  const shot = it.track(a, permit);
  const burst = it.prng.int(2, 20);
  const wrapped = it.prng.int(0, Math.min(3, burst));
  it.params.burst = burst;
  it.params.wrappedInBatches = wrapped;
  const extras: TrackedShot[] = [];
  for (let i = 0; i < wrapped; i++) {
    extras.push(it.track(a, await it.forge(a, `abst-${it.seed}-${i}`), "low_confidence"));
  }
  const lanes = Array.from({ length: burst }, (_, i) => ({
    i,
    entries: i < wrapped ? [it.payload(shot), it.payload(extras[i])] : [it.payload(shot)],
  }));
  const results = await Promise.all(
    it.prng.shuffle(lanes).map((l) => it.sync(`sync.dup.${l.i}`, a, l.entries)),
  );
  const acceptedCopies = it.verdictsFor(a.sub, shot.id).filter((v) => v === "accepted").length;
  it.observations.acceptedCopies = acceptedCopies;
  it.inv(
    "every copy of the duplicated shot is 200 and acknowledges the shot",
    results.every((r) => r.status === 200) && acceptedCopies === burst,
    `accepted=${acceptedCopies}/${burst} statuses=${
      JSON.stringify(histogram(results.map((r) => r.status)))
    } verdicts=${JSON.stringify(histogram(it.verdictsFor(a.sub, shot.id)))}`,
  );
  it.inv(
    "every wrapped abstention is accepted alongside the duplicate",
    extras.every((e) => it.verdictsFor(a.sub, e.id)[0] === "accepted"),
    JSON.stringify(extras.map((e) => it.verdictsFor(a.sub, e.id))),
  );
  const replay = await it.sync("sync.replay", a, [it.payload(shot)]);
  it.inv(
    "post-burst replay is accepted",
    replay.status === 200 && it.verdictsFor(a.sub, shot.id).slice(-1)[0] === "accepted",
    `status=${replay.status}`,
  );
};

/** The same shot repeated INSIDE one batch, across concurrent batches. */
const dupInBatch: Body = async (it) => {
  const a = await it.actor();
  const permit = await it.reserve(a, `k-${it.seed}`);
  const shot = it.track(a, permit);
  const copiesPerBatch = it.prng.int(2, 6);
  const batches = it.prng.int(1, 8);
  it.params.copiesPerBatch = copiesPerBatch;
  it.params.batches = batches;
  const results = await Promise.all(
    Array.from(
      { length: batches },
      (_, i) =>
        it.sync(
          `sync.batchdup.${i}`,
          a,
          Array.from({ length: copiesPerBatch }, () => it.payload(shot)),
        ),
    ),
  );
  const perResponse = results.map((r) => ({
    status: r.status,
    accepted: r.row.accepted,
    rejected: r.row.rejected,
  }));
  it.observations.perResponse = perResponse;
  it.inv(
    "every batch is 200, lists the shot as accepted, and rejects nothing",
    results.every(
      (r) => r.status === 200 && r.row.accepted >= 1 && Object.keys(r.row.rejected).length === 0,
    ),
    JSON.stringify(perResponse),
  );
  // observation only: acceptedIds may repeat the id (drainOutbox keys by id)
  it.observations.acceptedIdsRepeated = results.some((r) => r.row.accepted > 1);
};

/** Two DIFFERENT shots carrying the SAME permit, N copies each, concurrently:
 * exactly one shot may consume the permit; the other is a permanent
 * access.permit_not_reserved and never gets a row. */
const permitReuse: Body = async (it) => {
  const a = await it.actor();
  const permit = await it.reserve(a, `k-${it.seed}`);
  const s1 = it.track(a, permit);
  const s2 = it.track(a, permit);
  const copies = it.prng.int(1, 8);
  it.params.copiesEach = copies;
  const lanes = [
    ...Array.from({ length: copies }, (_, i) => ({ s: s1, i })),
    ...Array.from({ length: copies }, (_, i) => ({ s: s2, i })),
  ];
  const results = await Promise.all(
    it.prng.shuffle(lanes).map((l) => it.sync(`sync.reuse.${l.i}`, a, [it.payload(l.s)])),
  );
  const after = await it.backend.snapshot([a.sub]);
  const rows = after.shots.filter((r) => r.id === s1.id || r.id === s2.id);
  const winner = rows[0]?.id;
  const loser = winner === s1.id ? s2 : s1;
  const loserVerdicts = it.verdictsFor(a.sub, loser.id);
  it.observations.winner = winner === s1.id ? "s1" : winner === s2.id ? "s2" : "none";
  it.observations.loserVerdicts = histogram(loserVerdicts);
  it.inv(
    "exactly one of the two shots sharing a permit is written; every copy of the other is access.permit_not_reserved",
    rows.length === 1 &&
      results.every((r) => r.status === 200) &&
      loserVerdicts.length === copies &&
      loserVerdicts.every((v) => v === "access.permit_not_reserved"),
    `rows=${rows.length} loser=${JSON.stringify(histogram(loserVerdicts))}`,
  );
  it.inv(
    "one rating spent for the pair",
    after.shots.filter((r) => r.userId === a.sub && r.resultKind === "scored").length === 1,
    `scored=${after.shots.filter((r) => r.userId === a.sub).length}`,
  );
};

/** k∈{0,1,2} ratings already spent through the route, then the legit
 * remainder of permits plus forged extras and one DISTINCT scored shot per
 * permit, concurrently, with abstentions mixed in: total scored rows == 2,
 * every refused scored shot is access.paywall_required with its permit
 * released free_limit_exceeded; abstentions are never refused by the limit. */
const freeLimitBackstop: Body = async (it) => {
  const a = await it.actor();
  const k = it.prng.int(0, 2);
  const extraForged = it.prng.int(1, 4);
  const abstentions = it.prng.int(0, 3);
  it.params.preSpent = k;
  it.params.forged = extraForged;
  it.params.abstentions = abstentions;
  for (let i = 0; i < k; i++) {
    const p = await it.reserve(a, `pre-${it.seed}-${i}`);
    const s = it.track(a, p);
    const r = await it.sync(`sync.pre.${i}`, a, [it.payload(s)]);
    if (r.status !== 200 || r.row.accepted !== 1) {
      throw new Error(`pre-spend ${i} failed: ${r.status} ${JSON.stringify(r.body)}`);
    }
  }
  const legit = 2 - k;
  const permits: string[] = [];
  for (let i = 0; i < legit; i++) permits.push(await it.reserve(a, `legit-${it.seed}-${i}`));
  for (let i = 0; i < extraForged; i++) permits.push(await it.forge(a, `forged-${it.seed}-${i}`));
  const scored = permits.map((p) => it.track(a, p, "scored"));
  const abst: TrackedShot[] = [];
  for (let i = 0; i < abstentions; i++) {
    abst.push(it.track(a, await it.forge(a, `abst-${it.seed}-${i}`), "low_confidence"));
  }
  const all = it.prng.shuffle([...scored, ...abst]);
  const batches: TrackedShot[][] = [];
  for (const s of all) {
    if (batches.length > 0 && it.prng.next() < 0.3) batches[batches.length - 1].push(s);
    else batches.push([s]);
  }
  it.params.batches = batches.map((b) => b.length);
  const results = await Promise.all(
    batches.map((b, i) => it.sync(`sync.backstop.${i}`, a, b.map((s) => it.payload(s)))),
  );
  const after = await it.backend.snapshot([a.sub]);
  const scoredRows = after.shots.filter((r) => r.userId === a.sub && r.resultKind === "scored")
    .length;
  const abstRows = after.shots.filter(
    (r) => r.userId === a.sub && r.resultKind === "low_confidence",
  ).length;
  const scoredVerdicts = scored.map((s) => it.verdictsFor(a.sub, s.id)[0]);
  const refused = scoredVerdicts.filter((v) => v !== "accepted");
  const releasedFLE = after.permits.filter(
    (p) => p.userId === a.sub && p.status === "released" && p.outcome === "free_limit_exceeded",
  ).length;
  it.observations.scoredVerdicts = histogram(scoredVerdicts);
  it.inv(
    "exactly 2 lifetime scored rows; every other scored shot is access.paywall_required with its permit released free_limit_exceeded",
    results.every((r) => r.status === 200) &&
      scoredRows === 2 &&
      refused.length === extraForged &&
      refused.every((v) => v === "access.paywall_required") &&
      releasedFLE === refused.length,
    `scoredRows=${scoredRows} refused=${
      JSON.stringify(histogram(refused))
    } releasedFLE=${releasedFLE}`,
  );
  it.inv(
    "abstentions are never refused by the free limit",
    abstRows === abstentions && abst.every((s) => it.verdictsFor(a.sub, s.id)[0] === "accepted"),
    `abstRows=${abstRows}/${abstentions}`,
  );
  const access = await it.call(
    "me.access",
    a.sub,
    () => it.h.handler(edgeRequest("GET", "/v1/me/access", { token: a.accessToken, ip: it.ip() })),
  );
  const fr = isRecord(access.body.freeRatings) ? access.body.freeRatings : {};
  it.observations.access = fr;
  it.inv(
    "GET /v1/me/access afterwards: used=2 remaining=0 canStartRating=false",
    access.status === 200 &&
      fr.used === 2 &&
      fr.remaining === 0 &&
      access.body.canStartRating === false,
    JSON.stringify({ status: access.status, fr, can: access.body.canStartRating }),
  );
};

/** Users A and B race for the SAME shot id, each with their own permit: one
 * row, every loser copy is shot.id_conflict, the loser's permit stays
 * reserved and still works for a different id, no cross-user replay-accept. */
const twoActorsSameId: Body = async (it) => {
  const a = await it.actor();
  const b = await it.actor();
  const pa = await it.reserve(a, `k-${it.seed}-a`);
  const pb = await it.reserve(b, `k-${it.seed}-b`);
  const sharedId = it.prng.uuid();
  const sa = it.track(a, pa, "scored", { id: null, exists: true }, sharedId);
  const sb = it.track(b, pb, "scored", { id: null, exists: true }, sharedId);
  it.shots.set(sharedId, sa); // provisional; the winner's entry is set below
  const copies = it.prng.int(1, 8);
  it.params.copiesEach = copies;
  const lanes = [
    ...Array.from({ length: copies }, (_, i) => ({ actor: a, s: sa, tag: "A", i })),
    ...Array.from({ length: copies }, (_, i) => ({ actor: b, s: sb, tag: "B", i })),
  ];
  const results = await Promise.all(
    it.prng
      .shuffle(lanes)
      .map((l) => it.sync(`sync.actor.${l.tag}.${l.i}`, l.actor, [it.payload(l.s)])),
  );
  const snap = await it.backend.snapshot([a.sub, b.sub]);
  const rows = snap.shots.filter((r) => r.id === sharedId);
  const winner = rows[0]?.userId === a.sub ? a : rows[0]?.userId === b.sub ? b : null;
  const loser = winner === a ? b : a;
  it.shots.set(sharedId, winner === b ? sb : sa);
  const loserVerdicts = it.verdictsFor(loser.sub, sharedId);
  const winnerVerdicts = winner ? it.verdictsFor(winner.sub, sharedId) : [];
  it.observations.winner = winner === a ? "A" : winner === b ? "B" : "none";
  it.observations.loserVerdicts = histogram(loserVerdicts);
  it.inv(
    "exactly one row for the contested id; every winner copy is accepted",
    rows.length === 1 &&
      winner !== null &&
      results.every((r) => r.status === 200) &&
      winnerVerdicts.length === copies &&
      winnerVerdicts.every((v) => v === "accepted"),
    `rows=${rows.length} winner=${JSON.stringify(histogram(winnerVerdicts))}`,
  );
  it.inv(
    "every loser copy is shot.id_conflict (never accepted, never a write error)",
    loserVerdicts.length === copies && loserVerdicts.every((v) => v === "shot.id_conflict"),
    JSON.stringify(histogram(loserVerdicts)),
  );
  const loserPermitId = loser === a ? pa : pb;
  const loserPermit = snap.permits.find((p) => p.id === loserPermitId);
  it.inv(
    "the loser's permit is untouched (still reserved) and its rating unspent",
    loserPermit?.status === "reserved" &&
      snap.shots.filter((r) => r.userId === loser.sub).length === 0,
    `permit=${loserPermit?.status}/${loserPermit?.outcome}`,
  );
  const again = await it.sync("sync.loser.replay", loser, [it.payload(loser === a ? sa : sb)]);
  const againVerdict = it.verdictsFor(loser.sub, sharedId).slice(-1)[0];
  it.inv(
    "the loser replaying the contested id after the burst is still shot.id_conflict (no cross-user replay-accept)",
    again.status === 200 && againVerdict === "shot.id_conflict",
    `verdict=${againVerdict}`,
  );
  const recover = it.track(loser, loserPermitId);
  const rec = await it.sync("sync.loser.recover", loser, [it.payload(recover)]);
  it.inv(
    "the loser syncs a different id on the same permit successfully",
    rec.status === 200 && it.verdictsFor(loser.sub, recover.id)[0] === "accepted",
    `status=${rec.status} verdict=${it.verdictsFor(loser.sub, recover.id)[0]}`,
  );
};

/** Logout of THIS session lands somewhere inside a burst of duplicate syncs.
 * Every copy is 200 (acknowledging the shot) or 401; the copies that got
 * through wrote ≤ 1 row; afterwards the revoked bearer is refused and a fresh
 * session for the same account completes/replays the shot. */
const logoutDuringSync: Body = async (it) => {
  const a = await it.actor();
  const permit = await it.reserve(a, `k-${it.seed}`);
  const shot = it.track(a, permit);
  const burst = it.prng.int(2, 16);
  const logoutAt = it.prng.int(0, burst);
  const logoutDelay = it.prng.int(0, 2 * STRESS_LATENCY_MS);
  it.params.burst = burst;
  it.params.logoutAt = logoutAt;
  it.params.logoutDelayMs = logoutDelay;
  const lanes: Array<Promise<unknown>> = [];
  for (let i = 0; i <= burst; i++) {
    if (i === logoutAt) {
      lanes.push(
        (async () => {
          if (logoutDelay > 0) await sleep(logoutDelay);
          return it.call("auth.logout", a.sub, () =>
            it.h.handler(
              edgeRequest("POST", "/v1/auth/logout", { token: a.accessToken, ip: it.ip() }),
            ));
        })(),
      );
    } else {
      lanes.push(it.sync(`sync.dup.${i}`, a, [it.payload(shot)]));
    }
  }
  await Promise.all(lanes);
  const syncRows = it.rows.filter((r) => r.op.startsWith("sync.dup"));
  const statuses = histogram(syncRows.map((r) => r.status));
  it.observations.syncStatuses = statuses;
  it.inv(
    "logout is 204; every sync copy is 200 acknowledging the shot (in flight before revocation) or 401 (after)",
    it.rows.some((r) => r.op === "auth.logout" && r.status === 204) &&
      syncRows.every(
        (r) => (r.status === 200 && r.accepted === 1) || r.status === 401,
      ),
    JSON.stringify(syncRows.map((r) => `${r.status}:${r.code ?? r.accepted}`)),
  );
  const stale = await it.sync("sync.revoked", a, [it.payload(shot)]);
  it.inv(
    "after logout settles, the revoked bearer is refused (401)",
    stale.status === 401,
    `status=${stale.status}`,
  );
  const reboot = await bootstrap(it.h, a.sub, it.ip());
  const fresh: Actor = {
    sub: a.sub,
    accessToken: reboot.accessToken,
    refreshToken: reboot.refreshToken,
    premium: false,
  };
  const done = await it.sync("sync.fresh_session", fresh, [it.payload(shot)]);
  it.inv(
    "a fresh session for the same account completes the shot (accepted, exactly one row)",
    reboot.status === 200 &&
      done.status === 200 &&
      it.verdictsFor(a.sub, shot.id).slice(-1)[0] === "accepted",
    `boot=${reboot.status} status=${done.status} verdicts=${
      JSON.stringify(histogram(it.verdictsFor(a.sub, shot.id)))
    }`,
  );
};

/** A refresh (rotation) lands inside a burst; copies before it bear the old
 * access token, copies issued after it bear the new one. Both sets are
 * served; the rotated-away refresh token is refused on reuse. */
const rotationDuringSync: Body = async (it) => {
  const a = await it.actor();
  const permit = await it.reserve(a, `k-${it.seed}`);
  const shot = it.track(a, permit);
  const burst = it.prng.int(2, 12);
  const afterRotation = it.prng.int(1, 4);
  const rotationDelay = it.prng.int(0, STRESS_LATENCY_MS);
  it.params.burst = burst;
  it.params.afterRotation = afterRotation;
  it.params.rotationDelayMs = rotationDelay;
  const rotation = (async () => {
    if (rotationDelay > 0) await sleep(rotationDelay);
    const res = await it.call("auth.refresh", a.sub, () =>
      it.h.handler(
        edgeRequest("POST", "/v1/auth/refresh", {
          ip: it.ip(),
          body: { refreshToken: a.refreshToken },
        }),
      ));
    const s = isRecord(res.body.session) ? res.body.session : {};
    return res.status === 200 && typeof s.accessToken === "string" ? s.accessToken : null;
  })();
  const old = Array.from(
    { length: burst },
    (_, i) => it.sync(`sync.old.${i}`, a, [it.payload(shot)]),
  );
  const fresh = rotation.then((newToken) =>
    newToken === null ? Promise.resolve([]) : Promise.all(
      Array.from(
        { length: afterRotation },
        (_, i) => it.sync(`sync.new.${i}`, a, [it.payload(shot)], newToken),
      ),
    )
  );
  const [newToken] = await Promise.all([rotation, ...old, fresh]);
  const syncRows = it.rows.filter((r) => r.op.startsWith("sync."));
  it.inv(
    "refresh is 200 and every copy (old or new bearer) is 200 acknowledging the shot",
    newToken !== null &&
      syncRows.length === burst + afterRotation &&
      syncRows.every((r) => r.status === 200 && r.accepted === 1),
    JSON.stringify(histogram(syncRows.map((r) => `${r.op.split(".")[1]}:${r.status}`))),
  );
  const reuse = await it.call("auth.refresh.reuse", a.sub, () =>
    it.h.handler(
      edgeRequest("POST", "/v1/auth/refresh", {
        ip: it.ip(),
        body: { refreshToken: a.refreshToken },
      }),
    ));
  it.inv(
    "the rotated-away refresh token is refused on reuse (401)",
    reuse.status === 401,
    `status=${reuse.status}`,
  );
};

/** The client gives up on a request mid-flight (the server keeps going) and
 * retries the same shot — possibly while the orphan is still in flight. */
const cancelAndRetry: Body = async (it) => {
  const a = await it.actor();
  const permit = await it.reserve(a, `k-${it.seed}`);
  const shot = it.track(a, permit);
  const cancelled = it.prng.int(1, 6);
  const waitBeforeRetry = it.prng.int(0, 3 * STRESS_LATENCY_MS);
  const retries = it.prng.int(1, 4);
  it.params.cancelled = cancelled;
  it.params.waitBeforeRetryMs = waitBeforeRetry;
  it.params.retries = retries;
  const orphanResults: Array<Promise<{ status: number }>> = [];
  for (let i = 0; i < cancelled; i++) {
    const controller = new AbortController();
    const request = new Request(it.syncRequest(a, [it.payload(shot)]), {
      signal: controller.signal,
    });
    const orphan = it
      .call(`sync.orphan.${i}`, a.sub, () => it.h.handler(request))
      .catch((e) => ({ status: -1, body: { _raw: String(e) }, row: undefined }));
    orphanResults.push(orphan);
    it.orphans.push(orphan);
    const abortAfter = it.prng.int(0, STRESS_LATENCY_MS);
    sleep(abortAfter).then(() => controller.abort());
  }
  if (waitBeforeRetry > 0) await sleep(waitBeforeRetry);
  const results = await Promise.all(
    Array.from(
      { length: retries },
      (_, i) => it.sync(`sync.retry.${i}`, a, [it.payload(shot)]),
    ),
  );
  it.inv(
    "every retry is 200 and acknowledges the shot",
    results.every((r) => r.status === 200 && r.row.accepted === 1),
    JSON.stringify(results.map((r) => `${r.status}:${r.row.accepted}`)),
  );
  const settled = await Promise.all(orphanResults);
  it.observations.orphanStatuses = histogram(settled.map((r) => r.status));
  it.inv(
    "abandoned copies still settle 200 (no 5xx, no throw, no hang)",
    settled.every((r) => r.status === 200),
    JSON.stringify(histogram(settled.map((r) => r.status))),
  );
};

/** Clock skew at the two time-dependent gates — the permit's 24h expiry and
 * the entitlement's expires_at — placed within a few ms of "now" so the burst
 * straddles them, plus a client capturedAt decades off. Outcomes must be a
 * consistent pair, never a half state. */
const clockSkew: Body = async (it) => {
  const a = await it.actor();
  const variant = it.prng.next() < 0.6 ? "permit_expiry" : "premium_expiry";
  it.params.variant = variant;
  if (variant === "permit_expiry") {
    const skewMs = it.prng.int(-40, 40);
    it.params.permitAgeSkewMs = skewMs;
    const permit = await it.reserve(a, `k-${it.seed}`);
    await it.backend.setPermitCreatedAt(permit, -(24 * 3600 * 1000) + skewMs);
    const shot = it.track(a, permit);
    const burst = it.prng.int(2, 12);
    it.params.burst = burst;
    // client clock decades off (inside the shots_captured_at_bounds window)
    const capturedAt = it.prng.next() < 0.5
      ? "2000-01-01T00:00:00.000Z"
      : "2099-12-31T23:59:59.000Z";
    it.params.capturedAt = capturedAt;
    const results = await Promise.all(
      Array.from(
        { length: burst },
        (_, i) => it.sync(`sync.skew.${i}`, a, [it.payload(shot, { capturedAt })]),
      ),
    );
    const snap = await it.backend.snapshot([a.sub]);
    const rows = snap.shots.filter((r) => r.id === shot.id);
    const p = snap.permits.find((x) => x.id === permit);
    const verdicts = it.verdictsFor(a.sub, shot.id);
    it.observations.verdicts = histogram(verdicts);
    it.observations.permit = `${p?.status}/${p?.outcome}`;
    const consistent = (rows.length === 1 && p?.status === "finalized" && verdicts.every((v) =>
      v === "accepted"
    )) ||
      (rows.length === 0 &&
        p?.status === "released" &&
        p?.outcome === "expired" &&
        verdicts.every(
          (v) => v === "access.permit_expired" || v === "access.permit_not_reserved",
        ));
    it.inv(
      "expiry straddle resolves to ONE state: (row ∧ finalized ∧ all copies accepted) or (no row ∧ released/expired ∧ all copies refused)",
      results.every((r) => r.status === 200) && consistent,
      `rows=${rows.length} permit=${p?.status}/${p?.outcome} verdicts=${
        JSON.stringify(histogram(verdicts))
      }`,
    );
    const freshPermit = await it.reserve(a, `k-${it.seed}-fresh`);
    const again: TrackedShot = { ...shot, permit: freshPermit };
    if (rows.length === 0) {
      it.shots.set(shot.id, again);
      it.refusedThenRewritten.add(shot.id);
    }
    const rec = await it.sync("sync.skew.recover", a, [it.payload(again)]);
    it.inv(
      "re-sync with a fresh permit is accepted (replay if the row exists, write otherwise)",
      rec.status === 200 && it.verdictsFor(a.sub, shot.id).slice(-1)[0] === "accepted",
      `status=${rec.status} verdict=${it.verdictsFor(a.sub, shot.id).slice(-1)[0]}`,
    );
  } else {
    const skewMs = it.prng.int(-40, 60);
    it.params.premiumExpirySkewMs = skewMs;
    for (let i = 0; i < 2; i++) {
      const p = await it.reserve(a, `pre-${it.seed}-${i}`);
      const r = await it.sync(`sync.pre.${i}`, a, [it.payload(it.track(a, p))]);
      if (r.status !== 200 || r.row.accepted !== 1) throw new Error(`pre-spend failed ${r.status}`);
    }
    await it.backend.setPremium(a.sub, new Date(Date.now() + skewMs).toISOString());
    a.premium = true; // the ≤2 rule is suspended; permit/row accounting is not
    const m = it.prng.int(2, 8);
    it.params.burst = m;
    const shots: TrackedShot[] = [];
    for (let i = 0; i < m; i++) shots.push(it.track(a, await it.forge(a, `pf-${it.seed}-${i}`)));
    const results = await Promise.all(
      shots.map((s, i) => it.sync(`sync.premskew.${i}`, a, [it.payload(s)])),
    );
    const snap = await it.backend.snapshot([a.sub]);
    const verdictOf = (s: TrackedShot) => it.verdictsFor(a.sub, s.id)[0];
    const accepted = shots.filter((s) => verdictOf(s) === "accepted");
    const refused = shots.filter((s) => verdictOf(s) !== "accepted");
    const permitOf = (s: TrackedShot) => snap.permits.find((p) => p.id === s.permit);
    const finalized = shots.filter((s) => permitOf(s)?.status === "finalized").length;
    const releasedFLE = shots.filter(
      (s) => permitOf(s)?.status === "released" && permitOf(s)?.outcome === "free_limit_exceeded",
    ).length;
    it.observations.accepted = accepted.length;
    it.observations.refused = histogram(refused.map(verdictOf));
    it.inv(
      "premium-expiry straddle: accepted == finalized permits == new scored rows; refused == released/free_limit_exceeded, all access.paywall_required",
      results.every((r) => r.status === 200) &&
        finalized === accepted.length &&
        snap.shots.filter((r) => r.userId === a.sub).length === 2 + accepted.length &&
        releasedFLE === refused.length &&
        refused.every((s) => verdictOf(s) === "access.paywall_required"),
      `accepted=${accepted.length} finalized=${finalized} refused=${refused.length} releasedFLE=${releasedFLE}`,
    );
  }
};

/** Random batches over a small pool of shots (drawn with replacement →
 * duplicates within and across batches), malformed entries, a shot whose
 * session does not exist, a shot whose session is created concurrently, on a
 * premium or a free account. */
const mixedBatchStorm: Body = async (it) => {
  const a = await it.actor();
  const premium = it.prng.next() < 0.5;
  if (premium) {
    await it.backend.setPremium(a.sub, null);
    a.premium = true;
  }
  const poolSize = it.prng.int(2, 7);
  const requests = it.prng.int(2, 12);
  const malformed = it.prng.int(0, 3);
  const withUnknownSession = it.prng.next() < 0.5;
  const withRacingSession = it.prng.next() < 0.5;
  it.params.premium = premium;
  it.params.poolSize = poolSize;
  it.params.requests = requests;
  it.params.malformed = malformed;
  it.params.unknownSession = withUnknownSession;
  it.params.racingSession = withRacingSession;
  const pool: TrackedShot[] = [];
  let legit = 0;
  for (let i = 0; i < poolSize; i++) {
    const kind = it.prng.next() < 0.7 ? "scored" : "low_confidence";
    let permit: string;
    if (legit < 2) {
      permit = await it.reserve(a, `pool-${it.seed}-${i}`);
      legit++;
    } else {
      permit = await it.forge(a, `pool-${it.seed}-${i}`);
    }
    pool.push(it.track(a, permit, kind));
  }
  const unknown = withUnknownSession
    ? it.track(a, await it.forge(a, `unk-${it.seed}`), "low_confidence", {
      id: it.prng.uuid(),
      exists: false,
    })
    : null;
  const racing = withRacingSession
    ? it.track(a, await it.forge(a, `race-${it.seed}`), "low_confidence", {
      id: it.prng.uuid(),
      exists: true,
    })
    : null;
  const garbage = (): unknown => {
    const pick = it.prng.int(0, 3);
    const id = it.prng.uuid();
    if (pick === 0) return { id: "not-a-uuid", source: "real" };
    if (pick === 1) return it.payload(pool[0], { id, source: "synthetic" });
    if (pick === 2) return it.payload(pool[0], { id, overallScore: 42 });
    return null;
  };
  const lanes = Array.from({ length: requests }, (_, i) => {
    const n = it.prng.int(1, 6);
    const entries: unknown[] = [];
    for (let j = 0; j < n; j++) entries.push(it.payload(pool[it.prng.int(0, pool.length - 1)]));
    return { i, entries };
  });
  if (racing) lanes[0].entries.push(it.payload(racing));
  if (unknown) lanes[it.prng.int(0, lanes.length - 1)].entries.push(it.payload(unknown));
  for (let i = 0; i < malformed; i++) {
    lanes[it.prng.int(0, lanes.length - 1)].entries.push(garbage());
  }
  const sessionRace = racing
    ? (async () => {
      await sleep(it.prng.int(0, 2 * STRESS_LATENCY_MS));
      await it.backend.createSession(a.sub, racing.sessionId!);
    })()
    : Promise.resolve();
  const [responses] = await Promise.all([
    Promise.all(it.prng.shuffle(lanes).map((l) => it.sync(`sync.storm.${l.i}`, a, l.entries))),
    sessionRace,
  ]);
  it.inv(
    "every storm request is 200",
    responses.every((r) => r.status === 200),
    JSON.stringify(histogram(responses.map((r) => r.status))),
  );
  const allRejected = responses.flatMap((r) =>
    Object.entries(r.row.rejected).flatMap(([c, n]) => Array.from({ length: n }, () => c))
  );
  const invalid = allRejected.filter(
    (c) => c === "shot.invalid_payload" || c === "shot.non_real_source",
  ).length;
  it.inv(
    "malformed entries are rejected one-for-one without poisoning the batch",
    invalid === malformed,
    `invalid=${invalid} sent=${malformed} codes=${JSON.stringify(histogram(allRejected))}`,
  );
  const snap = await it.backend.snapshot([a.sub]);
  const attempted = new Set<string>();
  for (const l of lanes) {
    for (const e of l.entries) if (isRecord(e) && typeof e.id === "string") attempted.add(e.id);
  }
  const scoredPool = pool.filter((s) => s.resultKind === "scored" && attempted.has(s.id));
  const abstPool = pool.filter((s) => s.resultKind === "low_confidence" && attempted.has(s.id));
  const scoredRows = snap.shots.filter((r) => r.userId === a.sub && r.resultKind === "scored")
    .length;
  const abstRows = snap.shots.filter(
    (r) => r.userId === a.sub && r.resultKind === "low_confidence",
  ).length;
  it.observations.attempted = { scored: scoredPool.length, abstentions: abstPool.length };
  it.inv(
    premium
      ? "premium: every attempted scored shot has a row"
      : "free: exactly min(2, attempted scored shots) scored rows",
    scoredRows === (premium ? scoredPool.length : Math.min(2, scoredPool.length)),
    `scoredRows=${scoredRows} attemptedScored=${scoredPool.length}`,
  );
  const racingVerdict = racing ? it.verdictsFor(a.sub, racing.id)[0] : null;
  const racingRow = racing ? snap.shots.some((r) => r.id === racing.id) : false;
  const unknownRow = unknown ? snap.shots.some((r) => r.id === unknown.id) : false;
  const unknownVerdict = unknown ? it.verdictsFor(a.sub, unknown.id)[0] : null;
  it.observations.racingSession = racingVerdict;
  it.observations.unknownSession = unknownVerdict;
  it.inv(
    "every attempted abstention has a row; the unknown-session shot has none and is shot.session_not_found",
    abstRows === abstPool.length + (racingRow ? 1 : 0) &&
      (!unknown || (!unknownRow && unknownVerdict === "shot.session_not_found")),
    `abstRows=${abstRows} attemptedAbst=${abstPool.length} racingRow=${racingRow} unknown=${unknownVerdict}/${unknownRow}`,
  );
  it.inv(
    "a shot whose session is being created concurrently is accepted (row) or shot.session_not_found (no row, permit still reserved) — never a row without its session",
    !racing ||
      (racingVerdict === "accepted" && racingRow) ||
      (racingVerdict === "shot.session_not_found" &&
        !racingRow &&
        snap.permits.find((p) => p.id === racing.permit)?.status === "reserved"),
    `verdict=${racingVerdict} row=${racingRow}`,
  );
};

export const BODIES: Record<Kind, Body> = {
  dup_same_shot: dupSameShot,
  dup_in_batch: dupInBatch,
  permit_reuse: permitReuse,
  free_limit_backstop: freeLimitBackstop,
  two_actors_same_id: twoActorsSameId,
  logout_during_sync: logoutDuringSync,
  rotation_during_sync: rotationDuringSync,
  cancel_and_retry: cancelAndRetry,
  clock_skew: clockSkew,
  mixed_batch_storm: mixedBatchStorm,
};

// ── Runner ───────────────────────────────────────────────────────────────────

export interface CampaignSummary {
  backend: string;
  seed: number;
  iterationsRequested: number;
  iterationsExecuted: number;
  requestsExecuted: number;
  held: number;
  broken: number;
  timeout: number;
  masked: number;
  byKind: Record<string, { executed: number; held: number; notHeld: number }>;
  notHeldIndexes: number[];
  invariantFailures: Record<string, number>;
  /** modelled-upstream / pg-bridge call counters summed over the campaign
   * (proof of which backend served the RPCs and how many times) */
  upstreamCounters: Record<string, number>;
  durationMs: number;
  replayHint: string;
  iterations: IterationRow[];
}

export async function runIteration(
  h: XcHarness,
  backend: StressBackend,
  index: number,
  ipOctet: number,
  replayHint: (index: number) => string,
): Promise<IterationRow> {
  const seed = mix(STRESS_SEED, index);
  const kind = kindFor(index);
  h.fake.reset(seed, STRESS_LATENCY_MS);
  h.upstreamCalls.length = 0;
  const it = new Iteration(h, backend, index, seed, kind, ipOctet);
  const t0 = performance.now();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), STRESS_ITER_TIMEOUT_MS);
  });
  try {
    const raced = await Promise.race([BODIES[kind](it).then(() => "done" as const), timeout]);
    timedOut = raced === "timeout";
    it.inv(
      "iteration settles within the wall-time bound (no deadlock)",
      !timedOut,
      timedOut ? `> ${STRESS_ITER_TIMEOUT_MS}ms` : `${Math.round(performance.now() - t0)}ms`,
    );
  } catch (error) {
    it.inv("scenario body ran without a harness error", false, String(error));
  } finally {
    clearTimeout(timer);
  }
  if (!timedOut) {
    try {
      await audit(it);
    } catch (error) {
      it.inv("audit ran without a harness error", false, String(error));
    }
  }
  const broken = it.invariants.filter((i) => !i.holds);
  const outcome: IterationRow["outcome"] = timedOut
    ? "TIMEOUT"
    : it.rows.some((r) => r.status === 429)
    ? "MASKED"
    : broken.length > 0
    ? "BROKEN"
    : "HELD";
  const row: IterationRow = {
    index,
    seed,
    kind,
    backend: backend.name,
    params: it.params,
    requests: it.rows.length,
    statusHistogram: histogram(it.rows.map((r) => r.status)),
    codeHistogram: histogram(
      it.rows.flatMap((r) => [
        ...(r.code ? [r.code] : []),
        ...Object.entries(r.rejected).flatMap(([c, n]) => Array.from({ length: n }, () => c)),
      ]),
    ),
    invariants: it.invariants,
    observations: it.observations,
    outcome,
    durationMs: Math.round(performance.now() - t0),
    replay: replayHint(index),
  };
  if (outcome !== "HELD") {
    row.timeline = h.fake.timeline;
    row.requestRows = it.rows;
  }
  return row;
}

export async function runCampaign(
  h: XcHarness,
  backend: StressBackend,
  ipOctet: number,
  replayHint: (index: number) => string,
  fileStem: string,
): Promise<CampaignSummary> {
  const indexes = STRESS_REPLAY.length > 0
    ? STRESS_REPLAY
    : Array.from({ length: STRESS_ITER }, (_, i) => i);
  const t0 = performance.now();
  const iterations: IterationRow[] = [];
  const upstreamCounters: Record<string, number> = {};
  for (const index of indexes) {
    const row = await runIteration(h, backend, index, ipOctet, replayHint);
    iterations.push(row);
    for (const [k, n] of Object.entries(h.fake.counters)) {
      upstreamCounters[k] = (upstreamCounters[k] ?? 0) + n;
    }
    if (row.outcome !== "HELD") {
      console.log(
        `[stress:${backend.name}] #${index} seed=${row.seed} ${row.kind} → ${row.outcome}\n` +
          row.invariants
            .filter((i) => !i.holds)
            .map((i) => `    NOT HELD: ${i.name} — ${i.detail}`)
            .join("\n") +
          `\n    replay: ${row.replay}`,
      );
    }
  }
  const byKind: CampaignSummary["byKind"] = {};
  const invariantFailures: Record<string, number> = {};
  for (const r of iterations) {
    byKind[r.kind] ??= { executed: 0, held: 0, notHeld: 0 };
    byKind[r.kind].executed++;
    if (r.outcome === "HELD") byKind[r.kind].held++;
    else byKind[r.kind].notHeld++;
    for (const i of r.invariants) {
      if (!i.holds) invariantFailures[i.name] = (invariantFailures[i.name] ?? 0) + 1;
    }
  }
  const summary: CampaignSummary = {
    backend: backend.name,
    seed: STRESS_SEED,
    iterationsRequested: indexes.length,
    iterationsExecuted: iterations.length,
    requestsExecuted: iterations.reduce((n, r) => n + r.requests, 0),
    held: iterations.filter((r) => r.outcome === "HELD").length,
    broken: iterations.filter((r) => r.outcome === "BROKEN").length,
    timeout: iterations.filter((r) => r.outcome === "TIMEOUT").length,
    masked: iterations.filter((r) => r.outcome === "MASKED").length,
    byKind,
    notHeldIndexes: iterations.filter((r) => r.outcome !== "HELD").map((r) => r.index),
    invariantFailures,
    upstreamCounters,
    durationMs: Math.round(performance.now() - t0),
    replayHint: replayHint(-1).replace("STRESS_REPLAY=-1", "STRESS_REPLAY=<index>"),
    iterations,
  };
  const dir = stressOutDir();
  await Deno.mkdir(dir, { recursive: true });
  const path = `${dir}${fileStem}.json`;
  await Deno.writeTextFile(path, JSON.stringify(summary, null, 2));
  const table = iterations.map((r) => ({
    index: r.index,
    seed: r.seed,
    kind: r.kind,
    outcome: r.outcome,
    requests: r.requests,
    durationMs: r.durationMs,
    notHeld: r.invariants.filter((i) => !i.holds).map((i) => i.name),
  }));
  await Deno.writeTextFile(`${dir}${fileStem}.seeds.json`, JSON.stringify(table, null, 2));
  console.log(
    `[stress:${backend.name}] ${summary.iterationsExecuted} iterations, ${summary.requestsExecuted} requests, ` +
      `held=${summary.held} broken=${summary.broken} timeout=${summary.timeout} masked=${summary.masked} ` +
      `in ${summary.durationMs}ms → ${path}`,
  );
  return summary;
}
