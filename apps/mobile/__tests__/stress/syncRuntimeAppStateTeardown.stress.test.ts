/**
 * stress / mod-sync-runtime — FAILURE INJECTION, AppState tear-down faults.
 *
 * Two AppState faults poison `syncRuntime.ts`'s module-level state for the
 * rest of the process (`clearSyncRuntime` throws before it can null
 * `removeAppStateListener`, and every later `clearSyncRuntime` /
 * `configureSyncRuntime` rethrows), so each case gets its own module
 * registry via `jest.isolateModules` instead of sharing the catalog suite.
 *
 * Both faults are INFERRED unreachable with React Native's real `AppState`
 * (its `addEventListener` always returns an `EventSubscription` whose
 * `remove()` does not throw); they are recorded as KNOWN_BROKEN pins of the
 * current behaviour, not as product findings of their own.
 */
import { AppState } from 'react-native';

import {
  USER_A,
  advance,
  createAppStateHarness,
  createFakeServer,
  createFaultingDb,
  flushFaultRecords,
  flushMicrotasks,
  outboxRowsFor,
  recordFault,
  sessionFor,
  shotPayload,
  unhandledRejectionSentinel,
  type AppStateHarness,
  type FakeServer,
  type FaultingDb,
} from '../../testing/stress/syncRuntimeFaultInjection';

jest.mock('../../src/data/db', () => ({ getDb: jest.fn() }));
jest.mock('../../src/config/runtimeConfig', () => {
  const actual = jest.requireActual<
    typeof import('../../src/config/runtimeConfig')
  >('../../src/config/runtimeConfig');
  return {
    ...actual,
    getRuntimePublicConfig: jest.fn(() => ({
      ...actual.getRuntimePublicConfig(),
      appVersion: '0.0.0-stress',
    })),
  };
});

const SUITE = 'syncRuntimeAppStateTeardown';

type RuntimeModule = typeof import('../../src/data/syncRuntime');
type ApiSessionModule = typeof import('../../src/account/apiSession');
type AccountScopeModule = typeof import('../../src/data/accountScope');
type DbModule = typeof import('../../src/data/db');

interface IsolatedWorld {
  runtime: RuntimeModule;
  apiSession: ApiSessionModule;
  accountScope: AccountScopeModule;
  db: FaultingDb;
  server: FakeServer;
  appState: AppStateHarness;
}

const sentinel = unhandledRejectionSentinel();
const realFetch = globalThis.fetch;

function loadWorld(): IsolatedWorld {
  const db = createFaultingDb();
  const server = createFakeServer();
  const appState = createAppStateHarness();
  let runtime!: RuntimeModule;
  let apiSession!: ApiSessionModule;
  let accountScope!: AccountScopeModule;
  jest.isolateModules(() => {
    const dbModule = jest.requireMock<DbModule>('../../src/data/db');
    (dbModule.getDb as jest.Mock).mockImplementation(() => db.db);
    apiSession = jest.requireActual<ApiSessionModule>(
      '../../src/account/apiSession',
    );
    accountScope = jest.requireActual<AccountScopeModule>(
      '../../src/data/accountScope',
    );
    runtime = jest.requireActual<RuntimeModule>('../../src/data/syncRuntime');
  });
  // `react-native`'s `AppState` is a getter that resolves through the
  // registry ACTIVE AT CALL TIME, so the runtime (called later, from the
  // test body) sees the main registry's AppState mock — patch that one.
  jest
    .spyOn(AppState, 'addEventListener')
    .mockImplementation(
      appState.addEventListener as unknown as typeof AppState.addEventListener,
    );
  globalThis.fetch = server.fetch;
  apiSession.establishApiSession(sessionFor(USER_A));
  accountScope.setActiveDataOwner(accountScope.canonicalDataOwner(USER_A));
  return { runtime, apiSession, accountScope, db, server, appState };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

describe('stress/mod-sync-runtime failure-injection — AppState tear-down', () => {
  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  afterAll(() => {
    sentinel.dispose();
    flushFaultRecords(SUITE);
  });

  it('A02 subscription.remove() throws → clearSyncRuntime rethrows and leaves the runtime un-clearable and un-configurable until relaunch (KNOWN BROKEN, INFERRED unreachable)', async () => {
    const w = loadWorld();
    await recordFault(
      SUITE,
      'appstate',
      'A02',
      null,
      { fault: 'subscription.remove throws' },
      async o => {
        const owner = w.accountScope.canonicalDataOwner(USER_A);
        w.db.inner.push('shot.sync', shotPayload('shot-1', null), owner);
        w.appState.mode = 'removeThrows';
        w.runtime.configureSyncRuntime(sessionFor(USER_A));
        await flushMicrotasks(20);
        // The healthy drain before the fault: shot-1 delivered.
        expect(outboxRowsFor(w.db, owner)).toEqual([]);
        o['deliveredBeforeFault'] = true;

        let clearError: string | null = null;
        try {
          w.runtime.clearSyncRuntime();
        } catch (error) {
          clearError = message(error);
        }
        o['clearError'] = clearError;
        expect(clearError).toContain('injected subscription.remove');
        // The retry timer WAS cleared before the throw…
        expect(jest.getTimerCount()).toBe(0);

        // …but the poisoned remover is still installed: every later clear
        // and configure rethrows, so a new row never drains.
        w.db.inner.push('shot.sync', shotPayload('shot-2', null), owner);
        let secondClearError: string | null = null;
        try {
          w.runtime.clearSyncRuntime();
        } catch (error) {
          secondClearError = message(error);
        }
        let configureError: string | null = null;
        try {
          w.runtime.configureSyncRuntime(sessionFor(USER_A));
        } catch (error) {
          configureError = message(error);
        }
        o['secondClearError'] = secondClearError;
        o['configureError'] = configureError;
        w.runtime.triggerOutboxSync();
        w.appState.fire('active');
        await advance(60_000);
        o['rowsAfter60s'] = outboxRowsFor(w.db, owner).map(r => r.id);
        o['requests'] = w.server.requests.length;
        o['unhandledRejections'] = sentinel.take();

        expect(secondClearError).toContain('injected subscription.remove');
        expect(configureError).toContain('injected subscription.remove');
        expect(o['rowsAfter60s']).toHaveLength(1);
        expect(o['requests']).toBe(1);
        expect(o['unhandledRejections']).toEqual([]);
        return 1;
      },
      { knownBroken: true },
    );
  });

  it('A03 addEventListener returns no subscription → rows drain, but the first clearSyncRuntime throws TypeError and poisons the runtime (KNOWN BROKEN, INFERRED unreachable)', async () => {
    const w = loadWorld();
    await recordFault(
      SUITE,
      'appstate',
      'A03',
      null,
      { fault: 'addEventListener returns undefined' },
      async o => {
        const owner = w.accountScope.canonicalDataOwner(USER_A);
        w.db.inner.push('shot.sync', shotPayload('shot-1', null), owner);
        w.appState.mode = 'returnsUndefined';
        w.runtime.configureSyncRuntime(sessionFor(USER_A));
        await flushMicrotasks(20);
        expect(outboxRowsFor(w.db, owner)).toEqual([]);
        expect(jest.getTimerCount()).toBe(1);

        let clearError: string | null = null;
        try {
          w.runtime.clearSyncRuntime();
        } catch (error) {
          clearError = message(error);
        }
        o['clearError'] = clearError;
        expect(clearError).toContain("reading 'remove'");

        w.appState.mode = 'normal';
        let configureError: string | null = null;
        try {
          w.runtime.configureSyncRuntime(sessionFor(USER_A));
        } catch (error) {
          configureError = message(error);
        }
        o['configureError'] = configureError;
        expect(configureError).toContain("reading 'remove'");
        expect(jest.getTimerCount()).toBe(0);
        o['unhandledRejections'] = sentinel.take();
        expect(o['unhandledRejections']).toEqual([]);
        return 1;
      },
      { knownBroken: true },
    );
  });

  it('A07 healthy subscription: clearSyncRuntime removes exactly one listener and a second configure re-registers exactly one', async () => {
    const w = loadWorld();
    await recordFault(
      SUITE,
      'appstate',
      'A07',
      null,
      { fault: 'none (control)' },
      async o => {
        w.runtime.configureSyncRuntime(sessionFor(USER_A));
        await flushMicrotasks(10);
        w.runtime.clearSyncRuntime();
        w.runtime.configureSyncRuntime(sessionFor(USER_A));
        await flushMicrotasks(10);
        w.runtime.clearSyncRuntime();
        o['handlers'] = w.appState.handlers.length;
        o['removals'] = w.appState.removals;
        expect(w.appState.handlers).toHaveLength(0);
        expect(w.appState.removals).toBe(2);
        expect(jest.getTimerCount()).toBe(0);
        return 0;
      },
    );
  });
});
