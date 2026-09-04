/**
 * ADVERSARIAL PASS 3 — mobile-ios-config — S2
 *
 * Attack: drive the JS half of the imported-video pipeline with a simulated
 * native bridge whose `importVideo` returns (a) a 61 s clip and (b) a 0 s
 * clip, then exercise the pose-extraction rejection path with the native
 * `camera.import_too_long` contract code.
 *
 * Expectations under test
 *  - 61 s: the extraction failure surfaced to the user is the "trim" guidance
 *    (mapped from `camera.import_too_long`, PickleVideoCapture.swift:248-254).
 *  - 0 s: rejected as EMPTY/INVALID media by a distinct error, never mistaken
 *    for the too-long case.
 *  - static pin of the Swift boundary (Linux can read the file, not run it):
 *    constant 60.0, `<=` comparison, `> 0` empty guard, distinct codes and
 *    the literal "under 60 seconds" copy.
 *
 * Extra edges: exact boundary (60000 / 60001 ms), negative, NaN, Infinity,
 * string, huge and unicode-polluted durations; rapid interleaved imports;
 * a cancelled import mid-flight; native rejection with no `code`.
 *
 * Read-only: no production file is touched.
 */
// The mobile tsconfig has no Node types (matches flow-app-store-compliance-ios-config).
declare const require: (id: string) => unknown;
declare const __dirname: string;
type Fs = {
  readFileSync: (p: string, encoding: 'utf8') => string;
  readdirSync: (p: string) => string[];
  existsSync: (p: string) => boolean;
  statSync: (p: string) => {
    isDirectory(): boolean;
    isFile(): boolean;
    size: number;
  };
};
type Path = {
  join: (...parts: string[]) => string;
  resolve: (...parts: string[]) => string;
};
const fs = require('fs') as Fs;
const path = require('path') as Path;

// Only the names capture.ts / AnalyzeScreen's pure helper need — spreading the
// real RN index pulls TurboModule getters jest cannot satisfy.
jest.mock('react-native', () => {
  const bridge: Record<string, unknown> = {
    capture: jest.fn(),
    importVideo: jest.fn(),
    cancel: jest.fn(),
    addListener: jest.fn(),
    removeListeners: jest.fn(),
    extractImportedPoseSequence: jest.fn(),
  };
  return {
    Platform: { OS: 'ios' },
    NativeModules: { PickleVideoCapture: bridge },
    NativeEventEmitter: class {
      addListener() {
        return { remove: () => {} };
      }
    },
    __simulatedBridge: bridge,
  };
});

const { __simulatedBridge: mockBridge } = jest.requireMock('react-native') as {
  __simulatedBridge: {
    capture: jest.Mock;
    importVideo: jest.Mock;
    cancel: jest.Mock;
    addListener: jest.Mock;
    removeListeners: jest.Mock;
    extractImportedPoseSequence: jest.Mock;
  };
};

import {
  extractImportedPoseSequence,
  importStrokeVideo,
  type CapturedClip,
} from '../../../src/camera/capture';

const MOBILE_ROOT = path.resolve(__dirname, '../../..');
const SWIFT_PATH = path.join(
  MOBILE_ROOT,
  'ios/LocalPods/PickleNative/Sources/PickleVideoCapture.swift',
);

function importedPayload(durationMs: unknown): Record<string, unknown> {
  return {
    uri: 'file:///private/var/mobile/Containers/Data/Application/X/Library/Application%20Support/PickleSensei/Captures/import-a.mov',
    durationMs,
    fps: 30,
    width: 1920,
    height: 1080,
    capturedAtIso: '2026-09-04T18:00:00.000Z',
    captureMode: 'imported_video',
    recognition: { status: 'unknown', reason: 'analysis_not_run' },
    ballSpeed: { status: 'unavailable', reason: 'analysis_not_run' },
  };
}

/** The exact rejection the Swift bridge emits for an over-length clip
 * (PickleVideoCapture.swift:248-254), replayed on the JS side. */
function nativeTooLongRejection(seconds: number): Error & { code: string } {
  return Object.assign(
    new Error(
      `This video is ${Math.round(seconds)} seconds long. Trim it to under 60 seconds and import it again.`,
    ),
    { code: 'camera.import_too_long' },
  );
}

/** The Swift bridge's empty-media rejection (PickleVideoCapture.swift:244-247). */
function nativeEmptyMediaRejection(): Error & { code: string } {
  return Object.assign(new Error('The video duration could not be read.'), {
    code: 'camera.invalid_media',
  });
}

const INVALID_CLIP_MESSAGE =
  'The native camera returned an invalid or incomplete video result.';

beforeEach(() => {
  jest.clearAllMocks();
});

describe('S2 — 61 s import (attack)', () => {
  it('JS import boundary ACCEPTS a 61 s clip: the 60 s cap is enforced only by native extraction', async () => {
    mockBridge.importVideo.mockResolvedValue(importedPayload(61_000));
    const clip = await importStrokeVideo();
    expect(clip.captureMode).toBe('imported_video');
    expect(clip.durationMs).toBe(61_000);
  });

  it('native import_too_long rejection surfaces trim guidance and keeps its contract code', async () => {
    mockBridge.importVideo.mockResolvedValue(importedPayload(61_000));
    const clip = (await importStrokeVideo()) as Extract<
      CapturedClip,
      { captureMode: 'imported_video' }
    >;
    mockBridge.extractImportedPoseSequence.mockRejectedValue(
      nativeTooLongRejection(61),
    );
    let caught: unknown;
    try {
      await extractImportedPoseSequence(clip, null);
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: 'camera.import_too_long' });
    expect((caught as Error).message).toContain(
      'Trim it to under 60 seconds and import it again.',
    );
    // Screen-level copy mapping is pinned in s2b (needs the real RN module).
  });

  it('the native too-long rejection is DISTINCT from the native empty-media rejection', () => {
    const tooLong = nativeTooLongRejection(61);
    const empty = nativeEmptyMediaRejection();
    expect(tooLong.code).not.toBe(empty.code);
    expect(empty.message).not.toMatch(/too long|Trim/i);
    expect(tooLong.message).not.toMatch(/could not be read/i);
  });
});

describe('S2 — 0 s import (attack)', () => {
  it('a 0 s payload is rejected at the JS import boundary with the invalid-clip error', async () => {
    mockBridge.importVideo.mockResolvedValue(importedPayload(0));
    await expect(importStrokeVideo()).rejects.toThrow(INVALID_CLIP_MESSAGE);
  });

  it('the JS invalid-clip error never reads as the too-long guidance', async () => {
    mockBridge.importVideo.mockResolvedValue(importedPayload(0));
    let caught: unknown;
    try {
      await importStrokeVideo();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).not.toMatch(/too long|Trim|60 seconds/i);
    expect((caught as { code?: unknown }).code).toBeUndefined();
  });

  it.each([
    [-1],
    [-61_000],
    [Number.NaN],
    [Number.POSITIVE_INFINITY],
    [Number.NEGATIVE_INFINITY],
    ['61000'],
    ['0'],
    [null],
    [undefined],
    [true],
    [{ valueOf: () => 61_000 }],
    ['６１０００'], // fullwidth digits
  ])(
    'non-positive / non-numeric durationMs %p is rejected as invalid media',
    async duration => {
      mockBridge.importVideo.mockResolvedValue(importedPayload(duration));
      await expect(importStrokeVideo()).rejects.toThrow(INVALID_CLIP_MESSAGE);
    },
  );

  it.each([
    [1],
    [60_000],
    [60_001],
    [61_000],
    [3_600_000],
    [Number.MAX_SAFE_INTEGER],
  ])(
    'positive finite durationMs %p passes the JS import boundary (the cap lives in native)',
    async duration => {
      mockBridge.importVideo.mockResolvedValue(importedPayload(duration));
      const clip = await importStrokeVideo();
      expect(clip.durationMs).toBe(duration);
    },
  );
});

describe('S2 — interleavings, cancellation, corrupt rejections', () => {
  it('rapid interleaved imports keep each result bound to its own promise (seed 0xbeef)', async () => {
    let seed = 0xbeef;
    const next = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed;
    };
    const durations = Array.from(
      { length: 25 },
      () => [0, 61_000, 60_000, 4_200][next() % 4]!,
    );
    mockBridge.importVideo.mockImplementation(() => {
      const d = durations.shift();
      return new Promise(resolve =>
        setTimeout(() => resolve(importedPayload(d)), next() % 5),
      );
    });
    const expected = [...durations];
    const settled = await Promise.allSettled(
      expected.map(() => importStrokeVideo()),
    );
    settled.forEach((result, i) => {
      if (expected[i] === 0) {
        expect(result.status).toBe('rejected');
        expect((result as PromiseRejectedResult).reason.message).toBe(
          INVALID_CLIP_MESSAGE,
        );
      } else {
        expect(result.status).toBe('fulfilled');
        expect(
          (result as PromiseFulfilledResult<CapturedClip>).value.durationMs,
        ).toBe(expected[i]);
      }
    });
  });

  it('a cancelled import mid-flight rejects with the native cancel code, not a media error', async () => {
    mockBridge.importVideo.mockRejectedValue(
      Object.assign(new Error('Video import was canceled.'), {
        code: 'camera.cancelled',
      }),
    );
    let caught: unknown;
    try {
      await importStrokeVideo();
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: 'camera.cancelled' });
    // AnalyzeScreen's `run` treats any message containing "cancel" as a user
    // cancel (not a startup failure); the contract message must keep it.
    expect((caught as Error).message.toLowerCase()).toContain('cancel');
  });

  it('extraction passes a code-less native rejection through untouched (no invented cause)', async () => {
    mockBridge.importVideo.mockResolvedValue(importedPayload(61_000));
    const clip = (await importStrokeVideo()) as Extract<
      CapturedClip,
      { captureMode: 'imported_video' }
    >;
    const noCode = new Error(
      'This video is 61 seconds long. Trim it to under 60 seconds and import it again.',
    );
    mockBridge.extractImportedPoseSequence.mockRejectedValue(noCode);
    await expect(extractImportedPoseSequence(clip, null)).rejects.toBe(noCode);
  });
});

describe('S2 — static pin of the native boundary (Linux reads the file; Mac runs it)', () => {
  const swift = fs.readFileSync(SWIFT_PATH, 'utf8');
  const lines = swift.split('\n');
  const lineOf = (needle: string) =>
    lines.findIndex(line => line.includes(needle)) + 1;

  it('the cap is exactly 60.0 s, compared with <= (60.000 s passes, 60.001 s fails)', () => {
    expect(swift).toMatch(
      /private static let importedPoseMaxDurationSeconds = 60\.0\b/,
    );
    expect(swift).toMatch(
      /guard durationSeconds <= Self\.importedPoseMaxDurationSeconds else \{/,
    );
    const tooLongLine = lineOf('"camera.import_too_long",');
    expect(tooLongLine).toBeGreaterThan(240);
    expect(tooLongLine).toBeLessThan(260);
  });

  it('empty / unreadable media is a DISTINCT code from too-long and is checked first', () => {
    const emptyGuard = lineOf(
      'guard durationSeconds.isFinite, durationSeconds > 0 else {',
    );
    const tooLongGuard = lineOf(
      'guard durationSeconds <= Self.importedPoseMaxDurationSeconds else {',
    );
    expect(emptyGuard).toBeGreaterThan(0);
    expect(emptyGuard).toBeLessThan(tooLongGuard);
    expect(lines[emptyGuard]).toContain('"camera.invalid_media"');
    expect(lines[emptyGuard]).toContain(
      'The video duration could not be read.',
    );
  });

  it('the native too-long copy tells the user to trim to under 60 seconds', () => {
    expect(swift).toContain('Trim it to under 60 seconds and import it again.');
  });

  it('the import step itself (importVideo → ClipMediaStore.importedPayload) enforces NO duration cap — over-length files are copied into private storage before the cap is checked', () => {
    const importFn = swift.slice(
      swift.indexOf('@objc func importVideo('),
      swift.indexOf('@objc func readTextFile('),
    );
    const pickerDelegate = swift.slice(
      swift.indexOf('func picker(_ picker: PHPickerViewController'),
      swift.indexOf('private func begin('),
    );
    expect(importFn).not.toMatch(
      /importedPoseMaxDurationSeconds|import_too_long/,
    );
    expect(pickerDelegate).not.toMatch(
      /importedPoseMaxDurationSeconds|import_too_long/,
    );
    const store = fs.readFileSync(
      path.join(
        MOBILE_ROOT,
        'ios/LocalPods/PickleNative/Sources/ClipMediaStore.swift',
      ),
      'utf8',
    );
    expect(store).not.toMatch(/60\.0|import_too_long|MaxDuration/);
    // and the too-long failure path removes nothing it just persisted
    const extraction = swift.slice(
      swift.indexOf('@objc func extractImportedPoseSequence('),
      swift.indexOf('@objc func setCompletionStrategy('),
    );
    const failClosure = extraction.slice(
      extraction.indexOf('let fail: (String, String, Error?) -> Void'),
      extraction.indexOf('let asset = AVURLAsset(url: videoURL)'),
    );
    expect(failClosure).not.toMatch(/removeItem|removeIfPresent/);
  });
});
