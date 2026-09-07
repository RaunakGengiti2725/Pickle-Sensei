/**
 * ADVERSARIAL PASS 3 / tester #4 — runCaptureAnalysis permit accounting and
 * artifact integrity attacks against 4d812e1a. REAL pipeline (fusion
 * providers, phase segmentation, scoring) over a synthetic swing fixture from
 * @pickle/evaluation; only the file read (readCaptureArtifact) and the HTTP
 * layer (globalThis.fetch) are simulated. Every `it` pins the behaviour
 * OBSERVED on this commit; titles carry the classification.
 *
 * Seeded probe (recorded): landmark visibility sweep over the canonical
 * generateSwingSequence() fixture → 0.9 scored / 0.5 low_confidence (conf
 * 0.46) / 0.3 low_confidence (0.28) / ≤0.2 unavailable (wrist not measured
 * on enough frames). Visibility 0.5 is therefore the deterministic
 * low-confidence fixture used below.
 */
import { generateSwingSequence } from '@pickle/evaluation';
import { serializePoseSequence, sha256Hex } from '@pickle/swing-domain';
import * as pipeline from '@pickle/analysis-pipeline';
import type { LocalDb } from '../src/data/db';
import {
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../src/data/accountScope';
import type { CapturedClip } from '../src/camera/capture';
import { runCaptureAnalysis } from '../src/analysis/runCaptureAnalysis';

jest.mock('../src/camera/capture', () => {
  const actual = jest.requireActual('../src/camera/capture');
  return {
    ...actual,
    readCaptureArtifact: (uri: string) => mockReadArtifact(uri),
  };
});

// analyzeCapture is re-exported from the pipeline index; a spy on the module
// namespace proves inference never starts for a rejected reservation.
jest.mock('@pickle/analysis-pipeline', () => {
  const actual = jest.requireActual('@pickle/analysis-pipeline');
  return { __esModule: true, ...actual };
});

let mockReadArtifact: (uri: string) => Promise<string> = async () => {
  throw new Error('readCaptureArtifact mock not configured');
};

const owner = '33333333-3333-4333-8333-333333333333';
const LOW_CONFIDENCE_VISIBILITY = 0.5;

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

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : `HTTP ${status}`,
    json: async () => body,
  } as unknown as Response;
}

interface PermitServerOptions {
  permitId?: string;
  accessSource?: 'free' | 'premium';
  /** `undefined` → the `access` block is omitted from the reserve body. */
  access?: unknown;
  reserveStatus?: number;
  reserveBody?: unknown;
  /** How the finalize (release) endpoint behaves. */
  release?: 'ok' | 'reject_network' | 'http_500' | 'http_401';
}

function permitServer(options: PermitServerOptions = {}) {
  const finalizeUrls: string[] = [];
  const finalizeBodies: unknown[] = [];
  const reserveBodies: unknown[] = [];
  const fetchMock = jest.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/v1/analysis-permits')) {
      reserveBodies.push(JSON.parse(String(init?.body)));
      if (options.reserveStatus !== undefined && options.reserveStatus >= 400) {
        return jsonResponse(options.reserveBody ?? null, options.reserveStatus);
      }
      return jsonResponse(
        options.reserveBody ?? {
          permit: {
            id: options.permitId ?? 'permit-attack-1',
            accessSource: options.accessSource ?? 'free',
            status: 'reserved',
            expiresAt: '2026-09-04T20:00:00.000Z',
          },
          ...(options.access !== undefined ? { access: options.access } : {}),
        },
      );
    }
    if (url.includes('/finalize')) {
      finalizeUrls.push(url);
      finalizeBodies.push(JSON.parse(String(init?.body)));
      switch (options.release ?? 'ok') {
        case 'reject_network':
          throw new TypeError('Network request failed');
        case 'http_500':
          return jsonResponse(
            { error: { code: 'internal', message: 'boom' } },
            500,
          );
        case 'http_401':
          return jsonResponse(
            { error: { code: 'auth.invalid', message: 'expired' } },
            401,
          );
        default:
          return jsonResponse({ ok: true });
      }
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
  return { fetchMock, finalizeUrls, finalizeBodies, reserveBodies };
}

/** Lowers every frame confidence and landmark visibility to `visibility`
 * on the canonical swing, re-serializes, and stamps the matching hash. */
function swingClipWithSidecar(visibility: number | null = null): {
  clip: CapturedClip;
  sidecarJson: string;
} {
  const { sequence, window } = generateSwingSequence({});
  const dimmed =
    visibility === null
      ? sequence
      : {
          ...sequence,
          frames: sequence.frames.map(frame => ({
            ...frame,
            confidence: visibility,
            landmarks: frame.landmarks.map(mark => ({ ...mark, visibility })),
          })),
        };
  const sidecarJson = serializePoseSequence(dimmed);
  const clip: CapturedClip = {
    uri: 'file:///captures/attack.mov',
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
      uri: 'file:///captures/attack.pose.json',
      frameCount: sequence.frames.length,
      sha256: sha256Hex(sidecarJson),
      coordinateSystem: 'normalized_image_top_left',
      poseModelVersion: 'apple-vision-bodypose-1',
    },
  };
  return { clip, sidecarJson };
}

function withRecordedHash(clip: CapturedClip, sha256: string): CapturedClip {
  if (clip.captureMode !== 'automatic_pose_trigger' || !clip.poseSequence) {
    throw new Error('fixture must be a guided clip with a pose sequence');
  }
  return { ...clip, poseSequence: { ...clip.poseSequence, sha256 } };
}

function request(db: LocalDb, clip: CapturedClip, captureId = 'capture-a4') {
  return {
    db,
    captureId,
    clip,
    declaredStroke: 'forehand_drive' as const,
    handedness: 'right' as const,
    cameraView: 'side' as const,
    apiConfig: { baseUrl: 'https://api.test', token: 'token-a4' },
    appVersion: '0.1.0',
  };
}

function setFetch(fetchMock: unknown) {
  (globalThis as { fetch?: unknown }).fetch = fetchMock;
}

const localShotInserts = (calls: RecordedCall[]) =>
  calls.filter(call => call.sql.includes('INSERT OR REPLACE INTO local_shot'));
const outboxInserts = (calls: RecordedCall[]) =>
  calls.filter(call => call.sql.includes('INSERT INTO outbox'));

beforeEach(() => setActiveDataOwner(owner));
afterEach(() => {
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  setFetch(undefined);
});

// ─── S2: permits.release rejects on a low-confidence outcome ────────────────

describe('S2 — release rejection on a low-confidence outcome', () => {
  it.each([
    ['network rejection', 'reject_network'],
    ['HTTP 500', 'http_500'],
    ['HTTP 401 (token expired mid-run)', 'http_401'],
  ] as const)(
    '[HELD] %s from finalize: outcome stays low_confidence and the local-only shot is still saved (no outbox entry)',
    async (_label, release) => {
      const { db, calls } = recordingDb();
      const { clip, sidecarJson } = swingClipWithSidecar(
        LOW_CONFIDENCE_VISIBILITY,
      );
      mockReadArtifact = async () => sidecarJson;
      const server = permitServer({ release });
      setFetch(server.fetchMock);

      const outcome = await runCaptureAnalysis(request(db, clip));
      expect(outcome.kind).toBe('low_confidence');
      if (outcome.kind !== 'low_confidence') return;
      expect(outcome.record.result?.resultKind).toBe('low_confidence');
      // The release WAS attempted, with the honest outcome and no ratingId.
      expect(server.finalizeBodies).toEqual([
        { outcome: 'low_confidence', ratingId: null },
      ]);
      expect(server.finalizeUrls[0]).toContain(
        '/v1/analysis-permits/permit-attack-1/finalize',
      );
      // saveLocalOnlyAnalysis executed: local_shot row with result_kind
      // low_confidence, and NOTHING queued for sync.
      const shots = localShotInserts(calls);
      expect(shots).toHaveLength(1);
      expect(shots[0]!.params[7]).toBe('low_confidence');
      expect(outboxInserts(calls)).toHaveLength(0);
      // The analysis record + capture status were persisted before release.
      expect(
        calls.some(call => call.sql.includes('local_analysis_record')),
      ).toBe(true);
      expect(
        calls.some(call => call.sql.includes("SET status = 'analyzed'")),
      ).toBe(true);
    },
  );

  it('[HELD] release is attempted once per abstained run even under 5 rapid repeats (no double-release, no double local save per run)', async () => {
    const { clip, sidecarJson } = swingClipWithSidecar(
      LOW_CONFIDENCE_VISIBILITY,
    );
    mockReadArtifact = async () => sidecarJson;
    const server = permitServer({ release: 'reject_network' });
    setFetch(server.fetchMock);
    const runs = Array.from({ length: 5 }, (_, i) => {
      const { db, calls } = recordingDb();
      return runCaptureAnalysis(request(db, clip, `capture-a4-${i}`)).then(
        outcome => ({ outcome, calls }),
      );
    });
    const settled = await Promise.all(runs);
    for (const { outcome, calls } of settled) {
      expect(outcome.kind).toBe('low_confidence');
      expect(localShotInserts(calls)).toHaveLength(1);
    }
    expect(server.finalizeBodies).toHaveLength(5);
    // Each run reserved with its own idempotency key.
    const keys = server.reserveBodies.map(
      body => (body as { idempotencyKey: string }).idempotencyKey,
    );
    expect(new Set(keys).size).toBe(5);
  });
});

// ─── S3: readCaptureArtifact resolves with an empty string ──────────────────

describe('S3 — empty / degenerate sidecar bytes', () => {
  it('[HELD] empty string → hash-mismatch path, no parse, no permit, no db write', async () => {
    const { db, calls } = recordingDb();
    const { clip } = swingClipWithSidecar();
    mockReadArtifact = async () => '';
    const fetchSpy = jest.fn();
    setFetch(fetchSpy);

    const outcome = await runCaptureAnalysis(request(db, clip));
    expect(outcome.kind).toBe('unavailable');
    if (outcome.kind !== 'unavailable') return;
    expect(outcome.reason).toContain('integrity check');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it('[HELD] empty string whose hash WAS recorded (sha256("")) → parse failure path, still no throw / no permit', async () => {
    const { db, calls } = recordingDb();
    const { clip } = swingClipWithSidecar();
    mockReadArtifact = async () => '';
    const fetchSpy = jest.fn();
    setFetch(fetchSpy);

    const outcome = await runCaptureAnalysis(
      request(db, withRecordedHash(clip, sha256Hex(''))),
    );
    expect(outcome.kind).toBe('unavailable');
    if (outcome.kind !== 'unavailable') return;
    expect(outcome.reason).toContain('invalid');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it.each([
    ['whitespace only', '   \n\t '],
    ['unicode garbage', '💥'.repeat(1000) + '\u0000\uFFFF'],
    ['JSON null', 'null'],
    ['JSON array', '[]'],
    ['truncated real sidecar', 'TRUNCATE'],
    ['5 MB of zeros', '0'.repeat(5 * 1024 * 1024)],
  ])(
    '[HELD] %s → integrity mismatch before any parse, no permit touched',
    async (_label, bytes) => {
      const { db, calls } = recordingDb();
      const { clip, sidecarJson } = swingClipWithSidecar();
      const payload =
        bytes === 'TRUNCATE'
          ? sidecarJson.slice(0, Math.floor(sidecarJson.length / 2))
          : bytes;
      mockReadArtifact = async () => payload;
      const fetchSpy = jest.fn();
      setFetch(fetchSpy);
      const outcome = await runCaptureAnalysis(request(db, clip));
      expect(outcome.kind).toBe('unavailable');
      if (outcome.kind !== 'unavailable') return;
      expect(outcome.reason).toContain('integrity check');
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(calls).toHaveLength(0);
    },
  );

  it('[HELD] a rejected read (permission denied / file gone) is reported as unreadable, never as an integrity or parse failure', async () => {
    const { db, calls } = recordingDb();
    const { clip } = swingClipWithSidecar();
    mockReadArtifact = async () => {
      throw new Error('EACCES: permission denied');
    };
    setFetch(jest.fn());
    const outcome = await runCaptureAnalysis(request(db, clip));
    expect(outcome.kind).toBe('unavailable');
    if (outcome.kind !== 'unavailable') return;
    expect(outcome.reason).toContain('could not be read');
    expect(calls).toHaveLength(0);
  });
});

// ─── S4: reserve returns access:null / malformed with accessSource 'free' ──

describe('S4 — reserve-time access snapshot missing or malformed', () => {
  it.each([
    ['access omitted', undefined],
    ['access: null', null],
    ['access: string', 'nope'],
    ['access: premium not boolean', { premium: 'false', freeRatings: {} }],
    [
      'access: freeRatings with NaN',
      {
        premium: false,
        freeRatings: {
          limit: 2,
          used: 2,
          reserved: 0,
          remaining: 0,
          availableToReserve: Number.NaN,
        },
      },
    ],
    [
      'access: freeRatings with string counts',
      {
        premium: false,
        freeRatings: {
          limit: '2',
          used: '2',
          reserved: '0',
          remaining: '0',
          availableToReserve: '0',
        },
      },
    ],
  ])(
    '[HELD] %s + accessSource free → scored with freeLimitReached=false (upgrade prompt skipped, rating still consumed)',
    async (_label, access) => {
      const { db, calls } = recordingDb();
      const { clip, sidecarJson } = swingClipWithSidecar();
      mockReadArtifact = async () => sidecarJson;
      const server = permitServer({ access, accessSource: 'free' });
      setFetch(server.fetchMock);

      const outcome = await runCaptureAnalysis(request(db, clip));
      expect(outcome.kind).toBe('scored');
      if (outcome.kind !== 'scored') return;
      // Documented degradation: a snapshot that cannot be parsed runs no
      // popup heuristics. The rating itself is still saved with its permit.
      expect(outcome.freeLimitReached).toBe(false);
      expect(localShotInserts(calls)).toHaveLength(1);
      expect(outboxInserts(calls)).toHaveLength(1);
      expect(server.finalizeBodies).toHaveLength(0);
    },
  );

  it('[HELD] control: a well-formed last-free snapshot flips freeLimitReached=true', async () => {
    const { db } = recordingDb();
    const { clip, sidecarJson } = swingClipWithSidecar();
    mockReadArtifact = async () => sidecarJson;
    const server = permitServer({
      accessSource: 'free',
      access: {
        premium: false,
        freeRatings: {
          limit: 2,
          used: 1,
          reserved: 1,
          remaining: 1,
          availableToReserve: 0,
        },
      },
    });
    setFetch(server.fetchMock);
    const outcome = await runCaptureAnalysis(request(db, clip));
    expect(outcome.kind).toBe('scored');
    if (outcome.kind !== 'scored') return;
    expect(outcome.freeLimitReached).toBe(true);
  });

  it('[HELD] a premium permit never reports the free limit even with availableToReserve 0', async () => {
    const { db } = recordingDb();
    const { clip, sidecarJson } = swingClipWithSidecar();
    mockReadArtifact = async () => sidecarJson;
    const server = permitServer({
      accessSource: 'premium',
      access: {
        premium: true,
        freeRatings: {
          limit: 2,
          used: 2,
          reserved: 0,
          remaining: 0,
          availableToReserve: 0,
        },
      },
    });
    setFetch(server.fetchMock);
    const outcome = await runCaptureAnalysis(request(db, clip));
    expect(outcome.kind).toBe('scored');
    if (outcome.kind !== 'scored') return;
    expect(outcome.freeLimitReached).toBe(false);
  });
});

// ─── Extra: reserve failures never write anything ───────────────────────────

describe('extra — reserve failures', () => {
  it('[HELD] 402 access.paywall_required → unavailable with cause paywall_required, capture left pending, no db write', async () => {
    const { db, calls } = recordingDb();
    const { clip, sidecarJson } = swingClipWithSidecar();
    mockReadArtifact = async () => sidecarJson;
    const server = permitServer({
      reserveStatus: 402,
      reserveBody: {
        error: {
          code: 'access.paywall_required',
          message: 'Upgrade to keep rating.',
        },
      },
    });
    setFetch(server.fetchMock);
    const outcome = await runCaptureAnalysis(request(db, clip));
    expect(outcome).toEqual({
      kind: 'unavailable',
      reason: 'Upgrade to keep rating.',
      cause: 'paywall_required',
    });
    expect(calls).toHaveLength(0);
  });

  it('[HELD] 503 with an empty body → unavailable with the status text, no db write, no retry storm (one reserve call)', async () => {
    const { db, calls } = recordingDb();
    const { clip, sidecarJson } = swingClipWithSidecar();
    mockReadArtifact = async () => sidecarJson;
    const server = permitServer({ reserveStatus: 503, reserveBody: null });
    setFetch(server.fetchMock);
    const outcome = await runCaptureAnalysis(request(db, clip));
    expect(outcome.kind).toBe('unavailable');
    if (outcome.kind !== 'unavailable') return;
    expect(outcome.cause).toBeUndefined();
    expect(outcome.reason).toBe('HTTP 503');
    expect(server.fetchMock).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(0);
  });

  it('[HELD] reserve network failure → generic "rating service could not be reached", no db write', async () => {
    const { db, calls } = recordingDb();
    const { clip, sidecarJson } = swingClipWithSidecar();
    mockReadArtifact = async () => sidecarJson;
    setFetch(
      jest.fn(async () => {
        throw new TypeError('Network request failed');
      }),
    );
    const outcome = await runCaptureAnalysis(request(db, clip));
    expect(outcome.kind).toBe('unavailable');
    if (outcome.kind !== 'unavailable') return;
    expect(outcome.reason).toContain('could not be reached');
    expect(calls).toHaveLength(0);
  });

  it('[HELD] a permit echoed back as status "released" is refused (409), nothing scored', async () => {
    const { db, calls } = recordingDb();
    const { clip, sidecarJson } = swingClipWithSidecar();
    mockReadArtifact = async () => sidecarJson;
    const server = permitServer({
      reserveBody: {
        permit: {
          id: 'permit-x',
          accessSource: 'free',
          status: 'released',
          expiresAt: '2026-09-04T20:00:00.000Z',
        },
      },
    });
    setFetch(server.fetchMock);
    const outcome = await runCaptureAnalysis(request(db, clip));
    expect(outcome.kind).toBe('unavailable');
    if (outcome.kind !== 'unavailable') return;
    expect(outcome.reason).toContain('no longer reserved');
    expect(calls).toHaveLength(0);
  });

  it('reserve 200 whose permit.id is "" is rejected before inference: no analyzeCapture call, no db write, no finalize, outcome unavailable', async () => {
    const { db, calls } = recordingDb();
    const { clip, sidecarJson } = swingClipWithSidecar();
    mockReadArtifact = async () => sidecarJson;
    const server = permitServer({ permitId: '' });
    setFetch(server.fetchMock);
    const analyzeSpy = jest.spyOn(pipeline, 'analyzeCapture');
    try {
      const outcome = await runCaptureAnalysis(request(db, clip));
      expect(outcome.kind).toBe('unavailable');
      if (outcome.kind !== 'unavailable') return;
      expect(outcome.reason).toContain('invalid analysis permit');
      expect(outcome.cause).toBeUndefined();
      expect(analyzeSpy).not.toHaveBeenCalled();
      expect(calls).toHaveLength(0);
      // Nothing to finalize: an id-less permit cannot be addressed.
      expect(server.reserveBodies).toHaveLength(1);
      expect(server.finalizeUrls).toHaveLength(0);
      expect(server.fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      analyzeSpy.mockRestore();
    }
  });

  it('reserve 200 whose permit.id is whitespace-only is rejected the same way', async () => {
    const { db, calls } = recordingDb();
    const { clip, sidecarJson } = swingClipWithSidecar();
    mockReadArtifact = async () => sidecarJson;
    const server = permitServer({ permitId: '   ' });
    setFetch(server.fetchMock);
    const analyzeSpy = jest.spyOn(pipeline, 'analyzeCapture');
    try {
      const outcome = await runCaptureAnalysis(request(db, clip));
      expect(outcome.kind).toBe('unavailable');
      expect(analyzeSpy).not.toHaveBeenCalled();
      expect(calls).toHaveLength(0);
      expect(server.finalizeUrls).toHaveLength(0);
    } finally {
      analyzeSpy.mockRestore();
    }
  });

  it('[HELD] a signed-out apiConfig (token null) never reaches the network and leaves nothing behind', async () => {
    const { db, calls } = recordingDb();
    const { clip, sidecarJson } = swingClipWithSidecar();
    mockReadArtifact = async () => sidecarJson;
    const fetchSpy = jest.fn();
    setFetch(fetchSpy);
    const outcome = await runCaptureAnalysis({
      ...request(db, clip),
      apiConfig: { baseUrl: 'https://api.test', token: null },
    });
    expect(outcome.kind).toBe('unavailable');
    if (outcome.kind !== 'unavailable') return;
    expect(outcome.reason).toContain('Sign in');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it('[HELD] a hostile permit id (slashes, unicode, query chars) is URL-encoded on release — no path injection', async () => {
    const { db } = recordingDb();
    const { clip, sidecarJson } = swingClipWithSidecar(
      LOW_CONFIDENCE_VISIBILITY,
    );
    mockReadArtifact = async () => sidecarJson;
    const hostile = '../../admin?x=1&y=2#frag/ünïcødé 🎾';
    const server = permitServer({ permitId: hostile });
    setFetch(server.fetchMock);
    const outcome = await runCaptureAnalysis(request(db, clip));
    expect(outcome.kind).toBe('low_confidence');
    expect(server.finalizeUrls).toHaveLength(1);
    expect(server.finalizeUrls[0]).toBe(
      `https://api.test/v1/analysis-permits/${encodeURIComponent(hostile)}/finalize`,
    );
    expect(server.finalizeUrls[0]).not.toContain('/../');
    expect(server.finalizeUrls[0]).not.toContain('?x=1');
  });
});
