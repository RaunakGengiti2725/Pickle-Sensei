/**
 * STRESS · scr-drilllibraryscreen · lens `rapid-interaction`.
 *
 * DrillLibraryScreen is rendered inside a real `NavigationContainer` +
 * native-stack navigator (the navigator the app uses), with the real
 * `useApiSessionStore`, the real `createTrainingApi` (its parsers included)
 * and the real local-evidence read path. Only native module boundaries are
 * replaced: safe-area, WebView, op-sqlite, `Linking` (already a jest mock in
 * the RN preset) and `globalThis.fetch`, which is answered by a scripted
 * server whose latency, ordering and failures come from the iteration seed.
 *
 * Every iteration is one seeded burst sequence (double/triple taps, taps
 * during transitions, simultaneous controls, back during async work,
 * navigation spam, token rotation, out-of-order server completion). After the
 * burst the world is settled and these invariants are checked:
 *
 *   - one side effect per intent: no overlapping save/unsave for a slug, one
 *     navigation per navigation burst, no orphan pending-save state;
 *   - the rendered list equals the server's answer for the FINAL query +
 *     family (stale responses never win), saved flags match the server;
 *   - no orphan loading state (catalog, detail, refresh spinner);
 *   - at most one video modal and one toast;
 *   - no console.error/warn (act() warnings included), no unhandled
 *     rejections, and requests always carry the bearer current at the time.
 *
 * Replay:   STRESS_ONLY=<seed> npx jest --ci drillLibraryScreenRapidInteraction
 * Campaign: STRESS_ITER=300 STRESS_SEED=20260904 npx jest --ci <same pattern>
 * Flake:    STRESS_ONLY=<seed> STRESS_REPEAT=10 npx jest --ci <same pattern>
 * Minimized: STRESS_SCENARIO=__tests__/stress/fixtures/<case>.json npx jest --ci <same pattern>
 * Strict:   STRESS_STRICT=1 also fails on soft violations (see softViolations)
 * Results:  apps/mobile/artifacts/stress/drill-library-rapid-interaction-*.json
 */
import { readFileSync } from 'node:fs';
import React from 'react';
import { Linking, Text, TextInput } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import {
  NavigationContainer,
  createNavigationContainerRef,
} from '@react-navigation/native';
import {
  createNativeStackNavigator,
  type NativeStackScreenProps,
} from '@react-navigation/native-stack';
import { Button, Page } from '../../src/design/components';
import {
  clearApiSession,
  establishApiSession,
} from '../../src/account/apiSession';
import type { RootStackParams } from '../../src/navigation/params';
import { DrillLibraryScreen } from '../../src/screens/DrillLibraryScreen';
import {
  FakeTrainingServer,
  createRng,
  expectedVisible,
  focusEvidencePayloads,
  generateScenario,
  iterationSeed,
  type IterationMetrics,
  type IterationResult,
  type Op,
  type Rng,
  type Scenario,
  type Spacing,
} from '../../test-support/stress/drillLibraryRapidInteraction';

// Node built-ins for the result table. The mobile tsconfig excludes node
// typings (see __tests__/matrix/networkAuthMatrix.test.ts), so the shims
// stay local to this file.
declare const require: (id: string) => unknown;
declare const __dirname: string;
declare const process: {
  env: Record<string, string | undefined>;
  on(event: 'unhandledRejection', listener: (reason: unknown) => void): void;
  off(event: 'unhandledRejection', listener: (reason: unknown) => void): void;
};
const { mkdirSync, writeFileSync } = require('fs') as {
  mkdirSync: (path: string, options: { recursive: boolean }) => void;
  writeFileSync: (path: string, data: string) => void;
};
const { join } = require('path') as { join: (...parts: string[]) => string };

jest.mock('react-native-safe-area-context', () => {
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  const ReactActual = jest.requireActual<typeof import('react')>('react');
  const insets = { top: 0, bottom: 0, left: 0, right: 0 };
  const frame = { x: 0, y: 0, width: 390, height: 844 };
  return {
    SafeAreaView: View,
    SafeAreaProvider: View,
    SafeAreaInsetsContext: ReactActual.createContext(insets),
    SafeAreaFrameContext: ReactActual.createContext(frame),
    useSafeAreaInsets: () => insets,
    useSafeAreaFrame: () => frame,
    initialWindowMetrics: null,
  };
});

jest.mock('react-native-webview', () => {
  const ReactActual = jest.requireActual<typeof import('react')>('react');
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  const MockWebView = (props: Record<string, unknown>) =>
    ReactActual.createElement(View, props);
  return { __esModule: true, default: MockWebView, WebView: MockWebView };
});

// The local store is opened once per process by getDb(); the fake reads its
// options at query time so each iteration can change the evidence it holds.
const mockSqliteOptions: { scoredShotPayloads: string[]; failReads: boolean } =
  { scoredShotPayloads: [], failReads: false };
jest.mock('@op-engineering/op-sqlite', () => {
  const { createFakeSqlite } = jest.requireActual<
    typeof import('../../test-support/stress/drillLibraryRapidInteraction')
  >('../../test-support/stress/drillLibraryRapidInteraction');
  return { open: () => createFakeSqlite(mockSqliteOptions) };
});

const ITER = Number(process.env.STRESS_ITER ?? 24);
const CAMPAIGN_SEED = Number(process.env.STRESS_SEED ?? 20260904);
const ONLY = process.env.STRESS_ONLY ? Number(process.env.STRESS_ONLY) : null;
const REPEAT = Number(process.env.STRESS_REPEAT ?? 1);
/** STRESS_STRICT=1 also fails an iteration when one external-open intent
 * (a browse / search burst) reaches Linking.openURL more than once. */
const STRICT = process.env.STRESS_STRICT === '1';
/** STRESS_SCENARIO=<path.json> replays one explicit (minimized) scenario
 * instead of generating it from the seed. */
const SCENARIO_FILE = process.env.STRESS_SCENARIO ?? null;
const OUT_DIR =
  process.env.STRESS_OUT ?? join(__dirname, '..', '..', 'artifacts', 'stress');

const API_BASE_URL = 'https://stress.invalid/functions/v1/api';
const CANONICAL_USER = '00000000-0000-4000-8000-0000000000aa';
const GO_BACK_UNHANDLED = "The action 'GO_BACK' was not handled";

const FAMILY_LABELS: readonly { value: string | null; label: string }[] = [
  { value: null, label: 'Show all drill families' },
  ...['dink', 'volley', 'drive', 'serve', 'return', 'drop_reset', 'global'].map(
    value => ({
      value,
      label: `Filter ${value.replace(/_/g, ' ')} drills`,
    }),
  ),
];

// ---------------------------------------------------------------------------
// Navigator: the app's stack (native-stack, headerShown false) with the
// previous screen and the connect-account destination as inert stand-ins.
// ---------------------------------------------------------------------------

const Stack = createNativeStackNavigator<RootStackParams>();
const navigationRef = createNavigationContainerRef<RootStackParams>();

function TabsStandIn({
  navigation,
}: NativeStackScreenProps<RootStackParams, 'Tabs'>) {
  return (
    <Page>
      <Button
        testID="open-library"
        label="Open drill library"
        onPress={() => navigation.navigate('DrillLibrary')}
      />
    </Page>
  );
}

function ConnectAccountStandIn({
  navigation,
}: NativeStackScreenProps<RootStackParams, 'ConnectAccount'>) {
  return (
    <Page>
      <Text>Connect account stand-in</Text>
      <Button
        testID="connect-back"
        label="Back to library"
        onPress={() => navigation.goBack()}
      />
    </Page>
  );
}

function Harness() {
  return (
    <NavigationContainer ref={navigationRef}>
      <Stack.Navigator
        screenOptions={{ headerShown: false, animation: 'fade_from_bottom' }}
      >
        <Stack.Screen
          name="Tabs"
          component={TabsStandIn}
          options={{ animation: 'none' }}
        />
        <Stack.Screen name="DrillLibrary" component={DrillLibraryScreen} />
        <Stack.Screen name="ConnectAccount" component={ConnectAccountStandIn} />
      </Stack.Navigator>
    </NavigationContainer>
  );
}

function routeNames(): string[] {
  if (!navigationRef.isReady()) return [];
  const state = navigationRef.getRootState();
  return state ? state.routes.map(route => route.name) : [];
}

// ---------------------------------------------------------------------------
// Tree queries
// ---------------------------------------------------------------------------

type Renderer = TestRenderer.ReactTestRenderer;
type Node = TestRenderer.ReactTestInstance;

function pressables(renderer: Renderer): Node[] {
  return renderer.root.findAll(n => typeof n.props.onPress === 'function');
}

function findByTestId(renderer: Renderer, testID: string): Node | null {
  return pressables(renderer).find(n => n.props.testID === testID) ?? null;
}

function findByTestIdPrefix(renderer: Renderer, prefix: string): Node | null {
  return (
    pressables(renderer).find(
      n =>
        typeof n.props.testID === 'string' && n.props.testID.startsWith(prefix),
    ) ?? null
  );
}

function findByLabel(renderer: Renderer, label: string): Node | null {
  return (
    pressables(renderer).find(n => n.props.accessibilityLabel === label) ?? null
  );
}

function findByLabelPrefix(renderer: Renderer, prefix: string): Node | null {
  return (
    pressables(renderer).find(
      n =>
        typeof n.props.accessibilityLabel === 'string' &&
        n.props.accessibilityLabel.startsWith(prefix),
    ) ?? null
  );
}

function allText(renderer: Renderer): string {
  return renderer.root
    .findAllByType(Text)
    .map(node => node.props.children)
    .flat()
    .filter((c): c is string => typeof c === 'string')
    .join(' ');
}

function countText(renderer: Renderer, needle: string): number {
  return renderer.root
    .findAllByType(Text)
    .map(node => node.props.children)
    .flat()
    .filter((c): c is string => typeof c === 'string' && c.includes(needle))
    .length;
}

/** Host nodes only — RN composites (View, Modal) forward testID to their
 * host element, so counting every match would double-count one mount. */
function nodesByTestId(renderer: Renderer, testID: string): Node[] {
  return renderer.root.findAll(
    n => n.props.testID === testID && typeof n.type === 'string',
  );
}

function cardSlugs(renderer: Renderer): string[] {
  return renderer.root
    .findAll(
      n =>
        typeof n.props.testID === 'string' &&
        n.props.testID.startsWith('drill-card-'),
    )
    .map(n => (n.props.testID as string).slice('drill-card-'.length))
    .filter((slug, index, list) => list.indexOf(slug) === index);
}

function refreshControls(renderer: Renderer): Node[] {
  return renderer.root.findAll(
    n =>
      typeof n.props.onRefresh === 'function' &&
      typeof n.props.refreshing === 'boolean' &&
      // Composite only; the host RCTRefreshControl carries no onRefresh.
      typeof n.type !== 'string',
  );
}

function searchInput(renderer: Renderer): Node | null {
  const [node] = renderer.root
    .findAllByType(TextInput)
    .filter(n => n.props.testID === 'drill-search-input');
  return node ?? null;
}

function selectedFamily(renderer: Renderer): string | null | undefined {
  for (const entry of FAMILY_LABELS) {
    const chip = findByLabel(renderer, entry.label);
    if (chip?.props.accessibilityState?.selected === true) return entry.value;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// One iteration
// ---------------------------------------------------------------------------

type Delivery = 'delivered' | 'blocked' | 'none';

interface World {
  renderer: Renderer;
  server: FakeTrainingServer;
  rng: Rng;
  scenario: Scenario;
  metrics: IterationMetrics;
  violations: string[];
  tokenSerial: number;
  currentToken: string;
  expectedRoutes: string[];
  consoleMessages: string[];
  /** Observations that only fail the iteration under STRESS_STRICT=1. */
  softViolations: string[];
}

function emptyMetrics(): IterationMetrics {
  return {
    opsExecuted: 0,
    tapsDelivered: 0,
    tapsBlockedByDisabled: 0,
    tapsWithoutTarget: 0,
    requests: 0,
    catalogRequests: 0,
    detailRequests: 0,
    saveRequests: 0,
    overlappedSaves: 0,
    redundantMutations: 0,
    retryDetailIntents: 0,
    retryDetailExcessRequests: 0,
    externalOpenIntents: 0,
    externalOpens: 0,
    externalOpenExcess: 0,
    refreshIntents: 0,
    refreshRequests: 0,
    staleBearerRequests: 0,
    goBackDevWarnings: 0,
    consoleErrors: 0,
    unhandledRejections: 0,
  };
}

async function flush(): Promise<void> {
  await act(async () => {});
}

async function advance(world: World, ms: number): Promise<void> {
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
  world.server.tick(ms);
}

/** Delivers a press the way the responder system would: a disabled control
 * never receives it, a missing control is nothing to tap. */
function deliver(world: World, locate: () => Node | null): Delivery {
  const node = locate();
  if (!node) {
    world.metrics.tapsWithoutTarget += 1;
    return 'none';
  }
  if (node.props.disabled === true) {
    world.metrics.tapsBlockedByDisabled += 1;
    return 'blocked';
  }
  world.metrics.tapsDelivered += 1;
  node.props.onPress();
  return 'delivered';
}

async function burst(
  world: World,
  taps: number,
  spacing: Spacing,
  locate: () => Node | null,
): Promise<Delivery[]> {
  const deliveries: Delivery[] = [];
  if (spacing === 'sameTick') {
    await act(async () => {
      for (let i = 0; i < taps; i += 1) deliveries.push(deliver(world, locate));
    });
  } else if (spacing === 'microtask') {
    await act(async () => {
      for (let i = 0; i < taps; i += 1) {
        deliveries.push(deliver(world, locate));
        await Promise.resolve();
      }
    });
  } else {
    for (let i = 0; i < taps; i += 1) {
      await act(async () => {
        deliveries.push(deliver(world, locate));
      });
      await advance(world, world.rng.int(1, 80));
    }
  }
  return deliveries;
}

function rotateToken(world: World): void {
  world.tokenSerial += 1;
  world.currentToken = `bearer-${world.scenario.seed}-${world.tokenSerial}`;
  world.server.tokenHistory.push(world.currentToken);
  establishApiSession({
    apiBaseUrl: API_BASE_URL,
    bearerToken: world.currentToken,
    canonicalAppUserId: CANONICAL_USER,
    provider: 'apple',
    refreshToken: 'refresh',
    bearerExpiresAtMs: Date.now() + 3_600_000,
  });
}

async function runOp(world: World, op: Op): Promise<void> {
  const { renderer, server, rng, metrics } = world;
  world.metrics.opsExecuted += 1;
  switch (op.kind) {
    case 'save':
      await burst(world, op.taps, op.spacing, () =>
        findByTestId(renderer, `save-toggle-${op.slug}`),
      );
      return;
    case 'expand':
      await burst(world, op.taps, op.spacing, () => {
        const [card] = renderer.root.findAll(
          n => n.props.testID === `drill-card-${op.slug}`,
        );
        if (!card) return null;
        const [toggle] = card.findAll(
          n =>
            typeof n.props.onPress === 'function' &&
            typeof n.props.accessibilityLabel === 'string' &&
            / detail for /.test(n.props.accessibilityLabel),
        );
        return toggle ?? null;
      });
      return;
    case 'type': {
      const input = searchInput(renderer);
      if (!input) {
        metrics.tapsWithoutTarget += 1;
        return;
      }
      let value = (input.props.value as string) ?? '';
      for (const char of op.text) {
        value += char;
        const current = searchInput(renderer);
        if (!current) break;
        await act(async () => {
          current.props.onChangeText(value);
        });
        metrics.tapsDelivered += 1;
        if (op.gapMs > 0) await advance(world, op.gapMs);
      }
      return;
    }
    case 'clearSearch':
      await burst(world, op.taps, 'sameTick', () =>
        findByLabel(renderer, 'Clear search'),
      );
      return;
    case 'family': {
      const label =
        FAMILY_LABELS.find(entry => entry.value === op.family)?.label ?? '';
      await burst(world, op.taps, rng.pick(['sameTick', 'ms']), () =>
        findByLabel(renderer, label),
      );
      return;
    }
    case 'refresh': {
      const before = server.log.filter(r => r.kind === 'catalog').length;
      await act(async () => {
        for (let i = 0; i < op.taps; i += 1) {
          const [control] = refreshControls(renderer);
          if (!control) {
            metrics.tapsWithoutTarget += 1;
            continue;
          }
          // A spinning RefreshControl does not re-fire onRefresh.
          if (control.props.refreshing === true) {
            metrics.tapsBlockedByDisabled += 1;
            continue;
          }
          metrics.tapsDelivered += 1;
          metrics.refreshIntents += 1;
          control.props.onRefresh();
        }
      });
      metrics.refreshRequests +=
        server.log.filter(r => r.kind === 'catalog').length - before;
      return;
    }
    case 'openMedia':
      await burst(world, op.taps, op.spacing, () =>
        findByTestIdPrefix(renderer, 'watch-media-'),
      );
      return;
    case 'closeMedia':
      await burst(world, op.taps, 'sameTick', () =>
        findByTestId(renderer, 'drill-video-close'),
      );
      return;
    case 'browse':
    case 'searchYoutube': {
      const opensBefore = metrics.externalOpens;
      const delivered = await burst(world, op.taps, op.spacing, () =>
        op.kind === 'browse'
          ? findByTestIdPrefix(renderer, 'browse-videos-')
          : findByTestId(renderer, 'search-youtube'),
      );
      await flush();
      const deliveredTaps = delivered.filter(d => d === 'delivered').length;
      if (deliveredTaps > 0) {
        // Taps spread over real milliseconds are separate intents; a
        // same-tick / same-microtask burst is one intent.
        const intents = op.spacing === 'ms' ? deliveredTaps : 1;
        metrics.externalOpenIntents += intents;
        const opens = metrics.externalOpens - opensBefore;
        if (opens > intents) {
          metrics.externalOpenExcess += opens - intents;
          world.softViolations.push(
            `${op.kind}: ${op.taps} taps (${op.spacing}) reached Linking.openURL ${opens}× for ${intents} intent(s)`,
          );
        }
      }
      return;
    }
    case 'retryDetail': {
      const before = server.log.filter(r => r.kind === 'detail').length;
      const delivered = await burst(world, op.taps, 'sameTick', () =>
        findByLabelPrefix(renderer, 'Retry detail for '),
      );
      if (delivered.includes('delivered')) {
        metrics.retryDetailIntents += 1;
        const issued =
          server.log.filter(r => r.kind === 'detail').length - before;
        if (issued > 1) {
          metrics.retryDetailExcessRequests += issued - 1;
          world.softViolations.push(
            `retryDetail: ${op.taps} same-tick taps issued ${issued} detail GETs for 1 intent`,
          );
        }
      }
      return;
    }
    case 'dismissError':
      await burst(world, op.taps, 'sameTick', () =>
        findByLabel(renderer, 'Dismiss error'),
      );
      return;
    case 'retryCatalog':
      await burst(world, op.taps, 'sameTick', () => {
        if (!allText(renderer).includes('The drill catalog could not load.'))
          return null;
        return findByLabel(renderer, 'Try again');
      });
      return;
    case 'rotateToken':
      await act(async () => {
        rotateToken(world);
      });
      return;
    case 'signIn':
      // A sign-in completing while the unconfigured state is on screen.
      await act(async () => {
        for (let i = 0; i < op.taps; i += 1) rotateToken(world);
      });
      return;
    case 'connectAccount': {
      const delivered = await burst(world, op.taps, 'sameTick', () =>
        findByLabel(renderer, 'Connect account'),
      );
      await flush();
      const routes = routeNames();
      const pushed = routes.filter(name => name === 'ConnectAccount').length;
      if (delivered.includes('delivered') && pushed !== 1) {
        world.violations.push(
          `connect-account burst (${op.taps} taps) pushed ${pushed} routes: ${routes.join('>')}`,
        );
      }
      if (routes.includes('ConnectAccount')) {
        await advance(world, rng.pick([0, 16, 300]));
        await burst(world, 1, 'sameTick', () =>
          findByTestId(renderer, 'connect-back'),
        );
        await flush();
      }
      return;
    }
    case 'release':
      for (let i = 0; i < op.count; i += 1) {
        await act(async () => {
          server.releaseOne();
        });
      }
      return;
    case 'advance':
      await advance(world, op.ms);
      return;
    case 'back': {
      const before = routeNames();
      const delivered = await burst(world, op.taps, op.spacing, () => {
        // Only the focused screen's header is tappable.
        if (routeNames().at(-1) !== 'DrillLibrary') return null;
        return findByLabel(renderer, 'Back');
      });
      await flush();
      if (delivered.includes('delivered')) {
        world.expectedRoutes = before.slice(0, -1);
      }
      return;
    }
  }
}

/** Lets the first catalog response land (releasing it if the server holds
 * it) so the burst sequence starts from a rendered list. */
async function awaitFirstCatalog(world: World): Promise<void> {
  const { server } = world;
  for (let round = 0; round < 12; round += 1) {
    if (server.log.some(r => r.kind === 'catalog' && r.completedAt !== null)) {
      await flush();
      return;
    }
    await act(async () => {
      server.releaseOne();
    });
    await advance(world, 250);
  }
}

async function settle(world: World): Promise<void> {
  const { server } = world;
  for (let round = 0; round < 60; round += 1) {
    await act(async () => {
      server.releaseOne();
    });
    await flush();
    await advance(world, 500);
    if (server.pendingCount === 0 && round >= 8) break;
  }
  await advance(world, 3_000);
  await flush();
  if (server.pendingCount !== 0) {
    world.violations.push(
      `harness: ${server.pendingCount} request(s) still pending after settle`,
    );
  }
}

function checkInvariants(world: World): void {
  const { renderer, server, metrics, violations, scenario } = world;

  // Request accounting from the server log.
  metrics.requests = server.log.length;
  metrics.catalogRequests = server.log.filter(r => r.kind === 'catalog').length;
  metrics.detailRequests = server.log.filter(r => r.kind === 'detail').length;
  metrics.saveRequests = server.log.filter(
    r => r.kind === 'save' || r.kind === 'unsave',
  ).length;
  metrics.overlappedSaves = server.log.filter(r => r.overlappedSave).length;
  metrics.redundantMutations = server.log.filter(
    r => r.redundantMutation,
  ).length;
  if (metrics.overlappedSaves > 0) {
    violations.push(
      `single-flight: ${metrics.overlappedSaves} save/unsave request(s) overlapped an open mutation for the same slug`,
    );
  }
  for (const record of server.log) {
    if (record.kind === 'other') {
      violations.push(`unexpected request ${record.method} ${record.path}`);
    }
    if (
      record.bearer !== null &&
      !server.tokenHistory.includes(record.bearer)
    ) {
      violations.push(`request ${record.seq} carried unknown bearer`);
    }
  }
  metrics.staleBearerRequests = server.log.filter(r => r.staleBearer).length;

  // Detail requests: one per slug plus one per delivered retry intent.
  const detailBySlug = new Map<string, number>();
  for (const record of server.log) {
    if (record.kind === 'detail' && record.slug) {
      detailBySlug.set(record.slug, (detailBySlug.get(record.slug) ?? 0) + 1);
    }
  }
  const retryBudget =
    metrics.retryDetailIntents + metrics.retryDetailExcessRequests;
  for (const [slug, count] of detailBySlug) {
    if (count > 1 + retryBudget) {
      violations.push(
        `detail for ${slug} was requested ${count}× with ${metrics.retryDetailIntents} retry intent(s)`,
      );
    }
  }

  // Console + rejections.
  const unexpectedConsole = world.consoleMessages.filter(
    message => !message.includes(GO_BACK_UNHANDLED),
  );
  metrics.goBackDevWarnings =
    world.consoleMessages.length - unexpectedConsole.length;
  metrics.consoleErrors = unexpectedConsole.length;
  for (const message of unexpectedConsole) {
    violations.push(`console: ${message.split('\n')[0]?.slice(0, 200)}`);
  }
  if (metrics.unhandledRejections > 0) {
    violations.push(`${metrics.unhandledRejections} unhandled rejection(s)`);
  }

  // Navigation.
  const routes = routeNames();
  if (routes.join('>') !== world.expectedRoutes.join('>')) {
    violations.push(
      `navigation: expected ${world.expectedRoutes.join('>')} got ${routes.join('>')}`,
    );
  }

  const screenMounted = routes.includes('DrillLibrary');
  if (!screenMounted) {
    if (allText(renderer).includes('Drill Library')) {
      violations.push('screen content still rendered after leaving the route');
    }
    return;
  }

  // Orphan loading / pending state.
  const text = allText(renderer);
  if (text.includes('Loading the drill catalog…')) {
    violations.push('orphan loading: catalog spinner still shown after settle');
  }
  if (text.includes('Loading drill detail…')) {
    violations.push('orphan loading: detail still loading after settle');
  }
  for (const control of refreshControls(renderer)) {
    if (control.props.refreshing === true) {
      violations.push('orphan loading: refresh spinner still active');
    }
  }
  const pendingToggles = pressables(renderer).filter(
    n =>
      typeof n.props.testID === 'string' &&
      n.props.testID.startsWith('save-toggle-') &&
      n.props.disabled === true,
  );
  if (pendingToggles.length > 0) {
    violations.push(
      `orphan pending save on ${pendingToggles
        .map(n => n.props.testID)
        .join(',')}`,
    );
  }

  // Duplicates.
  const players = nodesByTestId(renderer, 'drill-video-player');
  if (players.length > 1) {
    violations.push(`duplicate modal: ${players.length} video players mounted`);
  }
  const toasts =
    countText(renderer, 'Saved to your library') +
    countText(renderer, 'Removed from saved drills');
  if (toasts > 1) violations.push(`duplicate toast: ${toasts} toasts mounted`);

  // Catalog consistency against the final filter state.
  const input = searchInput(renderer);
  const catalog = server.log.filter(r => r.kind === 'catalog');
  const last = catalog.at(-1);
  if (input && last && last.outcome === 'ok') {
    const query = ((input.props.value as string) ?? '').trim();
    const family = selectedFamily(renderer);
    if (family === undefined) {
      violations.push('no family chip is selected');
    } else {
      if (last.q !== query || last.family !== family) {
        violations.push(
          `last catalog request (q=${JSON.stringify(last.q)}, family=${last.family}) does not match final controls (q=${JSON.stringify(query)}, family=${family})`,
        );
      }
      const expected = expectedVisible(query, family).sort();
      const rendered = cardSlugs(renderer).sort();
      if (expected.join(',') !== rendered.join(',')) {
        violations.push(
          `stale list: rendered [${rendered.join(',')}] expected [${expected.join(',')}]`,
        );
      }
    }
    // Saved flags must agree with the server once nothing is in flight.
    for (const slug of cardSlugs(renderer)) {
      const toggle = findByTestId(renderer, `save-toggle-${slug}`);
      if (!toggle) continue;
      const uiSaved = String(toggle.props.accessibilityLabel).startsWith(
        'Remove ',
      );
      if (uiSaved !== server.saved.has(slug)) {
        violations.push(
          `saved-flag divergence on ${slug}: UI ${uiSaved ? 'saved' : 'unsaved'}, server ${server.saved.has(slug) ? 'saved' : 'unsaved'}`,
        );
      }
    }
  } else if (
    input &&
    last &&
    last.outcome !== 'ok' &&
    text.includes('Loading')
  ) {
    violations.push(`loading text after failed final catalog request: ${text}`);
  }
  if (scenario.profile === 'signedOut' && catalog.length === 0) {
    if (!nodesByTestId(renderer, 'drill-library-unconfigured').length) {
      violations.push(
        'signed-out profile did not render the unconfigured state',
      );
    }
  }
}

async function runIteration(
  seed: number,
  iteration: number,
  explicitScenario: Scenario | null,
): Promise<IterationResult> {
  const startedAt = Date.now();
  const scenario = explicitScenario ?? generateScenario(seed);
  const rng = createRng(seed ^ 0x5bd1e995);
  const server = new FakeTrainingServer({
    rng,
    baseUrl: API_BASE_URL,
    failureRate: scenario.failureRate,
    latency: scenario.latency,
    snapshotAt: scenario.snapshotAt,
  });
  mockSqliteOptions.scoredShotPayloads =
    scenario.localEvidence === 'focus' ? focusEvidencePayloads() : [];
  mockSqliteOptions.failReads = scenario.localEvidence === 'corrupt';

  const consoleMessages: string[] = [];
  const toMessage = (args: unknown[]) =>
    args
      .map(arg =>
        arg instanceof Error
          ? arg.message
          : typeof arg === 'string'
            ? arg
            : JSON.stringify(arg),
      )
      .join(' ');
  const errorSpy = jest
    .spyOn(console, 'error')
    .mockImplementation((...args: unknown[]) => {
      consoleMessages.push(`error: ${toMessage(args)}`);
    });
  const warnSpy = jest
    .spyOn(console, 'warn')
    .mockImplementation((...args: unknown[]) => {
      consoleMessages.push(`warn: ${toMessage(args)}`);
    });
  const metrics = emptyMetrics();
  const onUnhandled = () => {
    metrics.unhandledRejections += 1;
  };
  process.on('unhandledRejection', onUnhandled);

  const openUrl = Linking.openURL as jest.Mock;
  openUrl.mockReset();
  openUrl.mockImplementation(() => {
    metrics.externalOpens += 1;
    return rng.chance(0.15)
      ? Promise.reject(new Error('No app can open this URL'))
      : Promise.resolve();
  });
  (globalThis as { fetch: unknown }).fetch = server.fetch;

  const world: World = {
    renderer: null as unknown as Renderer,
    server,
    rng,
    scenario,
    metrics,
    violations: [],
    tokenSerial: 0,
    currentToken: '',
    expectedRoutes: ['Tabs', 'DrillLibrary'],
    consoleMessages,
    softViolations: [],
  };
  let finalRoutes: string[] = [];

  clearApiSession();
  if (scenario.profile === 'signedIn') rotateToken(world);

  try {
    await act(async () => {
      world.renderer = TestRenderer.create(<Harness />);
    });
    // Navigation spam from the previous screen: N presses, one push.
    await burst(world, scenario.openTaps, 'sameTick', () =>
      findByTestId(world.renderer, 'open-library'),
    );
    await flush();
    const afterOpen = routeNames();
    if (afterOpen.join('>') !== 'Tabs>DrillLibrary') {
      world.violations.push(
        `navigation spam: ${scenario.openTaps} presses produced ${afterOpen.join('>')}`,
      );
    }

    if (scenario.waitForCatalog) await awaitFirstCatalog(world);

    for (const op of scenario.ops) {
      await runOp(world, op);
    }
    await settle(world);
    finalRoutes = routeNames();
    checkInvariants(world);
    if (STRICT) world.violations.push(...world.softViolations);
  } catch (error) {
    world.violations.push(
      `threw: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`,
    );
  } finally {
    try {
      await act(async () => {
        if (world.renderer) world.renderer.unmount();
      });
      // Anything still in flight resolves against an unmounted tree.
      server.releaseAll();
      await flush();
      await act(async () => {
        jest.advanceTimersByTime(5_000);
      });
    } catch (error) {
      world.violations.push(
        `teardown threw: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    process.off('unhandledRejection', onUnhandled);
    errorSpy.mockRestore();
    warnSpy.mockRestore();
    clearApiSession();
  }

  return {
    seed,
    iteration,
    outcome: world.violations.length === 0 ? 'held' : 'broken',
    violations: world.violations,
    softViolations: world.softViolations,
    scenario,
    metrics,
    finalRoutes,
    durationMs: Date.now() - startedAt,
    requestLog:
      world.violations.length > 0 || world.softViolations.length > 0
        ? world.server.log.map(r => ({
            seq: r.seq,
            kind: r.kind,
            slug: r.slug,
            q: r.q,
            family: r.family,
            outcome: r.outcome,
            arrivedAt: r.arrivedAt,
            completedAt: r.completedAt,
          }))
        : undefined,
  };
}

// ---------------------------------------------------------------------------
// Campaign
// ---------------------------------------------------------------------------

const explicitScenario: Scenario | null = SCENARIO_FILE
  ? (JSON.parse(readFileSync(SCENARIO_FILE, 'utf8')) as Scenario)
  : null;

const seeds: number[] = explicitScenario
  ? Array.from({ length: REPEAT }, () => explicitScenario.seed)
  : ONLY !== null
    ? Array.from({ length: REPEAT }, () => ONLY)
    : Array.from({ length: ITER }, (_, i) => iterationSeed(CAMPAIGN_SEED, i));

const results: IterationResult[] = [];

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

afterAll(() => {
  const broken = results.filter(r => r.outcome === 'broken');
  const sum = (pick: (m: IterationMetrics) => number) =>
    results.reduce((total, r) => total + pick(r.metrics), 0);
  const summary = {
    generatedAt: new Date().toISOString(),
    campaignSeed: CAMPAIGN_SEED,
    only: ONLY,
    repeat: REPEAT,
    strict: STRICT,
    iterations: results.length,
    held: results.length - broken.length,
    broken: broken.length,
    bursts: sum(m => m.opsExecuted),
    tapsDelivered: sum(m => m.tapsDelivered),
    tapsBlockedByDisabled: sum(m => m.tapsBlockedByDisabled),
    requests: sum(m => m.requests),
    overlappedSaves: sum(m => m.overlappedSaves),
    redundantMutations: sum(m => m.redundantMutations),
    retryDetailIntents: sum(m => m.retryDetailIntents),
    retryDetailExcessRequests: sum(m => m.retryDetailExcessRequests),
    externalOpenIntents: sum(m => m.externalOpenIntents),
    externalOpens: sum(m => m.externalOpens),
    externalOpenExcess: sum(m => m.externalOpenExcess),
    softViolationSeeds: results
      .filter(r => r.softViolations.length > 0)
      .map(r => ({ seed: r.seed, softViolations: r.softViolations })),
    refreshIntents: sum(m => m.refreshIntents),
    refreshRequests: sum(m => m.refreshRequests),
    staleBearerRequests: sum(m => m.staleBearerRequests),
    goBackDevWarnings: sum(m => m.goBackDevWarnings),
    consoleErrors: sum(m => m.consoleErrors),
    unhandledRejections: sum(m => m.unhandledRejections),
    brokenSeeds: broken.map(r => ({
      seed: r.seed,
      iteration: r.iteration,
      violations: r.violations,
      replay: `STRESS_ONLY=${r.seed} npx jest --ci drillLibraryScreenRapidInteraction`,
    })),
  };
  mkdirSync(OUT_DIR, { recursive: true });
  const suffix = explicitScenario
    ? `-scenario-${explicitScenario.seed}`
    : ONLY !== null
      ? `-only-${ONLY}`
      : '';
  writeFileSync(
    join(OUT_DIR, `drill-library-rapid-interaction-summary${suffix}.json`),
    JSON.stringify(summary, null, 2),
  );
  writeFileSync(
    join(OUT_DIR, `drill-library-rapid-interaction-results${suffix}.json`),
    JSON.stringify(results, null, 2),
  );
});

describe('DrillLibraryScreen · rapid interaction (real navigator + stores)', () => {
  seeds.forEach((seed, index) => {
    it(`seed ${seed} (#${index}) holds every rapid-interaction invariant`, async () => {
      const result = await runIteration(seed, index, explicitScenario);
      results.push(result);
      expect(result.violations).toEqual([]);
    });
  });
});
