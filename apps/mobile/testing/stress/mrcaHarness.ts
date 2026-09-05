/**
 * mod-run-capture-analysis — SEEDED RANDOMIZED LONG-RUN harness.
 *
 * Generates legal / near-legal action sequences over the PUBLIC API of
 * `runCaptureAnalysis` and `practiceSet` (plan / commit / resumeOrStart /
 * note / current), executes them against the REAL modules (real fusion
 * pipeline, real repository SQL against the in-memory LocalDb, real permit
 * client) with only the I/O seams replaced (sidecar reader, `fetch`, uuid),
 * and model-checks the documented invariants after EVERY step.
 *
 * Invariants (AGENTS.md "analysis permit semantics", runCaptureAnalysis.ts
 * release-boundary comments, practiceSet.ts contracts):
 *
 *  G1  every finalize names a permit the server issued, and each permit is
 *      finalized AT MOST once (never released twice, never released after
 *      being consumed);
 *  G2  no rating without a permit: every `shot.sync` outbox row carries a
 *      permit id the server issued and that was never released;
 *  G3  no open transaction survives a step (no orphaned BEGIN);
 *  G4  stability SLO accounting: analysis_started == runs started and
 *      completed + failed == runs settled;
 *  G5  the signed-out bucket is never written (accountScope contract);
 *  G6  the permit client never calls an unexpected route;
 *  G7  practice-set kv state equals the model (per owner, exact bytes) and
 *      every session row / session.create outbox row is one the model
 *      predicted;
 *
 *  Per single analysis run (R*): rejected-before-reserve input never
 *  reserves nor writes; a reserve failure never releases nor writes; a
 *  reserved run settles its permit exactly once — consumed iff scored,
 *  released 'low_confidence' / 'unsupported' / 'failed' matching the outcome
 *  otherwise, and released exactly once even when the run throws;
 *  telemetry never changes the outcome; `freeLimitReached` mirrors the
 *  reserve-time access snapshot; a scored record carries the request's
 *  sessionId.
 *
 *  Per practice-set call (P*): plan writes nothing and returns exactly the
 *  model's plan; commit / note / resumeOrStart leave exactly the model's kv
 *  record; current is a pure read of the model's live-set rule; signed-out
 *  callers get null with zero statements; an invalid clock throws before any
 *  write.
 */
import type { ShotTypeSlug } from '@pickle/shared-types';
import type { LocalDb } from '../../src/data/db';
import {
  GUEST_DATA_OWNER,
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import { stabilitySlo } from '../../src/analysis/stabilityTelemetry';
import {
  runCaptureAnalysis,
  type CaptureAnalysisOutcome,
} from '../../src/analysis/runCaptureAnalysis';
import {
  PRACTICE_SET_IDLE_TIMEOUT_MS,
  commitPracticeSet,
  currentPracticeSetId,
  notePracticeSetAnalysis,
  planPracticeSet,
  practiceSetKeyForOwner,
  resumeOrStartPracticeSet,
  type PracticeSetPlan,
} from '../../src/analysis/practiceSet';
import {
  createFakeLocalDb,
  type FakeLocalDb,
} from '../xcBehavioral/fakeLocalDb';
import {
  CLIP_KINDS,
  PRE_RESERVE_GATE_KINDS,
  makeClipFixture,
  makeEnvelope,
  type ClipKind,
} from './mrcaFixtures';
import {
  createStressPermitServer,
  defaultScript,
  deferred,
  type Deferred,
  type ReleaseMode,
  type ReserveMode,
  type StressPermitServer,
} from './mrcaPermitServer';
import {
  chance,
  int,
  mulberry32,
  permutation,
  pick,
  seededUuid,
  weighted,
  type Rng,
} from './rng';
import { seams } from './mrcaSeams';

// ─── Action vocabulary ──────────────────────────────────────────────────────

export type OwnerTag = 'A' | 'B' | 'guest' | 'signed_out';
export const OWNERS: Record<OwnerTag, string> = {
  A: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  B: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  guest: GUEST_DATA_OWNER,
  signed_out: SIGNED_OUT_DATA_OWNER,
};

/** How a step names a session: the live set, a known set, a made-up one. */
export type SessionRef = 'none' | 'current' | 'known' | 'foreign' | 'empty';
export type ClockRef = 'now' | 'invalid';
export type EnvelopeRef = 'none' | 'SUPPORTED' | 'DEGRADED' | 'UNSUPPORTED';
export type ProviderMode = 'real' | 'throw_sync' | 'reject_async';
export type TelemetryMode = 'none' | 'consent' | 'no_consent';
export type TokenMode = 'ok' | 'missing' | 'blank';

export const DB_FAULT_NEEDLES = [
  'INSERT INTO local_analysis_record',
  'UPDATE local_capture',
  'INSERT OR REPLACE INTO local_shot',
  'INSERT INTO outbox',
  'COMMIT',
  'BEGIN IMMEDIATE',
  'INSERT OR REPLACE INTO kv',
  'INSERT OR REPLACE INTO local_session',
  'SELECT value FROM kv',
] as const;
export type DbFaultNeedle = (typeof DB_FAULT_NEEDLES)[number];

export interface RunSpec {
  id: string;
  clipKind: ClipKind;
  envelope: EnvelopeRef;
  declared: ShotTypeSlug | null;
  canonical: boolean;
  reserve: ReserveMode;
  release: ReleaseMode;
  provider: ProviderMode;
  telemetry: TelemetryMode;
  token: TokenMode;
  session: SessionRef;
  handedness: 'right' | 'left' | 'ambidextrous';
}

export type KvCorruptMode =
  | 'garbage'
  | 'missing_session'
  | 'bad_timestamp'
  | 'future'
  | 'empty_string'
  | 'wrong_types';

export type Action =
  | { kind: 'analyze'; run: RunSpec }
  | {
      kind: 'analyze_race';
      runs: RunSpec[];
      releaseOrder: number[];
      abandon: boolean[];
      holdRelease: boolean[];
    }
  | { kind: 'drain' }
  | {
      kind: 'ps_plan';
      shot: ShotTypeSlug | null;
      preferred: SessionRef;
      clock: ClockRef;
    }
  | { kind: 'ps_commit'; clock: ClockRef | null }
  | {
      kind: 'ps_resume_or_start';
      shot: ShotTypeSlug | null;
      preferred: SessionRef;
      clock: ClockRef;
    }
  | { kind: 'ps_note'; session: SessionRef; clock: ClockRef }
  | { kind: 'ps_current'; clock: ClockRef }
  | { kind: 'switch_owner'; owner: OwnerTag }
  | { kind: 'clock'; deltaMs: number }
  | { kind: 'kv_corrupt'; mode: KvCorruptMode }
  | { kind: 'db_fault'; needle: DbFaultNeedle };

export const SEQUENCE_MIN_LENGTH = 5;
export const SEQUENCE_MAX_LENGTH = 60;

const SHOT_TYPES: ReadonlyArray<ShotTypeSlug | null> = [
  'forehand_drive',
  'backhand_drive',
  'dink',
  'third_shot_drop',
  'serve',
  null,
];

const RESERVE_MODES: readonly ReserveMode[] = [
  'ok',
  'ok',
  'ok',
  'ok',
  'ok_last_free',
  'ok_premium',
  'ok_malformed_access',
  'paywall_402',
  'server_500',
  'network_throw',
  'not_reserved_status',
  'invalid_permit',
  'blank_permit_id',
  'malformed_json',
];
const RELEASE_MODES: readonly ReleaseMode[] = [
  'ok',
  'ok',
  'ok',
  'server_500',
  'network_throw',
];

function genRunSpec(rng: Rng, id: string): RunSpec {
  const clipKind = weighted<ClipKind>(rng, [
    ['good', 30],
    ['good_left', 8],
    ['good_wide_stance', 8],
    ['frozen_wrists', 8],
    ['sparse_pose', 6],
    ['invisible_pose', 6],
    ['imported_with_sidecar', 6],
    ['imported_no_sidecar', 4],
    ['no_sidecar', 4],
    ['unreadable_sidecar', 4],
    ['hash_mismatch', 4],
    ['invalid_sidecar', 4],
    ['empty_frames', 3],
  ]);
  return {
    id,
    clipKind,
    envelope: weighted<EnvelopeRef>(rng, [
      ['none', 55],
      ['SUPPORTED', 15],
      ['DEGRADED', 15],
      ['UNSUPPORTED', 15],
    ]),
    declared: pick(rng, SHOT_TYPES),
    canonical: chance(rng, 0.3),
    reserve: pick(rng, RESERVE_MODES),
    release: pick(rng, RELEASE_MODES),
    provider: weighted<ProviderMode>(rng, [
      ['real', 78],
      ['throw_sync', 11],
      ['reject_async', 11],
    ]),
    telemetry: weighted<TelemetryMode>(rng, [
      ['none', 55],
      ['consent', 30],
      ['no_consent', 15],
    ]),
    token: weighted<TokenMode>(rng, [
      ['ok', 88],
      ['missing', 6],
      ['blank', 6],
    ]),
    session: weighted<SessionRef>(rng, [
      ['none', 40],
      ['current', 30],
      ['known', 15],
      ['foreign', 15],
    ]),
    handedness: weighted(rng, [
      ['right', 70],
      ['left', 20],
      ['ambidextrous', 10],
    ]),
  };
}

function genSessionRef(rng: Rng): SessionRef {
  return weighted<SessionRef>(rng, [
    ['none', 40],
    ['current', 25],
    ['known', 15],
    ['foreign', 15],
    ['empty', 5],
  ]);
}

function genClock(rng: Rng): ClockRef {
  return chance(rng, 0.05) ? 'invalid' : 'now';
}

function genClockDelta(rng: Rng): number {
  return weighted<number>(rng, [
    [0, 5],
    [int(rng, 1, 5 * 60_000), 35],
    [int(rng, 5 * 60_000, 19 * 60_000), 15],
    [PRACTICE_SET_IDLE_TIMEOUT_MS, 8],
    [PRACTICE_SET_IDLE_TIMEOUT_MS + 1, 8],
    [PRACTICE_SET_IDLE_TIMEOUT_MS - 1, 4],
    [int(rng, 21 * 60_000, 3 * 60 * 60_000), 15],
    [-int(rng, 1, 30 * 60_000), 10],
  ]);
}

export function generateSequence(seed: number): Action[] {
  const rng = mulberry32(seed);
  const length = int(rng, SEQUENCE_MIN_LENGTH, SEQUENCE_MAX_LENGTH);
  const actions: Action[] = [];
  let runCounter = 0;
  for (let i = 0; i < length; i += 1) {
    const kind = weighted<Action['kind']>(rng, [
      ['analyze', 30],
      ['analyze_race', 8],
      ['drain', 4],
      ['ps_plan', 9],
      ['ps_commit', 8],
      ['ps_resume_or_start', 7],
      ['ps_note', 7],
      ['ps_current', 6],
      ['switch_owner', 5],
      ['clock', 8],
      ['kv_corrupt', 3],
      ['db_fault', 3],
    ]);
    switch (kind) {
      case 'analyze':
        runCounter += 1;
        actions.push({
          kind,
          run: genRunSpec(rng, `run-${seed}-${runCounter}`),
        });
        break;
      case 'analyze_race': {
        const count = int(rng, 2, 4);
        const runs: RunSpec[] = [];
        for (let r = 0; r < count; r += 1) {
          runCounter += 1;
          runs.push(genRunSpec(rng, `run-${seed}-${runCounter}`));
        }
        const abandon = runs.map(() => chance(rng, 0.25));
        const holdRelease = runs.map(() => chance(rng, 0.25));
        actions.push({
          kind,
          runs,
          releaseOrder: permutation(rng, count),
          abandon,
          holdRelease,
        });
        break;
      }
      case 'drain':
        actions.push({ kind });
        break;
      case 'ps_plan':
      case 'ps_resume_or_start':
        actions.push({
          kind,
          shot: pick(rng, SHOT_TYPES),
          preferred: genSessionRef(rng),
          clock: genClock(rng),
        });
        break;
      case 'ps_commit':
        actions.push({ kind, clock: chance(rng, 0.5) ? genClock(rng) : null });
        break;
      case 'ps_note':
        actions.push({
          kind,
          session: genSessionRef(rng),
          clock: genClock(rng),
        });
        break;
      case 'ps_current':
        actions.push({ kind, clock: genClock(rng) });
        break;
      case 'switch_owner':
        actions.push({
          kind,
          owner: weighted<OwnerTag>(rng, [
            ['A', 40],
            ['B', 25],
            ['guest', 20],
            ['signed_out', 15],
          ]),
        });
        break;
      case 'clock':
        actions.push({ kind, deltaMs: genClockDelta(rng) });
        break;
      case 'kv_corrupt':
        actions.push({
          kind,
          mode: pick(rng, [
            'garbage',
            'missing_session',
            'bad_timestamp',
            'future',
            'empty_string',
            'wrong_types',
          ]),
        });
        break;
      case 'db_fault':
        actions.push({ kind, needle: pick(rng, DB_FAULT_NEEDLES) });
        break;
      default:
        break;
    }
  }
  return actions;
}

// ─── Model ─────────────────────────────────────────────────────────────────

interface StoredSet {
  sessionId: string;
  shotType: ShotTypeSlug | null;
  startedAtIso: string;
  lastActivityAtIso: string;
}

/** Mirrors practiceSet.ts parseStoredPracticeSet (the documented contract:
 * a corrupt record reads as "no live set"). */
function parseStored(raw: string | undefined): StoredSet | null {
  if (raw === undefined || raw === '') return null;
  try {
    const record = JSON.parse(raw) as Record<string, unknown> | null;
    if (typeof record !== 'object' || record === null) return null;
    const sessionId = record['sessionId'];
    const startedAtIso = record['startedAtIso'];
    const lastActivityAtIso = record['lastActivityAtIso'];
    const shotType = record['shotType'];
    if (typeof sessionId !== 'string' || sessionId.length === 0) return null;
    if (typeof startedAtIso !== 'string') return null;
    if (typeof lastActivityAtIso !== 'string') return null;
    if (shotType !== null && typeof shotType !== 'string') return null;
    return {
      sessionId,
      shotType: shotType as ShotTypeSlug | null,
      startedAtIso,
      lastActivityAtIso,
    };
  } catch {
    return null;
  }
}

function isLive(stored: StoredSet, nowMs: number): boolean {
  const last = Date.parse(stored.lastActivityAtIso);
  if (!Number.isFinite(last)) return false;
  const idle = nowMs - last;
  return idle >= 0 && idle <= PRACTICE_SET_IDLE_TIMEOUT_MS;
}

function serializeStored(stored: StoredSet): string {
  return JSON.stringify({
    sessionId: stored.sessionId,
    shotType: stored.shotType,
    startedAtIso: stored.startedAtIso,
    lastActivityAtIso: stored.lastActivityAtIso,
  });
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

interface ExecutedStatement {
  sql: string;
  params: unknown[];
  threw: string | null;
}

interface HeldRun {
  spec: RunSpec;
  promise: Promise<Settled>;
  gates: Deferred<void>[];
}

type Settled =
  | { status: 'resolved'; outcome: CaptureAnalysisOutcome }
  | { status: 'rejected'; message: string };

export interface StepTrace {
  i: number;
  action: string;
  result: string;
}

export interface Violation {
  step: number;
  action: string;
  invariant: string;
  detail: string;
}

export interface SequenceResult {
  seed: number;
  length: number;
  outcome: 'ok' | 'violation' | 'harness_error';
  violations: Violation[];
  trace: StepTrace[];
  stats: {
    runsStarted: number;
    runsSettled: number;
    scored: number;
    lowConfidence: number;
    qualityBlocked: number;
    unavailable: number;
    rejected: number;
    reserves: number;
    releases: number;
    practiceSetCalls: number;
    kvCorruptions: number;
    dbFaultsArmed: number;
    dbFaultsHit: number;
    racesRun: number;
    abandoned: number;
  };
  error?: string;
}

const BASE_CLOCK_MS = Date.parse('2026-09-05T12:00:00.000Z');
const API_BASE = 'https://api.stress.test';

class World {
  readonly rng: Rng;
  readonly uuidRng: Rng;
  readonly fake: FakeLocalDb;
  readonly db: LocalDb;
  readonly server: StressPermitServer;
  readonly statementsThisStep: ExecutedStatement[] = [];
  readonly violations: Violation[] = [];
  readonly trace: StepTrace[] = [];
  readonly held: HeldRun[] = [];
  readonly knownSessionIds: string[] = [];
  readonly armedFaults: string[] = [];
  /** Every statement that threw, across the whole sequence. */
  readonly faultedStatements: ExecutedStatement[] = [];
  readonly kvModel = new Map<string, string>();
  /** Session rows + session.create outbox rows the model expects, in order. */
  readonly expectedSessions: Array<{ owner: string; id: string }> = [];
  lastPlan: PracticeSetPlan | null = null;
  owner: OwnerTag = 'A';
  nowMs = BASE_CLOCK_MS;
  stepIndex = 0;
  stats: SequenceResult['stats'] = {
    runsStarted: 0,
    runsSettled: 0,
    scored: 0,
    lowConfidence: 0,
    qualityBlocked: 0,
    unavailable: 0,
    rejected: 0,
    reserves: 0,
    releases: 0,
    practiceSetCalls: 0,
    kvCorruptions: 0,
    dbFaultsArmed: 0,
    dbFaultsHit: 0,
    racesRun: 0,
    abandoned: 0,
  };
  private uuidCounter = 0;
  private readonly originalFetch = globalThis.fetch;

  constructor(readonly seed: number) {
    this.rng = mulberry32(seed ^ 0x9e3779b9);
    this.uuidRng = mulberry32(seed ^ 0x7f4a7c15);
    this.fake = createFakeLocalDb();
    this.server = createStressPermitServer();
    const inner = this.fake.db;
    this.db = {
      execute: async (sql, params = []) => {
        const entry: ExecutedStatement = { sql, params, threw: null };
        this.statementsThisStep.push(entry);
        try {
          return await inner.execute(sql, params);
        } catch (error) {
          entry.threw = error instanceof Error ? error.message : String(error);
          this.faultedStatements.push(entry);
          if (entry.threw.startsWith('stress-fault:')) {
            const needle = entry.threw.slice('stress-fault:'.length);
            const index = this.armedFaults.indexOf(needle);
            if (index >= 0) this.armedFaults.splice(index, 1);
            this.stats.dbFaultsHit += 1;
          }
          throw error;
        }
      },
      close() {},
    };
    seams.makeUuid = () => {
      this.uuidCounter += 1;
      return seededUuid(this.uuidRng);
    };
    seams.analyzeCapture = null;
    setActiveDataOwner(OWNERS.A);
    stabilitySlo.reset();
    // The permit client reaches the server through the global fetch.
    globalThis.fetch = this.server.fetch as unknown as typeof fetch;
  }

  dispose(): void {
    globalThis.fetch = this.originalFetch;
    seams.analyzeCapture = null;
    setActiveDataOwner(OWNERS.A);
  }

  nowIso(ref: ClockRef): string {
    return ref === 'invalid'
      ? 'not-a-timestamp'
      : new Date(this.nowMs).toISOString();
  }

  activeOwnerKey(): string {
    return OWNERS[this.owner];
  }

  storedFor(ownerKey: string): StoredSet | null {
    return parseStored(this.kvModel.get(practiceSetKeyForOwner(ownerKey)));
  }

  resolveSession(ref: SessionRef): string | null {
    switch (ref) {
      case 'none':
        return null;
      case 'empty':
        return '';
      case 'current': {
        const stored = this.storedFor(this.activeOwnerKey());
        return stored && isLive(stored, this.nowMs) ? stored.sessionId : null;
      }
      case 'known':
        return this.knownSessionIds.length > 0
          ? pick(this.rng, this.knownSessionIds)
          : null;
      case 'foreign':
        return `foreign-${seededUuid(this.rng)}`;
      default:
        return null;
    }
  }

  /** Orphan outbox rows already reported, so G5 fires once per new row. */
  reportedOrphanRows = 0;

  fail(invariant: string, detail: string, action: string): void {
    this.violations.push({
      step: this.stepIndex,
      action,
      invariant,
      detail,
    });
  }
}

async function flush(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  }
}

function describeAction(action: Action): string {
  switch (action.kind) {
    case 'analyze':
      return `analyze ${describeRun(action.run)}`;
    case 'analyze_race':
      return `race[${action.runs.map(describeRun).join(' | ')}] order=${action.releaseOrder.join(',')} abandon=${action.abandon.map(Number).join('')} holdRelease=${action.holdRelease.map(Number).join('')}`;
    case 'drain':
      return 'drain';
    case 'ps_plan':
      return `ps_plan shot=${action.shot} preferred=${action.preferred} clock=${action.clock}`;
    case 'ps_commit':
      return `ps_commit clock=${action.clock}`;
    case 'ps_resume_or_start':
      return `ps_resume_or_start shot=${action.shot} preferred=${action.preferred} clock=${action.clock}`;
    case 'ps_note':
      return `ps_note session=${action.session} clock=${action.clock}`;
    case 'ps_current':
      return `ps_current clock=${action.clock}`;
    case 'switch_owner':
      return `switch_owner ${action.owner}`;
    case 'clock':
      return `clock ${action.deltaMs >= 0 ? '+' : ''}${action.deltaMs}ms`;
    case 'kv_corrupt':
      return `kv_corrupt ${action.mode}`;
    case 'db_fault':
      return `db_fault ${action.needle}`;
    default:
      return 'unknown';
  }
}

function describeRun(run: RunSpec): string {
  return `${run.clipKind}/env=${run.envelope}/decl=${run.declared}/res=${run.reserve}/rel=${run.release}/prov=${run.provider}/tel=${run.telemetry}/tok=${run.token}/sess=${run.session}/hand=${run.handedness}`;
}

function describeSettled(settled: Settled): string {
  if (settled.status === 'rejected') return `REJECTED(${settled.message})`;
  const o = settled.outcome;
  switch (o.kind) {
    case 'scored':
      return `scored free=${o.freeLimitReached} score=${o.record.result?.resultKind === 'scored' ? o.record.result.overallScore : 'n/a'}`;
    case 'low_confidence':
      return `low_confidence result=${o.record.result ? o.record.result.resultKind : 'null'}`;
    case 'quality_blocked':
      return `quality_blocked pose=${o.poseQuality ? o.poseQuality.reasons.join('+') : 'envelope'}`;
    case 'unavailable':
      return `unavailable cause=${o.cause ?? 'none'} reason=${o.reason.slice(0, 60)}`;
    default:
      return 'unknown';
  }
}

// ─── Runs ──────────────────────────────────────────────────────────────────

function gatedBeforeReserve(run: RunSpec): boolean {
  return (
    run.envelope === 'UNSUPPORTED' ||
    PRE_RESERVE_GATE_KINDS.has(run.clipKind) ||
    run.token !== 'ok'
  );
}

function reserveSucceeds(mode: ReserveMode): boolean {
  return (
    mode === 'ok' ||
    mode === 'ok_last_free' ||
    mode === 'ok_premium' ||
    mode === 'ok_malformed_access'
  );
}

interface StartedRun {
  spec: RunSpec;
  sessionId: string | null;
  promise: Promise<Settled>;
}

function startRun(world: World, spec: RunSpec): StartedRun {
  const fixture = makeClipFixture(world.rng, spec.clipKind, spec.id);
  const sessionId = world.resolveSession(spec.session);
  const sidecar = fixture.sidecarJson;
  const previousRead = seams.readArtifact;
  const readers = new Map<string, string | null>();
  readers.set(fixture.clip.poseSequence?.uri ?? spec.id, sidecar);
  seams.readArtifact = async uri => {
    const hit = readers.get(uri);
    if (hit === undefined) return previousRead(uri);
    if (hit === null) throw new Error('ENOENT: sidecar unreadable');
    return hit;
  };
  const token =
    spec.token === 'ok'
      ? 'bearer-stress'
      : spec.token === 'blank'
        ? '   '
        : null;
  const telemetry =
    spec.telemetry === 'none'
      ? null
      : {
          consentActive: spec.telemetry === 'consent',
          consentVersion: 'stress-consent-1',
          dims: {
            userPseudonym: null,
            sessionId,
            courtId: null,
            deviceModel: null,
            devicePlatform: 'ios' as const,
            osVersion: null,
          },
        };
  world.stats.runsStarted += 1;
  const promise: Promise<Settled> = runCaptureAnalysis({
    db: world.db,
    captureId: `capture-${spec.id}`,
    clip: fixture.clip,
    declaredStroke: spec.declared,
    declaredCanonical:
      spec.canonical && spec.declared ? spec.declared.toUpperCase() : null,
    handedness: spec.handedness,
    cameraView: 'side',
    apiConfig: { baseUrl: API_BASE, token },
    appVersion: '1.0.0-stress',
    sessionId,
    captureEnvelope:
      spec.envelope === 'none' ? null : makeEnvelope(spec.envelope),
    evaluationTelemetry: telemetry,
  }).then(
    outcome => ({ status: 'resolved', outcome }) as Settled,
    error =>
      ({
        status: 'rejected',
        message: error instanceof Error ? error.message : String(error),
      }) as Settled,
  );
  return { spec, sessionId, promise };
}

function installProvider(spec: RunSpec): void {
  if (spec.provider === 'real') {
    seams.analyzeCapture = null;
  } else if (spec.provider === 'throw_sync') {
    seams.analyzeCapture = () => {
      throw new TypeError(`stress provider throw (${spec.id})`);
    };
  } else {
    seams.analyzeCapture = () =>
      Promise.reject(new Error(`stress provider reject (${spec.id})`)) as never;
  }
}

const SIGNED_OUT_WRITE_MESSAGE =
  'Sign in or continue locally before saving product data.';

/**
 * Which harness-injected fault explains a rejected run, or null when the
 * throw has no scripted cause (a real finding). A db fault only explains a
 * throw when it hit a statement on the analysis path — telemetry is best
 * effort, so a fault on the trial insert must never surface.
 */
function explainedThrow(world: World, message: string): string | null {
  if (message.startsWith('stress-fault:')) {
    const hit = world.faultedStatements.find(
      s => s.threw === message && !s.sql.includes("'evaluation.trial'"),
    );
    return hit ? 'db_fault' : null;
  }
  if (message.includes('stress provider')) return 'provider';
  if (message === SIGNED_OUT_WRITE_MESSAGE) return 'signed_out';
  return null;
}

function tallySettled(world: World, settled: Settled): void {
  world.stats.runsSettled += 1;
  if (settled.status === 'rejected') {
    world.stats.rejected += 1;
    return;
  }
  switch (settled.outcome.kind) {
    case 'scored':
      world.stats.scored += 1;
      break;
    case 'low_confidence':
      world.stats.lowConfidence += 1;
      break;
    case 'quality_blocked':
      world.stats.qualityBlocked += 1;
      break;
    case 'unavailable':
      world.stats.unavailable += 1;
      break;
    default:
      break;
  }
}

function shotSyncRows(
  world: World,
): Array<{ permitId: string | null; id: string | null; owner: string }> {
  return world.fake.outbox
    .filter(row => row.kind === 'shot.sync')
    .map(row => {
      try {
        const payload = JSON.parse(row.payload) as {
          analysisPermitId?: string;
          id?: string;
        };
        return {
          permitId: payload.analysisPermitId ?? null,
          id: payload.id ?? null,
          owner: row.owner_key,
        };
      } catch {
        return { permitId: null, id: null, owner: row.owner_key };
      }
    });
}

/** Precise checks for ONE run that ran alone in its step. */
function checkSingleRun(
  world: World,
  started: StartedRun,
  settled: Settled,
  reservesBefore: number,
  releasesBefore: number,
  shotRowsBefore: number,
  recordsBefore: number,
  label: string,
): void {
  const { spec } = started;
  const reserves = world.server.reserves.slice(reservesBefore);
  const releases = world.server.releases.slice(releasesBefore);
  const statements = world.statementsThisStep;
  const nonTelemetry = statements.filter(
    s => !s.sql.includes("'evaluation.trial'"),
  );
  const telemetryRows = statements.filter(
    s => s.sql.includes("'evaluation.trial'") && s.threw === null,
  );
  const threw = statements.filter(s => s.threw !== null);
  const rowsNow = shotSyncRows(world);
  const newShotRows = rowsNow.slice(shotRowsBefore);
  const newRecords = world.fake.analysisRecords.length - recordsBefore;

  // R1 — input gates never reserve nor write.
  if (gatedBeforeReserve(spec)) {
    if (reserves.length !== 0) {
      world.fail(
        'R1.gate_no_reserve',
        `reserved ${reserves.length}x for gated input`,
        label,
      );
    }
    if (releases.length !== 0) {
      world.fail(
        'R1.gate_no_release',
        `released ${releases.length}x for gated input`,
        label,
      );
    }
    if (nonTelemetry.length !== 0) {
      world.fail(
        'R1.gate_no_write',
        `${nonTelemetry.length} statements for gated input: ${nonTelemetry.map(s => s.sql.slice(0, 40)).join(' ; ')}`,
        label,
      );
    }
    if (settled.status === 'rejected') {
      world.fail(
        'R1.gate_no_throw',
        `gated input threw: ${settled.message}`,
        label,
      );
    } else {
      const expectedKind =
        spec.envelope === 'UNSUPPORTED' ? 'quality_blocked' : 'unavailable';
      if (settled.outcome.kind !== expectedKind) {
        world.fail(
          'R1.gate_kind',
          `expected ${expectedKind}, got ${settled.outcome.kind}`,
          label,
        );
      }
    }
  } else {
    // R2 — exactly one reserve attempt per run that passes the gates.
    if (reserves.length !== 1) {
      world.fail(
        'R2.one_reserve',
        `expected 1 reserve, saw ${reserves.length}`,
        label,
      );
      return;
    }
    const reserve = reserves[0]!;
    if (!reserveSucceeds(spec.reserve)) {
      // R3 — reserve failure: unavailable, no release, no write.
      if (settled.status === 'rejected') {
        world.fail(
          'R3.reserve_fail_no_throw',
          `reserve failure threw: ${settled.message}`,
          label,
        );
      } else if (settled.outcome.kind !== 'unavailable') {
        world.fail(
          'R3.reserve_fail_kind',
          `expected unavailable, got ${settled.outcome.kind}`,
          label,
        );
      } else if (
        (settled.outcome.cause === 'paywall_required') !==
        (spec.reserve === 'paywall_402')
      ) {
        world.fail(
          'R3.paywall_cause',
          `cause=${settled.outcome.cause ?? 'none'} for reserve mode ${spec.reserve}`,
          label,
        );
      }
      if (releases.length !== 0) {
        world.fail(
          'R3.reserve_fail_no_release',
          `released ${releases.length}x after failed reserve`,
          label,
        );
      }
      if (nonTelemetry.length !== 0) {
        world.fail(
          'R3.reserve_fail_no_write',
          `${nonTelemetry.length} statements after failed reserve`,
          label,
        );
      }
    } else {
      const permitId = reserve.permitId;
      if (permitId === null) {
        world.fail(
          'R4.permit_issued',
          'ok reserve recorded without permit id',
          label,
        );
        return;
      }
      const mine = releases.filter(r => r.permitId === permitId);
      const foreign = releases.filter(r => r.permitId !== permitId);
      if (foreign.length !== 0) {
        world.fail(
          'R4.release_other_permit',
          `released foreign permits ${foreign.map(r => r.permitId).join(',')}`,
          label,
        );
      }
      const consumedRows = newShotRows.filter(r => r.permitId === permitId);
      if (settled.status === 'rejected') {
        // R5 — a throw settles the permit exactly once and leaves no rating.
        if (mine.length !== 1) {
          world.fail(
            'R5.throw_release_once',
            `rejected run released ${mine.length}x (${mine.map(r => r.outcome).join(',')})`,
            label,
          );
        } else if (
          mine[0]!.outcome !== 'failed' &&
          mine[0]!.outcome !== 'low_confidence'
        ) {
          world.fail(
            'R5.throw_release_outcome',
            `rejected run released with ${mine[0]!.outcome}`,
            label,
          );
        }
        if (consumedRows.length !== 0) {
          world.fail(
            'R5.throw_no_rating',
            `rejected run left ${consumedRows.length} shot.sync rows`,
            label,
          );
        }
        const legitimate = explainedThrow(world, settled.message) !== null;
        if (!legitimate) {
          world.fail(
            'R5.unexplained_throw',
            `run threw without provider fault / db fault / signed-out: ${settled.message}`,
            label,
          );
        }
        return;
      }
      const outcome = settled.outcome;
      // R6 — telemetry never changes the outcome (a trial fault must not throw).
      if (spec.telemetry === 'consent' && world.owner !== 'signed_out') {
        const trialThrew = threw.some(s =>
          s.sql.includes("'evaluation.trial'"),
        );
        if (!trialThrew && telemetryRows.length !== 1) {
          world.fail(
            'R6.telemetry_row',
            `consented run queued ${telemetryRows.length} trials`,
            label,
          );
        }
      } else if (telemetryRows.length !== 0 && spec.telemetry !== 'consent') {
        world.fail(
          'R6.telemetry_without_consent',
          `${telemetryRows.length} trial rows without consent`,
          label,
        );
      }
      switch (outcome.kind) {
        case 'scored':
          if (mine.length !== 0) {
            world.fail(
              'R7.scored_no_release',
              `scored run released ${mine.map(r => r.outcome).join(',')}`,
              label,
            );
          }
          if (consumedRows.length !== 1) {
            world.fail(
              'R7.scored_one_shot_row',
              `scored run left ${consumedRows.length} shot.sync rows for its permit`,
              label,
            );
          } else if (consumedRows[0]!.id !== outcome.analysisId) {
            world.fail(
              'R7.scored_row_id',
              `shot.sync row id ${consumedRows[0]!.id} != analysisId ${outcome.analysisId}`,
              label,
            );
          }
          if (outcome.freeLimitReached !== (spec.reserve === 'ok_last_free')) {
            world.fail(
              'R7.free_limit_reached',
              `freeLimitReached=${outcome.freeLimitReached} for reserve mode ${spec.reserve}`,
              label,
            );
          }
          if (
            (outcome.record.result?.sessionId ?? null) !== started.sessionId
          ) {
            world.fail(
              'R7.session_id',
              `result.sessionId=${String(outcome.record.result?.sessionId)} request=${String(started.sessionId)}`,
              label,
            );
          }
          if (newRecords !== 1) {
            world.fail(
              'R7.scored_record',
              `scored run wrote ${newRecords} analysis records`,
              label,
            );
          }
          if (spec.provider !== 'real') {
            world.fail(
              'R7.scored_despite_provider_fault',
              'provider was scripted to throw but run scored',
              label,
            );
          }
          break;
        case 'low_confidence':
          if (mine.length !== 1 || mine[0]!.outcome !== 'low_confidence') {
            world.fail(
              'R8.low_confidence_release',
              `released ${mine.map(r => r.outcome).join(',') || 'nothing'}`,
              label,
            );
          }
          if (consumedRows.length !== 0) {
            world.fail(
              'R8.low_confidence_no_rating',
              `${consumedRows.length} shot.sync rows for an abstention`,
              label,
            );
          }
          if (newRecords !== 1) {
            world.fail(
              'R8.low_confidence_record',
              `abstention wrote ${newRecords} analysis records`,
              label,
            );
          }
          if (spec.provider !== 'real') {
            world.fail(
              'R8.low_confidence_despite_provider_fault',
              'provider was scripted to throw but run abstained',
              label,
            );
          }
          break;
        case 'quality_blocked':
          if (mine.length !== 1 || mine[0]!.outcome !== 'unsupported') {
            world.fail(
              'R9.quality_blocked_release',
              `released ${mine.map(r => r.outcome).join(',') || 'nothing'}`,
              label,
            );
          }
          if (nonTelemetry.length !== 0) {
            world.fail(
              'R9.quality_blocked_no_write',
              `${nonTelemetry.length} statements`,
              label,
            );
          }
          if (!outcome.poseQuality) {
            world.fail(
              'R9.quality_blocked_pose',
              'post-reserve quality_blocked without poseQuality',
              label,
            );
          }
          break;
        case 'unavailable':
          if (mine.length !== 1 || mine[0]!.outcome !== 'failed') {
            world.fail(
              'R10.unavailable_release',
              `released ${mine.map(r => r.outcome).join(',') || 'nothing'}`,
              label,
            );
          }
          if (nonTelemetry.length !== 0) {
            world.fail(
              'R10.unavailable_no_write',
              `${nonTelemetry.length} statements`,
              label,
            );
          }
          break;
        default:
          break;
      }
      if (spec.provider !== 'real' && outcome.kind !== 'quality_blocked') {
        world.fail(
          'R11.provider_fault_must_throw',
          `provider ${spec.provider} but run resolved ${outcome.kind}`,
          label,
        );
      }
    }
  }
}

// ─── Global invariants ─────────────────────────────────────────────────────

function checkGlobal(world: World, label: string): void {
  const { server, fake } = world;
  const releasedCounts = new Map<string, number>();
  for (const release of server.releases) {
    releasedCounts.set(
      release.permitId,
      (releasedCounts.get(release.permitId) ?? 0) + 1,
    );
    if (!server.issued.has(release.permitId)) {
      world.fail(
        'G1.release_unissued',
        `released ${release.permitId} which was never issued`,
        label,
      );
    }
    if (
      !['low_confidence', 'unsupported', 'failed', 'cancelled'].includes(
        release.outcome,
      )
    ) {
      world.fail(
        'G1.release_outcome_vocab',
        `release outcome ${release.outcome}`,
        label,
      );
    }
  }
  for (const [permitId, count] of releasedCounts) {
    if (count > 1) {
      world.fail('G1.release_once', `${permitId} released ${count}x`, label);
    }
  }
  const rows = shotSyncRows(world);
  const seenRowPermits = new Set<string>();
  for (const row of rows) {
    if (row.permitId === null || !server.issued.has(row.permitId)) {
      world.fail(
        'G2.rating_without_permit',
        `shot.sync row ${row.id} permit=${String(row.permitId)}`,
        label,
      );
      continue;
    }
    if (releasedCounts.has(row.permitId)) {
      world.fail(
        'G2.rating_on_released_permit',
        `shot.sync row ${row.id} on released permit ${row.permitId}`,
        label,
      );
    }
    if (seenRowPermits.has(row.permitId)) {
      world.fail(
        'G2.permit_reused',
        `permit ${row.permitId} on two shot.sync rows`,
        label,
      );
    }
    seenRowPermits.add(row.permitId);
    if (row.owner === SIGNED_OUT_DATA_OWNER) {
      world.fail(
        'G5.signed_out_write',
        `shot.sync row under signed-out owner`,
        label,
      );
    }
  }
  if (fake.openTransactions() !== 0) {
    world.fail('G3.open_transaction', `${fake.openTransactions()} open`, label);
  }
  const events = stabilitySlo.events();
  const started = events.filter(e => e.kind === 'analysis_started').length;
  const completed = events.filter(e => e.kind === 'analysis_completed').length;
  const failed = events.filter(e => e.kind === 'analysis_failed').length;
  if (started !== world.stats.runsStarted) {
    world.fail(
      'G4.slo_started',
      `analysis_started=${started} runsStarted=${world.stats.runsStarted}`,
      label,
    );
  }
  if (completed + failed !== world.stats.runsSettled) {
    world.fail(
      'G4.slo_settled',
      `completed=${completed} failed=${failed} settled=${world.stats.runsSettled}`,
      label,
    );
  }
  for (const statement of world.statementsThisStep) {
    const writes = /^\s*(INSERT|UPDATE|DELETE)/i.test(statement.sql);
    if (writes && statement.params.includes(SIGNED_OUT_DATA_OWNER)) {
      const persisted =
        statement.threw === null ? 'persisted' : `threw=${statement.threw}`;
      world.fail(
        'G5.signed_out_write',
        `${statement.sql.slice(0, 50)} ${persisted} params=${JSON.stringify(statement.params).slice(0, 80)}`,
        label,
      );
    }
  }
  const orphanRows = fake.outbox.filter(
    r => r.owner_key === SIGNED_OUT_DATA_OWNER,
  );
  if (orphanRows.length !== world.reportedOrphanRows) {
    world.reportedOrphanRows = orphanRows.length;
    world.fail(
      'G5.signed_out_outbox_row',
      `${orphanRows.length} outbox row(s) under owner 'signed-out': ${orphanRows.map(r => `#${r.id}:${r.kind}`).join(',')}`,
      label,
    );
  }
  if (server.unexpectedUrls.length !== 0) {
    world.fail('G6.unexpected_route', server.unexpectedUrls.join(','), label);
    server.unexpectedUrls.length = 0;
  }
  // G7 — practice-set durable state equals the model exactly.
  for (const tag of ['A', 'B', 'guest'] as OwnerTag[]) {
    const key = practiceSetKeyForOwner(OWNERS[tag]);
    const actual = fake.kv.get(key);
    const expected = world.kvModel.get(key);
    if (actual !== expected) {
      world.fail(
        'G7.kv_model',
        `owner ${tag}: actual=${String(actual)} expected=${String(expected)}`,
        label,
      );
    }
  }
  const signedOutKey = practiceSetKeyForOwner(SIGNED_OUT_DATA_OWNER);
  if (fake.kv.has(signedOutKey)) {
    world.fail('G5.signed_out_kv', `kv has ${signedOutKey}`, label);
  }
  const sessionRows = fake.sessions.map(s => `${s.owner}:${s.id}:${s.mode}`);
  const expectedRows = world.expectedSessions.map(
    s => `${s.owner}:${s.id}:practice_set`,
  );
  if (sessionRows.join('|') !== expectedRows.join('|')) {
    world.fail(
      'G7.session_rows',
      `actual=${sessionRows.join('|')} expected=${expectedRows.join('|')}`,
      label,
    );
  }
  const sessionCreates = fake.outbox
    .filter(r => r.kind === 'session.create')
    .map(r => {
      try {
        return `${r.owner_key}:${(JSON.parse(r.payload) as { id: string }).id}`;
      } catch {
        return `${r.owner_key}:?`;
      }
    });
  const expectedCreates = world.expectedSessions.map(s => `${s.owner}:${s.id}`);
  if (sessionCreates.join('|') !== expectedCreates.join('|')) {
    world.fail(
      'G7.session_outbox',
      `actual=${sessionCreates.join('|')} expected=${expectedCreates.join('|')}`,
      label,
    );
  }
}

// ─── Practice-set steps ────────────────────────────────────────────────────

interface PlanExpectation {
  sessionId: string | 'NEW';
  resumed: boolean;
  shotType: ShotTypeSlug | null;
  startedAtIso: string;
  nowIso: string;
  owner: string;
}

function predictPlan(
  world: World,
  shot: ShotTypeSlug | null,
  preferred: string | null,
  nowIso: string,
): PlanExpectation | null {
  if (world.owner === 'signed_out') return null;
  const owner = world.activeOwnerKey();
  const stored = world.storedFor(owner);
  if (preferred !== null && preferred.length > 0) {
    const continuing = stored?.sessionId === preferred ? stored : null;
    return {
      sessionId: preferred,
      resumed: true,
      shotType: continuing?.shotType ?? shot,
      startedAtIso: continuing?.startedAtIso ?? nowIso,
      nowIso,
      owner,
    };
  }
  if (stored && isLive(stored, Date.parse(nowIso))) {
    return {
      sessionId: stored.sessionId,
      resumed: true,
      shotType: stored.shotType,
      startedAtIso: stored.startedAtIso,
      nowIso,
      owner,
    };
  }
  return {
    sessionId: 'NEW',
    resumed: false,
    shotType: shot,
    startedAtIso: nowIso,
    nowIso,
    owner,
  };
}

function comparePlan(
  world: World,
  actual: PracticeSetPlan | null,
  expected: PlanExpectation | null,
  label: string,
): void {
  if (expected === null || actual === null) {
    if (expected !== actual) {
      world.fail(
        'P1.plan_null',
        `actual=${actual ? 'plan' : 'null'} expected=${expected ? 'plan' : 'null'}`,
        label,
      );
    }
    return;
  }
  if (expected.sessionId === 'NEW') {
    if (!UUID_RE.test(actual.sessionId)) {
      world.fail(
        'P1.plan_new_uuid',
        `new set id ${actual.sessionId} is not a v4 uuid`,
        label,
      );
    }
    if (world.knownSessionIds.includes(actual.sessionId)) {
      world.fail(
        'P1.plan_new_unique',
        `new set reused id ${actual.sessionId}`,
        label,
      );
    }
  } else if (actual.sessionId !== expected.sessionId) {
    world.fail(
      'P1.plan_session',
      `actual=${actual.sessionId} expected=${expected.sessionId}`,
      label,
    );
  }
  if (actual.resumed !== expected.resumed) {
    world.fail(
      'P1.plan_resumed',
      `actual=${actual.resumed} expected=${expected.resumed}`,
      label,
    );
  }
  if (actual.shotType !== expected.shotType) {
    world.fail(
      'P1.plan_shot',
      `actual=${actual.shotType} expected=${expected.shotType}`,
      label,
    );
  }
  if (actual.startedAtIso !== expected.startedAtIso) {
    world.fail(
      'P1.plan_started',
      `actual=${actual.startedAtIso} expected=${expected.startedAtIso}`,
      label,
    );
  }
  if (actual.nowIso !== expected.nowIso) {
    world.fail(
      'P1.plan_now',
      `actual=${actual.nowIso} expected=${expected.nowIso}`,
      label,
    );
  }
  if (actual.owner !== expected.owner) {
    world.fail(
      'P1.plan_owner',
      `actual=${actual.owner} expected=${expected.owner}`,
      label,
    );
  }
}

function noteKnownSession(world: World, id: string): void {
  if (!world.knownSessionIds.includes(id)) world.knownSessionIds.push(id);
}

/** Applies the model's view of `commitPracticeSet(plan, nowIso)` given what
 * the db actually did (which statement, if any, threw). */
function modelCommit(
  world: World,
  plan: PracticeSetPlan,
  nowIso: string | undefined,
  threwMessage: string | null,
  statements: ExecutedStatement[],
  label: string,
): void {
  const now = nowIso ?? plan.nowIso;
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) {
    if (threwMessage === null) {
      world.fail(
        'P2.commit_invalid_clock',
        'invalid nowIso did not throw',
        label,
      );
    }
    if (statements.length !== 0) {
      world.fail(
        'P2.commit_invalid_clock_write',
        `${statements.length} statements`,
        label,
      );
    }
    return;
  }
  const thrownStatement = statements.find(s => s.threw !== null) ?? null;
  if (!plan.resumed) {
    if (world.owner === 'signed_out') {
      if (threwMessage === null) {
        world.fail(
          'P2.commit_signed_out_throws',
          'new set committed while signed out did not throw',
          label,
        );
      }
      if (statements.length !== 0) {
        world.fail(
          'P2.commit_signed_out_no_write',
          `${statements.length} statements while signed out`,
          label,
        );
      }
      return;
    }
    const inTransaction =
      thrownStatement !== null &&
      (thrownStatement.sql === 'BEGIN IMMEDIATE' ||
        thrownStatement.sql === 'COMMIT' ||
        thrownStatement.sql.includes('local_session') ||
        thrownStatement.sql.includes("'session.create'"));
    if (inTransaction) {
      if (threwMessage === null) {
        world.fail(
          'P2.commit_fault_throws',
          `db fault in transaction did not surface: ${thrownStatement!.sql.slice(0, 40)}`,
          label,
        );
      }
      return;
    }
    world.expectedSessions.push({
      owner: world.activeOwnerKey(),
      id: plan.sessionId,
    });
  }
  if (
    thrownStatement !== null &&
    thrownStatement.sql.includes('INSERT OR REPLACE INTO kv')
  ) {
    if (threwMessage === null) {
      world.fail(
        'P2.commit_kv_fault_throws',
        'kv write fault did not surface',
        label,
      );
    }
    return;
  }
  if (threwMessage !== null) {
    world.fail(
      'P2.commit_unexplained_throw',
      `commit threw without a db fault: ${threwMessage}`,
      label,
    );
    return;
  }
  world.kvModel.set(
    practiceSetKeyForOwner(plan.owner),
    serializeStored({
      sessionId: plan.sessionId,
      shotType: plan.shotType,
      startedAtIso: plan.startedAtIso,
      lastActivityAtIso: now,
    }),
  );
  noteKnownSession(world, plan.sessionId);
}

async function stepPlan(
  world: World,
  action: Extract<Action, { kind: 'ps_plan' }>,
  label: string,
): Promise<string> {
  world.stats.practiceSetCalls += 1;
  const preferred = world.resolveSession(action.preferred);
  const nowIso = world.nowIso(action.clock);
  let actual: PracticeSetPlan | null = null;
  let threw: string | null = null;
  try {
    actual = await planPracticeSet(world.db, {
      shotType: action.shot,
      nowIso,
      preferredSessionId: preferred,
    });
  } catch (error) {
    threw = error instanceof Error ? error.message : String(error);
  }
  const writes = world.statementsThisStep.filter(
    s => !/^\s*SELECT/i.test(s.sql),
  );
  if (writes.length !== 0) {
    world.fail(
      'P1.plan_read_only',
      `plan issued ${writes.length} non-SELECT statements`,
      label,
    );
  }
  if (action.clock === 'invalid') {
    if (world.owner !== 'signed_out' && threw === null) {
      world.fail(
        'P1.plan_invalid_clock',
        'invalid nowIso did not throw',
        label,
      );
    }
    if (world.owner === 'signed_out' && (threw !== null || actual !== null)) {
      world.fail(
        'P1.plan_signed_out_first',
        `signed-out plan with invalid clock: threw=${threw} plan=${actual ? 'plan' : 'null'}`,
        label,
      );
    }
    world.lastPlan = null;
    return threw ? `threw(${threw})` : `plan=${actual ? 'plan' : 'null'}`;
  }
  const readFault = world.statementsThisStep.find(s => s.threw !== null);
  if (readFault) {
    if (threw === null)
      world.fail(
        'P1.plan_read_fault_throws',
        'kv read fault did not surface',
        label,
      );
    world.lastPlan = null;
    return `threw(${threw})`;
  }
  if (threw !== null) {
    world.fail('P1.plan_throws', threw, label);
    world.lastPlan = null;
    return `threw(${threw})`;
  }
  comparePlan(
    world,
    actual,
    predictPlan(world, action.shot, preferred, nowIso),
    label,
  );
  world.lastPlan = actual;
  if (world.owner === 'signed_out' && world.statementsThisStep.length !== 0) {
    world.fail(
      'P1.plan_signed_out_no_read',
      `${world.statementsThisStep.length} statements while signed out`,
      label,
    );
  }
  return actual
    ? `plan ${actual.resumed ? 'resumed' : 'new'} ${actual.sessionId}`
    : 'plan=null';
}

async function stepCommit(
  world: World,
  action: Extract<Action, { kind: 'ps_commit' }>,
  label: string,
): Promise<string> {
  const plan = world.lastPlan;
  if (plan === null) return 'no plan to commit (skipped)';
  world.stats.practiceSetCalls += 1;
  const nowIso = action.clock === null ? undefined : world.nowIso(action.clock);
  let threw: string | null = null;
  try {
    await commitPracticeSet(world.db, plan, nowIso);
  } catch (error) {
    threw = error instanceof Error ? error.message : String(error);
  }
  modelCommit(world, plan, nowIso, threw, world.statementsThisStep, label);
  return threw ? `threw(${threw})` : `committed ${plan.sessionId}`;
}

async function stepResumeOrStart(
  world: World,
  action: Extract<Action, { kind: 'ps_resume_or_start' }>,
  label: string,
): Promise<string> {
  world.stats.practiceSetCalls += 1;
  const preferred = world.resolveSession(action.preferred);
  const nowIso = world.nowIso(action.clock);
  const expected = predictPlan(world, action.shot, preferred, nowIso);
  const knownBefore = [...world.knownSessionIds];
  let result: { sessionId: string | null; resumed: boolean } | null = null;
  let threw: string | null = null;
  const planStatements = world.statementsThisStep.length;
  try {
    result = await resumeOrStartPracticeSet(world.db, {
      shotType: action.shot,
      nowIso,
      preferredSessionId: preferred,
    });
  } catch (error) {
    threw = error instanceof Error ? error.message : String(error);
  }
  if (action.clock === 'invalid') {
    if (world.owner !== 'signed_out' && threw === null) {
      world.fail('P3.ros_invalid_clock', 'invalid nowIso did not throw', label);
    }
    if (
      world.statementsThisStep.filter(s => !/^\s*SELECT/i.test(s.sql))
        .length !== 0
    ) {
      world.fail(
        'P3.ros_invalid_clock_write',
        'wrote with an invalid clock',
        label,
      );
    }
    return threw ? `threw(${threw})` : `result=${JSON.stringify(result)}`;
  }
  if (expected === null) {
    if (
      threw !== null ||
      result === null ||
      result.sessionId !== null ||
      result.resumed
    ) {
      world.fail(
        'P3.ros_signed_out',
        `threw=${threw} result=${JSON.stringify(result)}`,
        label,
      );
    }
    if (world.statementsThisStep.length !== 0) {
      world.fail(
        'P3.ros_signed_out_no_statements',
        `${world.statementsThisStep.length} statements`,
        label,
      );
    }
    return 'null (signed out)';
  }
  // The plan the module committed is reconstructed from the model's
  // expectation plus the id the call returned (a NEW set has a fresh uuid).
  const stepStatements = world.statementsThisStep.slice(planStatements);
  const writeStatements = stepStatements.filter(
    s => !/^\s*SELECT/i.test(s.sql),
  );
  const readFault = stepStatements.find(
    s => /^\s*SELECT/i.test(s.sql) && s.threw !== null,
  );
  if (readFault) {
    // The plan's kv read hit an armed fault: nothing durable may change.
    if (threw === null)
      world.fail(
        'P3.ros_read_fault_throws',
        'kv read fault did not surface',
        label,
      );
    if (writeStatements.length !== 0)
      world.fail(
        'P3.ros_read_fault_write',
        `${writeStatements.length} writes after a failed plan read`,
        label,
      );
    return `threw(${threw})`;
  }
  let sessionId: string;
  if (result !== null) {
    if (result.sessionId === null) {
      world.fail(
        'P3.ros_null_session',
        'signed-in caller got null sessionId',
        label,
      );
      return 'null';
    }
    sessionId = result.sessionId;
    if (expected.sessionId !== 'NEW' && sessionId !== expected.sessionId) {
      world.fail(
        'P3.ros_session',
        `actual=${sessionId} expected=${expected.sessionId}`,
        label,
      );
    }
    if (
      expected.sessionId === 'NEW' &&
      (!UUID_RE.test(sessionId) || knownBefore.includes(sessionId))
    ) {
      world.fail('P3.ros_new_uuid', `new set id ${sessionId}`, label);
    }
    if (result.resumed !== expected.resumed) {
      world.fail(
        'P3.ros_resumed',
        `actual=${result.resumed} expected=${expected.resumed}`,
        label,
      );
    }
  } else {
    // Threw during commit: recover the id from the statements that ran.
    const sessionInsert = writeStatements.find(s =>
      s.sql.includes('local_session'),
    );
    const kvInsert = writeStatements.find(s =>
      s.sql.includes('INSERT OR REPLACE INTO kv'),
    );
    if (expected.sessionId !== 'NEW') {
      sessionId = expected.sessionId;
    } else if (sessionInsert) {
      sessionId = String(sessionInsert.params[1]);
    } else if (kvInsert) {
      sessionId = (
        JSON.parse(String(kvInsert.params[1])) as { sessionId: string }
      ).sessionId;
    } else {
      // Nothing observable ran before the throw (e.g. BEGIN fault): the
      // model cannot know the fresh uuid, and nothing durable changed.
      const thrownStatement =
        writeStatements.find(s => s.threw !== null) ??
        world.statementsThisStep.find(s => s.threw !== null);
      if (!thrownStatement) {
        world.fail('P3.ros_unexplained_throw', threw ?? 'unknown', label);
      }
      return `threw(${threw})`;
    }
  }
  const plan: PracticeSetPlan = {
    sessionId,
    resumed: expected.resumed,
    shotType: expected.shotType,
    startedAtIso: expected.startedAtIso,
    nowIso: expected.nowIso,
    owner: expected.owner,
  };
  modelCommit(world, plan, undefined, threw, writeStatements, label);
  return threw
    ? `threw(${threw})`
    : `${plan.resumed ? 'resumed' : 'new'} ${sessionId}`;
}

async function stepNote(
  world: World,
  action: Extract<Action, { kind: 'ps_note' }>,
  label: string,
): Promise<string> {
  world.stats.practiceSetCalls += 1;
  const sessionId =
    world.resolveSession(action.session) ?? `foreign-${seededUuid(world.rng)}`;
  const nowIso = world.nowIso(action.clock);
  let threw: string | null = null;
  try {
    await notePracticeSetAnalysis(world.db, sessionId, nowIso);
  } catch (error) {
    threw = error instanceof Error ? error.message : String(error);
  }
  const statements = world.statementsThisStep;
  if (world.owner === 'signed_out' || sessionId.length === 0) {
    if (threw !== null || statements.length !== 0) {
      world.fail(
        'P4.note_noop',
        `threw=${threw} statements=${statements.length}`,
        label,
      );
    }
    return 'noop';
  }
  if (action.clock === 'invalid') {
    if (threw === null)
      world.fail(
        'P4.note_invalid_clock',
        'invalid nowIso did not throw',
        label,
      );
    if (statements.length !== 0)
      world.fail(
        'P4.note_invalid_clock_write',
        `${statements.length} statements`,
        label,
      );
    return `threw(${threw})`;
  }
  const thrown = statements.find(s => s.threw !== null) ?? null;
  if (thrown !== null) {
    if (threw === null)
      world.fail(
        'P4.note_fault_throws',
        `db fault did not surface: ${thrown.sql.slice(0, 40)}`,
        label,
      );
    // A SELECT fault aborts before the write; a kv write fault leaves the old record.
    return `threw(${threw})`;
  }
  if (threw !== null) {
    world.fail('P4.note_unexplained_throw', threw, label);
    return `threw(${threw})`;
  }
  const owner = world.activeOwnerKey();
  const stored = world.storedFor(owner);
  const continuing = stored?.sessionId === sessionId ? stored : null;
  world.kvModel.set(
    practiceSetKeyForOwner(owner),
    serializeStored({
      sessionId,
      shotType: continuing?.shotType ?? null,
      startedAtIso: continuing?.startedAtIso ?? nowIso,
      lastActivityAtIso: nowIso,
    }),
  );
  noteKnownSession(world, sessionId);
  return `noted ${sessionId}`;
}

async function stepCurrent(
  world: World,
  action: Extract<Action, { kind: 'ps_current' }>,
  label: string,
): Promise<string> {
  world.stats.practiceSetCalls += 1;
  const nowIso = world.nowIso(action.clock);
  let actual: string | null = null;
  let threw: string | null = null;
  try {
    actual = await currentPracticeSetId(world.db, nowIso);
  } catch (error) {
    threw = error instanceof Error ? error.message : String(error);
  }
  const writes = world.statementsThisStep.filter(
    s => !/^\s*SELECT/i.test(s.sql),
  );
  if (writes.length !== 0)
    world.fail('P5.current_read_only', `${writes.length} writes`, label);
  if (world.owner === 'signed_out') {
    if (
      threw !== null ||
      actual !== null ||
      world.statementsThisStep.length !== 0
    ) {
      world.fail(
        'P5.current_signed_out',
        `threw=${threw} actual=${actual} statements=${world.statementsThisStep.length}`,
        label,
      );
    }
    return 'null (signed out)';
  }
  if (action.clock === 'invalid') {
    if (threw === null)
      world.fail(
        'P5.current_invalid_clock',
        'invalid nowIso did not throw',
        label,
      );
    return `threw(${threw})`;
  }
  const thrown = world.statementsThisStep.find(s => s.threw !== null);
  if (thrown) {
    if (threw === null)
      world.fail('P5.current_fault_throws', 'db fault did not surface', label);
    return `threw(${threw})`;
  }
  if (threw !== null) {
    world.fail('P5.current_unexplained_throw', threw, label);
    return `threw(${threw})`;
  }
  const stored = world.storedFor(world.activeOwnerKey());
  const expected =
    stored && isLive(stored, Date.parse(nowIso)) ? stored.sessionId : null;
  if (actual !== expected) {
    world.fail(
      'P5.current_value',
      `actual=${actual} expected=${expected}`,
      label,
    );
  }
  return `current=${actual}`;
}

function stepKvCorrupt(world: World, mode: KvCorruptMode): string {
  world.stats.kvCorruptions += 1;
  const owner = world.owner === 'signed_out' ? 'A' : world.owner;
  const key = practiceSetKeyForOwner(OWNERS[owner]);
  const stored = world.storedFor(OWNERS[owner]);
  const sessionId = stored?.sessionId ?? seededUuid(world.rng);
  let raw: string;
  switch (mode) {
    case 'garbage':
      raw = pick(world.rng, ['{not json', '42', '"string"', '[1,2,3]']);
      break;
    case 'missing_session':
      raw = JSON.stringify({
        shotType: null,
        startedAtIso: world.nowIso('now'),
        lastActivityAtIso: world.nowIso('now'),
      });
      break;
    case 'bad_timestamp':
      raw = serializeStored({
        sessionId,
        shotType: 'dink',
        startedAtIso: world.nowIso('now'),
        lastActivityAtIso: 'yesterday-ish',
      });
      break;
    case 'future':
      raw = serializeStored({
        sessionId,
        shotType: stored?.shotType ?? null,
        startedAtIso: world.nowIso('now'),
        lastActivityAtIso: new Date(
          world.nowMs + int(world.rng, 1, 60 * 60_000),
        ).toISOString(),
      });
      break;
    case 'empty_string':
      raw = '';
      break;
    case 'wrong_types':
      raw = JSON.stringify({
        sessionId,
        shotType: 7,
        startedAtIso: 12,
        lastActivityAtIso: world.nowIso('now'),
      });
      break;
    default:
      raw = '';
  }
  world.fake.kv.set(key, raw);
  world.kvModel.set(key, raw);
  return `kv[${owner}] <- ${raw.slice(0, 60)}`;
}

// ─── Analysis steps ────────────────────────────────────────────────────────

async function stepAnalyze(
  world: World,
  action: Extract<Action, { kind: 'analyze' }>,
  label: string,
): Promise<string> {
  const { run } = action;
  installProvider(run);
  world.server.enqueue(
    defaultScript({ reserve: run.reserve, release: run.release }),
  );
  const reservesBefore = world.server.reserves.length;
  const releasesBefore = world.server.releases.length;
  const shotRowsBefore = shotSyncRows(world).length;
  const recordsBefore = world.fake.analysisRecords.length;
  const started = startRun(world, run);
  const settled = await started.promise;
  await flush(2);
  tallySettled(world, settled);
  // A gated run never consumed its script; drop it so it cannot leak into a
  // later step's reserve.
  const leftover = world.server.pendingScripts();
  if (leftover > 0) world.server.clearScripts();
  checkSingleRun(
    world,
    started,
    settled,
    reservesBefore,
    releasesBefore,
    shotRowsBefore,
    recordsBefore,
    label,
  );
  return describeSettled(settled);
}

async function stepRace(
  world: World,
  action: Extract<Action, { kind: 'analyze_race' }>,
  label: string,
): Promise<string> {
  world.stats.racesRun += 1;
  const reservers = action.runs.filter(run => !gatedBeforeReserve(run)).length;
  const gates: Deferred<void>[] = [];
  const releaseGates: Deferred<void>[] = [];
  // Scripts are consumed in reserve-call order; gate k belongs to the k-th
  // run to reach the server, whichever run that turns out to be.
  for (let k = 0; k < reservers; k += 1) {
    const script = defaultScript({
      reserve: action.runs[k]!.reserve,
      release: action.runs[k]!.release,
      holdReserve: deferred<void>(),
      holdRelease: action.holdRelease[k] ? deferred<void>() : null,
    });
    gates.push(script.holdReserve!);
    if (script.holdRelease) releaseGates.push(script.holdRelease);
    world.server.enqueue(script);
  }
  // All race runs share one provider seam: the provider mode of the first
  // run applies to all of them (the seam is process-global).
  installProvider(action.runs[0]!);
  const reservesBefore = world.server.reserves.length;
  const releasesBefore = world.server.releases.length;
  // Runs parked by an earlier race (abandoned reserve gates) still count as
  // in-flight at the server; only the delta belongs to this step.
  const inFlightBefore = world.server.inFlightReserves;
  world.server.maxInFlightReserves = inFlightBefore;
  const started = action.runs.map(run => startRun(world, run));
  await flush(8);
  const inFlightNow = world.server.inFlightReserves - inFlightBefore;
  if (inFlightNow !== reservers) {
    world.fail(
      'C1.race_reserve_count',
      `expected ${reservers} in-flight reserves, saw ${inFlightNow}`,
      label,
    );
  }
  if (world.server.maxInFlightReserves - inFlightBefore < reservers) {
    world.fail(
      'C1.race_overlap',
      `max in-flight ${world.server.maxInFlightReserves - inFlightBefore} < ${reservers}`,
      label,
    );
  }
  const order = action.releaseOrder.filter(k => k < gates.length);
  const results: string[] = [];
  const awaited = new Set<number>();
  for (const k of order) {
    if (action.abandon[k]) {
      world.stats.abandoned += 1;
      continue;
    }
    gates[k]!.resolve();
    await flush(4);
    awaited.add(k);
  }
  // Runs whose gate was released: settle now (unless parked on a release
  // gate, which the drain step lifts later).
  const parked: HeldRun[] = [];
  const settledNow: Settled[] = [];
  for (let r = 0; r < started.length; r += 1) {
    const s = started[r]!;
    const raced = await Promise.race([
      s.promise.then(v => ({ done: true as const, v })),
      flush(3).then(() => ({ done: false as const })),
    ]);
    if (raced.done) {
      tallySettled(world, raced.v);
      settledNow.push(raced.v);
      results.push(describeSettled(raced.v));
    } else {
      parked.push({ spec: s.spec, promise: s.promise, gates: [] });
      results.push('in-flight');
    }
  }
  // The gates still closed (abandoned reserves, held releases) travel with
  // the parked runs so `drain` can lift them.
  const pendingGates = [
    ...gates.filter((g, k) => !awaited.has(k) && !g.settled),
    ...releaseGates.filter(g => !g.settled),
  ];
  if (parked.length > 0) {
    parked[0]!.gates.push(...pendingGates);
    world.held.push(...parked);
  } else {
    for (const g of pendingGates) g.resolve();
  }
  const leftover = world.server.pendingScripts();
  if (leftover > 0) world.server.clearScripts();
  // C2 — concurrent reserves are all distinct permits.
  const reserves = world.server.reserves.slice(reservesBefore);
  const ids = reserves
    .map(r => r.permitId)
    .filter((id): id is string => id !== null);
  if (new Set(ids).size !== ids.length) {
    world.fail('C2.race_distinct_permits', ids.join(','), label);
  }
  const releases = world.server.releases.slice(releasesBefore);
  const releasedIds = releases.map(r => r.permitId);
  if (new Set(releasedIds).size !== releasedIds.length) {
    world.fail('C2.race_release_once', releasedIds.join(','), label);
  }
  for (const s of settledNow) {
    if (s.status === 'rejected' && explainedThrow(world, s.message) === null) {
      world.fail('C3.race_unexplained_throw', s.message, label);
    }
  }
  return `race -> ${results.join(' ; ')}`;
}

async function stepDrain(world: World, label: string): Promise<string> {
  if (world.held.length === 0) return 'nothing held';
  const releasesBefore = world.server.releases.length;
  const held = world.held.splice(0, world.held.length);
  for (const h of held) for (const g of h.gates) if (!g.settled) g.resolve();
  const results: string[] = [];
  for (const h of held) {
    const settled = await h.promise;
    tallySettled(world, settled);
    results.push(describeSettled(settled));
    if (
      settled.status === 'rejected' &&
      explainedThrow(world, settled.message) === null
    ) {
      world.fail('C3.drain_unexplained_throw', settled.message, label);
    }
  }
  await flush(2);
  const releases = world.server.releases.slice(releasesBefore);
  const releasedIds = releases.map(r => r.permitId);
  if (new Set(releasedIds).size !== releasedIds.length) {
    world.fail('C2.drain_release_once', releasedIds.join(','), label);
  }
  return `drained ${held.length}: ${results.join(' ; ')}`;
}

// ─── Sequence executor ─────────────────────────────────────────────────────

export interface ExecuteOptions {
  /** Stop at the first violating step (minimization wants the full run). */
  stopOnViolation?: boolean;
}

export async function executeSequence(
  seed: number,
  actions: Action[],
  options: ExecuteOptions = {},
): Promise<SequenceResult> {
  const world = new World(seed);
  const finish = (
    outcome: SequenceResult['outcome'],
    error?: string,
  ): SequenceResult => ({
    seed,
    length: actions.length,
    outcome,
    violations: world.violations,
    trace: world.trace,
    stats: {
      ...world.stats,
      reserves: world.server.reserves.length,
      releases: world.server.releases.length,
    },
    ...(error !== undefined ? { error } : {}),
  });
  try {
    for (let i = 0; i < actions.length; i += 1) {
      const action = actions[i]!;
      world.stepIndex = i;
      world.statementsThisStep.length = 0;
      const label = describeAction(action);
      let result: string;
      switch (action.kind) {
        case 'analyze':
          result = await stepAnalyze(world, action, label);
          break;
        case 'analyze_race':
          result = await stepRace(world, action, label);
          break;
        case 'drain':
          result = await stepDrain(world, label);
          break;
        case 'ps_plan':
          result = await stepPlan(world, action, label);
          break;
        case 'ps_commit':
          result = await stepCommit(world, action, label);
          break;
        case 'ps_resume_or_start':
          result = await stepResumeOrStart(world, action, label);
          break;
        case 'ps_note':
          result = await stepNote(world, action, label);
          break;
        case 'ps_current':
          result = await stepCurrent(world, action, label);
          break;
        case 'switch_owner':
          world.owner = action.owner;
          setActiveDataOwner(OWNERS[action.owner]);
          result = `owner=${action.owner}`;
          break;
        case 'clock':
          world.nowMs += action.deltaMs;
          result = `now=${new Date(world.nowMs).toISOString()}`;
          break;
        case 'kv_corrupt':
          result = stepKvCorrupt(world, action.mode);
          break;
        case 'db_fault': {
          world.stats.dbFaultsArmed += 1;
          world.armedFaults.push(action.needle);
          world.fake.failNext(
            action.needle,
            new Error(`stress-fault:${action.needle}`),
          );
          result = `armed ${action.needle}`;
          break;
        }
        default:
          result = 'noop';
      }
      checkGlobal(world, label);
      world.trace.push({ i, action: label, result });
      if (options.stopOnViolation && world.violations.length > 0) break;
    }
    // Sequence end: lift every gate so no run is left mid-flight, then
    // re-check the global invariants over the final durable state.
    world.stepIndex = actions.length;
    world.statementsThisStep.length = 0;
    const drained = await stepDrain(world, 'final drain');
    checkGlobal(world, 'final drain');
    world.trace.push({
      i: actions.length,
      action: 'final drain',
      result: drained,
    });
  } catch (error) {
    return finish(
      'harness_error',
      error instanceof Error
        ? `${error.message}\n${error.stack ?? ''}`
        : String(error),
    );
  } finally {
    world.dispose();
  }
  return finish(world.violations.length === 0 ? 'ok' : 'violation');
}

export async function runSeed(seed: number): Promise<SequenceResult> {
  return executeSequence(seed, generateSequence(seed));
}

/** Greedy one-at-a-time action removal that preserves the failure (a
 * violation or harness error). Deterministic: same input → same minimum. */
export async function minimizeActions(
  seed: number,
  actions: Action[],
  failsWith: (result: SequenceResult) => boolean,
  maxPasses = 3,
): Promise<Action[]> {
  let current = actions;
  for (let pass = 0; pass < maxPasses; pass += 1) {
    let removedAny = false;
    for (let i = current.length - 1; i >= 0; i -= 1) {
      if (current.length <= 1) break;
      const candidate = [...current.slice(0, i), ...current.slice(i + 1)];
      const result = await executeSequence(seed, candidate, {
        stopOnViolation: true,
      });
      if (failsWith(result)) {
        current = candidate;
        removedAny = true;
      }
    }
    // Shrink races to the single run that carries the failure.
    for (let i = 0; i < current.length; i += 1) {
      const action = current[i]!;
      if (action.kind !== 'analyze_race') continue;
      for (const run of action.runs) {
        const candidate = [...current];
        candidate[i] = { kind: 'analyze', run };
        const result = await executeSequence(seed, candidate, {
          stopOnViolation: true,
        });
        if (failsWith(result)) {
          current = candidate;
          removedAny = true;
          break;
        }
      }
    }
    if (!removedAny) break;
  }
  return current;
}

export { CLIP_KINDS };
