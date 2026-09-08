/**
 * ADVERSARY (INT-import-media-capture): malformed / zero-length / oversized
 * imported-clip payloads at the JS trust boundary.
 *
 * `assertCapturedClip` is the ONLY gate between the native import bridge (and
 * the persisted `local_capture.payload` column) and the analysis pipeline.
 * Native enforces import limits (60 s, pixel/byte/disk budgets) in Swift, but
 * a persisted row, a relaunch after process death, or a native regression
 * hands JS a clip object that never went through those checks. Each attack
 * asserts the honest outcome: the clip is refused (or, for the persisted row,
 * surfaced as `corrupt`), never admitted as a valid imported capture.
 */
import { MAX_IMPORTED_POSE_FRAMES } from '../../src/camera/capture';
import {
  assertCapturedClip,
  type CapturedClip,
} from '../../src/camera/capture';
import { getPendingCapture } from '../../src/data/repository';
import {
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import {
  closeSqliteTestDatabases,
  createSqliteTestDb,
} from '../../testSupport/sqlite';

const owner = '33333333-3333-4333-8333-333333333333';
const captureId = '77777777-7777-4777-8777-777777777777';
const SHA = 'a'.repeat(64);

function validImportedClip(): Record<string, unknown> {
  return {
    uri: 'file:///private/captures/import-abc.mov',
    captureMode: 'imported_video',
    capturedAtIso: '2026-08-30T10:00:00.000Z',
    durationMs: 4200,
    fps: 30,
    width: 1080,
    height: 1920,
    byteSize: 1_000_000,
    recognition: { status: 'unknown', reason: 'analysis_not_run' },
    ballSpeed: { status: 'unavailable', reason: 'analysis_not_run' },
  };
}

function withPoseRef(
  clip: Record<string, unknown>,
  frameCount: number,
): Record<string, unknown> {
  return {
    ...clip,
    poseSequence: {
      schemaVersion: 1,
      format: 'pickle.pose-sequence.v1',
      uri: 'file:///private/captures/import-abc-pose.pose.json',
      frameCount,
      sha256: SHA,
      coordinateSystem: 'normalized_image_top_left',
      poseModelVersion: 'apple-vision-test',
    },
  };
}

describe('ADV imported clip boundary: assertCapturedClip(imported_video)', () => {
  it('control: a well-formed imported clip is accepted', () => {
    expect(() =>
      assertCapturedClip(validImportedClip(), 'imported_video'),
    ).not.toThrow();
  });

  it('ATTACK B1: zero FPS imported clip (no frame timing possible) must be refused', () => {
    // The canonical sidecar parser refuses fps <= 0; admitting a 0 fps clip
    // here guarantees a later metadata mismatch or, worse, a division by
    // zero in any frame<->time mapping that trusts clip.fps.
    expect(() =>
      assertCapturedClip({ ...validImportedClip(), fps: 0 }, 'imported_video'),
    ).toThrow();
  });

  it('ATTACK B2: sub-millisecond (effectively zero-length) media must be refused', () => {
    expect(() =>
      assertCapturedClip(
        { ...validImportedClip(), durationMs: Number.MIN_VALUE },
        'imported_video',
      ),
    ).toThrow();
  });

  it('ATTACK B3: imported clip longer than the 60 s native import ceiling must be refused in JS too', () => {
    // Native rejects with camera.import_too_long at 60 s. A persisted or
    // replayed clip object claiming two hours never passed that check.
    expect(() =>
      assertCapturedClip(
        { ...validImportedClip(), durationMs: 7_200_000 },
        'imported_video',
      ),
    ).toThrow();
  });

  it('ATTACK B4: absurd pixel dimensions (1e9 x 1e9) must be refused', () => {
    expect(() =>
      assertCapturedClip(
        { ...validImportedClip(), width: 1_000_000_000, height: 1_000_000_000 },
        'imported_video',
      ),
    ).toThrow();
  });

  it('ATTACK B5: an ARRAY dressed up with clip properties must not pass the record check', () => {
    const arrayClip = Object.assign([], validImportedClip());
    expect(() => assertCapturedClip(arrayClip, 'imported_video')).toThrow();
  });

  it('ATTACK B6: native identity origin native_export on an imported_video clip must be refused', () => {
    const clip = {
      ...validImportedClip(),
      nativeMediaIdentity: {
        schemaVersion: 1,
        format: 'pickle.native-media-identity.v1',
        receiptId: '66666666-6666-4666-8666-666666666666',
        operationId: '77777777-7777-4777-8777-777777777777',
        origin: 'native_export',
        algorithm: 'sha256',
        videoFileName: 'import-abc.mov',
        byteSize: 1_000_000,
        sha256: SHA,
      },
    };
    expect(() => assertCapturedClip(clip, 'imported_video')).toThrow();
  });

  it('ATTACK B7: poster URI escaping the captures directory must be refused', () => {
    expect(() =>
      assertCapturedClip(
        {
          ...validImportedClip(),
          posterUri: 'file:///private/captures/../../../etc/passwd',
        },
        'imported_video',
      ),
    ).toThrow();
  });

  it('ATTACK B8: pose sidecar ref claiming more frames than the extraction ceiling must be refused', () => {
    expect(() =>
      assertCapturedClip(
        withPoseRef(validImportedClip(), MAX_IMPORTED_POSE_FRAMES + 1),
        'imported_video',
      ),
    ).toThrow();
  });

  it('ATTACK B9: an empty file: URI (no path) must be refused', () => {
    expect(() =>
      assertCapturedClip(
        { ...validImportedClip(), uri: 'file:' },
        'imported_video',
      ),
    ).toThrow();
  });

  it('ATTACK B10: a clip URI with parent-directory traversal must be refused', () => {
    expect(() =>
      assertCapturedClip(
        {
          ...validImportedClip(),
          uri: 'file:///private/captures/../../Library/Cookies/evil.mov',
        },
        'imported_video',
      ),
    ).toThrow();
  });
});

describe('ADV imported clip boundary: persisted row after relaunch', () => {
  beforeEach(() => setActiveDataOwner(owner));
  afterEach(() => {
    closeSqliteTestDatabases();
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  });

  function seedRow(clip: Record<string, unknown>, payload: string) {
    const { db, native } = createSqliteTestDb();
    native
      .prepare(
        `INSERT INTO local_capture
    (owner_key, id, uri, shot_type, captured_at, duration_ms, fps, width, height, status, payload)
    VALUES (?, ?, ?, 'forehand_drive', ?, ?, ?, ?, ?, 'awaiting_model', ?)`,
      )
      .run(
        owner,
        captureId,
        clip.uri,
        clip.capturedAtIso,
        clip.durationMs,
        clip.fps,
        clip.width,
        clip.height,
        payload,
      );
    return db;
  }

  it('ATTACK B11: a persisted 0 fps / 2 h imported row must not reload as a VALID pending capture', async () => {
    const clip = { ...validImportedClip(), fps: 0, durationMs: 7_200_000 };
    const db = seedRow(clip, JSON.stringify(clip));
    const pending = await getPendingCapture(db, captureId);
    expect(pending).not.toBeNull();
    expect(pending!.evidenceStatus).not.toBe('valid');
    expect(pending!.clip).toBeNull();
  });

  it('ATTACK B12: a persisted payload with a trailing-garbage JSON body is corrupt, not legacy', async () => {
    const clip = validImportedClip();
    const db = seedRow(clip, `${JSON.stringify(clip)}garbage`);
    const pending = await getPendingCapture(db, captureId);
    expect(pending!.evidenceStatus).toBe('corrupt');
    expect(pending!.clip).toBeNull();
  });

  it('ATTACK B13: a persisted payload whose declared byteSize disagrees with its identity is refused', async () => {
    const clip: Record<string, unknown> = {
      ...validImportedClip(),
      byteSize: 999,
      nativeMediaIdentity: {
        schemaVersion: 1,
        format: 'pickle.native-media-identity.v1',
        receiptId: '66666666-6666-4666-8666-666666666666',
        operationId: '77777777-7777-4777-8777-777777777777',
        origin: 'import_copy',
        algorithm: 'sha256',
        videoFileName: 'import-abc.mov',
        byteSize: 1_000_000,
        sha256: SHA,
      },
    };
    const db = seedRow(clip, JSON.stringify(clip));
    const pending = await getPendingCapture(db, captureId);
    expect(pending!.evidenceStatus).toBe('corrupt');
    expect(pending!.clip).toBeNull();
  });

  it('control: a valid persisted imported row reloads as valid evidence', async () => {
    const clip = validImportedClip();
    const db = seedRow(clip, JSON.stringify(clip));
    const pending = await getPendingCapture(db, captureId);
    expect(pending!.evidenceStatus).toBe('valid');
    expect((pending!.clip as CapturedClip).captureMode).toBe('imported_video');
  });
});
