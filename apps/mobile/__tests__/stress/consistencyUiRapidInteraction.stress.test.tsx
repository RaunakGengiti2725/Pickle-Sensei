/**
 * STRESS — unit `cmp-consistency-ui`, lens `rapid-interaction`.
 *
 * Every interactive surface of the consistency UI (AchievementsShowcase,
 * ConsistencyCard, DaySecuredBanner, FlameIcon/AnimatedFlame, MilestoneBadge,
 * StreakCelebration) is driven by a seeded burst generator: double/triple
 * taps on the same control, simultaneous taps on different controls dispatched
 * from ONE commit (stale handlers, the real double-tap window), taps landing
 * mid-transition, hardware back racing an in-flight dismissal, and unmount
 * churn during animations.
 *
 * Invariants asserted per burst:
 *   - one side effect per intent (one selection fold, one navigation entry,
 *     one accessibility announcement per celebration, one banner consumption);
 *   - no duplicate modal and no duplicate detail panel;
 *   - no orphan state (a consumed "Day N secured" moment never returns);
 *   - no act() warnings, no console errors, no unhandled rejections.
 *
 * Replay any iteration from its seed:
 *   STRESS_SEEDS=<seed> npx jest --ci __tests__/stress/consistencyUiRapidInteraction
 * Bigger campaign / custom table location:
 *   STRESS_ITER=3000 STRESS_OUT=/tmp/table.json npx jest --ci …
 */
import React from 'react';
import { AccessibilityInfo, Modal, Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';

// The consistency store persists through SQLite; the native module is absent
// under jest, exactly like the existing consistency suites.
jest.mock('../../src/data/db', () => ({
  getDb: () => {
    throw new Error('no native sqlite in jest');
  },
}));

jest.mock('react-native-linear-gradient', () => {
  const ReactModule = require('react');
  const { View } = require('react-native');
  const MockGradient = (props: { children?: React.ReactNode }) =>
    ReactModule.createElement(View, null, props.children);
  return { __esModule: true, default: MockGradient };
});

jest.mock('react-native-safe-area-context', () => {
  const ReactModule = require('react');
  const { View } = require('react-native');
  return {
    SafeAreaView: (props: { children?: React.ReactNode; testID?: string }) =>
      ReactModule.createElement(View, { testID: props.testID }, props.children),
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  };
});

import { AchievementsShowcase } from '../../src/consistency/AchievementsShowcase';
import { ConsistencyCard } from '../../src/consistency/ConsistencyCard';
import { DaySecuredBanner } from '../../src/consistency/DaySecuredBanner';
import { AnimatedFlame } from '../../src/consistency/FlameIcon';
import { MilestoneBadge } from '../../src/consistency/MilestoneBadge';
import { StreakCelebration } from '../../src/consistency/StreakCelebration';
import {
  buildConsistencySnapshot,
  flameIntensityForStreak,
  type ConsistencySnapshot,
  type TrainingActivityInput,
} from '../../src/consistency/engine';
import { useConsistencyStore } from '../../src/consistency/store';
import type {
  ConsistencyCelebration,
  DaySecuredMoment,
} from '../../src/consistency/store';
import {
  setActiveDataOwner,
  SIGNED_OUT_DATA_OWNER,
} from '../../src/data/accountScope';
import { useReducedMotion } from '../../src/design/components';
import type { RootStackParams } from '../../src/navigation/params';
import {
  buildResultTable,
  installConsoleSentinel,
  installRejectionSentinel,
  iterationCount,
  rngFor,
  seedsFor,
  writeResultTable,
  type ConsoleSentinel,
  type IterationRecord,
  type RejectionSentinel,
  type Rng,
} from '../../test-support/stress/rapidInteractionHarness';

const BASE_SEED =
  Number.parseInt(process.env['STRESS_BASE_SEED'] ?? '', 10) || 0x51ea5e01;
const ENGINE_OPTIONS = { asOfIso: '2026-03-10T18:00:00.000Z', timeZone: 'UTC' };

/** ProgressScreen's wiring: `onPress={() => navigation.navigate('StreakCalendar')}`. */
const STREAK_ROUTE: keyof RootStackParams = 'StreakCalendar';

function strokes(days: readonly string[]): TrainingActivityInput[] {
  return days.map((day, index) => ({
    kind: 'stroke',
    atIso: `${day}T1${index % 8}:00:00.000Z`,
    shotType: index % 2 === 0 ? 'dink' : 'serve',
    overallScore: 6 + (index % 4) * 0.5,
    resultKind: 'scored',
  }));
}

const FRESH = buildConsistencySnapshot([], ENGINE_OPTIONS);
const THREE_DAYS = buildConsistencySnapshot(
  strokes(['2026-03-08', '2026-03-09', '2026-03-10']),
  ENGINE_OPTIONS,
);
const AT_RISK = buildConsistencySnapshot(
  strokes(['2026-03-07', '2026-03-08', '2026-03-09']),
  ENGINE_OPTIONS,
);
const VOLUME = buildConsistencySnapshot(
  Array.from({ length: 100 }, (_, index): TrainingActivityInput => ({
    kind: 'stroke',
    atIso: `2026-03-10T08:${String(index % 60).padStart(2, '0')}:00.000Z`,
    shotType: 'dink',
    overallScore: 7,
    resultKind: 'scored',
  })),
  ENGINE_OPTIONS,
);

const SNAPSHOTS: ReadonlyArray<ConsistencySnapshot> = [
  FRESH,
  THREE_DAYS,
  AT_RISK,
  VOLUME,
];

const CELEBRATIONS: ReadonlyArray<ConsistencyCelebration> = [
  {
    kind: 'streak',
    achievementId: 'streak.1',
    title: 'Day One',
    blurb: 'The first rep is the hardest.',
    reward: 'Starter badge',
    rarity: 'common',
    value: 1,
    streakAtCelebration: 1,
  },
  {
    kind: 'streak',
    achievementId: 'streak.7',
    title: 'Week One',
    blurb: 'A full week of real training.',
    reward: 'Streak Shield earned',
    rarity: 'uncommon',
    value: 7,
    streakAtCelebration: 7,
  },
  {
    kind: 'streak',
    achievementId: 'streak.30',
    title: '30 Day Club',
    blurb: 'A month of showing up.',
    reward: 'Exclusive profile frame',
    rarity: 'epic',
    value: 30,
    streakAtCelebration: 30,
  },
  {
    kind: 'volume',
    achievementId: 'volume.specialist',
    title: 'Serve Specialist',
    blurb: 'Twenty-five scored analyses of a single stroke.',
    reward: 'Technique crest',
    rarity: 'rare',
    value: 25,
    streakAtCelebration: 4,
    detail: 'serve',
  },
];

function momentFor(rng: Rng): DaySecuredMoment {
  const streak = rng.between(1, 42);
  return {
    day: '2026-03-10',
    streak,
    xpToday: rng.between(0, 60),
    shieldsAvailable: rng.between(0, 3),
    nextMilestone: rng.bool()
      ? { title: 'Week One', daysAway: rng.between(1, 6) }
      : null,
  };
}

type Instance = TestRenderer.ReactTestInstance;
type Renderer = TestRenderer.ReactTestRenderer;

function render(element: React.ReactElement): Renderer {
  let renderer!: Renderer;
  act(() => {
    renderer = TestRenderer.create(element);
  });
  return renderer;
}

function hosts(renderer: Renderer, testID: string): Instance[] {
  return renderer.root.findAll(
    node => typeof node.type === 'string' && node.props.testID === testID,
  );
}

/** The Pressable behind a PressableScale badge cell. */
function badgeButtons(renderer: Renderer): Instance[] {
  return renderer.root.findAll(
    node =>
      node.props.accessibilityRole === 'button' &&
      typeof node.props.onPress === 'function' &&
      typeof node.props.accessibilityLabel === 'string' &&
      typeof node.props.style === 'function',
  );
}

function pressableByTestId(renderer: Renderer, testID: string): Instance {
  const [node] = renderer.root.findAll(
    node =>
      node.props.testID === testID && typeof node.props.onPress === 'function',
  );
  if (!node) throw new Error(`no pressable with testID ${testID}`);
  return node;
}

function pressableByLabel(renderer: Renderer, label: string): Instance {
  const [node] = renderer.root.findAll(
    node =>
      node.props.accessibilityLabel === label &&
      typeof node.props.onPress === 'function',
  );
  if (!node) throw new Error(`no pressable labeled ${label}`);
  return node;
}

function allText(renderer: Renderer): string {
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

/** Live detail panels of the showcase (the only polite live region there). */
function detailPanels(renderer: Renderer): Instance[] {
  return renderer.root.findAll(
    node =>
      typeof node.type === 'string' &&
      node.props.accessibilityLiveRegion === 'polite' &&
      node.props.testID === undefined,
  );
}

function selectedBadges(renderer: Renderer): Instance[] {
  return badgeButtons(renderer).filter(
    node => node.props.accessibilityState?.selected === true,
  );
}

const BACKDROP_LABEL = 'Dismiss milestone celebration';
const CONTINUE_ID = 'streak-celebration-continue';
const HOLD_MS = 3600;

interface Burst {
  script: string[];
  interactions: number;
  failures: string[];
}

function check(burst: Burst, condition: boolean, message: string): void {
  if (!condition) burst.failures.push(message);
}

/**
 * Rapid taps on the trophy rail: same badge twice/three times, different
 * badges "simultaneously" (all handlers from one commit, dispatched in a
 * single act), and taps that land while the shimmer animation is running.
 */
function showcaseBadgeBurst(rng: Rng, burst: Burst): void {
  const snapshot = rng.pick(SNAPSHOTS);
  const dark = rng.bool();
  const renderer = render(
    <AchievementsShowcase snapshot={snapshot} dark={dark} />,
  );
  try {
    const buttons = badgeButtons(renderer);
    check(burst, buttons.length > 0, 'showcase rendered no badge buttons');
    if (buttons.length === 0) return;
    const titleOf = (node: Instance) =>
      String(node.props.accessibilityLabel).split('.')[0]!;

    const grouped = rng.bool(0.6);
    const taps = rng.between(2, 6);
    let target = rng.int(buttons.length);
    const sequence: number[] = [];
    for (let i = 0; i < taps; i += 1) {
      // 55% of taps repeat the previous control — the double/triple tap.
      if (!rng.bool(0.55)) target = rng.int(buttons.length);
      sequence.push(target);
    }
    let expected: number | null = null;
    for (const index of sequence) expected = expected === index ? null : index;

    burst.script.push(
      `showcase snapshot=${SNAPSHOTS.indexOf(snapshot)} dark=${dark} ${
        grouped ? 'grouped' : 'sequential'
      } taps=[${sequence.join(',')}]`,
    );
    burst.interactions += sequence.length;

    if (grouped) {
      act(() => {
        sequence.forEach((index, position) => {
          buttons[index]!.props.onPress();
          // Tap landing mid-transition of the previous one.
          if (position % 2 === 1) jest.advanceTimersByTime(rng.between(1, 24));
        });
      });
    } else {
      for (const index of sequence) {
        act(() => {
          badgeButtons(renderer)[index]!.props.onPress();
        });
        act(() => {
          jest.advanceTimersByTime(rng.between(1, 40));
        });
      }
    }

    const panels = detailPanels(renderer);
    const selected = selectedBadges(renderer);
    check(
      burst,
      panels.length === (expected === null ? 0 : 1),
      `expected ${expected === null ? 0 : 1} detail panel, saw ${
        panels.length
      }`,
    );
    check(
      burst,
      selected.length === (expected === null ? 0 : 1),
      `expected ${
        expected === null ? 0 : 1
      } selected badge, saw ${selected.length}`,
    );
    if (expected !== null) {
      const title = titleOf(buttons[expected]!).trim();
      check(
        burst,
        selected[0] !== undefined && titleOf(selected[0]).trim() === title,
        `selected badge is not the folded selection ${title}`,
      );
      check(
        burst,
        allText(renderer).includes(title),
        `detail panel does not show folded selection ${title}`,
      );
      check(
        burst,
        badgeButtons(renderer)[expected]!.props.accessibilityState?.selected ===
          true,
        `badge ${expected} is not the selected one after the burst`,
      );
    }
  } finally {
    act(() => renderer.unmount());
  }
}

/**
 * The milestone ceremony under a dismissal storm: Continue, backdrop and the
 * hardware back racing each other, sometimes all three from one commit, then
 * a fresh milestone arriving immediately after.
 */
function celebrationDismissBurst(rng: Rng, burst: Burst): void {
  const announce = jest
    .spyOn(AccessibilityInfo, 'announceForAccessibility')
    .mockImplementation(() => {});
  const first = rng.pick(CELEBRATIONS);
  act(() => {
    useConsistencyStore.setState({ celebration: first });
  });
  const renderer = render(<StreakCelebration />);
  try {
    check(
      burst,
      hosts(renderer, 'streak-celebration').length === 1,
      'celebration stage did not mount exactly once',
    );
    check(
      burst,
      announce.mock.calls.length === 1,
      `expected 1 announcement on show, saw ${announce.mock.calls.length}`,
    );

    const routes = ['continue', 'backdrop', 'back'] as const;
    const grouped = rng.bool(0.6);
    const taps = rng.between(2, 5);
    const sequence = Array.from({ length: taps }, () => rng.pick(routes));
    burst.script.push(
      `celebration=${first.achievementId} ${
        grouped ? 'grouped' : 'sequential'
      } dismiss=[${sequence.join(',')}]`,
    );
    burst.interactions += sequence.length;

    const fire = (route: (typeof routes)[number]) => {
      if (route === 'continue') {
        pressableByTestId(renderer, CONTINUE_ID).props.onPress();
        return;
      }
      if (route === 'backdrop') {
        pressableByLabel(renderer, BACKDROP_LABEL).props.onPress();
        return;
      }
      renderer.root.findAllByType(Modal)[0]!.props.onRequestClose();
    };

    if (grouped) {
      // Stale handlers from one commit: the real simultaneous-controls case.
      const handlers = sequence.map(route => {
        if (route === 'continue') {
          return pressableByTestId(renderer, CONTINUE_ID).props
            .onPress as () => void;
        }
        if (route === 'backdrop') {
          return pressableByLabel(renderer, BACKDROP_LABEL).props
            .onPress as () => void;
        }
        return renderer.root.findAllByType(Modal)[0]!.props
          .onRequestClose as () => void;
      });
      act(() => {
        handlers.forEach((handler, position) => {
          handler();
          if (position % 2 === 1) jest.advanceTimersByTime(rng.between(1, 30));
        });
      });
    } else {
      for (const route of sequence) {
        // Once dismissed the controls are gone; a real user's later taps in
        // the same burst land on the closing overlay and must be no-ops.
        const stillOpen = useConsistencyStore.getState().celebration !== null;
        act(() => {
          if (stillOpen) fire(route);
        });
        act(() => {
          jest.advanceTimersByTime(rng.between(1, 40));
        });
      }
    }

    check(
      burst,
      useConsistencyStore.getState().celebration === null,
      'celebration survived the dismissal storm',
    );
    const modals = renderer.root.findAllByType(Modal);
    check(burst, modals.length === 1, `expected 1 modal, saw ${modals.length}`);
    check(
      burst,
      modals[0]!.props.visible === false,
      'modal stayed visible after dismissal',
    );
    check(
      burst,
      hosts(renderer, 'streak-celebration').length === 0,
      'celebration stage stayed mounted after dismissal',
    );
    check(
      burst,
      announce.mock.calls.length === 1,
      `dismissal re-announced: ${announce.mock.calls.length} announcements`,
    );

    if (rng.bool(0.5)) {
      // A second milestone lands right on top of the closing ceremony.
      const second =
        CELEBRATIONS[
          (CELEBRATIONS.indexOf(first) + rng.between(1, 3)) %
            CELEBRATIONS.length
        ]!;
      act(() => {
        useConsistencyStore.setState({ celebration: second });
      });
      burst.script.push(`rearm=${second.achievementId}`);
      burst.interactions += 1;
      check(
        burst,
        hosts(renderer, 'streak-celebration').length === 1,
        're-armed ceremony did not render exactly one stage',
      );
      check(
        burst,
        renderer.root.findAllByType(Modal)[0]!.props.visible === true,
        're-armed ceremony left the modal hidden',
      );
      check(
        burst,
        announce.mock.calls.length === 2,
        `re-arm announced ${announce.mock.calls.length} times, expected 2`,
      );
      act(() => {
        pressableByTestId(renderer, CONTINUE_ID).props.onPress();
      });
      burst.interactions += 1;
      check(
        burst,
        useConsistencyStore.getState().celebration === null,
        're-armed ceremony could not be dismissed',
      );
      check(
        burst,
        hosts(renderer, 'streak-celebration').length === 0,
        're-armed stage stayed mounted after dismissal',
      );
    }
  } finally {
    act(() => renderer.unmount());
    announce.mockRestore();
    act(() => {
      useConsistencyStore.setState({ celebration: null });
    });
  }
}

/**
 * "Day N secured" is a one-shot moment. Two banners mounted in the same
 * commit race for it, the surface is torn down mid-hold (back during async),
 * and it must never come back.
 */
function daySecuredConsumptionRace(rng: Rng, burst: Burst): void {
  const moment = momentFor(rng);
  act(() => {
    useConsistencyStore.setState({ daySecured: moment });
  });
  const mounts = rng.between(1, 3);
  burst.script.push(`daySecured streak=${moment.streak} mounts=${mounts}`);
  burst.interactions += mounts;
  let renderer = render(
    <>
      {Array.from({ length: mounts }, (_, index) => (
        <DaySecuredBanner key={index} />
      ))}
    </>,
  );
  try {
    check(
      burst,
      hosts(renderer, 'day-secured-banner').length === 1,
      `expected exactly 1 banner for one moment, saw ${
        hosts(renderer, 'day-secured-banner').length
      }`,
    );
    check(
      burst,
      useConsistencyStore.getState().daySecured === null,
      'moment was not consumed by the banner',
    );
    check(
      burst,
      allText(renderer).includes(`Day ${moment.streak} secured`),
      'banner did not render the consumed moment',
    );

    const churns = rng.between(1, 3);
    for (let i = 0; i < churns; i += 1) {
      act(() => {
        jest.advanceTimersByTime(rng.between(1, HOLD_MS + 400));
      });
      act(() => renderer.unmount());
      renderer = render(<DaySecuredBanner />);
      burst.interactions += 1;
      check(
        burst,
        hosts(renderer, 'day-secured-banner').length === 0,
        'a consumed moment re-appeared on remount',
      );
      check(
        burst,
        useConsistencyStore.getState().daySecured === null,
        'a consumed moment was re-armed by a remount',
      );
    }
    act(() => {
      jest.advanceTimersByTime(2 * HOLD_MS);
    });
  } finally {
    act(() => renderer.unmount());
    act(() => {
      useConsistencyStore.setState({ daySecured: null });
    });
  }
}

/**
 * Spam-tapping the consistency card: the card must not amplify a press, and
 * ProgressScreen's `navigation.navigate('StreakCalendar')` wiring must leave
 * exactly one calendar entry on the stack no matter how fast the taps land.
 */
function consistencyCardTapSpam(rng: Rng, burst: Burst): void {
  const stack: string[] = ['Progress'];
  const navigate = (route: string) => {
    const existing = stack.indexOf(route);
    if (existing >= 0) stack.length = existing + 1;
    else stack.push(route);
  };
  const onPress = jest.fn(() => navigate(STREAK_ROUTE));
  const snapshot = rng.bool(0.15) ? null : rng.pick(SNAPSHOTS);
  const renderer = render(
    <ConsistencyCard snapshot={snapshot} onPress={onPress} />,
  );
  try {
    const card = pressableByTestId(renderer, 'consistency-card');
    const grouped = rng.bool(0.5);
    const taps = rng.between(2, 6);
    burst.script.push(
      `card snapshot=${
        snapshot === null ? 'null' : SNAPSHOTS.indexOf(snapshot)
      } ${grouped ? 'grouped' : 'sequential'} taps=${taps}`,
    );
    burst.interactions += taps;

    const tap = () => {
      const node = pressableByTestId(renderer, 'consistency-card');
      node.props.onPressIn?.();
      node.props.onPress();
      node.props.onPressOut?.();
    };
    if (grouped) {
      act(() => {
        for (let i = 0; i < taps; i += 1) {
          card.props.onPressIn?.();
          card.props.onPress();
          card.props.onPressOut?.();
        }
      });
    } else {
      for (let i = 0; i < taps; i += 1) {
        act(() => tap());
        act(() => {
          jest.advanceTimersByTime(rng.between(1, 30));
        });
      }
    }

    check(
      burst,
      onPress.mock.calls.length === taps,
      `card amplified presses: ${onPress.mock.calls.length} of ${taps}`,
    );
    check(
      burst,
      stack.length === 2 && stack[1] === STREAK_ROUTE,
      `spam taps produced stack [${stack.join(' > ')}]`,
    );
    check(
      burst,
      hosts(renderer, 'consistency-card').length === 1,
      'consistency card duplicated itself under press churn',
    );

    // Press lifecycle alone must never navigate.
    const before = onPress.mock.calls.length;
    act(() => {
      const node = pressableByTestId(renderer, 'consistency-card');
      node.props.onPressIn?.();
      node.props.onPressOut?.();
    });
    burst.interactions += 1;
    check(
      burst,
      onPress.mock.calls.length === before,
      'press-in/press-out fired a navigation',
    );
  } finally {
    act(() => renderer.unmount());
  }
}

/**
 * Spam navigation analogue: the whole unit is mounted, churned (snapshot swap,
 * theme flip, flame intensity changes, badge taps) and torn down mid-animation
 * over and over. Reanimated loops must be cancelled without a warning.
 */
function unitMountChurn(rng: Rng, burst: Burst): void {
  function Unit(props: {
    snapshot: ConsistencySnapshot;
    dark: boolean;
    streak: number;
  }) {
    return (
      <>
        <ConsistencyCard snapshot={props.snapshot} onPress={() => {}} />
        <AchievementsShowcase snapshot={props.snapshot} dark={props.dark} />
        <AnimatedFlame
          intensity={flameIntensityForStreak(props.streak)}
          size={20 + (props.streak % 12)}
        />
        <MilestoneBadge
          glyph="shieldFlame"
          value={String(props.streak)}
          rarity="rare"
          earned={props.streak % 2 === 0}
          size={48 + (props.streak % 16)}
        />
      </>
    );
  }

  let snapshot = rng.pick(SNAPSHOTS);
  let dark = rng.bool();
  let streak = rng.between(0, 120);
  const renderer = render(
    <Unit snapshot={snapshot} dark={dark} streak={streak} />,
  );
  try {
    const steps = rng.between(3, 8);
    burst.script.push(`churn steps=${steps} startStreak=${streak}`);
    for (let i = 0; i < steps; i += 1) {
      snapshot = rng.pick(SNAPSHOTS);
      dark = rng.bool();
      streak = rng.between(0, 120);
      act(() => {
        renderer.update(
          <Unit snapshot={snapshot} dark={dark} streak={streak} />,
        );
      });
      burst.interactions += 1;
      const buttons = badgeButtons(renderer);
      if (buttons.length > 0 && rng.bool(0.7)) {
        act(() => {
          buttons[rng.int(buttons.length)]!.props.onPress();
        });
        burst.interactions += 1;
      }
      act(() => {
        jest.advanceTimersByTime(rng.between(1, 900));
      });
    }
    check(
      burst,
      hosts(renderer, 'consistency-card').length === 1,
      'unit lost or duplicated the consistency card under churn',
    );
    check(
      burst,
      detailPanels(renderer).length <= 1,
      'unit rendered more than one detail panel',
    );
  } finally {
    act(() => renderer.unmount());
    act(() => {
      jest.advanceTimersByTime(2000);
    });
  }
}

const SCENARIOS: ReadonlyArray<{
  name: string;
  run: (rng: Rng, burst: Burst) => void;
}> = [
  { name: 'showcase-badge-burst', run: showcaseBadgeBurst },
  { name: 'celebration-dismiss-storm', run: celebrationDismissBurst },
  { name: 'day-secured-consumption-race', run: daySecuredConsumptionRace },
  { name: 'consistency-card-tap-spam', run: consistencyCardTapSpam },
  { name: 'unit-mount-churn', run: unitMountChurn },
];

let consoleSentinel: ConsoleSentinel;
let rejectionSentinel: RejectionSentinel;

/** A signed-in owner: the consistency store only arms real moments for one. */
const STRESS_OWNER = '11111111-1111-4111-8111-111111111111';

function MotionProbe() {
  useReducedMotion();
  return null;
}

beforeAll(async () => {
  rejectionSentinel = installRejectionSentinel();
  setActiveDataOwner(STRESS_OWNER);
  // The design system's reduce-motion observer resolves an AccessibilityInfo
  // promise the first time any component asks for it and pushes the answer
  // into every live subscriber. Flush that once here so a campaign burst is
  // never charged with the observer's own out-of-act update.
  let probe!: Renderer;
  await act(async () => {
    probe = TestRenderer.create(<MotionProbe />);
  });
  act(() => probe.unmount());
});

afterAll(() => {
  rejectionSentinel.restore();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
});

beforeEach(() => {
  jest.useFakeTimers();
  consoleSentinel = installConsoleSentinel();
});

afterEach(() => {
  consoleSentinel.restore();
  jest.useRealTimers();
  act(() => {
    useConsistencyStore.setState({ celebration: null, daySecured: null });
  });
});

describe('stress: cmp-consistency-ui under rapid/concurrent interaction', () => {
  it('holds one-side-effect-per-intent across a seeded burst campaign', () => {
    const iterations = iterationCount(320);
    const seeds = seedsFor(BASE_SEED, iterations);
    const results: IterationRecord[] = [];

    for (const seed of seeds) {
      const rng = rngFor(seed);
      const scenario = SCENARIOS[rng.int(SCENARIOS.length)]!;
      const burst: Burst = { script: [], interactions: 0, failures: [] };
      try {
        scenario.run(rng, burst);
      } catch (error) {
        burst.failures.push(
          `threw: ${
            error instanceof Error ? `${error.name}: ${error.message}` : error
          }`,
        );
      }
      const noise = consoleSentinel.drain();
      const actWarnings = noise.filter(message =>
        /not wrapped in act|act\(\)/i.test(message),
      );
      if (actWarnings.length > 0) {
        burst.failures.push(`act warning: ${actWarnings[0]}`);
      }
      const otherNoise = noise.filter(
        message => !actWarnings.includes(message),
      );
      if (otherNoise.length > 0) {
        burst.failures.push(`console noise: ${otherNoise[0]}`);
      }
      const rejections = rejectionSentinel.drain();
      if (rejections.length > 0) {
        burst.failures.push(`unhandled rejection: ${rejections[0]}`);
      }

      results.push({
        seed,
        scenario: scenario.name,
        outcome: burst.failures.length === 0 ? 'HELD' : 'BROKEN',
        interactions: burst.interactions,
        script: burst.script.join(' | '),
        failures: burst.failures,
      });
    }

    const table = buildResultTable({
      unit: 'cmp-consistency-ui',
      lens: 'rapid-interaction',
      baseSeed: BASE_SEED,
      results,
    });
    const artifact = writeResultTable(
      'cmp-consistency-ui-rapid-interaction',
      table,
    );

    const broken = results.filter(record => record.outcome === 'BROKEN');
    if (broken.length > 0) {
      throw new Error(
        `${broken.length}/${results.length} bursts BROKEN (table: ${artifact})\n${broken
          .slice(0, 10)
          .map(
            record =>
              `  seed=${record.seed} ${record.scenario} :: ${record.script}\n    ${record.failures.join(
                '\n    ',
              )}`,
          )
          .join('\n')}`,
      );
    }

    expect(table.interactions).toBeGreaterThanOrEqual(results.length * 2);
    expect(results).toHaveLength(seeds.length);
  });
});
