import { generateSwingSequence } from '@pickle/evaluation';
import {
  serializePoseSequence,
  sha256Hex,
  type PoseSequence,
} from '@pickle/swing-domain';
import type { LocalDb } from '../src/data/db';
import {
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../src/data/accountScope';
import type { CapturedClip } from '../src/camera/capture';
import {
  IMPORT_ADMISSION_LIMITS,
  admitImportedClip,
  importAdmissionRejectionMessage,
} from '../src/camera/importAdmission';
import { runCaptureAnalysis } from '../src/analysis/runCaptureAnalysis';
import {
  clearApiSession,
  establishApiSession,
} from '../src/account/apiSession';
import {
  closeSqliteTestDatabases,
  createSqliteTestDb,
  seedSqliteCapture,
} from '../testSupport/sqlite';

/**
 * W03-01 adversary, round 8 (candidate 806d511b) — shipping path.
 *
 * The objective: "duration bounds, frame-rate/rotation/codec support,
 * single-stroke plausibility; ambiguous clips are rejected with a precise
 * reason and never reach charging." Each attack runs an imported clip through
 * the real `runCaptureAnalysis` (real SQLite, real pipeline, fetch stubbed at
 * the permit API) and asserts that a clip the rules must refuse never
 * produces a `POST /v1/analysis-permits` and is refused with the import
 * reason, not a later gate's copy. A failing test is a reproducer.
 */

jest.mock('../src/data/db', () => ({ getDb: jest.fn() }));

jest.mock('../src/camera/capture', () => {
  const actual = jest.requireActual('../src/camera/capture');
  return {
    ...actual,
    readCaptureArtifact: (uri: string) => mockReadArtifact(uri),
  };
});

let mockReadArtifact: (uri: string) => Promise<string> = async () => {
  throw new Error('readCaptureArtifact mock not configured');
};

const owner = '33333333-3333-4333-8333-333333333333';
const PERMITS_PATH = '/v1/analysis-permits';

function jsonResponse(
  body: unknown,
  status = 200,
  headers?: Headers,
): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'ERR',
    headers: headers ?? new Headers(),
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function permitServer(reserve?: (url: string) => Promise<Response>) {
  const finalized: unknown[] = [];
  const fetchMock = jest.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith(PERMITS_PATH)) {
      if (reserve) return reserve(url);
      return jsonResponse({
        permit: {
          id: '66666666-6666-4666-8666-666666666666',
          accessSource: 'free',
          status: 'reserved',
          expiresAt: '2026-08-30T20:00:00.000Z',
        },
      });
    }
    if (url.includes('/finalize')) {
      finalized.push(JSON.parse(String(init?.body)));
      return jsonResponse({ ok: true });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
  const permitPosts = () =>
    fetchMock.mock.calls
      .map(call => String(call[0]))
      .filter(url => url.endsWith(PERMITS_PATH));
  return { fetchMock, finalized, permitPosts };
}

function importedClipWithSidecar(sequence: PoseSequence): {
  clip: CapturedClip;
  sidecarJson: string;
} {
  const lastFrame = sequence.frames[sequence.frames.length - 1];
  const sidecarJson = serializePoseSequence(sequence);
  const clip: CapturedClip = {
    uri: 'file:///imports/attack-clip.mov',
    durationMs: (lastFrame?.timestampMs ?? 0) + 100,
    fps: sequence.video.fps,
    width: sequence.video.width,
    height: sequence.video.height,
    capturedAtIso: '2026-09-08T08:00:00.000Z',
    captureMode: 'imported_video',
    recognition: { status: 'unknown', reason: 'analysis_not_run' },
    ballSpeed: { status: 'unavailable', reason: 'analysis_not_run' },
    posterUri: 'file:///imports/attack-clip.poster.jpg',
    poseSequence: {
      schemaVersion: 1,
      format: 'pickle.pose-sequence.v1',
      uri: 'file:///imports/attack-clip.pose.json',
      frameCount: sequence.frames.length,
      sha256: sha256Hex(sidecarJson),
      coordinateSystem: 'normalized_image_top_left',
      poseModelVersion: sequence.producedBy.modelVersion,
    },
  };
  return { clip, sidecarJson };
}

function request(db: LocalDb, clip: CapturedClip) {
  const captureId = '77777777-7777-4777-8777-777777777777';
  seedSqliteCapture(db, owner, captureId, clip);
  return {
    db,
    captureId,
    clip,
    declaredStroke: 'forehand_drive' as const,
    handedness: 'right' as const,
    cameraView: 'side' as const,
    apiConfig: { baseUrl: 'https://api.test', token: 'token-1' },
    appVersion: '0.1.0',
    targetSeed: {
      point: { x: 0.42, y: 0.63 },
      selectedAtIso: '2026-09-08T08:01:00.000Z',
    },
  };
}

function skeletonProfile(
  durationMs: number,
  fps: number,
  rightAt: (tMs: number) => number,
  options: {
    leftAt?: (tMs: number) => number;
    scaleAt?: (tMs: number) => number;
  } = {},
): PoseSequence {
  const { sequence } = generateSwingSequence();
  const body = sequence.frames[0];
  if (!body) throw new Error('synthetic swing produced no frames');
  const leftAt = options.leftAt ?? (() => 0);
  const scaleAt = options.scaleAt ?? (() => 1);
  const dtMs = 1000 / fps;
  const frames: PoseSequence['frames'] = [];
  let index = 0;
  for (let tMs = 0; tMs <= durationMs; tMs += dtMs) {
    const rightStep = (rightAt(tMs) * dtMs) / 1000;
    const leftStep = (leftAt(tMs) * dtMs) / 1000;
    const scale = scaleAt(tMs);
    frames.push({
      frameIndex: index,
      timestampMs: Math.round(tMs),
      confidence: body.confidence,
      landmarks: body.landmarks.map(mark => {
        const scaled = {
          ...mark,
          x: 0.5 + (mark.x - 0.5) * scale,
          y: 0.5 + (mark.y - 0.5) * scale,
        };
        if (mark.name === 'right_wrist')
          return { ...scaled, x: 0.55 + (index % 2 === 0 ? 0 : rightStep) };
        if (mark.name === 'left_wrist')
          return { ...scaled, x: 0.3 + (index % 2 === 0 ? 0 : leftStep) };
        return scaled;
      }),
    });
    index += 1;
  }
  return { ...sequence, video: { ...sequence.video, fps }, frames };
}

function hump(centerMs: number, halfWidthMs: number, peak: number) {
  return (tMs: number): number => {
    const distance = Math.abs(tMs - centerMs);
    if (distance >= halfWidthMs) return 0;
    return peak * (1 - distance / halfWidthMs);
  };
}

function occludeRightWrist(
  sequence: PoseSequence,
  fromMs: number,
  toMs: number,
): PoseSequence {
  return {
    ...sequence,
    frames: sequence.frames.map(frame =>
      frame.timestampMs >= fromMs && frame.timestampMs <= toMs
        ? {
            ...frame,
            landmarks: frame.landmarks.map(mark =>
              mark.name === 'right_wrist'
                ? {
                    ...mark,
                    visibility:
                      IMPORT_ADMISSION_LIMITS.minLandmarkVisibility - 0.01,
                  }
                : mark,
            ),
          }
        : frame,
    ),
  };
}

const TORSO = 0.2;

/** ATTACK 1 shape: far stroke at scale 0.4, then a near stroke (see unit suite). */
function approachingRally(): PoseSequence {
  const far = hump(800, 150, 5 * TORSO * 0.4);
  const near = hump(3500, 150, 5 * TORSO);
  return skeletonProfile(5000, 60, tMs => far(tMs) + near(tMs), {
    scaleAt: tMs => (tMs < 1500 ? 0.4 : 1),
  });
}

/** ATTACK 2 shape: two-handed stroke, right wrist untracked for the first 2 s. */
function twoHandedWithRightHole(): PoseSequence {
  return occludeRightWrist(
    skeletonProfile(5000, 60, hump(4000, 150, 5 * TORSO), {
      leftAt: hump(4050, 150, 5.5 * TORSO),
    }),
    0,
    2000,
  );
}

const IMPORT_REASON_COPY = new Set(
  (
    [
      'duration_too_short',
      'duration_too_long',
      'frame_rate_unknown',
      'frame_rate_too_high',
      'unsupported_dimensions',
      'pose_coverage_incomplete',
      'too_few_pose_frames',
      'wrist_not_tracked',
      'body_scale_unmeasured',
      'no_stroke_event',
      'multiple_stroke_events',
      'stroke_truncated_at_clip_edge',
      'motion_not_stroke_like',
    ] as const
  ).map(reason => importAdmissionRejectionMessage(reason)),
);

describe('W03-01 adversary r8 — unsupported imports must be refused before any permit traffic', () => {
  beforeEach(() => {
    setActiveDataOwner(owner);
    establishApiSession({
      canonicalAppUserId: owner,
      apiBaseUrl: 'https://api.test',
      bearerToken: 'token-1',
      provider: 'apple',
    });
  });
  afterEach(() => {
    closeSqliteTestDatabases();
    clearApiSession();
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    (globalThis as { fetch?: unknown }).fetch = undefined;
  });

  describe('ATTACK 7 — frame rate below what the rating pipeline supports (10/12/14 fps)', () => {
    // The pipeline refuses anything under 15 effective fps; the objective
    // names "frame-rate support" as an ADMISSION rule. A 10 fps single-stroke
    // import is admitted by admitImportedClip and must therefore be refused
    // somewhere before the permit reservation — or the import rule is not
    // conservative about frame rate at all.
    it.each([10, 12, 14])(
      'a %d fps single stroke never reaches POST /v1/analysis-permits and is refused with an import reason',
      async fps => {
        const { db } = createSqliteTestDb();
        const { sequence } = generateSwingSequence({ handed: 'right', fps });
        const { clip, sidecarJson } = importedClipWithSidecar(sequence);
        mockReadArtifact = async () => sidecarJson;
        const server = permitServer();
        (globalThis as { fetch?: unknown }).fetch = server.fetchMock;

        const outcome = await runCaptureAnalysis(request(db, clip));
        expect(outcome.kind).toBe('quality_blocked');
        expect(server.permitPosts()).toEqual([]);
        expect(server.finalized).toEqual([]);
        if (outcome.kind !== 'quality_blocked') return;
        expect(IMPORT_REASON_COPY.has(outcome.reason)).toBe(true);
      },
    );
  });

  describe('ATTACK 8 — pose evidence the pipeline will refuse is admitted, then a permit is reserved', () => {
    it('a 15 fps clip with only 14 pose frames (below the 24-frame rating floor) never reaches a reservation', async () => {
      const { db } = createSqliteTestDb();
      const sequence = skeletonProfile(870, 15, hump(450, 200, 5 * TORSO));
      expect(sequence.frames).toHaveLength(14);
      const { clip, sidecarJson } = importedClipWithSidecar(sequence);
      mockReadArtifact = async () => sidecarJson;
      const server = permitServer();
      (globalThis as { fetch?: unknown }).fetch = server.fetchMock;

      const outcome = await runCaptureAnalysis(request(db, clip));
      expect(outcome.kind).toBe('quality_blocked');
      expect(server.permitPosts()).toEqual([]);
    });

    it('a player whose torso is 0.06 image heights (below the 0.08 rating floor) never reaches a reservation', async () => {
      const { db } = createSqliteTestDb();
      const sequence = skeletonProfile(
        3000,
        60,
        hump(1500, 150, 5 * TORSO * 0.3),
        {
          scaleAt: () => 0.3,
        },
      );
      const { clip, sidecarJson } = importedClipWithSidecar(sequence);
      mockReadArtifact = async () => sidecarJson;
      const server = permitServer();
      (globalThis as { fetch?: unknown }).fetch = server.fetchMock;

      const outcome = await runCaptureAnalysis(request(db, clip));
      expect(outcome.kind).toBe('quality_blocked');
      expect(server.permitPosts()).toEqual([]);
    });
  });

  describe('ATTACK 9 — network failure at the reservation an unsupported clip should never have reached', () => {
    // If the frame-rate rule really ran before charging, the network could
    // not change the answer: the clip is refused offline with its reason.
    const failures: Array<[string, () => Promise<Response>]> = [
      [
        'offline (fetch rejects)',
        async () => {
          throw new TypeError('Network request failed');
        },
      ],
      [
        '429 + Retry-After',
        async () =>
          jsonResponse(
            { error: 'rate_limited' },
            429,
            new Headers({ 'Retry-After': '30' }),
          ),
      ],
      ['500', async () => jsonResponse({ error: 'internal' }, 500)],
    ];

    it.each(failures)(
      'a 10 fps import is refused with its import reason when the permit API is %s',
      async (_label, reserve) => {
        const { db } = createSqliteTestDb();
        const { sequence } = generateSwingSequence({
          handed: 'right',
          fps: 10,
        });
        const { clip, sidecarJson } = importedClipWithSidecar(sequence);
        mockReadArtifact = async () => sidecarJson;
        const server = permitServer(reserve);
        (globalThis as { fetch?: unknown }).fetch = server.fetchMock;

        const outcome = await runCaptureAnalysis(request(db, clip));
        expect(outcome.kind).toBe('quality_blocked');
        expect(server.permitPosts()).toEqual([]);
        if (outcome.kind !== 'quality_blocked') return;
        expect(IMPORT_REASON_COPY.has(outcome.reason)).toBe(true);
      },
    );
  });

  describe('ATTACK 10 — ambiguous multi-stroke clips that the round-8 gate admits are CHARGED', () => {
    it.each([
      ['player walks towards the camera between two strokes', approachingRally],
      [
        'two-handed stroke whose right wrist was untracked for 2 s',
        twoHandedWithRightHole,
      ],
    ])(
      '%s: refused before the permit reservation, never scored',
      async (_label, shape) => {
        const { db, native } = createSqliteTestDb();
        const sequence = shape();
        const { clip, sidecarJson } = importedClipWithSidecar(sequence);
        // The unit gate's verdict is the shipping gate's verdict.
        const unit = admitImportedClip(clip, sequence);
        mockReadArtifact = async () => sidecarJson;
        const server = permitServer();
        (globalThis as { fetch?: unknown }).fetch = server.fetchMock;

        const outcome = await runCaptureAnalysis(request(db, clip));
        const ratedShots = native
          .prepare('SELECT COUNT(*) AS n FROM local_shot')
          .get() as { n: number };
        expect({
          unitAdmitted: unit.admitted,
          kind: outcome.kind,
          permitPosts: server.permitPosts().length,
          ratedShots: ratedShots.n,
        }).toEqual({
          unitAdmitted: false,
          kind: 'quality_blocked',
          permitPosts: 0,
          ratedShots: 0,
        });
      },
    );
  });
});
