/**
 * STRESS SUITE — `src/camera/CaptureGuidancePanel.tsx` and
 * `src/camera/CaptureEvidenceCard.tsx`, lens: RAPID / CONCURRENT INTERACTION.
 *
 * Both components are render-only (no handlers, no async), so "rapid
 * interaction" for them means the parent slamming props at them faster than
 * a frame: the live envelope re-evaluating on every readiness/quality event
 * while the user walks in and out of frame, and the evidence card being
 * re-keyed while the window rotates / Dynamic Type changes / the clip is
 * swapped between an automatic capture and an import.
 *
 * Each seeded burst is 1–8 ticks; a tick applies 1–6 updates inside ONE
 * act() (batched — only the LAST update may be visible), interleaved with
 * `Dimensions.set` window changes (drives `useWindowDimensions`) and fake
 * timer advances, and sometimes unmounts mid-burst. After every tick the
 * rendered tree must equal what a fresh render of the LAST props produces:
 *
 *  CaptureGuidancePanel
 *   - renders null iff no DEGRADED/UNSUPPORTED dimension is present;
 *   - exactly one row per actionable dimension, in canonical order, text
 *     identical to `captureGuidanceLines`, no duplicate rows for duplicate
 *     dimension entries, NOT_MEASURED never invents guidance;
 *   - gate copy says "on hold" iff any dimension is UNSUPPORTED;
 *   - no duplicate-key console.error, no act() warning, no throw.
 *
 *  CaptureEvidenceCard
 *   - never prints an MPH figure unless `ballSpeed.status === 'measured'`;
 *   - eyebrow/provenance/facts/accessibility label track the LAST clip;
 *   - layout flags (compact/stacked) follow the LAST window dimensions;
 *   - exactly one summary node (no duplicate cards), no console noise.
 *
 * Scale: STRESS_ITER bursts per component (default 60). STRESS_SEED replays
 * one seed; STRESS_OUT=<dir> writes the seed → outcome JSON tables.
 */
jest.mock('react-native-svg', () => {
  const React = require('react') as typeof import('react');
  const { View } = require('react-native') as typeof import('react-native');
  const make = (name: string) => {
    const Mock = (props: { children?: React.ReactNode }) =>
      React.createElement(View, null, props.children);
    Mock.displayName = name;
    return Mock;
  };
  return {
    __esModule: true,
    default: make('Svg'),
    Svg: make('Svg'),
    Circle: make('Circle'),
    Defs: make('Defs'),
    Line: make('Line'),
    Path: make('Path'),
    Polyline: make('Polyline'),
    RadialGradient: make('RadialGradient'),
    Rect: make('Rect'),
    Stop: make('Stop'),
  };
});

import React from 'react';
import { Dimensions, Text, View } from 'react-native';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import type {
  EnvelopeDimension,
  EnvelopeDimensionVerdict,
  EnvelopeStatus,
  EnvelopeVerdict,
} from '@pickle/shared-types';
import { ENVELOPE_DIMENSIONS } from '@pickle/shared-types';
import { CaptureGuidancePanel } from '../../src/camera/CaptureGuidancePanel';
import { CaptureEvidenceCard } from '../../src/camera/CaptureEvidenceCard';
import {
  captureGuidanceLines,
  readyGate,
} from '../../src/camera/captureEnvelope';
import type {
  BallSpeedEvidence,
  CaptureEvidenceJoint,
  CapturedClip,
} from '../../src/camera/capture';
import { CAPTURE_EVIDENCE_JOINTS } from '../../src/camera/capture';

// Node built-ins for the campaign flags / JSON table. The mobile tsconfig
// deliberately excludes node typings, so the shims stay local.
declare const process: { env: Record<string, string | undefined> } & {
  on: (event: 'unhandledRejection', handler: (reason: unknown) => void) => void;
  off: (
    event: 'unhandledRejection',
    handler: (reason: unknown) => void,
  ) => void;
};
const fs = jest.requireActual<{
  mkdirSync: (dir: string, options: { recursive: boolean }) => void;
  writeFileSync: (file: string, data: string) => void;
}>('fs');
const path = jest.requireActual<{ join: (...parts: string[]) => string }>(
  'path',
);

// ─── seeded RNG ─────────────────────────────────────────────────────────────

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

class Rng {
  private readonly next: () => number;
  constructor(seed: number) {
    this.next = mulberry32(seed);
  }
  float(): number {
    return this.next();
  }
  int(min: number, maxInclusive: number): number {
    return min + Math.floor(this.next() * (maxInclusive - min + 1));
  }
  pick<T>(items: readonly T[]): T {
    return items[this.int(0, items.length - 1)]!;
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
}

const ITER = Number.parseInt(process.env.STRESS_ITER ?? '60', 10);
const ONLY_SEED =
  process.env.STRESS_SEED !== undefined
    ? Number.parseInt(process.env.STRESS_SEED, 10)
    : null;
const OUT_DIR = process.env.STRESS_OUT ?? null;
const PANEL_BASE_SEED = 0x9a1d;
const CARD_BASE_SEED = 0xca4d;

function seeds(base: number): number[] {
  if (ONLY_SEED !== null) return [ONLY_SEED];
  return Array.from({ length: ITER }, (_, i) => base + i);
}

function writeTable(name: string, rows: unknown[], summary: unknown) {
  if (!OUT_DIR) return;
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(OUT_DIR, `${name}.json`),
    JSON.stringify({ summary, rows }, null, 2),
  );
}

// ─── shared guards ──────────────────────────────────────────────────────────

const consoleLog: string[] = [];
const rejections: string[] = [];
let errorSpy: jest.SpyInstance;
let warnSpy: jest.SpyInstance;
const onRejection = (reason: unknown) => {
  rejections.push(String(reason));
};
const ORIGINAL_WINDOW = Dimensions.get('window');
const ORIGINAL_SCREEN = Dimensions.get('screen');

beforeAll(() => {
  errorSpy = jest.spyOn(console, 'error').mockImplementation((...args) => {
    consoleLog.push(`error: ${args.map(String).join(' ')}`);
  });
  warnSpy = jest.spyOn(console, 'warn').mockImplementation((...args) => {
    consoleLog.push(`warn: ${args.map(String).join(' ')}`);
  });
  process.on('unhandledRejection', onRejection);
});

afterAll(() => {
  errorSpy.mockRestore();
  warnSpy.mockRestore();
  process.off('unhandledRejection', onRejection);
  Dimensions.set({ window: ORIGINAL_WINDOW, screen: ORIGINAL_SCREEN });
});

beforeEach(() => {
  jest.useFakeTimers();
  consoleLog.length = 0;
  rejections.length = 0;
  Dimensions.set({ window: ORIGINAL_WINDOW, screen: ORIGINAL_SCREEN });
});

afterEach(() => {
  jest.useRealTimers();
});

function drainGuards(violations: string[]) {
  if (consoleLog.length > 0) {
    violations.push(...consoleLog.map(line => `console ${line}`));
    consoleLog.length = 0;
  }
  if (rejections.length > 0) {
    violations.push(...rejections.map(line => `unhandledRejection ${line}`));
    rejections.length = 0;
  }
}

function textNodes(renderer: ReactTestRenderer): string[] {
  return renderer.root
    .findAllByType(Text)
    .map(node => React.Children.toArray(node.props.children).join(''));
}

function setWindow(width: number, fontScale: number) {
  const window = { width, height: 844, scale: 3, fontScale };
  Dimensions.set({ window, screen: window });
}

// ═══════════════════════════════════════════════════════════════════════════
// CaptureGuidancePanel
// ═══════════════════════════════════════════════════════════════════════════

const STATUSES: readonly EnvelopeStatus[] = [
  'SUPPORTED',
  'DEGRADED',
  'UNSUPPORTED',
  'NOT_MEASURED',
];

function genEnvelope(rng: Rng): EnvelopeVerdict | null {
  if (rng.chance(0.12)) return null;
  const dims: EnvelopeDimensionVerdict[] = [];
  const count = rng.int(0, ENVELOPE_DIMENSIONS.length + 3);
  for (let i = 0; i < count; i += 1) {
    // Allow duplicates and non-canonical order: the panel must dedupe by
    // canonical iteration and never emit duplicate React keys.
    const dimension: EnvelopeDimension = rng.pick(ENVELOPE_DIMENSIONS);
    const status = rng.pick(STATUSES);
    dims.push({
      dimension,
      status,
      measured: status === 'NOT_MEASURED' ? null : rng.float() * 100,
      unit: 'unit',
      thresholdId: `stress-${dimension}`,
    });
  }
  const unsupported = dims.some(d => d.status === 'UNSUPPORTED');
  const degraded = dims.some(d => d.status === 'DEGRADED');
  const notMeasured = dims
    .filter(d => d.status === 'NOT_MEASURED')
    .map(d => d.dimension);
  return {
    thresholdsVersion: 'stress',
    provisional: true,
    dimensions: dims,
    overall: unsupported ? 'UNSUPPORTED' : degraded ? 'DEGRADED' : 'SUPPORTED',
    overallWithCoverage: unsupported
      ? 'UNSUPPORTED'
      : degraded
        ? 'DEGRADED'
        : notMeasured.length > 0
          ? 'SUPPORTED_UNMEASURED'
          : 'SUPPORTED',
    notMeasured,
  };
}

type PanelAction =
  | { kind: 'envelope'; envelope: EnvelopeVerdict | null }
  | { kind: 'advance'; ms: number }
  | { kind: 'unmount' };

function genPanelBurst(seed: number): PanelAction[][] {
  const rng = new Rng(seed);
  const ticks: PanelAction[][] = [];
  const tickCount = rng.int(1, 8);
  for (let t = 0; t < tickCount; t += 1) {
    const n = rng.chance(0.4) ? rng.int(2, 6) : 1;
    const tick: PanelAction[] = [];
    for (let i = 0; i < n; i += 1) {
      const roll = rng.float();
      if (roll < 0.86)
        tick.push({ kind: 'envelope', envelope: genEnvelope(rng) });
      else if (roll < 0.98)
        tick.push({ kind: 'advance', ms: rng.pick([0, 16, 250]) });
      else tick.push({ kind: 'unmount' });
    }
    ticks.push(tick);
  }
  return ticks;
}

interface PanelOutcome {
  seed: number;
  ticks: number;
  updates: number;
  renderedNull: number;
  renderedRows: number;
  blockedTicks: number;
  unmountedMidBurst: boolean;
  status: 'HELD' | 'BROKEN';
  violations: string[];
}

function runPanelBurst(seed: number): PanelOutcome {
  const burst = genPanelBurst(seed);
  const violations: string[] = [];
  let envelope: EnvelopeVerdict | null = null;
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(
      <CaptureGuidancePanel envelope={envelope} />,
    );
  });
  let mounted = true;
  let updates = 0;
  let renderedNull = 0;
  let renderedRows = 0;
  let blockedTicks = 0;

  for (const [tickIndex, tick] of burst.entries()) {
    if (!mounted) break;
    try {
      act(() => {
        for (const action of tick) {
          if (!mounted) break;
          updates += 1;
          if (action.kind === 'envelope') {
            envelope = action.envelope;
            renderer.update(<CaptureGuidancePanel envelope={envelope} />);
          } else if (action.kind === 'advance') {
            jest.advanceTimersByTime(action.ms);
          } else {
            renderer.unmount();
            mounted = false;
          }
        }
      });
    } catch (error) {
      violations.push(`tick ${tickIndex}: threw ${String(error)}`);
      break;
    }
    if (!mounted) break;

    const expectedLines = captureGuidanceLines(envelope);
    const gate = readyGate(envelope);
    const texts = textNodes(renderer);
    const panels = renderer.root.findAll(
      node =>
        node.type === View &&
        node.props.accessibilityLabel === 'Capture guidance',
    );
    if (expectedLines.length === 0) {
      renderedNull += 1;
      if (renderer.toJSON() !== null || panels.length !== 0) {
        violations.push(
          `tick ${tickIndex}: rendered a panel with no actionable lines`,
        );
      }
      continue;
    }
    if (panels.length !== 1) {
      violations.push(
        `tick ${tickIndex}: ${panels.length} guidance panels rendered`,
      );
    }
    const gateText = gate.blocked
      ? 'Ready is on hold until the items above are fixed.'
      : 'Ready is not blocked — fixing the items above improves the read.';
    if (gate.blocked) blockedTicks += 1;
    const expectedTexts = [...expectedLines.map(line => line.text), gateText];
    renderedRows += expectedLines.length;
    if (JSON.stringify(texts) !== JSON.stringify(expectedTexts)) {
      violations.push(
        `tick ${tickIndex}: text mismatch ${JSON.stringify(texts)} != ${JSON.stringify(
          expectedTexts,
        )}`,
      );
    }
    const seenDims = new Set(expectedLines.map(line => line.dimension));
    if (seenDims.size !== expectedLines.length) {
      violations.push(
        `tick ${tickIndex}: captureGuidanceLines emitted duplicate dimensions`,
      );
    }
    const canonicalIndex = expectedLines.map(line =>
      ENVELOPE_DIMENSIONS.indexOf(line.dimension),
    );
    if (
      canonicalIndex.some((idx, i) => i > 0 && idx <= canonicalIndex[i - 1]!)
    ) {
      violations.push(
        `tick ${tickIndex}: rows not in canonical dimension order`,
      );
    }
    for (const line of expectedLines) {
      const verdicts = envelope!.dimensions.filter(
        d => d.dimension === line.dimension,
      );
      if (
        !verdicts.some(
          v => v.status === 'DEGRADED' || v.status === 'UNSUPPORTED',
        )
      ) {
        violations.push(
          `tick ${tickIndex}: guidance for non-actionable ${line.dimension}`,
        );
      }
    }
  }
  if (mounted) act(() => renderer.unmount());
  act(() => {
    jest.runOnlyPendingTimers();
  });
  drainGuards(violations);
  return {
    seed,
    ticks: burst.length,
    updates,
    renderedNull,
    renderedRows,
    blockedTicks,
    unmountedMidBurst:
      !mounted && burst.some(t => t.some(a => a.kind === 'unmount')),
    status: violations.length === 0 ? 'HELD' : 'BROKEN',
    violations,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// CaptureEvidenceCard
// ═══════════════════════════════════════════════════════════════════════════

const BASE_AUTOMATIC: Extract<
  CapturedClip,
  { captureMode: 'automatic_pose_trigger' }
> = {
  uri: 'file:///private/captures/real.mov',
  durationMs: 3900,
  fps: 59.94,
  width: 720,
  height: 1280,
  capturedAtIso: '2026-08-27T18:00:00.000Z',
  captureMode: 'automatic_pose_trigger',
  recognition: {
    status: 'unknown',
    reason: 'validated_classifier_unavailable',
  },
  trigger: {
    startMs: 1800,
    endMs: 2450,
    peakMotionMs: 2220,
    confidence: 0.84,
    source: 'temporal_pose_motion',
    modelVersion: 'temporal-stroke-heuristic-2',
  },
  captureEvidence: {
    schemaVersion: 1,
    window: 'detected_motion',
    poseSource: 'apple_vision_body_pose',
    poseModelVersion: 'apple-vision-bodypose-1',
    triggerAlgorithmVersion: 'temporal-stroke-heuristic-2',
    motionUnit: 'normalized_image_units_per_second',
    analysisInputFrameCount: 8,
    poseFrameCount: 7,
    poseMissingFrameCount: 1,
    trackedDurationMs: 600,
    meanCanonicalJointVisibility: 0.86,
    meanJointCoverage: 0.93,
    minimumJointCoverage: 0.83,
    fullBodyVisibleFrameCount: 5,
    jointMotion: [],
  },
  ballSpeed: {
    status: 'unavailable',
    reason: 'calibrated_ball_tracker_unavailable',
  },
  preRollMs: 1800,
  postRollMs: 1450,
};

const UNAVAILABLE_REASONS = [
  'calibrated_ball_tracker_unavailable',
  'camera_not_calibrated',
  'frame_rate_too_low',
  'track_too_short',
  'out_of_plane_motion',
  'low_confidence',
] as const;

function genBallSpeed(rng: Rng): BallSpeedEvidence {
  if (rng.chance(0.3)) {
    return {
      status: 'measured',
      milesPerHour: rng.float() * 60,
      metersPerSecond: rng.float() * 27,
      confidence: rng.float(),
      source: 'calibrated_monocular_ball_track',
      calibrationId: 'cal-stress',
      trackerModelVersion: 'tracker-stress',
      measurementFrameRate: rng.pick([30, 59.94, 120, 240]),
      trackPointCount: rng.int(3, 40),
      trackedDistanceMeters: rng.float() * 6,
      trackedDurationMs: rng.int(40, 800),
      reprojectionErrorPx: rng.float() * 3,
    };
  }
  return { status: 'unavailable', reason: rng.pick(UNAVAILABLE_REASONS) };
}

function genClip(rng: Rng): CapturedClip {
  if (rng.chance(0.3)) {
    return {
      uri: 'file:///private/var/mobile/import.mov',
      durationMs: rng.pick([0, 1200, 3900, 15000, 60000]),
      fps: rng.pick([0, 24, 29.97, 30, 59.94, 120]),
      width: 1920,
      height: rng.pick([480, 720, 1080, 2160]),
      capturedAtIso: '2026-08-29T18:00:00.000Z',
      captureMode: 'imported_video',
      recognition: { status: 'unknown', reason: 'analysis_not_run' },
      ballSpeed: { status: 'unavailable', reason: 'analysis_not_run' },
    };
  }
  const jointCount = rng.int(0, CAPTURE_EVIDENCE_JOINTS.length);
  const joints: CaptureEvidenceJoint[] = [];
  for (let i = 0; i < jointCount; i += 1)
    joints.push(rng.pick(CAPTURE_EVIDENCE_JOINTS));
  const jointMotion = joints.map(joint => ({
    joint,
    sampleCount: rng.int(1, 12),
    meanNormalizedPerSecond: rng.float() * 3,
    peakNormalizedPerSecond: rng.chance(0.15) ? 0 : rng.float() * 4,
  }));
  return {
    ...BASE_AUTOMATIC,
    captureEvidence: {
      ...BASE_AUTOMATIC.captureEvidence,
      poseFrameCount: rng.int(0, 240),
      trackedDurationMs: rng.int(0, 5000),
      meanCanonicalJointVisibility: rng.float(),
      meanJointCoverage: rng.float(),
      jointMotion,
    },
    ballSpeed: genBallSpeed(rng),
  };
}

const WINDOW_WIDTHS = [320, 349, 350, 375, 390, 409, 410, 430, 844] as const;
const FONT_SCALES = [0.85, 1, 1.15, 1.16, 1.2, 1.21, 1.5, 2] as const;

type CardAction =
  | { kind: 'clip'; clip: CapturedClip }
  | { kind: 'window'; width: number; fontScale: number }
  | { kind: 'advance'; ms: number }
  | { kind: 'unmount' };

function genCardBurst(seed: number): CardAction[][] {
  const rng = new Rng(seed);
  const ticks: CardAction[][] = [];
  const tickCount = rng.int(1, 8);
  for (let t = 0; t < tickCount; t += 1) {
    const n = rng.chance(0.4) ? rng.int(2, 6) : 1;
    const tick: CardAction[] = [];
    for (let i = 0; i < n; i += 1) {
      const roll = rng.float();
      if (roll < 0.55) tick.push({ kind: 'clip', clip: genClip(rng) });
      else if (roll < 0.88) {
        tick.push({
          kind: 'window',
          width: rng.pick(WINDOW_WIDTHS),
          fontScale: rng.pick(FONT_SCALES),
        });
      } else if (roll < 0.98)
        tick.push({ kind: 'advance', ms: rng.pick([0, 16, 250]) });
      else tick.push({ kind: 'unmount' });
    }
    ticks.push(tick);
  }
  return ticks;
}

interface CardOutcome {
  seed: number;
  ticks: number;
  updates: number;
  measuredSpeedTicks: number;
  importedTicks: number;
  windowChanges: number;
  unmountedMidBurst: boolean;
  status: 'HELD' | 'BROKEN';
  violations: string[];
}

function expectedCardTexts(clip: CapturedClip): {
  eyebrow: string;
  provenance: string;
  speedTitle: string;
  label: string;
} {
  const evidence =
    clip.captureMode === 'automatic_pose_trigger' ? clip.captureEvidence : null;
  const speedTitle =
    clip.ballSpeed.status === 'measured'
      ? `${clip.ballSpeed.milesPerHour.toFixed(1)} MPH`
      : 'Not measured';
  let label: string;
  if (clip.captureMode === 'imported_video') {
    label =
      'Imported video. No automatic pose scan was recorded. Ball speed has not been analyzed.';
  } else {
    const most = [...clip.captureEvidence.jointMotion].sort(
      (a, b) => b.peakNormalizedPerSecond - a.peakNormalizedPerSecond,
    )[0];
    const speed =
      clip.ballSpeed.status === 'measured'
        ? `${clip.ballSpeed.milesPerHour.toFixed(1)} miles per hour measured.`
        : 'Ball speed not measured.';
    label = `Real capture evidence. ${clip.captureEvidence.poseFrameCount} usable pose frames. ${Math.round(
      clip.captureEvidence.meanJointCoverage * 100,
    )} percent average joint coverage. Most camera-relative movement at ${
      most ? most.joint.replace(/_/g, ' ') : 'no retained joint'
    }. ${speed}`;
  }
  return {
    eyebrow: evidence ? 'MEASURED MOTION' : 'SOURCE VIDEO',
    provenance: evidence ? 'ON-DEVICE' : 'IMPORTED',
    speedTitle,
    label,
  };
}

function runCardBurst(seed: number): CardOutcome {
  const burst = genCardBurst(seed);
  const violations: string[] = [];
  let clip = BASE_AUTOMATIC as CapturedClip;
  let window = { width: 390, fontScale: 1 };
  setWindow(window.width, window.fontScale);
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(<CaptureEvidenceCard clip={clip} />);
  });
  let mounted = true;
  let updates = 0;
  let measuredSpeedTicks = 0;
  let importedTicks = 0;
  let windowChanges = 0;

  for (const [tickIndex, tick] of burst.entries()) {
    if (!mounted) break;
    try {
      act(() => {
        for (const action of tick) {
          if (!mounted) break;
          updates += 1;
          switch (action.kind) {
            case 'clip':
              clip = action.clip;
              renderer.update(<CaptureEvidenceCard clip={clip} />);
              break;
            case 'window':
              window = { width: action.width, fontScale: action.fontScale };
              windowChanges += 1;
              setWindow(window.width, window.fontScale);
              break;
            case 'advance':
              jest.advanceTimersByTime(action.ms);
              break;
            case 'unmount':
              renderer.unmount();
              mounted = false;
              break;
          }
        }
      });
    } catch (error) {
      violations.push(`tick ${tickIndex}: threw ${String(error)}`);
      break;
    }
    if (!mounted) break;

    const want = expectedCardTexts(clip);
    const texts = textNodes(renderer);
    const joined = texts.join('\n');
    const summaries = renderer.root.findAll(
      node => node.type === View && node.props.accessibilityRole === 'summary',
    );
    if (summaries.length !== 1) {
      violations.push(
        `tick ${tickIndex}: ${summaries.length} summary cards rendered`,
      );
    } else if (summaries[0]!.props.accessibilityLabel !== want.label) {
      violations.push(
        `tick ${tickIndex}: a11y label "${summaries[0]!.props.accessibilityLabel}" != "${want.label}"`,
      );
    }
    if (!texts.includes(want.eyebrow) || !texts.includes(want.provenance)) {
      violations.push(
        `tick ${tickIndex}: eyebrow/provenance stale for ${clip.captureMode}`,
      );
    }
    if (!texts.includes(want.speedTitle)) {
      violations.push(
        `tick ${tickIndex}: speed title "${want.speedTitle}" missing`,
      );
    }
    const mphMatches = joined.match(/\d+(\.\d+)? MPH/g) ?? [];
    if (clip.ballSpeed.status === 'measured') {
      measuredSpeedTicks += 1;
      if (mphMatches.length !== 1) {
        violations.push(
          `tick ${tickIndex}: ${mphMatches.length} MPH figures for measured speed`,
        );
      }
    } else if (mphMatches.length !== 0) {
      violations.push(
        `tick ${tickIndex}: MPH figure ${mphMatches.join(',')} without measurement`,
      );
    }
    if (clip.captureMode === 'imported_video') {
      importedTicks += 1;
      if (texts.includes('POSE FRAMES') || texts.includes('MOST MOVEMENT')) {
        violations.push(`tick ${tickIndex}: pose facts shown for an import`);
      }
      const fps = clip.fps > 0 ? `${Math.round(clip.fps)}` : '—';
      if (!texts.includes(fps) || !texts.includes(`${clip.height}p`)) {
        violations.push(`tick ${tickIndex}: import facts stale`);
      }
    } else {
      const most = [...clip.captureEvidence.jointMotion].sort(
        (a, b) => b.peakNormalizedPerSecond - a.peakNormalizedPerSecond,
      )[0];
      const wantMost = most ? most.joint.replace(/_/g, ' ') : 'Not retained';
      if (!texts.includes(wantMost)) {
        violations.push(
          `tick ${tickIndex}: most-movement "${wantMost}" missing`,
        );
      }
      if (!texts.includes(`${clip.captureEvidence.poseFrameCount}`)) {
        violations.push(`tick ${tickIndex}: pose frame count stale`);
      }
      if (texts.includes('SOURCE FPS')) {
        violations.push(
          `tick ${tickIndex}: import facts shown for an automatic capture`,
        );
      }
    }
    // Layout flags must reflect the LAST window (useWindowDimensions).
    const stackFacts = window.width < 350 || window.fontScale > 1.2;
    const compactEvidence = window.width < 410 || window.fontScale > 1.15;
    const columnStyles = renderer.root
      .findAll(node => Array.isArray(node.props.style))
      .flatMap(node =>
        (node.props.style as unknown[]).filter(
          (s): s is { flexDirection: 'column'; gap?: number } =>
            s !== null &&
            typeof s === 'object' &&
            (s as { flexDirection?: string }).flexDirection === 'column',
        ),
      );
    // styles.factsColumn carries a gap; styles.heroRowCompact does not.
    const stacked = columnStyles.some(s => s.gap !== undefined);
    const compact = columnStyles.some(s => s.gap === undefined);
    if (stacked !== stackFacts) {
      violations.push(
        `tick ${tickIndex}: stacked facts=${stacked}, window ${JSON.stringify(window)}`,
      );
    }
    if (
      clip.captureMode === 'automatic_pose_trigger' &&
      compact !== compactEvidence
    ) {
      violations.push(
        `tick ${tickIndex}: compact hero=${compact}, window ${JSON.stringify(window)}`,
      );
    }
  }
  if (mounted) act(() => renderer.unmount());
  act(() => {
    jest.runOnlyPendingTimers();
  });
  drainGuards(violations);
  return {
    seed,
    ticks: burst.length,
    updates,
    measuredSpeedTicks,
    importedTicks,
    windowChanges,
    unmountedMidBurst:
      !mounted && burst.some(t => t.some(a => a.kind === 'unmount')),
    status: violations.length === 0 ? 'HELD' : 'BROKEN',
    violations,
  };
}

// ═══════════════════════════════════════════════════════════════════════════

describe('CaptureGuidancePanel rapid envelope churn', () => {
  it(`matches captureGuidanceLines after every batched update across ${seeds(PANEL_BASE_SEED).length} seeds`, () => {
    const outcomes = seeds(PANEL_BASE_SEED).map(runPanelBurst);
    const broken = outcomes.filter(o => o.status === 'BROKEN');
    const summary = {
      component: 'CaptureGuidancePanel',
      seeds: outcomes.length,
      ticks: outcomes.reduce((n, o) => n + o.ticks, 0),
      updates: outcomes.reduce((n, o) => n + o.updates, 0),
      renderedNullTicks: outcomes.reduce((n, o) => n + o.renderedNull, 0),
      renderedRows: outcomes.reduce((n, o) => n + o.renderedRows, 0),
      blockedTicks: outcomes.reduce((n, o) => n + o.blockedTicks, 0),
      unmountedMidBurst: outcomes.filter(o => o.unmountedMidBurst).length,
      broken: broken.map(o => o.seed),
    };
    writeTable('captureGuidancePanel', outcomes, summary);
    expect(
      broken.map(o => ({ seed: o.seed, violations: o.violations })),
    ).toEqual([]);
  });

  it('replays identically from a seed', () => {
    const seed = PANEL_BASE_SEED + 3;
    expect(genPanelBurst(seed)).toEqual(genPanelBurst(seed));
    expect(runPanelBurst(seed)).toEqual(runPanelBurst(seed));
  });
});

describe('CaptureEvidenceCard rapid clip/window churn', () => {
  it(`tracks the last clip and window after every batched update across ${seeds(CARD_BASE_SEED).length} seeds`, () => {
    const outcomes = seeds(CARD_BASE_SEED).map(runCardBurst);
    const broken = outcomes.filter(o => o.status === 'BROKEN');
    const summary = {
      component: 'CaptureEvidenceCard',
      seeds: outcomes.length,
      ticks: outcomes.reduce((n, o) => n + o.ticks, 0),
      updates: outcomes.reduce((n, o) => n + o.updates, 0),
      measuredSpeedTicks: outcomes.reduce(
        (n, o) => n + o.measuredSpeedTicks,
        0,
      ),
      importedTicks: outcomes.reduce((n, o) => n + o.importedTicks, 0),
      windowChanges: outcomes.reduce((n, o) => n + o.windowChanges, 0),
      unmountedMidBurst: outcomes.filter(o => o.unmountedMidBurst).length,
      broken: broken.map(o => o.seed),
    };
    writeTable('captureEvidenceCard', outcomes, summary);
    expect(
      broken.map(o => ({ seed: o.seed, violations: o.violations })),
    ).toEqual([]);
  });

  it('replays identically from a seed', () => {
    const seed = CARD_BASE_SEED + 3;
    expect(genCardBurst(seed)).toEqual(genCardBurst(seed));
    expect(runCardBurst(seed)).toEqual(runCardBurst(seed));
  });
});
