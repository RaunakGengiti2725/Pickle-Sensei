/**
 * STRESS — cmp-navigation / lens `rapid-interaction` / PremiumTabBar.
 *
 * Renders the real PremiumTabBar inside a tiny stateful tab host (the host
 * plays the bottom-tab navigator: `navigate(tab)` moves the focused index
 * synchronously, exactly like TabRouter does) and fires seeded bursts of
 * double/triple taps, taps during the 210 ms close transition, "simultaneous"
 * presses batched into one act(), Android back mid-transition, access/auth
 * flips while an action is pending, and unmount mid-close.
 *
 * A reference model of the documented menu state machine (openMenu clears any
 * pending close + action; closeMenu(after) parks the LAST action behind ONE
 * timer; the timer hides the modal and runs the parked action once) predicts
 * the exact side-effect sequence. Any divergence — an extra/missing
 * navigation, a menu that stays open, a stale pending action firing, a leaked
 * timer, an act() warning — fails the iteration with its seed.
 *
 * Replay:  STRESS_SEED=<seed> npx jest --ci __tests__/stress/premiumTabBar
 * Scale:   STRESS_ITER=1000 npx jest --ci __tests__/stress/premiumTabBar
 */
jest.mock('react-native-linear-gradient', () => {
  const React = require('react');
  const { View } = require('react-native');
  const MockGradient = (props: { children?: React.ReactNode }) =>
    React.createElement(View, null, props.children);
  return { __esModule: true, default: MockGradient };
});
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

type AccessStatus = 'idle' | 'loading' | 'ready' | 'unconfigured' | 'error';
const mockAccess: {
  canonicalAccess: { canStartRating: boolean } | null;
  status: AccessStatus;
} = { canonicalAccess: { canStartRating: true }, status: 'ready' };
const mockAuth: { session: { localOnly: boolean } | null } = {
  session: { localOnly: false },
};
jest.mock('../../src/state/accessStore', () => ({
  useAccessStore: { getState: () => mockAccess },
}));
jest.mock('../../src/auth/authStore', () => ({
  useAuthStore: { getState: () => mockAuth },
}));

import React, { useMemo, useState } from 'react';
import { Modal } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import type { BottomTabBarProps } from '@react-navigation/bottom-tabs';
import { PremiumTabBar } from '../../src/navigation/PremiumTabBar';
import type { MainTabParams } from '../../src/navigation/params';
import {
  campaignConfig,
  campaignSeeds,
  invariant,
  InvariantViolation,
  minimizeScript,
  NoiseCapture,
  SeededRng,
  summarize,
  writeTable,
  type IterationOutcome,
} from '../../__harness__/stress/rapidInteraction.harness';

const SUITE = 'premiumTabBar.rapidInteraction';
const MOTION_MS = 210;
const TAB_ROUTES: (keyof MainTabParams)[] = [
  'Home',
  'Library',
  'Add',
  'Performance',
  'Settings',
];
const TAB_LABEL: Record<keyof MainTabParams, string> = {
  Home: 'Home',
  Library: 'Library',
  Add: 'COACH',
  Performance: 'Progress',
  Settings: 'Settings',
};
const REGULAR_TABS = TAB_ROUTES.filter(name => name !== 'Add');
const COACH_ACTIONS = [
  'Auto Analyze',
  'Import Video',
  'Drill Library',
] as const;
type CoachAction = (typeof COACH_ACTIONS)[number];

// ─── Recording tab host ──────────────────────────────────────────────────────

type Recorded = { kind: 'root' | 'tab'; args: unknown[] };

type Host = {
  recorded: Recorded[];
  emitted: { type: string; target: string }[];
  preventNext: boolean;
  index: number;
};

function makeHost(): Host {
  return { recorded: [], emitted: [], preventNext: false, index: 0 };
}

function TabHost({ host }: { host: Host }) {
  const [index, setIndex] = useState(0);
  host.index = index;
  const navigation = useMemo(
    () => ({
      emit: (event: { type: string; target: string }) => {
        host.emitted.push({ type: event.type, target: event.target });
        if (event.type !== 'tabPress') return { defaultPrevented: false };
        const defaultPrevented = host.preventNext;
        host.preventNext = false;
        return { defaultPrevented };
      },
      navigate: (name: keyof MainTabParams, params: unknown) => {
        host.recorded.push({ kind: 'tab', args: [name, params] });
        setIndex(TAB_ROUTES.indexOf(name));
      },
      getParent: () => ({
        navigate: (...args: unknown[]) => {
          host.recorded.push({ kind: 'root', args });
        },
      }),
    }),
    [host],
  );
  const props = {
    state: {
      index,
      routes: TAB_ROUTES.map(name => ({ key: `${name}-1`, name })),
    },
    navigation,
    descriptors: {},
    insets: { top: 0, bottom: 0, left: 0, right: 0 },
  } as unknown as BottomTabBarProps;
  return <PremiumTabBar {...props} />;
}

// ─── Reference model ─────────────────────────────────────────────────────────

type Model = {
  now: number;
  visible: boolean;
  open: boolean;
  fireAt: number | null;
  pending: CoachAction | null;
  /** Focused index as of the last commit (what closures inside a batch see). */
  committedIndex: number;
  index: number;
  committedOpen: boolean;
  committedVisible: boolean;
  access: typeof mockAccess;
  auth: typeof mockAuth;
  preventNext: boolean;
  expected: Recorded[];
  expectedEmits: number;
  info: Record<string, number>;
};

function bump(model: Model, key: string) {
  model.info[key] = (model.info[key] ?? 0) + 1;
}

function destinationFor(model: Model, action: CoachAction): unknown[] {
  if (action === 'Drill Library') return ['DrillLibrary'];
  const source = action === 'Auto Analyze' ? 'camera' : 'library';
  if (model.auth.session?.localOnly) return ['ConnectAccount'];
  const { canonicalAccess, status } = model.access;
  if (
    !canonicalAccess?.canStartRating &&
    (canonicalAccess !== null ||
      status === 'ready' ||
      status === 'unconfigured' ||
      status === 'error')
  ) {
    return ['Paywall', { source: 'rating' }];
  }
  return ['Analyze', { source }];
}

function modelOpen(model: Model) {
  model.fireAt = null;
  model.pending = null;
  model.visible = true;
  model.open = true;
}

function modelClose(model: Model, after?: CoachAction) {
  if (after) model.pending = after;
  if (model.fireAt !== null) return;
  model.open = false;
  model.fireAt = model.now + MOTION_MS;
}

function modelAdvance(model: Model, ms: number) {
  model.now += ms;
  if (model.fireAt !== null && model.fireAt <= model.now) {
    model.fireAt = null;
    const action = model.pending;
    model.pending = null;
    model.visible = false;
    if (action)
      model.expected.push({
        kind: 'root',
        args: destinationFor(model, action),
      });
  }
}

// ─── Scripted actions ────────────────────────────────────────────────────────

type Action =
  | { t: 'fab' }
  | { t: 'overlayFab' }
  | { t: 'backdrop' }
  | { t: 'back' }
  | { t: 'action'; which: CoachAction }
  | { t: 'tab'; which: keyof MainTabParams }
  | { t: 'longTab'; which: keyof MainTabParams }
  | { t: 'prevent' }
  | { t: 'access'; status: AccessStatus; canStart: boolean | null }
  | { t: 'auth'; localOnly: boolean | null }
  | { t: 'advance'; ms: number }
  | { t: 'unmount' };

/** A batch is a set of actions delivered inside ONE act() ("simultaneous"). */
type Batch = Action[];

const ADVANCES = [0, 1, 16, 50, 100, 200, 209, 210, 211, 300, 500];

function generateScript(rng: SeededRng): Batch[] {
  const batches: Batch[] = [];
  const burstLength = 4 + rng.int(20);
  for (let i = 0; i < burstLength; i += 1) {
    const size = rng.weighted([
      [6, 1],
      [2, 2],
      [1, 3],
      [1, 4],
    ] as const);
    const batch: Batch = [];
    for (let j = 0; j < size; j += 1) batch.push(randomAction(rng));
    // Repeat the same press N times to model double/triple taps.
    if (
      rng.chance(0.25) &&
      batch[0]!.t !== 'advance' &&
      batch[0]!.t !== 'unmount'
    ) {
      const copies = 1 + rng.int(2);
      for (let c = 0; c < copies; c += 1) batch.push(batch[0]!);
    }
    batches.push(batch);
    if (rng.chance(0.55))
      batches.push([{ t: 'advance', ms: rng.pick(ADVANCES) }]);
  }
  if (rng.chance(0.15)) batches.push([{ t: 'unmount' }]);
  return batches;
}

function randomAction(rng: SeededRng): Action {
  return rng.weighted<Action>([
    [10, { t: 'fab' }],
    [4, { t: 'overlayFab' }],
    [6, { t: 'backdrop' }],
    [3, { t: 'back' }],
    [12, { t: 'action', which: rng.pick(COACH_ACTIONS) }],
    [8, { t: 'tab', which: rng.pick(TAB_ROUTES) }],
    [2, { t: 'longTab', which: rng.pick(REGULAR_TABS) }],
    [1, { t: 'prevent' }],
    [
      2,
      {
        t: 'access',
        status: rng.pick([
          'idle',
          'loading',
          'ready',
          'unconfigured',
          'error',
        ] as const),
        canStart: rng.pick([true, false, null]),
      },
    ],
    [2, { t: 'auth', localOnly: rng.pick([true, false, null]) }],
    [6, { t: 'advance', ms: rng.pick(ADVANCES) }],
  ]);
}

function describeAction(action: Action): string {
  switch (action.t) {
    case 'action':
    case 'tab':
    case 'longTab':
      return `${action.t}:${action.which}`;
    case 'access':
      return `access:${action.status}/${String(action.canStart)}`;
    case 'auth':
      return `auth:${String(action.localOnly)}`;
    case 'advance':
      return `advance:${action.ms}`;
    default:
      return action.t;
  }
}

// ─── Execution ───────────────────────────────────────────────────────────────

type Renderer = TestRenderer.ReactTestRenderer;

/**
 * Composite wrappers (PressableScale → Pressable) repeat the label/onPress on
 * nested nodes; a user taps ONE control, so keep only the outermost match.
 */
function pressablesByLabel(renderer: Renderer, label: string) {
  const matches = renderer.root.findAll(
    n =>
      n.props.accessibilityLabel === label &&
      typeof n.props.onPress === 'function',
  );
  const set = new Set(matches);
  return matches.filter(node => {
    for (let p = node.parent; p; p = p.parent) if (set.has(p)) return false;
    return true;
  });
}

function insideModal(node: TestRenderer.ReactTestInstance): boolean {
  for (let p = node.parent; p; p = p.parent) if (p.type === Modal) return true;
  return false;
}

/** Both COACH buttons (in-bar + the overlay copy inside the open menu). */
function allFabs(renderer: Renderer) {
  // The backdrop shares the "Close coach actions" label, so identify FABs by
  // their expanded accessibility state instead.
  return [
    ...pressablesByLabel(renderer, 'Open coach actions'),
    ...pressablesByLabel(renderer, 'Close coach actions'),
  ].filter(n => n.props.accessibilityState?.expanded !== undefined);
}

function barFab(renderer: Renderer) {
  const fabs = allFabs(renderer).filter(n => !insideModal(n));
  invariant(
    fabs.length === 1,
    () => `expected exactly one in-bar COACH FAB, found ${fabs.length}`,
  );
  return fabs[0]!;
}

function overlayFab(renderer: Renderer) {
  return allFabs(renderer).find(n => insideModal(n));
}

function backdrop(renderer: Renderer) {
  return pressablesByLabel(renderer, 'Close coach actions').find(
    n => n.props.accessibilityState?.expanded === undefined,
  );
}

function checkCommitted(renderer: Renderer, model: Model, where: string) {
  const modals = renderer.root.findAllByType(Modal);
  invariant(
    modals.length === 1,
    () => `${where}: ${modals.length} modals rendered`,
  );
  const visible = modals[0]!.props.visible === true;
  invariant(
    visible === model.visible,
    () => `${where}: modal visible=${visible}, model says ${model.visible}`,
  );
  const label = barFab(renderer).props.accessibilityLabel as string;
  const expectedLabel = model.open
    ? 'Close coach actions'
    : 'Open coach actions';
  invariant(
    label === expectedLabel,
    () => `${where}: FAB label "${label}", model says "${expectedLabel}"`,
  );
  const expanded = barFab(renderer).props.accessibilityState.expanded;
  invariant(
    expanded === model.open,
    () => `${where}: FAB expanded=${expanded}, model open=${model.open}`,
  );
  const overlays = allFabs(renderer).filter(insideModal).length;
  invariant(
    overlays === (model.visible ? 1 : 0),
    () => `${where}: ${overlays} overlay FAB(s) for visible=${model.visible}`,
  );
  const rows = COACH_ACTIONS.map(a => pressablesByLabel(renderer, a).length);
  invariant(
    rows.every(count => count === (model.visible ? 1 : 0)),
    () =>
      `${where}: action rows ${rows.join(',')} for visible=${model.visible}`,
  );
  const selected = renderer.root
    .findAll(
      n =>
        n.props.accessibilityRole === 'tab' &&
        typeof n.props.onPress === 'function',
    )
    .map(n => n.props.accessibilityState?.selected === true);
  const expectedSelected = REGULAR_TABS.map(
    name => TAB_ROUTES.indexOf(name) === model.index,
  );
  invariant(
    JSON.stringify(selected) === JSON.stringify(expectedSelected),
    () =>
      `${where}: selected tabs ${JSON.stringify(selected)} vs model ${JSON.stringify(expectedSelected)}`,
  );
}

function applyAction(
  renderer: Renderer,
  host: Host,
  model: Model,
  action: Action,
) {
  switch (action.t) {
    case 'fab': {
      barFab(renderer).props.onPress();
      bump(
        model,
        model.committedOpen
          ? 'fabClose'
          : model.fireAt !== null
            ? 'fabReopenDuringClose'
            : 'fabOpen',
      );
      if (model.committedOpen) modelClose(model);
      else modelOpen(model);
      return;
    }
    case 'overlayFab': {
      const node = overlayFab(renderer);
      if (!node) {
        bump(model, 'overlayFabUnavailable');
        return;
      }
      node.props.onPress();
      bump(
        model,
        model.fireAt !== null ? 'overlayFabDuringClose' : 'overlayFab',
      );
      modelClose(model);
      return;
    }
    case 'backdrop': {
      const node = backdrop(renderer);
      if (!node) {
        bump(model, 'backdropUnavailable');
        return;
      }
      node.props.onPress();
      bump(model, model.fireAt !== null ? 'backdropDuringClose' : 'backdrop');
      modelClose(model);
      return;
    }
    case 'back': {
      const modal = renderer.root.findByType(Modal);
      if (modal.props.visible !== true) {
        bump(model, 'backWithoutModal');
        return;
      }
      modal.props.onRequestClose();
      modelClose(model);
      bump(model, 'androidBack');
      return;
    }
    case 'action': {
      const [row] = pressablesByLabel(renderer, action.which);
      if (!row) {
        bump(model, 'actionUnavailable');
        return;
      }
      row.props.onPress();
      bump(model, model.committedOpen ? 'actionTap' : 'actionTapDuringClose');
      modelClose(model, action.which);
      return;
    }
    case 'tab': {
      if (action.which === 'Add') {
        // The Add slot IS the FAB; a "tab" press on it is a FAB press.
        applyAction(renderer, host, model, { t: 'fab' });
        return;
      }
      const [node] = pressablesByLabel(renderer, TAB_LABEL[action.which]);
      invariant(node, () => `tab ${action.which} missing`);
      node.props.onPress();
      model.expectedEmits += 1;
      const prevented = model.preventNext;
      model.preventNext = false;
      const focused = TAB_ROUTES.indexOf(action.which) === model.committedIndex;
      if (!focused && !prevented) {
        model.expected.push({ kind: 'tab', args: [action.which, undefined] });
        if (model.index === TAB_ROUTES.indexOf(action.which))
          bump(model, 'redundantTabNavigateInBatch');
        model.index = TAB_ROUTES.indexOf(action.which);
        bump(model, 'tabSwitch');
      } else {
        bump(model, prevented ? 'tabPrevented' : 'tabRefocus');
      }
      return;
    }
    case 'longTab': {
      const [node] = pressablesByLabel(renderer, TAB_LABEL[action.which]);
      invariant(node, () => `tab ${action.which} missing`);
      node.props.onLongPress();
      bump(model, 'tabLongPress');
      return;
    }
    case 'prevent':
      host.preventNext = true;
      model.preventNext = true;
      return;
    case 'access':
      mockAccess.status = action.status;
      mockAccess.canonicalAccess =
        action.canStart === null ? null : { canStartRating: action.canStart };
      model.access = {
        status: action.status,
        canonicalAccess: mockAccess.canonicalAccess,
      };
      bump(model, 'accessFlip');
      return;
    case 'auth':
      mockAuth.session =
        action.localOnly === null ? null : { localOnly: action.localOnly };
      model.auth = { session: mockAuth.session };
      bump(model, 'authFlip');
      return;
    case 'advance':
      jest.advanceTimersByTime(action.ms);
      modelAdvance(model, action.ms);
      bump(
        model,
        action.ms > 0 && action.ms < MOTION_MS
          ? 'advanceDuringClose'
          : 'advance',
      );
      return;
    case 'unmount':
      return;
  }
}

/** Runs one script; returns null when every invariant held. */
function runScript(script: Batch[]): {
  failure: string | null;
  info: Record<string, number>;
  actions: number;
} {
  jest.useFakeTimers();
  mockAccess.status = 'ready';
  mockAccess.canonicalAccess = { canStartRating: true };
  mockAuth.session = { localOnly: false };
  const host = makeHost();
  const model: Model = {
    now: 0,
    visible: false,
    open: false,
    fireAt: null,
    pending: null,
    committedIndex: 0,
    index: 0,
    committedOpen: false,
    committedVisible: false,
    access: { status: 'ready', canonicalAccess: { canStartRating: true } },
    auth: { session: { localOnly: false } },
    preventNext: false,
    expected: [],
    expectedEmits: 0,
    info: {},
  };
  const noise = new NoiseCapture();
  noise.start();
  let renderer!: Renderer;
  let mounted = false;
  let actions = 0;
  try {
    act(() => {
      renderer = TestRenderer.create(<TabHost host={host} />);
    });
    mounted = true;
    let step = 0;
    for (const batch of script) {
      step += 1;
      if (batch.some(a => a.t === 'unmount')) {
        act(() => renderer.unmount());
        mounted = false;
        actions += 1;
        invariant(
          jest.getTimerCount() === 0,
          () =>
            `step ${step}: ${jest.getTimerCount()} timer(s) leaked after unmount`,
        );
        break;
      }
      act(() => {
        for (const action of batch) {
          actions += 1;
          applyAction(renderer, host, model, action);
        }
      });
      model.committedIndex = model.index;
      model.committedOpen = model.open;
      model.committedVisible = model.visible;
      checkCommitted(
        renderer,
        model,
        `step ${step} (${batch.map(describeAction).join('+')})`,
      );
      compareRecorded(host, model, `step ${step}`);
    }
    if (mounted) {
      // Settle: dismiss an open menu the way a user would, then let every
      // transition finish — the menu must end closed and idle.
      if (model.open) {
        act(() => {
          barFab(renderer).props.onPress();
        });
        modelClose(model);
      }
      act(() => {
        jest.advanceTimersByTime(1000);
      });
      modelAdvance(model, 1000);
      model.committedOpen = model.open;
      model.committedVisible = model.visible;
      checkCommitted(renderer, model, 'settle');
      compareRecorded(host, model, 'settle');
      invariant(
        !model.visible && !model.open,
        () => 'model itself not idle after settle',
      );
      // Stale-intent probe: open → close with NO action must navigate nowhere.
      const before = host.recorded.length;
      act(() => {
        barFab(renderer).props.onPress();
      });
      act(() => {
        barFab(renderer).props.onPress();
        jest.advanceTimersByTime(1000);
      });
      invariant(
        host.recorded.length === before,
        () =>
          `stale pending action fired on a plain open/close: ${JSON.stringify(host.recorded.slice(before))}`,
      );
      invariant(
        renderer.root.findByType(Modal).props.visible === false,
        () => 'menu still visible after plain open/close',
      );
      act(() => renderer.unmount());
      mounted = false;
      invariant(
        jest.getTimerCount() === 0,
        () => `${jest.getTimerCount()} timer(s) leaked after settle+unmount`,
      );
    }
    invariant(
      host.emitted.filter(e => e.type === 'tabPress').length ===
        model.expectedEmits,
      () =>
        `tabPress emitted ${host.emitted.filter(e => e.type === 'tabPress').length}×, expected ${model.expectedEmits}`,
    );
    const noiseReport = noise.report();
    invariant(
      noiseReport === null,
      () => `console/rejection noise:\n${noiseReport}`,
    );
    return { failure: null, info: model.info, actions };
  } catch (error) {
    const message =
      error instanceof InvariantViolation
        ? error.message
        : `thrown: ${String(error)}`;
    return { failure: message, info: model.info, actions };
  } finally {
    if (mounted) {
      try {
        act(() => renderer.unmount());
      } catch {
        // already reported
      }
    }
    noise.stop();
    jest.clearAllTimers();
    jest.useRealTimers();
  }
}

function compareRecorded(host: Host, model: Model, where: string) {
  const actual = JSON.stringify(host.recorded);
  const expected = JSON.stringify(model.expected);
  invariant(
    actual === expected,
    () =>
      `${where}: side effects diverged\n  actual:   ${actual}\n  expected: ${expected}`,
  );
}

// ─── Campaign ────────────────────────────────────────────────────────────────

const config = campaignConfig(160);
const seeds = campaignSeeds(config);
const results: IterationOutcome[] = [];

describe('stress/rapid-interaction: PremiumTabBar seeded bursts', () => {
  afterAll(() => {
    writeTable(config, summarize(SUITE, config, results));
  });

  it.each(seeds.map((seed, i) => [i, seed] as const))(
    'iteration %i (seed %i) — one side effect per intent, menu never orphaned',
    (_iteration, seed) => {
      const script = generateScript(new SeededRng(seed));
      const { failure, info, actions } = runScript(script);
      const flat = script.map(batch => batch.map(describeAction).join('+'));
      results.push({
        seed,
        outcome: failure ? 'fail' : 'pass',
        actions,
        script: flat,
        ...(failure ? { failure } : {}),
        info,
      });
      if (failure && config.minimize) {
        const minimal = minimizeScript(script, s => runScript(s).failure);
        throw new Error(
          `seed ${seed} FAILED: ${failure}\nminimal script (${minimal.script.length} batches):\n${minimal.script
            .map(b => '  ' + b.map(describeAction).join('+'))
            .join('\n')}\nminimal failure: ${minimal.failure}`,
        );
      }
      if (failure) {
        throw new Error(
          `seed ${seed} FAILED: ${failure}\nscript:\n${flat.map(s => '  ' + s).join('\n')}`,
        );
      }
    },
  );
});
