/**
 * STRESS / failure-injection — runCaptureAnalysis (unit mod-run-capture-analysis).
 *
 * Every dependency the module reaches is wrapped by an injectable fault
 * (throw / reject / timeout / malformed / partial / slow / never-resolves):
 *   camera artifact read (readCaptureArtifact), fetch (reserve + finalize),
 *   SQLite (LocalDb.execute, transaction-faithful fake), the Vision fusion
 *   providers (phase / biomechanics / scorer / faults / uncertainty / coach),
 *   the id generator (makeUuid → crypto), the clock (Date.now) and the
 *   evaluation-telemetry queue.
 *
 * Three campaigns, all seeded (mulberry32) and replayable:
 *   1. catalog — every fault in FAULT_CATALOG exactly once per fixture class;
 *   2. combo   — STRESS_ITER seeded random 1–3 fault combinations;
 *   3. race    — STRESS_RACE seeded concurrent runs sharing one permit server.
 * Run one seed with STRESS_SEED=<n>; write the seed→outcome table with
 * STRESS_REPORT=/abs/path.json. Defaults are small so the suite stays fast.
 *
 * Oracle (independent of the injected fault):
 *   - the run settles within 60s of fake time unless the fault is a
 *     never-resolving LOCAL dependency (file / SQLite / provider) — the module
 *     has no timeout of its own there and the screen's Close control is the
 *     recovery; that is recorded as `hang_no_timeout`, never as a pass;
 *   - a thrown error is an Error with a message (never a silent undefined);
 *   - every reserved permit is settled EXACTLY once: one finalize attempt OR
 *     one committed `shot.sync` outbox row carrying it — never both, never
 *     neither, and a finalize never carries a permit id that was not reserved;
 *   - `scored` ⇒ the rating transaction COMMITTED (local_shot scored row +
 *     shot.sync outbox row with the permit id) and the capture is analyzed;
 *   - `low_confidence` ⇒ finalize 'low_confidence', no shot.sync row, at most
 *     one local-only shot row, an analysis record row;
 *   - `quality_blocked` / `unavailable` / thrown ⇒ no committed local_shot or
 *     shot.sync row; no scored row without its outbox twin;
 *   - no transaction is left open; a telemetry fault never changes the outcome.
 */
import { generateSwingSequence } from '@pickle/evaluation';
import { serializePoseSequence, sha256Hex } from '@pickle/swing-domain';
import type { FusionProviders } from '@pickle/analysis-pipeline';
import { writeFileSync } from 'fs';
import type { LocalDb } from '../../src/data/db';
import {
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import type { CapturedClip } from '../../src/camera/capture';
import {
  runCaptureAnalysis,
  type CaptureAnalysisOutcome,
  type RunCaptureAnalysisRequest,
} from '../../src/analysis/runCaptureAnalysis';

jest.mock('../../src/camera/capture', () => {
  const actual = jest.requireActual('../../src/camera/capture');
  return {
    ...actual,
    readCaptureArtifact: (uri: string) => mockReadArtifact(uri),
  };
});

jest.mock('../../src/vision/providers', () => {
  const actual = jest.requireActual('../../src/vision/providers');
  return {
    ...actual,
    createFusionProviders: (...args: unknown[]) =>
      mockProviderHook(
        (
          actual.createFusionProviders as (
            ...a: unknown[]
          ) => ProviderAvailability
        )(...args),
      ),
  };
});

jest.mock('../../src/util/uuid', () => {
  const actual = jest.requireActual('../../src/util/uuid');
  return {
    ...actual,
    makeUuid: () => mockUuidHook(actual.makeUuid as () => string),
  };
});

type ProviderAvailability =
  | { kind: 'real'; providers: FusionProviders }
  | { kind: 'unavailable'; reason: string };

let mockReadArtifact: (uri: string) => Promise<string> = async () => {
  throw new Error('readCaptureArtifact hook not configured');
};
let mockProviderHook: (a: ProviderAvailability) => ProviderAvailability = a =>
  a;
let mockUuidHook: (real: () => string) => string = real => real();

const OWNER = '77777777-7777-4777-8777-777777777777';
const STRESS_ITER = Number(process.env['STRESS_ITER'] ?? 24);
const STRESS_RACE = Number(process.env['STRESS_RACE'] ?? 6);
const STRESS_SEED = process.env['STRESS_SEED']
  ? Number(process.env['STRESS_SEED'])
  : null;
const STRESS_REPORT = process.env['STRESS_REPORT'] ?? null;
const SETTLE_WINDOW_MS = 60_000;

// ─── Seeded RNG ─────────────────────────────────────────────────────────────

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rng: () => number, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length)]!;
}

// ─── Transaction-faithful fake SQLite ───────────────────────────────────────

type DbMode = 'throw' | 'reject' | 'slow' | 'never';

interface DbFault {
  /** Substring of the SQL statement the fault targets. */
  match: string;
  mode: DbMode;
  delayMs?: number;
  /** Fire only on the Nth matching statement (1-based); default every. */
  nth?: number;
}

interface CommittedRow {
  table: string;
  kind: string | null;
  params: unknown[];
}

class FakeSqlite {
  readonly committed: CommittedRow[] = [];
  readonly log: string[] = [];
  private staged: CommittedRow[] | null = null;
  txnOpenCount = 0;
  txnCommitCount = 0;
  txnRollbackCount = 0;
  faultHits = 0;
  private matchCounts = new Map<string, number>();
  constructor(private readonly faults: DbFault[]) {}

  get transactionOpen(): boolean {
    return this.staged !== null;
  }

  readonly db: LocalDb = {
    execute: (sql: string, params: unknown[] = []) => this.execute(sql, params),
    close() {},
  };

  private execute(
    sql: string,
    params: unknown[],
  ): Promise<{ rows: Record<string, unknown>[] }> {
    this.log.push(sql.replace(/\s+/g, ' ').trim().slice(0, 60));
    for (const fault of this.faults) {
      if (!sql.includes(fault.match)) continue;
      const seen = (this.matchCounts.get(fault.match) ?? 0) + 1;
      this.matchCounts.set(fault.match, seen);
      if (fault.nth !== undefined && fault.nth !== seen) continue;
      this.faultHits += 1;
      switch (fault.mode) {
        case 'throw':
          throw new Error(`SQLITE_IOERR injected on ${fault.match}`);
        case 'reject':
          return Promise.reject(
            new Error(`SQLITE_BUSY injected on ${fault.match}`),
          );
        case 'never':
          return new Promise(() => {});
        case 'slow':
          return new Promise(resolve =>
            setTimeout(
              () => resolve(this.apply(sql, params)),
              fault.delayMs ?? 1_000,
            ),
          );
      }
    }
    return Promise.resolve(this.apply(sql, params));
  }

  private apply(
    sql: string,
    params: unknown[],
  ): { rows: Record<string, unknown>[] } {
    const flat = sql.replace(/\s+/g, ' ').trim();
    if (flat.startsWith('BEGIN')) {
      this.staged = [];
      this.txnOpenCount += 1;
      return { rows: [] };
    }
    if (flat.startsWith('COMMIT')) {
      if (this.staged) this.committed.push(...this.staged);
      this.staged = null;
      this.txnCommitCount += 1;
      return { rows: [] };
    }
    if (flat.startsWith('ROLLBACK')) {
      this.staged = null;
      this.txnRollbackCount += 1;
      return { rows: [] };
    }
    const insert = /^INSERT(?: OR REPLACE)? INTO (\w+)/.exec(flat);
    const update = /^UPDATE (\w+)/.exec(flat);
    const table = insert?.[1] ?? update?.[1] ?? 'unknown';
    const kindLiteral = /VALUES \(\?, '([a-z.]+)'/.exec(flat);
    const row: CommittedRow = {
      table,
      kind: kindLiteral?.[1] ?? null,
      params,
    };
    (this.staged ?? this.committed).push(row);
    return { rows: [] };
  }
}

// ─── Fault-injectable permit server ─────────────────────────────────────────

type FetchMode =
  | 'ok'
  | 'reject_network'
  | 'throw_sync'
  | 'never_honors_abort'
  | 'slow'
  | 'http_402_paywall'
  | 'http_401'
  | 'http_409_not_reserved'
  | 'http_429'
  | 'http_500'
  | 'http_503'
  | 'body_unparseable'
  | 'body_null'
  | 'body_array'
  | 'body_missing_permit'
  | 'permit_empty_id'
  | 'permit_whitespace_id'
  | 'permit_numeric_id'
  | 'permit_bad_access_source'
  | 'permit_missing_expires'
  | 'permit_status_released'
  | 'permit_status_missing'
  | 'access_malformed'
  | 'access_partial';

interface ServerState {
  reserveMode: FetchMode;
  finalizeMode: FetchMode;
  slowMs: number;
  permitIdSeq: number;
  reservedIds: string[];
  finalizeCalls: { permitId: string; outcome: unknown }[];
  reserveCalls: number;
  /** All reserves answer with this fixed id (server idempotency fault). */
  duplicatePermitId?: string;
}

function jsonResponse(body: unknown, status = 200, unparseable = false) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : `HTTP ${status}`,
    json: async () => {
      if (unparseable) throw new SyntaxError('Unexpected token < in JSON');
      return body;
    },
  } as unknown as Response;
}

function reserveBody(state: ServerState, mode: FetchMode): unknown {
  const id =
    state.duplicatePermitId ?? `permit-stress-${(state.permitIdSeq += 1)}`;
  const access = {
    premium: false,
    freeRatings: {
      total: 2,
      used: 1,
      reserved: 1,
      remaining: 0,
      availableToReserve: 0,
    },
  };
  const permit: Record<string, unknown> = {
    id,
    accessSource: 'free',
    status: 'reserved',
    expiresAt: '2026-09-04T22:00:00.000Z',
  };
  switch (mode) {
    case 'body_null':
      return null;
    case 'body_array':
      return [];
    case 'body_missing_permit':
      return { access };
    case 'permit_empty_id':
      return { permit: { ...permit, id: '' }, access };
    case 'permit_whitespace_id':
      return { permit: { ...permit, id: '   ' }, access };
    case 'permit_numeric_id':
      return { permit: { ...permit, id: 42 }, access };
    case 'permit_bad_access_source':
      return { permit: { ...permit, accessSource: 'trial' }, access };
    case 'permit_missing_expires':
      return { permit: { ...permit, expiresAt: undefined }, access };
    case 'permit_status_released':
      return { permit: { ...permit, status: 'released' }, access };
    case 'permit_status_missing':
      return { permit: { ...permit, status: undefined }, access };
    case 'access_malformed':
      return { permit, access: 'yes' };
    case 'access_partial':
      return { permit, access: { premium: false, freeRatings: { total: 2 } } };
    default:
      return { permit, access };
  }
}

function makeFetch(state: ServerState) {
  return jest.fn((url: string, init?: RequestInit): Promise<Response> => {
    const isReserve = url.endsWith('/v1/analysis-permits');
    const isFinalize = url.includes('/finalize');
    if (!isReserve && !isFinalize) {
      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    }
    const mode = isReserve ? state.reserveMode : state.finalizeMode;
    if (isReserve) state.reserveCalls += 1;
    if (isFinalize) {
      const match = /analysis-permits\/([^/]+)\/finalize/.exec(url);
      state.finalizeCalls.push({
        permitId: decodeURIComponent(match?.[1] ?? ''),
        outcome: (JSON.parse(String(init?.body)) as { outcome: unknown })
          .outcome,
      });
    }
    const respond = (): Response => {
      switch (mode) {
        case 'http_402_paywall':
          return jsonResponse(
            {
              error: {
                code: 'access.paywall_required',
                message: 'Upgrade to keep rating.',
              },
            },
            402,
          );
        case 'http_401':
          return jsonResponse(
            { error: { code: 'auth.invalid', message: 'expired' } },
            401,
          );
        case 'http_409_not_reserved':
          return jsonResponse(
            {
              error: {
                code: 'access.permit_not_reserved',
                message: 'already consumed',
              },
            },
            409,
          );
        case 'http_429':
          return jsonResponse(
            { error: { code: 'rate_limited', message: 'slow down' } },
            429,
          );
        case 'http_500':
          return jsonResponse(
            { error: { code: 'internal', message: 'boom' } },
            500,
          );
        case 'http_503':
          return jsonResponse(null, 503);
        case 'body_unparseable':
          return jsonResponse(null, 200, true);
        default:
          if (isFinalize) return jsonResponse({ ok: true });
          {
            const body = reserveBody(state, mode);
            const permit = (
              body as { permit?: { id?: unknown; status?: unknown } } | null
            )?.permit;
            // The server-side truth: a permit row exists in `reserved` state
            // whenever a usable id was issued and the body does not say it
            // is already settled. (An empty id is not a row anyone can act on.)
            if (
              permit &&
              typeof permit.id === 'string' &&
              permit.id.trim().length > 0 &&
              (permit.status === 'reserved' || permit.status === undefined)
            ) {
              state.reservedIds.push(permit.id);
            }
            return jsonResponse(body);
          }
      }
    };
    switch (mode) {
      case 'throw_sync':
        throw new TypeError('fetch is not a function (injected)');
      case 'reject_network':
        return Promise.reject(new TypeError('Network request failed'));
      case 'never_honors_abort':
        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (signal) {
            signal.addEventListener('abort', () =>
              reject(new DOMException('Aborted', 'AbortError')),
            );
          }
        });
      case 'slow':
        return new Promise<Response>((resolve, reject) => {
          const signal = init?.signal;
          const timer = setTimeout(() => resolve(respond()), state.slowMs);
          signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new DOMException('Aborted', 'AbortError'));
          });
        });
      default:
        return Promise.resolve(respond());
    }
  });
}

// ─── Fixtures ───────────────────────────────────────────────────────────────

type FixtureClass = 'scored' | 'low_confidence' | 'gate_blocked';

interface Fixture {
  clip: CapturedClip;
  sidecarJson: string;
}

function swingClip(fixture: FixtureClass): Fixture {
  const { sequence, window } = generateSwingSequence({});
  let shaped = sequence;
  if (fixture === 'low_confidence') {
    const visibility = 0.5;
    shaped = {
      ...sequence,
      frames: sequence.frames.map(frame => ({
        ...frame,
        confidence: visibility,
        landmarks: frame.landmarks.map(mark => ({ ...mark, visibility })),
      })),
    };
  } else if (fixture === 'gate_blocked') {
    // Drop every landmark below the hips on every frame: the pose-quality
    // gate measures "body not fully visible" and must refuse BEFORE inference.
    shaped = {
      ...sequence,
      frames: sequence.frames.map(frame => ({
        ...frame,
        landmarks: frame.landmarks.map(mark =>
          /knee|ankle|heel|foot|toe/i.test(mark.name)
            ? { ...mark, visibility: 0.05 }
            : mark,
        ),
      })),
    };
  }
  const sidecarJson = serializePoseSequence(shaped);
  const clip: CapturedClip = {
    uri: 'file:///captures/stress.mov',
    durationMs: window.endMs,
    fps: 60,
    width: 1080,
    height: 1080,
    capturedAtIso: '2026-09-04T12:00:00.000Z',
    captureMode: 'automatic_pose_trigger',
    recognition: {
      status: 'unknown',
      reason: 'validated_classifier_unavailable',
    },
    trigger: {
      startMs: window.startMs,
      endMs: window.endMs,
      peakMotionMs: window.peakMs,
      confidence: 0.86,
      source: 'temporal_pose_motion',
      modelVersion: 'temporal-stroke-heuristic-2',
    },
    captureEvidence: {
      schemaVersion: 1,
      window: 'detected_motion',
      poseSource: 'apple_vision_body_pose',
      poseModelVersion: 'apple-vision-bodypose-1',
      triggerAlgorithmVersion: 'temporal-stroke-heuristic-2',
      motionUnit: 'normalized_image_units_per_second',
      analysisInputFrameCount: shaped.frames.length,
      poseFrameCount: shaped.frames.length,
      poseMissingFrameCount: 0,
      trackedDurationMs: window.endMs,
      meanCanonicalJointVisibility: 0.9,
      meanJointCoverage: 0.9,
      minimumJointCoverage: 0.8,
      fullBodyVisibleFrameCount: shaped.frames.length,
      jointMotion: [
        {
          joint: 'right_wrist',
          sampleCount: 4,
          meanNormalizedPerSecond: 0.6,
          peakNormalizedPerSecond: 1.4,
        },
      ],
    },
    ballSpeed: {
      status: 'unavailable',
      reason: 'calibrated_ball_tracker_unavailable',
    },
    preRollMs: 400,
    postRollMs: 300,
    poseSequence: {
      schemaVersion: 1,
      format: 'pickle.pose-sequence.v1',
      uri: 'file:///captures/stress.pose.json',
      frameCount: shaped.frames.length,
      sha256: sha256Hex(sidecarJson),
      coordinateSystem: 'normalized_image_top_left',
      poseModelVersion: 'apple-vision-bodypose-1',
    },
  };
  return { clip, sidecarJson };
}

const FIXTURES: Record<FixtureClass, Fixture> = {
  scored: swingClip('scored'),
  low_confidence: swingClip('low_confidence'),
  gate_blocked: swingClip('gate_blocked'),
};

// ─── Fault catalog ──────────────────────────────────────────────────────────

type Dependency =
  | 'camera_artifact'
  | 'fetch_reserve'
  | 'fetch_finalize'
  | 'sqlite'
  | 'vision_provider'
  | 'uuid_crypto'
  | 'clock'
  | 'telemetry';

interface Scenario {
  server: ServerState;
  dbFaults: DbFault[];
  readArtifact: (sidecarJson: string) => Promise<string>;
  providerHook: (a: ProviderAvailability) => ProviderAvailability;
  uuidHook: (real: () => string) => string;
  clock: (() => number) | null;
  telemetry: boolean;
  /** True when a never-resolving LOCAL dependency was injected. */
  localNever: boolean;
}

interface Fault {
  id: string;
  dependency: Dependency;
  apply: (scenario: Scenario, rng: () => number) => void;
}

const providerFault =
  (
    provider: keyof FusionProviders,
    method: string,
    mode: 'reject' | 'throw_sync' | 'never' | 'slow' | 'malformed' | 'partial',
  ) =>
  (scenario: Scenario, rng: () => number): void => {
    if (mode === 'never') scenario.localNever = true;
    const delay = 500 + Math.floor(rng() * 5_000);
    scenario.providerHook = availability => {
      if (availability.kind !== 'real') return availability;
      const target = availability.providers[provider] as unknown as Record<
        string,
        (...args: unknown[]) => unknown
      > | null;
      if (!target) return availability;
      const original = target[method]!.bind(target);
      const wrapped: Record<string, unknown> = Object.create(
        Object.getPrototypeOf(target) as object | null,
      );
      Object.assign(wrapped, target);
      wrapped[method] = (...args: unknown[]) => {
        switch (mode) {
          case 'reject':
            return Promise.reject(new Error(`${provider}.${method} crashed`));
          case 'throw_sync':
            throw new RangeError(`${provider}.${method} threw synchronously`);
          case 'never':
            return new Promise(() => {});
          case 'slow':
            return new Promise(resolve =>
              setTimeout(() => resolve(original(...args)), delay),
            );
          case 'malformed':
            return Promise.resolve({ ok: true, value: null });
          case 'partial':
            return Promise.resolve({ ok: true });
        }
      };
      return {
        kind: 'real',
        providers: {
          ...availability.providers,
          [provider]: wrapped,
        } as FusionProviders,
      };
    };
  };

const dbFault =
  (match: string, mode: DbMode, nth?: number) =>
  (scenario: Scenario, rng: () => number): void => {
    if (mode === 'never') scenario.localNever = true;
    scenario.dbFaults.push({
      match,
      mode,
      nth,
      delayMs: 200 + Math.floor(rng() * 3_000),
    });
  };

const reserveFault =
  (mode: FetchMode) =>
  (scenario: Scenario, rng: () => number): void => {
    scenario.server.reserveMode = mode;
    scenario.server.slowMs = 1_000 + Math.floor(rng() * 15_000);
  };

const finalizeFault =
  (mode: FetchMode) =>
  (scenario: Scenario, rng: () => number): void => {
    scenario.server.finalizeMode = mode;
    scenario.server.slowMs = 1_000 + Math.floor(rng() * 15_000);
  };

const uuidFault =
  (mode: 'throw_first' | 'throw_second' | 'throw_late') =>
  (scenario: Scenario): void => {
    let calls = 0;
    const failAt = mode === 'throw_first' ? 1 : mode === 'throw_second' ? 2 : 5;
    scenario.uuidHook = real => {
      calls += 1;
      if (calls === failAt) {
        throw new Error('crypto.getRandomValues unavailable');
      }
      return real();
    };
  };

const FAULT_CATALOG: readonly Fault[] = [
  // camera / file artifact
  {
    id: 'artifact.throw_sync',
    dependency: 'camera_artifact',
    apply: s => {
      s.readArtifact = () => {
        throw new Error('RNFS.readFile threw synchronously');
      };
    },
  },
  {
    id: 'artifact.reject',
    dependency: 'camera_artifact',
    apply: s => {
      s.readArtifact = () => Promise.reject(new Error('ENOENT'));
    },
  },
  {
    id: 'artifact.slow',
    dependency: 'camera_artifact',
    apply: (s, rng) => {
      const delay = 1_000 + Math.floor(rng() * 20_000);
      s.readArtifact = json =>
        new Promise(resolve => setTimeout(() => resolve(json), delay));
    },
  },
  {
    id: 'artifact.never_resolves',
    dependency: 'camera_artifact',
    apply: s => {
      s.localNever = true;
      s.readArtifact = () => new Promise(() => {});
    },
  },
  {
    id: 'artifact.malformed_json',
    dependency: 'camera_artifact',
    apply: s => {
      s.readArtifact = async () => '{"schemaVersion":1,"frames":"nope"';
    },
  },
  {
    id: 'artifact.truncated_partial',
    dependency: 'camera_artifact',
    apply: (s, rng) => {
      const ratio = 0.1 + rng() * 0.8;
      s.readArtifact = async json =>
        json.slice(0, Math.floor(json.length * ratio));
    },
  },
  {
    id: 'artifact.empty',
    dependency: 'camera_artifact',
    apply: s => {
      s.readArtifact = async () => '';
    },
  },
  {
    id: 'artifact.bit_flip',
    dependency: 'camera_artifact',
    apply: (s, rng) => {
      s.readArtifact = async json => {
        const at = Math.floor(rng() * json.length);
        const flipped = json.charCodeAt(at) === 48 ? '1' : '0';
        return json.slice(0, at) + flipped + json.slice(at + 1);
      };
    },
  },
  {
    id: 'artifact.non_string',
    dependency: 'camera_artifact',
    apply: s => {
      s.readArtifact = async () => null as unknown as string;
    },
  },
  // fetch — reserve
  ...(
    [
      'reject_network',
      'throw_sync',
      'never_honors_abort',
      'slow',
      'http_402_paywall',
      'http_401',
      'http_409_not_reserved',
      'http_429',
      'http_500',
      'http_503',
      'body_unparseable',
      'body_null',
      'body_array',
      'body_missing_permit',
      'permit_empty_id',
      'permit_whitespace_id',
      'permit_numeric_id',
      'permit_bad_access_source',
      'permit_missing_expires',
      'permit_status_released',
      'permit_status_missing',
      'access_malformed',
      'access_partial',
    ] as const
  ).map(mode => ({
    id: `reserve.${mode}`,
    dependency: 'fetch_reserve' as const,
    apply: reserveFault(mode),
  })),
  // fetch — finalize
  ...(
    [
      'reject_network',
      'throw_sync',
      'never_honors_abort',
      'slow',
      'http_401',
      'http_409_not_reserved',
      'http_429',
      'http_500',
      'http_503',
      'body_unparseable',
    ] as const
  ).map(mode => ({
    id: `finalize.${mode}`,
    dependency: 'fetch_finalize' as const,
    apply: finalizeFault(mode),
  })),
  // SQLite
  ...(
    [
      ['INSERT INTO local_analysis_record', 'throw'],
      ['INSERT INTO local_analysis_record', 'reject'],
      ['INSERT INTO local_analysis_record', 'slow'],
      ['INSERT INTO local_analysis_record', 'never'],
      ["SET status = 'analyzed'", 'throw'],
      ["SET status = 'analyzed'", 'reject'],
      ["SET status = 'analyzed'", 'never'],
      ['BEGIN IMMEDIATE', 'throw'],
      ['BEGIN IMMEDIATE', 'reject'],
      ['BEGIN IMMEDIATE', 'never'],
      ['INSERT OR REPLACE INTO local_shot', 'throw'],
      ['INSERT OR REPLACE INTO local_shot', 'reject'],
      ['INSERT OR REPLACE INTO local_shot', 'slow'],
      ['INSERT OR REPLACE INTO local_shot', 'never'],
      ["'shot.sync'", 'throw'],
      ["'shot.sync'", 'reject'],
      ['COMMIT', 'throw'],
      ['COMMIT', 'reject'],
      ['COMMIT', 'never'],
      ['ROLLBACK', 'throw'],
    ] as const
  ).map(([match, mode]) => ({
    id: `sqlite.${match.replace(/[^a-z_]/gi, '').toLowerCase()}.${mode}`,
    dependency: 'sqlite' as const,
    apply: dbFault(match, mode),
  })),
  {
    id: 'sqlite.commit_and_rollback_both_fail',
    dependency: 'sqlite',
    apply: (s, rng) => {
      dbFault('COMMIT', 'reject')(s, rng);
      dbFault('ROLLBACK', 'reject')(s, rng);
    },
  },
  {
    id: 'sqlite.local_shot_then_rollback_fail',
    dependency: 'sqlite',
    apply: (s, rng) => {
      dbFault('INSERT OR REPLACE INTO local_shot', 'reject')(s, rng);
      dbFault('ROLLBACK', 'throw')(s, rng);
    },
  },
  // Vision fusion providers
  ...(
    [
      ['phase', 'segmentPhases'],
      ['biomechanics', 'extract'],
      ['scorer', 'score'],
      ['faultDetector', 'detectFaults'],
      ['uncertainty', 'estimate'],
      ['coach', 'rank'],
    ] as const
  ).flatMap(([provider, method]) =>
    (['reject', 'throw_sync', 'malformed', 'partial', 'slow', 'never'] as const)
      .filter(mode => mode !== 'never' || provider === 'scorer')
      .map(mode => ({
        id: `provider.${provider}.${mode}`,
        dependency: 'vision_provider' as const,
        apply: providerFault(provider, method, mode),
      })),
  ),
  {
    id: 'provider.bundle_unavailable',
    dependency: 'vision_provider',
    apply: s => {
      s.providerHook = () => ({
        kind: 'unavailable',
        reason: 'Scoring providers are not installed on this device.',
      });
    },
  },
  {
    id: 'provider.bundle_malformed',
    dependency: 'vision_provider',
    apply: s => {
      s.providerHook = a =>
        a.kind === 'real'
          ? {
              kind: 'real',
              providers: {
                ...a.providers,
                scorer: null,
              } as unknown as FusionProviders,
            }
          : a;
    },
  },
  // ids / crypto
  {
    id: 'uuid.throw_first',
    dependency: 'uuid_crypto',
    apply: uuidFault('throw_first'),
  },
  {
    id: 'uuid.throw_second',
    dependency: 'uuid_crypto',
    apply: uuidFault('throw_second'),
  },
  {
    id: 'uuid.throw_late',
    dependency: 'uuid_crypto',
    apply: uuidFault('throw_late'),
  },
  // clock
  {
    id: 'clock.date_now_nan',
    dependency: 'clock',
    apply: s => {
      s.clock = () => Number.NaN;
    },
  },
  {
    id: 'clock.date_now_zero',
    dependency: 'clock',
    apply: s => {
      s.clock = () => 0;
    },
  },
  {
    id: 'clock.date_now_backwards',
    dependency: 'clock',
    apply: s => {
      let t = 1_800_000_000_000;
      s.clock = () => (t -= 60_000);
    },
  },
  {
    id: 'clock.date_now_far_future',
    dependency: 'clock',
    apply: s => {
      s.clock = () => 8.64e15;
    },
  },
  // telemetry queue
  {
    id: 'telemetry.outbox_reject',
    dependency: 'telemetry',
    apply: (s, rng) => {
      s.telemetry = true;
      dbFault("'evaluation.trial'", 'reject')(s, rng);
    },
  },
  {
    id: 'telemetry.outbox_throw',
    dependency: 'telemetry',
    apply: (s, rng) => {
      s.telemetry = true;
      dbFault("'evaluation.trial'", 'throw')(s, rng);
    },
  },
];

const FAULT_BY_ID = new Map(FAULT_CATALOG.map(f => [f.id, f]));

function freshScenario(): Scenario {
  return {
    server: {
      reserveMode: 'ok',
      finalizeMode: 'ok',
      slowMs: 2_000,
      permitIdSeq: 0,
      reservedIds: [],
      finalizeCalls: [],
      reserveCalls: 0,
    },
    dbFaults: [],
    readArtifact: async json => json,
    providerHook: a => a,
    uuidHook: real => real(),
    clock: null,
    telemetry: false,
    localNever: false,
  };
}

// ─── Execution + oracle ─────────────────────────────────────────────────────

type Settled =
  | { state: 'resolved'; outcome: CaptureAnalysisOutcome }
  | { state: 'rejected'; error: unknown }
  | { state: 'pending' };

/**
 * Reserve bodies that carry a usable, still-reserved permit id but fail the
 * client's strict parse: the client answers `unavailable` WITHOUT releasing
 * the id it was handed, so the reservation lives until the server sweep.
 * Recorded as an observation (P3 candidate), never as a pass.
 */
const KNOWN_LEAKED_RESERVATION_FAULTS = new Set([
  'reserve.permit_bad_access_source',
  'reserve.permit_missing_expires',
  'reserve.permit_status_missing',
]);

type Classification =
  | 'HELD'
  | 'BROKEN'
  | 'OBSERVED_hang_no_timeout'
  | 'OBSERVED_leaked_reservation'
  | 'OBSERVED_txn_open_after_rollback_fault';

interface IterationResult {
  seed: number;
  campaign: 'catalog' | 'combo' | 'race' | 'abandon';
  fixture: FixtureClass;
  faults: string[];
  outcome: string;
  reserved: string[];
  finalized: { permitId: string; outcome: unknown }[];
  consumedPermits: string[];
  committedTables: Record<string, number>;
  transactionOpen: boolean;
  violations: string[];
  observations: string[];
  classification: Classification;
}

function summarizeOutcome(settled: Settled): string {
  switch (settled.state) {
    case 'resolved':
      return settled.outcome.kind === 'unavailable' && settled.outcome.cause
        ? `unavailable:${settled.outcome.cause}`
        : settled.outcome.kind;
    case 'rejected':
      return `thrown:${
        settled.error instanceof Error
          ? settled.error.constructor.name
          : typeof settled.error
      }`;
    case 'pending':
      return 'pending_after_60s';
  }
}

function committedByTable(db: FakeSqlite): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of db.committed) {
    const key = row.kind ? `${row.table}:${row.kind}` : row.table;
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

function consumedPermits(db: FakeSqlite): string[] {
  return db.committed
    .filter(row => row.table === 'outbox' && row.kind === 'shot.sync')
    .map(row => {
      const payload = JSON.parse(String(row.params[1])) as {
        analysisPermitId?: unknown;
      };
      return String(payload.analysisPermitId);
    });
}

interface Verdict {
  violations: string[];
  observations: string[];
}

function checkInvariants(
  settled: Settled,
  scenario: Scenario,
  db: FakeSqlite,
  faultIds: readonly string[],
): Verdict {
  const violations: string[] = [];
  const observations: string[] = [];
  const leakExpected = faultIds.some(id =>
    KNOWN_LEAKED_RESERVATION_FAULTS.has(id),
  );
  const rollbackFaulted = scenario.dbFaults.some(f => f.match === 'ROLLBACK');
  const reserved = scenario.server.reservedIds;
  const finalized = scenario.server.finalizeCalls;
  const consumed = consumedPermits(db);
  const scoredShots = db.committed.filter(
    row => row.table === 'local_shot' && row.params[7] === 'scored',
  );
  const localOnlyShots = db.committed.filter(
    row => row.table === 'local_shot' && row.params[7] !== 'scored',
  );
  const records = db.committed.filter(
    row => row.table === 'local_analysis_record',
  );

  // Settlement / spinner.
  if (settled.state === 'pending' && !scenario.localNever) {
    violations.push(
      'run still pending after 60s with no never-resolving local dependency',
    );
  }
  // No silent failure.
  if (settled.state === 'rejected') {
    const error = settled.error;
    if (!(error instanceof Error) || !error.message) {
      violations.push('thrown value is not an Error with a message');
    }
  }
  if (settled.state === 'resolved' && settled.outcome.kind !== 'scored') {
    const reason =
      settled.outcome.kind === 'low_confidence'
        ? 'n/a'
        : settled.outcome.reason;
    if (typeof reason !== 'string' || reason.length === 0) {
      violations.push(
        `${settled.outcome.kind} outcome carries an empty reason`,
      );
    }
  }
  // Permit accounting: every reserved permit settled exactly once.
  for (const id of reserved) {
    const finalizeCount = finalized.filter(f => f.permitId === id).length;
    const consumeCount = consumed.filter(c => c === id).length;
    const total = finalizeCount + consumeCount;
    if (settled.state === 'pending') {
      if (total > 1)
        violations.push(`permit ${id} settled ${total}× while pending`);
      continue;
    }
    if (
      total === 0 &&
      leakExpected &&
      settled.state === 'resolved' &&
      settled.outcome.kind === 'unavailable'
    ) {
      observations.push(
        `permit ${id} left reserved server-side (client discarded a malformed-but-usable reserve body without releasing it)`,
      );
      continue;
    }
    if (total !== 1) {
      violations.push(
        `permit ${id} settled ${total}× (finalize ${finalizeCount}, consumed ${consumeCount})`,
      );
    }
  }
  for (const f of finalized) {
    if (!reserved.includes(f.permitId)) {
      violations.push(`finalize for unreserved permit "${f.permitId}"`);
    }
    if (
      !['failed', 'low_confidence', 'unsupported'].includes(String(f.outcome))
    ) {
      violations.push(`finalize with unexpected outcome ${String(f.outcome)}`);
    }
  }
  for (const c of consumed) {
    if (!reserved.includes(c)) {
      violations.push(`shot.sync carries unreserved permit "${c}"`);
    }
  }
  // Persistence consistency.
  if (scoredShots.length !== consumed.length) {
    violations.push(
      `scored local_shot rows (${scoredShots.length}) != shot.sync rows (${consumed.length})`,
    );
  }
  if (db.transactionOpen && settled.state !== 'pending') {
    if (rollbackFaulted) {
      observations.push(
        'transaction left open after COMMIT/ROLLBACK both failed (connection needs a restart to write again)',
      );
    } else {
      violations.push('transaction left open');
    }
  }
  if (settled.state === 'resolved') {
    const outcome = settled.outcome;
    if (outcome.kind === 'scored') {
      if (
        consumed.length !== 1 ||
        consumed[0] !== reserved[reserved.length - 1]
      ) {
        violations.push(
          'scored outcome without a committed shot.sync row for its permit',
        );
      }
      if (records.length !== 1)
        violations.push('scored outcome without exactly one analysis record');
      if (!db.committed.some(r => r.table === 'local_capture')) {
        violations.push('scored outcome but capture not marked analyzed');
      }
      if (finalized.length !== 0)
        violations.push('scored outcome but a finalize was sent');
      if (typeof outcome.freeLimitReached !== 'boolean')
        violations.push('freeLimitReached not boolean');
    } else {
      if (scoredShots.length !== 0 || consumed.length !== 0) {
        violations.push(
          `${outcome.kind} outcome but a scored rating was committed`,
        );
      }
      if (outcome.kind === 'low_confidence') {
        if (
          finalized.filter(f => f.outcome === 'low_confidence').length !== 1
        ) {
          violations.push(
            'low_confidence outcome without exactly one low_confidence finalize',
          );
        }
        if (localOnlyShots.length > 1)
          violations.push('more than one local-only shot row');
        if (records.length !== 1)
          violations.push(
            'low_confidence outcome without exactly one analysis record',
          );
      } else {
        if (localOnlyShots.length !== 0) {
          violations.push(
            `${outcome.kind} outcome but a local-only shot row was committed`,
          );
        }
        if (outcome.kind === 'quality_blocked' && records.length !== 0) {
          violations.push(
            'quality_blocked but an analysis record was committed',
          );
        }
        if (outcome.kind === 'quality_blocked' && reserved.length === 1) {
          if (finalized.filter(f => f.outcome === 'unsupported').length !== 1) {
            violations.push(
              'quality_blocked after reserve without an unsupported finalize',
            );
          }
        }
        if (
          outcome.kind === 'unavailable' &&
          reserved.length === 1 &&
          !leakExpected
        ) {
          if (finalized.filter(f => f.outcome === 'failed').length !== 1) {
            violations.push(
              'unavailable after reserve without a failed finalize',
            );
          }
        }
      }
    }
  }
  if (settled.state === 'rejected') {
    if (scoredShots.length !== 0 || consumed.length !== 0) {
      violations.push('thrown run left a committed scored rating behind');
    }
    // A throw AFTER the typed outcome already settled the permit (e.g. the
    // local-only save of an abstention failing) keeps that settlement; a throw
    // before any settlement must release 'failed'.
    if (reserved.length === 1 && finalized.length !== 1) {
      violations.push('thrown run after reserve did not finalize exactly once');
    }
  }
  return { violations, observations };
}

function baseRequest(
  db: LocalDb,
  fixture: Fixture,
  scenario: Scenario,
  captureId: string,
): RunCaptureAnalysisRequest {
  return {
    db,
    captureId,
    clip: fixture.clip,
    declaredStroke: 'forehand_drive',
    handedness: 'right',
    cameraView: 'side',
    apiConfig: { baseUrl: 'https://api.stress.test', token: 'token-stress' },
    appVersion: '0.1.0-stress',
    evaluationTelemetry: scenario.telemetry
      ? {
          consentActive: true,
          consentVersion: 'v1',
          dims: {
            userPseudonym: 'stress-pseudonym',
            sessionId: null,
            courtId: null,
            deviceModel: 'stress',
            devicePlatform: 'ios',
            osVersion: '26',
          },
        }
      : null,
  };
}

function installScenario(scenario: Scenario, fixture: Fixture): FakeSqlite {
  mockReadArtifact = () => scenario.readArtifact(fixture.sidecarJson);
  mockProviderHook = scenario.providerHook;
  mockUuidHook = scenario.uuidHook;
  (globalThis as { fetch?: unknown }).fetch = makeFetch(scenario.server);
  if (scenario.clock)
    jest.spyOn(Date, 'now').mockImplementation(scenario.clock);
  return new FakeSqlite(scenario.dbFaults);
}

async function settle<T>(
  promise: Promise<T>,
): Promise<
  | { state: 'resolved'; outcome: T }
  | { state: 'rejected'; error: unknown }
  | { state: 'pending' }
> {
  let result:
    | { state: 'resolved'; outcome: T }
    | { state: 'rejected'; error: unknown }
    | { state: 'pending' } = { state: 'pending' };
  promise.then(
    outcome => {
      result = { state: 'resolved', outcome };
    },
    (error: unknown) => {
      result = { state: 'rejected', error };
    },
  );
  await jest.advanceTimersByTimeAsync(SETTLE_WINDOW_MS);
  return result;
}

async function runIteration(
  seed: number,
  campaign: IterationResult['campaign'],
  fixtureClass: FixtureClass,
  faultIds: string[],
): Promise<IterationResult> {
  const rng = mulberry32(seed);
  const scenario = freshScenario();
  for (const id of faultIds) FAULT_BY_ID.get(id)!.apply(scenario, rng);
  const fixture = FIXTURES[fixtureClass];
  const sqlite = installScenario(scenario, fixture);
  const settled = await settle(
    runCaptureAnalysis(
      baseRequest(sqlite.db, fixture, scenario, `capture-${seed}`),
    ),
  );
  const { violations, observations } = checkInvariants(
    settled,
    scenario,
    sqlite,
    faultIds,
  );
  return {
    seed,
    campaign,
    fixture: fixtureClass,
    faults: faultIds,
    outcome: summarizeOutcome(settled),
    reserved: [...scenario.server.reservedIds],
    finalized: [...scenario.server.finalizeCalls],
    consumedPermits: consumedPermits(sqlite),
    committedTables: committedByTable(sqlite),
    transactionOpen: sqlite.transactionOpen,
    violations,
    observations,
    classification: classify(settled, violations, observations),
  };
}

function classify(
  settled: Settled,
  violations: string[],
  observations: string[],
): Classification {
  if (violations.length > 0) return 'BROKEN';
  if (settled.state === 'pending') return 'OBSERVED_hang_no_timeout';
  if (observations.some(o => o.includes('left reserved'))) {
    return 'OBSERVED_leaked_reservation';
  }
  if (observations.some(o => o.includes('transaction left open'))) {
    return 'OBSERVED_txn_open_after_rollback_fault';
  }
  return 'HELD';
}

const results: IterationResult[] = [];

function planCombo(seed: number): { fixture: FixtureClass; faults: string[] } {
  const rng = mulberry32(seed ^ 0x9e3779b9);
  const fixture = pick(rng, [
    'scored',
    'scored',
    'low_confidence',
    'gate_blocked',
  ] as const);
  const count = 1 + Math.floor(rng() * 3);
  const faults: string[] = [];
  const usedDeps = new Set<Dependency>();
  for (let i = 0; i < count * 3 && faults.length < count; i += 1) {
    const fault = pick(rng, FAULT_CATALOG);
    if (usedDeps.has(fault.dependency)) continue;
    usedDeps.add(fault.dependency);
    faults.push(fault.id);
  }
  return { fixture, faults };
}

beforeEach(() => {
  jest.useFakeTimers();
  setActiveDataOwner(OWNER);
});
afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  (globalThis as { fetch?: unknown }).fetch = undefined;
  mockProviderHook = a => a;
  mockUuidHook = real => real();
});
afterAll(() => {
  if (STRESS_REPORT) {
    writeFileSync(
      STRESS_REPORT,
      JSON.stringify(
        {
          unit: 'runCaptureAnalysis',
          catalogSize: FAULT_CATALOG.length,
          iterations: results.length,
          held: results.filter(r => r.classification === 'HELD').length,
          broken: results.filter(r => r.classification === 'BROKEN').length,
          observed: results
            .filter(r => r.classification.startsWith('OBSERVED'))
            .reduce<Record<string, number>>((acc, r) => {
              acc[r.classification] = (acc[r.classification] ?? 0) + 1;
              return acc;
            }, {}),
          results,
        },
        null,
        2,
      ),
    );
  }
});

describe('runCaptureAnalysis failure injection — fixtures', () => {
  it('[HELD] the three fixture classes reach their intended outcome with no fault injected', async () => {
    const outcomes: Record<FixtureClass, string> = {
      scored: '',
      low_confidence: '',
      gate_blocked: '',
    };
    for (const fixture of Object.keys(FIXTURES) as FixtureClass[]) {
      const result = await runIteration(1, 'catalog', fixture, []);
      outcomes[fixture] = result.outcome;
      expect(result.violations).toEqual([]);
      jest.restoreAllMocks();
    }
    expect(outcomes).toEqual({
      scored: 'scored',
      low_confidence: 'low_confidence',
      gate_blocked: 'quality_blocked',
    });
  });
});

describe(`runCaptureAnalysis failure injection — catalog (${FAULT_CATALOG.length} faults)`, () => {
  const cases = FAULT_CATALOG.flatMap((fault, index) =>
    (fault.dependency === 'sqlite' ||
    fault.dependency === 'fetch_finalize' ||
    fault.dependency === 'telemetry'
      ? (['scored', 'low_confidence'] as const)
      : (['scored'] as const)
    ).map(fixture => ({
      fault,
      fixture,
      seed: 1_000 + index * 4 + (fixture === 'scored' ? 0 : 1),
    })),
  ).filter(c => STRESS_SEED === null || c.seed === STRESS_SEED);

  it.each(cases.map(c => [c.fault.id, c.fixture, c.seed] as const))(
    'fault %s on %s fixture (seed %i): permit settled once, no fake success, no corrupt rows',
    async (faultId, fixture, seed) => {
      const result = await runIteration(seed, 'catalog', fixture, [faultId]);
      results.push(result);
      expect(result.violations).toEqual([]);
      if (!faultId.includes('never')) {
        expect(result.outcome).not.toBe('pending_after_60s');
      }
      // Observations are pinned: a fault outside the known sets must not
      // start producing one silently.
      if (result.observations.length > 0) {
        expect(
          KNOWN_LEAKED_RESERVATION_FAULTS.has(faultId) ||
            faultId.includes('rollback'),
        ).toBe(true);
      }
    },
  );
});

describe(`runCaptureAnalysis failure injection — seeded combos (STRESS_ITER=${STRESS_ITER})`, () => {
  const seeds =
    STRESS_SEED !== null
      ? [STRESS_SEED]
      : Array.from({ length: STRESS_ITER }, (_, i) => 20_000 + i);
  it.each(seeds.map(seed => [seed, planCombo(seed)] as const))(
    'seed %i → %j',
    async (seed, plan) => {
      const result = await runIteration(
        seed,
        'combo',
        plan.fixture,
        plan.faults,
      );
      results.push(result);
      expect(result.violations).toEqual([]);
    },
  );
});

describe(`runCaptureAnalysis failure injection — permit races (STRESS_RACE=${STRESS_RACE})`, () => {
  const seeds =
    STRESS_SEED !== null
      ? [STRESS_SEED]
      : Array.from({ length: STRESS_RACE }, (_, i) => 30_000 + i);

  it.each(seeds.map(seed => [seed] as const))(
    'seed %i: N concurrent runs share one permit server with staggered faults — each permit settled exactly once, no cross-talk',
    async seed => {
      const rng = mulberry32(seed);
      const runs = 2 + Math.floor(rng() * 4);
      const scenario = freshScenario();
      scenario.server.finalizeMode = pick(rng, [
        'ok',
        'slow',
        'reject_network',
        'http_500',
      ] as const);
      scenario.server.slowMs = 500 + Math.floor(rng() * 10_000);
      const sqlite = new FakeSqlite([]);
      mockProviderHook = a => a;
      mockUuidHook = real => real();
      (globalThis as { fetch?: unknown }).fetch = makeFetch(scenario.server);
      const fixtures: FixtureClass[] = [];
      const delays: number[] = [];
      for (let i = 0; i < runs; i += 1) {
        fixtures.push(
          pick(rng, ['scored', 'low_confidence', 'gate_blocked'] as const),
        );
        delays.push(Math.floor(rng() * 3_000));
      }
      // The artifact read is the per-run stagger point.
      let readIndex = 0;
      mockReadArtifact = () => {
        const i = readIndex;
        readIndex += 1;
        const json = FIXTURES[fixtures[i % runs]!]!.sidecarJson;
        return new Promise(resolve =>
          setTimeout(() => resolve(json), delays[i % runs]),
        );
      };
      const promises = fixtures.map((fixture, i) =>
        runCaptureAnalysis(
          baseRequest(
            sqlite.db,
            FIXTURES[fixture],
            scenario,
            `race-${seed}-${i}`,
          ),
        ),
      );
      const settledAll = await settle(Promise.all(promises));
      const violations: string[] = [];
      if (settledAll.state !== 'resolved') {
        violations.push(
          `race batch did not resolve: ${summarizeOutcome(settledAll as Settled)}`,
        );
      }
      const reserved = scenario.server.reservedIds;
      const consumed = consumedPermits(sqlite);
      if (reserved.length !== runs)
        violations.push(
          `expected ${runs} reservations, saw ${reserved.length}`,
        );
      if (new Set(reserved).size !== reserved.length)
        violations.push('duplicate permit ids issued');
      for (const id of reserved) {
        const total =
          scenario.server.finalizeCalls.filter(f => f.permitId === id).length +
          consumed.filter(c => c === id).length;
        if (total !== 1) violations.push(`permit ${id} settled ${total}×`);
      }
      if (settledAll.state === 'resolved') {
        const kinds = settledAll.outcome.map(o => o.kind);
        const scoredCount = kinds.filter(k => k === 'scored').length;
        if (scoredCount !== consumed.length) {
          violations.push(
            `${scoredCount} scored outcomes but ${consumed.length} shot.sync rows`,
          );
        }
        kinds.forEach((kind, i) => {
          const expected =
            fixtures[i] === 'scored'
              ? 'scored'
              : fixtures[i] === 'low_confidence'
                ? 'low_confidence'
                : 'quality_blocked';
          if (kind !== expected)
            violations.push(`run ${i} (${fixtures[i]}) produced ${kind}`);
        });
      }
      if (sqlite.transactionOpen) violations.push('transaction left open');
      results.push({
        seed,
        campaign: 'race',
        fixture: 'scored',
        faults: [
          `race.runs=${runs}`,
          `finalize.${scenario.server.finalizeMode}`,
        ],
        outcome:
          settledAll.state === 'resolved'
            ? settledAll.outcome.map(o => o.kind).join(',')
            : summarizeOutcome(settledAll as Settled),
        reserved: [...reserved],
        finalized: [...scenario.server.finalizeCalls],
        consumedPermits: consumed,
        committedTables: committedByTable(sqlite),
        transactionOpen: sqlite.transactionOpen,
        violations,
        observations: [],
        classification: violations.length ? 'BROKEN' : 'HELD',
      });
      expect(violations).toEqual([]);
    },
  );

  it('[HELD] seed 31000: server hands the SAME permit id to two concurrent runs — each run settles "its" permit once; the duplicate is visible to the server, never hidden by the client', async () => {
    const scenario = freshScenario();
    scenario.server.duplicatePermitId = 'permit-dup';
    const sqlite = new FakeSqlite([]);
    (globalThis as { fetch?: unknown }).fetch = makeFetch(scenario.server);
    mockReadArtifact = async () => FIXTURES.scored.sidecarJson;
    const settledAll = await settle(
      Promise.all([
        runCaptureAnalysis(
          baseRequest(sqlite.db, FIXTURES.scored, scenario, 'dup-a'),
        ),
        runCaptureAnalysis(
          baseRequest(sqlite.db, FIXTURES.scored, scenario, 'dup-b'),
        ),
      ]),
    );
    expect(settledAll.state).toBe('resolved');
    const consumed = consumedPermits(sqlite);
    // Two shot.sync rows both carry permit-dup: the client cannot disambiguate a
    // server that violates its own uniqueness — the second sync is refused
    // server-side (apply_synced_shot re-checks the live permit). Recorded, not
    // repaired.
    expect(consumed).toEqual(['permit-dup', 'permit-dup']);
    expect(scenario.server.finalizeCalls).toEqual([]);
    results.push({
      seed: 31000,
      campaign: 'race',
      fixture: 'scored',
      faults: ['reserve.duplicate_permit_id'],
      outcome: 'scored,scored',
      reserved: [...scenario.server.reservedIds],
      finalized: [],
      consumedPermits: consumed,
      committedTables: committedByTable(sqlite),
      transactionOpen: sqlite.transactionOpen,
      violations: [],
      observations: [
        'server issued one permit id to two reservations; both ratings carry it — server-side uniqueness decides',
      ],
      classification: 'HELD',
    });
  });
});

describe('runCaptureAnalysis failure injection — cancellation / abandonment', () => {
  it.each([
    ['low_confidence', 'finalize.slow', 40_001],
    ['low_confidence', 'finalize.never_honors_abort', 40_002],
    ['scored', 'sqlite.insertintolocal_analysis_record.slow', 40_003],
    ['scored', 'provider.scorer.slow', 40_004],
    ['scored', 'reserve.slow', 40_005],
  ] as const)(
    '[HELD] %s run abandoned by its caller (nobody awaits) under %s (seed %i): the permit is still settled exactly once once timers run',
    async (fixture, faultId, seed) => {
      const rng = mulberry32(seed);
      const scenario = freshScenario();
      FAULT_BY_ID.get(faultId)!.apply(scenario, rng);
      const sqlite = installScenario(scenario, FIXTURES[fixture]);
      // Caller abandons: the promise is dropped without await (the screen's
      // `abandoned` ref path). The module must still settle its own permit.
      const dropped = runCaptureAnalysis(
        baseRequest(sqlite.db, FIXTURES[fixture], scenario, `abandon-${seed}`),
      );
      dropped.catch(() => {});
      const settled = await settle(dropped);
      const { violations, observations } = checkInvariants(
        settled,
        scenario,
        sqlite,
        [faultId],
      );
      results.push({
        seed,
        campaign: 'abandon',
        fixture,
        faults: [faultId],
        outcome: summarizeOutcome(settled),
        reserved: [...scenario.server.reservedIds],
        finalized: [...scenario.server.finalizeCalls],
        consumedPermits: consumedPermits(sqlite),
        committedTables: committedByTable(sqlite),
        transactionOpen: sqlite.transactionOpen,
        violations,
        observations,
        classification: classify(settled, violations, observations),
      });
      expect(violations).toEqual([]);
      expect(settled.state).toBe('resolved');
      expect(scenario.server.reservedIds).toHaveLength(1);
    },
  );
});
