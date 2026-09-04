/**
 * FAILURE INJECTION — ProgressScreen's load path (the consumer of
 * progress/api + practiceHistory + practiceSetProgress).
 *
 * Every dependency the screen awaits is faulted from a seeded RNG under jest
 * fake timers: the SQLite handle (`getDb`), the two repository reads
 * (`listRealAnalysisFacts`, `listCaptureHistory`: throw / reject / slow /
 * never-resolves / hostile rows), the account fetch
 * (`fetchCanonicalProgress`: reject / throw / slow / malformed) and the
 * session (`getApiSession`: null / present / throw). The clock is driven 60 s
 * forward and the rendered tree must satisfy:
 *
 *   settles_60s     — no loading state remains after 60 s of fake time
 *   error_visible   — a failed local read shows the alert-role error state
 *                     whose detail is honest and a pressable "Try again"
 *   recoverable     — pressing Try again with the fault cleared renders the
 *                     dashboard (loading → data, not a stale error)
 *   no_fake_success — after a failed local read no dashboard is rendered
 *   no_crash        — the render never throws (hostile rows, faulted deps)
 *   copy            — the rendered text carries no NaN / undefined / null /
 *                     Infinity / [object Object]
 *   account_notice  — a signed-in load whose account fetch failed tells the
 *                     player the account view is unavailable (recorded as an
 *                     invariant: the lens forbids silent failure)
 *
 * `fetchCanonicalProgress` is mocked at module level, so a "never resolves"
 * fetch models a transport that ignores the module's 15 s deadline — that is
 * the gated hardening campaign (STRESS_HARDENING=1), as in the api suite.
 *
 * Replay:  STRESS_ONLY=progressScreen:<seed>   Scale: STRESS_ITER=<n>
 * Table:   artifacts/stress/progressScreen.json
 */
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

const mockGetDb = jest.fn<unknown, []>();
jest.mock('../../src/data/db', () => ({
  getDb: () => mockGetDb(),
}));

jest.mock('react-native-safe-area-context', () => {
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  return { SafeAreaView: View };
});

const mockNavigate = jest.fn();
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: mockNavigate }),
  useFocusEffect: (callback: () => void | (() => void)) => {
    const ReactActual = jest.requireActual<typeof import('react')>('react');
    ReactActual.useEffect(() => callback(), [callback]);
  },
}));

const mockListRealAnalysisFacts = jest.fn<Promise<unknown[]>, unknown[]>();
const mockListCaptureHistory = jest.fn<Promise<unknown[]>, unknown[]>();
jest.mock('../../src/data/repository', () => ({
  listRealAnalysisFacts: (...args: unknown[]) =>
    mockListRealAnalysisFacts(...args),
  listCaptureHistory: (...args: unknown[]) => mockListCaptureHistory(...args),
}));

const mockGetApiSession = jest.fn<unknown, []>(() => null);
jest.mock('../../src/account/apiSession', () => ({
  getApiSession: () => mockGetApiSession(),
}));

const mockFetchCanonicalProgress = jest.fn<Promise<unknown>, unknown[]>();
jest.mock('../../src/progress/api', () => ({
  fetchCanonicalProgress: (...args: unknown[]) =>
    mockFetchCanonicalProgress(...args),
}));

jest.mock('../../src/progress/playerRank', () => {
  const actual = jest.requireActual<
    typeof import('../../src/progress/playerRank')
  >('../../src/progress/playerRank');
  return { ...actual, fetchPlayerRank: jest.fn(async () => null) };
});

const mockAppState = { profile: null as { skillLevel?: string } | null };
jest.mock('../../src/state/appStore', () => ({
  useAppStore: (selector: (s: typeof mockAppState) => unknown) =>
    selector(mockAppState),
}));

const mockConsistencyState = {
  snapshot: null as unknown,
  refresh: jest.fn(async () => {}),
};
jest.mock('../../src/consistency/store', () => ({
  useConsistencyStore: (
    selector: (s: typeof mockConsistencyState) => unknown,
  ) => selector(mockConsistencyState),
}));

jest.mock('../../src/progress/rankCelebration', () => {
  const state = { maybeCelebrate: jest.fn(async () => {}) };
  return {
    useRankCelebrationStore: (selector: (s: typeof state) => unknown) =>
      selector(state),
  };
});

import { ProgressScreen } from '../../src/screens/ProgressScreen';
import type { RealAnalysisFact } from '../../src/data/repository';
import { SeededRng } from '../../test-support/stress/seededRng';
import {
  CampaignTable,
  Checker,
  describeValue,
  forbiddenToken,
  planCampaign,
} from '../../test-support/stress/campaign';

const TEST_FILE =
  '__tests__/stress/progressScreen.failureInjection.stress.test.tsx';
const ADVANCE_MS = 60_000;
const DAY_MS = 86_400_000;
const realNow: () => number = Date.now.bind(Date);

// ─── Faults ──────────────────────────────────────────────────────────────────

type DepFault =
  'ok' | 'throw_sync' | 'reject' | 'slow' | 'never_resolves' | 'hostile_rows';

const LOCAL_FAULTS: readonly DepFault[] = [
  'ok',
  'ok',
  'throw_sync',
  'reject',
  'slow',
  'never_resolves',
  'hostile_rows',
];

type FetchFault =
  | 'ok'
  | 'reject'
  | 'throw_sync'
  | 'slow'
  | 'malformed_resolve'
  | 'never_resolves';

/** `fetchCanonicalProgress` is an `async` function: it can reject, stall or
 * resolve, never throw synchronously — a sync throw is out of contract and
 * lives in the hardening pool with the never-settling transport. */
const FETCH_FAULTS: readonly FetchFault[] = [
  'ok',
  'reject',
  'slow',
  'malformed_resolve',
];
const FETCH_HARDENING_FAULTS: readonly FetchFault[] = [
  'never_resolves',
  'never_resolves',
  'throw_sync',
];

type SessionFault = 'signed_out' | 'signed_in' | 'throw_sync';
type DbFault = 'ok' | 'throw_sync';

interface Injection {
  db: DbFault;
  session: SessionFault;
  facts: DepFault;
  captures: DepFault;
  fetch: FetchFault;
  slowMs: number;
}

const ERRORS = [
  () => new Error('database is locked'),
  () => new Error('no such table: local_shot'),
  () => new TypeError('Cannot read properties of null'),
  () => 'string rejection',
  () => null,
  () => ({ code: 'SQLITE_BUSY' }),
] as const;

function daysAgoIso(days: number, now: number): string {
  return new Date(now - days * DAY_MS).toISOString();
}

function validFact(
  rng: SeededRng,
  now: number,
  index: number,
): RealAnalysisFact {
  return {
    id: `fact-${index}`,
    shotType: rng.pick(['dink', 'serve', 'forehand_drive', 'third_shot_drop']),
    capturedAt: daysAgoIso(rng.int(0, 40), now),
    overallScore: rng.int(0, 100) / 10,
    confidence: rng.next(),
    resultKind: 'scored',
    scoringModelVersion: rng.pick(['model-2', 'model-3']),
    shotConfigVersion: 'config-1',
    sessionId: rng.chance(0.5) ? `set-${rng.int(0, 2)}` : null,
    priorityCheckpoint: rng.chance(0.5) ? 'contact_point' : null,
    checkpointScores: {
      contact_point: rng.int(0, 100),
      preparation: rng.int(0, 100),
    },
  };
}

/** Rows `listRealAnalysisFacts` can hand the screen from a corrupt-but-
 * parseable `local_shot.payload`: the reader copies `overallScore`,
 * `capturedAt`, `shotType`, `resultKind` and `id` straight out of the JSON
 * (only `sessionId`, `priorityCheckpoint` and `checkpointScores` are
 * validated), so every value here is JSON-representable. */
function hostileFact(
  rng: SeededRng,
  now: number,
  index: number,
  mutations: string[],
): RealAnalysisFact {
  const base = validFact(rng, now, index) as unknown as Record<string, unknown>;
  const apply = (field: string, value: unknown) => {
    mutations.push(`${field}=${describeValue(value)}`);
    if (value === undefined) delete base[field];
    else base[field] = value;
  };
  switch (rng.int(0, 6)) {
    case 0:
      apply('capturedAt', rng.pick(['', 'not a date', 'NaN', 12345]));
      break;
    case 1:
      apply('capturedAt', undefined);
      break;
    case 2:
      apply('overallScore', rng.pick([null, 'seven', '', true, {}]));
      break;
    case 3:
      apply('shotType', rng.pick([undefined, 7, '']));
      break;
    case 4:
      apply('resultKind', rng.pick(['SCORED', null, 42]));
      break;
    case 5:
      apply('confidence', rng.pick([null, 'high']));
      break;
    default:
      apply('id', rng.pick([undefined, 7]));
  }
  return base as unknown as RealAnalysisFact;
}

function factRows(
  rng: SeededRng,
  now: number,
  hostile: boolean,
  mutations: string[],
): RealAnalysisFact[] {
  const rows: RealAnalysisFact[] = [];
  const count = rng.int(0, 12);
  for (let i = 0; i < count; i++) {
    rows.push(
      hostile && rng.chance(0.5)
        ? hostileFact(rng, now, i, mutations)
        : validFact(rng, now, i),
    );
  }
  return rows;
}

function canonicalPayload(rng: SeededRng, now: number) {
  const series = [];
  const n = rng.int(0, 5);
  for (let i = 0; i < n; i++) {
    series.push({
      day: daysAgoIso(rng.int(2, 27), now).slice(0, 10),
      shotType: rng.pick(['dink', 'serve']),
      scoringModelVersion: 'model-2',
      shotCount: rng.int(1, 40),
      avgScore: rng.int(0, 100) / 10,
      bestScore: rng.int(0, 100) / 10,
    });
  }
  return {
    series,
    improving: [],
    needsAttention: [],
    streak: {
      currentDays: rng.int(0, 5),
      longestDays: rng.int(0, 9),
      practicedToday: rng.chance(0.5),
      lastPracticeDate: null,
    },
  };
}

function pending<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

function delayed<T>(ms: number, value: () => T): Promise<T> {
  return new Promise<T>(resolve => {
    setTimeout(() => resolve(value()), ms);
  });
}

function wireDependency(
  mock: jest.Mock<Promise<unknown[]>, unknown[]>,
  fault: DepFault,
  rng: SeededRng,
  rows: () => unknown[],
  slowMs: number,
): void {
  const error = rng.pick(ERRORS);
  switch (fault) {
    case 'ok':
    case 'hostile_rows':
      mock.mockImplementation(async () => rows());
      break;
    case 'throw_sync':
      mock.mockImplementation(() => {
        throw error();
      });
      break;
    case 'reject':
      mock.mockImplementation(() => Promise.reject(error()));
      break;
    case 'slow':
      mock.mockImplementation(() => delayed(slowMs, rows));
      break;
    case 'never_resolves':
      mock.mockImplementation(() => pending());
      break;
  }
}

function wireFetch(
  fault: FetchFault,
  rng: SeededRng,
  now: number,
  slowMs: number,
): void {
  const error = rng.pick(ERRORS);
  switch (fault) {
    case 'ok':
      mockFetchCanonicalProgress.mockImplementation(async () =>
        canonicalPayload(rng, now),
      );
      break;
    case 'reject':
      mockFetchCanonicalProgress.mockImplementation(() =>
        Promise.reject(error()),
      );
      break;
    case 'throw_sync':
      mockFetchCanonicalProgress.mockImplementation(() => {
        throw error();
      });
      break;
    case 'slow':
      mockFetchCanonicalProgress.mockImplementation(() =>
        delayed(slowMs, () => canonicalPayload(rng, now)),
      );
      break;
    case 'malformed_resolve':
      // Out of the module's contract; the screen must not crash on it.
      mockFetchCanonicalProgress.mockImplementation(async () =>
        rng.pick([null, undefined]),
      );
      break;
    case 'never_resolves':
      mockFetchCanonicalProgress.mockImplementation(() => pending());
      break;
  }
}

function wireAll(
  injection: Injection,
  rng: SeededRng,
  now: number,
  mutations: string[] = [],
): void {
  mockGetDb.mockImplementation(() => {
    if (injection.db === 'throw_sync')
      throw new Error('Unable to open the local database.');
    return { execute: jest.fn(async () => ({ rows: [] })), close() {} };
  });
  mockGetApiSession.mockImplementation(() => {
    if (injection.session === 'throw_sync')
      throw new Error('keychain unavailable');
    if (injection.session === 'signed_in') {
      return {
        provider: 'apple',
        canonicalAppUserId: 'apple:user',
        bearerToken: 'token',
        email: null,
        displayName: null,
      };
    }
    return null;
  });
  wireDependency(
    mockListRealAnalysisFacts,
    injection.facts,
    rng,
    () => factRows(rng, now, injection.facts === 'hostile_rows', mutations),
    injection.slowMs,
  );
  wireDependency(
    mockListCaptureHistory,
    injection.captures,
    rng,
    () => [],
    injection.slowMs,
  );
  wireFetch(injection.fetch, rng, now, injection.slowMs);
}

function wireHealthy(rng: SeededRng, now: number): void {
  wireAll(
    {
      db: 'ok',
      session: 'signed_out',
      facts: 'ok',
      captures: 'ok',
      fetch: 'ok',
      slowMs: 0,
    },
    rng,
    now,
  );
}

// ─── Tree inspection ─────────────────────────────────────────────────────────

function renderedText(renderer: TestRenderer.ReactTestRenderer): string {
  const out: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node === 'string') {
      out.push(node);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node && typeof node === 'object' && 'children' in node) {
      walk((node as { children: unknown }).children);
    }
  };
  walk(renderer.toJSON());
  return out.join(' ');
}

type ScreenState = 'loading' | 'error' | 'dashboard' | 'empty';

function screenState(renderer: TestRenderer.ReactTestRenderer): ScreenState {
  const hosts = renderer.root.findAll(n => typeof n.type === 'string');
  if (
    hosts.some(
      n =>
        typeof n.props.accessibilityLabel === 'string' &&
        n.props.accessibilityLabel.startsWith('Loading measured progress'),
    )
  ) {
    return 'loading';
  }
  if (hosts.some(n => n.props.accessibilityRole === 'alert')) return 'error';
  return renderedText(renderer).includes('Progress') ? 'dashboard' : 'empty';
}

function retryControl(renderer: TestRenderer.ReactTestRenderer) {
  const [node] = renderer.root.findAll(
    n =>
      typeof n.props.onPress === 'function' &&
      (n.props.accessibilityLabel === 'Try again' ||
        (typeof n.props.children === 'string' &&
          n.props.children === 'Try again') ||
        JSON.stringify(n.props.children ?? '').includes('Try again')),
  );
  return node ?? null;
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

/** Drive the fake clock forward in fixed steps (the spinner animation keeps
 * re-arming zero-delay frames, so timer-by-timer stepping never advances),
 * letting React settle after each, until the loading state is gone or the
 * budget is spent. */
const STEP_MS = 250;

async function drive(
  renderer: TestRenderer.ReactTestRenderer,
  budgetMs: number,
): Promise<number> {
  const start = jest.now();
  await flush();
  while (screenState(renderer) === 'loading' && jest.now() - start < budgetMs) {
    await act(async () => {
      jest.advanceTimersByTime(
        Math.min(STEP_MS, budgetMs - (jest.now() - start)),
      );
    });
    await flush();
  }
  return jest.now() - start;
}

// ─── Scenario ────────────────────────────────────────────────────────────────

function drawInjection(
  rng: SeededRng,
  fetchPool: readonly FetchFault[],
  fetchOnly: boolean,
): Injection {
  return {
    db: fetchOnly ? 'ok' : rng.chance(0.1) ? 'throw_sync' : 'ok',
    session: fetchOnly
      ? 'signed_in'
      : rng.pick([
          'signed_out',
          'signed_in',
          'signed_in',
          'throw_sync',
        ] as const),
    facts: fetchOnly ? 'ok' : rng.pick(LOCAL_FAULTS),
    captures: fetchOnly ? 'ok' : rng.pick(LOCAL_FAULTS),
    fetch: rng.pick(fetchPool),
    slowMs: rng.int(1, 14_000),
  };
}

function localFails(i: Injection): boolean {
  return (
    i.db === 'throw_sync' ||
    i.session === 'throw_sync' ||
    i.facts === 'throw_sync' ||
    i.facts === 'reject' ||
    i.captures === 'throw_sync' ||
    i.captures === 'reject'
  );
}

function localHangs(i: Injection): boolean {
  return (
    !localFails(i) &&
    (i.facts === 'never_resolves' || i.captures === 'never_resolves')
  );
}

async function runScenario(
  table: CampaignTable,
  seed: number,
  fetchPool: readonly FetchFault[],
  fetchOnly = false,
): Promise<void> {
  const rng = new SeededRng(seed);
  const now = Date.UTC(2026, 7, 27, 15) + rng.int(-10, 10) * DAY_MS;
  jest.setSystemTime(now);
  const injection = drawInjection(rng, fetchPool, fetchOnly);
  const checker = new Checker();
  const started = realNow();
  const observed: string[] = [];
  const faultLabel =
    [
      injection.db === 'throw_sync' ? 'db:throw' : null,
      injection.session === 'throw_sync' ? 'session:throw' : null,
      injection.facts !== 'ok' ? `facts:${injection.facts}` : null,
      injection.captures !== 'ok' ? `captures:${injection.captures}` : null,
      injection.session === 'signed_in' && injection.fetch !== 'ok'
        ? `fetch:${injection.fetch}`
        : null,
    ]
      .filter(Boolean)
      .join('+') || 'none';

  const mutations: string[] = [];
  let renderer: TestRenderer.ReactTestRenderer | null = null;
  try {
    wireAll(injection, rng, now, mutations);
    await act(async () => {
      renderer = TestRenderer.create(<ProgressScreen />);
    });
    const r = renderer!;
    observed.push(`first paint: ${screenState(r)}`);
    const elapsed = await drive(r, ADVANCE_MS);
    const state = screenState(r);
    observed.push(`after ${elapsed}ms: ${state}`);
    const text = renderedText(r);
    const token = forbiddenToken(text);
    checker.check(
      'copy',
      token === null,
      () => `rendered text contains "${token}"`,
    );

    const fetchHangs =
      injection.session === 'signed_in' && injection.fetch === 'never_resolves';
    checker.check(
      'settles_60s',
      state !== 'loading',
      () =>
        `still loading after ${ADVANCE_MS}ms (${localHangs(injection) ? 'a local read never resolved' : fetchHangs ? 'the account fetch never resolved' : 'no dependency hung'})`,
    );

    if (localFails(injection)) {
      checker.check(
        'error_visible',
        state === 'error',
        () => `local read failed but screen shows ${state}`,
      );
      observed.push(`local failure → ${state}`);
      checker.check(
        'error_visible',
        text.includes('Progress couldn’t load') &&
          text.includes('could not be opened'),
        () => `error copy missing: ${JSON.stringify(text.slice(0, 200))}`,
      );
      const retry = retryControl(r);
      checker.check(
        'error_visible',
        retry !== null,
        () => 'no pressable "Try again" control in the error state',
      );
      checker.check(
        'no_fake_success',
        !text.includes('Practice activity'),
        () => 'dashboard copy rendered beside the error',
      );
      if (retry) {
        wireHealthy(rng, now);
        await act(async () => {
          retry.props.onPress();
        });
        await drive(r, ADVANCE_MS);
        const after = screenState(r);
        observed.push(`retry → ${after}`);
        checker.check(
          'recoverable',
          after === 'dashboard',
          () => `after retry with healthy deps: ${after}`,
        );
        const afterText = renderedText(r);
        const afterToken = forbiddenToken(afterText);
        checker.check(
          'copy',
          afterToken === null,
          () => `post-retry text contains "${afterToken}"`,
        );
      }
    } else if (!localHangs(injection) && !fetchHangs) {
      checker.check(
        'no_crash',
        state === 'dashboard',
        () =>
          `healthy local reads but screen shows ${state}${state === 'error' ? ` — ${JSON.stringify(text.slice(0, 160))}` : ''}`,
      );
      if (
        injection.session === 'signed_in' &&
        injection.fetch !== 'ok' &&
        injection.fetch !== 'slow'
      ) {
        const notice =
          /unavailable|couldn|could not|offline|device only|device-only|not synced|sign in/i.test(
            text,
          );
        observed.push(`account fetch ${injection.fetch}; notice=${notice}`);
        checker.check(
          'account_notice',
          notice,
          () =>
            `signed-in load with account fetch ${injection.fetch} renders device data with no notice of the failed account view`,
        );
      }
    }
  } catch (error) {
    observed.push(`threw ${describeValue(error)}`);
    checker.fail('no_crash', describeValue(error));
  } finally {
    if (renderer) {
      await act(async () => {
        (renderer as TestRenderer.ReactTestRenderer).unmount();
      });
    }
  }
  const result = table.record(
    seed,
    faultLabel,
    { ...injection, now: new Date(now).toISOString(), mutations },
    checker,
    observed.join('; '),
    realNow() - started,
  );
  expect({
    outcome: result.outcome,
    failures: result.failures,
    replay: result.replay,
  }).toEqual({
    outcome: 'HELD',
    failures: [],
    replay: result.replay,
  });
}

// ─── Campaigns ───────────────────────────────────────────────────────────────

const main = planCampaign('progressScreen', 24, TEST_FILE);
const hardening = planCampaign(
  'progressScreenFetchOutOfContract',
  4,
  TEST_FILE,
  { hardening: true },
);
const mainTable = new CampaignTable(main, {
  localFaults: LOCAL_FAULTS,
  fetchFaults: FETCH_FAULTS,
  advanceMs: ADVANCE_MS,
});
const hardeningTable = new CampaignTable(hardening, {
  note: 'fetchCanonicalProgress mocked out of contract: never settles (transport ignoring the module deadline) or throws synchronously (impossible for an async function)',
  fetchFaults: FETCH_HARDENING_FAULTS,
  advanceMs: ADVANCE_MS,
});

beforeEach(() => {
  jest.useFakeTimers();
  mockGetDb.mockReset();
  mockGetApiSession.mockReset();
  mockListRealAnalysisFacts.mockReset();
  mockListCaptureHistory.mockReset();
  mockFetchCanonicalProgress.mockReset();
});

afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

afterAll(() => {
  mainTable.flush();
  hardeningTable.flush();
});

describe('ProgressScreen under injected dependency faults', () => {
  for (const seed of main.seeds) {
    it(`seed ${seed}`, () => runScenario(mainTable, seed, FETCH_FAULTS));
  }
});

describe('ProgressScreen when the account fetch breaks its contract (hardening)', () => {
  for (const seed of hardening.seeds) {
    it(`seed ${seed}`, () =>
      runScenario(hardeningTable, seed, FETCH_HARDENING_FAULTS, true));
  }
});
