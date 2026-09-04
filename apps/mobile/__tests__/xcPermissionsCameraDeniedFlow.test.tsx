/**
 * xc-journey-notifications-permissions — CAMERA permission journey harness.
 *
 * Native camera execution is BLOCKED_EXTERNAL from Linux; this suite drives
 * the REAL AnalyzeScreen through every outcome the native bridge can report
 * into JS for the guided-capture (camera) source and asserts that no outcome
 * dead-ends the player:
 *   - `camera.permission_denied`  (AVAuthorizationStatus .denied/.restricted,
 *     or the user tapping "Don't Allow" on the first prompt) → typed error
 *     surface with the exact Settings copy, Try again + Close.
 *   - `camera.configuration_failed` → same surface, native message verbatim.
 *   - missing native bridge (JS-side guard) → same surface.
 *   - user cancel → back to the ready landing, no error surface.
 *   - the permission event stream (`requesting` → `granted` | `denied`) while
 *     the capture promise is pending → never crashes the working state.
 *   - Try again after a still-denied permission (iOS never re-prompts) → the
 *     error surface is shown again, one native call per tap, Close still
 *     works.
 *   - seeded fuzz over random outcome/control sequences with a per-step
 *     dead-end invariant; every failing seed is replayable.
 *
 * Artifacts: $XC_PERMISSIONS_ARTIFACT_DIR (default
 * <repo>/artifacts/xc-journey-notifications-permissions).
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
  useRoute: () => ({ params: { source: 'camera' } }),
}));

// The camera bridge is a controllable fake: the test owns the event stream
// and the outcome of every `capture()` call, exactly like the native layer.
type Listener = (event: unknown) => void;
interface PendingCapture {
  resolve: (clip: unknown) => void;
  reject: (error: unknown) => void;
}
const cameraFake: {
  listener: Listener | null;
  pending: PendingCapture[];
  cancelCalls: number;
} = { listener: null, pending: [], cancelCalls: 0 };
jest.mock('../src/camera/capture', () => {
  const actual = jest.requireActual<typeof import('../src/camera/capture')>(
    '../src/camera/capture',
  );
  return {
    ...actual,
    subscribeToCameraEvents: (listener: Listener) => {
      cameraFake.listener = listener;
      return () => {
        cameraFake.listener = null;
      };
    },
    captureStrokeVideo: jest.fn(
      () =>
        new Promise((resolve, reject) => {
          cameraFake.pending.push({ resolve, reject });
        }),
    ),
    importStrokeVideo: jest.fn(),
    cancelCameraOperation: jest.fn(() => {
      cameraFake.cancelCalls += 1;
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
import { captureStrokeVideo } from '../src/camera/capture';
import { runCaptureAnalysis } from '../src/analysis/runCaptureAnalysis';

// ---------------------------------------------------------------------------
// Artifact plumbing (typed local node globals — mobile tsconfig has no node
// types; same pattern as the other filesystem-reading suites here).
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Native contract strings (verbatim from
// apps/mobile/ios/LocalPods/PickleNative/Sources/PickleVideoCapture.swift and
// apps/mobile/src/camera/capture.ts). INFERRED from source — Linux cannot
// execute the Swift side.
// ---------------------------------------------------------------------------

const NATIVE_CAMERA_DENIED_ANALYZE =
  'Allow camera access in Settings to analyze a stroke.';
const NATIVE_CAMERA_DENIED_SESSION =
  'Allow camera access in Settings to record a session.';
const JS_BRIDGE_MISSING =
  'Real guided camera capture is not available on this device.';
const NATIVE_CONFIG_FAILED =
  'The operation couldn’t be completed. (AVFoundationErrorDomain error -11852.)';
const NATIVE_CANCEL = 'User cancelled guided capture.';

class NativeCaptureError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

// Copy rules from docs/APP_STORE_SUBMISSION.md + AGENTS.md: none of these
// may appear in anything the permission journeys render.
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

// ---------------------------------------------------------------------------
// Render helpers
// ---------------------------------------------------------------------------

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function renderedStrings(renderer: ReactTestRenderer): string[] {
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
    const json = node as { children?: unknown };
    walk(json.children ?? null);
  };
  walk(renderer.toJSON());
  return out;
}

function renderedText(renderer: ReactTestRenderer): string {
  return renderedStrings(renderer).join('\n');
}

/** Every `Button` (design/components) and every pressable with a label. */
function pressables(renderer: ReactTestRenderer): ReactTestInstance[] {
  return renderer.root.findAll(
    node =>
      typeof node.props === 'object' &&
      node.props !== null &&
      typeof (node.props as { onPress?: unknown }).onPress === 'function' &&
      (typeof (node.props as { label?: unknown }).label === 'string' ||
        typeof (node.props as { accessibilityLabel?: unknown })
          .accessibilityLabel === 'string' ||
        typeof (node.props as { accessibilityRole?: unknown })
          .accessibilityRole === 'string'),
  );
}

function findButton(
  renderer: ReactTestRenderer,
  label: string,
): ReactTestInstance | null {
  const matches = renderer.root.findAll(
    node =>
      typeof node.props === 'object' &&
      node.props !== null &&
      (node.props as { label?: unknown }).label === label &&
      typeof (node.props as { onPress?: unknown }).onPress === 'function',
  );
  // The design `Button` wraps a pressable; the outermost match is the
  // component itself (its onPress is the caller's handler).
  return matches[0] ?? null;
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

type ScreenPhase = 'ready' | 'working' | 'error' | 'other';

function classifyPhase(renderer: ReactTestRenderer): ScreenPhase {
  const text = renderedText(renderer);
  if (
    text.includes('Capture interrupted') &&
    text.includes('Nothing was rated.')
  )
    return 'error';
  if (text.includes('Opening camera…')) return 'working';
  if (text.includes('Open automatic camera')) return 'ready';
  return 'other';
}

interface DeadEndCheck {
  phase: ScreenPhase;
  actionableControls: number;
  hasClose: boolean;
  violations: string[];
}

/**
 * "Never dead-end" invariant: whatever the phase, the player must have at
 * least one actionable control, and every negative phase must offer an exit
 * (Close / header close) PLUS a retry. Copy must stay within the dossier.
 */
function deadEndCheck(renderer: ReactTestRenderer): DeadEndCheck {
  const phase = classifyPhase(renderer);
  const controls = pressables(renderer);
  const text = renderedText(renderer);
  const violations: string[] = [];
  const hasClose =
    findButton(renderer, 'Close') !== null ||
    renderer.root.findAll(
      node =>
        typeof node.props === 'object' &&
        node.props !== null &&
        typeof (node.props as { onClose?: unknown }).onClose === 'function',
    ).length > 0;
  if (controls.length === 0) violations.push('no actionable control rendered');
  if (!hasClose) violations.push('no Close/onClose exit rendered');
  if (phase === 'error') {
    if (!findButton(renderer, 'Try again'))
      violations.push('error phase without "Try again"');
    if (!findButton(renderer, 'Close'))
      violations.push('error phase without "Close"');
  }
  if (phase === 'other') violations.push('unrecognised phase rendered');
  for (const rule of BANNED_COPY) {
    if (rule.test(text)) violations.push(`banned copy matched ${rule}`);
  }
  return { phase, actionableControls: controls.length, hasClose, violations };
}

async function mountCameraScreen(): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<AnalyzeScreen />);
  });
  await flush();
  return renderer;
}

async function settleLatestCapture(
  outcome: { kind: 'reject'; error: Error } | { kind: 'cancel' },
) {
  const pending = cameraFake.pending.pop();
  if (!pending) throw new Error('no pending native capture to settle');
  await act(async () => {
    pending.reject(
      outcome.kind === 'cancel'
        ? new NativeCaptureError('camera.cancelled', NATIVE_CANCEL)
        : outcome.error,
    );
  });
  await flush();
}

async function emitPermission(state: 'requesting' | 'granted' | 'denied') {
  await act(async () => {
    cameraFake.listener?.({
      type: 'permission',
      state,
      emittedAtIso: '2026-09-04T05:00:00.000Z',
    });
  });
}

// ---------------------------------------------------------------------------
// Deterministic PRNG (mulberry32) for the fuzz section
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

interface OutcomeRow {
  outcome: string;
  errorCode: string | null;
  message: string;
  phaseAfter: ScreenPhase;
  header: string | null;
  showsNothingRated: boolean;
  showsMessageVerbatim: boolean;
  tryAgain: boolean;
  close: boolean;
  goBackCalls: number;
  nativeCalls: number;
  analysisCalls: number;
  deadEnd: DeadEndCheck;
}

const NEGATIVE_OUTCOMES: Array<{
  outcome: string;
  error: Error;
  expectSurface: boolean;
}> = [
  {
    outcome:
      'permission_denied (AVAuthorizationStatus.denied / first-prompt Don’t Allow)',
    error: new NativeCaptureError(
      'camera.permission_denied',
      NATIVE_CAMERA_DENIED_ANALYZE,
    ),
    expectSurface: true,
  },
  {
    outcome:
      'permission_restricted (AVAuthorizationStatus.restricted → same native branch)',
    error: new NativeCaptureError(
      'camera.permission_denied',
      NATIVE_CAMERA_DENIED_ANALYZE,
    ),
    expectSurface: true,
  },
  {
    outcome: 'configuration_failed (AVFoundation error, camera granted)',
    error: new NativeCaptureError(
      'camera.configuration_failed',
      NATIVE_CONFIG_FAILED,
    ),
    expectSurface: true,
  },
  {
    outcome: 'bridge_missing (JS guard in captureStrokeVideo)',
    error: new Error(JS_BRIDGE_MISSING),
    expectSurface: true,
  },
  {
    outcome: 'user_cancel',
    error: new NativeCaptureError('camera.cancelled', NATIVE_CANCEL),
    expectSurface: false,
  },
];

describe('xc camera permission journey — AnalyzeScreen guided capture', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    cameraFake.listener = null;
    cameraFake.pending = [];
    cameraFake.cancelCalls = 0;
  });

  it('every native capture outcome lands on a recoverable surface (outcome table)', async () => {
    const rows: OutcomeRow[] = [];
    for (const { outcome, error, expectSurface } of NEGATIVE_OUTCOMES) {
      jest.clearAllMocks();
      const renderer = await mountCameraScreen();
      expect(classifyPhase(renderer)).toBe('ready');

      await press(renderer, 'Open automatic camera');
      expect(classifyPhase(renderer)).toBe('working');
      expect(cameraFake.pending).toHaveLength(1);

      // Native always emits `requesting` before resolving the permission.
      await emitPermission('requesting');
      expect(classifyPhase(renderer)).toBe('working');
      if (
        error instanceof NativeCaptureError &&
        error.code === 'camera.permission_denied'
      ) {
        await emitPermission('denied');
      } else if (error.message !== JS_BRIDGE_MISSING) {
        await emitPermission('granted');
      }
      expect(classifyPhase(renderer)).toBe('working');

      await settleLatestCapture({ kind: 'reject', error });
      const text = renderedText(renderer);
      const phaseAfter = classifyPhase(renderer);
      const check = deadEndCheck(renderer);
      rows.push({
        outcome,
        errorCode: error instanceof NativeCaptureError ? error.code : null,
        message: error.message,
        phaseAfter,
        header: text.includes('Capture interrupted')
          ? 'Capture interrupted'
          : text.includes('Auto Analyze')
            ? 'Auto Analyze'
            : null,
        showsNothingRated: text.includes('Nothing was rated.'),
        showsMessageVerbatim: text.includes(error.message),
        tryAgain: findButton(renderer, 'Try again') !== null,
        close: findButton(renderer, 'Close') !== null,
        goBackCalls: mockNavigation.goBack.mock.calls.length,
        nativeCalls: (captureStrokeVideo as jest.Mock).mock.calls.length,
        analysisCalls: (runCaptureAnalysis as jest.Mock).mock.calls.length,
        deadEnd: check,
      });

      if (expectSurface) {
        expect(phaseAfter).toBe('error');
        expect(text).toContain('Capture interrupted');
        expect(text).toContain('Nothing was rated.');
        expect(text).toContain(error.message);
        expect(findButton(renderer, 'Try again')).not.toBeNull();
        expect(findButton(renderer, 'Close')).not.toBeNull();
      } else {
        // Cancel is not a failure: straight back to the landing, no goBack
        // for the camera source, no error surface.
        expect(phaseAfter).toBe('ready');
        expect(text).not.toContain('Nothing was rated.');
        expect(mockNavigation.goBack).not.toHaveBeenCalled();
      }
      expect(check.violations).toEqual([]);
      expect(runCaptureAnalysis).not.toHaveBeenCalled();

      await act(async () => {
        renderer.unmount();
      });
    }
    const file = writeArtifact('camera-outcome-table.json', {
      generatedAt: new Date().toISOString(),
      source: 'camera',
      rows,
    });
    expect(file).toContain('camera-outcome-table.json');
  });

  it('denied → Try again while still denied re-runs ONE native call per tap and never strands the player; Close exits', async () => {
    const renderer = await mountCameraScreen();
    const trace: string[] = [];

    await press(renderer, 'Open automatic camera');
    trace.push(`tap:Open automatic camera → ${classifyPhase(renderer)}`);
    await emitPermission('requesting');
    await emitPermission('denied');
    await settleLatestCapture({
      kind: 'reject',
      error: new NativeCaptureError(
        'camera.permission_denied',
        NATIVE_CAMERA_DENIED_ANALYZE,
      ),
    });
    trace.push(`native:permission_denied → ${classifyPhase(renderer)}`);
    expect(classifyPhase(renderer)).toBe('error');
    expect(captureStrokeVideo).toHaveBeenCalledTimes(1);

    // iOS never re-prompts once denied: the second attempt fails the same way.
    for (let attempt = 2; attempt <= 4; attempt += 1) {
      await press(renderer, 'Try again');
      trace.push(`tap:Try again#${attempt} → ${classifyPhase(renderer)}`);
      expect(classifyPhase(renderer)).toBe('working');
      expect(captureStrokeVideo).toHaveBeenCalledTimes(attempt);
      expect(cameraFake.pending).toHaveLength(1);
      await settleLatestCapture({
        kind: 'reject',
        error: new NativeCaptureError(
          'camera.permission_denied',
          NATIVE_CAMERA_DENIED_ANALYZE,
        ),
      });
      trace.push(
        `native:permission_denied#${attempt} → ${classifyPhase(renderer)}`,
      );
      expect(classifyPhase(renderer)).toBe('error');
      expect(renderedText(renderer)).toContain(NATIVE_CAMERA_DENIED_ANALYZE);
      expect(deadEndCheck(renderer).violations).toEqual([]);
    }

    // Double-tap Try again while the camera is opening → exactly one call.
    await press(renderer, 'Try again');
    const before = (captureStrokeVideo as jest.Mock).mock.calls.length;
    const tryAgainWhileWorking = findButton(renderer, 'Try again');
    expect(tryAgainWhileWorking).toBeNull(); // working phase has no Try again
    expect((captureStrokeVideo as jest.Mock).mock.calls.length).toBe(before);
    await settleLatestCapture({ kind: 'cancel' });
    trace.push(`native:cancel → ${classifyPhase(renderer)}`);
    expect(classifyPhase(renderer)).toBe('ready');

    // The player can always leave from the error surface.
    await press(renderer, 'Open automatic camera');
    await settleLatestCapture({
      kind: 'reject',
      error: new NativeCaptureError(
        'camera.permission_denied',
        NATIVE_CAMERA_DENIED_ANALYZE,
      ),
    });
    expect(classifyPhase(renderer)).toBe('error');
    await press(renderer, 'Close');
    trace.push(`tap:Close → goBack=${mockNavigation.goBack.mock.calls.length}`);
    expect(mockNavigation.goBack).toHaveBeenCalledTimes(1);
    expect(runCaptureAnalysis).not.toHaveBeenCalled();

    writeArtifact('camera-denied-retry-trace.json', {
      generatedAt: new Date().toISOString(),
      nativeCalls: (captureStrokeVideo as jest.Mock).mock.calls.length,
      trace,
    });
    await act(async () => {
      renderer.unmount();
    });
  });

  it('header close while the camera is opening cancels the native operation and leaves', async () => {
    const renderer = await mountCameraScreen();
    await press(renderer, 'Open automatic camera');
    expect(classifyPhase(renderer)).toBe('working');
    const header = renderer.root.findAll(
      node =>
        typeof node.props === 'object' &&
        node.props !== null &&
        typeof (node.props as { onClose?: unknown }).onClose === 'function',
    )[0];
    expect(header).toBeDefined();
    await act(async () => {
      (header!.props as { onClose: () => void }).onClose();
    });
    expect(cameraFake.cancelCalls).toBe(1);
    expect(mockNavigation.goBack).toHaveBeenCalledTimes(1);
    // The late native rejection after leaving must not throw.
    await settleLatestCapture({ kind: 'cancel' });
    await act(async () => {
      renderer.unmount();
    });
  });

  it('unmount during a pending capture cancels the native operation exactly once', async () => {
    const renderer = await mountCameraScreen();
    await press(renderer, 'Open automatic camera');
    await act(async () => {
      renderer.unmount();
    });
    expect(cameraFake.cancelCalls).toBe(1);
    await act(async () => {
      cameraFake.pending
        .pop()!
        .reject(
          new NativeCaptureError(
            'camera.permission_denied',
            NATIVE_CAMERA_DENIED_ANALYZE,
          ),
        );
    });
    await flush();
  });

  it('camera denial copy (both native strings) names Settings and obeys the dossier copy rules', () => {
    for (const copy of [
      NATIVE_CAMERA_DENIED_ANALYZE,
      NATIVE_CAMERA_DENIED_SESSION,
      JS_BRIDGE_MISSING,
    ]) {
      for (const rule of BANNED_COPY) expect(copy).not.toMatch(rule);
    }
    expect(NATIVE_CAMERA_DENIED_ANALYZE).toMatch(/Settings/);
    expect(NATIVE_CAMERA_DENIED_SESSION).toMatch(/Settings/);
  });

  it('seeded fuzz: random native outcome / control sequences never dead-end (replayable)', async () => {
    const replaySeed = process.env['XC_PERMISSIONS_REPLAY_SEED'];
    const caseCount = replaySeed
      ? 1
      : Number(process.env['XC_PERMISSIONS_CAMERA_FUZZ_CASES'] ?? 120);
    const heapBefore = process.memoryUsage().heapUsed;
    const seedRng = mulberry32(0x5eed_ca11);
    const cases: Array<{
      seed: number;
      steps: string[];
      failed: boolean;
      violations: string[];
      replay: string;
    }> = [];
    let totalSteps = 0;

    for (let i = 0; i < caseCount; i += 1) {
      const seed = replaySeed
        ? Number(replaySeed)
        : Math.floor(seedRng() * 0xffffffff);
      const rng = mulberry32(seed);
      jest.clearAllMocks();
      cameraFake.pending = [];
      cameraFake.cancelCalls = 0;
      const renderer = await mountCameraScreen();
      const steps: string[] = [];
      const violations: string[] = [];
      const stepCount = 4 + Math.floor(rng() * 10);
      for (let s = 0; s < stepCount; s += 1) {
        const phase = classifyPhase(renderer);
        const roll = rng();
        let step = '';
        if (phase === 'working') {
          if (roll < 0.15) {
            await emitPermission('requesting');
            step = 'emit:requesting';
          } else if (roll < 0.3) {
            await emitPermission('granted');
            step = 'emit:granted';
          } else if (roll < 0.45) {
            await emitPermission('denied');
            step = 'emit:denied';
          } else if (roll < 0.7) {
            await settleLatestCapture({
              kind: 'reject',
              error: new NativeCaptureError(
                'camera.permission_denied',
                NATIVE_CAMERA_DENIED_ANALYZE,
              ),
            });
            step = 'native:permission_denied';
          } else if (roll < 0.8) {
            await settleLatestCapture({
              kind: 'reject',
              error: new NativeCaptureError(
                'camera.configuration_failed',
                NATIVE_CONFIG_FAILED,
              ),
            });
            step = 'native:configuration_failed';
          } else if (roll < 0.9) {
            await settleLatestCapture({
              kind: 'reject',
              error: new Error(JS_BRIDGE_MISSING),
            });
            step = 'native:bridge_missing';
          } else {
            await settleLatestCapture({ kind: 'cancel' });
            step = 'native:cancel';
          }
        } else if (phase === 'error') {
          if (roll < 0.7) {
            await press(renderer, 'Try again');
            step = 'tap:Try again';
          } else {
            await press(renderer, 'Close');
            step = 'tap:Close';
          }
        } else if (phase === 'ready') {
          await press(renderer, 'Open automatic camera');
          step = 'tap:Open automatic camera';
        } else {
          step = `phase:${phase}`;
        }
        totalSteps += 1;
        const check = deadEndCheck(renderer);
        steps.push(
          `${step} → ${check.phase} (controls=${check.actionableControls})`,
        );
        if (check.violations.length > 0) {
          violations.push(`step ${s}: ${check.violations.join('; ')}`);
        }
        // Exactly one native operation may be pending at any time.
        if (cameraFake.pending.length > 1) {
          violations.push(
            `step ${s}: ${cameraFake.pending.length} concurrent native captures`,
          );
        }
        if (check.phase === 'working' && cameraFake.pending.length !== 1) {
          violations.push(
            `step ${s}: working phase with ${cameraFake.pending.length} pending captures`,
          );
        }
      }
      cases.push({
        seed,
        steps,
        failed: violations.length > 0,
        violations,
        replay: `XC_PERMISSIONS_REPLAY_SEED=${seed} npx jest --ci __tests__/xcPermissionsCameraDeniedFlow.test.tsx -t fuzz`,
      });
      await act(async () => {
        renderer.unmount();
      });
      // Settle anything still pending so no promise leaks across cases.
      for (const pending of cameraFake.pending.splice(0)) {
        await act(async () => {
          pending.reject(
            new NativeCaptureError('camera.cancelled', NATIVE_CANCEL),
          );
        });
      }
      expect(runCaptureAnalysis).not.toHaveBeenCalled();
    }

    const failing = cases.filter(c => c.failed);
    const heapAfter = process.memoryUsage().heapUsed;
    writeArtifact('camera-fuzz.json', {
      generatedAt: new Date().toISOString(),
      caseCount,
      totalSteps,
      failingCases: failing.length,
      heapUsedBeforeBytes: heapBefore,
      heapUsedAfterBytes: heapAfter,
      cases,
    });
    writeArtifact('camera-fuzz-failures.json', failing);
    expect(failing).toEqual([]);
  });
});
