/**
 * XC journey harness — mounts the REAL `RootNavigator` (every route it
 * declares) on the in-process stack host, wires the production stores to the
 * scripted journey server + real SQLite, and exposes a driver for scenario
 * tests: press controls, emit native camera events, advance fake time, probe
 * for spinners, and collect replayable evidence.
 *
 * `mocks.ts` MUST be imported by the test before this module.
 */
import React from 'react';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import type { ReactTestInstance, ReactTestRenderer } from 'react-test-renderer';
import { RootNavigator } from '../../src/navigation/RootNavigator';
import { BrandSpinner } from '../../src/design/components';
import { AnalysisProgressBar } from '../../src/components/AnalysisProgress';
import { StrokeResultAnalyzing } from '../../src/components/StrokeResult';
import {
  clearApiSession,
  establishApiSession,
} from '../../src/account/apiSession';
import {
  SIGNED_OUT_DATA_OWNER,
  canonicalDataOwner,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import { getDb } from '../../src/data/db';
import { useAuthStore } from '../../src/auth/authStore';
import {
  clearSyncRuntime,
  configureSyncRuntime,
} from '../../src/data/syncRuntime';
import {
  clearAccessStoreConfiguration,
  configureAccessStore,
} from '../../src/state/accessStore';
import { createCanonicalAccessClient } from '../../src/billing/accessApi';
import type {
  BillingStoreClient,
  StoreEntitlementState,
  StorePlans,
} from '../../src/billing/types';
import {
  clearTrainingStoreConfiguration,
  configureTrainingStore,
} from '../../src/training/store';
import { createTrainingApi } from '../../src/training/api';
import { consumeTryAgainHandoff } from '../../src/screens/tryAgainHandoff';
import {
  createJourneyServer,
  type JourneyRequestLog,
  type JourneyServer,
  type JourneyServerScript,
} from './journeyServer';
import {
  JourneyStack,
  installJourneyStack,
  type NavEvent,
  type RouteName,
} from './navigationHarness';
import {
  armDeferredCapture,
  emitCameraEvent,
  mulberry32,
  nativeCaptureSequence,
  resetCameraSeam,
  seededClip,
  type ClipFixture,
  type DeferredCapture,
} from './cameraSeam';
import {
  clearSqliteFaults,
  resetSqliteJournal,
  sqliteJournal,
  type SqliteJournalEntry,
} from './nodeSqliteOpSqlite';

export const JOURNEY_OWNER = '33333333-3333-4333-8333-333333333333';
export const JOURNEY_API = 'https://journey.test';

/** Virtual-time budget a `waitFor` may consume before failing. */
const WAIT_BUDGET_MS = 10_000;
const TICK_MS = 25;

const plans: StorePlans = {
  offeringId: 'default',
  annual: {
    id: 'annual-plan',
    productId: 'pickle_sensei_pro_yearly',
    period: 'annual',
    price: 59.99,
    priceString: '$59.99',
    pricePerMonthString: '$5.00',
    freeTrial: null,
  },
  monthly: {
    id: 'monthly-plan',
    productId: 'pickle_sensei_pro_monthly',
    period: 'monthly',
    price: 7.99,
    priceString: '$7.99',
    pricePerMonthString: '$7.99',
    freeTrial: null,
  },
  lifetime: {
    id: 'lifetime-plan',
    productId: 'pickle_sensei_pro_lifetime',
    period: 'lifetime',
    price: 159.99,
    priceString: '$159.99',
    pricePerMonthString: null,
    freeTrial: null,
  },
};

const noEntitlement: StoreEntitlementState = {
  premium: false,
  productId: null,
  expirationDate: null,
};

/** StoreKit is BLOCKED_EXTERNAL on Linux; this stand-in never grants. */
function storeKitStandIn(): BillingStoreClient & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    configure: async () => {
      calls.push('configure');
    },
    loadPlans: async () => {
      calls.push('loadPlans');
      return plans;
    },
    purchase: async () => {
      calls.push('purchase');
      throw new Error('StoreKit purchase is not reachable in this harness');
    },
    restore: async () => {
      calls.push('restore');
      return noEntitlement;
    },
    readEntitlement: async () => {
      calls.push('readEntitlement');
      return noEntitlement;
    },
  };
}

export interface SpinnerProbe {
  brandSpinners: number;
  analysisProgress: number;
  resultAnalyzing: number;
  pendingTimers: number;
}

export interface ScenarioEvidence {
  scenario: string;
  seed: number | null;
  clip: Omit<ClipFixture, 'clip' | 'sidecarJson'> | null;
  script: JourneyServerScript;
  finalStack: RouteName[];
  navEvents: NavEvent[];
  requests: JourneyRequestLog[];
  sql: { statements: number; failed: SqliteJournalEntry[] };
  permits: Array<{ id: string; status: string; outcome: string | null }>;
  syncedShotIds: string[];
  spinnerProbes: Array<{ label: string; probe: SpinnerProbe }>;
  recoveryControls: string[];
  heap: {
    beforeRss: number;
    beforeHeapUsed: number;
    afterRss: number;
    afterHeapUsed: number;
  };
  virtualMsAdvanced: number;
  passed: boolean;
  failure: string | null;
  storeKitCalls: string[];
}

export interface JourneyOptions {
  scenario: string;
  seed?: number;
  script?: Partial<JourneyServerScript>;
  initialRoutes?: Array<{ name: RouteName; params?: unknown }>;
}

export interface Journey {
  renderer: ReactTestRenderer;
  stack: JourneyStack;
  server: JourneyServer;
  seed: number;
  storeKit: ReturnType<typeof storeKitStandIn>;
  evidence: ScenarioEvidence;
  /** Advances virtual time in small ticks, flushing React between them. */
  flush(ms?: number): Promise<void>;
  /** Advances virtual time by exactly `ms` (single sinon tick + React flush). */
  advance(ms: number): Promise<void>;
  waitFor(condition: () => boolean, what: string): Promise<void>;
  text(): string;
  textIn(route: RouteName): string;
  topRoute(): RouteName;
  routeNames(): RouteName[];
  find(testID: string): ReactTestInstance;
  has(testID: string): boolean;
  pressTestId(testID: string): Promise<void>;
  pressButton(label: string): Promise<void>;
  /** Same, scoped to one mounted route's subtree. */
  pressButtonIn(route: RouteName, label: string): Promise<void>;
  buttonLabels(): string[];
  probeSpinners(label: string): SpinnerProbe;
  /** Route-level entry (what a deep link or another screen would issue). */
  navigateTo(name: RouteName, params?: unknown): Promise<void>;
  /** Emits the literal native pre-clip event sequence. */
  driveNativeCaptureSequence(): void;
  armCapture(): DeferredCapture;
  clip(id: string): ClipFixture;
  recordRecovery(controls: string[]): void;
  /** Live outbox rows for the journey owner, straight from real SQLite. */
  outbox(): Promise<OutboxRow[]>;
  teardown(): Promise<void>;
}

export interface OutboxRow {
  id: number;
  kind: string;
  attempts: number;
  lastError: string | null;
}

const evidenceLog: ScenarioEvidence[] = [];

export function collectedEvidence(): ScenarioEvidence[] {
  return evidenceLog;
}

/** Repo-level `artifacts/` is gitignored; `XC_JOURNEY_OUT` overrides. */
export function evidenceDir(): string {
  return (
    process.env['XC_JOURNEY_OUT'] ??
    resolve(__dirname, '../../../../artifacts/xc-journey')
  );
}

/** Writes the raw scenario table + a compact matrix for one suite. */
export function writeEvidence(suite: string): {
  tablePath: string;
  matrixPath: string;
} {
  const dir = evidenceDir();
  mkdirSync(dir, { recursive: true });
  const tablePath = resolve(dir, `${suite}.scenarios.json`);
  const matrixPath = resolve(dir, `${suite}.matrix.json`);
  writeFileSync(
    tablePath,
    JSON.stringify(
      {
        suite,
        node: process.versions.node,
        generatedAt: new Date().toISOString(),
        scenarios: evidenceLog,
      },
      null,
      2,
    ),
  );
  writeFileSync(
    matrixPath,
    JSON.stringify(
      evidenceLog.map(e => ({
        scenario: e.scenario,
        seed: e.seed,
        passed: e.passed,
        failure: e.failure,
        finalStack: e.finalStack,
        requests: e.requests.map(r => `${r.method} ${r.path} -> ${r.status}`),
        sqlStatements: e.sql.statements,
        sqlFailed: e.sql.failed.length,
        permits: e.permits,
        recoveryControls: e.recoveryControls,
        lastProbe: e.spinnerProbes.at(-1) ?? null,
        virtualMsAdvanced: e.virtualMsAdvanced,
        heapUsedDeltaBytes: e.heap.afterHeapUsed - e.heap.beforeHeapUsed,
        rssDeltaBytes: e.heap.afterRss - e.heap.beforeRss,
      })),
      null,
      2,
    ),
  );
  return { tablePath, matrixPath };
}

let realFetch: typeof globalThis.fetch | undefined;
let realRandom: () => number = Math.random;

export async function mountJourney(options: JourneyOptions): Promise<Journey> {
  const seed = options.seed ?? 1;
  jest.useFakeTimers({
    doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'],
  });
  const heapBefore = process.memoryUsage();
  const server = createJourneyServer(options.script);
  realFetch = globalThis.fetch;
  globalThis.fetch = server.fetch as typeof globalThis.fetch;
  // Seeded `Math.random`: the sync back-off jitter (and anything else the
  // production tree randomises) replays identically for the same seed.
  realRandom = Math.random;
  Math.random = mulberry32(seed ^ 0x9e3779b9);

  resetCameraSeam();
  resetSqliteJournal();
  clearSqliteFaults();
  consumeTryAgainHandoff();
  setActiveDataOwner(JOURNEY_OWNER);
  establishApiSession({
    apiBaseUrl: JOURNEY_API,
    bearerToken: 'journey-bearer',
    canonicalAppUserId: JOURNEY_OWNER,
    provider: 'apple',
  });
  // Signed-in canonical (synced) account: the rating gate reads
  // `session.localOnly`; the guide reads `session.canonicalAppUserId`.
  useAuthStore.setState({
    hydrated: true,
    busy: false,
    error: null,
    session: {
      provider: 'apple',
      subject: JOURNEY_OWNER,
      canonicalAppUserId: JOURNEY_OWNER,
      localOnly: false,
      displayName: 'Journey Tester',
      email: null,
    },
  });
  const storeKit = storeKitStandIn();
  configureAccessStore({
    store: storeKit,
    backend: createCanonicalAccessClient({
      baseUrl: JOURNEY_API,
      token: 'journey-bearer',
      fetchFn: server.fetch as typeof globalThis.fetch,
    }),
  });
  configureTrainingStore(
    createTrainingApi({
      baseUrl: JOURNEY_API,
      token: 'journey-bearer',
      fetchFn: server.fetch as typeof globalThis.fetch,
    }),
  );
  configureSyncRuntime({
    apiBaseUrl: JOURNEY_API,
    bearerToken: 'journey-bearer',
    canonicalAppUserId: JOURNEY_OWNER,
    provider: 'apple',
  });

  const stack = new JourneyStack(
    options.initialRoutes ?? [
      { name: 'Tabs' },
      { name: 'Analyze', params: { source: 'camera' } },
    ],
  );
  installJourneyStack(stack);

  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<RootNavigator />);
  });

  let virtualMsAdvanced = 0;
  const evidence: ScenarioEvidence = {
    scenario: options.scenario,
    seed,
    clip: null,
    script: server.script,
    finalStack: [],
    navEvents: [],
    requests: [],
    sql: { statements: 0, failed: [] },
    permits: [],
    syncedShotIds: [],
    spinnerProbes: [],
    recoveryControls: [],
    heap: {
      beforeRss: heapBefore.rss,
      beforeHeapUsed: heapBefore.heapUsed,
      afterRss: 0,
      afterHeapUsed: 0,
    },
    virtualMsAdvanced: 0,
    passed: false,
    failure: null,
    storeKitCalls: storeKit.calls,
  };

  const advance = async (ms: number) => {
    await act(async () => {
      await jest.advanceTimersByTimeAsync(ms);
    });
    virtualMsAdvanced += ms;
  };

  const flush = async (ms = TICK_MS * 4) => {
    const ticks = Math.max(1, Math.ceil(ms / TICK_MS));
    for (let i = 0; i < ticks; i += 1) {
      await advance(TICK_MS);
    }
  };

  const waitFor = async (condition: () => boolean, what: string) => {
    let spent = 0;
    while (!condition()) {
      if (spent >= WAIT_BUDGET_MS) {
        throw new Error(
          `Timed out (${WAIT_BUDGET_MS} virtual ms) waiting for ${what}. ` +
            `Stack=${stack.routes.map(r => r.name).join(' > ')} ` +
            `Text="${allText(renderer.root).slice(0, 600)}"`,
        );
      }
      await advance(TICK_MS);
      spent += TICK_MS;
    }
  };

  const routeNode = (route: RouteName): ReactTestInstance | null => {
    const nodes = renderer.root.findAll(
      n => n.props.testID === `xc-route-${route}`,
    );
    return nodes.at(-1) ?? null;
  };

  const journey: Journey = {
    renderer,
    stack,
    server,
    seed,
    storeKit,
    evidence,
    flush,
    advance,
    waitFor,
    text: () => allText(renderer.root),
    textIn: route => {
      const node = routeNode(route);
      return node ? allText(node) : '';
    },
    topRoute: () => stack.top().name,
    routeNames: () => stack.routes.map(r => r.name),
    find: testID => {
      const nodes = renderer.root.findAll(n => n.props.testID === testID);
      if (nodes.length === 0) throw new Error(`No node with testID ${testID}`);
      return nodes[0]!;
    },
    has: testID =>
      renderer.root.findAll(n => n.props.testID === testID).length > 0,
    pressTestId: async testID => {
      const nodes = renderer.root.findAll(
        n => n.props.testID === testID && typeof n.props.onPress === 'function',
      );
      const node = nodes.at(-1);
      if (!node) {
        throw new Error(
          `No pressable with testID ${testID}. Buttons: ${buttonLabels(renderer.root).join(' | ')}`,
        );
      }
      await act(async () => {
        node.props.onPress();
      });
      await flush();
    },
    pressButton: async label => {
      const node = findPressableByLabel(renderer.root, label);
      if (!node) {
        throw new Error(
          `No pressable labelled "${label}". Buttons: ${buttonLabels(renderer.root).join(' | ')}`,
        );
      }
      await act(async () => {
        node.props.onPress();
      });
      await flush();
    },
    pressButtonIn: async (route, label) => {
      const scope = routeNode(route);
      if (!scope) throw new Error(`Route ${route} is not mounted`);
      const node = findPressableByLabel(scope, label);
      if (!node) {
        throw new Error(
          `No pressable labelled "${label}" in ${route}. Buttons: ${buttonLabels(scope).join(' | ')}`,
        );
      }
      await act(async () => {
        node.props.onPress();
      });
      await flush();
    },
    buttonLabels: () => buttonLabels(renderer.root),
    probeSpinners: label => {
      const probe: SpinnerProbe = {
        brandSpinners: renderer.root.findAllByType(BrandSpinner).length,
        analysisProgress:
          renderer.root.findAllByType(AnalysisProgressBar).length,
        resultAnalyzing: renderer.root.findAllByType(StrokeResultAnalyzing)
          .length,
        pendingTimers: jest.getTimerCount(),
      };
      evidence.spinnerProbes.push({ label, probe });
      return probe;
    },
    navigateTo: async (name, params) => {
      await act(async () => {
        stack.navigationFor(stack.top()).navigate(name, params);
      });
      await flush();
    },
    driveNativeCaptureSequence: () => {
      act(() => {
        for (const event of nativeCaptureSequence()) emitCameraEvent(event);
      });
    },
    armCapture: () => armDeferredCapture(),
    clip: id => {
      const fixture = seededClip(id, seed);
      evidence.clip = {
        seed: fixture.seed,
        truth: fixture.truth,
        frameCount: fixture.frameCount,
      };
      return fixture;
    },
    recordRecovery: controls => {
      evidence.recoveryControls.push(...controls);
    },
    outbox: async () => {
      const { rows } = await getDb().execute(
        `SELECT id, kind, attempts, last_error FROM outbox
         WHERE owner_key = ? ORDER BY id ASC`,
        [canonicalDataOwner(JOURNEY_OWNER)],
      );
      return rows.map(row => ({
        id: Number(row['id']),
        kind: String(row['kind']),
        attempts: Number(row['attempts']),
        lastError:
          row['last_error'] === null ? null : String(row['last_error']),
      }));
    },
    teardown: async () => {
      evidence.finalStack = stack.routes.map(r => r.name);
      evidence.navEvents = [...stack.events];
      evidence.requests = server.requests.map(r => ({ ...r }));
      const journal = sqliteJournal();
      evidence.sql = {
        statements: journal.length,
        failed: journal.filter(entry => !entry.ok),
      };
      evidence.permits = [...server.permits.entries()].map(([id, p]) => ({
        id,
        ...p,
      }));
      evidence.syncedShotIds = [...server.syncedShotIds];
      evidence.virtualMsAdvanced = virtualMsAdvanced;
      const heapAfter = process.memoryUsage();
      evidence.heap.afterRss = heapAfter.rss;
      evidence.heap.afterHeapUsed = heapAfter.heapUsed;
      evidenceLog.push(evidence);

      await act(async () => {
        renderer.unmount();
      });
      await flush();
      clearSyncRuntime();
      clearAccessStoreConfiguration();
      clearTrainingStoreConfiguration();
      clearApiSession();
      useAuthStore.setState({ session: null, hydrated: false });
      setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
      getDb().close();
      installJourneyStack(null);
      resetCameraSeam();
      consumeTryAgainHandoff();
      globalThis.fetch = realFetch as typeof globalThis.fetch;
      Math.random = realRandom;
      jest.clearAllTimers();
      jest.useRealTimers();
    },
  };
  return journey;
}

/** Runs a scenario, recording pass/fail into its evidence no matter what. */
export async function runScenario(
  options: JourneyOptions,
  body: (journey: Journey) => Promise<void>,
): Promise<void> {
  const journey = await mountJourney(options);
  try {
    await body(journey);
    journey.evidence.passed = true;
  } catch (error) {
    journey.evidence.failure =
      error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    await journey.teardown();
  }
}

// ─── Tree helpers ────────────────────────────────────────────────────────────

export function allText(root: ReactTestInstance): string {
  return root
    .findAllByType(Text)
    .map(node => node.props.children)
    .flat(Infinity)
    .filter(
      (c): c is string | number =>
        typeof c === 'string' || typeof c === 'number',
    )
    .map(String)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function textOf(node: ReactTestInstance): string {
  return allText(node) || String(node.props.accessibilityLabel ?? '');
}

function pressables(root: ReactTestInstance): ReactTestInstance[] {
  return root.findAll(
    n =>
      typeof n.props.onPress === 'function' &&
      typeof n.type !== 'string' &&
      n.props.disabled !== true,
  );
}

export function buttonLabels(root: ReactTestInstance): string[] {
  const seen = new Set<string>();
  for (const node of pressables(root)) {
    const label = textOf(node);
    if (label) seen.add(label);
  }
  return [...seen];
}

function findPressableByLabel(
  root: ReactTestInstance,
  label: string,
): ReactTestInstance | null {
  const matches = pressables(root).filter(node => {
    if (node.props.label === label) return true;
    if (node.props.accessibilityLabel === label) return true;
    return textOf(node) === label;
  });
  // Outermost composite wins: it owns the real handler.
  return matches[0] ?? null;
}
