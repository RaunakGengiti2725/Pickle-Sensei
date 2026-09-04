/**
 * STRESS · scr-formreviewscreen · lens `lifecycle`
 *
 * Seeded lifecycle-interruption campaign against the FormReview screen mounted
 * in the real navigator/providers (see __harness__/formReviewLifecycle/harness.tsx for
 * exactly what is real and what is a native boundary).
 *
 * Per iteration (one seed): two owners' strokes are written through the
 * production repository into a real SQLite store, the tree is mounted at
 * FormReview, and a seeded schedule of 8–28 steps interleaves boundary
 * releases/failures with lifecycle events. After the schedule the device
 * settles and these invariants are asserted:
 *
 *   I1  rendered state == ground truth for the CURRENT owner + route param
 *       given exactly the boundary outcomes that load observed
 *       (missing / ready·clip / ready·pose / ready·bare) — never a stale
 *       analysis from a cancelled load or a previous owner;
 *   I2  no leaked JS timers after every unmount/kill (jest.getTimerCount()),
 *       AppState subscriptions balanced, one DB handle closed per kill;
 *   I3  re-hydrate is idempotent: kill → relaunch twice renders identical
 *       trees;
 *   I4  after an account switch nothing of the previous owner is visible
 *       (player props AND the serialized tree), and a re-analyze press hands
 *       the NEW owner's set to the Analyze route;
 *   I5  no console.error / console.warn during the iteration.
 *
 * Scale: `STRESS_ITER` iterations (default 12 so the suite stays fast;
 * the campaign runs ≥ 120). `STRESS_SEED=<n>` replays exactly one seed.
 * `STRESS_OUT=<dir>` writes the seed → outcome JSON table.
 *
 * Run: cd apps/mobile && STRESS_ITER=120 STRESS_OUT=artifacts/stress \
 *        npx jest --ci --detectOpenHandles __tests__/stress/formReviewScreen.lifecycle
 */
jest.mock('react-native', () => {
  const RN = jest.requireActual('react-native');
  // The capture bridge is read at module-evaluation time by camera/capture.ts;
  // install the private-artifact reader before anything imports it.
  RN.NativeModules.PickleVideoCapture = {
    readTextFile: (uri: string) =>
      (
        jest.requireActual('../../__harness__/formReviewLifecycle/harness') as {
          device: { readTextFile: (uri: string) => Promise<string> };
        }
      ).device.readTextFile(uri),
  };
  return RN;
});
jest.mock('@op-engineering/op-sqlite', () => ({
  open: () =>
    (
      jest.requireActual('../../__harness__/formReviewLifecycle/harness') as {
        device: { openSqlite: () => unknown };
      }
    ).device.openSqlite(),
}));
jest.mock('react-native-svg', () => {
  const React = jest.requireActual('react') as typeof import('react');
  const { View } = jest.requireActual(
    'react-native',
  ) as typeof import('react-native');
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

import { act } from 'react-test-renderer';
import { getApiSession } from '../../src/account/apiSession';
import { getDb } from '../../src/data/db';
import {
  GUEST_DATA_OWNER,
  SIGNED_OUT_DATA_OWNER,
  getActiveDataOwner,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import {
  OWNER_A,
  OWNER_B,
  Rng,
  canonicalTree,
  device,
  flush,
  focusedRoute,
  installNativeBoundaries,
  killProcess,
  mountTree,
  peekTryAgainHandoff,
  pressable,
  relaunchSession,
  rotateBearer,
  routeNames,
  seedStroke,
  timers,
  unmountTree,
  visibleState,
  type OpKind,
  type SeededStroke,
  type SidecarVariant,
  type Tree,
  type VisibleState,
} from '../../__harness__/formReviewLifecycle/harness';

declare const require: (id: string) => unknown;
declare const __dirname: string;
declare const process: { env: Record<string, string | undefined> };
const { mkdirSync, writeFileSync } = require('fs') as {
  mkdirSync: (path: string, options: { recursive: boolean }) => void;
  writeFileSync: (path: string, data: string) => void;
};
const { join } = require('path') as { join: (...parts: string[]) => string };

const ITERATIONS = Number(process.env.STRESS_ITER ?? 12);
const BASE_SEED = Number(process.env.STRESS_BASE_SEED ?? 424_242);
const ONLY_SEED =
  process.env.STRESS_SEED !== undefined
    ? Number(process.env.STRESS_SEED)
    : null;
const OUT_DIR = process.env.STRESS_OUT ?? null;
const CHUNK = 10;

// ─── Result table ───────────────────────────────────────────────────────────

type Action =
  | 'release'
  | 'drain'
  | 'fail_op'
  | 'background'
  | 'foreground'
  | 'kill_relaunch'
  | 'account_switch'
  | 'pop'
  | 'reopen'
  | 'param_change'
  | 'push_away'
  | 'token_rotate'
  | 'revoke_artifact'
  | 'press'
  | 'reanalyze'
  | 'tick';

interface IterationResult {
  seed: number;
  outcome: 'HELD' | 'BROKEN';
  steps: string[];
  failures: string[];
  scenario: {
    ownerBSameId: boolean;
    sidecarA: SidecarVariant;
    sidecarB: SidecarVariant;
    captureA: boolean;
    captureB: boolean;
  };
  counts: Partial<Record<Action, number>>;
  finalState: VisibleState;
  finalOwner: string;
  /** Peak count of framework-owned (navigation/screens/Animated) timers seen after an unmount; informational. */
  frameworkTimerResidue: number;
  reopenedAtSettle: boolean;
  opsReleased: number;
  opsFailed: number;
}

const results: IterationResult[] = [];

// ─── Ground truth ───────────────────────────────────────────────────────────

function expectedState(
  strokes: SeededStroke[],
  owner: string,
  analysisId: string,
  epoch: number,
): VisibleState {
  const seeded = strokes.find(
    stroke => stroke.owner === owner && stroke.analysisId === analysisId,
  );
  const ops = device.log.filter(record => record.epoch === epoch);
  const outcome = (kind: OpKind) =>
    ops.find(record => record.kind === kind)?.outcome ?? 'never';
  if (!seeded || outcome('sql.shot') !== 'ok') return { kind: 'missing' };
  const recordOk = outcome('sql.record') === 'ok';
  const captureOk = recordOk && outcome('sql.capture') === 'ok';
  const artifactOk = outcome('artifact') === 'ok';
  return {
    kind: 'ready',
    analysisId,
    sessionId: `set-${seeded.ownerTag}`,
    clipUri: seeded.hasCapture && captureOk ? seeded.clipUri : null,
    sequenceFrames:
      seeded.hasCapture && captureOk && seeded.sidecar === 'valid' && artifactOk
        ? seeded.frameCount
        : null,
  };
}

// ─── One iteration ──────────────────────────────────────────────────────────

async function runIteration(seed: number): Promise<IterationResult> {
  const rng = new Rng(seed);
  const steps: string[] = [];
  const failures: string[] = [];
  const counts: Partial<Record<Action, number>> = {};
  const errors: string[] = [];
  const errorSpy = jest
    .spyOn(console, 'error')
    .mockImplementation((...args: unknown[]) => {
      errors.push(`error: ${args.map(String).join(' ').slice(0, 200)}`);
    });
  const warnSpy = jest
    .spyOn(console, 'warn')
    .mockImplementation((...args: unknown[]) => {
      errors.push(`warn: ${args.map(String).join(' ').slice(0, 200)}`);
    });

  jest.setSystemTime(new Date('2026-09-04T12:00:00.000Z'));
  device.reset();

  // ── Scenario shape ──
  const ownerBSameId = rng.next() < 0.5;
  const sidecarA = rng.pick<SidecarVariant>([
    'valid',
    'valid',
    'corrupt',
    'absent',
  ]);
  const sidecarB = rng.pick<SidecarVariant>(['valid', 'absent']);
  const captureA = rng.next() < 0.85;
  const captureB = rng.next() < 0.7;
  const idA = `analysis-${seed}-a`;
  const idB = ownerBSameId ? idA : `analysis-${seed}-b`;
  const idOther = `analysis-${seed}-other`;
  const strokes: SeededStroke[] = [
    {
      owner: OWNER_A,
      ownerTag: 'owner-a',
      analysisId: idA,
      captureId: `capture-${seed}-a`,
      shotType: 'forehand_drive',
      hasCapture: captureA,
      clipUri: `file:///captures/owner-a/${seed}.mov`,
      sidecarUri: `file:///captures/owner-a/${seed}.pose.json`,
      sidecar: sidecarA,
      frameCount: 0,
    },
    {
      owner: OWNER_B,
      ownerTag: 'owner-b',
      analysisId: idB,
      captureId: `capture-${seed}-b`,
      shotType: 'backhand_drive',
      hasCapture: captureB,
      clipUri: `file:///captures/owner-b/${seed}.mov`,
      sidecarUri: `file:///captures/owner-b/${seed}.pose.json`,
      sidecar: sidecarB,
      frameCount: 0,
    },
    // A second stroke of owner A for the param-change (cancel mid-flight) path.
    {
      owner: OWNER_A,
      ownerTag: 'owner-a',
      analysisId: idOther,
      captureId: `capture-${seed}-other`,
      shotType: 'dink',
      hasCapture: true,
      clipUri: `file:///captures/owner-a/${seed}-other.mov`,
      sidecarUri: `file:///captures/owner-a/${seed}-other.pose.json`,
      sidecar: 'valid',
      frameCount: 0,
    },
  ];
  for (const stroke of strokes) await seedStroke(stroke);
  // Seeding is done with a fresh process: same model as the first launch.
  killProcess();
  device.log = [];
  device.vaultOwner = OWNER_A;
  let bearerSerial = 0;
  relaunchSession(`bearer-${seed}-${bearerSerial}`);

  const stepCount = rng.int(10, 36);
  let tree = null as Tree | null;
  let param = idA;
  /** Epoch of the load the mounted FormReview screen currently owns. */
  let loadEpoch = 0;
  let settledState: VisibleState = { kind: 'absent' };
  let frameworkResidue = 0;
  let reopenedAtSettle = false;
  let switchedTo: string | null = null;
  const ownerAMarkers = ['owner-a', 'set-owner-a'];

  const note = (action: Action, detail = '') => {
    counts[action] = (counts[action] ?? 0) + 1;
    steps.push(detail ? `${action}:${detail}` : action);
  };

  const assertTornDown = async (where: string) => {
    // Let one-shot flushes fire (the RN jest preset's NativeAnimatedModule
    // mock completes every started animation with a 16 ms timeout); anything
    // app-owned still alive after that is a leak (intervals, re-armed loops).
    await act(async () => {
      jest.advanceTimersByTime(100);
    });
    const leaked = timers.appTimers();
    if (leaked.length > 0) {
      failures.push(
        `I2 ${where}: ${leaked.length} app timer(s) still live: ${leaked
          .map(timer => `${timer.kind}(${timer.ms}) @ ${timer.site}`)
          .join('; ')}`,
      );
      for (const [handle, timer] of timers.live) {
        if (timer.owner !== 'app') continue;
        if (timer.kind === 'interval') clearInterval(handle);
        else clearTimeout(handle);
      }
    }
    frameworkResidue = Math.max(
      frameworkResidue,
      timers.frameworkTimers().length,
    );
    if (device.appStateListeners.size !== 0) {
      failures.push(
        `I2 ${where}: ${device.appStateListeners.size} AppState listener(s) leaked`,
      );
    }
  };

  const mount = async () => {
    device.mode = 'gated';
    tree = await mountTree(param);
    loadEpoch = device.epoch;
  };

  const formReviewMounted = () =>
    tree !== null && routeNames(tree.nav).includes('FormReview');
  const formReviewFocused = () =>
    tree !== null && focusedRoute(tree.nav)?.name === 'FormReview';

  const assertSessionBound = (where: string) => {
    const session = getApiSession();
    const owner = getActiveDataOwner();
    if (session && session.canonicalAppUserId !== owner) {
      failures.push(
        `I4 ${where}: API session bound to ${session.canonicalAppUserId.slice(0, 8)} while data owner is ${owner.slice(0, 8)}`,
      );
    }
  };

  const relaunch = async (why: string) => {
    if (tree) await unmountTree(tree);
    tree = null;
    await assertTornDown(`after unmount (${why})`);
    const closesBefore = device.closes;
    killProcess();
    if (device.closes !== closesBefore + 1) {
      failures.push(`I2 kill (${why}): DB handle not closed exactly once`);
    }
    if (peekTryAgainHandoff() !== null) {
      failures.push(`kill (${why}): try-again handoff survived the process`);
    }
    bearerSerial += 1;
    relaunchSession(`bearer-${seed}-${bearerSerial}`);
    assertSessionBound(`relaunch (${why})`);
    await mount();
  };

  const releaseOne = async (fail: boolean) => {
    if (device.pending.length === 0) {
      await act(async () => {
        jest.advanceTimersByTime(40);
      });
      return 'idle';
    }
    const op = rng.pick(device.pending);
    device.trigger = op.epoch;
    try {
      await act(async () => {
        if (fail) op.reject(new Error(`injected ${op.kind} failure`));
        else op.resolve();
        await Promise.resolve();
      });
      await flush();
    } finally {
      device.trigger = null;
    }
    return `${op.kind}@e${op.epoch}`;
  };

  const settle = async () => {
    device.mode = 'immediate';
    let guard = 0;
    while (device.pending.length > 0 && guard++ < 64) {
      await releaseOne(false);
    }
    await flush();
    await act(async () => {
      jest.advanceTimersByTime(50);
    });
    await flush();
  };

  try {
    await mount();

    for (let step = 0; step < stepCount; step++) {
      const action = rng.weighted<Action>({
        release: 26,
        drain: 8,
        fail_op: 4,
        background: 4,
        foreground: 4,
        kill_relaunch: 5,
        account_switch: 4,
        pop: 4,
        reopen: 4,
        param_change: 4,
        push_away: 3,
        token_rotate: 3,
        revoke_artifact: 3,
        press: 8,
        reanalyze: 3,
        tick: 10,
      });

      switch (action) {
        case 'release':
          note(action, await releaseOne(false));
          break;
        case 'drain': {
          let released = 0;
          let guard = 0;
          while (device.pending.length > 0 && guard++ < 16) {
            await releaseOne(false);
            released += 1;
          }
          note(action, String(released));
          break;
        }
        case 'fail_op':
          note(action, await releaseOne(true));
          break;
        case 'background': {
          if (device.appState === 'background') break;
          await act(async () => {
            device.emitAppState('inactive');
            device.emitAppState('background');
          });
          note(action);
          break;
        }
        case 'foreground': {
          if (device.appState !== 'background') break;
          const suspendedMs = rng.pick([500, 5_000, 29_000, 31_000, 120_000]);
          jest.setSystemTime(Date.now() + suspendedMs);
          await act(async () => {
            device.emitAppState('active');
          });
          await flush();
          note(action, `${suspendedMs}ms`);
          break;
        }
        case 'kill_relaunch':
          await relaunch('kill');
          note(action);
          break;
        case 'account_switch': {
          const target = rng.pick([
            OWNER_B,
            OWNER_B,
            OWNER_A,
            SIGNED_OUT_DATA_OWNER,
            GUEST_DATA_OWNER,
          ]);
          if (target === device.vaultOwner) break;
          // Sign-out in the app unmounts RootNavigator; the next owner
          // re-hydrates from the Keychain. Modeled as unmount → relaunch.
          device.vaultOwner = target;
          switchedTo = target;
          await relaunch(`switch→${target.slice(0, 8)}`);
          note(action, target.slice(0, 8));
          break;
        }
        case 'pop': {
          if (!tree || !formReviewFocused()) break;
          await act(async () => {
            tree!.nav.goBack();
          });
          await flush();
          note(action);
          break;
        }
        case 'reopen': {
          if (!tree || formReviewMounted()) break;
          param = rng.pick([idA, idA, idB, idOther]);
          device.epoch += 1;
          loadEpoch = device.epoch;
          await act(async () => {
            tree!.nav.navigate('FormReview', { analysisId: param });
          });
          await flush();
          note(action, param.slice(-5));
          break;
        }
        case 'param_change': {
          if (!tree || !formReviewFocused()) break;
          const next = rng.pick([idA, idB, idOther].filter(id => id !== param));
          param = next;
          device.epoch += 1;
          loadEpoch = device.epoch;
          await act(async () => {
            tree!.nav.navigate('FormReview', { analysisId: next });
          });
          await flush();
          note(action, next.slice(-5));
          break;
        }
        case 'push_away': {
          if (!tree) break;
          const focused = focusedRoute(tree.nav)?.name;
          if (focused === 'Analyze') {
            await act(async () => {
              tree!.nav.goBack();
            });
            note(action, 'back');
          } else {
            await act(async () => {
              tree!.nav.navigate('Analyze', { source: 'library' });
            });
            note(action, 'analyze');
          }
          await flush();
          break;
        }
        case 'token_rotate': {
          bearerSerial += 1;
          if (rotateBearer(`bearer-${seed}-${bearerSerial}`)) {
            assertSessionBound('token rotation');
            note(action);
          }
          break;
        }
        case 'revoke_artifact': {
          const owner = getActiveDataOwner();
          const victim = strokes.find(
            stroke => stroke.owner === owner && stroke.analysisId === param,
          );
          if (!victim) break;
          const which = rng.pick(['sidecar', 'clip'] as const);
          const uri = which === 'sidecar' ? victim.sidecarUri : victim.clipUri;
          if (!device.files.delete(uri)) break;
          note(action, which);
          break;
        }
        case 'press': {
          if (!tree || !formReviewFocused()) break;
          const state = visibleState(tree.renderer);
          if (state.kind === 'ready') {
            const target = rng.pick([
              'form-review-play',
              'form-review-play',
              'form-review-speed',
              'form-review-next-stop',
              'form-review-prev-stop',
              'form-review-autopause',
              'form-review-stage',
            ]);
            const node = pressable(tree.renderer, target);
            if (!node) break;
            await act(async () => {
              node.props.onPress();
            });
            await act(async () => {
              jest.advanceTimersByTime(rng.pick([16, 120, 480, 1200]));
            });
            note(action, target.replace('form-review-', ''));
          } else if (state.kind === 'missing') {
            const retry = tree.renderer.root.findAll(
              node =>
                typeof node.props.onPress === 'function' &&
                node.props.label === 'Try again',
            )[0];
            if (!retry) break;
            await act(async () => {
              retry.props.onPress();
            });
            await flush();
            note(action, 'missing-retry');
          }
          break;
        }
        case 'reanalyze': {
          if (!tree || !formReviewFocused()) break;
          const node = pressable(tree.renderer, 'form-review-reanalyze');
          if (!node) break;
          const state = visibleState(tree.renderer);
          const mountsBefore = device.analyzeMounts.length;
          await act(async () => {
            node.props.onPress();
          });
          await flush();
          const mounted = device.analyzeMounts[mountsBefore];
          if (!mounted) {
            failures.push('reanalyze: Analyze route did not mount');
          } else if (state.kind !== 'ready') {
            failures.push(`reanalyze: pressed while ${state.kind}`);
          } else if (mounted.handoff?.sessionId !== state.sessionId) {
            failures.push(
              `I4 reanalyze: handoff set ${String(mounted.handoff?.sessionId)} ≠ shown ${String(state.sessionId)}`,
            );
          } else if (mounted.params?.source !== 'camera') {
            failures.push('reanalyze: Analyze not opened with source=camera');
          }
          // Come back to the review as a user would.
          await act(async () => {
            tree!.nav.goBack();
          });
          await flush();
          note(action);
          break;
        }
        case 'tick': {
          const ms = rng.pick([16, 50, 200, 700, 2_000]);
          await act(async () => {
            jest.advanceTimersByTime(ms);
          });
          note(action, `${ms}ms`);
          break;
        }
      }
    }

    // ── Settle and assert ──
    await settle();
    // Return to the review if the schedule left another route on top, or
    // re-open it if the schedule popped it (a fresh load on a new epoch).
    if (tree && formReviewMounted() && !formReviewFocused()) {
      await act(async () => {
        tree!.nav.goBack();
      });
      await flush();
    } else if (tree && !formReviewMounted()) {
      device.epoch += 1;
      loadEpoch = device.epoch;
      await act(async () => {
        tree!.nav.navigate('FormReview', { analysisId: param });
      });
      await settle();
      reopenedAtSettle = true;
    }
    if (tree && formReviewMounted()) {
      const owner = getActiveDataOwner();
      const shown = visibleState(tree.renderer);
      settledState = shown;
      const expected = expectedState(strokes, owner, param, loadEpoch);
      if (JSON.stringify(shown) !== JSON.stringify(expected)) {
        failures.push(
          `I1 settled: shown ${JSON.stringify(shown)} expected ${JSON.stringify(expected)}`,
        );
      }
      if (switchedTo !== null && owner !== OWNER_A) {
        const json = JSON.stringify(tree.renderer.toJSON());
        for (const marker of ownerAMarkers) {
          if (json.includes(marker)) {
            failures.push(`I4 previous owner marker "${marker}" in tree`);
          }
        }
      }

      // I3: kill → relaunch twice must be idempotent.
      await relaunch('rehydrate-1');
      await settle();
      const first = canonicalTree(tree!.renderer);
      const firstState = visibleState(tree!.renderer);
      await relaunch('rehydrate-2');
      await settle();
      const second = canonicalTree(tree!.renderer);
      if (first !== second) {
        let at = 0;
        while (at < first.length && first[at] === second[at]) at++;
        failures.push(
          `I3 relaunch twice rendered differently at ${at}: …${first.slice(at - 60, at + 60)}… vs …${second.slice(at - 60, at + 60)}…`,
        );
      }
      const rehydrated = expectedState(
        strokes,
        getActiveDataOwner(),
        param,
        loadEpoch,
      );
      if (JSON.stringify(firstState) !== JSON.stringify(rehydrated)) {
        failures.push(
          `I3 rehydrate: shown ${JSON.stringify(firstState)} expected ${JSON.stringify(rehydrated)}`,
        );
      }
      // Rows survived the kill (re-hydrate really read the persisted store).
      if (
        rehydrated.kind === 'ready' &&
        device.log.filter(r => r.epoch === loadEpoch && r.kind === 'sql.shot')
          .length !== 1
      ) {
        failures.push('I3 rehydrate did not issue exactly one shot read');
      }
    } else if (tree === null) {
      failures.push('harness: tree unexpectedly null at settle');
    }

    if (tree) await unmountTree(tree);
    tree = null;
    await assertTornDown('final unmount');
  } catch (error) {
    failures.push(
      `exception: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
    );
    if (tree) {
      try {
        await unmountTree(tree);
      } catch {
        // already torn down
      }
    }
  } finally {
    device.mode = 'immediate';
    for (const op of [...device.pending]) op.resolve();
    await flush();
    try {
      getDb().close();
    } catch {
      // never opened
    }
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    jest.clearAllTimers();
    timers.live.clear();
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  }
  for (const line of errors) failures.push(`I5 ${line}`);

  const finalOwner = device.vaultOwner;
  return {
    seed,
    outcome: failures.length === 0 ? 'HELD' : 'BROKEN',
    steps,
    failures,
    scenario: { ownerBSameId, sidecarA, sidecarB, captureA, captureB },
    counts,
    finalState: settledState,
    finalOwner,
    frameworkTimerResidue: frameworkResidue,
    reopenedAtSettle,
    opsReleased: device.log.filter(r => r.outcome === 'ok').length,
    opsFailed: device.log.filter(r => r.outcome !== 'ok').length,
  };
}

// ─── Campaign ───────────────────────────────────────────────────────────────

const seeds =
  ONLY_SEED !== null
    ? [ONLY_SEED]
    : Array.from({ length: ITERATIONS }, (_, i) => BASE_SEED + i);
const chunks: number[][] = [];
for (let i = 0; i < seeds.length; i += CHUNK)
  chunks.push(seeds.slice(i, i + CHUNK));

beforeAll(() => {
  installNativeBoundaries();
  jest.useFakeTimers();
  timers.install();
});

afterAll(() => {
  timers.uninstall();
  jest.useRealTimers();
  const broken = results.filter(r => r.outcome === 'BROKEN');
  const summary = {
    unit: 'scr-formreviewscreen',
    lens: 'lifecycle',
    baseSeed: BASE_SEED,
    iterations: results.length,
    held: results.length - broken.length,
    broken: broken.length,
    brokenSeeds: broken.map(r => r.seed),
    actionTotals: results.reduce<Record<string, number>>((acc, r) => {
      for (const [k, v] of Object.entries(r.counts))
        acc[k] = (acc[k] ?? 0) + (v ?? 0);
      return acc;
    }, {}),
    opsReleased: results.reduce((n, r) => n + r.opsReleased, 0),
    opsFailed: results.reduce((n, r) => n + r.opsFailed, 0),
  };
  if (OUT_DIR) {
    const dir = OUT_DIR.startsWith('/')
      ? OUT_DIR
      : join(__dirname, '..', '..', OUT_DIR);
    mkdirSync(dir, { recursive: true });
    const suffix = ONLY_SEED !== null ? `-seed-${ONLY_SEED}` : '';
    writeFileSync(
      join(dir, `formreviewscreen-lifecycle-summary${suffix}.json`),
      JSON.stringify(summary, null, 2),
    );
    writeFileSync(
      join(dir, `formreviewscreen-lifecycle-results${suffix}.json`),
      JSON.stringify(results, null, 2),
    );
  }
});

describe('FormReviewScreen × lifecycle interruption (seeded)', () => {
  for (const chunk of chunks) {
    const label = `seeds ${chunk[0]}…${chunk[chunk.length - 1]}`;
    it(`holds I1–I5 for ${label}`, async () => {
      const chunkResults: IterationResult[] = [];
      for (const seed of chunk) {
        const result = await runIteration(seed);
        results.push(result);
        chunkResults.push(result);
      }
      const broken = chunkResults.filter(r => r.outcome === 'BROKEN');
      expect(
        broken.map(r => ({
          seed: r.seed,
          failures: r.failures,
          steps: r.steps,
        })),
      ).toEqual([]);
    }, 120_000);
  }
});
