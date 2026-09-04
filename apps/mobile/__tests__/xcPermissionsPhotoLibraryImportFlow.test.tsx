/**
 * xc-journey-notifications-permissions — PHOTO LIBRARY (video import) journey.
 *
 * The import path uses PHPickerViewController (INFERRED from
 * apps/mobile/ios/LocalPods/PickleNative/Sources/PickleVideoCapture.swift):
 * the system picker never raises a photo-library permission prompt, so the
 * iOS "Limited Photos" state cannot dead-end the player — the picker itself
 * is the permission UI. What CAN reach JS from the native side is:
 *   - `camera.cancelled`            "Video import was canceled."
 *   - `camera.presentation_failed`  "The video library could not be opened."
 *   - `camera.invalid_media`        "The selected item is not a supported video."
 *   - copy failure (ClipMediaStore) → arbitrary native error message
 *   - missing native bridge (JS guard) "Real video import is not available on
 *     this device."
 * This suite drives the REAL AnalyzeScreen with source='library' through every
 * one of these, checks the surface + recovery controls, then runs a seeded
 * fuzz over outcome × control sequences with a dead-end invariant. Real
 * PHPicker execution (and the Limited Photos UI) is BLOCKED_EXTERNAL from
 * Linux and is NOT claimed here.
 */
jest.mock('../src/data/db', () => ({ getDb: jest.fn() }));
jest.mock('../src/data/repository', () => ({
  savePendingCapture: jest.fn(() => Promise.resolve()),
  setCaptureTargetSeed: jest.fn(() => Promise.resolve()),
  setDeclaredStroke: jest.fn(() => Promise.resolve()),
  getKv: jest.fn(() => Promise.resolve(null)),
  setKv: jest.fn(() => Promise.resolve()),
}));
jest.mock('../src/account/apiSession', () => ({
  getApiSession: jest.fn(() => null),
}));
jest.mock('../src/analysis/runCaptureAnalysis', () => ({
  runCaptureAnalysis: jest.fn(),
}));
jest.mock('react-native-safe-area-context', () => {
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  return { SafeAreaView: View };
});

const mockNavigation = {
  replace: jest.fn(),
  navigate: jest.fn(),
  goBack: jest.fn(),
  popToTop: jest.fn(),
};
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => mockNavigation,
  useRoute: () => ({ params: { source: 'library' } }),
}));

type Listener = (event: unknown) => void;
interface PendingImport {
  resolve: (clip: unknown) => void;
  reject: (error: unknown) => void;
}
const importFake: {
  listener: Listener | null;
  pending: PendingImport[];
  cancelCalls: number;
} = { listener: null, pending: [], cancelCalls: 0 };
jest.mock('../src/camera/capture', () => {
  const actual = jest.requireActual<typeof import('../src/camera/capture')>(
    '../src/camera/capture',
  );
  return {
    ...actual,
    subscribeToCameraEvents: (listener: Listener) => {
      importFake.listener = listener;
      return () => {
        importFake.listener = null;
      };
    },
    captureStrokeVideo: jest.fn(),
    importStrokeVideo: jest.fn(
      () =>
        new Promise((resolve, reject) => {
          importFake.pending.push({ resolve, reject });
        }),
    ),
    cancelCameraOperation: jest.fn(() => {
      importFake.cancelCalls += 1;
    }),
  };
});

import React from 'react';
import TestRenderer, {
  act,
  type ReactTestInstance,
  type ReactTestRenderer,
} from 'react-test-renderer';
import { AnalyzeScreen } from '../src/screens/AnalyzeScreen';
import { importStrokeVideo } from '../src/camera/capture';
import { runCaptureAnalysis } from '../src/analysis/runCaptureAnalysis';

declare const __dirname: string;
declare const process: {
  env: Record<string, string | undefined>;
  memoryUsage: () => { heapUsed: number };
};
const { mkdirSync, writeFileSync } = require('fs') as {
  mkdirSync: (path: string, options: { recursive: boolean }) => void;
  writeFileSync: (path: string, data: string) => void;
};
const { resolve: resolvePath, join: joinPath } = require('path') as {
  resolve: (...parts: string[]) => string;
  join: (...parts: string[]) => string;
};
const ARTIFACT_DIR =
  process.env['XC_PERMISSIONS_ARTIFACT_DIR'] ??
  resolvePath(
    __dirname,
    '..',
    '..',
    '..',
    'artifacts',
    'xc-journey-notifications-permissions',
  );
function writeArtifact(name: string, value: unknown): string {
  mkdirSync(ARTIFACT_DIR, { recursive: true });
  const file = joinPath(ARTIFACT_DIR, name);
  writeFileSync(file, JSON.stringify(value, null, 2));
  return file;
}

// Verbatim native/JS contract strings (INFERRED from source).
const NATIVE_IMPORT_CANCELLED = 'Video import was canceled.';
const NATIVE_PRESENTATION_FAILED = 'The video library could not be opened.';
const NATIVE_INVALID_MEDIA = 'The selected item is not a supported video.';
const NATIVE_COPY_FAILED =
  'The file couldn’t be saved because you don’t have permission.';
const JS_IMPORT_BRIDGE_MISSING =
  'Real video import is not available on this device.';

class NativeCaptureError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

const BANNED_COPY = [
  /android/i,
  /google play/i,
  /guest mode/i,
  /live court/i,
  /\bDUPR\b/,
  /swingvision/i,
  /pb vision/i,
  /\d+(\.\d+)?\s?%/,
  /\bmost accurate\b/i,
  /\bbest\b/i,
  /\b#1\b/,
  /replaces? (a|your) coach/i,
  /as good as a coach/i,
];

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** The library source auto-launches the picker after a 160ms timer. */
async function waitForAutoLaunch() {
  await act(async () => {
    await new Promise<void>(resolve => setTimeout(() => resolve(), 200));
  });
  await flush();
}

function renderedText(renderer: ReactTestRenderer): string {
  const out: string[] = [];
  const walk = (node: unknown): void => {
    if (node === null || node === undefined) return;
    if (typeof node === 'string') {
      out.push(node);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    walk((node as { children?: unknown }).children ?? null);
  };
  walk(renderer.toJSON());
  return out.join('\n');
}

function findButton(
  renderer: ReactTestRenderer,
  label: string,
): ReactTestInstance | null {
  return (
    renderer.root.findAll(
      node =>
        typeof node.props === 'object' &&
        node.props !== null &&
        (node.props as { label?: unknown }).label === label &&
        typeof (node.props as { onPress?: unknown }).onPress === 'function',
    )[0] ?? null
  );
}

function headerClose(renderer: ReactTestRenderer): (() => void) | null {
  const node = renderer.root.findAll(
    n =>
      typeof n.props === 'object' &&
      n.props !== null &&
      typeof (n.props as { onClose?: unknown }).onClose === 'function',
  )[0];
  return node ? (node.props as { onClose: () => void }).onClose : null;
}

async function press(renderer: ReactTestRenderer, label: string) {
  const button = findButton(renderer, label);
  if (!button) {
    throw new Error(
      `No button labelled "${label}" — rendered: ${renderedText(renderer)}`,
    );
  }
  await act(async () => {
    (button.props as { onPress: () => void }).onPress();
  });
  await flush();
}

type ScreenPhase = 'working' | 'error' | 'ready' | 'other';
function classifyPhase(renderer: ReactTestRenderer): ScreenPhase {
  const text = renderedText(renderer);
  if (
    text.includes('Capture interrupted') &&
    text.includes('Nothing was rated.')
  )
    return 'error';
  if (text.includes('Opening video library…')) return 'working';
  if (text.includes('Import video') || text.includes('Open Library'))
    return 'ready';
  return 'other';
}

function deadEndCheck(renderer: ReactTestRenderer): {
  phase: ScreenPhase;
  violations: string[];
} {
  const phase = classifyPhase(renderer);
  const text = renderedText(renderer);
  const violations: string[] = [];
  if (phase === 'working' && !headerClose(renderer))
    violations.push('working phase without header close');
  if (phase === 'error') {
    if (!findButton(renderer, 'Try again'))
      violations.push('error phase without "Try again"');
    if (!findButton(renderer, 'Close'))
      violations.push('error phase without "Close"');
    if (!text.includes('Nothing was rated.'))
      violations.push('error phase without "Nothing was rated."');
  }
  if (phase === 'other')
    violations.push(`unrecognised phase: ${text.slice(0, 120)}`);
  for (const rule of BANNED_COPY) {
    if (rule.test(text)) violations.push(`banned copy matched ${rule}`);
  }
  return { phase, violations };
}

async function mount(): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<AnalyzeScreen />);
  });
  await flush();
  return renderer;
}

async function unmount(renderer: ReactTestRenderer) {
  await act(async () => {
    renderer.unmount();
  });
}

async function emit(event: unknown) {
  await act(async () => {
    importFake.listener?.(event);
  });
}

async function settleLatestImport(error: Error) {
  const pending = importFake.pending.pop();
  if (!pending) throw new Error('no pending native import to settle');
  await act(async () => {
    pending.reject(error);
  });
  await flush();
}

const OUTCOMES = {
  cancelled: () =>
    new NativeCaptureError('camera.cancelled', NATIVE_IMPORT_CANCELLED),
  presentation_failed: () =>
    new NativeCaptureError(
      'camera.presentation_failed',
      NATIVE_PRESENTATION_FAILED,
    ),
  invalid_media: () =>
    new NativeCaptureError('camera.invalid_media', NATIVE_INVALID_MEDIA),
  copy_failed: () =>
    new NativeCaptureError('camera.import_failed', NATIVE_COPY_FAILED),
  bridge_missing: () => new Error(JS_IMPORT_BRIDGE_MISSING),
} as const;
type OutcomeName = keyof typeof OUTCOMES;
const OUTCOME_NAMES = Object.keys(OUTCOMES) as OutcomeName[];

beforeEach(() => {
  jest.clearAllMocks();
  importFake.listener = null;
  importFake.pending = [];
  importFake.cancelCalls = 0;
});

describe('xc photo-library import journey — every native outcome', () => {
  it('auto-launches the system picker and each negative outcome is recoverable', async () => {
    const rows: Array<{
      outcome: OutcomeName;
      message: string;
      phaseAfter: ScreenPhase;
      goBackCalls: number;
      showsNativeMessage: boolean;
      violations: string[];
    }> = [];
    for (const outcome of OUTCOME_NAMES) {
      mockNavigation.goBack.mockClear();
      const renderer = await mount();
      await waitForAutoLaunch();
      expect(classifyPhase(renderer)).toBe('working');
      expect(importStrokeVideo).toHaveBeenCalledTimes(rows.length + 1);
      expect(renderedText(renderer)).toContain(
        'The selected file is copied into protected app storage',
      );
      await emit({ type: 'import', state: 'selecting', captureId: 'imp-1' });
      expect(renderedText(renderer)).toContain('Choose one video…');
      const error = OUTCOMES[outcome]();
      await settleLatestImport(error);
      const check = deadEndCheck(renderer);
      const text = renderedText(renderer);
      if (outcome === 'cancelled') {
        // Picker dismissed by the player → the screen leaves; no error copy.
        expect(mockNavigation.goBack).toHaveBeenCalledTimes(1);
        expect(text).not.toContain('Capture interrupted');
      } else {
        expect(check.phase).toBe('error');
        expect(text).toContain(error.message);
        expect(mockNavigation.goBack).not.toHaveBeenCalled();
      }
      expect(check.violations).toEqual([]);
      expect(runCaptureAnalysis).not.toHaveBeenCalled();
      rows.push({
        outcome,
        message: error.message,
        phaseAfter: check.phase,
        goBackCalls: mockNavigation.goBack.mock.calls.length,
        showsNativeMessage: text.includes(error.message),
        violations: check.violations,
      });
      await unmount(renderer);
    }
    writeArtifact('photo-library-outcome-table.json', {
      generatedAt: new Date().toISOString(),
      note: 'PHPicker never prompts for photo-library permission (system picker); Limited Photos cannot dead-end. Real picker execution BLOCKED_EXTERNAL (Apple runtime).',
      rows,
    });
  });

  it('Try again after "could not be opened" re-launches the picker once per tap; Close exits', async () => {
    const renderer = await mount();
    await waitForAutoLaunch();
    const trace: string[] = [];
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await settleLatestImport(OUTCOMES.presentation_failed());
      expect(classifyPhase(renderer)).toBe('error');
      expect(renderedText(renderer)).toContain(NATIVE_PRESENTATION_FAILED);
      trace.push(`attempt ${attempt}: presentation_failed → error surface`);
      await press(renderer, 'Try again');
      expect(importStrokeVideo).toHaveBeenCalledTimes(attempt + 1);
      expect(classifyPhase(renderer)).toBe('working');
      trace.push(`Try again → import #${attempt + 1} pending`);
    }
    await settleLatestImport(OUTCOMES.invalid_media());
    expect(renderedText(renderer)).toContain(NATIVE_INVALID_MEDIA);
    await press(renderer, 'Close');
    expect(mockNavigation.goBack).toHaveBeenCalledTimes(1);
    trace.push('invalid_media → Close → goBack');
    writeArtifact('photo-library-retry-trace.json', {
      generatedAt: new Date().toISOString(),
      trace,
      importCalls: (importStrokeVideo as jest.Mock).mock.calls.length,
    });
    await unmount(renderer);
  });

  it('header Close while the picker is up cancels the native operation and leaves', async () => {
    const renderer = await mount();
    await waitForAutoLaunch();
    const close = headerClose(renderer);
    expect(close).not.toBeNull();
    await act(async () => {
      close!();
    });
    await flush();
    expect(importFake.cancelCalls).toBe(1);
    expect(mockNavigation.goBack).toHaveBeenCalledTimes(1);
    // Native then reports the cancel; nothing throws, no error surface.
    await settleLatestImport(OUTCOMES.cancelled());
    expect(renderedText(renderer)).not.toContain('Capture interrupted');
    await unmount(renderer);
  });

  it('unmount while the picker is pending cancels exactly once; late rejection is harmless', async () => {
    const renderer = await mount();
    await waitForAutoLaunch();
    await unmount(renderer);
    expect(importFake.cancelCalls).toBe(1);
    const pending = importFake.pending.pop()!;
    await act(async () => {
      pending.reject(OUTCOMES.copy_failed());
    });
    await flush();
    expect(runCaptureAnalysis).not.toHaveBeenCalled();
  });

  it('seeded fuzz: random outcome/control sequences never dead-end (replayable)', async () => {
    const replaySeed = process.env['XC_PERMISSIONS_REPLAY_SEED'];
    const caseCount = replaySeed
      ? 1
      : Number(process.env['XC_PERMISSIONS_PHOTO_FUZZ_CASES'] ?? 80);
    const seedBase = 0x1b_1b_ca_5e;
    const heapBefore = process.memoryUsage().heapUsed;
    const cases: Array<{
      seed: number;
      steps: string[];
      failed: boolean;
      violations: string[];
      replay: string;
    }> = [];
    for (let i = 0; i < caseCount; i += 1) {
      const seed = replaySeed ? Number(replaySeed) : seedBase + i;
      let state = seed >>> 0;
      const rand = () => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return state / 0x1_0000_0000;
      };
      mockNavigation.goBack.mockClear();
      const steps: string[] = [];
      const violations: string[] = [];
      const renderer = await mount();
      await waitForAutoLaunch();
      let left = false;
      const stepCount = 2 + Math.floor(rand() * 8);
      for (let s = 0; s < stepCount && !left; s += 1) {
        const phase = classifyPhase(renderer);
        if (phase === 'working') {
          const roll = rand();
          if (roll < 0.15) {
            steps.push('headerClose');
            const close = headerClose(renderer);
            if (!close) {
              violations.push('working phase without header close');
              break;
            }
            await act(async () => {
              close();
            });
            await flush();
            left = true;
          } else {
            const outcome =
              OUTCOME_NAMES[Math.floor(rand() * OUTCOME_NAMES.length)]!;
            steps.push(`settle:${outcome}`);
            if (importFake.pending.length === 0) {
              violations.push('working phase without a pending native import');
              break;
            }
            await settleLatestImport(OUTCOMES[outcome]());
            if (outcome === 'cancelled') left = true;
          }
        } else if (phase === 'error') {
          if (rand() < 0.6) {
            steps.push('Try again');
            await press(renderer, 'Try again');
          } else {
            steps.push('Close');
            await press(renderer, 'Close');
            left = true;
          }
        } else {
          violations.push(`unexpected phase ${phase}`);
          break;
        }
        const check = deadEndCheck(renderer);
        if (!left) violations.push(...check.violations);
      }
      if (left && mockNavigation.goBack.mock.calls.length === 0) {
        violations.push('left the flow without navigation.goBack');
      }
      await unmount(renderer);
      // Every exit path settles any outstanding native import.
      while (importFake.pending.length) {
        await settleLatestImport(OUTCOMES.cancelled());
      }
      cases.push({
        seed,
        steps,
        failed: violations.length > 0,
        violations,
        replay: `XC_PERMISSIONS_REPLAY_SEED=${seed} npx jest --ci __tests__/xcPermissionsPhotoLibraryImportFlow.test.tsx -t "seeded fuzz"`,
      });
    }
    const failing = cases.filter(c => c.failed);
    writeArtifact('photo-library-fuzz.json', {
      generatedAt: new Date().toISOString(),
      seedBase,
      caseCount: cases.length,
      totalSteps: cases.reduce((n, c) => n + c.steps.length, 0),
      failingCases: failing.length,
      heapUsedBeforeBytes: heapBefore,
      heapUsedAfterBytes: process.memoryUsage().heapUsed,
      cases,
    });
    if (failing.length)
      writeArtifact('photo-library-fuzz-failures.json', failing);
    expect(failing).toEqual([]);
  });
});
