/**
 * ADVERSARIAL PASS #4 — review module attacked directly (FixList and
 * FormReviewPlayer mounted with hand-built evidence):
 *
 *  S2  priorityFix.checkpoint that is NOT in CHECKPOINTS is ignored and the
 *      worst measured fault leads (no PRIORITY tag, no phantom item).
 *  S3  clip={uri, durationMs: 0} + a valid sequence: no division by zero,
 *      every timeline position stays within [0%, 100%] on every tick.
 *  S8  autoPause ON: scrub backwards past two visited stops, play — both
 *      re-fire in order, none fires twice in one pass.
 *  S9  native playback available: onError after the first auto-pause keeps
 *      the visited stops, resumes the JS clock from the current playhead and
 *      shows the clip-gone caption.
 *  +   corrupt durations (NaN / negative / Infinity), rapid play/pause
 *      toggles, speed change mid-pass, scrub-without-release.
 */
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

// The native clip player is a controllable fake: the test decides whether
// the build "has" native playback and drives its progress/error callbacks.
const nativeFake: { available: boolean } = { available: false };
jest.mock('../src/components/ClipPlayer', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    clipPlaybackAvailable: () => nativeFake.available,
    ClipPlayer: (props: Record<string, unknown>) =>
      React.createElement(View, { testID: 'fake-clip-player', ...props }),
  };
});

import React from 'react';
import { StyleSheet, Text } from 'react-native';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import type {
  CheckpointKey,
  CheckpointScore,
  FaultDirection,
  PhaseKey,
  PhaseSpan,
  ScoreBand,
  ShotAnalysis,
} from '@pickle/shared-types';
import { FixList } from '../src/review/FixList';
import {
  FormReviewPlayer,
  replayStageCaption,
} from '../src/review/FormReviewPlayer';
import {
  buildFormReviewScript,
  fixList,
  type ReviewJoint,
  type ReviewPoseFrame,
  type ReviewPoseSequence,
} from '../src/review/formReviewModel';
import { drillFocusFromAnalysis } from '../src/review/recommendedDrillsModel';

// ─── Fixtures ───────────────────────────────────────────────────────────────

function phase(
  key: PhaseKey,
  startMs: number,
  endMs: number,
  representativeMs = startMs + (endMs - startMs) / 2,
): PhaseSpan {
  return { key, startMs, representativeMs, endMs, confidence: 0.8 };
}

function checkpoint(
  key: CheckpointKey,
  score: number | null,
  band: ScoreBand,
  direction: FaultDirection,
  overrides: Partial<CheckpointScore> = {},
): CheckpointScore {
  return {
    key,
    score,
    confidence: 0.8,
    band,
    direction,
    severity: score === null ? 0 : (100 - score) / 100,
    applicable: true,
    ...overrides,
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
    phase('contact', 1880, 1920, 1900),
    phase('follow_through', 1920, 2400),
    phase('recover', 2400, 3200),
  ],
  measurements: [],
  checkpoints: [
    checkpoint('ready_position', 85, 'green', 'none'),
    checkpoint('athletic_base', 72, 'yellow', 'narrow'),
    checkpoint('preparation', 88, 'green', 'none'),
    checkpoint('paddle_set', 90, 'green', 'none'),
    checkpoint('swing_length', null, 'unscored', 'none'),
    checkpoint('sequencing', 82, 'green', 'none'),
    checkpoint('paddle_path', 61, 'red', 'low'),
    checkpoint('contact_position', 48, 'red', 'late'),
    checkpoint('face_wrist_stability', 30, 'red', 'unstable', {
      applicable: false,
    }),
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

function frameAt(
  timestampMs: number,
  joints: Partial<Record<ReviewJoint, { x: number; y: number }>>,
): ReviewPoseFrame {
  return {
    timestampMs,
    confidence: 0.9,
    landmarks: Object.entries(joints).map(([name, point]) => ({
      name,
      x: point.x,
      y: point.y,
      visibility: 0.95,
    })),
  };
}

function fullBodySequence(): ReviewPoseSequence {
  const frames: ReviewPoseFrame[] = [];
  for (let t = 0; t <= 3200; t += 40) {
    const sweep = t / 3200;
    frames.push(
      frameAt(t, {
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
      }),
    );
  }
  return { frames, video: { width: 1080, height: 1920, fps: 30 } };
}

const review = { width: 1080, height: 1920, poseSequence: null };

// ─── Harness ────────────────────────────────────────────────────────────────

const mounted: ReactTestRenderer[] = [];

async function render(element: React.ReactElement) {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(element);
  });
  mounted.push(renderer);
  return renderer;
}

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

function byTestId(renderer: ReactTestRenderer, testID: string) {
  const [node] = renderer.root.findAll(
    candidate =>
      candidate.props.testID === testID &&
      typeof candidate.props.onPress === 'function',
  );
  if (!node) throw new Error(`no pressable with testID ${testID}`);
  return node;
}

async function press(renderer: ReactTestRenderer, testID: string) {
  const node = byTestId(renderer, testID);
  await act(async () => {
    node.props.onPress();
  });
}

function hostByTestId(renderer: ReactTestRenderer, testID: string) {
  return renderer.root.findAll(
    node => typeof node.type === 'string' && node.props.testID === testID,
  );
}

function flatStyle(node: { props: { style?: unknown } }) {
  return (StyleSheet.flatten(node.props.style as never) ?? {}) as Record<
    string,
    unknown
  >;
}

function playLabel(renderer: ReactTestRenderer) {
  return byTestId(renderer, 'form-review-play').props.accessibilityLabel as
    'Play replay' | 'Pause replay';
}

function clockText(renderer: ReactTestRenderer): string {
  const match = allText(renderer).match(/(\d+\.\d\ds)/g);
  return match ? match[match.length - 1]! : '';
}

function stopCounter(renderer: ReactTestRenderer): string {
  return allText(renderer).match(/STOP \d+ OF \d+/)?.[0] ?? '';
}

/** Every percentage string used as a `left`/`width` on the timeline track. */
function timelinePercents(renderer: ReactTestRenderer): number[] {
  const [track] = hostByTestId(renderer, 'form-review-timeline');
  if (!track) throw new Error('no timeline');
  const values: number[] = [];
  for (const node of track.findAll(n => typeof n.type === 'string')) {
    const style = flatStyle(node);
    for (const key of ['left', 'width'] as const) {
      const raw = style[key];
      if (typeof raw === 'string' && raw.endsWith('%')) {
        values.push(Number.parseFloat(raw));
      }
    }
  }
  return values;
}

async function layoutTimeline(renderer: ReactTestRenderer, width = 300) {
  const [track] = renderer.root.findAll(
    node =>
      node.props.testID === 'form-review-timeline' &&
      typeof node.props.onLayout === 'function',
  );
  await act(async () => {
    track!.props.onLayout({
      nativeEvent: { layout: { x: 0, y: 0, width, height: 24 } },
    });
  });
}

async function scrubTo(
  renderer: ReactTestRenderer,
  locationX: number,
  release = true,
) {
  const [track] = renderer.root.findAll(
    node =>
      node.props.testID === 'form-review-timeline' &&
      typeof node.props.onResponderGrant === 'function',
  );
  await act(async () => {
    track!.props.onResponderGrant({ nativeEvent: { locationX } });
    if (release) track!.props.onResponderRelease();
  });
}

/**
 * Drive the JS clock tick by tick while playing and record every pause the
 * player takes (the clock text at each freeze). Stops when playback pauses or
 * the budget is exhausted.
 */
async function playUntilPause(
  renderer: ReactTestRenderer,
  budgetMs: number,
): Promise<{ pausedAt: string | null; percentsSeen: number[] }> {
  const percentsSeen: number[] = [];
  let elapsed = 0;
  while (elapsed < budgetMs) {
    await act(async () => {
      jest.advanceTimersByTime(34);
    });
    elapsed += 34;
    percentsSeen.push(...timelinePercents(renderer));
    if (playLabel(renderer) === 'Play replay') {
      return { pausedAt: clockText(renderer), percentsSeen };
    }
  }
  return { pausedAt: null, percentsSeen };
}

function player(
  overrides: Partial<React.ComponentProps<typeof FormReviewPlayer>> = {},
) {
  const sequence =
    overrides.sequence === undefined ? fullBodySequence() : overrides.sequence;
  const shot = overrides.analysis ?? analysis;
  return (
    <FormReviewPlayer
      analysis={shot}
      clip={{ uri: 'file:///captures/clip.mov', durationMs: 3400 }}
      review={review}
      sequence={sequence}
      script={buildFormReviewScript(shot, sequence)}
      {...overrides}
    />
  );
}

beforeEach(() => {
  jest.useFakeTimers();
  nativeFake.available = false;
});

afterEach(async () => {
  for (const renderer of mounted.splice(0)) {
    await act(async () => {
      renderer.unmount();
    });
  }
  jest.useRealTimers();
});

// ─── S2 ─────────────────────────────────────────────────────────────────────

describe('attack4/S2 — priorityFix.checkpoint not in CHECKPOINTS', () => {
  const bogus = {
    ...analysis,
    priorityFix: {
      checkpoint: 'quantum_wrist_flux' as CheckpointKey,
      reasonKey: 'lowest_score',
      severity: 0.9,
      confidence: 0.8,
    },
  } as ShotAnalysis;

  it('the unknown priority is ignored: worst measured fault leads and no PRIORITY tag renders', async () => {
    const items = fixList(bogus);
    expect(items.map(item => item.key)).toEqual([
      'contact_position',
      'paddle_path',
      'athletic_base',
    ]);
    expect(items.some(item => item.isPriority)).toBe(false);

    const renderer = await render(<FixList analysis={bogus} />);
    const cards = renderer.root.findAll(
      node =>
        typeof node.type === 'string' &&
        typeof node.props.testID === 'string' &&
        node.props.testID.startsWith('fix-item-') &&
        !node.props.testID.endsWith('-review'),
    );
    expect(cards.map(card => card.props.testID)).toEqual([
      'fix-item-contact_position',
      'fix-item-paddle_path',
      'fix-item-athletic_base',
    ]);
    const copy = allText(renderer);
    expect(copy).not.toContain('PRIORITY');
    expect(copy).not.toContain('quantum');
    expect(copy).toContain('3 of 9 checkpoints');
  });

  it('a priorityFix naming an unknown key that ALSO appears in checkpoints never becomes an item or a drill focus', async () => {
    const corrupt = {
      ...bogus,
      checkpoints: [
        ...analysis.checkpoints,
        checkpoint('quantum_wrist_flux' as CheckpointKey, 12, 'red', 'late'),
      ],
    } as ShotAnalysis;
    const items = fixList(corrupt);
    expect(items[0]!.key).toBe('contact_position');
    expect(
      items.some(item => (item.key as string) === 'quantum_wrist_flux'),
    ).toBe(false);
    const renderer = await render(<FixList analysis={corrupt} />);
    expect(hostByTestId(renderer, 'fix-item-quantum_wrist_flux')).toHaveLength(
      0,
    );
    expect(allText(renderer)).not.toContain('quantum');
    // The drill focus is the worst KNOWN fault, not the corrupt row.
    expect(drillFocusFromAnalysis(corrupt)?.checkpoint).toBe(
      'contact_position',
    );
  });

  it('clean analysis + unknown priority naming a corrupt checkpoint row: no phantom fix; the documented priority fallback keys drills by FAMILY only', () => {
    const clean = {
      ...bogus,
      checkpoints: [
        checkpoint('ready_position', 85, 'green', 'none'),
        checkpoint('contact_position', 84, 'green', 'none'),
        checkpoint('quantum_wrist_flux' as CheckpointKey, 12, 'red', 'late'),
      ],
    } as ShotAnalysis;
    expect(fixList(clean)).toEqual([]);
    const focus = drillFocusFromAnalysis(clean);
    console.info(
      `[attack4/S2-clean-corrupt] drillFocusFromAnalysis → ${JSON.stringify(focus)}`,
    );
    // recommendedDrillsModel documents this fallback ("else the engine's own
    // priorityFix checkpoint when it carries an applicable, finite score");
    // the only field the drills surface consumes is the stroke FAMILY, which
    // comes from shotType, never from the unknown key.
    if (focus !== null) {
      expect(focus.family).toBe('drive');
      expect(focus.shotType).toBe('forehand_drive');
    }
  });

  it('the player verdict label for the unknown priority falls back to FIX (no PRIORITY FIX)', async () => {
    const script = buildFormReviewScript(bogus, fullBodySequence());
    const contact = script.stops.find(stop => stop.phase === 'contact')!;
    const renderer = await render(
      player({ analysis: bogus, script, initialStop: contact }),
    );
    const copy = allText(renderer);
    expect(copy).toContain('Contact position scored 48');
    expect(copy).not.toContain('PRIORITY');
  });
});

// ─── S3 ─────────────────────────────────────────────────────────────────────

describe('attack4/S3 — clip with durationMs: 0', () => {
  it('no division by zero: markers and knob stay within [0,100]% for the whole pass', async () => {
    const renderer = await render(
      player({ clip: { uri: 'file:///captures/clip.mov', durationMs: 0 } }),
    );
    const initial = timelinePercents(renderer);
    expect(initial.length).toBeGreaterThan(0);
    for (const value of initial) {
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(100);
    }
    // Markers are spread (not all collapsed on 0 or 100).
    const distinct = new Set(initial.map(v => Math.round(v)));
    expect(distinct.size).toBeGreaterThan(3);

    // Auto-pause off so a full pass runs to the end without stopping.
    await press(renderer, 'form-review-autopause');
    await press(renderer, 'form-review-play');
    const seen: number[] = [];
    for (let i = 0; i < 140 && playLabel(renderer) === 'Pause replay'; i++) {
      await act(async () => {
        jest.advanceTimersByTime(34);
      });
      seen.push(...timelinePercents(renderer));
    }
    expect(playLabel(renderer)).toBe('Play replay');
    expect(seen.length).toBeGreaterThan(100);
    for (const value of seen) {
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(100);
    }
    expect(Math.max(...seen)).toBe(100);
    // The clock never printed NaN/Infinity.
    expect(allText(renderer)).not.toMatch(/NaN|Infinity/);
  });

  it('scrubbing a zero-duration clip seeks by the measured extent, never by 0', async () => {
    const renderer = await render(
      player({ clip: { uri: 'file:///captures/clip.mov', durationMs: 0 } }),
    );
    await layoutTimeline(renderer, 300);
    await scrubTo(renderer, 150);
    const clock = Number.parseFloat(clockText(renderer));
    expect(Number.isFinite(clock)).toBe(true);
    expect(clock).toBeGreaterThan(1);
    expect(clock).toBeLessThan(3.5);
    for (const value of timelinePercents(renderer)) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(100);
    }
  });

  it.each([
    ['NaN', Number.NaN],
    ['negative', -500],
    ['-Infinity', Number.NEGATIVE_INFINITY],
  ])(
    'corrupt clip durationMs=%s falls back to the measured extent',
    async (_label, durationMs) => {
      const renderer = await render(
        player({ clip: { uri: 'file:///captures/clip.mov', durationMs } }),
      );
      await press(renderer, 'form-review-play');
      const result = await playUntilPause(renderer, 800);
      expect(result.pausedAt).toBe('0.45s');
      for (const value of result.percentsSeen) {
        expect(Number.isFinite(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(100);
      }
      expect(allText(renderer)).not.toMatch(/NaN|Infinity/);
    },
  );

  it('corrupt clip durationMs=+Infinity: no crash, positions clamp, the pass still pauses at the first stop', async () => {
    const renderer = await render(
      player({
        clip: {
          uri: 'file:///captures/clip.mov',
          durationMs: Number.POSITIVE_INFINITY,
        },
      }),
    );
    for (const value of timelinePercents(renderer)) {
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(100);
    }
    await press(renderer, 'form-review-play');
    const result = await playUntilPause(renderer, 800);
    console.info(
      `[attack4/S3-inf] pausedAt=${result.pausedAt} percents(max)=${Math.max(...result.percentsSeen)} clock=${clockText(renderer)}`,
    );
    expect(result.pausedAt).toBe('0.45s');
    expect(allText(renderer)).not.toMatch(/NaN|Infinity/);
  });

  it('no clip, empty sequence, no phases/timestamps: extent floors at 1s and nothing divides by zero', async () => {
    const bare = {
      ...analysis,
      phases: [],
      timestamps: {
        startMs: Number.NaN,
        contactMs: Number.NaN,
        endMs: Number.NaN,
      },
    } as unknown as ShotAnalysis;
    const empty: ReviewPoseSequence = {
      frames: [],
      video: { width: 1080, height: 1920, fps: 30 },
    };
    const renderer = await render(
      player({ analysis: bare, clip: null, sequence: empty }),
    );
    for (const value of timelinePercents(renderer)) {
      expect(Number.isFinite(value)).toBe(true);
    }
    await press(renderer, 'form-review-autopause');
    await press(renderer, 'form-review-play');
    for (let i = 0; i < 60 && playLabel(renderer) === 'Pause replay'; i++) {
      await act(async () => {
        jest.advanceTimersByTime(34);
      });
    }
    expect(playLabel(renderer)).toBe('Play replay');
    expect(clockText(renderer)).toBe('1.00s');
  });
});

// ─── S8 ─────────────────────────────────────────────────────────────────────

describe('attack4/S8 — scrub backwards past two visited stops with autoPause on', () => {
  it('both stops re-fire in order and none fires twice in one pass (timeline scrub)', async () => {
    const renderer = await render(player());
    await layoutTimeline(renderer, 340); // 340px ↔ 3400ms → 1px = 10ms
    const fired: string[] = [];

    // Pass 1: visit stop 1 (0.45s), stop 2 (1.20s), stop 3 (1.70s).
    for (const expected of ['0.45s', '1.20s', '1.70s']) {
      await press(renderer, 'form-review-play');
      const { pausedAt } = await playUntilPause(renderer, 1500);
      expect(pausedAt).toBe(expected);
      fired.push(pausedAt!);
    }
    expect(stopCounter(renderer)).toBe('STOP 3 OF 6');

    // Scrub back to 0.30s — before BOTH stop 1 and stop 2.
    await scrubTo(renderer, 30);
    expect(clockText(renderer)).toBe('0.30s');
    expect(playLabel(renderer)).toBe('Play replay');

    // Pass 2: the two passed stops re-fire, in order, exactly once each.
    const refired: string[] = [];
    for (let i = 0; i < 3; i++) {
      await press(renderer, 'form-review-play');
      const { pausedAt } = await playUntilPause(renderer, 1500);
      expect(pausedAt).not.toBeNull();
      refired.push(pausedAt!);
    }
    expect(refired).toEqual(['0.45s', '1.20s', '1.70s']);
    expect(new Set(refired).size).toBe(3);
  });

  it('prev-stop twice from stop 3 re-fires stop 2 then stop 3 (never the stop the playhead sits on)', async () => {
    const renderer = await render(player());
    for (const expected of ['0.45s', '1.20s', '1.70s']) {
      await press(renderer, 'form-review-play');
      expect((await playUntilPause(renderer, 1500)).pausedAt).toBe(expected);
    }
    await press(renderer, 'form-review-prev-stop');
    await press(renderer, 'form-review-prev-stop');
    expect(clockText(renderer)).toBe('0.45s');
    expect(stopCounter(renderer)).toBe('STOP 1 OF 6');
    const refired: string[] = [];
    for (let i = 0; i < 2; i++) {
      await press(renderer, 'form-review-play');
      refired.push((await playUntilPause(renderer, 1500)).pausedAt!);
    }
    expect(refired).toEqual(['1.20s', '1.70s']);
  });

  it('scrub back to EXACTLY a visited stop: that stop does not re-fire, the next does', async () => {
    const renderer = await render(player());
    await layoutTimeline(renderer, 340);
    for (const expected of ['0.45s', '1.20s']) {
      await press(renderer, 'form-review-play');
      expect((await playUntilPause(renderer, 1500)).pausedAt).toBe(expected);
    }
    await scrubTo(renderer, 45); // 0.45s exactly
    expect(clockText(renderer)).toBe('0.45s');
    await press(renderer, 'form-review-play');
    expect((await playUntilPause(renderer, 1500)).pausedAt).toBe('1.20s');
  });

  it('scrub without release (finger still down) then play: the pass still auto-pauses once the touch ends', async () => {
    const renderer = await render(player());
    await layoutTimeline(renderer, 340);
    await scrubTo(renderer, 30, false); // grant, no release
    await press(renderer, 'form-review-play');
    // While the finger is down auto-pause is suspended by design; the pass
    // must not fire a stop twice or skip forward. Release, then it resumes.
    const during = await playUntilPause(renderer, 300);
    console.info(
      `[attack4/S8-noRelease] paused during held scrub: ${during.pausedAt}; clock=${clockText(renderer)}`,
    );
    const [track] = renderer.root.findAll(
      node =>
        node.props.testID === 'form-review-timeline' &&
        typeof node.props.onResponderRelease === 'function',
    );
    await act(async () => {
      track!.props.onResponderRelease();
    });
    const after = await playUntilPause(renderer, 1500);
    if (during.pausedAt === null) {
      // Stop 1 (0.45s) was crossed while suspended and is NOT visited: the
      // player must not fire it late at a wrong frame; it fires the next.
      expect(after.pausedAt).toBe('1.20s');
    } else {
      expect(during.pausedAt).toBe('0.45s');
      expect(after.pausedAt).toBe('1.20s');
    }
  });

  it('rapid play/pause toggles never fire a stop twice; speed change mid-pass keeps order', async () => {
    const renderer = await render(player());
    const fired: string[] = [];
    for (let i = 0; i < 6; i++) {
      await press(renderer, 'form-review-play');
      await act(async () => {
        jest.advanceTimersByTime(34);
      });
      if (playLabel(renderer) === 'Play replay')
        fired.push(clockText(renderer));
      else await press(renderer, 'form-review-play');
    }
    await press(renderer, 'form-review-speed'); // next speed
    await press(renderer, 'form-review-play');
    let result = await playUntilPause(renderer, 4000);
    fired.push(result.pausedAt!);
    await press(renderer, 'form-review-play');
    result = await playUntilPause(renderer, 4000);
    fired.push(result.pausedAt!);
    console.info(`[attack4/S8-rapid] fired=${fired.join(',')}`);
    expect(fired).toEqual(['0.45s', '1.20s']);
  });
});

// ─── S9 ─────────────────────────────────────────────────────────────────────

describe('attack4/S9 — native player errors after the first auto-pause', () => {
  function nativeProps(renderer: ReactTestRenderer) {
    const [node] = hostByTestId(renderer, 'fake-clip-player');
    if (!node) throw new Error('no native clip player mounted');
    return node.props as {
      onProgress: (ms: number) => void;
      onError: () => void;
      onLoad: (ms: number) => void;
      onEnd: () => void;
      playing: boolean;
    };
  }

  it('visited stops persist, the JS clock resumes from the playhead, the clip-gone caption shows', async () => {
    nativeFake.available = true;
    const renderer = await render(player());
    expect(hostByTestId(renderer, 'fake-clip-player')).toHaveLength(1);
    expect(allText(renderer)).not.toContain('clip file is gone');

    // Native-driven pass: play, native reports 0.50s → auto-pause on stop 1.
    await press(renderer, 'form-review-play');
    expect(nativeProps(renderer).playing).toBe(true);
    await act(async () => {
      nativeProps(renderer).onProgress(500);
    });
    expect(playLabel(renderer)).toBe('Play replay');
    expect(clockText(renderer)).toBe('0.45s');
    expect(stopCounter(renderer)).toBe('STOP 1 OF 6');
    // No JS clock while native drives.
    await act(async () => {
      jest.advanceTimersByTime(500);
    });
    expect(clockText(renderer)).toBe('0.45s');

    // The stored file goes unreadable.
    await act(async () => {
      nativeProps(renderer).onError();
    });
    expect(hostByTestId(renderer, 'fake-clip-player')).toHaveLength(0);
    expect(allText(renderer)).toContain(
      'The clip file is gone from this device; the measured pose is shown instead.',
    );
    expect(clockText(renderer)).toBe('0.45s');

    // Resume: the JS clock starts at 0.45s, not 0; stop 1 does not re-fire.
    await press(renderer, 'form-review-play');
    await act(async () => {
      jest.advanceTimersByTime(34 * 3);
    });
    const resumed = Number.parseFloat(clockText(renderer));
    expect(resumed).toBeGreaterThan(0.5);
    expect(resumed).toBeLessThan(0.6);
    expect(playLabel(renderer)).toBe('Pause replay');
    const { pausedAt } = await playUntilPause(renderer, 1500);
    expect(pausedAt).toBe('1.20s');
    expect(stopCounter(renderer)).toBe('STOP 2 OF 6');
  });

  it('onError while PLAYING switches to the JS clock mid-flight without a reset', async () => {
    nativeFake.available = true;
    const renderer = await render(player());
    await press(renderer, 'form-review-autopause'); // off: no freeze at stop 1
    await press(renderer, 'form-review-play');
    await act(async () => {
      nativeProps(renderer).onProgress(1000);
    });
    expect(clockText(renderer)).toBe('1.00s');
    await act(async () => {
      nativeProps(renderer).onError();
    });
    expect(playLabel(renderer)).toBe('Pause replay');
    await act(async () => {
      jest.advanceTimersByTime(34 * 6);
    });
    const now = Number.parseFloat(clockText(renderer));
    expect(now).toBeGreaterThan(1.15);
    expect(now).toBeLessThan(1.3);
    expect(allText(renderer)).toContain('clip file is gone');
  });

  // Plane limit (Linux): whether Fabric still delivers a native progress
  // event to a view React has already unmounted cannot be established here;
  // this pins only that such a stale event cannot crash or corrupt the clock
  // into a non-finite value. The observed playhead is logged.
  it('a stale native progress callback after the error never crashes or produces a non-finite clock', async () => {
    nativeFake.available = true;
    const renderer = await render(player());
    await press(renderer, 'form-review-play');
    const native = nativeProps(renderer);
    await act(async () => {
      native.onProgress(500);
    });
    await act(async () => {
      native.onError();
    });
    await press(renderer, 'form-review-play');
    await act(async () => {
      jest.advanceTimersByTime(34 * 3);
    });
    const before = clockText(renderer);
    // A stale native callback from the torn-down layer.
    await act(async () => {
      native.onProgress(100);
    });
    console.info(
      `[attack4/S9-late-native] clock before stale progress=${before} after=${clockText(renderer)}`,
    );
    expect(Number.isFinite(Number.parseFloat(clockText(renderer)))).toBe(true);
    expect(playLabel(renderer)).toBe('Pause replay');
    expect(allText(renderer)).toContain('clip file is gone');
  });

  it('onError repeated + onError with no sequence: caption switches to the no-evidence copy', async () => {
    nativeFake.available = true;
    const renderer = await render(player({ sequence: null }));
    const native = nativeProps(renderer);
    await act(async () => {
      native.onError();
      native.onError();
    });
    expect(allText(renderer)).toContain(
      'No clip file or recorded pose is stored for this stroke on this device.',
    );
    expect(
      replayStageCaption(
        { uri: 'file:///captures/clip.mov', durationMs: 3400 },
        null,
        true,
      ),
    ).toContain('No clip file or recorded pose');
  });

  it('native onLoad reporting 0 or a negative duration is ignored', async () => {
    nativeFake.available = true;
    const renderer = await render(player());
    const native = nativeProps(renderer);
    await act(async () => {
      native.onLoad(0);
      native.onLoad(-1);
    });
    for (const value of timelinePercents(renderer)) {
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeLessThanOrEqual(100);
    }
    await act(async () => {
      native.onLoad(1000); // shorter than the last stop (2.8s)
    });
    for (const value of timelinePercents(renderer)) {
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeLessThanOrEqual(100);
    }
  });
});
