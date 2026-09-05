/**
 * STRESS · scr-libraryscreen · lens `failure-injection`
 *
 * Renders the production LibraryScreen inside the real navigation stack the
 * app uses (NavigationContainer → native stack → bottom tabs), with the real
 * training store, the real training API transport, the real SQLite adapter
 * (`getDb` + migrations) and the real repository parsers. Only the native /
 * network boundaries are faked, and every fault is injected there:
 *
 *   SQLite driver (op-sqlite)  open throw · migrate throw · execute throw /
 *                              reject / never / slow / malformed / partial
 *   fetch (training API)       reject · never · slow · 4xx/5xx · 204 ·
 *                              malformed JSON · schema-invalid · partial
 *   Linking (native opener)    canOpenURL false / reject / never · openURL
 *                              reject / never
 *   clock                      future / epoch / non-ISO timestamps
 *   navigation                 blur+refocus mid-flight, stale late settles,
 *                              store reconfiguration mid-flight
 *
 * Invariants asserted after every scenario (fake timers advanced 60s):
 *   - no unbounded spinner without a visible control, no silent failure
 *   - no fake success (an error is never rendered as an empty library, a
 *     failed catalog load is never rendered as "No saved drills yet.")
 *   - no garbage render (NaN / undefined / Invalid Date / [object Object])
 *   - recoverable: clearing the fault + the visible control (or a refocus)
 *     restores the ground-truth render
 *   - no corrupted persisted state: the screen issues zero write statements
 *     and the driver's rows are byte-identical to the seeded rows
 *   - no console.error / console.warn
 *
 * Replay one deterministic scenario:   npx jest --ci libraryScreenFailureInjection -t 'S17 '
 * Replay one random seed:              STRESS_SEED=<seed> STRESS_ITER=1 npx jest --ci libraryScreenFailureInjection -t random
 * Long campaign:                       STRESS_ITER=200 npx jest --ci libraryScreenFailureInjection
 * Result table:                        artifacts/stress/libraryscreen-failure-injection.json
 *                                      (override with STRESS_OUT=<path>)
 */
import React from 'react';
import { Linking, Text, View } from 'react-native';
import {
  act,
  create,
  type ReactTestInstance,
  type ReactTestRenderer,
} from 'react-test-renderer';
import {
  NavigationContainer,
  createNavigationContainerRef,
} from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import * as opSqlite from '@op-engineering/op-sqlite';
import {
  LibraryScreen,
  READS_LOAD_ERROR_TITLE,
} from '../../src/screens/LibraryScreen';
import { BrandNoticeHost } from '../../src/design/BrandNotice';
import { getDb } from '../../src/data/db';
import { setActiveDataOwner } from '../../src/data/accountScope';
import { useAuthStore } from '../../src/auth/authStore';
import {
  clearTrainingStoreConfiguration,
  configureTrainingStore,
  useTrainingStore,
} from '../../src/training/store';
import { createTrainingApi } from '../../src/training/api';
import type {
  MainTabParams,
  RootStackParams,
} from '../../src/navigation/params';
import {
  Rng,
  SAVED_SLUGS,
  UUIDS,
  createFakeFetch,
  createServerState,
  currentPlanBody,
  legacyCaptureRow,
  realShotRow,
  savedDrillItem,
  type FakeSqliteDriverState,
  type FakeTrainingServerState,
  type OutcomeRow,
  type RouteFault,
  type Row,
  type TableFault,
} from '../../test-support/stress/libraryScreenFailureInjectionHarness';

// apps/mobile types only `jest` (no @types/node); the harness declares the
// exact Node surface it uses to persist the seed → outcome table.
declare const require: (id: string) => unknown;
declare const process: { env: Record<string, string | undefined> };

jest.mock('@op-engineering/op-sqlite', () => {
  const support = jest.requireActual<
    typeof import('../../test-support/stress/libraryScreenFailureInjectionHarness')
  >('../../test-support/stress/libraryScreenFailureInjectionHarness');
  const state = support.createSqliteState();
  return { ...support.createFakeOpSqlite(state), __state: state };
});

jest.mock('react-native-safe-area-context', () => {
  const { View: RNView } =
    jest.requireActual<typeof import('react-native')>('react-native');
  return {
    SafeAreaView: RNView,
    SafeAreaProvider: RNView,
    SafeAreaInsetsContext: {
      Consumer: (props: {
        children: (insets: Record<string, number>) => React.ReactNode;
      }) => props.children({ top: 0, bottom: 0, left: 0, right: 0 }),
    },
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
    useSafeAreaFrame: () => ({ x: 0, y: 0, width: 390, height: 844 }),
    initialWindowMetrics: null,
  };
});

const sqlite = (opSqlite as unknown as { __state: FakeSqliteDriverState })
  .__state;

// ---------------------------------------------------------------------------
// Real navigator (the app's RootNavigator shape, with the sibling screens the
// Library can navigate to replaced by param-recording stubs).
// ---------------------------------------------------------------------------

const Stack = createNativeStackNavigator<RootStackParams>();
const Tabs = createBottomTabNavigator<MainTabParams>();
const navigationRef = createNavigationContainerRef<RootStackParams>();

function StubScreen(props: { route: { name: string; params?: object } }) {
  return (
    <View>
      <Text>{`STUB:${props.route.name}:${JSON.stringify(
        props.route.params ?? null,
      )}`}</Text>
    </View>
  );
}

function MainTabs() {
  return (
    <Tabs.Navigator
      initialRouteName="Library"
      tabBar={() => null}
      screenOptions={{ headerShown: false }}
    >
      <Tabs.Screen name="Home" component={StubScreen} />
      <Tabs.Screen name="Library" component={LibraryScreen} />
    </Tabs.Navigator>
  );
}

class Boundary extends React.Component<
  { children: React.ReactNode; onError: (error: Error) => void },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error) {
    this.props.onError(error);
  }

  render() {
    return this.state.failed ? <Text>RENDER_CRASH</Text> : this.props.children;
  }
}

function App(props: { onError: (error: Error) => void }) {
  return (
    <Boundary onError={props.onError}>
      <NavigationContainer ref={navigationRef}>
        <Stack.Navigator screenOptions={{ headerShown: false }}>
          <Stack.Screen name="Tabs" component={MainTabs} />
          <Stack.Screen name="Result" component={StubScreen} />
          <Stack.Screen name="Analyze" component={StubScreen} />
          <Stack.Screen name="DrillLibrary" component={StubScreen} />
          <Stack.Screen name="ConnectAccount" component={StubScreen} />
        </Stack.Navigator>
        <BrandNoticeHost />
      </NavigationContainer>
    </Boundary>
  );
}

// ---------------------------------------------------------------------------
// Copy pinned from the production screen / store
// ---------------------------------------------------------------------------

const STRESS_OWNER = '9f8e7d6c-5b4a-4f3e-8d2c-1b0a9f8e7d6c';
const READS_SPINNER = 'Opening your library…';
const SAVED_SPINNER = 'Loading saved drills…';
const READS_EMPTY = 'Your measured reads, in one place.';
const READS_TRUTH = '1 analyzed read · 1 pending clip';
const SAVED_OFFLINE = 'Training is offline.';
const SAVED_HELD = 'Saved entries couldn’t be verified right now.';
const SAVED_EMPTY = 'No saved drills yet.';
const SAVED_UNCONFIGURED = 'Saved training needs a synced account.';
const SAVED_TRUTH = '2 saved';
const MEDIA_NOTICE = 'Video unavailable';
const GARBAGE = ['NaN', 'undefined', 'Invalid Date', '[object Object]', 'null'];

// ---------------------------------------------------------------------------
// World: one mounted app + fault controls + invariant checks
// ---------------------------------------------------------------------------

type LinkFault =
  | { mode: 'ok' }
  | { mode: 'false' }
  | { mode: 'reject' }
  | { mode: 'never' }
  | { mode: 'slow'; delayMs: number };

interface LinkingFaults {
  canOpen: LinkFault;
  open: LinkFault;
}

function linkImpl(fault: LinkFault, value: boolean) {
  return () => {
    switch (fault.mode) {
      case 'ok':
        return Promise.resolve(value);
      case 'false':
        return Promise.resolve(false);
      case 'reject':
        return Promise.reject(new Error('Unable to open URL'));
      case 'never':
        return new Promise<boolean>(() => {});
      case 'slow':
        return new Promise<boolean>(resolve =>
          setTimeout(() => resolve(value), fault.delayMs),
        );
    }
  };
}

/** Rendered copy: strings inside one <Text> concatenate exactly as RN lays
 * them out; separate <Text> elements are newline-separated. */
function collectText(node: ReactTestInstance | null): string {
  if (!node) return '';
  const parts: string[] = [];
  const visit = (child: ReactTestInstance | string, inText: boolean) => {
    if (typeof child === 'string') {
      parts.push(child);
      return;
    }
    const isText = (child.type as unknown) === 'Text';
    if (isText && !inText) parts.push('\n');
    child.children.forEach(grandchild => visit(grandchild, inText || isText));
  };
  visit(node, false);
  return parts.join('');
}

class World {
  renderer: ReactTestRenderer | null = null;
  readonly server: FakeTrainingServerState = createServerState();
  readonly linking: LinkingFaults = {
    canOpen: { mode: 'ok' },
    open: { mode: 'ok' },
  };
  readonly consoleIssues: string[] = [];
  readonly crashes: Error[] = [];
  readonly openedUrls: string[] = [];
  private shotSnapshot: string;
  private captureSnapshot: string;

  constructor() {
    sqlite.openMode = 'ok';
    sqlite.shots = { mode: 'ok' };
    sqlite.captures = { mode: 'ok' };
    sqlite.shotRows = [realShotRow()];
    sqlite.captureRows = [legacyCaptureRow()];
    sqlite.statements.length = 0;
    sqlite.writes.length = 0;
    sqlite.pending.length = 0;
    sqlite.openCount = 0;
    this.shotSnapshot = JSON.stringify(sqlite.shotRows);
    this.captureSnapshot = JSON.stringify(sqlite.captureRows);
    setActiveDataOwner(STRESS_OWNER);
    useAuthStore.setState({
      session: {
        provider: 'apple',
        subject: 'stress-user',
        canonicalAppUserId: STRESS_OWNER,
        localOnly: false,
        displayName: null,
        email: null,
      },
    });
    globalThis.fetch = createFakeFetch(this.server) as typeof fetch;
    configureTrainingStore(
      createTrainingApi({ baseUrl: 'https://api.stress.test', token: 'tok' }),
    );
    jest.spyOn(Linking, 'canOpenURL').mockImplementation(url => {
      void url;
      return linkImpl(this.linking.canOpen, true)();
    });
    jest.spyOn(Linking, 'openURL').mockImplementation(url => {
      const result = linkImpl(this.linking.open, true)();
      return result.then(() => {
        this.openedUrls.push(url);
      });
    });
  }

  resnapshotRows(): void {
    this.shotSnapshot = JSON.stringify(sqlite.shotRows);
    this.captureSnapshot = JSON.stringify(sqlite.captureRows);
  }

  async mount(): Promise<void> {
    await act(async () => {
      this.renderer = create(
        <App onError={error => this.crashes.push(error)} />,
      );
    });
    await this.flush();
  }

  async unmount(): Promise<void> {
    if (!this.renderer) return;
    const renderer = this.renderer;
    await act(async () => {
      renderer.unmount();
    });
    this.renderer = null;
  }

  async flush(rounds = 8): Promise<void> {
    for (let i = 0; i < rounds; i += 1) {
      await act(async () => {
        await Promise.resolve();
      });
    }
  }

  /** Advances fake time in steps so timers armed by promise continuations
   * (e.g. a slow detail fetch queued after a slow list fetch) also fire. */
  async advance(ms: number): Promise<void> {
    const step = Math.max(1, Math.min(1_000, Math.ceil(ms / 12)));
    let remaining = ms;
    while (remaining > 0) {
      const chunk = Math.min(step, remaining);
      remaining -= chunk;
      await act(async () => {
        await jest.advanceTimersByTimeAsync(chunk);
      });
      await this.flush(2);
    }
    await this.flush();
  }

  text(): string {
    return collectText(this.renderer?.root ?? null);
  }

  has(copy: string): boolean {
    return this.text().includes(copy);
  }

  pressableByLabel(label: string): ReactTestInstance | null {
    if (!this.renderer) return null;
    const [node] = this.renderer.root.findAll(
      n =>
        typeof n.type !== 'string' &&
        n.props.accessibilityLabel === label &&
        typeof n.props.onPress === 'function',
    );
    return node ?? null;
  }

  async press(label: string): Promise<boolean> {
    const node = this.pressableByLabel(label);
    if (
      !node ||
      node.props.disabled ||
      node.props.accessibilityState?.disabled
    ) {
      return false;
    }
    await act(async () => {
      node.props.onPress();
    });
    await this.flush();
    return true;
  }

  /** Presses a segmented tab; false when the tabs are not on screen (the
   * initial reads spinner renders without them). */
  async pressTab(label: 'Reads' | 'Saved drills'): Promise<boolean> {
    if (!this.renderer) throw new Error('not mounted');
    const tabs = this.renderer.root.findAll(
      n =>
        typeof n.type !== 'string' &&
        n.props.accessibilityRole === 'tab' &&
        typeof n.props.onPress === 'function' &&
        collectText(n).includes(label),
    );
    const tab = tabs[0];
    if (!tab) return false;
    await act(async () => {
      tab.props.onPress();
    });
    await this.flush();
    return true;
  }

  async navigateAway(): Promise<void> {
    await act(async () => {
      navigationRef.navigate('Result', { analysisId: UUIDS.shot });
    });
    await this.flush();
  }

  async navigateBack(): Promise<void> {
    await act(async () => {
      if (navigationRef.canGoBack()) navigationRef.goBack();
    });
    await this.flush();
  }

  currentRoute(): string {
    return navigationRef.getCurrentRoute()?.name ?? '';
  }

  brandNoticeVisible(): boolean {
    if (!this.renderer) return false;
    const dialogs = this.renderer.root.findAll(
      n => n.props.testID === 'brand-notice' && typeof n.type !== 'string',
    );
    return dialogs.some(d => d.props.visible === true);
  }

  clearFaults(): void {
    sqlite.openMode = 'ok';
    sqlite.shots = { mode: 'ok' };
    sqlite.captures = { mode: 'ok' };
    this.server.routes.savedDrills = { mode: 'ok' };
    this.server.routes.drillDetail = { mode: 'ok' };
    this.server.routes.currentPlan = { mode: 'ok' };
    this.server.routes.unsaveDrill = { mode: 'ok' };
    this.server.drillDetailBySlug = {};
    const defaults = createServerState();
    this.server.savedDrillsBody = defaults.savedDrillsBody;
    this.server.drillDetailBody = defaults.drillDetailBody;
    this.linking.canOpen = { mode: 'ok' };
    this.linking.open = { mode: 'ok' };
  }

  /** Invariants that must hold at every checkpoint of every scenario. */
  checkInvariants(where: string): void {
    const text = this.text();
    expect({ where, crashes: this.crashes.map(e => e.message) }).toEqual({
      where,
      crashes: [],
    });
    expect({ where, consoleIssues: this.consoleIssues }).toEqual({
      where,
      consoleIssues: [],
    });
    expect({ where, text }).not.toContain('RENDER_CRASH');
    // Whole-word garbage tokens only; the stub screens' route params are
    // stripped first ("null" is legitimate there).
    const stripped = text.replace(/STUB:[^\n]*/g, '');
    for (const token of GARBAGE) {
      const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const match = stripped.match(
        new RegExp(`(^|[^A-Za-z])${escaped}([^A-Za-z]|$)`),
      );
      expect({ where, token, garbage: match?.[0] ?? null }).toEqual({
        where,
        token,
        garbage: null,
      });
    }
    expect({ where, writes: sqlite.writes }).toEqual({ where, writes: [] });
    expect({ where, rows: JSON.stringify(sqlite.shotRows) }).toEqual({
      where,
      rows: this.shotSnapshot,
    });
    expect({ where, rows: JSON.stringify(sqlite.captureRows) }).toEqual({
      where,
      rows: this.captureSnapshot,
    });
    const store = useTrainingStore.getState();
    expect(['idle', 'loading', 'ready', 'unconfigured', 'error']).toContain(
      store.savedStatus,
    );
    expect(['idle', 'loading', 'ready', 'unconfigured', 'error']).toContain(
      store.planStatus,
    );
    expect(Array.isArray(store.savedDrills)).toBe(true);
    for (const detail of Object.values(store.drillDetails)) {
      expect(detail).toEqual(
        expect.objectContaining({ slug: expect.any(String) }),
      );
    }
    // A spinner and its terminal state never coexist.
    expect(
      text.includes(READS_SPINNER) && text.includes(READS_LOAD_ERROR_TITLE),
    ).toBe(false);
    expect(text.includes(READS_SPINNER) && text.includes(READS_TRUTH)).toBe(
      false,
    );
    // Error states always carry their visible control.
    if (text.includes(READS_LOAD_ERROR_TITLE)) {
      expect(this.pressableByLabel('Try again')).not.toBeNull();
    }
    if (text.includes(SAVED_OFFLINE) || text.includes(SAVED_HELD)) {
      expect(this.pressableByLabel('Try again')).not.toBeNull();
    }
    // Segmented tabs (the on-screen navigation control) are present whenever
    // the Library is focused and past its initial reads spinner (the loading
    // state deliberately renders without a header).
    if (this.currentRoute() === 'Library' && !text.includes(READS_SPINNER)) {
      expect(
        this.renderer?.root.findAll(
          n =>
            typeof n.type !== 'string' &&
            n.props.accessibilityRole === 'tab' &&
            typeof n.props.onPress === 'function',
        ).length,
      ).toBe(2);
    }
  }
}

// ---------------------------------------------------------------------------
// Scenario catalogue
// ---------------------------------------------------------------------------

type Expectation =
  | { kind: 'reads-error' }
  | { kind: 'reads-ok'; text?: string }
  | { kind: 'reads-settles-within-60s' }
  | { kind: 'saved-error' }
  | { kind: 'saved-held' }
  | { kind: 'saved-partial' }
  | { kind: 'saved-ok'; text?: string }
  | { kind: 'saved-unconfigured'; connect: boolean }
  | { kind: 'saved-settles-within-60s' }
  | { kind: 'plan-absent' }
  | { kind: 'plan-present' }
  | { kind: 'unsave-error' }
  | { kind: 'unsave-settles-within-60s' }
  | { kind: 'media-notice' }
  | { kind: 'media-opens' }
  | { kind: 'media-settles-within-60s' }
  | { kind: 'custom'; run: (world: World) => Promise<void> };

interface Scenario {
  id: string;
  dependency: string;
  shape: string;
  apply: (world: World) => void;
  expectation: Expectation;
}

const malformedResult = (result: unknown): TableFault => ({
  mode: 'result',
  result,
});

const S: Scenario[] = [];
let n = 0;
function scenario(
  dependency: string,
  shape: string,
  apply: (world: World) => void,
  expectation: Expectation,
): void {
  n += 1;
  S.push({
    id: `S${String(n).padStart(2, '0')}`,
    dependency,
    shape,
    apply,
    expectation,
  });
}

// --- SQLite: open / migrate ------------------------------------------------
scenario(
  'sqlite.open',
  'throw',
  () => {
    sqlite.openMode = 'throw';
  },
  { kind: 'reads-error' },
);
scenario(
  'sqlite.migrate',
  'throw',
  () => {
    sqlite.openMode = 'migrate-throw';
  },
  { kind: 'reads-error' },
);

// --- SQLite: local_shot read ----------------------------------------------
scenario(
  'sqlite.local_shot',
  'throw',
  () => {
    sqlite.shots = {
      mode: 'throw',
      message: 'SQLITE_BUSY: database is locked',
    };
  },
  { kind: 'reads-error' },
);
scenario(
  'sqlite.local_shot',
  'reject',
  () => {
    sqlite.shots = { mode: 'reject', message: 'SQLITE_IOERR: disk I/O error' };
  },
  { kind: 'reads-error' },
);
scenario(
  'sqlite.local_shot',
  'never',
  () => {
    sqlite.shots = { mode: 'never' };
  },
  { kind: 'reads-settles-within-60s' },
);
scenario(
  'sqlite.local_shot',
  'slow-5s',
  () => {
    sqlite.shots = { mode: 'slow', delayMs: 5_000 };
  },
  { kind: 'reads-settles-within-60s' },
);
scenario(
  'sqlite.local_shot',
  'slow-59s',
  () => {
    sqlite.shots = { mode: 'slow', delayMs: 59_000 };
  },
  { kind: 'reads-settles-within-60s' },
);
scenario(
  'sqlite.local_shot',
  'slow-reject-30s',
  () => {
    sqlite.shots = {
      mode: 'slow-reject',
      delayMs: 30_000,
      message: 'SQLITE_IOERR',
    };
  },
  { kind: 'reads-settles-within-60s' },
);
scenario(
  'sqlite.local_shot',
  'malformed:rows-not-array',
  () => {
    sqlite.shots = malformedResult({ rows: 'corrupt' });
  },
  { kind: 'reads-error' },
);
scenario(
  'sqlite.local_shot',
  'malformed:result-null',
  () => {
    sqlite.shots = malformedResult(null);
  },
  { kind: 'reads-error' },
);
scenario(
  'sqlite.local_shot',
  'malformed:rows-of-null',
  () => {
    sqlite.shots = malformedResult({ rows: [null] });
  },
  { kind: 'reads-error' },
);
scenario(
  'sqlite.local_shot',
  'malformed:overall_score-text',
  () => {
    sqlite.shotRows = [realShotRow({ overall_score: 'seventy-one' })];
  },
  { kind: 'reads-ok', text: '1 analyzed read' },
);
scenario(
  'sqlite.local_shot',
  'malformed:captured_at-garbage',
  () => {
    sqlite.shotRows = [realShotRow({ captured_at: 'yesterday-ish' })];
  },
  { kind: 'reads-ok', text: '1 analyzed read' },
);
scenario(
  'sqlite.local_shot',
  'malformed:score-null-on-scored',
  () => {
    sqlite.shotRows = [realShotRow({ overall_score: null })];
  },
  { kind: 'reads-ok', text: '1 analyzed read' },
);
scenario(
  'sqlite.local_shot',
  'partial:100-rows-one-corrupt',
  () => {
    sqlite.shotRows = Array.from({ length: 100 }, (_, i) =>
      realShotRow({
        id: `${UUIDS.shot.slice(0, -3)}${String(i).padStart(3, '0')}`,
        captured_at:
          i === 50
            ? 'not-a-date'
            : `2026-08-${String((i % 28) + 1).padStart(2, '0')}T10:00:00.000Z`,
      }),
    );
  },
  { kind: 'reads-ok', text: '100 analyzed reads' },
);
scenario(
  'sqlite.local_shot',
  'malformed:low_confidence-with-score',
  () => {
    sqlite.shotRows = [
      realShotRow({ result_kind: 'low_confidence', overall_score: 88 }),
    ];
  },
  { kind: 'reads-ok', text: 'NOT READ' },
);

// --- SQLite: local_capture read ------------------------------------------
scenario(
  'sqlite.local_capture',
  'reject',
  () => {
    sqlite.captures = { mode: 'reject', message: 'SQLITE_CORRUPT' };
  },
  { kind: 'reads-error' },
);
scenario(
  'sqlite.local_capture',
  'throw',
  () => {
    sqlite.captures = { mode: 'throw', message: 'SQLITE_MISUSE' };
  },
  { kind: 'reads-error' },
);
scenario(
  'sqlite.local_capture',
  'never',
  () => {
    sqlite.captures = { mode: 'never' };
  },
  { kind: 'reads-settles-within-60s' },
);
scenario(
  'sqlite.local_capture',
  'slow-20s',
  () => {
    sqlite.captures = { mode: 'slow', delayMs: 20_000 };
  },
  { kind: 'reads-settles-within-60s' },
);
scenario(
  'sqlite.local_capture',
  'malformed:payload-invalid-json',
  () => {
    sqlite.captureRows = [legacyCaptureRow({ payload: '{"uri": ' })];
  },
  { kind: 'reads-ok', text: 'Saved evidence could not be verified' },
);
scenario(
  'sqlite.local_capture',
  'malformed:payload-wrong-shape',
  () => {
    sqlite.captureRows = [
      legacyCaptureRow({ payload: JSON.stringify({ hello: 'world' }) }),
    ];
  },
  { kind: 'reads-ok', text: 'Saved evidence could not be verified' },
);
scenario(
  'sqlite.local_capture',
  'malformed:payload-number',
  () => {
    sqlite.captureRows = [legacyCaptureRow({ payload: 42 })];
  },
  { kind: 'reads-ok', text: 'Saved evidence could not be verified' },
);
scenario(
  'sqlite.local_capture',
  'malformed:duration-text',
  () => {
    sqlite.captureRows = [legacyCaptureRow({ duration_ms: 'four seconds' })];
  },
  { kind: 'reads-ok', text: '1 pending clip' },
);
scenario(
  'sqlite.local_capture',
  'malformed:captured_at-garbage',
  () => {
    sqlite.captureRows = [legacyCaptureRow({ captured_at: '' })];
  },
  { kind: 'reads-ok', text: '1 pending clip' },
);
scenario(
  'sqlite.local_capture',
  'malformed:declared_stroke-unknown',
  () => {
    sqlite.captureRows = [
      legacyCaptureRow({ declared_stroke: 'moonball', shot_type: 'unknown' }),
    ];
  },
  { kind: 'reads-ok', text: '1 pending clip' },
);
scenario(
  'sqlite.local_capture',
  'malformed:rows-of-null',
  () => {
    sqlite.captures = malformedResult({ rows: [null] });
  },
  { kind: 'reads-error' },
);
scenario(
  'sqlite.both',
  'partial:shots-ok-captures-reject',
  () => {
    sqlite.captures = { mode: 'reject', message: 'SQLITE_IOERR' };
  },
  { kind: 'reads-error' },
);
scenario(
  'sqlite.both',
  'partial:shots-reject-captures-slow',
  () => {
    sqlite.shots = { mode: 'reject', message: 'SQLITE_IOERR' };
    sqlite.captures = { mode: 'slow', delayMs: 3_000 };
  },
  { kind: 'reads-error' },
);
scenario(
  'sqlite.both',
  'partial:shots-slow-captures-reject',
  () => {
    sqlite.shots = { mode: 'slow', delayMs: 3_000 };
    sqlite.captures = { mode: 'reject', message: 'SQLITE_IOERR' };
  },
  { kind: 'reads-error' },
);
scenario(
  'sqlite.both',
  'partial:shots-never-captures-reject',
  () => {
    sqlite.shots = { mode: 'never' };
    sqlite.captures = { mode: 'reject', message: 'SQLITE_IOERR' };
  },
  { kind: 'reads-error' },
);
scenario(
  'sqlite.both',
  'empty-tables',
  () => {
    sqlite.shotRows = [];
    sqlite.captureRows = [];
  },
  { kind: 'reads-ok', text: READS_EMPTY },
);

// --- fetch: GET /v1/me/saved-drills ---------------------------------------
scenario(
  'fetch.saved-drills',
  'reject',
  w => {
    w.server.routes.savedDrills = {
      mode: 'reject',
      message: 'Network request failed',
    };
  },
  { kind: 'saved-error' },
);
scenario(
  'fetch.saved-drills',
  'never',
  w => {
    w.server.routes.savedDrills = { mode: 'never' };
  },
  { kind: 'saved-settles-within-60s' },
);
scenario(
  'fetch.saved-drills',
  'slow-5s',
  w => {
    w.server.routes.savedDrills = { mode: 'slow', delayMs: 5_000 };
  },
  { kind: 'saved-settles-within-60s' },
);
scenario(
  'fetch.saved-drills',
  'slow-59s',
  w => {
    w.server.routes.savedDrills = { mode: 'slow', delayMs: 59_000 };
  },
  { kind: 'saved-settles-within-60s' },
);
scenario(
  'fetch.saved-drills',
  'slow-reject-45s',
  w => {
    w.server.routes.savedDrills = {
      mode: 'slow-reject',
      delayMs: 45_000,
      message: 'timeout',
    };
  },
  { kind: 'saved-settles-within-60s' },
);
scenario(
  'fetch.saved-drills',
  'http-500',
  w => {
    w.server.routes.savedDrills = { mode: 'status', status: 500 };
  },
  { kind: 'saved-error' },
);
scenario(
  'fetch.saved-drills',
  'http-502-html',
  w => {
    w.server.routes.savedDrills = { mode: 'malformed-json', status: 502 };
  },
  { kind: 'saved-error' },
);
scenario(
  'fetch.saved-drills',
  'http-401',
  w => {
    w.server.routes.savedDrills = { mode: 'status', status: 401 };
  },
  { kind: 'saved-error' },
);
scenario(
  'fetch.saved-drills',
  'http-403',
  w => {
    w.server.routes.savedDrills = { mode: 'status', status: 403 };
  },
  { kind: 'saved-error' },
);
scenario(
  'fetch.saved-drills',
  'http-404',
  w => {
    w.server.routes.savedDrills = { mode: 'status', status: 404 };
  },
  { kind: 'saved-error' },
);
scenario(
  'fetch.saved-drills',
  'http-429',
  w => {
    w.server.routes.savedDrills = { mode: 'status', status: 429 };
  },
  { kind: 'saved-error' },
);
scenario(
  'fetch.saved-drills',
  'http-204-empty',
  w => {
    w.server.routes.savedDrills = { mode: 'status', status: 204 };
  },
  { kind: 'saved-error' },
);
scenario(
  'fetch.saved-drills',
  'malformed:json-parse',
  w => {
    w.server.routes.savedDrills = { mode: 'malformed-json' };
  },
  { kind: 'saved-error' },
);
scenario(
  'fetch.saved-drills',
  'malformed:items-not-array',
  w => {
    w.server.routes.savedDrills = { mode: 'body', body: { items: 'none' } };
  },
  { kind: 'saved-error' },
);
scenario(
  'fetch.saved-drills',
  'malformed:body-null',
  w => {
    w.server.routes.savedDrills = { mode: 'body', body: null };
  },
  { kind: 'saved-error' },
);
scenario(
  'fetch.saved-drills',
  'malformed:item-bad-uuid',
  w => {
    w.server.routes.savedDrills = {
      mode: 'body',
      body: { items: [{ ...savedDrillItem(SAVED_SLUGS[0], 'not-a-uuid') }] },
    };
  },
  { kind: 'saved-error' },
);
scenario(
  'fetch.saved-drills',
  'malformed:item-saved_at-garbage',
  w => {
    w.server.routes.savedDrills = {
      mode: 'body',
      body: {
        items: [
          {
            ...savedDrillItem(SAVED_SLUGS[0], UUIDS.drillA),
            saved_at: 'last tuesday',
          },
        ],
      },
    };
  },
  { kind: 'saved-error' },
);
scenario(
  'fetch.saved-drills',
  'malformed:item-missing-title',
  w => {
    const item = savedDrillItem(SAVED_SLUGS[0], UUIDS.drillA);
    delete item['title'];
    w.server.routes.savedDrills = { mode: 'body', body: { items: [item] } };
  },
  { kind: 'saved-error' },
);
scenario(
  'fetch.saved-drills',
  'partial:one-of-two-invalid',
  w => {
    w.server.routes.savedDrills = {
      mode: 'body',
      body: {
        items: [
          savedDrillItem(SAVED_SLUGS[0], UUIDS.drillA),
          { ...savedDrillItem(SAVED_SLUGS[1], UUIDS.drillB), coach_name: 7 },
        ],
      },
    };
  },
  { kind: 'saved-error' },
);
scenario(
  'fetch.saved-drills',
  'empty-list',
  w => {
    w.server.routes.savedDrills = { mode: 'body', body: { items: [] } };
  },
  { kind: 'saved-ok', text: SAVED_EMPTY },
);
scenario(
  'fetch.saved-drills',
  'huge-list-200',
  w => {
    w.server.routes.savedDrills = {
      mode: 'body',
      body: {
        items: Array.from({ length: 200 }, (_, i) =>
          savedDrillItem(
            `drill-${i}`,
            `${UUIDS.drillA.slice(0, -4)}${String(i).padStart(4, '0')}`,
          ),
        ),
      },
    };
    w.server.drillDetailBody = slug => ({
      ...currentDetail(slug),
    });
  },
  { kind: 'saved-ok', text: '200 saved' },
);

function currentDetail(slug: string): Row {
  const base = createServerState().drillDetailBody(SAVED_SLUGS[0]) as {
    drill: Row;
    mappings: unknown[];
    instructionalMedia: unknown[];
  };
  return {
    ...base,
    drill: { ...base.drill, slug, title: `Drill ${slug}` },
  };
}

// --- fetch: GET /v1/catalog/drills/:slug (detail, partial failures) -------
scenario(
  'fetch.drill-detail',
  'reject-all',
  w => {
    w.server.routes.drillDetail = {
      mode: 'reject',
      message: 'Network request failed',
    };
  },
  { kind: 'saved-held' },
);
scenario(
  'fetch.drill-detail',
  'http-500-all',
  w => {
    w.server.routes.drillDetail = { mode: 'status', status: 500 };
  },
  { kind: 'saved-held' },
);
scenario(
  'fetch.drill-detail',
  'http-404-all',
  w => {
    w.server.routes.drillDetail = { mode: 'status', status: 404 };
  },
  { kind: 'saved-held' },
);
scenario(
  'fetch.drill-detail',
  'malformed:all',
  w => {
    w.server.routes.drillDetail = { mode: 'body', body: { drill: 'nope' } };
  },
  { kind: 'saved-held' },
);
scenario(
  'fetch.drill-detail',
  'malformed:media-http-url',
  w => {
    w.server.drillDetailBody = slug => {
      const body = createServerState().drillDetailBody(slug) as {
        instructionalMedia: Row[];
      };
      const media = body.instructionalMedia[0];
      return {
        ...body,
        instructionalMedia: [
          { ...media, sourceUrl: 'http://insecure.example' },
        ],
      };
    };
  },
  { kind: 'saved-held' },
);
scenario(
  'fetch.drill-detail',
  'malformed:mapping-target_sets-0',
  w => {
    w.server.drillDetailBody = slug => {
      const body = createServerState().drillDetailBody(slug) as {
        mappings: Row[];
      };
      const mapping = body.mappings[0];
      return { ...body, mappings: [{ ...mapping, target_sets: 0 }] };
    };
  },
  { kind: 'saved-held' },
);
scenario(
  'fetch.drill-detail',
  'partial:one-of-two-rejects',
  w => {
    w.server.drillDetailBySlug[SAVED_SLUGS[1]] = {
      mode: 'reject',
      message: 'Network request failed',
    };
  },
  { kind: 'saved-partial' },
);
scenario(
  'fetch.drill-detail',
  'partial:one-of-two-500',
  w => {
    w.server.drillDetailBySlug[SAVED_SLUGS[1]] = {
      mode: 'status',
      status: 500,
    };
  },
  { kind: 'saved-partial' },
);
scenario(
  'fetch.drill-detail',
  'partial:one-of-two-malformed',
  w => {
    w.server.drillDetailBySlug[SAVED_SLUGS[1]] = { mode: 'body', body: {} };
  },
  { kind: 'saved-partial' },
);
scenario(
  'fetch.drill-detail',
  'never-all',
  w => {
    w.server.routes.drillDetail = { mode: 'never' };
  },
  { kind: 'saved-settles-within-60s' },
);
scenario(
  'fetch.drill-detail',
  'partial:one-of-two-never',
  w => {
    w.server.drillDetailBySlug[SAVED_SLUGS[1]] = { mode: 'never' };
  },
  { kind: 'saved-settles-within-60s' },
);
scenario(
  'fetch.drill-detail',
  'slow-30s-all',
  w => {
    w.server.routes.drillDetail = { mode: 'slow', delayMs: 30_000 };
  },
  { kind: 'saved-settles-within-60s' },
);
scenario(
  'fetch.drill-detail',
  'empty-media-list',
  w => {
    w.server.drillDetailBody = slug => ({
      ...(createServerState().drillDetailBody(slug) as Row),
      instructionalMedia: [],
    });
  },
  { kind: 'saved-ok', text: SAVED_TRUTH },
);

// --- fetch: GET /v1/training-plans/current --------------------------------
scenario(
  'fetch.current-plan',
  'reject',
  w => {
    w.server.routes.currentPlan = {
      mode: 'reject',
      message: 'Network request failed',
    };
  },
  { kind: 'plan-absent' },
);
scenario(
  'fetch.current-plan',
  'http-500',
  w => {
    w.server.routes.currentPlan = { mode: 'status', status: 500 };
  },
  { kind: 'plan-absent' },
);
scenario(
  'fetch.current-plan',
  'http-401',
  w => {
    w.server.routes.currentPlan = { mode: 'status', status: 401 };
  },
  { kind: 'plan-absent' },
);
scenario(
  'fetch.current-plan',
  'never',
  w => {
    w.server.routes.currentPlan = { mode: 'never' };
  },
  { kind: 'plan-absent' },
);
scenario(
  'fetch.current-plan',
  'slow-40s',
  w => {
    w.server.currentPlanBody = currentPlanBody;
    w.server.routes.currentPlan = { mode: 'slow', delayMs: 40_000 };
  },
  { kind: 'plan-present' },
);
scenario(
  'fetch.current-plan',
  'malformed:plan-not-object',
  w => {
    w.server.routes.currentPlan = { mode: 'body', body: { plan: 'yes' } };
  },
  { kind: 'plan-absent' },
);
scenario(
  'fetch.current-plan',
  'malformed:plan-bad-status',
  w => {
    const body = currentPlanBody() as { plan: Row };
    w.server.routes.currentPlan = {
      mode: 'body',
      body: { plan: { ...body.plan, status: 'paused' } },
    };
  },
  { kind: 'plan-absent' },
);
scenario(
  'fetch.current-plan',
  'malformed:plan-item-drill-missing',
  w => {
    const body = currentPlanBody() as { plan: { items: Row[] } & Row };
    const first = body.plan.items[0];
    w.server.routes.currentPlan = {
      mode: 'body',
      body: { plan: { ...body.plan, items: [{ ...first, drill: null }] } },
    };
  },
  { kind: 'plan-absent' },
);
scenario(
  'fetch.current-plan',
  'malformed:baselineScore-NaN-string',
  w => {
    const body = currentPlanBody() as { plan: Row };
    w.server.routes.currentPlan = {
      mode: 'body',
      body: { plan: { ...body.plan, baselineScore: 'NaN' } },
    };
  },
  { kind: 'plan-absent' },
);
scenario(
  'fetch.current-plan',
  'ok-active-plan',
  w => {
    w.server.currentPlanBody = currentPlanBody;
  },
  { kind: 'plan-present' },
);
scenario(
  'fetch.current-plan',
  'ok-plan-but-detail-rejects',
  w => {
    w.server.currentPlanBody = currentPlanBody;
    w.server.routes.drillDetail = {
      mode: 'reject',
      message: 'Network request failed',
    };
  },
  { kind: 'plan-present' },
);

// --- fetch: DELETE /v1/me/saved-drills/:slug (unsave mutation) ------------
scenario(
  'fetch.unsave',
  'reject',
  w => {
    w.server.routes.unsaveDrill = {
      mode: 'reject',
      message: 'Network request failed',
    };
  },
  { kind: 'unsave-error' },
);
scenario(
  'fetch.unsave',
  'http-500',
  w => {
    w.server.routes.unsaveDrill = { mode: 'status', status: 500 };
  },
  { kind: 'unsave-error' },
);
scenario(
  'fetch.unsave',
  'http-401',
  w => {
    w.server.routes.unsaveDrill = { mode: 'status', status: 401 };
  },
  { kind: 'unsave-error' },
);
scenario(
  'fetch.unsave',
  'http-409',
  w => {
    w.server.routes.unsaveDrill = { mode: 'status', status: 409 };
  },
  { kind: 'unsave-error' },
);
scenario(
  'fetch.unsave',
  'malformed:200-html',
  w => {
    w.server.routes.unsaveDrill = { mode: 'malformed-json', status: 200 };
  },
  { kind: 'unsave-error' },
);
scenario(
  'fetch.unsave',
  'never',
  w => {
    w.server.routes.unsaveDrill = { mode: 'never' };
  },
  { kind: 'unsave-settles-within-60s' },
);
scenario(
  'fetch.unsave',
  'slow-30s',
  w => {
    w.server.routes.unsaveDrill = { mode: 'slow', delayMs: 30_000 };
  },
  { kind: 'unsave-settles-within-60s' },
);
scenario(
  'fetch.unsave',
  'ok-then-reload-rejects',
  w => {
    void w;
  },
  {
    kind: 'custom',
    run: async w => {
      await w.pressTab('Saved drills');
      await w.flush();
      expect(w.has(SAVED_TRUTH)).toBe(true);
      // The DELETE succeeds; the follow-up GET /saved-drills fails.
      w.server.routes.savedDrills = { mode: 'status', status: 503 };
      expect(await w.press('Remove Kitchen line dinks from saved drills')).toBe(
        true,
      );
      await w.advance(60_000);
      w.checkInvariants('after unsave + failed reload');
      // No fake success: the list must not claim a fresh "1 saved" from a
      // failed reload; the offline card with a retry must show instead.
      expect(w.has(SAVED_OFFLINE)).toBe(true);
      expect(w.has(SAVED_EMPTY)).toBe(false);
      w.clearFaults();
      w.server.savedDrillsBody = () => ({
        items: [savedDrillItem(SAVED_SLUGS[1], UUIDS.drillB)],
      });
      expect(await w.press('Try again')).toBe(true);
      await w.advance(1_000);
      expect(w.has('1 saved')).toBe(true);
      w.checkInvariants('after recovery');
    },
  },
);

// --- Linking (native URL opener) ------------------------------------------
scenario(
  'linking.canOpenURL',
  'false',
  w => {
    w.linking.canOpen = { mode: 'false' };
  },
  { kind: 'media-notice' },
);
scenario(
  'linking.canOpenURL',
  'reject',
  w => {
    w.linking.canOpen = { mode: 'reject' };
  },
  { kind: 'media-notice' },
);
scenario(
  'linking.canOpenURL',
  'never',
  w => {
    w.linking.canOpen = { mode: 'never' };
  },
  { kind: 'media-settles-within-60s' },
);
scenario(
  'linking.canOpenURL',
  'slow-10s',
  w => {
    w.linking.canOpen = { mode: 'slow', delayMs: 10_000 };
  },
  { kind: 'media-settles-within-60s' },
);
scenario(
  'linking.openURL',
  'reject',
  w => {
    w.linking.open = { mode: 'reject' };
  },
  { kind: 'media-notice' },
);
scenario(
  'linking.openURL',
  'never',
  w => {
    w.linking.open = { mode: 'never' };
  },
  { kind: 'media-settles-within-60s' },
);
scenario('linking', 'ok', () => {}, { kind: 'media-opens' });

// --- Clock ------------------------------------------------------------------
scenario(
  'clock',
  'captured_at-in-far-future',
  () => {
    sqlite.shotRows = [
      realShotRow({ captured_at: '2999-12-31T23:59:59.000Z' }),
    ];
    sqlite.captureRows = [
      legacyCaptureRow({ captured_at: '2999-12-31T23:59:59.000Z' }),
    ];
  },
  { kind: 'reads-ok', text: READS_TRUTH },
);
scenario(
  'clock',
  'captured_at-epoch-zero',
  () => {
    sqlite.shotRows = [
      realShotRow({ captured_at: '1970-01-01T00:00:00.000Z' }),
    ];
  },
  { kind: 'reads-ok', text: READS_TRUTH },
);
scenario(
  'clock',
  'captured_at-numeric-ms',
  () => {
    sqlite.shotRows = [realShotRow({ captured_at: 1756568645000 })];
  },
  { kind: 'reads-ok', text: READS_TRUTH },
);
scenario(
  'clock',
  'saved_at-far-future-plan-created-epoch',
  w => {
    w.server.savedDrillsBody = () => ({
      items: [
        {
          ...savedDrillItem(SAVED_SLUGS[0], UUIDS.drillA),
          saved_at: '2999-01-01T00:00:00.000Z',
        },
      ],
    });
  },
  { kind: 'saved-ok', text: '1 saved' },
);

// --- Auth / configuration ---------------------------------------------------
scenario(
  'auth',
  'local-only-session-unconfigured-training',
  w => {
    void w;
    useAuthStore.setState({
      session: {
        provider: 'apple',
        subject: 'local',
        canonicalAppUserId: null,
        localOnly: true,
        displayName: null,
        email: null,
      },
    });
    clearTrainingStoreConfiguration();
  },
  { kind: 'saved-unconfigured', connect: true },
);
scenario(
  'auth',
  'signed-out-unconfigured-training',
  () => {
    useAuthStore.setState({ session: null });
    clearTrainingStoreConfiguration();
  },
  { kind: 'saved-unconfigured', connect: false },
);
scenario(
  'auth',
  'api-configured-without-token',
  () => {
    configureTrainingStore(
      createTrainingApi({ baseUrl: 'https://api.stress.test', token: null }),
    );
  },
  { kind: 'saved-unconfigured', connect: false },
);
scenario(
  'auth',
  'api-configured-without-baseUrl',
  () => {
    configureTrainingStore(createTrainingApi({ baseUrl: '', token: 'tok' }));
  },
  { kind: 'saved-unconfigured', connect: false },
);
scenario(
  'auth',
  'fetch-missing-in-build',
  () => {
    (globalThis as { fetch?: typeof fetch }).fetch = undefined;
  },
  { kind: 'saved-unconfigured', connect: false },
);

// --- Navigation / concurrency ----------------------------------------------
scenario(
  'navigation',
  'blur-during-never-then-refocus',
  () => {
    sqlite.shots = { mode: 'never' };
  },
  {
    kind: 'custom',
    run: async w => {
      expect(w.has(READS_SPINNER)).toBe(true);
      await w.navigateAway();
      expect(w.currentRoute()).toBe('Result');
      sqlite.shots = { mode: 'ok' };
      await w.navigateBack();
      await w.advance(1_000);
      expect(w.has(READS_TRUTH)).toBe(true);
      // The abandoned first read settles late with an error: it must be dropped.
      const stale = sqlite.pending.shift();
      expect(stale).toBeDefined();
      await act(async () => {
        stale?.settle(false);
      });
      await w.advance(1_000);
      expect(w.has(READS_TRUTH)).toBe(true);
      expect(w.has(READS_LOAD_ERROR_TITLE)).toBe(false);
      w.checkInvariants('after stale reject');
    },
  },
);
scenario(
  'navigation',
  'saved-drills-stale-error-after-fresh-success',
  w => {
    w.server.routes.savedDrills = { mode: 'never' };
  },
  {
    kind: 'custom',
    run: async w => {
      await w.pressTab('Saved drills');
      await w.flush();
      expect(w.has(SAVED_SPINNER)).toBe(true);
      // Blur + refocus while the first request is still in flight; the second
      // request succeeds.
      await w.navigateAway();
      w.server.routes.savedDrills = { mode: 'ok' };
      await w.navigateBack();
      await w.advance(1_000);
      expect(w.has(SAVED_TRUTH)).toBe(true);
      // Now the abandoned first request fails late.
      const stale = w.server.pending.find(p => p.route === 'savedDrills');
      expect(stale).toBeDefined();
      await act(async () => {
        stale?.settle(false);
      });
      await w.advance(1_000);
      w.checkInvariants('after stale saved-drills reject');
      // A stale failure must not replace a fresh, successful list with an
      // error card.
      expect(w.has(SAVED_TRUTH)).toBe(true);
      expect(w.has(SAVED_OFFLINE)).toBe(false);
    },
  },
);
scenario(
  'navigation',
  'saved-drills-stale-success-after-fresh-error',
  w => {
    w.server.routes.savedDrills = { mode: 'never' };
  },
  {
    kind: 'custom',
    run: async w => {
      await w.pressTab('Saved drills');
      await w.flush();
      await w.navigateAway();
      w.server.routes.savedDrills = { mode: 'status', status: 503 };
      await w.navigateBack();
      await w.advance(1_000);
      expect(w.has(SAVED_OFFLINE)).toBe(true);
      const stale = w.server.pending.find(p => p.route === 'savedDrills');
      expect(stale).toBeDefined();
      await act(async () => {
        stale?.settle(true);
      });
      await w.advance(1_000);
      w.checkInvariants('after stale saved-drills success');
      // A stale success must not paint over the newest (failed) load: the user
      // was told training is offline and pressed nothing since.
      expect(w.has(SAVED_OFFLINE)).toBe(true);
      expect(w.has(SAVED_TRUTH)).toBe(false);
    },
  },
);
scenario(
  'navigation',
  'reconfigure-store-mid-flight',
  w => {
    w.server.routes.savedDrills = { mode: 'slow', delayMs: 5_000 };
  },
  {
    kind: 'custom',
    run: async w => {
      await w.pressTab('Saved drills');
      await w.flush();
      expect(w.has(SAVED_SPINNER)).toBe(true);
      // Sign-in rotation reconfigures the training store while the request is
      // in flight: the old request's result must be dropped, and a refocus must
      // reload under the new configuration.
      await act(async () => {
        configureTrainingStore(
          createTrainingApi({
            baseUrl: 'https://api.stress.test',
            token: 'tok2',
          }),
        );
      });
      w.server.routes.savedDrills = { mode: 'ok' };
      await w.advance(6_000);
      w.checkInvariants('after reconfigure');
      await w.navigateAway();
      await w.navigateBack();
      await w.advance(1_000);
      expect(w.has(SAVED_TRUTH)).toBe(true);
      w.checkInvariants('after refocus');
    },
  },
);
scenario(
  'navigation',
  'rapid-tab-thrash-during-faults',
  w => {
    w.server.routes.savedDrills = { mode: 'slow', delayMs: 2_000 };
    w.server.routes.drillDetail = { mode: 'slow', delayMs: 2_000 };
  },
  {
    kind: 'custom',
    run: async w => {
      for (let i = 0; i < 6; i += 1) {
        expect(await w.pressTab(i % 2 === 0 ? 'Saved drills' : 'Reads')).toBe(
          true,
        );
        w.checkInvariants(`thrash ${i}`);
        expect(w.has(SAVED_EMPTY)).toBe(false);
      }
      await w.advance(5_000);
      expect(w.has(READS_TRUTH)).toBe(true);
      expect(await w.pressTab('Saved drills')).toBe(true);
      expect(w.has(SAVED_TRUTH)).toBe(true);
      w.checkInvariants('after thrash');
    },
  },
);
scenario(
  'navigation',
  'retry-hammer-while-failing',
  () => {
    sqlite.shots = { mode: 'reject', message: 'SQLITE_IOERR' };
  },
  {
    kind: 'custom',
    run: async w => {
      await w.advance(100);
      for (let i = 0; i < 10; i += 1) {
        expect(await w.press('Try again')).toBe(true);
        w.checkInvariants(`retry ${i}`);
        expect(w.has(READS_LOAD_ERROR_TITLE)).toBe(true);
        expect(w.has(READS_EMPTY)).toBe(false);
      }
      sqlite.shots = { mode: 'ok' };
      expect(await w.press('Try again')).toBe(true);
      await w.advance(100);
      expect(w.has(READS_TRUTH)).toBe(true);
      expect(sqlite.openCount).toBe(1);
      w.checkInvariants('after recovery');
    },
  },
);
scenario(
  'navigation',
  'open-read-result-then-back-during-saved-fault',
  w => {
    w.server.routes.savedDrills = { mode: 'status', status: 500 };
  },
  {
    kind: 'custom',
    run: async w => {
      await w.advance(100);
      expect(await w.press('Open dink result')).toBe(true);
      expect(w.currentRoute()).toBe('Result');
      expect(w.has(`STUB:Result:{"analysisId":"${UUIDS.shot}"}`)).toBe(true);
      await w.navigateBack();
      await w.advance(100);
      expect(w.has(READS_TRUTH)).toBe(true);
      await w.pressTab('Saved drills');
      expect(w.has(SAVED_OFFLINE)).toBe(true);
      w.checkInvariants('after result round trip');
    },
  },
);

// ---------------------------------------------------------------------------
// Expectation runners
// ---------------------------------------------------------------------------

async function expectReadsError(w: World): Promise<void> {
  await w.advance(60_000);
  w.checkInvariants('after fault');
  expect(w.has(READS_LOAD_ERROR_TITLE)).toBe(true);
  expect(w.has(READS_SPINNER)).toBe(false);
  expect(w.has(READS_EMPTY)).toBe(false);
  expect(w.has('analyzed read')).toBe(false);
  expect(w.pressableByLabel('Try again')).not.toBeNull();
  // The saved tab is still reachable and honest while reads are down.
  await w.pressTab('Saved drills');
  await w.advance(1_000);
  expect(w.has(SAVED_TRUTH)).toBe(true);
  await w.pressTab('Reads');
  expect(w.has(READS_LOAD_ERROR_TITLE)).toBe(true);
  // Recovery through the visible control.
  w.clearFaults();
  expect(await w.press('Try again')).toBe(true);
  await w.advance(1_000);
  w.checkInvariants('after recovery');
  expect(w.has(READS_TRUTH)).toBe(true);
  expect(w.has(READS_LOAD_ERROR_TITLE)).toBe(false);
}

async function expectReadsOk(w: World, text: string): Promise<void> {
  await w.advance(60_000);
  w.checkInvariants('after settle');
  expect(w.has(READS_SPINNER)).toBe(false);
  expect(w.has(READS_LOAD_ERROR_TITLE)).toBe(false);
  expect(w.has(text)).toBe(true);
}

async function expectReadsSettles(w: World): Promise<void> {
  await w.advance(60_000);
  w.checkInvariants('after 60s');
  // No unbounded spinner: after 60s the screen is either loaded or shows the
  // retryable error card.
  expect(w.has(READS_SPINNER)).toBe(false);
  expect(w.has(READS_TRUTH) || w.has(READS_LOAD_ERROR_TITLE)).toBe(true);
  expect(w.has(READS_EMPTY)).toBe(false);
}

async function gotoSaved(w: World): Promise<void> {
  await w.pressTab('Saved drills');
  await w.advance(60_000);
  w.checkInvariants('after fault (saved tab)');
}

async function recoverSaved(w: World): Promise<void> {
  w.clearFaults();
  if (!(await w.press('Try again'))) {
    await w.navigateAway();
    await w.navigateBack();
  }
  await w.advance(1_000);
  w.checkInvariants('after recovery');
  expect(w.has(SAVED_TRUTH)).toBe(true);
  expect(w.has(SAVED_SPINNER)).toBe(false);
  expect(
    w.pressableByLabel('Remove Kitchen line dinks from saved drills'),
  ).not.toBeNull();
}

async function expectSavedError(w: World): Promise<void> {
  await gotoSaved(w);
  expect(w.has(SAVED_OFFLINE)).toBe(true);
  expect(w.has(SAVED_SPINNER)).toBe(false);
  expect(w.has(SAVED_EMPTY)).toBe(false);
  expect(w.has(SAVED_TRUTH)).toBe(false);
  expect(w.pressableByLabel('Try again')).not.toBeNull();
  // Reads are unaffected by a training outage.
  await w.pressTab('Reads');
  expect(w.has(READS_TRUTH)).toBe(true);
  await w.pressTab('Saved drills');
  await recoverSaved(w);
}

async function expectSavedHeld(w: World): Promise<void> {
  await gotoSaved(w);
  expect(w.has(SAVED_HELD)).toBe(true);
  expect(w.has('2 saved entries are hidden')).toBe(true);
  expect(w.has(SAVED_EMPTY)).toBe(false);
  expect(w.has('SAVED DRILL')).toBe(false);
  await recoverSaved(w);
}

async function expectSavedPartial(w: World): Promise<void> {
  await gotoSaved(w);
  expect(w.has('1 saved')).toBe(true);
  expect(w.has('1 additional saved entry is hidden')).toBe(true);
  expect(w.has('Kitchen line dinks')).toBe(true);
  expect(w.has('Third shot drop')).toBe(false);
  await recoverSaved(w);
}

async function expectSavedOk(w: World, text: string): Promise<void> {
  await gotoSaved(w);
  expect(w.has(SAVED_SPINNER)).toBe(false);
  expect(w.has(SAVED_OFFLINE)).toBe(false);
  expect(w.has(text)).toBe(true);
}

async function expectSavedUnconfigured(
  w: World,
  connect: boolean,
): Promise<void> {
  await gotoSaved(w);
  expect(w.has(SAVED_UNCONFIGURED)).toBe(true);
  expect(w.has(SAVED_SPINNER)).toBe(false);
  expect(w.has(SAVED_EMPTY)).toBe(false);
  expect(w.pressableByLabel('Connect account') !== null).toBe(connect);
  if (connect) {
    expect(await w.press('Connect account')).toBe(true);
    expect(w.currentRoute()).toBe('ConnectAccount');
    await w.navigateBack();
  }
  // Reads never depend on the training configuration.
  await w.pressTab('Reads');
  expect(w.has(READS_TRUTH)).toBe(true);
}

async function expectSavedSettles(w: World): Promise<void> {
  await gotoSaved(w);
  // No unbounded spinner: after 60s the saved tab is either loaded, held, or
  // offline with a visible retry.
  expect(w.has(SAVED_SPINNER)).toBe(false);
  expect(w.has(SAVED_TRUTH) || w.has(SAVED_OFFLINE) || w.has(SAVED_HELD)).toBe(
    true,
  );
  expect(w.has(SAVED_EMPTY)).toBe(false);
}

async function expectPlanAbsent(w: World): Promise<void> {
  await gotoSaved(w);
  expect(w.has('CURRENT PLAN')).toBe(false);
  expect(w.pressableByLabel('Open your current personalized plan')).toBeNull();
  // A plan outage never hides the saved drills or the reads.
  expect(w.has(SAVED_TRUTH)).toBe(true);
  await w.pressTab('Reads');
  expect(w.has(READS_TRUTH)).toBe(true);
}

async function expectPlanPresent(w: World): Promise<void> {
  await gotoSaved(w);
  expect(w.has('CURRENT PLAN')).toBe(true);
  expect(w.has('0/1 DONE')).toBe(true);
  expect(await w.press('Open your current personalized plan')).toBe(true);
  expect(w.has(`STUB:Result:{"analysisId":"${UUIDS.shot}"}`)).toBe(true);
  await w.navigateBack();
  await w.advance(100);
  w.checkInvariants('after plan round trip');
}

async function expectUnsaveError(w: World): Promise<void> {
  await w.pressTab('Saved drills');
  await w.advance(100);
  expect(w.has(SAVED_TRUTH)).toBe(true);
  expect(await w.press('Remove Kitchen line dinks from saved drills')).toBe(
    true,
  );
  await w.advance(60_000);
  w.checkInvariants('after failed unsave');
  // No fake success: the entry is still listed, and the failure is visible
  // and dismissible.
  expect(w.has(SAVED_TRUTH)).toBe(true);
  expect(w.has('Kitchen line dinks')).toBe(true);
  expect(w.has('DISMISS')).toBe(true);
  expect(useTrainingStore.getState().mutation).toBe('idle');
  const dismiss = w.renderer?.root.findAll(
    n =>
      typeof n.type !== 'string' &&
      n.props.accessibilityHint === 'Dismisses this message' &&
      typeof n.props.onPress === 'function',
  )[0];
  expect(dismiss).toBeDefined();
  await act(async () => {
    dismiss?.props.onPress();
  });
  await w.flush();
  expect(w.has('DISMISS')).toBe(false);
  // Recovery: the same control works once the transport is healthy.
  w.clearFaults();
  w.server.savedDrillsBody = () => ({
    items: [savedDrillItem(SAVED_SLUGS[1], UUIDS.drillB)],
  });
  expect(await w.press('Remove Kitchen line dinks from saved drills')).toBe(
    true,
  );
  await w.advance(1_000);
  expect(w.has('1 saved')).toBe(true);
  expect(w.has('Kitchen line dinks')).toBe(false);
  w.checkInvariants('after recovery');
}

async function expectUnsaveSettles(w: World): Promise<void> {
  await w.pressTab('Saved drills');
  await w.advance(100);
  expect(await w.press('Remove Kitchen line dinks from saved drills')).toBe(
    true,
  );
  await w.advance(60_000);
  w.checkInvariants('after 60s');
  // No unbounded busy state: after 60s the mutation has settled one way or
  // the other and the controls are usable again.
  expect(useTrainingStore.getState().mutation).toBe('idle');
  const remove = w.pressableByLabel('Remove Third shot drop from saved drills');
  expect(remove).not.toBeNull();
  expect(Boolean(remove?.props.disabled)).toBe(false);
}

async function openFirstMedia(w: World): Promise<void> {
  await w.pressTab('Saved drills');
  await w.advance(100);
  expect(w.has(SAVED_TRUTH)).toBe(true);
  expect(
    await w.press('Watch reviewed instruction for Kitchen line dinks'),
  ).toBe(true);
}

async function expectMediaNotice(w: World): Promise<void> {
  await openFirstMedia(w);
  await w.advance(60_000);
  w.checkInvariants('after failed open');
  expect(w.brandNoticeVisible()).toBe(true);
  expect(w.has(MEDIA_NOTICE)).toBe(true);
  expect(w.openedUrls).toEqual([]);
  expect(await w.press('Got it')).toBe(true);
  expect(w.brandNoticeVisible()).toBe(false);
  w.clearFaults();
  expect(
    await w.press('Watch reviewed instruction for Kitchen line dinks'),
  ).toBe(true);
  await w.advance(100);
  expect(w.openedUrls).toEqual(['https://www.youtube.com/watch?v=dQw4w9WgXcQ']);
  expect(w.brandNoticeVisible()).toBe(false);
}

async function expectMediaOpens(w: World): Promise<void> {
  await openFirstMedia(w);
  await w.advance(100);
  w.checkInvariants('after open');
  expect(w.openedUrls).toEqual(['https://www.youtube.com/watch?v=dQw4w9WgXcQ']);
  expect(w.brandNoticeVisible()).toBe(false);
}

async function expectMediaSettles(w: World): Promise<void> {
  await openFirstMedia(w);
  await w.advance(60_000);
  w.checkInvariants('after 60s');
  // No silent failure: within 60s the tap either opened the URL or told the
  // user it could not.
  expect(w.openedUrls.length === 1 || w.brandNoticeVisible()).toBe(true);
  // The control stays usable either way.
  expect(
    w.pressableByLabel('Watch reviewed instruction for Kitchen line dinks'),
  ).not.toBeNull();
}

async function runExpectation(
  w: World,
  expectation: Expectation,
): Promise<void> {
  switch (expectation.kind) {
    case 'reads-error':
      return expectReadsError(w);
    case 'reads-ok':
      return expectReadsOk(w, expectation.text ?? READS_TRUTH);
    case 'reads-settles-within-60s':
      return expectReadsSettles(w);
    case 'saved-error':
      return expectSavedError(w);
    case 'saved-held':
      return expectSavedHeld(w);
    case 'saved-partial':
      return expectSavedPartial(w);
    case 'saved-ok':
      return expectSavedOk(w, expectation.text ?? SAVED_TRUTH);
    case 'saved-unconfigured':
      return expectSavedUnconfigured(w, expectation.connect);
    case 'saved-settles-within-60s':
      return expectSavedSettles(w);
    case 'plan-absent':
      return expectPlanAbsent(w);
    case 'plan-present':
      return expectPlanPresent(w);
    case 'unsave-error':
      return expectUnsaveError(w);
    case 'unsave-settles-within-60s':
      return expectUnsaveSettles(w);
    case 'media-notice':
      return expectMediaNotice(w);
    case 'media-opens':
      return expectMediaOpens(w);
    case 'media-settles-within-60s':
      return expectMediaSettles(w);
    case 'custom':
      return expectation.run(w);
  }
}

// ---------------------------------------------------------------------------
// Harness lifecycle
// ---------------------------------------------------------------------------

const outcomes: OutcomeRow[] = [];
let world: World | null = null;
let consoleErrorSpy: jest.SpyInstance | null = null;
let consoleWarnSpy: jest.SpyInstance | null = null;
const realFetch = globalThis.fetch;

function stringify(args: unknown[]): string {
  return args
    .map(arg => (arg instanceof Error ? arg.message : String(arg)))
    .join(' ');
}

beforeEach(() => {
  jest.useFakeTimers();
  world = new World();
  const w = world;
  consoleErrorSpy = jest
    .spyOn(console, 'error')
    .mockImplementation((...args: unknown[]) => {
      w.consoleIssues.push(`error: ${stringify(args)}`);
    });
  consoleWarnSpy = jest
    .spyOn(console, 'warn')
    .mockImplementation((...args: unknown[]) => {
      w.consoleIssues.push(`warn: ${stringify(args)}`);
    });
});

afterEach(async () => {
  await world?.unmount();
  // Drop the cached driver instance so the next scenario can inject an
  // open/migration fault again.
  sqlite.openMode = 'ok';
  try {
    getDb().close();
  } catch {
    // the driver was never opened in this scenario
  }
  clearTrainingStoreConfiguration();
  globalThis.fetch = realFetch;
  consoleErrorSpy?.mockRestore();
  consoleWarnSpy?.mockRestore();
  jest.restoreAllMocks();
  jest.clearAllTimers();
  jest.useRealTimers();
  world = null;
});

afterAll(() => {
  const fs = require('fs') as {
    mkdirSync(path: string, options: { recursive: boolean }): void;
    writeFileSync(path: string, data: string): void;
  };
  const path = require('path') as {
    dirname(p: string): string;
    resolve(...parts: string[]): string;
  };
  const out = path.resolve(
    process.env['STRESS_OUT'] ??
      'artifacts/stress/libraryscreen-failure-injection.json',
  );
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const broken = outcomes.filter(o => o.outcome === 'BROKEN');
  fs.writeFileSync(
    out,
    JSON.stringify(
      {
        unit: 'scr-libraryscreen',
        lens: 'failure-injection',
        deterministicScenarios: S.length,
        randomIterations: RANDOM_ITERATIONS,
        randomSeedBase: RANDOM_SEED_BASE,
        executed: outcomes.length,
        held: outcomes.length - broken.length,
        broken: broken.length,
        brokenSeeds: broken.map(o => o.seed ?? o.scenario),
        rows: outcomes,
      },
      null,
      2,
    ),
  );
});

async function runScenario(
  row: Omit<OutcomeRow, 'outcome' | 'detail'>,
  body: (w: World) => Promise<void>,
): Promise<void> {
  const w = world;
  if (!w) throw new Error('world not created');
  try {
    await body(w);
    outcomes.push({ ...row, outcome: 'HELD', detail: 'all invariants held' });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    outcomes.push({
      ...row,
      outcome: 'BROKEN',
      detail: message.split('\n').slice(0, 12).join('\n'),
      rendered: w.text().replace(/\n+/g, ' | ').trim().slice(0, 600),
      trainingStore: {
        savedStatus: useTrainingStore.getState().savedStatus,
        planStatus: useTrainingStore.getState().planStatus,
        mutation: useTrainingStore.getState().mutation,
      },
    });
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Deterministic catalogue
// ---------------------------------------------------------------------------

/**
 * Scenarios whose failure is a reproduced, reported defect at 1fb0efd7 (see the
 * stress report for this unit). They run with the SAME strict assertions via
 * `test.failing`, so the suite stays green while the defect is open and turns
 * red the moment a fix lands — at which point the entry is removed here and
 * the scenario is promoted to the regular catalogue. The outcome table still
 * records them as BROKEN with the assertion message and rendered tree.
 */
const KNOWN_BROKEN: Record<string, string> = {
  'sqlite.local_shot/never': 'reads spinner has no control after 60s',
  'sqlite.local_capture/never': 'reads spinner has no control after 60s',
  'fetch.saved-drills/never': 'saved spinner has no control after 60s',
  'fetch.drill-detail/never-all': 'saved spinner has no control after 60s',
  'fetch.drill-detail/partial:one-of-two-never':
    'one hung detail request blocks the whole saved tab',
  'fetch.unsave/never': 'mutation stays saving:<slug> forever',
  'linking.canOpenURL/never': 'no feedback when the opener hangs',
  'linking.openURL/never': 'no feedback when the opener hangs',
  'sqlite.local_shot/malformed:overall_score-text': 'renders NaN',
  'sqlite.local_shot/malformed:captured_at-garbage':
    'renders NaN / INVALID DATE',
  'sqlite.local_capture/malformed:captured_at-garbage': 'renders Invalid Date',
  'clock/captured_at-numeric-ms': 'renders NaN / INVALID DATE',
  'navigation/saved-drills-stale-error-after-fresh-success':
    'stale reject overwrites fresh list with the offline card',
  'navigation/saved-drills-stale-success-after-fresh-error':
    'stale success paints over the newest failed load',
};

function isKnownBroken(scenario: Scenario): boolean {
  return `${scenario.dependency}/${scenario.shape}` in KNOWN_BROKEN;
}

async function runDeterministic(scenario: Scenario): Promise<void> {
  await runScenario(
    {
      scenario: scenario.id,
      seed: null,
      dependency: scenario.dependency,
      shape: scenario.shape,
    },
    async w => {
      scenario.apply(w);
      w.resnapshotRows();
      await w.mount();
      w.checkInvariants('after mount');
      await runExpectation(w, scenario.expectation);
      w.checkInvariants('final');
    },
  );
}

describe('LibraryScreen failure injection — deterministic catalogue', () => {
  const held = S.filter(scenario => !isKnownBroken(scenario));
  const broken = S.filter(isKnownBroken);

  test.each(held)('$id $dependency $shape', runDeterministic);

  // Every KNOWN_BROKEN key must name a real catalogue entry (no stale pins).
  test('known-broken pins match catalogue entries', () => {
    const keys = new Set(S.map(s => `${s.dependency}/${s.shape}`));
    expect(Object.keys(KNOWN_BROKEN).filter(k => !keys.has(k))).toEqual([]);
    expect(broken.length).toBe(Object.keys(KNOWN_BROKEN).length);
  });

  test.failing.each(broken)(
    '$id $dependency $shape [known-broken: fails until fixed]',
    runDeterministic,
  );
});

// ---------------------------------------------------------------------------
// Seeded random campaign: composed faults × user action scripts
// ---------------------------------------------------------------------------

const RANDOM_ITERATIONS = Math.max(
  0,
  Number(process.env['STRESS_ITER'] ?? '16'),
);
const RANDOM_SEED_BASE = Number(process.env['STRESS_SEED'] ?? '20260905');

const SQLITE_FAULTS: Array<[string, () => TableFault]> = [
  ['ok', () => ({ mode: 'ok' })],
  ['ok', () => ({ mode: 'ok' })],
  ['reject', () => ({ mode: 'reject', message: 'SQLITE_IOERR' })],
  ['throw', () => ({ mode: 'throw', message: 'SQLITE_BUSY' })],
  ['never', () => ({ mode: 'never' })],
  ['slow-2s', () => ({ mode: 'slow', delayMs: 2_000 })],
  [
    'slow-reject-4s',
    () => ({ mode: 'slow-reject', delayMs: 4_000, message: 'SQLITE_IOERR' }),
  ],
  ['malformed', () => ({ mode: 'result', result: { rows: [null] } })],
];

const ROUTE_FAULTS: Array<[string, () => RouteFault]> = [
  ['ok', () => ({ mode: 'ok' })],
  ['ok', () => ({ mode: 'ok' })],
  ['reject', () => ({ mode: 'reject', message: 'Network request failed' })],
  ['never', () => ({ mode: 'never' })],
  ['slow-3s', () => ({ mode: 'slow', delayMs: 3_000 })],
  ['http-500', () => ({ mode: 'status', status: 500 })],
  ['http-401', () => ({ mode: 'status', status: 401 })],
  ['http-429', () => ({ mode: 'status', status: 429 })],
  ['malformed-json', () => ({ mode: 'malformed-json' })],
  ['body-invalid', () => ({ mode: 'body', body: { items: [{ nope: true }] } })],
];

const LINK_FAULTS: Array<[string, () => LinkFault]> = [
  ['ok', () => ({ mode: 'ok' })],
  ['false', () => ({ mode: 'false' })],
  ['reject', () => ({ mode: 'reject' })],
  ['never', () => ({ mode: 'never' })],
];

type Action =
  | 'tab-saved'
  | 'tab-reads'
  | 'retry'
  | 'refocus'
  | 'advance-1s'
  | 'advance-60s'
  | 'unsave'
  | 'watch'
  | 'settle-pending-ok'
  | 'settle-pending-fail'
  | 'clear-faults';

const ACTIONS: Action[] = [
  'tab-saved',
  'tab-reads',
  'retry',
  'refocus',
  'advance-1s',
  'advance-60s',
  'unsave',
  'watch',
  'settle-pending-ok',
  'settle-pending-fail',
  'clear-faults',
];

async function perform(w: World, action: Action): Promise<void> {
  switch (action) {
    case 'tab-saved':
      await w.pressTab('Saved drills');
      return;
    case 'tab-reads':
      await w.pressTab('Reads');
      return;
    case 'retry':
      await w.press('Try again');
      return;
    case 'refocus':
      await w.navigateAway();
      await w.navigateBack();
      return;
    case 'advance-1s':
      return w.advance(1_000);
    case 'advance-60s':
      return w.advance(60_000);
    case 'unsave':
      await w.press('Remove Kitchen line dinks from saved drills');
      return;
    case 'watch':
      await w.press('Watch reviewed instruction for Kitchen line dinks');
      return;
    case 'settle-pending-ok':
    case 'settle-pending-fail': {
      const ok = action === 'settle-pending-ok';
      const sql = sqlite.pending.shift();
      const net = w.server.pending.shift();
      await act(async () => {
        sql?.settle(ok);
        net?.settle(ok);
      });
      await w.flush();
      return;
    }
    case 'clear-faults':
      w.clearFaults();
      return;
  }
}

describe('LibraryScreen failure injection — seeded random campaign', () => {
  const seeds = Array.from(
    { length: RANDOM_ITERATIONS },
    (_, i) => RANDOM_SEED_BASE + i,
  );

  test.each(seeds)('random seed %d', async seed => {
    const rng = new Rng(seed);
    const picks = {
      shots: rng.pick(SQLITE_FAULTS),
      captures: rng.pick(SQLITE_FAULTS),
      saved: rng.pick(ROUTE_FAULTS),
      detail: rng.pick(ROUTE_FAULTS),
      plan: rng.pick(ROUTE_FAULTS),
      unsave: rng.pick(ROUTE_FAULTS),
      canOpen: rng.pick(LINK_FAULTS),
      open: rng.pick(LINK_FAULTS),
      withPlan: rng.chance(0.4),
    };
    const script: Action[] = Array.from({ length: 4 + rng.int(5) }, () =>
      rng.pick(ACTIONS),
    );
    const shape = Object.entries(picks)
      .map(([k, v]) => `${k}=${Array.isArray(v) ? v[0] : String(v)}`)
      .join(',');
    await runScenario(
      { scenario: `R${seed}`, seed, dependency: 'composed', shape, script },
      async w => {
        sqlite.shots = picks.shots[1]();
        sqlite.captures = picks.captures[1]();
        w.server.routes.savedDrills = picks.saved[1]();
        w.server.routes.drillDetail = picks.detail[1]();
        w.server.routes.currentPlan = picks.plan[1]();
        w.server.routes.unsaveDrill = picks.unsave[1]();
        w.linking.canOpen = picks.canOpen[1]();
        w.linking.open = picks.open[1]();
        if (picks.withPlan) w.server.currentPlanBody = currentPlanBody;
        await w.mount();
        w.checkInvariants('after mount');
        for (const [index, action] of script.entries()) {
          await perform(w, action);
          w.checkInvariants(`after ${index}:${action}`);
          // Fake success is never rendered while its dependency is faulted.
          if (sqlite.shots.mode !== 'ok' && sqlite.shots.mode !== 'slow') {
            expect(w.has(READS_EMPTY)).toBe(false);
          }
          if (
            w.server.routes.savedDrills.mode !== 'ok' &&
            w.server.routes.savedDrills.mode !== 'slow'
          ) {
            expect(w.has(SAVED_EMPTY)).toBe(false);
          }
        }
        // Recovery: with every fault cleared, one refocus + 60s restores the
        // ground truth on both tabs.
        w.clearFaults();
        // Late settles of anything still hanging must not corrupt the fresh
        // state either.
        await perform(w, 'refocus');
        await w.advance(60_000);
        await perform(w, 'settle-pending-fail');
        await w.advance(1_000);
        w.checkInvariants('after recovery');
        await w.pressTab('Reads');
        if (!w.has(READS_TRUTH)) {
          await w.press('Try again');
          await w.advance(1_000);
        }
        expect(w.has(READS_TRUTH)).toBe(true);
        await w.pressTab('Saved drills');
        if (!w.has(SAVED_TRUTH) && !w.has('1 saved')) {
          await w.press('Try again');
          await w.advance(1_000);
        }
        expect(w.has(SAVED_TRUTH) || w.has('1 saved')).toBe(true);
        expect(useTrainingStore.getState().mutation).toBe('idle');
        w.checkInvariants('final');
      },
    );
  });
});
