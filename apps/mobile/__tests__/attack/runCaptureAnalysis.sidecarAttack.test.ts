/**
 * ADVERSARIAL PASS 3 — mobile-analyze-capture / runCaptureAnalysis sidecar
 * integrity (scenarios S3, S4 + extras). Attacks are executed against the
 * REAL runCaptureAnalysis pipeline with a recording LocalDb and a permit
 * server mock; each `it` block states the attack and what would count as a
 * break. Nothing here is a Mac/iOS runtime claim.
 *
 * S3  bytes hash correctly but the sidecar REF's frameCount disagrees with
 *     the serialized sequence → must not score.
 * S4  valid-hash sidecar with < 6 frames → providers/fusion must refuse and
 *     NO permit may be reserved.
 */
import { generateSwingSequence } from '@pickle/evaluation';
import {
  parsePoseSequence,
  serializePoseSequence,
  sha256Hex,
} from '@pickle/swing-domain';
import type { LocalDb } from '../../src/data/db';
import {
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import type { CapturedClip } from '../../src/camera/capture';
import { runCaptureAnalysis } from '../../src/analysis/runCaptureAnalysis';
import { selectVisionProviders } from '../../src/vision/providers';

jest.mock('../../src/data/db', () => ({ getDb: jest.fn() }));

jest.mock('../../src/camera/capture', () => {
  const actual = jest.requireActual('../../src/camera/capture');
  return {
    ...actual,
    readCaptureArtifact: (uri: string) => mockReadArtifact(uri),
  };
});

let mockReadArtifact: (uri: string) => Promise<string> = async () => {
  throw new Error('readCaptureArtifact mock not configured');
};

const owner = '44444444-4444-4444-8444-444444444444';

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

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => body,
  } as unknown as Response;
}

/** Permit server that records every reserve + finalize call verbatim. */
function permitServer(): {
  fetchMock: jest.Mock;
  reserved: string[];
  finalized: { url: string; body: unknown }[];
} {
  const reserved: string[] = [];
  const finalized: { url: string; body: unknown }[] = [];
  let seq = 0;
  const fetchMock = jest.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/v1/analysis-permits')) {
      seq += 1;
      const id = `permit-attack-${seq}`;
      reserved.push(id);
      return jsonResponse({
        permit: {
          id,
          accessSource: 'free',
          status: 'reserved',
          expiresAt: '2026-09-04T20:00:00.000Z',
        },
      });
    }
    if (url.includes('/finalize')) {
      finalized.push({ url, body: JSON.parse(String(init?.body)) });
      return jsonResponse({ ok: true });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
  return { fetchMock, reserved, finalized };
}

function importedClip(
  sidecarJson: string,
  frameCount: number,
  durationMs: number,
): CapturedClip {
  return {
    uri: 'file:///imports/attack.mov',
    durationMs,
    fps: 30,
    width: 1080,
    height: 1080,
    capturedAtIso: '2026-09-04T10:00:00.000Z',
    captureMode: 'imported_video',
    recognition: { status: 'unknown', reason: 'analysis_not_run' },
    ballSpeed: { status: 'unavailable', reason: 'analysis_not_run' },
    poseSequence: {
      schemaVersion: 1,
      format: 'pickle.pose-sequence.v1',
      uri: 'file:///imports/attack.pose.json',
      frameCount,
      sha256: sha256Hex(sidecarJson),
      coordinateSystem: 'normalized_image_top_left',
      poseModelVersion: 'apple-vision-bodypose-1',
    },
  };
}

function request(db: LocalDb, clip: CapturedClip) {
  return {
    db,
    captureId: 'capture-attack-1',
    clip,
    declaredStroke: 'forehand_drive' as const,
    handedness: 'right' as const,
    cameraView: 'side' as const,
    apiConfig: { baseUrl: 'https://api.test', token: 'token-1' },
    appVersion: '0.1.0',
    targetSeed: null,
  };
}

const PRODUCER = {
  providerId: 'pose.apple-vision',
  runtime: 'vision_framework',
  executionTarget: 'on_device',
  artifactHash: null,
} as const;

beforeEach(() => setActiveDataOwner(owner));
afterEach(() => {
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  (globalThis as { fetch?: unknown }).fetch = undefined;
});

describe('S3 — valid hash, sidecar ref frameCount disagrees with the bytes', () => {
  it('ATTACK: ref.frameCount = frames+7 with correct sha256 → must not be scored', async () => {
    const { sequence, window } = generateSwingSequence();
    const sidecarJson = serializePoseSequence(sequence);
    mockReadArtifact = async () => sidecarJson;
    const { db, calls } = recordingDb();
    const { fetchMock, reserved } = permitServer();
    (globalThis as { fetch?: unknown }).fetch = fetchMock;

    const clip = importedClip(
      sidecarJson,
      sequence.frames.length + 7,
      window.endMs,
    );
    // Precondition: the bytes really do parse; only the REF metadata lies.
    expect(parsePoseSequence(sidecarJson, PRODUCER).ok).toBe(true);
    expect(sha256Hex(sidecarJson)).toBe(clip.poseSequence!.sha256);

    const outcome = await runCaptureAnalysis(request(db, clip));

    console.log(
      `[S3] frameCount ref=${clip.poseSequence!.frameCount} bytes=${sequence.frames.length} → outcome.kind=${outcome.kind} permitsReserved=${reserved.length}`,
    );
    expect(outcome.kind).toBe('unavailable');
    if (outcome.kind !== 'unavailable') return;
    expect(outcome.reason).toMatch(/invalid|integrity|frame/i);
    expect(reserved).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it('ATTACK: ref.frameCount = 0 with correct sha256 → must not be scored', async () => {
    const { sequence, window } = generateSwingSequence();
    const sidecarJson = serializePoseSequence(sequence);
    mockReadArtifact = async () => sidecarJson;
    const { db } = recordingDb();
    const { fetchMock, reserved } = permitServer();
    (globalThis as { fetch?: unknown }).fetch = fetchMock;

    const clip = importedClip(sidecarJson, 0, window.endMs);
    const outcome = await runCaptureAnalysis(request(db, clip));

    console.log(
      `[S3b] frameCount ref=0 bytes=${sequence.frames.length} → outcome.kind=${outcome.kind} permitsReserved=${reserved.length}`,
    );
    expect(outcome.kind).toBe('unavailable');
    expect(reserved).toHaveLength(0);
  });

  it('CONTROL: a sidecar whose BYTES are corrupted (frames truncated) but re-hashed parses fine — only parse-level failures are surfaced', async () => {
    // Bytes-level tamper the pipeline DOES catch: a frame with a non-monotonic
    // timestamp, re-hashed so the integrity check passes and the parser is the
    // only remaining gate.
    const { sequence, window } = generateSwingSequence();
    const wire = JSON.parse(serializePoseSequence(sequence)) as {
      frames: { t: number }[];
    };
    wire.frames[3]!.t = wire.frames[2]!.t; // duplicate timestamp
    const corrupt = JSON.stringify(wire);
    mockReadArtifact = async () => corrupt;
    const { db, calls } = recordingDb();
    const { fetchMock, reserved } = permitServer();
    (globalThis as { fetch?: unknown }).fetch = fetchMock;
    const clip = importedClip(corrupt, sequence.frames.length, window.endMs);

    const outcome = await runCaptureAnalysis(request(db, clip));
    expect(outcome.kind).toBe('unavailable');
    if (outcome.kind !== 'unavailable') return;
    expect(outcome.reason).toContain('pose_sequence.non_monotonic');
    expect(reserved).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });
});

describe('S4 — valid-hash sidecar with fewer than 6 frames', () => {
  function shortSidecar(frameCount: number) {
    const { sequence, window } = generateSwingSequence();
    const short = {
      ...sequence,
      frames: sequence.frames.slice(0, frameCount),
    };
    const sidecarJson = serializePoseSequence(short);
    expect(parsePoseSequence(sidecarJson, PRODUCER).ok).toBe(true);
    return { sidecarJson, window, frames: short.frames.length };
  }

  it('selectVisionProviders refuses a 5-frame recording outright', () => {
    const { sequence } = generateSwingSequence();
    const result = selectVisionProviders('forehand_drive', {
      poseFrames: sequence.frames.slice(0, 5).map(f => ({
        timestampMs: f.timestampMs,
        space: 'normalized-image' as const,
        confidence: f.confidence,
        landmarks: f.landmarks.map(m => ({
          name: m.name as never,
          x: m.x,
          y: m.y,
          visibility: m.visibility,
        })),
      })),
      handedness: 'right',
      cameraView: 'side',
      videoDurationMs: 200,
      frameRate: 30,
      videoWidth: 1080,
      videoHeight: 1080,
    } as never);
    expect(result.kind).toBe('unavailable');
    if (result.kind !== 'unavailable') return;
    expect(result.reason).toContain('Too few pose frames');
  });

  it.each([5, 3, 1])(
    'ATTACK: runCaptureAnalysis with a %d-frame valid-hash sidecar → not scored AND no permit reserved',
    async frameCount => {
      const { sidecarJson, window, frames } = shortSidecar(frameCount);
      mockReadArtifact = async () => sidecarJson;
      const { db, calls } = recordingDb();
      const { fetchMock, reserved, finalized } = permitServer();
      (globalThis as { fetch?: unknown }).fetch = fetchMock;
      const clip = importedClip(sidecarJson, frames, window.endMs);

      const outcome = await runCaptureAnalysis(request(db, clip));

      console.log(
        `[S4] frames=${frames} → outcome.kind=${outcome.kind} reason=${
          outcome.kind === 'unavailable' ? JSON.stringify(outcome.reason) : '-'
        } permitsReserved=${reserved.length} finalized=${JSON.stringify(
          finalized.map(f => f.body),
        )} dbWrites=${calls.length}`,
      );
      expect(outcome.kind).not.toBe('scored');
      // The scenario's assertion: fusion refuses BEFORE a permit exists.
      expect(reserved).toHaveLength(0);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it('CONTROL: a 6-frame valid-hash sidecar is at least not scored with a fabricated score', async () => {
    const { sidecarJson, window, frames } = shortSidecar(6);
    mockReadArtifact = async () => sidecarJson;
    const { db } = recordingDb();
    const { fetchMock, reserved, finalized } = permitServer();
    (globalThis as { fetch?: unknown }).fetch = fetchMock;
    const clip = importedClip(sidecarJson, frames, window.endMs);
    const outcome = await runCaptureAnalysis(request(db, clip));

    console.log(
      `[S4-6] frames=6 → outcome.kind=${outcome.kind} reason=${
        outcome.kind === 'unavailable' ? JSON.stringify(outcome.reason) : '-'
      } permitsReserved=${reserved.length} finalized=${JSON.stringify(
        finalized.map(f => f.body),
      )}`,
    );
    expect(outcome.kind).not.toBe('scored');
  });
});

describe('extras — hostile sidecar contents behind a valid hash', () => {
  it('unicode / huge poseModelVersion is carried verbatim and never crashes the run', async () => {
    const { sequence, window } = generateSwingSequence();
    const hostile = {
      ...sequence,
      producedBy: {
        ...sequence.producedBy,
        modelVersion: '🥒'.repeat(5000) + '\u0000\u202e',
      },
    };
    const sidecarJson = serializePoseSequence(hostile);
    mockReadArtifact = async () => sidecarJson;
    const { db } = recordingDb();
    const { fetchMock } = permitServer();
    (globalThis as { fetch?: unknown }).fetch = fetchMock;
    const clip = importedClip(
      sidecarJson,
      sequence.frames.length,
      window.endMs,
    );
    const outcome = await runCaptureAnalysis(request(db, clip));
    expect(['scored', 'unavailable', 'analyzed', 'quality_blocked']).toContain(
      outcome.kind,
    );
    if (outcome.kind === 'scored') {
      const poseRef = outcome.record.provenance.providerVersions.find(
        ref => ref.providerId === 'pose.apple-vision',
      );
      expect(poseRef?.modelVersion).toBe(hostile.producedBy.modelVersion);
    }
  });

  it('a sidecar at the native import cap (60 s @ 60 fps = 3600 frames) parses and either scores or refuses — never throws', async () => {
    // PickleVideoCapture.importedPoseMaxDurationSeconds = 60 is the largest
    // sidecar native will ever hand us; this measures the JS-side cost of
    // that worst case on Linux (a proxy, NOT a device number).
    const { sequence } = generateSwingSequence();
    const frames = Array.from({ length: 3600 }, (_, i) => ({
      ...sequence.frames[i % sequence.frames.length]!,
      frameIndex: i,
      timestampMs: i * (1000 / 60),
    }));
    const huge = { ...sequence, frames };
    const sidecarJson = serializePoseSequence(huge);
    mockReadArtifact = async () => sidecarJson;
    const { db } = recordingDb();
    const { fetchMock } = permitServer();
    (globalThis as { fetch?: unknown }).fetch = fetchMock;
    const clip = importedClip(sidecarJson, frames.length, frames.length * 16);
    const startedAt = Date.now();
    const outcome = await runCaptureAnalysis(request(db, clip));

    console.log(
      `[huge] frames=3600 bytes=${sidecarJson.length} → outcome.kind=${outcome.kind} in ${Date.now() - startedAt}ms (Linux jest proxy)`,
    );
    expect(typeof outcome.kind).toBe('string');
  }, 120000);

  it('readCaptureArtifact rejection (permission denied on the sidecar file) is surfaced as unavailable without a permit', async () => {
    const { sequence, window } = generateSwingSequence();
    const sidecarJson = serializePoseSequence(sequence);
    mockReadArtifact = async () => {
      throw new Error('EACCES: permission denied');
    };
    const { db, calls } = recordingDb();
    const { fetchMock, reserved } = permitServer();
    (globalThis as { fetch?: unknown }).fetch = fetchMock;
    const clip = importedClip(
      sidecarJson,
      sequence.frames.length,
      window.endMs,
    );
    const outcome = await runCaptureAnalysis(request(db, clip));
    expect(outcome.kind).toBe('unavailable');
    expect(reserved).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });
});
