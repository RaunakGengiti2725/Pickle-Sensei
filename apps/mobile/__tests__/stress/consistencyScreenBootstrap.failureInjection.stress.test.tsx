/**
 * STRESS / failure-injection — useConsistencyBootstrap + StreakCalendarScreen
 * on top of the REAL consistency store with faulted SQLite dependencies.
 *
 * Each seed mounts the hook and the screen for an owner, arms a fault on
 * the first history read (throw / reject / reject-non-Error / slow 5–20 s /
 * timeout 45 s / never / malformed / partial), advances fake timers 60 s and
 * inspects the rendered tree:
 *   - no infinite spinner (the screen has none; asserted by walking the tree)
 *   - a failed read is VISIBLE: error card, accessibility alert, "Try again"
 *     button and a working header back control
 *   - a pending read is never rendered as a fake zero-streak empty state
 *   - "Try again" with the fault cleared recovers a real snapshot
 *   - AppState 'active' triggers exactly one history refresh; after unmount
 *     the listener is gone and no further reads happen
 *   - switching the owner rehydrates for the new owner and never writes the
 *     old owner's ledger key
 *
 * Replay: `STRESS_SEED=<seed> npx jest --ci consistencyScreenBootstrap`.
 * STRESS_ITER=<n> sets the campaign size (default 24).
 */
import { FaultRepository } from '../../test-support/stress/consistency/faultRepo';

let mockRepo = new FaultRepository();

jest.mock('../../src/data/db', () => ({
  getDb: () => mockRepo.getDb(),
}));

jest.mock('../../src/data/repository', () => ({
  getKv: (db: unknown, key: string) => mockRepo.getKv(db, key),
  setKv: (db: unknown, key: string, value: string) =>
    mockRepo.setKv(db, key, value),
  listActivityShots: (db: unknown) => mockRepo.listActivityShots(db),
}));

jest.mock('react-native-safe-area-context', () => {
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  return {
    SafeAreaView: View,
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
    initialWindowMetrics: null,
  };
});

jest.mock('react-native-linear-gradient', () => {
  const ReactModule = require('react');
  const { View } = require('react-native');
  const MockGradient = (props: { children?: React.ReactNode }) =>
    ReactModule.createElement(View, null, props.children);
  return { __esModule: true, default: MockGradient };
});

const mockGoBack = jest.fn();
const mockFocusEffects: (() => void)[] = [];
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ goBack: mockGoBack, navigate: jest.fn() }),
  useFocusEffect: (effect: () => void) => {
    mockFocusEffects.push(effect);
  },
}));

import type React from 'react';
import type { ReactTestInstance, ReactTestRenderer } from 'react-test-renderer';
import type { ActivityShotRow } from '../../src/data/repository';
import { consistencyKeyForOwner } from '../../src/consistency/store';
import {
  summarizeRows,
  writeJsonArtifact,
  type StressRow,
} from '../../test-support/stress/consistency/artifacts';
import {
  FAULT_KINDS,
  MALFORMED_KV_VARIANT_NAMES,
  MALFORMED_SHOT_VARIANT_NAMES,
  type DepName,
  type Fault,
  type FaultKind,
} from '../../test-support/stress/consistency/faultRepo';
import {
  campaignSeeds,
  chance,
  int,
  makePrng,
  pick,
  weighted,
  type Rng,
} from '../../test-support/stress/consistency/prng';
import { nodeProcess } from '../../xc-harness/lifecycle-persistence/nodeShim';

type ReactModule = typeof import('react');
type RendererModule = typeof import('react-test-renderer');
type RNModule = typeof import('react-native');
type StoreModule = typeof import('../../src/consistency/store');
type ScopeModule = typeof import('../../src/data/accountScope');
type HookModule =
  typeof import('../../src/consistency/useConsistencyBootstrap');
type ScreenModule = typeof import('../../src/screens/StreakCalendarScreen');

const RealDate = Date;
const OWNER_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OWNER_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SIGNED_OUT_OWNER = 'signed-out';
const BUDGET_MS = 60_000;
const STEP_MS = 1_000;

interface Loaded {
  React: ReactModule;
  renderer: RendererModule;
  rn: RNModule;
  store: StoreModule;
  scope: ScopeModule;
  hook: HookModule;
  screen: ScreenModule;
}

function loadFresh(): Loaded {
  jest.resetModules();
  mockFocusEffects.length = 0;
  return {
    React: require('react') as ReactModule,
    renderer: require('react-test-renderer') as RendererModule,
    rn: require('react-native') as RNModule,
    store: require('../../src/consistency/store') as StoreModule,
    scope: require('../../src/data/accountScope') as ScopeModule,
    hook: require('../../src/consistency/useConsistencyBootstrap') as HookModule,
    screen: require('../../src/screens/StreakCalendarScreen') as ScreenModule,
  };
}

function seedShots(rng: Rng, owner: string, nowMs: number, days: number): void {
  const rows: ActivityShotRow[] = [];
  let counter = 0;
  for (let back = 0; back < days; back += 1) {
    if (back > 0 && chance(rng, 0.25)) continue;
    const count = int(rng, 1, 3);
    for (let i = 0; i < count; i += 1) {
      const ms = nowMs - back * 86_400_000 - int(rng, 60_000, 3_600_000);
      rows.push({
        id: `${owner.slice(0, 4)}-shot-${counter}`,
        sessionId: null,
        shotType: pick(rng, ['dink', 'serve', 'forehand_drive']),
        capturedAt: new Date(ms).toISOString(),
        overallScore: Math.round((3 + rng() * 6) * 10) / 10,
        resultKind: 'scored',
      });
      counter += 1;
    }
  }
  mockRepo.shots.set(owner, rows);
}

function planFault(rng: Rng, dep: DepName): Fault {
  const kinds: readonly FaultKind[] =
    dep === 'setKv'
      ? FAULT_KINDS.filter(kind => kind !== 'malformed')
      : FAULT_KINDS;
  const kind = pick(rng, kinds);
  const fault: Fault = { kind, sticky: false };
  if (kind === 'slow') fault.delayMs = int(rng, 5_000, 20_000);
  if (kind === 'timeout') fault.delayMs = 45_000;
  if (kind === 'malformed') {
    fault.variant =
      dep === 'getKv'
        ? pick(rng, MALFORMED_KV_VARIANT_NAMES)
        : pick(rng, MALFORMED_SHOT_VARIANT_NAMES);
  }
  return fault;
}

function faultLabel(dep: DepName, fault: Fault): string {
  const bits: string[] = [fault.kind];
  if (fault.delayMs) bits.push(`${fault.delayMs}ms`);
  if (fault.variant) bits.push(fault.variant);
  return `${dep}:${bits.join('/')}`;
}

async function advance(ms: number): Promise<void> {
  let elapsed = 0;
  await jest.advanceTimersByTimeAsync(0);
  while (elapsed < ms) {
    await jest.advanceTimersByTimeAsync(STEP_MS);
    elapsed += STEP_MS;
  }
}

interface TreeDigest {
  texts: string;
  hasErrorCard: boolean;
  hasAlertRegion: boolean;
  tryAgainNode: ReactTestInstance | null;
  backNode: ReactTestInstance | null;
  hasHero: boolean;
  heroStreak: string | null;
  hasSpinner: boolean;
}

function digestTree(loaded: Loaded, root: ReactTestRenderer): TreeDigest {
  const texts = root.root
    .findAllByType(loaded.rn.Text)
    .map(node => node.props.children)
    .flat(3)
    .filter((child): child is string | number =>
      ['string', 'number'].includes(typeof child),
    )
    .join(' ')
    .replace(/\s+/g, ' ');
  const byTestId = (id: string) =>
    root.root.findAll(node => node.props.testID === id, { deep: true });
  const pressables = root.root.findAll(
    node => typeof node.props.onPress === 'function',
  );
  const tryAgain =
    pressables.find(node => {
      const label = node.props.accessibilityLabel ?? node.props.label;
      if (typeof label === 'string' && /try again/i.test(label)) return true;
      try {
        return node
          .findAllByType(loaded.rn.Text)
          .some(text => /try again/i.test(String(text.props.children)));
      } catch {
        return false;
      }
    }) ?? null;
  const back =
    pressables.find(node => {
      const label = node.props.accessibilityLabel;
      return typeof label === 'string' && /back/i.test(label);
    }) ?? null;
  const heroStreakNode = root.root
    .findAll(node => node.props.testID === 'streak-hero', { deep: true })
    .flatMap(node => node.findAllByType(loaded.rn.Text))[0];
  return {
    texts,
    hasErrorCard: byTestId('streak-load-error').length > 0,
    hasAlertRegion:
      root.root.findAll(node => node.props.accessibilityRole === 'alert')
        .length > 0,
    tryAgainNode: tryAgain,
    backNode: back,
    hasHero: byTestId('streak-hero').length > 0,
    heroStreak: heroStreakNode ? String(heroStreakNode.props.children) : null,
    hasSpinner: root.root.findAllByType(loaded.rn.ActivityIndicator).length > 0,
  };
}

let appStateHandlers: ((state: string) => void)[] = [];
let removedHandlers = 0;

function installAppStateSpy(loaded: Loaded): void {
  appStateHandlers = [];
  removedHandlers = 0;
  jest.spyOn(loaded.rn.AppState, 'addEventListener').mockImplementation(((
    _event: string,
    handler: (state: string) => void,
  ) => {
    appStateHandlers.push(handler);
    return {
      remove: () => {
        appStateHandlers = appStateHandlers.filter(h => h !== handler);
        removedHandlers += 1;
      },
    };
  }) as unknown as RNModule['AppState']['addEventListener']);
}

function historyReads(): number {
  return mockRepo.calls.filter(call => call.dep === 'listActivityShots').length;
}

function writesForOwner(owner: string): number {
  return mockRepo.writes.filter(
    write => write.key === consistencyKeyForOwner(owner),
  ).length;
}

async function runSeed(seed: number): Promise<StressRow> {
  const started = RealDate.now();
  const rng = makePrng(seed);
  mockRepo = new FaultRepository();
  mockGoBack.mockClear();
  const loaded = loadFresh();
  mockRepo.ownerResolver = loaded.scope.getActiveDataOwner;
  installAppStateSpy(loaded);

  const nowMs = Date.UTC(
    2026,
    int(rng, 0, 11),
    int(rng, 1, 28),
    int(rng, 6, 22),
    int(rng, 0, 59),
  );
  jest.useFakeTimers({ now: nowMs });
  seedShots(rng, OWNER_A, nowMs, int(rng, 1, 30));
  seedShots(rng, OWNER_B, nowMs, int(rng, 0, 12));

  const firstDep: DepName = weighted(rng, [
    ['listActivityShots', 4],
    ['getDb', 2],
    ['getKv', 2],
  ]);
  const firstFault = planFault(rng, firstDep);
  const faults: string[] = [faultLabel(firstDep, firstFault)];
  mockRepo.arm(firstDep, firstFault);

  const invariants: Record<string, boolean> = {};
  const details: string[] = [];
  const observed: Record<string, unknown> = {};

  loaded.scope.setActiveDataOwner(OWNER_A);
  const { React, renderer } = loaded;
  const Harness = ({ ownerKey }: { ownerKey: string | null }) => {
    loaded.hook.useConsistencyBootstrap(ownerKey);
    return React.createElement(loaded.screen.StreakCalendarScreen);
  };

  let root!: ReactTestRenderer;
  await renderer.act(async () => {
    root = renderer.create(React.createElement(Harness, { ownerKey: OWNER_A }));
  });
  // useFocusEffect is mocked to record; fire it once like navigation would.
  await renderer.act(async () => {
    for (const effect of mockFocusEffects) effect();
  });
  await renderer.act(async () => {
    await advance(STEP_MS);
  });
  // What the user sees one second in, while the read is still in flight
  // for slow / timeout / never faults (recorded, informs the pending-state
  // finding; asserted only once the 60 s budget is spent).
  const earlyState = loaded.store.useConsistencyStore.getState();
  const earlyTree = digestTree(loaded, root);
  observed.at1s = {
    hasSnapshot: earlyState.snapshot !== null,
    loadError: earlyState.loadError,
    heroStreak: earlyTree.heroStreak,
    hasErrorCard: earlyTree.hasErrorCard,
    hasSpinner: earlyTree.hasSpinner,
    pendingRenderedAsZeroStreak:
      earlyState.snapshot === null &&
      !earlyState.loadError &&
      earlyTree.hasHero &&
      earlyTree.heroStreak === '0',
  };
  await renderer.act(async () => {
    await advance(BUDGET_MS - STEP_MS);
  });

  const state1 = loaded.store.useConsistencyStore.getState();
  const tree1 = digestTree(loaded, root);
  observed.afterFault = {
    hydrated: state1.hydrated,
    loadError: state1.loadError,
    hasSnapshot: state1.snapshot !== null,
    streak: state1.snapshot?.currentStreak ?? null,
    tree: {
      ...tree1,
      tryAgainNode: tree1.tryAgainNode !== null,
      backNode: tree1.backNode !== null,
    },
    historyReads: historyReads(),
  };

  invariants.no_spinner_after_60s = !tree1.hasSpinner;
  if (tree1.hasSpinner)
    details.push(
      'no_spinner_after_60s: ActivityIndicator still mounted after 60 s',
    );

  invariants.back_control_visible = tree1.backNode !== null;
  if (!invariants.back_control_visible)
    details.push('back_control_visible: no header back control in tree');

  if (state1.loadError && !state1.snapshot) {
    invariants.error_visible_with_retry =
      tree1.hasErrorCard && tree1.hasAlertRegion && tree1.tryAgainNode !== null;
    if (!invariants.error_visible_with_retry) {
      details.push(
        `error_visible_with_retry: card=${tree1.hasErrorCard} alert=${tree1.hasAlertRegion} tryAgain=${tree1.tryAgainNode !== null}`,
      );
    }
  }

  // A read that has not settled must not be presented as a real result.
  if (!state1.loadError && !state1.snapshot) {
    invariants.pending_not_rendered_as_zero_streak = !(
      tree1.hasHero && tree1.heroStreak === '0'
    );
    if (!invariants.pending_not_rendered_as_zero_streak) {
      details.push(
        `pending_not_rendered_as_zero_streak: history read unsettled after 60 s (fault ${faults[0]}) yet the screen shows "${tree1.heroStreak} DAY STREAK" / "${tree1.texts.includes('Your first analysis lights the flame.') ? 'Your first analysis lights the flame.' : ''}" with no retry control (tryAgain=${tree1.tryAgainNode !== null})`,
      );
    }
    invariants.no_silent_failure = false;
    details.push(
      'no_silent_failure: neither snapshot nor loadError after 60 s — the failure is invisible to the user',
    );
  }

  // Malformed/partial rows must not surface as a fake success either: the
  // store either shows truth from the rows it could parse or flags the error.
  const truthReads = historyReads();
  invariants.history_read_attempted = truthReads >= 1;

  // Recovery: clear faults and press "Try again" if visible, else refresh
  // via a foreground event (what the bootstrap hook would do).
  mockRepo.clearFaults();
  const readsBeforeRecovery = historyReads();
  await renderer.act(async () => {
    if (tree1.tryAgainNode) {
      tree1.tryAgainNode.props.onPress();
    } else {
      for (const handler of appStateHandlers) handler('active');
    }
    await advance(BUDGET_MS);
  });
  const state2 = loaded.store.useConsistencyStore.getState();
  const tree2 = digestTree(loaded, root);
  observed.afterRecovery = {
    via: tree1.tryAgainNode ? 'try-again' : 'appstate-active',
    hydrated: state2.hydrated,
    loadError: state2.loadError,
    hasSnapshot: state2.snapshot !== null,
    streak: state2.snapshot?.currentStreak ?? null,
    heroStreak: tree2.heroStreak,
    historyReads: historyReads(),
    readsDuringRecovery: historyReads() - readsBeforeRecovery,
  };
  invariants.recovers_after_faults_clear =
    state2.snapshot !== null && !state2.loadError;
  if (!invariants.recovers_after_faults_clear) {
    details.push(
      `recovers_after_faults_clear: after clearing faults and ${tree1.tryAgainNode ? 'pressing Try again' : 'foregrounding'} + 60 s: snapshot=${state2.snapshot !== null} loadError=${state2.loadError} reads=${historyReads() - readsBeforeRecovery}`,
    );
  }
  if (state2.snapshot) {
    invariants.hero_matches_store =
      tree2.heroStreak === String(state2.snapshot.currentStreak);
    if (!invariants.hero_matches_store)
      details.push(
        `hero_matches_store: hero=${tree2.heroStreak} store=${state2.snapshot.currentStreak}`,
      );
  }

  // AppState foreground → exactly one refresh per event.
  const readsBeforeForeground = historyReads();
  await renderer.act(async () => {
    for (const handler of appStateHandlers) handler('background');
    for (const handler of appStateHandlers) handler('inactive');
    await advance(2_000);
  });
  invariants.non_active_states_do_not_refresh =
    historyReads() === readsBeforeForeground;
  if (!invariants.non_active_states_do_not_refresh)
    details.push(
      'non_active_states_do_not_refresh: background/inactive triggered a read',
    );
  await renderer.act(async () => {
    for (const handler of appStateHandlers) handler('active');
    await advance(5_000);
  });
  const foregroundReads = historyReads() - readsBeforeForeground;
  observed.foregroundReads = foregroundReads;
  observed.appStateListeners = appStateHandlers.length;
  if (state2.snapshot) {
    invariants.foreground_refreshes_once = foregroundReads === 1;
    if (!invariants.foreground_refreshes_once)
      details.push(
        `foreground_refreshes_once: ${foregroundReads} history reads for one 'active' event`,
      );
  }
  invariants.single_listener = appStateHandlers.length === 1;
  if (!invariants.single_listener)
    details.push(
      `single_listener: ${appStateHandlers.length} AppState listeners registered`,
    );

  // Owner switch along the real path (authStore: sign out → signed-out owner
  // → sign in as B; App.tsx passes ownerKey null in between). The hook
  // re-hydrates for B; no write may target A and A's snapshot must not be
  // presented as B's.
  const writesABefore = writesForOwner(OWNER_A);
  const snapshotA = loaded.store.useConsistencyStore.getState().snapshot;
  loaded.scope.setActiveDataOwner(SIGNED_OUT_OWNER);
  await renderer.act(async () => {
    root.update(React.createElement(Harness, { ownerKey: null }));
    await advance(2_000);
  });
  const signedOut = loaded.store.useConsistencyStore.getState();
  const switchFault = chance(rng, 0.5)
    ? planFault(rng, 'listActivityShots')
    : null;
  if (switchFault) {
    faults.push(`switch:${faultLabel('listActivityShots', switchFault)}`);
    mockRepo.arm('listActivityShots', switchFault);
  }
  loaded.scope.setActiveDataOwner(OWNER_B);
  await renderer.act(async () => {
    root.update(React.createElement(Harness, { ownerKey: OWNER_B }));
    await advance(STEP_MS);
  });
  const earlyB = loaded.store.useConsistencyStore.getState();
  const earlyBTree = digestTree(loaded, root);
  await renderer.act(async () => {
    await advance(BUDGET_MS - STEP_MS);
  });
  mockRepo.clearFaults();
  const state3 = loaded.store.useConsistencyStore.getState();
  observed.afterOwnerSwitch = {
    signedOutOwnerKey: signedOut.ownerKey,
    signedOutStillHoldsSnapshotA:
      snapshotA !== null && signedOut.snapshot === snapshotA,
    at1s: {
      ownerKey: earlyB.ownerKey,
      showsSnapshotA: snapshotA !== null && earlyB.snapshot === snapshotA,
      heroStreak: earlyBTree.heroStreak,
    },
    ownerKey: state3.ownerKey,
    hydrated: state3.hydrated,
    loadError: state3.loadError,
    hasSnapshot: state3.snapshot !== null,
    showsSnapshotA: snapshotA !== null && state3.snapshot === snapshotA,
    writesA: writesForOwner(OWNER_A) - writesABefore,
  };
  invariants.owner_switch_no_cross_writes =
    writesForOwner(OWNER_A) === writesABefore;
  if (!invariants.owner_switch_no_cross_writes)
    details.push(
      'owner_switch_no_cross_writes: ledger write for the previous owner after switching',
    );
  invariants.owner_switch_targets_new_owner =
    state3.ownerKey === OWNER_B || state3.ownerKey === null;
  if (!invariants.owner_switch_targets_new_owner)
    details.push(
      `owner_switch_targets_new_owner: store.ownerKey=${state3.ownerKey}`,
    );
  // 60 s after B signed in, whatever is on screen must be B's (or an error),
  // never the previous account's derived streak.
  invariants.owner_switch_no_stale_snapshot =
    state3.snapshot === null ||
    (state3.ownerKey === OWNER_B && state3.snapshot !== snapshotA);
  if (!invariants.owner_switch_no_stale_snapshot)
    details.push(
      `owner_switch_no_stale_snapshot: 60 s after signing in as B (switch fault ${switchFault ? faultLabel('listActivityShots', switchFault) : 'none'}) the screen still shows owner A's snapshot (hero "${digestTree(loaded, root).heroStreak} DAY STREAK") under ownerKey=${state3.ownerKey}, loadError=${state3.loadError}`,
    );

  // Back control must reach navigation.goBack.
  const tree3 = digestTree(loaded, root);
  if (tree3.backNode) {
    await renderer.act(async () => {
      tree3.backNode!.props.onPress();
    });
    invariants.back_control_navigates = mockGoBack.mock.calls.length >= 1;
    if (!invariants.back_control_navigates)
      details.push('back_control_navigates: goBack not called');
  }

  // Unmount → listener removed → later foreground events do nothing.
  await renderer.act(async () => {
    root.unmount();
  });
  const readsAfterUnmount = historyReads();
  const survivingHandlers = [...appStateHandlers];
  await renderer.act(async () => {
    for (const handler of survivingHandlers) handler('active');
    await advance(5_000);
  });
  invariants.listener_removed_on_unmount =
    survivingHandlers.length === 0 && removedHandlers >= 1;
  if (!invariants.listener_removed_on_unmount)
    details.push(
      `listener_removed_on_unmount: ${survivingHandlers.length} listeners survive, removed=${removedHandlers}`,
    );
  invariants.no_reads_after_unmount = historyReads() === readsAfterUnmount;
  if (!invariants.no_reads_after_unmount)
    details.push(
      'no_reads_after_unmount: a history read happened after unmount',
    );

  jest.useRealTimers();
  jest.restoreAllMocks();

  const failed = Object.entries(invariants)
    .filter(([, ok]) => !ok)
    .map(([name]) => name);
  return {
    suite: 'consistencyScreenBootstrap.failureInjection',
    seed,
    scenario: `first=${faults[0]} switch=${faults[1] ?? 'clean'}`,
    faults,
    inputs: {
      nowIso: new Date(nowMs).toISOString(),
      shotsA: mockRepo.shots.get(OWNER_A)?.length ?? 0,
      shotsB: mockRepo.shots.get(OWNER_B)?.length ?? 0,
    },
    observed: { ...observed, details },
    invariants,
    ok: failed.length === 0,
    failed,
    durationMs: RealDate.now() - started,
  };
}

describe('consistency bootstrap hook + StreakCalendarScreen — failure injection', () => {
  const seeds = campaignSeeds(nodeProcess.env, 24, 1);

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it(`keeps the screen recoverable across ${seeds.length} seeded fault scenarios`, async () => {
    const rows: StressRow[] = [];
    for (const seed of seeds) {
      rows.push(await runSeed(seed));
    }
    const summary = summarizeRows(
      'consistencyScreenBootstrap.failureInjection',
      rows,
      {
        replay: 'STRESS_SEED=<seed> npx jest --ci consistencyScreenBootstrap',
      },
    );
    writeJsonArtifact('screen-bootstrap.rows.json', rows);
    writeJsonArtifact('screen-bootstrap.summary.json', summary);
    const failures = rows
      .filter(row => !row.ok)
      .map(
        row =>
          `seed ${row.seed} [${row.faults.join(', ')}]: ${row.failed.join(', ')} :: ${(row.observed as { details: string[] }).details.join(' | ')}`,
      );
    expect(failures).toEqual([]);
  }, 600_000);
});
