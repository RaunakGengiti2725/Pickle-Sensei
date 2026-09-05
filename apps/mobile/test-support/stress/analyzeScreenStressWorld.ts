/**
 * The "world" one AnalyzeScreen stress iteration runs inside: every native or
 * remote dependency the screen (or the runtime it triggers) reaches, backed
 * by a real in-memory SQLite database and driven by the seeded `FaultPlan`
 * from ./analyzeScreenFailureInjection.
 *
 * Only the seams the app itself cannot own under jest are faked — the native
 * camera bridge, the SQLite driver, fetch, the Keychain module and the
 * RevenueCat SDK. Everything above them (repository, permits client, access
 * store, session keeper, sync runtime, analysis pipeline, providers) is the
 * production code path. Validation of native payloads goes through the real
 * `assertCapturedClip` / `assertImportedPoseExtraction`, exactly as the
 * production bridge wrappers do.
 */
import { generateSwingSequence } from '@pickle/evaluation';
import { serializePoseSequence, sha256Hex } from '@pickle/swing-domain';
import type { Result } from '@pickle/shared-types';
import type { FusionProviders } from '@pickle/analysis-pipeline';
import type { CanonicalAccessState } from '../../src/billing/types';
import type { RevenueCatSdk } from '../../src/billing/revenueCatClient';
import {
  assertCapturedClip,
  assertImportedPoseExtraction,
  type CameraEvent,
  type CapturedClip,
  type ImportedPoseExtraction,
} from '../../src/camera/capture';
import {
  SLOW_SEAM_MS,
  type FaultPlan,
  type KeychainFault,
  type PersistenceSnapshot,
  type RevenueCatFault,
  type Route,
  type RouteFault,
  type SeamBehaviour,
  type SqlFault,
  type VisionFault,
} from './analyzeScreenFailureInjection';

// apps/mobile types only `jest` (no @types/node): declare the node:sqlite
// surface this harness drives, the same way dbMigrationMalformedOutbox does.
declare const require: (id: string) => unknown;

interface SqliteStatement {
  all(...params: (string | number | null)[]): Record<string, unknown>[];
  run(...params: (string | number | null)[]): unknown;
}
export interface SqliteDatabase {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): void;
  close(): void;
}

export function openMemorySqlite(): SqliteDatabase {
  const { DatabaseSync } = require('node:sqlite') as {
    DatabaseSync: new (location: string) => SqliteDatabase;
  };
  return new DatabaseSync(':memory:');
}

// ─── Shared constants ────────────────────────────────────────────────────────

export const OWNER = '44444444-4444-4444-8444-444444444444';
export const API_BASE_URL = 'https://stress.invalid';
export const BEARER_1 = 'bearer-stress-1';
export const REFRESH_1 = 'refresh-stress-1';
export const RC_PUBLIC_KEY = 'appl_stress_public_key';

export class NativeBridgeError extends Error {
  code: string | null;
  constructor(message: string, code: string | null) {
    super(message);
    this.name = 'NativeBridgeError';
    this.code = code;
  }
}

/** A timer that the world can advance (jest fake timers). */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const NEVER = new Promise<never>(() => {});

// ─── Log ─────────────────────────────────────────────────────────────────────

export interface WorldLog {
  faultHits: number;
  fetchCalls: string[];
  bridgeCalls: string[];
  cancelCalls: number;
  reservedPermits: string[];
  releasedPermits: Array<{ id: string; outcome: string }>;
  syncedShots: string[];
  rotatedBearers: number;
  revokedSessions: number;
  keychainWrites: number;
  keychainReads: number;
  sqlStatements: number;
}

function emptyLog(): WorldLog {
  return {
    faultHits: 0,
    fetchCalls: [],
    bridgeCalls: [],
    cancelCalls: 0,
    reservedPermits: [],
    releasedPermits: [],
    syncedShots: [],
    rotatedBearers: 0,
    revokedSessions: 0,
    keychainWrites: 0,
    keychainReads: 0,
    sqlStatements: 0,
  };
}

// ─── Clip fixtures ───────────────────────────────────────────────────────────

export interface ClipFixture {
  clip: CapturedClip;
  sidecarJson: string;
}

export function guidedClipFixture(id: string): ClipFixture {
  const { sequence, window } = generateSwingSequence();
  const sidecarJson = serializePoseSequence(sequence);
  const clip: CapturedClip = {
    uri: `file:///captures/${id}.mov`,
    durationMs: window.endMs,
    fps: 60,
    width: 1080,
    height: 1080,
    capturedAtIso: '2026-09-04T18:00:00.000Z',
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
    targetSeed: { x: 0.5, y: 0.6, source: 'live_camera_tap' },
    captureEvidence: {
      schemaVersion: 1,
      window: 'detected_motion',
      poseSource: 'apple_vision_body_pose',
      poseModelVersion: 'apple-vision-bodypose-1',
      triggerAlgorithmVersion: 'temporal-stroke-heuristic-2',
      motionUnit: 'normalized_image_units_per_second',
      analysisInputFrameCount: sequence.frames.length,
      poseFrameCount: sequence.frames.length,
      poseMissingFrameCount: 0,
      trackedDurationMs: window.endMs,
      meanCanonicalJointVisibility: 0.9,
      meanJointCoverage: 0.9,
      minimumJointCoverage: 0.8,
      fullBodyVisibleFrameCount: sequence.frames.length,
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
    preRollMs: 2000,
    postRollMs: 1500,
    poseSequence: {
      schemaVersion: 1,
      format: 'pickle.pose-sequence.v1',
      uri: `file:///captures/${id}.pose.json`,
      frameCount: sequence.frames.length,
      sha256: sha256Hex(sidecarJson),
      coordinateSystem: 'normalized_image_top_left',
      poseModelVersion: 'apple-vision-bodypose-1',
    },
  };
  return { clip, sidecarJson };
}

export function importedClipFixture(id: string): ClipFixture {
  const { sequence } = generateSwingSequence();
  const sidecarJson = serializePoseSequence(sequence);
  const clip = assertCapturedClip({
    uri: `file:///private/var/mobile/${id}.mov`,
    durationMs: 4200,
    fps: 30,
    width: 1920,
    height: 1080,
    capturedAtIso: '2026-09-04T12:00:00.000Z',
    captureMode: 'imported_video',
    recognition: { status: 'unknown', reason: 'analysis_not_run' },
    ballSpeed: { status: 'unavailable', reason: 'analysis_not_run' },
  });
  return { clip, sidecarJson };
}

export function extractionFor(
  fixture: ClipFixture,
  id: string,
): ImportedPoseExtraction {
  const frames = JSON.parse(fixture.sidecarJson) as { frames: unknown[] };
  return {
    poseSequence: {
      schemaVersion: 1,
      format: 'pickle.pose-sequence.v1',
      uri: `file:///private/var/mobile/${id}.pose.json`,
      frameCount: frames.frames.length,
      sha256: sha256Hex(fixture.sidecarJson),
      coordinateSystem: 'normalized_image_top_left',
      poseModelVersion: 'apple-vision-bodypose-1',
    },
    framesWithPose: frames.frames.length,
    framesTotal: frames.frames.length,
  };
}

// ─── Payload mutators (malformed / partial variants) ─────────────────────────

function asRecord(value: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

export function malformedClip(clip: CapturedClip, variant: string): unknown {
  const c = asRecord(clip);
  switch (variant) {
    case 'null':
      return null;
    case 'string':
      return 'file:///captures/nope.mov';
    case 'empty_object':
      return {};
    case 'wrong_mode':
      return { ...c, captureMode: 'screen_recording' };
    case 'missing_uri':
      delete c['uri'];
      return c;
    case 'negative_duration':
      return { ...c, durationMs: -1 };
    case 'pose_ref_wrong_type':
      return { ...c, poseSequence: 'file:///captures/pose.json' };
    case 'recognition_garbage':
      return { ...c, recognition: { status: 42 } };
    case 'trigger_nan':
      return {
        ...c,
        trigger: { ...(c['trigger'] as object), confidence: Number.NaN },
      };
    default:
      return { ...c, [variant]: undefined };
  }
}

export function partialClip(clip: CapturedClip, variant: string): unknown {
  const c = asRecord(clip);
  switch (variant) {
    case 'no_pose_sequence':
      delete c['poseSequence'];
      return c;
    case 'no_capture_evidence':
      delete c['captureEvidence'];
      return c;
    case 'no_target_seed':
      delete c['targetSeed'];
      return c;
    case 'no_trigger':
      delete c['trigger'];
      return c;
    default:
      return c;
  }
}

export function malformedSidecar(json: string, variant: string): string {
  switch (variant) {
    case 'not_json':
      return '<html>502 Bad Gateway</html>';
    case 'wrong_format': {
      const parsed = JSON.parse(json) as Record<string, unknown>;
      return JSON.stringify({ ...parsed, format: 'pickle.pose-sequence.v0' });
    }
    case 'frames_not_array': {
      const parsed = JSON.parse(json) as Record<string, unknown>;
      return JSON.stringify({ ...parsed, frames: { length: 3 } });
    }
    case 'one_flipped_byte': {
      const at = Math.floor(json.length / 2);
      const ch = json[at] === '0' ? '9' : '0';
      return json.slice(0, at) + ch + json.slice(at + 1);
    }
    case 'empty_string':
      return '';
    default:
      return json.slice(0, -1);
  }
}

export function partialSidecar(json: string, variant: string): string {
  const parsed = JSON.parse(json) as { frames: Array<Record<string, unknown>> };
  switch (variant) {
    case 'truncated_half':
      return json.slice(0, Math.floor(json.length / 2));
    case 'frames_dropped':
      return JSON.stringify({
        ...parsed,
        frames: parsed.frames.slice(0, Math.max(1, parsed.frames.length >> 2)),
      });
    case 'frame_missing_joints':
      return JSON.stringify({
        ...parsed,
        frames: parsed.frames.map((frame, i) =>
          i % 2 === 0 ? { ...frame, joints: [] } : frame,
        ),
      });
    default:
      return json;
  }
}

export function malformedExtraction(
  good: ImportedPoseExtraction,
  variant: string,
): unknown {
  const e = asRecord(good);
  switch (variant) {
    case 'null':
      return null;
    case 'frames_with_pose_gt_total':
      return { ...e, framesWithPose: (e['framesTotal'] as number) + 5 };
    case 'pose_ref_missing':
      delete e['poseSequence'];
      return e;
    case 'frames_zero':
      return { ...e, framesWithPose: 0, framesTotal: 0 };
    default:
      return e;
  }
}

// ─── Fetch server ────────────────────────────────────────────────────────────

function jsonResponse(body: unknown, status = 200, rawText?: string): Response {
  const text = rawText ?? JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : `HTTP ${status}`,
    headers: { get: () => null },
    json: async () => JSON.parse(text) as unknown,
    text: async () => text,
  } as unknown as Response;
}

export function accessBody(used = 0, reserved = 0): CanonicalAccessState {
  const remaining = 2 - used;
  const available = remaining - reserved;
  return {
    premium: false,
    entitlements: [],
    freeRatings: {
      limit: 2,
      used,
      reserved,
      remaining,
      availableToReserve: available,
    },
    canStartRating: available > 0,
    paywallRequired: available <= 0,
  };
}

function routeOf(url: string, method: string): Route | null {
  const path = url.startsWith(API_BASE_URL)
    ? url.slice(API_BASE_URL.length)
    : url;
  if (path === '/v1/auth/refresh') return 'auth.refresh';
  if (path === '/v1/me/access') return 'access.get';
  if (path === '/v1/analysis-permits' && method === 'POST') {
    return 'permits.reserve';
  }
  if (path.startsWith('/v1/analysis-permits/') && path.endsWith('/finalize')) {
    return 'permits.release';
  }
  if (path === '/v1/shots:sync') return 'shots.sync';
  return null;
}

function malformedPermitBody(variant: string, permitId: string): unknown {
  const good = {
    id: permitId,
    accessSource: 'free',
    status: 'reserved',
    expiresAt: '2026-09-04T20:00:00.000Z',
  };
  switch (variant) {
    case 'permit_null':
      return { permit: null };
    case 'permit_string':
      return { permit: permitId };
    case 'id_empty':
      return { permit: { ...good, id: '' } };
    case 'id_number':
      return { permit: { ...good, id: 12345 } };
    case 'status_consumed':
      return { permit: { ...good, status: 'consumed' } };
    case 'status_released':
      return { permit: { ...good, status: 'released' } };
    case 'missing_expires':
      return {
        permit: { id: permitId, accessSource: 'free', status: 'reserved' },
      };
    case 'access_garbage':
      return { permit: good, access: { freeRatings: 'two' } };
    default:
      return {};
  }
}

function abortError(): Error {
  const error = new Error('The operation was aborted.');
  error.name = 'AbortError';
  return error;
}

/** Resolves with `value` after `delayMs`, or rejects as soon as `signal`
 * aborts — the same contract a real fetch honours. */
function respondLater<T>(
  value: () => T,
  delayMs: number,
  signal: AbortSignal | null | undefined,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    if (delayMs === Number.POSITIVE_INFINITY) return;
    setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      try {
        resolve(value());
      } catch (error) {
        reject(error);
      }
    }, delayMs);
  });
}

// ─── SQLite driver with fault injection ──────────────────────────────────────

interface OpSqliteLike {
  executeSync(sql: string): { rows: Record<string, unknown>[] };
  execute(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[] }>;
  close(): void;
}

// ─── World ───────────────────────────────────────────────────────────────────

export interface WorldOptions {
  plan: FaultPlan;
  /** Called when the fake native bridge emits a camera event. */
  emit: (event: CameraEvent) => void;
}

export class StressWorld {
  readonly plan: FaultPlan;
  readonly log: WorldLog = emptyLog();
  readonly fixture: ClipFixture;
  readonly extraction: ImportedPoseExtraction;
  readonly sqlite: SqliteDatabase;
  readonly consoleErrors: string[] = [];
  readonly keychainStore = new Map<string, string>();
  private readonly emit: (event: CameraEvent) => void;
  private readonly sqlSeen = new Map<string, number>();
  private readonly routeSeen = new Map<Route, number>();
  private readonly rcSeen = new Map<string, number>();
  private permitSeq = 0;
  private bearerSeq = 1;
  private openTransaction = false;

  constructor(options: WorldOptions) {
    this.plan = options.plan;
    this.emit = options.emit;
    const id = `stress-${options.plan.seed}`;
    this.fixture =
      options.plan.source === 'library'
        ? importedClipFixture(id)
        : guidedClipFixture(id);
    this.extraction = extractionFor(this.fixture, id);
    this.sqlite = openMemorySqlite();
  }

  private hit(): void {
    this.log.faultHits += 1;
  }

  // ── op-sqlite driver ─────────────────────────────────────────────────────

  /** What the mocked `@op-engineering/op-sqlite` `open()` returns. */
  opSqlite(): OpSqliteLike {
    const run = (sql: string, params: unknown[] = []) => {
      const trimmed = sql.trim();
      const isQuery = /^(SELECT|PRAGMA|WITH)/i.test(trimmed);
      const statement = this.sqlite.prepare(trimmed);
      const rows = isQuery
        ? statement.all(...(params as (string | number | null)[]))
        : ((statement.run(...(params as (string | number | null)[])),
          []) as Record<string, unknown>[]);
      if (/^BEGIN/i.test(trimmed)) this.openTransaction = true;
      if (/^(COMMIT|ROLLBACK)/i.test(trimmed)) this.openTransaction = false;
      return { rows };
    };
    return {
      executeSync: sql => run(sql),
      execute: async (sql, params = []) => {
        this.log.sqlStatements += 1;
        const fault = this.sqlFaultFor(sql);
        if (fault) {
          this.hit();
          switch (fault.form) {
            case 'throw':
              throw new Error(
                `[stress] SQLite threw synchronously: ${fault.match}`,
              );
            case 'reject':
              await Promise.resolve();
              throw new Error(
                `[stress] SQLITE_BUSY: database is locked (${fault.match})`,
              );
            case 'never':
              return NEVER;
            case 'slow':
              await sleep(fault.delayMs);
              return run(sql, params);
            case 'malformed':
              run(sql, params);
              return {
                rows: [
                  { payload: '{not json', record: '<<binary>>', id: null },
                  { unrelated: 1 },
                ],
              };
          }
        }
        return run(sql, params);
      },
      close: () => this.sqlite.close(),
    };
  }

  private sqlFaultFor(sql: string): SqlFault | null {
    for (const fault of this.plan.sql) {
      if (!new RegExp(fault.match, 'i').test(sql)) continue;
      const seen = (this.sqlSeen.get(fault.match) ?? 0) + 1;
      this.sqlSeen.set(fault.match, seen);
      if (seen === fault.onNth) return fault;
    }
    return null;
  }

  // ── fetch ────────────────────────────────────────────────────────────────

  fetch = async (
    input: string | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const route = routeOf(url, method);
    this.log.fetchCalls.push(`${method} ${url.replace(API_BASE_URL, '')}`);
    if (!route) {
      throw new Error(`[stress] Unexpected fetch ${method} ${url}`);
    }
    const seen = (this.routeSeen.get(route) ?? 0) + 1;
    this.routeSeen.set(route, seen);
    const fault = this.plan.fetch.find(
      f => f.route === route && f.onNth === seen,
    );
    const body = init?.body !== undefined ? String(init.body) : '';
    if (fault) {
      this.hit();
      return this.faultedResponse(route, fault, body, init?.signal);
    }
    return this.okResponse(route, body);
  };

  private okResponse(route: Route, body: string): Response {
    switch (route) {
      case 'auth.refresh': {
        this.bearerSeq += 1;
        return jsonResponse({
          session: {
            accessToken: `bearer-stress-${this.bearerSeq}`,
            refreshToken: `refresh-stress-${this.bearerSeq}`,
            expiresAt: Math.floor(Date.now() / 1000) + 3600,
          },
        });
      }
      case 'access.get': {
        const used = Math.min(2, this.log.syncedShots.length);
        const reserved = Math.max(
          0,
          Math.min(
            2 - used,
            this.log.reservedPermits.length -
              this.log.releasedPermits.length -
              this.log.syncedShots.length,
          ),
        );
        return jsonResponse(accessBody(used, reserved));
      }
      case 'permits.reserve': {
        this.permitSeq += 1;
        const id = `permit-${this.plan.seed}-${this.permitSeq}`;
        this.log.reservedPermits.push(id);
        return jsonResponse({
          permit: {
            id,
            accessSource: 'free',
            status: 'reserved',
            expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
          },
          access: accessBody(0, 1),
        });
      }
      case 'permits.release': {
        const parsed = JSON.parse(body || '{}') as { outcome?: string };
        const id =
          this.log.reservedPermits[this.log.reservedPermits.length - 1] ?? '?';
        this.log.releasedPermits.push({ id, outcome: parsed.outcome ?? '?' });
        return jsonResponse({ ok: true });
      }
      case 'shots.sync': {
        const parsed = JSON.parse(body || '{}') as {
          shots?: Array<{ id: string }>;
        };
        const accepted = (parsed.shots ?? []).map(s => s.id);
        this.log.syncedShots.push(...accepted);
        return jsonResponse({ acceptedIds: accepted, rejected: [] });
      }
    }
  }

  private faultedResponse(
    route: Route,
    fault: RouteFault,
    body: string,
    signal: AbortSignal | null | undefined,
  ): Promise<Response> {
    switch (fault.form) {
      case 'reject':
        return respondLater<Response>(
          () => {
            throw new TypeError('Network request failed');
          },
          fault.delayMs,
          signal,
        );
      case 'never':
        return respondLater(
          () => this.okResponse(route, body),
          Number.POSITIVE_INFINITY,
          signal,
        );
      case 'slow':
        return respondLater(
          () => this.okResponse(route, body),
          fault.delayMs,
          signal,
        );
      case 'malformed_json':
        return respondLater(
          () => jsonResponse(null, 200, '{"permit": {"id": "half'),
          fault.delayMs,
          signal,
        );
      case 'malformed_body':
      case 'partial_body':
        return respondLater(
          () =>
            route === 'permits.reserve'
              ? jsonResponse(
                  malformedPermitBody(
                    fault.variant,
                    `permit-m-${this.plan.seed}`,
                  ),
                )
              : route === 'auth.refresh'
                ? jsonResponse({
                    session: { accessToken: '', refreshToken: 7 },
                  })
                : route === 'access.get'
                  ? jsonResponse({ premium: 'yes', freeRatings: { limit: 3 } })
                  : jsonResponse({ accepted: 'all', rejected: null }),
          fault.delayMs,
          signal,
        );
      case 'status':
        return respondLater(
          () =>
            jsonResponse(
              {
                error: {
                  code:
                    fault.status === 402
                      ? 'access.paywall_required'
                      : fault.status === 401
                        ? 'auth.invalid_token'
                        : fault.status === 429
                          ? 'rate.limited'
                          : 'internal',
                  message: `[stress] ${route} ${fault.status}`,
                },
              },
              fault.status,
            ),
          fault.delayMs,
          signal,
        );
    }
  }

  // ── native camera bridge ─────────────────────────────────────────────────

  private async seam<T>(
    name: string,
    behaviour: SeamBehaviour,
    good: () => T,
    malformed: (variant: string) => unknown,
    partial: (variant: string) => unknown,
    validate: (value: unknown) => T,
  ): Promise<T> {
    this.log.bridgeCalls.push(name);
    switch (behaviour.mode) {
      case 'ok':
        // Baseline plans carry a sub-second realism delay; anything at or
        // above SLOW_SEAM_MS is the injected `slow` fault.
        if (behaviour.delayMs >= SLOW_SEAM_MS) this.hit();
        if (behaviour.delayMs > 0) await sleep(behaviour.delayMs);
        return good();
      case 'throw':
        this.hit();
        throw new NativeBridgeError(behaviour.message, null);
      case 'reject':
        this.hit();
        await sleep(behaviour.delayMs);
        throw new NativeBridgeError(behaviour.message, behaviour.code);
      case 'never':
        this.hit();
        return NEVER;
      case 'malformed':
        this.hit();
        await sleep(behaviour.delayMs);
        return validate(malformed(behaviour.variant));
      case 'partial':
        this.hit();
        await sleep(behaviour.delayMs);
        return validate(partial(behaviour.variant));
    }
  }

  private async runPermissionScript(): Promise<
    'ok' | 'reject_denied' | 'never'
  > {
    const script = this.plan.permission;
    if (!script) return 'ok';
    this.hit();
    for (const state of script.events) {
      await sleep(
        Math.max(
          0,
          Math.floor(script.denyAfterMs / Math.max(1, script.events.length)),
        ),
      );
      if (state === 'malformed') {
        this.emit({ type: 'permission', state: 42 } as unknown as CameraEvent);
        this.emit({} as unknown as CameraEvent);
        this.emit({
          type: 'readiness',
          state: 'flying',
        } as unknown as CameraEvent);
      } else {
        this.emit({
          type: 'permission',
          state,
          emittedAtIso: new Date().toISOString(),
        });
      }
    }
    return script.outcome;
  }

  captureStrokeVideo = async (): Promise<CapturedClip> => {
    this.log.bridgeCalls.push('captureStrokeVideo');
    const permission = await this.runPermissionScript();
    if (permission === 'never') return NEVER;
    if (permission === 'reject_denied') {
      throw new NativeBridgeError(
        'Camera access is off for Pickle Sensei. Turn it on in Settings to record a stroke.',
        'camera.permission_denied',
      );
    }
    this.emit({
      type: 'readiness',
      state: 'ready',
      jointCoverage: 0.9,
      emittedAtIso: new Date().toISOString(),
    } as unknown as CameraEvent);
    return this.seam(
      'captureStrokeVideo:bridge',
      this.plan.capture,
      () => this.fixture.clip,
      variant => malformedClip(this.fixture.clip, variant),
      variant => partialClip(this.fixture.clip, variant),
      value => assertCapturedClip(value, 'automatic_pose_trigger'),
    );
  };

  importStrokeVideo = async (): Promise<CapturedClip> => {
    return this.seam(
      'importStrokeVideo',
      this.plan.capture,
      () => this.fixture.clip,
      variant => malformedClip(this.fixture.clip, variant),
      variant => partialClip(this.fixture.clip, variant),
      value => assertCapturedClip(value, 'imported_video'),
    );
  };

  extractImportedPoseSequence = async (): Promise<ImportedPoseExtraction> => {
    return this.seam(
      'extractImportedPoseSequence',
      this.plan.extraction,
      () => this.extraction,
      variant => malformedExtraction(this.extraction, variant),
      () => ({ ...this.extraction, framesWithPose: 1 }),
      value => assertImportedPoseExtraction(value),
    );
  };

  readCaptureArtifact = async (uri: string): Promise<string> => {
    return this.seam(
      `readCaptureArtifact:${uri.split('/').pop() ?? uri}`,
      this.plan.readTextFile,
      () => this.fixture.sidecarJson,
      variant => malformedSidecar(this.fixture.sidecarJson, variant),
      variant => partialSidecar(this.fixture.sidecarJson, variant),
      value => value as string,
    );
  };

  cancelCameraOperation = (): void => {
    this.log.cancelCalls += 1;
  };

  // ── Keychain ─────────────────────────────────────────────────────────────

  private async keychainDelay(fault: KeychainFault | null, op: 'get' | 'set') {
    if (!fault || fault.op !== op) return null;
    this.hit();
    return fault;
  }

  keychain = {
    ACCESSIBLE: {
      AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'afterFirstUnlockThisDeviceOnly',
    },
    setGenericPassword: async (
      username: string,
      password: string,
      options?: { service?: string },
    ): Promise<false | { service: string; storage: string }> => {
      this.log.keychainWrites += 1;
      const fault = await this.keychainDelay(this.plan.keychain, 'set');
      if (fault && fault.op === 'set') {
        if (fault.form === 'throw') {
          throw new Error(
            '[stress] Keychain errSecInteractionNotAllowed (-25308)',
          );
        }
        await Promise.resolve();
        throw new Error('[stress] Keychain errSecIO (-36)');
      }
      this.keychainStore.set(
        options?.service ?? 'default',
        JSON.stringify({ username, password }),
      );
      return { service: options?.service ?? 'default', storage: 'keychain' };
    },
    getGenericPassword: async (options?: {
      service?: string;
    }): Promise<
      | false
      | { service: string; username: string; password: string; storage: string }
    > => {
      this.log.keychainReads += 1;
      const fault = await this.keychainDelay(this.plan.keychain, 'get');
      const service = options?.service ?? 'default';
      if (fault && fault.op === 'get') {
        switch (fault.form) {
          case 'reject':
            await sleep(fault.delayMs);
            throw new Error('[stress] Keychain errSecAuthFailed (-25293)');
          case 'never':
            return NEVER;
          case 'slow':
            await sleep(fault.delayMs);
            break;
          case 'malformed':
            return {
              service,
              username: 'session',
              password: malformedVaultRecord(fault.variant),
              storage: 'keychain',
            };
        }
      }
      const stored = this.keychainStore.get(service);
      if (!stored) return false;
      const parsed = JSON.parse(stored) as {
        username: string;
        password: string;
      };
      return { service, ...parsed, storage: 'keychain' };
    },
    resetGenericPassword: async (options?: {
      service?: string;
    }): Promise<boolean> => {
      this.keychainStore.delete(options?.service ?? 'default');
      return true;
    },
  };

  // ── RevenueCat SDK ───────────────────────────────────────────────────────

  private async rcFault(
    method: RevenueCatFault['method'],
  ): Promise<RevenueCatFault | null> {
    const fault = this.plan.revenueCat;
    if (!fault || fault.method !== method) return null;
    const seen = (this.rcSeen.get(method) ?? 0) + 1;
    this.rcSeen.set(method, seen);
    this.hit();
    switch (fault.form) {
      case 'throw':
        throw new Error(
          `[stress] RevenueCat ${method} threw: SDK not initialized`,
        );
      case 'reject':
        await sleep(fault.delayMs);
        throw new Error(
          `[stress] RevenueCat ${method} rejected: NETWORK_ERROR`,
        );
      case 'never':
        await NEVER;
        return fault;
      case 'slow':
        await sleep(fault.delayMs);
        return fault;
      case 'malformed':
      case 'partial':
        return fault;
    }
  }

  private package(
    id: string,
    type: string,
  ): {
    identifier: string;
    packageType: string;
    product: {
      identifier: string;
      price: number;
      priceString: string;
      pricePerMonthString: string | null;
      introPrice: null;
      defaultOption: null;
    };
  } {
    const price =
      type === 'ANNUAL' ? 59.99 : type === 'MONTHLY' ? 7.99 : 159.99;
    return {
      identifier: `$rc_${type.toLowerCase()}`,
      packageType: type,
      product: {
        identifier: id,
        price,
        priceString: `$${price.toFixed(2)}`,
        pricePerMonthString: type === 'ANNUAL' ? '$5.00' : null,
        introPrice: null,
        defaultOption: null,
      },
    };
  }

  private rcConfigured = false;
  private rcAppUserId: string | null = null;

  revenueCat: RevenueCatSdk = {
    isConfigured: async () => {
      await this.rcFault('isConfigured');
      return this.rcConfigured;
    },
    configure: async ({ appUserID }) => {
      await this.rcFault('configure');
      this.rcConfigured = true;
      this.rcAppUserId = appUserID;
    },
    getAppUserID: async () => {
      const fault = await this.rcFault('getAppUserID');
      if (fault?.form === 'partial') return '$RCAnonymousID:stress';
      return this.rcAppUserId ?? '$RCAnonymousID:unset';
    },
    logIn: async appUserID => {
      await this.rcFault('logIn');
      this.rcAppUserId = appUserID;
      return { customerInfo: { entitlements: { active: {} } } };
    },
    getOfferings: async () => {
      const fault = await this.rcFault('getOfferings');
      if (fault?.form === 'malformed') {
        switch (fault.variant) {
          case 'offerings_null_current':
            return { current: null };
          case 'offerings_garbage':
            return { current: 'default' } as unknown as Awaited<
              ReturnType<RevenueCatSdk['getOfferings']>
            >;
          case 'packages_all_null':
            return {
              current: {
                identifier: 'default',
                annual: null,
                monthly: null,
                lifetime: null,
              },
            };
          case 'price_string':
            return {
              current: {
                identifier: 'default',
                annual: {
                  ...this.package('pickle_sensei_pro_yearly', 'ANNUAL'),
                  product: {
                    ...this.package('pickle_sensei_pro_yearly', 'ANNUAL')
                      .product,
                    price: '59.99' as unknown as number,
                  },
                },
                monthly: null,
                lifetime: null,
              },
            };
        }
      }
      return {
        current: {
          identifier: 'default',
          annual: this.package('pickle_sensei_pro_yearly', 'ANNUAL'),
          monthly: this.package('pickle_sensei_pro_monthly', 'MONTHLY'),
          lifetime: this.package('pickle_sensei_pro_lifetime', 'LIFETIME'),
        },
      };
    },
    purchasePackage: async () => {
      throw new Error('[stress] purchase is out of scope for AnalyzeScreen');
    },
    restorePurchases: async () => {
      throw new Error('[stress] restore is out of scope for AnalyzeScreen');
    },
    getCustomerInfo: async () =>
      ({
        entitlements: { active: {} },
      }) as unknown as Awaited<ReturnType<RevenueCatSdk['getCustomerInfo']>>,
    checkTrialOrIntroductoryPriceEligibility: async ids => {
      await this.rcFault('checkTrialOrIntroductoryPriceEligibility');
      return Object.fromEntries(ids.map(id => [id, { status: 2 }]));
    },
  };

  // ── Vision providers ─────────────────────────────────────────────────────

  /** Wraps the production provider bundle according to the vision fault. */
  wrapProviders(
    resolved:
      | { kind: 'real'; providers: FusionProviders }
      | { kind: 'unavailable'; reason: string },
  ):
    | { kind: 'real'; providers: FusionProviders }
    | { kind: 'unavailable'; reason: string } {
    const fault: VisionFault | null = this.plan.vision;
    if (!fault) return resolved;
    this.hit();
    if (fault.target === 'registry' || resolved.kind !== 'real') {
      return {
        kind: 'unavailable',
        reason:
          'A required analysis provider is missing from the model registry.',
      };
    }
    const providers = { ...resolved.providers };
    const wrap = <A extends unknown[], R>(
      original: (...args: A) => Promise<Result<R>>,
    ) => {
      return async (...args: A): Promise<Result<R>> => {
        switch (fault.form) {
          case 'throw':
            throw new Error(`[stress] ${fault.target} provider threw`);
          case 'reject':
            await sleep(fault.delayMs);
            throw new Error(`[stress] ${fault.target} provider rejected`);
          case 'never':
            return NEVER;
          case 'slow':
            await sleep(fault.delayMs);
            return original(...args);
          case 'malformed':
            return malformedResult<R>(fault.variant);
          case 'partial': {
            const result = await original(...args);
            if (!result.ok) return result;
            const value = result.value;
            return {
              ok: true,
              value: (Array.isArray(value)
                ? value.slice(0, Math.max(0, value.length >> 1))
                : value) as R,
            };
          }
          case 'unavailable':
            return original(...args);
        }
      };
    };
    switch (fault.target) {
      case 'phase':
        providers.phase = {
          ...providers.phase,
          segmentPhases: wrap(
            providers.phase.segmentPhases.bind(providers.phase),
          ),
        };
        break;
      case 'biomechanics':
        providers.biomechanics = {
          ...providers.biomechanics,
          extract: wrap(
            providers.biomechanics.extract.bind(providers.biomechanics),
          ),
        };
        break;
      case 'scorer':
        providers.scorer = {
          ...providers.scorer,
          score: wrap(providers.scorer.score.bind(providers.scorer)),
        };
        break;
      case 'faultDetector':
        providers.faultDetector = {
          ...providers.faultDetector,
          detectFaults: wrap(
            providers.faultDetector.detectFaults.bind(providers.faultDetector),
          ),
        };
        break;
      case 'coach':
        providers.coach = {
          ...providers.coach,
          rank: wrap(providers.coach.rank.bind(providers.coach)),
        };
        break;
    }
    return { kind: 'real', providers };
  }

  // ── Persistence integrity ────────────────────────────────────────────────

  snapshot(): PersistenceSnapshot {
    const one = (sql: string) => {
      const row = this.sqlite.prepare(sql).all()[0] ?? {};
      return Number(Object.values(row)[0] ?? 0);
    };
    const integrity = String(
      Object.values(
        this.sqlite.prepare('PRAGMA integrity_check').all()[0] ?? {},
      )[0] ?? 'missing',
    );
    const parsable = (table: string, column: string) => {
      let bad = 0;
      for (const row of this.sqlite
        .prepare(`SELECT ${column} AS v FROM ${table}`)
        .all()) {
        try {
          const v = row['v'];
          if (v === null || v === undefined) continue;
          JSON.parse(String(v));
        } catch {
          bad += 1;
        }
      }
      return bad;
    };
    const scoredWithoutOutboxOrReceipt = one(
      `SELECT count(*) FROM local_shot s
       WHERE s.result_kind = 'scored'
         AND NOT EXISTS (
           SELECT 1 FROM outbox o
           WHERE o.owner_key = s.owner_key AND o.kind = 'shot.sync'
             AND json_valid(o.payload) AND json_extract(o.payload, '$.id') = s.id)
         AND NOT EXISTS (
           SELECT 1 FROM sync_receipt r
           WHERE r.owner_key = s.owner_key AND r.kind = 'shot.sync' AND r.entity_id = s.id)`,
    );
    return {
      backend: 'node:sqlite',
      integrity,
      openTransaction: this.openTransaction,
      captures: one('SELECT count(*) FROM local_capture'),
      analysisRecords: one('SELECT count(*) FROM local_analysis_record'),
      shots: one('SELECT count(*) FROM local_shot'),
      outboxShotSync: one(
        `SELECT count(*) FROM outbox WHERE kind = 'shot.sync'`,
      ),
      syncReceipts: one('SELECT count(*) FROM sync_receipt'),
      unparsablePayloads:
        parsable('local_shot', 'payload') +
        parsable('local_capture', 'payload') +
        parsable('local_analysis_record', 'record') +
        parsable('outbox', 'payload'),
      shotsWithoutOutboxOrReceipt: scoredWithoutOutboxOrReceipt,
      shotScores: this.sqlite
        .prepare(
          `SELECT overall_score FROM local_shot WHERE result_kind = 'scored'`,
        )
        .all()
        .map(row => Number(row['overall_score'])),
    };
  }

  /** Statuses of every capture row — a capture must be either still awaiting
   * the model or analyzed, and an analyzed capture must own a record. */
  captureRows(): Array<{ id: string; status: string; records: number }> {
    return this.sqlite
      .prepare(
        `SELECT c.id AS id, c.status AS status,
                (SELECT count(*) FROM local_analysis_record r WHERE r.capture_id = c.id) AS records
         FROM local_capture c`,
      )
      .all()
      .map(row => ({
        id: String(row['id']),
        status: String(row['status']),
        records: Number(row['records']),
      }));
  }

  close(): void {
    try {
      this.sqlite.close();
    } catch {
      // Already closed by getDb().close().
    }
  }
}

function malformedVaultRecord(variant: string): string {
  switch (variant) {
    case 'not_json':
      return '\u0000\u0001binary';
    case 'version_2':
      return JSON.stringify({
        version: 2,
        provider: 'apple',
        canonicalAppUserId: OWNER,
        refreshToken: REFRESH_1,
      });
    case 'empty_refresh':
      return JSON.stringify({
        version: 1,
        provider: 'apple',
        canonicalAppUserId: OWNER,
        refreshToken: '',
        email: null,
        displayName: null,
      });
    case 'provider_guest':
      return JSON.stringify({
        version: 1,
        provider: 'guest',
        canonicalAppUserId: OWNER,
        refreshToken: REFRESH_1,
      });
    case 'array':
      return JSON.stringify([1, 2, 3]);
    default:
      return '{';
  }
}

function malformedResult<R>(variant: string): Result<R> {
  switch (variant) {
    case 'ok_null_value':
      return { ok: true, value: null as unknown as R };
    case 'ok_garbage_value':
      return { ok: true, value: 'garbage' as unknown as R };
    case 'nan_confidence':
      return {
        ok: true,
        value: {
          overallScore: Number.NaN,
          checkpoints: [],
          analysisConfidence: Number.NaN,
          presentation: 'normal',
          guidance: null,
          checkpointEvidence: [],
          internal: null,
        } as unknown as R,
      };
    case 'score_out_of_range':
      return {
        ok: true,
        value: {
          overallScore: 1400,
          checkpoints: [
            { checkpoint: 'contact_point', score: 250, confidence: 3 },
          ],
          analysisConfidence: 7,
          presentation: 'normal',
          guidance: null,
          checkpointEvidence: [],
          internal: null,
        } as unknown as R,
      };
    case 'empty_checkpoints':
      return {
        ok: true,
        value: {
          overallScore: 71,
          checkpoints: [],
          analysisConfidence: 0.9,
          presentation: 'normal',
          guidance: null,
          checkpointEvidence: [],
          internal: null,
        } as unknown as R,
      };
    case 'not_a_result':
    default:
      return { status: 'done' } as unknown as Result<R>;
  }
}
