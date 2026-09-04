/**
 * Cross-cutting security harness (secrets / logging / privacy): seeded
 * adversarial fuzz of every mobile egress boundary and of the Keychain vault.
 *
 * What it proves, at scale (XC_ITER iterations per boundary, default 2000):
 *   1. /v1/shots:sync wire payload — a persisted ShotAnalysis stuffed with
 *      pose landmarks, clip/sidecar file URIs, tokens, emails, device ids and
 *      base64 blobs in every non-canonical slot never leaks any of them onto
 *      the wire; the wire key set is exactly the canonical allowlist.
 *   2. /v1/me/evaluation/trials wire payload — same adversarial record through
 *      buildEvaluationTrial + drainOutbox; consent=false always yields nothing.
 *   3. Keychain vault — every setGenericPassword call carries the
 *      AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY class + the vault service, stores
 *      exactly the allowlisted keys (never an access/provider token), and a
 *      tampered/malformed record is rejected AND cleared on load.
 *
 * Every failure is recorded with {seed, iteration, boundary, sentinelKind}
 * so it replays with XC_SEED=<seed> XC_ITER=<iteration+1>. A JSON matrix of
 * the run is written to XC_ARTIFACT_DIR (default: os.tmpdir()).
 *
 *   cd apps/mobile && XC_SEED=1 XC_ITER=2000 XC_ARTIFACT_DIR=/tmp/xc \
 *     npx jest --ci --silent __tests__/xc/xcSecretsEgressFuzz.test.ts
 */
import type { ShotAnalysis } from '@pickle/shared-types';
import { validateEvaluationTrial } from '@pickle/shared-types';
import type { CaptureAnalysisRecord } from '@pickle/analysis-pipeline';
import * as Keychain from 'react-native-keychain';
import type { CaptureAnalysisOutcome } from '../../src/analysis/runCaptureAnalysis';
import type { LocalDb } from '../../src/data/db';
import { drainOutbox, type SyncTransport } from '../../src/data/sync';
import {
  buildEvaluationTrial,
  recordEvaluationTrial,
  type EvaluationTelemetryContext,
} from '../../src/evaluation/trialCapture';
import {
  GUEST_DATA_OWNER,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import {
  clearPersistedSession,
  loadPersistedSession,
  savePersistedSession,
  SESSION_VAULT_SERVICE,
  type PersistedSession,
} from '../../src/account/sessionVault';

// Node built-ins, typed the same way be-mobile-security-secrets.test.ts does
// (the RN tsconfig ships no node types).
declare const require: (id: string) => unknown;
declare const process: { env: Record<string, string | undefined> };
const fs = require('fs') as {
  mkdirSync: (p: string, options: { recursive: true }) => void;
  writeFileSync: (p: string, data: string) => void;
};
const os = require('os') as { tmpdir: () => string };
const path = require('path') as { join: (...parts: string[]) => string };

// ─── Deterministic PRNG (mulberry32) ─────────────────────────────────────────

const SEED = Number.parseInt(process.env.XC_SEED ?? '1602847', 10);
const ITER = Number.parseInt(process.env.XC_ITER ?? '2000', 10);
const ARTIFACT_DIR = process.env.XC_ARTIFACT_DIR ?? os.tmpdir();

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

const ALPHANUM =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

function randomString(rng: () => number, length: number, alphabet = ALPHANUM) {
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += alphabet[Math.floor(rng() * alphabet.length)];
  }
  return out;
}

function randomUuid(rng: () => number): string {
  const hex = '0123456789abcdef';
  const s = (n: number) => randomString(rng, n, hex);
  return `${s(8)}-${s(4)}-4${s(3)}-8${s(3)}-${s(12)}`;
}

// ─── Adversarial sentinels ───────────────────────────────────────────────────

type SentinelKind =
  | 'jwt'
  | 'bearer'
  | 'refresh_token'
  | 'stripe_like_key'
  | 'github_like_token'
  | 'email'
  | 'file_uri'
  | 'private_path'
  | 'base64_blob'
  | 'idfv_uuid'
  | 'pose_landmark_marker';

interface Sentinel {
  kind: SentinelKind;
  value: string;
  /** Substring whose presence in an egress string proves a leak. */
  needle: string;
}

function makeSentinels(rng: () => number, iteration: number): Sentinel[] {
  const tag = `XC${iteration}_${randomString(rng, 10)}`;
  const jwt = `eyJhbGciOiJIUzI1NiJ9.${randomString(rng, 40)}${tag}.${randomString(rng, 43)}`;
  const idfv = randomUuid(rng).toUpperCase();
  return [
    { kind: 'jwt', value: jwt, needle: jwt },
    {
      kind: 'bearer',
      value: `Bearer ${randomString(rng, 32)}${tag}-brr`,
      needle: `${tag}-brr`,
    },
    {
      kind: 'refresh_token',
      value: `${randomString(rng, 12)}-${tag}-rt`,
      needle: `${tag}-rt`,
    },
    {
      kind: 'stripe_like_key',
      value: `sk_live_${randomString(rng, 24)}${tag}`,
      needle: `sk_live_`,
    },
    {
      kind: 'github_like_token',
      value: `ghp_${randomString(rng, 36)}${tag}`,
      needle: `ghp_`,
    },
    {
      kind: 'email',
      value: `${randomString(rng, 8).toLowerCase()}.${tag.toLowerCase()}@example.com`,
      needle: `@example.com`,
    },
    {
      kind: 'file_uri',
      value: `file:///var/mobile/Containers/Data/Application/${randomUuid(rng).toUpperCase()}/Library/Application%20Support/PickleSensei/Captures/stroke-${randomUuid(rng)}.pose.json`,
      needle: `file:///`,
    },
    {
      kind: 'private_path',
      value: `/private/var/mobile/Containers/Data/Application/${randomUuid(rng).toUpperCase()}/Library/Application Support/PickleSensei/Captures/stroke-${randomUuid(rng)}.mov`,
      needle: `/private/var/mobile`,
    },
    {
      kind: 'base64_blob',
      value: `${randomString(rng, 96, `${ALPHANUM}+/`)}${tag}==`,
      needle: `${tag}==`,
    },
    { kind: 'idfv_uuid', value: idfv, needle: idfv },
    {
      kind: 'pose_landmark_marker',
      value: `landmark:${tag}`,
      needle: `landmark:${tag}`,
    },
  ];
}

function sentinelOf(sentinels: Sentinel[], kind: SentinelKind): Sentinel {
  const found = sentinels.find(s => s.kind === kind);
  if (!found) throw new Error(`missing sentinel ${kind}`);
  return found;
}

/** Uniform pick that is total: the sentinel list is never empty. */
function pickSentinel(rng: () => number, sentinels: Sentinel[]): Sentinel {
  const picked = sentinels[Math.floor(rng() * sentinels.length)];
  if (!picked) throw new Error('sentinel list is empty');
  return picked;
}

function poseFrames(rng: () => number, sentinel: Sentinel, frames: number) {
  const out: Array<Record<string, unknown>> = [];
  for (let i = 0; i < frames; i += 1) {
    out.push({
      i,
      t: i * 33,
      c: rng(),
      l: [
        { n: 'nose', x: rng(), y: rng(), v: rng() },
        { n: 'right_wrist', x: rng(), y: rng(), v: rng() },
        { n: sentinel.value, x: rng(), y: rng(), v: rng() },
      ],
    });
  }
  return out;
}

function leaks(serialized: string, sentinels: Sentinel[]): SentinelKind[] {
  return sentinels.filter(s => serialized.includes(s.needle)).map(s => s.kind);
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

const SHOT_TYPES = ['dink', 'forehand_drive', 'backhand_drive', 'serve'];
const CAMERA_VIEWS = ['side', 'behind', 'front'];

function baseAnalysis(rng: () => number): ShotAnalysis {
  return {
    id: randomUuid(rng),
    sessionId: rng() < 0.5 ? randomUuid(rng) : null,
    shotType: SHOT_TYPES[
      Math.floor(rng() * SHOT_TYPES.length)
    ] as ShotAnalysis['shotType'],
    cameraView: CAMERA_VIEWS[
      Math.floor(rng() * CAMERA_VIEWS.length)
    ] as ShotAnalysis['cameraView'],
    handedness: rng() < 0.5 ? 'right' : 'left',
    capturedAtIso: new Date(
      Date.UTC(2026, 8, 1) + Math.floor(rng() * 86_400_000),
    ).toISOString(),
    timestamps: { startMs: 0, contactMs: rng() < 0.8 ? 450 : null, endMs: 900 },
    phases: [
      {
        key: 'prepare',
        startMs: 0,
        representativeMs: 150,
        endMs: 300,
        confidence: rng(),
      },
      {
        key: 'contact',
        startMs: 300,
        representativeMs: 450,
        endMs: 500,
        confidence: rng(),
      },
    ],
    measurements: [
      {
        metricKey: 'wrist_height',
        value: rng(),
        confidence: rng(),
        unit: 'normalized',
        source: 'real',
      },
    ],
    checkpoints: [
      {
        key: 'contact_position',
        score: Math.round(rng() * 100) / 10,
        confidence: rng(),
        band: 'good',
        direction: null,
        severity: null,
        applicable: true,
      } as unknown as ShotAnalysis['checkpoints'][number],
    ],
    overallScore: Math.round(rng() * 100) / 10,
    analysisConfidence: rng(),
    resultKind: 'scored',
    guidance: null,
    priorityFix: null,
    versionVector: {
      appVersion: '1.0',
      modelBundleVersion: 'on-device-fusion-1',
      poseModelVersion: 'pose-1',
      paddleModelVersion: 'none',
      strokeDetectorVersion: 'stroke-1',
      phaseModelVersion: 'phase-1',
      scoringModelVersion: 'score-1',
      shotConfigVersion: 'dink-1',
    },
    source: 'real',
  };
}

/**
 * A persisted shot record the way a hostile/buggy writer could leave it in
 * SQLite: canonical fields plus every place a secret, path or pose frame
 * could plausibly hitch a ride. Only the canonical projection may reach the
 * wire.
 */
function adversarialPersistedShot(
  rng: () => number,
  sentinels: Sentinel[],
  analysisPermitId: string,
): Record<string, unknown> {
  const pick = () => pickSentinel(rng, sentinels);
  const of = (kind: SentinelKind) => sentinelOf(sentinels, kind).value;
  const analysis = baseAnalysis(rng);
  const withJunk: Record<string, unknown> = {
    ...analysis,
    analysisPermitId,
    // Non-canonical top-level slots.
    clip: {
      uri: of('private_path'),
      posterUri: of('file_uri'),
      poseSequence: {
        uri: of('file_uri'),
        sha256: randomString(rng, 64, '0123456789abcdef'),
        frames: poseFrames(rng, pick(), 3),
      },
    },
    poseSequence: {
      uri: of('file_uri'),
      frames: poseFrames(rng, pick(), 2),
    },
    landmarks: poseFrames(rng, pick(), 2),
    accessToken: of('jwt'),
    refreshToken: of('refresh_token'),
    authorization: of('bearer'),
    email: of('email'),
    deviceId: of('idfv_uuid'),
    debugBlob: of('base64_blob'),
    apiKey: of('stripe_like_key'),
    ghToken: of('github_like_token'),
    // Canonical slots that are strings but NOT projected: guidance /
    // priorityFix / measurements / handedness.
    guidance: pick().value,
    priorityFix: { checkpointKey: 'contact_position', note: pick().value },
    measurements: [
      {
        metricKey: pick().value,
        value: rng(),
        confidence: rng(),
        unit: 'normalized',
        source: 'real',
      },
    ],
  };
  // Randomly nest a sentinel into a projected sub-object's EXTRA key so we
  // prove the projection copies only known keys (checkpoints are re-mapped
  // field-by-field; timestamps/phases/versionVector are passed by reference).
  const checkpoint = (
    withJunk.checkpoints as Array<Record<string, unknown>>
  )[0];
  if (!checkpoint) throw new Error('baseAnalysis must yield a checkpoint');
  checkpoint.debugUri = pick().value;
  checkpoint.frames = poseFrames(rng, pick(), 1);
  return withJunk;
}

const WIRE_SHOT_KEYS = [
  'id',
  'analysisPermitId',
  'sessionId',
  'shotType',
  'cameraView',
  'capturedAt',
  'timestamps',
  'overallScore',
  'confidence',
  'resultKind',
  'source',
  'phases',
  'checkpoints',
  'versionVector',
].sort();

const WIRE_CHECKPOINT_KEYS = [
  'key',
  'score',
  'confidence',
  'band',
  'direction',
  'severity',
  'applicable',
].sort();

function fakeDb() {
  interface OutboxRow {
    id: number;
    owner_key: string;
    kind: string;
    payload: string;
    attempts: number;
    last_error: string | null;
  }
  const outbox: OutboxRow[] = [];
  let nextId = 1;
  const db: LocalDb = {
    async execute(sql: string, params: unknown[] = []) {
      if (sql === 'BEGIN IMMEDIATE' || sql === 'COMMIT' || sql === 'ROLLBACK') {
        return { rows: [] };
      }
      if (sql.includes('INSERT OR REPLACE INTO sync_receipt')) {
        return { rows: [] };
      }
      if (sql.includes('INSERT INTO outbox')) {
        outbox.push({
          id: nextId++,
          owner_key: String(params[0]),
          kind: sql.includes("'evaluation.trial'")
            ? 'evaluation.trial'
            : String(params[1] ?? 'shot.sync'),
          payload: String(params[params.length - 1]),
          attempts: 0,
          last_error: null,
        });
        return { rows: [] };
      }
      if (sql.startsWith('SELECT id, kind, payload')) {
        return {
          rows: outbox
            .filter(
              r =>
                r.owner_key === String(params[0]) &&
                r.attempts < Number(params[1]),
            )
            .map(r => ({ ...r })),
        };
      }
      if (sql.startsWith('DELETE FROM outbox')) {
        const idx = outbox.findIndex(
          r => r.owner_key === params[0] && r.id === params[1],
        );
        if (idx >= 0) outbox.splice(idx, 1);
        return { rows: [] };
      }
      if (sql.startsWith('UPDATE outbox')) {
        const row = outbox.find(
          r => r.owner_key === params[1] && r.id === params[2],
        );
        if (row) {
          if (sql.includes('attempts = attempts + 1')) row.attempts += 1;
          row.last_error = String(params[0]);
        }
        return { rows: [] };
      }
      if (sql.startsWith('SELECT count(*)')) {
        return {
          rows: [
            { n: outbox.filter(row => row.owner_key === params[0]).length },
          ],
        };
      }
      throw new Error(`fakeDb: unhandled sql ${sql}`);
    },
    close() {},
  };
  const push = (kind: string, payload: unknown, owner = GUEST_DATA_OWNER) => {
    outbox.push({
      id: nextId++,
      owner_key: owner,
      kind,
      payload: JSON.stringify(payload),
      attempts: 0,
      last_error: null,
    });
  };
  return { db, push, outbox };
}

function capturingTransport() {
  const shotBatches: unknown[][] = [];
  const trialBatches: unknown[][] = [];
  const transport: SyncTransport = {
    async syncShots(shots) {
      shotBatches.push(shots);
      return {
        acceptedIds: shots.map(s => String((s as { id: string }).id)),
        rejected: [],
      };
    },
    async createSession() {},
    async finalizeSession() {},
    async uploadEvaluationTrials(trials) {
      trialBatches.push(trials);
      return {
        acceptedTrialIds: trials.map(t =>
          String((t as { trialId: string }).trialId),
        ),
        rejected: [],
      };
    },
  };
  return { transport, shotBatches, trialBatches };
}

// ─── Evaluation-trial adversarial record ─────────────────────────────────────

function adversarialOutcome(
  rng: () => number,
  sentinels: Sentinel[],
): CaptureAnalysisOutcome {
  const pick = () => pickSentinel(rng, sentinels);
  const result = baseAnalysis(rng);
  result.guidance = pick().value;
  const record = {
    schemaVersion: 1,
    id: randomUuid(rng),
    captureId: randomUuid(rng),
    createdAtIso: result.capturedAtIso,
    engineVersion: 'fusion-1',
    strokeTaxonomyVersion: 'v3',
    strokeResolution: {
      kind: 'predicted',
      shotType: result.shotType,
      confidence: rng(),
    },
    modalities: {
      pose: true,
      paddle: false,
      ball: false,
      court: false,
      camera: true,
    },
    modelRuns: [
      {
        providerId: 'pose.apple-vision',
        inputUri: pick().value,
        frames: poseFrames(rng, pick(), 2),
      },
    ],
    provenance: {
      appVersion: '1.0',
      pipelineVersion: 'fusion-1',
      providerVersions: [
        {
          providerId: 'pose.apple-vision',
          modelVersion: 'pose-1',
          runtime: 'vision_framework',
          executionTarget: 'on_device',
          artifactHash: pick().value,
        },
      ],
      scoreVersion: 'score-1',
      taxonomyVersion: 'v3',
      drillMappingVersion: 'none',
      captureEnvelopeVersion: 'capture-envelope-not-measured',
      recordedAtIso: result.capturedAtIso,
    },
    result,
    faults: [{ code: 'x', detail: pick().value }],
    uncertainty: {
      analysisConfidence: result.analysisConfidence,
      presentation: 'normal',
      perCheckpoint: {},
      limitingFactors: ['paddle_unavailable'],
    },
    evidence: [{ kind: 'frame', uri: pick().value }],
    shadow: [{ note: pick().value }],
    strokeIntent: {
      declaredStroke: null,
      predictedStroke: null,
      resolutionBasis: 'predicted_l3',
      resolvedProfileId: null,
      resolvedProfileVersion: null,
      disagreement: null,
    },
    captureEnvelope: {
      overall: 'SUPPORTED',
      dimensions: [],
      clipUri: pick().value,
    },
    // Non-canonical slots a hostile writer could add.
    clip: { uri: pick().value, poseSequence: { uri: pick().value } },
    accessToken: sentinelOf(sentinels, 'jwt').value,
    email: sentinelOf(sentinels, 'email').value,
  } as unknown as CaptureAnalysisRecord;
  return {
    kind: rng() < 0.7 ? 'scored' : 'low_confidence',
    analysisId: record.id,
    record,
    freeLimitReached: false,
  } as CaptureAnalysisOutcome;
}

const TRIAL_CONTEXT: EvaluationTelemetryContext = {
  consentActive: true,
  dims: {
    userPseudonym: 'pseudonym-fixed',
    sessionId: null,
    courtId: null,
    deviceModel: 'iOS phone',
    devicePlatform: 'ios',
    osVersion: '18.0',
  },
};

// ─── Run bookkeeping ─────────────────────────────────────────────────────────

interface Failure {
  boundary: string;
  seed: number;
  iteration: number;
  leaked: SentinelKind[];
  detail?: string;
}

interface BoundaryStats {
  iterations: number;
  failures: Failure[];
  sentinelsPerIteration: number;
}

const matrix: Record<string, BoundaryStats> = {};

afterAll(() => {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  const file = path.join(ARTIFACT_DIR, 'xc-secrets-egress-fuzz.json');
  fs.writeFileSync(
    file,
    JSON.stringify(
      {
        harness: 'xcSecretsEgressFuzz',
        seed: SEED,
        iterationsRequested: ITER,
        boundaries: matrix,
        totalFailures: Object.values(matrix).reduce(
          (n, b) => n + b.failures.length,
          0,
        ),
      },
      null,
      2,
    ),
  );
});

beforeEach(() => {
  setActiveDataOwner(GUEST_DATA_OWNER);
});

// ─── 1. Shot sync wire payload ───────────────────────────────────────────────

describe(`shot sync egress fuzz (seed=${SEED}, iter=${ITER})`, () => {
  it('never puts pose frames, media URIs, tokens, emails or device ids on the wire', async () => {
    const rng = mulberry32(SEED);
    const failures: Failure[] = [];
    const { db, push } = fakeDb();
    const { transport, shotBatches } = capturingTransport();
    const batch = 50;
    for (let iteration = 0; iteration < ITER; iteration += 1) {
      const sentinels = makeSentinels(rng, iteration);
      push(
        'shot.sync',
        adversarialPersistedShot(rng, sentinels, randomUuid(rng)),
      );
      if ((iteration + 1) % batch === 0 || iteration === ITER - 1) {
        shotBatches.length = 0;
        await drainOutbox(db, transport);
        const wire = shotBatches.flat();
        // Each queued row must have produced exactly one wire shot.
        const expected = ((iteration % batch) + 1) as number;
        if (wire.length !== expected) {
          failures.push({
            boundary: 'shot.sync',
            seed: SEED,
            iteration,
            leaked: [],
            detail: `expected ${expected} wire shots, got ${wire.length}`,
          });
        }
        for (const shot of wire) {
          const serialized = JSON.stringify(shot);
          const keys = Object.keys(shot as Record<string, unknown>).sort();
          const checkpointKeys = (
            (shot as { checkpoints: Array<Record<string, unknown>> })
              .checkpoints ?? []
          ).map(c => Object.keys(c).sort());
          const badKeys =
            JSON.stringify(keys) !== JSON.stringify(WIRE_SHOT_KEYS) ||
            checkpointKeys.some(
              k => JSON.stringify(k) !== JSON.stringify(WIRE_CHECKPOINT_KEYS),
            );
          const leaked = leaks(serialized, sentinels);
          if (leaked.length > 0 || badKeys) {
            failures.push({
              boundary: 'shot.sync',
              seed: SEED,
              iteration,
              leaked,
              detail: badKeys ? `wire keys ${keys.join(',')}` : undefined,
            });
          }
        }
      }
    }
    matrix['shot.sync'] = {
      iterations: ITER,
      failures,
      sentinelsPerIteration: makeSentinels(mulberry32(1), 0).length,
    };
    expect(failures).toEqual([]);
  });
});

// ─── 2. Evaluation trial wire payload ────────────────────────────────────────

describe(`evaluation trial egress fuzz (seed=${SEED}, iter=${ITER})`, () => {
  it('projects only claim metadata; nothing from record internals reaches the wire', async () => {
    const rng = mulberry32(SEED ^ 0x9e3779b9);
    const failures: Failure[] = [];
    const { db } = fakeDb();
    const { transport, trialBatches } = capturingTransport();
    const batch = 50;
    let queued = 0;
    for (let iteration = 0; iteration < ITER; iteration += 1) {
      const sentinels = makeSentinels(rng, iteration);
      const outcome = adversarialOutcome(rng, sentinels);
      const input = {
        outcome,
        captureId: randomUuid(rng),
        capturedAtIso: new Date(Date.UTC(2026, 8, 1)).toISOString(),
        declaredStroke: null,
        latencyMs: Math.floor(rng() * 5000),
        appVersion: '1.0',
        context: TRIAL_CONTEXT,
      };
      // Consent off → nothing built, nothing queued. Ever.
      const withoutConsent = buildEvaluationTrial({
        ...input,
        context: { ...TRIAL_CONTEXT, consentActive: false },
      });
      if (withoutConsent !== null) {
        failures.push({
          boundary: 'evaluation.trial',
          seed: SEED,
          iteration,
          leaked: [],
          detail: 'trial built without consent',
        });
      }
      const trial = await recordEvaluationTrial(db, input);
      if (!trial) {
        failures.push({
          boundary: 'evaluation.trial',
          seed: SEED,
          iteration,
          leaked: [],
          detail: 'consented trial not built',
        });
        continue;
      }
      queued += 1;
      const validation = validateEvaluationTrial(trial);
      if (!validation.ok) {
        failures.push({
          boundary: 'evaluation.trial',
          seed: SEED,
          iteration,
          leaked: [],
          detail: `contract: ${validation.errors.join('; ')}`,
        });
      }
      if (queued % batch === 0 || iteration === ITER - 1) {
        trialBatches.length = 0;
        await drainOutbox(db, transport);
        for (const wireTrial of trialBatches.flat()) {
          const leaked = leaks(JSON.stringify(wireTrial), sentinels);
          if (leaked.length > 0) {
            failures.push({
              boundary: 'evaluation.trial',
              seed: SEED,
              iteration,
              leaked,
            });
          }
        }
      }
      // Per-iteration check against THIS iteration's sentinels (the batch
      // check above only sees the last iteration's sentinels).
      const leaked = leaks(JSON.stringify(trial), sentinels);
      if (leaked.length > 0) {
        failures.push({
          boundary: 'evaluation.trial',
          seed: SEED,
          iteration,
          leaked,
        });
      }
    }
    matrix['evaluation.trial'] = {
      iterations: ITER,
      failures,
      sentinelsPerIteration: makeSentinels(mulberry32(1), 0).length,
    };
    expect(failures).toEqual([]);
  });
});

// ─── 3. Keychain vault ───────────────────────────────────────────────────────

const { __keychainStore } = Keychain as unknown as {
  __keychainStore: Map<
    string,
    { username: string; password: string; accessible?: string }
  >;
};

const VAULT_KEYS = [
  'version',
  'provider',
  'canonicalAppUserId',
  'refreshToken',
  'email',
  'displayName',
].sort();

describe(`Keychain vault fuzz (seed=${SEED}, iter=${ITER})`, () => {
  beforeEach(() => __keychainStore.clear());

  it('every write is AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY under the vault service with exactly the allowlisted keys', async () => {
    const rng = mulberry32(SEED ^ 0x51ed270b);
    const failures: Failure[] = [];
    const setSpy = jest.spyOn(Keychain, 'setGenericPassword');
    for (let iteration = 0; iteration < ITER; iteration += 1) {
      const sentinels = makeSentinels(rng, iteration);
      const session: PersistedSession = {
        version: 1,
        provider: rng() < 0.5 ? 'apple' : 'google',
        canonicalAppUserId: randomUuid(rng),
        refreshToken: sentinels.find(s => s.kind === 'refresh_token')!.value,
        email:
          rng() < 0.5 ? sentinels.find(s => s.kind === 'email')!.value : null,
        displayName: rng() < 0.5 ? randomString(rng, 12) : null,
      };
      setSpy.mockClear();
      const saved = await savePersistedSession(session);
      const call = setSpy.mock.calls[0];
      const options = call?.[2] as
        { service?: string; accessible?: string } | undefined;
      const stored = __keychainStore.get(SESSION_VAULT_SERVICE);
      const storedKeys = stored
        ? Object.keys(JSON.parse(stored.password) as object).sort()
        : [];
      const problems: string[] = [];
      if (!saved) problems.push('save returned false');
      if (setSpy.mock.calls.length !== 1)
        problems.push('setGenericPassword call count != 1');
      if (options?.service !== SESSION_VAULT_SERVICE)
        problems.push(`service=${String(options?.service)}`);
      if (
        options?.accessible !==
        Keychain.ACCESSIBLE.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY
      ) {
        problems.push(`accessible=${String(options?.accessible)}`);
      }
      if (JSON.stringify(storedKeys) !== JSON.stringify(VAULT_KEYS)) {
        problems.push(`stored keys ${storedKeys.join(',')}`);
      }
      if (
        stored &&
        /accessToken|idToken|identityToken|providerToken/i.test(stored.password)
      ) {
        problems.push('stored record names an access/provider token field');
      }
      // The jwt/bearer sentinels model the access + provider tokens that must
      // never be persisted: they were never given to the vault, so any
      // appearance is a harness bug worth failing loudly on.
      const leaked = stored
        ? leaks(
            stored.password,
            sentinels.filter(s => s.kind === 'jwt' || s.kind === 'bearer'),
          )
        : [];
      if (problems.length > 0 || leaked.length > 0) {
        failures.push({
          boundary: 'keychain.save',
          seed: SEED,
          iteration,
          leaked,
          detail: problems.join('; ') || undefined,
        });
      }
      // Round trip must be lossless for the allowlisted record.
      const loaded = await loadPersistedSession();
      if (JSON.stringify(loaded) !== JSON.stringify(session)) {
        failures.push({
          boundary: 'keychain.roundtrip',
          seed: SEED,
          iteration,
          leaked: [],
          detail: 'load != save',
        });
      }
    }
    setSpy.mockRestore();
    matrix['keychain.save'] = {
      iterations: ITER,
      failures,
      sentinelsPerIteration: 2,
    };
    expect(failures).toEqual([]);
  });

  it('rejects and clears a tampered/malformed vault record instead of trusting it', async () => {
    const rng = mulberry32(SEED ^ 0x7f4a7c15);
    const failures: Failure[] = [];
    const mutations = [
      'drop_version',
      'wrong_version',
      'drop_provider',
      'bad_provider',
      'drop_user',
      'empty_user',
      'drop_refresh',
      'empty_refresh',
      'non_string_refresh',
      'array_root',
      'string_root',
      'truncated_json',
      'null_root',
    ] as const;
    for (let iteration = 0; iteration < ITER; iteration += 1) {
      const good: Record<string, unknown> = {
        version: 1,
        provider: 'apple',
        canonicalAppUserId: randomUuid(rng),
        refreshToken: randomString(rng, 40),
        email: null,
        displayName: null,
      };
      const mutation =
        mutations[Math.floor(rng() * mutations.length)] ?? 'null_root';
      let raw = 'null';
      switch (mutation) {
        case 'drop_version':
          delete good.version;
          raw = JSON.stringify(good);
          break;
        case 'wrong_version':
          good.version = 2;
          raw = JSON.stringify(good);
          break;
        case 'drop_provider':
          delete good.provider;
          raw = JSON.stringify(good);
          break;
        case 'bad_provider':
          good.provider = randomString(rng, 6);
          raw = JSON.stringify(good);
          break;
        case 'drop_user':
          delete good.canonicalAppUserId;
          raw = JSON.stringify(good);
          break;
        case 'empty_user':
          good.canonicalAppUserId = '';
          raw = JSON.stringify(good);
          break;
        case 'drop_refresh':
          delete good.refreshToken;
          raw = JSON.stringify(good);
          break;
        case 'empty_refresh':
          good.refreshToken = '';
          raw = JSON.stringify(good);
          break;
        case 'non_string_refresh':
          good.refreshToken = { token: randomString(rng, 10) };
          raw = JSON.stringify(good);
          break;
        case 'array_root':
          raw = JSON.stringify([good]);
          break;
        case 'string_root':
          raw = JSON.stringify(randomString(rng, 20));
          break;
        case 'truncated_json':
          raw = JSON.stringify(good).slice(0, 10 + Math.floor(rng() * 20));
          break;
        case 'null_root':
          raw = 'null';
          break;
      }
      __keychainStore.set(SESSION_VAULT_SERVICE, {
        username: 'session',
        password: raw,
        accessible: Keychain.ACCESSIBLE.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
      });
      const loaded = await loadPersistedSession();
      const stillStored = __keychainStore.has(SESSION_VAULT_SERVICE);
      if (loaded !== null || stillStored) {
        failures.push({
          boundary: 'keychain.tamper',
          seed: SEED,
          iteration,
          leaked: [],
          detail: `${mutation}: loaded=${loaded !== null} stillStored=${stillStored}`,
        });
      }
    }
    await clearPersistedSession();
    matrix['keychain.tamper'] = {
      iterations: ITER,
      failures,
      sentinelsPerIteration: 0,
    };
    expect(failures).toEqual([]);
  });
});
