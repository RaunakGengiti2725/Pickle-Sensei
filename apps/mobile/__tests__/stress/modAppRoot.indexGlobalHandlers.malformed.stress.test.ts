import type { StabilityRecorder } from '../../src/analysis/stabilityTelemetry';
import {
  capture,
  describeThrown,
  finishRow,
  planCampaign,
  summarize,
  writeJsonArtifact,
  type StressRow,
} from '../../stress-harness/mod-app-root/campaign';
import {
  hostileThrowable,
  safeDescribe,
  THROWABLE_FAMILIES,
} from '../../stress-harness/mod-app-root/malformedCorpus';
import { makePrng, pick } from '../../stress-harness/mod-app-root/prng';

/**
 * STRESS · mod-app-root · lens boundary-malformed · index.js
 *
 * The app entry installs two process-wide handlers that every other module
 * relies on: the global JS error handler (records a stability 'crash' and
 * forwards to React Native's handler) and, in Release, the Hermes promise
 * rejection tracker (normalises the rejected value into an Error and reports
 * it as non-fatal). Both receive whatever the runtime throws — which is
 * `unknown`, not `Error` — so they are fed the whole hostile corpus:
 * corrupted Error fields, throwing getters, 64KB+ messages/stacks, symbols,
 * BigInts, NaN/-0/Infinity, null-prototype objects, revoked/trapping Proxies,
 * prototype-pollution payloads, deep cause chains, empty collections. The
 * `isFatal` flag is fuzzed with wrong types too.
 *
 * Invariants (per iteration, all must hold):
 * - handler-no-throw       the installed global handler never throws
 * - forwarded-once         the previous handler is called exactly once with
 *                          the SAME error reference and the SAME isFatal
 * - fatal-flag-strict      a recorded crash is fatal iff isFatal === true
 * - fingerprint-shape      a recorded fingerprint is exactly 8 lowercase hex
 *                          chars (never the message/stack body)
 * - fingerprint-stable     the same hostile value fingerprints identically
 *                          twice (replayable telemetry)
 * - rejection-no-throw     onUnhandled(id, value) never throws
 * - rejection-reported     the previous handler receives exactly one Error
 *                          instance, non-fatal, for the rejection
 * - handled-no-throw       onHandled(id) never throws
 *
 * Also OBSERVED (not asserted, reported in the summary as
 * `held-telemetry-lost` + `telemetryLost[]`): whether the crash telemetry
 * survived the hostile value on each path (`crashRecorded`,
 * `rejectionCrashRecorded`). index.js swallows telemetry failures by design
 * ("Telemetry must never stand between an error and its handler"), so a lost
 * fingerprint is a degradation to report with its seeds, not a broken
 * invariant.
 *
 * Replay one row: STRESS_SEED=<seed> npx jest --ci __tests__/stress/modAppRoot.indexGlobalHandlers
 * Full campaign:  STRESS_ITER=3000 npx jest --ci __tests__/stress/modAppRoot.indexGlobalHandlers
 */

jest.mock('react-native', () => ({
  AppRegistry: { registerComponent: jest.fn() },
}));
jest.mock('../../App', () => ({ __esModule: true, default: () => null }));
jest.mock('../../src/notifications/service', () => ({
  registerBackgroundNotificationHandler: jest.fn(),
}));

type Handler = (error: unknown, isFatal?: unknown) => void;
type RejectionTrackerOptions = {
  allRejections: boolean;
  onUnhandled: (id: unknown, rejection: unknown) => void;
  onHandled: (id: unknown) => void;
};
type HermesInternalStub = {
  enablePromiseRejectionTracker: jest.Mock<void, [RejectionTrackerOptions]>;
};

const errorUtils = (
  globalThis as unknown as {
    ErrorUtils: {
      getGlobalHandler(): Handler;
      setGlobalHandler(handler: Handler): void;
      reportError(error: unknown): void;
    };
  }
).ErrorUtils;
const mutableGlobal = globalThis as unknown as {
  __DEV__: boolean;
  HermesInternal?: HermesInternalStub;
};

const originalHandler = errorUtils.getGlobalHandler();
const originalDev = mutableGlobal.__DEV__;
const hermesStub: HermesInternalStub = {
  enablePromiseRejectionTracker: jest.fn(),
};

const forwarded: Array<{ error: unknown; isFatal: unknown }> = [];
const previousHandler: Handler = (error, isFatal) => {
  forwarded.push({ error, isFatal });
};

let stabilitySlo: StabilityRecorder;
let installed: Handler;
let tracker: RejectionTrackerOptions;
let warnSpy: jest.SpyInstance;
let errorSpy: jest.SpyInstance;

const IS_FATAL_VARIANTS: ReadonlyArray<readonly [string, unknown]> = [
  ['true', true],
  ['false', false],
  ['undefined', undefined],
  ['null', null],
  ['zero', 0],
  ['one', 1],
  ['string-true', 'true'],
  ['empty-string', ''],
  ['nan', NaN],
  ['object', {}],
  ['array', []],
];

const REJECTION_ID_VARIANTS: ReadonlyArray<readonly [string, unknown]> = [
  ['small', 7],
  ['zero', 0],
  ['negative', -1],
  ['nan', NaN],
  ['infinity', Infinity],
  ['huge', 2 ** 53],
  ['float', 1.5],
  ['string', '7'],
  ['null', null],
  ['undefined', undefined],
  ['object', { id: 7 }],
];

type CrashEvent = Extract<
  ReturnType<StabilityRecorder['events']>[number],
  { kind: 'crash' }
>;

function crashEventsSince(start: number): CrashEvent[] {
  return stabilitySlo
    .events()
    .slice(start)
    .filter((event): event is CrashEvent => event.kind === 'crash');
}

const HEX8 = /^[0-9a-f]{8}$/;

/** `instanceof` itself throws on a Proxy with a hostile getPrototypeOf trap. */
function isRealError(value: unknown): value is Error {
  const probe = capture(() => value instanceof Error);
  return !probe.threw && probe.value;
}

beforeAll(() => {
  mutableGlobal.__DEV__ = false;
  mutableGlobal.HermesInternal = hermesStub;
  errorUtils.setGlobalHandler(previousHandler);
  jest.isolateModules(() => {
    jest.requireActual('../../index.js');
    stabilitySlo = jest.requireActual<
      typeof import('../../src/analysis/stabilityTelemetry')
    >('../../src/analysis/stabilityTelemetry').stabilitySlo;
  });
  installed = errorUtils.getGlobalHandler();
  const options = hermesStub.enablePromiseRejectionTracker.mock.calls[0]?.[0];
  if (!options)
    throw new Error('index.js did not install the rejection tracker');
  tracker = options;
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterAll(() => {
  warnSpy.mockRestore();
  errorSpy.mockRestore();
  errorUtils.setGlobalHandler(originalHandler);
  mutableGlobal.__DEV__ = originalDev;
  delete mutableGlobal.HermesInternal;
});

const plan = planCampaign('index-global-handlers', 40);

interface Iteration {
  row: StressRow;
  family: string;
}

function runIteration(seed: number): Iteration {
  const rng = makePrng(seed);
  const throwable = hostileThrowable(rng);
  const [fatalLabel, isFatal] = pick(rng, IS_FATAL_VARIANTS);
  const [idLabel, id] = pick(rng, REJECTION_ID_VARIANTS);
  const started = Date.now();

  // ── global handler ──
  forwarded.length = 0;
  let eventsBefore = stabilitySlo.events().length;
  const first = capture(() => installed(throwable.value, isFatal));
  const firstEvents = crashEventsSince(eventsBefore);
  const firstForwarded = forwarded.slice();

  forwarded.length = 0;
  eventsBefore = stabilitySlo.events().length;
  const second = capture(() => installed(throwable.value, isFatal));
  const secondEvents = crashEventsSince(eventsBefore);

  const handlerNoThrow = !first.threw && !second.threw;
  const forwardedOnce =
    firstForwarded.length === 1 &&
    Object.is(firstForwarded[0]?.error, throwable.value) &&
    Object.is(firstForwarded[0]?.isFatal, isFatal);
  const crashRecorded = firstEvents.length === 1;
  const fatalStrict = firstEvents.every(
    event => event.fatal === (isFatal === true),
  );
  const fingerprintShape = firstEvents.every(event =>
    HEX8.test(event.fingerprint),
  );
  const fingerprintStable =
    firstEvents.length === secondEvents.length &&
    firstEvents.every(
      (event, index) => event.fingerprint === secondEvents[index]?.fingerprint,
    );

  // ── promise rejection tracker ──
  forwarded.length = 0;
  eventsBefore = stabilitySlo.events().length;
  const rejected = capture(() => tracker.onUnhandled(id, throwable.value));
  const rejectionEvents = crashEventsSince(eventsBefore);
  const rejectionForwarded = forwarded.slice();
  const reportedError = rejectionForwarded[0]?.error;
  const reportedIsError = isRealError(reportedError);
  const valueIsError = isRealError(throwable.value);
  const messageProbe = reportedIsError
    ? capture(() => reportedError.message)
    : null;
  const reportedMessage =
    messageProbe &&
    !messageProbe.threw &&
    typeof messageProbe.value === 'string'
      ? messageProbe.value
      : null;
  const rejectionReported =
    rejectionForwarded.length === 1 &&
    reportedIsError &&
    rejectionForwarded[0]?.isFatal === false &&
    (valueIsError
      ? Object.is(reportedError, throwable.value)
      : reportedMessage !== null &&
        reportedMessage.startsWith('Unhandled promise rejection: '));
  const rejectionCrashRecorded =
    rejectionEvents.length === 1 && rejectionEvents[0]?.fatal === false;
  const handled = capture(() => tracker.onHandled(id));
  forwarded.length = 0;

  const row = finishRow({
    suite: plan.suite,
    scenario: 'global-handler+rejection-tracker',
    seed,
    inputs: {
      family: throwable.family,
      label: throwable.label,
      describe: throwable.describe,
      valueType: safeDescribe(throwable.value),
      isFatal: fatalLabel,
      rejectionId: idLabel,
    },
    observed: {
      handlerThrew: first.threw ? first.error : null,
      secondCallThrew: second.threw ? second.error : null,
      crashRecorded,
      fingerprint: firstEvents[0]?.fingerprint ?? null,
      fatal: firstEvents[0]?.fatal ?? null,
      rejectionThrew: rejected.threw ? rejected.error : null,
      rejectionReportedType: reportedIsError
        ? 'Error'
        : describeThrown(reportedError),
      rejectionMessageLength: reportedMessage?.length ?? null,
      rejectionCrashRecorded,
      handledThrew: handled.threw ? handled.error : null,
    },
    invariants: {
      'handler-no-throw': handlerNoThrow,
      'forwarded-once': forwardedOnce,
      'fatal-flag-strict': fatalStrict,
      'fingerprint-shape': fingerprintShape,
      'fingerprint-stable': fingerprintStable,
      'rejection-no-throw': !rejected.threw,
      'rejection-reported': rejectionReported,
      'handled-no-throw': !handled.threw,
    },
    durationMs: Date.now() - started,
  });
  return { row, family: throwable.family };
}

function telemetryLost(row: StressRow): boolean {
  return (
    row.observed['crashRecorded'] !== true ||
    row.observed['rejectionCrashRecorded'] !== true
  );
}

describe(`index.js global handlers × hostile throwables (${plan.iterations} seeds)`, () => {
  const rows: StressRow[] = [];
  const wallStart = Date.now();

  afterAll(() => {
    const summary = summarize(
      plan,
      rows,
      Date.now() - wallStart,
      row => String(row.inputs['family']),
      row =>
        row.ok
          ? telemetryLost(row)
            ? 'held-telemetry-lost'
            : 'held'
          : 'broken',
    );
    const lost = rows.filter(row => row.ok && telemetryLost(row));
    writeJsonArtifact('index-global-handlers.rows.json', rows);
    writeJsonArtifact('index-global-handlers.summary.json', {
      ...summary,
      familiesCovered: THROWABLE_FAMILIES.filter(family =>
        rows.some(row => row.inputs['family'] === family),
      ),
      telemetryLost: lost.map(row => ({
        seed: row.seed,
        family: row.inputs['family'],
        label: row.inputs['label'],
        globalHandlerRecorded: row.observed['crashRecorded'],
        rejectionRecorded: row.observed['rejectionCrashRecorded'],
      })),
    });
  });

  it.each(plan.seeds.map(seed => [seed] as const))(
    'seed %d: handlers never throw, always forward, fingerprints stay 8-hex',
    seed => {
      const { row } = runIteration(seed);
      rows.push(row);
      expect(row.failed).toEqual([]);
    },
  );
});
