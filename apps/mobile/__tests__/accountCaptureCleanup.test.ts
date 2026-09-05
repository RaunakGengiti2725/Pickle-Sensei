import { NativeModules } from 'react-native';
import {
  CaptureCleanupError,
  cleanupAccountCaptures,
} from '../src/account/captureCleanup';
import type { LocalDb } from '../src/data/db';

jest.mock('react-native', () => ({ NativeModules: {} }));

declare const __dirname: string;
const { execFileSync } = jest.requireActual<{
  execFileSync(
    file: string,
    args: string[],
    options: { input: string; encoding: 'utf8'; timeout: number },
  ): string;
}>('node:child_process');
const { readFileSync } = jest.requireActual<{
  readFileSync(path: string, encoding: 'utf8'): string;
}>('node:fs');
const { join } = jest.requireActual<{
  join(...parts: string[]): string;
}>('node:path');
const { platform } = jest.requireActual<{ platform: string }>('node:process');

const OWNER = '11111111-1111-4111-8111-111111111111';
const ROOT =
  'file:///var/mobile/Containers/Data/Application/22222222-2222-4222-8222-222222222222/Library/Application%20Support/PickleSensei/Captures/';
const OLD_ROOT = ROOT.replace(
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333',
);
const mockDeleteCaptureFiles = jest.fn();
type Row = Record<string, unknown>;

function capture(uri: string, payload: unknown = null): Row {
  return {
    uri,
    payload: payload === null ? null : JSON.stringify(payload),
  };
}

function database(owned: Row[] = [], others: Row[] = []) {
  const execute = jest.fn(async (sql: string, _params?: unknown[]) => ({
    rows: sql.includes('owner_key = ?') ? owned : others,
  }));
  const db: LocalDb = { execute, close: jest.fn() };
  return { db, execute };
}

beforeEach(() => {
  mockDeleteCaptureFiles.mockReset();
  mockDeleteCaptureFiles.mockImplementation(async (uris: string[]) => ({
    results: uris.map((_, index) => ({ index, status: 'deleted' })),
  }));
  NativeModules.PickleVideoCapture = {
    deleteCaptureFiles: mockDeleteCaptureFiles,
  };
});

describe('cleanupAccountCaptures', () => {
  it('reads only the explicitly deleted owner and other-owner references with bound parameters before deleting recorded media', async () => {
    const uri = ROOT + 'own.mov';
    const payloadUri = OLD_ROOT + 'own.mov';
    const posterUri = ROOT + 'own-poster.jpg';
    const poseUri = ROOT + 'own.pose.json';
    const { db, execute } = database([
      capture(uri, {
        uri: payloadUri,
        posterUri,
        poseSequence: { uri: poseUri },
      }),
      capture(uri),
    ]);

    await expect(cleanupAccountCaptures(db, OWNER)).resolves.toEqual({
      deletedCount: 4,
      missingCount: 0,
      sharedCount: 0,
    });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[0]).toEqual([
      'SELECT uri, payload FROM local_capture WHERE owner_key = ?',
      [OWNER],
    ]);
    expect(execute.mock.calls[1]).toEqual([
      'SELECT uri, payload FROM local_capture WHERE owner_key <> ? OR owner_key IS NULL',
      [OWNER],
    ]);
    expect(mockDeleteCaptureFiles).toHaveBeenCalledWith([
      uri,
      payloadUri,
      posterUri,
      poseUri,
    ]);
    expect(execute.mock.invocationCallOrder[1]).toBeLessThan(
      mockDeleteCaptureFiles.mock.invocationCallOrder[0]!,
    );
    expect(execute.mock.calls.every(([sql]) => sql.startsWith('SELECT '))).toBe(
      true,
    );
  });

  it('never interpolates an owner into SQL or substitutes the active owner', async () => {
    const deletedOwner = "deleted' OR 1=1 --";
    const { db, execute } = database([capture(ROOT + 'owned.mov')]);
    await cleanupAccountCaptures(db, deletedOwner);
    for (const [sql, params] of execute.mock.calls) {
      expect(sql).not.toContain(deletedOwner);
      expect(params).toEqual([deletedOwner]);
    }
  });

  it('protects shared references across video, poster, and pose fields, even when another owner has a relocated, escaped, or case-aliased basename', async () => {
    const ownOnly = ROOT + 'exclusive.mov';
    const { db } = database(
      [
        capture(ROOT + 'shared.mov', {
          uri: ownOnly,
          posterUri: ROOT + 'shared-poster.jpg',
          poseSequence: { uri: ROOT + 'shared.pose.json' },
        }),
      ],
      [
        capture(OLD_ROOT + 'sha%72ed.mov', {
          uri: ROOT + 'someone-elses.mov',
          posterUri: OLD_ROOT + 'SHARED.POSE.JSON',
          poseSequence: { uri: ROOT + 'shared-poster.jpg' },
        }),
      ],
    );
    await expect(cleanupAccountCaptures(db, OWNER)).resolves.toEqual({
      deletedCount: 1,
      missingCount: 0,
      sharedCount: 3,
    });
    expect(mockDeleteCaptureFiles).toHaveBeenCalledWith([ownOnly]);
  });

  it('protects exact shared URIs and Unicode-normalized basenames without requiring a native bridge', async () => {
    NativeModules.PickleVideoCapture = undefined;
    const uri = ROOT + 'shared.mov';
    const { db } = database(
      [capture(uri), capture(ROOT + 'caf%C3%A9.mov')],
      [capture(uri), capture(OLD_ROOT + 'cafe%CC%81.mov')],
    );
    await expect(cleanupAccountCaptures(db, OWNER)).resolves.toEqual({
      deletedCount: 0,
      missingCount: 0,
      sharedCount: 2,
    });
    expect(mockDeleteCaptureFiles).not.toHaveBeenCalled();
  });

  it('conservatively protects Unicode case-folding aliases across owners', async () => {
    const { db } = database(
      [capture(ROOT + 'STRASSE.mov'), capture(ROOT + '%CF%83.pose.json')],
      [
        capture(OLD_ROOT + 'stra%E1%BA%9Ee.mov'),
        capture(OLD_ROOT + '%CF%82.pose.json'),
      ],
    );
    await expect(cleanupAccountCaptures(db, OWNER)).resolves.toEqual({
      deletedCount: 0,
      missingCount: 0,
      sharedCount: 2,
    });
    expect(mockDeleteCaptureFiles).not.toHaveBeenCalled();
  });

  it('does not call native or inspect unrelated payloads when the owner has no capture rows', async () => {
    NativeModules.PickleVideoCapture = undefined;
    const { db, execute } = database([], [{ uri: 'private', payload: '{' }]);
    await expect(cleanupAccountCaptures(db, OWNER)).resolves.toEqual({
      deletedCount: 0,
      missingCount: 0,
      sharedCount: 0,
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(mockDeleteCaptureFiles).not.toHaveBeenCalled();
  });

  it.each([null, '', undefined])(
    'cleans legacy rows with a %p payload using only their recorded video URI',
    async payload => {
      const uri = ROOT + 'legacy.mov';
      const { db } = database([{ uri, payload }]);
      await cleanupAccountCaptures(db, OWNER);
      expect(mockDeleteCaptureFiles).toHaveBeenCalledWith([uri]);
    },
  );

  it.each([
    '{broken',
    '[]',
    '42',
    JSON.stringify({ posterUri: { uri: ROOT + 'hidden.jpg' } }),
    JSON.stringify({ poseSequence: ['hidden.pose.json'] }),
    JSON.stringify({ poseSequence: { uri: 42 } }),
  ])(
    'fails closed on an unreadable owned payload without discarding the retry manifest: %s',
    async payload => {
      const { db, execute } = database([{ uri: ROOT + 'legacy.mov', payload }]);
      await expect(cleanupAccountCaptures(db, OWNER)).rejects.toMatchObject({
        code: 'capture.references_unreadable',
      });
      expect(mockDeleteCaptureFiles).not.toHaveBeenCalled();
      expect(
        execute.mock.calls.every(([sql]) => sql.startsWith('SELECT ')),
      ).toBe(true);
    },
  );

  it('fails closed if another owner has an unreadable payload that could hide a shared sidecar', async () => {
    const { db } = database(
      [capture(ROOT + 'own.mov')],
      [{ uri: ROOT + 'other.mov', payload: '{"posterUri":' }],
    );
    await expect(cleanupAccountCaptures(db, OWNER)).rejects.toMatchObject({
      code: 'capture.references_unreadable',
    });
    expect(mockDeleteCaptureFiles).not.toHaveBeenCalled();
  });

  it('fails closed on an undecodable other-owner URI', async () => {
    const { db } = database(
      [capture(ROOT + 'own.mov')],
      [capture(OLD_ROOT + 'bad%zz.mov')],
    );
    await expect(cleanupAccountCaptures(db, OWNER)).rejects.toMatchObject({
      code: 'capture.references_unreadable',
    });
    expect(mockDeleteCaptureFiles).not.toHaveBeenCalled();
  });

  it.each(['', '   '])('refuses a missing explicit owner: %p', async owner => {
    const { db, execute } = database([capture(ROOT + 'own.mov')]);
    await expect(cleanupAccountCaptures(db, owner)).rejects.toMatchObject({
      code: 'capture.invalid_owner',
    });
    expect(execute).not.toHaveBeenCalled();
    expect(mockDeleteCaptureFiles).not.toHaveBeenCalled();
  });

  it.each([undefined, null, 42, '', ROOT + 'bad%zz.mov'])(
    'fails closed on an unreadable row URI: %p',
    async uri => {
      const { db, execute } = database([{ uri, payload: null }]);
      await expect(cleanupAccountCaptures(db, OWNER)).rejects.toMatchObject({
        code: 'capture.references_unreadable',
      });
      expect(mockDeleteCaptureFiles).not.toHaveBeenCalled();
      expect(
        execute.mock.calls.every(([sql]) => sql.startsWith('SELECT ')),
      ).toBe(true);
    },
  );

  it('validates every manifest before submitting even the first native batch', async () => {
    const { db } = database([
      ...Array.from({ length: 260 }, (_, index) =>
        capture(ROOT + `${index}.mov`),
      ),
      { uri: ROOT + 'last.mov', payload: '{' },
    ]);
    await expect(cleanupAccountCaptures(db, OWNER)).rejects.toMatchObject({
      code: 'capture.references_unreadable',
    });
    expect(mockDeleteCaptureFiles).not.toHaveBeenCalled();
  });

  it('reports bridge unavailability rather than pretending clips were removed', async () => {
    NativeModules.PickleVideoCapture = {};
    const { db } = database([capture(ROOT + 'own.mov')]);
    await expect(cleanupAccountCaptures(db, OWNER)).rejects.toMatchObject({
      code: 'capture.native_unavailable',
    });
  });

  it('sanitizes database failures without leaking paths, owners, or source errors', async () => {
    const { db, execute } = database([capture(ROOT + 'own.mov')]);
    execute.mockRejectedValueOnce(new Error(ROOT + OWNER));
    const error = await cleanupAccountCaptures(db, OWNER).catch(value => value);
    expect(error).toBeInstanceOf(CaptureCleanupError);
    expect(error.code).toBe('capture.read_failed');
    expect(error.message).not.toContain(ROOT);
    expect(error.message).not.toContain(OWNER);
    expect(error.cause).toBeUndefined();
    expect(mockDeleteCaptureFiles).not.toHaveBeenCalled();
  });

  it('does not delete anything if the other-owner reference read fails', async () => {
    const { db, execute } = database([capture(ROOT + 'own.mov')]);
    execute.mockResolvedValueOnce({ rows: [capture(ROOT + 'own.mov')] });
    execute.mockRejectedValueOnce(new Error(ROOT + OWNER));
    await expect(cleanupAccountCaptures(db, OWNER)).rejects.toMatchObject({
      code: 'capture.read_failed',
    });
    expect(mockDeleteCaptureFiles).not.toHaveBeenCalled();
  });

  it('sanitizes rejected native promises without logging the original error', async () => {
    const log = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    try {
      const { db } = database([capture(ROOT + 'own.mov')]);
      mockDeleteCaptureFiles.mockRejectedValueOnce(new Error(ROOT + OWNER));
      const error = await cleanupAccountCaptures(db, OWNER).catch(
        value => value,
      );
      expect(error).toBeInstanceOf(CaptureCleanupError);
      expect(error.code).toBe('capture.delete_failed');
      expect(error.message).not.toContain(ROOT);
      expect(error.message).not.toContain(OWNER);
      expect(error.cause).toBeUndefined();
      expect(log).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  it.each(['failed', 'rejected'])(
    'reports a native %s item and safely retries the same recorded references',
    async status => {
      const { db } = database([
        capture(ROOT + 'own.mov', { posterUri: ROOT + 'own-poster.jpg' }),
      ]);
      mockDeleteCaptureFiles.mockResolvedValueOnce({
        results: [
          { index: 0, status: 'deleted' },
          { index: 1, status, code: 'file.delete_failed' },
        ],
      });
      await expect(cleanupAccountCaptures(db, OWNER)).rejects.toMatchObject({
        code: 'capture.delete_failed',
      });
      mockDeleteCaptureFiles.mockResolvedValueOnce({
        results: [
          { index: 0, status: 'missing' },
          { index: 1, status: 'deleted' },
        ],
      });
      await expect(cleanupAccountCaptures(db, OWNER)).resolves.toEqual({
        deletedCount: 1,
        missingCount: 1,
        sharedCount: 0,
      });
      expect(mockDeleteCaptureFiles.mock.calls[0]).toEqual(
        mockDeleteCaptureFiles.mock.calls[1],
      );
    },
  );

  it.each([
    undefined,
    { results: [] },
    { results: [{ index: 9, status: 'deleted' }] },
    { results: [{ index: 0, status: 'unknown' }] },
    { results: [{ status: 'deleted' }] },
  ])(
    'does not accept an incomplete native acknowledgement: %p',
    async value => {
      const { db } = database([capture(ROOT + 'own.mov')]);
      mockDeleteCaptureFiles.mockResolvedValueOnce(value);
      await expect(cleanupAccountCaptures(db, OWNER)).rejects.toMatchObject({
        code: 'capture.delete_failed',
      });
    },
  );

  it('rejects duplicate native result indices', async () => {
    const { db } = database([
      capture(ROOT + 'own.mov', { posterUri: ROOT + 'own-poster.jpg' }),
    ]);
    mockDeleteCaptureFiles.mockResolvedValueOnce({
      results: [
        { index: 0, status: 'deleted' },
        { index: 0, status: 'deleted' },
      ],
    });
    await expect(cleanupAccountCaptures(db, OWNER)).rejects.toMatchObject({
      code: 'capture.delete_failed',
    });
  });

  it('stops submitting batches after any incomplete acknowledgement', async () => {
    const { db, execute } = database(
      Array.from({ length: 260 }, (_, index) => capture(ROOT + `${index}.mov`)),
    );
    mockDeleteCaptureFiles.mockResolvedValueOnce({ results: [] });
    await expect(cleanupAccountCaptures(db, OWNER)).rejects.toMatchObject({
      code: 'capture.delete_failed',
    });
    expect(mockDeleteCaptureFiles).toHaveBeenCalledTimes(1);
    expect(mockDeleteCaptureFiles.mock.calls[0]![0]).toHaveLength(128);
    expect(execute.mock.calls.every(([sql]) => sql.startsWith('SELECT '))).toBe(
      true,
    );
  });

  it('bounds every native batch to 128 URIs and waits for each batch before starting the next', async () => {
    const { db } = database(
      Array.from({ length: 260 }, (_, index) => capture(ROOT + `${index}.mov`)),
    );
    let active = 0;
    let maximumActive = 0;
    mockDeleteCaptureFiles.mockImplementation(async (uris: string[]) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await Promise.resolve();
      active -= 1;
      return {
        results: uris.map((_, index) => ({ index, status: 'deleted' })),
      };
    });
    await expect(cleanupAccountCaptures(db, OWNER)).resolves.toEqual({
      deletedCount: 260,
      missingCount: 0,
      sharedCount: 0,
    });
    expect(
      mockDeleteCaptureFiles.mock.calls.map(([uris]) => uris.length),
    ).toEqual([128, 128, 4]);
    expect(maximumActive).toBe(1);
  });
});

const nativeSourcePath = join(
  __dirname,
  '../ios/LocalPods/PickleNative/Sources/ClipMediaStore.swift',
);

it('sets backup exclusion when accessing existing private iOS capture storage', () => {
  const source = readFileSync(nativeSourcePath, 'utf8');
  expect(source).toContain('isExcludedFromBackup = true');
  expect(source).toContain('try directory.setResourceValues(resourceValues)');
});

it('exposes bounded capture-file deletion through both native bridges', () => {
  const swift = readFileSync(
    join(
      __dirname,
      '../ios/LocalPods/PickleNative/Sources/PickleVideoCapture.swift',
    ),
    'utf8',
  );
  const objc = readFileSync(
    join(
      __dirname,
      '../ios/LocalPods/PickleNative/Sources/PickleVideoCaptureBridge.m',
    ),
    'utf8',
  );
  const android = readFileSync(
    join(
      __dirname,
      '../android/app/src/main/java/com/picklesensei/camera/PickleVideoCaptureModule.kt',
    ),
    'utf8',
  );
  expect(swift).toContain('@objc func deleteCaptureFiles(');
  expect(swift).toContain('CaptureMediaCleanup.maximumBatchSize');
  expect(swift).toContain('CaptureMediaCleanup.deleteFiles(');
  expect(objc).toContain(
    'RCT_EXTERN_METHOD(deleteCaptureFiles:(NSArray *)uris',
  );
  expect(android).toContain(
    'fun deleteCaptureFiles(uris: ReadableArray, promise: Promise)',
  );
  expect(android).toContain('MAX_CAPTURE_CLEANUP_BATCH = 128');
  expect(android).toContain('OsConstants.O_NOFOLLOW');
});

const nativeTest = platform === 'darwin' ? it : it.skip;

nativeTest(
  'runs the production iOS deletion implementation against synthetic files, relocation, traversal, directories, symlinks, missing files, and bounded batches',
  () => {
    const source = readFileSync(nativeSourcePath, 'utf8');
    const start = source.indexOf('enum CaptureMediaCleanup {');
    const end = source.indexOf('\nenum ClipMediaStore {');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const implementation = source.slice(start, end);
    const fixtures = String.raw`
let fm = FileManager.default
let sandbox = fm.temporaryDirectory.appendingPathComponent("pickle-cleanup-fixtures-\(UUID().uuidString)", isDirectory: true)
try fm.createDirectory(at: sandbox, withIntermediateDirectories: true)
defer { try? fm.removeItem(at: sandbox) }
let containers = sandbox.appendingPathComponent("Containers/Data/Application", isDirectory: true)
let current = containers.appendingPathComponent("22222222-2222-4222-8222-222222222222", isDirectory: true)
let previous = containers.appendingPathComponent("33333333-3333-4333-8333-333333333333", isDirectory: true)
let support = current.appendingPathComponent("Library/Application Support", isDirectory: true)
let root = support.appendingPathComponent("PickleSensei/Captures", isDirectory: true)
let previousRoot = previous.appendingPathComponent("Library/Application Support/PickleSensei/Captures", isDirectory: true)
let outside = sandbox.appendingPathComponent("outside/Captures", isDirectory: true)
for directory in [root, previousRoot, outside] {
  try fm.createDirectory(at: directory, withIntermediateDirectories: true)
}
func put(_ url: URL) throws {
  try Data("synthetic-only".utf8).write(to: url)
}
func results(_ uris: [String]) throws -> [[String: Any]] {
  try CaptureMediaCleanup.deleteFiles(uris, applicationSupportDirectory: support)
}
let video = root.appendingPathComponent("owned.mov")
let poster = root.appendingPathComponent("owned-poster.jpg")
let pose = root.appendingPathComponent("owned.pose.json")
let otherOwner = root.appendingPathComponent("other-owner.mov")
let oldVideo = previousRoot.appendingPathComponent("owned.mov")
let outsideVideo = outside.appendingPathComponent("owned.mov")
for file in [video, poster, pose, otherOwner, oldVideo, outsideVideo] { try put(file) }
let removed = try results([oldVideo.absoluteString, poster.absoluteString, pose.absoluteString])
precondition(removed.count == 3 && removed.allSatisfy { $0["status"] as? String == "deleted" })
precondition(!fm.fileExists(atPath: video.path))
precondition(!fm.fileExists(atPath: poster.path))
precondition(!fm.fileExists(atPath: pose.path))
precondition(fm.fileExists(atPath: otherOwner.path))
precondition(fm.fileExists(atPath: oldVideo.path))
precondition(fm.fileExists(atPath: outsideVideo.path))
precondition(fm.fileExists(atPath: root.path))
let missing = try results([video.absoluteString, poster.absoluteString, pose.absoluteString])
precondition(missing.allSatisfy { $0["status"] as? String == "missing" })
let subdirectory = root.appendingPathComponent("nested", isDirectory: true)
try fm.createDirectory(at: subdirectory, withIntermediateDirectories: true)
try put(subdirectory.appendingPathComponent("keep.mov"))
let link = root.appendingPathComponent("escape.mov")
let internalLink = root.appendingPathComponent("other-link.mov")
try fm.createSymbolicLink(at: link, withDestinationURL: outsideVideo)
try fm.createSymbolicLink(at: internalLink, withDestinationURL: otherOwner)
let rootUri = root.absoluteString.hasSuffix("/") ? root.absoluteString : root.absoluteString + "/"
let invalid = [
  root.absoluteString,
  String(rootUri.dropLast()),
  subdirectory.absoluteString,
  rootUri + "nested/keep.mov",
  rootUri + "../other-owner.mov",
  rootUri + "%2e%2e/other-owner.mov",
  rootUri + "%2E/other-owner.mov",
  rootUri + "%2Fother-owner.mov",
  rootUri + "other-owner.mov/",
  rootUri + "/other-owner.mov",
  rootUri + "other-owner.mov?token=synthetic-secret",
  rootUri + "other-owner.mov#fragment",
  rootUri + "%00other-owner.mov",
  rootUri + "%5cother-owner.mov",
  rootUri + "bad%zz.mov",
  otherOwner.path,
  "https://example.invalid/other-owner.mov",
  "file://example.invalid" + otherOwner.path,
  "file://user@localhost" + otherOwner.path,
  outsideVideo.absoluteString,
  root.deletingLastPathComponent().appendingPathComponent("Captures-extra/other-owner.mov").absoluteString,
  link.absoluteString,
  internalLink.absoluteString,
]
let refused = try results(invalid)
precondition(refused.count == invalid.count)
precondition(refused.allSatisfy { $0["status"] as? String == "rejected" })
precondition(refused.allSatisfy { Set($0.keys) == Set(["index", "status", "code"]) })
precondition(fm.fileExists(atPath: otherOwner.path))
precondition(fm.fileExists(atPath: outsideVideo.path))
precondition(fm.fileExists(atPath: subdirectory.appendingPathComponent("keep.mov").path))
let limited = try results(Array(repeating: video.absoluteString, count: 128))
precondition(limited.count == 128)
do {
  _ = try results(Array(repeating: video.absoluteString, count: 129))
  preconditionFailure("oversized batch accepted")
} catch CaptureMediaCleanup.Failure.invalidBatch {}
let locked = root.appendingPathComponent("locked.mov")
try put(locked)
try fm.setAttributes([.posixPermissions: 0o500], ofItemAtPath: root.path)
let denied = try results([locked.absoluteString])
try fm.setAttributes([.posixPermissions: 0o700], ofItemAtPath: root.path)
precondition(denied[0]["status"] as? String == "failed")
precondition(fm.fileExists(atPath: locked.path))
let movedRoot = support.appendingPathComponent("moved-captures", isDirectory: true)
try fm.moveItem(at: root, to: movedRoot)
try fm.createSymbolicLink(at: root, withDestinationURL: outside)
do {
  _ = try results([video.absoluteString])
  preconditionFailure("symlink root accepted")
} catch CaptureMediaCleanup.Failure.unavailable {}
precondition(fm.fileExists(atPath: outsideVideo.path))
let emptySupport = sandbox.appendingPathComponent("empty/Library/Application Support", isDirectory: true)
try fm.createDirectory(at: emptySupport, withIntermediateDirectories: true)
let absent = emptySupport.appendingPathComponent("PickleSensei/Captures/absent.mov")
let absentResult = try CaptureMediaCleanup.deleteFiles([absent.absoluteString], applicationSupportDirectory: emptySupport)
precondition(absentResult[0]["status"] as? String == "missing")
let parentLinkSupport = sandbox.appendingPathComponent("parent-link/Library/Application Support", isDirectory: true)
try fm.createDirectory(at: parentLinkSupport, withIntermediateDirectories: true)
try fm.createSymbolicLink(at: parentLinkSupport.appendingPathComponent("PickleSensei"), withDestinationURL: sandbox.appendingPathComponent("outside"))
do {
  _ = try CaptureMediaCleanup.deleteFiles([parentLinkSupport.appendingPathComponent("PickleSensei/Captures/owned.mov").absoluteString], applicationSupportDirectory: parentLinkSupport)
  preconditionFailure("symlink parent accepted")
} catch CaptureMediaCleanup.Failure.unavailable {}
precondition(fm.fileExists(atPath: outsideVideo.path))
print("capture-cleanup-fixtures-passed")
`;
    const output = execFileSync('xcrun', ['swift', '-'], {
      input: `import Foundation\nimport Darwin\n${implementation}\n${fixtures}`,
      encoding: 'utf8',
      timeout: 60000,
    });
    expect(output.trim()).toBe('capture-cleanup-fixtures-passed');
  },
  70000,
);
