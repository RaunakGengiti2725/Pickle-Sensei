/**
 * SEEDED RANDOMIZED LONG-RUN — AnalyzeScreen inside the production
 * RootNavigator (real NavigationContainer / native-stack / tab navigators /
 * AnalyzeRoute access gate / zustand stores / sync runtime / SQLite
 * repository). Only native modules (camera bridge, SQLite JSI, notifications),
 * `fetch` and the sibling screens are replaced.
 *
 * Every sequence is replayable from its seed:
 *   STRESS_ITER=2000 STRESS_SEED_BASE=1000 STRESS_OUT=/tmp/stress.json \
 *     npx jest --ci __tests__/stress/analyzeScreenRandomizedSeeded
 *   STRESS_REPLAY_SEED=1234 npx jest --ci __tests__/stress/analyzeScreenRandomizedSeeded
 *
 * Invariants (checked after EVERY action — see
 * testing/stress/analyzeScreenStressDriver.tsx `checkInvariants`):
 *   I1  repeated capture-start never runs two native camera operations
 *   I2  at most one analysis permit reserved at a time; one permit per clip
 *   I3  no navigation to Result after abandonment / from outside Analyze
 *   I4  no orphaned "working" state once nothing is pending
 *   I5  typed `camera.cancelled` is a cancellation (ready / goBack)
 *   I6  message-only cancellation text is a capture FAILURE with "Try again"
 *   I7  imported clips never offer Auto Detect scoring
 *   I8  clips without a pose sequence never reach the permit stage / a score
 *   I9  only scored analyses create outbox sync work
 *   I10 an analysis auto-routes to Result at most once
 *   I11 access refresh happens after unmount and after the run settled
 *   I12 same seed twice → identical trace (determinism test below)
 *   I13 the free-limit surface appears only when the last free rating was spent
 *   I15 the navigator never holds two AnalyzeScreen instances at once
 *
 * Near-legal inputs the generator mixes in: double taps, blind taps on
 * controls that are not on screen, typed vs message-only camera cancellation,
 * invalid native payloads, held/offline server routes, and a camera event
 * delivered AFTER the native operation settled (`native.lateEvent`).
 */
import '../../testing/stress/installNativeSeams';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  AnalyzeScreenStressDriver,
  describeAction,
  lengthForSeed,
  optionsForSeed,
  parseAction,
  type SequenceResult,
  type StressAction,
} from '../../testing/stress/analyzeScreenStressDriver';
import { minimizeSequence } from '../../testing/stress/minimize';
import { seedRange } from '../../testing/stress/seededRng';

jest.mock(
  '@op-engineering/op-sqlite',
  () =>
    jest.requireActual<typeof import('../../testing/stress/sqliteMemory')>(
      '../../testing/stress/sqliteMemory',
    ).opSqliteModule,
);

jest.mock('@react-navigation/native', () => {
  const actual = jest.requireActual<typeof import('@react-navigation/native')>(
    '@react-navigation/native',
  );
  const capture = jest.requireActual<
    typeof import('../../testing/stress/navigationRefCapture')
  >('../../testing/stress/navigationRefCapture');
  return {
    ...actual,
    createNavigationContainerRef: (
      ...args: Parameters<typeof actual.createNavigationContainerRef>
    ) =>
      capture.registerNavigationRef(
        actual.createNavigationContainerRef(...args),
      ),
  };
});

const stubs = () =>
  jest.requireActual<typeof import('../../testing/stress/navigatorStubs')>(
    '../../testing/stress/navigatorStubs',
  );
jest.mock('../../src/screens/HomeScreen', () => ({
  HomeScreen: stubs().StubHomeScreen,
}));
jest.mock('../../src/screens/LibraryScreen', () => ({
  LibraryScreen: stubs().stubNamed('Tabs/Library'),
}));
jest.mock('../../src/screens/ProgressScreen', () => ({
  ProgressScreen: stubs().stubNamed('Tabs/Performance'),
}));
jest.mock('../../src/screens/SettingsScreen', () => ({
  SettingsScreen: stubs().stubNamed('Tabs/Settings'),
}));
jest.mock('../../src/screens/DrillLibraryScreen', () => ({
  DrillLibraryScreen: stubs().stubNamed('DrillLibrary'),
}));
jest.mock('../../src/screens/ResultScreen', () => ({
  ResultScreen: stubs().StubResultScreen,
}));
jest.mock('../../src/screens/ResultDetailsScreen', () => ({
  ResultDetailsScreen: stubs().stubNamed('ResultDetails'),
}));
jest.mock('../../src/screens/FormReviewScreen', () => ({
  FormReviewScreen: stubs().stubNamed('FormReview'),
}));
jest.mock('../../src/screens/StreakCalendarScreen', () => ({
  StreakCalendarScreen: stubs().stubNamed('StreakCalendar'),
}));
jest.mock('../../src/screens/PaywallScreen', () => ({
  PaywallScreen: stubs().StubPaywallScreen,
}));
jest.mock('../../src/screens/SignInScreen', () => ({
  SignInScreen: stubs().StubSignInScreen,
}));
jest.mock('../../src/screens/ManageAccountScreen', () => ({
  ManageAccountScreen: stubs().stubNamed('ManageAccount'),
}));
jest.mock('../../src/screens/ConsentSettingsScreen', () => ({
  ConsentSettingsScreen: stubs().stubNamed('ConsentSettings'),
}));
jest.mock('../../src/screens/NotificationSettingsScreen', () => ({
  NotificationSettingsScreen: stubs().stubNamed('NotificationSettings'),
}));
jest.mock('../../src/navigation/PremiumTabBar', () => ({
  PremiumTabBar: stubs().StubTabBar,
}));
jest.mock('../../src/notifications/service', () => ({
  subscribeToNotificationPresses: () => () => {},
}));

const ITERATIONS = Number(process.env.STRESS_ITER ?? '24');
const SEED_BASE = Number(process.env.STRESS_SEED_BASE ?? '1000');
const DETERMINISM_SEEDS = Number(process.env.STRESS_DETERMINISM ?? '3');
const REPLAY_SEED = process.env.STRESS_REPLAY_SEED
  ? Number(process.env.STRESS_REPLAY_SEED)
  : null;
const OUT = process.env.STRESS_OUT ?? null;
const STRICT = process.env.STRESS_STRICT === '1';
const PER_SEQUENCE_BUDGET_MS = 4_000;

/**
 * Product defects this campaign reproduced (full write-up in the stress
 * report; each is replayable with `STRESS_REPLAY_SEED=<seed>`). A sequence
 * whose violations are ALL explained by one of these is still minimized and
 * recorded in the JSON table (outcome `violated`, `knownFindings` set) but
 * only fails the suite under STRESS_STRICT=1, so the default run stays a
 * regression gate for everything else until the defects are fixed. Delete
 * the entry once its defect is fixed — the campaign then enforces it.
 */
const KNOWN_FINDINGS: ReadonlyArray<{
  id: string;
  invariant: string;
  seed: number;
  title: string;
}> = [
  {
    id: 'F1',
    invariant: 'I15',
    seed: 1001,
    title:
      "'Open Library' calls navigation.navigate('Tabs', …) from the stack; " +
      'React Navigation 7 pushes a SECOND Tabs route instead of popping, so ' +
      'AnalyzeScreen stays mounted (and subscribed to camera events) under it',
  },
  {
    id: 'F2',
    invariant: 'I4',
    seed: 1012,
    title:
      'a camera readiness event with no capture in flight (buried instance ' +
      'of F1, or an event trailing a settled native op) flips AnalyzeScreen ' +
      'to `working` with nothing that can move it out of that phase',
  },
];

function knownFindingsFor(violations: string[]): string[] | null {
  const ids = new Set<string>();
  for (const violation of violations) {
    const invariant = /→ (I\d+)\b/.exec(violation)?.[1];
    const known = KNOWN_FINDINGS.find(f => f.invariant === invariant);
    if (!known) return null;
    ids.add(known.id);
  }
  return [...ids].sort();
}

const driver = new AnalyzeScreenStressDriver();

beforeAll(() => {
  jest.useFakeTimers({
    doNotFake: [
      'setImmediate',
      'clearImmediate',
      'nextTick',
      'queueMicrotask',
      'hrtime',
    ],
    now: new Date('2026-09-04T18:00:00.000Z'),
  });
});

afterAll(() => {
  jest.useRealTimers();
});

interface CampaignRow {
  seed: number;
  length: number;
  /** V8 heap after the sequence (after a forced GC when --expose-gc is on). */
  heapUsedMb: number;
  fakeTimersPending: number;
  options: SequenceResult['options'];
  outcome: 'held' | 'violated' | 'crashed';
  violations: string[];
  /** Known-finding ids explaining EVERY violation, when they all are. */
  knownFindings: string[] | null;
  fingerprint: string;
  outcomes: SequenceResult['outcomes'];
  actions?: string[];
}

interface Failure {
  seed: number;
  options: SequenceResult['options'];
  violations: string[];
  originalActions: string[];
  minimizedActions: string[];
  minimizationReplays: number;
  rerunFailureRate: string;
  knownFindings: string[] | null;
}

function writeArtifact(name: string, value: unknown): void {
  if (!OUT) return;
  const dir = path.dirname(OUT);
  fs.mkdirSync(dir, { recursive: true });
  const target =
    name === 'main' ? OUT : OUT.replace(/\.json$/, `.${name}.json`);
  fs.writeFileSync(target, JSON.stringify(value, null, 2));
}

describe('AnalyzeScreen — seeded randomized long-run (real RootNavigator)', () => {
  it(
    `holds every invariant across ${ITERATIONS} seeded sequences (seeds ${SEED_BASE}…${
      SEED_BASE + ITERATIONS - 1
    })`,
    async () => {
      const rows: CampaignRow[] = [];
      const failures: Failure[] = [];
      const seeds =
        REPLAY_SEED !== null ? [REPLAY_SEED] : seedRange(SEED_BASE, ITERATIONS);
      const startedAt = Date.now();
      const wall = () => process.hrtime.bigint();
      const wallStart = wall();
      let totalActions = 0;
      const outcomeTotals = {
        scored: 0,
        permitsReserved: 0,
        resultRoutes: 0,
        freeLimitShown: 0,
        errorsShown: 0,
        typedCancels: 0,
        crashed: 0,
        violated: 0,
        violatedKnownFinding: 0,
        held: 0,
      };
      const actionHistogram = new Map<string, number>();
      const signatureCounts = new Map<string, number>();

      for (const seed of seeds) {
        const options = optionsForSeed(seed);
        const length = lengthForSeed(seed);
        const result = await driver.runSequence(seed, length, options);
        totalActions += result.actions.length;
        for (const action of result.actions) {
          const key = action.split(':')[0]!;
          actionHistogram.set(key, (actionHistogram.get(key) ?? 0) + 1);
        }
        const outcome = result.crashed
          ? 'crashed'
          : result.violations.length
            ? 'violated'
            : 'held';
        outcomeTotals[outcome] += 1;
        const knownFindings =
          outcome === 'violated' ? knownFindingsFor(result.violations) : null;
        if (knownFindings) outcomeTotals.violatedKnownFinding += 1;
        outcomeTotals.scored += result.outcomes.scored;
        outcomeTotals.permitsReserved += result.outcomes.permitsReserved;
        outcomeTotals.resultRoutes += result.outcomes.resultRoutes;
        outcomeTotals.freeLimitShown += result.outcomes.freeLimitShown ? 1 : 0;
        outcomeTotals.errorsShown += result.outcomes.errorsShown;
        outcomeTotals.typedCancels += result.outcomes.typedCancels;
        global.gc?.();
        rows.push({
          seed,
          length,
          heapUsedMb: Math.round(process.memoryUsage().heapUsed / 1e5) / 10,
          fakeTimersPending: jest.getTimerCount(),
          options,
          outcome,
          violations: result.violations,
          knownFindings,
          fingerprint: result.fingerprint,
          outcomes: result.outcomes,
          ...(outcome === 'held' ? {} : { actions: result.actions }),
        });
        if (outcome !== 'held') {
          // Flakiness: replay the seed from scratch. A byte-identical trace
          // is deterministic (1/1); anything else is re-run 10× for a rate.
          const again = await driver.runSequence(seed, length, options);
          let rerunFailureRate: string;
          if (again.fingerprint === result.fingerprint) {
            rerunFailureRate = 'deterministic (rerun trace identical)';
          } else {
            let failing =
              again.violations.length > 0 || again.crashed !== null ? 1 : 0;
            for (let i = 1; i < 10; i += 1) {
              const more = await driver.runSequence(seed, length, options);
              if (more.violations.length > 0 || more.crashed !== null)
                failing += 1;
            }
            rerunFailureRate = `flaky ${failing}/10`;
          }
          // Minimize the recorded action list. The first two seeds of each
          // violation signature get the full replay budget; later ones a
          // smaller one (they are the same failure class, still minimized).
          const signature = result.violations
            .map(v => v.replace(/^#\S+ \S+ → /, '').replace(/\d+/g, 'N'))
            .sort()
            .join('|');
          const seen = signatureCounts.get(signature) ?? 0;
          signatureCounts.set(signature, seen + 1);
          const original = result.actions.map(parseAction);
          const minimized = await minimizeSequence<StressAction>(
            original,
            async candidate => {
              const replay = await driver.replayActions(
                seed,
                candidate,
                options,
              );
              return replay.violations.length > 0 || replay.crashed !== null;
            },
            seen < 2 ? 80 : 32,
          );
          failures.push({
            seed,
            options,
            violations: result.violations,
            originalActions: result.actions,
            minimizedActions: minimized.actions.map(describeAction),
            minimizationReplays: minimized.replays,
            rerunFailureRate,
            knownFindings,
          });
          writeArtifact(`trace-${seed}`, result);
        }
      }

      const elapsedMs = Number(wall() - wallStart) / 1e6;
      const table = {
        unit: 'scr-analyzescreen',
        lens: 'randomized-seeded',
        startedAtFakeClockIso: new Date(startedAt).toISOString(),
        wallClockMs: Math.round(elapsedMs),
        iterations: seeds.length,
        seedBase: seeds[0],
        totalActions,
        outcomeTotals,
        actionHistogram: Object.fromEntries(
          [...actionHistogram.entries()].sort(),
        ),
        failures,
        rows,
      };
      writeArtifact('main', table);

      const enforced = STRICT
        ? failures
        : failures.filter(f => f.knownFindings === null);
      if (enforced.length > 0) {
        const summary = enforced
          .map(
            f =>
              `seed ${f.seed} (${f.rerunFailureRate})\n  minimized: ${f.minimizedActions.join(
                ' → ',
              )}\n  ${f.violations.join('\n  ')}`,
          )
          .join('\n\n');
        throw new Error(
          `${enforced.length} seeded sequence(s) violated invariants:\n${summary}`,
        );
      }
      for (const known of KNOWN_FINDINGS) {
        // Every known finding must still reproduce from its recorded seed;
        // once it stops, the entry is stale and must be deleted so the
        // invariant is enforced again.
        if (seeds.includes(known.seed)) {
          const row = rows.find(r => r.seed === known.seed)!;
          expect(row.knownFindings ?? []).toContain(known.id);
        }
      }
      expect(totalActions).toBeGreaterThanOrEqual(seeds.length * 5);
    },
    Math.max(60_000, (ITERATIONS + 1) * PER_SEQUENCE_BUDGET_MS * 12),
  );

  it(
    `same seed twice → identical trace (${DETERMINISM_SEEDS} seeds)`,
    async () => {
      const seeds = seedRange(SEED_BASE + 777_000, DETERMINISM_SEEDS);
      const report: Array<{
        seed: number;
        fingerprint: string;
        identical: boolean;
        steps: number;
      }> = [];
      for (const seed of seeds) {
        const options = optionsForSeed(seed);
        const length = lengthForSeed(seed);
        const first = await driver.runSequence(seed, length, options);
        const second = await driver.runSequence(seed, length, options);
        const identical =
          first.fingerprint === second.fingerprint &&
          JSON.stringify(
            first.trace.map(s => [
              s.action,
              s.route,
              s.phase,
              s.enabled,
              s.textDigest,
            ]),
          ) ===
            JSON.stringify(
              second.trace.map(s => [
                s.action,
                s.route,
                s.phase,
                s.enabled,
                s.textDigest,
              ]),
            );
        report.push({
          seed,
          fingerprint: first.fingerprint,
          identical,
          steps: first.trace.length,
        });
        expect(second.actions).toEqual(first.actions);
        expect(second.trace).toEqual(first.trace);
        expect(second.fingerprint).toBe(first.fingerprint);
      }
      writeArtifact('determinism', report);
    },
    Math.max(60_000, (DETERMINISM_SEEDS + 1) * PER_SEQUENCE_BUDGET_MS * 3),
  );

  it('scripted oracle: a guided capture scores through the real navigator and routes to Result once', async () => {
    const actions: StressAction[] = [
      { kind: 'home.startCamera' },
      { kind: 'tap', label: 'Forehand Drive' },
      { kind: 'tap', label: 'Open automatic camera' },
      { kind: 'tapTwice', label: 'Open automatic camera' },
      { kind: 'native.event', event: 'ready' },
      { kind: 'native.resolve', variant: 'guided_scoring' },
      { kind: 'settle', ms: 1_000 },
      { kind: 'settle', ms: 5_000 },
    ];
    const result = await driver.replayActions(42, actions, {
      premium: false,
      preUsed: 0,
    });
    expect(result.violations).toEqual([]);
    expect(result.outcomes.permitsReserved).toBe(1);
    expect(result.outcomes.scored).toBe(1);
    expect(result.outcomes.resultRoutes).toBe(1);
    const last = result.trace[result.trace.length - 1]!;
    expect(last.route).toBe('Result');
    expect(last.server.accepted).toBe(1);
    expect(last.bridge.capture).toBe(1);
  });

  it('scripted oracle: the last free rating shows the free-limit surface instead of auto-routing', async () => {
    const actions: StressAction[] = [
      { kind: 'home.startCamera' },
      { kind: 'tap', label: 'Open automatic camera' },
      { kind: 'native.resolve', variant: 'guided_scoring' },
      { kind: 'tap', label: 'Dink' },
      { kind: 'tapTwice', label: 'Get my Technique Score' },
      { kind: 'settle', ms: 5_000 },
    ];
    const result = await driver.replayActions(43, actions, {
      premium: false,
      preUsed: 1,
    });
    expect(result.violations).toEqual([]);
    expect(result.outcomes.scored).toBe(1);
    expect(result.outcomes.freeLimitShown).toBe(true);
    expect(result.outcomes.resultRoutes).toBe(0);
    expect(result.trace[result.trace.length - 1]!.phase).toBe('free_limit');
  });

  it('scripted oracle: typed cancel returns to ready; message-only cancel is a failure', async () => {
    const typed = await driver.replayActions(
      44,
      [
        { kind: 'home.startCamera' },
        { kind: 'tap', label: 'Serve' },
        { kind: 'tap', label: 'Open automatic camera' },
        { kind: 'native.rejectTyped' },
      ],
      { premium: false, preUsed: 0 },
    );
    expect(typed.violations).toEqual([]);
    expect(typed.trace[typed.trace.length - 1]!.phase).toBe('ready');

    const text = await driver.replayActions(
      45,
      [
        { kind: 'home.startCamera' },
        { kind: 'tap', label: 'Serve' },
        { kind: 'tap', label: 'Open automatic camera' },
        { kind: 'native.rejectText' },
      ],
      { premium: false, preUsed: 0 },
    );
    expect(text.violations).toEqual([]);
    expect(text.trace[text.trace.length - 1]!.phase).toBe('error');
    expect(text.trace[text.trace.length - 1]!.enabled).toContain('Try again');
  });
});
