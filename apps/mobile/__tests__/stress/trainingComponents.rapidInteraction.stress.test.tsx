/**
 * Rapid / concurrent interaction stress harness for
 * `src/training/components.tsx` (SavedDrillCard + PlanDrillCard).
 *
 * Every iteration is a seeded burst of gestures against a freshly rendered
 * card (or a store-wired card list), replayable from its seed:
 *   - double / triple taps on one control
 *   - tap-during-transition (finger down, props flip, finger up)
 *   - simultaneous controls (interleaved gestures on different controls)
 *   - back during async (unmount while a request is in flight / while held)
 *   - spam navigation (media row hammered, including across media expiry)
 *   - mixed random sequences
 *
 * Gestures travel two paths:
 *   responder — the REAL React Native Pressability state machine on the host
 *               view (onStartShouldSetResponder → onResponderGrant →
 *               onResponderRelease), i.e. what a touch does on device;
 *   direct    — `onPress` on the Pressable after the same
 *               onStartShouldSetResponder gate, i.e. what
 *               @testing-library/react-native's fireEvent.press does.
 *
 * Campaign A (component): the card alone with counting callbacks. Oracle:
 *   exactly one callback per accepted gesture, correct media argument, no
 *   duplicate control, no console.error/warn (act warnings), no unhandled
 *   rejection, no timers left behind after unmount.
 * Campaign B (store-wired): the cards wired exactly as ResultScreen /
 *   LibraryScreen wire them (`busy={mutation !== 'idle'}`, bookmark →
 *   setDrillSaved, confirm → completePlanItem, media → async openMedia) over
 *   the real `useTrainingStore` and a deferred fake TrainingApi whose
 *   requests settle only when the script says so. Oracle: one request per
 *   accepted intent, never more than one mutation in flight, `mutation`
 *   back to 'idle' once every request settled (no orphan busy state), one
 *   consistency-ledger record per successful completion, store state equal
 *   to the fake server, plus the hygiene checks above.
 *
 * Knobs: STRESS_ITER (bursts per campaign, default 40 so the suite stays
 * fast), STRESS_SEED (replay one seed in both campaigns), STRESS_BASE_SEED
 * (first seed of the sweep, default 20260904), STRESS_OUT (write the
 * seed → outcome JSON table to this path).
 */
jest.mock('react-native-safe-area-context', () => {
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  return {
    SafeAreaView: View,
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
    initialWindowMetrics: null,
  };
});

const mockLedger: Array<{ id: string; slug: string }> = [];
jest.mock('../../src/consistency/store', () => ({
  useConsistencyStore: {
    getState: () => ({
      recordDrillCompletion: async (entry: { id: string; slug: string }) => {
        mockLedger.push({ id: entry.id, slug: entry.slug });
      },
    }),
  },
}));

import * as fs from 'fs';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { PlanDrillCard, SavedDrillCard } from '../../src/training/components';
import {
  clearTrainingStoreConfiguration,
  configureTrainingStore,
  useTrainingStore,
} from '../../src/training/store';
import {
  TrainingError,
  type CompletionEvidence,
  type DrillCompletion,
  type DrillDetail,
  type EmbeddedInstructionalMedia,
  type HostedInstructionalMedia,
  type InstructionalMedia,
  type SavedDrill,
  type TrainingApi,
  type TrainingPlan,
  type TrainingPlanItem,
} from '../../src/training/types';

type Renderer = TestRenderer.ReactTestRenderer;
type Instance = TestRenderer.ReactTestInstance;

// ---------------------------------------------------------------------------
// Knobs + seeded RNG
// ---------------------------------------------------------------------------

const ITER = Math.max(1, Number(process.env.STRESS_ITER ?? 40));
const BASE_SEED = Number(process.env.STRESS_BASE_SEED ?? 20260904);
const REPLAY_SEED =
  process.env.STRESS_SEED === undefined
    ? null
    : Number(process.env.STRESS_SEED);
const OUT = process.env.STRESS_OUT;

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
  int(n: number): number {
    return Math.floor(this.next() * n);
  }
  pick<T>(items: readonly T[]): T {
    return items[this.int(items.length)]!;
  }
  bool(p = 0.5): boolean {
    return this.next() < p;
  }
}

function seedsFor(campaignOffset: number): number[] {
  if (REPLAY_SEED !== null) return [REPLAY_SEED];
  return Array.from({ length: ITER }, (_, i) => BASE_SEED + campaignOffset + i);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW = new Date('2026-09-01T12:00:00.000Z').getTime();

const embedMedia: EmbeddedInstructionalMedia = {
  id: 'media-embed-1',
  kind: 'embed',
  provider: 'youtube',
  videoId: 'abc123XYZ',
  embedUrl: 'https://www.youtube-nocookie.com/embed/abc123XYZ',
  sourceUrl: 'https://www.youtube.com/watch?v=abc123XYZ',
  creatorName: 'Court Coach',
  licenseName: 'CC BY 4.0',
  licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
  attribution: 'Court Coach · CC BY 4.0',
};

function hostedMedia(expiresAtMs: number): HostedInstructionalMedia {
  return {
    id: 'media-hosted-1',
    kind: 'hosted',
    playbackUrl: 'https://media.example.test/dink.mp4?sig=1',
    expiresAt: new Date(expiresAtMs).toISOString(),
    sourceUrl: 'https://media.example.test/dink',
    creatorName: 'Hosted Coach',
    licenseName: 'Licensed',
    licenseUrl: null,
    attribution: 'Hosted Coach · Licensed',
  };
}

function detailFor(
  slug: string,
  title: string,
  media: InstructionalMedia[],
  saved: boolean,
): DrillDetail {
  return {
    id: `detail-${slug}`,
    slug,
    title,
    description: 'Feed balls and reset softly.',
    coachName: 'Coach Nakamura',
    equipment: [],
    difficultyMin: null,
    difficultyMax: null,
    saved,
    mappings: [
      {
        checkpoint: 'contact_height',
        shotType: 'dink',
        planRole: 'targeted',
        faultDirections: ['high'],
        cueText: 'Soft hands',
        targetSets: 3,
        targetRepetitionsPerSet: 12,
        targetDurationSeconds: null,
        restSeconds: 30,
      },
    ],
    instructionalMedia: media,
  };
}

function savedDrillFor(slug: string, title: string): SavedDrill {
  return {
    id: `saved-${slug}`,
    slug,
    title,
    description: 'Feed balls and reset softly.',
    coachName: 'Coach Nakamura',
    equipment: [],
    difficultyMin: null,
    difficultyMax: null,
    savedAt: new Date(NOW - 86_400_000).toISOString(),
  };
}

function planItemFor(
  id: string,
  position: number,
  slug: string,
  title: string,
  saved: boolean,
  completion: DrillCompletion | null,
): TrainingPlanItem {
  return {
    id,
    position,
    kind: position === 1 ? 'warmup' : 'targeted',
    drill: {
      slug,
      title,
      description: 'Feed balls and reset softly.',
      coachName: 'Coach Nakamura',
      equipment: [],
      saved,
    },
    cueText: 'Soft hands',
    targetSets: 3,
    targetRepetitionsPerSet: position === 1 ? 12 : null,
    targetDurationSeconds: position === 1 ? null : 45,
    restSeconds: 30,
    completion,
  };
}

// ---------------------------------------------------------------------------
// Gesture plumbing (real Pressability responder path + RNTL-style direct path)
// ---------------------------------------------------------------------------

type Control = 'bookmark' | 'media' | 'confirm';
type Path = 'responder' | 'direct';

function controlOf(label: unknown): Control | null {
  if (typeof label !== 'string') return null;
  if (label.startsWith('Watch reviewed instruction for ')) return 'media';
  if (
    label.startsWith('Confirm completion of ') ||
    label.endsWith(' completion logged')
  )
    return 'confirm';
  if (label.startsWith('Remove ') || label.startsWith('Save '))
    return 'bookmark';
  return null;
}

function hostPressables(renderer: Renderer): Instance[] {
  return renderer.root.findAll(
    node =>
      typeof node.type === 'string' &&
      typeof node.props.onResponderGrant === 'function' &&
      typeof node.props.onStartShouldSetResponder === 'function' &&
      controlOf(node.props.accessibilityLabel) !== null,
  );
}

function pressableComponents(renderer: Renderer): Instance[] {
  return renderer.root.findAll(
    node =>
      typeof node.type === 'function' &&
      node.type.name === 'Pressable' &&
      typeof node.props.onPress === 'function' &&
      controlOf(node.props.accessibilityLabel) !== null,
  );
}

const measureTarget = {
  measure(callback: (...values: number[]) => void) {
    callback(0, 0, 120, 44, 0, 0);
  },
};

function touchEvent() {
  return {
    persist() {},
    currentTarget: measureTarget,
    target: measureTarget,
    nativeEvent: {
      timestamp: Date.now(),
      pageX: 20,
      pageY: 20,
      locationX: 20,
      locationY: 20,
      touches: [],
      changedTouches: [],
      identifier: 1,
    },
  };
}

/** Host view of the requested control on card `card` (0-based order). */
function hostFor(
  renderer: Renderer,
  card: number,
  control: Control,
): Instance | null {
  const cards = groupByCard(hostPressables(renderer));
  const nodes = cards[card] ?? [];
  const matches = nodes.filter(
    node => controlOf(node.props.accessibilityLabel) === control,
  );
  if (matches.length > 1) {
    throw new Error(
      `duplicate control ${control} on card ${card}: ${matches.length}`,
    );
  }
  return matches[0] ?? null;
}

function componentFor(
  renderer: Renderer,
  card: number,
  control: Control,
): Instance | null {
  const cards = groupByCard(pressableComponents(renderer));
  const nodes = cards[card] ?? [];
  const matches = nodes.filter(
    node => controlOf(node.props.accessibilityLabel) === control,
  );
  if (matches.length > 1) {
    throw new Error(
      `duplicate control ${control} on card ${card}: ${matches.length}`,
    );
  }
  return matches[0] ?? null;
}

/**
 * Pressables appear in document order; a new card starts at every bookmark
 * (the first pressable each card renders).
 */
function groupByCard(nodes: Instance[]): Instance[][] {
  const cards: Instance[][] = [];
  for (const node of nodes) {
    if (
      controlOf(node.props.accessibilityLabel) === 'bookmark' ||
      !cards.length
    ) {
      cards.push([]);
    }
    cards[cards.length - 1]!.push(node);
  }
  return cards;
}

/** Finger down through the real responder system. True if RN accepted it. */
function responderDown(node: Instance): boolean {
  const accepted = Boolean(node.props.onStartShouldSetResponder());
  if (!accepted) return false;
  node.props.onResponderGrant(touchEvent());
  return true;
}

function responderUp(node: Instance): void {
  node.props.onResponderRelease(touchEvent());
}

/** RNTL fireEvent.press semantics: gated by onStartShouldSetResponder. */
function directPress(host: Instance, component: Instance): boolean {
  if (!host.props.onStartShouldSetResponder()) return false;
  component.props.onPress();
  return true;
}

// ---------------------------------------------------------------------------
// Hygiene monitors (console noise, unhandled rejections, leaked timers)
// ---------------------------------------------------------------------------

const consoleNoise: string[] = [];
const rejections: string[] = [];
let consoleErrorSpy: jest.SpyInstance;
let consoleWarnSpy: jest.SpyInstance;
const onRejection = (reason: unknown) => {
  rejections.push(String(reason));
};

beforeAll(() => {
  consoleErrorSpy = jest
    .spyOn(console, 'error')
    .mockImplementation((...args: unknown[]) => {
      consoleNoise.push(`error: ${args.map(String).join(' ')}`);
    });
  consoleWarnSpy = jest
    .spyOn(console, 'warn')
    .mockImplementation((...args: unknown[]) => {
      consoleNoise.push(`warn: ${args.map(String).join(' ')}`);
    });
  process.on('unhandledRejection', onRejection);
});

afterAll(() => {
  consoleErrorSpy.mockRestore();
  consoleWarnSpy.mockRestore();
  process.off('unhandledRejection', onRejection);
});

async function flushMicrotasks(rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

function drainHygiene(): string[] {
  const failures = consoleNoise.splice(0).concat(rejections.splice(0));
  return failures;
}

// ---------------------------------------------------------------------------
// Result table
// ---------------------------------------------------------------------------

type Category =
  | 'doubleTap'
  | 'tripleTap'
  | 'tapDuringTransition'
  | 'simultaneousControls'
  | 'backDuringAsync'
  | 'spamNavigation'
  | 'mixed';

const CATEGORIES: readonly Category[] = [
  'doubleTap',
  'tripleTap',
  'tapDuringTransition',
  'simultaneousControls',
  'backDuringAsync',
  'spamNavigation',
  'mixed',
];

interface Row {
  campaign: 'component' | 'store';
  seed: number;
  category: Category;
  script: string;
  outcome: 'HELD' | 'BROKEN';
  metrics: Record<string, number>;
  failures: string[];
}

const rows: Row[] = [];

afterAll(() => {
  const broken = rows.filter(row => row.outcome === 'BROKEN');
  const summary = {
    generatedAt: new Date().toISOString(),
    iterPerCampaign: ITER,
    baseSeed: BASE_SEED,
    replaySeed: REPLAY_SEED,
    executed: rows.length,
    held: rows.length - broken.length,
    broken: broken.length,
    brokenSeeds: broken.map(row => `${row.campaign}:${row.seed}`),
    byCategory: CATEGORIES.map(category => ({
      category,
      executed: rows.filter(row => row.category === category).length,
      broken: broken.filter(row => row.category === category).length,
    })),
    totals: rows.reduce<Record<string, number>>((acc, row) => {
      for (const [key, value] of Object.entries(row.metrics)) {
        acc[key] = (acc[key] ?? 0) + value;
      }
      return acc;
    }, {}),
    rows,
  };
  if (OUT) fs.writeFileSync(OUT, JSON.stringify(summary, null, 2));
  process.stdout.write(
    `[stress:cmp-training-components:rapid-interaction] executed=${summary.executed} held=${summary.held} broken=${summary.broken}${
      broken.length ? ` seeds=${summary.brokenSeeds.join(',')}` : ''
    }\n`,
  );
});

// ---------------------------------------------------------------------------
// Campaign A — component alone
// ---------------------------------------------------------------------------

interface ModelA {
  card: 'saved' | 'plan';
  busy: boolean;
  saved: boolean;
  complete: boolean;
  media: 'embed' | 'hosted' | 'none';
  hostedExpiresAt: number;
}

type StepA =
  | { kind: 'tap'; control: Control; path: Path }
  | { kind: 'down'; control: Control }
  | { kind: 'up'; control: Control }
  | { kind: 'flip'; prop: 'busy' | 'saved' | 'complete' }
  | { kind: 'advance'; ms: number }
  | { kind: 'unmount' };

function describeA(step: StepA): string {
  switch (step.kind) {
    case 'tap':
      return `${step.path === 'responder' ? 'tap' : 'press'}(${step.control})`;
    case 'down':
      return `down(${step.control})`;
    case 'up':
      return `up(${step.control})`;
    case 'flip':
      return `flip(${step.prop})`;
    case 'advance':
      return `advance(${step.ms})`;
    case 'unmount':
      return 'unmount';
  }
}

function controlsFor(model: ModelA): Control[] {
  const controls: Control[] = ['bookmark', 'media'];
  if (model.card === 'plan') controls.push('confirm');
  return controls;
}

function scriptA(rng: Rng, category: Category, model: ModelA): StepA[] {
  const controls = controlsFor(model);
  const control = rng.pick(controls);
  const path = (): Path => (rng.bool(0.6) ? 'responder' : 'direct');
  const tap = (c: Control): StepA => ({
    kind: 'tap',
    control: c,
    path: path(),
  });
  const maybeGap = (): StepA[] =>
    rng.bool(0.4)
      ? [{ kind: 'advance', ms: rng.pick([0, 8, 16, 50, 120]) }]
      : [];
  switch (category) {
    case 'doubleTap':
      return [tap(control), ...maybeGap(), tap(control)];
    case 'tripleTap':
      return [
        tap(control),
        ...maybeGap(),
        tap(control),
        ...maybeGap(),
        tap(control),
      ];
    case 'tapDuringTransition': {
      const flips: Array<'busy' | 'saved' | 'complete'> =
        model.card === 'plan' ? ['busy', 'saved', 'complete'] : ['busy'];
      const steps: StepA[] = [{ kind: 'down', control }];
      const flipCount = 1 + rng.int(2);
      for (let i = 0; i < flipCount; i += 1) {
        steps.push({ kind: 'flip', prop: rng.pick(flips) });
        if (rng.bool(0.3))
          steps.push({ kind: 'advance', ms: rng.pick([16, 200, 600]) });
      }
      steps.push({ kind: 'up', control });
      if (rng.bool(0.5)) steps.push(tap(control));
      return steps;
    }
    case 'simultaneousControls': {
      const other = rng.pick(controls.filter(c => c !== control));
      if (rng.bool(0.5)) {
        // Two fingers: A goes down, B is tapped, A is released.
        return [
          { kind: 'down', control },
          tap(other),
          ...(rng.bool(0.5) ? [tap(other)] : []),
          { kind: 'up', control },
        ];
      }
      return [
        { kind: 'tap', control, path: 'direct' },
        { kind: 'tap', control: other, path: 'direct' },
        { kind: 'tap', control, path: 'direct' },
      ];
    }
    case 'backDuringAsync':
      return rng.bool(0.5)
        ? [tap(control), { kind: 'flip', prop: 'busy' }, { kind: 'unmount' }]
        : [{ kind: 'down', control }, { kind: 'unmount' }];
    case 'spamNavigation': {
      const steps: StepA[] = [];
      const taps = 3 + rng.int(4);
      for (let i = 0; i < taps; i += 1) {
        steps.push(tap('media'));
        if (rng.bool(0.25))
          steps.push({ kind: 'advance', ms: rng.pick([16, 400, 2_000]) });
        if (rng.bool(0.2)) steps.push({ kind: 'flip', prop: 'busy' });
      }
      return steps;
    }
    case 'mixed': {
      const steps: StepA[] = [];
      const held = new Set<Control>();
      const count = 4 + rng.int(7);
      for (let i = 0; i < count; i += 1) {
        const roll = rng.int(10);
        const c = rng.pick(controls);
        if (roll < 4) {
          if (!held.has(c)) steps.push(tap(c));
        } else if (roll < 6 && !held.has(c)) {
          held.add(c);
          steps.push({ kind: 'down', control: c });
        } else if (roll < 8 && held.size) {
          const h = [...held][0]!;
          held.delete(h);
          steps.push({ kind: 'up', control: h });
        } else if (roll < 9) {
          steps.push({
            kind: 'flip',
            prop:
              model.card === 'plan'
                ? rng.pick(['busy', 'saved', 'complete'])
                : 'busy',
          });
        } else steps.push({ kind: 'advance', ms: rng.pick([0, 16, 100, 700]) });
      }
      for (const h of held) steps.push({ kind: 'up', control: h });
      if (rng.bool(0.3)) steps.push({ kind: 'unmount' });
      return steps;
    }
  }
}

const completionFixture: DrillCompletion = {
  id: 'completion-1',
  completedAt: new Date(NOW - 3_600_000).toISOString(),
  actualRepetitions: 36,
  actualDurationSeconds: null,
  qualifiesForStreak: true,
};

interface MediaCall {
  media: InstructionalMedia;
  at: number;
}

function elementA(
  model: ModelA,
  calls: { bookmark: number; confirm: number; media: MediaCall[] },
) {
  const media: InstructionalMedia[] =
    model.media === 'embed'
      ? [embedMedia]
      : model.media === 'hosted'
        ? [hostedMedia(model.hostedExpiresAt)]
        : [];
  const detail = detailFor('soft-reset', 'Soft Reset', media, model.saved);
  if (model.card === 'saved') {
    return (
      <SavedDrillCard
        drill={savedDrillFor('soft-reset', 'Soft Reset')}
        detail={detail}
        busy={model.busy}
        onUnsave={() => {
          calls.bookmark += 1;
        }}
        onOpenMedia={m => {
          calls.media.push({ media: m, at: Date.now() });
        }}
      />
    );
  }
  return (
    <PlanDrillCard
      item={planItemFor(
        'item-1',
        1,
        'soft-reset',
        'Soft Reset',
        model.saved,
        model.complete ? completionFixture : null,
      )}
      detail={detail}
      busy={model.busy}
      onToggleSaved={() => {
        calls.bookmark += 1;
      }}
      onConfirmComplete={() => {
        calls.confirm += 1;
      }}
      onOpenMedia={m => {
        calls.media.push({ media: m, at: Date.now() });
      }}
    />
  );
}

async function runComponentBurst(seed: number): Promise<Row> {
  const rng = new Rng(seed);
  const category = CATEGORIES[seed % CATEGORIES.length]!;
  const model: ModelA = {
    card: rng.bool(0.5) ? 'saved' : 'plan',
    busy: rng.bool(0.2),
    saved: rng.bool(0.5),
    complete: false,
    media: rng.pick(['embed', 'hosted', 'hosted', 'none']),
    hostedExpiresAt: NOW + rng.pick([500, 1_000, 5_000, 3_600_000]),
  };
  const steps = scriptA(rng, category, model);
  const calls = { bookmark: 0, confirm: 0, media: [] as MediaCall[] };
  const expected = { bookmark: 0, confirm: 0, media: 0 };
  const metrics = {
    gestures: 0,
    accepted: 0,
    refused: 0,
    missingControl: 0,
    releasedWhileDisabled: 0,
    staleMediaDelivered: 0,
  };
  const failures: string[] = [];
  const held = new Map<Control, { enabledAtGrant: boolean }>();
  let mounted = true;

  jest.useFakeTimers({ now: NOW });
  let renderer!: Renderer;
  act(() => {
    renderer = TestRenderer.create(elementA(model, calls));
  });
  const rerender = () => {
    act(() => {
      renderer.update(elementA(model, calls));
    });
  };

  const enabledNow = (control: Control): boolean => {
    if (control === 'media') return true;
    if (control === 'bookmark') return !model.busy;
    return !model.busy && !model.complete;
  };

  try {
    for (const step of steps) {
      if (!mounted && step.kind !== 'advance') break;
      switch (step.kind) {
        case 'tap': {
          metrics.gestures += 1;
          const host = hostFor(renderer, 0, step.control);
          if (!host) {
            metrics.missingControl += 1;
            break;
          }
          let accepted = false;
          act(() => {
            if (step.path === 'responder') {
              accepted = responderDown(host);
              if (accepted) responderUp(host);
            } else {
              const component = componentFor(renderer, 0, step.control);
              accepted = component ? directPress(host, component) : false;
            }
          });
          if (accepted !== enabledNow(step.control)) {
            failures.push(
              `${describeA(step)}: RN accepted=${accepted} but control enabled=${enabledNow(step.control)}`,
            );
          }
          if (accepted) {
            metrics.accepted += 1;
            expected[step.control] += 1;
          } else metrics.refused += 1;
          break;
        }
        case 'down': {
          metrics.gestures += 1;
          const host = hostFor(renderer, 0, step.control);
          if (!host) {
            metrics.missingControl += 1;
            break;
          }
          let accepted = false;
          act(() => {
            accepted = responderDown(host);
          });
          if (accepted !== enabledNow(step.control)) {
            failures.push(
              `${describeA(step)}: RN accepted=${accepted} but control enabled=${enabledNow(step.control)}`,
            );
          }
          if (accepted) held.set(step.control, { enabledAtGrant: true });
          else metrics.refused += 1;
          break;
        }
        case 'up': {
          const grant = held.get(step.control);
          held.delete(step.control);
          if (!grant) break;
          const host = hostFor(renderer, 0, step.control);
          if (!host) {
            // Control left the tree while held (e.g. media expired after a
            // re-render): Pressability was reset on unmount, nothing fires.
            metrics.missingControl += 1;
            break;
          }
          act(() => {
            responderUp(host);
          });
          // Pressability gates `disabled` at grant, not at release: a press
          // that started on an enabled control fires once even if the
          // control was disabled while the finger was down.
          metrics.accepted += 1;
          expected[step.control] += 1;
          if (!enabledNow(step.control)) metrics.releasedWhileDisabled += 1;
          break;
        }
        case 'flip': {
          if (step.prop === 'busy') model.busy = !model.busy;
          else if (step.prop === 'saved') model.saved = !model.saved;
          else model.complete = !model.complete;
          rerender();
          break;
        }
        case 'advance':
          act(() => {
            jest.advanceTimersByTime(step.ms);
          });
          break;
        case 'unmount':
          act(() => {
            renderer.unmount();
          });
          mounted = false;
          held.clear();
          break;
      }
    }
    await flushMicrotasks();
    if (mounted) {
      act(() => {
        renderer.unmount();
      });
      mounted = false;
    }
    // Anything the card left behind (press animations, long-press timers)
    // must drain within the animation budget; async `act` scopes schedule
    // their own flush timers, so no async flush may follow this point.
    act(() => {
      jest.advanceTimersByTime(5_000);
    });

    if (calls.bookmark !== expected.bookmark) {
      failures.push(
        `bookmark handler calls=${calls.bookmark} expected=${expected.bookmark}`,
      );
    }
    if (calls.confirm !== expected.confirm) {
      failures.push(
        `confirm handler calls=${calls.confirm} expected=${expected.confirm}`,
      );
    }
    if (calls.media.length !== expected.media) {
      failures.push(
        `media handler calls=${calls.media.length} expected=${expected.media}`,
      );
    }
    for (const { media, at } of calls.media) {
      if (
        media.kind === 'hosted' &&
        new Date(media.expiresAt).getTime() <= at
      ) {
        // The card computes the playable media at render time; a tap after
        // expiry (no re-render) forwards the expired item. Tracked, not
        // failed at the component level — the parent's openMedia handles the
        // failed open with a retry dialog.
        metrics.staleMediaDelivered += 1;
      }
      if (
        (model.media === 'embed' && media.id !== embedMedia.id) ||
        (model.media === 'hosted' && media.id !== 'media-hosted-1')
      ) {
        failures.push(`media handler received wrong media ${media.id}`);
      }
    }
    const leakedTimers = jest.getTimerCount();
    if (leakedTimers !== 0)
      failures.push(`timers still pending after unmount: ${leakedTimers}`);
  } catch (error) {
    failures.push(`threw: ${String(error)}`);
    if (mounted) {
      try {
        act(() => {
          renderer.unmount();
        });
      } catch {
        // already unmounted
      }
    }
  } finally {
    jest.useRealTimers();
  }
  failures.push(...drainHygiene());
  return {
    campaign: 'component',
    seed,
    category,
    script: `${model.card}${model.busy ? '[busy]' : ''}${model.saved ? '[saved]' : ''}[${model.media}${
      model.media === 'hosted' ? `+${model.hostedExpiresAt - NOW}ms` : ''
    }] ${steps.map(describeA).join(' ')}`,
    outcome: failures.length ? 'BROKEN' : 'HELD',
    metrics,
    failures,
  };
}

// ---------------------------------------------------------------------------
// Campaign B — cards wired to the real training store + deferred fake API
// ---------------------------------------------------------------------------

interface Pending {
  kind: 'save' | 'unsave' | 'complete';
  slug: string;
  evidence: CompletionEvidence | null;
  resolve: () => void;
  reject: (error: Error) => void;
}

class DeferredApi implements TrainingApi {
  readonly pending: Pending[] = [];
  readonly server = {
    saved: new Set<string>(),
    completions: new Map<string, DrillCompletion>(),
  };
  requests = 0;
  maxInFlight = 0;
  readonly details: Record<string, DrillDetail>;

  constructor(details: Record<string, DrillDetail>, saved: string[]) {
    this.details = details;
    for (const slug of saved) this.server.saved.add(slug);
  }

  private defer(
    kind: Pending['kind'],
    slug: string,
    evidence: CompletionEvidence | null,
  ) {
    this.requests += 1;
    return new Promise<void>((resolve, reject) => {
      this.pending.push({ kind, slug, evidence, resolve, reject });
      this.maxInFlight = Math.max(this.maxInFlight, this.pending.length);
    });
  }

  async listSavedDrills(): Promise<SavedDrill[]> {
    return [...this.server.saved].map(slug =>
      savedDrillFor(slug, this.details[slug]?.title ?? slug),
    );
  }
  async getDrill(slug: string): Promise<DrillDetail> {
    const detail = this.details[slug];
    if (!detail)
      throw new TrainingError(
        'training.not_found',
        'Unknown drill.',
        false,
        404,
      );
    return { ...detail, saved: this.server.saved.has(slug) };
  }
  saveDrill(slug: string): Promise<void> {
    return this.defer('save', slug, null);
  }
  unsaveDrill(slug: string): Promise<void> {
    return this.defer('unsave', slug, null);
  }
  async getCurrentPlan(): Promise<TrainingPlan | null> {
    return null;
  }
  async createPlan(): Promise<TrainingPlan> {
    throw new TrainingError('training.unavailable', 'not exercised', true);
  }
  async completeDrill(evidence: CompletionEvidence): Promise<DrillCompletion> {
    await this.defer('complete', evidence.drillSlug, evidence);
    const completion: DrillCompletion = {
      id: evidence.id,
      completedAt: evidence.completedAt,
      actualRepetitions: evidence.actualRepetitions,
      actualDurationSeconds: evidence.actualDurationSeconds,
      qualifiesForStreak: true,
    };
    this.server.completions.set(evidence.trainingPlanItemId, completion);
    return completion;
  }
  async reassessPlan(): Promise<TrainingPlan> {
    throw new TrainingError('training.unavailable', 'not exercised', true);
  }

  /** Settle the oldest in-flight mutation. Returns false if none. */
  settleOne(fail: boolean): boolean {
    const next = this.pending.shift();
    if (!next) return false;
    if (fail) {
      next.reject(
        new TrainingError(
          'training.unavailable',
          'Training is temporarily unavailable.',
          true,
          503,
        ),
      );
      return true;
    }
    if (next.kind === 'save') this.server.saved.add(next.slug);
    if (next.kind === 'unsave') this.server.saved.delete(next.slug);
    next.resolve();
    return true;
  }
}

const PLAN_SLUGS = [
  'soft-reset',
  'third-shot-drop',
  'kitchen-footwork',
] as const;

function planFixture(rng: Rng): TrainingPlan {
  return {
    id: 'plan-1',
    status: 'active',
    algorithmVersion: 'v1',
    sourceShotId: 'shot-1',
    shotType: 'dink',
    priorityCheckpoint: 'contact_height',
    priorityDirection: 'high',
    baselineScore: 61,
    baselineCheckpointScore: 48,
    reassessmentShotId: null,
    scoreDelta: null,
    createdAt: new Date(NOW - 7_200_000).toISOString(),
    completedAt: null,
    items: PLAN_SLUGS.map((slug, index) =>
      planItemFor(
        `item-${index + 1}`,
        index + 1,
        slug,
        titleFor(slug),
        rng.bool(0.4),
        null,
      ),
    ),
  };
}

function titleFor(slug: string): string {
  return slug
    .split('-')
    .map(part => part[0]!.toUpperCase() + part.slice(1))
    .join(' ');
}

interface Wired {
  navigations: string[];
  callbackInvocations: number;
  expectedRequests: number;
}

/** Mirrors ResultScreen (plan cards) + LibraryScreen (saved cards) wiring. */
function WiredCards(props: { wired: Wired }) {
  const mutation = useTrainingStore(state => state.mutation);
  const currentPlan = useTrainingStore(state => state.currentPlan);
  const savedDrills = useTrainingStore(state => state.savedDrills);
  const drillDetails = useTrainingStore(state => state.drillDetails);
  const setDrillSaved = useTrainingStore(state => state.setDrillSaved);
  const completePlanItem = useTrainingStore(state => state.completePlanItem);
  const busy = mutation !== 'idle';
  const openMedia = async (media: InstructionalMedia) => {
    await Promise.resolve();
    props.wired.navigations.push(media.id);
  };
  const noteIntent = (wouldRequest: boolean) => {
    props.wired.callbackInvocations += 1;
    if (wouldRequest && useTrainingStore.getState().mutation === 'idle') {
      props.wired.expectedRequests += 1;
    }
  };
  const prescribed = currentPlan?.items.filter(item => item.drill) ?? [];
  return (
    <>
      {prescribed.map(item => (
        <PlanDrillCard
          key={item.id}
          item={item}
          detail={item.drill ? drillDetails[item.drill.slug] : undefined}
          busy={busy}
          onToggleSaved={() => {
            noteIntent(Boolean(item.drill));
            if (item.drill)
              void setDrillSaved(item.drill.slug, !item.drill.saved);
          }}
          onConfirmComplete={() => {
            noteIntent(Boolean(item.drill) && item.completion === null);
            void completePlanItem(item);
          }}
          onOpenMedia={media => void openMedia(media)}
        />
      ))}
      {savedDrills.map(drill => (
        <SavedDrillCard
          key={drill.slug}
          drill={drill}
          detail={drillDetails[drill.slug]}
          busy={busy}
          onUnsave={() => {
            noteIntent(true);
            void setDrillSaved(drill.slug, false);
          }}
          onOpenMedia={media => void openMedia(media)}
        />
      ))}
    </>
  );
}

type StepB =
  | { kind: 'tap'; card: number; control: Control; path: Path }
  | { kind: 'down'; card: number; control: Control }
  | { kind: 'up'; card: number; control: Control }
  | { kind: 'settle'; fail: boolean }
  | { kind: 'advance'; ms: number }
  | { kind: 'unmount' };

function describeB(step: StepB): string {
  switch (step.kind) {
    case 'tap':
      return `${step.path === 'responder' ? 'tap' : 'press'}(${step.card}.${step.control})`;
    case 'down':
      return `down(${step.card}.${step.control})`;
    case 'up':
      return `up(${step.card}.${step.control})`;
    case 'settle':
      return step.fail ? 'settle(fail)' : 'settle(ok)';
    case 'advance':
      return `advance(${step.ms})`;
    case 'unmount':
      return 'unmount';
  }
}

function scriptB(rng: Rng, category: Category, cards: number): StepB[] {
  const controls: Control[] = ['bookmark', 'media', 'confirm'];
  const path = (): Path => (rng.bool(0.6) ? 'responder' : 'direct');
  const card = rng.int(cards);
  const control = rng.pick(controls);
  const tap = (c: number, k: Control): StepB => ({
    kind: 'tap',
    card: c,
    control: k,
    path: path(),
  });
  const settle = (): StepB => ({ kind: 'settle', fail: rng.bool(0.25) });
  const settleAll: StepB[] = [settle(), settle(), settle(), settle()];
  switch (category) {
    case 'doubleTap':
      return [tap(card, control), tap(card, control), ...settleAll];
    case 'tripleTap':
      return [
        tap(card, control),
        tap(card, control),
        ...(rng.bool(0.5) ? [settle()] : []),
        tap(card, control),
        ...settleAll,
      ];
    case 'tapDuringTransition': {
      let other = rng.int(cards);
      let otherControl = rng.pick(['bookmark', 'confirm'] as const);
      if (other === card && otherControl === control) {
        // Never re-grant the held control: RN's responder system hands a
        // second finger on the responder view to the same Pressability.
        other = (card + 1) % cards;
        otherControl = control === 'bookmark' ? 'confirm' : 'bookmark';
      }
      return [
        { kind: 'down', card, control },
        tap(other, otherControl),
        ...(rng.bool(0.5) ? [settle()] : []),
        { kind: 'up', card, control },
        tap(card, control),
        ...settleAll,
      ];
    }
    case 'simultaneousControls': {
      const steps: StepB[] = [];
      const count = 3 + rng.int(4);
      for (let i = 0; i < count; i += 1) {
        steps.push({
          kind: 'tap',
          card: rng.int(cards),
          control: rng.pick(controls),
          path: 'direct',
        });
      }
      return [...steps, ...settleAll];
    }
    case 'backDuringAsync':
      return [
        tap(card, control),
        ...(rng.bool(0.5) ? [tap(rng.int(cards), rng.pick(controls))] : []),
        { kind: 'unmount' },
        ...settleAll,
      ];
    case 'spamNavigation': {
      const steps: StepB[] = [];
      const taps = 3 + rng.int(5);
      for (let i = 0; i < taps; i += 1) {
        steps.push(tap(rng.int(cards), 'media'));
        if (rng.bool(0.3))
          steps.push(
            tap(rng.int(cards), rng.pick(['bookmark', 'confirm'] as const)),
          );
        if (rng.bool(0.3))
          steps.push({ kind: 'advance', ms: rng.pick([16, 400, 2_000]) });
      }
      return [...steps, ...settleAll];
    }
    case 'mixed': {
      const steps: StepB[] = [];
      const held = new Set<string>();
      const count = 5 + rng.int(8);
      for (let i = 0; i < count; i += 1) {
        const roll = rng.int(12);
        const c = rng.int(cards);
        const k = rng.pick(controls);
        if (roll < 5) {
          if (!held.has(`${c}.${k}`)) steps.push(tap(c, k));
        } else if (roll < 7 && !held.has(`${c}.${k}`)) {
          held.add(`${c}.${k}`);
          steps.push({ kind: 'down', card: c, control: k });
        } else if (roll < 9 && held.size) {
          const key = [...held][0]!;
          held.delete(key);
          const [hc, hk] = key.split('.') as [string, Control];
          steps.push({ kind: 'up', card: Number(hc), control: hk });
        } else if (roll < 11) steps.push(settle());
        else steps.push({ kind: 'advance', ms: rng.pick([0, 16, 100, 700]) });
      }
      for (const key of held) {
        const [hc, hk] = key.split('.') as [string, Control];
        steps.push({ kind: 'up', card: Number(hc), control: hk });
      }
      if (rng.bool(0.25)) steps.push({ kind: 'unmount' });
      return [...steps, ...settleAll, ...settleAll];
    }
  }
}

async function runStoreBurst(seed: number): Promise<Row> {
  const rng = new Rng(seed);
  const category = CATEGORIES[seed % CATEGORIES.length]!;
  const plan = planFixture(rng);
  const savedSlugs = ['soft-reset', 'dink-ladder'].filter(() => rng.bool(0.6));
  const details: Record<string, DrillDetail> = {};
  for (const slug of [...PLAN_SLUGS, 'dink-ladder']) {
    const media = rng.pick<InstructionalMedia[]>([
      [embedMedia],
      [
        {
          ...hostedMedia(NOW + rng.pick([500, 5_000, 3_600_000])),
          id: `media-${slug}`,
        },
      ],
      [],
    ]);
    details[slug] = detailFor(
      slug,
      titleFor(slug),
      media,
      savedSlugs.includes(slug),
    );
  }
  for (const item of plan.items) {
    if (item.drill) item.drill.saved = savedSlugs.includes(item.drill.slug);
  }
  const savedDrills = savedSlugs.map(slug =>
    savedDrillFor(slug, titleFor(slug)),
  );
  const cardCount = plan.items.length + savedDrills.length;
  const steps = scriptB(rng, category, cardCount);

  const api = new DeferredApi(details, savedSlugs);
  mockLedger.length = 0;
  configureTrainingStore(api);
  useTrainingStore.setState({
    planStatus: 'ready',
    savedStatus: 'ready',
    currentPlan: plan,
    savedDrills,
    drillDetails: details,
  });

  const wired: Wired = {
    navigations: [],
    callbackInvocations: 0,
    expectedRequests: 0,
  };
  const metrics = {
    gestures: 0,
    accepted: 0,
    refused: 0,
    missingControl: 0,
    requests: 0,
    settledOk: 0,
    settledFail: 0,
    navigations: 0,
    ledgerRecords: 0,
    releasedWhileDisabled: 0,
  };
  const failures: string[] = [];
  const held = new Set<string>();
  let mounted = true;
  let mediaTapsAccepted = 0;

  jest.useFakeTimers({ now: NOW });
  let renderer!: Renderer;
  act(() => {
    renderer = TestRenderer.create(<WiredCards wired={wired} />);
  });

  const checkInFlight = (where: string) => {
    if (api.pending.length > 1) {
      failures.push(
        `${where}: ${api.pending.length} mutation requests in flight`,
      );
    }
    const mutation = useTrainingStore.getState().mutation;
    if (api.pending.length === 0 && mutation !== 'idle') {
      failures.push(`${where}: mutation=${mutation} with no request in flight`);
    }
  };

  try {
    for (const step of steps) {
      if (!mounted && step.kind !== 'settle' && step.kind !== 'advance')
        continue;
      switch (step.kind) {
        case 'tap': {
          metrics.gestures += 1;
          const host = hostFor(renderer, step.card, step.control);
          if (!host) {
            metrics.missingControl += 1;
            break;
          }
          const enabled = host.props.accessibilityState?.disabled !== true;
          let accepted = false;
          act(() => {
            if (step.path === 'responder') {
              accepted = responderDown(host);
              if (accepted) responderUp(host);
            } else {
              const component = componentFor(renderer, step.card, step.control);
              accepted = component ? directPress(host, component) : false;
            }
          });
          if (accepted !== enabled) {
            failures.push(
              `${describeB(step)}: accepted=${accepted} but a11y disabled=${!enabled}`,
            );
          }
          if (accepted) {
            metrics.accepted += 1;
            if (step.control === 'media') mediaTapsAccepted += 1;
          } else metrics.refused += 1;
          await flushMicrotasks(1);
          checkInFlight(describeB(step));
          break;
        }
        case 'down': {
          metrics.gestures += 1;
          const host = hostFor(renderer, step.card, step.control);
          if (!host) {
            metrics.missingControl += 1;
            break;
          }
          let accepted = false;
          act(() => {
            accepted = responderDown(host);
          });
          if (accepted) held.add(`${step.card}.${step.control}`);
          else metrics.refused += 1;
          break;
        }
        case 'up': {
          const key = `${step.card}.${step.control}`;
          if (!held.has(key)) break;
          held.delete(key);
          const host = hostFor(renderer, step.card, step.control);
          if (!host) {
            metrics.missingControl += 1;
            break;
          }
          const disabledNow = host.props.accessibilityState?.disabled === true;
          act(() => {
            responderUp(host);
          });
          metrics.accepted += 1;
          if (step.control === 'media') mediaTapsAccepted += 1;
          if (disabledNow) metrics.releasedWhileDisabled += 1;
          await flushMicrotasks(1);
          checkInFlight(describeB(step));
          break;
        }
        case 'settle': {
          const had = api.settleOne(step.fail);
          if (had) {
            if (step.fail) metrics.settledFail += 1;
            else metrics.settledOk += 1;
          }
          await flushMicrotasks(6);
          checkInFlight(describeB(step));
          break;
        }
        case 'advance':
          act(() => {
            jest.advanceTimersByTime(step.ms);
          });
          break;
        case 'unmount':
          act(() => {
            renderer.unmount();
          });
          mounted = false;
          held.clear();
          break;
      }
    }
    // Drain anything the script left in flight, then let the store settle.
    while (api.settleOne(false)) metrics.settledOk += 1;
    await flushMicrotasks(8);
    if (mounted) {
      act(() => {
        renderer.unmount();
      });
      mounted = false;
    }
    // No async `act` scope after this point (they schedule flush timers).
    act(() => {
      jest.advanceTimersByTime(5_000);
    });

    const state = useTrainingStore.getState();
    metrics.requests = api.requests;
    metrics.navigations = wired.navigations.length;
    metrics.ledgerRecords = mockLedger.length;

    if (state.mutation !== 'idle') {
      failures.push(
        `orphan mutation state after all requests settled: ${state.mutation}`,
      );
    }
    if (api.pending.length !== 0)
      failures.push(`requests never settled: ${api.pending.length}`);
    if (api.maxInFlight > 1)
      failures.push(`max concurrent mutation requests=${api.maxInFlight}`);
    if (api.requests !== wired.expectedRequests) {
      failures.push(
        `requests=${api.requests} but accepted intents while idle=${wired.expectedRequests}`,
      );
    }
    if (wired.navigations.length !== mediaTapsAccepted) {
      failures.push(
        `navigations=${wired.navigations.length} media taps=${mediaTapsAccepted}`,
      );
    }
    const completedOnServer = api.server.completions.size;
    if (mockLedger.length !== completedOnServer) {
      failures.push(
        `ledger records=${mockLedger.length} server completions=${completedOnServer}`,
      );
    }
    if (new Set(mockLedger.map(entry => entry.id)).size !== mockLedger.length) {
      failures.push('duplicate ledger record ids');
    }
    // Store ↔ server consistency (only meaningful if the host stayed mounted
    // or not — the store lives outside React either way).
    for (const item of state.currentPlan?.items ?? []) {
      if (!item.drill) continue;
      const serverCompletion = api.server.completions.get(item.id) ?? null;
      if ((item.completion?.id ?? null) !== (serverCompletion?.id ?? null)) {
        failures.push(
          `item ${item.id} completion=${item.completion?.id ?? null} server=${serverCompletion?.id ?? null}`,
        );
      }
      if (item.drill.saved !== api.server.saved.has(item.drill.slug)) {
        failures.push(
          `item ${item.id} saved=${item.drill.saved} server=${api.server.saved.has(item.drill.slug)}`,
        );
      }
    }
    const storeSaved = new Set(state.savedDrills.map(drill => drill.slug));
    for (const slug of api.server.saved) {
      if (!storeSaved.has(slug))
        failures.push(`server saved ${slug} missing from store savedDrills`);
    }
    for (const slug of storeSaved) {
      if (!api.server.saved.has(slug))
        failures.push(`store savedDrills has ${slug} but server does not`);
    }
    const leakedTimers = jest.getTimerCount();
    if (leakedTimers !== 0)
      failures.push(`timers still pending after unmount: ${leakedTimers}`);
  } catch (error) {
    failures.push(`threw: ${String(error)}`);
    if (mounted) {
      try {
        act(() => {
          renderer.unmount();
        });
      } catch {
        // already unmounted
      }
    }
  } finally {
    jest.useRealTimers();
    clearTrainingStoreConfiguration();
  }
  failures.push(...drainHygiene());
  return {
    campaign: 'store',
    seed,
    category,
    script: `cards=${cardCount} saved=[${savedSlugs.join(',')}] ${steps.map(describeB).join(' ')}`,
    outcome: failures.length ? 'BROKEN' : 'HELD',
    metrics,
    failures,
  };
}

// ---------------------------------------------------------------------------
// Suites
// ---------------------------------------------------------------------------

function report(row: Row): void {
  rows.push(row);
  if (row.outcome === 'BROKEN') {
    throw new Error(
      `seed ${row.seed} (${row.campaign}/${row.category}) BROKEN\n  script: ${row.script}\n  ${row.failures.join('\n  ')}`,
    );
  }
}

describe('stress: training/components.tsx rapid interaction (component)', () => {
  const seeds = seedsFor(0);
  test.each(seeds)('seed %i', async seed => {
    report(await runComponentBurst(seed));
  });
});

describe('stress: training/components.tsx rapid interaction (store-wired)', () => {
  const seeds = seedsFor(1_000_000);
  test.each(seeds)('seed %i', async seed => {
    report(await runStoreBurst(seed));
  });
});

describe('stress: campaign coverage', () => {
  test('every burst category ran in both campaigns', () => {
    if (REPLAY_SEED !== null) return;
    for (const campaign of ['component', 'store'] as const) {
      for (const category of CATEGORIES) {
        const ran = rows.some(
          row => row.campaign === campaign && row.category === category,
        );
        if (ITER >= 40)
          expect({ campaign, category, ran }).toEqual({
            campaign,
            category,
            ran: true,
          });
      }
    }
  });
});
