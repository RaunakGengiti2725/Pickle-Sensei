/**
 * STRESS — unit `mod-run-capture-analysis`, lens `boundary-malformed`.
 *
 * Seeded campaign against `runCaptureAnalysis` with malformed / boundary
 * input at every untrusted seam the function reads:
 *
 *   A. sidecar wire — hash-consistent mutations of a canonical pose-sequence
 *      JSON (truncation, wrong types, prototype-pollution keys, NaN /
 *      Infinity / -0 / overflow literals, null bytes, 64KB+ strings, path
 *      traversal, future schema versions, empty arrays/objects, unicode
 *      normalization pairs, non-monotonic / duplicated / dropped frames).
 *   B. permit server — fuzzed HTTP status + body for reserve and finalize.
 *   C. request fields — declared stroke / handedness / camera view / ids /
 *      envelope / telemetry / clip trigger boundaries.
 *   E. concurrent mixed batches with provider throws — permit accounting
 *      under interleaving.
 *
 * Invariants asserted for EVERY iteration:
 *   - the promise settles with a typed `CaptureAnalysisOutcome` (a provider
 *     throw is the documented exception and is asserted separately);
 *   - `reason` strings never leak `undefined` / `[object Object]`; blank,
 *     oversized (>4KB) or null-byte-bearing reasons are RECORDED as
 *     observations in the JSON table (they echo server / caller input);
 *   - no permit is reserved before the sidecar parses and the stroke gate
 *     passes; a reserved permit is consumed by a scored save or finalized
 *     exactly once with the matching outcome, never both, never twice;
 *   - no durable write (local_shot / outbox / analysis record) unless the
 *     outcome is scored or low_confidence, and low_confidence never reaches
 *     the sync outbox;
 *   - persisted scores are finite and in range;
 *   - `Object.prototype` is not polluted.
 *
 * Replay: every iteration derives from `STRESS_SEED` (default 20260905) and
 * its campaign/index; `STRESS_REPLAY=A:17` runs exactly one iteration.
 * Scale: `STRESS_ITER=<n>` iterations per campaign (default 30 keeps the
 * suite fast). `STRESS_OUT=<dir>` writes the seed → outcome JSON table.
 */
import * as fs from 'fs';
import * as path from 'path';
import { Platform } from 'react-native';
import { SHOT_TYPES, type EnvelopeVerdict } from '@pickle/shared-types';
import { generateSwingSequence } from '@pickle/evaluation';
import { serializePoseSequence, sha256Hex } from '@pickle/swing-domain';
import type { CapturedClip } from '../../src/camera/capture';
import type { LocalDb } from '../../src/data/db';
import { useApiSessionStore } from '../../src/account/apiSession';
import {
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import {
  runCaptureAnalysis,
  type CaptureAnalysisOutcome,
  type RunCaptureAnalysisRequest,
} from '../../src/analysis/runCaptureAnalysis';
import { stabilitySlo } from '../../src/analysis/stabilityTelemetry';
import * as pipeline from '@pickle/analysis-pipeline';

// Spread the real pipeline so `jest.spyOn(pipeline, 'analyzeCapture')` can
// inject a provider throw AFTER the permit is reserved (campaign E).
jest.mock('@pickle/analysis-pipeline', () => {
  const actual = jest.requireActual('@pickle/analysis-pipeline');
  return { __esModule: true, ...actual };
});

let mockReadArtifact: (uri: string) => Promise<string> = async () => '';
jest.mock('../../src/camera/capture', () => {
  const actual = jest.requireActual('../../src/camera/capture');
  return {
    ...actual,
    readCaptureArtifact: (uri: string) => mockReadArtifact(uri),
  };
});

// ─── Seeded RNG (mulberry32; identical stream for identical seed) ───────────

function hashSeed(label: string): number {
  let h = 2166136261;
  for (let i = 0; i < label.length; i++) {
    h ^= label.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

class Rng {
  private state: number;
  constructor(seed: number) {
    this.state = seed >>> 0 || 0x9e3779b9;
  }
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
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
  pick<T>(items: readonly T[]): T {
    return items[this.int(0, items.length - 1)] as T;
  }
  shuffle<T>(items: T[]): T[] {
    for (let i = items.length - 1; i > 0; i--) {
      const j = this.int(0, i);
      const tmp = items[i] as T;
      items[i] = items[j] as T;
      items[j] = tmp;
    }
    return items;
  }
}

// ─── Boundary payload vocabularies ──────────────────────────────────────────

const BIG = 64 * 1024;
const NULL_BYTE = '\u0000';
const NFC_E = '\u00e9'; // é composed
const NFD_E = 'e\u0301'; // é decomposed
const HANGUL_NFC = '\uD55C';
const HANGUL_NFD = '\u1112\u1161\u11AB';
const ZALGO = 'a\u0300\u0301\u0302\u0303\u0304\u0305\u0306\u0307\u0308';
const FAMILY = '\uD83D\uDC68\u200D\uD83D\uDC69\u200D\uD83D\uDC67'; // 1 grapheme, 8 code units
const LONE_SURROGATE = '\uD800';
const RTL_OVERRIDE = '\u202Eabc\u202C';
const TRAVERSALS = [
  '../../etc/passwd',
  '..\\..\\windows\\system32',
  '%2e%2e%2f%2e%2e%2fetc',
  '/etc/passwd',
  'file:///etc/passwd',
  'a/b/../../c',
  '....//....//',
  '\u2025\u2025/', // two-dot leader look-alike
];
const POLLUTION_KEYS = ['__proto__', 'constructor', 'prototype'];

function bigString(rng: Rng): string {
  const unit = rng.pick([
    'a',
    NFC_E,
    NFD_E,
    FAMILY,
    ZALGO,
    NULL_BYTE,
    '\u{1F4A5}',
    ' ',
  ]);
  // Exceed 64KB in UTF-16 code units, bytes AND graphemes alike.
  const repeat = Math.ceil((BIG + rng.int(0, 4096)) / unit.length);
  return unit.repeat(repeat);
}

function weirdString(rng: Rng): string {
  return rng.pick<string>([
    '',
    ' ',
    '\n\t\r',
    NULL_BYTE,
    `serve${NULL_BYTE}`,
    `${NULL_BYTE}serve`,
    NFC_E,
    NFD_E,
    HANGUL_NFC,
    HANGUL_NFD,
    ZALGO,
    FAMILY,
    LONE_SURROGATE,
    RTL_OVERRIDE,
    '\uFEFF',
    '\uFFFF',
    '\uFFFE',
    rng.pick(TRAVERSALS),
    rng.pick(POLLUTION_KEYS),
    '${jndi:ldap://x}',
    "'; DROP TABLE local_shot; --",
    '<script>alert(1)</script>',
    'NaN',
    'Infinity',
    '-0',
    '1e999',
    'null',
    'undefined',
    '[object Object]',
    'true',
    '0',
    '-1',
    '9007199254740993',
    bigString(rng),
  ]);
}

function weirdNumber(rng: Rng): number {
  return rng.pick<number>([
    NaN,
    Infinity,
    -Infinity,
    -0,
    0,
    -1,
    1e308,
    -1e308,
    5e-324,
    Number.MAX_SAFE_INTEGER,
    Number.MAX_SAFE_INTEGER + 2,
    Number.MIN_SAFE_INTEGER - 2,
    2 ** 31,
    2 ** 32,
    -(2 ** 31) - 1,
    0.1 + 0.2,
    1e-300,
    123456789012345680000,
  ]);
}

/** A value of the "wrong" JS type for any slot. */
function wrongType(rng: Rng): unknown {
  return rng.pick<unknown>([
    null,
    undefined,
    true,
    false,
    weirdNumber(rng),
    weirdString(rng),
    [],
    {},
    [null],
    [[]],
    { length: 1 },
    { toString: null },
    Object.create(null),
    () => 'fn',
    Symbol('s'),
    new Date(NaN),
    BigInt(1),
  ]);
}

/** Same as wrongType but JSON-representable (for sidecar wire mutations). */
function wrongJsonType(rng: Rng): unknown {
  return rng.pick<unknown>([
    null,
    true,
    false,
    -1,
    0,
    1.5,
    1e308,
    weirdString(rng),
    [],
    {},
    [null],
    [[]],
    { length: 1 },
    { [rng.pick(POLLUTION_KEYS)]: { polluted: true } },
  ]);
}

// ─── Fixtures ───────────────────────────────────────────────────────────────

const { sequence, window } = generateSwingSequence({});
const CANONICAL_SIDECAR = serializePoseSequence(sequence);
const CANONICAL_SHA = sha256Hex(CANONICAL_SIDECAR);

function clipFor(sidecarJson: string, sha: string = sha256Hex(sidecarJson)) {
  const clip: CapturedClip = {
    uri: 'file:///tmp/stress.mov',
    durationMs: window.endMs,
    fps: 60,
    width: 1080,
    height: 1080,
    capturedAtIso: '2026-09-05T00:00:00.000Z',
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
      poseModelVersion: sequence.producedBy.modelVersion,
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
    preRollMs: 400,
    postRollMs: 300,
    poseSequence: {
      schemaVersion: 1,
      format: 'pickle.pose-sequence.v1',
      uri: 'file:///tmp/stress.pose.json',
      frameCount: sequence.frames.length,
      sha256: sha,
      coordinateSystem: 'normalized_image_top_left',
      poseModelVersion: sequence.producedBy.modelVersion,
    },
  };
  return clip;
}

interface RecordedCall {
  sql: string;
  params: unknown[];
}

function recordingDb(): { db: LocalDb; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const db: LocalDb = {
    async execute(sql, params = []) {
      calls.push({ sql, params: [...params] });
      return { rows: [] };
    },
    close() {},
  };
  return { db, calls };
}

interface WriteSummary {
  shots: RecordedCall[];
  /** `shot.sync` outbox rows (the only kind a scored save may enqueue). */
  outbox: RecordedCall[];
  /** `evaluation.trial` outbox rows — consent-gated telemetry. */
  trials: RecordedCall[];
  records: RecordedCall[];
  begins: number;
  commits: number;
  rollbacks: number;
  total: number;
  /** Every DB call except consent-gated `evaluation.trial` outbox rows. */
  durable: number;
}

function summarizeWrites(calls: RecordedCall[]): WriteSummary {
  const has = (frag: string) => (c: RecordedCall) => c.sql.includes(frag);
  return {
    shots: calls.filter(has('INTO local_shot')),
    outbox: calls.filter(
      c => has('INSERT INTO outbox')(c) && c.sql.includes("'shot.sync'"),
    ),
    trials: calls.filter(
      c => has('INSERT INTO outbox')(c) && c.sql.includes("'evaluation.trial'"),
    ),
    records: calls.filter(has('local_analysis_record')),
    begins: calls.filter(c => c.sql.trim().startsWith('BEGIN')).length,
    commits: calls.filter(c => c.sql.trim().startsWith('COMMIT')).length,
    rollbacks: calls.filter(c => c.sql.trim().startsWith('ROLLBACK')).length,
    total: calls.length,
    durable: calls.filter(
      c =>
        !(
          c.sql.includes('INSERT INTO outbox') &&
          c.sql.includes("'evaluation.trial'")
        ),
    ).length,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : `HTTP ${status}`,
    json: async () => body,
  } as unknown as Response;
}

function brokenJsonResponse(status: number): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: `HTTP ${status}`,
    json: async () => {
      throw new SyntaxError('Unexpected token < in JSON at position 0');
    },
  } as unknown as Response;
}

interface PermitServerCall {
  method: string;
  url: string;
  body: unknown;
  idempotencyKey: string | null;
  /** Set on reserve calls: the server handed out a contract-valid permit. */
  granted?: boolean;
}

/** Mirrors the client contract in data/api.ts parseReservedPermit. */
function isGrantedPermitResponse(response: Response, body: unknown): boolean {
  if (!(response.status >= 200 && response.status < 300)) return false;
  if (typeof body !== 'object' || body === null) return false;
  const permit = (body as { permit?: unknown }).permit;
  if (typeof permit !== 'object' || permit === null) return false;
  const p = permit as Record<string, unknown>;
  return (
    typeof p.id === 'string' &&
    p.id.trim().length > 0 &&
    (p.accessSource === 'free' || p.accessSource === 'premium') &&
    p.status === 'reserved' &&
    typeof p.expiresAt === 'string'
  );
}

interface PermitServer {
  fetch: jest.Mock<Promise<Response>, [RequestInfo | URL, RequestInit?]>;
  reserves: PermitServerCall[];
  finalizes: PermitServerCall[];
  others: PermitServerCall[];
}

type ReserveResponder = (call: PermitServerCall, n: number) => Response;
type FinalizeResponder = (call: PermitServerCall, n: number) => Response;

function validPermitBody(id: string, extra: Record<string, unknown> = {}) {
  return {
    permit: {
      id,
      accessSource: 'free',
      status: 'reserved',
      expiresAt: '2099-01-01T00:00:00.000Z',
    },
    access: {
      premium: false,
      freeRatings: {
        limit: 3,
        used: 0,
        reserved: 1,
        remaining: 3,
        availableToReserve: 2,
      },
    },
    ...extra,
  };
}

function permitServer(
  reserve: ReserveResponder = (c, n) =>
    jsonResponse(validPermitBody(`permit-${n}-${c.idempotencyKey ?? 'k'}`)),
  finalize: FinalizeResponder = () => jsonResponse({ ok: true }),
): PermitServer {
  const reserves: PermitServerCall[] = [];
  const finalizes: PermitServerCall[] = [];
  const others: PermitServerCall[] = [];
  const fetchMock = jest.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      let body: unknown = null;
      if (typeof init?.body === 'string') {
        try {
          body = JSON.parse(init.body);
        } catch {
          body = init.body;
        }
      }
      const key =
        typeof body === 'object' && body !== null
          ? (body as { idempotencyKey?: unknown }).idempotencyKey
          : undefined;
      const call: PermitServerCall = {
        method,
        url,
        body,
        idempotencyKey: typeof key === 'string' ? key : null,
      };
      if (url.includes('/analysis-permits') && method === 'POST') {
        if (url.includes('/finalize')) {
          finalizes.push(call);
          return finalize(call, finalizes.length);
        }
        reserves.push(call);
        const response = reserve(call, reserves.length);
        let parsed: unknown = null;
        try {
          parsed = await response.json();
        } catch {
          parsed = null;
        }
        call.granted = isGrantedPermitResponse(response, parsed);
        return response;
      }
      others.push(call);
      return jsonResponse({ error: 'unexpected' }, 404);
    },
  );
  return { fetch: fetchMock, reserves, finalizes, others };
}

const BASE_REQUEST = (
  clip: CapturedClip,
  db: LocalDb,
): RunCaptureAnalysisRequest => ({
  db,
  clip,
  captureId: 'capture-stress',
  declaredStroke: 'forehand_drive',
  handedness: 'right',
  cameraView: 'side',
  appVersion: '0.1.0-stress',
  apiConfig: { baseUrl: 'https://stress.invalid', token: 'stress-token' },
  sessionId: null,
  captureEnvelope: null,
});

// ─── Campaign plumbing ──────────────────────────────────────────────────────

const STRESS_SEED = Number(process.env.STRESS_SEED ?? '20260905') || 20260905;
const STRESS_ITER = Math.max(1, Number(process.env.STRESS_ITER ?? '') || 30);
const STRESS_OUT = process.env.STRESS_OUT ?? null;
const REPLAY = process.env.STRESS_REPLAY ?? null;

function seedFor(campaign: string, index: number): number {
  return hashSeed(`${STRESS_SEED}:${campaign}:${index}`);
}

function indexesFor(campaign: string): number[] {
  if (REPLAY) {
    const [c, i] = REPLAY.split(':');
    return c === campaign ? [Number(i)] : [];
  }
  return Array.from({ length: STRESS_ITER }, (_, i) => i);
}

/** `test.each` over the campaign's indexes; a campaign excluded by
 * `STRESS_REPLAY` becomes one skipped test (jest rejects an empty table). */
function campaignTest(
  campaign: string,
): (name: string, fn: (index: number) => Promise<void>) => void {
  const idx = indexesFor(campaign);
  return idx.length > 0 ? test.each(idx) : test.skip.each([-1]);
}

interface IterationRow {
  id: string;
  seed: number;
  campaign: string;
  ops: string[];
  outcome: string;
  reason: string | null;
  reserves: number;
  finalizes: number;
  finalizeOutcomes: string[];
  writes: { shots: number; outbox: number; records: number };
  durationMs: number;
  violations: string[];
  /**
   * Non-fatal quality observations (e.g. a blank or oversized user-facing
   * reason). They never fail the run; they are tallied in the JSON table so
   * the stress report can cite them by seed.
   */
  observations: string[];
  rejected: string | null;
  payloadBytes: number;
  /** Individual runCaptureAnalysis invocations this row covers (batches > 1). */
  invocations: number;
}

const rows: IterationRow[] = [];

/**
 * Observations are collected per iteration in this module-level bucket and
 * attached to the row by `toRow`; `checkOutcomeShape` writes to it.
 */
let currentObservations: string[] = [];

function recordRow(row: IterationRow): void {
  rows.push(row);
  if (row.violations.length > 0) {
    // Surface the seed inline so a red run is replayable without the table.
    throw new Error(
      `[${row.id} seed=${row.seed}] ops=${row.ops.join('+')} outcome=${
        row.outcome
      } violations:\n  - ${row.violations.join('\n  - ')}`,
    );
  }
}

afterAll(() => {
  if (!STRESS_OUT) return;
  fs.mkdirSync(STRESS_OUT, { recursive: true });
  const file = path.join(
    STRESS_OUT,
    'runCaptureAnalysis.boundaryMalformed.results.json',
  );
  const byCampaign: Record<string, Record<string, number>> = {};
  for (const r of rows) {
    const c = (byCampaign[r.campaign] ??= {});
    c[r.outcome] = (c[r.outcome] ?? 0) + 1;
  }
  fs.writeFileSync(
    file,
    JSON.stringify(
      {
        unit: 'mod-run-capture-analysis',
        lens: 'boundary-malformed',
        baseSeed: STRESS_SEED,
        iterPerCampaign: STRESS_ITER,
        executed: rows.length,
        invocations: rows.reduce((n, r) => n + r.invocations, 0),
        violations: rows.filter(r => r.violations.length > 0).length,
        observations: rows.filter(r => r.observations.length > 0).length,
        observationSeeds: rows
          .filter(r => r.observations.length > 0)
          .map(r => ({ id: r.id, seed: r.seed, observations: r.observations })),
        byCampaign,
        maxDurationMs: Math.max(0, ...rows.map(r => r.durationMs)),
        rows,
      },
      null,
      1,
    ),
  );
});

const KINDS = new Set([
  'scored',
  'low_confidence',
  'unavailable',
  'quality_blocked',
]);

function checkOutcomeShape(o: CaptureAnalysisOutcome, v: string[]): void {
  if (!KINDS.has(o.kind)) v.push(`unknown outcome kind ${String(o.kind)}`);
  if (o.kind === 'unavailable' || o.kind === 'quality_blocked') {
    if (typeof o.reason !== 'string') {
      v.push('non-string reason on rejection');
    } else {
      // Reason QUALITY is observed, not asserted: the outcome is still the
      // typed rejection the lens demands, but a blank/oversized/artefact
      // reason is worth a seed in the report.
      if (o.reason.trim().length === 0) {
        currentObservations.push('blank reason on rejection');
      } else if (/undefined|\[object Object\]/.test(o.reason)) {
        currentObservations.push(
          `reason leaks formatting artefact: ${o.reason.slice(0, 120)}`,
        );
      }
      if (o.reason.length > 4096) {
        currentObservations.push(
          `reason echoes oversized input (${o.reason.length} chars)`,
        );
      }
      if (o.reason.includes(NULL_BYTE)) {
        currentObservations.push('reason contains a null byte');
      }
    }
  }
  if (o.kind === 'scored' || o.kind === 'low_confidence') {
    if (typeof o.analysisId !== 'string' || o.analysisId.length === 0) {
      v.push('missing analysisId');
    }
  }
  if (o.kind === 'scored') {
    const s = o.record.result?.overallScore;
    if (typeof s !== 'number' || !Number.isFinite(s) || s < 0 || s > 100) {
      v.push(`scored outcome with non-finite/out-of-range score ${String(s)}`);
    }
  }
}

function checkPersistedRows(w: WriteSummary, v: string[]): void {
  for (const shot of w.shots) {
    const score = shot.params[5];
    if (
      score !== null &&
      (typeof score !== 'number' ||
        !Number.isFinite(score) ||
        score < 0 ||
        score > 100)
    ) {
      v.push(`local_shot overall_score not finite in range: ${String(score)}`);
    }
    const payload = shot.params[shot.params.length - 1];
    if (typeof payload === 'string') {
      try {
        JSON.parse(payload);
      } catch {
        v.push('local_shot payload is not JSON');
      }
    }
  }
  for (const ob of w.outbox) {
    const payload = ob.params.find(
      p => typeof p === 'string' && p.startsWith('{'),
    );
    if (typeof payload !== 'string') continue;
    if (/NaN|Infinity/.test(payload)) {
      // JSON.stringify would have turned these into null; a literal means a
      // hand-built string.
      v.push('outbox payload contains NaN/Infinity literal');
    }
  }
}

function checkPollution(v: string[]): void {
  const probe = {} as Record<string, unknown>;
  if (probe.polluted !== undefined) v.push('Object.prototype polluted');
  if (Object.prototype.hasOwnProperty.call(Object.prototype, 'polluted')) {
    v.push('Object.prototype gained own property');
  }
}

/**
 * Permit accounting contract (mirrors runCaptureAnalysis.ts doc-comment):
 * reserve ≤ 1; scored ⇒ consumed (0 finalize) + 1 local_shot + 1 outbox;
 * not scored after reserve ⇒ exactly 1 finalize with matching outcome.
 */
function checkPermitAccounting(
  outcome: CaptureAnalysisOutcome | null,
  server: PermitServer,
  w: WriteSummary,
  v: string[],
  opts: { rejected: boolean },
): void {
  if (server.reserves.length > 1) v.push(`reserved ${server.reserves.length}×`);
  if (server.others.length > 0)
    v.push(`unexpected API call ${server.others[0]?.url}`);
  const finalizeOutcomes = server.finalizes.map(f =>
    typeof f.body === 'object' && f.body
      ? (f.body as { outcome?: unknown }).outcome
      : null,
  );
  const granted = server.reserves.filter(r => r.granted === true).length;
  if (granted === 0) {
    if (server.finalizes.length > 0)
      v.push('finalize without a granted permit');
    if (w.durable > 0)
      v.push(`${w.durable} DB call(s) without a granted permit`);
    if (
      outcome &&
      (outcome.kind === 'scored' || outcome.kind === 'low_confidence')
    ) {
      v.push(`${outcome.kind} without reserving a permit`);
    }
    return;
  }
  const permitId = (() => {
    // Recover the id the server handed out from the finalize URL, if any.
    const f = server.finalizes[0];
    if (!f) return null;
    const m = /analysis-permits\/([^/]+)\/finalize/.exec(f.url);
    return m ? (m[1] ?? null) : null;
  })();
  if (opts.rejected) {
    if (server.finalizes.length !== 1 || finalizeOutcomes[0] !== 'failed') {
      v.push(
        `provider throw: finalize=${JSON.stringify(finalizeOutcomes)} (want exactly ['failed'])`,
      );
    }
    if (w.shots.length + w.outbox.length > 0)
      v.push('provider throw wrote durable rows');
    return;
  }
  if (!outcome) return;
  switch (outcome.kind) {
    case 'scored':
      if (server.finalizes.length !== 0)
        v.push(`scored but finalized ${JSON.stringify(finalizeOutcomes)}`);
      if (w.shots.length !== 1)
        v.push(`scored wrote ${w.shots.length} local_shot rows`);
      if (w.outbox.length !== 1)
        v.push(`scored wrote ${w.outbox.length} outbox rows`);
      if (w.begins !== 1 || w.commits !== 1)
        v.push('scored save not in one transaction');
      break;
    case 'low_confidence':
      if (
        finalizeOutcomes.length !== 1 ||
        finalizeOutcomes[0] !== 'low_confidence'
      ) {
        v.push(`low_confidence finalize=${JSON.stringify(finalizeOutcomes)}`);
      }
      if (w.outbox.length !== 0) v.push('low_confidence reached sync outbox');
      if (w.records.length === 0)
        v.push('low_confidence saved no local record');
      break;
    case 'quality_blocked':
      if (
        finalizeOutcomes.length !== 1 ||
        finalizeOutcomes[0] !== 'unsupported'
      ) {
        v.push(`quality_blocked finalize=${JSON.stringify(finalizeOutcomes)}`);
      }
      if (w.durable !== 0)
        v.push(`quality_blocked made ${w.durable} DB call(s)`);
      break;
    case 'unavailable':
      if (finalizeOutcomes.length !== 1 || finalizeOutcomes[0] !== 'failed') {
        v.push(
          `unavailable-after-reserve finalize=${JSON.stringify(finalizeOutcomes)}`,
        );
      }
      if (w.durable !== 0) v.push(`unavailable made ${w.durable} DB call(s)`);
      break;
  }
  if (
    permitId !== null &&
    permitId !== encodeURIComponent(decodeURIComponent(permitId))
  ) {
    v.push(`finalize URL permit id not URL-encoded: ${permitId.slice(0, 80)}`);
  }
}

async function runOne(request: RunCaptureAnalysisRequest): Promise<{
  outcome: CaptureAnalysisOutcome | null;
  rejected: unknown;
  ms: number;
}> {
  const t0 = Date.now();
  try {
    const outcome = await runCaptureAnalysis(request);
    return { outcome, rejected: null, ms: Date.now() - t0 };
  } catch (error) {
    return { outcome: null, rejected: error, ms: Date.now() - t0 };
  }
}

function rowFor(
  id: string,
  seed: number,
  campaign: string,
  ops: string[],
  result: {
    outcome: CaptureAnalysisOutcome | null;
    rejected: unknown;
    ms: number;
  },
  server: PermitServer,
  w: WriteSummary,
  violations: string[],
  payloadBytes: number,
  invocations = 1,
): IterationRow {
  const o = result.outcome;
  return {
    id,
    seed,
    campaign,
    ops,
    outcome: o ? o.kind : result.rejected !== null ? 'REJECTED' : 'BATCH',
    reason:
      o && (o.kind === 'unavailable' || o.kind === 'quality_blocked')
        ? o.reason.slice(0, 160)
        : null,
    reserves: server.reserves.length,
    finalizes: server.finalizes.length,
    finalizeOutcomes: server.finalizes.map(f =>
      String((f.body as { outcome?: unknown } | null)?.outcome ?? null),
    ),
    writes: {
      shots: w.shots.length,
      outbox: w.outbox.length,
      records: w.records.length,
    },
    durationMs: result.ms,
    violations,
    observations: currentObservations,
    invocations,
    rejected:
      result.rejected === null
        ? null
        : result.rejected instanceof Error
          ? `${result.rejected.name}: ${result.rejected.message.slice(0, 200)}`
          : String(result.rejected).slice(0, 200),
    payloadBytes,
  };
}

// ─── Campaign A: sidecar wire mutations ─────────────────────────────────────

type Wire = {
  schemaVersion?: unknown;
  format?: unknown;
  coordinateSystem?: unknown;
  poseModelVersion?: unknown;
  video?: Record<string, unknown> | unknown;
  frames?: unknown;
  [key: string]: unknown;
};

interface SidecarMutation {
  json: string;
  ops: string[];
  /** false ⇒ keep the ORIGINAL hash so the integrity check must refuse. */
  rehash: boolean;
}

function mutateSidecar(rng: Rng): SidecarMutation {
  const ops: string[] = [];
  const wire = JSON.parse(CANONICAL_SIDECAR) as Wire;
  const frames = wire.frames as Array<Record<string, unknown>>;
  const objectOps: Array<() => void> = [
    () => {
      wire.schemaVersion = rng.pick<unknown>([
        2,
        0,
        -1,
        '1',
        null,
        1.5,
        999,
        [1],
        {},
        1e308,
      ]);
      ops.push('schema:' + JSON.stringify(wire.schemaVersion));
    },
    () => {
      wire.format = rng.pick<unknown>([
        'pickle.pose-sequence.v2',
        'pickle.pose-sequence.v1 ',
        'PICKLE.POSE-SEQUENCE.V1',
        `pickle.pose-sequence.v1${NULL_BYTE}`,
        '',
        null,
        1,
        bigString(rng),
      ]);
      ops.push('format');
    },
    () => {
      wire.coordinateSystem = rng.pick<unknown>([
        'normalized_image_top_left ',
        'normalized_image_bottom_left',
        'pixel',
        NFD_E,
        '',
        null,
        0,
        { [rng.pick(POLLUTION_KEYS)]: 1 },
      ]);
      ops.push('coord');
    },
    () => {
      wire.poseModelVersion = rng.pick<unknown>([
        '',
        ' ',
        null,
        1,
        [],
        weirdString(rng),
      ]);
      ops.push('modelVersion');
    },
    () => {
      const key = rng.pick(POLLUTION_KEYS);
      wire[key] = { polluted: true, isAdmin: true };
      ops.push(`pollute:${key}`);
    },
    () => {
      wire[weirdString(rng).slice(0, 2048)] = wrongJsonType(rng);
      ops.push('extraRootKey');
    },
    () => {
      const video = wire.video as Record<string, unknown>;
      const field = rng.pick(['width', 'height', 'fps']);
      video[field] = rng.pick<unknown>([
        0,
        -1,
        -0,
        1e308,
        1e-300,
        '1080',
        null,
        [],
        {},
        0.5,
        NaN,
      ]);
      ops.push(`video.${field}`);
    },
    () => {
      wire.video = wrongJsonType(rng);
      ops.push('video:wrongType');
    },
    () => {
      delete wire.video;
      ops.push('video:missing');
    },
    () => {
      wire.frames = rng.pick<unknown>([
        [],
        null,
        {},
        'frames',
        0,
        [[]],
        [{}],
        [null],
      ]);
      ops.push('frames:degenerate');
    },
    () => {
      wire.frames = frames.slice(0, rng.int(1, 3));
      ops.push('frames:tooFew');
    },
    () => {
      wire.frames = frames.slice(0, Math.max(1, Math.floor(frames.length / 2)));
      ops.push('frames:halfTruncated');
    },
    () => {
      const i = rng.int(0, frames.length - 1);
      frames.splice(i, 1);
      ops.push(`frames:drop@${i}`);
    },
    () => {
      const i = rng.int(0, frames.length - 1);
      frames.splice(i, 0, { ...(frames[i] as Record<string, unknown>) });
      ops.push(`frames:dupTimestamp@${i}`);
    },
    () => {
      rng.shuffle(frames);
      ops.push('frames:shuffled');
    },
    () => {
      frames.reverse();
      ops.push('frames:reversed');
    },
    () => {
      for (const f of frames) f.t = frames[0]?.t ?? 0;
      ops.push('frames:allSameT');
    },
    () => {
      const reps = rng.int(2, 6);
      const copy = frames.slice();
      for (let r = 1; r < reps; r++) {
        const last = Number((frames[frames.length - 1] as { t: number }).t);
        for (const f of copy) frames.push({ ...f, t: last + 1 + Number(f.t) });
      }
      ops.push(`frames:x${reps}`);
    },
    () => {
      const f = rng.pick(frames);
      const field = rng.pick(['t', 'i', 'c']);
      f[field] = rng.pick<unknown>([
        -1,
        -0,
        1e308,
        1.5,
        '1',
        null,
        [],
        {},
        2 ** 53 + 2,
      ]);
      ops.push(`frame.${field}`);
    },
    () => {
      const f = rng.pick(frames);
      f.t = -Math.abs(Number(f.t)) - 1;
      ops.push('frame.t:negative');
    },
    () => {
      const f = rng.pick(frames);
      f.l = rng.pick<unknown>([[], null, {}, 'l', [null], [{}], [[]]]);
      ops.push('frame.l:degenerate');
    },
    () => {
      const f = rng.pick(frames);
      const l = f.l as Array<Record<string, unknown>>;
      const lm = rng.pick(l);
      const field = rng.pick(['n', 'x', 'y', 'v', 'z']);
      lm[field] =
        field === 'n'
          ? rng.pick<unknown>([
              '',
              null,
              1,
              weirdString(rng),
              rng.pick(POLLUTION_KEYS),
            ])
          : rng.pick<unknown>([
              1e308,
              -1e308,
              -0,
              1.5,
              -2,
              '0.5',
              null,
              [],
              {},
            ]);
      ops.push(`landmark.${field}`);
    },
    () => {
      const f = rng.pick(frames);
      const l = f.l as Array<Record<string, unknown>>;
      l.splice(rng.int(0, l.length - 1), 1);
      ops.push('landmark:drop');
    },
    () => {
      const f = rng.pick(frames);
      const l = f.l as Array<Record<string, unknown>>;
      const lm = rng.pick(l);
      for (let k = 0; k < rng.int(1, 40); k++) l.push({ ...lm });
      ops.push('landmark:dupMany');
    },
    () => {
      const f = rng.pick(frames);
      const l = f.l as Array<Record<string, unknown>>;
      for (const lm of l) delete lm.z;
      ops.push('landmark:z-missing');
    },
    () => {
      const f = rng.pick(frames);
      f[rng.pick(POLLUTION_KEYS)] = { polluted: true };
      ops.push('frame:pollute');
    },
  ];
  const stringOps: Array<(json: string) => string> = [
    json => {
      ops.push('str:truncate');
      return json.slice(0, rng.int(0, json.length - 1));
    },
    json => {
      ops.push('str:nullByte');
      const at = rng.int(0, json.length);
      return json.slice(0, at) + NULL_BYTE + json.slice(at);
    },
    json => {
      ops.push('str:bom');
      return '\uFEFF' + json;
    },
    json => {
      ops.push('str:trailingGarbage');
      return (
        json + rng.pick(['}', ']', 'x', ',', '{}', NULL_BYTE, '\n\n', '//'])
      );
    },
    json => {
      ops.push('str:commaToSemicolon');
      const idx = json.indexOf(',', rng.int(0, json.length - 1));
      return idx < 0
        ? json + ';'
        : json.slice(0, idx) + ';' + json.slice(idx + 1);
    },
    json => {
      const lit = rng.pick([
        '1e999',
        '-1e999',
        '-0',
        '1e-999',
        '9007199254740993',
        '1E+400',
        '0x10',
        'NaN',
        'Infinity',
        '-',
      ]);
      ops.push(`str:numLiteral:${lit}`);
      const m = /-?\d+(\.\d+)?/g;
      const matches: number[] = [];
      let r: RegExpExecArray | null;
      while ((r = m.exec(json)) !== null && matches.length < 5000)
        matches.push(r.index);
      if (matches.length === 0) return json;
      const at = rng.pick(matches);
      const end = at + (/-?\d+(\.\d+)?/.exec(json.slice(at))?.[0].length ?? 1);
      return json.slice(0, at) + lit + json.slice(end);
    },
    json => {
      ops.push('str:wrapArray');
      return `[${json}]`;
    },
    json => {
      ops.push('str:doubled');
      return json + json;
    },
    json => {
      ops.push('str:bigWhitespace');
      const at = json.indexOf(':', rng.int(0, json.length - 1));
      const pad = ' '.repeat(BIG + 1);
      return at < 0
        ? json + pad
        : json.slice(0, at + 1) + pad + json.slice(at + 1);
    },
    json => {
      ops.push('str:unicodeEscapes');
      return json.replace(
        /"n":"([^"]+)"/,
        (_m, n: string) => `"n":"${n}\\u0000\\ud800"`,
      );
    },
    () => {
      ops.push('str:literal');
      return rng.pick([
        '',
        ' ',
        'null',
        '[]',
        '{}',
        '0',
        '"x"',
        'true',
        '{',
        '}',
        '{"schemaVersion":1',
        NULL_BYTE,
        '\uFEFF',
        bigString(rng),
      ]);
    },
  ];
  const nObject = rng.int(0, 3);
  for (let k = 0; k < nObject; k++) rng.pick(objectOps)();
  let json = JSON.stringify(wire);
  const nString = nObject === 0 ? rng.int(1, 2) : rng.chance(0.3) ? 1 : 0;
  for (let k = 0; k < nString; k++) json = rng.pick(stringOps)(json);
  const rehash = rng.chance(0.9);
  if (!rehash) ops.push('hash:stale');
  return { json, ops, rehash };
}

// ─── Campaign B: permit server body / status fuzz ───────────────────────────

interface ReserveScenario {
  ops: string[];
  respond: ReserveResponder;
  finalizeRespond: FinalizeResponder;
  /** What a compliant client must do with this response. */
  expect: 'scored' | 'unavailable' | 'unavailable_paywall' | 'any_typed';
}

function reserveScenario(rng: Rng): ReserveScenario {
  const ops: string[] = [];
  const finalizeRespond: FinalizeResponder = rng.pick<FinalizeResponder>([
    () => jsonResponse({ ok: true }),
    () => jsonResponse({}, 500),
    () => brokenJsonResponse(200),
    () => {
      throw new TypeError('Network request failed');
    },
    () => jsonResponse(wrongType(rng), rng.pick([200, 204, 400, 404])),
  ]);
  const mode = rng.pick([
    'status',
    'permitShape',
    'accessShape',
    'bodyShape',
    'json_broken',
    'throws',
    'valid',
  ]);
  ops.push(`reserve:${mode}`);
  switch (mode) {
    case 'status': {
      const status = rng.pick([
        400, 401, 402, 403, 404, 409, 410, 418, 422, 429, 500, 502, 503, 599,
        100, 204, 301,
      ]);
      const code = rng.pick<unknown>([
        'access.paywall_required',
        'auth.required',
        'permit.exhausted',
        '',
        null,
        42,
        {},
        [],
        weirdString(rng),
      ]);
      const body = rng.pick<unknown>([
        { error: { code, message: weirdString(rng) } },
        { error: { code } },
        { error: weirdString(rng) },
        { error: null },
        {
          error: {
            code,
            message: bigString(rng),
            stack: 'at Object.<anonymous> (/srv/api/index.ts:1:1)',
          },
        },
        {},
        null,
        [],
        weirdString(rng),
        validPermitBody('permit-with-error-status'),
      ]);
      ops.push(
        `status:${status}`,
        `code:${typeof code === 'string' ? code.slice(0, 40) : typeof code}`,
      );
      const bodyCode =
        typeof body === 'object' && body !== null && !Array.isArray(body)
          ? (() => {
              const err = (body as { error?: unknown }).error;
              return typeof err === 'object' && err !== null
                ? (err as { code?: unknown }).code
                : undefined;
            })()
          : undefined;
      const paywall = status === 402 || bodyCode === 'access.paywall_required';
      // Statuses < 400 that are not 2xx are still "not ok" for fetch (301 is
      // followed by fetch normally; here the mock returns it verbatim).
      const expect: ReserveScenario['expect'] =
        status >= 200 && status < 300
          ? 'any_typed'
          : paywall
            ? 'unavailable_paywall'
            : 'unavailable';
      return {
        ops,
        respond: () => jsonResponse(body, status),
        finalizeRespond,
        expect,
      };
    }
    case 'permitShape': {
      const base = validPermitBody('permit-shape');
      const permit = base.permit as Record<string, unknown>;
      const field = rng.pick([
        'id',
        'accessSource',
        'status',
        'expiresAt',
        'all',
      ]);
      let stillValid = true;
      if (field === 'id' || field === 'all') {
        const id = rng.pick<unknown>([
          '',
          ' ',
          '\t',
          NULL_BYTE,
          `p${NULL_BYTE}q`,
          rng.pick(TRAVERSALS),
          'a/b?c=d#e&f=g',
          'permit with spaces',
          NFC_E,
          NFD_E,
          FAMILY,
          LONE_SURROGATE,
          rng.pick(POLLUTION_KEYS),
          bigString(rng),
          0,
          -0,
          NaN,
          null,
          undefined,
          {},
          [],
          true,
          'ok-permit',
        ]);
        permit.id = id;
        stillValid =
          stillValid && typeof id === 'string' && id.trim().length > 0;
        ops.push(
          `permit.id:${typeof id === 'string' ? JSON.stringify(id.slice(0, 24)) : String(id)}`,
        );
      }
      if (field === 'accessSource' || field === 'all') {
        const src = rng.pick<unknown>([
          'free',
          'premium',
          'FREE',
          'Premium',
          'trial',
          '',
          null,
          1,
          undefined,
          ['free'],
        ]);
        permit.accessSource = src;
        stillValid = stillValid && (src === 'free' || src === 'premium');
        ops.push(`permit.accessSource:${String(src)}`);
      }
      if (field === 'status' || field === 'all') {
        const st = rng.pick<unknown>([
          'reserved',
          'consumed',
          'released',
          'expired',
          'RESERVED',
          '',
          null,
          1,
          undefined,
        ]);
        permit.status = st;
        stillValid = stillValid && st === 'reserved';
        ops.push(`permit.status:${String(st)}`);
      }
      if (field === 'expiresAt' || field === 'all') {
        const exp = rng.pick<unknown>([
          '2099-01-01T00:00:00.000Z',
          '1970-01-01T00:00:00.000Z',
          '',
          'not a date',
          '2099-13-45T99:99:99Z',
          0,
          1e308,
          NaN,
          null,
          undefined,
          {},
        ]);
        permit.expiresAt = exp;
        stillValid = stillValid && typeof exp === 'string';
        ops.push(`permit.expiresAt:${typeof exp}`);
      }
      return {
        ops,
        respond: () => jsonResponse(base),
        finalizeRespond,
        expect: stillValid ? 'scored' : 'unavailable',
      };
    }
    case 'accessShape': {
      const base = validPermitBody(`permit-access-${rng.int(0, 1e9)}`);
      const access = rng.pick<unknown>([
        null,
        undefined,
        [],
        'access',
        42,
        { premium: 'yes', freeRatings: {} },
        { premium: true },
        { premium: false, freeRatings: null },
        {
          premium: false,
          freeRatings: {
            limit: NaN,
            used: 0,
            reserved: 0,
            remaining: 0,
            availableToReserve: 0,
          },
        },
        {
          premium: false,
          freeRatings: {
            limit: Infinity,
            used: -Infinity,
            reserved: -0,
            remaining: 1e308,
            availableToReserve: 0,
          },
        },
        {
          premium: false,
          freeRatings: {
            limit: '3',
            used: 0,
            reserved: 0,
            remaining: 0,
            availableToReserve: 0,
          },
        },
        {
          premium: false,
          freeRatings: {
            limit: 3,
            used: 3,
            reserved: 0,
            remaining: 0,
            availableToReserve: 0,
          },
        },
        {
          premium: false,
          freeRatings: {
            limit: 3,
            used: 0,
            reserved: 0,
            remaining: 3,
            availableToReserve: -1,
          },
        },
        {
          premium: false,
          freeRatings: {
            limit: 3,
            used: 0,
            reserved: 0,
            remaining: 3,
            availableToReserve: 2 ** 53,
          },
        },
        {
          premium: true,
          freeRatings: {
            limit: 0,
            used: 0,
            reserved: 0,
            remaining: 0,
            availableToReserve: 0,
          },
        },
        {
          [rng.pick(POLLUTION_KEYS)]: { polluted: true },
          premium: false,
          freeRatings: {
            limit: 3,
            used: 0,
            reserved: 0,
            remaining: 3,
            availableToReserve: 2,
          },
        },
      ]);
      (base as Record<string, unknown>).access = access;
      ops.push(
        `access:${access === null ? 'null' : Array.isArray(access) ? 'array' : typeof access}`,
      );
      return {
        ops,
        respond: () => jsonResponse(base),
        finalizeRespond,
        expect: 'scored',
      };
    }
    case 'bodyShape': {
      const body = rng.pick<unknown>([
        null,
        undefined,
        [],
        [validPermitBody('in-array')],
        {},
        { permit: null },
        { permit: 'permit-1' },
        { permit: [] },
        { permit: { [rng.pick(POLLUTION_KEYS)]: { polluted: true } } },
        weirdString(rng),
        42,
        true,
        { permit: validPermitBody('nested').permit, access: undefined },
      ]);
      ops.push(
        `body:${body === null ? 'null' : Array.isArray(body) ? 'array' : typeof body}`,
      );
      const status = rng.pick([200, 201]);
      // A permit without its access snapshot is still a contract-valid grant
      // (parseReserveAccess degrades to null) — classify by the same rule.
      const granted = isGrantedPermitResponse(jsonResponse(body, status), body);
      ops.push(granted ? 'grant:valid' : 'grant:malformed');
      return {
        ops,
        respond: () => jsonResponse(body, status),
        finalizeRespond,
        expect: granted ? 'any_typed' : 'unavailable',
      };
    }
    case 'json_broken': {
      const status = rng.pick([200, 400, 402, 500, 502]);
      ops.push(`status:${status}`);
      return {
        ops,
        respond: () => brokenJsonResponse(status),
        finalizeRespond,
        expect: status === 402 ? 'unavailable_paywall' : 'unavailable',
      };
    }
    case 'throws': {
      const err = rng.pick<unknown>([
        new TypeError('Network request failed'),
        new Error(bigString(rng)),
        'string rejection',
        null,
        undefined,
        { code: 'ECONNRESET' },
        42,
      ]);
      ops.push(`fetchThrows:${err instanceof Error ? err.name : typeof err}`);
      return {
        ops,
        respond: () => {
          throw err;
        },
        finalizeRespond,
        expect: 'unavailable',
      };
    }
    default:
      return {
        ops,
        respond: (c, n) =>
          jsonResponse(
            validPermitBody(`permit-${n}-${c.idempotencyKey ?? 'k'}`),
          ),
        finalizeRespond,
        expect: 'scored',
      };
  }
}

// ─── Campaign C: request-field fuzz ─────────────────────────────────────────

function envelope(
  overall: EnvelopeVerdict['overall'],
  rng: Rng,
  mangle: boolean,
): EnvelopeVerdict {
  const verdict: EnvelopeVerdict = {
    thresholdsVersion: mangle ? bigString(rng) : 'stress-v1',
    provisional: true,
    dimensions: mangle
      ? rng.pick<EnvelopeVerdict['dimensions']>([
          [],
          [
            {
              dimension: 'brightness',
              status: overall === 'SUPPORTED' ? 'SUPPORTED' : 'UNSUPPORTED',
              measured: weirdNumber(rng),
              unit: weirdString(rng).slice(0, 64),
              thresholdId: rng.pick(TRAVERSALS),
            },
          ],
          null as unknown as EnvelopeVerdict['dimensions'],
        ])
      : [
          {
            dimension: 'frame_rate',
            status:
              overall === 'SUPPORTED'
                ? 'SUPPORTED'
                : overall === 'DEGRADED'
                  ? 'DEGRADED'
                  : 'UNSUPPORTED',
            measured: 30,
            unit: 'fps',
            thresholdId: 'frame_rate.min',
          },
        ],
    overall,
    overallWithCoverage: overall,
    notMeasured: mangle ? ['brightness', 'frame_rate'] : [],
  };
  return verdict;
}

interface RequestScenario {
  ops: string[];
  request: RunCaptureAnalysisRequest;
  expectNoReserve: boolean;
  expectKind: CaptureAnalysisOutcome['kind'] | null;
  /**
   * Set when the generated request violates the TypeScript contract in a way
   * no production caller can produce (both callers build the value
   * in-process). A throw on such input is recorded as an observation, not
   * a violation, so the report can cite it without failing the held
   * invariants.
   */
  typeViolation: string | null;
}

function requestScenario(
  rng: Rng,
  db: LocalDb,
  clip: CapturedClip,
): RequestScenario {
  const ops: string[] = [];
  const request = BASE_REQUEST(clip, db) as unknown as Record<string, unknown>;
  let expectNoReserve = false;
  let expectKind: CaptureAnalysisOutcome['kind'] | null = null;
  let typeViolation: string | null = null;
  const fields = rng
    .shuffle([
      'declaredStroke',
      'declaredCanonical',
      'handedness',
      'cameraView',
      'appVersion',
      'sessionId',
      'captureId',
      'focusCheckpoint',
      'targetSeed',
      'captureEnvelope',
      'evaluationTelemetry',
      'apiConfig',
      'clip.trigger',
      'clip.durationMs',
    ])
    .slice(0, rng.int(1, 3));
  for (const field of fields) {
    switch (field) {
      case 'declaredStroke': {
        const value = rng.pick<unknown>([
          ...SHOT_TYPES,
          null,
          '',
          'FOREHAND_DRIVE',
          'forehand-drive',
          'forehand_drive ',
          `forehand_drive${NULL_BYTE}`,
          rng.pick(POLLUTION_KEYS),
          rng.pick(TRAVERSALS),
          bigString(rng),
          NFD_E,
        ]);
        request.declaredStroke = value;
        ops.push(
          `declaredStroke:${value === null ? 'null' : JSON.stringify(String(value).slice(0, 24))}`,
        );
        if (
          value !== null &&
          !(SHOT_TYPES as readonly string[]).includes(value as string)
        ) {
          // The registry's technique_scoring entry supports "all" strokes,
          // so a non-slug string passes the release gate and is refused by
          // the per-slug scorer AFTER reserve; the permit must then be
          // finalized 'failed' with no durable write (checked by the
          // accounting invariant).
          expectKind = 'unavailable';
        }
        break;
      }
      case 'declaredCanonical':
        request.declaredCanonical = rng.pick<unknown>([
          undefined,
          null,
          'FOREHAND_DRIVE',
          '',
          weirdString(rng),
        ]);
        ops.push('declaredCanonical');
        break;
      case 'handedness':
        request.handedness = rng.pick<unknown>([
          'right',
          'left',
          'ambidextrous',
          '',
          null,
          undefined,
          1,
          'RIGHT',
          weirdString(rng),
        ]);
        ops.push(`handedness:${String(request.handedness).slice(0, 16)}`);
        break;
      case 'cameraView':
        request.cameraView = rng.pick<unknown>([
          'side',
          'rear_oblique',
          'front',
          'top',
          'SIDE',
          '',
          null,
          undefined,
          weirdString(rng),
        ]);
        ops.push(`cameraView:${String(request.cameraView).slice(0, 16)}`);
        break;
      case 'appVersion':
        request.appVersion = rng.pick<unknown>([
          '',
          '0.0.0',
          '999.999.999',
          bigString(rng),
          NULL_BYTE,
          null,
          undefined,
          1,
        ]);
        ops.push('appVersion');
        break;
      case 'sessionId':
        request.sessionId = rng.pick<unknown>([
          undefined,
          null,
          '',
          'session-1',
          rng.pick(TRAVERSALS),
          bigString(rng),
          NULL_BYTE,
          42,
        ]);
        ops.push('sessionId');
        break;
      case 'captureId':
        request.captureId = rng.pick<unknown>([
          '',
          'capture-1',
          rng.pick(TRAVERSALS),
          bigString(rng),
          NULL_BYTE,
          NFD_E,
          rng.pick(POLLUTION_KEYS),
        ]);
        ops.push('captureId');
        break;
      case 'focusCheckpoint':
        request.focusCheckpoint = rng.pick<unknown>([
          undefined,
          null,
          '',
          'contact_point',
          'CONTACT_POINT',
          rng.pick(POLLUTION_KEYS),
          weirdString(rng),
        ]);
        ops.push('focusCheckpoint');
        break;
      case 'targetSeed':
        request.targetSeed = rng.pick<unknown>([
          undefined,
          null,
          {
            point: { x: 0.5, y: 0.5 },
            selectedAtIso: '2026-09-05T00:00:00.000Z',
          },
          { point: { x: NaN, y: Infinity }, selectedAtIso: '' },
          { point: { x: -0, y: 1e308 }, selectedAtIso: 'not-a-date' },
          { point: null, selectedAtIso: null },
          {},
          [],
          'seed',
        ]);
        ops.push('targetSeed');
        break;
      case 'captureEnvelope': {
        const variant = rng.pick([
          'undefined',
          'null',
          'SUPPORTED',
          'DEGRADED',
          'UNSUPPORTED',
          'UNSUPPORTED_mangled',
          'garbageOverall',
          'wrongType',
        ]);
        ops.push(`envelope:${variant}`);
        switch (variant) {
          case 'undefined':
            request.captureEnvelope = undefined;
            break;
          case 'null':
            request.captureEnvelope = null;
            break;
          case 'SUPPORTED':
            request.captureEnvelope = envelope(
              'SUPPORTED',
              rng,
              rng.chance(0.3),
            );
            break;
          case 'DEGRADED':
            request.captureEnvelope = envelope(
              'DEGRADED',
              rng,
              rng.chance(0.3),
            );
            break;
          case 'UNSUPPORTED':
            request.captureEnvelope = envelope('UNSUPPORTED', rng, false);
            expectNoReserve = true;
            expectKind = 'quality_blocked';
            break;
          case 'UNSUPPORTED_mangled': {
            const mangled = envelope('UNSUPPORTED', rng, true);
            request.captureEnvelope = mangled;
            expectNoReserve = true;
            expectKind = 'quality_blocked';
            if (mangled.dimensions === null) {
              ops.push('envelope.dimensions:null');
              typeViolation =
                'captureEnvelope.dimensions is null (typed as EnvelopeDimensionVerdict[])';
            }
            break;
          }
          case 'garbageOverall':
            request.captureEnvelope = {
              ...envelope('SUPPORTED', rng, false),
              overall: weirdString(rng) as 'SUPPORTED',
            };
            break;
          default:
            request.captureEnvelope = wrongType(rng);
        }
        break;
      }
      case 'evaluationTelemetry':
        request.evaluationTelemetry = rng.pick<unknown>([
          undefined,
          null,
          { consentActive: false },
          { consentActive: true, consentVersion: weirdString(rng), dims: {} },
          { consentActive: true, dims: wrongType(rng) },
          { consentActive: 'yes', dims: null },
          wrongType(rng),
        ]);
        ops.push('telemetry');
        break;
      case 'apiConfig': {
        const token = rng.pick<unknown>([
          'stress-token',
          '',
          '   ',
          null,
          undefined,
          42,
          bigString(rng),
          NULL_BYTE,
        ]);
        const baseUrl = rng.pick<unknown>([
          'https://stress.invalid',
          '',
          'not a url',
          'https://stress.invalid/',
          `https://stress.invalid/${NULL_BYTE}`,
          rng.pick(TRAVERSALS),
        ]);
        request.apiConfig = { baseUrl, token };
        ops.push(
          `apiConfig.token:${typeof token === 'string' ? JSON.stringify(token.slice(0, 8)) : String(token)}`,
        );
        if (typeof token !== 'string' || token.trim().length === 0) {
          expectNoReserve = true;
          expectKind = 'unavailable';
        }
        break;
      }
      case 'clip.trigger': {
        const trig = rng.pick<unknown>([
          {
            startMs: window.endMs,
            endMs: window.startMs,
            peakMotionMs: window.peakMs,
          },
          { startMs: -1, endMs: -1, peakMotionMs: -1 },
          { startMs: NaN, endMs: NaN, peakMotionMs: NaN },
          { startMs: 0, endMs: Infinity, peakMotionMs: -0 },
          { startMs: 1e308, endMs: 1e308, peakMotionMs: 1e308 },
          {
            startMs: window.startMs,
            endMs: window.endMs,
            peakMotionMs: undefined,
          },
          { startMs: window.startMs, endMs: window.endMs },
          null,
          {},
        ]);
        (request.clip as Record<string, unknown>) = {
          ...(request.clip as CapturedClip),
          trigger: trig,
        };
        ops.push('clip.trigger');
        if (trig === null) {
          ops.push('clip.trigger:null');
          typeViolation =
            'clip.trigger is null on an automatic_pose_trigger clip (typed as AutomaticStrokeTrigger)';
        }
        break;
      }
      case 'clip.durationMs':
        (request.clip as Record<string, unknown>) = {
          ...(request.clip as CapturedClip),
          durationMs: weirdNumber(rng),
        };
        ops.push('clip.durationMs');
        break;
    }
  }
  // The envelope gate runs before the stroke gate, so an UNSUPPORTED
  // envelope decides the outcome regardless of other malformed fields.
  const env = request.captureEnvelope as
    { overall?: unknown } | null | undefined;
  if (env && typeof env === 'object' && env.overall === 'UNSUPPORTED') {
    expectKind = 'quality_blocked';
    expectNoReserve = true;
  }
  return {
    ops,
    request: request as unknown as RunCaptureAnalysisRequest,
    expectNoReserve,
    expectKind,
    typeViolation,
  };
}

// ─── Suite ──────────────────────────────────────────────────────────────────

const OWNER = '5715e55e-0000-4000-8000-000000000001';

beforeAll(() => {
  Platform.OS = 'ios';
});

beforeEach(() => {
  stabilitySlo.reset();
  useApiSessionStore.setState({ session: null });
  setActiveDataOwner(OWNER);
});

afterEach(() => {
  jest.restoreAllMocks();
  mockReadArtifact = async () => '';
});

afterAll(() => {
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
});

describe('runCaptureAnalysis — boundary/malformed stress (seeded)', () => {
  test('replay contract: the same seed produces the same sidecar mutation', () => {
    const a = mutateSidecar(new Rng(seedFor('A', 7)));
    const b = mutateSidecar(new Rng(seedFor('A', 7)));
    expect(a.json).toBe(b.json);
    expect(a.ops).toEqual(b.ops);
    const c = mutateSidecar(new Rng(seedFor('A', 8)));
    expect(c.json === a.json && c.ops.join() === a.ops.join()).toBe(false);
  });

  test('canonical fixture scores (positive control)', async () => {
    const { db, calls } = recordingDb();
    const server = permitServer();
    global.fetch = server.fetch as unknown as typeof fetch;
    mockReadArtifact = async () => CANONICAL_SIDECAR;
    const outcome = await runCaptureAnalysis(
      BASE_REQUEST(clipFor(CANONICAL_SIDECAR, CANONICAL_SHA), db),
    );
    expect(outcome.kind).toBe('scored');
    const w = summarizeWrites(calls);
    expect(w.shots).toHaveLength(1);
    expect(w.outbox).toHaveLength(1);
    expect(server.reserves).toHaveLength(1);
    expect(server.finalizes).toHaveLength(0);
  });

  describe('A. hash-consistent sidecar wire mutations', () => {
    campaignTest('A')('A:%i', async index => {
      const seed = seedFor('A', index);
      const rng = new Rng(seed);
      const mutation = mutateSidecar(rng);
      const clip = clipFor(
        mutation.json,
        mutation.rehash ? sha256Hex(mutation.json) : CANONICAL_SHA,
      );
      const { db, calls } = recordingDb();
      const server = permitServer();
      global.fetch = server.fetch as unknown as typeof fetch;
      mockReadArtifact = async () => mutation.json;
      const result = await runOne(BASE_REQUEST(clip, db));
      const w = summarizeWrites(calls);
      const v: string[] = [];
      currentObservations = [];
      if (result.rejected !== null) {
        v.push(
          `threw out of runCaptureAnalysis: ${String(result.rejected).slice(0, 300)}`,
        );
      }
      if (result.outcome) checkOutcomeShape(result.outcome, v);
      if (
        !mutation.rehash &&
        result.outcome &&
        result.outcome.kind !== 'unavailable'
      ) {
        v.push('stale hash accepted');
      }
      if (!mutation.rehash && server.reserves.length > 0)
        v.push('stale hash reserved a permit');
      checkPermitAccounting(result.outcome, server, w, v, { rejected: false });
      checkPersistedRows(w, v);
      checkPollution(v);
      recordRow(
        rowFor(
          `A:${index}`,
          seed,
          'A',
          mutation.ops,
          result,
          server,
          w,
          v,
          mutation.json.length,
        ),
      );
    });
  });

  describe('B. permit server status/body fuzz', () => {
    campaignTest('B')('B:%i', async index => {
      const seed = seedFor('B', index);
      const rng = new Rng(seed);
      const scenario = reserveScenario(rng);
      const { db, calls } = recordingDb();
      const server = permitServer(scenario.respond, scenario.finalizeRespond);
      global.fetch = server.fetch as unknown as typeof fetch;
      mockReadArtifact = async () => CANONICAL_SIDECAR;
      const analyze = jest.spyOn(pipeline, 'analyzeCapture');
      const result = await runOne(
        BASE_REQUEST(clipFor(CANONICAL_SIDECAR, CANONICAL_SHA), db),
      );
      const w = summarizeWrites(calls);
      const v: string[] = [];
      currentObservations = [];
      if (result.rejected !== null) {
        v.push(
          `threw out of runCaptureAnalysis: ${String(result.rejected).slice(0, 300)}`,
        );
      }
      const o = result.outcome;
      if (o) {
        checkOutcomeShape(o, v);
        switch (scenario.expect) {
          case 'scored':
            if (o.kind !== 'scored')
              v.push(
                `valid permit ⇒ want scored, got ${o.kind}: ${'reason' in o ? o.reason : ''}`,
              );
            break;
          case 'unavailable':
          case 'unavailable_paywall':
            if (o.kind !== 'unavailable')
              v.push(`bad reserve ⇒ want unavailable, got ${o.kind}`);
            if (analyze.mock.calls.length > 0)
              v.push('inference ran on a rejected/malformed permit');
            if (w.durable > 0)
              v.push(`rejected permit but ${w.durable} DB call(s)`);
            if (server.finalizes.length > 0)
              v.push('finalized a permit that was never validly reserved');
            if (o.kind === 'unavailable') {
              const gotPaywall = o.cause === 'paywall_required';
              if (scenario.expect === 'unavailable_paywall' && !gotPaywall)
                v.push('paywall cause dropped');
              if (scenario.expect === 'unavailable' && gotPaywall)
                v.push('paywall cause invented');
            }
            break;
          default:
            break;
        }
      }
      checkPermitAccounting(o, server, w, v, { rejected: false });
      checkPersistedRows(w, v);
      checkPollution(v);
      // The reserve idempotency key must be present and stable-format.
      const key = server.reserves[0]?.idempotencyKey ?? null;
      if (server.reserves.length > 0 && (!key || key.trim().length === 0))
        v.push('reserve without Idempotency-Key');
      recordRow(
        rowFor(`B:${index}`, seed, 'B', scenario.ops, result, server, w, v, 0),
      );
    });
  });

  describe('C. request-field boundaries', () => {
    campaignTest('C')('C:%i', async index => {
      const seed = seedFor('C', index);
      const rng = new Rng(seed);
      const { db, calls } = recordingDb();
      const scenario = requestScenario(
        rng,
        db,
        clipFor(CANONICAL_SIDECAR, CANONICAL_SHA),
      );
      const server = permitServer();
      global.fetch = server.fetch as unknown as typeof fetch;
      mockReadArtifact = async () => CANONICAL_SIDECAR;
      const result = await runOne(scenario.request);
      const w = summarizeWrites(calls);
      const v: string[] = [];
      currentObservations = [];
      if (result.rejected !== null) {
        if (scenario.typeViolation) {
          currentObservations.push(
            `type-violation input threw (${scenario.typeViolation}): ${String(result.rejected).slice(0, 200)}`,
          );
        } else {
          v.push(
            `threw out of runCaptureAnalysis: ${String(result.rejected).slice(0, 300)}`,
          );
        }
        if (w.durable > 0) v.push(`throw left ${w.durable} durable DB call(s)`);
        // A throw AFTER reserve is tolerated only if the release boundary
        // finalized every reserved permit as 'failed' (no leak).
        const failed = server.finalizes.filter(
          f => (f.body as { outcome?: unknown } | null)?.outcome === 'failed',
        ).length;
        if (server.reserves.length > 0 && failed !== server.reserves.length)
          v.push(
            `throw leaked a permit: reserves=${server.reserves.length} 'failed' finalizes=${failed}`,
          );
      }
      if (result.outcome) {
        checkOutcomeShape(result.outcome, v);
        if (
          scenario.expectKind &&
          result.outcome.kind !== scenario.expectKind
        ) {
          v.push(`want ${scenario.expectKind}, got ${result.outcome.kind}`);
        }
      }
      if (scenario.expectNoReserve && server.reserves.length > 0) {
        v.push('reserved a permit for a request refused up front');
      }
      const telemetry = (scenario.request as { evaluationTelemetry?: unknown })
        .evaluationTelemetry;
      const consent =
        typeof telemetry === 'object' && telemetry !== null
          ? Boolean((telemetry as { consentActive?: unknown }).consentActive)
          : false;
      if (w.trials.length > 0 && !consent)
        v.push('evaluation trial enqueued without consent');
      if (w.trials.length > 1)
        v.push(`${w.trials.length} evaluation trials for one run`);
      checkPermitAccounting(result.outcome, server, w, v, { rejected: false });
      checkPersistedRows(w, v);
      checkPollution(v);
      recordRow(
        rowFor(`C:${index}`, seed, 'C', scenario.ops, result, server, w, v, 0),
      );
    });
  });

  describe('E. concurrent mixed batches with provider throws', () => {
    campaignTest('E')('E:%i', async index => {
      const seed = seedFor('E', index);
      const rng = new Rng(seed);
      const batch = rng.int(2, 6);
      const actualAnalyze = pipeline.analyzeCapture;
      const spy = jest.spyOn(pipeline, 'analyzeCapture');
      spy.mockImplementation(async (providers, input, options) => {
        if (input.captureId.includes('__throw__')) {
          throw new Error(`stress provider throw ${input.captureId}`);
        }
        return actualAnalyze(providers, input, options);
      });
      const server = permitServer(
        (c, n) =>
          jsonResponse(
            validPermitBody(`permit-${n}-${c.idempotencyKey ?? 'k'}`),
          ),
        () =>
          rng.chance(0.2) ? jsonResponse({}, 500) : jsonResponse({ ok: true }),
      );
      global.fetch = server.fetch as unknown as typeof fetch;
      const sidecars = new Map<string, string>();
      mockReadArtifact = async uri => sidecars.get(uri) ?? '';
      const members: Array<{
        captureId: string;
        uri: string;
        ops: string[];
        throws: boolean;
        stale: boolean;
        db: LocalDb;
        calls: RecordedCall[];
        request: RunCaptureAnalysisRequest;
      }> = [];
      for (let m = 0; m < batch; m++) {
        const kind = rng.pick(['valid', 'valid', 'mutated', 'throw']);
        const { db, calls } = recordingDb();
        const uri = `file:///tmp/stress-E-${index}-${m}.pose.json`;
        let json = CANONICAL_SIDECAR;
        let ops = ['valid'];
        let stale = false;
        if (kind === 'mutated') {
          const mutation = mutateSidecar(rng);
          json = mutation.json;
          ops = mutation.ops;
          stale = !mutation.rehash;
        }
        sidecars.set(uri, json);
        const clip = clipFor(json, stale ? CANONICAL_SHA : sha256Hex(json));
        clip.poseSequence = { ...clip.poseSequence!, uri };
        const captureId =
          kind === 'throw' ? `capture-${m}-__throw__` : `capture-${m}`;
        members.push({
          captureId,
          uri,
          ops: kind === 'throw' ? ['providerThrow'] : ops,
          throws: kind === 'throw',
          stale,
          db,
          calls,
          request: { ...BASE_REQUEST(clip, db), captureId },
        });
      }
      const results = await Promise.all(
        rng.shuffle(members.slice()).map(async member => ({
          member,
          result: await runOne(member.request),
        })),
      );
      const v: string[] = [];
      currentObservations = [];
      const finalizeByPermit = new Map<string, string[]>();
      for (const f of server.finalizes) {
        const id =
          /analysis-permits\/([^/]+)\/finalize/.exec(f.url)?.[1] ?? '?';
        const arr = finalizeByPermit.get(id) ?? [];
        arr.push(String((f.body as { outcome?: unknown } | null)?.outcome));
        finalizeByPermit.set(id, arr);
      }
      for (const [id, outs] of finalizeByPermit) {
        if (outs.length > 1)
          v.push(`permit ${id} finalized ${outs.length}× (${outs.join(',')})`);
      }
      const keys = server.reserves.map(r => r.idempotencyKey);
      if (new Set(keys).size !== keys.length)
        v.push('duplicate Idempotency-Key across concurrent reserves');
      let totalShots = 0;
      let totalOutbox = 0;
      let scored = 0;
      for (const { member, result } of results) {
        const w = summarizeWrites(member.calls);
        totalShots += w.shots.length;
        totalOutbox += w.outbox.length;
        if (member.throws) {
          if (result.rejected === null)
            v.push(
              `${member.captureId}: provider throw was swallowed (outcome ${result.outcome?.kind})`,
            );
          if (w.durable > 0)
            v.push(
              `${member.captureId}: provider throw made ${w.durable} DB call(s)`,
            );
        } else {
          if (result.rejected !== null)
            v.push(
              `${member.captureId}: threw ${String(result.rejected).slice(0, 200)}`,
            );
          if (result.outcome) {
            checkOutcomeShape(result.outcome, v);
            if (result.outcome.kind === 'scored') scored++;
            if (member.stale && result.outcome.kind !== 'unavailable')
              v.push('stale hash accepted');
          }
        }
        checkPersistedRows(w, v);
      }
      const throwers = members.filter(m => m.throws).length;
      const failedFinalizes = server.finalizes.filter(
        f => (f.body as { outcome?: unknown } | null)?.outcome === 'failed',
      ).length;
      if (failedFinalizes !== throwers) {
        // Every provider throw must release exactly one permit as 'failed';
        // no other member in this batch can legitimately produce 'failed'
        // (mutated sidecars are refused before reserve; valid ones score).
        v.push(
          `provider throws=${throwers} but 'failed' finalizes=${failedFinalizes}`,
        );
      }
      if (scored + server.finalizes.length !== server.reserves.length) {
        v.push(
          `reserves=${server.reserves.length} ≠ scored ${scored} + finalized ${server.finalizes.length}`,
        );
      }
      if (totalShots !== scored)
        v.push(`scored=${scored} but local_shot rows=${totalShots}`);
      if (totalOutbox !== scored)
        v.push(`scored=${scored} but outbox rows=${totalOutbox}`);
      const exceptions = stabilitySlo
        .events()
        .filter(
          e => e.kind === 'analysis_failed' && e.failureKind === 'exception',
        ).length;
      if (exceptions !== throwers)
        v.push(`telemetry exception events=${exceptions} want ${throwers}`);
      checkPollution(v);
      const summaryOps = members.map(m => m.ops.join('+'));
      const combinedW: WriteSummary = {
        shots: [],
        outbox: [],
        trials: [],
        records: [],
        begins: 0,
        commits: 0,
        rollbacks: 0,
        total: 0,
        durable: 0,
      };
      for (const m of members) {
        const w = summarizeWrites(m.calls);
        combinedW.shots.push(...w.shots);
        combinedW.outbox.push(...w.outbox);
        combinedW.records.push(...w.records);
        combinedW.total += w.total;
        combinedW.durable += w.durable;
      }
      const ms = Math.max(...results.map(r => r.result.ms));
      recordRow(
        rowFor(
          `E:${index}`,
          seed,
          'E',
          summaryOps,
          { outcome: null, rejected: null, ms },
          server,
          combinedW,
          v,
          0,
          members.length,
        ),
      );
    });
  });
});
