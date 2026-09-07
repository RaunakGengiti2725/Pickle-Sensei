jest.mock('react-native', () => {
  const bridge = {
    capture: jest.fn(),
    importVideo: jest.fn(),
    compareCapturedClipBytes: jest.fn(),
    cancel: jest.fn(),
  };
  return {
    NativeModules: { PickleVideoCapture: bridge },
    Platform: { OS: 'ios' },
  };
});

import {
  assertCapturedClip,
  cancelCameraOperation,
  captureStrokeVideo,
  importStrokeVideo,
  verifyCapturedClipCurrentBytes,
} from '../src/camera/capture';
import {
  captureDataOwnerContext,
  setActiveDataOwner,
  SIGNED_OUT_DATA_OWNER,
} from '../src/data/accountScope';
import {
  getPendingCapture,
  savePendingCapture,
  updateCaptureClipPayload,
} from '../src/data/repository';
import {
  closeSqliteTestDatabases,
  createSqliteTestDb,
} from '../testSupport/sqlite';

const { NativeModules } = jest.requireMock('react-native') as {
  NativeModules: { PickleVideoCapture: Record<string, jest.Mock | undefined> };
};
const bridge = NativeModules.PickleVideoCapture;
const ownerA = '11111111-1111-4111-8111-111111111111';
const ownerB = '22222222-2222-4222-8222-222222222222';
const identity = {
  schemaVersion: 1,
  format: 'pickle.native-media-identity.v1',
  receiptId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  operationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  videoFileName: 'import-cccccccc-cccc-4ccc-8ccc-cccccccccccc.mov',
  origin: 'import_copy',
  algorithm: 'sha256',
  sha256: 'a'.repeat(64),
  byteSize: 2097169,
};
const legacy = {
  uri: `file:///private/var/mobile/Containers/Data/Application/dddddddd-dddd-4ddd-8ddd-dddddddddddd/Library/Application%20Support/PickleSensei/Captures/${identity.videoFileName}`,
  durationMs: 4200,
  fps: 59.94,
  width: 720,
  height: 1280,
  capturedAtIso: '2026-08-27T18:00:00.000Z',
  captureMode: 'imported_video',
  recognition: { status: 'unknown', reason: 'imported_video_not_analyzed' },
  ballSpeed: { status: 'unavailable', reason: 'analysis_not_run' },
};
const clip = {
  ...legacy,
  byteSize: identity.byteSize,
  nativeMediaIdentity: identity,
};

function response(operationId: string, status = 'verified-current-bytes') {
  return {
    status,
    operationId,
    receiptId: identity.receiptId,
    videoFileName: identity.videoFileName,
    expectedSha256: identity.sha256,
    expectedByteSize: identity.byteSize,
  };
}
function deferred() {
  let resolve!: (value: unknown) => void;
  let reject!: (value: unknown) => void;
  const promise = new Promise<unknown>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
async function drain() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  setActiveDataOwner(ownerA);
  bridge.compareCapturedClipBytes = jest.fn(request =>
    Promise.resolve(response(request.operationId)),
  );
  bridge.cancel = jest.fn();
  bridge.importVideo = jest.fn().mockResolvedValue(clip);
  bridge.capture = jest.fn();
});
afterEach(() => {
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  closeSqliteTestDatabases();
});

describe('strict optional native creation identity (unsigned expectation)', () => {
  it('preserves legacy absence without adding an identity', async () => {
    const parsed = assertCapturedClip(legacy);
    expect(parsed).not.toHaveProperty('nativeMediaIdentity');
    await expect(
      verifyCapturedClipCurrentBytes(parsed, captureDataOwnerContext()),
    ).resolves.toEqual({ status: 'legacy' });
    expect(bridge.compareCapturedClipBytes).not.toHaveBeenCalled();
    expect(bridge.cancel).not.toHaveBeenCalled();
  });

  it('preserves the exact valid identity through import and JSON serialization', async () => {
    const parsed = await importStrokeVideo();
    expect(parsed.nativeMediaIdentity).toEqual(identity);
    expect(assertCapturedClip(JSON.parse(JSON.stringify(parsed)))).toEqual(
      clip,
    );
    expect(bridge.compareCapturedClipBytes).not.toHaveBeenCalled();
  });

  it.each([null, undefined, false, [], {}, 'sha256'])(
    'rejects provided malformed identity %p rather than treating it as legacy',
    value => {
      expect(() =>
        assertCapturedClip({ ...clip, nativeMediaIdentity: value }),
      ).toThrow();
    },
  );

  it.each([
    ['schemaVersion', 2],
    ['schemaVersion', true],
    ['format', 'pickle.native-media-identity.v2'],
    ['receiptId', 'receipt'],
    ['receiptId', `${identity.receiptId}\n`],
    ['operationId', 'camera-js-id'],
    ['operationId', '00000000-0000-0000-0000-000000000000'],
    ['origin', 'original_camera'],
    ['algorithm', 'sha1'],
    ['sha256', 'a'.repeat(63)],
    ['sha256', 'g'.repeat(64)],
    ['sha256', `${identity.sha256}\n`],
    ['byteSize', 0],
    ['byteSize', 536870913],
    ['byteSize', 1.5],
    ['byteSize', Number.NaN],
    ['byteSize', Number.POSITIVE_INFINITY],
    ['byteSize', '2097169'],
    ['byteSize', true],
    ['videoFileName', '../clip.mov'],
    ['videoFileName', 'other.mov'],
    ['videoFileName', `${identity.videoFileName}?x=1`],
    ['owner', ownerA],
  ])(
    'rejects malformed field %s = %p without native access',
    async (key, value) => {
      const malformed = {
        ...clip,
        nativeMediaIdentity: { ...identity, [key as string]: value },
      };
      expect(() => assertCapturedClip(malformed)).toThrow();
      await expect(
        verifyCapturedClipCurrentBytes(malformed, captureDataOwnerContext()),
      ).resolves.toEqual({ status: 'invalid' });
      expect(bridge.compareCapturedClipBytes).not.toHaveBeenCalled();
    },
  );

  it.each(Object.keys(identity))('rejects missing required field %s', key => {
    const incomplete: Record<string, unknown> = { ...identity };
    delete incomplete[key];
    expect(() =>
      assertCapturedClip({ ...clip, nativeMediaIdentity: incomplete }),
    ).toThrow();
  });

  it.each([undefined, identity.byteSize + 1])(
    'requires a matching outer byteSize (%p)',
    byteSize => {
      expect(() => assertCapturedClip({ ...clip, byteSize })).toThrow();
    },
  );

  it.each([1, 536870912])(
    'accepts the inclusive size boundary %i',
    byteSize => {
      expect(
        assertCapturedClip({
          ...clip,
          byteSize,
          nativeMediaIdentity: { ...identity, byteSize },
        }).nativeMediaIdentity?.byteSize,
      ).toBe(byteSize);
    },
  );

  it.each([
    `${legacy.uri}?`,
    `${legacy.uri}?token=one`,
    `${legacy.uri}#`,
    `${legacy.uri}#fragment`,
    legacy.uri.replace('file:///', 'file://remote/'),
    legacy.uri.replace('file:///', 'https:///'),
    legacy.uri.replace('/Captures/', '/Captures/../Captures/'),
    legacy.uri.replace('/Captures/', '/Captures/%2e%2e/Captures/'),
    legacy.uri.replace('/Captures/', '/Captures%2f'),
    `${legacy.uri}%00`,
    `${legacy.uri}\n`,
    legacy.uri.replace(identity.videoFileName, 'other.mov'),
  ])(
    'rejects ambiguous or mismatched URI %s before native access',
    async uri => {
      await expect(
        verifyCapturedClipCurrentBytes(
          { ...clip, uri },
          captureDataOwnerContext(),
        ),
      ).resolves.toEqual({ status: 'invalid' });
      expect(bridge.compareCapturedClipBytes).not.toHaveBeenCalled();
    },
  );

  it('does not coerce metadata or execute a supplied accessor', () => {
    const getter = jest.fn(() => identity.sha256);
    const malformed = { ...identity };
    Object.defineProperty(malformed, 'sha256', {
      get: getter,
      enumerable: true,
    });
    expect(() =>
      assertCapturedClip({ ...clip, nativeMediaIdentity: malformed }),
    ).toThrow();
    expect(getter).not.toHaveBeenCalled();
  });

  it('round-trips exact metadata through real SQLite capture storage and a payload update', async () => {
    const { db } = createSqliteTestDb();
    const parsed = await importStrokeVideo();
    await savePendingCapture(db, 'capture-one', 'forehand_drive', parsed);
    const first = await getPendingCapture(db, 'capture-one');
    expect(first?.clip?.nativeMediaIdentity).toEqual(identity);
    const withPose = assertCapturedClip({
      ...parsed,
      poseSequence: {
        schemaVersion: 1,
        format: 'pickle.pose-sequence.v1',
        uri: legacy.uri.replace('.mov', '-poses.json'),
        frameCount: 1,
        sha256: 'b'.repeat(64),
        coordinateSystem: 'normalized_image_top_left',
        poseModelVersion: 'pose-1',
      },
    });
    await updateCaptureClipPayload(db, 'capture-one', withPose);
    expect(
      (await getPendingCapture(db, 'capture-one'))?.clip?.nativeMediaIdentity,
    ).toEqual(identity);
    await savePendingCapture(
      db,
      'legacy-one',
      'forehand_drive',
      assertCapturedClip({
        ...legacy,
        uri: legacy.uri.replace('.mov', '-legacy.mov'),
      }),
    );
    const old = (await getPendingCapture(db, 'legacy-one'))?.clip;
    expect(old).not.toHaveProperty('nativeMediaIdentity');
    await expect(
      verifyCapturedClipCurrentBytes(old, captureDataOwnerContext()),
    ).resolves.toEqual({ status: 'legacy' });
    setActiveDataOwner(ownerB);
    expect(await getPendingCapture(db, 'capture-one')).toBeNull();
    expect(bridge.compareCapturedClipBytes).not.toHaveBeenCalled();
  });
});

describe('owner-context-bound fresh current-byte comparison', () => {
  it('does not downgrade corrupt stored identity to legacy absence', async () => {
    const { db } = createSqliteTestDb();
    await savePendingCapture(
      db,
      'corrupt-one',
      'forehand_drive',
      assertCapturedClip(clip),
    );
    await db.execute(
      'UPDATE local_capture SET payload = ? WHERE owner_key = ? AND id = ?',
      [
        JSON.stringify({
          ...clip,
          nativeMediaIdentity: { ...identity, sha256: 'bad' },
        }),
        ownerA,
        'corrupt-one',
      ],
    );
    const stored = await getPendingCapture(db, 'corrupt-one');
    expect(stored?.evidenceStatus).toBe('corrupt');
    expect(stored?.clip).toBeNull();
    await expect(
      verifyCapturedClipCurrentBytes(stored?.clip, captureDataOwnerContext()),
    ).resolves.toEqual({ status: 'invalid' });
    expect(bridge.compareCapturedClipBytes).not.toHaveBeenCalled();
  });

  it.each(['', 'A\n', '../bad', 'x'.repeat(129)])(
    'rejects invalid comparison operation id %p without native work',
    async operationId => {
      await expect(
        verifyCapturedClipCurrentBytes(clip, captureDataOwnerContext(), {
          operationId,
        }),
      ).resolves.toEqual({ status: 'invalid' });
      expect(bridge.compareCapturedClipBytes).not.toHaveBeenCalled();
      expect(bridge.cancel).not.toHaveBeenCalled();
    },
  );

  it('passes the original expectation and a distinct comparison operation id, without rewriting the clip', async () => {
    const before = JSON.stringify(clip);
    await expect(
      verifyCapturedClipCurrentBytes(clip, captureDataOwnerContext(), {
        operationId: 'compare-one',
      }),
    ).resolves.toEqual({
      status: 'verified-current-bytes',
      comparedExpectation: identity,
    });
    expect(bridge.compareCapturedClipBytes).toHaveBeenCalledWith({
      uri: clip.uri,
      byteSize: clip.byteSize,
      nativeMediaIdentity: identity,
      operationId: 'compare-one',
    });
    expect(JSON.stringify(clip)).toBe(before);
    expect(bridge.capture).not.toHaveBeenCalled();
    expect(bridge.importVideo).not.toHaveBeenCalled();
  });

  it('never caches success or upgrades a mismatch, even for a same-name same-size replacement', async () => {
    bridge.compareCapturedClipBytes!.mockImplementation(request =>
      Promise.resolve(response(request.operationId, 'mismatch')),
    );
    await expect(
      verifyCapturedClipCurrentBytes(clip, captureDataOwnerContext()),
    ).resolves.toEqual({ status: 'mismatch' });
    await expect(
      verifyCapturedClipCurrentBytes(clip, captureDataOwnerContext()),
    ).resolves.toEqual({ status: 'mismatch' });
    expect(bridge.compareCapturedClipBytes).toHaveBeenCalledTimes(2);
  });

  it.each(['missing', 'throwing'])(
    'reports unavailable native support (%s)',
    async mode => {
      if (mode === 'missing') bridge.compareCapturedClipBytes = undefined;
      else
        bridge.compareCapturedClipBytes!.mockRejectedValue(
          new Error('unreadable'),
        );
      await expect(
        verifyCapturedClipCurrentBytes(clip, captureDataOwnerContext()),
      ).resolves.toEqual({ status: 'unavailable' });
    },
  );

  it.each([
    ['status', 'verified'],
    ['status', 'original'],
    ['receiptId', ownerB],
    ['operationId', 'old-operation'],
    ['videoFileName', 'other.mov'],
    ['expectedSha256', 'b'.repeat(64)],
    ['expectedByteSize', 1],
    ['attested', true],
  ])(
    'rejects native responses with substituted or overstated %s',
    async (key, value) => {
      bridge.compareCapturedClipBytes!.mockImplementation(request =>
        Promise.resolve({
          ...response(request.operationId),
          [key as string]: value,
        }),
      );
      await expect(
        verifyCapturedClipCurrentBytes(clip, captureDataOwnerContext()),
      ).resolves.toEqual({ status: 'invalid' });
    },
  );

  it.each([
    'camera.cancelled',
    'camera.invalid_byte_comparison_request',
    'camera.byte_comparison_unavailable',
  ])('maps native error %s conservatively', async code => {
    bridge.compareCapturedClipBytes!.mockRejectedValue({ code });
    await expect(
      verifyCapturedClipCurrentBytes(clip, captureDataOwnerContext()),
    ).resolves.toEqual({
      status:
        code === 'camera.cancelled'
          ? 'cancelled'
          : code === 'camera.invalid_byte_comparison_request'
            ? 'invalid'
            : 'unavailable',
    });
  });

  it('never starts native work for stale owners or already-aborted calls', async () => {
    const context = captureDataOwnerContext();
    setActiveDataOwner(ownerB);
    await expect(
      verifyCapturedClipCurrentBytes(clip, context),
    ).resolves.toEqual({ status: 'cancelled' });
    const controller = new AbortController();
    controller.abort();
    await expect(
      verifyCapturedClipCurrentBytes(clip, captureDataOwnerContext(), {
        signal: controller.signal,
      }),
    ).resolves.toEqual({ status: 'cancelled' });
    expect(bridge.compareCapturedClipBytes).not.toHaveBeenCalled();
    expect(bridge.cancel).not.toHaveBeenCalled();
  });

  it('cancels promptly on owner A to B to A and retains the busy barrier until native drains', async () => {
    const pending = deferred();
    bridge.compareCapturedClipBytes!.mockReturnValue(pending.promise);
    const context = captureDataOwnerContext();
    const run = verifyCapturedClipCurrentBytes(clip, context, {
      operationId: 'A',
    });
    setActiveDataOwner(ownerB);
    setActiveDataOwner(ownerA);
    await expect(run).resolves.toEqual({ status: 'cancelled' });
    await expect(
      verifyCapturedClipCurrentBytes(clip, captureDataOwnerContext(), {
        operationId: 'B',
      }),
    ).resolves.toEqual({ status: 'unavailable' });
    expect(bridge.compareCapturedClipBytes).toHaveBeenCalledTimes(1);
    expect(bridge.cancel).toHaveBeenCalledTimes(1);
    pending.resolve(response('A'));
    await drain();
  });

  it.each(['resolve', 'reject'])(
    'ignores late A %s and stale A cancellation after B starts',
    async settle => {
      const a = deferred();
      const b = deferred();
      const controllerA = new AbortController();
      bridge
        .compareCapturedClipBytes!.mockReturnValueOnce(a.promise)
        .mockReturnValueOnce(b.promise);
      const runA = verifyCapturedClipCurrentBytes(
        clip,
        captureDataOwnerContext(),
        { operationId: 'A', signal: controllerA.signal },
      );
      controllerA.abort();
      await expect(runA).resolves.toEqual({ status: 'cancelled' });
      if (settle === 'resolve') a.resolve(response('A'));
      else a.reject(new Error('late A'));
      await drain();
      setActiveDataOwner(ownerB);
      const runB = verifyCapturedClipCurrentBytes(
        clip,
        captureDataOwnerContext(),
        { operationId: 'B' },
      );
      cancelCameraOperation('A');
      controllerA.abort();
      expect(bridge.cancel).toHaveBeenCalledTimes(1);
      b.resolve(response('B'));
      await expect(runB).resolves.toMatchObject({
        status: 'verified-current-bytes',
      });
    },
  );

  it('fences a final owner change even after native promise completion', async () => {
    const pending = deferred();
    bridge.compareCapturedClipBytes!.mockReturnValue(pending.promise);
    const run = verifyCapturedClipCurrentBytes(
      clip,
      captureDataOwnerContext(),
      { operationId: 'A' },
    );
    pending.resolve(response('A'));
    void Promise.resolve().then(() => setActiveDataOwner(ownerB));
    await expect(run).resolves.toEqual({ status: 'cancelled' });
  });

  it('snapshots the original expectation against caller mutation while reading', async () => {
    const pending = deferred();
    bridge.compareCapturedClipBytes!.mockReturnValue(pending.promise);
    const mutable = { ...clip, nativeMediaIdentity: { ...identity } };
    const run = verifyCapturedClipCurrentBytes(
      mutable,
      captureDataOwnerContext(),
      { operationId: 'A' },
    );
    mutable.nativeMediaIdentity.sha256 = 'b'.repeat(64);
    mutable.byteSize = 1;
    pending.resolve(response('A'));
    await expect(run).resolves.toEqual({
      status: 'verified-current-bytes',
      comparedExpectation: identity,
    });
    expect(
      bridge.compareCapturedClipBytes!.mock.calls[0]?.[0].nativeMediaIdentity
        .sha256,
    ).toBe(identity.sha256);
  });

  it('does not cancel a guided capture it failed to acquire', async () => {
    const guided = deferred();
    bridge.capture!.mockReturnValue(guided.promise);
    const run = captureStrokeVideo({ operationId: 'guided' });
    void run.catch(() => {});
    await expect(
      verifyCapturedClipCurrentBytes(clip, captureDataOwnerContext(), {
        operationId: 'compare',
      }),
    ).resolves.toEqual({ status: 'unavailable' });
    expect(bridge.cancel).not.toHaveBeenCalled();
    cancelCameraOperation('guided');
    guided.reject(new Error('drained'));
    await expect(run).rejects.toMatchObject({ code: 'camera.cancelled' });
    await drain();
  });
});
