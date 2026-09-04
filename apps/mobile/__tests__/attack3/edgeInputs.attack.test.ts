/**
 * ADVERSARIAL PASS 3 / mobile-analyze-capture — extra (self-assigned) attacks
 * on `runCaptureAnalysis` and `assertCapturedClip`:
 *
 *  E1 corrupt state — sidecar hash mismatch / unreadable sidecar
 *  E2 malformed permit-server replies (no permit, empty id, non-JSON)
 *  E3 release endpoint failing on the non-scored path
 *  E4 clock skew — capturedAtIso far in the future / permit already expired
 *  E5 unicode + huge numeric inputs through validation and the envelope
 *  E6 rapid repeats — N concurrent runs for ONE captureId at the entry point
 *
 * Seeded randomness: the pose sequence comes from the deterministic
 * `generateSwingSequence()` (no seed parameter; output is fixed).
 */
import { generateSwingSequence } from '@pickle/evaluation';
import { serializePoseSequence, sha256Hex } from '@pickle/swing-domain';
import * as pipeline from '@pickle/analysis-pipeline';
import type { LocalDb } from '../../src/data/db';
import {
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import {
  assertCapturedClip,
  type CapturedClip,
} from '../../src/camera/capture';
import { attemptCaptureEnvelope } from '../../src/camera/captureEnvelope';
import { runCaptureAnalysis } from '../../src/analysis/runCaptureAnalysis';

jest.mock('../../src/camera/capture', () => {
  const actual = jest.requireActual('../../src/camera/capture');
  return {
    ...actual,
    readCaptureArtifact: (uri: string) => mockReadArtifact(uri),
  };
});

jest.mock('@pickle/analysis-pipeline', () => {
  const actual = jest.requireActual('@pickle/analysis-pipeline');
  return { __esModule: true, ...actual };
});

let mockReadArtifact: (uri: string) => Promise<string> = async () => {
  throw new Error('readCaptureArtifact mock not configured');
};

const owner = '66666666-6666-4666-8666-666666666666';

interface RecordedCall {
  sql: string;
  params: unknown[];
}

function recordingDb(): { db: LocalDb; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const db: LocalDb = {
    async execute(sql, params = []) {
      calls.push({ sql, params });
      return { rows: [] };
    },
    close() {},
  };
  return { db, calls };
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: 'x',
    json: async () => body,
  } as unknown as Response;
}

interface Server {
  reserves: number;
  finalized: Array<{ permitId: string; outcome: unknown }>;
  fetchMock: jest.Mock;
}

function permitServer(options: {
  reserveBody?: (n: number) => unknown;
  reserveStatus?: number;
  finalizeStatus?: number;
  expiresAt?: string;
}): Server {
  const server: Server = { reserves: 0, finalized: [], fetchMock: jest.fn() };
  server.fetchMock.mockImplementation(
    async (url: string, init?: RequestInit) => {
      if (url.endsWith('/v1/analysis-permits')) {
        server.reserves += 1;
        if (options.reserveBody) {
          return jsonResponse(
            options.reserveStatus ?? 200,
            options.reserveBody(server.reserves),
          );
        }
        return jsonResponse(options.reserveStatus ?? 200, {
          permit: {
            id: `permit-${server.reserves}`,
            accessSource: 'free',
            status: 'reserved',
            expiresAt: options.expiresAt ?? '2026-09-04T20:00:00.000Z',
          },
        });
      }
      const finalize = /\/v1\/analysis-permits\/([^/]+)\/finalize$/.exec(url);
      if (finalize) {
        const body = JSON.parse(String(init?.body)) as { outcome?: unknown };
        server.finalized.push({
          permitId: decodeURIComponent(finalize[1]!),
          outcome: body.outcome,
        });
        return jsonResponse(options.finalizeStatus ?? 200, { ok: true });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    },
  );
  (globalThis as { fetch?: unknown }).fetch = server.fetchMock;
  return server;
}

function swingClip(
  overrides: Partial<Pick<CapturedClip, 'uri' | 'fps' | 'capturedAtIso'>> = {},
): { clip: CapturedClip; sidecarJson: string } {
  const { sequence, window } = generateSwingSequence();
  const sidecarJson = serializePoseSequence(sequence);
  const uri = overrides.uri ?? 'file:///captures/attack3-edge.mov';
  const clip: CapturedClip = {
    uri,
    durationMs: window.endMs,
    fps: overrides.fps ?? 60,
    width: 1080,
    height: 1080,
    capturedAtIso: overrides.capturedAtIso ?? '2026-09-04T12:00:00.000Z',
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
      uri: `${uri}.pose.json`,
      frameCount: sequence.frames.length,
      sha256: sha256Hex(sidecarJson),
      coordinateSystem: 'normalized_image_top_left',
      poseModelVersion: 'apple-vision-bodypose-1',
    },
  };
  return { clip, sidecarJson };
}

function request(db: LocalDb, clip: CapturedClip, captureId = 'capture-edge') {
  return {
    db,
    captureId,
    clip,
    declaredStroke: 'forehand_drive' as const,
    handedness: 'right' as const,
    cameraView: 'side' as const,
    apiConfig: { baseUrl: 'https://api.test', token: 'token-1' },
    appVersion: '0.1.0',
  };
}

const sqlOf = (calls: RecordedCall[]) => calls.map(c => c.sql.trim());

beforeEach(() => setActiveDataOwner(owner));
afterEach(() => {
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  (globalThis as { fetch?: unknown }).fetch = undefined;
});

describe('E1 — corrupt state', () => {
  it('sidecar hash mismatch: unavailable BEFORE any permit reserve or durable write (HELD)', async () => {
    const { clip, sidecarJson } = swingClip();
    // One flipped byte in the recorded sequence.
    mockReadArtifact = async () => sidecarJson.replace('"frames"', '"frame5"');
    const server = permitServer({});
    const { db, calls } = recordingDb();
    const outcome = await runCaptureAnalysis(request(db, clip));
    expect(outcome.kind).toBe('unavailable');
    if (outcome.kind !== 'unavailable') throw new Error('unreachable');
    expect(outcome.reason).toMatch(/integrity check/);
    expect(server.reserves).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('sidecar unreadable (native read throws): unavailable, no permit, no write (HELD)', async () => {
    const { clip } = swingClip();
    mockReadArtifact = async () => {
      throw new Error('ENOENT');
    };
    const server = permitServer({});
    const { db, calls } = recordingDb();
    const outcome = await runCaptureAnalysis(request(db, clip));
    expect(outcome).toMatchObject({
      kind: 'unavailable',
      reason: expect.stringMatching(/could not be read/),
    });
    expect(server.reserves).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('sidecar bytes match the hash but are not a pose sequence: unavailable, no permit (HELD)', async () => {
    const { clip } = swingClip();
    const garbage = '{"schemaVersion":1,"format":"pickle.pose-sequence.v1"}';
    clip.poseSequence!.sha256 = sha256Hex(garbage);
    mockReadArtifact = async () => garbage;
    const server = permitServer({});
    const { db, calls } = recordingDb();
    const outcome = await runCaptureAnalysis(request(db, clip));
    expect(outcome).toMatchObject({
      kind: 'unavailable',
      reason: expect.stringMatching(/pose sequence is invalid/),
    });
    expect(server.reserves).toBe(0);
    expect(calls).toHaveLength(0);
  });
});

describe('E2 — malformed permit-server replies', () => {
  it('200 with an empty body: no inference, no write, unavailable with the generic reachability message (HELD, wording noted)', async () => {
    const { clip, sidecarJson } = swingClip();
    mockReadArtifact = async () => sidecarJson;
    const server = permitServer({ reserveBody: () => ({}) });
    const { db, calls } = recordingDb();
    const outcome = await runCaptureAnalysis(request(db, clip));
    // `reserved.permit.id` throws TypeError → caught by the reserve catch →
    // rendered as "could not be reached" although the server DID answer.
    expect(outcome).toMatchObject({
      kind: 'unavailable',
      reason: expect.stringMatching(/could not be reached/),
    });
    expect(server.reserves).toBe(1);
    expect(calls).toHaveLength(0);
  });

  it('200 with permit.id = "" (empty string): inference RUNS, the analysis record + capture status are written, then saveAnalysis THROWS out of runCaptureAnalysis — half-promoted, exception to the caller (same class as S1)', async () => {
    const { clip, sidecarJson } = swingClip();
    mockReadArtifact = async () => sidecarJson;
    const server = permitServer({
      reserveBody: () => ({
        permit: {
          id: '',
          accessSource: 'free',
          status: 'reserved',
          expiresAt: '2026-09-04T20:00:00.000Z',
        },
      }),
    });
    const { db, calls } = recordingDb();
    let thrown: unknown = null;
    let outcome: Awaited<ReturnType<typeof runCaptureAnalysis>> | null = null;
    try {
      outcome = await runCaptureAnalysis(request(db, clip));
    } catch (error) {
      thrown = error;
    }
    expect(server.reserves).toBe(1);
    const sql = sqlOf(calls);
    const recordWritten = sql.some(s =>
      s.startsWith('INSERT INTO local_analysis_record'),
    );
    const shotWritten = sql.some(s => s.startsWith('INSERT INTO local_shot'));
    if (thrown !== null) {
      // Observed on 4d812e1a: the repository guard rejects the empty permit id
      // AFTER the record and status writes, and the exception escapes.
      expect(String((thrown as Error).message)).toMatch(
        /server-reserved analysis permit is required/,
      );
      expect(recordWritten).toBe(true);
      expect(
        sql.some(s =>
          s.startsWith("UPDATE local_capture SET status = 'analyzed'"),
        ),
      ).toBe(true);
      expect(shotWritten).toBe(false);
      expect(server.finalized).toEqual([]);
    } else {
      expect(outcome).not.toBeNull();
      expect(['low_confidence', 'unavailable']).toContain(outcome!.kind);
    }
  });

  it('reserve answers 429 Too Many Requests: unavailable with the server message, nothing written (HELD)', async () => {
    const { clip, sidecarJson } = swingClip();
    mockReadArtifact = async () => sidecarJson;
    const server = permitServer({
      reserveStatus: 429,
      reserveBody: () => ({
        error: { code: 'rate_limited', message: 'Too many requests.' },
      }),
    });
    const { db, calls } = recordingDb();
    const outcome = await runCaptureAnalysis(request(db, clip));
    expect(outcome).toMatchObject({
      kind: 'unavailable',
      reason: 'Too many requests.',
    });
    expect(server.reserves).toBe(1);
    expect(calls).toHaveLength(0);
  });
});

describe('E3 — release endpoint failing on the non-scored path', () => {
  afterEach(() => jest.restoreAllMocks());

  it('finalize returns 500 after an inference failure (result.ok === false): release is attempted once with outcome failed, the 500 is swallowed, and the caller gets a typed unavailable (HELD — server sweep is the backstop)', async () => {
    const { clip, sidecarJson } = swingClip();
    mockReadArtifact = async () => sidecarJson;
    const server = permitServer({ finalizeStatus: 500 });
    const { db, calls } = recordingDb();
    jest.spyOn(pipeline, 'analyzeCapture').mockImplementation(
      async () =>
        ({
          ok: false,
          failure: { code: 'attack3', message: 'inference declined honestly' },
        }) as never,
    );
    const outcome = await runCaptureAnalysis(request(db, clip));
    expect(outcome).toEqual({
      kind: 'unavailable',
      reason: 'inference declined honestly',
    });
    expect(server.reserves).toBe(1);
    expect(server.finalized).toEqual([
      { permitId: 'permit-1', outcome: 'failed' },
    ]);
    expect(calls).toHaveLength(0);
  });
});

describe('E4 — clock skew', () => {
  it('capturedAtIso 100 years in the future passes validation and is persisted verbatim; an already-expired permit expiresAt is not checked client-side (observed)', async () => {
    const { clip, sidecarJson } = swingClip({
      capturedAtIso: '2126-09-04T12:00:00.000Z',
    });
    mockReadArtifact = async () => sidecarJson;
    const validated = assertCapturedClip(clip, 'automatic_pose_trigger');
    expect(validated.capturedAtIso).toBe('2126-09-04T12:00:00.000Z');
    const server = permitServer({ expiresAt: '2000-01-01T00:00:00.000Z' });
    const { db, calls } = recordingDb();
    const outcome = await runCaptureAnalysis(request(db, validated));
    expect(server.reserves).toBe(1);
    expect(['scored', 'low_confidence']).toContain(outcome.kind);
    const record = calls.find(c =>
      c.sql.includes('INSERT INTO local_analysis_record'),
    );
    expect(record).toBeDefined();
    expect(JSON.stringify(record!.params)).toContain(
      '2126-09-04T12:00:00.000Z',
    );
  });
});

describe('E5 — unicode and huge inputs', () => {
  it('unicode file URI (emoji + CJK + RTL) passes validation and is forwarded to the sidecar reader byte-for-byte; scoring proceeds (HELD)', async () => {
    const uri = 'file:///captures/📹 スイング ضربة\u200f.mov';
    const { clip, sidecarJson } = swingClip({ uri });
    const seen: string[] = [];
    mockReadArtifact = async (requested: string) => {
      seen.push(requested);
      return sidecarJson;
    };
    const validated = assertCapturedClip(clip, 'automatic_pose_trigger');
    expect(validated.uri).toBe(uri);
    permitServer({});
    const { db } = recordingDb();
    const outcome = await runCaptureAnalysis(request(db, validated));
    expect(seen).toEqual([`${uri}.pose.json`]);
    expect(['scored', 'low_confidence']).toContain(outcome.kind);
  });

  it('fps 1e12 passes assertCapturedClip and the envelope reports frame_rate SUPPORTED (no upper bound); Infinity is rejected (observed)', () => {
    const { clip } = swingClip({ fps: 1e12 });
    const validated = assertCapturedClip(clip, 'automatic_pose_trigger');
    const envelope = attemptCaptureEnvelope(validated, null, null);
    expect(
      envelope.dimensions.find(d => d.dimension === 'frame_rate')?.status,
    ).toBe('SUPPORTED');
    expect(() =>
      assertCapturedClip(
        { ...clip, fps: Number.POSITIVE_INFINITY },
        'automatic_pose_trigger',
      ),
    ).toThrow(/invalid or incomplete/);
  });

  it('a 4 MB uri string is accepted by assertCapturedClip (no length cap) (observed)', () => {
    const { clip } = swingClip({
      uri: `file:///${'a'.repeat(4 * 1024 * 1024)}.mov`,
    });
    const validated = assertCapturedClip(clip, 'automatic_pose_trigger');
    expect(validated.uri.length).toBeGreaterThan(4 * 1024 * 1024);
  });
});

describe('E6 — rapid repeats at the entry point', () => {
  it('5 concurrent runCaptureAnalysis calls for ONE captureId reserve 5 permits and write 5 records — dedupe lives only in the screen (observed; the screen guard is covered by S7)', async () => {
    const { clip, sidecarJson } = swingClip();
    mockReadArtifact = async () => sidecarJson;
    const server = permitServer({});
    const { db, calls } = recordingDb();
    const outcomes = await Promise.all(
      Array.from({ length: 5 }, () =>
        runCaptureAnalysis(request(db, clip, 'capture-same-id')),
      ),
    );
    expect(
      outcomes.every(o => o.kind === 'scored' || o.kind === 'low_confidence'),
    ).toBe(true);
    expect(server.reserves).toBe(5);
    expect(
      sqlOf(calls).filter(s =>
        s.startsWith('INSERT INTO local_analysis_record'),
      ),
    ).toHaveLength(5);
  });
});
