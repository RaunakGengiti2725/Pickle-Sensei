/**
 * Render-cost harness — AnalyzeScreen, per camera/native event.
 *
 * Real AnalyzeScreen + real appStore/accessStore. The native camera seam is
 * driven through its typed `CameraEvent` contract (same pattern as the
 * existing analyzeScreenFullFlowE2E / analyzeScreenExtractionProgress
 * harnesses): `captureStrokeVideo` / `extractImportedPoseSequence` are held
 * pending so the screen stays in its live-capture / extraction surface while
 * events stream in. Native iOS execution is BLOCKED_EXTERNAL — the numbers
 * here are the JS-side render cost per event only, not device frame timing.
 *
 * Scale (SEED=20260903): 300 readiness events, 300 capture_quality events,
 * 20 stroke_detected, 20 processing, 20 profile writes, 20 unselected
 * accessStore writes, 20 canonicalAccess writes; import flow: 20 import
 * events + 300 import_pose_extraction progress events + 100 events from a
 * stale pass. Replay: `cd apps/mobile && npx jest __tests__/perf/analyzeRender`.
 * Raw table: artifacts/perf-mobile-render/analyze.json.
 */
import {
  commitCount,
  measureStep,
  rendererInjected,
  resetCommits,
  summarize,
  type StepResult,
} from '../../perf/renderCounter';

jest.mock('../../src/data/db', () => ({ getDb: jest.fn(() => ({})) }));
jest.mock('../../src/data/repository', () => ({
  savePendingCapture: jest.fn(async () => {}),
  setDeclaredStroke: jest.fn(async () => {}),
  setCaptureTargetSeed: jest.fn(async () => {}),
}));
jest.mock('../../src/analysis/runCaptureAnalysis', () => ({
  runCaptureAnalysis: jest.fn(() => new Promise(() => {})),
}));
jest.mock('../../src/account/apiSession', () => ({
  getApiSession: () => null,
}));

type CameraListener = (event: CameraEvent) => void;
const mockCameraListeners = new Set<CameraListener>();
jest.mock('../../src/camera/capture', () => {
  const actual = jest.requireActual<typeof import('../../src/camera/capture')>(
    '../../src/camera/capture',
  );
  return {
    ...actual,
    captureStrokeVideo: jest.fn(() => new Promise(() => {})),
    importStrokeVideo: jest.fn(),
    cancelCameraOperation: jest.fn(),
    importedPoseExtractionAvailable: jest.fn(() => true),
    extractImportedPoseSequence: jest.fn(() => new Promise(() => {})),
    subscribeToCameraEvents: (listener: CameraListener) => {
      mockCameraListeners.add(listener);
      return () => mockCameraListeners.delete(listener);
    },
  };
});
jest.mock('../../src/camera/TargetSelector', () => ({
  TargetSelector: () => null,
}));
const mockNavigation = {
  goBack: jest.fn(),
  replace: jest.fn(),
  popToTop: jest.fn(),
  navigate: jest.fn(),
};
let mockRouteParams: Record<string, unknown> = { source: 'camera' };
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => mockNavigation,
  useRoute: () => ({ params: mockRouteParams }),
}));
jest.mock('react-native-safe-area-context', () => {
  const ReactModule = require('react');
  const { View } = require('react-native');
  return {
    SafeAreaView: (props: { children?: React.ReactNode }) =>
      ReactModule.createElement(View, null, props.children),
  };
});
jest.mock('react-native-svg', () => {
  const ReactModule = require('react');
  const { View } = require('react-native');
  const Mock = (props: { children?: React.ReactNode }) =>
    ReactModule.createElement(View, null, props.children);
  return {
    __esModule: true,
    default: Mock,
    Svg: Mock,
    Circle: Mock,
    Ellipse: Mock,
    G: Mock,
    Line: Mock,
    Path: Mock,
    Polygon: Mock,
    Polyline: Mock,
    Rect: Mock,
    Defs: Mock,
    LinearGradient: Mock,
    Stop: Mock,
  };
});

import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import { AnalyzeScreen } from '../../src/screens/AnalyzeScreen';
import { TargetSelector } from '../../src/camera/TargetSelector';
import {
  assertCapturedClip,
  importStrokeVideo,
  type CameraEvent,
  type CameraReadinessState,
  type CaptureQualitySignalsV1,
} from '../../src/camera/capture';
import { useAppStore, type Profile } from '../../src/state/appStore';
import { useAccessStore } from '../../src/state/accessStore';
import type { CanonicalAccessState } from '../../src/billing/types';
import {
  FIXED_NOW_ISO,
  FIXED_NOW_MS,
  makeRng,
  renderedText,
  writeArtifact,
} from '../../perf/fixtures';

const SEED = 20260903;
const READINESS_EVENTS = 300;
const QUALITY_EVENTS = 300;
const EXTRACTION_EVENTS = 300;
const STALE_EXTRACTION_EVENTS = 100;
const STEPS = 20;
const RUNAWAY_THRESHOLD = 3;

const READINESS_STATES: readonly CameraReadinessState[] = [
  'no_person',
  'move_closer',
  'full_body_required',
  'move_farther',
  'hold_still',
  'ready',
];

const importedClip = assertCapturedClip({
  uri: 'file:///private/var/mobile/import.mov',
  durationMs: 4200,
  fps: 30,
  width: 1920,
  height: 1080,
  capturedAtIso: FIXED_NOW_ISO,
  captureMode: 'imported_video',
  recognition: { status: 'unknown', reason: 'analysis_not_run' },
  ballSpeed: { status: 'unavailable', reason: 'analysis_not_run' },
});

function atIso(offsetMs: number): string {
  return new Date(FIXED_NOW_MS + offsetMs).toISOString();
}

function readinessEvent(i: number, rng: () => number): CameraEvent {
  const state = READINESS_STATES[i % READINESS_STATES.length]!;
  return {
    emittedAtIso: atIso(i * 33),
    type: 'readiness',
    state,
    poseConfidence: Math.round(rng() * 1000) / 1000,
    jointCoverage: Math.round(rng() * 1000) / 1000,
    stableForMs: Math.floor(rng() * 800),
    missingJoints: state === 'full_body_required' ? ['left_ankle'] : [],
    source: 'apple_vision_body_pose',
    modelVersion: 'apple-vision-bodypose-1',
  };
}

function qualityEvent(i: number, rng: () => number): CameraEvent {
  const signals: CaptureQualitySignalsV1 = {
    schemaVersion: 1,
    frameWidthPx: 1080,
    frameHeightPx: 1920,
    avgFrameRateFps: 60 - Math.floor(rng() * 5),
    brightnessMeanLuma: Math.round(rng() * 255),
    laplacianVarianceMedian: Math.round(rng() * 400),
    meanAbsFrameDiff: Math.round(rng() * 40),
    sampledFrameCount: 8 + Math.floor(rng() * 8),
  };
  return { emittedAtIso: atIso(i * 250), type: 'capture_quality', signals };
}

function strokeDetectedEvent(i: number, rng: () => number): CameraEvent {
  return {
    emittedAtIso: atIso(i * 1000),
    type: 'stroke_detected',
    startTimestampMs: 2000 + i,
    endTimestampMs: 2700 + i,
    peakMotionTimestampMs: 2400 + i,
    confidence: Math.round(rng() * 1000) / 1000,
    detectionModelVersion: 'temporal-stroke-heuristic-2',
    recognition: {
      status: 'unknown',
      reason: 'validated_classifier_unavailable',
    },
  };
}

function processingEvent(i: number): CameraEvent {
  return {
    emittedAtIso: atIso(i * 1000),
    type: 'processing',
    state: 'preparing_clip',
  };
}

function importEvent(i: number): CameraEvent {
  const states = ['selecting', 'copying', 'completed'] as const;
  return {
    emittedAtIso: atIso(i * 1000),
    type: 'import',
    state: states[i % states.length]!,
  };
}

function extractionEvent(
  i: number,
  progress: number,
  captureId: string,
): CameraEvent {
  return {
    emittedAtIso: atIso(i * 100),
    type: 'import_pose_extraction',
    state: 'extracting',
    progress,
    captureId,
  };
}

function profileFor(i: number): Profile {
  return {
    firstName: `Player${i}`,
    skillLevel: ['beginner', 'intermediate', 'advanced'][i % 3]!,
    handedness: i % 2 === 0 ? 'right' : 'left',
    goal: 'dinks',
    biggestProblem: 'consistency',
    focusCheckpoint: 'contact_position',
  };
}

function accessFor(i: number): CanonicalAccessState {
  const used = i % 3;
  return {
    premium: false,
    entitlements: [],
    freeRatings: {
      limit: 2,
      used,
      reserved: 0,
      remaining: 2 - used,
      availableToReserve: 2 - used,
    },
    canStartRating: used < 2,
    paywallRequired: used >= 2,
  };
}

function emit(event: CameraEvent) {
  act(() => {
    for (const listener of mockCameraListeners) listener(event);
  });
}

async function flush() {
  await act(async () => {
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  });
}

function pressByLabel(renderer: TestRenderer.ReactTestRenderer, label: string) {
  const [node] = renderer.root.findAll(
    n =>
      n.props['accessibilityLabel'] === label &&
      typeof n.props['onPress'] === 'function',
  );
  if (!node) throw new Error(`No pressable with accessibilityLabel ${label}`);
  act(() => (node.props['onPress'] as () => void)());
}

function pressButton(renderer: TestRenderer.ReactTestRenderer, label: string) {
  const candidates = renderer.root.findAll(
    n =>
      typeof n.props['onPress'] === 'function' &&
      n.findAll(t => t.type === Text && String(t.props['children']) === label)
        .length > 0,
  );
  const node = candidates[candidates.length - 1];
  if (!node) throw new Error(`No button labeled ${label}`);
  act(() => (node.props['onPress'] as () => void)());
}

function worstOf(local: readonly StepResult[], component: string): number {
  return Math.max(...local.map(s => s.maxPerInstance[component] ?? 0));
}

function worstAny(local: readonly StepResult[]): number {
  return Math.max(...local.map(s => s.max?.renders ?? 0));
}

const steps: StepResult[] = [];
let staleExtractionRendersPerEvent = -1;
let identicalReadinessRendersPerEvent = -1;

afterAll(() => {
  const summary = summarize('AnalyzeScreen', steps, RUNAWAY_THRESHOLD);
  const file = writeArtifact('analyze.json', {
    screen: 'AnalyzeScreen',
    seed: SEED,
    readinessEvents: READINESS_EVENTS,
    qualityEvents: QUALITY_EVENTS,
    extractionEvents: EXTRACTION_EVENTS,
    staleExtractionEvents: STALE_EXTRACTION_EVENTS,
    fixedNowIso: FIXED_NOW_ISO,
    runawayThreshold: RUNAWAY_THRESHOLD,
    commitsObserved: commitCount(),
    staleExtractionRendersPerEvent,
    identicalReadinessRendersPerEvent,
    summary,
    steps,
  });
  console.log(`[perf] AnalyzeScreen table -> ${file}`);
});

describe('perf: AnalyzeScreen guided camera — render cost per native event', () => {
  let renderer: TestRenderer.ReactTestRenderer;

  beforeAll(() => {
    expect(rendererInjected()).toBe(true);
    mockRouteParams = { source: 'camera' };
    mockCameraListeners.clear();
    useAppStore.setState({ profile: profileFor(0) });
    useAccessStore.setState({ canonicalAccess: accessFor(0) });
    resetCommits();
  });

  afterAll(async () => {
    await act(async () => {
      renderer.unmount();
    });
  });

  it('mounts and opens the automatic camera (capture held pending)', async () => {
    steps.push(
      await measureStep('camera.mount', { source: 'camera' }, async () => {
        await act(async () => {
          renderer = TestRenderer.create(<AnalyzeScreen />);
        });
        await flush();
      }),
    );
    steps.push(
      await measureStep(
        'camera.declare+open',
        { technique: 'Forehand Drive', button: 'Open automatic camera' },
        async () => {
          pressByLabel(renderer, 'Forehand Drive');
          pressButton(renderer, 'Open automatic camera');
          await flush();
        },
      ),
    );
    expect(mockCameraListeners.size).toBeGreaterThan(0);
    expect(worstAny(steps)).toBeLessThanOrEqual(RUNAWAY_THRESHOLD);
  });

  it('readiness events: at most 1 AnalyzeScreen render per event', async () => {
    const rng = makeRng(SEED);
    const local: StepResult[] = [];
    for (let i = 0; i < READINESS_EVENTS; i += 1) {
      const event = readinessEvent(i, rng);
      local.push(
        await measureStep(`camera.readiness#${i + 1}`, event, () => {
          emit(event);
        }),
      );
    }
    steps.push(...local);
    expect(renderedText(renderer.toJSON()).length).toBeGreaterThan(0);
    expect(worstOf(local, 'AnalyzeScreen')).toBeLessThanOrEqual(1);
    expect(worstAny(local)).toBeLessThanOrEqual(RUNAWAY_THRESHOLD);
  });

  it('identical repeated readiness payloads: render count per event recorded', async () => {
    const rng = makeRng(SEED + 7);
    const template = readinessEvent(5, rng); // state 'ready'
    const local: StepResult[] = [];
    for (let i = 0; i < STEPS; i += 1) {
      const event: CameraEvent = { ...template };
      local.push(
        await measureStep(`camera.readiness.identical#${i + 1}`, event, () => {
          emit(event);
        }),
      );
    }
    steps.push(...local);
    identicalReadinessRendersPerEvent = worstOf(local, 'AnalyzeScreen');
    expect(identicalReadinessRendersPerEvent).toBeLessThanOrEqual(1);
    expect(worstAny(local)).toBeLessThanOrEqual(RUNAWAY_THRESHOLD);
  });

  it('capture_quality events: at most 1 AnalyzeScreen render per event', async () => {
    const rng = makeRng(SEED + 1);
    const local: StepResult[] = [];
    for (let i = 0; i < QUALITY_EVENTS; i += 1) {
      const event = qualityEvent(i, rng);
      local.push(
        await measureStep(`camera.capture_quality#${i + 1}`, event, () => {
          emit(event);
        }),
      );
    }
    steps.push(...local);
    expect(worstOf(local, 'AnalyzeScreen')).toBeLessThanOrEqual(1);
    expect(worstAny(local)).toBeLessThanOrEqual(RUNAWAY_THRESHOLD);
  });

  it('stroke_detected / processing events render bounded', async () => {
    const rng = makeRng(SEED + 2);
    const local: StepResult[] = [];
    for (let i = 0; i < STEPS; i += 1) {
      const stroke = strokeDetectedEvent(i, rng);
      local.push(
        await measureStep(`camera.stroke_detected#${i + 1}`, stroke, () => {
          emit(stroke);
        }),
      );
      const processing = processingEvent(i);
      local.push(
        await measureStep(`camera.processing#${i + 1}`, processing, () => {
          emit(processing);
        }),
      );
    }
    steps.push(...local);
    expect(worstOf(local, 'AnalyzeScreen')).toBeLessThanOrEqual(1);
    expect(worstAny(local)).toBeLessThanOrEqual(RUNAWAY_THRESHOLD);
  });

  it('appStore.profile writes re-render at most once', async () => {
    const local: StepResult[] = [];
    for (let i = 1; i <= STEPS; i += 1) {
      const profile = profileFor(i);
      local.push(
        await measureStep(`appStore.profile#${i}`, profile, () => {
          act(() => {
            useAppStore.setState({ profile });
          });
        }),
      );
    }
    steps.push(...local);
    expect(worstOf(local, 'AnalyzeScreen')).toBeLessThanOrEqual(1);
    expect(worstAny(local)).toBeLessThanOrEqual(RUNAWAY_THRESHOLD);
  });

  it('accessStore slices Analyze never selects do not render', async () => {
    const local: StepResult[] = [];
    for (let i = 1; i <= STEPS; i += 1) {
      const operation = i % 2 === 1 ? 'syncing' : 'idle';
      local.push(
        await measureStep(
          `accessStore.unselected.operation#${i}`,
          { operation },
          () => {
            act(() => {
              useAccessStore.setState({ operation });
            });
          },
        ),
      );
    }
    steps.push(...local);
    expect(Math.max(...local.map(s => s.totalRenders))).toBe(0);
  });

  it('accessStore.canonicalAccess writes render bounded (selector reads limit only)', async () => {
    const local: StepResult[] = [];
    for (let i = 1; i <= STEPS; i += 1) {
      const canonicalAccess = accessFor(i);
      local.push(
        await measureStep(
          `accessStore.canonicalAccess#${i}`,
          canonicalAccess,
          () => {
            act(() => {
              useAccessStore.setState({ canonicalAccess });
            });
          },
        ),
      );
    }
    steps.push(...local);
    expect(worstOf(local, 'AnalyzeScreen')).toBeLessThanOrEqual(1);
    expect(worstAny(local)).toBeLessThanOrEqual(RUNAWAY_THRESHOLD);
  });
});

describe('perf: AnalyzeScreen imported video — render cost per extraction event', () => {
  let renderer: TestRenderer.ReactTestRenderer;

  beforeAll(() => {
    mockRouteParams = { source: 'library' };
    mockCameraListeners.clear();
    (importStrokeVideo as jest.Mock).mockResolvedValue(importedClip);
  });

  afterAll(async () => {
    await act(async () => {
      renderer.unmount();
    });
  });

  it('mounts, auto-launches the import, declares, and arms extraction', async () => {
    steps.push(
      await measureStep(
        'import.mount+launch',
        { source: 'library' },
        async () => {
          await act(async () => {
            renderer = TestRenderer.create(<AnalyzeScreen />);
          });
          // library imports auto-launch after a 160 ms arming delay
          await act(async () => {
            await new Promise<void>(resolve => setTimeout(resolve, 250));
          });
          await flush();
        },
      ),
    );
    expect(renderedText(renderer.toJSON())).toContain('Capture complete');
    steps.push(
      await measureStep(
        'import.declare+skipTarget',
        { technique: 'Forehand drive', target: 'skip' },
        async () => {
          pressByLabel(renderer, 'Forehand drive');
          const selector = renderer.root.findByType(TargetSelector);
          await act(async () => {
            (selector.props['onSkip'] as () => void)();
          });
          await flush();
        },
      ),
    );
    expect(renderedText(renderer.toJSON())).toContain(
      'Reading player movement',
    );
  });

  it('import_pose_extraction progress: at most 1 AnalyzeScreen render per event', async () => {
    const local: StepResult[] = [];
    for (let i = 0; i < EXTRACTION_EVENTS; i += 1) {
      const event = extractionEvent(
        i,
        Math.min(0.99, (i + 1) / EXTRACTION_EVENTS),
        'native-pass-1',
      );
      local.push(
        await measureStep(
          `camera.import_pose_extraction#${i + 1}`,
          event,
          () => {
            emit(event);
          },
        ),
      );
    }
    steps.push(...local);
    expect(renderedText(renderer.toJSON())).toContain('99%');
    expect(worstOf(local, 'AnalyzeScreen')).toBeLessThanOrEqual(1);
    expect(worstAny(local)).toBeLessThanOrEqual(RUNAWAY_THRESHOLD);
  });

  it('stale-pass extraction events: progress ignored, screen render count recorded', async () => {
    const local: StepResult[] = [];
    for (let i = 0; i < STALE_EXTRACTION_EVENTS; i += 1) {
      const event = extractionEvent(i, 0.5, 'someone-elses-pass');
      local.push(
        await measureStep(
          `camera.import_pose_extraction.stale#${i + 1}`,
          event,
          () => {
            emit(event);
          },
        ),
      );
    }
    steps.push(...local);
    // the bar never follows the foreign pass …
    const text = renderedText(renderer.toJSON());
    expect(text).toContain('99%');
    expect(text).not.toContain('50%');
    // … but the handler's unconditional `setPhase({kind:'working', …})` for
    // every 'extracting' event still re-renders the screen once per event.
    staleExtractionRendersPerEvent = worstOf(local, 'AnalyzeScreen');
    expect(staleExtractionRendersPerEvent).toBeLessThanOrEqual(1);
    expect(worstAny(local)).toBeLessThanOrEqual(RUNAWAY_THRESHOLD);
  });

  it('import events render bounded', async () => {
    const local: StepResult[] = [];
    for (let i = 0; i < STEPS; i += 1) {
      const event = importEvent(i);
      local.push(
        await measureStep(`camera.import#${i + 1}`, event, () => {
          emit(event);
        }),
      );
    }
    steps.push(...local);
    expect(worstOf(local, 'AnalyzeScreen')).toBeLessThanOrEqual(1);
    expect(worstAny(local)).toBeLessThanOrEqual(RUNAWAY_THRESHOLD);
  });
});
