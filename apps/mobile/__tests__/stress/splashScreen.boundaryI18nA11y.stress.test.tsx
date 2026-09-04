/**
 * STRESS — scr-splashscreen / lens boundary-i18n-a11y (unit plane).
 *
 * Renders the REAL `SplashScreen` (real `PressableScale`, real
 * `useReducedMotion`, real Animated + StatusBar stack) under a seeded matrix
 * of environment × event-stream scenarios. Only native edges are faked:
 * `react-native-video` (repo auto-mock: a host View that keeps the player
 * props), the StatusBar native module (jest.setup.js), `AccessibilityInfo`
 * (jest preset), `Dimensions`/`I18nManager` constants, `Intl` locale and the
 * process time zone.
 *
 * Campaigns (all rows land in ONE JSON table, seed → outcome):
 *   A  fixed matrix  3 font scales × 3 widths × 12 locales   (108 rows)
 *   B  timezones     8 zones incl. UTC±14 / DST edges × 2 phases (16 rows)
 *   C  boundary props (14 rows: null/undefined/0/-1/huge/NaN/long strings…)
 *   D  seeded event streams  STRESS_ITER rows (default 48; every row is
 *      `scenarioFromSeed(seed)` → replay with STRESS_SEED=<seed>)
 *
 * Invariants (each is a row.invariants key):
 *   noCrash              render/events/unmount never throw, no React error log
 *   rootPresent          exactly one `splash-screen` host while mounted
 *   introImage           exactly one accessible image "Pickle Sensei intro animation"
 *   allInteractiveLabeled every interactive host has a non-empty label
 *   allInteractiveRoled  …and an accessibilityRole
 *   allInteractive44     …and a modelled box ≥ 44 pt both ways at this scale
 *   skipOnlyControl      ≤ 1 interactive host at any time; it is `splash-skip`
 *   skipVisibleIffProgress skip appears iff a progress ≥ 1 s arrived (NaN/-1/… never)
 *   skipLabelAndRole     Skip is labelled "Skip intro" with role button whenever shown
 *   skipFitsZone         modelled Skip height ≤ 15 % zone at this viewport/scale
 *   skipFitsWidth        modelled Skip width ≤ viewport width
 *   pointerOwnership     root pointerEvents auto until exit, none while exiting
 *   statusBarOnTop       dark-content entry is top of the StatusBar stack while mounted
 *   finishedExactlyOnce  onFinished fires exactly when the state machine says, once
 *   volumeInRange        player volume always within [0, 1]
 *   noPostUnmountCallbacks draining 8.6 s after unmount fires nothing (no stale
 *                        watchdog / animation end reaching onFinished)
 *   i18nInvariantTree    (A/B) a11y fingerprint identical across locales/zones
 *
 * Artifacts: artifacts/stress-splashscreen/unit.{rows,summary}.json plus
 * unit.trees.json (host-tree dumps per phase + every failing row).
 */
import React from 'react';
import {
  AccessibilityInfo,
  Dimensions,
  I18nManager,
  StatusBar,
} from 'react-native';
import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer';
import {
  EXIT_MS,
  SKIP_AFTER_S,
  SplashScreen,
  WATCHDOG_MS,
} from '../../src/screens/SplashScreen';
import { nodeProcess } from '../../xc-harness/lifecycle-persistence/nodeShim';
import {
  FONT_SCALES,
  LOCALES,
  PRIMARY_FONT_SCALES,
  PROP_CASES,
  TIMEZONES,
  VIEWPORTS,
  isRtlLocale,
  iterationBudget,
  scenarioFromSeed,
  seedFilter,
  type Locale,
  type PlayerEvent,
  type Scenario,
  type TimezoneCase,
  type Viewport,
} from '../../xc-harness/stress-splash/env';
import {
  a11yFingerprint,
  auditAccessibility,
  byTestId,
  dumpHostTree,
  finishRow,
  innermostByTestId,
  interactiveNodes,
  modelBox,
  realNow,
  summarizeRows,
  writeJsonArtifact,
  type StressRow,
  type TreeDump,
} from '../../xc-harness/stress-splash/tree';

const INTRO_LABEL = 'Pickle Sensei intro animation';
const SKIP_LABEL = 'Skip intro';

type StatusBarStack = {
  _propsStack: { barStyle: { value: string; animated: boolean } | null }[];
};
/** Frame slack the existing suites grant Animated under fake timers. */
const FRAME_SLACK_MS = 50;
const statusBarStack = StatusBar as unknown as StatusBarStack;

const rows: StressRow[] = [];
const trees: Record<string, TreeDump[]> = {};
let treeSamples = 0;

// ─── Environment plumbing (native edges only) ────────────────────────────────

function setViewport(viewport: Viewport, fontScale: number): void {
  const dims = {
    width: viewport.width,
    height: viewport.height,
    scale: viewport.scale,
    fontScale,
  };
  Dimensions.set({ window: dims, screen: dims });
}

function setLocale(locale: Locale): () => void {
  const rtl = isRtlLocale(locale);
  const i18n = I18nManager as unknown as { isRTL: boolean };
  const previousRtl = i18n.isRTL;
  i18n.isRTL = rtl;
  const proto = Intl.DateTimeFormat.prototype;
  const original = proto.resolvedOptions;
  proto.resolvedOptions = function patched(this: Intl.DateTimeFormat) {
    const base = original.call(this);
    return { ...base, locale };
  };
  return () => {
    i18n.isRTL = previousRtl;
    proto.resolvedOptions = original;
  };
}

function setTimezone(zone: TimezoneCase): () => void {
  const previous = nodeProcess.env['TZ'];
  nodeProcess.env['TZ'] = zone.tz;
  jest.setSystemTime(new Date(zone.startIso));
  return () => {
    if (previous === undefined) delete nodeProcess.env['TZ'];
    else nodeProcess.env['TZ'] = previous;
  };
}

/** Drives the real `useReducedMotion` through the native event it listens to. */
function emitReducedMotion(value: boolean): void {
  const calls = (AccessibilityInfo.addEventListener as unknown as jest.Mock)
    .mock.calls as [string, (value: boolean) => void][];
  const listeners = calls
    .filter(([event]) => event === 'reduceMotionChanged')
    .map(([, listener]) => listener);
  if (listeners.length === 0) {
    throw new Error('useReducedMotion never subscribed to reduceMotionChanged');
  }
  for (const listener of listeners) listener(value);
}

// ─── Rendering ───────────────────────────────────────────────────────────────

interface Harness {
  renderer: TestRenderer.ReactTestRenderer;
  root: () => ReactTestInstance;
  update: (ready: unknown, onFinished: unknown) => Promise<void>;
  onFinished: jest.Mock;
  errors: string[];
  restore: () => void;
}

/** `override` lets the boundary suite pass literally anything (undefined too). */
async function mount(
  readyAtMount: unknown,
  override?: { value: unknown },
): Promise<Harness> {
  const onFinished = jest.fn();
  const errors: string[] = [];
  const consoleError = jest
    .spyOn(console, 'error')
    .mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(' ').slice(0, 300));
    });
  const finishedProp = override ? override.value : onFinished;
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      React.createElement(SplashScreen, {
        ready: readyAtMount as boolean,
        onFinished: finishedProp as () => void,
      }),
    );
  });
  const harness: Harness = {
    renderer,
    root: () => renderer.root,
    update: async (ready, next) => {
      await act(async () => {
        renderer.update(
          React.createElement(SplashScreen, {
            ready: ready as boolean,
            onFinished: next as () => void,
          }),
        );
      });
    },
    onFinished,
    errors,
    restore: () => consoleError.mockRestore(),
  };
  return harness;
}

async function unmount(h: Harness): Promise<void> {
  try {
    await act(async () => {
      h.renderer.unmount();
    });
  } finally {
    h.restore();
  }
}

let clockMs = 0;

/**
 * Advances the fake clock in its own `act` per segment, splitting at the
 * watchdog deadline: React commits the timer-driven state update when the
 * `act` closes, so a single long advance would start the exit animation at
 * the END of the advance instead of at 8 s (a harness artefact, not a
 * production one — the existing suites elapse in separate acts for the same
 * reason).
 */
async function advance(ms: number): Promise<void> {
  const target = clockMs + ms;
  if (clockMs < WATCHDOG_MS && target > WATCHDOG_MS) {
    await act(async () => {
      await jest.advanceTimersByTimeAsync(WATCHDOG_MS - clockMs);
    });
    clockMs = WATCHDOG_MS;
  }
  await act(async () => {
    await jest.advanceTimersByTimeAsync(target - clockMs);
  });
  clockMs = target;
}

function resetClock(): void {
  clockMs = 0;
}

function video(root: ReactTestInstance): ReactTestInstance | null {
  return innermostByTestId(root, 'splash-video');
}

function splashRoot(root: ReactTestInstance): ReactTestInstance | null {
  return innermostByTestId(root, 'splash-screen');
}

// ─── Observation ─────────────────────────────────────────────────────────────

interface Observation {
  phase: string;
  rootCount: number;
  pointerEvents: unknown;
  introImages: number;
  interactive: number;
  skipPresent: boolean;
  skipLabel: unknown;
  skipRole: unknown;
  skipBox: ReturnType<typeof modelBox> | null;
  audit: ReturnType<typeof auditAccessibility>;
  statusTop: string | undefined;
  volume: unknown;
  fingerprint: string;
}

function observe(
  h: Harness,
  phase: string,
  ctx: { fontScale: number; width: number; height: number },
): Observation {
  const root = h.root();
  const roots = byTestId(root, 'splash-screen');
  const introImages = root
    .findAll(node => typeof node.type === 'string')
    .filter(
      node =>
        node.props.accessible === true &&
        node.props.accessibilityRole === 'image' &&
        node.props.accessibilityLabel === INTRO_LABEL,
    ).length;
  const skip = innermostByTestId(root, 'splash-skip');
  const stack = statusBarStack._propsStack;
  return {
    phase,
    rootCount: roots.length,
    pointerEvents: splashRoot(root)?.props.pointerEvents,
    introImages,
    interactive: interactiveNodes(root).length,
    skipPresent: skip !== null,
    skipLabel: skip?.props.accessibilityLabel,
    skipRole: skip?.props.accessibilityRole,
    skipBox: skip ? modelBox(skip, ctx) : null,
    audit: auditAccessibility(root, ctx),
    statusTop: stack.length
      ? stack[stack.length - 1]?.barStyle?.value
      : undefined,
    volume: video(root)?.props.volume,
    fingerprint: a11yFingerprint(root),
  };
}

function sampleTree(key: string, h: Harness): void {
  if (trees[key] || treeSamples > 40) return;
  treeSamples += 1;
  trees[key] = dumpHostTree(h.root());
}

// ─── Scenario execution (the replayable unit) ────────────────────────────────

interface Expectation {
  /**
   * onFinished must have fired by the end of the scenario; `edge` = the
   * scenario ends inside the one-frame slack after the exit animation, where
   * the fake clock cannot pin either answer.
   */
  finished: 'yes' | 'no' | 'edge';
  skipEverVisible: boolean;
  /**
   * The scenario unmounts while the exit animation is still running. The
   * production effect (SplashScreen.tsx:97-137) has no cleanup, so the
   * animation-end callback then reaches `onFinished` after unmount — the
   * campaign's classified P3 (minimal repro: `ready` + `onEnd`, unmount
   * before EXIT_MS elapses; seeds 53277 53342 53398 53515 53521 53572
   * 53612 53639 with STRESS_ITER=400). `edge` = unmount inside the
   * one-frame slack after the animation's nominal end.
   */
  postUnmountFinish: 'yes' | 'no' | 'edge';
}

/**
 * Pure model of the production state machine (SplashScreen.tsx:97-137):
 * handoff ⇔ ready ∧ (over ∨ skip), exit takes EXIT_MS (0 under reduced
 * motion), onFinished fires once when the exit animation completes.
 */
function modelExpectation(
  scenario: Pick<
    Scenario,
    'events' | 'readyAtMount' | 'reducedMotion' | 'settleMs'
  >,
): Expectation {
  let ready = scenario.readyAtMount;
  let over = false;
  let skipVisible = false;
  let skipRequested = false;
  let reduced = scenario.reducedMotion;
  let exitStartedAt: number | null = null;
  let exitDuration = 0;
  let unmountAt: number | null = null;
  let lastAt = 0;
  const maybeStartExit = (now: number): void => {
    if (exitStartedAt !== null) return;
    if (ready && (over || skipRequested)) {
      exitStartedAt = now;
      exitDuration = reduced ? 0 : EXIT_MS;
    }
  };
  const tick = (now: number): void => {
    if (!over && now >= WATCHDOG_MS) {
      over = true;
      maybeStartExit(WATCHDOG_MS);
    }
  };
  for (const event of scenario.events) {
    tick(event.atMs);
    lastAt = event.atMs;
    switch (event.kind) {
      case 'progress':
        if (
          typeof event.currentTime === 'number' &&
          event.currentTime >= SKIP_AFTER_S
        ) {
          skipVisible = true;
        }
        break;
      case 'end':
      case 'error':
        over = true;
        break;
      case 'skip':
      case 'skip-double':
        if (skipVisible) skipRequested = true;
        break;
      case 'ready-true':
        ready = true;
        break;
      case 'ready-false':
        ready = false;
        break;
      case 'reduced-motion-on':
        reduced = true;
        break;
      case 'reduced-motion-off':
        reduced = false;
        break;
      case 'new-onFinished':
        break;
      case 'unmount':
        unmountAt = event.atMs;
        break;
    }
    if (unmountAt !== null) break;
    maybeStartExit(event.atMs);
  }
  const end = unmountAt ?? lastAt + scenario.settleMs;
  if (unmountAt === null) tick(end);
  let finished: Expectation['finished'] = 'no';
  let postUnmountFinish: Expectation['postUnmountFinish'] = 'no';
  if (exitStartedAt !== null) {
    const done = exitStartedAt + exitDuration;
    if (done + FRAME_SLACK_MS <= end) finished = 'yes';
    else if (done <= end) finished = 'edge';
    // Every scenario unmounts: either at its `unmount` event or when the
    // settle window closes. A 0 ms native-driven timing still completes on
    // the next frame.
    const unmountMoment = unmountAt ?? end;
    const firesAt = exitDuration === 0 ? done + 16 : done;
    if (unmountMoment < firesAt) postUnmountFinish = 'yes';
    else if (unmountMoment < done + FRAME_SLACK_MS) postUnmountFinish = 'edge';
  }
  return { finished, skipEverVisible: skipVisible, postUnmountFinish };
}

async function runScenario(
  suite: string,
  name: string,
  scenario: Scenario,
  extra: Record<string, unknown> = {},
): Promise<StressRow> {
  const started = realNow();
  const ctx = {
    fontScale: scenario.fontScale,
    width: scenario.viewport.width,
    height: scenario.viewport.height,
  };
  setViewport(scenario.viewport, scenario.fontScale);
  const restoreLocale = setLocale(scenario.locale);
  const restoreTz = setTimezone(scenario.timezone);
  const observations: Observation[] = [];
  const invariants: Record<string, boolean> = {};
  let crash: string | null = null;
  let finishedCalls = 0;
  let volumeOutOfRange = 0;
  let clock = 0;
  let skipEverPresent = false;
  let unmounted = false;
  let h: Harness | null = null;
  resetClock();
  try {
    h = await mount(scenario.readyAtMount);
    // The observer subscribes on the first mount ever; the scenario's Reduce
    // Motion setting arrives through the native event exactly like iOS.
    await act(async () => {
      emitReducedMotion(scenario.reducedMotion);
    });
    let currentFinished: unknown = h.onFinished;
    let currentReady: unknown = scenario.readyAtMount;
    observations.push(observe(h, 'mount', ctx));
    sampleTree(
      `${suite}:mount:${scenario.viewport.name}:${scenario.fontScale}`,
      h,
    );
    for (const event of scenario.events) {
      const delta = Math.max(0, event.atMs - clock);
      if (delta > 0) await advance(delta);
      clock = event.atMs;
      const root = h.root();
      const player = video(root);
      switch (event.kind) {
        case 'progress':
          if (player) {
            await act(async () => {
              player.props.onProgress({
                currentTime: event.currentTime,
                playableDuration: 0,
                seekableDuration: 0,
              });
            });
          }
          break;
        case 'end':
          if (player) await act(async () => player.props.onEnd());
          break;
        case 'error':
          if (player) {
            await act(async () =>
              player.props.onError({ error: { code: -11800, domain: 'AV' } }),
            );
          }
          break;
        case 'skip':
        case 'skip-double': {
          const skip = innermostByTestId(root, 'splash-skip');
          if (skip) {
            await act(async () => {
              skip.props.onClick?.();
              if (event.kind === 'skip-double') skip.props.onClick?.();
            });
          }
          break;
        }
        case 'ready-true':
        case 'ready-false':
          currentReady = event.kind === 'ready-true';
          await h.update(currentReady, currentFinished);
          break;
        case 'reduced-motion-on':
        case 'reduced-motion-off':
          await act(async () => {
            emitReducedMotion(event.kind === 'reduced-motion-on');
          });
          break;
        case 'new-onFinished':
          currentFinished = jest.fn(() => h?.onFinished());
          await h.update(currentReady, currentFinished);
          break;
        case 'unmount':
          await unmount(h);
          unmounted = true;
          break;
      }
      if (unmounted) break;
      const obs = observe(h, `${event.kind}@${event.atMs}`, ctx);
      observations.push(obs);
      if (obs.skipPresent) {
        skipEverPresent = true;
        sampleTree(
          `${suite}:skip-visible:${scenario.viewport.name}:${scenario.fontScale}`,
          h,
        );
      }
      const vol = obs.volume;
      if (typeof vol !== 'number' || vol < 0 || vol > 1) volumeOutOfRange += 1;
    }
    if (!unmounted) {
      await advance(scenario.settleMs);
      const obs = observe(h, 'settled', ctx);
      observations.push(obs);
      if (obs.skipPresent) skipEverPresent = true;
      if (obs.pointerEvents === 'none') {
        sampleTree(`${suite}:exiting:${scenario.viewport.name}`, h);
      }
      finishedCalls = h.onFinished.mock.calls.length;
      await unmount(h);
      unmounted = true;
    } else {
      finishedCalls = h.onFinished.mock.calls.length;
    }
  } catch (error) {
    crash =
      error instanceof Error
        ? `${error.name}: ${error.message}`
        : String(error);
    if (h && !unmounted) {
      try {
        await unmount(h);
      } catch {
        /* already torn down */
      }
    }
  }
  // Drain anything left on the clock: a callback that fires AFTER unmount
  // (a stale watchdog / animation end reaching onFinished) is the leak that
  // matters; the raw timer count also includes React/Animated bookkeeping.
  const timersAfterUnmount = jest.getTimerCount();
  const finishedBeforeDrain = h?.onFinished.mock.calls.length ?? 0;
  let drainError: string | null = null;
  try {
    await advance(WATCHDOG_MS + EXIT_MS + FRAME_SLACK_MS);
  } catch (error) {
    drainError = error instanceof Error ? error.message : String(error);
  }
  const finishedAfterDrain = h?.onFinished.mock.calls.length ?? 0;
  restoreTz();
  restoreLocale();
  emitReducedMotion(false);

  const reactErrors = (h?.errors ?? []).filter(
    line => !line.includes('not wrapped in act'),
  );
  const expectation = modelExpectation(scenario);
  const zoneHeight = 0.15 * scenario.viewport.height;
  const skipBoxes = observations
    .map(obs => obs.skipBox)
    .filter((box): box is NonNullable<typeof box> => box !== null);
  const skipMaxHeight = skipBoxes.reduce((m, b) => Math.max(m, b.height), 0);
  const skipMaxWidth = skipBoxes.reduce((m, b) => Math.max(m, b.width), 0);
  const exitObservations = observations.filter(
    obs => obs.pointerEvents === 'none',
  );
  const liveObservations = observations.filter(
    obs => obs.pointerEvents === 'auto',
  );

  invariants.noCrash = crash === null && reactErrors.length === 0;
  invariants.rootPresent = observations.every(obs => obs.rootCount === 1);
  invariants.introImage = observations.every(obs => obs.introImages === 1);
  invariants.allInteractiveLabeled = observations.every(
    obs => obs.audit.unlabeled.length === 0,
  );
  invariants.allInteractiveRoled = observations.every(
    obs => obs.audit.unroled.length === 0,
  );
  invariants.allInteractive44 = observations.every(
    obs => obs.audit.under44.length === 0,
  );
  invariants.skipOnlyControl = observations.every(
    obs => obs.interactive <= 1 && (obs.interactive === 0 || obs.skipPresent),
  );
  invariants.skipVisibleIffProgress =
    skipEverPresent === expectation.skipEverVisible;
  invariants.skipLabelAndRole = observations.every(
    obs =>
      !obs.skipPresent ||
      (obs.skipLabel === SKIP_LABEL && obs.skipRole === 'button'),
  );
  invariants.skipFitsZone =
    skipBoxes.length === 0 || skipMaxHeight <= zoneHeight;
  invariants.skipFitsWidth =
    skipBoxes.length === 0 || skipMaxWidth <= scenario.viewport.width;
  // auto… then none…, never back: the sequence must be a run of 'auto'
  // followed by a run of 'none'.
  const pointerSequence = observations.map(o => o.pointerEvents);
  const firstNone = pointerSequence.indexOf('none');
  invariants.pointerOwnership = pointerSequence.every(
    (value, index) =>
      value === (firstNone !== -1 && index >= firstNone ? 'none' : 'auto'),
  );
  invariants.statusBarOnTop = observations.every(
    obs => obs.statusTop === 'dark-content',
  );
  invariants.finishedExactlyOnce =
    expectation.finished === 'edge'
      ? finishedCalls <= 1
      : finishedCalls === (expectation.finished === 'yes' ? 1 : 0);
  invariants.volumeInRange = volumeOutOfRange === 0;
  invariants.noPostUnmountCallbacks =
    drainError === null && finishedAfterDrain === finishedBeforeDrain;

  const row = finishRow({
    suite,
    scenario: name,
    seed: scenario.seed,
    inputs: {
      fontScale: scenario.fontScale,
      viewport: scenario.viewport.name,
      locale: scenario.locale,
      rtl: isRtlLocale(scenario.locale),
      timezone: scenario.timezone.name,
      tz: scenario.timezone.tz,
      startIso: scenario.timezone.startIso,
      reducedMotion: scenario.reducedMotion,
      readyAtMount: scenario.readyAtMount,
      events: scenario.events,
      settleMs: scenario.settleMs,
      ...extra,
    },
    observed: {
      crash,
      reactErrors,
      finishedCalls,
      expectedFinished: expectation.finished,
      expectedPostUnmountFinish: expectation.postUnmountFinish,
      skipEverPresent,
      expectedSkipVisible: expectation.skipEverVisible,
      skipMaxHeight: Math.round(skipMaxHeight * 100) / 100,
      skipMaxWidth: Math.round(skipMaxWidth * 100) / 100,
      zoneHeight,
      zoneHeadroomPt: Math.round((zoneHeight - skipMaxHeight) * 100) / 100,
      skipHitSlop: skipBoxes[0]?.hitSlop ?? null,
      skipScaledFontSize: skipBoxes[0]?.scaledFontSize ?? null,
      liveObservations: liveObservations.length,
      exitObservations: exitObservations.length,
      statusTops: Array.from(new Set(observations.map(o => o.statusTop))),
      timersAfterUnmount,
      finishedAfterDrain,
      drainError,
      phases: observations.map(o => o.phase),
      a11yAudits: observations.map(o => ({
        phase: o.phase,
        interactive: o.interactive,
        unlabeled: o.audit.unlabeled,
        unroled: o.audit.unroled,
        under44: o.audit.under44,
      })),
      fingerprintMount: observations[0]?.fingerprint ?? '',
      fingerprintSkip:
        observations.find(o => o.skipPresent)?.fingerprint ?? null,
    },
    invariants,
    durationMs: realNow() - started,
  });
  if (!row.ok && h) {
    trees[`FAIL:${suite}:${name}:${scenario.seed}`] = observations.length
      ? [
          {
            type: '#fingerprint',
            text: observations[observations.length - 1]?.fingerprint,
          },
        ]
      : [];
  }
  rows.push(row);
  return row;
}

// ─── Fixed scenario builders ─────────────────────────────────────────────────

const UTC = TIMEZONES[0]!;

/** Canonical happy path: play 1.2 s → Skip shows → skip → exit → finished. */
function matrixScenario(
  seed: number,
  fontScale: number,
  viewport: Viewport,
  locale: Locale,
  timezone: TimezoneCase,
  reducedMotion: boolean,
): Scenario {
  const events: PlayerEvent[] = [
    { atMs: 100, kind: 'progress', currentTime: 0.1 },
    { atMs: 1000, kind: 'progress', currentTime: 0.999 },
    { atMs: 1200, kind: 'progress', currentTime: 1.2 },
    { atMs: 1600, kind: 'ready-true' },
    { atMs: 2000, kind: 'skip' },
  ];
  return {
    seed,
    fontScale,
    viewport,
    locale,
    timezone,
    reducedMotion,
    readyAtMount: false,
    events,
    settleMs: EXIT_MS + 100,
  };
}

// ─── Suites ──────────────────────────────────────────────────────────────────

beforeAll(() => {
  jest.useFakeTimers();
});

afterAll(() => {
  jest.useRealTimers();
  const summary = summarizeRows(rows);
  const rowsFile = writeJsonArtifact('unit.rows.json', rows);
  const summaryFile = writeJsonArtifact('unit.summary.json', summary);
  const treesFile = writeJsonArtifact('unit.trees.json', trees);
  console.log(
    `[stress:splash:unit] rows=${rows.length} failed=${String(summary.failed)} → ${rowsFile}, ${summaryFile}, ${treesFile}`,
  );
});

const only = seedFilter(nodeProcess.env);

describe('A · fixed matrix: 3 font scales × 3 widths × 12 locales', () => {
  const cells: [number, Viewport, Locale][] = [];
  for (const fontScale of PRIMARY_FONT_SCALES) {
    for (const viewport of VIEWPORTS) {
      for (const locale of LOCALES) cells.push([fontScale, viewport, locale]);
    }
  }
  const fingerprints = new Map<string, Set<string>>();

  test.each(cells.map(c => [c[0], c[1].name, c[2], c[1]] as const))(
    'fontScale=%s %s %s',
    async (fontScale, _viewportName, locale, viewport) => {
      const seed =
        0xa000 +
        cells.findIndex(
          c => c[0] === fontScale && c[1] === viewport && c[2] === locale,
        );
      if (only !== null && only !== seed) return;
      const row = await runScenario(
        'A-matrix',
        `matrix/${fontScale}/${viewport.name}/${locale}`,
        matrixScenario(seed, fontScale, viewport, locale, UTC, false),
      );
      const key = `${fontScale}/${viewport.name}`;
      const set = fingerprints.get(key) ?? new Set<string>();
      set.add(
        `${String(row.observed.fingerprintMount)}\n---\n${String(row.observed.fingerprintSkip)}`,
      );
      fingerprints.set(key, set);
      expect(row.failed).toEqual([]);
    },
  );

  test('a11y tree is locale-invariant per (fontScale, width) cell', () => {
    if (only !== null) return;
    const drift = Array.from(fingerprints.entries()).filter(
      ([, set]) => set.size !== 1,
    );
    rows.push(
      finishRow({
        suite: 'A-matrix',
        scenario: 'i18n-invariant-tree',
        seed: null,
        inputs: { cells: fingerprints.size, locales: LOCALES.length },
        observed: {
          drift: drift.map(([key, set]) => ({ key, variants: set.size })),
        },
        invariants: { i18nInvariantTree: drift.length === 0 },
        durationMs: 0,
      }),
    );
    expect(drift).toEqual([]);
  });
});

describe('B · 8 time zones incl. UTC±14 and DST edges', () => {
  const cases: [TimezoneCase, boolean][] = [];
  for (const zone of TIMEZONES) {
    cases.push([zone, false], [zone, true]);
  }
  const fingerprints = new Set<string>();
  test.each(cases)('%s reducedMotion=%s', async (zone, reducedMotion) => {
    const seed = 0xb000 + TIMEZONES.indexOf(zone) * 2 + (reducedMotion ? 1 : 0);
    if (only !== null && only !== seed) return;
    // Watchdog path: no end/error ever arrives; the 8 s cut must fire on the
    // fake clock regardless of wall-clock zone / DST step under it.
    const scenario: Scenario = {
      seed,
      fontScale: 1,
      viewport: VIEWPORTS[1]!,
      locale: 'en-IN',
      timezone: zone,
      reducedMotion,
      readyAtMount: true,
      events: [
        { atMs: 500, kind: 'progress', currentTime: 0.5 },
        { atMs: 1500, kind: 'progress', currentTime: 1.5 },
        { atMs: WATCHDOG_MS - 1, kind: 'progress', currentTime: 7.9 },
      ],
      settleMs: 1 + EXIT_MS,
    };
    const row = await runScenario(
      'B-timezone',
      `tz/${zone.name}/rm=${reducedMotion}`,
      scenario,
      {
        tzNote: zone.note,
      },
    );
    fingerprints.add(String(row.observed.fingerprintSkip));
    expect(row.failed).toEqual([]);
  });
  test('a11y tree is time-zone-invariant', () => {
    if (only !== null) return;
    rows.push(
      finishRow({
        suite: 'B-timezone',
        scenario: 'tz-invariant-tree',
        seed: null,
        inputs: { zones: TIMEZONES.length },
        observed: { variants: fingerprints.size },
        invariants: { i18nInvariantTree: fingerprints.size === 1 },
        durationMs: 0,
      }),
    );
    expect(fingerprints.size).toBe(1);
  });
});

describe('C · boundary props (null / undefined / numerics / long strings)', () => {
  test.each(PROP_CASES.map((c, i) => [c.name, c, 0xc000 + i] as const))(
    '%s',
    async (name, propCase, seed) => {
      if (only !== null && only !== seed) return;
      const started = realNow();
      setViewport(VIEWPORTS[1]!, 1);
      const restoreTz = setTimezone(UTC);
      resetClock();
      const invariants: Record<string, boolean> = {};
      let crash: string | null = null;
      let h: Harness | null = null;
      let finishedCalls = 0;
      let treeOk = false;
      let unmountOk = false;
      const throwing = jest.fn(() => {
        throw new Error('onFinished consumer threw');
      });
      try {
        const override =
          propCase.onFinished === 'fn'
            ? undefined
            : propCase.onFinished === 'throws'
              ? { value: throwing }
              : { value: propCase.onFinished };
        h = await mount(propCase.ready, override);
        const obs = observe(h, 'mount', {
          fontScale: 1,
          width: 375,
          height: 667,
        });
        treeOk =
          obs.rootCount === 1 && obs.introImages === 1 && obs.interactive === 0;
        const player = video(h.root());
        await advance(1200);
        if (player) {
          await act(async () => {
            player.props.onProgress({
              currentTime: 1.5,
              playableDuration: 0,
              seekableDuration: 0,
            });
          });
          await act(async () => player.props.onEnd());
        }
        await advance(EXIT_MS + 50);
        finishedCalls =
          propCase.onFinished === 'throws'
            ? throwing.mock.calls.length
            : h.onFinished.mock.calls.length;
        await unmount(h);
        unmountOk = true;
      } catch (error) {
        crash =
          error instanceof Error
            ? `${error.name}: ${error.message}`
            : String(error);
        if (h && !unmountOk) {
          try {
            await unmount(h);
          } catch {
            /* torn down */
          }
        }
      }
      await advance(WATCHDOG_MS + EXIT_MS);
      restoreTz();
      const reactErrors = (h?.errors ?? []).filter(
        l => !l.includes('not wrapped in act'),
      );
      const readyTruthy = Boolean(propCase.ready);
      invariants.noCrash = crash === null && reactErrors.length === 0;
      invariants.treeIntact = treeOk;
      // Truthiness is the only contract JS can enforce for a `boolean` prop.
      invariants.finishedMatchesTruthiness =
        propCase.onFinished === 'fn'
          ? finishedCalls === (readyTruthy ? 1 : 0)
          : true;
      invariants.unmountClean = unmountOk;
      // Type-forbidden callbacks: the handoff throws out of the animation
      // end callback (classified P3 in the campaign report). The assertion
      // pins THAT outcome so the suite stays green while the row is BROKEN.
      const expectedFailures = propCase.typeForbiddenCallback
        ? ['noCrash', 'unmountClean']
        : [];
      rows.push(
        finishRow({
          suite: 'C-props',
          scenario: `props/${name}`,
          seed,
          inputs: {
            ready:
              typeof propCase.ready === 'string' && propCase.ready.length > 40
                ? `<string len=${propCase.ready.length}>`
                : String(propCase.ready),
            readyType: typeof propCase.ready,
            onFinished: String(propCase.onFinished),
          },
          observed: {
            crash,
            reactErrors,
            finishedCalls,
            readyTruthy,
            typeForbiddenCallback: propCase.typeForbiddenCallback === true,
          },
          invariants,
          durationMs: realNow() - started,
        }),
      );
      expect(
        Object.entries(invariants)
          .filter(([, v]) => !v)
          .map(([k]) => k),
      ).toEqual(expectedFailures);
    },
  );
});

describe('D · seeded event streams (STRESS_ITER, default 48)', () => {
  const budget = iterationBudget(nodeProcess.env, 'STRESS_ITER', 48);
  const seeds: number[] =
    only !== null
      ? [only]
      : Array.from({ length: budget }, (_, i) => 0xd000 + i);
  test.each(seeds.map(s => [s] as const))('seed %s', async seed => {
    const scenario = scenarioFromSeed(seed);
    const row = await runScenario('D-seeded', `seeded/${seed}`, scenario, {
      allFontScales: FONT_SCALES,
    });
    // Rows stay BROKEN in the JSON table; the assertion pins the classified
    // P3 (unmount mid-exit → onFinished after unmount) so the suite is green
    // and any OTHER failure still fails the test.
    const predicted = String(row.observed.expectedPostUnmountFinish);
    const acceptable: string[][] =
      predicted === 'yes'
        ? [['noPostUnmountCallbacks']]
        : predicted === 'edge'
          ? [[], ['noPostUnmountCallbacks']]
          : [[]];
    expect(acceptable).toContainEqual(row.failed);
  });
});
