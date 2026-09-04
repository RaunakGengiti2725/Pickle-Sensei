/**
 * STRESS — failure injection at the SCREEN boundary of the review models.
 *
 * `reviewModelsFailureInjection.test.ts` proves how the five review modules
 * behave when their dependencies fail. This companion mounts the one screen
 * that consumes them all (FormReviewScreen) with the SAME fault modes on its
 * two async dependencies — the evidence loader (SQLite) and the pose sidecar
 * loader (camera artifact + hash + parser) — and asserts the user-visible
 * contract: after 60s of fake time there is no spinner without a working
 * Close/Back control, a missing analysis shows a visible retry/back control,
 * a broken sidecar degrades to a pose-less replay (never a fake skeleton),
 * and nothing throws out of the render tree.
 *
 * Deterministic: seed → fault pair; `STRESS_SEED=<n>` replays one seed,
 * `STRESS_ITER=<n>` widens the campaign. Results are appended as a JSON table.
 */
const mockGetDb = jest.fn(() => ({}));
jest.mock('../../src/data/db', () => ({ getDb: () => mockGetDb() }));

const mockLoadEvidence = jest.fn();
jest.mock('../../src/components/strokeResultData', () => ({
  loadStrokeResultEvidence: (...args: unknown[]) => mockLoadEvidence(...args),
}));

const mockLoadSequence = jest.fn();
jest.mock('../../src/review/poseSidecar', () => ({
  loadReviewPoseSequence: (...args: unknown[]) => mockLoadSequence(...args),
}));

const mockNavigation = {
  goBack: jest.fn(),
  replace: jest.fn(),
  popToTop: jest.fn(),
  navigate: jest.fn(),
};
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => mockNavigation,
  useRoute: () => ({ params: { analysisId: 'analysis-1' } }),
}));
jest.mock('react-native-safe-area-context', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    SafeAreaView: (props: { children?: React.ReactNode; testID?: string }) =>
      React.createElement(View, { testID: props.testID }, props.children),
  };
});
jest.mock('react-native-svg', () => {
  const React = require('react');
  const { View } = require('react-native');
  const Mock = (props: { children?: React.ReactNode }) =>
    React.createElement(View, null, props.children);
  return {
    __esModule: true,
    default: Mock,
    Svg: Mock,
    Circle: Mock,
    Defs: Mock,
    G: Mock,
    Line: Mock,
    Path: Mock,
    Polygon: Mock,
    Polyline: Mock,
    RadialGradient: Mock,
    LinearGradient: Mock,
    Rect: Mock,
    Stop: Mock,
  };
});

import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { Text } from 'react-native';
import TestRenderer, {
  act,
  type ReactTestInstance,
  type ReactTestRenderer,
} from 'react-test-renderer';
import type {
  CheckpointKey,
  CheckpointScore,
  FaultDirection,
  PhaseKey,
  PhaseSpan,
  ScoreBand,
  ShotAnalysis,
} from '@pickle/shared-types';
import { FormReviewScreen } from '../../src/screens/FormReviewScreen';
import type {
  ReviewPoseFrame,
  ReviewPoseSequence,
} from '../../src/review/formReviewModel';

// ─── Seeded RNG (mulberry32) ────────────────────────────────────────────────

type Rng = () => number;

function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function int(rng: Rng, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

function pick<T>(rng: Rng, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length)]!;
}

// ─── Fixtures ───────────────────────────────────────────────────────────────

function phase(key: PhaseKey, startMs: number, endMs: number): PhaseSpan {
  return {
    key,
    startMs,
    representativeMs: startMs + (endMs - startMs) / 2,
    endMs,
    confidence: 0.8,
  };
}

function checkpoint(
  key: CheckpointKey,
  score: number | null,
  band: ScoreBand,
  direction: FaultDirection,
): CheckpointScore {
  return {
    key,
    score,
    confidence: 0.8,
    band,
    direction,
    severity: score === null ? 0 : (100 - score) / 100,
    applicable: true,
  };
}

const analysis: ShotAnalysis = {
  id: 'analysis-1',
  sessionId: 'set-1',
  shotType: 'forehand_drive',
  cameraView: 'side',
  handedness: 'right',
  capturedAtIso: '2026-09-01T10:00:00.000Z',
  timestamps: { startMs: 0, contactMs: 1900, endMs: 3200 },
  phases: [
    phase('ready', 0, 900),
    phase('prepare', 900, 1500),
    phase('accelerate', 1500, 1900),
    phase('contact', 1880, 1920),
    phase('follow_through', 1920, 2400),
    phase('recover', 2400, 3200),
  ],
  measurements: [],
  checkpoints: [
    checkpoint('ready_position', 85, 'green', 'none'),
    checkpoint('athletic_base', 72, 'yellow', 'narrow'),
    checkpoint('paddle_path', 61, 'red', 'low'),
    checkpoint('contact_position', 48, 'red', 'late'),
    checkpoint('follow_through', 80, 'green', 'short'),
    checkpoint('recovery', 92, 'green', 'none'),
  ],
  overallScore: 7.1,
  analysisConfidence: 0.84,
  resultKind: 'scored',
  guidance: null,
  priorityFix: {
    checkpoint: 'contact_position',
    reasonKey: 'lowest_score',
    severity: 0.52,
    confidence: 0.8,
  },
  versionVector: {
    appVersion: '0.1.0',
    modelBundleVersion: 'on-device-fusion-1',
    poseModelVersion: 'apple-vision-bodypose-1',
    paddleModelVersion: 'none',
    strokeDetectorVersion: 'temporal-stroke-heuristic-2',
    phaseModelVersion: 'phase-geometry-1',
    scoringModelVersion: 'sm-v1',
    shotConfigVersion: 'forehand_drive@1',
  },
  source: 'real',
};

const sidecarRef = {
  schemaVersion: 1 as const,
  format: 'pickle.pose-sequence.v1' as const,
  uri: 'file:///captures/clip.pose.json',
  frameCount: 81,
  sha256: 'ab'.repeat(32),
  coordinateSystem: 'normalized_image_top_left' as const,
  poseModelVersion: 'apple-vision-bodypose-1',
};

function fullBodySequence(): ReviewPoseSequence {
  const frames: ReviewPoseFrame[] = [];
  for (let t = 0; t <= 3200; t += 40) {
    const sweep = t / 3200;
    const joints: Record<string, { x: number; y: number }> = {
      head: { x: 0.5, y: 0.18 },
      left_shoulder: { x: 0.45, y: 0.3 },
      right_shoulder: { x: 0.55, y: 0.3 },
      left_elbow: { x: 0.4, y: 0.42 },
      right_elbow: { x: 0.62, y: 0.42 },
      left_wrist: { x: 0.38, y: 0.52 },
      right_wrist: { x: 0.3 + 0.4 * sweep, y: 0.5 },
      left_hip: { x: 0.46, y: 0.55 },
      right_hip: { x: 0.54, y: 0.55 },
      left_knee: { x: 0.46, y: 0.72 },
      right_knee: { x: 0.54, y: 0.72 },
      left_ankle: { x: 0.45, y: 0.9 },
      right_ankle: { x: 0.55, y: 0.9 },
    };
    frames.push({
      timestampMs: t,
      confidence: 0.9,
      landmarks: Object.entries(joints).map(([name, p]) => ({
        name,
        x: p.x,
        y: p.y,
        visibility: 0.95,
      })),
    });
  }
  return { frames, video: { width: 1080, height: 1920, fps: 30 } };
}

function evidence(withSidecar: boolean) {
  return {
    analysis,
    record: null,
    clip: {
      uri: 'file:///captures/clip.mov',
      durationMs: 3400,
      posterUri: 'file:///captures/clip.poster.jpg',
    },
    review: {
      width: 1080,
      height: 1920,
      poseSequence: withSidecar ? sidecarRef : null,
    },
    attempts: [],
  };
}

// ─── Fault modes ────────────────────────────────────────────────────────────

type Mode =
  | 'ok'
  | 'throw'
  | 'reject'
  | 'timeout'
  | 'malformed'
  | 'partial'
  | 'slow'
  | 'never-resolves';

const MODES: readonly Mode[] = [
  'ok',
  'throw',
  'reject',
  'timeout',
  'malformed',
  'partial',
  'slow',
  'never-resolves',
];

/** `loadReviewPoseSequence` is an async function, so it cannot throw
 * synchronously — its throw paths are exercised inside the module harness. */
const SIDECAR_MODES: readonly Mode[] = MODES.filter(mode => mode !== 'throw');

const ONE_MINUTE_MS = 60_000;

/** A dependency `fn` behaving per `mode`; `slow` and `timeout` use the fake
 * clock (≤ 45s / 90s) so the 60s advance distinguishes them. */
function behave<T>(
  mode: Mode,
  rng: Rng,
  ok: () => T,
  malformed: () => unknown,
  partial: () => unknown,
): () => Promise<unknown> {
  switch (mode) {
    case 'ok':
      return () => Promise.resolve(ok());
    case 'throw':
      return () => {
        throw new TypeError('dependency threw synchronously');
      };
    case 'reject':
      return () => Promise.reject(new Error('dependency rejected'));
    case 'timeout':
      return () =>
        new Promise(resolve =>
          setTimeout(() => resolve(ok()), ONE_MINUTE_MS + int(rng, 1, 30_000)),
        );
    case 'malformed':
      return () => Promise.resolve(malformed());
    case 'partial':
      return () => Promise.resolve(partial());
    case 'slow':
      return () =>
        new Promise(resolve =>
          setTimeout(() => resolve(ok()), int(rng, 1_000, 45_000)),
        );
    case 'never-resolves':
      return () => new Promise(() => {});
  }
}

interface Row {
  seed: number;
  evidenceMode: Mode;
  sidecarMode: Mode;
  outcome: 'HELD' | 'BROKEN';
  screen: 'loading' | 'missing' | 'ready' | 'unknown';
  violations: string[];
  notes: string[];
}

const mounted: ReactTestRenderer[] = [];

function allText(renderer: ReactTestRenderer): string {
  return renderer.root
    .findAllByType(Text)
    .map(node => node.props.children)
    .flat(3)
    .filter((child): child is string | number =>
      ['string', 'number'].includes(typeof child),
    )
    .join(' ')
    .replace(/\s+/g, ' ');
}

/** The innermost pressables carrying `label` — one per on-screen control
 * (Button → PressableScale → Pressable all forward the same props). */
function pressables(renderer: ReactTestRenderer, label: string) {
  const matches = (node: ReactTestInstance) =>
    typeof node.props.onPress === 'function' &&
    (node.props.accessibilityLabel === label || node.props.testID === label);
  const all = renderer.root.findAll(matches);
  return all.filter(
    node => node.findAll(matches).filter(inner => inner !== node).length === 0,
  );
}

async function flushReact(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
  await act(async () => {
    await new Promise<void>(resolve => setImmediate(resolve));
  });
}

async function runSeed(seed: number): Promise<Row> {
  const rng = mulberry32(seed);
  const evidenceMode = pick(rng, MODES);
  const sidecarMode = pick(rng, SIDECAR_MODES);
  const row: Row = {
    seed,
    evidenceMode,
    sidecarMode,
    outcome: 'HELD',
    screen: 'unknown',
    violations: [],
    notes: [],
  };
  const check = (ok: boolean, message: string) => {
    if (!ok) row.violations.push(message);
  };

  jest.useFakeTimers({
    doNotFake: ['setImmediate', 'clearImmediate', 'nextTick'],
  });
  jest.clearAllMocks();
  // `throw` for evidence = the SQLite handle itself failing to open
  // (getDb() throws synchronously: corrupt file / failed migration).
  mockGetDb.mockImplementation(() => {
    if (evidenceMode === 'throw') throw new Error('sqlite open failed');
    return {};
  });
  mockLoadEvidence.mockImplementation(
    behave(
      evidenceMode === 'throw' ? 'ok' : evidenceMode,
      rng,
      () => evidence(true),
      () => pick(rng, [null, 42, 'garbage', {}, { analysis: null }, []]),
      () => ({
        analysis,
        record: null,
        clip: null,
        review: null,
        attempts: [],
      }),
    ),
  );
  mockLoadSequence.mockImplementation(
    behave(
      sidecarMode,
      rng,
      () => fullBodySequence(),
      () => null,
      () => ({ frames: [], video: null }),
    ),
  );

  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = TestRenderer.create(<FormReviewScreen />);
    });
    mounted.push(renderer);
    await flushReact();
    await act(async () => {
      await jest.advanceTimersByTimeAsync(ONE_MINUTE_MS);
    });
    await flushReact();
  } catch (error) {
    row.violations.push(
      `render threw — ${error instanceof Error ? error.message : String(error)}`,
    );
    row.outcome = 'BROKEN';
    return row;
  } finally {
    jest.useRealTimers();
  }

  const copy = allText(renderer);
  const spinner = copy.includes('Preparing your form review…');
  const missing = copy.includes('Review unavailable');
  const ready =
    renderer.root.findAll(n => n.props.testID === 'form-review-screen').length >
    0;
  row.screen = spinner
    ? 'loading'
    : missing
      ? 'missing'
      : ready
        ? 'ready'
        : 'unknown';

  const evidenceSettledOk =
    evidenceMode === 'ok' ||
    evidenceMode === 'slow' ||
    evidenceMode === 'partial';
  const evidenceFailed =
    evidenceMode === 'reject' || evidenceMode === 'malformed';
  const evidenceHung =
    evidenceMode === 'timeout' || evidenceMode === 'never-resolves';
  const dbOpenThrew = evidenceMode === 'throw';
  // Partial evidence carries no sidecar ref, so the sidecar loader never runs.
  const sidecarConsulted = evidenceMode !== 'partial';
  const sidecarHung =
    sidecarConsulted &&
    (sidecarMode === 'timeout' || sidecarMode === 'never-resolves');

  if (dbOpenThrew) {
    // A synchronous getDb() throw must surface like any other missing
    // evidence: the 'Review unavailable' state with its back control.
    check(
      missing,
      `getDb() threw synchronously: expected 'Review unavailable', saw ${row.screen}`,
    );
    check(
      !spinner,
      'getDb() threw synchronously: spinner still shown after 60s',
    );
    const close = pressables(renderer, 'Close');
    const back = pressables(renderer, 'Try again');
    check(
      close.length + back.length >= 1,
      'after a sync getDb() throw there is no visible retry/back/close control',
    );
  } else if (evidenceFailed) {
    check(
      missing,
      `evidence ${evidenceMode}: expected 'Review unavailable', saw ${row.screen}`,
    );
    const back = pressables(renderer, 'Try again');
    check(
      back.length === 1,
      'missing-analysis state has no visible retry/back control',
    );
    if (back[0]) {
      await act(async () => {
        back[0]!.props.onPress();
      });
      check(
        mockNavigation.goBack.mock.calls.length === 1,
        'retry control did not navigate back',
      );
    }
  } else if (evidenceHung || (evidenceSettledOk && sidecarHung)) {
    // The screen has no timeout: after 60s it is still "Preparing…". The
    // lens requires a working escape; record whether one exists.
    check(
      spinner,
      `hung dependency: expected the loading state, saw ${row.screen}`,
    );
    const close = pressables(renderer, 'Close');
    check(
      close.length === 1,
      'loading state after 60s has no visible Close control',
    );
    if (close[0]) {
      await act(async () => {
        close[0]!.props.onPress();
      });
      check(
        mockNavigation.goBack.mock.calls.length === 1,
        'Close did not navigate back',
      );
    }
    row.notes.push(
      `spinner still shown after 60s (${evidenceHung ? 'evidence' : 'sidecar'} ${
        evidenceHung ? evidenceMode : sidecarMode
      }) — recoverable only via Close`,
    );
  } else {
    // Evidence arrived and the sidecar settled (ok / failed / malformed): a
    // replay renders, pose-less when the sidecar failed, never a spinner.
    check(ready, `expected the replay, saw ${row.screen}`);
    check(!spinner, 'spinner still visible although every dependency settled');
    check(copy.includes('Form review'), 'header missing');
    check(copy.includes('STOP 1 OF'), 'no stops rendered');
    check(
      mockLoadSequence.mock.calls.length === (sidecarConsulted ? 1 : 0),
      `sidecar loader called ${mockLoadSequence.mock.calls.length}× (expected ${sidecarConsulted ? 1 : 0})`,
    );
  }

  row.outcome = row.violations.length === 0 ? 'HELD' : 'BROKEN';
  return row;
}

// ─── Campaign ───────────────────────────────────────────────────────────────

const OUT_DIR =
  process.env.STRESS_OUT ?? path.resolve(__dirname, '../../artifacts/stress');
const ONLY_SEED = process.env.STRESS_SEED
  ? Number(process.env.STRESS_SEED)
  : null;
const REQUESTED_ITER = process.env.STRESS_ITER
  ? Number(process.env.STRESS_ITER)
  : null;
const ITERATIONS = ONLY_SEED !== null ? 1 : Math.max(24, REQUESTED_ITER ?? 24);
const seeds =
  ONLY_SEED !== null
    ? [ONLY_SEED]
    : Array.from({ length: ITERATIONS }, (_v, i) => i);
const rows: Row[] = [];

afterEach(async () => {
  for (const renderer of mounted.splice(0)) {
    await act(async () => {
      renderer.unmount();
    });
  }
  jest.useRealTimers();
});

afterAll(() => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const held = rows.filter(r => r.outcome === 'HELD').length;
  fs.writeFileSync(
    path.join(OUT_DIR, 'review-screens-failure-injection.json'),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        iterations: rows.length,
        held,
        broken: rows.length - held,
        replay:
          'cd apps/mobile && STRESS_SEED=<seed> npx jest --ci __tests__/stress/reviewScreensFailureInjection.test.tsx',
        rows,
      },
      null,
      2,
    ),
  );
});

describe('FormReviewScreen — failure injection (seeded)', () => {
  it.each(seeds)('seed %i', async seed => {
    const row = await runSeed(seed);
    rows.push(row);
    expect({
      seed: row.seed,
      modes: `${row.evidenceMode}/${row.sidecarMode}`,
      violations: row.violations,
    }).toEqual({
      seed: row.seed,
      modes: `${row.evidenceMode}/${row.sidecarMode}`,
      violations: [],
    });
  });
});
