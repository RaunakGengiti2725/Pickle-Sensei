/**
 * Seeded randomized campaign over the public repository API.
 *
 * A sequence is a pure function of its 32-bit seed: `generateActions(seed)`
 * yields 5–60 legal or near-legal actions; `executeActions` replays them
 * against a REAL production-migrated SQLite store (through the LocalDb the
 * test injects) and the reference model side by side, checking every read
 * projection and the raw per-owner row partition after EVERY step.
 *
 * Failures carry the seed, the failing step, the offending invariant and a
 * ddmin-minimized action list that still reproduces them.
 */
import type { LocalDb } from '../../src/data/db';
import {
  getActiveDataOwner,
  setActiveDataOwner,
  SIGNED_OUT_DATA_OWNER,
} from '../../src/data/accountScope';
import * as repo from '../../src/data/repository';
import { OUTBOX_MAX_ATTEMPTS } from '../../src/data/sync';
import type { ShotTypeSlug } from '@pickle/shared-types';
import { makePrng, pick } from '../lifecycle-persistence/seeds';
import {
  buildAnalysis,
  buildClip,
  buildRecord,
  captureId,
  enrichClip,
  INVALID_OWNERS,
  OWNER_A,
  OWNER_B,
  OWNER_CHOICES,
  PERMIT_ID,
  sessionId,
  shotId,
  shotTypeFor,
  type ShotSpec,
} from './fixtures';
import { OWNER_SCOPED_TABLES, RepositoryModel } from './model';
import { GUEST_DATA_OWNER } from '../../src/data/accountScope';

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export type Action =
  | { type: 'switchOwner'; owner: string }
  | { type: 'switchOwnerInvalid'; owner: string }
  | { type: 'saveAnalysis'; spec: ShotSpec; permit: string }
  | { type: 'saveLocalOnly'; spec: ShotSpec }
  | {
      type: 'saveSession';
      id: string;
      mode: string;
      shotType: string | null;
      startedSeq: number;
    }
  | { type: 'finishSession'; id: string; summary: Record<string, unknown> }
  | {
      type: 'savePendingCapture';
      id: string;
      clipSeq: number;
      uriSuffix: string;
      shotType: string;
      declared: ShotTypeSlug | null;
    }
  | { type: 'setDeclaredStroke'; id: string; declared: ShotTypeSlug }
  | { type: 'setCaptureTargetSeed'; id: string; x: number; y: number }
  | { type: 'updateCaptureClipPayload'; id: string; mismatch: boolean }
  | { type: 'markCaptureAnalyzed'; id: string }
  | {
      type: 'saveAnalysisRecord';
      n: number;
      captureId: string;
      createdSeq: number;
      withResult: ShotSpec | null;
    }
  | { type: 'setKv'; key: string; value: string }
  | { type: 'purgeOwnerData'; owner: string }
  | { type: 'envReceipt'; shotId: string }
  | {
      type: 'envBumpAttempts';
      shotId: string;
      by: number;
      lastError: string | null;
    }
  | {
      type: 'readDuringDelete';
      owner: string;
      read: ReadKind;
      order: 'readFirst' | 'purgeFirst';
      /** Microtask hops the read waits before being issued (purgeFirst only). */
      delay: number;
    }
  | { type: 'badLimit'; read: LimitedRead; limit: number }
  | { type: 'bulkSave'; specs: ShotSpec[] }
  | {
      type: 'concurrentTransactions';
      first: TxWrite;
      second: TxWrite;
    };

export type ReadKind =
  | 'listShots'
  | 'listActivityShots'
  | 'listRealAnalysisFacts'
  | 'listCaptureHistory';

export type LimitedRead =
  | 'listRealAnalysisFacts'
  | 'listScoredCheckpointFacts'
  | 'listPendingCaptures'
  | 'listCaptureHistory'
  | 'listLiveSessionHistory';

export type TxWrite =
  | { kind: 'saveAnalysis'; spec: ShotSpec }
  | { kind: 'saveSession'; id: string; startedSeq: number }
  | { kind: 'finishSession'; id: string }
  | { kind: 'purgeOwnerData'; owner: string };

export interface GenerateOptions {
  /** Include the overlapping-transaction family (near-legal concurrency). */
  concurrentTransactions?: boolean;
  /** Fixed length instead of the seeded 5–60. */
  length?: number;
}

const SESSION_MODES = ['live_court', 'practice_set', 'drill'] as const;
const KV_UNSCOPED_KEYS = ['walkthrough.seen', 'week.chart', 'local.mode'];
const KV_VALUES = ['1', 'true', '{"v":1}', 'x'.repeat(2048), '\u{1F3D3}'];

interface GenState {
  rng: () => number;
  seq: number;
  shotIds: string[];
  captures: Array<{ id: string; clipSeq: number }>;
  sessionIds: string[];
  recordCount: number;
  kvKeys: string[];
}

function nextSpec(gen: GenState, id: string): ShotSpec {
  const seq = gen.seq++;
  const scored = gen.rng() < 0.7;
  return {
    id,
    seq,
    shotType: shotTypeFor(Math.floor(gen.rng() * 8)),
    scored,
    score: scored ? Math.round(gen.rng() * 100) / 10 : null,
    sessionId:
      gen.sessionIds.length > 0 && gen.rng() < 0.4
        ? pick(gen.rng, gen.sessionIds)
        : null,
    checkpointVariant: pick(gen.rng, ['none', 'all_applicable', 'mixed']),
    priority: gen.rng() < 0.5,
    source: 'real',
  };
}

function newShotId(gen: GenState): string {
  const id = shotId(gen.seq + 1);
  gen.shotIds.push(id);
  return id;
}

function knownOrFresh(gen: GenState, known: string[], fresh: string): string {
  return known.length > 0 && gen.rng() < 0.85 ? pick(gen.rng, known) : fresh;
}

function captureIds(gen: GenState): string[] {
  return gen.captures.map(capture => capture.id);
}

const WEIGHTS: Array<[Action['type'], number]> = [
  ['switchOwner', 10],
  ['switchOwnerInvalid', 2],
  ['saveAnalysis', 18],
  ['saveLocalOnly', 5],
  ['saveSession', 4],
  ['finishSession', 4],
  ['savePendingCapture', 8],
  ['setDeclaredStroke', 3],
  ['setCaptureTargetSeed', 2],
  ['updateCaptureClipPayload', 2],
  ['markCaptureAnalyzed', 3],
  ['saveAnalysisRecord', 5],
  ['setKv', 4],
  ['purgeOwnerData', 4],
  ['envReceipt', 2],
  ['envBumpAttempts', 3],
  ['readDuringDelete', 4],
  ['badLimit', 1],
  ['bulkSave', 1],
];

function pickType(rng: () => number, options: GenerateOptions): Action['type'] {
  const weights: Array<[Action['type'], number]> =
    options.concurrentTransactions
      ? [...WEIGHTS, ['concurrentTransactions', 6]]
      : WEIGHTS;
  const total = weights.reduce((sum, [, weight]) => sum + weight, 0);
  let roll = rng() * total;
  for (const [type, weight] of weights) {
    roll -= weight;
    if (roll < 0) return type;
  }
  return 'saveAnalysis';
}

function txWrite(gen: GenState): TxWrite {
  const roll = gen.rng();
  if (roll < 0.5)
    return { kind: 'saveAnalysis', spec: nextSpec(gen, newShotId(gen)) };
  if (roll < 0.7) {
    const id = sessionId(gen.seq + 1);
    gen.sessionIds.push(id);
    return { kind: 'saveSession', id, startedSeq: gen.seq++ };
  }
  if (roll < 0.85) {
    return {
      kind: 'finishSession',
      id: knownOrFresh(gen, gen.sessionIds, sessionId(999999)),
    };
  }
  return {
    kind: 'purgeOwnerData',
    owner: pick(gen.rng, [OWNER_A, OWNER_B, GUEST_DATA_OWNER]),
  };
}

export function generateActions(
  seed: number,
  options: GenerateOptions = {},
): Action[] {
  const rng = makePrng(seed);
  const length = options.length ?? 5 + Math.floor(rng() * 56);
  const gen: GenState = {
    rng,
    seq: 1,
    shotIds: [],
    captures: [],
    sessionIds: [],
    recordCount: 0,
    kvKeys: [],
  };
  const actions: Action[] = [
    {
      type: 'switchOwner',
      owner: pick(rng, [OWNER_A, OWNER_B, GUEST_DATA_OWNER]),
    },
  ];
  while (actions.length < length) {
    const type = pickType(rng, options);
    switch (type) {
      case 'switchOwner':
        actions.push({ type, owner: pick(rng, OWNER_CHOICES) });
        break;
      case 'switchOwnerInvalid':
        actions.push({ type, owner: pick(rng, INVALID_OWNERS) });
        break;
      case 'saveAnalysis': {
        const roll = rng();
        const id =
          gen.shotIds.length > 0 && roll < 0.3
            ? pick(rng, gen.shotIds)
            : newShotId(gen);
        const spec = nextSpec(gen, id);
        if (roll > 0.96) spec.source = 'fixture';
        const permit =
          roll > 0.93 && roll <= 0.96 ? pick(rng, ['', '   ']) : PERMIT_ID;
        actions.push({ type, spec, permit });
        break;
      }
      case 'saveLocalOnly': {
        const id =
          gen.shotIds.length > 0 && rng() < 0.3
            ? pick(rng, gen.shotIds)
            : newShotId(gen);
        const spec = nextSpec(gen, id);
        spec.scored = rng() < 0.15; // near-legal: scored must be refused
        if (!spec.scored) spec.score = null;
        actions.push({ type, spec });
        break;
      }
      case 'saveSession': {
        const id =
          gen.sessionIds.length > 0 && rng() < 0.2
            ? pick(rng, gen.sessionIds)
            : sessionId(gen.seq + 1);
        if (!gen.sessionIds.includes(id)) gen.sessionIds.push(id);
        const mode = pick(rng, SESSION_MODES);
        actions.push({
          type,
          id,
          mode,
          shotType: rng() < 0.5 ? shotTypeFor(Math.floor(rng() * 8)) : null,
          startedSeq: gen.seq++,
        });
        break;
      }
      case 'finishSession':
        actions.push({
          type,
          id: knownOrFresh(gen, gen.sessionIds, sessionId(999999)),
          summary: { rallies: Math.floor(rng() * 40), stress: true },
        });
        break;
      case 'savePendingCapture': {
        const roll = rng();
        let clipSeq = gen.seq++;
        let id = captureId(clipSeq);
        if (gen.captures.length > 0 && roll < 0.15) {
          id = pick(rng, gen.captures).id; // duplicate id, fresh uri
        } else if (gen.captures.length > 0 && roll < 0.25) {
          clipSeq = pick(rng, gen.captures).clipSeq; // duplicate uri, fresh id
        }
        if (!gen.captures.some(capture => capture.id === id)) {
          gen.captures.push({ id, clipSeq });
        }
        actions.push({
          type,
          id,
          clipSeq,
          uriSuffix: '',
          shotType:
            rng() < 0.5 ? 'unrecognized' : shotTypeFor(Math.floor(rng() * 8)),
          declared: rng() < 0.5 ? shotTypeFor(Math.floor(rng() * 8)) : null,
        });
        break;
      }
      case 'setDeclaredStroke':
        actions.push({
          type,
          id: knownOrFresh(gen, captureIds(gen), captureId(999999)),
          declared: shotTypeFor(Math.floor(rng() * 8)),
        });
        break;
      case 'setCaptureTargetSeed':
        actions.push({
          type,
          id: knownOrFresh(gen, captureIds(gen), captureId(999999)),
          x: Math.round(rng() * 1000) / 1000,
          y: Math.round(rng() * 1000) / 1000,
        });
        break;
      case 'updateCaptureClipPayload':
        actions.push({
          type,
          id: knownOrFresh(gen, captureIds(gen), captureId(999999)),
          mismatch: rng() < 0.2,
        });
        break;
      case 'markCaptureAnalyzed':
        actions.push({
          type,
          id: knownOrFresh(gen, captureIds(gen), captureId(999999)),
        });
        break;
      case 'saveAnalysisRecord': {
        const n =
          gen.recordCount > 0 && rng() < 0.15
            ? Math.floor(rng() * gen.recordCount) + 1
            : ++gen.recordCount;
        actions.push({
          type,
          n,
          captureId: knownOrFresh(gen, captureIds(gen), captureId(999999)),
          createdSeq: gen.seq++,
          withResult:
            rng() < 0.6 ? nextSpec(gen, shotId(gen.seq + 500000)) : null,
        });
        break;
      }
      case 'setKv': {
        const owner = pick(rng, [OWNER_A, OWNER_B, GUEST_DATA_OWNER]);
        const key =
          rng() < 0.8
            ? `${pick(rng, repo.OWNER_SCOPED_KV_NAMESPACES)}:${owner}`
            : pick(rng, KV_UNSCOPED_KEYS);
        if (!gen.kvKeys.includes(key)) gen.kvKeys.push(key);
        actions.push({ type, key, value: pick(rng, KV_VALUES) });
        break;
      }
      case 'purgeOwnerData':
        actions.push({
          type,
          owner: pick(rng, [OWNER_A, OWNER_B, GUEST_DATA_OWNER]),
        });
        break;
      case 'envReceipt':
        actions.push({
          type,
          shotId: knownOrFresh(gen, gen.shotIds, shotId(999999)),
        });
        break;
      case 'envBumpAttempts':
        actions.push({
          type,
          shotId: knownOrFresh(gen, gen.shotIds, shotId(999999)),
          by: pick(rng, [
            1,
            OUTBOX_MAX_ATTEMPTS - 1,
            OUTBOX_MAX_ATTEMPTS,
            OUTBOX_MAX_ATTEMPTS + 5,
          ]),
          lastError: pick(rng, ['shot.rejected: bad payload', '', null]),
        });
        break;
      case 'readDuringDelete':
        actions.push({
          type,
          owner: pick(rng, [OWNER_A, OWNER_B, GUEST_DATA_OWNER]),
          read: pick(rng, [
            'listShots',
            'listActivityShots',
            'listRealAnalysisFacts',
            'listCaptureHistory',
          ]),
          order: pick(rng, ['readFirst', 'purgeFirst']),
          delay: Math.floor(rng() * 24),
        });
        break;
      case 'badLimit':
        actions.push({
          type,
          read: pick(rng, [
            'listRealAnalysisFacts',
            'listScoredCheckpointFacts',
            'listPendingCaptures',
            'listCaptureHistory',
            'listLiveSessionHistory',
          ]),
          limit: pick(rng, [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]),
        });
        break;
      case 'bulkSave': {
        const specs: ShotSpec[] = [];
        const count = 25 + Math.floor(rng() * 50);
        for (let i = 0; i < count; i++)
          specs.push(nextSpec(gen, newShotId(gen)));
        actions.push({ type, specs });
        break;
      }
      case 'concurrentTransactions':
        actions.push({ type, first: txWrite(gen), second: txWrite(gen) });
        break;
    }
  }
  return actions;
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

export interface StressDb extends LocalDb {
  /** True while the underlying connection has an open transaction. */
  inTransaction(): boolean;
}

export interface StepTrace {
  step: number;
  action: string;
  outcome: string;
  stateHash: string;
}

export interface Failure {
  step: number;
  action: Action;
  invariant: string;
  detail: string;
}

export interface SequenceResult {
  seed: number;
  length: number;
  executedSteps: number;
  ok: boolean;
  failure: Failure | null;
  trace: StepTrace[];
  durationMs: number;
}

class InvariantViolation extends Error {
  constructor(
    readonly invariant: string,
    readonly detail: string,
  ) {
    super(`${invariant}: ${detail}`);
  }
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return value === undefined ? 'undefined' : JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter(key => record[key] !== undefined)
    .sort();
  return `{${keys
    .map(key => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(',')}}`;
}

function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function expectSame(
  invariant: string,
  actual: unknown,
  expected: unknown,
): void {
  const a = stableStringify(actual);
  const e = stableStringify(expected);
  if (a !== e) {
    throw new InvariantViolation(
      invariant,
      `expected ${truncate(e)} but observed ${truncate(a)}`,
    );
  }
}

function truncate(text: string): string {
  return text.length > 600
    ? `${text.slice(0, 600)}…(${text.length} chars)`
    : text;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function outcomeOf(operation: () => Promise<unknown>): Promise<string> {
  try {
    await operation();
    return 'ok';
  } catch (error) {
    return `threw:${errorMessage(error)}`;
  }
}

function expectOutcome(
  invariant: string,
  actual: string,
  expected: string | RegExp,
): void {
  const matches =
    typeof expected === 'string' ? actual === expected : expected.test(actual);
  if (!matches) {
    throw new InvariantViolation(
      invariant,
      `expected outcome ${String(expected)} but observed ${actual}`,
    );
  }
}

const SIGNED_OUT_MESSAGE =
  'threw:Sign in or continue locally before saving product data.';
const UNIQUE_VIOLATION = /^threw:(Error: )?UNIQUE constraint failed/;
/** SQLite's fail-fast for a second BEGIN while a transaction is open. */
const NESTED_TX =
  /^threw:(Error: )?cannot start a transaction within a transaction/;

interface Context {
  db: StressDb;
  model: RepositoryModel;
  knownShotIds: Set<string>;
  knownCaptureIds: Set<string>;
  knownKvKeys: Set<string>;
}

async function applyAction(ctx: Context, action: Action): Promise<string> {
  const { db, model } = ctx;
  switch (action.type) {
    case 'switchOwner': {
      const outcome = await outcomeOf(async () =>
        setActiveDataOwner(action.owner),
      );
      const accepted = model.setOwner(action.owner);
      expectOutcome(
        'setActiveDataOwner.accepts',
        outcome,
        accepted ? 'ok' : 'threw:Invalid local data owner.',
      );
      expectSame(
        'getActiveDataOwner.lowercased',
        getActiveDataOwner(),
        model.activeOwner,
      );
      return outcome;
    }
    case 'switchOwnerInvalid': {
      const before = getActiveDataOwner();
      const outcome = await outcomeOf(async () =>
        setActiveDataOwner(action.owner),
      );
      const accepted = model.setOwner(action.owner);
      expectOutcome(
        'setActiveDataOwner.rejectsInvalid',
        outcome,
        accepted ? 'ok' : 'threw:Invalid local data owner.',
      );
      if (!accepted) {
        expectSame(
          'setActiveDataOwner.unchangedOnReject',
          getActiveDataOwner(),
          before,
        );
      }
      return outcome;
    }
    case 'saveAnalysis': {
      const analysis = buildAnalysis(action.spec);
      ctx.knownShotIds.add(analysis.id);
      const outcome = await outcomeOf(() =>
        repo.saveAnalysis(db, analysis, action.permit),
      );
      if (analysis.source !== 'real') {
        expectOutcome(
          'saveAnalysis.refusesFixture',
          outcome,
          'threw:Only real analyses may be persisted by the app runtime.',
        );
      } else if (!action.permit.trim()) {
        expectOutcome(
          'saveAnalysis.requiresPermit',
          outcome,
          'threw:A server-reserved analysis permit is required before persisting a rating.',
        );
      } else if (!model.writable) {
        expectOutcome(
          'saveAnalysis.refusesSignedOut',
          outcome,
          SIGNED_OUT_MESSAGE,
        );
      } else {
        expectOutcome('saveAnalysis.ok', outcome, 'ok');
        model.active.shots.set(analysis.id, analysis);
        model.active.outbox.push({
          kind: 'shot.sync',
          entityId: analysis.id,
          attempts: 0,
          lastError: null,
        });
      }
      return outcome;
    }
    case 'saveLocalOnly': {
      const analysis = buildAnalysis(action.spec);
      ctx.knownShotIds.add(analysis.id);
      const outcome = await outcomeOf(() =>
        repo.saveLocalOnlyAnalysis(db, analysis),
      );
      if (analysis.resultKind === 'scored') {
        expectOutcome(
          'saveLocalOnlyAnalysis.refusesScored',
          outcome,
          'threw:Scored analyses must be persisted with their analysis permit via saveAnalysis.',
        );
      } else if (!model.writable) {
        expectOutcome(
          'saveLocalOnlyAnalysis.refusesSignedOut',
          outcome,
          SIGNED_OUT_MESSAGE,
        );
      } else {
        expectOutcome('saveLocalOnlyAnalysis.ok', outcome, 'ok');
        model.active.shots.set(analysis.id, analysis);
      }
      return outcome;
    }
    case 'saveSession': {
      const session = {
        id: action.id,
        mode: action.mode,
        shotType: action.shotType,
        focusCheckpoint: null,
        startedAt: startedAtIso(action.startedSeq),
      };
      const outcome = await outcomeOf(() => repo.saveSession(db, session));
      if (!model.writable) {
        expectOutcome(
          'saveSession.refusesSignedOut',
          outcome,
          SIGNED_OUT_MESSAGE,
        );
      } else {
        expectOutcome('saveSession.ok', outcome, 'ok');
        model.active.sessions.set(action.id, {
          ...session,
          completed: false,
          summary: null,
        });
        model.active.outbox.push({
          kind: 'session.create',
          entityId: action.id,
          attempts: 0,
          lastError: null,
        });
      }
      return outcome;
    }
    case 'finishSession': {
      const outcome = await outcomeOf(() =>
        repo.finishSession(db, action.id, action.summary),
      );
      if (!model.writable) {
        expectOutcome(
          'finishSession.refusesSignedOut',
          outcome,
          SIGNED_OUT_MESSAGE,
        );
      } else {
        expectOutcome('finishSession.ok', outcome, 'ok');
        const session = model.active.sessions.get(action.id);
        if (session) {
          session.completed = true;
          session.summary = JSON.stringify(action.summary);
        }
        model.active.outbox.push({
          kind: 'session.finalize',
          entityId: action.id,
          attempts: 0,
          lastError: null,
        });
      }
      return outcome;
    }
    case 'savePendingCapture': {
      const clip = buildClip(action.clipSeq, action.uriSuffix);
      ctx.knownCaptureIds.add(action.id);
      const outcome = await outcomeOf(() =>
        repo.savePendingCapture(
          db,
          action.id,
          action.shotType,
          clip,
          action.declared,
        ),
      );
      if (!model.writable) {
        expectOutcome(
          'savePendingCapture.refusesSignedOut',
          outcome,
          SIGNED_OUT_MESSAGE,
        );
      } else {
        const bucket = model.active;
        const duplicateId = bucket.captures.has(action.id);
        const duplicateUri = Array.from(bucket.captures.values()).some(
          capture => capture.identity.uri === clip.uri,
        );
        if (duplicateId || duplicateUri) {
          expectOutcome(
            'savePendingCapture.rejectsDuplicate',
            outcome,
            UNIQUE_VIOLATION,
          );
        } else {
          expectOutcome('savePendingCapture.ok', outcome, 'ok');
          bucket.captures.set(action.id, {
            id: action.id,
            shotType: action.shotType,
            declaredStroke: action.declared,
            identity: clip,
            payload: clip,
            status: 'awaiting_model',
            targetSeed: null,
          });
        }
      }
      return outcome;
    }
    case 'setDeclaredStroke': {
      const outcome = await outcomeOf(() =>
        repo.setDeclaredStroke(db, action.id, action.declared),
      );
      if (!model.writable) {
        expectOutcome(
          'setDeclaredStroke.refusesSignedOut',
          outcome,
          SIGNED_OUT_MESSAGE,
        );
      } else {
        expectOutcome('setDeclaredStroke.ok', outcome, 'ok');
        const capture = model.active.captures.get(action.id);
        if (capture) capture.declaredStroke = action.declared;
      }
      return outcome;
    }
    case 'setCaptureTargetSeed': {
      const seed = {
        point: { x: action.x, y: action.y },
        selectedAtIso: startedAtIso(0),
      };
      const outcome = await outcomeOf(() =>
        repo.setCaptureTargetSeed(db, action.id, seed),
      );
      if (!model.writable) {
        expectOutcome(
          'setCaptureTargetSeed.refusesSignedOut',
          outcome,
          SIGNED_OUT_MESSAGE,
        );
      } else {
        expectOutcome('setCaptureTargetSeed.ok', outcome, 'ok');
        const capture = model.active.captures.get(action.id);
        if (capture) capture.targetSeed = seed;
      }
      return outcome;
    }
    case 'updateCaptureClipPayload': {
      const existing = model.active.captures.get(action.id);
      const base = existing ? existing.identity : buildClip(0);
      const clip = enrichClip(
        action.mismatch ? { ...base, durationMs: base.durationMs + 1 } : base,
      );
      const outcome = await outcomeOf(() =>
        repo.updateCaptureClipPayload(db, action.id, clip),
      );
      if (!model.writable) {
        expectOutcome(
          'updateCaptureClipPayload.refusesSignedOut',
          outcome,
          SIGNED_OUT_MESSAGE,
        );
      } else {
        expectOutcome('updateCaptureClipPayload.ok', outcome, 'ok');
        if (existing) existing.payload = clip;
      }
      return outcome;
    }
    case 'markCaptureAnalyzed': {
      const outcome = await outcomeOf(() =>
        repo.markCaptureAnalyzed(db, action.id),
      );
      if (!model.writable) {
        expectOutcome(
          'markCaptureAnalyzed.refusesSignedOut',
          outcome,
          SIGNED_OUT_MESSAGE,
        );
      } else {
        expectOutcome('markCaptureAnalyzed.ok', outcome, 'ok');
        const capture = model.active.captures.get(action.id);
        if (capture) capture.status = 'analyzed';
      }
      return outcome;
    }
    case 'saveAnalysisRecord': {
      const record = buildRecord(
        action.n,
        action.captureId,
        action.createdSeq,
        action.withResult ? buildAnalysis(action.withResult) : null,
      );
      ctx.knownCaptureIds.add(action.captureId);
      const outcome = await outcomeOf(() =>
        repo.saveAnalysisRecord(db, record),
      );
      if (!model.writable) {
        expectOutcome(
          'saveAnalysisRecord.refusesSignedOut',
          outcome,
          SIGNED_OUT_MESSAGE,
        );
      } else if (model.active.records.has(record.id)) {
        expectOutcome(
          'saveAnalysisRecord.rejectsDuplicate',
          outcome,
          UNIQUE_VIOLATION,
        );
      } else {
        expectOutcome('saveAnalysisRecord.ok', outcome, 'ok');
        model.active.records.set(record.id, record);
      }
      return outcome;
    }
    case 'setKv': {
      ctx.knownKvKeys.add(action.key);
      const outcome = await outcomeOf(() =>
        repo.setKv(db, action.key, action.value),
      );
      expectOutcome('setKv.ok', outcome, 'ok');
      model.kv.set(action.key, action.value);
      return outcome;
    }
    case 'purgeOwnerData': {
      const outcome = await outcomeOf(() =>
        repo.purgeOwnerData(db, action.owner),
      );
      expectOutcome('purgeOwnerData.ok', outcome, 'ok');
      model.purge(action.owner);
      return outcome;
    }
    case 'envReceipt': {
      // The sync layer's acceptance write (sync.ts), scoped like it is.
      const owner = getActiveDataOwner();
      await db.execute(
        `INSERT OR REPLACE INTO sync_receipt (owner_key, kind, entity_id) VALUES (?, 'shot.sync', ?)`,
        [owner, action.shotId],
      );
      model.bucket(owner).receipts.add(action.shotId);
      ctx.knownShotIds.add(action.shotId);
      return 'ok';
    }
    case 'envBumpAttempts': {
      // The sync layer's failure bookkeeping on the newest outbox row.
      const owner = getActiveDataOwner();
      await db.execute(
        `UPDATE outbox SET attempts = attempts + ?, last_error = ?
         WHERE id = (SELECT MAX(id) FROM outbox
                     WHERE owner_key = ? AND kind = 'shot.sync'
                       AND json_extract(payload, '$.id') = ?)`,
        [action.by, action.lastError, owner, action.shotId],
      );
      const rows = model
        .bucket(owner)
        .outbox.filter(
          row => row.kind === 'shot.sync' && row.entityId === action.shotId,
        );
      const row = rows[rows.length - 1];
      if (row) {
        row.attempts += action.by;
        row.lastError = action.lastError;
      }
      ctx.knownShotIds.add(action.shotId);
      return 'ok';
    }
    case 'readDuringDelete': {
      // Start a read, delete an owner bucket while it is in flight, then
      // observe both. The read must be linearizable: it sees either the
      // pre-delete or the post-delete partition, never a torn view.
      const before = snapshotRead(model, action.read);
      let pending: Promise<unknown>;
      let purge: Promise<void>;
      if (action.order === 'readFirst') {
        pending = performRead(db, action.read);
        purge = repo.purgeOwnerData(db, action.owner);
      } else {
        purge = repo.purgeOwnerData(db, action.owner);
        pending = (async () => {
          for (let hop = 0; hop < action.delay; hop++) await Promise.resolve();
          return performRead(db, action.read);
        })();
      }
      const [readOutcome, purgeOutcome] = await Promise.allSettled([
        pending,
        purge,
      ]);
      expectOutcome(
        'purgeOwnerData.duringRead.ok',
        purgeOutcome.status === 'fulfilled'
          ? 'ok'
          : `threw:${errorMessage(purgeOutcome.reason)}`,
        'ok',
      );
      model.purge(action.owner);
      const after = snapshotRead(model, action.read);
      if (readOutcome.status === 'rejected') {
        throw new InvariantViolation(
          'read.duringDelete.noThrow',
          `read threw ${errorMessage(readOutcome.reason)}`,
        );
      }
      const observed = stableStringify(readOutcome.value);
      if (
        observed !== stableStringify(before) &&
        observed !== stableStringify(after)
      ) {
        throw new InvariantViolation(
          'read.duringDelete.linearizable',
          `observed ${truncate(observed)}; pre=${truncate(stableStringify(before))}; post=${truncate(stableStringify(after))}`,
        );
      }
      return `ok:${observed === stableStringify(before) ? 'pre' : 'post'}`;
    }
    case 'badLimit': {
      const outcome = await outcomeOf(() =>
        performLimitedRead(db, action.read, action.limit),
      );
      expectOutcome(
        'limit.validated',
        outcome,
        /^threw:.* limit must be a positive integer\.$/,
      );
      return outcome;
    }
    case 'bulkSave': {
      let outcome = 'ok';
      for (const spec of action.specs) {
        const analysis = buildAnalysis(spec);
        ctx.knownShotIds.add(analysis.id);
        outcome = await outcomeOf(() =>
          repo.saveAnalysis(db, analysis, PERMIT_ID),
        );
        if (!model.writable) {
          expectOutcome(
            'bulkSave.refusesSignedOut',
            outcome,
            SIGNED_OUT_MESSAGE,
          );
        } else {
          expectOutcome('bulkSave.ok', outcome, 'ok');
          model.active.shots.set(analysis.id, analysis);
          model.active.outbox.push({
            kind: 'shot.sync',
            entityId: analysis.id,
            attempts: 0,
            lastError: null,
          });
        }
      }
      return outcome;
    }
    case 'concurrentTransactions':
      return applyConcurrent(ctx, action.first, action.second);
  }
}

function startedAtIso(seq: number): string {
  return new Date(Date.UTC(2026, 2, 1) + seq * 1000).toISOString();
}

function snapshotRead(model: RepositoryModel, read: ReadKind): unknown {
  switch (read) {
    case 'listShots':
      return model.listShots(1000);
    case 'listActivityShots':
      return model.listActivityShots();
    case 'listRealAnalysisFacts':
      return model.listRealAnalysisFacts(null);
    case 'listCaptureHistory':
      return model.listCaptureHistory(null);
  }
}

function performRead(db: LocalDb, read: ReadKind): Promise<unknown> {
  switch (read) {
    case 'listShots':
      return repo.listShots(db, 1000);
    case 'listActivityShots':
      return repo.listActivityShots(db);
    case 'listRealAnalysisFacts':
      return repo.listRealAnalysisFacts(db, null);
    case 'listCaptureHistory':
      return repo.listCaptureHistory(db, null);
  }
}

function performLimitedRead(
  db: LocalDb,
  read: LimitedRead,
  limit: number,
): Promise<unknown> {
  switch (read) {
    case 'listRealAnalysisFacts':
      return repo.listRealAnalysisFacts(db, limit);
    case 'listScoredCheckpointFacts':
      return repo.listScoredCheckpointFacts(db, limit);
    case 'listPendingCaptures':
      return repo.listPendingCaptures(db, limit);
    case 'listCaptureHistory':
      return repo.listCaptureHistory(db, limit);
    case 'listLiveSessionHistory':
      return repo.listLiveSessionHistory(db, limit);
  }
}

// ---------------------------------------------------------------------------
// Overlapping transactions (near-legal: two un-sequenced writes in flight)
// ---------------------------------------------------------------------------

function runTx(db: LocalDb, write: TxWrite): Promise<void> {
  switch (write.kind) {
    case 'saveAnalysis':
      return repo.saveAnalysis(db, buildAnalysis(write.spec), PERMIT_ID);
    case 'saveSession':
      return repo.saveSession(db, {
        id: write.id,
        mode: 'practice_set',
        shotType: null,
        focusCheckpoint: null,
        startedAt: startedAtIso(write.startedSeq),
      });
    case 'finishSession':
      return repo.finishSession(db, write.id, { stress: true });
    case 'purgeOwnerData':
      return repo.purgeOwnerData(db, write.owner);
  }
}

/** Applies a write to the model as if it fully committed. */
function commitToModel(ctx: Context, write: TxWrite): void {
  const { model } = ctx;
  switch (write.kind) {
    case 'saveAnalysis': {
      const analysis = buildAnalysis(write.spec);
      ctx.knownShotIds.add(analysis.id);
      model.active.shots.set(analysis.id, analysis);
      model.active.outbox.push({
        kind: 'shot.sync',
        entityId: analysis.id,
        attempts: 0,
        lastError: null,
      });
      return;
    }
    case 'saveSession':
      model.active.sessions.set(write.id, {
        id: write.id,
        mode: 'practice_set',
        shotType: null,
        focusCheckpoint: null,
        startedAt: startedAtIso(write.startedSeq),
        completed: false,
        summary: null,
      });
      model.active.outbox.push({
        kind: 'session.create',
        entityId: write.id,
        attempts: 0,
        lastError: null,
      });
      return;
    case 'finishSession': {
      const session = model.active.sessions.get(write.id);
      if (session) {
        session.completed = true;
        session.summary = JSON.stringify({ stress: true });
      }
      model.active.outbox.push({
        kind: 'session.finalize',
        entityId: write.id,
        attempts: 0,
        lastError: null,
      });
      return;
    }
    case 'purgeOwnerData':
      model.purge(write.owner);
      return;
  }
}

/** Raw row evidence of a write, independent of the model: the count of the
 * rows the write creates (or, for purge, the owner's remaining rows). */
async function footprint(
  db: LocalDb,
  owner: string,
  write: TxWrite,
): Promise<number> {
  switch (write.kind) {
    case 'saveAnalysis': {
      const shot = await db.execute(
        `SELECT COUNT(*) AS n FROM local_shot WHERE owner_key = ? AND id = ? AND captured_at = ?`,
        [owner, write.spec.id, buildAnalysis(write.spec).capturedAtIso],
      );
      return Number(shot.rows[0]?.['n']);
    }
    case 'saveSession': {
      const session = await db.execute(
        `SELECT COUNT(*) AS n FROM local_session WHERE owner_key = ? AND id = ? AND started_at = ?`,
        [owner, write.id, startedAtIso(write.startedSeq)],
      );
      return Number(session.rows[0]?.['n']);
    }
    case 'finishSession':
      return outboxCount(db, owner, 'session.finalize', write.id);
    case 'purgeOwnerData': {
      let total = 0;
      for (const table of OWNER_SCOPED_TABLES) {
        const row = await db.execute(
          `SELECT COUNT(*) AS n FROM ${table} WHERE owner_key = ?`,
          [write.owner],
        );
        total += Number(row.rows[0]?.['n']);
      }
      return total;
    }
  }
}

function targetKey(write: TxWrite): string {
  switch (write.kind) {
    case 'saveAnalysis':
      return `shot:${write.spec.id}:${write.spec.seq}`;
    case 'saveSession':
      return `session:${write.id}:${write.startedSeq}`;
    case 'finishSession':
      return `finalize:${write.id}`;
    case 'purgeOwnerData':
      return `purge:${write.owner}`;
  }
}

async function outboxCount(
  db: LocalDb,
  owner: string,
  kind: string,
  entityId: string,
): Promise<number> {
  const row = await db.execute(
    `SELECT COUNT(*) AS n FROM outbox WHERE owner_key = ? AND kind = ? AND json_extract(payload, '$.id') = ?`,
    [owner, kind, entityId],
  );
  return Number(row.rows[0]?.['n']);
}

async function applyConcurrent(
  ctx: Context,
  first: TxWrite,
  second: TxWrite,
): Promise<string> {
  const { db, model } = ctx;
  const owner = getActiveDataOwner();
  if (!model.writable) {
    const outcomes = await Promise.allSettled([
      runTx(db, first),
      runTx(db, second),
    ]);
    const bothPurge =
      first.kind === 'purgeOwnerData' && second.kind === 'purgeOwnerData';
    const summary: string[] = [];
    for (const [index, write] of [first, second].entries()) {
      const outcome = outcomes[index];
      if (write.kind === 'purgeOwnerData') {
        if (outcome?.status === 'fulfilled') model.purge(write.owner);
        const observed =
          outcome?.status === 'fulfilled'
            ? 'ok'
            : `threw:${errorMessage(outcome?.reason)}`;
        // Two purges overlap on the shared connection: the loser's BEGIN
        // IMMEDIATE fails fast; the post-step model check proves nothing of
        // it landed (the model only purges the resolved one).
        if (bothPurge && NESTED_TX.test(observed)) {
          summary.push('purge:rejected(nested-tx)');
          continue;
        }
        expectOutcome('concurrent.purge.ok', observed, 'ok');
        summary.push('purge:resolved');
      } else {
        expectOutcome(
          'concurrent.refusesSignedOut',
          outcome?.status === 'rejected'
            ? `threw:${errorMessage(outcome.reason)}`
            : 'ok',
          SIGNED_OUT_MESSAGE,
        );
        summary.push(`${write.kind}:refused`);
      }
    }
    if (db.inTransaction()) {
      throw new InvariantViolation(
        'concurrent.noDanglingTransaction',
        'connection left inside a transaction',
      );
    }
    return `ok:signed-out:${summary.join('|')}`;
  }
  const outboxBefore = await Promise.all(
    [first, second].map(write =>
      write.kind === 'saveAnalysis'
        ? outboxCount(db, owner, 'shot.sync', write.spec.id)
        : write.kind === 'saveSession'
          ? outboxCount(db, owner, 'session.create', write.id)
          : Promise.resolve(0),
    ),
  );
  const footprintBefore = await Promise.all(
    [first, second].map(write => footprint(db, owner, write)),
  );
  const outcomes = await Promise.allSettled([
    runTx(db, first),
    runTx(db, second),
  ]);
  if (db.inTransaction()) {
    throw new InvariantViolation(
      'concurrent.noDanglingTransaction',
      'connection left inside a transaction',
    );
  }
  const summary: string[] = [];
  for (const [index, write] of [first, second].entries()) {
    const outcome = outcomes[index];
    const resolved = outcome?.status === 'fulfilled';
    const before = footprintBefore[index] ?? 0;
    const after = await footprint(db, owner, write);
    // purge: "landed" = rows gone; indeterminate when there was nothing to
    // purge (then only the resolved/rejected contract is checked).
    const landed =
      write.kind === 'purgeOwnerData' ? after === 0 : after > before;
    // Indeterminate when the twin write targets the same rows (its footprint
    // is indistinguishable) or when a purge had nothing to remove.
    const indeterminate =
      targetKey(first) === targetKey(second) ||
      (write.kind === 'purgeOwnerData' && before === 0);
    const reason =
      outcome?.status === 'rejected'
        ? NESTED_TX.test(`threw:${errorMessage(outcome.reason)}`)
          ? '(nested-tx)'
          : '(other)'
        : '';
    summary.push(
      `${write.kind}:${resolved ? 'resolved' : `rejected${reason}`}:${landed ? 'landed' : 'absent'}`,
    );
    if (resolved) {
      if (!landed && !indeterminate) {
        throw new InvariantViolation(
          'concurrent.resolvedMeansPersisted',
          `${write.kind} resolved but its rows are absent (${summary.join(' | ')})`,
        );
      }
      // Atomicity: the paired outbox row must have landed exactly once more.
      if (write.kind === 'saveAnalysis' || write.kind === 'saveSession') {
        const kind =
          write.kind === 'saveAnalysis' ? 'shot.sync' : 'session.create';
        const entity = write.kind === 'saveAnalysis' ? write.spec.id : write.id;
        const after = await outboxCount(db, owner, kind, entity);
        if (after !== (outboxBefore[index] ?? 0) + 1) {
          throw new InvariantViolation(
            'concurrent.atomicOutboxPair',
            `${write.kind} resolved with outbox delta ${after - (outboxBefore[index] ?? 0)} (${summary.join(' | ')})`,
          );
        }
      }
      commitToModel(ctx, write);
    } else if (landed && !indeterminate) {
      throw new InvariantViolation(
        'concurrent.rejectedMeansRolledBack',
        `${write.kind} rejected (${errorMessage(outcome?.status === 'rejected' ? outcome.reason : null)}) but its rows landed (${summary.join(' | ')})`,
      );
    }
  }
  return `ok:${summary.join('|')}`;
}

// ---------------------------------------------------------------------------
// Invariant sweep (after every step)
// ---------------------------------------------------------------------------

/** Per-id probes are bounded so bulk sequences stay fast: all ids up to 40,
 * otherwise the 20 oldest and 20 newest (deterministic, insertion order). */
function sample(ids: Set<string>): string[] {
  const all = Array.from(ids);
  if (all.length <= 40) return all;
  return [...all.slice(0, 20), ...all.slice(-20)];
}

async function checkInvariants(ctx: Context): Promise<string> {
  const { db, model } = ctx;
  if (db.inTransaction()) {
    throw new InvariantViolation(
      'connection.noOpenTransaction',
      'a transaction is still open after the step',
    );
  }
  expectSame('activeOwner', getActiveDataOwner(), model.activeOwner);

  const shots = await repo.listShots(db, 1000);
  expectSame('listShots.newestFirstOwnerScoped', shots, model.listShots(1000));
  expectSame(
    'listShots.limit',
    await repo.listShots(db, 3),
    model.listShots(3),
  );
  expectSame(
    'listActivityShots.oldestFirst',
    await repo.listActivityShots(db),
    model.listActivityShots(),
  );
  expectSame(
    'recentScores.all',
    await repo.recentScores(db, null, 30),
    model.recentScores(null, 30),
  );
  const lastType = shots[0]?.shotType ?? 'dink';
  expectSame(
    `recentScores.byType`,
    await repo.recentScores(db, lastType, 5),
    model.recentScores(lastType, 5),
  );
  expectSame(
    'listRealAnalysisFacts.unbounded',
    await repo.listRealAnalysisFacts(db, null),
    model.listRealAnalysisFacts(null),
  );
  expectSame(
    'listRealAnalysisFacts.limited',
    await repo.listRealAnalysisFacts(db, 4),
    model.listRealAnalysisFacts(4),
  );
  expectSame(
    'listScoredCheckpointFacts',
    await repo.listScoredCheckpointFacts(db, 120),
    model.listScoredCheckpointFacts(120),
  );
  expectSame(
    'listScoredCheckpointFacts.limited',
    await repo.listScoredCheckpointFacts(db, 2),
    model.listScoredCheckpointFacts(2),
  );
  for (const id of sample(ctx.knownShotIds)) {
    expectSame(
      `getAnalysis.ownerScoped[${id}]`,
      await repo.getAnalysis(db, id),
      model.getAnalysis(id),
    );
    expectSame(
      `hasShotSyncReceipt[${id}]`,
      await repo.hasShotSyncReceipt(db, id),
      model.hasShotSyncReceipt(id),
    );
    expectSame(
      `getShotOutboxStatus[${id}]`,
      await repo.getShotOutboxStatus(db, id),
      model.getShotOutboxStatus(id),
    );
  }

  expectSame(
    'listPendingCaptures.unbounded',
    await repo.listPendingCaptures(db, null),
    model.listPendingCaptures(null),
  );
  expectSame(
    'listPendingCaptures.limited',
    await repo.listPendingCaptures(db, 2),
    model.listPendingCaptures(2),
  );
  expectSame(
    'listCaptureHistory.unbounded',
    await repo.listCaptureHistory(db, null),
    model.listCaptureHistory(null),
  );
  expectSame(
    'listCaptureHistory.limited',
    await repo.listCaptureHistory(db, 2),
    model.listCaptureHistory(2),
  );
  for (const id of sample(ctx.knownCaptureIds)) {
    expectSame(
      `getPendingCapture[${id}]`,
      await repo.getPendingCapture(db, id),
      model.getPendingCapture(id),
    );
    expectSame(
      `getCaptureTargetSeed[${id}]`,
      await repo.getCaptureTargetSeed(db, id),
      model.getCaptureTargetSeed(id),
    );
    expectSame(
      `listAnalysisRecords[${id}]`,
      await repo.listAnalysisRecords(db, id),
      model.listAnalysisRecords(id),
    );
  }

  const live = await repo.listLiveSessionHistory(db, 60);
  expectSame(
    'listLiveSessionHistory.completedLiveCourtAsc',
    live.map(row => ({
      ...row,
      endedAt: row.endedAt === null ? null : 'present',
    })),
    model.listLiveSessionHistory(60),
  );
  for (const key of ctx.knownKvKeys) {
    expectSame(`getKv[${key}]`, await repo.getKv(db, key), model.getKv(key));
  }

  // Raw partition check: every owner's row counts in every owner-scoped
  // table, including owners that are NOT active (isolation + purge).
  const partition: Record<string, Record<string, number>> = {};
  for (const table of OWNER_SCOPED_TABLES) {
    const { rows } = await db.execute(
      `SELECT owner_key, COUNT(*) AS n FROM ${table} GROUP BY owner_key ORDER BY owner_key`,
    );
    const counts: Record<string, number> = {};
    for (const row of rows) counts[String(row['owner_key'])] = Number(row['n']);
    partition[table] = counts;
    expectSame(`partition.${table}`, counts, model.rowCounts(table));
  }
  // Every shot.sync outbox row belongs to a real shot payload of its owner
  // (the migration purge rule) and every kv owner namespace key that exists
  // belongs to an owner the model still knows about.
  const { rows: kvRows } = await db.execute(
    `SELECT key, value FROM kv ORDER BY key`,
  );
  const kvObserved = Object.fromEntries(
    kvRows.map(row => [String(row['key']), String(row['value'])]),
  );
  expectSame(
    'kv.exact',
    kvObserved,
    Object.fromEntries(Array.from(model.kv.entries()).sort()),
  );

  return fnv1a(
    stableStringify({
      shots,
      partition,
      kv: kvObserved,
      owner: getActiveDataOwner(),
    }),
  );
}

// ---------------------------------------------------------------------------
// Sequence runner, determinism, minimization
// ---------------------------------------------------------------------------

/** Opens a fresh migrated store whose statement scheduling derives from `seed`. */
export type OpenDb = (seed: number) => StressDb;

function describeAction(action: Action): string {
  switch (action.type) {
    case 'saveAnalysis':
      return `saveAnalysis(${action.spec.id.slice(0, 8)},${action.spec.scored ? 'scored' : 'low'},${action.spec.source}${action.permit.trim() ? '' : ',no-permit'})`;
    case 'saveLocalOnly':
      return `saveLocalOnly(${action.spec.id.slice(0, 8)},${action.spec.scored ? 'scored' : 'low'})`;
    case 'bulkSave':
      return `bulkSave(${action.specs.length})`;
    case 'concurrentTransactions':
      return `concurrent(${action.first.kind},${action.second.kind})`;
    default:
      return `${action.type}(${stableStringify({ ...action, type: undefined })})`;
  }
}

export async function executeActions(
  openDb: OpenDb,
  seed: number,
  actions: Action[],
): Promise<SequenceResult> {
  const startedAt = Date.now();
  const db = openDb(seed);
  const ctx: Context = {
    db,
    model: new RepositoryModel(),
    knownShotIds: new Set(),
    knownCaptureIds: new Set(),
    knownKvKeys: new Set(),
  };
  const trace: StepTrace[] = [];
  let failure: Failure | null = null;
  let executedSteps = 0;
  try {
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    for (const [index, action] of actions.entries()) {
      let outcome = '';
      try {
        outcome = await applyAction(ctx, action);
        const stateHash = await checkInvariants(ctx);
        trace.push({
          step: index,
          action: describeAction(action),
          outcome,
          stateHash,
        });
        executedSteps = index + 1;
      } catch (error) {
        executedSteps = index + 1;
        const violation =
          error instanceof InvariantViolation
            ? error
            : new InvariantViolation(
                'unexpected.exception',
                errorMessage(error),
              );
        failure = {
          step: index,
          action,
          invariant: violation.invariant,
          detail: violation.detail,
        };
        trace.push({
          step: index,
          action: describeAction(action),
          outcome: outcome || 'n/a',
          stateHash: `FAIL:${violation.invariant}`,
        });
        break;
      }
    }
  } finally {
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    db.close();
  }
  return {
    seed,
    length: actions.length,
    executedSteps,
    ok: failure === null,
    failure,
    trace,
    durationMs: Date.now() - startedAt,
  };
}

export async function runSequence(
  openDb: OpenDb,
  seed: number,
  options: GenerateOptions = {},
): Promise<SequenceResult> {
  return executeActions(openDb, seed, generateActions(seed, options));
}

export function traceKey(result: SequenceResult): string {
  return stableStringify(
    result.trace.map(step => [
      step.step,
      step.action,
      step.outcome,
      step.stateHash,
    ]),
  );
}

export interface MinimizedFailure {
  seed: number;
  originalLength: number;
  minimizedLength: number;
  actions: Action[];
  failure: Failure;
  executions: number;
}

/** ddmin over the action list: the smallest sub-sequence (by greedy chunk
 * removal) that still trips the SAME invariant. */
export async function minimizeFailure(
  openDb: OpenDb,
  seed: number,
  actions: Action[],
  target: Failure,
  maxExecutions = 250,
): Promise<MinimizedFailure> {
  let current = actions.slice(0, target.step + 1);
  let executions = 0;
  let lastFailure = target;
  const stillFails = async (candidate: Action[]): Promise<boolean> => {
    if (executions >= maxExecutions) return false;
    executions += 1;
    const result = await executeActions(openDb, seed, candidate);
    if (result.failure && result.failure.invariant === target.invariant) {
      lastFailure = result.failure;
      return true;
    }
    return false;
  };
  let granularity = 2;
  while (current.length >= 2 && executions < maxExecutions) {
    const chunk = Math.ceil(current.length / granularity);
    let reduced = false;
    for (let start = 0; start < current.length; start += chunk) {
      const candidate = [
        ...current.slice(0, start),
        ...current.slice(start + chunk),
      ];
      if (candidate.length === 0) continue;
      if (await stillFails(candidate)) {
        current = candidate;
        granularity = Math.max(granularity - 1, 2);
        reduced = true;
        break;
      }
    }
    if (!reduced) {
      if (granularity >= current.length) break;
      granularity = Math.min(current.length, granularity * 2);
    }
  }
  return {
    seed,
    originalLength: actions.length,
    minimizedLength: current.length,
    actions: current,
    failure: lastFailure,
    executions,
  };
}
