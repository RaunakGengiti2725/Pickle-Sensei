/**
 * Boundary/malformed-input stress campaign for `drainOutbox`.
 *
 * Every family is a pure function of a 32-bit seed: it builds a real-SQLite
 * outbox, a transport whose behaviour is derived from the same seed, runs the
 * production drain, and checks the graceful-rejection invariants below. A
 * violation is a BROKEN row in the JSON table (seed + category + observed);
 * the absence of violations is a HELD row.
 *
 * Invariant codes (the `violations` column of the table):
 *   V_THROW          drainOutbox rejected instead of recording row failures
 *   V_PROTO          Object/Array prototype or globalThis gained a property
 *   V_REMAINING      result.remaining ≠ actual owner-scoped row count
 *   V_FOREIGN        a row belonging to another owner was touched
 *   V_LASTERR        a failed row lacks a non-empty string last_error
 *   V_ATTEMPTS       attempts moved by something other than +0/+1, or the
 *                    wrong delta for the failure class
 *   V_SENT_MALFORMED an undrainable payload reached the transport
 *   V_NOT_SENT       a drainable payload never reached the transport
 *   V_DELETED        a row was deleted without an exact-string server ack,
 *                    or an acked shot was not deleted
 *   V_RECEIPT        receipts ≠ deleted shot ids (atomicity / rollback)
 *   V_TXN_OPEN       a transaction was left open after the drain
 *   V_LIMIT          rows outside the SELECT window (LIMIT 50 / attempts
 *                    budget) were touched
 *   V_ACCOUNTING     synced/failed counters disagree with the row outcomes
 *   V_POISON         a row the server will never accept stays retryable
 *                    beyond OUTBOX_MAX_ATTEMPTS drains
 *   V_LOST           a row disappeared without an ack (data loss)
 */
import type { SyncTransport } from '../../../src/data/sync';
import { ApiError } from '../../../src/data/api';
import {
  drainOutbox,
  OUTBOX_MAX_ATTEMPTS,
  TRANSIENT_SYNC_REJECTION_CODES,
} from '../../../src/data/sync';
import {
  GUEST_DATA_OWNER,
  SIGNED_OUT_DATA_OWNER,
  getActiveDataOwner,
  setActiveDataOwner,
} from '../../../src/data/accountScope';
import {
  fs,
  nodeProcess,
  path,
} from '../../../xc-harness/lifecycle-persistence/nodeShim';
import {
  corruptRawJson,
  hostileString,
  hostileThrowable,
  isDrainableShotPayload,
  malformedResponse,
  mutateShotObject,
  mutateValue,
  preview,
  UUID_RE,
  validSessionPayload,
  validShotPayload,
  validTrialPayload,
} from './payloads';
import { iterationSeed, makeRng, seededUuid, type Rng } from './rng';
import {
  createSqliteOutboxDb,
  type OutboxRow,
  type SqliteOutboxDb,
} from './sqliteOutboxDb';

declare const __dirname: string;

export const FAMILIES = [
  'shot-payload',
  'response-shape',
  'transport-throw',
  'session-trial-rows',
  'mixed-batch',
  'db-fault-rollback',
  'concurrent-drains',
] as const;
export type Family = (typeof FAMILIES)[number];

export interface IterationResult {
  family: Family;
  seed: number;
  category: string;
  outcome: 'HELD' | 'BROKEN';
  violations: string[];
  detail: Record<string, unknown>;
  durationMs: number;
}

const OTHER_OWNER = '0b4d1f9e-3c2a-4b8e-9f1d-2a6c7e8b9d01';

// ─── shared checks ──────────────────────────────────────────────────────────

function protoSnapshot(): string {
  return JSON.stringify([
    Object.getOwnPropertyNames(Object.prototype),
    Object.getOwnPropertyNames(Array.prototype),
    Object.getOwnPropertyNames(Function.prototype),
    Object.getOwnPropertyNames(globalThis).filter(k => k === 'polluted'),
    'polluted' in {},
  ]);
}

interface Ctx {
  seed: number;
  rng: Rng;
  store: SqliteOutboxDb;
  owner: string;
  violations: string[];
  detail: Record<string, unknown>;
  /** Snapshot of rows the drain must never touch; taken at the first drain. */
  foreignBefore: string | null;
  /** Owners whose rows/receipts the drain(s) under test must never write. */
  isForeignOwner: (owner: string) => boolean;
  protoBefore: string;
}

function begin(seed: number, family: Family): Ctx {
  const rng = makeRng(seed);
  const store = createSqliteOutboxDb();
  const owner = GUEST_DATA_OWNER;
  setActiveDataOwner(owner);
  // Foreign-owner rows must never be touched by a guest drain.
  store.insert({
    owner: OTHER_OWNER,
    kind: 'shot.sync',
    payload: JSON.stringify(validShotPayload(rng)),
  });
  store.insert({
    owner: SIGNED_OUT_DATA_OWNER,
    kind: 'session.create',
    payload: 'not json',
  });
  store.insert({
    owner: OTHER_OWNER,
    kind: 'shot.sync',
    payload: '{',
    attempts: 3,
  });
  return {
    seed,
    rng,
    store,
    owner,
    violations: [],
    detail: { family },
    foreignBefore: null,
    isForeignOwner: o => o !== owner,
    protoBefore: protoSnapshot(),
  };
}

function fail(ctx: Ctx, code: string, why: string): void {
  ctx.violations.push(code);
  const list = (ctx.detail['why'] as string[] | undefined) ?? [];
  list.push(`${code}: ${why}`);
  ctx.detail['why'] = list;
}

async function runDrain(
  ctx: Ctx,
  transport: SyncTransport,
): Promise<{ synced: number; failed: number; remaining: number } | null> {
  // Foreign-owner rows are frozen at the first drain, after seeding.
  if (ctx.foreignBefore === null) {
    ctx.foreignBefore = JSON.stringify(
      ctx.store.rows().filter(r => ctx.isForeignOwner(r.owner_key)),
    );
  }
  try {
    return await drainOutbox(ctx.store.db, transport);
  } catch (error) {
    fail(ctx, 'V_THROW', preview(error));
    return null;
  }
}

function checkCommon(
  ctx: Ctx,
  result: { synced: number; failed: number; remaining: number } | null,
): void {
  const rows = ctx.store.rows();
  const own = rows.filter(r => r.owner_key === ctx.owner);
  if (result && result.remaining !== own.length) {
    fail(
      ctx,
      'V_REMAINING',
      `remaining=${result.remaining} rows=${own.length}`,
    );
  }
  const foreignAfter = JSON.stringify(
    rows.filter(r => ctx.isForeignOwner(r.owner_key)),
  );
  if (ctx.foreignBefore !== null && foreignAfter !== ctx.foreignBefore)
    fail(ctx, 'V_FOREIGN', 'foreign rows changed');
  if (protoSnapshot() !== ctx.protoBefore)
    fail(ctx, 'V_PROTO', 'prototype changed');
  if (ctx.store.inTransaction())
    fail(ctx, 'V_TXN_OPEN', 'transaction left open');
  const receipts = ctx.store.receipts();
  if (receipts.some(r => ctx.isForeignOwner(r.owner_key))) {
    fail(ctx, 'V_FOREIGN', 'receipt written for another owner');
  }
}

function finish(
  ctx: Ctx,
  startedAt: number,
  family: Family,
  category: string,
): IterationResult {
  ctx.store.close();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  return {
    family,
    seed: ctx.seed,
    category,
    outcome: ctx.violations.length === 0 ? 'HELD' : 'BROKEN',
    violations: [...new Set(ctx.violations)],
    detail: ctx.detail,
    durationMs: Date.now() - startedAt,
  };
}

interface SeededRow {
  id: number;
  kind: string;
  stored: string;
  label: string;
  attemptsBefore: number;
}

function rowById(rows: OutboxRow[], id: number): OutboxRow | undefined {
  return rows.find(r => r.id === id);
}

/** Retained-row contract: still there, string last_error, attempts moved by `delta`. */
function expectRetained(
  ctx: Ctx,
  rows: OutboxRow[],
  seeded: SeededRow,
  delta: 0 | 1 | null,
  why: string,
): void {
  const row = rowById(rows, seeded.id);
  if (!row) {
    fail(ctx, 'V_LOST', `${why}: row ${seeded.id} (${seeded.label}) vanished`);
    return;
  }
  if (typeof row.last_error !== 'string' || row.last_error.length === 0) {
    fail(ctx, 'V_LASTERR', `${why}: last_error=${preview(row.last_error)}`);
  }
  const moved = row.attempts - seeded.attemptsBefore;
  if (moved !== 0 && moved !== 1) {
    fail(ctx, 'V_ATTEMPTS', `${why}: attempts moved by ${moved}`);
  } else if (delta !== null && moved !== delta) {
    fail(
      ctx,
      'V_ATTEMPTS',
      `${why}: expected +${delta}, got +${moved} (${seeded.label})`,
    );
  }
}

function expectDeleted(
  ctx: Ctx,
  rows: OutboxRow[],
  seeded: SeededRow,
  why: string,
): void {
  if (rowById(rows, seeded.id))
    fail(ctx, 'V_DELETED', `${why}: acked row ${seeded.id} retained`);
}

/** A transport that accepts exactly the well-formed items and records calls. */
interface StrictTransport extends SyncTransport {
  calls: {
    syncShots: unknown[][];
    createSession: unknown[];
    finalizeSession: string[];
    trials: unknown[][];
  };
}

function strictTransport(withTrials: boolean): StrictTransport {
  const calls: StrictTransport['calls'] = {
    syncShots: [],
    createSession: [],
    finalizeSession: [],
    trials: [],
  };
  const transport: StrictTransport = {
    calls,
    async syncShots(shots) {
      calls.syncShots.push(shots);
      const acceptedIds: string[] = [];
      const rejected: Array<{ id: string; code: string; message: string }> = [];
      for (const shot of shots) {
        const id = (shot as Record<string, unknown>)['id'];
        if (typeof id === 'string' && UUID_RE.test(id)) acceptedIds.push(id);
        else
          rejected.push({
            id: String(id),
            code: 'shot.invalid',
            message: 'id must be a uuid',
          });
      }
      return { acceptedIds, rejected };
    },
    async createSession(session) {
      calls.createSession.push(session);
      const id = (session as Record<string, unknown> | null)?.['id'];
      if (
        typeof session !== 'object' ||
        session === null ||
        typeof id !== 'string' ||
        !UUID_RE.test(id)
      ) {
        throw new ApiError(400, 'session.invalid', 'session payload rejected');
      }
    },
    async finalizeSession(id) {
      calls.finalizeSession.push(id);
      if (!UUID_RE.test(id)) {
        throw new ApiError(404, 'session.not_found', 'no such session');
      }
    },
  };
  if (withTrials) {
    transport.uploadEvaluationTrials = async trials => {
      calls.trials.push(trials);
      const acceptedTrialIds: string[] = [];
      const rejected: Array<{
        trialId: string;
        code: string;
        message: string;
      }> = [];
      for (const trial of trials) {
        const id = (trial as Record<string, unknown>)['trialId'];
        if (typeof id === 'string' && UUID_RE.test(id))
          acceptedTrialIds.push(id);
        else
          rejected.push({
            trialId: String(id),
            code: 'evaluation.invalid',
            message: 'bad trial',
          });
      }
      return { acceptedTrialIds, rejected };
    };
  }
  return transport;
}

function tryParse(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

/**
 * Oracle: would the strict transport accept this stored row? Mirrors the
 * production parse (JSON.parse → String(payload.id) for finalize) plus the
 * strict server's uuid check, so the harness never guesses from a label.
 */
function strictServerAccepts(kind: string, stored: string): boolean {
  const parsed = tryParse(stored);
  if (!parsed.ok) return false;
  const obj =
    typeof parsed.value === 'object' &&
    parsed.value !== null &&
    !Array.isArray(parsed.value)
      ? (parsed.value as Record<string, unknown>)
      : null;
  if (kind === 'shot.sync') {
    if (!isDrainableShotPayload(parsed.value)) return false;
    const id = obj?.['id'];
    return typeof id === 'string' && UUID_RE.test(id);
  }
  const idKey = kind === 'evaluation.trial' ? 'trialId' : 'id';
  const idValue = obj?.[idKey];
  const validId = typeof idValue === 'string' && UUID_RE.test(idValue);
  return (
    (kind === 'session.create' ||
      kind === 'session.finalize' ||
      kind === 'evaluation.trial') &&
    obj !== null &&
    validId
  );
}

/** Build a malformed shot payload text from the seed. */
function malformedShotText(rng: Rng): { label: string; stored: string } {
  const base = validShotPayload(rng);
  if (rng.chance(0.45)) {
    const corrupted = corruptRawJson(rng, JSON.stringify(base));
    return { label: corrupted.label, stored: corrupted.value };
  }
  const mutated = mutateShotObject(rng, base, 'id');
  return { label: mutated.label, stored: JSON.stringify(mutated.value) };
}

/**
 * Drain repeatedly until nothing eligible is left; every row the strict
 * transport never accepts must fall out of the `attempts < MAX` window.
 */
async function checkPoisonExpiry(
  ctx: Ctx,
  transport: SyncTransport,
): Promise<void> {
  const eligibleNow = () =>
    ctx.store
      .rows()
      .filter(
        r => r.owner_key === ctx.owner && r.attempts < OUTBOX_MAX_ATTEMPTS,
      ).length;
  for (let i = 0; i < OUTBOX_MAX_ATTEMPTS + 1; i += 1) {
    const eligibleBefore = eligibleNow();
    const before = ctx.store.statements.length;
    const result = await runDrain(ctx, transport);
    if (!result) return;
    const touched = ctx.store.statements
      .slice(before)
      .some(sql => /^\s*(UPDATE|DELETE|INSERT)/i.test(sql));
    if (eligibleBefore === 0) {
      if (touched) fail(ctx, 'V_LIMIT', 'drain wrote with no eligible rows');
      if (result.synced !== 0 || result.failed !== 0)
        fail(ctx, 'V_ACCOUNTING', 'idle drain reported work');
      return;
    }
  }
  const stuck = ctx.store
    .rows()
    .filter(r => r.owner_key === ctx.owner && r.attempts < OUTBOX_MAX_ATTEMPTS);
  if (stuck.length > 0) {
    fail(
      ctx,
      'V_POISON',
      `${stuck.length} row(s) still retryable after ${OUTBOX_MAX_ATTEMPTS + 1} drains: ${stuck
        .map(
          r =>
            `${r.kind}#${r.id} attempts=${r.attempts} last_error=${preview(r.last_error, 60)}`,
        )
        .join('; ')}`,
    );
  }
}

// ─── family: shot-payload ───────────────────────────────────────────────────

async function shotPayloadFamily(seed: number): Promise<IterationResult> {
  const startedAt = Date.now();
  const ctx = begin(seed, 'shot-payload');
  const { rng, store } = ctx;
  const seeded: SeededRow[] = [];
  const count = rng.int(1, 3);
  for (let i = 0; i < count; i += 1) {
    const { label, stored } = malformedShotText(rng);
    const attemptsBefore = rng.chance(0.2) ? OUTBOX_MAX_ATTEMPTS - 1 : 0;
    const id = store.insert({
      owner: ctx.owner,
      kind: 'shot.sync',
      payload: stored,
      attempts: attemptsBefore,
    });
    seeded.push({
      id,
      kind: 'shot.sync',
      stored: store.storedPayload(id),
      label,
      attemptsBefore,
    });
  }
  const control = rng.chance(0.6);
  let controlRow: SeededRow | null = null;
  let controlShotId = '';
  if (control) {
    controlShotId = seededUuid(rng);
    const stored = JSON.stringify(validShotPayload(rng, controlShotId));
    const id = store.insert({
      owner: ctx.owner,
      kind: 'shot.sync',
      payload: stored,
    });
    controlRow = {
      id,
      kind: 'shot.sync',
      stored,
      label: 'control-valid',
      attemptsBefore: 0,
    };
  }
  const category = seeded.map(s => s.label).join(' | ');
  ctx.detail['rows'] = seeded.map(s => ({
    id: s.id,
    label: s.label,
    payload: preview(s.stored),
  }));
  ctx.detail['control'] = control;

  const transport = strictTransport(false);
  const result = await runDrain(ctx, transport);
  const rows = store.rows();
  const sent = transport.calls.syncShots.flat() as Record<string, unknown>[];
  const sentIds = sent.map(s => s['id']);

  let drainableCount = control ? 1 : 0;
  let deletedCount = 0;
  for (const s of seeded) {
    const parsed = tryParse(s.stored);
    const drainable = parsed.ok && isDrainableShotPayload(parsed.value);
    if (!drainable) {
      expectRetained(ctx, rows, s, 1, 'malformed shot');
      continue;
    }
    drainableCount += 1;
    const shotId = (parsed.value as Record<string, unknown>)['id'];
    if (
      !sentIds.some(
        id =>
          Object.is(id, shotId) ||
          JSON.stringify(id) === JSON.stringify(shotId),
      )
    ) {
      fail(
        ctx,
        'V_NOT_SENT',
        `drainable ${s.label} never reached the transport`,
      );
    }
    if (typeof shotId === 'string' && UUID_RE.test(shotId)) {
      expectDeleted(ctx, rows, s, 'server-accepted shot');
      deletedCount += 1;
      if (
        !store
          .receipts()
          .some(r => r.entity_id === shotId && r.kind === 'shot.sync')
      ) {
        fail(ctx, 'V_RECEIPT', `no receipt for accepted ${shotId}`);
      }
    } else {
      expectRetained(ctx, rows, s, 1, 'server-rejected shot');
    }
  }
  if (controlRow) {
    expectDeleted(ctx, rows, controlRow, 'control');
    deletedCount += 1;
    if (!store.receipts().some(r => r.entity_id === controlShotId)) {
      fail(ctx, 'V_RECEIPT', 'no receipt for control shot');
    }
  }
  if (sent.length !== drainableCount) {
    fail(
      ctx,
      'V_SENT_MALFORMED',
      `transport saw ${sent.length} shots, ${drainableCount} were drainable`,
    );
  }
  if (result && result.synced !== deletedCount) {
    fail(
      ctx,
      'V_ACCOUNTING',
      `synced=${result.synced} deleted=${deletedCount}`,
    );
  }
  const ownRetained = rows.filter(r => r.owner_key === ctx.owner).length;
  if (result && result.failed !== ownRetained) {
    fail(
      ctx,
      'V_ACCOUNTING',
      `failed=${result.failed} retained=${ownRetained}`,
    );
  }
  checkCommon(ctx, result);
  if (ctx.violations.length === 0) await checkPoisonExpiry(ctx, transport);
  checkCommon(ctx, null);
  return finish(ctx, startedAt, 'shot-payload', category);
}

// ─── family: response-shape ─────────────────────────────────────────────────

async function responseShapeFamily(seed: number): Promise<IterationResult> {
  const startedAt = Date.now();
  const ctx = begin(seed, 'response-shape');
  const { rng, store } = ctx;
  const shots: Array<SeededRow & { shotId: string }> = [];
  const count = rng.int(1, 4);
  for (let i = 0; i < count; i += 1) {
    const shotId = rng.chance(0.1)
      ? rng.pick(['a', '', ' ', '__proto__', 'constructor'])
      : seededUuid(rng);
    const stored = JSON.stringify(validShotPayload(rng, shotId));
    const id = store.insert({
      owner: ctx.owner,
      kind: 'shot.sync',
      payload: stored,
    });
    shots.push({
      id,
      kind: 'shot.sync',
      stored,
      label: `shot:${preview(shotId, 40)}`,
      attemptsBefore: 0,
      shotId,
    });
  }
  const trials: Array<SeededRow & { trialId: string }> = [];
  const withTrials = rng.chance(0.35);
  if (withTrials) {
    const n = rng.int(1, 2);
    for (let i = 0; i < n; i += 1) {
      const trialId = seededUuid(rng);
      const stored = JSON.stringify(validTrialPayload(rng, trialId));
      const id = store.insert({
        owner: ctx.owner,
        kind: 'evaluation.trial',
        payload: stored,
      });
      trials.push({
        id,
        kind: 'evaluation.trial',
        stored,
        label: 'trial',
        attemptsBefore: 0,
        trialId,
      });
    }
  }

  let shotResponse: { label: string; value: unknown } | null = null;
  let trialResponse: { label: string; value: unknown } | null = null;
  const transport: SyncTransport = {
    async syncShots(sentShots) {
      const ids = sentShots.map(s =>
        String((s as Record<string, unknown>)['id']),
      );
      shotResponse = malformedResponse(rng, ids, 'id', 'acceptedIds');
      return shotResponse.value as never;
    },
    async createSession() {},
    async finalizeSession() {},
  };
  if (withTrials) {
    transport.uploadEvaluationTrials = async sentTrials => {
      const ids = sentTrials.map(t =>
        String((t as Record<string, unknown>)['trialId']),
      );
      trialResponse = malformedResponse(
        rng,
        ids,
        'trialId',
        'acceptedTrialIds',
      );
      return trialResponse.value as never;
    };
  }

  const result = await runDrain(ctx, transport);
  const rows = store.rows();
  const receipts = store.receipts();
  const shotBody = shotResponse as { label: string; value: unknown } | null;
  const trialBody = trialResponse as { label: string; value: unknown } | null;
  const category = `${shotBody?.label ?? 'shots-not-sent'}${withTrials ? ` + trials:${trialBody?.label ?? 'not-sent'}` : ''}`;
  ctx.detail['shotResponse'] = preview(shotBody?.value, 240);
  if (withTrials) ctx.detail['trialResponse'] = preview(trialBody?.value, 240);
  ctx.detail['shots'] = shots.map(s => s.shotId);
  if (!shotBody)
    fail(ctx, 'V_NOT_SENT', 'valid shots never reached the transport');

  const exactAccepted = (body: unknown, field: string): Set<string> => {
    if (typeof body !== 'object' || body === null) return new Set();
    const accepted = (body as Record<string, unknown>)[field];
    if (!Array.isArray(accepted)) return new Set();
    return new Set(accepted.filter((v): v is string => typeof v === 'string'));
  };
  const transientFor = (body: unknown, idField: string): Set<string> => {
    const out = new Set<string>();
    if (typeof body !== 'object' || body === null) return out;
    const rejected = (body as Record<string, unknown>)['rejected'];
    if (!Array.isArray(rejected)) return out;
    for (const entry of rejected) {
      if (typeof entry !== 'object' || entry === null) continue;
      const e = entry as Record<string, unknown>;
      if (
        typeof e[idField] === 'string' &&
        typeof e['code'] === 'string' &&
        TRANSIENT_SYNC_REJECTION_CODES.has(e['code'])
      ) {
        out.add(e[idField]);
      }
    }
    return out;
  };

  let deleted = 0;
  const shotAccepted = exactAccepted(shotBody?.value, 'acceptedIds');
  const shotTransient = transientFor(shotBody?.value, 'id');
  for (const s of shots) {
    const row = rowById(rows, s.id);
    if (shotAccepted.has(s.shotId)) {
      expectDeleted(ctx, rows, s, `acked ${s.label}`);
      deleted += 1;
      if (
        !receipts.some(r => r.entity_id === s.shotId && r.kind === 'shot.sync')
      ) {
        fail(ctx, 'V_RECEIPT', `acked ${s.shotId} has no receipt`);
      }
      continue;
    }
    if (!row) {
      fail(
        ctx,
        'V_DELETED',
        `${s.label} deleted without an exact string ack (${shotBody?.label})`,
      );
      continue;
    }
    expectRetained(
      ctx,
      rows,
      s,
      shotTransient.has(s.shotId) ? 0 : null,
      `unacked ${s.label}`,
    );
  }
  const trialAccepted = exactAccepted(trialBody?.value, 'acceptedTrialIds');
  for (const t of trials) {
    if (trialAccepted.has(t.trialId)) {
      expectDeleted(ctx, rows, t, 'acked trial');
      deleted += 1;
      continue;
    }
    if (!rowById(rows, t.id)) {
      fail(
        ctx,
        'V_DELETED',
        `trial deleted without exact ack (${trialBody?.label})`,
      );
      continue;
    }
    expectRetained(ctx, rows, t, null, 'unacked trial');
  }
  for (const r of receipts) {
    if (!shotAccepted.has(r.entity_id))
      fail(ctx, 'V_RECEIPT', `receipt for unacked ${preview(r.entity_id, 40)}`);
  }
  if (result && result.synced !== deleted)
    fail(ctx, 'V_ACCOUNTING', `synced=${result.synced} deleted=${deleted}`);
  checkCommon(ctx, result);
  return finish(ctx, startedAt, 'response-shape', category);
}

// ─── family: transport-throw ────────────────────────────────────────────────

async function transportThrowFamily(seed: number): Promise<IterationResult> {
  const startedAt = Date.now();
  const ctx = begin(seed, 'transport-throw');
  const { rng, store } = ctx;
  const stage = rng.pick([
    'syncShots',
    'createSession',
    'finalizeSession',
    'uploadEvaluationTrials',
  ] as const);
  const throwable = hostileThrowable(rng);
  const shots: SeededRow[] = [];
  for (let i = 0, n = rng.int(1, 3); i < n; i += 1) {
    const stored = JSON.stringify(validShotPayload(rng));
    const id = store.insert({
      owner: ctx.owner,
      kind: 'shot.sync',
      payload: stored,
    });
    shots.push({
      id,
      kind: 'shot.sync',
      stored,
      label: 'shot',
      attemptsBefore: 0,
    });
  }
  const sessions: SeededRow[] = [];
  for (const kind of ['session.create', 'session.finalize'] as const) {
    if (!rng.chance(0.6)) continue;
    const stored = JSON.stringify(validSessionPayload(rng));
    const id = store.insert({ owner: ctx.owner, kind, payload: stored });
    sessions.push({ id, kind, stored, label: kind, attemptsBefore: 0 });
  }
  const trials: SeededRow[] = [];
  if (rng.chance(0.5)) {
    const stored = JSON.stringify(validTrialPayload(rng));
    const id = store.insert({
      owner: ctx.owner,
      kind: 'evaluation.trial',
      payload: stored,
    });
    trials.push({
      id,
      kind: 'evaluation.trial',
      stored,
      label: 'trial',
      attemptsBefore: 0,
    });
  }
  const base = strictTransport(true);
  const thrower = () => {
    throw throwable.value;
  };
  const transport: SyncTransport = {
    syncShots: stage === 'syncShots' ? async () => thrower() : base.syncShots,
    createSession:
      stage === 'createSession' ? async () => thrower() : base.createSession,
    finalizeSession:
      stage === 'finalizeSession'
        ? async () => thrower()
        : base.finalizeSession,
    uploadEvaluationTrials:
      stage === 'uploadEvaluationTrials'
        ? async () => thrower()
        : base.uploadEvaluationTrials,
  };
  const category = `${stage} ${throwable.label}`;
  ctx.detail['thrown'] = preview(throwable.value);
  ctx.detail['stringifiable'] = throwable.stringifiable;
  ctx.detail['expectedPermanent'] = throwable.permanent;

  const result = await runDrain(ctx, transport);
  const rows = store.rows();
  const delta: 0 | 1 = throwable.permanent ? 1 : 0;
  const STAGE_KIND: Record<typeof stage, string> = {
    syncShots: 'shot.sync',
    createSession: 'session.create',
    finalizeSession: 'session.finalize',
    uploadEvaluationTrials: 'evaluation.trial',
  };
  const affected = (kind: string) => STAGE_KIND[stage] === kind;
  let deleted = 0;
  // When the throw escaped drainOutbox (V_THROW) the later stages never ran;
  // the per-row consequences are the same finding, not separate ones.
  const seededRows = result ? [...sessions, ...shots, ...trials] : [];
  for (const s of seededRows) {
    if (affected(s.kind)) {
      expectRetained(
        ctx,
        rows,
        s,
        delta,
        `${s.kind} during ${throwable.label}`,
      );
    } else {
      expectDeleted(ctx, rows, s, `${s.kind} unaffected by ${stage} throw`);
      deleted += 1;
    }
  }
  if (result) {
    if (result.synced !== deleted)
      fail(ctx, 'V_ACCOUNTING', `synced=${result.synced} deleted=${deleted}`);
    const retained = rows.filter(r => r.owner_key === ctx.owner).length;
    if (result.failed !== retained)
      fail(ctx, 'V_ACCOUNTING', `failed=${result.failed} retained=${retained}`);
  }
  checkCommon(ctx, result);
  return finish(ctx, startedAt, 'transport-throw', category);
}

// ─── family: session-trial-rows ─────────────────────────────────────────────

async function sessionTrialRowsFamily(seed: number): Promise<IterationResult> {
  const startedAt = Date.now();
  const ctx = begin(seed, 'session-trial-rows');
  const { rng, store } = ctx;
  const seeded: SeededRow[] = [];
  for (let i = 0, n = rng.int(1, 3); i < n; i += 1) {
    const kindPick = rng.int(0, 9);
    let kind: string;
    if (kindPick <= 2) kind = 'session.create';
    else if (kindPick <= 5) kind = 'session.finalize';
    else if (kindPick <= 8) kind = 'evaluation.trial';
    else
      kind = rng.pick([
        'shot.sync.v2',
        '',
        'SESSION.CREATE',
        'session.create\u0000',
        hostileString(rng).value,
      ]);
    const idKey = kind === 'evaluation.trial' ? 'trialId' : 'id';
    const base =
      kind === 'evaluation.trial'
        ? validTrialPayload(rng)
        : validSessionPayload(rng);
    let label: string;
    let stored: string;
    const mode = rng.int(0, 3);
    if (mode === 0) {
      const c = corruptRawJson(rng, JSON.stringify(base));
      label = c.label;
      stored = c.value;
    } else if (mode === 1) {
      const m = mutateShotObject(rng, base, idKey);
      label = m.label;
      stored = JSON.stringify(m.value);
    } else if (mode === 2) {
      const v = mutateValue(rng);
      const copy = { ...base, [idKey]: v.value };
      label = `${idKey}:${v.label}`;
      stored = JSON.stringify(copy);
    } else {
      label = 'valid';
      stored = JSON.stringify(base);
    }
    const id = store.insert({ owner: ctx.owner, kind, payload: stored });
    seeded.push({
      id,
      kind: store.storedKind(id),
      stored: store.storedPayload(id),
      label: `${JSON.stringify(kind)}[${label}]`,
      attemptsBefore: 0,
    });
  }
  const category = seeded.map(s => s.label).join(' | ');
  ctx.detail['rows'] = seeded.map(s => ({
    id: s.id,
    kind: s.kind,
    label: s.label,
    payload: preview(s.stored),
  }));

  const transport = strictTransport(true);
  const result = await runDrain(ctx, transport);
  const rows = store.rows();
  let deleted = 0;
  for (const s of seeded) {
    if (strictServerAccepts(s.kind, s.stored)) {
      expectDeleted(ctx, rows, s, s.label);
      deleted += 1;
    } else {
      // Anything the strict server refuses is a contract verdict → +1.
      // Undrainable payloads are recorded locally → +1 as well.
      expectRetained(ctx, rows, s, 1, s.label);
    }
  }
  if (result && result.synced !== deleted)
    fail(ctx, 'V_ACCOUNTING', `synced=${result.synced} deleted=${deleted}`);
  checkCommon(ctx, result);
  if (ctx.violations.length === 0) await checkPoisonExpiry(ctx, transport);
  checkCommon(ctx, null);
  return finish(ctx, startedAt, 'session-trial-rows', category);
}

// ─── family: mixed-batch ────────────────────────────────────────────────────

async function mixedBatchFamily(seed: number): Promise<IterationResult> {
  const startedAt = Date.now();
  const ctx = begin(seed, 'mixed-batch');
  const { rng, store } = ctx;
  interface MixedRow extends SeededRow {
    expect: 'deleted' | 'retained+1' | 'untouched';
    shotId?: string;
  }
  const seeded: MixedRow[] = [];
  const total = rng.int(1, 70);
  const kinds = [
    'valid-shot',
    'valid-shot',
    'malformed-shot',
    'valid-session',
    'malformed-session',
    'valid-trial',
    'foreign',
    'exhausted',
    'odd-attempts',
  ] as const;
  for (let i = 0; i < total; i += 1) {
    const kind = rng.pick(kinds);
    switch (kind) {
      case 'valid-shot': {
        const shotId = seededUuid(rng);
        const stored = JSON.stringify(validShotPayload(rng, shotId));
        const id = store.insert({
          owner: ctx.owner,
          kind: 'shot.sync',
          payload: stored,
        });
        seeded.push({
          id,
          kind: 'shot.sync',
          stored,
          label: kind,
          attemptsBefore: 0,
          expect: 'deleted',
          shotId,
        });
        break;
      }
      case 'malformed-shot': {
        const { label, stored: bound } = malformedShotText(rng);
        const id = store.insert({
          owner: ctx.owner,
          kind: 'shot.sync',
          payload: bound,
        });
        const stored = store.storedPayload(id);
        const accepted = strictServerAccepts('shot.sync', stored);
        const shotId = accepted
          ? (JSON.parse(stored) as Record<string, string>)['id']
          : undefined;
        seeded.push({
          id,
          kind: 'shot.sync',
          stored,
          label: `malformed-shot[${label}]`,
          attemptsBefore: 0,
          expect: accepted ? 'deleted' : 'retained+1',
          shotId,
        });
        break;
      }
      case 'valid-session': {
        const k = rng.pick(['session.create', 'session.finalize']);
        const stored = JSON.stringify(validSessionPayload(rng));
        const id = store.insert({ owner: ctx.owner, kind: k, payload: stored });
        seeded.push({
          id,
          kind: k,
          stored,
          label: kind,
          attemptsBefore: 0,
          expect: 'deleted',
        });
        break;
      }
      case 'malformed-session': {
        const k = rng.pick([
          'session.create',
          'session.finalize',
          'unknown.kind',
        ]);
        const c = corruptRawJson(rng, JSON.stringify(validSessionPayload(rng)));
        const id = store.insert({
          owner: ctx.owner,
          kind: k,
          payload: c.value,
        });
        const stored = store.storedPayload(id);
        seeded.push({
          id,
          kind: k,
          stored,
          label: `malformed-session[${c.label}]`,
          attemptsBefore: 0,
          expect: strictServerAccepts(k, stored) ? 'deleted' : 'retained+1',
        });
        break;
      }
      case 'valid-trial': {
        const stored = JSON.stringify(validTrialPayload(rng));
        const id = store.insert({
          owner: ctx.owner,
          kind: 'evaluation.trial',
          payload: stored,
        });
        seeded.push({
          id,
          kind: 'evaluation.trial',
          stored,
          label: kind,
          attemptsBefore: 0,
          expect: 'deleted',
        });
        break;
      }
      case 'foreign': {
        const stored = JSON.stringify(validShotPayload(rng));
        const id = store.insert({
          owner: rng.pick([
            OTHER_OWNER,
            SIGNED_OUT_DATA_OWNER,
            'Device-Guest',
            ' device-guest',
          ]),
          kind: 'shot.sync',
          payload: stored,
        });
        seeded.push({
          id,
          kind: 'shot.sync',
          stored,
          label: kind,
          attemptsBefore: 0,
          expect: 'untouched',
        });
        break;
      }
      case 'exhausted': {
        const stored = JSON.stringify(validShotPayload(rng));
        const attempts = rng.pick([
          OUTBOX_MAX_ATTEMPTS,
          OUTBOX_MAX_ATTEMPTS + 1,
          1000,
        ]);
        const id = store.insert({
          owner: ctx.owner,
          kind: 'shot.sync',
          payload: stored,
          attempts,
          lastError: 'old',
        });
        seeded.push({
          id,
          kind: 'shot.sync',
          stored,
          label: kind,
          attemptsBefore: attempts,
          expect: 'untouched',
        });
        break;
      }
      default: {
        const stored = JSON.stringify(validShotPayload(rng));
        const attempts = rng.pick([-1, 7, 7.5]);
        const id = store.insert({
          owner: ctx.owner,
          kind: 'shot.sync',
          payload: stored,
          attempts,
        });
        seeded.push({
          id,
          kind: 'shot.sync',
          stored,
          label: `odd-attempts[${attempts}]`,
          attemptsBefore: attempts,
          expect: 'deleted',
        });
      }
    }
  }
  // The drain selects the first 50 eligible rows by id; the rest must wait.
  const eligible = seeded.filter(s => s.expect !== 'untouched');
  const window = new Set(eligible.slice(0, 50).map(s => s.id));
  const category = `${total} rows / ${eligible.length} eligible / ${Math.min(50, eligible.length)} in window`;
  ctx.detail['rows'] = seeded.map(s => ({
    id: s.id,
    label: s.label,
    expect: s.expect,
  }));

  const transport = strictTransport(true);
  const before = store.rows();
  const result = await runDrain(ctx, transport);
  const rows = store.rows();
  let deleted = 0;
  let retained = 0;
  for (const s of seeded) {
    const row = rowById(rows, s.id);
    if (s.expect === 'untouched' || !window.has(s.id)) {
      const prior = rowById(before, s.id);
      if (JSON.stringify(row) !== JSON.stringify(prior)) {
        fail(
          ctx,
          'V_LIMIT',
          `${s.label}#${s.id} outside window changed: ${preview(row)}`,
        );
      }
      continue;
    }
    if (s.expect === 'deleted') {
      expectDeleted(ctx, rows, s, s.label);
      deleted += 1;
      if (s.shotId && !store.receipts().some(r => r.entity_id === s.shotId)) {
        fail(ctx, 'V_RECEIPT', `no receipt for ${s.shotId}`);
      }
    } else {
      expectRetained(ctx, rows, s, 1, s.label);
      retained += 1;
    }
  }
  if (result) {
    if (result.synced !== deleted)
      fail(ctx, 'V_ACCOUNTING', `synced=${result.synced} deleted=${deleted}`);
    if (result.failed !== retained)
      fail(ctx, 'V_ACCOUNTING', `failed=${result.failed} retained=${retained}`);
  }
  if (transport.calls.syncShots.length > 1)
    fail(
      ctx,
      'V_LIMIT',
      `syncShots called ${transport.calls.syncShots.length}×`,
    );
  checkCommon(ctx, result);
  return finish(ctx, startedAt, 'mixed-batch', category);
}

// ─── family: db-fault-rollback ──────────────────────────────────────────────

async function dbFaultRollbackFamily(seed: number): Promise<IterationResult> {
  const startedAt = Date.now();
  const ctx = begin(seed, 'db-fault-rollback');
  const { rng, store } = ctx;
  const shots: Array<SeededRow & { shotId: string }> = [];
  const n = rng.int(2, 6);
  for (let i = 0; i < n; i += 1) {
    const shotId = seededUuid(rng);
    const stored = JSON.stringify(validShotPayload(rng, shotId));
    const id = store.insert({
      owner: ctx.owner,
      kind: 'shot.sync',
      payload: stored,
    });
    shots.push({
      id,
      kind: 'shot.sync',
      stored,
      label: 'shot',
      attemptsBefore: 0,
      shotId,
    });
  }
  const failIndex = rng.int(0, n - 1); // 0-based entry whose transaction fails
  const faultOn = rng.pick([
    'BEGIN IMMEDIATE',
    'INSERT OR REPLACE INTO sync_receipt',
    'DELETE FROM outbox',
    'COMMIT',
  ] as const);
  const patterns: Record<typeof faultOn, RegExp> = {
    'BEGIN IMMEDIATE': /^BEGIN IMMEDIATE$/,
    'INSERT OR REPLACE INTO sync_receipt':
      /INSERT OR REPLACE INTO sync_receipt/,
    'DELETE FROM outbox': /^\s*DELETE FROM outbox/,
    COMMIT: /^COMMIT$/,
  };
  const message = rng.pick([
    'SQLITE_FULL: database or disk is full',
    'SQLITE_IOERR: disk I/O error',
    'SQLITE_BUSY: database is locked',
  ]);
  store.failOn({ pattern: patterns[faultOn], nth: failIndex + 1, message });
  const category = `${faultOn} fails on entry ${failIndex + 1}/${n} (${message.split(':')[0]})`;
  ctx.detail['shots'] = shots.map(s => s.shotId);

  const transport = strictTransport(false);
  const result = await runDrain(ctx, transport);
  const rows = store.rows();
  const receipts = store.receipts();
  for (const [i, s] of shots.entries()) {
    const hasReceipt = receipts.some(r => r.entity_id === s.shotId);
    const row = rowById(rows, s.id);
    if (i < failIndex) {
      expectDeleted(ctx, rows, s, `entry ${i + 1} before fault`);
      if (!hasReceipt)
        fail(ctx, 'V_RECEIPT', `entry ${i + 1} deleted without receipt`);
    } else if (i === failIndex) {
      // Atomicity: either both receipt+delete happened or neither.
      if (row && hasReceipt)
        fail(
          ctx,
          'V_RECEIPT',
          `entry ${i + 1}: receipt committed but row retained`,
        );
      if (!row && !hasReceipt)
        fail(ctx, 'V_RECEIPT', `entry ${i + 1}: row deleted but no receipt`);
      if (row) expectRetained(ctx, rows, s, 0, `faulted entry ${i + 1}`);
    } else {
      // Later acked entries are retained transiently (the loop aborted).
      if (!row) {
        if (!hasReceipt)
          fail(
            ctx,
            'V_LOST',
            `entry ${i + 1} after fault vanished without receipt`,
          );
      } else {
        expectRetained(ctx, rows, s, 0, `entry ${i + 1} after fault`);
      }
    }
  }
  const deleted = shots.filter(s => !rowById(rows, s.id)).length;
  const retained = shots.length - deleted;
  if (result) {
    if (result.synced !== deleted)
      fail(ctx, 'V_ACCOUNTING', `synced=${result.synced} deleted=${deleted}`);
    if (result.failed !== retained)
      fail(
        ctx,
        'V_ACCOUNTING',
        `failed=${result.failed} retained=${retained} (synced+failed=${result.synced + result.failed} of ${n})`,
      );
  }
  checkCommon(ctx, result);
  // Recovery: with the fault cleared, the next drain must finish the job.
  if (!ctx.violations.some(v => v === 'V_THROW' || v === 'V_TXN_OPEN')) {
    const second = await runDrain(ctx, transport);
    const after = store.rows().filter(r => r.owner_key === ctx.owner);
    if (after.length !== 0)
      fail(
        ctx,
        'V_LOST',
        `${after.length} row(s) not recovered on the next drain`,
      );
    if (second && second.remaining !== after.length)
      fail(ctx, 'V_REMAINING', 'second drain remaining mismatch');
    for (const s of shots) {
      if (!store.receipts().some(r => r.entity_id === s.shotId))
        fail(ctx, 'V_RECEIPT', `no receipt after recovery for ${s.shotId}`);
    }
    checkCommon(ctx, second);
  }
  return finish(ctx, startedAt, 'db-fault-rollback', category);
}

// ─── family: concurrent-drains ──────────────────────────────────────────────

const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));

async function concurrentDrainsFamily(seed: number): Promise<IterationResult> {
  const startedAt = Date.now();
  const ctx = begin(seed, 'concurrent-drains');
  const { rng, store } = ctx;
  const shots: Array<SeededRow & { shotId: string }> = [];
  for (let i = 0, n = rng.int(1, 6); i < n; i += 1) {
    const shotId = seededUuid(rng);
    const stored = JSON.stringify(validShotPayload(rng, shotId));
    const id = store.insert({
      owner: ctx.owner,
      kind: 'shot.sync',
      payload: stored,
    });
    shots.push({
      id,
      kind: 'shot.sync',
      stored,
      label: 'shot',
      attemptsBefore: 0,
      shotId,
    });
  }
  const others: Array<SeededRow & { shotId: string }> = [];
  const switchOwner = rng.chance(0.5);
  if (switchOwner) {
    for (let i = 0, n = rng.int(1, 3); i < n; i += 1) {
      const shotId = seededUuid(rng);
      const stored = JSON.stringify(validShotPayload(rng, shotId));
      const id = store.insert({
        owner: OTHER_OWNER,
        kind: 'shot.sync',
        payload: stored,
      });
      others.push({
        id,
        kind: 'shot.sync',
        stored,
        label: 'other-owner shot',
        attemptsBefore: 0,
        shotId,
      });
    }
    // The other-owner rows are part of this scenario, not the fixed foreign set.
    ctx.isForeignOwner = o => o !== ctx.owner && o !== OTHER_OWNER;
  }
  const malformed = rng.chance(0.4);
  const malformedRows: SeededRow[] = [];
  if (malformed) {
    const { label, stored: bound } = malformedShotText(rng);
    const id = store.insert({
      owner: ctx.owner,
      kind: 'shot.sync',
      payload: bound,
    });
    const stored = store.storedPayload(id);
    const row = { id, kind: 'shot.sync', stored, label, attemptsBefore: 0 };
    if (strictServerAccepts('shot.sync', stored)) {
      // A mutation that left a drainable, server-acceptable row behaves like
      // any other valid shot (e.g. wrong-typed non-id field, own __proto__ key).
      const shotId = String(
        (JSON.parse(stored) as Record<string, unknown>)['id'],
      );
      shots.push({ ...row, label: `mutated-but-valid[${label}]`, shotId });
    } else {
      malformedRows.push(row);
    }
  }
  const yieldsA = rng.int(0, 3);
  const yieldsB = rng.int(0, 3);
  const base = strictTransport(false);
  let sends = 0;
  const yielding = (yields: number): SyncTransport => ({
    async syncShots(sent) {
      sends += 1;
      for (let i = 0; i < yields; i += 1) await tick();
      return base.syncShots(sent);
    },
    createSession: base.createSession,
    finalizeSession: base.finalizeSession,
  });
  const category = `${shots.length} shots, ${switchOwner ? 'owner switch mid-drain' : 'same owner'}, yields ${yieldsA}/${yieldsB}${malformed ? ', +malformed' : ''}`;
  ctx.detail['shots'] = shots.map(s => s.shotId);

  ctx.foreignBefore = JSON.stringify(
    store.rows().filter(r => ctx.isForeignOwner(r.owner_key)),
  );
  const errors: unknown[] = [];
  const a = drainOutbox(store.db, yielding(yieldsA)).catch(e => {
    errors.push(e);
    return null;
  });
  if (rng.chance(0.5)) await tick();
  if (switchOwner) setActiveDataOwner(OTHER_OWNER);
  const b = drainOutbox(store.db, yielding(yieldsB)).catch(e => {
    errors.push(e);
    return null;
  });
  const [ra, rb] = await Promise.all([a, b]);
  setActiveDataOwner(ctx.owner);
  if (errors.length > 0)
    fail(ctx, 'V_THROW', errors.map(e => preview(e)).join(' | '));
  ctx.detail['results'] = { a: ra, b: rb, sends };

  const rows = store.rows();
  const receipts = store.receipts();
  const all = [...shots, ...others];
  for (const s of all) {
    const row = rowById(rows, s.id);
    const hasReceipt = receipts.some(
      r =>
        r.entity_id === s.shotId &&
        r.owner_key === (others.includes(s) ? OTHER_OWNER : ctx.owner),
    );
    if (!row && !hasReceipt)
      fail(ctx, 'V_LOST', `${s.label} ${s.shotId} deleted without receipt`);
    if (row && hasReceipt)
      fail(
        ctx,
        'V_RECEIPT',
        `${s.label} ${s.shotId} has receipt but row retained`,
      );
    if (row) {
      const moved = row.attempts - s.attemptsBefore;
      if (moved !== 0 && moved !== 1)
        fail(ctx, 'V_ATTEMPTS', `${s.label} moved by ${moved}`);
      if (moved === 1)
        fail(
          ctx,
          'V_ATTEMPTS',
          `${s.label} lost an attempt to a concurrent drain (transient class expected)`,
        );
      if (typeof row.last_error !== 'string')
        fail(ctx, 'V_LASTERR', `${s.label} retained without last_error`);
    }
  }
  for (const m of malformedRows) {
    // Two overlapping drains may each record the permanent failure once, so
    // the budget may move by 1 or 2 here; anything else is a bug.
    const row = rowById(rows, m.id);
    if (!row) {
      fail(ctx, 'V_LOST', `malformed row ${m.id} (${m.label}) vanished`);
      continue;
    }
    if (typeof row.last_error !== 'string' || row.last_error.length === 0)
      fail(ctx, 'V_LASTERR', `malformed row retained without last_error`);
    const moved = row.attempts - m.attemptsBefore;
    ctx.detail['malformedAttemptsMoved'] = moved;
    if (moved < 1 || moved > 2)
      fail(ctx, 'V_ATTEMPTS', `malformed row attempts moved by ${moved}`);
  }
  checkCommon(ctx, null);
  // Convergence: a quiet follow-up drain per owner must leave nothing behind.
  if (!ctx.violations.includes('V_TXN_OPEN')) {
    const quiet = strictTransport(false);
    setActiveDataOwner(ctx.owner);
    const fa = await runDrain(ctx, quiet);
    if (switchOwner) {
      setActiveDataOwner(OTHER_OWNER);
      await runDrain(ctx, quiet);
      setActiveDataOwner(ctx.owner);
    }
    const left = store.rows().filter(r => all.some(s => s.id === r.id));
    if (left.length > 0)
      fail(
        ctx,
        'V_LOST',
        `${left.length} valid row(s) still queued after follow-up drain`,
      );
    if (
      fa &&
      fa.remaining !==
        store.rows().filter(r => r.owner_key === ctx.owner).length
    )
      fail(ctx, 'V_REMAINING', 'follow-up remaining mismatch');
  }
  return finish(ctx, startedAt, 'concurrent-drains', category);
}

// ─── runner ─────────────────────────────────────────────────────────────────

const RUNNERS: Record<Family, (seed: number) => Promise<IterationResult>> = {
  'shot-payload': shotPayloadFamily,
  'response-shape': responseShapeFamily,
  'transport-throw': transportThrowFamily,
  'session-trial-rows': sessionTrialRowsFamily,
  'mixed-batch': mixedBatchFamily,
  'db-fault-rollback': dbFaultRollbackFamily,
  'concurrent-drains': concurrentDrainsFamily,
};

export function runIteration(
  family: Family,
  seed: number,
): Promise<IterationResult> {
  const ownerBefore = getActiveDataOwner();
  return RUNNERS[family](seed).finally(() => setActiveDataOwner(ownerBefore));
}

export interface CampaignConfig {
  baseSeed: number;
  iterationsPerFamily: number;
  families: readonly Family[];
  /** `family:seed` — run exactly this iteration and nothing else. */
  replay: { family: Family; seed: number } | null;
}

export function configFromEnv(): CampaignConfig {
  const env = nodeProcess.env;
  const iter = Number(env['STRESS_ITER'] ?? '');
  const baseSeed = Number(env['STRESS_SEED'] ?? '');
  const only = env['STRESS_ONLY'];
  const replayRaw = env['STRESS_REPLAY'];
  let replay: CampaignConfig['replay'] = null;
  if (replayRaw) {
    const [family, seed] = replayRaw.split(':');
    if (
      !FAMILIES.includes(family as Family) ||
      !Number.isInteger(Number(seed))
    ) {
      throw new Error(
        `STRESS_REPLAY must be <family>:<seed>, got ${replayRaw}`,
      );
    }
    replay = { family: family as Family, seed: Number(seed) };
  }
  return {
    baseSeed: Number.isInteger(baseSeed) ? baseSeed : 0x5eed0b0,
    iterationsPerFamily: Number.isInteger(iter) && iter > 0 ? iter : 12,
    families: only
      ? (only
          .split(',')
          .filter(f => FAMILIES.includes(f as Family)) as Family[])
      : FAMILIES,
    replay,
  };
}

export async function runFamily(
  family: Family,
  config: CampaignConfig,
): Promise<IterationResult[]> {
  if (config.replay) {
    return config.replay.family === family
      ? [await runIteration(family, config.replay.seed)]
      : [];
  }
  const familyIndex = FAMILIES.indexOf(family);
  const out: IterationResult[] = [];
  for (let i = 0; i < config.iterationsPerFamily; i += 1) {
    out.push(
      await runIteration(
        family,
        iterationSeed(config.baseSeed, familyIndex, i),
      ),
    );
  }
  return out;
}

// ─── artifacts ──────────────────────────────────────────────────────────────

export function artifactDir(): string {
  const env = nodeProcess.env;
  const configured = env['STRESS_OUT'];
  const runId = env['STRESS_RUN_ID'] ?? 'local';
  const dir =
    configured && configured.length > 0
      ? configured
      : path.resolve(
          __dirname,
          '../../../../../artifacts/stress/mod-sync-outbox/boundary-malformed',
          runId,
        );
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function writeArtifacts(
  name: string,
  results: IterationResult[],
  config: CampaignConfig,
): {
  table: string;
  summary: string;
} {
  const dir = artifactDir();
  const table = path.join(dir, `${name}.results.json`);
  fs.writeFileSync(
    table,
    JSON.stringify(
      results.map(r => ({
        family: r.family,
        seed: r.seed,
        replay: `STRESS_REPLAY=${r.family}:${r.seed}`,
        outcome: r.outcome,
        violations: r.violations,
        category: r.category,
        detail: r.detail,
        durationMs: r.durationMs,
      })),
      null,
      2,
    ) + '\n',
  );
  const byViolation: Record<string, number> = {};
  const byFamily: Record<
    string,
    { executed: number; held: number; broken: number }
  > = {};
  for (const r of results) {
    const f = (byFamily[r.family] ??= { executed: 0, held: 0, broken: 0 });
    f.executed += 1;
    if (r.outcome === 'HELD') f.held += 1;
    else f.broken += 1;
    for (const v of r.violations) byViolation[v] = (byViolation[v] ?? 0) + 1;
  }
  const summaryPath = path.join(dir, `${name}.summary.json`);
  fs.writeFileSync(
    summaryPath,
    JSON.stringify(
      {
        name,
        node: nodeProcess.version,
        config: { ...config, families: [...config.families] },
        executed: results.length,
        held: results.filter(r => r.outcome === 'HELD').length,
        broken: results.filter(r => r.outcome === 'BROKEN').length,
        byFamily,
        byViolation,
        brokenSeeds: results
          .filter(r => r.outcome === 'BROKEN')
          .map(r => ({
            family: r.family,
            seed: r.seed,
            violations: r.violations,
            category: r.category,
          })),
      },
      null,
      2,
    ) + '\n',
  );
  return { table, summary: summaryPath };
}

export function describeBroken(results: IterationResult[], max = 8): string {
  const broken = results.filter(r => r.outcome === 'BROKEN');
  if (broken.length === 0) return '';
  return broken
    .slice(0, max)
    .map(
      r =>
        `STRESS_REPLAY=${r.family}:${r.seed} [${r.violations.join(',')}] ${r.category} :: ${(r.detail['why'] as string[] | undefined)?.join(' / ') ?? ''}`,
    )
    .join('\n');
}
